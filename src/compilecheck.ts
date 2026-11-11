// The compile gate (J, 2026-11-04): before an agent's Unity change may merge into beta, Hawkes Gen compiles the PR branch
// with the project's own Unity version and Library cache, with no player build (unity.build, customer mode, `check: true`:
// batchmode, nographics, import, compile, exit). Minutes, not the 45 to 70 of a WebGL build. The compiler errors (file,
// line, code) go onto the change; a failure sends the agent back (agents.ts, COMPILE_FIXES, never a try) and, when its
// passes are used up, fails the change so it can't merge. Gen owns the Unity licence: the customer does nothing.
//
// Cost: Gen reports seconds and dollars per run (result.seconds, result.cost); they are kept on the change (verify.compileCheck)
// and in `compile_checks`, and `compileCostReport()` is the average. Whether it runs is a setting
// (Settings → Builds, `builds.unityCompile`, on by default; the cost stop is `builds.unityCompileMaxCost`, $3): customers
// never touch env vars. STUDIO_UNITY_COMPILE=off|on stays only as an operator override (like STUDIO_UNITY_CHECK).
// Where Hawkes Gen has no compile-only mode yet the gate skips with a note (`compileGate`), never blocks, never runs a
// full player build by mistake.
//
// An infrastructure failure (Gen lost the job, a token, quota) never blocks a merge: the check says "couldn't run" and the
// change goes on to beta's own build. Only compiler errors block.
import { db } from './db.ts';
import { githubFor, GEN_GITHUB_KEYS } from './builds.ts';

/** The default cost stop: past this average per run the gate skips and says so (J: "a few dollars"). A setting. */
export const COST_STOP_USD = 3;
/** Passes an agent gets to fix compiler errors before its change fails. */
export const COMPILE_FIXES = 2;

export type CompileIssue = { file: string; line: number; col?: number; code: string; message: string };
export type CompileResult = {
  /** compiled: no errors; failed: compiler errors; unavailable: the check ran into trouble (not a verdict); skipped: it was not asked for (off, Gen can't, over the cost limit). */
  outcome: 'compiled' | 'failed' | 'unavailable' | 'skipped';
  ok: boolean;
  sha: string;
  issues: CompileIssue[];
  seconds: number | null;
  cost: number | null;
  unity?: string;
  machine?: string;
  job?: string;
  summary: string;
  /** Why it couldn't run. */
  note?: string;
};

db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL, by TEXT)`);

// ---- the setting (Settings → Builds; settings.ts section `builds`)
export type BuildsSettings = { /** Compile agents' Unity changes in Hawkes Gen before they may merge. */ unityCompile: boolean; /** Dollars: the gate skips while the measured average per run is above this. */ unityCompileMaxCost: number; /** Retry transient build failures by itself and turn access problems into one Inbox card (buildaccess.ts). */ handleFailures: boolean };
export const BUILDS_DEFAULTS: BuildsSettings = { unityCompile: true, unityCompileMaxCost: COST_STOP_USD, handleFailures: true };

export function buildsSettings(): BuildsSettings {
  const r = db.prepare(`SELECT value FROM settings WHERE key = 'builds'`).get() as { value: string } | undefined;
  let v: any = {};
  try { v = r ? JSON.parse(r.value) : {}; } catch { /* defaults */ }
  return { ...BUILDS_DEFAULTS, ...(typeof v === 'object' && v ? v : {}) };
}

export function saveBuildsSettings(patch: Record<string, any>, by = 'J'): BuildsSettings {
  const next = buildsSettings();
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (k === 'unityCompile') { if (typeof v !== 'boolean') throw new Error('builds.unityCompile: true or false'); next.unityCompile = v; continue; }
    if (k === 'handleFailures') { if (typeof v !== 'boolean') throw new Error('builds.handleFailures: true or false'); next.handleFailures = v; continue; }
    if (k === 'unityCompileMaxCost') {
      const n = Number(v);
      if (!(Number.isFinite(n) && n >= 0.1 && n <= 100)) throw new Error('builds.unityCompileMaxCost: 0.10 to 100 (dollars per run)');
      next.unityCompileMaxCost = Math.round(n * 100) / 100;
      continue;
    }
    throw new Error(`builds.${k}: not a setting (${Object.keys(BUILDS_DEFAULTS).join(', ')})`);
  }
  db.prepare('INSERT INTO settings (key, value, updated, by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, by = excluded.by')
    .run('builds', JSON.stringify(next), Date.now(), by);
  return next;
}

/** Operator override only: STUDIO_UNITY_COMPILE=off|on beats the setting; unset (the norm) leaves it to the setting. */
export const compileOverride = (): boolean | null => {
  const v = (process.env.STUDIO_UNITY_COMPILE ?? '').trim();
  return /^(on|1|true)$/i.test(v) ? true : /^(off|0|false)$/i.test(v) ? false : null;
};
/** Whether the gate is switched on (the override, else the setting). Read at run time: no restart. */
export const compileCheckOn = () => compileOverride() ?? buildsSettings().unityCompile;

/**
 * Whether Gen's unity.build has the compile-only `check` param (older Gens would run a whole player build), and if not, why
 * (the sentence the change shows). Cached 5 min. The contract Studio relies on is in docs/daily.md, "The compile gate:
 * what Hawkes Gen serves".
 */
let genSeen: { at: number; ok: boolean; why?: string } | null = null;
export async function genCompileMode(): Promise<{ ok: boolean; why?: string }> {
  if (genSeen && Date.now() - genSeen.at < 5 * 60_000) return genSeen;
  let ok = false;
  let why: string | undefined;
  try {
    const { gen } = await import('./gen.ts');
    const t: any = await (gen as any).tool('unity.build');
    const params = t?.params ?? t?.tool?.params;
    ok = Array.isArray(params) ? params.some((x: any) => x?.name === 'check' || x === 'check') : Boolean(params && typeof params === 'object' && 'check' in params);
    if (!ok) why = "Hawkes Gen's unity.build has no compile-only `check` mode yet";
  } catch (e: any) { why = `Hawkes Gen couldn't be asked about its compile-only mode (${String(e?.message ?? e).slice(0, 120)})`; }
  genSeen = { at: Date.now(), ok, ...(why ? { why } : {}) };
  return genSeen;
}
export const genHasCompileMode = async () => (await genCompileMode()).ok;
export const forgetGenCompileMode = () => { genSeen = null; };

/** Should the gate run now? Never throws. `why` is a plain sentence, for the change's log AND its summary (skippedCompile), when it is skipped. */
export async function compileGate(): Promise<{ run: boolean; why?: string }> {
  if (!compileCheckOn()) return { run: false, why: "Compile check skipped: it is switched off (Settings → Builds), so the change goes on to beta's own build" };
  const mode = await genCompileMode();
  if (!mode.ok) return { run: false, why: `Compile check skipped: ${mode.why ?? "Hawkes Gen's compile-only mode isn't live yet"}, so the change goes on to beta's own build` };
  const cap = buildsSettings().unityCompileMaxCost, avg = compileCostReport().avgCost;
  if (avg != null && avg > cap) return { run: false, why: `Compile check skipped: it averages $${avg.toFixed(2)} a run, over your $${cap.toFixed(2)} limit (Settings → Builds), so the change goes on to beta's own build` };
  return { run: true };
}

/** What Studio sends Gen: the customer build shape (github {repo, commit, token, ref}) and `check: true`, nothing else. */
export function compileParams(opts: { slug: string; sha: string; ref: string; token: string; path?: string; machine?: string | { cpu: number; memoryGiB: number } }): Record<string, unknown> {
  const github = githubFor(opts.slug, opts.sha, opts.token, opts.ref);
  const extra = Object.keys(github).filter((k) => !(GEN_GITHUB_KEYS as readonly string[]).includes(k));
  if (extra.length) throw new Error(`the compile check would send Hawkes Gen github.${extra.join(', github.')}: not sent`);
  return { github, check: true, ...(opts.path ? { path: opts.path } : {}), ...(opts.machine ? { machine: opts.machine } : {}), target: 'web' };
}

/** `Assets/X.cs(12,34): error CS1503: message` lines of a Unity log, when Gen's own parsed list is missing. */
export function parseCompilerLog(log: string, max = 100): CompileIssue[] {
  const out: CompileIssue[] = [];
  const seen = new Set<string>();
  for (const m of log.matchAll(/^\s*([^\s(][^(\n]*\.cs)\((\d+)(?:,(\d+))?\):\s*error\s+(CS\d{4}):\s*(.+)$/gm)) {
    const key = `${m[1]}:${m[2]}:${m[4]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file: m[1].trim(), line: Number(m[2]), ...(m[3] ? { col: Number(m[3]) } : {}), code: m[4], message: m[5].trim().slice(0, 300) });
    if (out.length >= max) break;
  }
  return out;
}

const mins = (s: number | null) => (s == null ? '?' : s < 90 ? `${Math.round(s)} s` : `${(s / 60).toFixed(1)} min`);
const usd = (c: number | null) => (c == null ? '?' : `$${c.toFixed(2)}`);

/** A gate that did not run, as a result the change carries: its summary reaches the ready line and the owner (agents.ts readyDetail). */
export const skippedCompile = (why: string, sha = ''): CompileResult => ({ outcome: 'skipped', ok: true, sha, issues: [], seconds: null, cost: null, note: why, summary: why });

/** Gen's finished job -> the verdict. A job that failed for any reason but compiler errors is `unavailable`. */
export function compileResultOf(job: any, sha: string): CompileResult {
  const r = job?.result ?? {};
  const seconds = typeof r.seconds === 'number' ? r.seconds : null;
  const cost = typeof r.cost === 'number' ? r.cost : null;
  const base = { sha, seconds, cost, ...(r.unity ? { unity: String(r.unity) } : {}), ...(r.machine?.name ? { machine: String(r.machine.name) } : {}), ...(job?.id ? { job: String(job.id) } : {}) };
  const listed: CompileIssue[] = Array.isArray(r.errors)
    ? r.errors.filter((e: any) => e && typeof e === 'object' && e.file).map((e: any) => ({ file: String(e.file), line: Number(e.line) || 0, ...(e.col ? { col: Number(e.col) } : {}), code: String(e.code ?? 'CS'), message: String(e.message ?? '').slice(0, 300) }))
    : [];
  const issues = listed.length ? listed : parseCompilerLog(String(r.logTail ?? ''));
  if (issues.length) {
    const files = new Set(issues.map((i) => i.file)).size;
    return { ...base, outcome: 'failed', ok: false, issues, summary: `Compile check FAILED (Hawkes Gen, Unity ${r.unity ?? '?'}, ${mins(seconds)}, ${usd(cost)}): ${issues.length} error${issues.length === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}: ${issues.slice(0, 3).map((i) => `${i.file}:${i.line} ${i.code}`).join(', ')}${issues.length > 3 ? ' ...' : ''}` };
  }
  if (job?.status === 'done' && r.ok !== false) return { ...base, outcome: 'compiled', ok: true, issues: [], summary: `Compile check passed (Hawkes Gen, Unity ${r.unity ?? '?'}, ${mins(seconds)}, ${usd(cost)}): the branch compiles` };
  const why = String(job?.error ?? r.error ?? 'no reason given').slice(0, 200);
  return { ...base, outcome: 'unavailable', ok: true, issues: [], note: why, summary: `Compile check couldn't run (${why}): the change goes on to beta's own build` };
}

/** Lines an agent can act on. */
export const compileLines = (r: Pick<CompileResult, 'issues'>, max = 40) =>
  r.issues.slice(0, max).map((x) => `${x.file}:${x.line}${x.col ? `:${x.col}` : ''} error ${x.code}: ${x.message}`).concat(r.issues.length > max ? [`... and ${r.issues.length - max} more`] : []);

/** What an agent whose branch fails to compile is told (it resumes its own session). */
export function compileFixPrompt(r: CompileResult): string {
  return `Hawkes Gen compiled your branch (${r.sha.slice(0, 7)}) with the project's own Unity version and the Unity compiler rejected it, so it can't merge into beta:

${compileLines(r).map((l) => `- ${l}`).join('\n')}

Fix each one in the file and line named (CS1503 is an argument of the wrong type: check the method's parameter types, and convert or pass the right value). Commit the fix, and update .hawkes/summary.md if what the change does is different now. Studio compiles it again before it may merge.`;
}

db.exec(`CREATE TABLE IF NOT EXISTS compile_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, change_id TEXT, product TEXT, sha TEXT, outcome TEXT,
  seconds REAL, cost REAL, errors INTEGER, job TEXT, machine TEXT
)`);

export function recordCompile(changeId: string, product: string, r: CompileResult) {
  db.prepare('INSERT INTO compile_checks (at, change_id, product, sha, outcome, seconds, cost, errors, job, machine) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(Date.now(), changeId, product, r.sha, r.outcome, r.seconds, r.cost, r.issues.length, r.job ?? null, r.machine ?? null);
}

/** Time and cost per run, from the runs Gen priced (unavailable ones have none). overCost: the average is past the setting's limit. */
export function compileCostReport() {
  const row = db.prepare('SELECT COUNT(*) n, AVG(seconds) s, AVG(cost) c, MAX(cost) mx, SUM(cost) total FROM compile_checks WHERE cost IS NOT NULL').get() as any;
  const avgCost = row.n ? row.c : null;
  return { runs: row.n as number, avgSeconds: row.n ? Math.round(row.s) : null, avgCost: avgCost == null ? null : Math.round(avgCost * 1000) / 1000, maxCost: row.n ? row.mx : null, totalCost: row.n ? Math.round(row.total * 100) / 100 : 0, overCost: avgCost != null && avgCost > buildsSettings().unityCompileMaxCost };
}

/** Runs the check on a pushed commit. Never throws: any failure to run is `unavailable`. */
export async function runCompileCheck(opts: { changeId: string; product: string; slug: string; sha: string; ref: string; path?: string }, say: (s: string) => void = () => {}): Promise<CompileResult> {
  const unavailable = (why: string): CompileResult => ({ outcome: 'unavailable', ok: true, sha: opts.sha, issues: [], seconds: null, cost: null, note: why, summary: `Compile check couldn't run (${why}): the change goes on to beta's own build` });
  try {
    const { forgetRepoToken, repoToken } = await import('./ghtoken.ts');
    forgetRepoToken(opts.slug);
    const token = await repoToken(opts.slug);
    if (!token) return unavailable(`Studio has no GitHub access to ${opts.slug}`);
    const { genRun } = await import('./gen.ts');
    say('Hawkes Gen is compiling the branch (no player build)');
    // One Unity build of a product at a time in Gen (unityslot.ts): a check may wait its turn behind a build, so the token
    // is minted again when its turn comes. A newer check replaces it while it waits (it ends `unavailable`, not a verdict).
    const paramsNow = async () => { forgetRepoToken(opts.slug); const t = (await repoToken(opts.slug)) ?? token; return compileParams({ slug: opts.slug, sha: opts.sha, ref: opts.ref, token: t, path: opts.path }); };
    const job = await genRun('unity.build', opts.product, compileParams({ slug: opts.slug, sha: opts.sha, ref: opts.ref, token, path: opts.path }), (j) => { if (j?.progress?.step) say(`Hawkes Gen: ${j.progress.step}`); }, 30 * 60 * 1000, { paramsNow });
    const r = compileResultOf(job, opts.sha);
    recordCompile(opts.changeId, opts.product, r);
    return r;
  } catch (e: any) {
    return unavailable(String(e?.message ?? e).slice(0, 120));
  }
}
