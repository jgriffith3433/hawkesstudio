// Agent workers: a finding becomes a pull request.
//
//   startFix(product, findings)  ->  a "change":
//     1. a git worktree on a new branch fix/<change> from origin's beta branch (beta.ts; made from main when missing;
//        J's checkout is never touched)
//     2. the brief: the findings (with their screenshots from Hawkes Gen), the story doc, the project's checks
//     3. Claude Code, headless, in the worktree: reads AGENTS.md, fixes, runs the checks, commits
//     4. Studio pushes the branch and opens a pull request into beta (GitHub API, the hawkes/github token)
//     5. ready once the agent's checks pass and the pull request is open: no playtest. One runs only when J asks
//        (playtestChange): web products are served from the worktree, Unity ones are built on the build server into a
//        website copy (.work/<change>-site); then the change's scenario is playtested and reviewed. Beta's own run
//        after the merge judges a task's acceptance criteria.
//   autoMergeBeta(change) -> J's rule (2026-10-17): a ready product change merges into beta by itself, no Approve card
//                        or PM gate (settings.agents.autoMergeBeta, on by default). One that can't (a canon conflict,
//                        a merge conflict, a pull request GitHub won't merge) stays ready for a person; Talk says why.
//   approve(change)   -> merges the pull request into beta (nothing goes live): the beta site and its playtest follow,
//                        the findings are marked fixed. Also the Changes tab's button for ones that couldn't auto-merge.
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
import { getProduct, getInfra, isInfra, PROJECTS, DATA, ROOT, storyOf, localUrl, type Product, type Infra } from './config.ts';
import { getFinding, updateFinding } from './backlog.ts';
import { reviewParams } from './review.ts';
import { gen, genRun, fileUrl } from './gen.ts';
import { repoMap } from './repos.ts';
import { serveDir, stopServed } from './local.ts';
import { claudeEnv } from './claude.ts';
import { buildPreview, removePreview, previewUrl, changeSiteDir, changeBuild, type ChangeBuild } from './previews.ts';
import { BETA, ensureBeta, gitAsync } from './beta.ts';
import { deployPending, critical } from './drain.ts';
import { notify, notifyOnce, PUBLIC_URL } from './notify.ts';
import { threadFor } from './roadmap.ts';
import { judgeCriteria, gate } from './acceptance.ts';
import { briefSection, learnFrom, recordRun, LEARNED_ASK } from './memory.ts';
import { canonCheck, CONTENTISH } from './canon.ts';
import { roleArgs, loadRole, type RoleName } from './roles.ts';
import { claudeCommand, spawnShell, sandboxShare, assertWorktree, shareWorktree } from './sandbox.ts';
import { launch, DetachedChild, type DetachRec } from './detach.ts';
import { warmDeps } from './warm.ts';

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
for (const col of ['task', 'criteria', 'session', 'pm_seen', 'gpu_budget']) try { db.exec(`ALTER TABLE changes ADD COLUMN ${col} TEXT`); } catch { /* already there */ }
// When the PM used up its tries and asked J (pm.ts pmRevise): the loop leaves it alone from then on.
try { db.exec('ALTER TABLE changes ADD COLUMN pm_escalated INTEGER'); } catch { /* already there */ }
// Where a change's work is (Phase), so it carries on from there after a Studio restart.
try { db.exec('ALTER TABLE changes ADD COLUMN phase TEXT'); } catch { /* already there */ }
// The automatic merge into beta (autoMergeBeta): 'trying', 'merged', or 'failed: <why>' (null: not tried).
try { db.exec('ALTER TABLE changes ADD COLUMN auto_merge TEXT'); } catch { /* already there */ }

export type Change = {
  id: string; product: string; findings: string[]; status: string; detail: string | null; repo: string; slug: string; branch: string; base: string;
  worktree: string; request: string | null; pr: number | null; pr_url: string | null; title: string | null; summary: string | null; commits: string[]; diffstat: string | null;
  verify: any; notes: { at: number; by: string; text: string }[]; log: string[]; cost: number; created: number; updated: number | null;
  /** The roadmap task it works on (roadmap.ts), its acceptance criteria, and the agent's Claude Code session (to resume after a question). */
  task: string | null; criteria: string[]; session: string | null;
  /** Dollars J approved for GPU generation in this change (content work); null: no GPU approved. */
  gpu_budget: string | null;
  /** When the PM used up its tries and asked J (pm.ts): the loop leaves it alone. */
  pm_escalated?: number | null;
  /** The automatic merge into beta: 'trying', 'merged', or 'failed: <why>'; null: not tried. */
  auto_merge?: string | null;
  /** The Talk conversation that started it (followup.ts). */
  origin?: string | null;
  /** A change to Hawkes Studio or Hawkes Gen (a pull request into main, which deploys itself), not a product. */
  infra: boolean;
  /** Absolute links for Talk and J: the change in Studio (its playtest and review if one was asked for, its log), the playtest video, preview, pull request. */
  links: ChangeLinks;
};
export type ChangeLinks = { change: string; pr: string | null; preview: string | null; video: string | null };

function changeLinks(r: any, verify: any): ChangeLinks {
  return {
    change: `${PUBLIC_URL}/#changes/${r.id}`,
    pr: r.pr_url ?? null,
    preview: verify?.preview ?? null,
    video: verify?.video ? fileUrl(verify.video) : null,
  };
}

const SETTINGS_FILE = path.join(DATA, 'agents.json');
/** autoMergeBeta: ready product changes merge into beta by themselves (J, 2026-10-17); off: a person merges them. */
export type AgentSettings = { enabled: boolean; autoFix: boolean; autoMergeBeta: boolean; betaPlaytests: boolean; maxConcurrent: number; maxPerDay: number; maxCostPerDay: number; severities: string[]; model: string; maxTurns: number };
const DEFAULTS: AgentSettings = { enabled: true, autoFix: true, autoMergeBeta: true, betaPlaytests: false, maxConcurrent: 2, maxPerDay: 4, maxCostPerDay: 20, severities: ['blocker', 'bug'], model: 'claude-opus-5-5', maxTurns: 80 };
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

const toChange = (r: any): Change => {
  const verify = parse(r.verify);
  return { ...r, infra: isInfra(r.product), criteria: parse(r.criteria) ?? [], findings: parse(r.findings) ?? [], commits: parse(r.commits) ?? [], verify, notes: parse(r.notes) ?? [], log: parse(r.log) ?? [], links: changeLinks(r, verify) };
};
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
  for (const k of ['findings', 'commits', 'verify', 'notes', 'log', 'phase']) if (patch[k] !== undefined) next[k] = patch[k] === null ? null : J(patch[k]);
  db.prepare(`UPDATE changes SET status=?, detail=?, pr=?, pr_url=?, title=?, summary=?, commits=?, diffstat=?, verify=?, notes=?, log=?, cost=?, session=?, phase=?, auto_merge=?, updated=? WHERE id=?`)
    .run(next.status, next.detail, next.pr, next.pr_url, next.title, next.summary, next.commits, next.diffstat, next.verify, next.notes, next.log, next.cost, next.session ?? null, next.phase ?? null, next.auto_merge ?? null, next.updated, id);
}

/**
 * Where a change's work is, recorded as it goes so a Studio restart (a deploy) doesn't redo it: the steps in order
 * (prepare: worktree and brief; agent: Claude Code, detached, with its process and how far its output was read;
 * publish: push and pull request; verify: build, playtest and review, with their Gen jobs; finish: canon, preview,
 * ready), and what the pass is (J's note, an answer). Null once the change isn't being worked on
 * (a failed one keeps the step it failed at, with `failed`).
 */
export type Phase = {
  step: 'prepare' | 'agent' | 'publish' | 'verify' | 'finish';
  note?: string;
  answer?: string;
  /** The worktree's HEAD before the agent's pass. */
  before?: string;
  /** The agent's detached process (detach.ts) and the byte of its output Studio had logged up to. */
  proc?: { rec: DetachRec; offset: number };
  /** The agent's final words (the summary when it wrote none). */
  result?: string;
  /** The pushed commit under verification. */
  tip?: string;
  /** Verification's Hawkes Gen jobs (build, playtest, review): waited on again after a restart, not submitted again. */
  jobs?: Record<string, string>;
  verify?: any;
  /** On a failed change: the step it failed at, kept for the Activity panel's stages (nothing resumes it). */
  failed?: boolean;
  /** A playtest asked for (playtestChange): who asked. It ends the pass with the change ready again, never failed. */
  requested?: string;
};
export const phaseOf = (id: string): Phase | null => parse((db.prepare('SELECT phase FROM changes WHERE id = ?').get(id) as any)?.phase ?? null);
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
  // STUDIO_GITHUB_API: a stand-in for GitHub's API (tests).
  const r = await fetch(`${process.env.STUDIO_GITHUB_API ?? 'https://api.github.com'}${route}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'hawkes-studio', 'X-GitHub-Api-Version': '2022-11-28', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${route}: ${r.status} ${data.message ?? ''}`);
  return data;
}

// ----------------------------------------------------------------- brief

/** What GPU generation this change may do (content work): J's approved budget, or none. */
function gpuBrief(c: Change) {
  const b = c.gpu_budget === null ? null : Number(c.gpu_budget);
  if (b !== null && b > 0) {
    return `## GPU budget: $${b.toFixed(2)} (approved by J)

You may generate through Hawkes Gen up to that: queue each kind of job as one batch (one model load), reuse what
the library already has (\`reuse\`, asset manifests), stop the servers you started when the batch is done, and report
the GPU minutes and dollars spent (\`hawkesgen_jobs\`). If it won't fit, make the most important part and say what the
rest would cost.

`;
  }
  return `## GPU budget: none

Nothing here was approved for GPU generation (images, video, music, 3D on the fleet). Do everything that needs no GPU
(design, data, specs, Claude-only steps, voice and sound effects are fine: cents each), price the GPU part with
\`hawkesgen_estimate\`, and end with that estimate in your summary so J can approve it. Never start a GPU server.

`;
}

/** Content and story work (dialogue, lore, levels, characters) is checked against canon; the rest is a fix or a build. */
const CONTENT = /\b(story|lore|canon|dialog(ue)?|line|lines|bark|script|cutscene|quest|character|fighter|level|floor|stage|map|name|text|copy|voice|narrat|chapter|scene|enemy|enemies|boss)\b/i;
export function roleOf(c: { infra?: boolean; request?: string | null; findings?: string[]; title?: string | null; gpu_budget?: string | null }): 'infra' | 'content' | 'builder' | 'fixer' {
  if (c.infra) return 'infra';
  // A task J gave a GPU budget is content work (generated art, music, levels).
  if (c.gpu_budget !== undefined && c.gpu_budget !== null) return 'content';
  if (CONTENT.test(`${c.request ?? ''} ${c.title ?? ''}`)) return 'content';
  return c.request ? 'builder' : 'fixer';
}
/** The roadmap item a task's change belongs to (its memory scope). */
function taskItem(c: Change) {
  if (!c.task) return null;
  return (db.prepare('SELECT item FROM tasks WHERE id = ?').get(c.task) as { item: string } | undefined)?.item ?? null;
}

/**
 * After an agent pass: what it left in .hawkes/learned.md becomes shared-memory candidates (once per pass), and its run
 * goes into the run history with the change's outcome (updated again when it is merged or closed).
 */
export function remember(id: string) {
  const c = getChange(id);
  if (!c) return;
  try {
    const file = path.join(c.worktree, '.hawkes', 'learned.md');
    let lessons = '';
    if (fs.existsSync(file)) {
      lessons = fs.readFileSync(file, 'utf8').trim().slice(0, 4000);
      const scope = c.infra ? { product: c.product } : { product: c.product, item: taskItem(c) };
      const ids = learnFrom(lessons, { who: 'agent', id: c.id }, { ...scope, source: c.pr_url ?? c.id });
      if (ids.length) addLog(id, `memory: ${ids.length} note(s) for the next agent (${ids.join(', ')})`);
      fs.renameSync(file, `${file}.${Date.now()}`);
    }
    const prev = db.prepare('SELECT lessons FROM agent_runs WHERE id = ?').get(`ar_${c.id.slice(2)}`) as { lessons: string } | undefined;
    recordRun({
      id: `ar_${c.id.slice(2)}`, kind: c.infra ? 'infra' : c.task ? 'task' : c.request ? 'request' : 'fix', subject: c.id, product: c.product, title: c.title ?? c.id,
      outcome: c.status, summary: `${c.summary ?? ''}${c.detail ? `\n\nStatus: ${c.detail}` : ''}${c.pr_url ? `\n${c.pr_url}` : ''}`, lessons: [prev?.lessons, lessons].filter(Boolean).join('\n'),
      by: c.task ? 'PM' : 'J', model: (() => { try { return loadRole(agentRole(c)).model; } catch { return null; } })(), cost: c.cost, started: c.created, finished: Date.now(),
    });
  } catch (e: any) {
    console.warn(`[memory] ${id}: ${e.message}`);
  }
}

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
  const mem = briefSection({ product: p.id, item: taskItem(c), role: roleOf(c), text: [c.request, c.title, ...findings.map((f) => `${f.title} ${f.area ?? ''} ${f.detail ?? ''}`)].filter(Boolean).join(' ') });
  const checks = (p.checks ?? []).map((k) => `- \`${k.cmd}\` (in ${k.dir === p.repo ? 'the repo root' : k.dir})`).join('\n') || '- (none listed: at least make sure it builds or loads)';
  const sub = repoFor(p).sub;
  const brief = `# ${c.request ? 'Work' : 'Fix'} for ${p.name}

You are fixing a problem Hawkes Studio's automated playtest found in ${p.name} (${p.about}).
${sub ? `The project lives in \`${sub}/\` inside this repository.` : ''}

${c.request ? `## What J asked for

${c.request}

Work out what that means in this project (read the story doc and AGENTS.md), make it well, and keep it consistent with
the product's tone and style. If it's too big for one change, do a solid first part and say what's left in the summary.

${gpuBrief(c)}` : ''}${c.criteria.length ? `## Acceptance criteria (how this is judged)

The change is ready once your checks pass and its pull request is open; after it is merged into beta, beta's playtest
judges these, and the work is done only when every one of them passes there:
${c.criteria.map((k, i) => `${i + 1}. ${k}`).join('\n')}

Where the game implements the playtest contract (\`window.hawkesPlaytest\`: see this project's AGENTS.md, and the spec
at \`hawkesstudio/docs/playtest.md\` next to this repository), add or extend a scenario that plays to what the criteria
describe (through real input, no teleporting; named setup shortcuts are fine) and logs events or checks that show each
one, so the review can judge them from the footage and the timeline. Write that scenario's name (one line, e.g.
\`checkout\`) in \`.hawkes/scenario.txt\`: beta's playtest plays it (and this change's, when J asks for one). To play specific content
(a new stage, level or enemy), add a second line with the scenario's options as JSON, e.g. \`{"stage":"neon-pit"}\`. Without a contract, make
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
${note ? `\n## Notes on the last attempt (J's or the PM's)\n\n${note}\n` : ''}${mem.text ? `\n${mem.text}` : ''}
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
9. ${LEARNED_ASK.replace(/\n/g, '\n   ')}

## The product's story (for tone and intent)

${storyOf(p, 6000)}
`;
  fs.writeFileSync(path.join(dir, 'brief.md'), brief);
  return path.join(dir, 'brief.md');
}

// ------------------------------------------------------------------ agent

/** Git LFS files in a new worktree (Sick Of It keeps its art there): real files, not pointers. Fast when the repo has them. */
function lfsPull(worktree: string, log: (s: string) => void) {
  try {
    if (!/filter=lfs/.test(fs.readFileSync(path.join(worktree, '.gitattributes'), 'utf8'))) return;
  } catch {
    return;
  }
  const t0 = Date.now();
  const r = git(worktree, ['lfs', 'pull'], 20 * 60_000);
  log(r.ok ? `git lfs pull (${Math.round((Date.now() - t0) / 1000)} s)` : `git lfs pull failed: ${r.err.split('\n').pop()}`);
}

export const AGENT_MEMORY_TOOLS = ['memory_search', 'memory_get', 'memory_write'];
/** The role an agent change runs as: content work, a build (requests, roadmap tasks, Studio and Gen), or a fix. */
export const agentRole = (c: Change): RoleName => ({ infra: 'builder', content: 'content', builder: 'builder', fixer: 'fixer' } as const)[roleOf(c)];
/**
 * An agent's or scout's MCP config: Studio's server with the memory tools only, as that agent (writes are candidates),
 * and Hawkes Gen's with a "user" role key (generate, estimate, read jobs and the library; no fleet launches, no keys):
 * AGENT_GEN_KEY, else Talk's, else the devtools' key. Never Studio's own (owner) key.
 */
export function agentMcp(id: string) {
  const dir = sandboxShare('mcp');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  const genKey = process.env.AGENT_GEN_KEY ?? process.env.TALK_GEN_KEY ?? process.env.DEV_GEN_KEY ?? '';
  const cfg = { mcpServers: {
    hawkesstudio: { command: process.execPath, args: [path.join(ROOT, 'bin', 'studio-mcp.mjs')], env: { STUDIO_SERVER: '1', STUDIO_AGENT: id, STUDIO_MCP_TOOLS: AGENT_MEMORY_TOOLS.join(',') } },
    ...(genKey ? { hawkesgen: { command: process.execPath, args: [path.join(PROJECTS, 'hawkesgen', 'bin', 'hawkesgen-mcp.mjs')], env: { HAWKESGEN_URL: process.env.HAWKESGEN_URL ?? 'http://127.0.0.1:8790', HAWKESGEN_KEY: genKey } } } : {}),
  } };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

type AgentResult = { ok: boolean; cost: number; result: string; sawResult: boolean; lost: boolean };
/** How an agent pass runs: as a new process (onStart records it), or reattached to one started before a restart. */
type AgentRun = { reattach?: { rec: DetachRec; offset: number }; onStart?: (rec: DetachRec) => void; onProgress?: (offset: number) => void };

const AGENT_LIMIT_MS = 60 * 60_000;

function runAgent(c: Change, briefFile: string, s: AgentSettings, env = claudeEnv(), resume?: { session: string; prompt: string }, how: AgentRun = {}): Promise<AgentResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof launch>['child'];
    let started = Date.now();
    // Reattached: its output is read again from the start (for the result), but lines logged before the restart aren't logged twice.
    let quietUntil = 0;
    if (how.reattach) {
      child = new DetachedChild(how.reattach.rec, { reattached: true });
      quietUntil = how.reattach.offset;
      started = how.reattach.rec.started;
    } else {
      const prompt = resume?.prompt ?? `Read ${path.relative(c.worktree, briefFile).replace(/\\/g, '/')} and do what it says. It's your whole task.`;
      // The role (.claude/agents/<role>.md): its model, standing instructions (the stable, cached part of the prompt),
      // tools and turn limit; the task itself is the brief.
      const { args: roleFlags, role } = roleArgs(agentRole(c), {
        extraAllowed: [...AGENT_MEMORY_TOOLS.map((t) => `mcp__hawkesstudio__${t}`), 'mcp__hawkesgen'],
        maxTurns: s.maxTurns !== DEFAULTS.maxTurns ? s.maxTurns : undefined,
      });
      const args = [
        ...(resume ? ['--resume', resume.session] : []),
        '-p', prompt, '--output-format', 'stream-json', '--verbose', ...roleFlags,
        '--permission-mode', 'acceptEdits',
        // Its own Studio MCP server with only the shared-memory tools, writing as this change (X-Studio-Agent).
        '--mcp-config', agentMcp(c.id), '--strict-mcp-config',
      ];
      addLog(c.id, `role ${role.name} (${role.model})`);
      // Outside Studio where it can be (detach.ts): a deploy restarting Studio doesn't stop it. Same user, same environment.
      const l = launch(`agent-${c.id}`, claudeCommand(args, { cwd: c.worktree, env }));
      child = l.child;
      if (l.rec) {
        addLog(c.id, `agent runs as ${l.rec.mode === 'systemd' ? 'the unit' : 'the process'} ${l.rec.unit} (it survives a Studio restart)`);
        how.onStart?.(l.rec);
      }
    }
    let buf = '';
    const out: AgentResult = { ok: false, cost: 0, result: '', sawResult: false, lost: false };
    let saved = 0;
    const timer = setTimeout(() => child.kill('SIGTERM'), Math.max(5_000, AGENT_LIMIT_MS - (Date.now() - started)));
    child.stdout!.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const quiet = child instanceof DetachedChild && child.offset <= quietUntil;
        try {
          const m = JSON.parse(line);
          // Its session id, so a question can be answered in the same session (claude --resume).
          if (m.type === 'system' && m.session_id && getChange(c.id)?.session !== m.session_id) update(c.id, { session: m.session_id });
          if (m.type === 'assistant' && !quiet) {
            for (const part of m.message?.content ?? []) {
              if (part.type === 'text' && part.text.trim()) addLog(c.id, `agent: ${part.text.trim().slice(0, 300)}`);
              if (part.type === 'tool_use') addLog(c.id, `tool: ${part.name} ${JSON.stringify(part.input).slice(0, 160)}`);
            }
          }
          if (m.type === 'result') {
            out.cost = Number(m.total_cost_usd) || 0;
            out.result = String(m.result ?? '');
            out.ok = !m.is_error;
            out.sawResult = true;
          }
        } catch {
          // Not JSON.
        }
      }
      // How far the output was logged, every few seconds (lines after it may be logged again after a restart).
      if (child instanceof DetachedChild && how.onProgress && Date.now() - saved > 3000) {
        saved = Date.now();
        how.onProgress(child.offset);
      }
    });
    child.stderr!.on('data', (d) => addLog(c.id, `stderr: ${String(d).slice(0, 300)}`));
    child.on('close', () => {
      clearTimeout(timer);
      out.lost = child instanceof DetachedChild && child.lost && !out.sawResult;
      resolve(out);
    });
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      addLog(c.id, `couldn't start Claude Code: ${e.message}`);
      resolve({ ok: false, cost: 0, result: e.message, sawResult: false, lost: false });
    });
  });
}

/**
 * The agent's pass in a change's "agent" step: reattached to its process when one was recorded (Studio restarted while
 * it ran), else started (and recorded). A process that vanished without a result (the server rebooted) runs again.
 */
async function agentPass(id: string, ph: Phase, save: (patch: Partial<Phase>) => void, s: AgentSettings, env: NodeJS.ProcessEnv, resume?: { session: string; prompt: string }) {
  const brief = path.join(getChange(id)!.worktree, '.hawkes', 'brief.md');
  const fresh = (): AgentRun => ({
    onStart: (rec) => save({ proc: { rec, offset: 0 } }),
    onProgress: (offset) => save({ proc: { ...ph.proc!, offset } }),
  });
  if (ph.proc) {
    addLog(id, `agent: reattached to ${ph.proc.rec.unit} after a Studio restart`);
    const r = await runAgent(getChange(id)!, brief, s, env, resume, { ...fresh(), reattach: ph.proc });
    if (!r.lost) return r;
    addLog(id, `agent: ${ph.proc.rec.unit} is gone with no result (the server restarted?); starting the pass again`);
    save({ proc: undefined });
  }
  return runAgent(getChange(id)!, brief, s, env, resume, fresh());
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
export function startTask(productId: string, request: string, { criteria = [], task = null, title, gpuBudget = null }: { criteria?: string[]; task?: string | null; title?: string; gpuBudget?: number | null } = {}) {
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
  db.prepare('UPDATE changes SET task = ?, criteria = ?, gpu_budget = ? WHERE id = ?').run(task, J(criteria), gpuBudget === null || !(gpuBudget >= 0) ? null : String(gpuBudget), id);
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
  // A Studio deploy is waiting (drain.ts): start nothing new; the queue resumes after the deploy restarts Studio.
  if (deployPending()) return;
  const s = agentSettings();
  for (const c of listChanges({ status: 'queued' }).reverse()) {
    if (running.size >= s.maxConcurrent) return;
    if (running.has(c.id)) continue;
    running.add(c.id);
    void work(c.id).finally(() => {
      running.delete(c.id);
      remember(c.id);
      void pump();
    });
  }
}

/** Pushes a change's branch and opens its pull request (or updates the one it has); a critical section (drain.ts). */
async function publish(id: string, { force, title, body }: { force: boolean; title: string | null; body: string }) {
  return critical(`pushing ${id} and its pull request`, async () => {
    let c = getChange(id)!;
    const push = await gitAsync(c.worktree, ['push', '--quiet', '-u', 'origin', `HEAD:${c.branch}`, ...(force ? ['--force-with-lease'] : [])]);
    if (!push.ok) throw new Error(`push failed: ${push.err}`);
    // A pull request merged or closed outside Studio (GitHub's website, another tool) takes no more commits: pushing
    // to its branch would leave the new ones off beta. Open a new pull request for what isn't on beta yet.
    if (c.pr && !c.infra) {
      const old = await github(`/repos/${c.slug}/pulls/${c.pr}`).catch(() => null);
      if (old && old.state !== 'open') {
        addLog(id, `pull request #${c.pr} was ${old.merged ? `merged outside Studio (${String(old.merged_at ?? '').slice(0, 16)}, head ${String(old.head?.sha ?? '').slice(0, 7)})` : 'closed'}; opening a new one for the commits not on ${c.base}`);
        update(id, { pr: null, pr_url: null });
        c = getChange(id)!;
      }
    }
    if (!c.pr) {
      // One already open for this branch: Studio opened it and restarted before it recorded it.
      const owner = c.slug.split('/')[0];
      const open: any[] = await github(`/repos/${c.slug}/pulls?state=open&head=${encodeURIComponent(`${owner}:${c.branch}`)}`).catch(() => []);
      const pr = open[0] ?? await github(`/repos/${c.slug}/pulls`, { method: 'POST', body: { title, head: c.branch, base: c.base, body, draft: false } });
      if (open[0]) await github(`/repos/${c.slug}/pulls/${pr.number}`, { method: 'PATCH', body: { body } });
      update(id, { pr: pr.number, pr_url: pr.html_url });
      addLog(id, `${open[0] ? 'found' : 'opened'} ${pr.html_url}`);
    } else {
      await github(`/repos/${c.slug}/pulls/${c.pr}`, { method: 'PATCH', body: { body } });
      addLog(id, `updated pull request #${c.pr}`);
    }
  });
}

async function work(id: string, note?: string, answer?: string, resumed?: Phase | null, asked = false) {
  if (getChange(id)!.infra) return workInfra(id, note, resumed);
  let c = getChange(id)!;
  const p = getProduct(c.product);
  const s = agentSettings();
  const repoDir = path.join(PROJECTS, c.repo);
  // Where the work is; after a restart it carries on from the recorded step (same agent process, same Gen jobs).
  const ph: Phase = resumed ?? { step: 'prepare', note, answer };
  ({ note, answer } = ph);
  const save = (patch: Partial<Phase>, extra: Record<string, any> = {}) => {
    Object.assign(ph, patch);
    update(id, { ...extra, phase: ph });
  };
  try {
    if (resumed && !asked) addLog(id, `Studio restarted: carrying on from the ${ph.step} step`);
    else if (!resumed) save({}, { status: note || answer ? 'revising' : 'working', detail: 'preparing the worktree' });
    const findings = c.findings.map((f) => getFinding(f)).filter((f): f is NonNullable<typeof f> => Boolean(f));

    if (ph.step === 'prepare') {
      update(id, { detail: 'preparing the worktree' });
      if (!fs.existsSync(c.worktree)) {
        fs.mkdirSync(WORK(), { recursive: true });
        // Agent branches start from beta (made from main the first time: pushing beta deploys nothing).
        await critical(`making the worktree of ${id}`, async () => {
          const beta = await ensureBeta(repoDir);
          if (beta.created) addLog(id, `made the ${BETA} branch from main (${beta.sha.slice(0, 7)})`);
          // Devtools saves still waiting in beta's working copy go to beta first, so the agent starts from them.
          const flushed = await import('./dev.ts').then(({ flushDev }) => flushDev(c.product, `before agent change ${id} started`)).catch((e) => ({ error: String(e.message ?? e) }));
          if ('pushed' in flushed && flushed.pushed) {
            addLog(id, `pushed devtools saves to ${BETA} first (${flushed.pushed.slice(0, 7)})`);
            await gitAsync(repoDir, ['fetch', '--quiet', 'origin']);
          }
          // A worktree a restart cut off halfway is forgotten first; its branch is reused.
          git(repoDir, ['worktree', 'prune']);
          const has = git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${c.branch}`]).ok;
          const w = git(repoDir, ['worktree', 'add', ...(has ? [] : ['-b']), ...(has ? [c.worktree, c.branch] : [c.branch, c.worktree, `origin/${c.base}`])]);
          if (!w.ok) throw new Error(`worktree failed: ${w.err}`);
        });
        // The agent (sandbox user) commits here: its git folder must be the agent group's.
        shareWorktree(c.worktree);
        // A warm start: node_modules from a checkout with the same lockfile (warm.ts), not a fresh npm ci.
        warmDeps(c.worktree, c.repo, (s) => addLog(id, s));
      lfsPull(c.worktree, (s) => addLog(id, s));
      }
      await writeBrief(c, p, findings, note);
      // A question from an earlier pass isn't asked again.
      fs.rmSync(path.join(c.worktree, '.hawkes', 'question.md'), { force: true });
      save({ step: 'agent', before: git(c.worktree, ['rev-parse', 'HEAD']).out, proc: undefined });
    }

    if (ph.step === 'agent') {
      update(id, { detail: 'Claude is working on it' });
      // An answer to the agent's question continues its own session (claude --resume); anything else starts a new one.
      c = getChange(id)!;
      const resume = answer && c.session
        ? { session: c.session, prompt: `The answer to your question:\n\n${answer}\n\nContinue the task in .hawkes/brief.md (rewritten with the latest thread) and finish it the way it says.` }
        : undefined;
      if (!ph.proc) addLog(id, resumed ? 'agent: it ran inside Studio, which restarted; starting the pass again' : resume ? `agent resumed its session with the answer` : `agent started`);
      const r = await agentPass(id, ph, save, s, claudeEnv(), resume);
      // The cost and the next step are written together, so a restart never counts a pass twice.
      save({ step: 'publish', result: r.result, proc: undefined }, { cost: getChange(id)!.cost + r.cost });
    }

    if (ph.step === 'publish') {
      c = getChange(id)!;
      // The agent could write its worktree: Studio's git runs there only while it still links to this repo.
      assertWorktree(c.worktree, repoDir);
      const summaryFile = path.join(c.worktree, '.hawkes', 'summary.md');
      const summary = fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8').trim() : ph.result ?? '';
      const commits = git(c.worktree, ['log', '--format=%h %s', `origin/${c.base}..HEAD`]).out.split('\n').filter(Boolean);
      const changedNow = git(c.worktree, ['rev-parse', 'HEAD']).out !== ph.before;
      // The agent asked a question: the change waits ("needs answer"); Talk answers from what J decided, or asks J (pm.ts).
      const questionFile = path.join(c.worktree, '.hawkes', 'question.md');
      const question = fs.existsSync(questionFile) ? fs.readFileSync(questionFile, 'utf8').trim() : '';
      if (question) {
        update(id, { status: 'needs answer', detail: `the agent asks: ${question.split('\n')[0].slice(0, 200)}`, summary, commits, phase: null });
        addLog(id, `question: ${question.slice(0, 300)}`);
        const { addQuestion, addComment } = await import('./roadmap.ts');
        addComment(c.task ?? id, question.slice(0, 4000), 'agent', 'question');
        addQuestion({ kind: 'agent', subject: id, product: c.product, text: question });
        return;
      }
      if (!commits.length || (note && !changedNow && !c.task)) {
        update(id, { status: 'failed', detail: 'the agent made no commit', summary, commits, phase: null });
        for (const f of findings) updateFinding(f.id, { status: 'open', note: `agent ${id} couldn't fix it: ${summary.slice(0, 200)}` });
        return;
      }
      if ((note || answer) && !changedNow) addLog(id, 'no new commit this pass; checking the branch again');
      const diffstat = git(c.worktree, ['diff', '--shortstat', `origin/${c.base}...HEAD`]).out;
      update(id, { summary, commits, diffstat, detail: 'pushing and opening the pull request' });
      const criteriaMd = c.criteria.length ? `\n\n**Acceptance criteria:**\n${c.criteria.map((k) => `- ${k}`).join('\n')}` : '';
      const body = `${summary}${criteriaMd}\n\n---\n**Findings** (Hawkes Studio playtest review):\n${findings.map((f: any) => `- [${f.severity}] ${f.title} (${f.id}, seen ${f.seen}×)`).join('\n')}\n\nMade by a Hawkes Studio agent. Approving it in Studio merges it into ${c.base} (the beta site, not live); going live is a separate step.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
      await publish(id, { force: Boolean(note || answer), title: c.title, body });
      // The branch tip the agent's checks passed on; approving merges exactly this commit (approve() checks it). No
      // playtest here: one runs only when J asks for it (playtestChange); beta's run after the merge judges the criteria.
      save({ step: 'finish', tip: git(c.worktree, ['rev-parse', 'HEAD']).out, jobs: {}, verify: undefined });
    }

    if (ph.step === 'verify') {
      if (resumed) update(id, { status: 'verifying', detail: 'playtesting the change' });
      // A playtest J asked for: the change's scenario on its version (web: the worktree; Unity: a build of the branch).
      // It never fails the change: a playtest that couldn't run (no build, no page server) says so on the change.
      const jobs: JobMemo = { get: (k) => ph.jobs?.[k], set: (k, job) => save({ jobs: { ...ph.jobs, [k]: job } }) };
      const verify: any = await verifyChange(getChange(id)!, p, findings, jobs).catch((e: any) => ({ outcome: 'not played', error: `the playtest couldn't run: ${String(e.message ?? e).slice(0, 300)}` }));
      save({ step: 'finish', verify });
    }

    c = getChange(id)!;
    // A playtest on request: its results join what the change already had (sha, preview, canon), and it's ready again.
    if (ph.requested) {
      const keep = Object.fromEntries(['scenario', 'options', 'canon'].filter((k) => c.verify?.[k] !== undefined).map((k) => [k, c.verify[k]]));
      const verify = { ...keep, ...ph.verify, sha: ph.tip ?? c.verify?.sha, preview: c.verify?.preview ?? null, try: c.verify?.try ?? null, asked: { at: Date.now(), by: ph.requested } };
      addLog(id, `playtest (asked by ${ph.requested}): ${verify.outcome ?? '?'} · review: ${verify.verdict ?? 'n/a'}${verify.error ? ` · ${verify.error}` : ''}`);
      update(id, { status: 'ready', detail: readyDetail(verify), verify, phase: null });
      return;
    }
    // Finish: the canon check, the preview, ready.
    const verify = ph.verify ?? { ...agentScenarioOf(c.worktree) };
    // Content and story changes are checked against the canon (canon.ts); a contradiction fails the merge gate.
    if (roleOf(c) === 'content') {
      update(id, { detail: 'checking the change against the canon' });
      const files = git(c.worktree, ['diff', '--name-only', `origin/${c.base}...HEAD`]).out.split('\n').filter((f) => CONTENTISH.test(f));
      const diff = files.length ? git(c.worktree, ['diff', `origin/${c.base}...HEAD`, '--', ...files.slice(0, 60)]).out : '';
      const canon = await canonCheck(p.id, diff, c.title ?? c.request ?? id).catch((e: any) => ({ ok: true, summary: `couldn't check: ${e.message}`, conflicts: [], checked: 0, skipped: 'error' }));
      addLog(id, `canon: ${canon.ok ? 'ok' : 'CONFLICT'}: ${canon.summary}${canon.conflicts.length ? ` (${canon.conflicts.map((k) => k.entry).join(', ')})` : ''}`);
      if (verify) verify.canon = canon;
    }
    // A preview J can open: <product>.hawkesgen.com/c/<id>/
    const pv = await Promise.resolve().then(() => buildPreview(p.id, { change: id, dir: c.worktree })).catch((e: any) => ({ status: 'failed', detail: e.message }) as any);
    const preview = pv?.status === 'ready' ? previewUrl(p.id, id) : null;
    if (preview) addLog(id, `preview: ${preview}`);
    const tryFile = path.join(c.worktree, '.hawkes', 'try.md');
    const howTo = fs.existsSync(tryFile) ? fs.readFileSync(tryFile, 'utf8').trim().slice(0, 2000) : null;
    const done = { ...verify, sha: ph.tip, preview, try: howTo };
    const auto = agentSettings().autoMergeBeta;
    // 'trying' is written with 'ready', so Talk's "ready for J" notice (followup.ts) never races the merge.
    update(id, { status: 'ready', detail: readyDetail(done), verify: done, phase: null, auto_merge: auto ? 'trying' : null });
    // No phone notification (J's rule: only when something went wrong or a milestone is reached): Talk reports it.
    // Ready means merged into beta now (autoMergeBeta); with it off, a person merges it (or the PM, pm.ts).
    if (auto) await autoMergeBeta(id);
  } catch (e: any) {
    addLog(id, `error: ${e.message}`);
    // A playtest on request that went wrong leaves the change as it was: ready, with what happened.
    if (ph.requested) {
      const v = { ...(getChange(id)!.verify ?? {}), outcome: 'not played', error: `the playtest couldn't run: ${String(e.message).slice(0, 300)}` };
      update(id, { status: 'ready', detail: readyDetail(v), verify: v, phase: null });
      return;
    }
    update(id, { status: 'failed', detail: String(e.message).slice(0, 300), phase: { step: ph.step, jobs: ph.jobs, failed: true } });
    for (const f of getChange(id)!.findings) updateFinding(f, { status: 'open' });
  }
}

/** A ready change's one line: whether it was playtested (only on request), its review and criteria, its preview. */
export function readyDetail(v: any) {
  const played = playtested(v);
  const met = played && v.criteria?.length ? ` · criteria ${v.criteria.filter((k: any) => k.met === 'yes').length}/${v.criteria.length} met` : '';
  const what = played ? `playtest ${v.outcome ?? '?'} · review: ${v.verdict ?? 'n/a'}${met}`
    : v?.outcome === 'not played' ? `ready: agent's checks passed (the playtest asked for couldn't run: ${String(v.error ?? '').slice(0, 160)})`
      : "ready: agent's checks passed, pull request open (not playtested)";
  return `${what}${v?.preview ? ` · preview ${v.preview}` : ''}`;
}
/** Whether a change was playtested (on request, or by the old automatic verification): its result is on it. */
export const playtested = (v: any) => Boolean(v && (v.playtest || (v.outcome && v.outcome !== 'not played')));

/** The scenario the agent added or extended for its criteria (.hawkes/scenario.txt line 1) and its options (line 2, JSON). */
function agentScenarioOf(worktree: string): { scenario?: string; options?: Record<string, unknown> } {
  let lines: string[];
  try {
    lines = fs.readFileSync(path.join(worktree, '.hawkes', 'scenario.txt'), 'utf8').trim().split('\n');
  } catch {
    return {};
  }
  const scenario = /^[\w.-]{1,60}$/.exec(lines[0]?.trim() ?? '')?.[0];
  if (!scenario) return {};
  try {
    const o = JSON.parse(lines.slice(1).join('\n').trim() || 'null');
    return o && typeof o === 'object' && !Array.isArray(o) ? { scenario, options: o as Record<string, unknown> } : { scenario };
  } catch {
    return { scenario };
  }
}

/**
 * J's (or Talk's) request to playtest a ready change, with the same build, video and review the old automatic
 * verification had. The change is "verifying" meanwhile (resumable after a restart: changes.phase), then ready again
 * with the results; a playtest that can't run never fails it. Returns at once; the playtest goes on in the background.
 */
export function playtestChange(id: string, by = 'J') {
  const c = getChange(id);
  if (!c) throw new Error('No such change');
  if (c.infra) throw new Error(`${getInfra(c.product).name} changes have checks (CI, the tests, a smoke check), not a playtest.`);
  if (c.status !== 'ready') throw new Error(`The change is ${c.status}: a playtest can be asked for once it's ready.`);
  if (!fs.existsSync(c.worktree)) throw new Error(`${id}'s worktree is gone; revise it to rebuild it.`);
  if (running.has(id)) throw new Error(`${id} is busy`);
  const ph: Phase = { step: 'verify', tip: c.verify?.sha ?? git(c.worktree, ['rev-parse', 'HEAD']).out, jobs: {}, requested: by };
  update(id, { status: 'verifying', detail: 'playtesting the change', phase: ph, notes: [...c.notes, { at: Date.now(), by, text: 'asked for a playtest' }] });
  addLog(id, `playtest asked for by ${by}`);
  running.add(id);
  void work(id, undefined, undefined, ph, true).finally(() => {
    running.delete(id);
    void pump();
  });
  return getChange(id);
}

/**
 * Ready changes whose pull request was merged outside Studio (J merging on GitHub): marked merged, not left "ready"
 * with an Approve card. Only when GitHub merged the commit Studio has on record; a pull request merged before the
 * agent's later commits stays as it is (approve() says to revise it, publish() opens a new pull request).
 */
export async function syncMergedOutside() {
  const out: string[] = [];
  if (!process.env.GITHUB_TOKEN) return out;
  for (const c of listChanges({ status: 'ready', limit: 100 })) {
    if (!c.pr || running.has(c.id)) continue;
    const pr = await github(`/repos/${c.slug}/pulls/${c.pr}`).catch(() => null);
    if (!pr?.merged) continue;
    const head = String(pr.head?.sha ?? '');
    if (c.verify?.sha && head !== c.verify.sha) continue;
    await critical(`recording ${c.id} as merged`, async () => {
      if (getChange(c.id)?.status !== 'ready') return;
      const at = String(pr.merged_at ?? '').slice(0, 16).replace('T', ' ');
      const by = pr.merged_by?.login ? `${pr.merged_by.login} on GitHub` : 'GitHub';
      update(c.id, { status: 'merged', detail: `merged into ${c.base} outside Studio (${by}, ${at}): ${String(pr.merge_commit_sha ?? '').slice(0, 7)}${c.infra ? '' : ' (not live yet)'}`, notes: [...c.notes, { at: Date.now(), by, text: `merged on GitHub (pull request #${c.pr})` }] });
      addLog(c.id, `pull request #${c.pr} was merged outside Studio (${by}, ${at}): marked merged`);
      remember(c.id);
      for (const f of c.findings) updateFinding(f, { status: 'fixed', note: `merged into ${c.base} in ${c.pr_url} (outside Studio)` });
      await cleanup(c.id, { deleteBranch: false });
    });
    out.push(c.id);
  }
  return out;
}

/** A verification's Gen jobs, recorded on the change as they're submitted (and found again after a restart). */
type JobMemo = { get: (k: string) => string | undefined; set: (k: string, job: string) => void };

/**
 * Builds a Unity change's branch on the build server into its own website copy (changeSiteDir: a worktree of the
 * site repo at main), never the real website folder. A commit that was already built isn't built again.
 */
async function buildChange(c: Change, p: Product, jobs?: JobMemo): Promise<ChangeBuild> {
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
  // A build started before a Studio restart: wait for that same job (its website copy is already set up, and may hold its output).
  const prior = jobs?.get('build');
  const siteRepo = path.join(PROJECTS, siteTop);
  if (!prior) await critical(`making the website copy of ${c.id}`, async () => {
  const f = await gitAsync(siteRepo, ['fetch', '--quiet', 'origin']);
  if (!f.ok) throw new Error(`fetching ${siteTop} failed: ${f.err}`);
  const head = git(siteRepo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).out || 'origin/main';
  if (!fs.existsSync(path.join(copy, '.git'))) {
    git(siteRepo, ['worktree', 'prune']);
    const w = await gitAsync(siteRepo, ['worktree', 'add', '--detach', '--force', copy, head]);
    if (!w.ok) throw new Error(`making the website copy failed: ${w.err}`);
    shareWorktree(copy);
  } else {
    const r = await gitAsync(copy, ['checkout', '--quiet', '--force', '--detach', head]);
    if (!r.ok) throw new Error(`resetting the website copy failed: ${r.err}`);
    git(copy, ['clean', '-fdq']);
  }
  });
  const top = repoFor(p).top;
  const rel = (d: string) => path.relative(PROJECTS, d).replace(/\\/g, '/');
  const projectDir = path.join(c.worktree, path.relative(top, p.build.project));
  const siteDir = path.join(copy, path.relative(siteTop, p.site));
  addLog(c.id, prior ? `build: waiting for ${prior} again (started before Studio restarted)` : `build: ${sha.slice(0, 7)} on the build server (${p.build.method}) into ${rel(siteDir)}`);
  update(c.id, { detail: 'building the branch on the build server' });
  const job = await genRun('unity.build', p.id, { project: p.build.project, site: p.build.site, method: p.build.method, projectDir: rel(projectDir), siteDir: rel(siteDir) },
    (j) => update(c.id, { detail: `build server: ${j.detail ?? j.status}` }), undefined, { job: prior, onSubmit: (id) => jobs?.set('build', id) });
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

async function verifyChange(c: Change, p: Product, findings: any[], jobs?: JobMemo) {
  let dir: string;
  let build: ChangeBuild | null = null;
  if (p.engine === 'unity' || p.build) {
    // Unity: build the branch, then serve that build the way the site's local server would.
    build = await buildChange(c, p, jobs).catch((e: any): ChangeBuild => ({ sha: '', ok: false, at: Date.now(), error: String(e.message ?? e).slice(0, 500), retry: true }));
    if (!build.ok) return { outcome: 'build failed', error: build.error, build };
    dir = path.join(changeSiteDir(c.id), path.relative(p.site.split('/')[0], p.local.dir));
  } else {
    dir = path.join(c.worktree, repoFor(p).sub, path.relative(p.repo, p.local.dir));
  }
  // The scenario the agent added or extended for its criteria (.hawkes/scenario.txt), else the finding's, else the first.
  // A second line in scenario.txt may give the scenario's options as JSON ({"stage":"neon-pit"}): the new content to play.
  const { scenario: agentScenario, options: agentOptions } = agentScenarioOf(c.worktree);
  const scenario = agentScenario ?? findings.map((f: any) => f.scenario).find((s: string) => s && s.endsWith('@local'))?.split('@')[0] ?? (p.playtests.find((t) => t.where === 'local')?.scenario ?? 'smoke');
  const mode = agentScenario ? undefined : p.playtests.find((t) => t.where === 'local' && (t.scenario ?? t.mode) === scenario)?.mode;
  const port = 8800 + (parseInt(c.id.slice(2, 6), 16) % 200);
  // After a Studio restart: a playtest that finished is kept and one still queued is waited for, but one that was
  // playing lost the page Studio served (its server stopped with Studio), so it is played again.
  let prior = jobs?.get('playtest') ? await gen.job(jobs.get('playtest')).catch(() => null) : null;
  if (prior && !['done', 'queued'].includes(prior.status)) {
    addLog(c.id, `playtest ${prior.id} was ${prior.status} when Studio restarted (its page server stopped); playing it again`);
    if (prior.status === 'running') await gen.cancel(prior.id).catch(() => {});
    prior = null;
  }
  const url = prior?.status === 'done' ? localUrl(p) : await serveDir(p, dir, port);
  try {
    const run = await genRun('playtest.run', p.id, { url, mode: mode ?? (p.contract ? 'contract' : 'auto'), ...(mode ? {} : { scenario }), ...(mode === 'site' ? { maxPages: 40 } : {}), ...(agentScenario && agentOptions ? { options: agentOptions } : {}) },
      undefined, undefined, { job: prior?.id, onSubmit: (id) => { jobs?.set('playtest', id); jobs?.set('review', ''); } });
    if (run.status !== 'done') return { outcome: 'failed', error: run.error, playtest: run.id, build };
    // A verify review (review.ts): did the change work (it says by id whether the findings look fixed), did anything regress.
    // A roadmap task's acceptance criteria go with it and are judged one by one (acceptance.ts).
    const rev = await genRun('playtest.review', p.id, reviewParams(p, run.id, 'verify', {
      ...(c.criteria.length ? { criteria: c.criteria } : {}),
      focus: c.request ? `This is a proposed change J asked for: "${c.request.slice(0, 1500)}". Say clearly whether it does that well, and whether anything got worse.${c.criteria.length ? ` Judge each acceptance criterion: ${c.criteria.map((k, i) => `(${i + 1}) ${k}`).join(' ')}` : ''}` : `This is a proposed fix for: ${findings.map((f: any) => `"${f.title}" (${f.detail})`).join('; ')}. Say clearly whether it is fixed, and whether anything got worse.`,
    }), undefined, undefined, { job: jobs?.get('review') || undefined, onSubmit: (id) => jobs?.set('review', id) });
    const v = rev.result ?? {};
    const video = run.outputs?.find((o: any) => o.kind === 'video')?.asset ?? null;
    const criteria = c.criteria.length ? await judgeCriteria(c.criteria, v, run.result, c.summary) : undefined;
    return { outcome: run.result?.outcome, scenario, ...(agentScenario && agentOptions ? { options: agentOptions } : {}), playtest: run.id, review: rev.id, verdict: v.verdict, changeWorked: v.changeWorked, known: v.known ?? [], summary: v.summary, scores: v.scores, findings: (v.findings ?? []).slice(0, 8), video, url: localUrl(p), build, ...(criteria ? { criteria } : {}) };
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
    const child = spawnShell(cmd, { cwd, env });
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
  const mem = briefSection({ product: t.id, role: 'infra', text: `${c.request ?? ''} ${c.title ?? ''}` });
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
7. ${LEARNED_ASK.replace(/\n/g, '\n   ')}
${mem.text ? `\n${mem.text}` : ''}`;
  fs.writeFileSync(path.join(dir, 'brief.md'), brief);
  return path.join(dir, 'brief.md');
}

async function workInfra(id: string, note?: string, resumed?: Phase | null) {
  let c = getChange(id)!;
  const t = getInfra(c.product);
  const s = agentSettings();
  const repoDir = path.join(PROJECTS, c.repo);
  // The same steps as a product change (work()), so a Studio restart carries on from where it was.
  const ph: Phase = resumed ?? { step: 'prepare', note };
  ({ note } = ph);
  const save = (patch: Partial<Phase>, extra: Record<string, any> = {}) => {
    Object.assign(ph, patch);
    update(id, { ...extra, phase: ph });
  };
  try {
    if (resumed) addLog(id, `Studio restarted: carrying on from the ${ph.step} step`);
    else save({}, { status: note ? 'revising' : 'working', detail: 'preparing the worktree' });

    if (ph.step === 'prepare') {
      update(id, { detail: 'preparing the worktree' });
      await critical(`making the worktree of ${id}`, async () => {
        if (!fs.existsSync(c.worktree)) {
          fs.mkdirSync(WORK(), { recursive: true });
          // Only refs move in the server's checkout; its files only change through deploy/hawkes-pull.mjs.
          const f = await gitAsync(repoDir, ['fetch', '--quiet', 'origin']);
          if (!f.ok) throw new Error(`fetch failed: ${f.err}`);
          git(repoDir, ['worktree', 'prune']);
          const has = git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${c.branch}`]).ok;
          const w = await gitAsync(repoDir, ['worktree', 'add', ...(has ? [c.worktree, c.branch] : ['-b', c.branch, c.worktree, `origin/${c.base}`])]);
          if (!w.ok) throw new Error(`worktree failed: ${w.err}`);
          shareWorktree(c.worktree);
          // A warm start: node_modules from a checkout with the same lockfile (warm.ts), not a fresh npm ci.
          warmDeps(c.worktree, c.repo, (s) => addLog(id, s));
      lfsPull(c.worktree, (s) => addLog(id, s));
        } else if (note) {
          // Another pass: bring the branch up to date with main first (main may have moved, or the merge conflicted).
          await gitAsync(repoDir, ['fetch', '--quiet', 'origin']);
          const m = await gitAsync(c.worktree, ['merge', '--no-edit', `origin/${c.base}`]);
          if (!m.ok) git(c.worktree, ['merge', '--abort']);
          addLog(id, m.ok ? `merged origin/${c.base} into the branch` : `merging origin/${c.base} conflicted; the agent works from the branch as it was`);
        }
      });
      await npmCi(id, c.worktree);
      writeInfraBrief(c, t, note);
      save({ step: 'agent', before: git(c.worktree, ['rev-parse', 'HEAD']).out, proc: undefined });
    }

    if (ph.step === 'agent') {
      update(id, { detail: 'Claude is working on it' });
      if (!ph.proc) addLog(id, resumed ? 'agent: it ran inside Studio, which restarted; starting the pass again' : `agent started`);
      const r = await agentPass(id, ph, save, s, infraEnv({ agent: true }));
      save({ step: 'publish', result: r.result, proc: undefined }, { cost: getChange(id)!.cost + r.cost });
    }

    if (ph.step === 'publish') {
      c = getChange(id)!;
      // The agent could write its worktree: Studio's git runs there only while it still links to this repo.
      assertWorktree(c.worktree, repoDir);
      const summaryFile = path.join(c.worktree, '.hawkes', 'summary.md');
      const summary = fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8').trim() : ph.result ?? '';
      const commits = git(c.worktree, ['log', '--format=%h %s', `origin/${c.base}..HEAD`]).out.split('\n').filter(Boolean);
      const changedNow = git(c.worktree, ['rev-parse', 'HEAD']).out !== ph.before;
      if (!commits.length || (note && !changedNow)) {
        update(id, { status: 'failed', detail: 'the agent made no commit', summary, commits, phase: null });
        return;
      }
      // Guard rails, before anything leaves the server.
      const files = git(c.worktree, ['diff', '--name-only', `origin/${c.base}...HEAD`]).out.split('\n').filter(Boolean);
      const bad = guardFiles(t.id, files, [c.request ?? '', ...c.notes.map((n) => n.text)].join('\n'));
      if (bad.length) {
        const list = bad.map((b) => `${b.file} (${b.why === 'forbidden' ? 'never changed by agents' : 'only when J names it'})`).join(', ');
        addLog(id, `guard rails: ${list}`);
        update(id, { status: 'failed', detail: `not pushed: it changes protected files: ${list}`.slice(0, 300), summary, commits, phase: null });
        return;
      }
      const diffstat = git(c.worktree, ['diff', '--shortstat', `origin/${c.base}...HEAD`]).out;
      update(id, { summary, commits, diffstat, detail: 'pushing and opening the pull request' });
      const body = `${summary}\n\n---\n**J asked:** ${c.request ?? ''}\n\nMade by a Hawkes Studio agent. Approving it in Studio merges it into main, and ${t.name} deploys itself once CI passes (the control server pulls it, restarts the service and rolls back if it isn't healthy).\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
      await publish(id, { force: Boolean(note), title: c.title, body });
      save({ step: 'verify', tip: git(c.worktree, ['rev-parse', 'HEAD']).out, verify: undefined }, { status: 'verifying', detail: 'checking: CI on the pull request, the checks, a smoke check' });
    }

    // Verify (checked again from the start after a restart: CI is GitHub's, the checks and smoke check take minutes), then ready.
    if (resumed && ph.step === 'verify') update(id, { status: 'verifying', detail: 'checking: CI on the pull request, the checks, a smoke check' });
    const v = ph.step === 'finish' ? ph.verify : await verifyInfra(getChange(id)!, t);
    update(id, { status: 'ready', detail: `${v.outcome}: ${v.summary}`.slice(0, 300), verify: v, phase: null });
    // Talk tells J in the chat; no phone notification (only failures and milestones go to the phone).
  } catch (e: any) {
    addLog(id, `error: ${e.message}`);
    update(id, { status: 'failed', detail: String(e.message).slice(0, 300), phase: { step: ph.step, failed: true } });
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
  if (c.verify?.sha && pr.head.sha !== c.verify.sha) throw new Error(`Pull request #${c.pr}'s head moved after the checks (checked ${String(c.verify.sha).slice(0, 7)}, now ${String(pr.head.sha).slice(0, 7)}). Revise ${c.id} so the new head is checked.`);
  const ci =await ciChecks(c.slug, pr.head.sha, { waitMs: 0 });
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
  remember(c.id);
  await cleanup(c.id, { deleteBranch: true });
  return getChange(c.id);
}

/**
 * The commit an approval merges: the pull request's head, which must be the branch tip that was verified. Refuses when
 * the pull request isn't open (merged or closed outside Studio: whatever came after that never reaches beta through it)
 * or when its head moved after verification (a push nobody verified).
 */
async function verifiedHead(c: Change) {
  const pr = await github(`/repos/${c.slug}/pulls/${c.pr}`);
  const head = String(pr.head?.sha ?? '');
  if (pr.state !== 'open') {
    throw new Error(pr.merged
      ? `Pull request #${c.pr} was already merged (${String(pr.merged_at ?? '').slice(0, 16)}, outside this approval) at ${head.slice(0, 7)}; commits the agent pushed after that are not on ${c.base}. Revise ${c.id} so Studio opens a new pull request for them.`
      : `Pull request #${c.pr} is closed. Revise ${c.id} to open a new one, or close the change.`);
  }
  // Changes verified before Studio recorded the verified commit: the worktree's head is what was pushed and played.
  const verified = c.verify?.sha || (fs.existsSync(c.worktree) ? git(c.worktree, ['rev-parse', 'HEAD']).out : '');
  if (!verified) throw new Error(`${c.id} has no verified commit on record; revise it so it is verified again.`);
  if (head !== verified) throw new Error(`Pull request #${c.pr}'s head moved after verification (verified ${verified.slice(0, 7)}, now ${head.slice(0, 7)}): not merging what wasn't checked. Revise ${c.id} so the new head is checked.`);
  return head;
}

/**
 * J's approval: merge the pull request (squash) into beta. Nothing goes live: the beta site is rebuilt and beta is
 * playtested with the change in; going live is deploy() (the deploy plan, then "DEPLOY <product>").
 */
export async function approve(id: string, { confirm, by = 'J', origin, auto = false }: { confirm?: string; by?: string; origin?: string | null; auto?: boolean } = {}) {
  const c = getChange(id);
  if (!c) throw new Error('No such change');
  if (confirm !== `MERGE ${id}`) throw new Error(c.infra
    ? `Approving merges this change into main, and ${getInfra(c.product).name} deploys itself once CI passes (a restart). Send confirm: "MERGE ${id}" (J's call).`
    : `Approving merges this change into ${BETA} (the beta site; going live is a separate step). Send confirm: "MERGE ${id}" (J's call).`);
  if (!c.pr) throw new Error('This change has no pull request');
  if (c.infra) {
    if (c.status !== 'ready') throw new Error(`The change is ${c.status}, not ready to approve.`);
    return critical(`merging ${id} into main`, () => approveInfra(c, by));
  }
  // An agent still on it moves the branch: what would be merged isn't what was verified.
  if (['queued', 'working', 'revising', 'verifying'].includes(c.status)) throw new Error(`The change is ${c.status}: its branch is still moving. Approve it once it's ready (verified).`);
  // A merge is a critical section (drain.ts): a deploy waits for it rather than cut it off between GitHub and Studio's records.
  return critical(`merging ${id} into ${BETA}`, async () => {
    const sha = await verifiedHead(c);
    // Changes opened before the beta lane target main: point them at beta first, so approving never goes live.
    if (c.base !== BETA) {
      await ensureBeta(path.join(PROJECTS, c.repo));
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
      // `sha`: GitHub refuses the merge if the pull request's head moved since the check above.
      m = await github(`/repos/${c.slug}/pulls/${c.pr}/merge`, { method: 'PUT', body: { merge_method: 'squash', sha, commit_title: `${c.title} (#${c.pr})` } });
    } catch (e: any) {
      // Usually a conflict with what's on beta now (devtools saves, another change). J hears it in Talk with the files
      // (an automatic merge says it in one line itself: autoMergeBeta).
      if (auto) throw e;
      const files = await github(`/repos/${c.slug}/pulls/${c.pr}/files?per_page=100`).then((fs: any[]) => fs.map((f) => f.filename)).catch(() => []);
      const { postNotice } = await import('./talk.ts');
      postNotice(`Merge stopped: ${c.title}`, `Merging ${id} (${c.pr_url}) into ${BETA} failed: ${e.message ?? e}\n\nThe change touches: ${files.slice(0, 30).join(', ') || '(unknown)'}\n\nIf beta changed those files since (devtools saves or another change), ask the agent to update its branch from ${BETA} (revise ${id}) and approve again.`);
      throw e;
    }
    void pullDev(c.product, `after merging ${id}`).catch((e) => console.warn(`[studio] beta working copy after ${id}: ${e.message ?? e}`));
    update(id, { status: 'merged', detail: `merged into ${BETA} by ${by}: ${String(m.sha ?? '').slice(0, 7)} (not live yet)`, notes: [...c.notes, { at: Date.now(), by, text: auto ? `merged into ${BETA} automatically (ready: the agent's checks passed)` : `approved and merged into ${BETA}` }], ...(auto ? { auto_merge: 'merged' } : {}) });
    remember(id);
    for (const f of c.findings) updateFinding(f, { status: 'fixed', note: `merged into ${BETA} in ${c.pr_url} (goes live with the next deploy)` });
    await cleanup(id, { deleteBranch: true });
    // Beta moved: its pre-deploy build, its build (Unity), the beta site and a local playtest of it follow, in the background.
    // A roadmap task's criteria are judged again on beta, on the scenario its agent wrote for them.
    void import('./pipeline.ts').then(({ startBeta }) => startBeta(c.product, { focus: `Just merged into beta: ${c.title}. Check it works and nothing regressed.`, origin, criteria: c.criteria, scenario: c.verify?.scenario, options: c.verify?.options })).catch((e) => console.warn(`[studio] beta after ${id}: ${e.message ?? e}`));
    return getChange(id);
  });
}

/**
 * A ready product change goes into beta by itself (J, 2026-10-17: no Approve card, no PM gate), through approve()'s
 * merge (the devtools flush and pull, the critical section, the beta run after it). One that can't stays ready for a
 * person (the Changes tab's Merge button), with one line in Talk saying why; a merged one gets one line too. Never the
 * phone, never Studio or Gen (their merges into main stay J's). The PM still judges a task's criteria on beta.
 */
export async function autoMergeBeta(id: string) {
  const c = getChange(id);
  if (!c || c.infra || c.status !== 'ready') return null;
  const fail = async (why: string) => {
    update(id, { auto_merge: `failed: ${why}`.slice(0, 500), detail: `couldn't merge into ${BETA} by itself: ${why}`.slice(0, 300) });
    addLog(id, `not merged into ${BETA} automatically: ${why}`);
    const { autoMergeFailedNotice, tellAbout } = await import('./followup.ts');
    await tellAbout(getChange(id)!, `Couldn't merge: ${c.title ?? id}`, autoMergeFailedNotice(getChange(id)!, why)).catch((e) => console.warn(`[studio] auto-merge notice ${id}: ${e.message ?? e}`));
    return null;
  };
  // A canon conflict never merges by itself (acceptance.ts gate); a requested playtest that failed doesn't either.
  const g = gate(c.verify, c.criteria);
  if (!g.pass) return fail(g.why.join('; ').slice(0, 300));
  if (!c.pr) return fail('it has no pull request');
  try {
    const merged = await approve(id, { confirm: `MERGE ${id}`, by: 'Studio (auto-merge)', origin: c.origin ?? null, auto: true });
    addLog(id, `merged into ${BETA} automatically`);
    const { autoMergedNotice, tellAbout } = await import('./followup.ts');
    const beta = await import('./dev.ts').then(({ betaUrl }) => betaUrl(getProduct(c.product))).catch(() => null);
    await tellAbout(merged!, null, autoMergedNotice(merged!, beta)).catch((e) => console.warn(`[studio] auto-merge notice ${id}: ${e.message ?? e}`));
    return merged;
  } catch (e: any) {
    return fail(String(e.message ?? e).slice(0, 300));
  }
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
    remember(id);
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
    remember(id);
    void pump();
  });
  return getChange(id);
}

export async function close(id: string, by = 'J') {
  const c = getChange(id);
  if (!c) throw new Error('No such change');
  return critical(`closing ${id}`, () => closeNow(c, by));
}
async function closeNow(c: Change, by: string) {
  const id = c.id;
  if (c.pr) await github(`/repos/${c.slug}/pulls/${c.pr}`, { method: 'PATCH', body: { state: 'closed' } }).catch(() => {});
  update(id, { status: 'closed', detail: `closed by ${by}`, notes: [...c.notes, { at: Date.now(), by, text: 'closed' }] });
  remember(id);
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

/**
 * After a restart (a deploy): changes that were being worked on carry on from their recorded step, reattached to the
 * same agent process and Gen jobs (work()). Ones with no step recorded (from before steps were) go back to the queue.
 */
export function resumeChanges() {
  const out: string[] = [];
  for (const c of listChanges({ status: 'working,verifying,revising', limit: 200 })) {
    const ph = phaseOf(c.id);
    if (!ph?.step || ph.failed) {
      update(c.id, { status: 'queued', detail: 'requeued after a restart' });
      continue;
    }
    if (running.has(c.id)) continue;
    running.add(c.id);
    out.push(c.id);
    void work(c.id, undefined, undefined, ph).finally(() => {
      running.delete(c.id);
      remember(c.id);
      void pump();
    });
  }
  // A restart between "ready" and its automatic merge: the merge is tried again (approve() refuses a moved head).
  for (const c of listChanges({ status: 'ready', limit: 100 })) {
    if (c.auto_merge !== 'trying' || c.infra || running.has(c.id)) continue;
    void autoMergeBeta(c.id).catch((e) => console.warn(`[studio] auto-merge ${c.id}: ${e.message ?? e}`));
  }
  return out;
}
// The server calls it once it listens (server.ts); a process that only imports this module (the CLI, tests) doesn't.
setTimeout(() => void pump(), 5000).unref();
// A safety net for the local queue (no GitHub involved): queued changes never wait on a slot nobody frees.
setInterval(() => void pump(), 60_000).unref();
