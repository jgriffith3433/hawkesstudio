// Scouts: "what would it take to ...?" answered by reading the code. A scout is Claude Code, headless and read-only,
// in a throwaway worktree of the product's beta (Studio and Gen: main): no edits, no commits, no pull request. It
// writes a short report (what exists, what it would take, a proposed roadmap item with tasks, acceptance criteria,
// order, sizes and rough cost, risks, questions for J), which goes back to the Talk conversation that asked
// (talk.ts studioSays: Claude turns it into a proposal for J). At most 2 run at once.

import { forOwner } from './owner.ts';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { db, newId } from './db.ts';
import { PROJECTS, getProduct, getInfra, isInfra, storyOf, StudioError } from './config.ts';
import { repoMap } from './repos.ts';
import { claudeEnv } from './claude.ts';
import { brainId, harnessStopOf } from './brains.ts';
import { harnessHeld, holdHarness } from './harness-hold.ts';
import { BETA, gitAsync } from './beta.ts';
import { lfsPull } from './lfs.ts';
import { briefSection, recordRun } from './memory.ts';
import { roleArgs } from './roles.ts';
import { spawnClaude } from './sandbox.ts';
import { addWorktree } from './worktree.ts';
import { syncRepo, isUnityProduct } from './repos.ts';
import { readRepoViaApi } from './repo-read.ts';
import { populateSource } from './source-ready.ts';
import { primeRepoToken } from './ghtoken.ts';
import { noteCancel, cancelNote, cancelWords } from './cancel.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS scouts (
    id TEXT PRIMARY KEY, product TEXT NOT NULL, question TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, report TEXT,
    origin TEXT, cost REAL DEFAULT 0, created INTEGER NOT NULL, finished INTEGER
  );
`);
// Later columns (a table made before them gets them added): the Claude session (follow-ups resume it), the turns used so
// far, the last steps (live progress in Activity), and the scout this one re-runs.
for (const col of ['session TEXT', 'turns INTEGER DEFAULT 0', 'log TEXT', 'retry_of TEXT', 'dismissed INTEGER']) {
  try { db.exec(`ALTER TABLE scouts ADD COLUMN ${col}`); } catch { /* already there */ }
}

export type Scout = { id: string; product: string; question: string; status: string; detail: string | null; report: string | null; origin: string | null; cost: number; created: number; finished: number | null; session?: string | null; turns?: number | null; log?: string | null; retry_of?: string | null; dismissed?: number | null };
/** A scout with its log as a list and who cancelled it (the same shape through the API, studio_scout and Activity). */
const view = (x: Scout | undefined) => (x ? { ...x, log: ((): string[] => { try { return JSON.parse(x.log ?? '[]'); } catch { return []; } })(), cancelled: x.status === 'cancelled' ? cancelNote(`scout:${x.id}`) : null, model: process.env.SCOUT_MODEL ?? roleArgs('scout').role.model ?? null } : null);
export const getScout = (id: string) => (db.prepare('SELECT * FROM scouts WHERE id = ?').get(id) as Scout | undefined) ?? null;
export const getScoutView = (id: string) => view(getScout(id)!);
export const listScouts = (limit = 30) => db.prepare('SELECT id, product, question, status, detail, cost, turns, created, finished, retry_of FROM scouts ORDER BY created DESC LIMIT ?').all(limit) as Scout[];

/** Failed scouts older than this drop out of the default Activity list by themselves (still under "Show dismissed"). */
export const FAILED_HIDE_MS = 24 * 3_600_000;
/** Dismissing hides a finished scout from Activity (stored here, so every device agrees; the row, report and cost stay). Never a running one. */
export function dismissScout(id: string, now = Date.now()) {
  const x = getScout(id);
  if (!x) throw new Error(`No such scout ${id}`);
  if (x.status === 'running') throw new Error(`Scout ${id} is still running: cancel it first`);
  db.prepare('UPDATE scouts SET dismissed = ? WHERE id = ?').run(now, id);
  return getScout(id)!;
}
export function restoreScout(id: string) {
  if (!getScout(id)) throw new Error(`No such scout ${id}`);
  db.prepare('UPDATE scouts SET dismissed = NULL WHERE id = ?').run(id);
  return getScout(id)!;
}
/** "Clear failed": dismisses every failed scout not already dismissed. Returns their ids. */
export function clearFailedScouts(now = Date.now()) {
  const ids = (db.prepare("SELECT id FROM scouts WHERE status = 'failed' AND dismissed IS NULL").all() as { id: string }[]).map((r) => r.id);
  db.prepare("UPDATE scouts SET dismissed = ? WHERE status = 'failed' AND dismissed IS NULL").run(now);
  return ids;
}
const set = (id: string, patch: Partial<Scout>) => {
  const cur = getScout(id)!;
  const n = { ...cur, ...patch };
  db.prepare('UPDATE scouts SET status = ?, detail = ?, report = ?, cost = ?, finished = ?, session = ?, turns = ?, log = ? WHERE id = ?').run(n.status, n.detail, n.report, n.cost, n.finished, n.session ?? null, n.turns ?? 0, n.log ?? null, id);
};
/** Running scouts' processes, so Cancel can stop one; `cancelled` marks the ones asked to stop. */
const live = new Map<string, { kill: () => void; st: ScoutStream | null }>();
const cancelled = new Set<string>();

const git = (cwd: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 5 * 60_000 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
};
let active = 0;
/** A scout never runs longer than this: it is stopped and reports what it had written so far (scoutReport). */
export const SCOUT_WALL_MIN = Number(process.env.STUDIO_SCOUT_WALL_MIN) || 15;
// Scouts kept ending in error_max_turns with no report (2026-11-02); this beats Settings' tuning caps (20-40) for scouts.
const SCOUT_MAX_TURNS = 100;

/** What a scout's stream-json output said, line by line (feedScoutLine), so a run that ends without a report still says why. */
export type ScoutStream = { session: string; steps: number; result: string; cost: number; ok: boolean; subtype: string; isError: boolean; turns: number; sawResult: boolean; said: string[]; code: number | null; err: string; timedOut: boolean };
export const newScoutStream = (): ScoutStream => ({ session: '', steps: 0, result: '', cost: 0, ok: false, subtype: '', isError: false, turns: 0, sawResult: false, said: [], code: null, err: '', timedOut: false });
export function feedScoutLine(st: ScoutStream, m: any, onTool?: (detail: string) => void) {
  if (m?.session_id) st.session = String(m.session_id);
  if (m?.type === 'assistant') {
    st.steps++;
    for (const part of m.message?.content ?? []) {
      if (part.type === 'tool_use') onTool?.(`${part.name} ${JSON.stringify(part.input).slice(0, 100)}`);
      else if (part.type === 'text' && String(part.text ?? '').trim()) st.said = [...st.said, String(part.text).trim()].slice(-3);
    }
  }
  if (m?.type === 'result') {
    st.sawResult = true;
    st.result = String(m.result ?? '');
    st.cost = Number(m.total_cost_usd) || 0;
    st.isError = !!m.is_error;
    st.ok = !m.is_error;
    st.subtype = String(m.subtype ?? '');
    st.turns = Number(m.num_turns) || 0;
  }
}
/** Why a scout has no (full) report: the result's subtype, turns, exit code and the end of stderr. */
export function scoutWhy(st: ScoutStream) {
  const parts = st.timedOut ? [`stopped after ${SCOUT_WALL_MIN} min (wall-clock limit)`] : [st.sawResult ? `${st.subtype || 'result'}${st.isError ? ' (is_error)' : ''}${st.turns ? ` after ${st.turns} turns` : ''}` : 'no result message'];
  if (st.code !== null) parts.push(`exit ${st.code}`);
  const tail = st.err.trim().split('\n').slice(-3).join(' | ').slice(-200);
  if (tail) parts.push(`stderr: ${tail}`);
  return parts.join(', ');
}
/** The report, or when the result has no text the scout's last words as a partial one (so the reading isn't thrown away). */
export function scoutReport(st: ScoutStream) {
  const text = st.result.trim();
  if (text.length > 40 && st.ok) return { text, partial: false };
  const said = st.said.join('\n\n').trim();
  if (text.length <= 40 && said.length > 40) return { text: `**Partial report** (the scout stopped early: ${scoutWhy(st)}). This is what it had written so far:\n\n${said}`, partial: true };
  return { text, partial: false };
}

/**
 * Scouts left 'running' by a restart (nothing in this process runs them: x_15ed2881de77 showed 40+ min at $0) are
 * failed with a plain reason, and their scratch worktrees (.work/scout-*) are removed. Run once at start-up.
 */
export function sweepScouts(now = Date.now(), maxMin = SCOUT_WALL_MIN + 5) {
  const stale = db.prepare("SELECT id FROM scouts WHERE status = 'running' AND created < ?").all(now - maxMin * 60_000) as { id: string }[];
  for (const { id } of stale) set(id, { status: 'failed', detail: `lost: still running after ${maxMin} min with nothing working on it (Studio restarted?)`, finished: now });
  const work = path.join(PROJECTS, '.work');
  const running = new Set((db.prepare("SELECT id FROM scouts WHERE status = 'running'").all() as { id: string }[]).map((r) => r.id));
  try {
    for (const d of fs.readdirSync(work)) {
      if (d.startsWith('scout-') && !running.has(d.slice(6))) fs.rmSync(path.join(work, d), { recursive: true, force: true });
    }
  } catch { /* no .work yet */ }
  return stale.map((r) => r.id);
}
try { sweepScouts(); } catch { /* the table or folder isn't there yet */ }

/**
 * opts.brief: the scout's instructions instead of "what would it take" (the PM's diagnosis of a task that failed its
 * tries, pm.ts rescue); opts.quiet: its report is read by the PM (getScout), not posted to Talk.
 */
type ScoutOpts = { brief?: string; quiet?: boolean; retryOf?: string; followUp?: { message: string; prior: string | null; session: string | null } };
export function startScout(product: string, question: string, origin: string | null = null, opts: ScoutOpts = {}) {
  if (!question?.trim()) throw new StudioError('Say what to find out');
  if (active >= 2) throw new StudioError('Two scouts are already running; ask again when one reports back.');
  // The harness in use refuses to run (harness-hold.ts): a scout now would only fail. Asked again after the hold.
  if (harnessHeld()) throw new StudioError('The AI harness is on hold (a usage limit or billing): scouts start again once it answers.');
  const inf = isInfra(product) ? getInfra(product) : null;
  const p = inf ? null : getProduct(product);
  const top = inf ? inf.repo : p!.repo.split('/')[0];
  if (!inf && !repoMap()[top]) throw new StudioError(`products.json has no GitHub repo for ${top}`);
  const id = newId('x');
  db.prepare('INSERT INTO scouts (id, product, question, status, detail, origin, created, retry_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, inf?.id ?? p!.id, question.trim().slice(0, 4000), 'running', 'starting', origin, Date.now(), opts.retryOf ?? null);
  active++;
  void run(id, top, inf ? 'main' : BETA, opts).finally(() => active--);
  return getScoutView(id)!;
}

/** The top-level repo folder and base branch a scout reads (as startScout works them out). */
const baseOf = (product: string) => {
  const inf = isInfra(product) ? getInfra(product) : null;
  return { top: inf ? inf.repo : getProduct(product).repo.split('/')[0], base: inf ? 'main' : BETA };
};

/**
 * Stops a running scout (Activity's Cancel, studio_cancel { kind: "scout" }): the process is killed, what it had written
 * is kept as a partial report, the cost so far is recorded, and the status is `cancelled` (never a failure).
 */
export function cancelScout(id: string, by: string, reason?: string | null) {
  const s = getScout(id);
  if (!s) throw new StudioError(`No such scout ${id}`);
  if (s.status !== 'running') throw new StudioError(`Scout ${id} is ${s.status}, not running`);
  noteCancel(`scout:${id}`, by, reason);
  cancelled.add(id);
  const l = live.get(id);
  if (l) { set(id, { detail: 'cancelling' }); l.kill(); }
  else set(id, { status: 'cancelled', detail: `cancelled ${cancelWords(cancelNote(`scout:${id}`))}`, finished: Date.now() }); // nothing is running it (a restart took it)
  return getScoutView(id)!;
}

/** Runs a finished, failed or cancelled scout's question again: a new scout (x_...) that remembers which it re-runs. */
export function rerunScout(id: string, origin: string | null = null) {
  const s = getScout(id);
  if (!s) throw new StudioError(`No such scout ${id}`);
  if (s.status === 'running') throw new StudioError(`Scout ${id} is still running`);
  return startScout(s.product, s.question, origin ?? s.origin, { retryOf: id });
}

/**
 * A follow-up question to a scout that has stopped: the same session resumes when Claude Code still has it (else a fresh
 * pass is given the question, the earlier report and the follow-up), and the answer is added to the scout's report.
 */
export function followUpScout(id: string, message: string) {
  const s = getScout(id);
  if (!s) throw new StudioError(`No such scout ${id}`);
  if (s.status === 'running') throw new StudioError(`Scout ${id} is still running; follow up when it reports`);
  if (!message?.trim()) throw new StudioError('Say what to ask the scout');
  if (active >= 2) throw new StudioError('Two scouts are already running; ask again when one reports back.');
  if (harnessHeld()) throw new StudioError('The AI harness is on hold (a usage limit or billing): scouts start again once it answers.');
  const { top, base } = baseOf(s.product);
  cancelled.delete(id);
  set(id, { status: 'running', detail: 'following up', finished: null, log: JSON.stringify([`follow-up: ${message.trim().slice(0, 100)}`]) });
  active++;
  void run(id, top, base, { followUp: { message: message.trim().slice(0, 4000), prior: s.report, session: s.session ?? null } }).finally(() => active--);
  return getScoutView(id)!;
}

async function run(id: string, top: string, base: string, opts: ScoutOpts = {}) {
  const s = getScout(id)!;
  const repo = path.join(PROJECTS, top);
  const wt = path.join(PROJECTS, '.work', `scout-${id}`);
  let ref = '';
  try {
    // A clone or worktree that fails (a big Unity repo killed for memory, "could not read Username") falls back to reading
    // GitHub's tarball of the ref (repo-read.ts): no history, no art, but the source a scout needs.
    try {
      // No checkout yet (a fresh server, a repo added since): clone it first instead of failing with git's "not a repository".
      if (!fs.existsSync(path.join(repo, '.git'))) {
        const slug = repoMap()[top];
        if (!slug) throw new Error(`worktree: no checkout of ${top} and products.json has no GitHub repo for it`);
        set(id, { detail: `cloning ${top}` });
        const sync = await syncRepo(top, slug, base);
        if (sync.action === 'failed' || !fs.existsSync(path.join(repo, '.git'))) throw new Error(`worktree: couldn't clone ${top}: ${sync.detail}`);
      }
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      await primeRepoToken(repoMap()[top]);
      const fetched = await gitAsync(repo, ['fetch', '--quiet', 'origin']);
      if (!fetched.ok) throw new Error(`worktree: fetch failed: ${String((fetched as any).err ?? '').split('\n').pop()}`);
      ref = git(repo, ['rev-parse', '--verify', `origin/${base}`]).ok ? `origin/${base}` : 'origin/main';
      const w = await addWorktree(repo, wt, ['--detach', wt, ref], gitAsync, { removeLeftover: true, log: (m) => set(id, { detail: m }) });
      if (!w.ok) throw new Error(`worktree: ${w.err || 'git gave no message'} (repo ${repo}, exit ${w.ok ? 0 : 'non-zero'})`);
      // A light checkout gets its source files checked out here with Studio's token (source-ready.ts); a worktree that
      // still has none is a git failure like the rest: the tarball below gives the scout the source.
      const light = git(wt, ['config', '--get', 'hawkes.light']).out === 'true';
      const unity = (() => { try { return !isInfra(s.product) && isUnityProduct(getProduct(s.product)); } catch { return false; } })();
      if (light || unity) {
        const probe = await populateSource(wt, gitAsync, { unity, log: (m) => set(id, { detail: m }) });
        if (!probe.ok) throw new Error(probe.reason ?? 'source unreadable');
      }
    } catch (gitErr: any) {
      const slug = repoMap()[top];
      if (!slug) throw gitErr;
      set(id, { detail: `git couldn't give the source (${String(gitErr.message ?? gitErr).slice(0, 120)}); reading it through GitHub's API` });
      try {
        const branch = base || 'main';
        const got = await readRepoViaApi(slug, branch, wt).catch(() => readRepoViaApi(slug, 'main', wt));
        ref = `${got.ref} (read through GitHub's API: ${got.files} files, no history)`;
      } catch (apiErr: any) {
        throw new Error(`${gitErr.message ?? gitErr}; reading through GitHub's API failed too: ${apiErr.message ?? apiErr}`);
      }
    }
    if (fs.existsSync(path.join(wt, '.git'))) await lfsPull(wt);
    set(id, { detail: `reading ${top} (${ref})` });
    const story = isInfra(s.product) ? '' : storyOf(getProduct(s.product), 4000);
    const follow = opts.followUp;
    const mem = briefSection({ product: s.product, role: 'scout', text: s.question });
    const prompt = opts.brief ? `${opts.brief}\n\nYou are reading ${top} at ${ref} (read AGENTS.md first). You can't change anything: don't edit, don't commit.${mem.text ? `\n\n${mem.text}` : ''}` : `You are a scout for Hawkes Studio. J asked: "${s.question}"

Find out what it would take, by reading this repository (${top}, at ${ref}; read AGENTS.md first). You can't change
anything: don't edit, don't commit. Be concrete and short. Once you have read about 25 files, stop reading and write
the report; if the question has numbered parts, answer each one briefly. Reply with a Markdown report:

## What's there now
(the relevant code, data and systems, with file paths)
## What it would take
(the pieces of work, in order; what's hard or risky)
## Proposed roadmap item
- Title, goal (one line), why (one line), size S/M/L
- Acceptance criteria J could check by playing it (3-6, each observable in a playtest)
- Tasks, in order: each one agent change (one pull request), with its request in plain words, its own acceptance
  criteria, and what it depends on
- Rough cost: agent runs (each about one Claude Code session), Unity builds (about $0.10 each), any generated assets
  or GPU time (about $1.86/hr), and how long
## Questions for J
(only real direction choices; with the option you'd pick)
${mem.text ? `\n${mem.text}` : ''}${story ? `\nThe product's story, for tone:\n${story}\n` : ''}`;
    // The scout role (.claude/agents/scout.md): model, read-only tools, turn limit; SCOUT_MODEL still overrides the model.
    const { args: roleFlags } = roleArgs('scout', { maxTurns: SCOUT_MAX_TURNS, extraAllowed: ['mcp__hawkesstudio__memory_search', 'mcp__hawkesstudio__memory_get', 'mcp__hawkesstudio__memory_write', 'mcp__hawkesstudio__studio_analytics'] });
    if (process.env.SCOUT_MODEL) roleFlags.splice(roleFlags.indexOf('--model') + 1, 1, process.env.SCOUT_MODEL);
    const harness = brainId();
    const agentMcpFile = (await import('./agents.ts')).agentMcp(id);
    const follow2 = follow ? { ...follow, resume: Boolean(follow.session) } : null;
    // A follow-up resumes the scout's session; with none (or when Claude Code no longer has it) a fresh pass is told what was found.
    const freshPrompt = follow ? `${prompt}\n\nYour earlier report:\n${follow.prior ?? '(none)'}\n\nJ's follow-up question (answer just this, briefly, reading what you need): ${follow.message}` : prompt;
    const attempt = (resumeId: string | null) => new Promise<ScoutStream>((resolve) => {
      const args = ['-p', forOwner(resumeId ? follow!.message : freshPrompt), ...(resumeId ? ['--resume', resumeId] : []), '--output-format', 'stream-json', '--verbose', ...roleFlags,
        '--mcp-config', agentMcpFile, '--strict-mcp-config'];
      const child = spawnClaude(args, { cwd: wt, env: claudeEnv() });
      const st = newScoutStream();
      let buf = '';
      const logTool = (detail: string) => {
        const cur = getScout(id);
        let l: string[] = [];
        try { l = JSON.parse(cur?.log ?? '[]'); } catch { /* none */ }
        set(id, { detail, turns: st.steps, session: st.session || cur?.session || null, log: JSON.stringify([...l, detail].slice(-12)) });
      };
      live.set(id, { kill: () => { child.kill('SIGTERM'); }, st });
      child.stderr.on('data', (d) => (st.err = `${st.err}${d}`.slice(-8000)));
      const timer = setTimeout(() => { st.timedOut = true; child.kill('SIGTERM'); }, SCOUT_WALL_MIN * 60_000);
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          try { feedScoutLine(st, JSON.parse(line), logTool); } catch { /* not JSON */ }
        }
      });
      child.on('close', (code) => { clearTimeout(timer); st.code = code; resolve(st); });
      child.on('error', (e) => { clearTimeout(timer); st.result = `(couldn't start Claude Code: ${e.message})`; st.ok = false; resolve(st); });
    });
    if (cancelled.has(id)) throw new Error('cancelled');
    let r = await attempt(follow2?.resume ? follow2.session : null);
    if (follow2?.resume && !r.sawResult && !cancelled.has(id) && /no conversation found/i.test(r.err)) r = await attempt(null);
    set(id, { turns: r.steps, session: r.session || getScout(id)?.session || null });
    const full = scoutReport(r);
    const text = full.text;
    // A usage cap, billing or a login error is not a report (it pasted the cap into the next brief as a diagnosis), and
    // the harness is held (harness-hold.ts). Its line stays in the detail, so pm.ts followRescues gives the round back.
    const stop = r.ok && text.length > 400 ? null : harnessStopOf(r.ok ? text : `${r.result.trim()}\n${r.err}`, r.ok ? { kinds: ['usage', 'billing', 'auth'] } : {});
    if (stop && stop.kind !== 'transient' && !cancelled.has(id)) holdHarness(stop, { source: `scout ${id}`, harness });
    const ok = !stop && text.length > 40;
    if (cancelled.has(id)) {
      // Stopped on purpose: keep what it had written as a partial report and what it cost so far; nothing is blamed.
      const said = r.said.join('\n\n').trim();
      const kept = r.ok && text.length > 40 ? text : said.length > 40 ? `**Partial report** (cancelled ${cancelWords(cancelNote(`scout:${id}`))}). This is what the scout had written so far:\n\n${said}` : null;
      const prior = follow?.prior ? `${follow.prior}\n\n---\n` : '';
      set(id, { status: 'cancelled', detail: `cancelled ${cancelWords(cancelNote(`scout:${id}`))}${kept ? ' (partial report kept)' : ''}`, report: kept ? `${prior}${kept}` : follow?.prior ?? null, cost: (follow ? getScout(id)?.cost ?? 0 : 0) + r.cost, finished: Date.now() });
    } else {
      const detail = stop ? `the harness stopped the scout: ${stop.line.slice(0, 200)}` : ok ? (full.partial ? `partial report: ${scoutWhy(r)}`.slice(0, 400) : 'reported') : `no report: ${scoutWhy(r)}`.slice(0, 400);
      const reportOut = ok ? (follow?.prior ? `${follow.prior}\n\n---\n**Follow-up: ${follow.message.slice(0, 200)}**\n\n${text}` : text) : follow?.prior ?? null;
      set(id, { status: ok ? 'done' : 'failed', detail, report: reportOut, cost: (follow ? getScout(id)?.cost ?? 0 : 0) + r.cost, finished: Date.now() });
    }
  } catch (e: any) {
    if (cancelled.has(id)) set(id, { status: 'cancelled', detail: `cancelled ${cancelWords(cancelNote(`scout:${id}`))}`, finished: Date.now() });
    else set(id, { status: 'failed', detail: String(e.message ?? e).slice(0, 600), finished: Date.now() });
  } finally {
    live.delete(id);
    git(repo, ['worktree', 'remove', '--force', wt]);
    fs.rmSync(wt, { recursive: true, force: true });
  }
  const done = getScout(id)!;
  recordRun({ id: `ar_${id.slice(2)}`, kind: 'scout', subject: id, product: done.product, title: `Scout: ${done.question.slice(0, 150)}`, outcome: done.status, summary: done.report ?? done.detail ?? '', by: done.origin ? 'Talk' : 'J', model: process.env.SCOUT_MODEL ?? roleArgs('scout').role.model, cost: done.cost, started: done.created, finished: done.finished ?? Date.now() });
  const text = done.status === 'done'
    ? `Scout ${id} reported on "${done.question}" (${done.product}):\n\n${done.report}\n\nTurn this into a proposal for J: the roadmap item and tasks with acceptance criteria, order, size and rough cost. Add them (studio_roadmap) only after J says yes.`
    : done.status === 'cancelled' ? `Scout ${id} on "${done.question}" (${done.product}) was ${done.detail}. It is not a failure; re-run it (studio_cancel { kind: "scout", id: "${id}", resume: true }, a new scout) or ask a follow-up (studio_scout { id, message }) if it's still wanted.${done.report ? `\n\nWhat it had:\n${done.report}` : ''}`
    : `Scout ${id} on "${done.question}" (${done.product}) failed: ${done.detail}`;
  if (opts.quiet) return;
  const talk: any = await import('./talk.ts');
  if (done.origin && typeof talk.studioSays === 'function' && talk.studioSays(done.origin, text)) return;
  talk.postNotice(`Scout: ${done.question.slice(0, 60)}`, text);
}
