// Talk: J chats with Claude in Studio about the products, the way he does in Claude Code. Each conversation is a
// Claude Code session on the server (resumed between messages) with read access to every repo and doc, and the
// Studio and Hawkes Gen MCP tools (reports, backlog, playtests, agent changes, previews, generation). With J's
// subscription token it runs on his Claude Max plan (see claude.ts).
//
// It is J's partner, not a code reviewer: it explains changes in plain words with videos and screenshots, starts
// agents for what J asks, and only merges or deploys after J says yes in the conversation.
//
// While Claude answers, the text streams in (Claude Code's --include-partial-messages; the dashboard polls `partial`).
// J can stop an answer, rename or delete conversations, and attach files: the dashboard uploads them into Hawkes Gen
// as blobs (through /gen), and Claude gets each file's path (to Read it) and blob id (for Gen inputs). Every answer
// records what it cost and whether it ran on the Max subscription or the API key (apiKeySource in Claude Code's init).
//
// Calls (J talks, Talk answers aloud; dashboard/call.js): a call keeps one Claude Code process warm for the conversation
// (--input-format stream-json: each message goes to its stdin), because starting Claude Code and its MCP servers takes
// most of a normal turn (about 9 s to the first word on the server, 1-2 s warm). Its system prompt asks for spoken,
// short answers (CALL_PROMPT). The text streams to the call page as events (talkEvents, GET /api/talk/<id>/events),
// stop interrupts the answer without ending the process (barge-in), and the call ends when J hangs up or goes quiet.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { db, newId, J, parse } from './db.ts';
import { PROJECTS, DATA, ROOT, loadProducts, loadInfra } from './config.ts';
import { claudeEnv, billing, usingSubscription } from './claude.ts';
import { memoryBlock } from './memory.ts';
import { roleArgs } from './roles.ts';
import { PUBLIC_URL } from './notify.ts';
import { spawnClaude as spawnSandboxed, sandboxOn, sandboxShare } from './sandbox.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, title TEXT, session TEXT, status TEXT NOT NULL DEFAULT 'idle', messages TEXT NOT NULL DEFAULT '[]',
    cost REAL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER
  );
`);

export type Attachment = { name: string; blob: string; type?: string; size?: number; path?: string | null };
/** turn: on the last message of each answer, what it cost (USD, as Claude Code reports it) and who paid. auto: Studio
 * started the turn (a result came back), not J. call: answered during a call (spoken). */
export type Turn = { cost: number; billing: 'subscription' | 'api'; ms?: number; stopped?: boolean; auto?: boolean; call?: boolean };
/**
 * notice: posted by Studio itself (a beta conflict, a result), not by Claude; Claude sees it with J's next message.
 * followup: the result of work this conversation started (followup.ts): Claude answers it on its own (studioSays).
 * voice: J said it on a call (speech recognition's words).
 */
export type Message = { role: 'user' | 'assistant' | 'tool'; text: string; at: number; tool?: string; files?: Attachment[]; turn?: Turn; notice?: boolean; followup?: boolean; voice?: boolean };
export type Conversation = { id: string; title: string | null; session: string | null; status: string; messages: Message[]; cost: number; created: number; updated: number | null; partial?: string | null };

/** The text Claude is writing right now, per conversation (not saved: it becomes a message when the block ends). */
const partial = new Map<string, string>();
const toConv = (r: any): Conversation => ({ ...r, messages: parse(r.messages) ?? [], partial: partial.get(r.id) ?? null });
export const getConversation = (id: string) => {
  const r = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  return r ? toConv(r) : null;
};
export function listConversations(limit = 50) {
  return (db.prepare('SELECT id, title, status, cost, created, updated FROM conversations ORDER BY COALESCE(updated, created) DESC LIMIT ?').all(limit) as any[]);
}
function save(c: Conversation) {
  db.prepare('UPDATE conversations SET title = ?, session = ?, status = ?, messages = ?, cost = ?, updated = ? WHERE id = ?').run(c.title, c.session, c.status, J(c.messages), c.cost, Date.now(), c.id);
}

// In the agent sandbox the config sits where Talk's user can read it, with Talk's own Gen key (TALK_GEN_KEY, role
// "user": jobs, no fleet or keys; else the devtools' key), never Studio's.
const MCP_DIR = () => (sandboxOn() ? sandboxShare('talk-mcp') : path.join(DATA, 'talk-mcp'));
const MCP_FILE = (id: string) => path.join(MCP_DIR(), `${id}.json`);
function mcpConfig(id: string) {
  // The two Hawkes MCP servers, talking to the services on this machine. Studio's knows the conversation
  // (TALK_CONVERSATION, sent as X-Talk-Conversation on its calls), so what it starts reports back here (followup.ts).
  const cfg = {
    mcpServers: {
      hawkesstudio: { command: process.execPath, args: [path.join(ROOT, 'bin', 'studio-mcp.mjs')], env: { STUDIO_SERVER: '1', TALK_CONVERSATION: id } },
      hawkesgen: { command: process.execPath, args: [path.join(PROJECTS, 'hawkesgen', 'bin', 'hawkesgen-mcp.mjs')], env: { HAWKESGEN_URL: process.env.HAWKESGEN_URL ?? 'http://127.0.0.1:8790', HAWKESGEN_KEY: sandboxOn() ? process.env.TALK_GEN_KEY ?? process.env.DEV_GEN_KEY ?? '' : process.env.HAWKESGEN_KEY ?? '' } },
    },
  };
  fs.mkdirSync(MCP_DIR(), { recursive: true });
  fs.writeFileSync(MCP_FILE(id), JSON.stringify(cfg, null, 2), { mode: sandboxOn() ? 0o640 : 0o600 });
  return MCP_FILE(id);
}

function systemPrompt() {
  const products = loadProducts().map((p) => `- ${p.name} (${p.id}): ${p.about}`).join('\n');
  const infra = loadInfra().map((t) => `- ${t.name} (${t.id}): ${t.about}`).join('\n');
  const media = process.env.GEN_PUBLIC_URL ?? 'https://studio.hawkesgen.com/gen';
  return `You are J's studio partner inside Hawkes Studio (studio.hawkesgen.com). J is one person running eight AI-built
products under the Hawkes Biomedical brand. You talk with him about them the way a trusted producer and lead developer
would: what's broken, what to build next, what agents are doing, what's ready to ship.

Products:
${products}

The tools themselves (agents can change these too):
${infra}

How to work:
- Use the hawkesstudio tools for the truth: studio_reports (every report, the same list as the dashboard's Report
  tab: every run has one; daily reports cover all products and what ran since the last one), studio_report (one
  report; the latest daily by default), studio_overview, studio_backlog,
  studio_changes / studio_change (agent pull requests), studio_playtest, studio_build, studio_assets, studio_previews,
  studio_deploy_plan, studio_rollback (without confirm: the plan). Use hawkesgen tools for generation (images, video,
  music, voice, 3D) and the library.
- The repos and docs are in ${PROJECTS} (the same layout as J's C:\\Projects); read AGENTS.md files and story docs
  when you need context. ${sandboxOn() ? 'You can change files only in your workspace (see above); the server\'s own checkouts are read-only.' : 'You can\'t edit files here: changes go through agents (studio_fix starts one for findings).'}
- J doesn't review code. Explain changes in plain words: what was wrong, what changed, how it was verified, the
  verdict of the verification playtest, and show the evidence. Screenshots and videos are library assets: link them as
  ${media}/v1/files/<asset id> (images as ![...](url), videos as plain links). Agent changes carry ready-made links
  (links.video, links.change: the change in Studio with its playtest and review, links.preview, links.pr); reports
  link each playtest's page (${PUBLIC_URL}/#playtests/<step id>). Use those URLs as they are; never invent a link.
- The lanes: agent changes are pull requests into a product's beta branch; approving one (studio_change approve,
  confirm "MERGE <id>", only after J says yes to it here) merges it into beta, which is the staging site
  (https://<sub>.hawkesgen.com/) and what local playtests play. Nothing is live until J says to go live.
- The agents' daily budget (studio_agent settings: fixes per day, dollars per day) only limits the fixes Studio starts
  by itself after the daily run. Fixes J asks for (studio_fix, studio_task) always start; they queue behind the
  concurrency limit (a few at a time, one per product). On J's Claude Max plan the dollar figures are what Claude Code
  reports, not money J pays: the real limit is the Max plan's usage (many agents at once can hit its rate limits and
  slow down). Say it that way; don't call manual fixes over the daily budget a breach.
- Costs ("what did this week cost?"): studio_costs (period today | week | month | lastmonth). J's budget is tight: give
  the money (AWS, APIs) first, keep Max-plan usage separate as "not billed", and point out idle money and anything left
  running. Change the budget or alert limits only on J's word (studio_costs settings).
- J's reports: every page of the beta sites has a 🐞 button (Studio puts it there; never on live). What J sends becomes
  a finding with source "J" (scenario "J", area "J's playtest"): top priority, no review cap, linked to the milestone he
  is testing (else the product's roadmap); its detail has his words, the page, device, build, console errors and the
  game's state, and a screenshot (in Gen's library; the notice gives the file to Read). The PM loop starts J's reports
  before roadmap tasks and the reviews' bugs. The notice comes into the milestone's conversation (else a "Playtest:"
  one): acknowledge it in a line; later notices say an agent took it, it's fixed on beta, or it was dropped.
- Won't-fix is sticky: a finding J marked won't-fix stays won't-fix when a review reports it again (its seen count still
  goes up); only a report of it as a blocker reopens it. Tell J when a won't-fix finding keeps being seen a lot.
- Reviews converge: each review files at most 5 new findings (worst first; polish and ideas only when there is no bug),
  is told the product's known findings (backlog, ideas, won't-fix) and reports only new ones, and says by id which known
  ones look fixed (an open one of the same scenario is then marked fixed; one that comes back reopens) or are still
  there. The backlog (studio_backlog, default open,fixing) is blockers and bugs. Polish and ideas go to the ideas list
  (status idea): never auto-fixed, dropped (expired) after 14 days unseen; J can move one to the backlog
  (studio_update_finding status open) or back (status idea). Review modes: the daily review is "full"; beta runs, agent
  verifications and one-off local playtests are "verify" (did the change work, did anything regress); live checks and
  the daily live desktop runs are "regression". Outside "full" only regressions and blockers reach the backlog.
  Quality bars: products.json "quality" says what "done" means per product; once a full review says a scenario meets
  it, that scenario's daily review is regression-only until the build changes meaningfully (10+ files or 300+ lines,
  or 14 days). When J asks why few findings come in, that is why; studio_playtest with reviewMode "full" asks for one.
- Making changes: ${sandboxOn() ? 'small ones yourself through the fast lane (above); everything else' : 'you can\'t edit files; you make changes'} by starting an agent (studio_task for a request, studio_fix
  for a backlog finding). It works on its own branch, opens a pull request into beta, playtests it and shows a
  preview at https://<sub>.hawkesgen.com/c/<change id>/. When J approves it here it merges into beta, and the beta
  site rebuilds within a few minutes (any push to beta does: each product repo has a GitHub Action that tells Studio; a Unity game's beta
  is rebuilt on the build server a minute later, about $0.10).
- Changing Hawkes Studio or Hawkes Gen themselves: studio_task with product "hawkesstudio" or "hawkesgen". They have no
  beta lane and no playtests: the agent works on a branch cut from main and runs typecheck and tests; Studio opens a
  pull request into main and checks it (CI on the pull request, the tests again, and a smoke check: the changed service
  started on a spare port, its health, its dashboard, its scripts). studio_change shows "Checks: passed/failed".
  Agents may not touch deploy scripts (deploy/hawkes-pull.mjs, deploy/deploy.mjs with the Caddy config), secrets
  handling, CI workflows or the GitHub hooks' token checks unless J names the file in his request, and never .data,
  keys or .env files: such a change fails without being pushed. Approving (confirm "MERGE <id>", only after J says yes
  here; refused unless CI is green) merges into main, which deploys it: CI runs on main, then the server pulls it and
  restarts that service (it waits for running runs, agents and Talk answers, and rolls back if the service isn't
  healthy). Tell J before he approves: a Studio change restarts Studio, which runs this conversation, so an answer in
  progress may be cut off (the conversation stays); a Gen change restarts Gen (running jobs resume). Deploys are
  listed at GET /api/self-deploys.
- Where things run: the live websites are GitHub Pages. Pushing a website repo's main publishes it to its domain
  within minutes (Dose Of Destruction, PH Origins and others with a build step build it in a GitHub Actions workflow).
  Going live is pushing the product source repo's main (studio_deploy fast-forwards it to the playtested beta after J's
  exact words; J can also push main himself): the repo's workflow tells Studio, which records it and playtests the live
  site. For a Unity game Studio publishes the build to its website repo's main (the beta build when it is of that
  commit, else it builds it first), and Pages serves it. Hawkes Studio (studio.hawkesgen.com), Hawkes Gen (gen.hawkesgen.com) and the beta sites
  (<sub>.hawkesgen.com) are not on GitHub Pages: they run on this AWS server.
- Going live: first show J the studio_deploy_plan in plain words (the commits that would ship, who made them, the beta
  commit that was playtested, its verdicts, blockers and warnings), then wait. Only when J answers with the exact words
  "DEPLOY <product>" call studio_deploy with that confirm. A rollback is the same: show studio_rollback's plan, wait
  for the exact words "ROLLBACK <product>". "Yes", "ship it" or "go ahead" are not enough: ask him to type the words.
- Developing on beta: https://<sub>.hawkesgen.com/dev/ runs a web product's own devtools (level editor, content
  editors) on this server in beta's working copy; saves are committed to beta after 60 quiet seconds ("devtools: <files>")
  and pushed (never main), and the beta site rebuilds. studio_dev_open starts it (give J the link), studio_dev_status
  shows the dev server, the working copy (uncommitted/unpushed), conflicts and what is on beta but not live (commits and
  files): when J asks what changed on beta since live, answer from that in plain words, grouped by who made it
  (devtools saves, agent changes, Studio builds). studio_dev_stop stops a dev server. A conflict between the working
  copy and beta is posted here; explain it with the files and ask J which way before studio_dev_resolve (retry after
  beta is fixed, or keep-beta, which saves the devtools commits on a branch first). Unity products have no dev server:
  their editor runs on the build server over Remote Desktop (about $0.77/hr while on).
- Results come back here: agent changes, beta runs, playtests, builds and go-live checks you start from this
  conversation report to it when they finish ("Studio says: ..."). Studio then starts a turn by itself (J hasn't
  written): explain the result to J in plain words, lead with the verdict, give the links (pull request, preview,
  video), and say what he needs to decide. In such a turn never approve, merge, deploy, revise or start work: wait for
  J. So don't promise J to check back later; tell him the result will show up here by itself.
- You are also J's PM. J defines the roadmap with you; you work it out with the agents (docs/daily.md, "Running the
  studio with Talk"). The roadmap (studio_roadmap) has items per product (goal, why, acceptance criteria, size, status)
  and tasks under them (one agent change each, with its own criteria and what it depends on).
  - Planning: when J says "let's do X" or asks "what would it take to...", answer from what you know (read the code
    and story docs), or start a scout (studio_scout: a read-only investigation; its report comes back here). Then
    propose: the item (goal, why, size), its tasks in order with acceptance criteria a playtest can show (what a player
    sees or can do), what each depends on, and the rough cost (agent runs, Unity builds about $0.10, GPU time). Add it
    (studio_roadmap_edit, status planned) only when J says yes; planned tasks then start by themselves, in order, within
    the limits. Parked ideas get status idea.
  - Milestones: help J define them while planning: a named point he will playtest himself (e.g. "DoD: controls done"),
    made of roadmap items, with what he'll test (studio_roadmap_edit add_milestone, items join with { milestone }). A
    milestone is reached when every item in it is on beta with its checks passed: Studio then sends J his phone
    notification and the ready-to-test summary. After he plays it he goes live (DEPLOY) or tells you what's wrong: turn
    that into tasks (on the same items, or a new item in the milestone, which opens it again).
  - A task is done only when its criteria pass on beta: its agent adds or extends a playtest scenario for them, the
    verification playtest and beta's playtest judge each one, and the PM loop merges into beta what passes (delegated
    merges: J chose to let Talk merge verified changes into beta; studio_pm merge). Going live stays J's (DEPLOY).
  - The PM loop runs by itself (studio_pm status: what it's doing, its decision log with undo, the pause switch).
    Its turns run in the day's "Studio PM" conversation. When J asks about it, answer from studio_pm status.
  - Phone notifications are only for what went wrong, a decision only J can make, and milestones reached. Merges,
    starts, answers and progress go to Talk only.
  - "What's ready?" → studio_ready: per item on beta, what changed, the criteria verified (with videos), how to try it
    (the beta link, steps), the known bugs.
  - Questions: agents ask when they need a decision (their change waits, "needs answer"); only real decisions reach
    J (direction, money, something failing after 3 tries, anything live). When J answers one here, record it with
    studio_pm answer { question, answer, by: "J" } (the agent resumes), and write J's decisions on a piece of work into
    its thread (studio_comments) so agents follow them.
  - Never raise limits, launch GPU servers or change PM settings without J's word.
- J can attach files: his message then lists each one's path (Read it; images too) and its blob id (blob:<sha>, usable
  as a hawkesgen input).
- Be concise and direct: lead with what matters, use short lists, no filler. Ask when a decision is J's.
${memoryStable()}`;
}

/** Studio-wide decisions and preferences: stable between turns (so the prompt caches), changing only when memory does. */
function memoryStable() {
  const b = memoryBlock({ role: 'talk', stableOnly: true, maxChars: 2500 });
  return b.text ? `\n\nFrom the shared memory (studio-wide decisions and preferences):\n${b.text}` : '';
}

const running = new Map<string, ChildProcess>();
const stopping = new Set<string>();

export function startConversation(title?: string) {
  const id = newId('t');
  db.prepare('INSERT INTO conversations (id, title, status, messages, created) VALUES (?, ?, ?, ?, ?)').run(id, title ?? null, 'idle', '[]', Date.now());
  return getConversation(id)!;
}

/** Studio tells J something in Talk (a conversation of its own); when J answers, Claude gets the notice with it. */
export function postNotice(title: string, text: string) {
  const c = startConversation(title);
  c.messages.push({ role: 'assistant', text, at: Date.now(), notice: true });
  save(c);
  return c.id;
}

export function renameConversation(id: string, title: string) {
  if (!getConversation(id)) throw new Error('No such conversation');
  db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(String(title).trim().slice(0, 120) || null, id);
  return getConversation(id)!;
}

export function deleteConversation(id: string) {
  endCall(id);
  stop(id);
  partial.delete(id);
  clearTimeout(autoTimers.get(id));
  autoTimers.delete(id);
  queuedTurns.delete(id);
  fs.rmSync(MCP_FILE(id), { force: true });
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
}

/** Where Hawkes Gen keeps a blob on this machine (Studio and Gen share the disk), so Claude can Read it. */
function blobFile(blob: string) {
  const hash = /^blob:([0-9a-f]{64})$/.exec(blob)?.[1];
  if (!hash) return null;
  const dir = path.join(process.env.GEN_BLOBS ?? path.join(PROJECTS, 'hawkesgen', '.data', 'blobs'), hash.slice(0, 2));
  const name = fs.existsSync(dir) ? fs.readdirSync(dir).find((n) => n.startsWith(hash)) : undefined;
  if (!name) return null;
  // The sandbox can't read Gen's data folder: Talk gets a copy in the shared work folder.
  if (!sandboxOn()) return path.join(dir, name);
  const copy = path.join(sandboxShare('attachments'), name);
  if (!fs.existsSync(copy)) fs.copyFileSync(path.join(dir, name), copy);
  return copy;
}

/** Sends J's message (with files already uploaded to Hawkes Gen); Claude answers in the background (poll getConversation). */
export function say(id: string, text: string, files: Attachment[] = [], { voice = false }: { voice?: boolean } = {}) {
  const c = getConversation(id);
  if (!c) throw new Error('No such conversation');
  if (running.has(id)) throw new Error('Claude is still answering');
  files = files.filter((f) => f && /^blob:[0-9a-f]{64}$/.test(String(f.blob))).slice(0, 10)
    .map((f) => ({ name: String(f.name ?? 'file').slice(0, 120), blob: String(f.blob), type: f.type ? String(f.type).slice(0, 80) : undefined, size: Number(f.size) || undefined, path: blobFile(String(f.blob)) }));
  if (!text.trim() && !files.length) throw new Error('Say something');
  const userAt = Date.now();
  c.messages.push({ role: 'user', text, at: userAt, ...(files.length ? { files } : {}), ...(voice ? { voice: true } : {}) });
  if (!c.title) c.title = (text.trim() || files.map((f) => f.name).join(', ')).slice(0, 80);
  c.status = 'thinking';
  save(c);

  const attached = files.length
    ? `\n\n[J attached ${files.length === 1 ? 'a file' : `${files.length} files`}]\n${files.map((f) => `- ${f.name}${f.type ? ` (${f.type}${f.size ? `, ${Math.ceil(f.size / 1024)} KB` : ''})` : ''}: ${f.path ?? '(not on this machine)'}; Hawkes Gen input ${f.blob}`).join('\n')}`
    : '';
  // Studio's notices since Claude last answered (a new conversation's are all of them) go first, so Claude knows them.
  const notices = unanswered(c).map((m) => `[Studio posted this in the conversation]\n${m.text}`);
  // What the shared memory knows about this message (after the stable system prompt, so the cached prefix holds).
  const known = memoryBlock({ role: 'talk', relevantOnly: true, text: `${text} ${notices.join(' ')}`.slice(0, 4000), maxChars: 2500, limit: 8, exclude: memoryBlock({ role: 'talk', stableOnly: true }).ids });
  const recall = known.text ? `\n\n[From the shared memory, matching this message (memory_get <id> for more)]\n${known.text}` : '';
  const prompt = `${notices.length ? `${notices.join('\n\n')}\n\n[J's message]\n` : ''}${text.trim() || 'See the attached files.'}${attached}${recall}`;
  runTurn(id, prompt, userAt);
  return getConversation(id)!;
}

/** Studio's notices after Claude's last real answer. */
function unanswered(c: Conversation) {
  const lastAnswer = c.messages.findLastIndex((m) => m.role === 'assistant' && !m.notice);
  return c.messages.slice(lastAnswer + 1).filter((m) => m.notice);
}

// ------------------------------------------------------------ Studio says

/** Results that finish within this window after the first one are answered in one turn. */
const BATCH_MS = () => Number(process.env.TALK_FOLLOWUP_BATCH_MS ?? 60_000);
const autoTimers = new Map<string, NodeJS.Timeout>();
/** Conversations with results waiting while a turn runs (answered when it ends). */
const waitingAuto = new Set<string>();

/**
 * Work this conversation started finished (followup.ts): the notice goes into the conversation now, and Claude answers
 * it by itself in a turn of its own a minute later (results within that minute share the turn). Never a second turn
 * while one runs: it waits for the running one, and J's own message answers the notices too (say() includes them).
 */
export function studioSays(id: string, text: string) {
  const c = getConversation(id);
  if (!c) return false;
  c.messages.push({ role: 'assistant', text, at: Date.now(), notice: true, followup: true });
  save(c);
  scheduleAuto(id);
  return true;
}

function scheduleAuto(id: string, ms = BATCH_MS()) {
  if (autoTimers.has(id)) return;
  const t = setTimeout(() => {
    autoTimers.delete(id);
    autoTurn(id);
  }, ms);
  t.unref?.();
  autoTimers.set(id, t);
}

function autoTurn(id: string) {
  const c = getConversation(id);
  if (!c) return;
  // A turn is running (J's, or an earlier one): this one waits for it (the close handler reschedules).
  if (running.has(id)) return void waitingAuto.add(id);
  const todo = unanswered(c).filter((m) => m.followup);
  if (!todo.length) return;
  c.status = 'thinking';
  save(c);
  const prompt = `[Studio says: work started from this conversation finished]\n\n${todo.map((m) => m.text).join('\n\n---\n\n')}

[Studio started this turn, not J: he hasn't written since. Tell him in plain words what came back: lead with the outcome
and the verdict, then the evidence (pull request, preview, video links) and what, if anything, he needs to decide. Look
details up with the tools if that helps, but don't approve, merge, deploy, revise or start anything: wait for J. Keep it short.]`;
  runTurn(id, prompt, Date.now(), { auto: true });
}

/** Prompts waiting for a conversation's running turn to end (studioTurn). */
const queuedTurns = new Map<string, string[]>();

/**
 * A turn Studio starts with its own prompt (e.g. a PM turn): marked auto like the result turns. While a turn runs it
 * waits for it to end (several waiting prompts go in one turn). False when there is no such conversation.
 */
export function studioTurn(id: string, prompt: string) {
  const c = getConversation(id);
  if (!c) return false;
  if (running.has(id)) {
    queuedTurns.set(id, [...(queuedTurns.get(id) ?? []), prompt]);
    return true;
  }
  c.status = 'thinking';
  save(c);
  runTurn(id, prompt, Date.now(), { auto: true });
  return true;
}

/** What one turn needs while its output streams in (a turn of its own process, or of a call's warm process). */
type TurnCtx = { userAt: number; auto: boolean; call: boolean; billing: Turn['billing']; done: boolean; finished?: boolean; err: string };

/**
 * Live text for call pages, per conversation id (GET /api/talk/<id>/events): { type: 'turn' } when a turn starts,
 * 'start' / 'delta' (text) / 'end' for each text block as Claude writes it, 'tool' (text) when it calls a tool, 'idle'
 * when the turn is over.
 */
export const talkEvents = new EventEmitter();
talkEvents.setMaxListeners(100);
const emit = (id: string, e: Record<string, unknown>) => talkEvents.emit(id, e);

/** Spoken answers: appended to the system prompt of a call's process (only calls; the chat stays as it is). */
const CALL_PROMPT = `

J is on a voice call with you right now (Studio's call mode, often on his phone). What you write is read aloud by a
speech voice, sentence by sentence as you write it, and he answers by talking:
- Talk like a person on the phone: one to three short sentences, the answer first, no filler openers. He can ask for more.
- Never put tables, Markdown lists, headings, code, file paths, ids or URLs in what you say: they can't be read aloud.
  Say numbers and names the way you'd say them.
- When there are details worth seeing (links, videos, lists, numbers), say "I'll put the details in the chat" and write
  them after a line with only --- on it: everything after that line shows in the conversation and isn't read aloud.
- Before tool calls that take a while, say a few words first ("Let me look at last night's report."), so he isn't left
  in silence.
- Speech recognition mishears names: if his words look garbled, make your best guess and say it, or ask briefly.
- Spoken words never confirm anything irreversible: DEPLOY, ROLLBACK and MERGE confirmations have to be typed in the
  chat. Say so, and put the exact words to type in the details.`;

function claudeArgs(c: Conversation, call: boolean) {
  // The role (.claude/agents/talk.md, or pm.md in the PM's conversation): model, tools, its standing instructions
  // first (stable, so the prompt caches), then Studio's context (products, lanes, the shared memory's decisions).
  const { args: role } = roleArgs((c as any).kind === 'pm' ? 'pm' : 'talk', { extraPrompt: systemPrompt() + (call ? CALL_PROMPT : '') });
  const model = (call && process.env.TALK_CALL_MODEL) || process.env.TALK_MODEL;
  if (model) role.splice(role.indexOf('--model') + 1, 1, model);
  return [
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--mcp-config', mcpConfig(c.id), '--strict-mcp-config',
    ...role,
    ...(c.session ? ['--resume', c.session] : []),
  ];
}

/**
 * Starts Claude Code. TALK_CLAUDE: the executable, when it isn't "claude" on the PATH; TALK_CLAUDE_ARGS: a JSON array of
 * arguments before Claude Code's own (tests run a stand-in script with node).
 */
function spawnClaude(args: string[]) {
  const pre: string[] = process.env.TALK_CLAUDE_ARGS ? JSON.parse(process.env.TALK_CLAUDE_ARGS) : [];
  // In the agent sandbox, as its user with no secrets (sandbox.ts); its working directory stays the projects folder.
  if (sandboxOn() && !pre.length) return spawnSandboxed(args, { cwd: PROJECTS, env: claudeEnv() });
  return spawn(process.env.TALK_CLAUDE || 'claude', [...pre, ...args], { cwd: PROJECTS, env: claudeEnv(), windowsHide: true });
}

/** Calls f with each JSON line of the process's stream-json output. */
function readLines(child: ChildProcess, f: (m: any) => void) {
  let buf = '';
  child.stdout!.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      f(m);
    }
  });
}

/** The conversation so far, for a new Claude Code session (the old one is gone). */
function recap(c: Conversation, before: number) {
  const msgs = c.messages.filter((m) => m.at < before && m.role !== 'tool').slice(-30);
  if (!msgs.length) return '';
  const lines = msgs.map((m) => `${m.role === 'user' ? 'J' : m.notice ? 'Studio' : 'You'}: ${m.text.replace(/\s+/g, ' ').slice(0, 1200)}`);
  return `[This conversation continues from an earlier session that is no longer available. What was said so far, newest last:]\n${lines.join('\n')}\n\n[Now:]\n`;
}

/** Runs one Claude Code turn in a conversation whose status is already "thinking" (in the call's process during a call). */
function runTurn(id: string, prompt: string, userAt: number, { auto = false, fresh = false }: { auto?: boolean; fresh?: boolean } = {}) {
  // Who pays: Claude Code says which key it uses when it starts (apiKeySource "none" = the subscription login).
  const ctx: TurnCtx = { userAt, auto, call: false, billing: usingSubscription() ? 'subscription' : 'api', done: false, err: '' };
  partial.delete(id);
  emit(id, { type: 'turn', auto });
  const call = calls.get(id);
  if (call) {
    ctx.call = true;
    const child = call.child ?? spawnCall(id, call);
    call.turn = ctx;
    call.seen = Date.now();
    running.set(id, child);
    child.stdin!.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
    return;
  }
  const c = getConversation(id)!;
  const child = spawnClaude(['-p', prompt, ...claudeArgs(c, false)]);
  running.set(id, child);
  readLines(child, (m) => onLine(id, m, ctx));
  child.stderr!.on('data', (d) => (ctx.err += d));
  const timer = setTimeout(() => child.kill('SIGTERM'), 30 * 60_000);
  child.on('close', (code) => {
    clearTimeout(timer);
    const stopped = stopping.delete(id);
    const conv = getConversation(id);
    // Its Claude Code session is gone (another home since the agent sandbox, a cleared cache): once, a new session
    // that gets the conversation so far.
    if (conv && !stopped && code !== 0 && c.session && !fresh && /no conversation found|session.*not found/i.test(ctx.err) && !conv.messages.some((x) => x.role === 'assistant' && x.at >= userAt)) {
      conv.session = null;
      save(conv);
      running.delete(id);
      return void runTurn(id, `${recap(conv, userAt)}${prompt}`, userAt, { auto, fresh: true });
    }
    finishTurn(id, ctx, { stopped, code });
  });
  child.on('error', (e) => failedStart(id, e));
}

function failedStart(id: string, e: Error) {
  running.delete(id);
  waitingAuto.delete(id);
  const conv = getConversation(id);
  if (!conv) return;
  conv.messages.push({ role: 'assistant', text: `(Couldn't start Claude Code: ${e.message})`, at: Date.now() });
  conv.status = 'idle';
  save(conv);
  emit(id, { type: 'idle' });
}

/** The answer's cost and billing go on its last message. */
function endTurn(conv: Conversation, ctx: TurnCtx, turn: Turn) {
  ctx.done = true;
  const last = conv.messages.at(-1);
  if (ctx.auto) turn.auto = true;
  if (ctx.call) turn.call = true;
  if (last && last.at >= ctx.userAt && last.role !== 'user' && !last.notice) last.turn = turn;
  else conv.messages.push({ role: 'assistant', text: turn.stopped ? '(stopped)' : '(no answer)', at: Date.now(), turn });
}

function onLine(id: string, m: any, ctx: TurnCtx) {
  // Partial text is kept in memory only, so streaming doesn't write the database on every token.
  if (m.type === 'stream_event') {
    const ev = m.event;
    if (ev?.type === 'content_block_start' && ev.content_block?.type === 'text') {
      partial.set(id, '');
      emit(id, { type: 'start' });
    } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      partial.set(id, (partial.get(id) ?? '') + ev.delta.text);
      emit(id, { type: 'delta', text: ev.delta.text });
    } else if (ev?.type === 'content_block_stop') emit(id, { type: 'end' });
    return;
  }
  const conv = getConversation(id);
  if (!conv) return;
  if (m.type === 'system' && m.subtype === 'init' && m.apiKeySource) ctx.billing = m.apiKeySource === 'none' ? 'subscription' : 'api';
  if (m.type === 'system' && m.session_id && !conv.session) conv.session = m.session_id;
  if (m.type === 'assistant') {
    partial.delete(id);
    for (const part of m.message?.content ?? []) {
      if (part.type === 'text' && part.text.trim()) conv.messages.push({ role: 'assistant', text: part.text, at: Date.now() });
      if (part.type === 'tool_use') {
        conv.messages.push({ role: 'tool', text: describeTool(part.name, part.input), tool: part.name, at: Date.now() });
        emit(id, { type: 'tool', text: describeTool(part.name, part.input) });
      }
    }
  }
  if (m.type === 'result') {
    if (m.session_id) conv.session = m.session_id;
    const cost = Number(m.total_cost_usd) || 0;
    if (ctx.billing === 'api') conv.cost += cost;
    const turn: Turn = { cost, billing: ctx.billing, ms: Number(m.duration_ms) || undefined };
    // A call's process stays up: the turn ends with its result (stopping: J interrupted it, e.g. by talking).
    const stopped = ctx.call && stopping.delete(id);
    if (m.is_error && !stopped && !conv.messages.some((x) => x.role === 'assistant' && x.at >= ctx.userAt)) conv.messages.push({ role: 'assistant', text: `(Claude stopped: ${String(m.result ?? m.subtype ?? 'error').slice(0, 300)})`, at: Date.now() });
    if (ctx.call) {
      save(conv);
      return finishTurn(id, ctx, { stopped, turn });
    }
    endTurn(conv, ctx, turn);
  }
  save(conv);
}

/** A turn is over (its process closed, or a call's turn got its result): the conversation is idle again. */
function finishTurn(id: string, ctx: TurnCtx, { stopped = false, code = 0, turn }: { stopped?: boolean; code?: number | null; turn?: Turn }) {
  if (ctx.finished) return;
  ctx.finished = true;
  running.delete(id);
  const call = calls.get(id);
  if (call?.turn === ctx) call.turn = null;
  const text = partial.get(id);
  partial.delete(id);
  const conv = getConversation(id);
  if (!conv) return;
  // What Claude had written when J stopped it stays in the conversation.
  if (text?.trim()) conv.messages.push({ role: 'assistant', text: `${text}${stopped ? ' …' : ''}`, at: Date.now() });
  if (!stopped && code !== 0 && !conv.messages.some((x) => x.role === 'assistant' && x.at >= ctx.userAt)) {
    conv.messages.push({ role: 'assistant', text: `(Claude couldn't answer: ${(ctx.err.trim().split('\n').pop() || `exit ${code}`).slice(0, 300)})`, at: Date.now() });
  }
  if (!ctx.done) endTurn(conv, ctx, { ...(turn ?? { cost: 0, billing: ctx.billing }), ...(stopped ? { stopped: true } : {}) });
  conv.status = 'idle';
  save(conv);
  emit(id, { type: 'idle' });
  // Results that came in while this turn ran get their own turn now (unless this one already answered them).
  waitingAuto.delete(id);
  const queued = queuedTurns.get(id);
  queuedTurns.delete(id);
  if (queued?.length) setTimeout(() => studioTurn(id, queued.join('\n\n---\n\n')), 2000).unref?.();
  else if (unanswered(conv).some((m) => m.followup)) scheduleAuto(id, 5000);
}

// ------------------------------------------------------------ calls

type Call = { child: ChildProcess | null; turn: TurnCtx | null; seen: number; started: number; err: string };
const calls = new Map<string, Call>();
/** A call ends by itself when the call page stops checking in (it pings every 20 s while the call is up). */
const CALL_IDLE_MS = () => Number(process.env.TALK_CALL_IDLE_MS ?? 90_000);

/** The call's warm Claude Code process: it reads one stream-json message per turn from stdin. */
function spawnCall(id: string, call: Call) {
  const c = getConversation(id)!;
  const child = spawnClaude(['-p', '--input-format', 'stream-json', ...claudeArgs(c, true)]);
  call.child = child;
  call.err = '';
  readLines(child, (m) => call.turn && !call.turn.finished && onLine(id, m, call.turn));
  child.stderr!.on('data', (d) => (call.err = (call.err + d).slice(-4000)));
  child.stdin!.on('error', () => {}); // a process that died is noticed on close
  const gone = () => {
    if (call.child === child) call.child = null;
    const ctx = call.turn;
    call.turn = null;
    return ctx;
  };
  child.on('close', (code) => {
    const ctx = gone();
    if (!ctx || ctx.finished) return;
    ctx.err = call.err;
    finishTurn(id, ctx, { stopped: stopping.delete(id), code: code ?? 1 });
  });
  child.on('error', (e) => {
    const ctx = gone();
    if (ctx && !ctx.finished) failedStart(id, e);
  });
  return child;
}

/**
 * J starts a call (or the call page checks in): the conversation gets a warm Claude Code process, started now so it is
 * ready by the time J finishes his first sentence (if a text answer is still running, on the next turn instead).
 */
export function startCall(id: string) {
  if (!getConversation(id)) throw new Error('No such conversation');
  const call = calls.get(id);
  if (call) {
    call.seen = Date.now();
    return callInfo(id);
  }
  const fresh: Call = { child: null, turn: null, seen: Date.now(), started: Date.now(), err: '' };
  calls.set(id, fresh);
  if (!running.has(id)) spawnCall(id, fresh);
  return callInfo(id);
}

/** J hangs up: an answer in progress still finishes into the conversation, then the process ends. */
export function endCall(id: string) {
  const call = calls.get(id);
  if (!call) return false;
  calls.delete(id);
  call.child?.stdin?.end();
  return true;
}

export function callInfo(id: string) {
  const call = calls.get(id);
  return call ? { active: true, warm: !!call.child, since: call.started } : { active: false, warm: false, since: null };
}

setInterval(() => {
  for (const [id, call] of calls) if (!call.turn && Date.now() - call.seen > CALL_IDLE_MS()) endCall(id);
}, 15_000).unref?.();

/** Stops Claude's answer (what it wrote so far is kept; the session can go on). In a call it interrupts the turn. */
export function stop(id: string) {
  const child = running.get(id);
  if (!child) return false;
  stopping.add(id);
  const call = calls.get(id);
  if (call?.child === child && call.turn) {
    const ctx = call.turn;
    child.stdin!.write(`${JSON.stringify({ type: 'control_request', request_id: `stop-${Date.now()}`, request: { subtype: 'interrupt' } })}\n`);
    // An interrupt that doesn't end the turn soon ends the process (the next turn starts a new one).
    setTimeout(() => {
      if (call.turn === ctx) child.kill('SIGTERM');
    }, 5000).unref?.();
  } else child.kill('SIGTERM');
  return true;
}

function describeTool(name: string, input: any) {
  const short = name.replace(/^mcp__hawkes(studio|gen)__/, '');
  const arg = input?.product ?? input?.run ?? input?.id ?? input?.tool ?? input?.file_path ?? input?.pattern ?? '';
  return `${short}${arg ? ` ${String(arg).slice(0, 60)}` : ''}`;
}

export const talkInfo = () => ({ billing: billing(), subscription: usingSubscription(), model: process.env.TALK_MODEL ?? 'claude-opus-5-5' });

// A conversation interrupted by a restart isn't thinking any more.
db.prepare(`UPDATE conversations SET status = 'idle' WHERE status = 'thinking'`).run();
// Results posted before a restart that Claude hadn't answered yet still get their turn.
for (const r of db.prepare('SELECT id FROM conversations WHERE updated > ?').all(Date.now() - 6 * 3600_000) as { id: string }[]) {
  const c = getConversation(r.id);
  if (c && unanswered(c).some((m) => m.followup)) scheduleAuto(c.id, 20_000);
}