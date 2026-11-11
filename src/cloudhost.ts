// Hawkes Studio on Google Cloud Run (docs/studio-cloudrun.md): one instance at most, none while idle. The pattern is
// Hawkes Gen's (hawkesgen src/cloudhost.ts):
//   - The database (studio.db) is streamed to Cloud Storage by Litestream around this process
//     (server/studio-cloudrun/entrypoint.sh) and restored before it starts.
//   - The small state files beside it (settings, agents.json, the Claude accounts, Talk's sessions under claude-home/,
//     the shared memory's export state...) are synced here: pulled before anything reads them, pushed when they change and
//     when Cloud Run stops the instance (gs://<STUDIO_STATE_BUCKET>/state/).
//   - While Studio has work going (a run, an agent change, a Talk answer, a queued go-live, a Cloud Run job it follows), it
//     calls its own /api/health every 45 s: Cloud Run keeps an instance that is serving requests, so a daily run or an
//     agent never loses its machine halfway, and the instance goes away once Studio is idle.
// Product repos are not state: they are cloned from GitHub on demand (repos.ts), into the instance's own disk.

import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.ts';

/**
 * A customer's Studio (a cell, cells.ts) shares one bucket with every other cell, each under its own prefix
 * (STUDIO_STATE_PREFIX, e.g. `o/acme/`): its database, state files and agents' jobs all live under it. J's Studio has none.
 */
export const statePrefix = () => {
  const p = String(process.env.STUDIO_STATE_PREFIX ?? '').trim().replace(/^\/+|\/+$/g, '');
  return p ? `${p}/` : '';
};
const STATE = () => `${statePrefix()}state/`;
/**
 * What is synced: small files under DATA, never the database (Litestream's), detached processes' output (the jobs keep
 * their own in the bucket), worktrees, previews, scratch or logs of single runs, or old repo backups (Studio no longer
 * makes them; a stray one left under DATA must not come back into memory on every start).
 */
const SKIP = /^(studio\.db)(-wal|-shm|-journal)?$|^(detached|tmp|work|previews|logs|cache|npm-cache|talk-mcp|backups|claude-home\/(statsig|todos|shell-snapshots|ide|plugins))(\/|$)|litestream|\.lock$/;
const MAX_BYTES = 20 * 1024 * 1024;

function walk(dir: string, base = dir): string[] {
  let out: string[] = [];
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (SKIP.test(rel)) continue;
    if (e.isDirectory()) out = out.concat(walk(full, base));
    else if (e.isFile() && fs.statSync(full).size <= MAX_BYTES) out.push(rel);
  }
  return out;
}

/** The files to push: those whose size or mtime changed since the last push (`seen`). Exported for the tests. */
export function changedFiles(dir: string, seen: Map<string, string>) {
  const out: string[] = [];
  for (const rel of walk(dir)) {
    const st = fs.statSync(path.join(dir, rel));
    const sig = `${st.size}:${st.mtimeMs}`;
    if (seen.get(rel) !== sig) { out.push(rel); seen.set(rel, sig); }
  }
  return out;
}

/** Whether a path (relative to DATA, with /) is state that is synced. Exported for the tests. */
export const synced = (rel: string) => !SKIP.test(rel);

export const stateBucket = () => process.env.STUDIO_STATE_BUCKET?.trim() || null;

/** Before the rest of Studio loads: brings the state files down from Cloud Storage (a fresh instance has none). */
export async function pullState(dir = DATA) {
  const bucket = stateBucket();
  if (!bucket) return 0;
  const { gcsList, gcsRead } = await import('./gcp.ts');
  let n = 0;
  const prefix = STATE();
  const todo = (await gcsList(bucket, prefix)).filter((o) => { const rel = o.name.slice(prefix.length); return rel && synced(rel) && !rel.includes('..'); });
  // Eight at a time: every cold start waits for this (one by one it was about 5 s for 21 files, 2026-10-30).
  for (let i = 0; i < todo.length; i += 8) {
    await Promise.all(todo.slice(i, i + 8).map(async (o) => {
      const data = await gcsRead(bucket, o.name);
      if (!data) return;
      const dest = path.join(dir, o.name.slice(prefix.length));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data, { mode: 0o600 });
      n++;
    }));
  }
  return n;
}

const seen = new Map<string, string>();
let pushing: Promise<number> | null = null;

/** Pushes the state files that changed. One push at a time; a second call while one runs waits for it. */
export function pushState(dir = DATA): Promise<number> {
  const bucket = stateBucket();
  if (!bucket) return Promise.resolve(0);
  if (pushing) return pushing;
  pushing = (async () => {
    const { gcsWrite } = await import('./gcp.ts');
    let n = 0;
    for (const rel of changedFiles(dir, seen)) {
      await gcsWrite(bucket, `${STATE()}${rel}`, path.join(dir, rel));
      n++;
    }
    return n;
  })().finally(() => { pushing = null; });
  return pushing;
}

/** What keeps the instance up: work Studio is doing or following. Each part fails closed (unknown = not busy). */
export async function busy(): Promise<string | null> {
  try {
    const { activeRun } = await import('./pipeline.ts');
    if (activeRun()) return 'a run';
  } catch { /* not loaded */ }
  try {
    const { db } = await import('./db.ts');
    const changes = db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE status IN ('working', 'revising', 'verifying')`).get() as { n: number };
    if (changes.n) return `${changes.n} agent change(s)`;
  } catch { /* table missing */ }
  try {
    const { following, buildsRunning } = await import('./cloudjob.ts');
    if (following() > 0) return 'a Cloud Run job';
    if (buildsRunning() > 0) return 'a beta site build';
  } catch { /* not loaded */ }
  // The whole of a beta site's build, not only its Cloud Run job: reading the sources and publishing the files too
  // (2026-10-31: a customer's Studio went idle mid-publish and Cloud Run stopped it).
  try {
    if ((await import('./previews.ts')).previewsBuilding() > 0) return 'a beta site build';
  } catch { /* not loaded */ }
  try {
    if ((await import('./cells.ts')).rollingCells()) return "a roll of customers' Studios";
  } catch { /* not loaded */ }
  try {
    const ops = await import('./ops.ts');
    if (ops.listOps({ since: Date.now() }).some((o) => o.status === 'queued' || o.status === 'running')) return 'a background operation';
  } catch { /* not loaded */ }
  return await waitingWork();
}

/**
 * Work Studio owns that waits (a gate, a retry, Gen, a build): it moves on only while Studio runs, because every wake for
 * it (a gate's event, a retry's timer, the PM's pass) lives in this process. Before 2026-11-11 only work in flight kept
 * the instance up, so with every change held by a gate Cloud Run stopped Studio and the queue sat until someone opened
 * the site. Each kind here has an end of its own (a deadline, the 6 h Unity hold, an op's retries), so this can't hold
 * the instance up for ever. Work waiting on a person (a question, an Inbox card) doesn't count: that wakes Studio itself.
 */
export async function waitingWork(): Promise<string | null> {
  try {
    const { db } = await import('./db.ts');
    const q = (sql: string) => { try { return (db.prepare(sql).get() as { n: number }).n; } catch { return 0; } };
    const changes = q(`SELECT COUNT(*) AS n FROM changes WHERE status IN ('queued', 'waiting on Gen', 'ready')`);
    if (changes) return `${changes} agent change(s) waiting to go on`;
    const ops = q(`SELECT COUNT(*) AS n FROM ops WHERE status = 'waiting'`);
    if (ops) return `${ops} background operation(s) waiting`;
    const runs = q(`SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')`);
    if (runs) return `${runs} run(s) waiting`;
    // Bounded: a merged task gets beta's build within the Unity hold's 6 h (unitybuild-policy.ts), so only that window counts.
    const merged = q(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'merged' AND (build IS NULL OR build LIKE '%"unproven":true%') AND merged_at > ${Date.now() - 7 * 3600_000}`);
    if (merged) return `${merged} merged task(s) waiting for beta's build`;
  } catch { /* no database yet */ }
  return null;
}

/** The service's own address (the deploy passes it on). */
const selfUrl = () => (process.env.STUDIO_SERVICE_URL ?? '').replace(/\/+$/, '');

/** Starts the push loop, the keep-alive and nothing else (the stop handler is server.ts's). */
export function startCloudHost({ every = 30_000, ping = 45_000 } = {}) {
  // What came down from the bucket counts as already pushed, so the first loop sends only real changes.
  changedFiles(DATA, seen);
  setInterval(() => void pushState().catch((e) => console.warn(`[cloudhost] state push: ${e.message}`)), every).unref();
  // One writer at a time (cloudlease.ts): once a newer instance has claimed the database, this one saves its state and
  // stops, so nothing it writes afterwards is lost on a copy nobody reads.
  void import('./cloudlease.ts').then((L) => L.watchLease((by) => {
    logExit('lease-lost', `${by.rev ?? 'another instance'} (${by.id}) took the database, how: ${by.how ?? 'unknown'}; saving state and stopping`);
    void flushOnStop().finally(() => process.exit(0));
  })).catch((e) => console.warn(`[cloudhost] lease: ${e.message}`));
  // Once, a minute after start (the jobs Studio follows are re-attached by then): executions nobody follows are cancelled.
  setTimeout(() => void import('./cloudjob.ts').then((m) => m.cancelStrayExecutions()).catch((e) => console.warn(`[cloudhost] stray executions: ${e.message}`)), 60_000).unref();
  const url = selfUrl();
  if (!url) {
    console.warn('[cloudhost] STUDIO_SERVICE_URL is not set: nothing keeps the instance up while work runs');
    return;
  }
  setInterval(() => void busy().then(async (why) => {
    if (why) await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(20_000) });
  }).catch(() => {}), ping).unref();
}

/**
 * One line for every deliberate exit, on stdout and stderr as JSON with a severity (Cloud Logging shows those as entries),
 * and best effort in the state bucket (db/exit-<time>-<id>), which stays readable even when the log doesn't show it.
 */
export function logExit(path: string, why: string) {
  const line = { severity: 'WARNING', message: `[studio] exit via ${path}: ${why}`, exitPath: path, revision: process.env.K_REVISION ?? null };
  console.log(JSON.stringify(line));
  console.error(line.message);
  void import('./cloudlease.ts').then((L) => L.recordExit(path, why)).catch(() => {});
}

/** Cloud Run sends SIGTERM and allows 10 s: push the state first. Returns once it's done or after 8 s. */
export async function flushOnStop() {
  await Promise.race([pushState().catch((e) => console.warn(`[cloudhost] final push: ${e.message}`)), new Promise((r) => setTimeout(r, 8000))]);
}
