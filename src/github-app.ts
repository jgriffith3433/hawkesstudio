// GitHub through a GitHub App (J, 2026-10-30: "getting hooked up to GitHub through tokens or what ever is the most modern
// way"; the GitHub App was his pick). Studio makes its own app with GitHub's manifest flow: the person clicks once on
// GitHub (nothing to fill in) and GitHub hands Studio the app's id, private key and OAuth client back. Then:
//   - installing the app on the repos they choose gives Studio short-lived installation tokens for those repos;
//   - signing in with GitHub (the app's OAuth) gives a user token, which is what creates a new repo in their account.
// A pasted fine-grained token per repo stays as the fallback, and in J's Studio his own GITHUB_TOKEN still covers his
// repos. Secrets live in the data folder (synced to the state bucket on Cloud Run, never in the API), files 0600.
// Tests stand GitHub in with GITHUB_API_BASE / GITHUB_WEB_BASE.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA, StudioError } from './config.ts';
import { customerStudio, PLATFORM_GITHUB } from './tenancy.ts';
import { getUser } from './auth.ts';

export const API = () => (process.env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/+$/, '');
export const WEB = () => (process.env.GITHUB_WEB_BASE || 'https://github.com').replace(/\/+$/, '');

const APP_FILE = () => path.join(DATA, 'github-app.json');
const USERS_FILE = () => path.join(DATA, 'github-users.json');
const TOKENS_FILE = () => path.join(DATA, 'github-tokens.json');

export type AppConfig = { id: number; slug: string; clientId: string; clientSecret: string; pem: string; webhookSecret?: string; htmlUrl: string; owner: string };
type UserLink = { login: string; token: string; refresh?: string; expires?: number; refreshExpires?: number; at: number };

const readJson = <T>(file: string, fallback: T): T => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
};
const writeSecret = (file: string, value: unknown) => {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
};

export const appConfig = (): AppConfig | null => readJson<AppConfig | null>(APP_FILE(), null);

/** owner/name from anything people paste: a URL, git@, owner/name, with or without .git. */
export function repoSlug(s: unknown): string | null {
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(String(s ?? '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** A call to GitHub's API. Throws a sentence with GitHub's own message. */
export async function gh(token: string | null, method: string, url: string, body?: unknown, { jwt = false } = {}): Promise<any> {
  const r = await fetch(`${API()}${url}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'hawkes-studio',
      ...(token ? { Authorization: `${jwt ? 'Bearer' : 'token'} ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const why = data?.message ?? String(text).slice(0, 200);
    throw new StudioError(`GitHub ${method} ${url}: ${r.status} ${why}${data?.errors ? ` (${JSON.stringify(data.errors).slice(0, 200)})` : ''}`, r.status === 404 ? 404 : r.status === 401 || r.status === 403 ? 403 : 502);
  }
  return data;
}

// ------------------------------------------------------------------ making the app (the manifest flow)

/** What Studio asks GitHub to make: permissions for setting a game up and working on it, nothing else. */
export function manifest(base: string) {
  const host = new URL(base).host;
  return {
    name: `Hawkes Studio ${host}`.slice(0, 34),
    url: base,
    redirect_url: `${base}/api/github/app/created`,
    callback_urls: [`${base}/api/github/callback`],
    setup_url: `${base}/api/github/installed`,
    setup_on_update: true,
    // After an install GitHub signs the person in (the callback), so Studio can check the installation is theirs before
    // linking it to their Studio (customers' cells, below).
    request_oauth_on_install: true,
    public: !customerStudio(),
    hook_attributes: { url: `${base}/api/github/webhook`, active: false },
    default_permissions: {
      metadata: 'read', contents: 'write', pull_requests: 'write', workflows: 'write', pages: 'write',
      administration: 'write', actions: 'read', checks: 'read',
    },
    default_events: [],
  };
}

/** A signed state for GitHub's round trips (the app, the sign-in): who asked, and when; 15 minutes. */
const stateKey = () => {
  const f = path.join(DATA, 'github-state.key');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {
    const k = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, k, { mode: 0o600 });
    return k;
  }
};
export function signState(payload: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify({ ...payload, t: Date.now() })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', stateKey()).update(body).digest('base64url')}`;
}
export function readState(state: unknown): Record<string, any> | null {
  const [body, mac] = String(state ?? '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', stateKey()).update(body).digest('base64url');
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return Date.now() - Number(p.t) < 15 * 60_000 ? p : null;
}

/** The page that sends the person to GitHub with the manifest (a form GitHub requires as a POST). org: make it there. */
export function setupPage(base: string, org?: string | null) {
  const target = org ? `${WEB()}/organizations/${encodeURIComponent(org)}/settings/apps/new` : `${WEB()}/settings/apps/new`;
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect GitHub</title>
<body style="font:16px system-ui;max-width:560px;margin:60px auto;padding:0 16px">
<h1 style="font-size:22px">Connect Hawkes Studio to GitHub</h1>
<p>GitHub will ask you to create the app Studio uses for your games' repositories. Nothing to fill in: press <b>Create GitHub App</b> there, then install it on the repositories you want Studio to work on.</p>
<form method="post" action="${esc(`${target}?state=${encodeURIComponent(signState({ k: 'app' }))}`)}">
<input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest(base)))}">
<button style="font:inherit;padding:10px 16px">Continue to GitHub</button></form>
<script>document.forms[0].submit()</script></body>`;
}

/** GitHub's answer to the manifest: the app, saved. Returns where to install it. */
export async function appCreated(code: string, state: string) {
  if (!readState(state)) throw new StudioError('This link expired or was not made here: start again from Studio.', 400);
  const a = await gh(null, 'POST', `/app-manifests/${encodeURIComponent(code)}/conversions`);
  const cfg: AppConfig = {
    id: a.id, slug: a.slug, clientId: a.client_id, clientSecret: a.client_secret, pem: a.pem, webhookSecret: a.webhook_secret,
    htmlUrl: a.html_url, owner: a.owner?.login ?? '',
  };
  writeSecret(APP_FILE(), cfg);
  return { app: publicApp(cfg), install: installUrl(cfg) };
}

const publicApp = (c: AppConfig) => ({ id: c.id, slug: c.slug, owner: c.owner, url: c.htmlUrl });
export const installUrl = (c = appConfig()) => (c ? `${WEB()}/apps/${c.slug}/installations/new` : null);

// ------------------------------------------------------------------ the app's own tokens

/** The app's JWT (RS256, 9 minutes), for the /app routes. */
export function appJwt(c = appConfig()) {
  if (!c) throw new StudioError('GitHub isn\'t connected yet: make the GitHub App first (studio_github setup).', 409);
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: now - 60, exp: now + 540, iss: String(c.id) })}`;
  return `${head}.${crypto.sign('RSA-SHA256', Buffer.from(head), c.pem).toString('base64url')}`;
}

export async function installations() {
  const c = appConfig();
  if (!c) return [];
  const list = await gh(appJwt(c), 'GET', '/app/installations?per_page=100', undefined, { jwt: true });
  return (list as any[]).map((i) => ({ id: i.id as number, account: String(i.account?.login ?? ''), type: String(i.account?.type ?? ''), repos: i.repository_selection as string }));
}

const tokenCache = new Map<number, { token: string; expires: number }>();
export async function installationToken(id: number) {
  const hit = tokenCache.get(id);
  if (hit && hit.expires - Date.now() > 5 * 60_000) return hit.token;
  const t = await gh(appJwt(), 'POST', `/app/installations/${id}/access_tokens`, {}, { jwt: true });
  tokenCache.set(id, { token: t.token, expires: Date.parse(t.expires_at) });
  return t.token as string;
}

/** The repositories one installation may reach. */
export async function installationRepos(id: number) {
  const r = await gh(await installationToken(id), 'GET', '/installation/repositories?per_page=100');
  return (r.repositories as any[]).map((x) => ({ repo: String(x.full_name), private: Boolean(x.private), url: String(x.html_url) }));
}

// ------------------------------------------------------------------ signing in with GitHub (user tokens)

export function connectUrl(base: string, userId: string) {
  const c = appConfig();
  if (!c) throw new StudioError('Make the GitHub App first (studio_github setup), then sign in with GitHub.', 409);
  const q = new URLSearchParams({ client_id: c.clientId, redirect_uri: `${base}/api/github/callback`, state: signState({ k: 'user', u: userId }) });
  return `${WEB()}/login/oauth/authorize?${q}`;
}

/** GitHub's sign-in answer: the person's user token, kept for them. */
export async function userCallback(base: string, code: string, state: string, installationId?: string | null) {
  const s = readState(state);
  // After installing the app from a customer's Studio (installLinkFor): the person's sign-in proves the installation is
  // one they can reach, then it is linked to their org.
  if (s?.k === 'install' && s.org && installationId) {
    const link = await exchange({ code, redirect_uri: `${base}/api/github/callback` });
    const theirs = await gh(link.token, 'GET', '/user/installations?per_page=100');
    const inst = (theirs.installations as any[] ?? []).find((i) => String(i.id) === String(installationId));
    if (!inst) throw new StudioError("That installation isn't one your GitHub account can reach: install the app again from your Studio.", 403);
    linkInstallation(Number(installationId), String(s.org), String(inst.account?.login ?? ''));
    return { user: null, login: null, org: String(s.org), account: String(inst.account?.login ?? ''), back: s.back ? String(s.back) : null };
  }
  if (!s || s.k !== 'user' || !s.u) throw new StudioError('This sign-in link expired or was not made here: start again from Studio.', 400);
  const link = await exchange({ code, redirect_uri: `${base}/api/github/callback` });
  const me = await gh(link.token, 'GET', '/user');
  const users = readJson<Record<string, UserLink>>(USERS_FILE(), {});
  users[s.u] = { ...link, login: String(me.login) };
  writeSecret(USERS_FILE(), users);
  return { user: s.u as string, login: String(me.login), org: null, account: null, back: null };
}

// ------------------------------------------------------------------ customers' Studios share J's app (the control plane)

const INSTALLS_FILE = () => path.join(DATA, 'github-installs.json');
type InstallLink = { org: string; account: string; at: number };

/** The app's install page for one customer's org: the signed state comes back with the installation (userCallback). */
export function installLinkFor(org: string, back?: string | null) {
  const c = appConfig();
  if (!c) return null;
  return `${WEB()}/apps/${c.slug}/installations/new?state=${encodeURIComponent(signState({ k: 'install', org, ...(back ? { back } : {}) }))}`;
}

/** Records which org an installation belongs to. One installation, one org: a second org can't take it over. */
export function linkInstallation(id: number, org: string, account: string) {
  const all = readJson<Record<string, InstallLink>>(INSTALLS_FILE(), {});
  const had = all[String(id)];
  if (had && had.org !== org) throw new StudioError(`That installation (${account}) already belongs to another Studio.`, 409);
  all[String(id)] = { org, account, at: Date.now() };
  writeSecret(INSTALLS_FILE(), all);
}

/** The installations linked to one org, as GitHub has them now (gone ones are left out). */
export async function orgInstallations(org: string) {
  const linked = Object.entries(readJson<Record<string, InstallLink>>(INSTALLS_FILE(), {})).filter(([, l]) => l.org === org).map(([id]) => Number(id));
  if (!linked.length) return [];
  return (await installations()).filter((i) => linked.includes(i.id));
}

/**
 * A token for one org's one repo: only through an installation linked to that org, and scoped to that repository alone
 * (GitHub's repositories: [name]), so a cell never gets a token wider than the repo it asked for. null: not reachable.
 */
export async function orgRepoToken(org: string, repo: string) {
  const slug = repoSlug(repo);
  if (!slug) throw new StudioError('repo: owner/name', 400);
  const [owner, name] = slug.split('/');
  const inst = (await orgInstallations(org)).find((i) => i.account.toLowerCase() === owner.toLowerCase());
  if (!inst) return null;
  try {
    const t = await gh(appJwt(), 'POST', `/app/installations/${inst.id}/access_tokens`, { repositories: [name] }, { jwt: true });
    return { token: String(t.token), expires: Date.parse(t.expires_at) };
  } catch (e: any) {
    if (e.status === 404 || /422|not accessible|repositor/i.test(String(e.message))) return null;
    throw e;
  }
}

async function exchange(params: Record<string, string>): Promise<Omit<UserLink, 'login'>> {
  const c = appConfig()!;
  const r = await fetch(`${WEB()}/login/oauth/access_token`, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret, ...params }), signal: AbortSignal.timeout(30_000),
  });
  const d: any = await r.json().catch(() => ({}));
  if (!d.access_token) throw new StudioError(`GitHub sign-in: ${d.error_description ?? d.error ?? r.status}`, 400);
  const now = Date.now();
  return {
    token: d.access_token, refresh: d.refresh_token, at: now,
    ...(d.expires_in ? { expires: now + Number(d.expires_in) * 1000 } : {}),
    ...(d.refresh_token_expires_in ? { refreshExpires: now + Number(d.refresh_token_expires_in) * 1000 } : {}),
  };
}

/** A person's GitHub user token (refreshed when it is near its end), or null when they haven't signed in. */
export async function userToken(userId: string): Promise<{ login: string; token: string } | null> {
  const users = readJson<Record<string, UserLink>>(USERS_FILE(), {});
  const u = users[userId];
  if (!u) return null;
  if (u.expires && u.expires - Date.now() < 5 * 60_000) {
    if (!u.refresh || (u.refreshExpires && u.refreshExpires < Date.now())) return null;
    const next = await exchange({ grant_type: 'refresh_token', refresh_token: u.refresh });
    users[userId] = { ...next, login: u.login };
    writeSecret(USERS_FILE(), users);
    return { login: u.login, token: next.token };
  }
  return { login: u.login, token: u.token };
}

export function disconnectUser(userId: string) {
  const users = readJson<Record<string, UserLink>>(USERS_FILE(), {});
  delete users[userId];
  writeSecret(USERS_FILE(), users);
}

// ------------------------------------------------------------------ pasted tokens (the fallback)

/** A fine-grained token for one repo, kept here (never shown again). Checked against the repo first. */
export async function savePastedToken(repo: string, token: string) {
  const slug = repoSlug(repo);
  if (!slug) throw new StudioError('repo: owner/name', 400);
  if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(token.trim())) throw new StudioError('That doesn\'t look like a GitHub token (github_pat_... or ghp_...).', 400);
  const r = await gh(token.trim(), 'GET', `/repos/${slug}`);
  if (!r.permissions?.push) throw new StudioError(`That token can read ${slug} but not write to it: give it Contents read and write.`, 400);
  const all = readJson<Record<string, string>>(TOKENS_FILE(), {});
  all[slug.toLowerCase()] = token.trim();
  writeSecret(TOKENS_FILE(), all);
  return { repo: slug };
}

// ------------------------------------------------------------------ a token for a repo, whichever way it comes

export type RepoAccess = { token: string; via: 'app' | 'user' | 'pasted' | 'studio' };

/**
 * The best token Studio has for a repo: the app's installation on its owner (when that installation reaches it), a
 * pasted token for it, J's own GITHUB_TOKEN for his repos in his Studio, or the asking person's GitHub sign-in.
 */
export async function accessFor(repo: string, userId?: string | null): Promise<RepoAccess | null> {
  const slug = repoSlug(repo);
  if (!slug) return null;
  const [owner] = slug.split('/');
  try {
    const inst = (await installations()).find((i) => i.account.toLowerCase() === owner.toLowerCase());
    if (inst) {
      const token = await installationToken(inst.id);
      if (inst.repos === 'all' || (await installationRepos(inst.id)).some((r) => r.repo.toLowerCase() === slug.toLowerCase())) return { token, via: 'app' };
    }
  } catch { /* no app, or GitHub unreachable: the other ways */ }
  const pasted = readJson<Record<string, string>>(TOKENS_FILE(), {})[slug.toLowerCase()];
  if (pasted) return { token: pasted, via: 'pasted' };
  // A customer's Studio: J's app through the control plane, scoped to this one repo (cellside.ts).
  if (customerStudio()) {
    const t = await (await import('./cellside.ts')).cellGithubToken(slug).catch(() => null);
    if (t) return { token: t, via: 'app' };
  }
  if (!customerStudio() && owner.toLowerCase() === PLATFORM_GITHUB && process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN, via: 'studio' };
  if (userId) {
    const u = await userToken(userId).catch(() => null);
    if (u) return { token: u.token, via: 'user' };
  }
  return null;
}

/** Everything about the connection, for Talk and the dashboard (no secrets). */
export async function githubStatus(base: string, userId?: string | null) {
  const c = appConfig();
  // A customer's Studio shares J's app (the control plane): its install link carries this org, and only the
  // installations linked to it show. Making an app or signing in with GitHub isn't done from a cell.
  const cell = !c ? await (await import('./cellside.ts')).cellGithub(`${base}/`).catch((e) => ({ error: String(e.message ?? e) }) as any) : null;
  if (cell) {
    return {
      app: cell.app ? { slug: cell.app.slug } : null, setup: null, install: cell.install ?? null, installations: cell.installations ?? [],
      user: null, connect: null, pastedRepos: Object.keys(readJson<Record<string, string>>(TOKENS_FILE(), {})), error: cell.error ?? (cell.app ? null : "GitHub isn't set up for Studio yet: Hawkes Studio's team turns it on."),
    };
  }
  const user = userId ? await userToken(userId).catch(() => null) : null;
  let installs: Awaited<ReturnType<typeof installations>> = [];
  let error: string | null = null;
  if (c) installs = await installations().catch((e) => { error = e.message; return []; });
  return {
    app: c ? publicApp(c) : null,
    setup: c ? null : `${base}/api/github/app/setup`,
    install: installUrl(c),
    installations: installs,
    user: user ? { login: user.login } : null,
    // Opened in the person's browser: Studio's own sign-in says who, then GitHub's.
    connect: c && !user ? `${base}/api/github/connect` : null,
    pastedRepos: Object.keys(readJson<Record<string, string>>(TOKENS_FILE(), {})),
    error,
  };
}

/** Whose GitHub sign-in Talk and the agents use (they have no person of their own): an admin's, else anyone's here. */
export function linkedAdmin(): string | null {
  const ids = Object.keys(readJson<Record<string, UserLink>>(USERS_FILE(), {}));
  return ids.find((id) => getUser(id)?.role === 'admin') ?? ids.find((id) => getUser(id)) ?? null;
}
