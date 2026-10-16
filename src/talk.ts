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

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { db, newId, J, parse } from './db.ts';
import { PROJECTS, DATA, ROOT, loadProducts } from './config.ts';
import { claudeEnv, billing, usingSubscription } from './claude.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, title TEXT, session TEXT, status TEXT NOT NULL DEFAULT 'idle', messages TEXT NOT NULL DEFAULT '[]',
    cost REAL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER
  );
`);

export type Attachment = { name: string; blob: string; type?: string; size?: number; path?: string | null };
/** turn: on the last message of each answer, what it cost (USD, as Claude Code reports it) and who paid. */
export type Turn = { cost: number; billing: 'subscription' | 'api'; ms?: number; stopped?: boolean };
/** notice: posted by Studio itself (a beta conflict), not by Claude; Claude sees it with J's next message. */
export type Message = { role: 'user' | 'assistant' | 'tool'; text: string; at: number; tool?: string; files?: Attachment[]; turn?: Turn; notice?: boolean };
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

const MCP_FILE = () => path.join(DATA, 'talk-mcp.json');
function mcpConfig() {
  // The two Hawkes MCP servers, talking to the services on this machine.
  const cfg = {
    mcpServers: {
      hawkesstudio: { command: process.execPath, args: [path.join(ROOT, 'bin', 'studio-mcp.mjs')], env: { STUDIO_SERVER: '1' } },
      hawkesgen: { command: process.execPath, args: [path.join(PROJECTS, 'hawkesgen', 'bin', 'hawkesgen-mcp.mjs')], env: { HAWKESGEN_URL: process.env.HAWKESGEN_URL ?? 'http://127.0.0.1:8790', HAWKESGEN_KEY: process.env.HAWKESGEN_KEY ?? '' } },
    },
  };
  fs.writeFileSync(MCP_FILE(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return MCP_FILE();
}

function systemPrompt() {
  const products = loadProducts().map((p) => `- ${p.name} (${p.id}): ${p.about}`).join('\n');
  const media = process.env.GEN_PUBLIC_URL ?? 'https://studio.hawkesgen.com/gen';
  return `You are J's studio partner inside Hawkes Studio (studio.hawkesgen.com). J is one person running eight AI-built
products under the Hawkes Biomedical brand. You talk with him about them the way a trusted producer and lead developer
would: what's broken, what to build next, what agents are doing, what's ready to ship.

Products:
${products}

How to work:
- Use the hawkesstudio tools for the truth: studio_reports (every report, the same list as the dashboard's Report
  tab: every run has one; daily reports cover all products and what ran since the last one), studio_report (one
  report; the latest daily by default), studio_overview, studio_backlog,
  studio_changes / studio_change (agent pull requests), studio_playtest, studio_build, studio_assets, studio_previews,
  studio_deploy_plan, studio_rollback (without confirm: the plan). Use hawkesgen tools for generation (images, video,
  music, voice, 3D) and the library.
- The repos and docs are in ${PROJECTS} (the same layout as J's C:\\Projects); read AGENTS.md files and story docs
  when you need context. You can't edit files here: changes go through agents (studio_fix starts one for findings).
- J doesn't review code. Explain changes in plain words: what was wrong, what changed, how it was verified, the
  verdict of the verification playtest, and show the evidence. Screenshots and videos are library assets: link them as
  ${media}/v1/files/<asset id> (images as ![...](url), videos as plain links).
- The lanes: agent changes are pull requests into a product's beta branch; approving one (studio_change approve,
  confirm "MERGE <id>", only after J says yes to it here) merges it into beta, which is the staging site
  (https://<sub>.hawkesgen.com/) and what local playtests play. Nothing is live until J says to go live.
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
- J can attach files: his message then lists each one's path (Read it; images too) and its blob id (blob:<sha>, usable
  as a hawkesgen input).
- Be concise and direct: lead with what matters, use short lists, no filler. Ask when a decision is J's.`;
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
  stop(id);
  partial.delete(id);
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
}

/** Where Hawkes Gen keeps a blob on this machine (Studio and Gen share the disk), so Claude can Read it. */
function blobFile(blob: string) {
  const hash = /^blob:([0-9a-f]{64})$/.exec(blob)?.[1];
  if (!hash) return null;
  const dir = path.join(process.env.GEN_BLOBS ?? path.join(PROJECTS, 'hawkesgen', '.data', 'blobs'), hash.slice(0, 2));
  const name = fs.existsSync(dir) ? fs.readdirSync(dir).find((n) => n.startsWith(hash)) : undefined;
  return name ? path.join(dir, name) : null;
}

/** Sends J's message (with files already uploaded to Hawkes Gen); Claude answers in the background (poll getConversation). */
export function say(id: string, text: string, files: Attachment[] = []) {
  const c = getConversation(id);
  if (!c) throw new Error('No such conversation');
  if (running.has(id)) throw new Error('Claude is still answering');
  files = files.filter((f) => f && /^blob:[0-9a-f]{64}$/.test(String(f.blob))).slice(0, 10)
    .map((f) => ({ name: String(f.name ?? 'file').slice(0, 120), blob: String(f.blob), type: f.type ? String(f.type).slice(0, 80) : undefined, size: Number(f.size) || undefined, path: blobFile(String(f.blob)) }));
  if (!text.trim() && !files.length) throw new Error('Say something');
  const userAt = Date.now();
  c.messages.push({ role: 'user', text, at: userAt, ...(files.length ? { files } : {}) });
  if (!c.title) c.title = (text.trim() || files.map((f) => f.name).join(', ')).slice(0, 80);
  c.status = 'thinking';
  save(c);

  const attached = files.length
    ? `\n\n[J attached ${files.length === 1 ? 'a file' : `${files.length} files`}]\n${files.map((f) => `- ${f.name}${f.type ? ` (${f.type}${f.size ? `, ${Math.ceil(f.size / 1024)} KB` : ''})` : ''}: ${f.path ?? '(not on this machine)'}; Hawkes Gen input ${f.blob}`).join('\n')}`
    : '';
  // Studio's notices since Claude last answered (a new conversation's are all of them) go first, so Claude knows them.
  const lastAnswer = c.messages.findLastIndex((m) => m.role === 'assistant' && !m.notice);
  const notices = c.messages.slice(lastAnswer + 1).filter((m) => m.notice).map((m) => `[Studio posted this in the conversation]\n${m.text}`);
  const prompt = `${notices.length ? `${notices.join('\n\n')}\n\n[J's message]\n` : ''}${text.trim() || 'See the attached files.'}${attached}`;
  const args = [
    '-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', process.env.TALK_MODEL ?? 'claude-opus-5-5',
    '--mcp-config', mcpConfig(), '--strict-mcp-config',
    '--allowedTools', 'mcp__hawkesstudio,mcp__hawkesgen,Read,Glob,Grep',
    '--disallowedTools', 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch',
    '--append-system-prompt', systemPrompt(),
    ...(c.session ? ['--resume', c.session] : []),
  ];
  // TALK_CLAUDE: the Claude Code executable, when it isn't "claude" on the PATH.
  const child = spawn(process.env.TALK_CLAUDE || 'claude', args, { cwd: PROJECTS, env: claudeEnv(), windowsHide: true });
  running.set(id, child);
  partial.delete(id);
  // Who pays: Claude Code says which key it uses when it starts (apiKeySource "none" = the subscription login).
  let billing: Turn['billing'] = usingSubscription() ? 'subscription' : 'api';
  let turnDone = false;
  /** The answer's cost and billing go on its last message. */
  const endTurn = (conv: Conversation, turn: Turn) => {
    turnDone = true;
    const last = conv.messages.at(-1);
    if (last && last.at >= userAt && last.role !== 'user') last.turn = turn;
    else conv.messages.push({ role: 'assistant', text: turn.stopped ? '(stopped)' : '(no answer)', at: Date.now(), turn });
  };
  let buf = '';
  child.stdout.on('data', (d) => {
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
      // Partial text is kept in memory only, so streaming doesn't write the database on every token.
      if (m.type === 'stream_event') {
        const ev = m.event;
        if (ev?.type === 'content_block_start' && ev.content_block?.type === 'text') partial.set(id, '');
        else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') partial.set(id, (partial.get(id) ?? '') + ev.delta.text);
        continue;
      }
      const conv = getConversation(id);
      if (!conv) continue;
      if (m.type === 'system' && m.subtype === 'init' && m.apiKeySource) billing = m.apiKeySource === 'none' ? 'subscription' : 'api';
      if (m.type === 'system' && m.session_id && !conv.session) conv.session = m.session_id;
      if (m.type === 'assistant') {
        partial.delete(id);
        for (const part of m.message?.content ?? []) {
          if (part.type === 'text' && part.text.trim()) conv.messages.push({ role: 'assistant', text: part.text, at: Date.now() });
          if (part.type === 'tool_use') conv.messages.push({ role: 'tool', text: describeTool(part.name, part.input), tool: part.name, at: Date.now() });
        }
      }
      if (m.type === 'result') {
        if (m.session_id) conv.session = m.session_id;
        const cost = Number(m.total_cost_usd) || 0;
        if (billing === 'api') conv.cost += cost;
        if (m.is_error && !conv.messages.some((x) => x.role === 'assistant' && x.at >= userAt)) conv.messages.push({ role: 'assistant', text: `(Claude stopped: ${String(m.result ?? m.subtype ?? 'error').slice(0, 300)})`, at: Date.now() });
        endTurn(conv, { cost, billing, ms: Number(m.duration_ms) || undefined });
      }
      save(conv);
    }
  });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const timer = setTimeout(() => child.kill('SIGTERM'), 30 * 60_000);
  child.on('close', (code) => {
    clearTimeout(timer);
    running.delete(id);
    const wasStopped = stopping.delete(id);
    const text = partial.get(id);
    partial.delete(id);
    const conv = getConversation(id);
    if (!conv) return;
    // What Claude had written when J stopped it stays in the conversation.
    if (text?.trim()) conv.messages.push({ role: 'assistant', text: `${text}${wasStopped ? ' …' : ''}`, at: Date.now() });
    if (!wasStopped && code !== 0 && !conv.messages.some((x) => x.role === 'assistant' && x.at >= userAt)) {
      conv.messages.push({ role: 'assistant', text: `(Claude couldn't answer: ${(err.trim().split('\n').pop() || `exit ${code}`).slice(0, 300)})`, at: Date.now() });
    }
    if (!turnDone) endTurn(conv, { cost: 0, billing, ...(wasStopped ? { stopped: true } : {}) });
    conv.status = 'idle';
    save(conv);
  });
  child.on('error', (e) => {
    running.delete(id);
    const conv = getConversation(id);
    if (!conv) return;
    conv.messages.push({ role: 'assistant', text: `(Couldn't start Claude Code: ${e.message})`, at: Date.now() });
    conv.status = 'idle';
    save(conv);
  });
  return getConversation(id)!;
}

/** Stops Claude's answer (what it wrote so far is kept; the session can go on). */
export function stop(id: string) {
  const child = running.get(id);
  if (!child) return false;
  stopping.add(id);
  child.kill('SIGTERM');
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