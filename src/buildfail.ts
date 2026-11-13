// Build failures you can see and understand (J, 2026-11-03: "if it's failing, why be in I know it's failing? ... why did
// we have to dig so hard to find this problem"). Sick of It's web build failed seven times (v1 to v7) and the only place
// anyone learned it was Go live refusing with "Build web of beta <sha> isn't in ... yet".
//
// Here, one place for what a failed build keeps and says (builds.ts calls it; it never starts a build):
//   - classify(): what kind of failure (token / restart / compile / publish / timeout / memory / other) and whether it is
//     infrastructure (Hawkes Gen, GitHub, Studio: build again) or code (the project: somebody has to fix it), in plain words
//   - extractLog(): the last ~200 lines of the Unity / GameDeploy output from the Gen job, so the real reason is kept
//   - recordFailure(): writes all of it on the build row (class, kind, step, the log, every Gen job that was tried)
//   - announce(): the Inbox item (inbox.ts buildFailures) and ONE push notification per failure, after Studio's own
//     retries (builds.ts viaGen) are used up
//   - failureOf() / lastBuilds() / attemptsAt(): what the overview, Go live and the run's "Why did this fail?" show
// No polling: the dashboard hears about a row changing through /api/stream (a database write).

import { db } from './db.ts';
import { tokenLost, infraLost, buildsOf, UNITY_FAILED, TRUNCATED, DOWNLOAD_FAILED_PREFIX, NO_ROOM_PREFIX } from './builds.ts';
import { getProduct } from './config.ts';
import { QUOTA, accessCause, accessFix, retryPending } from './buildaccess.ts';
import { fixerNow, fixedWording, fixSentence, type FixerNow } from './buildfix.ts';

export type FailClass = 'rejected' | 'script' | 'token' | 'restart' | 'compile' | 'publish' | 'timeout' | 'memory' | 'access' | 'other';
export type FailKind = 'infrastructure' | 'code' | 'unknown';
export type Classified = { class: FailClass; kind: FailKind; plain: string };

/** Where in a build it stopped (builds.ts sets it as it goes): shown as "failed at …". */
export type Stage = 'checkout' | 'build' | 'download' | 'publish' | 'mount' | 'playtest';
const STAGE_WORDS: Record<Stage, string> = {
  checkout: 'getting the commit', build: 'building', download: 'downloading the build', publish: 'publishing the files', mount: 'putting it into the site', playtest: 'playing it',
};
export const stageWords = (s: string | null | undefined) => STAGE_WORDS[s as Stage] ?? (s || 'building');

export const LOG_LINES = 200;
const LOG_BYTES = 60_000;

/**
 * Gen's rejection of a build request (hawkesgen customer.ts admitCustomer: "customer builds take github ...", "github.repo
 * must be ...", "X isn't for customer builds", "target ... can't be built in the cloud"), as its own sentence; null when the
 * error is anything else. Exported for the tests.
 */
export function genRefusal(error: unknown): string | null {
  const e = String(error ?? '');
  const m = /(customer builds take[^\n]*|github(?: must be|\.(?:repo|commit|token|ref)\b)[^\n]*|[a-zA-Z]+ isn't for customer builds[^\n]*|target "[^"]*" can't be built in the cloud[^\n]*|method must be a static method[^\n]*)/.exec(e);
  return m ? m[1].trim().slice(0, 300) : null;
}

/**
 * The real error of a failed shell build (npm / static, run by Studio's job), not the tail of its output (Dose of Destruction
 * v7-v11, 2026-11-03: the stored reason was Vite's chunk-size warnings). Picks the first error-looking lines of the log
 * and the step of the `&&` chain they came from. Exported for the tests.
 */
export function digestLog(log: string, command = ''): { errors: string[]; step: string | null } {
  const lines = String(log ?? '').split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const bad = /quota exceeded|RESOURCE_EXHAUSTED|Could not create or update|\berror\b|\bERR!|ERR_|No such file|cannot (stat|create|open|access)|not found|Permission denied|ENOENT|EEXIST|failed to|Cannot find|\bfatal\b|Exit status|exited with/i;
  const noise = /^\s*(\(!\)|warning|npm warn)|manualChunks|chunk(s)? (is|are) larger|Some chunks|dynamic import|Consider:|build\.rollupOptions|chunkSizeWarningLimit/i;
  const hit: number[] = [];
  lines.forEach((l, i) => { if (bad.test(l) && !noise.test(l)) hit.push(i); });
  const errors = hit.slice(0, 8).map((i) => lines[i].slice(0, 240));
  // The step: the command the first error follows (npm prints "> name@1.0.0 build" before a script; "npm ci" fails before any).
  let step: string | null = null;
  const at = hit.length ? hit[0] : lines.length;
  for (let i = at; i >= 0; i--) {
    const m = /^>\s+\S+@\S+\s+(.+)$/.exec(lines[i] ?? '');
    if (m) { step = `npm run ${m[1].trim().split(/\s+/)[0]}`; break; }
  }
  const first = lines[hit[0]] ?? '';
  const tool = /^(cp|rm|mv|mkdir|ln|tar|cd|sh|git):/.exec(first) ?? /^\/bin\/sh: \d+: (\S+?):/.exec(first);
  if (tool) step = tool[1];
  else if (!step && /npm (error|ERR!)/i.test(first) && /\bnpm ci\b|lock ?file|package-lock|EUSAGE/i.test(lines.join('\n'))) step = 'npm ci';

  return { errors, step };
}

/** What went wrong, in two words and in plain ones. Exported for the tests. */
export function classify(error: unknown, o: { stage?: string | null; log?: string | null; tries?: number; slug?: string | null } = {}): Classified {
  const e = String(error ?? '');
  const log = String(o.log ?? '');
  const both = `${e}\n${log}`;
  const retried = (o.tries ?? 1) > 1 ? ` Studio tried ${o.tries} times by itself.` : '';
  // Hawkes Gen refused the request itself (a shape or a value it doesn't take): its own message is the cause, said as it
  // came ("Not recognised: customer builds take github ..." hid it behind "Cause unclear" on 2026-11-03).
  const refused = genRefusal(e);
  if (refused) return { class: 'rejected', kind: 'infrastructure', plain: `Hawkes Gen refused the build request: ${refused}. The request Studio sent doesn't fit what Gen takes, so it is a Studio/Gen mismatch, not your code, and building again won't change it until one of them is fixed.` };
  // Google Cloud had no room (hawkes-games build 113, 2026-11-10: "Quota exceeded for total allowable CPU per project per
  // region" while a function deployed, the CPU going to Studio's own agent jobs): not the code, so no fix agent; built again.
  if (QUOTA.test(both)) {
    const line = new RegExp(`[^\\n]*(${QUOTA.source})[^\\n]*`, 'i').exec(both)?.[0].trim().slice(0, 200);
    return { class: 'other', kind: 'infrastructure', plain: `Google Cloud ran out of room for this deploy for a moment${line ? ` (${line})` : ''}. That's capacity, not the code.${retried} Studio builds again by itself.` };
  }
  // The finished build's download never worked (builds.ts viaGen, after its own tries): Gen said it built fine, so no code is
  // to blame. Checked before everything else so a word in the error can't make it a compile failure.
  // Studio had no room to unpack the finished build, not even in the site store (builds.ts unpackBuild, NoRoom): its words
  // carry the bytes needed and free. Studio's working space, never the code, never sent to an agent.
  if (e.includes(NO_ROOM_PREFIX)) return { class: 'other', kind: 'infrastructure', plain: `Hawkes Gen finished the build, but Studio had no room to unpack it (${e.slice(e.indexOf(NO_ROOM_PREFIX) + NO_ROOM_PREFIX.length, e.indexOf(NO_ROOM_PREFIX) + NO_ROOM_PREFIX.length + 220)}). That's Studio's working space, not your code: nothing is sent to an agent. Build again once space is freed.` };
  if (e.startsWith(DOWNLOAD_FAILED_PREFIX)) return { class: 'publish', kind: 'infrastructure', plain: `Hawkes Gen finished the build, but Studio couldn't download its output (${e.slice(DOWNLOAD_FAILED_PREFIX.length, DOWNLOAD_FAILED_PREFIX.length + 160)}) even after trying again.${retried} That's Hawkes Gen's storage or the connection, not your code: nothing is sent to an agent. Build again.` };
  if ((/error CS\d+|compil(e|ation) (error|failed)|BuildFailedException|build method .* (failed|threw)|Scripts have compiler errors/i.test(both) || UNITY_FAILED.test(both)) && !tokenLost(e)) {
    const first = /error CS\d+[^\n]{0,160}/i.exec(both)?.[0];
    return { class: 'compile', kind: 'code', plain: `The project's code doesn't build${first ? ` (${first.trim()})` : ''}. Studio can't fix this by building again: someone has to fix the code first.` };
  }
  if (tokenLost(e)) {
    // Gen's "couldn't fetch <repo> at <commit> (… can the GitHub token read the repo?)": the source never arrived, so no code was built.
    if (/couldn't fetch/i.test(e)) return { class: 'token', kind: 'infrastructure', plain: `Hawkes Gen couldn't fetch the project's source from GitHub for this build (the GitHub access it was given had expired, or the commit wasn't readable then). The code never reached the compiler: that's infrastructure, so re-running the build is the fix.${retried} Build again.` };
    return { class: 'token', kind: 'infrastructure', plain: `Hawkes Gen lost the GitHub access it was given for this build (the token expired or Gen restarted). That's infrastructure, not the code.${retried} Build again.` };
  }
  if (/timed out|ran past|no result|stuck in Hawkes Gen/i.test(e)) return { class: 'timeout', kind: 'infrastructure', plain: `The build ran out of time before it finished. Probably infrastructure (a slow or stuck machine), not the code.${retried} Build again; if it keeps timing out, look at the Gen job.` };
  if (/out of memory|\bOOM\b|killed \(137\)|exit(ed)? (code )?137/i.test(both)) return { class: 'memory', kind: 'infrastructure', plain: `The build machine ran out of memory. That's the machine's size, not the code; Studio asks Gen for a bigger one when this happens.${retried} Build again.` };
  if (infraLost(e) || /Hawkes Gen (finished job|doesn't know job)|stopped: its run|Gen restarted/i.test(e)) return { class: 'restart', kind: 'infrastructure', plain: `Hawkes Gen or Studio restarted or lost the job while it was building. That's infrastructure, not the code.${retried} Build again.` };
  // The output arrived cut short (b_86e7f3a869dc, 2026-11-11: "gzip: stdin: unexpected end of file / tar: Unexpected EOF",
  // filed as "Not recognised"): the build itself finished, its archive or its download didn't. Built once more by itself.
  if (TRUNCATED.test(e)) return { class: 'other', kind: 'infrastructure', plain: `The build finished in Hawkes Gen, but its output arrived cut short (${e.slice(0, 160)}). That's the download or Gen's storage, not your code.${retried} Studio downloads it again, and builds the same commit once more by itself if it is still cut short.` };
  // GitHub refused the app's token (403/404): the real cause and the one fix, never "access or install" (buildaccess.ts).
  const cause = accessCause(e);
  if (cause) return { class: 'access', kind: 'infrastructure', plain: accessFix(cause, o.slug ?? null) };
  // One file of the finished build couldn't be written to the beta sites store (sitestore.ts workerStore, after its own tries).
  if (/^beta sites (PUT|GET|POST) /.test(e)) return { class: 'publish', kind: 'infrastructure', plain: `Hawkes Gen built it fine, but the beta sites store refused a file (${e.slice(0, 260)}). That's the site store, not your code: nothing is sent to an agent. Build again.` };
  if (o.stage === 'publish' || o.stage === 'mount' || o.stage === 'download' || /publish|loader|assertLoader|commit(ting)? into|couldn't (put|write)|R2/i.test(e)) {
    const loader = /loader/i.test(e);
    return { class: 'publish', kind: loader ? 'code' : 'infrastructure', plain: loader ? `The build finished but its files aren't what the site page loads (${e.slice(0, 160)}). That's the build's setup, not Studio.` : `The build itself finished, but Studio couldn't publish it (${e.slice(0, 160)}). That's Studio or the site store, not your code. Build again.` };
  }
  const sh = /^(.+?) failed(?:: ([^\n]*?))? \(exit (\d+)\)/m.exec(e);
  if (sh) return { class: 'script', kind: 'code', plain: `The project's build command failed (exit ${sh[3]}). ${e.slice(sh[0].length).replace(/^:\s*/, '').slice(0, 300) || 'See the log below for the step that failed.'} Building again won't change it: the command or the project needs fixing.` };
  if (/\[GameDeploy\][^\n]*FAILED|DEPLOY FAILED/i.test(both)) return { class: 'other', kind: 'unknown', plain: 'The deploy script failed and its log has no compile error in it. Read the log below: it is either the project (a script step failed) or the build machine.' };
  return { class: 'other', kind: 'unknown', plain: `Not recognised: ${e.slice(0, 200) || 'no reason given'}. The log below is what Gen kept.` };
}

/** The last lines of what Gen kept for a job (its log, the Unity log's tail, the build's errors), as one text. */
export function extractLog(job: any, lines = LOG_LINES): string {
  if (!job) return '';
  const parts: string[] = [];
  const asLines = (x: unknown): string[] => (Array.isArray(x) ? x.map((l) => (typeof l === 'string' ? l : l?.text ?? l?.line ?? l?.message ?? JSON.stringify(l))) : typeof x === 'string' ? x.split(/\r?\n/) : []);
  const errors = asLines(job.result?.errors).filter(Boolean);
  if (errors.length) parts.push('--- errors ---', ...errors.slice(0, 40));
  const unity = asLines(job.result?.logTail);
  if (unity.length) parts.push('--- Unity log (tail) ---', ...unity.slice(-lines));
  const genLog = asLines(job.log);
  if (genLog.length) parts.push('--- Hawkes Gen job log ---', ...genLog.slice(-lines));
  if (job.error) parts.push('--- Gen\'s error ---', String(job.error));
  const text = parts.join('\n');
  return text.length > LOG_BYTES ? text.slice(-LOG_BYTES) : text;
}

/** Thrown by builds.ts viaGen when a Unity build ends in failure: carries what Gen kept, so it isn't one line any more. */
export class BuildFailure extends Error {
  jobs: { id: string; error: string }[];
  log: string;
  constructor(message: string, o: { jobs: { id: string; error: string }[]; log: string }) {
    super(message);
    this.jobs = o.jobs;
    this.log = o.log;
  }
}

export type FailureView = {
  id: string; product: string; build: string; version: number; status: string; sha: string | null; ref: string | null;
  class: FailClass | null; kind: FailKind | null; plain: string; reason: string; step: string | null; stepWords: string | null;
  seconds: number | null; started: number; finished: number | null; run: string | null; genJob: string | null; jobs: { id: string; error: string }[];
  hasLog: boolean; tries: number;
  /** The automatic fixer's state for a code failure (buildfix.ts): what the red card says instead of "someone has to fix the code". */
  fix?: FixerNow & { sentence: string };
};

const parseJobs = (s: unknown): { id: string; error: string }[] => { try { const v = JSON.parse(String(s ?? '[]')); return Array.isArray(v) ? v : []; } catch { return []; } };

/** What a failure is, for "the same one again": the build, the class and the reason with ids, numbers and hashes taken out. */
export function failSignature(r: { build: string; fail_class?: string | null; detail?: string | null }): string {
  const why = String(r.detail ?? '').toLowerCase().replace(/\b[0-9a-f]{7,64}\b/g, '#').replace(/\b(?:b|r|j|a)_[0-9a-f]+\b/g, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 200);
  return `${r.build}|${r.fail_class ?? ''}|${why}`;
}

/** A builds row as a failure card needs it (no log: that is the "Why did this fail?" call). */
export function failureOf(r: any): FailureView {
  const jobs = parseJobs(r.gen_jobs);
  const c = r.fail_class ? null : r.status === 'failed' ? classify(r.detail, { stage: r.fail_step }) : null;
  return {
    id: r.id, product: r.product, build: r.build, version: r.version, status: r.status, sha: r.sha ?? null, ref: r.ref ?? null,
    class: (r.fail_class ?? c?.class ?? null) as FailClass | null, kind: (r.fail_kind ?? c?.kind ?? null) as FailKind | null,
    plain: r.status === 'failed' ? (r.fail_plain ?? c?.plain ?? '') : '', reason: r.detail ?? '', step: r.fail_step ?? null, stepWords: r.status === 'failed' ? stageWords(r.fail_step) : null,
    seconds: r.finished ? Math.round((r.finished - r.started) / 1000) : null, started: r.started, finished: r.finished ?? null, run: r.run ?? null,
    genJob: r.gen_job ?? jobs[jobs.length - 1]?.id ?? null, jobs, hasLog: Boolean(r.fail_log), tries: Math.max(1, jobs.length),
  };
}

/** Writes what a failed build knows on its row. Called from builds.ts when a build ends in failure; then announce(). */
export function recordFailure(rowId: string, error: unknown, o: { stage?: string | null; jobs?: { id: string; error: string }[]; log?: string; slug?: string | null } = {}): Classified {
  const why = String((error as any)?.message ?? error ?? '').slice(0, 500);
  const jobs = o.jobs ?? (error instanceof BuildFailure ? error.jobs : []);
  const log = (o.log ?? (error instanceof BuildFailure ? error.log : '')) || '';
  const c = classify(why, { stage: o.stage, log, tries: jobs.length, slug: o.slug });
  db.prepare("UPDATE builds SET status = 'failed', detail = ?, finished = COALESCE(finished, ?), fail_class = ?, fail_kind = ?, fail_plain = ?, fail_step = ?, fail_log = ?, gen_jobs = ? WHERE id = ?")
    .run(why, Date.now(), c.class, c.kind, c.plain, o.stage ?? null, log ? log.slice(-LOG_BYTES) : null, jobs.length ? JSON.stringify(jobs) : null, rowId);
  return c;
}

/** The newest build of each build id of a project (beta's, not an agent change's preview). */
export function lastBuilds(product: string): any[] {
  return db.prepare(`SELECT b.* FROM builds b WHERE b.product = ? AND b.change IS NULL AND b.started = (SELECT MAX(started) FROM builds x WHERE x.product = b.product AND x.build = b.build AND x.change IS NULL)`).all(product) as any[];
}

export type BuildRunning = { build: string; version: number | null; state: 'starting' | 'building'; run: string; started: number; step: string | null };

/**
 * Builds going right now: a running build run names its builds up front, and the row only exists once that build's turn
 * comes ("starting"), then it is "building". Go live and the cards show this at once when Build is pressed, and not a
 * stale red badge in between (J, 2026-11-03: the buttons "show back up again").
 */
export function buildsRunning(product: string): BuildRunning[] {
  const out: BuildRunning[] = [];
  const runs = db.prepare("SELECT id, options, started FROM runs WHERE kind = 'build' AND status = 'running' AND products LIKE ? ORDER BY started DESC").all(`%"${product}"%`) as any[];
  for (const r of runs) {
    let want: string[] = [];
    let change: unknown = null;
    try { const o = JSON.parse(r.options ?? '{}'); want = Array.isArray(o.builds) ? o.builds.map(String) : []; change = o.change; } catch {}
    if (change) continue; // an agent change's preview, not the project's own build
    for (const id of want) {
      if (out.some((x) => x.build === id)) continue;
      const row = db.prepare('SELECT version, status FROM builds WHERE run = ? AND product = ? AND build = ? ORDER BY started DESC LIMIT 1').get(r.id, product, id) as any;
      if (row && row.status !== 'building') continue; // this build of the run has ended; its result shows instead
      const step = db.prepare("SELECT detail FROM steps WHERE run = ? AND kind = 'build' AND name = ? ORDER BY started DESC LIMIT 1").get(r.id, id) as any;
      out.push({ build: id, version: row?.version ?? null, state: row ? 'building' : 'starting', run: r.id, started: r.started, step: step?.detail ?? null });
    }
  }
  return out;
}

/**
 * The build ids the project has now (its builds list). A failure of a build since removed or renamed isn't the project's
 * failure any more (Hawkes Net's "package" build, 2026-11-03: the card kept saying "Last build failed" and its Build again
 * named a build that no longer exists). null when the project isn't known here: nothing is hidden then.
 */
export function configuredBuilds(product: string): Set<string> | null {
  try { return new Set(buildsOf(getProduct(product)).map((b) => b.id)); } catch { return null; }
}

/**
 * Builds whose newest attempt failed, with the failure. Left out: a build id the project no longer has (configuredBuilds),
 * a failure a later success of the same build id superseded (lastBuilds keeps only the newest attempt of each id, and an
 * agent change's preview never counts), and one being built now or about to start. A success of a DIFFERENT build id
 * doesn't clear it: "release" working says nothing about "web" failing.
 */
export function failingBuilds(product: string): FailureView[] {
  const going = new Set(buildsRunning(product).map((x) => x.build));
  const now = configuredBuilds(product);
  return lastBuilds(product)
    // A failure waiting for its automatic retry isn't one yet, and an access failure is the project's one access card (buildaccess.ts).
    .filter((r) => r.status === 'failed' && !going.has(r.build) && (!now || now.has(r.build)) && !retryPending(r.id) && r.fail_class !== 'access')
    .map(failureOf)
    .map(withFixer);
}

/** A code failure with the fixer's state: its `plain` says "fix merged, rebuilding" or who is on it, never "someone has to fix the code" while a fixer is. */
function withFixer(f: FailureView): FailureView {
  if (f.kind !== 'code') return f;
  const now = fixerNow(failSignature({ build: f.build, fail_class: f.class, detail: f.reason }), f.product);
  return { ...f, plain: fixedWording(f.plain, now), fix: { ...now, sentence: fixSentence(now) } };
}

export type BuildDone = { id: string; build: string; version: number; sha: string | null; finished: number; seconds: number | null; url: string | null };

/**
 * Builds whose newest attempt succeeded in the last day (and aren't running again): the green "Done" state beside the
 * red and blue ones. A build id being built now isn't listed (it shows as building until it ends).
 */
export function buildsDone(product: string, within = 24 * 3600_000): BuildDone[] {
  const going = new Set(buildsRunning(product).map((x) => x.build));
  const now = configuredBuilds(product);
  return lastBuilds(product)
    .filter((r) => r.status === 'ready' && !going.has(r.build) && (!now || now.has(r.build)) && Date.now() - (r.finished ?? r.started) < within)
    .map((r) => ({ id: r.id, build: r.build, version: r.version, sha: r.sha ?? null, finished: r.finished ?? r.started, seconds: r.finished ? Math.round((r.finished - r.started) / 1000) : null, url: r.url ?? null }));
}

/** Every attempt at one commit, newest first: the history Go live shows next to "build first". */
export function attemptsAt(product: string, sha: string): FailureView[] {
  return (db.prepare(`SELECT * FROM builds WHERE product = ? AND change IS NULL AND sha IS NOT NULL AND (sha = ? OR ? LIKE sha || '%') ORDER BY started DESC LIMIT 20`).all(product, sha, sha) as any[]).map(failureOf);
}

/** The whole record of one failed build, with its log: the "Why did this fail?" view. */
export function whyFailed(rowId: string) {
  const r = db.prepare('SELECT * FROM builds WHERE id = ?').get(rowId) as any;
  if (!r) return null;
  const f = failureOf(r);
  const step = r.run ? db.prepare("SELECT id, status, detail FROM steps WHERE run = ? AND kind = 'build' AND name = ? ORDER BY started DESC LIMIT 1").get(r.run, r.build) : null;
  return { ...f, log: r.fail_log ?? '', commit: r.sha ?? null, step: f.step, runStep: step ?? null, noLog: r.status === 'failed' && !r.fail_log ? 'Hawkes Gen kept no log for this build (it failed before it started, or it failed before logs were kept).' : null };
}

/** The one-line-per-attempt text Go live puts beside "isn't built yet". */
export function attemptsLine(attempts: FailureView[]): string {
  const failed = attempts.filter((a) => a.status === 'failed');
  if (!attempts.length) return 'It was never built (no build ran for this commit).';
  const building = attempts.find((a) => a.status === 'building');
  if (building) return `It is being built right now (${building.build} ${building.version}).`;
  if (!failed.length) return '';
  const last = failed[0];
  return `It was tried ${failed.length} time${failed.length === 1 ? '' : 's'} and failed${last.kind ? ` (${last.kind === 'infrastructure' ? 'infrastructure' : last.kind === 'code' ? 'the code' : 'cause unclear'})` : ''}; last: ${last.plain || last.reason}`;
}

// ------------------------------------------------------------------ telling people (once)

/** Whether the build's previous attempt (same project, same build) failed the same way and J was told about it. */
export function repeatsLast(r: any): boolean {
  const prev = db.prepare("SELECT * FROM builds WHERE product = ? AND build = ? AND change IS NULL AND status = 'failed' AND started < ? AND id != ? ORDER BY started DESC LIMIT 1").get(r.product, r.build, r.started, r.id) as any;
  return Boolean(prev && prev.notified && failSignature(prev) === failSignature(r));
}

/**
 * The failure is final (Studio's own retries are used up): the Inbox shows it (inbox.ts) and J's phone is told ONCE.
 * `notified` on the row makes it once per failure, not per look; agent changes' previews (change not null) stay quiet.
 */
export async function announce(rowId: string): Promise<boolean> {
  const r = db.prepare('SELECT * FROM builds WHERE id = ?').get(rowId) as any;
  if (!r || r.status !== 'failed' || r.change || r.notified) return false;
  const took = db.prepare('UPDATE builds SET notified = ? WHERE id = ? AND notified IS NULL').run(Date.now(), rowId);
  if (!Number(took.changes)) return false;
  // A failure that is the code's: an agent is started on it first (once per failure, at most twice in all: buildfix.ts),
  // so the card and the push below say what it is doing rather than "someone has to fix the code first".
  let stopped = false;
  if (r.fail_kind === 'code') {
    const x = await import('./buildfix.ts').then((m) => m.autoFixBuild(rowId)).catch(() => null);
    if (x?.started) console.log(`[builds] ${r.product} ${r.build}: ${x.why}`);
    stopped = Boolean(x?.escalated); // buildfix.ts already told the phone, once
  }
  // The same failure again (a rebuild that fails the same way) was told already: marked, not told twice.
  if (stopped) return true;
  if (repeatsLast(r)) return false;
  // Beta is red: the agents running on this product hear why, on this event (not on a timer).
  void import('./buildfix.ts').then((m) => m.tellRunningAgents(r)).catch((e: any) => console.warn(`[builds] telling agents about ${r.product}'s red build: ${e?.message ?? e}`));
  try {
    const { notify, PUBLIC_URL } = await import('./notify.ts');
    const { fixerNow, fixedWording } = await import('./buildfix.ts');
    const name = (() => { try { return getProduct(r.product).name; } catch { return r.product; } })();
    const f = failureOf(r);
    const now = fixerNow(failSignature(r), r.product);
    const fixing = now.state === 'working' || now.state === 'merged';
    const title = fixing ? `${name}: build ${r.build} ${r.version} failed, a fix agent is on it` : `${name}: build ${r.build} ${r.version} failed`;
    const why = fixedWording(f.plain, now);
    const body = `${f.kind === 'infrastructure' ? 'Infrastructure' : f.kind === 'code' ? 'Code' : 'Cause unclear'}${f.stepWords ? `, while ${f.stepWords}` : ''}${f.tries > 1 ? `, after ${f.tries} tries` : ''}. ${why}`.slice(0, 600);
    const url = fixing && now.url ? `${PUBLIC_URL}/${now.url}` : `${PUBLIC_URL}/#inbox`;
    return await notify(title, body, { url, priority: 4, tags: ['rotating_light'] });
  } catch (e: any) {
    console.warn(`[builds] couldn't tell about the failed build ${rowId}: ${e?.message ?? e}`);
    return false;
  }
}

/** A build that ended: classify and keep what Gen left (the log), then tell. Used when a build row is settled outside buildOne. */
export async function settleFailure(rowId: string, error: string, o: { job?: any; stage?: string | null } = {}) {
  const log = extractLog(o.job);
  const prior = parseJobs((db.prepare('SELECT gen_jobs FROM builds WHERE id = ?').get(rowId) as any)?.gen_jobs);
  const jobId = o.job?.id ? String(o.job.id) : null;
  const jobs = prior.length || !jobId ? prior : [{ id: jobId, error: String(o.job?.error ?? error).slice(0, 300) }];
  recordFailure(rowId, error, { stage: o.stage ?? 'build', jobs, log });
  await announce(rowId);
}
