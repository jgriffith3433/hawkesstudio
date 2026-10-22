// The Social tab (dashboard/social.js): Studio's YouTube and TikTok accounts, and finished videos posted to them.
// Nothing goes public from here. YouTube uploads are private (an unaudited API project can't do anything else) and
// TikTok uploads land in the account's inbox as a draft (the Content Posting API's video.upload): J opens the app,
// checks it and presses Post. So agents may post: the last step is always J's, on the platform itself.
//
// The OAuth apps are J's (Google Cloud: YouTube Data API v3; TikTok for Developers: Login Kit + Content Posting API).
// Their client ids and secrets, and the refresh tokens, live in .data/social.json (0600), set from the dashboard.
// The sandbox can't change them (guards.ts) and they never leave this file: GET /api/social shows only what's connected.
// docs/social.md has the setup steps.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type http from 'node:http';
import { DATA } from './config.ts';
import { db, newId, J, parse } from './db.ts';
import { gen } from './gen.ts';

export const PLATFORMS = ['youtube', 'tiktok'] as const;
export type Platform = (typeof PLATFORMS)[number];
const isPlatform = (p: unknown): p is Platform => PLATFORMS.includes(p as Platform);

type Account = { clientId?: string; clientSecret?: string; refreshToken?: string; refreshExpires?: number; name?: string; id?: string; connectedAt?: number };
type Store = Partial<Record<Platform, Account>>;

db.exec(`CREATE TABLE IF NOT EXISTS social_posts (
  id TEXT PRIMARY KEY, created INTEGER NOT NULL, by TEXT, product TEXT, asset TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT, tags TEXT, platforms TEXT NOT NULL, results TEXT NOT NULL DEFAULT '{}'
)`);

const storePath = () => path.join(DATA, 'social.json');
function readStore(): Store {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8'));
  } catch {
    return {};
  }
}
function writeStore(s: Store) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(s, null, 2), { mode: 0o600 });
}
function patchAccount(p: Platform, patch: Partial<Account> | null) {
  const s = readStore();
  s[p] = patch === null ? undefined : { ...s[p], ...patch };
  writeStore(s);
}

// ------------------------------------------------------------------------------------------------ OAuth

export const SCOPES: Record<Platform, string> = {
  youtube: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
  tiktok: 'user.info.basic,video.upload',
};

/** Where the platform sends J back: this site's own address (Caddy passes the host), registered in each OAuth app. */
export function redirectUri(req: http.IncomingMessage | null, p: Platform) {
  const host = String(req?.headers['x-forwarded-host'] ?? req?.headers.host ?? '127.0.0.1:8791');
  const local = /^(127\.0\.0\.1|localhost)(:|$)/.test(host);
  return `${local ? 'http' : 'https'}://${host}/api/social/callback/${p}`;
}

const states = new Map<string, { p: Platform; at: number }>();

/** The sign-in address for a platform (state is single-use, 15 minutes). */
export function authUrl(p: Platform, clientId: string, redirect: string, state = crypto.randomBytes(16).toString('hex')) {
  for (const [k, v] of states) if (Date.now() - v.at > 15 * 60_000) states.delete(k);
  states.set(state, { p, at: Date.now() });
  if (p === 'youtube') {
    return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPES.youtube, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state })}`;
  }
  return `https://www.tiktok.com/v2/auth/authorize/?${new URLSearchParams({ client_key: clientId, response_type: 'code', scope: SCOPES.tiktok, redirect_uri: redirect, state })}`;
}

export function takeState(state: string, p: Platform) {
  const s = states.get(state);
  states.delete(state);
  return !!s && s.p === p && Date.now() - s.at < 15 * 60_000;
}

async function form(url: string, body: Record<string, string>) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(20_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`${new URL(url).host}: ${j.error_description || j.error?.message || j.error || r.status}`);
  return j;
}

/** Trades the code from the callback for tokens, and remembers who signed in. */
async function connect(p: Platform, code: string, redirect: string) {
  const a = readStore()[p];
  if (!a?.clientId || !a.clientSecret) throw new Error(`Set the ${p} app's client id and secret first`);
  if (p === 'youtube') {
    const t = await form('https://oauth2.googleapis.com/token', { client_id: a.clientId, client_secret: a.clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirect });
    if (!t.refresh_token) throw new Error('Google sent no refresh token: remove Hawkes Studio at myaccount.google.com/permissions and connect again');
    const ch: any = await (await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { authorization: `Bearer ${t.access_token}` } })).json();
    const c = ch.items?.[0];
    patchAccount(p, { refreshToken: t.refresh_token, name: c?.snippet?.title ?? 'YouTube channel', id: c?.id, connectedAt: Date.now() });
  } else {
    const t = await form('https://open.tiktokapis.com/v2/oauth/token/', { client_key: a.clientId, client_secret: a.clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirect });
    const u: any = await (await fetch('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name', { headers: { authorization: `Bearer ${t.access_token}` } })).json();
    patchAccount(p, { refreshToken: t.refresh_token, refreshExpires: Date.now() + Number(t.refresh_expires_in ?? 0) * 1000, name: u.data?.user?.display_name ?? 'TikTok account', id: t.open_id, connectedAt: Date.now() });
  }
}

/** A fresh access token from the stored refresh token (TikTok also hands back a new refresh token: kept). */
async function accessToken(p: Platform): Promise<string> {
  const a = readStore()[p];
  if (!a?.refreshToken) throw new Error(`${p} isn't connected (Social tab)`);
  if (p === 'youtube') {
    return (await form('https://oauth2.googleapis.com/token', { client_id: a.clientId!, client_secret: a.clientSecret!, refresh_token: a.refreshToken, grant_type: 'refresh_token' })).access_token;
  }
  const t = await form('https://open.tiktokapis.com/v2/oauth/token/', { client_key: a.clientId!, client_secret: a.clientSecret!, refresh_token: a.refreshToken, grant_type: 'refresh_token' });
  if (t.refresh_token && t.refresh_token !== a.refreshToken) patchAccount(p, { refreshToken: t.refresh_token, refreshExpires: Date.now() + Number(t.refresh_expires_in ?? 0) * 1000 });
  return t.access_token;
}

/** What the dashboard may see: never ids' secrets or tokens. */
export function accounts(req: http.IncomingMessage | null = null) {
  const s = readStore();
  return Object.fromEntries(PLATFORMS.map((p) => {
    const a = s[p] ?? {};
    return [p, { configured: !!(a.clientId && a.clientSecret), connected: !!a.refreshToken, name: a.name ?? null, connectedAt: a.connectedAt ?? null, refreshExpires: a.refreshExpires ?? null, redirect: redirectUri(req, p) }];
  }));
}

// ------------------------------------------------------------------------------------------------ uploads

/** YouTube: a resumable upload, private, in Gaming. Returns the video's id and links. */
async function youtubeUpload(bytes: Uint8Array, post: Post) {
  const token = await accessToken('youtube');
  const shorts = post.description.includes('#Shorts') || post.title.includes('#Shorts');
  const meta = {
    snippet: { title: post.title.slice(0, 100), description: post.description.slice(0, 5000), tags: post.tags.slice(0, 30), categoryId: '20' },
    status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
  };
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'video/mp4', 'x-upload-content-length': String(bytes.length) },
    body: JSON.stringify(meta),
  });
  const where = init.headers.get('location');
  if (!init.ok || !where) throw new Error(`YouTube wouldn't start the upload: ${init.status} ${(await init.text()).slice(0, 300)}`);
  const up = await fetch(where, { method: 'PUT', headers: { 'content-type': 'video/mp4' }, body: bytes as unknown as BodyInit });
  const v: any = await up.json().catch(() => ({}));
  if (!up.ok || !v.id) throw new Error(`YouTube upload failed: ${up.status} ${JSON.stringify(v.error ?? v).slice(0, 300)}`);
  return { status: 'private', id: v.id, url: shorts ? `https://youtube.com/shorts/${v.id}` : `https://youtu.be/${v.id}`, edit: `https://studio.youtube.com/video/${v.id}/edit` };
}

/** TikTok's chunks: one when it's 64 MB or less, else 10 MB chunks with the remainder in the last one. */
export function tiktokChunks(size: number) {
  const MB = 1024 * 1024;
  if (size <= 64 * MB) return { chunkSize: size, count: 1 };
  const chunkSize = 10 * MB;
  return { chunkSize, count: Math.floor(size / chunkSize) };
}

/** TikTok: into the account's inbox as a draft. J finishes it in the app (caption, cover, Post). */
async function tiktokUpload(bytes: Uint8Array) {
  const token = await accessToken('tiktok');
  const { chunkSize, count } = tiktokChunks(bytes.length);
  const init = await fetch('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ source_info: { source: 'FILE_UPLOAD', video_size: bytes.length, chunk_size: chunkSize, total_chunk_count: count } }),
  });
  const j: any = await init.json().catch(() => ({}));
  if (!init.ok || j.error?.code !== 'ok') throw new Error(`TikTok wouldn't start the upload: ${j.error?.message || init.status}`);
  for (let i = 0; i < count; i++) {
    const start = i * chunkSize;
    const end = i === count - 1 ? bytes.length : start + chunkSize;
    const r = await fetch(j.data.upload_url, { method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end - 1}/${bytes.length}` }, body: bytes.subarray(start, end) as unknown as BodyInit });
    if (!r.ok) throw new Error(`TikTok chunk ${i + 1}/${count} failed: ${r.status}`);
  }
  return { status: 'uploading', publishId: j.data.publish_id };
}

/** Where a TikTok upload is now (SEND_TO_USER_INBOX means it's waiting in J's inbox). */
async function tiktokStatus(publishId: string) {
  const r = await fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
    method: 'POST', headers: { authorization: `Bearer ${await accessToken('tiktok')}`, 'content-type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ publish_id: publishId }),
  });
  const j: any = await r.json().catch(() => ({}));
  const s = String(j.data?.status ?? 'unknown');
  return { status: s === 'SEND_TO_USER_INBOX' ? 'in inbox' : s === 'PUBLISH_COMPLETE' ? 'posted' : s === 'FAILED' ? 'failed' : 'uploading', error: j.data?.fail_reason || undefined };
}

// ------------------------------------------------------------------------------------------------ posts

export type Post = { id: string; created: number; by: string | null; product: string | null; asset: string; title: string; description: string; tags: string[]; platforms: Platform[]; results: Record<string, any> };
const rowToPost = (r: any): Post => ({ ...r, tags: parse(r.tags) ?? [], platforms: parse(r.platforms) ?? [], results: parse(r.results) ?? {} });
const savePost = (p: Post) => db.prepare('UPDATE social_posts SET results = ? WHERE id = ?').run(J(p.results), p.id);

export function listPosts(limit = 50): Post[] {
  return (db.prepare('SELECT * FROM social_posts ORDER BY created DESC LIMIT ?').all(limit) as any[]).map(rowToPost);
}
export const getPost = (id: string) => {
  const r = db.prepare('SELECT * FROM social_posts WHERE id = ?').get(id);
  return r ? rowToPost(r) : null;
};

/** Checks a post's fields; returns why it can't go, or null. */
export function postProblem(b: any, connected: Record<string, boolean>): string | null {
  if (!/^a_[0-9a-f]{8,32}$/.test(String(b?.asset ?? ''))) return 'asset: the Gen asset id of an .mp4 (a_...)';
  if (!String(b?.title ?? '').trim()) return 'title is required';
  const platforms = Array.isArray(b?.platforms) && b.platforms.length ? b.platforms : PLATFORMS.filter((p) => connected[p]);
  if (!platforms.length) return 'No accounts are connected yet (Social tab)';
  for (const p of platforms) {
    if (!isPlatform(p)) return `Not a platform: ${p}`;
    if (!connected[p]) return `${p} isn't connected (Social tab)`;
  }
  return null;
}

/** Makes a post and uploads it to each platform in the background. Returns at once. */
export function createPost(b: any, by: string | null): Post {
  const acc = accounts();
  const connected = Object.fromEntries(PLATFORMS.map((p) => [p, acc[p].connected]));
  const problem = postProblem(b, connected);
  if (problem) throw Object.assign(new Error(problem), { status: 400 });
  const platforms: Platform[] = Array.isArray(b.platforms) && b.platforms.length ? b.platforms : PLATFORMS.filter((p) => connected[p]);
  const post: Post = {
    id: newId('sp'), created: Date.now(), by, product: b.product ? String(b.product) : null, asset: String(b.asset),
    title: String(b.title).trim().slice(0, 100), description: String(b.description ?? '').slice(0, 5000),
    tags: (Array.isArray(b.tags) ? b.tags : String(b.tags ?? '').split(',')).map((t: unknown) => String(t).trim().replace(/^#/, '')).filter(Boolean).slice(0, 30),
    platforms, results: Object.fromEntries(platforms.map((p) => [p, { status: 'queued' }])),
  };
  db.prepare('INSERT INTO social_posts (id, created, by, product, asset, title, description, tags, platforms, results) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(post.id, post.created, by, post.product, post.asset, post.title, post.description, J(post.tags), J(post.platforms), J(post.results));
  void upload(post);
  return post;
}

async function upload(post: Post) {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await gen.bytes(post.asset));
  } catch (e: any) {
    for (const p of post.platforms) post.results[p] = { status: 'failed', error: `Couldn't read ${post.asset} from Gen: ${e.message}` };
    return savePost(post);
  }
  await Promise.all(post.platforms.map(async (p) => {
    post.results[p] = { status: 'uploading' };
    savePost(post);
    try {
      post.results[p] = p === 'youtube' ? await youtubeUpload(bytes, post) : await tiktokUpload(bytes);
    } catch (e: any) {
      post.results[p] = { status: 'failed', error: String(e.message).slice(0, 400) };
    }
    savePost(post);
  }));
}

/** A post with TikTok's latest status filled in. */
export async function refreshPost(id: string) {
  const post = getPost(id);
  if (!post) return null;
  const t = post.results.tiktok;
  if (t?.publishId && t.status === 'uploading') {
    try {
      post.results.tiktok = { ...t, ...(await tiktokStatus(t.publishId)) };
      savePost(post);
    } catch { /* keep what we had */ }
  }
  return post;
}

// ------------------------------------------------------------------------------------------------ routes

type Send = (res: http.ServerResponse, status: number, body: unknown) => void;

export async function handleSocialApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, send: Send, readJson: (req: http.IncomingMessage) => Promise<any>, by: string | null) {
  const route = url.pathname;
  const method = req.method ?? 'GET';
  let m: RegExpExecArray | null;
  if (route === '/api/social' && method === 'GET') return send(res, 200, { accounts: accounts(req), posts: listPosts(Number(url.searchParams.get('limit')) || 50) });
  if (route === '/api/social/config' && method === 'POST') {
    const b = await readJson(req);
    if (!isPlatform(b.platform)) return send(res, 400, { error: 'platform: youtube or tiktok' });
    const clientId = String(b.clientId ?? '').trim();
    const clientSecret = String(b.clientSecret ?? '').trim();
    if (!clientId || !clientSecret) return send(res, 400, { error: 'Both the client id (TikTok: client key) and the client secret' });
    patchAccount(b.platform, { clientId, clientSecret });
    return send(res, 200, { accounts: accounts(req) });
  }
  if ((m = /^\/api\/social\/connect\/(\w+)$/.exec(route)) && method === 'GET') {
    const p = m[1];
    if (!isPlatform(p)) return send(res, 404, { error: 'No such platform' });
    const a = readStore()[p];
    if (!a?.clientId) return send(res, 400, { error: `Set the ${p} app's client id and secret first` });
    res.writeHead(302, { location: authUrl(p, a.clientId, redirectUri(req, p)) });
    return res.end();
  }
  if ((m = /^\/api\/social\/callback\/(\w+)$/.exec(route)) && method === 'GET') {
    const p = m[1];
    const back = (msg: string) => { res.writeHead(302, { location: `/?${new URLSearchParams({ social: msg })}#social` }); res.end(); };
    if (!isPlatform(p)) return send(res, 404, { error: 'No such platform' });
    if (url.searchParams.get('error')) return back(`${p}: ${url.searchParams.get('error_description') || url.searchParams.get('error')}`);
    if (!takeState(String(url.searchParams.get('state') ?? ''), p)) return back(`${p}: that sign-in expired or didn't start here. Try Connect again.`);
    try {
      await connect(p, String(url.searchParams.get('code') ?? ''), redirectUri(req, p));
      return back(`${p} connected`);
    } catch (e: any) {
      return back(`${p}: ${e.message}`);
    }
  }
  if ((m = /^\/api\/social\/disconnect\/(\w+)$/.exec(route)) && method === 'POST') {
    if (!isPlatform(m[1])) return send(res, 404, { error: 'No such platform' });
    patchAccount(m[1], { refreshToken: undefined, refreshExpires: undefined, name: undefined, id: undefined, connectedAt: undefined });
    return send(res, 200, { accounts: accounts(req) });
  }
  if (route === '/api/social/posts' && method === 'POST') {
    try {
      return send(res, 200, createPost(await readJson(req), by));
    } catch (e: any) {
      return send(res, e.status ?? 500, { error: e.message });
    }
  }
  if ((m = /^\/api\/social\/posts\/(sp_[0-9a-f]+)$/.exec(route)) && method === 'GET') {
    const post = await refreshPost(m[1]);
    return post ? send(res, 200, post) : send(res, 404, { error: 'No such post' });
  }
  return send(res, 404, { error: 'Not found' });
}
