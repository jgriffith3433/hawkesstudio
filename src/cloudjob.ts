// Agents', scouts' and Talk's Claude Code as Cloud Run jobs (detach.ts mode "cloudrun", docs/studio-cloudrun.md). Studio
// on Cloud Run has no systemd and no sandbox user; each pass runs instead as one execution of the job `studio-agent`
// (the same image as the service, src/cloudjob-run.ts), which is its own sandbox: its own machine, a user without
// Studio's keys, nothing of Studio's but what this file sends. Studio follows each execution the way Hawkes Gen follows
// a Unity build on Cloud Run (hawkesgen src/providers/builder/cloudrun.ts), and mirrors what it writes into the same
// files a local detached process would (<unit>.log, .err, .exit in .data/detached), so DetachedChild, agents.ts and
// talk.ts read it unchanged.
//
// The round trip, under gs://<STUDIO_STATE_BUCKET>/jobs/<unit>/:
//   in   spec.json  what to run (file, args, cwd, a filtered environment with the Claude login), the workspace's git
//                   facts and the token the runner clones with. Private to Studio's and the job's service accounts; the
//                   runner deletes it as soon as it has read it.
//        in.bundle  commits of the workspace that GitHub doesn't have (git bundle HEAD --not --remotes)
//        in.pack    its uncommitted files, Claude Code's session folder for the workspace (so --resume works) and
//                   files the command names by absolute path outside it (an --mcp-config)
//   out  log-NNNNNN, err-NNNNNN  output chunks, every ~2 s
//        out.bundle, out.pack, exit.json  what the pass committed and left uncommitted, the session, then the exit
//   stop           Studio's Stop (a time limit, J's Stop): the runner ends the command
// The workspace runs at the same absolute path in the job, so Claude Code's session folders (named after the path) match.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { DATA, ROOT } from './config.ts';

export type PackFile = { p: string; d: string; m?: number };
export type Pack = { files: PackFile[]; deleted?: string[] };

/** A pack of files (gzip of JSON, base64 bodies): small enough for uncommitted work and session logs. */
export function packFiles(entries: { p: string; file: string }[], deleted: string[] = []): Buffer {
  const files: PackFile[] = [];
  for (const e of entries) {
    try {
      const st = fs.statSync(e.file);
      if (!st.isFile()) continue;
      files.push({ p: e.p, d: fs.readFileSync(e.file).toString('base64'), m: st.mode & 0o777 });
    } catch { /* gone meanwhile */ }
  }
  return zlib.gzipSync(Buffer.from(JSON.stringify({ files, deleted } satisfies Pack)));
}

export const readPack = (b: Buffer): Pack => JSON.parse(zlib.gunzipSync(b).toString('utf8'));

/** Writes a pack's files under `root` (relative paths) or where they say (absolute), and removes its deleted paths. */
export function unpack(pack: Pack, root: string) {
  for (const f of pack.files) {
    const dest = path.isAbsolute(f.p) ? f.p : path.join(root, f.p);
    if (!path.isAbsolute(f.p) && !path.resolve(dest).startsWith(path.resolve(root))) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(f.d, 'base64'), { mode: f.m ?? 0o644 });
  }
  for (const d of pack.deleted ?? []) {
    const dest = path.join(root, d);
    if (path.resolve(dest).startsWith(path.resolve(root))) fs.rmSync(dest, { force: true });
  }
}

/** Every file under a folder, as pack entries named by `name(rel)`. */
export function folderEntries(dir: string, name: (rel: string) => string) {
  const out: { p: string; file: string }[] = [];
  const walk = (d: string) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push({ p: name(path.relative(dir, full).replace(/\\/g, '/')), file: full });
    }
  };
  walk(dir);
  return out;
}

// ------------------------------------------------------------------- git

export const git = (cwd: string, args: string[], o: { input?: string } = {}) => {
  const r = spawnSync('git', ['-c', 'safe.directory=*', ...args], { cwd, encoding: 'buffer', windowsHide: true, maxBuffer: 512 * 1024 * 1024, input: o.input });
  return { ok: r.status === 0, out: (r.stdout ?? Buffer.alloc(0)).toString('utf8').trim(), raw: r.stdout ?? Buffer.alloc(0), err: (r.stderr ?? Buffer.alloc(0)).toString('utf8').trim() };
};
export const isGitWorkspace = (cwd: string) => fs.existsSync(path.join(cwd, '.git'));
/** The remote's address without any credentials in it. */
export const plainRemote = (url: string) => url.replace(/^(https?:\/\/)[^@/]*@/, '$1');

/** The workspace's uncommitted state: changed and new files (not ignored ones) and deleted ones. */
export function dirtyState(cwd: string) {
  const list = (args: string[]) => git(cwd, ['ls-files', '-z', ...args]).raw.toString('utf8').split('\0').filter(Boolean);
  const deleted = new Set(list(['-d']));
  const changed = [...new Set([...list(['-m']), ...list(['-o', '--exclude-standard'])])].filter((f) => !deleted.has(f));
  return { changed, deleted: [...deleted] };
}

/** What a workspace looks like for the job: HEAD, its branch, origin, a bundle of commits GitHub lacks, the dirty files. */
export function workspaceIn(cwd: string, tmp: string) {
  const head = git(cwd, ['rev-parse', 'HEAD']).out;
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  const remote = plainRemote(git(cwd, ['remote', 'get-url', 'origin']).out);
  const bundle = path.join(tmp, 'in.bundle');
  // Only what no remote-tracking ref has: the rest the job clones from GitHub. Empty (HEAD is on GitHub): no bundle.
  const b = git(cwd, ['bundle', 'create', bundle, 'HEAD', '--not', '--remotes']);
  const { changed, deleted } = dirtyState(cwd);
  return { head, branch, remote, bundle: b.ok && fs.existsSync(bundle) ? bundle : null, changed, deleted };
}

/**
 * Brings a job's result into the local workspace: its commits (out.bundle) and HEAD, then exactly its uncommitted files.
 * Untracked files the pass removed are removed here too (git clean, never ignored files such as node_modules).
 */
export function applyWorkspace(cwd: string, o: { head: string; bundle: string | null; pack: Pack | null }) {
  if (o.bundle) {
    const f = git(cwd, ['fetch', '--quiet', o.bundle, 'HEAD']);
    if (!f.ok) throw new Error(`couldn't read the job's commits: ${f.err.split('\n').pop()}`);
  }
  if (o.head && git(cwd, ['rev-parse', 'HEAD']).out !== o.head) {
    const r = git(cwd, ['reset', '--quiet', '--hard', o.head]);
    if (!r.ok) throw new Error(`couldn't move to the job's HEAD ${o.head.slice(0, 7)}: ${r.err.split('\n').pop()}`);
  } else git(cwd, ['reset', '--quiet', '--hard']);
  git(cwd, ['clean', '-fdq']);
  if (o.pack) unpack(o.pack, cwd);
}

// --------------------------------------------------------------- Claude Code

/** Claude Code's folder (CLAUDE_CONFIG_DIR, else ~/.claude). On Cloud Run it lives in DATA, so it is state that is synced. */
export const claudeDir = (env: NodeJS.ProcessEnv = process.env) => env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
/** The folder Claude Code keeps a workspace's sessions in: its path with every other character a dash. */
export const sessionDir = (cwd: string, env: NodeJS.ProcessEnv = process.env) => path.join(claudeDir(env), 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));

/** What of Studio's environment a job gets (the sandbox's filter, plus how to reach Studio as an agent). */
export function jobEnv(env: NodeJS.ProcessEnv, keep: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv) {
  const out: Record<string, string> = { ...(keep(env) as Record<string, string>) };
  delete out.HOME;
  delete out.PATH;
  delete out.PLAYWRIGHT_BROWSERS_PATH;
  for (const k of ['STUDIO_AGENT_KEY', 'CLAUDE_CONFIG_DIR', 'STUDIO_DATA']) if (env[k]) out[k] = String(env[k]);
  // The service's own address first (it works before studio.hawkesgen.ai points at it, and skips the Worker).
  const url = env.STUDIO_SERVICE_URL || env.STUDIO_URL;
  if (url) out.STUDIO_URL = String(url);
  return out;
}

// ----------------------------------------------------------------- the seam

export type JobRunner = {
  /** Uploads one object of the job's folder. */
  put(key: string, data: Buffer | string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  list(prefix: string): Promise<string[]>;
  remove(key: string): Promise<void>;
  /** Starts the execution; returns its name. */
  start(unit: string): Promise<string>;
  /** null: Cloud Run doesn't know it (any more). */
  state(execution: string): Promise<{ done: boolean; message: string } | null>;
  cancel(execution: string): Promise<void>;
};

/** The real runner: Cloud Storage and the Cloud Run job named by STUDIO_GCP_PROJECT, STUDIO_GCP_REGION, STUDIO_AGENT_JOB. */
export function cloudRunner(): JobRunner {
  const bucket = process.env.STUDIO_STATE_BUCKET;
  const project = process.env.STUDIO_GCP_PROJECT;
  const region = process.env.STUDIO_GCP_REGION || 'us-east4';
  const job = process.env.STUDIO_AGENT_JOB || 'studio-agent';
  if (!bucket || !project) throw new Error('Cloud Run jobs need STUDIO_STATE_BUCKET and STUDIO_GCP_PROJECT');
  const g = () => import('./gcp.ts');
  return {
    put: async (key, data) => { await (await g()).gcsWrite(bucket, key, data); },
    get: async (key) => (await g()).gcsRead(bucket, key),
    list: async (prefix) => (await (await g()).gcsList(bucket, prefix)).map((o) => o.name),
    remove: async (key) => (await g()).gcsDelete(bucket, key),
    start: async (unit) => (await g()).runJob({ project, region, job }, {
      env: { STUDIO_JOB_UNIT: unit },
      timeoutSeconds: Number(process.env.STUDIO_AGENT_JOB_TIMEOUT) || 4 * 3600,
    }),
    state: async (execution) => (await g()).getExecution(execution),
    cancel: async (execution) => (await g()).cancelExecution(execution),
  };
}

let runnerFor: () => JobRunner = cloudRunner;
/** Tests swap in a fake (a folder standing in for the bucket, a function for the job). */
export function setJobRunner(f: (() => JobRunner) | null) {
  runnerFor = f ?? cloudRunner;
}

const DIR = () => path.join(DATA, 'detached');
const local = (unit: string, ext: string) => path.join(DIR(), `${unit}.${ext}`);
const key = (unit: string, name: string) => `jobs/${unit}/${name}`;

type Spec = { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };
type Follow = { unit: string; execution: string | null; seen: { log: number; err: number }; done: boolean; error?: string; stopAsked?: number };
const follows = new Map<string, Follow>();
/** How many jobs Studio is following now (cloudhost.ts keeps the instance up while there are any). */
export const following = () => [...follows.values()].filter((f) => !f.done).length;

/**
 * Starts a command as a Cloud Run job execution: packs and uploads its inputs, then runs the job. Returns at once; what
 * fails later (an upload, the start) ends the process with an error the DetachedChild reads like any exit.
 */
export function startCloudJob(unit: string, spec: Spec, o: { gitToken?: string | null } = {}) {
  fs.mkdirSync(DIR(), { recursive: true, mode: 0o700 });
  for (const ext of ['log', 'err']) fs.writeFileSync(local(unit, ext), '');
  const f: Follow = { unit, execution: null, seen: { log: 0, err: 0 }, done: false };
  follows.set(unit, f);
  void (async () => {
    const r = runnerFor();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-job-'));
    try {
      const cwd = path.resolve(spec.cwd);
      const ws = isGitWorkspace(cwd) ? workspaceIn(cwd, tmp) : null;
      const entries: { p: string; file: string }[] = [];
      if (ws) for (const rel of ws.changed) entries.push({ p: rel, file: path.join(cwd, rel) });
      // The session folder for this workspace, and files the command names outside it (an --mcp-config).
      const sessions = sessionDir(cwd, spec.env);
      entries.push(...folderEntries(sessions, (rel) => path.join(sessions, rel)));
      for (const a of spec.args) if (path.isAbsolute(a) && !a.startsWith(cwd + path.sep) && fs.existsSync(a) && fs.statSync(a).isFile() && fs.statSync(a).size < 1_000_000) entries.push({ p: a, file: a });
      await r.put(key(unit, 'in.pack'), packFiles(entries, ws?.deleted ?? []));
      if (ws?.bundle) await r.put(key(unit, 'in.bundle'), fs.readFileSync(ws.bundle));
      const { sandboxEnv } = await import('./sandbox.ts');
      const env = jobEnv(spec.env, sandboxEnv);
      await r.put(key(unit, 'spec.json'), JSON.stringify({
        file: spec.file, args: spec.args, cwd, env, sessions,
        git: ws ? { head: ws.head, branch: ws.branch, remote: ws.remote, bundle: Boolean(ws.bundle), token: o.gitToken ?? null } : null,
      }));
      f.execution = await r.start(unit);
      await r.put(key(unit, 'execution.txt'), f.execution);
      fs.writeFileSync(local(unit, 'cloud.json'), JSON.stringify({ execution: f.execution }));
    } catch (e: any) {
      end(f, { code: null, signal: null, error: `the Cloud Run job didn't start: ${e.message ?? e}` });
      return;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    follow(f, spec.cwd, spec.env);
  })();
}

/** After a Studio restart: follows a job started before it (the execution's name is in the bucket). */
export function reattachCloudJob(unit: string, cwd: string, env: NodeJS.ProcessEnv = process.env) {
  if (follows.has(unit) || fs.existsSync(local(unit, 'exit'))) return;
  const f: Follow = { unit, execution: null, seen: { log: 0, err: 0 }, done: false };
  follows.set(unit, f);
  fs.mkdirSync(DIR(), { recursive: true, mode: 0o700 });
  // The local mirror starts again from the first chunk (a new instance has none; an old one rewrites what it had).
  for (const ext of ['log', 'err']) fs.writeFileSync(local(unit, ext), '');
  void (async () => {
    try {
      f.execution = (await runnerFor().get(key(unit, 'execution.txt')))?.toString('utf8') ?? null;
    } catch { /* the bucket answers later */ }
    follow(f, cwd, env);
  })();
}

function end(f: Follow, exit: { code: number | null; signal: string | null; error?: string }) {
  f.done = true;
  try {
    fs.writeFileSync(local(f.unit, 'exit.tmp'), JSON.stringify({ ...exit, at: Date.now() }));
    fs.renameSync(local(f.unit, 'exit.tmp'), local(f.unit, 'exit'));
  } catch { /* the folder went */ }
  setTimeout(() => follows.delete(f.unit), 60_000).unref();
}

/** Copies new output chunks into the local files, in order. */
async function pull(f: Follow, r: JobRunner) {
  const names = (await r.list(key(f.unit, 'out/'))).map((n) => n.slice(key(f.unit, 'out/').length)).sort();
  for (const kind of ['log', 'err'] as const) {
    for (const n of names.filter((x) => x.startsWith(`${kind}-`))) {
      const i = Number(n.slice(kind.length + 1));
      if (!(i > f.seen[kind])) continue;
      const b = await r.get(key(f.unit, `out/${n}`));
      if (!b) break;
      fs.appendFileSync(local(f.unit, kind), b);
      f.seen[kind] = i;
    }
  }
  return names;
}

/** Polls the job until its exit.json, then applies its workspace and session and writes the local exit. */
function follow(f: Follow, cwd: string, env: NodeJS.ProcessEnv, every = Number(process.env.STUDIO_JOB_POLL_MS) || 2000) {
  const r = runnerFor();
  let goneAt = 0;
  const tick = async () => {
    if (f.done) return;
    try {
      if (fs.existsSync(local(f.unit, 'stop')) && !f.stopAsked) {
        f.stopAsked = Date.now();
        await r.put(key(f.unit, 'stop'), String(Date.now()));
      }
      if (f.stopAsked && f.execution && Date.now() - f.stopAsked > 20_000) await r.cancel(f.execution);
      const names = await pull(f, r);
      if (names.includes('exit.json')) {
        await finish(f, r, cwd, env);
        return;
      }
      // Cloud Run says it's over but the runner said nothing (killed, out of memory, timed out): wait a little for the
      // last upload, then end it.
      const st = f.execution ? await r.state(f.execution) : null;
      if (f.execution && (!st || st.done)) {
        goneAt ||= Date.now();
        if (Date.now() - goneAt > 30_000) {
          await pull(f, r);
          end(f, { code: null, signal: null, error: `the Cloud Run job ended without its result${st?.message ? `: ${st.message}` : ''}` });
          return;
        }
      }
    } catch (e: any) {
      fs.appendFileSync(local(f.unit, 'err'), `[studio] following the job: ${e.message ?? e}\n`);
    }
    setTimeout(() => void tick(), every).unref();
  };
  void tick();
}

async function finish(f: Follow, r: JobRunner, cwd: string, env: NodeJS.ProcessEnv) {
  const exit = JSON.parse((await r.get(key(f.unit, 'out/exit.json')))?.toString('utf8') ?? '{}');
  try {
    const packB = await r.get(key(f.unit, 'out/out.pack'));
    const pack = packB ? readPack(packB) : null;
    // The session files go where they were (absolute paths); the workspace's files are relative.
    const session = pack ? { files: pack.files.filter((x) => path.isAbsolute(x.p)) } : null;
    const work = pack ? { files: pack.files.filter((x) => !path.isAbsolute(x.p)), deleted: pack.deleted } : null;
    if (session) unpack(session, '/');
    if (exit.git && fs.existsSync(cwd) && isGitWorkspace(cwd)) {
      let bundle: string | null = null;
      if (exit.git.bundle) {
        bundle = path.join(os.tmpdir(), `hs-${f.unit}-out.bundle`);
        fs.writeFileSync(bundle, (await r.get(key(f.unit, 'out/out.bundle')))!);
      }
      try {
        applyWorkspace(cwd, { head: exit.git.head, bundle, pack: work });
      } finally {
        if (bundle) fs.rmSync(bundle, { force: true });
      }
    }
  } catch (e: any) {
    fs.appendFileSync(local(f.unit, 'err'), `[studio] bringing the job's work back: ${e.message ?? e}\n`);
    end(f, { code: exit.code ?? null, signal: exit.signal ?? null, error: `the job's work couldn't be brought back: ${e.message ?? e}` });
    return;
  }
  end(f, { code: exit.code ?? null, signal: exit.signal ?? null, ...(exit.error ? { error: exit.error } : {}) });
  // The job's folder holds a Claude login only in spec.json (already gone) and its output: cleared once applied.
  void (async () => { for (const n of await r.list(key(f.unit, ''))) await r.remove(n); })().catch(() => {});
}

/** Whether Studio still waits on this job (for detach.ts detachedAlive). */
export function cloudJobAlive(unit: string) {
  const f = follows.get(unit);
  if (f) return !f.done;
  return !fs.existsSync(local(unit, 'exit'));
}

/** The MCP servers a job's Claude Code gets: Studio's over its address (stdio client, agents' key), Gen's over HTTPS. */
export function cloudMcp(studioEnv: Record<string, string>, genKey: string) {
  const gen = (process.env.HAWKESGEN_URL ?? '').replace(/\/+$/, '');
  return {
    hawkesstudio: { command: process.execPath, args: [path.join(ROOT, 'bin', 'studio-mcp.mjs')], env: { STUDIO_SERVER: '1', ...studioEnv, ...(process.env.STUDIO_SERVICE_URL || process.env.STUDIO_URL ? { STUDIO_URL: process.env.STUDIO_SERVICE_URL || process.env.STUDIO_URL! } : {}), ...(process.env.STUDIO_AGENT_KEY ? { STUDIO_AGENT_KEY: process.env.STUDIO_AGENT_KEY } : {}) } },
    ...(genKey && gen ? { hawkesgen: { type: 'http', url: `${gen}/mcp`, headers: { Authorization: `Bearer ${genKey}` } } } : {}),
  };
}

// ------------------------------------------------------------- site builds

let building = 0;
/** Beta-site builds Studio waits on now (counted by cloudhost.ts busy() with the passes it follows). */
export const buildsRunning = () => building;

export type CloudBuild = { code: number | null; error?: string; log: string; outputs: Buffer | null };

/**
 * A beta site's build as one execution of the agents' job (previews-cloud.ts): never in Studio's own process, since the
 * code built is beta's or an agent's, and the job is the sandbox (no Studio keys, its own machine). The commit is fetched
 * from GitHub (`bundle`: a local file of commits GitHub lacks, for an agent change not pushed yet); `command` runs in
 * `cwd` (the clone's absolute path; a site in a subfolder cds into it); `outputs` (relative to cwd) come back as a .tgz.
 */
export async function runCloudBuild(unit: string, o: { remote: string; head: string; cwd: string; command: string; outputs: string[]; bundle?: string | null; gitToken?: string | null; timeoutMs?: number; onLine?: (s: string) => void; every?: number }): Promise<CloudBuild> {
  const r = runnerFor();
  const k = (n: string) => key(unit, n);
  building++;
  let execution: string | null = null;
  let log = '';
  try {
    if (o.bundle) await r.put(k('in.bundle'), fs.readFileSync(o.bundle));
    await r.put(k('spec.json'), JSON.stringify({
      kind: 'build', outputs: o.outputs, file: '/bin/sh', args: ['-c', o.command], cwd: o.cwd,
      env: { CI: '1', npm_config_update_notifier: 'false' }, sessions: path.posix.join(o.cwd, '.hawkes-none', 's', 's'),
      git: { head: o.head, branch: 'HEAD', remote: plainRemote(o.remote), bundle: Boolean(o.bundle), token: o.gitToken ?? null, shallow: !o.bundle },
    }));
    execution = await r.start(unit);
    const t0 = Date.now();
    const seen = { log: 0, err: 0 };
    for (;;) {
      const names = (await r.list(k('out/'))).map((n) => n.slice(k('out/').length)).sort();
      for (const kind of ['log', 'err'] as const) {
        for (const n of names.filter((x) => x.startsWith(`${kind}-`))) {
          const i = Number(n.slice(kind.length + 1));
          if (!(i > seen[kind])) continue;
          const b = await r.get(k(`out/${n}`));
          if (!b) break;
          seen[kind] = i;
          const s = b.toString('utf8');
          log = (log + s).slice(-20_000);
          for (const line of s.split('\n').filter(Boolean)) o.onLine?.(line);
        }
      }
      if (names.includes('exit.json')) {
        const exit = JSON.parse((await r.get(k('out/exit.json')))?.toString('utf8') ?? '{}');
        const outputs = names.includes('outputs.tgz') ? await r.get(k('out/outputs.tgz')) : null;
        return { code: exit.code ?? null, ...(exit.error ? { error: exit.error } : {}), log, outputs };
      }
      const st = await r.state(execution);
      if (st?.done) {
        await new Promise((res) => setTimeout(res, o.every ?? 5000));
        if (!(await r.list(k('out/exit.json'))).length) return { code: null, error: `the build job ended without its result${st.message ? `: ${st.message}` : ''}`, log, outputs: null };
        continue;
      }
      if (Date.now() - t0 > (o.timeoutMs ?? 30 * 60_000)) {
        await r.put(k('stop'), String(Date.now())).catch(() => {});
        await r.cancel(execution).catch(() => {});
        return { code: null, error: 'the build took too long', log, outputs: null };
      }
      await new Promise((res) => setTimeout(res, o.every ?? 3000));
    }
  } finally {
    building--;
    void (async () => { for (const n of await r.list(k(''))) await r.remove(n); })().catch(() => {});
  }
}
