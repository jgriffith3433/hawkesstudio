// Agent workers: a finding becomes a pull request.
//
//   startFix(product, findings)  ->  a "change":
//     1. a git worktree on a new branch fix/<change> from origin's beta branch (beta.ts; made from main when missing;
//        J's checkout is never touched)
//     2. the brief: the findings (with their screenshots from Hawkes Gen), the story doc, the project's checks
//     3. Claude Code, headless, in the worktree: reads AGENTS.md, fixes, runs the checks, commits
//     4. Studio pushes the branch and opens a pull request into beta (GitHub API, the hawkes/github token)
//     5. verify: web products are served from the worktree, Unity ones are built on the build server into a website
//        copy (.work/<change>-site); then the finding's scenario is playtested and reviewed
//   approve(change)   -> merges the pull request into beta (nothing goes live): the beta site and its playtest follow,
//                        the findings are marked fixed. J's call only (the dashboard button, or confirm "MERGE <id>").
//                        Going live is a separate step (deploy.ts: the deploy plan, then "DEPLOY <product>").
//   revise(change, note) -> the agent continues on the same branch with J's note; the PR updates.
//
// Hawkes Studio and Hawkes Gen themselves (products.json "infra") take requests too (startTask), but they have no beta
// lane: main is what runs on the control server. Their changes are a worktree of /srv/hawkes/<repo> on task/<id> cut
// from main, npm ci, the agent (typecheck and tests against the running Gen), guard rails (protected files), a pull
// request into main, then verifyInfra: CI on the pull request, the checks again, and a smoke check of the changed
// service on a spare port. Approving merges into main; CI on main tells the server and it deploys itself
// (deploy/hawkes-pull.mjs: waits for runs, agents and Talk answers; rolls back if unhealthy).
//
// Runs on the server (STUDIO_SERVER=1, repos cloned by repos.ts, GITHUB_TOKEN from /run/hawkes/github.env).
// Caps (settings.agents): how many fixes run at once and per day, and a daily cost limit.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { db, newId, J, parse } from './db.ts';
import { getProduct, getInfra, isInfra, PROJECTS, DATA, storyOf, localUrl, type Product, type Infra } from './config.ts';
import { getFinding, updateFinding } from './backlog.ts';
import { reviewParams } from './review.ts';
import { gen, genRun } from './gen.ts';
import { repoMap } from './repos.ts';
import { serveDir, stopServed } from './local.ts';
import { claudeEnv } from './claude.ts';
import { buildPreview, removePreview, previewUrl, changeSiteDir, changeBuild, type ChangeBuild } from './previews.ts';
import { BETA, ensureBeta } from './beta.ts';
import { notify, notifyOnce, PUBLIC_URL } from './notify.ts';
import { threadFor } from './roadmap.ts';
import { judgeCriteria } from './acceptance.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS changes (
    id TEXT PRIMARY KEY, product TEXT NOT NULL, findings TEXT NOT NULL, status TEXT NOT NULL, detail TEXT,
    repo TEXT, slug TEXT, branch TEXT, base TEXT, worktree TEXT, pr INTEGER, pr_url TEXT, title TEXT, summary TEXT,
    commits TEXT, diffstat TEXT, verify TEXT, notes TEXT, log TEXT, cost REAL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER
  );
`);
// J's own requests (not findings) are changes too.
try { db.exec('ALTER TABLE changes ADD COLUMN request TEXT'); } catch { /* already there */ }
// The Talk conversation that started it (results report there, followup.ts), whether it was told, and who started it.
for (const col of ['origin', 'told', 'started_by']) try { db.exec(`ALTER TABLE changes ADD COLUMN ${col} TEXT`); } catch { /* already there */ }
// A roadmap task's change (roadmap.ts): the task, its acceptance criteria, the agent's session (to resume after a question), what the PM saw.
for (const col of ['task', 'criteria', 'session', 'pm_seen']) try { db.exec(`ALTER TABLE changes ADD COLUMN ${col} TEXT`); } catch { /* already there */ }

export type Change = {
  id: string; product: string; findings: string[]; status: string; detail: string | null; repo: string; slug: string; branch: string; base: string;
  worktree: string; request: string | null; pr: number | null; pr_url: string | null; title: string | null; summary: string | null; commits: string[]; diffstat: string | null;
  verify: any; notes: { at: number; by: string; text: string }[]; log: string[]; cost: number; created: number; updated: number | null;
  /** The roadmap task it works on (roadmap.ts), its acceptance criteria, and the agent's Claude Code session (to resume after a question). */
  task: string | null; criteria: string[]; session: string | null;
  /** A change to Hawkes Studio or Hawkes Gen (a pull request into main, which deploys itself), not a product. */
  infra: boolean;
};

const SETTINGS_FILE = path.join(DATA, 'agents.json');
export type AgentSettings = { enabled: boolean; autoFix: boolean; maxConcurrent: number; maxPerDay: number; maxCostPerDay: number; severities: string[]; model: string; maxTurns: number };
const DEFAULTS: AgentSettings = { enabled: true, autoFix: true, maxConcurrent: 2, maxPerDay: 4, maxCostPerDay: 20, severities: ['blocker', 'bug'], model: 'claude-opus-5-5', maxTurns: 80 };
export function agentSettings(): AgentSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return DEFAULTS;
  }
}
export function saveAgentSettings(patch: Partial<AgentSettings>) {
  const next = { ...agentSettings(), ...patch };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

const toChange = (r: any): Change => ({ ...r, infra: isInfra(r.product), criteria: parse(r.criteria) ?? [], findings: parse(r.findings) ?? [], commits: parse(r.commits) ?? [], verify: parse(r.verify), notes: parse(r.notes) ?? [], log: parse(r.log) ?? [] });
export const getChange = (id: string) => {
  const r = db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
  return r ? toChange(r) : null;
};
export function listChanges(q: { status?: string; product?: string; limit?: number } = {}) {
  const where: string[] = [];
  const args: any[] = [];
  if (q.status) { where.push(`status IN (${q.status.split(',').map(() => '?').join(',')})`); args.push(...q.status.split(',')); }
  if (q.product) { where.push('product = ?'); args.push(q.product); }
  return (db.prepare(`SELECT * FROM changes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created DESC LIMIT ?`).all(...args, q.limit ?? 100) as any[]).map(toChange);
}
function update(id: string, patch: Partial<Record<string, any>>) {
  const cur = db.prepare('SELECT * FROM changes WHERE id = ?').get(id) as any;
  const next: any = { ...cur, ...patch, updated: Date.now() };
  for (const k of ['findings', 'commits', 'verify', 'notes', 'log']) if (patch[k] !== undefined) next[k] = J(patch[k]);
  db.prepare(`UPDATE changes SET status=?, detail=?, pr=?, pr_url=?, title=?, summary=?, commits=?, diffstat=?, verify=?, notes=?, log=?, cost=?, session=?, updated=? WHERE id=?`)
    .run(next.status, next.detail, next.pr, next.pr_url, next.title, next.summary, next.commits, next.diffstat, next.verify, next.notes, next.log, next.cost, next.session ?? null, next.updated, id);
}
function addLog(id: string, line: string) {
  const c = getChange(id)!;
  const log = [...c.log, `${new Date().toISOString().slice(11, 19)} ${line}`].slice(-400);
  update(id, { log });
}

// ------------------------------------------------------------------- git

function git(cwd: string, args: string[], timeoutMs = 10 * 60_000) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? r.error?.message ?? '').trim() };
}

/** The repo a product's fixes go to (its source repo), its folder and GitHub slug. */
function repoFor(p: Product) {
  const top = p.repo.split('/')[0];
  const slug = repoMap()[top];
  if (!slug) throw new Error(`products.json has no GitHub repo for ${top}`);
  return { top, slug, sub: p.repo.split('/').slice(1).join('/') };
}

const WORK = () => path.join(PROJECTS, '.work');

// --------------------------------------------------------------- GitHub

async function github(route: string, init: { method?: string; body?: unknown } = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('No GitHub token on the server yet (node deploy/github-token.mjs, then restart hawkes-secrets and hawkes-studio).');
  const r = await fetch(`https://api.github.com${route}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'hawkes-studio', 'X-GitHub-Api-Version': '2022-11-28', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${route}: ${r.status} ${data.message ?? ''}`);
  return data;
}

// ----------------------------------------------------------------- brief

async function writeBrief(c: Change, p: Product, findings: any[], note?: string) {
  const dir = path.join(c.worktree, '.hawkes');
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  // Keep the brief out of commits.
  const exclude = path.join(PROJECTS, repoFor(p).top, '.git', 'info', 'exclude');
  if (!fs.existsSync(exclude) || !fs.readFileSync(exclude, 'utf8').includes('.hawkes/')) fs.appendFileSync(exclude, '\n.hawkes/\n');
  const shots: string[] = [];
  for (const f of findings) {
    for (const [i, a] of (f.shots ?? []).slice(0, 4).entries()) {
      const file = path.join(dir, 'shots', `${f.id}-${i + 1}.jpg`);
      try {
        await gen.download(a, file);
        shots.push(path.relative(c.worktree, file).replace(/\\/g, '/'));
      } catch {
        // A missing screenshot just isn't included.
      }
    }
  }
  const thread = threadFor(c);
  const checks = (p.checks ?? []).map((k) => `- \`${k.cmd}\` (in ${k.dir === p.repo ? 'the repo root' : k.dir})`).join('\n') || '- (none listed: at least make sure it builds or loads)';
  const sub = repoFor(p).sub;
  const brief = `# ${c.request ? 'Work' : 'Fix'} for ${p.name}

You are fixing a problem Hawkes Studio's automated playtest found in ${p.name} (${p.about}).
${sub ? `The project lives in \`${sub}/\` inside this repository.` : ''}

${c.request ? `## What J asked for

${c.request}

Work out what that means in this project (read the story doc and AGENTS.md), make it well, and keep it consistent with
the product's tone and style. If it's too big for one change, do a solid first part and say what's left in the summary.

` : ''}${c.criteria.length ? `## Acceptance criteria (how this is judged)

The change is merged into beta only when a playtest of it shows every one of these, and it is done only when they also
pass on beta:
${c.criteria.map((k, i) => `${i + 1}. ${k}`).join('\n')}

Where the game implements the playtest contract (\`window.hawkesPlaytest\`: see this project's AGENTS.md, and the spec
at \`hawkesstudio/docs/playtest.md\` next to this repository), add or extend a scenario that plays to what the criteria
describe (through real input, no teleporting; named setup shortcuts are fine) and logs events or checks that show each
one, so the review can judge them from the footage and the timeline. Write that scenario's name (one line, e.g.
\`checkout\`) in \`.hawkes/scenario.txt\`: Studio's verification playtest, and beta's, play it. Without a contract, make
sure each criterion can be seen when the page is played.

` : ''}${thread.length ? `## The thread (J, Talk and agents on this work; newest last)

${thread.map((m) => `- ${m.by}${m.kind !== 'comment' ? ` (${m.kind})` : ''}, ${new Date(m.at).toISOString().slice(0, 16).replace('T', ' ')}: ${m.text}`).join('\n')}

Follow what J said there; where it differs from the request, J's latest word wins.

` : ''}${findings.length ? `## The finding${findings.length > 1 ? 's' : ''}` : ''}

${findings.map((f) => `### [${f.severity}] ${f.title}
- Area: ${f.area ?? '-'} · scenario: ${f.scenario ?? '-'} · seen ${f.seen} time(s)
- What's wrong: ${f.detail ?? '-'}
- Suggested fix: ${f.fix ?? '-'}
- Screenshots: ${(shots.filter((s) => s.includes(f.id)).map((s) => `\`${s}\``).join(', ')) || 'none'}`).join('\n\n')}
${note ? `\n## Notes on the last attempt (J's or the PM's)\n\n${note}\n` : ''}
## How to work

1. Read \`AGENTS.md\` (and any docs it points to) before changing anything. Follow its rules.
2. Look at the screenshots to see the problem. Find the cause in the code or data; prefer the smallest correct fix.
3. Keep to this finding. Don't refactor unrelated code, don't touch generated output or build folders, don't change
   secrets, CI, or deploy scripts.
4. Run the project's checks:
${checks}
5. Commit your change with a clear message (\`Fix: ...\`). Don't push; Studio does.
6. Write \`.hawkes/summary.md\`: what was wrong, what you changed (files), how you checked it, and anything J should
   look at. If you couldn't fix it, explain why there instead, and don't commit.
7. Write \`.hawkes/try.md\`: how J tries it on the beta site, in two to five short steps a player would follow (where to
   go, what to press, what he should see).
8. If you can't go on without a decision that the request, the criteria and the thread don't settle (a real direction
   choice, not a detail you can decide well yourself), write ONE clear question to \`.hawkes/question.md\` (the options
   you see and the one you'd pick), commit nothing, and stop. Studio gets you the answer and you continue in this same
   session.

## The product's story (for tone and intent)

${storyOf(p, 6000)}
`;
  fs.writeFileSync(path.join(dir, 'brief.md'), brief);
  return path.join(dir, 'brief.md');
}

// ------------------------------------------------------------------ agent

function runAgent(c: Change, briefFile: string, s: AgentSettings, env = claudeEnv(), resume?: { session: string; prompt: string }): Promise<{ ok: boolean; cost: number; result: string }> {
  return new Promise((resolve) => {
    const prompt = resume?.prompt ?? `Read ${path.relative(c.worktree, briefFile).replace(/\\/g, '/')} and do what it says. It's your whole task.`;
    const args = [
      ...(resume ? ['--resume', resume.session] : []),
      '-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', s.model, '--max-turns', String(s.maxTurns),
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read,Edit,Write,Glob,Grep,TodoWrite,Bash(git status:*),Bash(git diff:*),Bash(git add:*),Bash(git commit:*),Bash(git log:*),Bash(npm:*),Bash(npx:*),Bash(node:*),Bash(ls:*),Bash(cat:*)',
    ];
    const child = spawn('claude', args, { cwd: c.worktree, env, windowsHide: true });
    let buf = '';
    let cost = 0;
    let result = '';
    let ok = false;
    const timer = setTimeout(() => child.kill('SIGTERM'), 60 * 60_000);
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          // Its session id, so a question can be answered in the same session (claude --resume).
          if (m.type === 'system' && m.session_id && getChange(c.id)?.session !== m.session_id) update(c.id, { session: m.session_id });
          if (m.type === 'assistant') {
            for (const part of m.message?.content ?? []) {
              if (part.type === 'text' && part.text.trim()) addLog(c.id, `agent: ${part.text.trim().slice(0, 300)}`);
              if (part.type === 'tool_use') addLog(c.id, `tool: ${part.name} ${JSON.stringify(part.input).slice(0, 160)}`);
            }
          }
          if (m.type === 'result') {
            cost = Number(m.total_cost_usd) || 0;
            result = String(m.result ?? '');
            ok = !m.is_error;
          }
        } catch {
          // Not JSON.
        }
      }
    });
    child.stderr.on('data', (d) => addLog(c.id, `stderr: ${String(d).slice(0, 300)}`));
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ ok, cost, result });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      addLog(c.id, `couldn't start Claude Code: ${e.message}`);
      resolve({ ok: false, cost: 0, result: e.message });
    });
  });
}

// ------------------------------------------------------------------ flow

const running = new Set<string>();

export function costToday() {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const r = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(cost), 0) AS cost FROM changes WHERE created >= ?').get(since.getTime()) as any;
  return { count: r.n as number, cost: r.cost as number };
}

/** Starts an agent on something J asked for (a feature, a change, a tweak): a branch, a pull request, a preview. */
export function startTask(productId: string, request: string, { criteria = [], task = null, title }: { criteria?: string[]; task?: string | null; title?: string } = {}) {
  const s = agentSettings();
  if (!s.enabled) throw new Error('Agent workers are turned off (settings).');
  // Studio and Gen themselves: a pull request into main (they have no beta lane).
  const inf = isInfra(productId) ? getInfra(productId) : null;
  const p = inf ? null : getProduct(productId);
  const target = inf ?? p!;
  if (!request.trim()) throw new Error('Say what to do');
  const busy = listChanges({ status: 'working,verifying,revising', product: target.id });
  if (busy.length) throw new Error(`${target.name} already has an agent working (${busy[0].id}); it can take the next one when that finishes.`);
  const { top, slug } = inf ? { top: inf.repo, slug: inf.slug } : repoFor(p!);
  const id = newId('c');
  const words = request.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-|-$/g, '');
  db.prepare('INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, title, request, notes, log, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, target.id, '[]', 'queued', task ? 'queued by the PM (a roadmap task)' : 'queued (J asked)', top, slug, `task/${id.slice(2)}-${words}`, inf ? 'main' : BETA, path.join(WORK(), id), (title ?? request.split(String.fromCharCode(10))[0]).slice(0, 120), request, '[]', '[]', Date.now());
  db.prepare('UPDATE changes SET task = ?, criteria = ? WHERE id = ?').run(task, J(criteria), id);
  void pump();
  return id;
}

/** Starts a fix for one or more findings of a product. Returns the change id; the work continues in the background. */
export function startFix(productId: string, findingIds: string[], { auto = false } = {}) {
  const s = agentSettings();
  if (!s.enabled) throw new Error('Agent workers are turned off (settings).');
  if (isInfra(productId)) throw new Error(`${getInfra(productId).name} has no playtest findings: ask for the change with studio_task.`);
  const p = getProduct(productId);
  const findings = findingIds.map((id) => getFinding(id)).filter(Boolean) as any[];
  if (!findings.length) throw new Error('No such findings');
  const busy = listChanges({ status: 'working,verifying,revising', product: p.id });
  if (busy.length) throw new Error(`${p.name} already has a fix in progress (${busy[0].id}).`);
  const today = costToday();
  if (auto && (today.count >= s.maxPerDay || today.cost >= s.maxCostPerDay)) {
    throw new Error(`Today's agent budget is used (${today.count} fixes, $${today.cost.toFixed(2)}).`);
  }
  const { top, slug } = repoFor(p);
  const id = newId('c');
  const branch = `fix/${id.slice(2)}-${findings[0].title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/-$/, '')}`;
  db.prepare('INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, title, notes, log, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, p.id, J(findings.map((f) => f.id)), 'queued', auto ? 'queued by the daily run' : 'queued', top, slug, branch, BETA, path.join(WORK(), id), `Fix: ${findings[0].title}`.slice(0, 120), '[]', '[]', Date.now());
  if (auto) db.prepare('UPDATE changes SET started_by = ? WHERE id = ?').run('the daily run', id);
  for (const f of findings) updateFinding(f.id, { status: 'fixing', note: `agent change ${id}` });
  void pump();
  return id;
}

/** Runs queued changes up to the concurrency limit. */
async function pump() {
  const s = agentSettings();
  for (const c of listChanges({ status: 'queued' }).reverse()) {
    if (running.size >= s.maxConcurrent) return;
    if (running.has(c.id)) continue;
    running.add(c.id);
    void work(c.id).finally(() => {
      running.delete(c.id);
      void pump();
    });
  }
}

async function work(id: string, note?: string, answer?: string) {
  if (getChange(id)!.infra) return workInfra(id, note);
  let c = getChange(id)!;
  const p = getProduct(c.product);
  const s = agentSettings();
  const repoDir = path.join(PROJECTS, c.repo);
  try {
    update(id, { status: note || answer ? 'revising' : 'working', detail: 'preparing the worktree' });
    if (!fs.existsSync(c.worktree)) {
      fs.mkdirSync(WORK(), { recursive: true });
      // Agent branches start from beta (made from main the first time: pushing beta deploys nothing).
      const beta = ensureBeta(repoDir);
      if (beta.created) addLog(id, `made the ${BETA} branch from main (${beta.sha.slice(0, 7)})`);
      // Devtools saves still waiting in beta's working copy go to beta first, so the agent starts from them.
      const flushed = await import('./dev.ts').then(({ flushDev }) => flushDev(c.product, `before agent change ${id} started`)).catch((e) => ({ error: String(e.message ?? e) }));
      if ('pushed' in flushed && flushed.pushed) {
        addLog(id, `pushed devtools saves to ${BETA} first (${flushed.pushed.slice(0, 7)})`);
        git(repoDir, ['fetch', '--quiet', 'origin']);
      }
      const w = git(repoDir, ['worktree', 'add', '-b', c.branch, c.worktree, `origin/${c.base}`]);
      if (!w.ok) throw new Error(`worktree failed: ${w.err}`);
    }
    const findings = c.findings.map((f) => getFinding(f)).filter((f): f is NonNullable<typeof f> => Boolean(f));
    const brief = await writeBrief(c, p, findings, note);
    update(id, { detail: 'Claude is working on it' });
    const before = git(c.worktree, ['rev-parse', 'HEAD']).out;
    // An answer to the agent's question continues its own session (claude --resume); anything else starts a new one.
    const questionFile = path.join(c.worktree, '.hawkes', 'question.md');
    fs.rmSync(questionFile, { force: true });
    const resume = answer && c.session
      ? { session: c.session, prompt: `The answer to your question:\n\n${answer}\n\nContinue the task in .hawkes/brief.md (rewritten with the latest thread) and finish it the way it says.` }
      : undefined;
    addLog(id, resume ? `agent resumed its session with the answer (${s.model})` : `agent started (${s.model})`);
    const r = await runAgent(getChange(id)!, brief, s, claudeEnv(), resume);
    c = getChange(id)!;
    update(id, { cost: c.cost + r.cost });
    const summaryFile = path.join(c.worktree, '.hawkes', 'summary.md');
    const summary = fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8').trim() : r.result;
    const commits = git(c.worktree, ['log', '--format=%h %s', `origin/${c.base}..HEAD`]).out.split('\n').filter(Boolean);
    const changedNow = git(c.worktree, ['rev-parse', 'HEAD']).out !== before;
    // The agent asked a question: the change waits ("needs answer"); Talk answers from what J decided, or asks J (pm.ts).
    const question = fs.existsSync(questionFile) ? fs.readFileSync(questionFile, 'utf8').trim() : '';
    if (question) {
      update(id, { status: 'needs answer', detail: `the agent asks: ${question.split('\n')[0].slice(0, 200)}`, summary, commits });
      addLog(id, `question: ${question.slice(0, 300)}`);
      const { addQuestion, addComment } = await import('./roadmap.ts');
      addComment(c.task ?? id, question.slice(0, 4000), 'agent', 'question');
      addQuestion({ kind: 'agent', subject: id, product: c.product, text: question });
      return;
    }
    if (!commits.length || (note && !changedNow && !c.task)) {
      update(id, { status: 'failed', detail: 'the agent made no commit', summary, commits });
      for (const f of findings) updateFinding(f.id, { status: 'open', note: `agent ${id} couldn't fix it: ${summary.slice(0, 200)}` });
      return;
    }
    if ((note || answer) && !changedNow) addLog(id, 'no new commit this pass; checking the branch again');
    const diffstat = git(c.worktree, ['diff', '--shortstat', `origin/${c.base}...HEAD`]).out;
    update(id, { summary, commits, diffstat, detail: 'pushing and opening the pull request' });

    // Push and open (or update) the pull request.
    const push = git(c.worktree, ['push', '--quiet', '-u', 'origin', `HEAD:${c.branch}`, ...(note || answer ? ['--force-with-lease'] : [])]);
    if (!push.ok) throw new Error(`push failed: ${push.err}`);
    c = getChange(id)!;
    const criteriaMd = c.criteria.length ? `\n\n**Acceptance criteria:**\n${c.criteria.map((k) => `- ${k}`).join('\n')}` : '';
    const body = `${summary}${criteriaMd}\n\n---\n**Findings** (Hawkes Studio playtest review):\n${findings.map((f: any) => `- [${f.severity}] ${f.title} (${f.id}, seen ${f.seen}×)`).join('\n')}\n\nMade by a Hawkes Studio agent. Approving it in Studio merges it into ${c.base} (the beta site, not live); going live is a separate step.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
    if (!c.pr) {
      const pr = await github(`/repos/${c.slug}/pulls`, { method: 'POST', body: { title: c.title, head: c.branch, base: c.base, body, draft: false } });
      update(id, { pr: pr.number, pr_url: pr.html_url });
      addLog(id, `opened ${pr.html_url}`);
    } else {
      await github(`/repos/${c.slug}/pulls/${c.pr}`, { method: 'PATCH', body: { body } });
      addLog(id, `updated pull request #${c.pr}`);
    }

    // Verify: play the finding's scenario on the fixed version (web: the worktree; Unity: a build of the branch).
    update(id, { status: 'verifying', detail: 'playtesting the fix' });
    const verify: any = await verifyChange(getChange(id)!, p, findings);
    // A preview J can open: <product>.hawkesgen.com/c/<id>/
    const pv = await buildPreview(p.id, { change: id, dir: c.worktree }).catch((e: any) => ({ status: 'failed', detail: e.message }) as any);
    const preview = pv?.status === 'ready' ? previewUrl(p.id, id) : null;
    if (preview) addLog(id, `preview: ${preview}`);
    const tryFile = path.join(c.worktree, '.hawkes', 'try.md');
    const howTo = fs.existsSync(tryFile) ? fs.readFileSync(tryFile, 'utf8').trim().slice(0, 2000) : null;
    const met = verify?.criteria?.length ? ` · criteria ${verify.criteria.filter((k: any) => k.met === 'yes').length}/${verify.criteria.length} met` : '';
    update(id, { status: 'ready', detail: `${verify ? `${verify.outcome ?? '?'} · review: ${verify.verdict ?? 'n/a'}${met}` : 'ready (not playtested: needs a build)'}${preview ? ` · preview ${preview}` : ''}`, verify: { ...(verify ?? {}), preview, try: howTo } });
    // No phone notification (J's rule: only when something went wrong or a milestone is reached): Talk reports it,
    // and a roadmap task's change is the PM's to review (pm.ts).
  } catch (e: any) {
    addLog(id, `error: ${e.message}`);
    update(id, { status: 'failed', detail: String(e.message).slice(0, 300) });
    for (const f of getChange(id)!.findings) updateFinding(f, { status: 'open' });
  }
}

/**
 * Builds a Unity change's branch on the build server into its own website copy (changeSiteDir: a worktree of the
 * site repo at main), never the real website folder. A commit that was already built isn't built again.
 */
async function buildChange(c: Change, p: Product): Promise<ChangeBuild> {
  if (!p.build) throw new Error(`${p.name} has no build settings (products.json build)`);
  const sha = git(c.worktree, ['rev-parse', 'HEAD']).out;
  const siteTop = p.site.split('/')[0];
  const copy = changeSiteDir(c.id);
  const last = changeBuild(c.id);
  if (last && last.sha === sha && (last.ok ? fs.existsSync(copy) : !last.retry)) {
    addLog(c.id, `build: ${sha.slice(0, 7)} was already built (${last.ok ? `Game/v${last.version ?? '?'}` : 'it failed'}); not building again`);
    return last;
  }
  const mark = `${copy}.json`;
  fs.rmSync(mark, { force: true });
  // The website copy, fresh at the site repo's main (a previous build of this change is cleared).
  const siteRepo = path.join(PROJECTS, siteTop);
  const f = git(siteRepo, ['fetch', '--quiet', 'origin']);
  if (!f.ok) throw new Error(`fetching ${siteTop} failed: ${f.err}`);
  const head = git(siteRepo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).out || 'origin/main';
  if (!fs.existsSync(path.join(copy, '.git'))) {
    git(siteRepo, ['worktree', 'prune']);
    const w = git(siteRepo, ['worktree', 'add', '--detach', '--force', copy, head]);
    if (!w.ok) throw new Error(`making the website copy failed: ${w.err}`);
  } else {
    const r = git(copy, ['checkout', '--quiet', '--force', '--detach', head]);
    if (!r.ok) throw new Error(`resetting the website copy failed: ${r.err}`);
    git(copy, ['clean', '-fdq']);
  }
  const top = repoFor(p).top;
  const rel = (d: string) => path.relative(PROJECTS, d).replace(/\\/g, '/');
  const projectDir = path.join(c.worktree, path.relative(top, p.build.project));
  const siteDir = path.join(copy, path.relative(siteTop, p.site));
  addLog(c.id, `build: ${sha.slice(0, 7)} on the build server (${p.build.method}) into ${rel(siteDir)}`);
  update(c.id, { detail: 'building the branch on the build server' });
  const job = await genRun('unity.build', p.id, { project: p.build.project, site: p.build.site, method: p.build.method, projectDir: rel(projectDir), siteDir: rel(siteDir) },
    (j) => update(c.id, { detail: `build server: ${j.detail ?? j.status}` }));
  const r = job.result ?? {};
  const cost = Number(job.cost ?? r.cost) || 0;
  update(c.id, { cost: getChange(c.id)!.cost + cost });
  // A Hawkes Gen without siteDir would have built into the real website folder: say so rather than playtest that.
  const stale = job.status === 'done' && r.site && r.site.folder !== rel(siteDir);
  const error = stale ? `Hawkes Gen's unity.build ignored siteDir (update Hawkes Gen); the build went to ${r.site.folder}` : job.status === 'done' ? undefined : String(job.error ?? job.detail ?? 'build failed');
  // Unity's own errors come back the same for the same commit; the server being busy, unlicensed or unreachable doesn't.
  const b: ChangeBuild = {
    sha, ok: !error, at: Date.now(), job: job.id, version: r.version ?? null, cost, minutes: Math.round((r.seconds ?? 0) / 60),
    ...(error ? { error: error.slice(0, 500), retry: !/Unity exited with code|error CS\d+|Build ?Failed/i.test(error) } : {}),
  };
  fs.writeFileSync(mark, JSON.stringify(b, null, 2));
  addLog(c.id, b.ok ? `build: Game/v${b.version ?? '?'} in ${b.minutes} min ($${cost.toFixed(2)})` : `build failed: ${b.error}`);
  return b;
}

async function verifyChange(c: Change, p: Product, findings: any[]) {
  let dir: string;
  let build: ChangeBuild | null = null;
  if (p.engine === 'unity' || p.build) {
    // Unity: build the branch, then serve that build the way the site's local server would.
    build = await buildChange(c, p).catch((e: any): ChangeBuild => ({ sha: '', ok: false, at: Date.now(), error: String(e.message ?? e).slice(0, 500), retry: true }));
    if (!build.ok) return { outcome: 'build failed', error: build.error, build };
    dir = path.join(changeSiteDir(c.id), path.relative(p.site.split('/')[0], p.local.dir));
  } else {
    dir = path.join(c.worktree, repoFor(p).sub, path.relative(p.repo, p.local.dir));
  }
  // The scenario the agent added or extended for its criteria (.hawkes/scenario.txt), else the finding's, else the first.
  const agentScenario = (() => {
    try {
      return /^[\w.-]{1,60}$/.exec(fs.readFileSync(path.join(c.worktree, '.hawkes', 'scenario.txt'), 'utf8').trim().split('\n')[0].trim())?.[0];
    } catch {
      return undefined;
    }
  })();
  const scenario = agentScenario ?? findings.map((f: any) => f.scenario).find((s: string) => s && s.endsWith('@local'))?.split('@')[0] ?? (p.playtests.find((t) => t.where === 'local')?.scenario ?? 'smoke');
  const mode = agentScenario ? undefined : p.playtests.find((t) => t.where === 'local' && (t.scenario ?? t.mode) === scenario)?.mode;
  const port = 8800 + (parseInt(c.id.slice(2, 6), 16) % 200);
  const url = await serveDir(p, dir, port);
  try {
    const run = await genRun('playtest.run', p.id, { url, mode: mode ?? (p.contract ? 'contract' : 'auto'), ...(mode ? {} : { scenario }), ...(mode === 'site' ? { maxPages: 40 } : {}) });
    if (run.status !== 'done') return { outcome: 'failed', error: run.error, playtest: run.id, build };
    // A verify review (review.ts): did the change work (it says by id whether the findings look fixed), did anything regress.
    // A roadmap task's acceptance criteria go with it and are judged one by one (acceptance.ts).
    const rev = await genRun('playtest.review', p.id, reviewParams(p, run.id, 'verify', {
      ...(c.criteria.length ? { criteria: c.criteria } : {}),
      focus: c.request ? `This is a proposed change J asked for: "${c.request.slice(0, 1500)}". Say clearly whether it does that well, and whether anything got worse.${c.criteria.length ? ` Judge each acceptance criterion: ${c.criteria.map((k, i) => `(${i + 1}) ${k}`).join(' ')}` : ''}` : `This is a proposed fix for: ${findings.map((f: any) => `"${f.title}" (${f.detail})`).join('; ')}. Say clearly whether it is fixed, and whether anything got worse.`,
    }));
    const v = rev.result ?? {};
    const video = run.outputs?.find((o: any) => o.kind === 'video')?.asset ?? null;
    const criteria = c.criteria.length ? await judgeCriteria(c.criteria, v, run.result, c.summary) : undefined;
    return { outcome: run.result?.outcome, scenario, playtest: run.id, review: rev.id, verdict: v.verdict, changeWorked: v.changeWorked, known: v.known ?? [], summary: v.summary, scores: v.scores, findings: (v.findings ?? []).slice(0, 8), video, url: localUrl(p), build, ...(criteria ? { criteria } : {}) };
  } finally {
    stopServed(port);
  }
}

// ------------------------------------------------------------ Studio and Gen

/** Never changed by an agent, whatever the request says: data, keys, env files. */
const FORBIDDEN = [/^\.data\//, /(^|\/)\.env(\.|$)/, /^deploy\/\.keys\//, /\.pem$/, /(^|\/)keys\.env$/];
/**
 * Changed only when J names the file in his request (or a note on it): how the server deploys and checks itself,
 * Caddy (in deploy.mjs), secrets, and the GitHub hooks' token checks. A change that touches one otherwise isn't pushed.
 */
const GUARDED: Record<string, string[]> = {
  hawkesstudio: [
    'deploy/hawkes-pull.mjs', 'deploy/deploy.mjs', 'deploy/provision.mjs', 'deploy/cloud-init.sh', 'deploy/secrets.mjs', 'deploy/github-token.mjs',
    'deploy/claude-token.mjs', 'bin/git-credential-hawkes', 'src/github-oidc.ts', 'src/claude.ts', '.github/workflows/',
  ],
  hawkesgen: ['bin/fetch-secrets.mjs', 'src/auth.ts', '.github/workflows/'],
};

/** The files a change may not touch: forbidden ones always; guarded ones unless J's words name them. */
export function guardFiles(target: string, files: string[], words: string) {
  const said = words.toLowerCase();
  const named = (f: string) => said.includes(f.toLowerCase()) || said.includes(path.posix.basename(f).toLowerCase());
  const out: { file: string; why: 'forbidden' | 'guarded' }[] = [];
  for (const f of files) {
    if (FORBIDDEN.some((r) => r.test(f))) out.push({ file: f, why: 'forbidden' });
    else if ((GUARDED[target] ?? []).some((g) => (g.endsWith('/') ? f.startsWith(g) : f === g)) && !named(f)) out.push({ file: f, why: 'guarded' });
  }
  return out;
}

/** The environment of an infra agent and its checks: no GitHub, AWS or other service keys (Claude's own login stays for the agent). */
const SECRET = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AWS_|ANTHROPIC|ELEVENLABS|OPENAI|GITHUB|CLAUDE|STRIPE|SMTP)/i;
function infraEnv({ agent = false, keepGenKey = true } = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(agent ? claudeEnv() : process.env)) {
    if (v === undefined) continue;
    const claude = agent && /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)$/.test(k);
    if (!SECRET.test(k) || claude || (keepGenKey && k === 'HAWKESGEN_KEY')) env[k] = v;
  }
  // Not the server: a worktree must never act like the running Studio (repo syncs) or Gen (fleet access).
  delete env.STUDIO_SERVER;
  delete env.HAWKES_AWS_ROLE;
  return env as NodeJS.ProcessEnv;
}

function sh(cwd: string, cmd: string, env: NodeJS.ProcessEnv, timeoutMs = 15 * 60_000): Promise<{ ok: boolean; out: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, { cwd, env, shell: true, windowsHide: true });
    let out = '';
    const keep = (d: any) => { out = (out + d).slice(-20_000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => { out += `\n(timed out after ${Math.round(timeoutMs / 60_000)} min)`; child.kill('SIGTERM'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out, ms: Date.now() - t0 }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out: e.message, ms: Date.now() - t0 }); });
  });
}
const tail = (s: string, n = 25) => s.trim().split('\n').slice(-n).join('\n');

/** npm ci in the worktree, unless node_modules already matches package-lock.json. */
async function npmCi(id: string, dir: string) {
  const lock = path.join(dir, 'package-lock.json');
  const hash = fs.existsSync(lock) ? crypto.createHash('sha1').update(fs.readFileSync(lock)).digest('hex') : 'none';
  const stamp = path.join(dir, 'node_modules', '.hawkes-lock');
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === hash) return;
  update(id, { detail: 'installing packages (npm ci)' });
  const r = await sh(dir, 'npm ci --no-audit --no-fund', { ...infraEnv(), PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' });
  if (!r.ok) throw new Error(`npm ci failed: ${tail(r.out, 5)}`);
  fs.writeFileSync(stamp, hash);
  addLog(id, `npm ci (${Math.round(r.ms / 1000)} s)`);
}

function writeInfraBrief(c: Change, t: Infra, note?: string) {
  const dir = path.join(c.worktree, '.hawkes');
  fs.mkdirSync(dir, { recursive: true });
  const exclude = path.join(PROJECTS, c.repo, '.git', 'info', 'exclude');
  if (!fs.existsSync(exclude) || !fs.readFileSync(exclude, 'utf8').includes('.hawkes/')) fs.appendFileSync(exclude, '\n.hawkes/\n');
  const brief = `# Work on ${t.name}

You are changing ${t.name} itself: ${t.about}

This repository deploys itself. There is no beta lane: when J approves your change, Studio merges its pull request
into main, CI runs typecheck and tests, and the control server pulls main and restarts ${t.name} (it rolls back if
the service doesn't come up healthy). A mistake here breaks the service J uses for everything: be careful and keep
the change small.

## What J asked for

${c.request ?? '(no request)'}
${note ? `\n## J's note on the last attempt\n\n${note}\n` : ''}
## How to work

1. Read \`AGENTS.md\` (and the docs it points to, e.g. \`docs/cloud.md\`) before changing anything. Follow its rules.
2. Make the smallest correct change that does what J asked. Don't refactor unrelated code.
3. Never touch \`.data/\`, \`.env\` files, keys (\`deploy/.keys/\`, \`*.pem\`, \`keys.env\`) or secrets. Don't change these
   unless J's request names the file: ${(GUARDED[t.id] ?? []).map((f) => `\`${f}\``).join(', ')}. A change that touches
   them anyway is thrown away.
4. Run the checks, and fix what fails:
${t.checks.map((k) => `   - \`${k}\``).join('\n')}
   ${t.id === 'hawkesstudio' ? `Studio's tests use the running Hawkes Gen at ${process.env.HAWKESGEN_URL ?? 'http://127.0.0.1:8790'} (free local tools only).` : 'Tests that need something missing here skip themselves.'}
5. Commit your change with a clear message. Don't push; Studio does.
6. Write \`.hawkes/summary.md\`: what you changed (files) and why, how you checked it, and anything J should know
   (in plain words: J doesn't read code). If you couldn't do it, explain why there instead, and don't commit.
`;
  fs.writeFileSync(path.join(dir, 'brief.md'), brief);
  return path.join(dir, 'brief.md');
}

async function workInfra(id: string, note?: string) {
  let c = getChange(id)!;
  const t = getInfra(c.product);
  const s = agentSettings();
  const repoDir = path.join(PROJECTS, c.repo);
  try {
    update(id, { status: note ? 'revising' : 'working', detail: 'preparing the worktree' });
    if (!fs.existsSync(c.worktree)) {
      fs.mkdirSync(WORK(), { recursive: true });
      // Only refs move in the server's checkout; its files only change through deploy/hawkes-pull.mjs.
      const f = git(repoDir, ['fetch', '--quiet', 'origin']);
      if (!f.ok) throw new Error(`fetch failed: ${f.err}`);
      const w = git(repoDir, ['worktree', 'add', '-b', c.branch, c.worktree, `origin/${c.base}`]);
      if (!w.ok) throw new Error(`worktree failed: ${w.err}`);
    } else if (note) {
      // Another pass: bring the branch up to date with main first (main may have moved, or the merge conflicted).
      git(repoDir, ['fetch', '--quiet', 'origin']);
      const m = git(c.worktree, ['merge', '--no-edit', `origin/${c.base}`]);
      if (!m.ok) git(c.worktree, ['merge', '--abort']);
      addLog(id, m.ok ? `merged origin/${c.base} into the branch` : `merging origin/${c.base} conflicted; the agent works from the branch as it was`);
    }
    await npmCi(id, c.worktree);
    const brief = writeInfraBrief(c, t, note);
    update(id, { detail: 'Claude is working on it' });
    addLog(id, `agent started (${s.model})`);
    const before = git(c.worktree, ['rev-parse', 'HEAD']).out;
    const r = await runAgent(getChange(id)!, brief, s, infraEnv({ agent: true }));
    c = getChange(id)!;
    update(id, { cost: c.cost + r.cost });
    const summaryFile = path.join(c.worktree, '.hawkes', 'summary.md');
    const summary = fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8').trim() : r.result;
    const commits = git(c.worktree, ['log', '--format=%h %s', `origin/${c.base}..HEAD`]).out.split('\n').filter(Boolean);
    const changedNow = git(c.worktree, ['rev-parse', 'HEAD']).out !== before;
    if (!commits.length || (note && !changedNow)) {
      update(id, { status: 'failed', detail: 'the agent made no commit', summary, commits });
      return;
    }
    // Guard rails, before anything leaves the server.
    const files = git(c.worktree, ['diff', '--name-only', `origin/${c.base}...HEAD`]).out.split('\n').filter(Boolean);
    const bad = guardFiles(t.id, files, [c.request ?? '', ...c.notes.map((n) => n.text)].join('\n'));
    if (bad.length) {
      const list = bad.map((b) => `${b.file} (${b.why === 'forbidden' ? 'never changed by agents' : 'only when J names it'})`).join(', ');
      addLog(id, `guard rails: ${list}`);
      update(id, { status: 'failed', detail: `not pushed: it changes protected files: ${list}`.slice(0, 300), summary, commits });
      return;
    }
    const diffstat = git(c.worktree, ['diff', '--shortstat', `origin/${c.base}...HEAD`]).out;
    update(id, { summary, commits, diffstat, detail: 'pushing and opening the pull request' });
    const push = git(c.worktree, ['push', '--quiet', '-u', 'origin', `HEAD:${c.branch}`, ...(note ? ['--force-with-lease'] : [])]);
    if (!push.ok) throw new Error(`push failed: ${push.err}`);
    c = getChange(id)!;
    const body = `${summary}\n\n---\n**J asked:** ${c.request ?? ''}\n\nMade by a Hawkes Studio agent. Approving it in Studio merges it into main, and ${t.name} deploys itself once CI passes (the control server pulls it, restarts the service and rolls back if it isn't healthy).\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
    if (!c.pr) {
      const pr = await github(`/repos/${c.slug}/pulls`, { method: 'POST', body: { title: c.title, head: c.branch, base: c.base, body, draft: false } });
      update(id, { pr: pr.number, pr_url: pr.html_url });
      addLog(id, `opened ${pr.html_url}`);
    } else {
      await github(`/repos/${c.slug}/pulls/${c.pr}`, { method: 'PATCH', body: { body } });
      addLog(id, `updated pull request #${c.pr}`);
    }
    update(id, { status: 'verifying', detail: 'checking: CI on the pull request, the checks, a smoke check' });
    const v = await verifyInfra(getChange(id)!, t);
    update(id, { status: 'ready', detail: `${v.outcome}: ${v.summary}`.slice(0, 300), verify: v });
    // Talk tells J in the chat; no phone notification (only failures and milestones go to the phone).
  } catch (e: any) {
    addLog(id, `error: ${e.message}`);
    update(id, { status: 'failed', detail: String(e.message).slice(0, 300) });
  }
}

/** GitHub's check runs of a commit ("Tell the server" doesn't count: it only runs on main). waitMs 0: one look. */
export async function ciChecks(slug: string, sha: string, { waitMs = 30 * 60_000, onWait }: { waitMs?: number; onWait?: (detail: string) => void } = {}) {
  const t0 = Date.now();
  for (;;) {
    const r = await github(`/repos/${slug}/commits/${sha}/check-runs?per_page=100`);
    const runs = ((r.check_runs ?? []) as any[]).filter((x) => x.name !== 'Tell the server');
    const list = runs.map((x) => ({ name: x.name, status: x.status, conclusion: x.conclusion, url: x.html_url }));
    const open = runs.filter((x) => x.status !== 'completed');
    if (runs.length && !open.length) {
      const bad = runs.filter((x) => !['success', 'skipped', 'neutral'].includes(x.conclusion));
      return { state: bad.length ? 'failure' : 'success', detail: bad.length ? bad.map((x) => `${x.name}: ${x.conclusion}`).join(', ') : `${runs.length} check(s) passed`, runs: list };
    }
    const waited = Date.now() - t0;
    if (waited >= waitMs || (!runs.length && waited >= Math.min(waitMs, 5 * 60_000))) {
      return { state: runs.length ? 'pending' : 'none', detail: runs.length ? `${open.length} check(s) still running` : 'no CI ran on this commit', runs: list };
    }
    onWait?.(runs.length ? `waiting for CI (${open.length} running)` : 'waiting for CI to start');
    await new Promise((res) => setTimeout(res, 20_000));
  }
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const port = (s.address() as net.AddressInfo).port; s.close(() => resolve(port)); });
});

/**
 * Starts the changed service from the worktree on a spare port with a scratch data folder (no keys, none of the live
 * service's state), then: its health answers ok, the dashboard page loads, and every dashboard script parses.
 */
export async function smokeCheck(dir: string, t: Infra) {
  const port = await freePort();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), `hawkes-smoke-${t.id}-`));
  const env = { ...infraEnv({ keepGenKey: false }), ...(t.smoke.env ?? {}), [t.smoke.portEnv]: String(port), [t.smoke.dataEnv]: data };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', t.smoke.start], { cwd: dir, env, windowsHide: true });
  let log = '';
  child.stdout.on('data', (d) => { log = (log + d).slice(-8000); });
  child.stderr.on('data', (d) => { log = (log + d).slice(-8000); });
  let exited: number | null = null;
  child.on('close', (code) => { exited = code ?? -1; });
  const base = `http://127.0.0.1:${port}`;
  const get = async (route: string) => {
    try {
      const r = await fetch(base + route, { signal: AbortSignal.timeout(10_000) });
      return { status: r.status, text: await r.text() };
    } catch (e: any) {
      return { status: 0, text: String(e.message ?? e) };
    }
  };
  try {
    let health: any = null;
    for (let i = 0; i < 60 && exited === null; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const h = await get(t.smoke.health);
      if (h.status === 200) { try { health = JSON.parse(h.text); } catch { health = { ok: false }; } break; }
    }
    const page = health ? await get('/') : null;
    const dashboard = Boolean(page && page.status === 200 && /<html/i.test(page.text));
    const scriptDir = path.join(dir, t.smoke.scripts);
    const scripts = (fs.existsSync(scriptDir) ? fs.readdirSync(scriptDir).filter((f) => f.endsWith('.js')) : []).map((f) => {
      const r = spawnSync(process.execPath, ['--check', path.join(scriptDir, f)], { encoding: 'utf8', windowsHide: true });
      return { file: `${t.smoke.scripts}/${f}`, ok: r.status === 0, error: r.status === 0 ? undefined : tail(r.stderr ?? '', 5) };
    });
    const ok = Boolean(health?.ok) && dashboard && scripts.every((x) => x.ok);
    const detail = !health ? (exited !== null ? `the server exited (code ${exited})` : 'no health answer in 60 s')
      : !health.ok ? 'health is not ok'
        : !dashboard ? 'the dashboard page did not load'
          : scripts.some((x) => !x.ok) ? `script errors: ${scripts.filter((x) => !x.ok).map((x) => x.file).join(', ')}`
            : `health ok, dashboard ok, ${scripts.length} script(s) parse`;
    return { ok, port, health: Boolean(health?.ok), dashboard, scripts, detail, log: ok ? undefined : tail(log, 30) };
  } finally {
    child.kill('SIGTERM');
    setTimeout(() => fs.rmSync(data, { recursive: true, force: true }), 3000).unref();
  }
}

/** Verification of a Studio or Gen change: the checks and a smoke check here, and CI on the pull request (GitHub). */
async function verifyInfra(c: Change, t: Infra) {
  const sha = git(c.worktree, ['rev-parse', 'HEAD']).out;
  const ci = ciChecks(c.slug, sha, { onWait: (d) => update(c.id, { detail: d }) }).catch((e: any) => ({ state: 'error', detail: String(e.message ?? e), runs: [] as any[] }));
  await npmCi(c.id, c.worktree);
  const checks: { cmd: string; ok: boolean; seconds: number; out?: string }[] = [];
  for (const cmd of t.checks) {
    update(c.id, { detail: `running ${cmd}` });
    const r = await sh(c.worktree, cmd, infraEnv());
    checks.push({ cmd, ok: r.ok, seconds: Math.round(r.ms / 1000), out: r.ok ? undefined : tail(r.out) });
    addLog(c.id, `${cmd}: ${r.ok ? 'ok' : 'FAILED'} (${Math.round(r.ms / 1000)} s)`);
  }
  update(c.id, { detail: 'smoke check: starting the changed service on a spare port' });
  const smoke = await smokeCheck(c.worktree, t).catch((e: any) => ({ ok: false, detail: String(e.message ?? e) }) as any);
  addLog(c.id, `smoke: ${smoke.ok ? 'ok' : 'FAILED'}: ${smoke.detail}`);
  const ciResult = await ci;
  addLog(c.id, `CI: ${ciResult.state}: ${ciResult.detail}`);
  const ok = ciResult.state === 'success' && checks.every((k) => k.ok) && smoke.ok;
  const summary = [
    `CI ${ciResult.state === 'success' ? 'green' : `${ciResult.state} (${ciResult.detail})`}`,
    ...checks.map((k) => `${k.cmd} ${k.ok ? 'ok' : 'FAILED'}`),
    `smoke: ${smoke.detail}`,
  ].join(' · ');
  return { kind: 'infra', sha, outcome: ok ? 'passed' : 'failed', verdict: ok ? 'ship' : 'broken', summary, ci: ciResult, checks, smoke };
}

/** J's approval of a Studio or Gen change: merge into main (only with CI green on the pull request); the server deploys it itself. */
async function approveInfra(c: Change, by: string) {
  const t = getInfra(c.product);
  const pr = await github(`/repos/${c.slug}/pulls/${c.pr}`);
  if (pr.state !== 'open') throw new Error(`Pull request #${c.pr} is ${pr.merged ? 'already merged' : pr.state}.`);
  const ci = await ciChecks(c.slug, pr.head.sha, { waitMs: 0 });
  if (ci.state !== 'success') throw new Error(`CI on pull request #${c.pr} isn't green (${ci.state}: ${ci.detail}); not merging into main, which deploys ${t.name}.`);
  let m: any;
  try {
    m = await github(`/repos/${c.slug}/pulls/${c.pr}/merge`, { method: 'PUT', body: { merge_method: 'squash', sha: pr.head.sha, commit_title: `${c.title} (#${c.pr})` } });
  } catch (e: any) {
    throw new Error(`Merging into main failed: ${e.message ?? e}. If main changed the same files, revise ${c.id} so the agent updates its branch from main.`);
  }
  const sha = String(m.sha ?? '').slice(0, 7);
  update(c.id, {
    status: 'merged',
    detail: `merged into main by ${by}: ${sha}. CI runs on main, then the server deploys ${t.name} itself (it waits for runs, agents and Talk answers, and rolls back if unhealthy): GET /api/self-deploys`,
    notes: [...c.notes, { at: Date.now(), by, text: `approved and merged into main (${t.name} deploys itself)` }],
  });
  await cleanup(c.id, { deleteBranch: true });
  return getChange(c.id);
}

/**
 * J's approval: merge the pull request (squash) into beta. Nothing goes live: the beta site is rebuilt and beta is
 * playtested with the change in; going live is deploy() (the deploy plan, then "DEPLOY <product>").
 */
export async function approve(id: string, { confirm, by = 'J', origin }: { confirm?: string; by?: string; origin?: string | null } = {}) {
  const c = getChange(id);
  if (!c) throw new Error('No such change');
  if (confirm !== `MERGE ${id}`) throw new Error(c.infra
    ? `Approving merges this change into main, and ${getInfra(c.product).name} deploys itself once CI passes (a restart). Send confirm: "MERGE ${id}" (J's call).`
    : `Approving merges this change into ${BETA} (the beta site; going live is a separate step). Send confirm: "MERGE ${id}" (J's call).`);
  if (!c.pr) throw new Error('This change has no pull request');
  if (c.infra) {
    if (c.status !== 'ready') throw new Error(`The change is ${c.status}, not ready to approve.`);
    return approveInfra(c, by);
  }
  // Changes opened before the beta lane target main: point them at beta first, so approving never goes live.
  if (c.base !== BETA) {
    ensureBeta(path.join(PROJECTS, c.repo));
    await github(`/repos/${c.slug}/pulls/${c.pr}`, { method: 'PATCH', body: { base: BETA } });
    db.prepare('UPDATE changes SET base = ? WHERE id = ?').run(BETA, id);
    addLog(id, `pull request #${c.pr} now targets ${BETA} (was ${c.base})`);
  }
  // Devtools saves in beta's working copy (dev.ts) go in first, so the merge sees them; a conflict there stops it.
  const { flushDev, pullDev } = await import('./dev.ts');
  const flushed = await flushDev(c.product, `before merging ${id}`);
  if ('conflict' in flushed && flushed.conflict) throw new Error(`Beta's working copy conflicts with beta (${flushed.conflict.join(', ')}); resolve that first (studio_dev_status).`);
  let m: any;
  try {
    m = await github(`/repos/${c.slug}/pulls/${c.pr}/merge`, { method: 'PUT', body: { merge_method: 'squash', commit_title: `${c.title} (#${c.pr})` } });
  } catch (e: any) {
    // Usually a conflict with what's on beta now (devtools saves, another change). J hears it in Talk with the files.
    const files = await github(`/repos/${c.slug}/pulls/${c.pr}/files?per_page=100`).then((fs: any[]) => fs.map((f) => f.filename)).catch(() => []);
    const { postNotice } = await import('./talk.ts');
    postNotice(`Merge stopped: ${c.title}`, `Merging ${id} (${c.pr_url}) into ${BETA} failed: ${e.message ?? e}\n\nThe change touches: ${files.slice(0, 30).join(', ') || '(unknown)'}\n\nIf beta changed those files since (devtools saves or another change), ask the agent to update its branch from ${BETA} (revise ${id}) and approve again.`);
    throw e;
  }
  void pullDev(c.product, `after merging ${id}`).catch((e) => console.warn(`[studio] beta working copy after ${id}: ${e.message ?? e}`));
  update(id, { status: 'merged', detail: `merged into ${BETA} by ${by}: ${String(m.sha ?? '').slice(0, 7)} (not live yet)`, notes: [...c.notes, { at: Date.now(), by, text: `approved and merged into ${BETA}` }] });
  for (const f of c.findings) updateFinding(f, { status: 'fixed', note: `merged into ${BETA} in ${c.pr_url} (goes live with the next deploy)` });
  await cleanup(id, { deleteBranch: true });
  // Beta moved: its pre-deploy build, its build (Unity), the beta site and a local playtest of it follow, in the background.
  // A roadmap task's criteria are judged again on beta, on the scenario its agent wrote for them.
  void import('./pipeline.ts').then(({ startBeta }) => startBeta(c.product, { focus: `Just merged into beta: ${c.title}. Check it works and nothing regressed.`, origin, criteria: c.criteria, scenario: c.verify?.scenario })).catch((e) => console.warn(`[studio] beta after ${id}: ${e.message ?? e}`));
  return getChange(id);
}

/** J's note: the agent continues on the same branch. */
export function revise(id: string, note: string, by = 'J') {
  const c = getChange(id);
  if (!c) throw new Error('No such change');
  if (!['ready', 'failed'].includes(c.status)) throw new Error(`The change is ${c.status}`);
  update(id, { status: 'queued', detail: 'queued for another pass', notes: [...c.notes, { at: Date.now(), by, text: note }] });
  running.add(id);
  // When it's done, the queue goes on (a revision holds a slot like any change).
  void work(id, note).finally(() => {
    running.delete(id);
    void pump();
  });
  return getChange(id);
}

/** The answer to an agent's question (from J, or Talk from what J decided): the agent resumes its own session. */
export function answerChange(id: string, answer: string, by = 'J') {
  const c = getChange(id);
  if (!c) throw new Error('No such change');
  if (c.status !== 'needs answer') throw new Error(`The change is ${c.status}, not waiting for an answer`);
  if (!answer.trim()) throw new Error('Say the answer');
  update(id, { status: 'queued', detail: 'answered; the agent continues', notes: [...c.notes, { at: Date.now(), by, text: `answer: ${answer.slice(0, 500)}` }] });
  running.add(id);
  void work(id, undefined, `${by}: ${answer}`).finally(() => {
    running.delete(id);
    void pump();
  });
  return getChange(id);
}

export async function close(id: string, by = 'J') {
  const c = getChange(id);
  if (!c) throw new Error('No such change');
  if (c.pr) await github(`/repos/${c.slug}/pulls/${c.pr}`, { method: 'PATCH', body: { state: 'closed' } }).catch(() => {});
  update(id, { status: 'closed', detail: `closed by ${by}`, notes: [...c.notes, { at: Date.now(), by, text: 'closed' }] });
  for (const f of c.findings) {
    const fd = getFinding(f);
    if (fd?.status === 'fixing') updateFinding(f, { status: 'open' });
  }
  await cleanup(id, { deleteBranch: true });
  return getChange(id);
}

async function cleanup(id: string, { deleteBranch = false } = {}) {
  const c = getChange(id)!;
  if (!c.infra) await removePreview(c.product, id).catch(() => {});
  const repoDir = path.join(PROJECTS, c.repo);
  git(repoDir, ['worktree', 'remove', '--force', c.worktree]);
  git(repoDir, ['branch', '-D', c.branch]);
  // A Unity change's website copy (its build).
  const copy = changeSiteDir(id);
  if (fs.existsSync(copy)) {
    const p = getProduct(c.product);
    git(path.join(PROJECTS, p.site.split('/')[0]), ['worktree', 'remove', '--force', copy]);
    fs.rmSync(copy, { recursive: true, force: true });
  }
  fs.rmSync(`${copy}.json`, { force: true });
  if (deleteBranch) await github(`/repos/${c.slug}/git/refs/heads/${c.branch}`, { method: 'DELETE' }).catch(() => {});
}

/** After a daily run: start fixes for new findings worth fixing, within the day's budget. */
export function autoFix(runId: string) {
  const s = agentSettings();
  if (!s.enabled || !s.autoFix || !process.env.GITHUB_TOKEN) return [];
  const started: string[] = [];
  const fresh = db.prepare(`SELECT * FROM findings WHERE status = 'open' AND last_run = ? ORDER BY CASE severity WHEN 'blocker' THEN 0 WHEN 'bug' THEN 1 ELSE 2 END, seen DESC`).all(runId) as any[];
  const byProduct = new Map<string, any>();
  for (const f of fresh) if (s.severities.includes(f.severity) && !byProduct.has(f.product)) byProduct.set(f.product, f);
  for (const [product, f] of byProduct) {
    try {
      started.push(startFix(product, [f.id], { auto: true }));
    } catch {
      // A product already being fixed, or the budget is used: skip.
    }
  }
  return started;
}

// Changes interrupted by a restart go back to the queue.
db.prepare(`UPDATE changes SET status = 'queued', detail = 'requeued after a restart' WHERE status IN ('working', 'verifying', 'revising')`).run();
setTimeout(() => void pump(), 5000).unref();
// A safety net for the local queue (no GitHub involved): queued changes never wait on a slot nobody frees.
setInterval(() => void pump(), 60_000).unref();
