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
import { syncRepo } from './repos.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS scouts (
    id TEXT PRIMARY KEY, product TEXT NOT NULL, question TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, report TEXT,
    origin TEXT, cost REAL DEFAULT 0, created INTEGER NOT NULL, finished INTEGER
  );
`);

export type Scout = { id: string; product: string; question: string; status: string; detail: string | null; report: string | null; origin: string | null; cost: number; created: number; finished: number | null };
export const getScout = (id: string) => (db.prepare('SELECT * FROM scouts WHERE id = ?').get(id) as Scout | undefined) ?? null;
export const listScouts = (limit = 30) => db.prepare('SELECT id, product, question, status, detail, cost, created, finished FROM scouts ORDER BY created DESC LIMIT ?').all(limit) as Scout[];
const set = (id: string, patch: Partial<Scout>) => {
  const cur = getScout(id)!;
  const n = { ...cur, ...patch };
  db.prepare('UPDATE scouts SET status = ?, detail = ?, report = ?, cost = ?, finished = ? WHERE id = ?').run(n.status, n.detail, n.report, n.cost, n.finished, id);
};

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
export type ScoutStream = { result: string; cost: number; ok: boolean; subtype: string; isError: boolean; turns: number; sawResult: boolean; said: string[]; code: number | null; err: string; timedOut: boolean };
export const newScoutStream = (): ScoutStream => ({ result: '', cost: 0, ok: false, subtype: '', isError: false, turns: 0, sawResult: false, said: [], code: null, err: '', timedOut: false });
export function feedScoutLine(st: ScoutStream, m: any, onTool?: (detail: string) => void) {
  if (m?.type === 'assistant') {
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
export function startScout(product: string, question: string, origin: string | null = null, opts: { brief?: string; quiet?: boolean } = {}) {
  if (!question?.trim()) throw new StudioError('Say what to find out');
  if (active >= 2) throw new StudioError('Two scouts are already running; ask again when one reports back.');
  // The harness in use refuses to run (harness-hold.ts): a scout now would only fail. Asked again after the hold.
  if (harnessHeld()) throw new StudioError('The AI harness is on hold (a usage limit or billing): scouts start again once it answers.');
  const inf = isInfra(product) ? getInfra(product) : null;
  const p = inf ? null : getProduct(product);
  const top = inf ? inf.repo : p!.repo.split('/')[0];
  if (!inf && !repoMap()[top]) throw new StudioError(`products.json has no GitHub repo for ${top}`);
  const id = newId('x');
  db.prepare('INSERT INTO scouts (id, product, question, status, detail, origin, created) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, inf?.id ?? p!.id, question.trim().slice(0, 4000), 'running', 'starting', origin, Date.now());
  active++;
  void run(id, top, inf ? 'main' : BETA, opts).finally(() => active--);
  return getScout(id)!;
}

async function run(id: string, top: string, base: string, opts: { brief?: string; quiet?: boolean } = {}) {
  const s = getScout(id)!;
  const repo = path.join(PROJECTS, top);
  const wt = path.join(PROJECTS, '.work', `scout-${id}`);
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
    await gitAsync(repo, ['fetch', '--quiet', 'origin']);
    const ref = git(repo, ['rev-parse', '--verify', `origin/${base}`]).ok ? `origin/${base}` : 'origin/main';
    const w = await addWorktree(repo, wt, ['--detach', wt, ref], gitAsync, { removeLeftover: true, log: (m) => set(id, { detail: m }) });
    if (!w.ok) throw new Error(`worktree: ${w.err || 'git gave no message'} (repo ${repo}, exit ${w.ok ? 0 : 'non-zero'})`);
    await lfsPull(wt);
    set(id, { detail: `reading ${top} (${ref})` });
    const story = isInfra(s.product) ? '' : storyOf(getProduct(s.product), 4000);
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
    const args = ['-p', forOwner(prompt), '--output-format', 'stream-json', '--verbose', ...roleFlags,
      '--mcp-config', (await import('./agents.ts')).agentMcp(id), '--strict-mcp-config'];
    const harness = brainId();
    const r = await new Promise<ScoutStream>((resolve) => {
      const child = spawnClaude(args, { cwd: wt, env: claudeEnv() });
      const st = newScoutStream();
      let buf = '';
      child.stderr.on('data', (d) => (st.err = `${st.err}${d}`.slice(-8000)));
      const timer = setTimeout(() => { st.timedOut = true; child.kill('SIGTERM'); }, SCOUT_WALL_MIN * 60_000);
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          try { feedScoutLine(st, JSON.parse(line), (detail) => set(id, { detail })); } catch { /* not JSON */ }
        }
      });
      child.on('close', (code) => { clearTimeout(timer); st.code = code; resolve(st); });
      child.on('error', (e) => { clearTimeout(timer); st.result = `(couldn't start Claude Code: ${e.message})`; st.ok = false; resolve(st); });
    });
    const full = scoutReport(r);
    const text = full.text;
    // A usage cap, billing or a login error is not a report (it pasted the cap into the next brief as a diagnosis), and
    // the harness is held (harness-hold.ts). Its line stays in the detail, so pm.ts followRescues gives the round back.
    const stop = r.ok && text.length > 400 ? null : harnessStopOf(r.ok ? text : `${r.result.trim()}\n${r.err}`, r.ok ? { kinds: ['usage', 'billing', 'auth'] } : {});
    if (stop && stop.kind !== 'transient') holdHarness(stop, { source: `scout ${id}`, harness });
    const ok = !stop && text.length > 40;
    const detail = stop ? `the harness stopped the scout: ${stop.line.slice(0, 200)}` : ok ? (full.partial ? `partial report: ${scoutWhy(r)}`.slice(0, 400) : 'reported') : `no report: ${scoutWhy(r)}`.slice(0, 400);
    set(id, { status: ok ? 'done' : 'failed', detail, report: ok ? text : null, cost: r.cost, finished: Date.now() });
  } catch (e: any) {
    set(id, { status: 'failed', detail: String(e.message ?? e).slice(0, 600), finished: Date.now() });
  } finally {
    git(repo, ['worktree', 'remove', '--force', wt]);
    fs.rmSync(wt, { recursive: true, force: true });
  }
  const done = getScout(id)!;
  recordRun({ id: `ar_${id.slice(2)}`, kind: 'scout', subject: id, product: done.product, title: `Scout: ${done.question.slice(0, 150)}`, outcome: done.status, summary: done.report ?? done.detail ?? '', by: done.origin ? 'Talk' : 'J', model: process.env.SCOUT_MODEL ?? roleArgs('scout').role.model, cost: done.cost, started: done.created, finished: done.finished ?? Date.now() });
  const text = done.status === 'done'
    ? `Scout ${id} reported on "${done.question}" (${done.product}):\n\n${done.report}\n\nTurn this into a proposal for J: the roadmap item and tasks with acceptance criteria, order, size and rough cost. Add them (studio_roadmap) only after J says yes.`
    : `Scout ${id} on "${done.question}" (${done.product}) failed: ${done.detail}`;
  if (opts.quiet) return;
  const talk: any = await import('./talk.ts');
  if (done.origin && typeof talk.studioSays === 'function' && talk.studioSays(done.origin, text)) return;
  talk.postNotice(`Scout: ${done.question.slice(0, 60)}`, text);
}
