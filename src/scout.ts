// Scouts: "what would it take to ...?" answered by reading the code. A scout is Claude Code, headless and read-only,
// in a throwaway worktree of the product's beta (Studio and Gen: main): no edits, no commits, no pull request. It
// writes a short report (what exists, what it would take, a proposed roadmap item with tasks, acceptance criteria,
// order, sizes and rough cost, risks, questions for J), which goes back to the Talk conversation that asked
// (talk.ts studioSays: Claude turns it into a proposal for J). At most 2 run at once.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { db, newId } from './db.ts';
import { PROJECTS, getProduct, getInfra, isInfra, storyOf, StudioError } from './config.ts';
import { repoMap } from './repos.ts';
import { claudeEnv } from './claude.ts';
import { BETA } from './beta.ts';
import { briefSection, recordRun } from './memory.ts';

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

export function startScout(product: string, question: string, origin: string | null = null) {
  if (!question?.trim()) throw new StudioError('Say what to find out');
  if (active >= 2) throw new StudioError('Two scouts are already running; ask again when one reports back.');
  const inf = isInfra(product) ? getInfra(product) : null;
  const p = inf ? null : getProduct(product);
  const top = inf ? inf.repo : p!.repo.split('/')[0];
  if (!inf && !repoMap()[top]) throw new StudioError(`products.json has no GitHub repo for ${top}`);
  const id = newId('x');
  db.prepare('INSERT INTO scouts (id, product, question, status, detail, origin, created) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, inf?.id ?? p!.id, question.trim().slice(0, 4000), 'running', 'starting', origin, Date.now());
  active++;
  void run(id, top, inf ? 'main' : BETA).finally(() => active--);
  return getScout(id)!;
}

async function run(id: string, top: string, base: string) {
  const s = getScout(id)!;
  const repo = path.join(PROJECTS, top);
  const wt = path.join(PROJECTS, '.work', `scout-${id}`);
  try {
    git(repo, ['fetch', '--quiet', 'origin']);
    const ref = git(repo, ['rev-parse', '--verify', `origin/${base}`]).ok ? `origin/${base}` : 'origin/main';
    const w = git(repo, ['worktree', 'add', '--detach', wt, ref]);
    if (!w.ok) throw new Error(`worktree: ${w.err}`);
    set(id, { detail: `reading ${top} (${ref})` });
    const story = isInfra(s.product) ? '' : storyOf(getProduct(s.product), 4000);
    const mem = briefSection({ product: s.product, role: 'scout', text: s.question });
    const prompt = `You are a scout for Hawkes Studio. J asked: "${s.question}"

Find out what it would take, by reading this repository (${top}, at ${ref}; read AGENTS.md first). You can't change
anything: don't edit, don't commit. Be concrete and short. Reply with a Markdown report:

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
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', process.env.SCOUT_MODEL ?? 'claude-opus-5-5', '--max-turns', '40',
      '--allowedTools', 'Read,Glob,Grep,Bash(git log:*),Bash(git show:*),Bash(ls:*),mcp__hawkesstudio__memory_search,mcp__hawkesstudio__memory_get,mcp__hawkesstudio__memory_write',
      '--mcp-config', (await import('./agents.ts')).agentMcp(id), '--strict-mcp-config', '--disallowedTools', 'Edit,Write,NotebookEdit,WebFetch,WebSearch'];
    const r = await new Promise<{ result: string; cost: number }>((resolve) => {
      const child = spawn(process.env.TALK_CLAUDE || 'claude', args, { cwd: wt, env: claudeEnv(), windowsHide: true });
      let buf = '';
      let result = '';
      let cost = 0;
      const timer = setTimeout(() => child.kill('SIGTERM'), 30 * 60_000);
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          try {
            const m = JSON.parse(line);
            if (m.type === 'assistant') for (const part of m.message?.content ?? []) if (part.type === 'tool_use') set(id, { detail: `${part.name} ${JSON.stringify(part.input).slice(0, 100)}` });
            if (m.type === 'result') { result = String(m.result ?? ''); cost = Number(m.total_cost_usd) || 0; }
          } catch { /* not JSON */ }
        }
      });
      child.on('close', () => { clearTimeout(timer); resolve({ result, cost }); });
      child.on('error', (e) => { clearTimeout(timer); resolve({ result: `(couldn't start Claude Code: ${e.message})`, cost: 0 }); });
    });
    const ok = r.result.trim().length > 40;
    set(id, { status: ok ? 'done' : 'failed', detail: ok ? 'reported' : 'no report', report: r.result.trim() || null, cost: r.cost, finished: Date.now() });
  } catch (e: any) {
    set(id, { status: 'failed', detail: String(e.message ?? e).slice(0, 300), finished: Date.now() });
  } finally {
    git(repo, ['worktree', 'remove', '--force', wt]);
    fs.rmSync(wt, { recursive: true, force: true });
  }
  const done = getScout(id)!;
  recordRun({ id: `ar_${id.slice(2)}`, kind: 'scout', subject: id, product: done.product, title: `Scout: ${done.question.slice(0, 150)}`, outcome: done.status, summary: done.report ?? done.detail ?? '', by: done.origin ? 'Talk' : 'J', model: process.env.SCOUT_MODEL ?? 'claude-opus-5-5', cost: done.cost, started: done.created, finished: done.finished ?? Date.now() });
  const text = done.status === 'done'
    ? `Scout ${id} reported on "${done.question}" (${done.product}):\n\n${done.report}\n\nTurn this into a proposal for J: the roadmap item and tasks with acceptance criteria, order, size and rough cost. Add them (studio_roadmap) only after J says yes.`
    : `Scout ${id} on "${done.question}" (${done.product}) failed: ${done.detail}`;
  const talk: any = await import('./talk.ts');
  if (done.origin && typeof talk.studioSays === 'function' && talk.studioSays(done.origin, text)) return;
  talk.postNotice(`Scout: ${done.question.slice(0, 60)}`, text);
}
