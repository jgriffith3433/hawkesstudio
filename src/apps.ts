// App servers: web products that are servers with their own database (products.json "app": the customer portal,
// hawkesgenwebsite). previews.ts publishes the other web products' beta and changes as static files; an app has no files
// to publish, so Studio runs it instead, one process per lane:
//
//   beta        the beta site (https://<sub>.hawkesgen.com/), from the preview worktree at beta's commit; on the server
//               on the product's local.port, so the "local" playtests play it (local.ts ensureServer)
//   c_<id>      an agent change (/c/<id>/ on the same host: dev-front.ts switches lanes by cookie), started when opened,
//               stopped after 30 idle minutes
//   serve-<n>   an agent change's verification playtest (local.ts serveDir), on the port it asked for
//   local       J's PC: the checkout itself, on local.port
//
// Each lane gets its own data folder (.work/apps/<product>/<lane>), its public address and, from `app.gen`, Hawkes Gen's
// address and a key of its own: made once by Studio (POST /v1/clients, role user, only app.gen.projects), kept in
// .data/app-keys.json (0600). Never Studio's environment: an app runs the code on beta or on an agent's branch, so on the
// server it runs as the agent sandbox's user (sandbox.ts) with only the variables it is given. Restarting Studio ends
// them (they're in its unit); the next request or playtest starts them again.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { DATA, GEN_URL, PROJECTS, paths, loadProducts, type Product } from './config.ts';
import { gen } from './gen.ts';
import { sandboxOn, sandboxSpawn, gidOf, AGENT_GROUP } from './sandbox.ts';

const WIN = process.platform === 'win32';
/** Change lanes stop after this long without a request. Beta and local keep running. */
export const APP_IDLE_MS = 30 * 60_000;
const START_MS = 90_000;
const KEYS = path.join(DATA, 'app-keys.json');
const STATE = path.join(DATA, 'apps.json');

export type AppStatus = 'starting' | 'running' | 'failed' | 'stopped';
type App = {
  product: string;
  lane: string;
  dir: string;
  sha: string | null;
  port: number;
  status: AppStatus;
  detail: string;
  started: number;
  lastUsed: number;
  pid?: number;
  child?: ChildProcess;
};

const apps = new Map<string, App>();
const keyOf = (product: string, lane: string) => `${product}/${lane}`;
export const isApp = (p: Product) => Boolean(p.app);
export const isLane = (s: string) => /^(beta|local|c_[0-9a-f]+|serve-\d+)$/.test(s);

/** Pids Studio started, so a server left over from before a restart (J's PC) is stopped before its port is reused. */
function saveState() {
  const rows = [...apps.values()].filter((a) => a.pid && (a.status === 'running' || a.status === 'starting')).map((a) => ({ product: a.product, lane: a.lane, pid: a.pid, port: a.port }));
  try { fs.writeFileSync(STATE, JSON.stringify(rows, null, 2)); } catch { /* best effort */ }
}
function leftovers(): { product: string; lane: string; pid: number; port: number }[] {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return []; }
}

function kill(pid: number) {
  if (WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
}

async function answers(port: number, p = '/') {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
    return r.status < 500;
  } catch {
    return false;
  }
}
async function healthy(port: number, health: string) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${health}`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** The product's own Gen key (made once, scoped to app.gen.projects), or null when it has no `gen`. */
export async function appGenKey(p: Product): Promise<string | null> {
  const want = p.app?.gen?.projects;
  if (!want?.length) return null;
  let keys: Record<string, { key: string; projects: string[]; client?: string }> = {};
  try { keys = JSON.parse(fs.readFileSync(KEYS, 'utf8')); } catch { /* none yet */ }
  const have = keys[p.id];
  if (have && JSON.stringify(have.projects) === JSON.stringify(want)) return have.key;
  // A changed scope makes a new key; the old client stays in Gen (disable it there if it matters).
  const made: any = await gen.request('/clients', { method: 'POST', body: { name: `beta-${p.id}-app`, role: 'user', projects: want } });
  if (!made?.key) throw new Error(`Hawkes Gen didn't make a key for ${p.name}'s beta`);
  keys[p.id] = { key: made.key, projects: want, client: made.client?.id };
  fs.writeFileSync(KEYS, JSON.stringify(keys, null, 2), { mode: 0o600 });
  try { fs.chmodSync(KEYS, 0o600); } catch { /* Windows */ }
  return made.key;
}

/** A lane's own data folder, outside its checkout (git clean never touches it), writable by the sandbox's user. */
export function appDataDir(p: Product, lane: string) {
  const dir = path.join(PROJECTS, '.work', 'apps', p.id, lane);
  fs.mkdirSync(dir, { recursive: true });
  if (sandboxOn()) {
    const gid = gidOf(AGENT_GROUP);
    for (const d of [path.dirname(path.dirname(dir)), path.dirname(dir), dir]) {
      try {
        if (gid !== null && fs.statSync(d).gid !== gid) fs.chownSync(d, -1, gid);
        fs.chmodSync(d, 0o2775);
      } catch { /* the sandbox user's own folder already */ }
    }
  }
  return dir;
}

/** Only what a program needs to run: no keys, tokens or Studio settings. */
function baseEnv(): Record<string, string> {
  const keep = /^(PATH|PATHEXT|SYSTEMROOT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|LANG|LC_\w+|TZ|NODE_OPTIONS|NODE_EXTRA_CA_CERTS)$/;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && keep.test(k)) env[k] = v;
  return env;
}

/** The variables an app is started with (its port, data, address, Gen), app.env last. */
export async function appEnv(p: Product, lane: string, port: number, publicUrl: string) {
  const a = p.app!;
  const own: Record<string, string> = { [a.portEnv]: String(port), [a.dataEnv]: appDataDir(p, lane), HAWKES_BETA: lane === 'local' ? '0' : '1' };
  if (a.urlEnv) own[a.urlEnv] = publicUrl.replace(/\/+$/, '');
  if (a.gen) {
    own[a.gen.urlEnv] = GEN_URL;
    const key = await appGenKey(p);
    if (key) own[a.gen.keyEnv] = key;
  }
  return { ...own, ...(a.env ?? {}) };
}

/**
 * Makes sure the product's app runs for `lane` from `dir` (at `sha`), and answers its health check. The same dir and
 * sha already running: nothing to do. Otherwise the old one is stopped and a new one started. port: a fixed port (beta
 * on the server and local use local.port, verifications theirs); else a free one.
 */
export function ensureApp(p: Product, lane: string, dir: string, o: { sha?: string | null; port?: number; publicUrl: string }): Promise<App> {
  if (!p.app) throw new Error(`${p.name} isn't an app (products.json "app")`);
  if (!isLane(lane)) throw new Error(`Not a lane: ${lane}`);
  const k = keyOf(p.id, lane);
  const busy = starting.get(k);
  if (busy) return busy;
  const run = (async () => {
    const cur = apps.get(k);
    if (cur && cur.status === 'running' && cur.dir === dir && cur.sha === (o.sha ?? null) && (!o.port || cur.port === o.port) && await healthy(cur.port, p.app!.health)) {
      cur.lastUsed = Date.now();
      return cur;
    }
    if (cur) await stopApp(p.id, lane, 'restarting it');
    return start(p, lane, dir, o);
  })().finally(() => starting.delete(k));
  starting.set(k, run);
  return run;
}
/** Starts under way, per lane: a second caller waits for the same one. */
const starting = new Map<string, Promise<App>>();

async function start(p: Product, lane: string, dir: string, o: { sha?: string | null; port?: number; publicUrl: string }): Promise<App> {
  const k = keyOf(p.id, lane);
  // A server Studio started before a restart and lost track of: stop it before its port is taken again.
  for (const l of leftovers().filter((x) => x.product === p.id && (x.lane === lane || (o.port && x.port === o.port)))) kill(l.pid);
  const port = o.port ?? await freePort();
  if (o.port) {
    const end = Date.now() + 15_000;
    while (Date.now() < end && await answers(port)) await new Promise((r) => setTimeout(r, 500));
    if (await answers(port)) throw new Error(`something else is already on port ${port} (not ${p.name}'s ${lane} that Studio started)`);
  }
  const app: App = { product: p.id, lane, dir, sha: o.sha ?? null, port, status: 'starting', detail: `starting ${p.app!.start}`, started: Date.now(), lastUsed: Date.now() };
  apps.set(k, app);
  const own = await appEnv(p, lane, port, o.publicUrl);
  fs.mkdirSync(paths.logs, { recursive: true });
  const logFile = path.join(paths.logs, `app-${p.id}-${lane}.log`);
  const log = fs.openSync(logFile, 'a');
  fs.writeSync(log, `\n--- ${new Date().toISOString()} ${lane} ${o.sha ?? ''} on :${port} in ${dir}\n`);
  const [file, args] = WIN ? ['cmd.exe', ['/c', p.app!.start]] : ['/bin/sh', ['-c', `exec ${p.app!.start}`]];
  // On the server: as the sandbox's user (an app runs beta's or an agent's code), with only `own` and a plain PATH.
  const child = sandboxSpawn(file, args, { cwd: dir, env: baseEnv(), own, detached: !WIN, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  app.child = child;
  app.pid = child.pid;
  saveState();
  child.on('exit', (code, signal) => {
    if (apps.get(k) !== app) return;
    if (app.status === 'running' || app.status === 'starting') Object.assign(app, { status: 'failed', detail: `it exited (${signal ?? code}); see .data/logs/app-${p.id}-${lane}.log` });
    app.pid = undefined;
    app.child = undefined;
    saveState();
  });
  child.on('error', (e) => {
    if (apps.get(k) === app) Object.assign(app, { status: 'failed', detail: `couldn't start it: ${e.message}` });
  });
  const end = Date.now() + START_MS;
  while (Date.now() < end) {
    if (app.status === 'failed') break;
    if (await healthy(port, p.app!.health)) {
      Object.assign(app, { status: 'running', detail: `on :${port}${app.sha ? ` at ${app.sha}` : ''}`, lastUsed: Date.now() });
      return app;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const tail = (() => { try { return fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-4).join(' | ').slice(-400); } catch { return ''; } })();
  const why = app.status === 'failed' ? app.detail : `it didn't answer ${p.app!.health} on :${port} in ${START_MS / 1000} s`;
  await stopApp(p.id, lane, 'it failed to start');
  Object.assign(app, { status: 'failed', detail: `${why}${tail ? `: ${tail}` : ''}` });
  apps.set(k, app);
  throw new Error(`${p.name} (${lane}) didn't start: ${app.detail}`);
}

/** Stops a lane's app (if Studio runs one). */
export async function stopApp(product: string, lane: string, why = 'stopped') {
  const k = keyOf(product, lane);
  const a = apps.get(k);
  if (!a) return false;
  const pid = a.pid;
  Object.assign(a, { status: 'stopped' as const, detail: why, pid: undefined, child: undefined });
  if (pid) {
    kill(pid);
    const end = Date.now() + 10_000;
    while (Date.now() < end && a.port && await answers(a.port)) await new Promise((r) => setTimeout(r, 250));
  }
  saveState();
  return true;
}

/** Stops a lane in every product (a verification's serve-<port> ends: local.ts stopServed). */
export function stopLane(lane: string, why?: string) {
  for (const a of apps.values()) if (a.lane === lane) void stopApp(a.product, lane, why);
}

/** The port a running lane answers on (and marks it used), or null. */
export function appPort(product: string, lane: string) {
  const a = apps.get(keyOf(product, lane));
  if (!a || a.status !== 'running') return null;
  a.lastUsed = Date.now();
  return a.port;
}

export function appStatus(product: string, lane: string) {
  const a = apps.get(keyOf(product, lane));
  return a ? { lane: a.lane, status: a.status, detail: a.detail, port: a.port, sha: a.sha, started: a.started, lastUsed: a.lastUsed } : null;
}
export function listApps() {
  return [...apps.values()].map((a) => ({ product: a.product, ...appStatus(a.product, a.lane)! }));
}

/** Change and verification lanes stop after APP_IDLE_MS without a request. */
export function sweepApps(now = Date.now()) {
  const stopped: string[] = [];
  for (const a of apps.values()) {
    if (a.status !== 'running' || a.lane === 'beta' || a.lane === 'local') continue;
    if (now - a.lastUsed > APP_IDLE_MS) {
      void stopApp(a.product, a.lane, `idle for ${Math.round(APP_IDLE_MS / 60_000)} minutes`);
      stopped.push(keyOf(a.product, a.lane));
    }
  }
  return stopped;
}
let sweeper: NodeJS.Timeout | null = null;
export function startAppSweeper() {
  if (sweeper || !loadProducts().some(isApp)) return;
  sweeper = setInterval(() => sweepApps(), 5 * 60_000);
  sweeper.unref();
}
