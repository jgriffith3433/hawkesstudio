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
//   out  log-NNNNNN, err-NNNNNN  output chunks, every ~2 s (Talk's: as they're written, spec.flushMs); after each upload
//                   the runner nudges Studio (POST /api/cloudjobs/<unit>/nudge), which reads them at once (kickCloudJob)
//        out.bundle, out.pack, exit.json  what the pass committed and left uncommitted, the session, then the exit
//   stop           Studio's Stop (a time limit, J's Stop): the runner ends the command
// The workspace runs at the same absolute path in the job, so Claude Code's session folders (named after the path) match.

import { customerStudio } from './tenancy.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { DATA, ROOT } from './config.ts';
import { runToken } from './jobbroker.ts';
import { storeLfsObject, type LfsRef } from './lfs.ts';
import { GENERIC_SOURCE_PATTERNS, unitySourcePatterns } from './source-ready.ts';

export type PackFile = { p: string; d: string; m?: number };
/**
 * `commit`: the pass's own commits as plain files (the net change start..HEAD and the commits' messages), the way back when
 * the commits' git objects can't be fetched: a bundle is a thin pack, and a light (partial) clone lacks the blobs it
 * deltas against (2026-11-03: "pack has 1 unresolved delta", every Unity agent change "made no commit").
 */
export type PackCommit = { message: string; files: PackFile[]; deleted: string[] };
/** `lfs`: the new Git LFS files the pass's commits point at; their bytes travel beside the pack as out/lfs/<oid>. */
export type Pack = { files: PackFile[]; deleted?: string[]; commit?: PackCommit; lfs?: LfsRef[] };

/** A pack of files (gzip of JSON, base64 bodies): small enough for uncommitted work and session logs. */
export function packFiles(entries: { p: string; file: string }[], deleted: string[] = [], commit?: PackCommit | null, lfs: LfsRef[] = []): Buffer {
  const files: PackFile[] = [];
  for (const e of entries) {
    try {
      const st = fs.statSync(e.file);
      if (!st.isFile()) continue;
      files.push({ p: e.p, d: fs.readFileSync(e.file).toString('base64'), m: st.mode & 0o777 });
    } catch { /* gone meanwhile */ }
  }
  return zlib.gzipSync(Buffer.from(JSON.stringify({ files, deleted, ...(commit ? { commit } : {}), ...(lfs.length ? { lfs } : {}) } satisfies Pack)));
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

export const git = (cwd: string, args: string[], o: { input?: string | Buffer } = {}) => {
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

/** The same as `git`, without holding Studio's event loop (a sync spawn froze it for ~2 s per job start, 2026-11-08). */
export const gitAsync = (cwd: string, args: string[]) => new Promise<{ ok: boolean; out: string; raw: Buffer }>((resolve) => {
  const p = spawn('git', ['-c', 'safe.directory=*', ...args], { cwd, windowsHide: true });
  const out: Buffer[] = [];
  p.stdout.on('data', (d) => out.push(d));
  p.stderr.resume();
  p.on('error', () => resolve({ ok: false, out: '', raw: Buffer.alloc(0) }));
  p.on('close', (code) => { const raw = Buffer.concat(out); resolve({ ok: code === 0, out: raw.toString('utf8').trim(), raw }); });
});
async function dirtyStateAsync(cwd: string) {
  const list = async (args: string[]) => (await gitAsync(cwd, ['ls-files', '-z', ...args])).raw.toString('utf8').split('\0').filter(Boolean);
  const deleted = new Set(await list(['-d']));
  const changed = [...new Set([...(await list(['-m'])), ...(await list(['-o', '--exclude-standard']))])].filter((f) => !deleted.has(f));
  return { changed, deleted: [...deleted] };
}

/** What a workspace looks like for the job: HEAD, its branch, origin, a bundle of commits GitHub lacks, the dirty files. */
export async function workspaceIn(cwd: string, tmp: string) {
  const head = (await gitAsync(cwd, ['rev-parse', 'HEAD'])).out;
  const branch = (await gitAsync(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).out;
  const remote = plainRemote((await gitAsync(cwd, ['remote', 'get-url', 'origin'])).out);
  const bundle = path.join(tmp, 'in.bundle');
  // Only what no remote-tracking ref has: the rest the job clones from GitHub. Empty (HEAD is on GitHub): no bundle.
  const b = await gitAsync(cwd, ['bundle', 'create', bundle, 'HEAD', '--not', '--remotes']);
  const { changed, deleted } = await dirtyStateAsync(cwd);
  return { head, branch, remote, bundle: b.ok && fs.existsSync(bundle) ? bundle : null, changed, deleted };
}

/**
 * Brings a job's result into the local workspace: its commits (out.bundle) and HEAD, then exactly its uncommitted files.
 * Untracked files the pass removed are removed here too (git clean, never ignored files such as node_modules).
 */
export function applyWorkspace(cwd: string, o: { head: string; bundle: string | null; pack: Pack | null }) {
  let fetchError = '';
  if (o.bundle) {
    const f = git(cwd, ['fetch', '--quiet', o.bundle, 'HEAD']);
    if (!f.ok) fetchError = f.err.split('\n').filter(Boolean).slice(-2).join(' | ') || 'git printed nothing';
  }
  // The job's HEAD is a commit this workspace has (fetched from the bundle, or already its own).
  const hasHead = !o.head || git(cwd, ['cat-file', '-e', `${o.head}^{commit}`]).ok;
  if (!hasHead && !o.pack?.commit) {
    throw new Error(fetchError ? `couldn't read the job's commits: ${fetchError}` : `the job's HEAD ${o.head.slice(0, 7)} isn't in this workspace and its commits didn't come back`);
  }
  if (hasHead) {
    if (o.head && git(cwd, ['rev-parse', 'HEAD']).out !== o.head) {
      const r = git(cwd, ['reset', '--quiet', '--hard', o.head]);
      if (!r.ok) throw new Error(`couldn't move to the job's HEAD ${o.head.slice(0, 7)}: ${r.err.split('\n').pop()}`);
    } else git(cwd, ['reset', '--quiet', '--hard']);
  } else {
    git(cwd, ['reset', '--quiet', '--hard']);
  }
  git(cwd, ['clean', '-fdq']);
  // The commits as files: written, staged and committed here (a light worktree can't take the job's git objects).
  if (!hasHead) {
    replayCommit(cwd, o.pack!.commit!, fetchError);
    // Studio's own later git status / diff in this light clone must not read blobs it can't fetch either.
    if (git(cwd, ['config', '--get', 'core.sparseCheckout']).out === 'true') for (const k of ['diff.renames', 'status.renames']) git(cwd, ['config', k, 'false']);
  }
  const rest = o.pack ? { files: o.pack.files, deleted: o.pack.deleted } : null;
  if (rest) unpack(rest, cwd);
  // A light (sparse) worktree: tracked files outside its cone are skip-worktree, which git status and `git add -A` don't
  // see, so the pass's edits there looked like "no changes" and were never committed. Mark what the pass touched.
  if (rest) showSparse(cwd, [...rest.files.filter((f) => !path.isAbsolute(f.p)).map((f) => f.p), ...(rest.deleted ?? [])]);
}

/** Makes the pass's commits here from their files (PackCommit): one commit with the pass's messages. Throws when git refuses. */
export function replayCommit(cwd: string, c: PackCommit, why = '') {
  const files = c.files.filter((f) => !path.isAbsolute(f.p));
  unpack({ files, deleted: c.deleted }, cwd);
  const paths = [...files.map((f) => f.p), ...c.deleted];
  if (!paths.length) return false;
  showSparse(cwd, paths);
  // Rename detection reads the blobs of deleted and added files: a light clone lacks them and can't fetch them (no credentials).
  const norename = ['-c', 'diff.renames=false', '-c', 'status.renames=false'];
  const fail = (what: string, err: string) => new Error(`staging the job's commits as files: ${what}${err.split('\n').pop()}`);
  // Staged without `git add`: add converts the file against the index's old blob (line-ending checks), and a blobless
  // clone can't fetch that blob (no credentials). Hash the file as it is and point the index at the new object instead.
  const modes = new Map<string, string>();
  for (let i = 0; i < files.length; i += 200) {
    const ls = git(cwd, ['ls-files', '-s', '-z', '--', ...files.slice(i, i + 200).map((f) => f.p)]).raw.toString('utf8').split('\0').filter(Boolean);
    for (const l of ls) { const m = /^(\d+) [0-9a-f]+ \d\t(.*)$/s.exec(l); if (m) modes.set(m[2], m[1]); }
  }
  const lines: string[] = [];
  for (const f of files) {
    const h = git(cwd, ['hash-object', '-w', '--no-filters', '--', path.join(cwd, f.p)]);
    if (!h.ok || !h.out) throw fail(`${f.p}: `, h.err);
    const mode = modes.get(f.p) ?? ((f.m ?? 0o644) & 0o111 ? '100755' : '100644');
    lines.push(`${mode} ${h.out}\t${f.p}`);
  }
  // Files the pass deleted may be ones this light worktree never checked out: removed from the index by name.
  for (const d of c.deleted) lines.push(`0 ${'0'.repeat(40)}\t${d}`);
  if (lines.length) {
    const r = git(cwd, ['update-index', '-z', '--index-info'], { input: Buffer.from(lines.join('\0') + '\0') });
    if (!r.ok) throw fail('', r.err);
  }
  if (!git(cwd, [...norename, 'diff', '--cached', '--name-only']).out) return false;
  const msg = `${c.message}\n\nCommitted by Hawkes Studio: the agent's commit${why ? ` couldn't be fetched as git objects (${why.slice(0, 200)})` : ' came back as files'}.`;
  const r = git(cwd, [...norename, '-c', 'user.name=Hawkes Studio', '-c', 'user.email=studio@hawkesgen.ai', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--no-verify', '-m', msg]);
  if (!r.ok) throw new Error(`committing the job's commits as files: ${r.err.split('\n').pop()}`);
  return true;
}

/** In a sparse worktree: the tracked `paths` count as present (not skip-worktree), so status and add see their changes. */
export function showSparse(cwd: string, paths: string[]) {
  if (!paths.length || git(cwd, ['config', '--get', 'core.sparseCheckout']).out !== 'true') return;
  for (let i = 0; i < paths.length; i += 200) {
    const tracked = git(cwd, ['ls-files', '-z', '--', ...paths.slice(i, i + 200)]).raw.toString('utf8').split('\0').filter(Boolean);
    if (tracked.length) git(cwd, ['update-index', '--no-skip-worktree', '-z', '--stdin'], { input: Buffer.from(tracked.join('\0') + '\0') });
  }
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

/**
 * A customer's cell: its agents' job has no bucket access at all, so each execution gets a run token for its own run
 * folder and the control plane's broker address instead (jobbroker.ts). J's Studio: nothing (the job reads its bucket).
 */
export function brokerEnv(unit: string): Record<string, string> {
  const org = process.env.STUDIO_ORG;
  const control = (process.env.STUDIO_CONTROL_URL ?? '').replace(/\/+$/, '');
  if (!org || !control || !process.env.STUDIO_BROKER_KEY) return {};
  return { STUDIO_RUN_TOKEN: runToken(org, unit), STUDIO_BROKER_URL: `${control}/api/cells/broker` };
}

/** The real runner: Cloud Storage and the Cloud Run job named by STUDIO_GCP_PROJECT, STUDIO_GCP_REGION, STUDIO_AGENT_JOB. */
export function cloudRunner(): JobRunner {
  const bucket = process.env.STUDIO_STATE_BUCKET;
  const project = process.env.STUDIO_GCP_PROJECT;
  const region = process.env.STUDIO_GCP_REGION || 'us-east4';
  const job = process.env.STUDIO_AGENT_JOB || 'studio-agent';
  if (!bucket || !project) throw new Error('Cloud Run jobs need STUDIO_STATE_BUCKET and STUDIO_GCP_PROJECT');
  const g = () => import('./gcp.ts');
  // A cell's jobs live under its own prefix in the shared bucket (cloudhost.ts statePrefix); the job is told it.
  const P = String(process.env.STUDIO_STATE_PREFIX ?? '').replace(/^\/+|\/+$/g, '');
  const at = (k: string) => (P ? `${P}/${k}` : k);
  return {
    // put's strings are contents (a spec, a marker); gcsWrite reads a string as a file path, so they go as bytes.
    put: async (key, data) => { const k = at(key); await (await g()).gcsWrite(bucket, k, typeof data === 'string' ? Buffer.from(data) : data); },
    get: async (key) => (await g()).gcsRead(bucket, at(key)),
    list: async (prefix) => (await (await g()).gcsList(bucket, at(prefix))).map((o) => (P ? o.name.slice(P.length + 1) : o.name)),
    remove: async (key) => (await g()).gcsDelete(bucket, at(key)),
    start: async (unit) => (await g()).runJob({ project, region, job }, {
      env: { STUDIO_JOB_UNIT: unit, ...(P ? { STUDIO_STATE_PREFIX: P } : {}), ...brokerEnv(unit) },
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
/** kick: read the bucket now (a nudge came); pushed: nudges have come for this job, so the timed look is a safety net. */
type Follow = { unit: string; execution: string | null; seen: { log: number; err: number }; done: boolean; error?: string; stopAsked?: number; kick?: (nudged: boolean) => void; pushed?: boolean };
const follows = new Map<string, Follow>();
/** How many jobs Studio is following now (cloudhost.ts keeps the instance up while there are any). */
export const following = () => [...follows.values()].filter((f) => !f.done).length;

/**
 * "<unit>" each time a job's local files changed (new output, its exit): DetachedChild reads them at once instead of on
 * its next look (detach.ts).
 */
export const jobFiles = new EventEmitter();
jobFiles.setMaxListeners(0);

/**
 * The job's runner wrote new output, or its exit (cloudjob-run.ts nudges Studio over HTTP after each upload: POST
 * /api/cloudjobs/<unit>/nudge): its follower looks now. A stop asked for (stopDetached) does the same. False when Studio
 * isn't following that job (another instance is, or it's over). nudged false: Studio's own reason to look (a stop), which
 * says nothing about whether the runner nudges.
 */
export function kickCloudJob(unit: string, { nudged = true }: { nudged?: boolean } = {}) {
  const f = follows.get(unit);
  if (!f || f.done || !f.kick) return false;
  f.kick(nudged);
  return true;
}

/** Talk's answers stream: their runner uploads output as it comes (at most every this often) instead of every ~2 s. */
const TALK_FLUSH_MS = () => Number(process.env.STUDIO_JOB_TALK_FLUSH_MS) || 250;

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
      const ws = isGitWorkspace(cwd) ? await workspaceIn(cwd, tmp) : null;
      const entries: { p: string; file: string }[] = [];
      if (ws) for (const rel of ws.changed) entries.push({ p: rel, file: path.join(cwd, rel) });
      // The agent's brief and notes (.hawkes/) are kept out of commits by .git/info/exclude, so the dirty files above
      // never include them: they go along by name (2026-10-31: every agent job asked where its brief was).
      if (ws) {
        const have = new Set(entries.map((e) => e.p));
        entries.push(...folderEntries(path.join(cwd, '.hawkes'), (rel) => `.hawkes/${rel}`).filter((e) => !have.has(e.p)));
      }
      // The session folder for this workspace, and files the command names outside it (an --mcp-config).
      const sessions = sessionDir(cwd, spec.env);
      entries.push(...folderEntries(sessions, (rel) => path.join(sessions, rel)));
      for (const a of spec.args) if (path.isAbsolute(a) && !a.startsWith(cwd + path.sep) && fs.existsSync(a) && fs.statSync(a).isFile() && fs.statSync(a).size < 1_000_000) entries.push({ p: a, file: a });
      await r.put(key(unit, 'in.pack'), packFiles(entries, ws?.deleted ?? []));
      if (ws?.bundle) await r.put(key(unit, 'in.bundle'), fs.readFileSync(ws.bundle));
      const { sandboxEnv } = await import('./sandbox.ts');
      const env = jobEnv(spec.env, sandboxEnv);
      // The workspace's own repo's token, minted now: the GitHub App's, scoped to that one repo and read-only (the job
      // only clones; Studio pushes and opens the pull request). Else the token handed over (detach.ts jobGitToken).
      let gitToken: string | null = null;
      if (ws) {
        const { jobRepoToken, slugOfRemote } = await import('./ghtoken.ts');
        gitToken = await jobRepoToken(slugOfRemote(ws.remote)).catch(() => null);
      }
      gitToken ??= o.gitToken ?? null;
      // A big repo (repos.ts bigRepo: a Unity project's, or over STUDIO_CLONE_MAX_MB) is cloned partially with no LFS
      // files (cloudjob-run.ts prepare's default); a small one fully, with its LFS files, as before.
      let big: string | null = null;
      let sparse: string[] | undefined;
      if (ws) {
        const { slugOfRemote } = await import('./ghtoken.ts');
        const slug = slugOfRemote(ws.remote);
        if (slug) big = await import('./repos.ts').then(({ bigRepo }) => bigRepo(slug)).catch(() => null);
        // The job's checkout is sparse like Studio's worktree (the job's disk is memory: a Unity project's whole tree killed it).
        if (big) sparse = jobSparsePatterns(cwd);
      }
      // A conflict pass (agents.ts agentPassRaw writes MERGE_BASE_FILE): the job brings that branch's side in with its token.
      const mergeBase = ws ? readMergeBase(cwd) : null;
      // An agent's read-only copies of the Studio's other projects' repos (access.ts), next to its worktree.
      const repos = ws ? await import('./access.ts').then((A) => A.extraReposFor(cwd)).catch(() => []) : [];
      await r.put(key(unit, 'spec.json'), JSON.stringify({
        file: spec.file, args: spec.args, cwd, env, sessions, ...(repos.length ? { repos } : {}),
        // Talk's answer (detach.ts names its unit hawkes-talk-<conversation>-…): its output goes up as it comes.
        ...(unit.startsWith('hawkes-talk-') ? { flushMs: TALK_FLUSH_MS() } : {}),
        // tokenAt and refresh: a job that waits for a machine past most of the token's hour gets a fresh one (jobgit.ts).
        git: ws ? { ...(mergeBase ? { base: mergeBase } : {}), head: ws.head, branch: ws.branch, remote: ws.remote, bundle: Boolean(ws.bundle), token: gitToken, tokenAt: Date.now(), ...(await gitRefresh(unit, ws.remote)), ...(big ? (sparse ? { sparse } : {}) : { partial: false, lfs: true }), ...(unit.startsWith('hawkes-agent-') ? { commitDirty: true } : {}) } : null,
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

/** Where a conflict pass names the base branch it merges (inside .hawkes/, so it travels by name and never into a commit). */
export const MERGE_BASE_FILE = '.hawkes/merge-base.txt';
/** The base branch a conflict pass merges, or null (not a conflict pass, or a name that isn't a plain branch name). */
export function readMergeBase(cwd: string): string | null {
  try {
    const b = fs.readFileSync(path.join(cwd, MERGE_BASE_FILE), 'utf8').trim();
    return /^[\w][\w./-]{0,100}$/.test(b) && !b.includes('..') ? b : null;
  } catch { return null; }
}

/** The source patterns the job checks out in a big repo: the same ones Studio's worktree got (source-ready.ts). */
export function jobSparsePatterns(cwd: string): string[] {
  // A Unity project at the root or nested (YoobaLand/YoobaLand/): its patterns, moved under its folder (source-ready.ts).
  const unity = Boolean(git(cwd, ['ls-files', '--', 'Assets', 'ProjectSettings']).out) || Boolean(git(cwd, ['ls-files', '--', '*ProjectSettings/ProjectVersion.txt']).out);
  return unity ? unitySourcePatterns(cwd) : GENERIC_SOURCE_PATTERNS;
}

/** The spec's way to a fresh clone token (jobgit.ts), or nothing when Studio has no address the job can reach. */
async function gitRefresh(unit: string, remote: string): Promise<{ refresh?: { url: string; key: string } }> {
  try {
    const { slugOfRemote } = await import('./ghtoken.ts');
    const refresh = (await import('./jobgit.ts')).jobGitRefresh(unit, slugOfRemote(remote));
    return refresh ? { refresh } : {};
  } catch { return {}; }
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

/** The last lines the job printed (its log, then its errors), on one line: what a failed job's detail shows besides the error. */
export function jobTail(unit: string, n = 4): string {
  const lines: string[] = [];
  for (const ext of ['err', 'log']) {
    try {
      lines.push(...fs.readFileSync(local(unit, ext), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('[studio] the Cloud Run job failed')).slice(-n));
    } catch { /* no file */ }
  }
  return lines.slice(-n).join(' | ').slice(0, 400);
}

/**
 * The line a failed job leaves on its stderr (J, 2026-11-03: Yooba Land passes ended "the agent made no commit" with the
 * real reason, a job killed with no result, only in the exit file): exit code, signal, error and the last output lines.
 * agents.ts machineryFailure reads `[studio] ... failed` lines, so the change's detail names the job's failure and it
 * counts as Studio's, not a try. Exported for the tests.
 */
export function jobFailureLine(unit: string, exit: { code: number | null; signal: string | null; error?: string }): string {
  const tail = jobTail(unit);
  return `[studio] the Cloud Run job failed: ${String(exit.error ?? '').replace(/\s+/g, ' ').slice(0, 300)} (exit code ${exit.code ?? 'none'}${exit.signal ? `, signal ${exit.signal}` : ''})${tail ? `; last output: ${tail}` : '; it printed nothing'}`;
}

/**
 * Cancels this Studio's agent-job executions that Studio no longer follows (2026-11-08: about 16 never-finished executions
 * in one region held its CPU quota, which can stop Cloud Run starting Studio's own replacement instance, and cost money).
 * Only executions of this Studio's own state prefix, and none younger than 10 minutes (one being started isn't followed
 * yet). Runs once when Studio starts; returns the names it cancelled.
 */
export async function cancelStrayExecutions(): Promise<string[]> {
  const project = process.env.STUDIO_GCP_PROJECT;
  if (!project || !process.env.STUDIO_STATE_BUCKET) return [];
  const t = { project, region: process.env.STUDIO_GCP_REGION || 'us-east4', job: process.env.STUDIO_AGENT_JOB || 'studio-agent' };
  const mine = String(process.env.STUDIO_STATE_PREFIX ?? '').replace(/^\/+|\/+$/g, '');
  const g = await import('./gcp.ts');
  const tracked = new Set([...follows.values()].filter((f) => !f.done).map((f) => f.execution).filter(Boolean));
  const cancelled: string[] = [];
  for (const e of await g.listOpenExecutions(t)) {
    if (tracked.has(e.name) || Date.now() - e.createdAt < 10 * 60_000) continue;
    if (!e.env.STUDIO_JOB_UNIT || String(e.env.STUDIO_STATE_PREFIX ?? '').replace(/^\/+|\/+$/g, '') !== mine) continue;
    await g.cancelExecution(e.name);
    cancelled.push(e.name);
  }
  if (cancelled.length) console.log(`[cloudjob] cancelled ${cancelled.length} execution(s) Studio no longer follows: ${cancelled.map((n) => n.split('/').pop()).join(', ')}`);
  return cancelled;
}

function end(f: Follow, exit: { code: number | null; signal: string | null; error?: string }) {
  f.done = true;
  // The record ended: an execution still running for it (a job Studio gave up on or stopped) is cancelled too.
  if (f.execution) { const r = runnerFor(), name = f.execution; void r.state(name).then((s) => { if (s && !s.done) return r.cancel(name); }).catch(() => {}); }
  if (exit.error) { try { fs.appendFileSync(local(f.unit, 'err'), `${jobFailureLine(f.unit, exit)}\n`); } catch { /* the folder went */ } }
  try {
    fs.writeFileSync(local(f.unit, 'exit.tmp'), JSON.stringify({ ...exit, at: Date.now() }));
    fs.renameSync(local(f.unit, 'exit.tmp'), local(f.unit, 'exit'));
  } catch { /* the folder went */ }
  jobFiles.emit(f.unit);
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
      jobFiles.emit(f.unit);
    }
  }
  return names;
}

/**
 * A job followed again after a restart whose execution's name isn't in the bucket after this long was never started
 * (Studio stopped while uploading its inputs) or was already collected (its folder cleared): nothing will ever end it.
 */
export const JOB_UNKNOWN_MS = () => Number(process.env.STUDIO_JOB_UNKNOWN_MS) || 10 * 60_000;

/**
 * A job whose runner has been nudging Studio (pushed): the timed look is only the safety net for a nudge that never
 * came (the network, another instance got it, a runner from before nudges), Cloud Run's own view of the execution
 * (killed, out of memory: no exit.json ever comes) and the stop. Before the first nudge it is STUDIO_JOB_POLL_MS.
 */
const JOB_SAFETY_MS = (every: number) => Number(process.env.STUDIO_JOB_SAFETY_MS) || Math.max(every, 5000);

/**
 * Follows the job until its exit.json, then applies its workspace and session and writes the local exit. It looks when
 * the runner nudges it (kickCloudJob: new output is in the bucket) and, as a safety net, on a timer: every
 * STUDIO_JOB_POLL_MS until the first nudge, then every JOB_SAFETY_MS. One look at a time; a nudge during a look makes
 * another right after it.
 */
function follow(f: Follow, cwd: string, env: NodeJS.ProcessEnv, every = Number(process.env.STUDIO_JOB_POLL_MS) || 2000) {
  const r = runnerFor();
  let goneAt = 0;
  let stateAt = 0;
  const since = Date.now();
  let timer: NodeJS.Timeout | null = null;
  let busy = false;
  let again = false;
  /** One look; true when the job is over (nothing more to follow). */
  const look = async (): Promise<boolean> => {
    if (f.done) return true;
    try {
      // Reattached: the execution's name is read again until the bucket answers (it used to be read once, and a miss
      // left the job followed forever with nothing to cancel or ask Cloud Run about).
      if (!f.execution) f.execution = (await r.get(key(f.unit, 'execution.txt')).catch(() => null))?.toString('utf8') || null;
      if (fs.existsSync(local(f.unit, 'stop')) && !f.stopAsked) {
        f.stopAsked = Date.now();
        await r.put(key(f.unit, 'stop'), String(Date.now()));
      }
      if (f.stopAsked && f.execution && Date.now() - f.stopAsked > 20_000) await r.cancel(f.execution);
      const names = await pull(f, r);
      if (names.includes('exit.json')) {
        await finish(f, r, cwd, env);
        return true;
      }
      if (!f.execution && Date.now() - since > JOB_UNKNOWN_MS()) {
        end(f, { code: null, signal: null, error: "the Cloud Run job can't be found (Studio restarted while starting it, or its result was already collected)" });
        return true;
      }
      // Cloud Run says it's over but the runner said nothing (killed, out of memory, timed out): wait a little for the
      // last upload, then end it. Asked at most every `every` (nudges come several times a second while Talk streams).
      if (f.execution && (goneAt || Date.now() - stateAt >= every)) {
        stateAt = Date.now();
        const st = await r.state(f.execution);
        if (!st || st.done) {
          goneAt ||= Date.now();
          if (Date.now() - goneAt > 30_000) {
            await pull(f, r);
            end(f, { code: null, signal: null, error: `the Cloud Run job ended without its result${st?.message ? `: ${st.message}` : ''}` });
            return true;
          }
        }
      }
    } catch (e: any) {
      fs.appendFileSync(local(f.unit, 'err'), `[studio] following the job: ${e.message ?? e}\n`);
    }
    return false;
  };
  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), ms);
    timer.unref();
  };
  const run = async () => {
    timer = null;
    if (f.done) return;
    if (busy) return void (again = true);
    busy = true;
    let over = false;
    try {
      over = await look();
    } finally {
      busy = false;
    }
    if (over || f.done) {
      if (timer) clearTimeout(timer);
      return;
    }
    if (again) {
      again = false;
      schedule(0);
    } else schedule(f.pushed ? JOB_SAFETY_MS(every) : every);
  };
  f.kick = (nudged) => {
    if (nudged) f.pushed = true;
    if (busy) again = true;
    else schedule(0);
  };
  void run();
}

/**
 * Remakes a job's workspace that is missing when the job ends (agents.ts: a change's worktree lives on the instance's own
 * disk, which a replaced Cloud Run instance lost while the job ran). True: the folder is a git workspace again.
 */
export type WorkspaceRestorer = (cwd: string) => Promise<boolean>;
let restorer: WorkspaceRestorer | null = null;
/** agents.ts sets it at load; tests swap in their own. */
export function setWorkspaceRestorer(f: WorkspaceRestorer | null) {
  restorer = f;
}

/** Where a job's folder is in the bucket, for messages (never a credential). */
export function jobFolder(unit: string) {
  const P = String(process.env.STUDIO_STATE_PREFIX ?? '').replace(/^\/+|\/+$/g, '');
  return `gs://${process.env.STUDIO_STATE_BUCKET || '<state bucket>'}/${P ? `${P}/` : ''}${key(unit, '')}`;
}

/** Downloads the job's new LFS objects (out/lfs/<oid>) into the workspace's store; each checked against its pointer's hash and size. */
export async function bringLfs(r: JobRunner, unit: string, cwd: string, refs: LfsRef[]) {
  const have = new Set((await r.list(key(unit, 'out/lfs/'))).map((n) => n.split('/').pop()));
  for (const ref of refs) {
    if (!have.has(ref.oid)) throw new Error(`the job's LFS file ${ref.oid.slice(0, 10)} is missing from ${jobFolder(unit)}`);
    const data = await r.get(key(unit, `out/lfs/${ref.oid}`));
    if (!data || data.length !== ref.size || createHash('sha256').update(data).digest('hex') !== ref.oid) throw new Error(`the job's LFS file ${ref.oid.slice(0, 10)} came back damaged (${data?.length ?? 0} of ${ref.size} bytes)`);
    storeLfsObject(cwd, ref, data);
  }
}

async function finish(f: Follow, r: JobRunner, cwd: string, env: NodeJS.ProcessEnv) {
  const exit = JSON.parse((await r.get(key(f.unit, 'out/exit.json')))?.toString('utf8') ?? '{}');
  try {
    const packB = await r.get(key(f.unit, 'out/out.pack'));
    const pack = packB ? readPack(packB) : null;
    // The session files go where they were (absolute paths); the workspace's files are relative.
    const session = pack ? { files: pack.files.filter((x) => path.isAbsolute(x.p)) } : null;
    const work: Pack | null = pack ? { files: pack.files.filter((x) => !path.isAbsolute(x.p)), deleted: pack.deleted, ...(pack.commit ? { commit: pack.commit } : {}) } : null;
    if (session) unpack(session, '/');
    if (exit.git) {
      // The workspace went while the job ran (2026-11-02: a replaced instance lost the worktree, this step skipped the
      // job's commits without a word and then deleted them from the bucket). It is made again first; if it can't be, the
      // job's folder stays in the bucket and the pass fails saying where its work is.
      if (!isGitWorkspace(cwd)) {
        const there = fs.existsSync(cwd);
        const remade = !there && restorer ? await restorer(cwd).catch((e: any) => {
          fs.appendFileSync(local(f.unit, 'err'), `[studio] remaking the workspace ${cwd}: ${e.message ?? e}\n`);
          return false;
        }) : false;
        if (!remade || !isGitWorkspace(cwd)) throw new Error(`worktree missing after restart: ${cwd} ${there ? 'is not a git workspace' : "is gone and couldn't be made again"}; the job's work is kept in ${jobFolder(f.unit)}`);
        // The workspace's own commits GitHub lacked when the job started (in.bundle): the job's commits build on them.
        const inB = await r.get(key(f.unit, 'in.bundle'));
        if (inB) {
          const file = path.join(os.tmpdir(), `hs-${f.unit}-in.bundle`);
          fs.writeFileSync(file, inB);
          try {
            const got = git(cwd, ['fetch', '--quiet', file, 'HEAD']);
            if (!got.ok) throw new Error(`couldn't read the workspace's earlier commits: ${got.err.split('\n').pop()}`);
          } finally {
            fs.rmSync(file, { force: true });
          }
        }
        fs.appendFileSync(local(f.unit, 'err'), `[studio] the workspace ${cwd} was gone (Studio restarted): made again, the job's work goes into it\n`);
      }
      let bundle: string | null = null;
      if (exit.git.bundle) {
        const b = await r.get(key(f.unit, 'out/out.bundle'));
        if (!b) throw new Error(`the job's commits (out.bundle) are missing from ${jobFolder(f.unit)}`);
        bundle = path.join(os.tmpdir(), `hs-${f.unit}-out.bundle`);
        fs.writeFileSync(bundle, b);
      }
      try {
        // The pass's new LFS files into this checkout's store; the branch push uploads them first (agents.ts publish).
        if (pack?.lfs?.length) await bringLfs(r, f.unit, cwd, pack.lfs);
        applyWorkspace(cwd, { head: exit.git.head, bundle, pack: work });
      } finally {
        if (bundle) fs.rmSync(bundle, { force: true });
      }
    }
  } catch (e: any) {
    // The job's folder (its out.bundle above all) stays: nothing else holds its commits.
    const why = `${e.message ?? e}`;
    console.error(`[cloudjob] ${f.unit}: the job's work couldn't be brought back: ${why}${why.includes(jobFolder(f.unit)) ? '' : ` (kept in ${jobFolder(f.unit)})`}`);
    fs.appendFileSync(local(f.unit, 'err'), `[studio] bringing the job's work back: ${why}\n`);
    end(f, { code: exit.code ?? null, signal: exit.signal ?? null, error: `${exit.error ? `${exit.error}; ` : ''}the job's work couldn't be brought back: ${why}` });
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
    // A customer's Studio says so to its tool server, which runs in the shared job with none of the cell's env: without
    // it Talk and agents got J's tool list and instructions (2026-10-31 review).
    hawkesstudio: { command: process.execPath, args: [path.join(ROOT, 'bin', 'studio-mcp.mjs')], env: { STUDIO_SERVER: '1', ...(customerStudio() ? { STUDIO_CUSTOMER: '1' } : {}), ...studioEnv, ...(process.env.STUDIO_SERVICE_URL || process.env.STUDIO_URL ? { STUDIO_URL: process.env.STUDIO_SERVICE_URL || process.env.STUDIO_URL! } : {}), ...(process.env.STUDIO_AGENT_KEY ? { STUDIO_AGENT_KEY: process.env.STUDIO_AGENT_KEY } : {}) } },
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
export async function runCloudBuild(unit: string, o: { remote: string; head: string; cwd: string; command: string; outputs: string[]; bundle?: string | null; gitToken?: string | null; timeoutMs?: number; onLine?: (s: string) => void; every?: number; beforeOutputs?: () => Promise<void> }): Promise<CloudBuild> {
  const r = runnerFor();
  const k = (n: string) => key(unit, n);
  building++;
  let execution: string | null = null;
  let log = '';
  try {
    if (o.bundle) await r.put(k('in.bundle'), fs.readFileSync(o.bundle));
    const { jobRepoToken, slugOfRemote } = await import('./ghtoken.ts');
    const gitToken = (await jobRepoToken(slugOfRemote(o.remote)).catch(() => null)) ?? o.gitToken ?? null;
    await r.put(k('spec.json'), JSON.stringify({
      kind: 'build', outputs: o.outputs, file: '/bin/sh', args: ['-c', o.command], cwd: o.cwd,
      env: { CI: '1', npm_config_update_notifier: 'false' }, sessions: path.posix.join(o.cwd, '.hawkes-none', 's', 's'),
      git: { head: o.head, branch: 'HEAD', remote: plainRemote(o.remote), bundle: Boolean(o.bundle), token: gitToken, tokenAt: Date.now(), ...(await gitRefresh(unit, o.remote)), shallow: !o.bundle, lfs: true },
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
        // The caller may wait for a slot first (heavyslot.ts): the outputs come back whole, into memory.
        if (names.includes('outputs.tgz')) await o.beforeOutputs?.();
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
