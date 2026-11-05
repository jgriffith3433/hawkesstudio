// A build that fails because of the code is fixed by an agent, not only reported (J, 2026-11-04: Yooba Land web 26 failed
// with "error CS0102: The type 'YoobaTunnel' already contains a definition for 'Find'"; Studio classified it as the code's
// fault (buildfail.ts), filed an Inbox card and stopped: "someone has to fix the code first").
//
//   autoFixBuild(): called once per final failure (buildfail.ts announce). Only kind "code" (compiler errors, a project's
//     own build command); infrastructure, quota, config and unknown failures keep their behaviour. It starts ONE agent
//     change (agents.ts startTask: a branch from beta, a pull request into beta, queued behind the product's other
//     agents by perProduct) whose request has the compiler errors, the failing commit and, when it can be told, the
//     merged change that brought it. The same failure (failSignature) starts one fixer at a time and at most MAX_FIXES
//     in all; after that the Inbox card is the owner's.
//   The fix merges into beta by itself (autoMergeBeta) and that starts beta's build (agents.ts approve → startBeta);
//     builds.ts startBuild closes the failed build's Inbox card (inbox.ts resolveBuildCards) when it starts, and the card
//     comes back only if the rebuild fails differently.
//   buildCheckBrief(): what every agent on a project with a build is told to run before opening a PR (agents.ts brief).
//
// The failure chain (J, 2026-11-05: Yooba Land builds 26-29 failed one compile error at a time, and the fix of 29 merged
// 90 seconds after the failure but nothing rebuilt it, because that build only runs on a tag):
//   - a chain is the run of failures of one build id of a project since it last worked (`build_chains`, one open at a time).
//     Each attempt is one fixer: the failed build row, its error text in full, its change.
//   - fixMerged(): the fixer's change merged into beta -> a new build of the same build id on beta's head, whatever its
//     trigger (a tag-only build too), at once (agents.ts approve calls it). The rebuild is the VERIFICATION: the fixer's
//     word is not (nothing is "fixed" until a build of the chain passes: buildPassed() closes it).
//   - the rebuild fails with other errors -> the chain goes on with a new fixer that is given the full error text of every
//     attempt so far; at most MAX_ATTEMPTS fixers in a chain. The same errors again (after a fix merged), or the cap, or a
//     rebuild that can't start -> escalate(): the chain stops and the owner's Inbox card lists what was tried, with links.
//   - the owner's notices follow the chain: "fix merged, rebuilding" (never "someone has to fix the code first" while a
//     fixer is on it), the old card goes when the rebuild starts (builds.ts startBuild -> inbox.ts resolveBuildCards).
//   No timers: every step is an event (a build failing, a change merging, a build starting or passing).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { getProduct, managedElsewhere } from './config.ts';
import { failSignature } from './buildfail.ts';
import { buildErrors, pickCulprit } from './buildblame.ts';

/** Fixers one failure chain (a build id's failures since it last worked) may start in all, so a fix that doesn't fix can't loop. */
export const MAX_ATTEMPTS = 3;
export const MAX_FIXES = MAX_ATTEMPTS;
/** A change merged into beta this long before the failed build started can be the one that broke it. */
const BLAME_WINDOW_MS = 48 * 3600_000;
/** Statuses of a change that is still on its way (its fix may yet merge): another fixer for the same failure waits. */
const OPEN = ['queued', 'working', 'verifying', 'revising', 'ready', 'needs answer', 'asked'];
/** Statuses of a change whose agent is running now: it is told when beta's build goes red (tellRunningAgents). */
const RUNNING = ['queued', 'working', 'verifying', 'revising', 'needs answer', 'waiting on Gen'];
/** The file a running agent finds in its worktree when beta is red; its brief says to read it before the pull request. */
export const BETA_RED_FILE = '.hawkes/beta-build.md';

/** The marker line a fixer's request carries; the count and the dedupe read it back from `changes.request`. */
export const fixMarker = (sig: string) => `build-fix:${crypto.createHash('sha1').update(sig).digest('hex').slice(0, 12)}`;


// ------------------------------------------------------------------ the failure chain

db.exec(`CREATE TABLE IF NOT EXISTS build_chains (
  id TEXT PRIMARY KEY, product TEXT NOT NULL, build TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
  attempts TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL, updated INTEGER NOT NULL
)`);

export type Attempt = {
  /** The failed build row this fixer answers. */
  row: string; sha: string | null; sig: string;
  /** The compiler's error lines in full, as that build reported them. */
  errors: string[];
  change: string; title: string; at: number;
  /** The rebuild after the fix merged: the run asked for (or why it could not start). */
  rebuild?: { at: number; run?: string; failed?: string };
};
export type Chain = { id: string; product: string; build: string; status: 'open' | 'passed' | 'escalated'; reason: string | null; attempts: Attempt[]; created: number; updated: number };
const chainOf = (r: any): Chain => { let a: Attempt[] = []; try { a = JSON.parse(r.attempts); } catch { /* none */ } return { ...r, attempts: Array.isArray(a) ? a : [] }; };
const saveChain = (c: Chain) => db.prepare('UPDATE build_chains SET status = ?, reason = ?, attempts = ?, updated = ? WHERE id = ?').run(c.status, c.reason, JSON.stringify(c.attempts), Date.now(), c.id);

/** The open chain of a build id, else null. */
export function openChain(product: string, build: string): Chain | null {
  const r = db.prepare("SELECT * FROM build_chains WHERE product = ? AND build = ? AND status = 'open' ORDER BY created DESC LIMIT 1").get(product, build);
  return r ? chainOf(r) : null;
}
/** The newest chain of a build id, whatever its state (the card reads an escalation from it). */
export function latestChain(product: string, build: string): Chain | null {
  const r = db.prepare('SELECT * FROM build_chains WHERE product = ? AND build = ? ORDER BY created DESC LIMIT 1').get(product, build);
  return r ? chainOf(r) : null;
}
function startChain(product: string, build: string): Chain {
  const c: Chain = { id: `ch_${crypto.randomBytes(5).toString('hex')}`, product, build, status: 'open', reason: null, attempts: [], created: Date.now(), updated: Date.now() };
  db.prepare('INSERT INTO build_chains (id, product, build, status, reason, attempts, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(c.id, product, build, c.status, c.reason, '[]', c.created, c.updated);
  return c;
}
const changeStatus = (id: string): string | null => { try { return (db.prepare('SELECT status FROM changes WHERE id = ?').get(id) as any)?.status ?? null; } catch { return null; } };

/** An error line without its position or numbers, so "the same error" survives the line moving. */
const flat = (l: string) => l.replace(/\(\d+,\d+\)/g, '').replace(/:\d+(:\d+)?\b/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
/** The errors a build reported, as comparable keys. Exported for the tests. */
export function errorKeys(r: { fail_log?: string | null; detail?: string | null }): string[] {
  const e = buildErrors(`${r.fail_log ?? ''}\n${r.detail ?? ''}`).lines;
  return [...new Set((e.length ? e : [String(r.detail ?? '')]).map(flat))].sort();
}
/** Whether two failures are the same errors again (every error of the new one was in the old one). */
export const sameErrors = (a: string[], b: string[]) => b.length > 0 && b.every((k) => a.includes(k));

/** The chain's tried-so-far text for the next fixer and for the Inbox card: each attempt, its change, its full error text. */
export function attemptsText(c: Chain, o: { full: boolean }): string {
  return c.attempts.map((a, i) => {
    const st = changeStatus(a.change);
    const fate = st === 'merged' ? (a.rebuild?.failed ? `merged; the rebuild couldn't start (${a.rebuild.failed})` : 'merged into beta; the rebuild then failed') : `its change is ${st ?? 'gone'}`;
    const head = `Attempt ${i + 1}: change ${a.change} (${a.title}), for build ${c.build} at ${a.sha ? a.sha.slice(0, 7) : 'an unknown commit'}: ${fate}.`;
    return o.full ? `${head}\nThe errors it was given:\n\`\`\`\n${a.errors.join('\n').slice(0, 2500)}\n\`\`\`` : `${head} First error: ${(a.errors[0] ?? '').slice(0, 160)}`;
  }).join('\n\n');
}

/** The chain stops: the owner's. Says so on the failed build's card and on the phone (once). Never throws. */
async function escalate(c: Chain, why: string, row: any): Promise<void> {
  c.status = 'escalated';
  c.reason = why;
  saveChain(c);
  console.log(`[buildfix] ${c.product} ${c.build}: stopped after ${c.attempts.length} attempt(s): ${why}`);
  try {
    const { notify, PUBLIC_URL } = await import('./notify.ts');
    const name = (() => { try { return getProduct(c.product).name; } catch { return c.product; } })();
    await notify(`${name}: build ${c.build} still fails after ${c.attempts.length} fix attempt${c.attempts.length === 1 ? '' : 's'}`, `${why}. It needs you: the Inbox card lists what was tried.${row?.version ? ` (build ${row.version})` : ''}`.slice(0, 600), { url: `${PUBLIC_URL}/#inbox`, priority: 4, tags: ['rotating_light'] });
  } catch (e: any) { console.warn(`[buildfix] couldn't tell about the stopped chain: ${e?.message ?? e}`); }
}

/**
 * A fixer's change merged into beta: build the same build id again on beta's head, even when its builds only run on a tag
 * (agents.ts approve). That rebuild is what verifies the fix. Never throws; false when the change isn't a build fixer's.
 */
export async function fixMerged(changeId: string, deps: { rebuild?: (product: string, build: string) => Promise<{ id: string } | null> } = {}): Promise<boolean> {
  try {
    const rows = db.prepare("SELECT * FROM build_chains WHERE status = 'open' AND attempts LIKE ?").all(`%${changeId}%`) as any[];
    const c = rows.map(chainOf).find((x) => x.attempts.some((a) => a.change === changeId));
    if (!c) return false;
    const a = c.attempts.find((x) => x.change === changeId)!;
    if (a.rebuild) return true; // asked already (a second call of the merge)
    a.rebuild = { at: Date.now() };
    try {
      const rebuild = deps.rebuild ?? (async (product, build) => (await import('./builds.ts')).startBuild(product, { build }));
      const run = await rebuild(c.product, c.build);
      if (run) a.rebuild.run = run.id;
      else a.rebuild.failed = 'the project has no such build any more';
    } catch (e: any) { a.rebuild.failed = String(e?.message ?? e).slice(0, 200); }
    if (a.rebuild.failed) { saveChain(c); await escalate(c, `The fix merged (change ${changeId}) but the rebuild could not start: ${a.rebuild.failed}`, null); return true; }
    saveChain(c);
    return true;
  } catch (e: any) {
    console.warn(`[buildfix] after ${changeId} merged: ${e?.message ?? e}`);
    return false;
  }
}

/** At start-up: a fix that merged while Studio was restarting still gets its rebuild (once: an attempt that has one is left). */
export async function resumeChains(): Promise<number> {
  let n = 0;
  for (const r of db.prepare("SELECT * FROM build_chains WHERE status = 'open'").all() as any[]) {
    for (const a of chainOf(r).attempts) if (!a.rebuild && changeStatus(a.change) === 'merged' && await fixMerged(a.change)) n++;
  }
  return n;
}

/** A build of the id finished well: the chain's fixes are verified, and it closes. */
export function buildPassed(product: string, build: string): void {
  const c = openChain(product, build);
  if (!c) return;
  c.status = 'passed';
  c.reason = c.attempts.length ? `a rebuild passed after ${c.attempts.length} fix attempt${c.attempts.length === 1 ? '' : 's'}` : 'a build passed';
  saveChain(c);
}

export type FixState = { open: string[]; total: number };
/** The fixers already started for a failure signature: the ones still open, and all that were started (cancelled ones don't count). */
export function fixersOf(sig: string): FixState {
  let rows: { id: string; status: string }[] = [];
  try { rows = db.prepare("SELECT id, status FROM changes WHERE request LIKE ? AND status != 'cancelled' ORDER BY created").all(`%${fixMarker(sig)}%`) as typeof rows; } catch { /* agents.ts makes the table; none yet means none started */ }
  return { open: rows.filter((r) => OPEN.includes(r.status)).map((r) => r.id), total: rows.length };
}

/**
 * Where the automatic fixer of a failure is now: working (an open change), merged (its fix is in beta and beta rebuilds),
 * exhausted (MAX_FIXES tried: the owner's), or none (no fixer started, or the last one stopped). The Inbox card and the
 * phone push say which; only "none" and "exhausted" keep the "someone has to fix the code" wording.
 */
export type FixerNow = { state: 'working' | 'merged' | 'exhausted' | 'none'; change: string | null; title: string | null; url: string | null };
export function fixerNow(sig: string, product?: string): FixerNow {
  let rows: { id: string; status: string; title: string | null }[] = [];
  try { rows = db.prepare("SELECT id, status, title FROM changes WHERE request LIKE ? AND status != 'cancelled' ORDER BY created").all(`%${fixMarker(sig)}%`) as typeof rows; } catch { /* no table yet: no fixer */ }
  const pick = (r: { id: string; title: string | null }, state: FixerNow['state']): FixerNow => ({ state, change: r.id, title: r.title ?? r.id, url: `#changes/${r.id}` });
  const open = rows.filter((r) => OPEN.includes(r.status));
  if (open.length) return pick(open[open.length - 1], 'working');
  const last = rows.at(-1);
  // A chain the owner has to take over (the cap, the same errors again, a rebuild that couldn't start) is exhausted whatever the signature.
  const build = sig.split('|')[0];
  const chain = product ? latestChain(product, build) : null;
  if (chain?.status === 'escalated') return { state: 'exhausted', change: null, title: null, url: null };
  if (last?.status === 'merged') return pick(last, 'merged');
  if (rows.length >= MAX_ATTEMPTS) return { state: 'exhausted', change: null, title: null, url: null };
  return { state: 'none', change: null, title: null, url: null };
}

/** The sentence that says where the fix is (the card and the push); empty when no fixer is involved. */
export function fixSentence(now: FixerNow): string {
  if (now.state === 'working') return `A fix agent is working on it (change ${now.change}, ${now.title}). When its fix merges, Studio rebuilds by itself (even a build that only runs on a tag), and this card goes then.`;
  if (now.state === 'merged') return `Fix merged into beta (change ${now.change}, ${now.title}), rebuilding. If the rebuild passes this goes away; if it fails again you'll see the new errors here.`;
  return '';
}

/** The "needs a person" sentence buildfail.ts writes for every code failure. A fixer replaces it; no fixer keeps it. */
const NEEDS_PERSON = /\s*Studio can't fix this by building again: someone has to fix the code first\./;
/** A failure's plain reason for the owner, with the automatic fixer's state in it (never "someone has to fix" while one works). */
export function fixedWording(plain: string, now: FixerNow): string {
  if (now.state !== 'working' && now.state !== 'merged') return plain;
  return `${plain.replace(NEEDS_PERSON, '')} ${fixSentence(now)}`.trim();
}

/**
 * Beta's build failed (announce, once per failure): every agent running on that product is told, by a file in its worktree
 * (.hawkes/beta-build.md: beta is red, why, and the error text) and a line in its log. Its brief has it read before the pull
 * request (buildCheckBrief). A code failure also files a memory lesson candidate. Returns how many agents were told.
 */
export async function tellRunningAgents(r: any): Promise<number> {
  let rows: { id: string; worktree: string | null }[] = [];
  try { rows = db.prepare(`SELECT id, worktree FROM changes WHERE product = ? AND status IN (${RUNNING.map(() => '?').join(',')})`).all(r.product, ...RUNNING) as typeof rows; } catch { return 0; }
  if (!rows.length) return 0;
  const errors = buildErrors(`${r.fail_log ?? ''}\n${r.detail ?? ''}`);
  const shown = errors.lines.length ? errors.lines : [String(r.detail ?? '').slice(0, 400)];
  const sha = r.sha ? String(r.sha).slice(0, 7) : 'unknown';
  const why = String(r.fail_plain ?? r.detail ?? '').replace(NEEDS_PERSON, '').trim();
  const text = `# Beta's build is red

Beta's build ${r.build} ${r.version} of ${r.product} failed (commit ${sha} on beta).

Why: ${why || 'no reason given'}

The error text:

\`\`\`
${shown.join('\n').slice(0, 3000)}
\`\`\`

Beta is red, so a change that builds on beta can still fail once it merges. Before you open your pull request, check that
your change doesn't add to these errors, and fix any of them your change touches. Say in the pull request that beta was
red and what you saw. (Studio wrote this file; it isn't part of your change and isn't committed.)
`;
  let agents: any = null;
  try { agents = await import('./agents.ts'); } catch { /* agents.ts not loaded (a test without it): files only */ }
  let told = 0;
  for (const c of rows) {
    if (c.worktree && fs.existsSync(c.worktree)) {
      try {
        fs.mkdirSync(path.join(c.worktree, '.hawkes'), { recursive: true });
        fs.writeFileSync(path.join(c.worktree, BETA_RED_FILE), text);
        told++;
      } catch { /* the worktree is going away: the log still says so */ }
    }
    agents?.changeLog?.(c.id, `beta's build ${r.build} ${r.version} failed (${sha}): ${why.slice(0, 200)}. The error text is in ${BETA_RED_FILE}; read it before the pull request.`);
  }
  if (r.fail_kind === 'code') {
    try {
      const { writeMemory } = await import('./memory.ts');
      const first = (shown[0] ?? '').replace(/^.*?(error )/, '$1').slice(0, 120);
      writeMemory({ kind: 'lesson', title: `Beta's ${r.product} build failed: ${first || 'a compile error'}`, body: `${why}\n\nError text:\n${shown.slice(0, 5).join('\n')}`.slice(0, 1500), product: r.product, tags: 'build' }, { who: 'agent', name: 'Studio (beta build)' });
    } catch (e: any) { console.warn(`[buildfix] lesson candidate for ${r.product}: ${e?.message ?? e}`); }
  }
  return told;
}

export type FixDeps = {
  /** Starts the agent change (agents.ts startTask); returns its id. */
  start: (product: string, request: string, o: { title: string }) => string;
  /** The merged changes of the product that could have brought the failing commit, with the files each touched. */
  culprits: (product: string, before: number, errorFiles: string[]) => Promise<{ id: string; title: string; task: string | null; pr_url: string | null; at: number; files: string[] }[]>;
  /** Whether agents may start fixes at all (settings.agents enabled and autoFix). */
  allowed: () => boolean;
};

const realDeps = (): FixDeps => ({
  start: (product, request, o) => {
    // Imported on use: agents.ts is heavy and imports builds.ts, which imports buildfail.ts.
    const A = requireAgents();
    const id = A.startTask(product, request, { title: o.title });
    db.prepare('UPDATE changes SET started_by = ? WHERE id = ?').run('Studio (build fix)', id);
    return id;
  },
  culprits: async (product, before, errorFiles) => {
    const A = requireAgents();
    const rows = db.prepare("SELECT id FROM changes WHERE product = ? AND status = 'merged' AND merged_at IS NOT NULL AND merged_at <= ? AND merged_at >= ? ORDER BY merged_at DESC LIMIT 12").all(product, before, before - BLAME_WINDOW_MS) as { id: string }[];
    const out: Awaited<ReturnType<FixDeps["culprits"]>> = [];
    for (const r of rows) {
      const c = A.getChange(r.id);
      if (!c) continue;
      let files: string[] = [];
      if (errorFiles.length && c.pr && c.slug) {
        const list: any = await A.github(`/repos/${c.slug}/pulls/${c.pr}/files?per_page=100`).catch(() => []);
        files = Array.isArray(list) ? list.map((f: any) => String(f.filename)) : [];
      }
      out.push({ id: c.id, title: c.title ?? c.id, task: c.task, pr_url: c.pr_url, at: (c as any).merged_at ?? c.created, files });
    }
    return out;
  },
  allowed: () => { const s = requireAgents().agentSettings(); return s.enabled && s.autoFix; },
});
let agentsMod: any = null;
function requireAgents() {
  if (!agentsMod) throw new Error('agents.ts is not loaded yet');
  return agentsMod as typeof import('./agents.ts');
}

export type FixResult = { started: string | null; why: string; escalated?: boolean };

/**
 * Starts a fixer for a failed build row when the failure is the code's, new, and the chain is under its cap. Never throws.
 * A failure that follows a merged fix of the chain is that fix's verdict: other errors continue the chain (a new fixer
 * with every earlier attempt's errors), the same errors, or the cap, stop it for the owner.
 */
export async function autoFixBuild(rowId: string, deps?: Partial<FixDeps>): Promise<FixResult> {
  try {
    const r = db.prepare('SELECT * FROM builds WHERE id = ?').get(rowId) as any;
    if (!r || r.status !== 'failed') return { started: null, why: 'not a failed build' };
    if (r.change) return { started: null, why: "an agent change's preview, not the project's own build" };
    if (r.fail_kind !== 'code') return { started: null, why: `a ${r.fail_kind ?? 'unclear'} failure: not fixed by an agent` };
    let p;
    try { p = getProduct(r.product); } catch { return { started: null, why: 'unknown project' }; }
    if (managedElsewhere(p)) return { started: null, why: 'handled by another Studio' };
    if (!deps?.start) agentsMod ??= await import('./agents.ts');
    const d: FixDeps = { ...realDeps(), ...deps };
    if (!d.allowed()) return { started: null, why: 'agents are off or auto-fix is off' };
    const sig = failSignature(r);
    const have = fixersOf(sig);
    if (have.open.length) return { started: null, why: `${have.open[0]} is already fixing this failure` };
    const chain = openChain(r.product, r.build) ?? startChain(r.product, r.build);
    if (chain.attempts.some((a) => a.row === rowId)) return { started: null, why: 'this failure has its fixer already' };
    const open = chain.attempts.find((a) => OPEN.includes(changeStatus(a.change) ?? ''));
    if (open) return { started: null, why: `${open.change} is already fixing this build` };
    const keys = errorKeys(r);
    const last = chain.attempts.at(-1);
    // The verdict on the last fix: it merged and the rebuild failed. Other errors: the chain goes on. The same: stop.
    if (last && changeStatus(last.change) === 'merged' && sameErrors(last.errors.map(flat), keys)) {
      await escalate(chain, `The fix merged (change ${last.change}) and the rebuild failed with the same error${keys.length === 1 ? '' : 's'}: ${keys.slice(0, 2).join('; ').slice(0, 200)}`, r);
      return { started: null, why: 'the same errors after a merged fix; it is the owner\'s now (Inbox)', escalated: true };
    }
    if (chain.attempts.length >= MAX_ATTEMPTS) {
      await escalate(chain, `${chain.attempts.length} fix attempts were made and the build still fails`, r);
      return { started: null, why: `${chain.attempts.length} fixers already tried this build; it is the owner's now (Inbox)`, escalated: true };
    }
    const { request, title } = await fixRequest(r, sig, chain.attempts.length, d, chain);
    const id = d.start(r.product, request, { title });
    chain.attempts.push({ row: rowId, sha: r.sha ?? null, sig, errors: buildErrors(`${r.fail_log ?? ''}\n${r.detail ?? ''}`).lines.concat(buildErrors(`${r.fail_log ?? ''}\n${r.detail ?? ''}`).lines.length ? [] : [String(r.detail ?? '').slice(0, 400)]), change: id, title, at: Date.now() });
    saveChain(chain);
    return { started: id, why: `started ${id} (attempt ${chain.attempts.length} of ${MAX_ATTEMPTS})` };
  } catch (e: any) {
    console.warn(`[buildfix] ${rowId}: ${e?.message ?? e}`);
    return { started: null, why: `couldn't start a fixer: ${e?.message ?? e}` };
  }
}

/** The fixer's request: the error text, the failing commit, and where the commit came from. Exported for the tests. */
export async function fixRequest(r: any, sig: string, earlier: number, d: Pick<FixDeps, 'culprits'>, chain?: Chain | null): Promise<{ request: string; title: string }> {
  const log = String(r.fail_log ?? '');
  const errors = buildErrors(`${log}\n${r.detail ?? ''}`);
  const sha = r.sha ? String(r.sha).slice(0, 7) : 'unknown';
  let blame = '';
  try {
    const cands = await d.culprits(r.product, r.started ?? Date.now(), errors.files);
    if (cands.length) {
      const { culprit, matched } = pickCulprit(cands, errors.files);
      blame = `\n\nThe failing commit came from a change an agent merged into beta: **${culprit.title}** (${culprit.id}${culprit.task ? `, roadmap task ${culprit.task}` : ''}${culprit.pr_url ? `, ${culprit.pr_url}` : ''})${matched.length ? `, whose diff touches ${matched.join(', ')}, named in the errors` : ' (the latest merged before the build; the errors name no file it touched, so check beta\'s recent commits too)'}. Keep what that change set out to do; fix only what stops the build.`;
    }
  } catch { /* the blame is a help, never a reason not to fix */ }
  const lines = errors.lines.length ? errors.lines.join('\n') : String(r.detail ?? '').slice(0, 1500);
  const tail = log && !errors.lines.length ? `\n\nThe end of the build log:\n\n\`\`\`\n${log.split('\n').slice(-40).join('\n').slice(0, 3000)}\n\`\`\`` : '';
  const history = chain?.attempts.length ? `\n\n## Already tried (${chain.attempts.length} fix attempt${chain.attempts.length === 1 ? '' : 's'} on this build, newest last)\n\n${attemptsText(chain, { full: true })}\n\nRead what those changes did (git log on beta). The errors above are what beta fails with now, after them: a fix that merged may have solved its own errors and exposed these, or missed its own. Do not repeat what failed.` : '';
  const retry = earlier && !history ? `\n\nA fixer already tried this failure (${earlier} time${earlier === 1 ? '' : 's'}): read what it changed (git log on beta) and find what it missed.` : '';
  const request = `Beta's build ${r.build} ${r.version} of ${r.product} failed because of the code (commit ${sha} on beta). Studio built it, the compiler/build command reported:

\`\`\`
${lines.slice(0, 4000)}
\`\`\`${tail}${blame}${history}${retry}

Make beta build again: fix these errors at their cause (for Unity C#, a CS0102 or CS0111 means two definitions of one member or type: find both, keep one, and check the other files of that class, partial classes included). Do not change the build setup or Studio's files. Branch from beta (this branch does) and open a pull request into beta; when it merges, Studio rebuilds this build on beta's head by itself (even when it only builds on a tag). Do not say the build is fixed: you cannot compile it here, and only that rebuild passing proves it. Say what you changed and what you could not check.

<!-- ${fixMarker(sig)} -->`;
  const first = errors.lines[0] ?? String(r.detail ?? '');
  return { request, title: `Fix build: ${first.replace(/^.*?error /, '').slice(0, 90)}` };
}

/**
 * What agents are told to run before opening a pull request, from the project's build (agents.ts brief, step 4): its
 * listed checks are the agent's own; a Unity project also has a compile that only the build server can do, so the agent
 * looks for what the compiler would report, and says in the PR description which it could run and which not.
 */
export function buildCheckBrief(p: { engine?: string; build?: unknown; builds?: { tool?: string; id?: string; command?: string }[] | null; checks?: { cmd: string }[] | null }): string {
  const unity = p.engine === 'unity' || Boolean(p.build) || Boolean(p.builds?.some((b) => b.tool === 'unity'));
  const others = (p.builds ?? []).filter((b) => b.tool !== 'unity' && b.command);
  if (!unity && !others.length) return '';
  const out = [
    `   If ${BETA_RED_FILE} is in your worktree, beta's build was red when Studio last looked: read it first, keep your change from adding to those errors, and say in the PR what you saw.`,
    '   Before the pull request, also run the project\'s build or compile check where you can, and say in the PR description which you ran and which you could not (and why).',
  ];
  if (unity) {
    out.push(
      '   Unity: Studio itself reads every .cs file you changed (syntax errors such as an unterminated string or a backslash before a closing quote, and a member defined twice in a type, partial classes included) before the pull request opens, and sends you back with file and line if it finds any; the full compile runs on the build server, not here. Before you open the PR, read the C# you changed for what it would reject:',
      '   a member or type defined twice (error CS0102/CS0111: the same name in one class, partial classes in other files included; `grep -rn "<Name>" Assets` for every type or method you added or renamed),',
      '   a missing `using`, a call whose signature you changed but not its callers, and any `error CS` text in the brief. If a Unity editor (`unity-editor`/`Unity -batchmode -quit`) is on this machine, compile with it; if not, say "Unity compile not run here" in the PR description.',
    );
  }
  for (const b of others) out.push(`   Build \`${b.id}\`: run \`${b.command}\` if it can run here.`);
  return out.join('\n');
}
