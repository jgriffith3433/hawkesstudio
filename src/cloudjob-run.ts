// The Cloud Run job's side of src/cloudjob.ts: one execution of `studio-agent` runs one agent's, scout's or Talk's
// Claude Code pass. Started by the image's entry with STUDIO_JOB_UNIT set:
//
//   node src/cloudjob-run.ts            (reads gs://<STUDIO_STATE_BUCKET>/jobs/<unit>/spec.json)
//
// 1. Reads the spec and deletes it at once (it holds the Claude login and the clone token).
// 2. Rebuilds the workspace at the same absolute path: a clone from GitHub (the token goes only on that one command, as a
//    header: it is never written to the clone), the commits GitHub lacks (in.bundle), the uncommitted files, Claude Code's
//    session folder and the files the command names (in.pack).
// 3. Runs the command as the unprivileged user `agent` when this runs as root (the image), so nothing the pass runs can
//    read this process's memory or the token. Output goes up in chunks every ~2 s (a Talk answer's within a quarter
//    second of being written: spec.flushMs), and after each upload the runner nudges Studio (POST
//    /api/cloudjobs/<unit>/nudge with the agents' key its MCP server uses) so it reads them now instead of on its next
//    look; a `stop` object ends the command.
// 4. Sends back what the pass committed (out.bundle) and left uncommitted plus the session (out.pack), then exit.json.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { git, packFiles, readPack, unpack, folderEntries, dirtyState, type JobRunner } from './cloudjob.ts';

type Store = Pick<JobRunner, 'put' | 'get' | 'list' | 'remove'>;
// kind "build" (previews-cloud.ts): a beta site's build of one commit, in a shallow clone when GitHub has the commit; no
// session or workspace goes back, only `outputs` (paths in the workspace) as out/outputs.tgz.
// The clone is partial (`--filter=blob:none`: git fetches the blobs a checkout needs, with the token) and skips Git LFS
// files unless the spec asks (`lfs`), so a big repo (a Unity project of GBs) is never pulled whole; `partial: false` asks
// for a full clone (Studio's spec for a small repo, so the pass can read any old file without a token).
type JobGit = { head: string; branch: string; remote: string; bundle: boolean; token: string | null; shallow?: boolean; partial?: boolean; lfs?: boolean };
type Spec = { kind?: 'build'; outputs?: string[]; file: string; args: string[]; cwd: string; env: Record<string, string>; sessions: string; git: JobGit | null; flushMs?: number };
/** Tells Studio new output is in the bucket (resolves either way, never throws). */
type Nudge = () => Promise<void>;

/**
 * The real nudge: Studio's address and the agents' key from the pass's own environment (cloudjob.ts jobEnv gives both,
 * for its MCP server), so nothing new is provisioned. Carries nothing but the unit: Studio only ever reads the output
 * from the bucket. Null without them (a local test, a Studio without the key).
 */
export function httpNudge(unit: string) {
  return (env: Record<string, string>): Nudge | null => {
    const url = String(env.STUDIO_URL ?? '').replace(/\/+$/, '');
    const key = String(env.STUDIO_AGENT_KEY ?? '').trim();
    if (!/^https?:\/\//.test(url) || !key) return null;
    return () => fetch(`${url}/api/cloudjobs/${encodeURIComponent(unit)}/nudge`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) })
      .then((r) => void r.body?.cancel().catch(() => {}), () => {});
  };
}

/** The workspace clone's arguments (no checkout: prepare checks the head out after the bundle). Exported for the tests. */
export const jobCloneArgs = (g: Pick<JobGit, 'remote' | 'partial'>, cwd: string) => ['clone', '--quiet', '--no-checkout', ...(g.partial === false ? [] : ['--filter=blob:none']), g.remote, cwd];
/** The environment for the clone's checkouts: LFS files skipped unless the spec asks for them. Exported for the tests. */
export const jobGitEnv = (g: Pick<JobGit, 'lfs'>): Record<string, string> => g.lfs ? {} : { GIT_LFS_SKIP_SMUDGE: '1' };
/** What a clone without LFS files keeps in its config, so the pass's own checkouts skip them too. */
const SKIP_LFS: [string, string][] = [['filter.lfs.smudge', 'git-lfs smudge --skip -- %f'], ['filter.lfs.process', 'git-lfs filter-process --skip']];


/** The unprivileged user the pass runs as (made in the image), when this runner is root. */
function agentUser() {
  if (process.getuid?.() !== 0) return null;
  const name = process.env.STUDIO_JOB_USER || 'agent';
  const r = spawnSync('id', ['-u', name], { encoding: 'utf8' });
  const g = spawnSync('id', ['-g', name], { encoding: 'utf8' });
  if (r.status !== 0 || g.status !== 0) return null;
  return { name, uid: Number(r.stdout.trim()), gid: Number(g.stdout.trim()), home: `/home/${name}` };
}

/** git with the clone token as a one-off header (never in the clone's config or remote URL). */
function gitWithToken(cwd: string, args: string[], token: string | null, env: Record<string, string> = {}) {
  // `-c` reaches the git processes this one starts too (GIT_CONFIG_PARAMETERS): a partial clone's lazy blob fetch.
  const auth = token ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`] : [];
  const r = spawnSync('git', ['-c', 'safe.directory=*', ...auth, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, ok: r.status === 0, err: String(r.stderr ?? r.error?.message ?? '').trim() };
}

/** Rebuilds the workspace; returns the HEAD the pass starts from. */
export async function prepare(unit: string, spec: Spec, store: Store, log: (s: string) => void, at: (p: string) => string = (p) => p) {
  const key = (n: string) => `jobs/${unit}/${n}`;
  const cwd = at(spec.cwd);
  if (spec.git) {
    fs.mkdirSync(path.dirname(cwd), { recursive: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    const env = jobGitEnv(spec.git);
    if (spec.git.shallow && !spec.git.bundle) {
      // Just that commit (a beta site's build): GitHub hands out any commit it has by id.
      fs.mkdirSync(cwd, { recursive: true });
      git(cwd, ['init', '--quiet']);
      const f = gitWithToken(cwd, ['fetch', '--quiet', '--depth', '1', spec.git.remote, spec.git.head], spec.git.token);
      if (f.status !== 0) throw new Error(`fetch of ${spec.git.head.slice(0, 7)} failed: ${f.err.split('\n').pop()}`);
      const co = gitWithToken(cwd, ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], null, env);
      if (!co.ok) throw new Error(`checkout of ${spec.git.head.slice(0, 7)}: ${co.err.split('\n').pop()}`);
      log(`[job] ${spec.git.remote} at ${spec.git.head.slice(0, 7)} (shallow)`);
      return git(cwd, ['rev-parse', 'HEAD']).out;
    }
    const c = gitWithToken(path.dirname(cwd), jobCloneArgs(spec.git, cwd), spec.git.token, env);
    if (c.status !== 0) throw new Error(`clone failed: ${c.err.split('\n').pop()}`);
    if (!spec.git.lfs) for (const [k, v] of SKIP_LFS) git(cwd, ['config', k, v]);
    if (spec.git.bundle) {
      const b = await store.get(key('in.bundle'));
      const file = path.join(os.tmpdir(), `${unit}-in.bundle`);
      fs.writeFileSync(file, b!);
      const f = git(cwd, ['fetch', '--quiet', file, 'HEAD']);
      if (!f.ok) throw new Error(`the workspace's own commits: ${f.err.split('\n').pop()}`);
    }
    // With the token: a partial clone fetches the head's blobs from GitHub here.
    const co = spec.git.branch && spec.git.branch !== 'HEAD'
      ? gitWithToken(cwd, ['checkout', '--quiet', '-B', spec.git.branch, spec.git.head], spec.git.token, env)
      : gitWithToken(cwd, ['checkout', '--quiet', '--detach', spec.git.head], spec.git.token, env);
    if (!co.ok) throw new Error(`checkout of ${spec.git.head.slice(0, 7)}: ${co.err.split('\n').pop()}`);
    // As in Studio's own clone: the agent's brief and notes never go into a commit.
    fs.appendFileSync(path.join(cwd, '.git', 'info', 'exclude'), '\n.hawkes/\n');
    log(`[job] workspace ${spec.git.remote} at ${spec.git.head.slice(0, 7)} (${spec.git.branch}${spec.git.partial === false ? '' : ', partial clone'}${spec.git.lfs ? '' : ', no LFS files'})`);
  } else fs.mkdirSync(cwd, { recursive: true });
  const pack = await store.get(key('in.pack'));
  if (pack) {
    const p = readPack(pack);
    for (const f of p.files.filter((x) => path.isAbsolute(x.p))) unpack({ files: [{ ...f, p: at(f.p) }] }, '/');
    unpack({ files: p.files.filter((f) => !path.isAbsolute(f.p)), deleted: p.deleted }, cwd);
  }
  return spec.git ? git(cwd, ['rev-parse', 'HEAD']).out : null;
}

/** What the pass did: its new commits (a bundle), its uncommitted files and the session folder. */
export function collect(spec: Spec, start: string | null, tmp: string, at: (p: string) => string = (p) => p) {
  const cwd = at(spec.cwd);
  const entries = folderEntries(at(spec.sessions), (rel) => path.join(spec.sessions, rel));
  let gitOut: { head: string; bundle: boolean } | null = null;
  let deleted: string[] = [];
  let bundle: string | null = null;
  if (spec.git && fs.existsSync(path.join(cwd, '.git'))) {
    const head = git(cwd, ['rev-parse', 'HEAD']).out;
    if (start && head && head !== start) {
      bundle = path.join(tmp, 'out.bundle');
      const b = git(cwd, ['bundle', 'create', bundle, 'HEAD', `^${start}`]);
      if (!b.ok) bundle = null;
    }
    const d = dirtyState(cwd);
    deleted = d.deleted;
    for (const rel of d.changed) entries.push({ p: rel, file: path.join(cwd, rel) });
    // The agent's notes (.hawkes/: its summary, question, stuck notes) come back by name: they're excluded from git.
    const have = new Set(entries.map((e) => e.p));
    entries.push(...folderEntries(path.join(cwd, '.hawkes'), (rel) => `.hawkes/${rel}`).filter((e) => !have.has(e.p)));
    gitOut = { head, bundle: Boolean(bundle) };
  }
  return { pack: packFiles(entries, deleted), bundle, git: gitOut };
}

/**
 * The whole execution. `store` is the bucket; `at` places absolute paths (tests: under a scratch root, as if on another
 * machine); `nudge` makes the function that tells Studio new output is up (the job's entry: httpNudge; tests their own).
 */
export async function runUnit(unit: string, store: Store, { every = 2000, at = (p: string) => p, nudge = null }: { every?: number; at?: (p: string) => string; nudge?: ((env: Record<string, string>) => Nudge | null) | null } = {}): Promise<number> {
  const key = (n: string) => `jobs/${unit}/${n}`;
  const chunks = { log: [] as Buffer[], err: [] as Buffer[] };
  const n = { log: 0, err: 0 };
  // One nudge at a time; more output meanwhile sends one more after it (never a pile of requests).
  let send: Nudge | null = null;
  let nudging: Promise<void> | null = null;
  let nudgeAgain = false;
  const poke = () => {
    if (!send) return;
    if (nudging) return void (nudgeAgain = true);
    nudging = (async () => {
      do {
        nudgeAgain = false;
        await send!();
      } while (nudgeAgain);
    })().finally(() => { nudging = null; });
  };
  // Uploads go one after another, so chunk n+1 is never in the bucket before chunk n (Studio reads them in order and
  // skips numbers it has passed). One that fails doesn't stop the next ones.
  let uploads: Promise<void> = Promise.resolve();
  const flush = () => (uploads = uploads.catch(() => {}).then(async () => {
    let wrote = false;
    for (const kind of ['log', 'err'] as const) {
      if (!chunks[kind].length) continue;
      const data = Buffer.concat(chunks[kind].splice(0));
      await store.put(key(`out/${kind}-${String(++n[kind]).padStart(6, '0')}`), data);
      wrote = true;
    }
    if (wrote) poke();
  }));
  const say = (s: string) => chunks.err.push(Buffer.from(`${s}\n`));
  let spec: Spec;
  try {
    const raw = await store.get(key('spec.json'));
    if (!raw) throw new Error('no spec');
    spec = JSON.parse(raw.toString('utf8'));
    await store.remove(key('spec.json'));
    send = nudge?.(spec.env ?? {}) ?? null;
  } catch (e: any) {
    say(`[job] ${e.message}`);
    await flush();
    await store.put(key('out/exit.json'), JSON.stringify({ code: null, signal: null, error: `no spec: ${e.message}` }));
    return 1;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-run-'));
  let start: string | null = null;
  let code: number | null = null;
  let signal: string | null = null;
  let error: string | undefined;
  try {
    start = await prepare(unit, spec, store, say, at);
    const user = agentUser();
    if (user) {
      // The pass's user owns its workspace and session folder (and nothing of this runner's).
      for (const d of [at(spec.cwd), path.dirname(path.dirname(at(spec.sessions))), user.home]) spawnSync('chown', ['-R', `${user.uid}:${user.gid}`, d]);
      // And the files its command names by absolute path (Talk's --mcp-config, 0600): unreadable to it otherwise, so Claude
      // Code stopped with EACCES before answering (2026-10-29).
      for (const a of spec.args) if (path.isAbsolute(a) && fs.existsSync(at(a)) && fs.statSync(at(a)).isFile()) spawnSync('chown', [`${user.uid}:${user.gid}`, at(a)]);
    }
    const env = { ...spec.env, PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: user?.home ?? os.homedir(), STUDIO_JOB: '1' };
    const child = spawn(spec.file, spec.args, { cwd: at(spec.cwd), env, stdio: ['ignore', 'pipe', 'pipe'], ...(user ? { uid: user.uid, gid: user.gid } : {}), windowsHide: true });
    // Output goes up `flushMs` after it's written (Talk's answers: a quarter second), else on the timer below.
    const flushMs = Number(spec.flushMs) > 0 ? Number(spec.flushMs) : 0;
    let soon: NodeJS.Timeout | null = null;
    const wrote = () => {
      if (!flushMs || soon) return;
      soon = setTimeout(() => { soon = null; void flush().catch(() => {}); }, flushMs);
    };
    child.stdout.on('data', (d: Buffer) => { chunks.log.push(d); wrote(); });
    child.stderr.on('data', (d: Buffer) => { chunks.err.push(d); wrote(); });
    const timer = setInterval(() => void (async () => {
      await flush();
      if ((await store.list(key('stop'))).length && child.exitCode === null) {
        child.kill('SIGTERM');
        setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 10_000).unref();
      }
    })().catch(() => {}), every);
    [code, signal] = await new Promise<[number | null, string | null]>((resolve) => {
      child.on('error', (e) => { error = e.message; resolve([null, null]); });
      child.on('close', (c, s) => resolve([c, s]));
    });
    clearInterval(timer);
    if (soon) clearTimeout(soon);
  } catch (e: any) {
    error = String(e.message ?? e);
    say(`[job] ${error}`);
  }
  if (spec.kind === 'build') {
    // A build sends back its outputs only (never the workspace or a session).
    try {
      const cwd = at(spec.cwd);
      const have = (spec.outputs ?? []).filter((o) => !path.isAbsolute(o) && !o.split(/[\\/]/).includes('..') && fs.existsSync(path.join(cwd, o)));
      if (code === 0 && !error && have.length) {
        // To stdout, from inside the workspace: no paths for tar to misread.
        const t = spawnSync('tar', ['-czf', '-', '--', ...have], { cwd, encoding: 'buffer', maxBuffer: 4 * 1024 ** 3 });
        if (t.status !== 0) throw new Error(`tar: ${String(t.stderr).trim().slice(0, 300)}`);
        await store.put(key('out/outputs.tgz'), t.stdout);
      }
      await flush();
      await store.put(key('out/exit.json'), JSON.stringify({ code, signal, ...(error ? { error } : {}), outputs: have }));
    } catch (e: any) {
      say(`[job] sending the build back: ${e.message ?? e}`);
      await flush().catch(() => {});
      await store.put(key('out/exit.json'), JSON.stringify({ code, signal, error: `sending the build back failed: ${e.message ?? e}` }));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return error ? 1 : 0;
  }
  try {
    const out = collect(spec, start, tmp, at);
    if (out.bundle) await store.put(key('out/out.bundle'), fs.readFileSync(out.bundle));
    await store.put(key('out/out.pack'), out.pack);
    await flush();
    await store.put(key('out/exit.json'), JSON.stringify({ code, signal, ...(error ? { error } : {}), git: out.git }));
  } catch (e: any) {
    say(`[job] sending the work back: ${e.message ?? e}`);
    await flush().catch(() => {});
    await store.put(key('out/exit.json'), JSON.stringify({ code, signal, error: `sending the work back failed: ${e.message ?? e}` }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // The exit is up: Studio collects it now rather than on its next look (awaited: the job's entry exits right after).
  if (send) {
    await nudging;
    await send();
  }
  return error ? 1 : 0;
}

// Run as the job's entry (not when a test imports it).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const unit = process.env.STUDIO_JOB_UNIT;
  const bucket = process.env.STUDIO_STATE_BUCKET;
  const brokered = Boolean(process.env.STUDIO_RUN_TOKEN && process.env.STUDIO_BROKER_URL);
  if (!unit || (!bucket && !brokered)) {
    console.error('STUDIO_JOB_UNIT and STUDIO_STATE_BUCKET (or a run token and the broker) are needed');
    process.exit(2);
  }
  // A customer's run (jobbroker.ts): this job's account has no bucket access; its own run folder only, by the broker.
  if (brokered) {
    const { brokerStore } = await import('./jobbroker.ts');
    const token = process.env.STUDIO_RUN_TOKEN!;
    delete process.env.STUDIO_RUN_TOKEN; // the pass's command never sees it
    const rc = await runUnit(unit, brokerStore(process.env.STUDIO_BROKER_URL!, token), { nudge: httpNudge(unit) });
    console.log(`[job] ${unit} finished (${rc ? 'with an error' : 'ok'})`);
    process.exit(0);
  }
  const g = await import('./gcp.ts');
  // A customer's cell: its jobs are under its own prefix in the shared bucket (cloudjob.ts passes STUDIO_STATE_PREFIX).
  const P = String(process.env.STUDIO_STATE_PREFIX ?? '').replace(/^\/+|\/+$/g, '');
  const at = (k: string) => (P ? `${P}/${k}` : k);
  const store: Store = {
    // Strings here are contents (exit.json, log chunks); gcsWrite reads a string as a file path, so they go as bytes.
    put: async (k, d) => { const key = at(k); await g.gcsWrite(bucket!, key, typeof d === 'string' ? Buffer.from(d) : d); },
    get: (k) => g.gcsRead(bucket!, at(k)),
    list: async (p) => (await g.gcsList(bucket!, at(p))).map((o) => (P ? o.name.slice(P.length + 1) : o.name)),
    remove: (k) => g.gcsDelete(bucket!, at(k)),
  };
  const rc = await runUnit(unit, store, { nudge: httpNudge(unit) });
  console.log(`[job] ${unit} finished (${rc ? 'with an error' : 'ok'})`);
  // The job's own exit is 0 either way: the result is in exit.json, and a retry would run the pass twice.
  process.exit(0);
}
