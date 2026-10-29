// The job broker for customers' agent runs (docs/studio-customers.md, section 2 "Isolation"). A customer's agents run
// their prompts with a shell, in the shared agents' job (studio-cell-agent). That job's service account has NO access to
// the cells' bucket, so an agent can't list or read another customer's objects, or even its own Studio's database. It
// reaches exactly its own run's folder through the control plane, the way Gen's GPU workers reach theirs (hawkesgen
// src/providers/gpu/broker.ts):
//
//   - The cell signs a run token for one run (its org, the unit, an expiry) with its own derived broker key
//     (cellkeys.ts STUDIO_BROKER_KEY) and passes it to the execution with the broker's address. A cell can only sign
//     for its own org: the control plane checks the token against the key it derives for the org the token names.
//   - The job asks POST/GET <control plane>/api/cells/broker?op=…&key=… with the token in X-Hawkes-Run-Token. The key is
//     relative to the cell's prefix (jobs/<unit>/…) and must lie inside that run's folder; anything else is 403.
//       op=list    the names under a prefix of the run's folder
//       op=url     {url}: a V4 signed GET for one object (big bundles go straight from Cloud Storage), or {proxy: true}
//       op=upload  {url}: a V4 signed PUT for one object, or {proxy: true}
//       op=read    the bytes, through the control plane
//       op=write   PUT: writes the body there
//       op=remove  deletes one object
//
// Tokens last 6 hours (a pass's time limit is 4).

import crypto from 'node:crypto';
import type http from 'node:http';
import { deriveKey, validOrg } from './cellkeys.ts';

export const BROKER_ROUTE = '/api/cells/broker';
const TTL_MS = 6 * 3600_000;
const UNIT = /^[A-Za-z0-9][\w.-]{0,120}$/;

const mac = (key: string, body: string) => crypto.createHmac('sha256', key).update(`hawkes-run:${body}`).digest('base64url');

/** A run's token, signed with the cell's own broker key (in the cell: STUDIO_BROKER_KEY). */
export function runToken(org: string, unit: string, key = process.env.STUDIO_BROKER_KEY ?? '', now = Date.now()) {
  if (!key) throw new Error('No broker key (STUDIO_BROKER_KEY) to sign a run token with');
  const body = Buffer.from(JSON.stringify({ org, unit, exp: now + TTL_MS })).toString('base64url');
  return `${body}.${mac(key, body)}`;
}

/** The run a token is for, checked against the key the control plane derives for the org it names; null otherwise. */
export function readRunToken(token: string, now = Date.now(), keyFor = (org: string) => deriveKey('broker', org)): { org: string; unit: string } | null {
  const [body, sig] = String(token ?? '').split('.');
  if (!body || !sig) return null;
  let v: any;
  try { v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!validOrg(v?.org) || !UNIT.test(String(v?.unit ?? '')) || !(Number(v?.exp) > now)) return null;
  let want: string;
  try { want = mac(keyFor(v.org), body); } catch { return null; }
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  return { org: v.org, unit: v.unit };
}

/** The bucket object a run may touch for this key, or null. Only its own run's folder: jobs/<unit>/… under o/<org>/. */
export function objectFor(run: { org: string; unit: string }, key: string): string | null {
  const k = String(key ?? '');
  if (!k.startsWith(`jobs/${run.unit}/`) || k.includes('..') || k.includes('//') || /[\r\n\\]/.test(k)) return null;
  return `o/${run.org}/${k}`;
}

export type BrokerDeps = {
  bucket: string;
  list: (prefix: string) => Promise<string[]>;
  read: (name: string) => Promise<Buffer | null>;
  write: (name: string, data: Buffer) => Promise<unknown>;
  remove: (name: string) => Promise<unknown>;
  sign: (method: 'GET' | 'PUT', name: string) => Promise<string | null>;
};

export async function defaultBrokerDeps(bucket: string): Promise<BrokerDeps> {
  const g = await import('./gcp.ts');
  return {
    bucket,
    list: async (prefix) => (await g.gcsList(bucket, prefix)).map((o) => o.name),
    read: (name) => g.gcsRead(bucket, name),
    write: (name, data) => g.gcsWrite(bucket, name, data),
    remove: (name) => g.gcsDelete(bucket, name),
    sign: async (method, name) => { const s = await g.signer().catch(() => null); return s ? g.signedUrl(method, bucket, name, s, 900) : null; },
  };
}

const MAX_WRITE = 512 * 1024 * 1024;

/** One broker request (server.ts, before Studio's own sign-in checks: the run token is the credential). */
export async function handleBroker(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: BrokerDeps) {
  const json = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const run = readRunToken(String(req.headers['x-hawkes-run-token'] ?? ''));
  if (!run) return json(401, { error: 'no valid run token' });
  const op = url.searchParams.get('op') ?? '';
  const key = url.searchParams.get('key') ?? '';
  const name = objectFor(run, key);
  const method = req.method ?? 'GET';
  if (!name || (op === 'write') !== (method === 'PUT')) return json(403, { error: `not this run's: ${op} ${key}` });
  const strip = `o/${run.org}/`;
  try {
    if (op === 'list') return json(200, { names: (await deps.list(name)).filter((n) => n.startsWith(`${strip}jobs/${run.unit}/`)).map((n) => n.slice(strip.length)) });
    if (op === 'url' || op === 'upload') {
      const u = await deps.sign(op === 'url' ? 'GET' : 'PUT', name);
      return json(200, u ? { url: u } : { proxy: true });
    }
    if (op === 'read') {
      const b = await deps.read(name);
      if (!b) return json(404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': String(b.length) });
      return res.end(b);
    }
    if (op === 'write') {
      const parts: Buffer[] = [];
      let n = 0;
      for await (const c of req) { n += (c as Buffer).length; if (n > MAX_WRITE) return json(413, { error: 'too big' }); parts.push(c as Buffer); }
      await deps.write(name, Buffer.concat(parts));
      return json(200, { ok: true });
    }
    if (op === 'remove') { await deps.remove(name); return json(200, { ok: true }); }
    return json(400, { error: `unknown op ${op}` });
  } catch (e: any) {
    if (!res.headersSent) return json(502, { error: e.message ?? String(e) });
    res.destroy();
  }
}

/**
 * The job's side (cloudjob-run.ts): its run folder through the broker, keys relative to the cell's prefix as before.
 * Big objects go by signed URL when the control plane can sign, else through it.
 */
export function brokerStore(base: string, token: string, f: typeof fetch = fetch) {
  const call = (op: string, key: string, init: RequestInit = {}) => f(`${base.replace(/\/+$/, '')}?op=${op}&key=${encodeURIComponent(key)}`, { ...init, headers: { 'X-Hawkes-Run-Token': token, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30 * 60_000) });
  const ok = async (r: Response, what: string) => { if (!r.ok) throw new Error(`the broker refused ${what} (${r.status} ${(await r.text()).slice(0, 200)})`); return r; };
  return {
    async put(key: string, data: Buffer | string) {
      const body = typeof data === 'string' ? Buffer.from(data) : data;
      const u: any = await (await ok(await call('upload', key), `upload ${key}`)).json();
      if (u.url) { await ok(await f(u.url, { method: 'PUT', body: new Uint8Array(body) }), `PUT ${key}`); return; }
      await ok(await call('write', key, { method: 'PUT', body: new Uint8Array(body) }), `write ${key}`);
    },
    async get(key: string): Promise<Buffer | null> {
      const u = await call('url', key);
      if (u.status === 403 || u.status === 401) await ok(u, `read ${key}`);
      const j: any = await u.json().catch(() => ({}));
      const r = j.url ? await f(j.url) : await call('read', key);
      if (r.status === 404) return null;
      await ok(r, `read ${key}`);
      return Buffer.from(await r.arrayBuffer());
    },
    async list(prefix: string): Promise<string[]> {
      return ((await (await ok(await call('list', prefix), `list ${prefix}`)).json()) as any).names ?? [];
    },
    async remove(key: string) { await ok(await call('remove', key, { method: 'POST' }), `remove ${key}`); },
  };
}
