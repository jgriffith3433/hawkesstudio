// The Inbox: one place for everything waiting on J, across every Talk conversation, agent and the PM loop.
//
//   questions   decisions filed with askJ (the PM's, Talk's, an agent's question passed on) and agent questions nobody
//               else will answer (J's own requests, or no PM loop running here)
//   GPU budgets content tasks that wait for J to approve a budget (roadmap.ts tasksAwaitingGpu)
//   merges      ready changes only J may merge: Studio and Gen (into main, which deploys), changes the PM doesn't
//               review (J's own requests, work from before the loop), everything while delegated merges are off
//   milestones  reached: every item passed its checks on beta, J's turn to playtest (with the beta link)
//
// Each card says what it blocks and since when, who asked and what they recommend, with options, a free-text answer and
// links. Cards are sorted by what they block most. Answering routes the way it always did (an agent resumes, the PM's
// next turn hears J's decision, a budget is approved, a change merges) and the card goes. Answers record who gave them
// (actor()): J on the dashboard, J through Talk only in a turn J started, otherwise Talk or the PM by name.
// No phone notifications here: the dashboard's badge is the signal.

import type http from 'node:http';
import { db, parse } from './db.ts';
import { getProduct, getInfra, isInfra, StudioError } from './config.ts';
import {
  listQuestions, getQuestion, setQuestion, answeredSince, getTask, getItem, getMilestone, listMilestones, milestoneProgress, tasksAwaitingGpu,
  approveGpu, updateTask, estimateTask, addComment, type Question, type Task,
} from './roadmap.ts';
import { gate } from './acceptance.ts';
import { listApprovals, type Approval } from './approvals.ts';

// Answers to the cards that aren't questions (budgets, merges, milestones): what was answered, by whom, and for a
// milestone how long its card stays away (until; null: for good).
db.exec(`CREATE TABLE IF NOT EXISTS inbox_acks (id TEXT PRIMARY KEY, at INTEGER NOT NULL, by TEXT, answer TEXT, until INTEGER)`);
try { db.exec('ALTER TABLE inbox_acks ADD COLUMN title TEXT'); } catch { /* already there */ }

export type InboxLink = { label: string; url?: string; video?: string };
export type InboxItem = {
  /** q_... for a question; gpu:k_..., merge:c_..., milestone:n_... for the others. */
  id: string;
  kind: 'question' | 'agent' | 'gpu' | 'merge' | 'milestone' | 'approval';
  /** The one-line question, and the whole of it when it's longer. */
  title: string; text: string | null;
  product: string | null; productName: string | null;
  /** What it's about (the agent, change, task or finding) in a line. */
  context: string | null;
  /** Who asked: "Talk (PM)", "agent c_...", "Studio". */
  asker: string;
  recommendation: string | null; options: string[];
  /** What waits until J answers, and since when (ms). */
  blocks: string; since: number;
  /** How much it blocks: the sort key (bigger first). */
  weight: number;
  links: InboxLink[];
  subject: string | null; conversation: string | null; asks: number;
  /** Words J may type to confirm (a Studio or Gen merge into main): the fallback; the Approve card comes first. */
  confirm?: string;
  /** An Approve / Deny card (approvals.ts): J taps one of its buttons; the Inbox's answer doesn't decide it. */
  approval?: Approval;
};

const name = (product: string | null | undefined) => {
  if (!product) return null;
  try { return isInfra(product) ? getInfra(product).name : getProduct(product).name; } catch { return product; }
};
const HOUR = 3600_000;
const firstLine = (s: string) => {
  const l = String(s).trim().split('\n').find((x) => x.trim()) ?? '';
  return l.length > 220 ? `${l.slice(0, 217)}…` : l;
};

// The few change fields the Inbox needs, straight from the table (agents.ts stays out of this module's imports).
type ChangeRow = { id: string; product: string; status: string; title: string | null; detail: string | null; pr: number | null; pr_url: string | null; verify: any; criteria: string[]; task: string | null; findings: string[]; request: string | null; created: number; updated: number | null; infra: boolean; origin: string | null };
const toChange = (r: any): ChangeRow => ({ ...r, verify: parse(r.verify), criteria: parse(r.criteria) ?? [], findings: parse(r.findings) ?? [], infra: isInfra(r.product) });
const changeRow = (id: string | null | undefined) => {
  if (!id) return null;
  try {
    const r = db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
    return r ? toChange(r) : null;
  } catch {
    return null; // No changes table yet (a fresh database).
  }
};
const readyChanges = () => {
  try {
    return (db.prepare(`SELECT * FROM changes WHERE status = 'ready' ORDER BY created`).all() as any[]).map(toChange);
  } catch {
    return [];
  }
};

let previews: typeof import('./previews.ts') | null = null;
void import('./previews.ts').then((m) => (previews = m)).catch(() => {});
const betaLink = (product: string | null) => {
  if (!product) return null;
  try { return previews?.listPreviews().find((x: any) => x.product === product)?.play ?? null; } catch { return null; }
};

function changeLinks(c: ChangeRow | null): InboxLink[] {
  if (!c) return [];
  const v = c.verify ?? {};
  return [
    v.preview ? { label: 'Preview', url: v.preview } : null,
    v.video ? { label: 'Video', video: v.video } : null,
    c.pr_url ? { label: `Pull request #${c.pr}`, url: c.pr_url } : null,
  ].filter(Boolean) as InboxLink[];
}

/** Tasks waiting on this one (depend on it, not done), and the milestone it belongs to. */
function waitingOn(t: Task) {
  const after = (db.prepare(`SELECT id, title FROM tasks WHERE depends LIKE ? AND status IN ('idea', 'planned')`).all(`%"${t.id}"%`) as any[]);
  const item = getItem(t.item);
  const ms = item?.milestone ? getMilestone(item.milestone) : null;
  return { after, ms: ms && ms.status === 'open' ? ms : null };
}
const taskBlocks = (t: Task, what: string) => {
  const { after, ms } = waitingOn(t);
  return {
    text: [what, after.length ? `${after.length} task(s) after it` : '', ms ? `milestone "${ms.title}"` : ''].filter(Boolean).join(' · '),
    weight: after.length * 10 + (ms ? 10 : 0),
  };
};

/** What a question is about, what waits on it, and its links. */
function about(q: Question) {
  const s = q.subject ?? '';
  let context: string | null = null;
  let blocks = 'nothing else: it decides what happens next';
  let weight = 15;
  let links: InboxLink[] = [];
  let product = q.product;
  if (s.startsWith('c_')) {
    const c = changeRow(s);
    const t = c?.task ? getTask(c.task) : null;
    product ??= c?.product ?? null;
    context = c ? `Agent change ${c.id}: ${c.title ?? c.request ?? ''}${t ? ` (task ${t.id})` : ''}` : `Change ${s}`;
    if (c?.status === 'needs answer') { blocks = `the agent on ${c.id} (paused)`; weight = 50; }
    if (t) { const b = taskBlocks(t, blocks); blocks = b.text; weight += b.weight; }
    links = changeLinks(c);
  } else if (s.startsWith('k_')) {
    const t = getTask(s);
    const c = changeRow(t?.change);
    product ??= t?.product ?? null;
    context = t ? `Task ${t.id}: ${t.title}${t.tries ? ` (${t.tries} tries)` : ''}${c ? ` · change ${c.id}` : ''}` : `Task ${s}`;
    const paused = c?.status === 'needs answer';
    const b = t ? taskBlocks(t, paused ? `the agent on ${c!.id} (paused)` : `task "${t.title}" (${t.status})`) : { text: blocks, weight: 0 };
    blocks = b.text;
    weight = (paused ? 50 : 30) + b.weight;
    links = changeLinks(c);
    if (t?.checks?.video && !links.some((l) => l.video)) links.push({ label: 'Video', video: t.checks.video });
  } else if (s.startsWith('f_')) {
    const f = db.prepare('SELECT id, product, severity, title FROM findings WHERE id = ?').get(s) as any;
    product ??= f?.product ?? null;
    context = f ? `Finding ${f.id}: [${f.severity}] ${f.title}` : `Finding ${s}`;
    blocks = f ? `fixing [${f.severity}] ${f.title}` : blocks;
    weight = f?.severity === 'blocker' ? 35 : 20;
  } else if (s.startsWith('i_')) {
    const it = getItem(s);
    product ??= it?.product ?? null;
    context = it ? `Roadmap item ${it.id}: ${it.title} (${it.status})` : `Item ${s}`;
    blocks = it ? `roadmap item "${it.title}"` : blocks;
    weight = 25;
  } else if (s.startsWith('n_')) {
    const m = getMilestone(s);
    context = m ? `Milestone ${m.id}: ${m.title}` : `Milestone ${s}`;
    blocks = m ? `milestone "${m.title}"` : blocks;
    weight = 30;
  }
  const beta = betaLink(product);
  if (beta && !links.length) links.push({ label: 'Beta', url: beta });
  return { context: q.context ?? context, blocks: q.blocks ?? blocks, weight, links, product };
}

/** Questions that no longer wait on anything are closed (the agent went on, the budget was approved elsewhere). */
function tidy() {
  const awaiting = new Set(tasksAwaitingGpu().map((t) => t.id));
  for (const q of listQuestions()) {
    let why = '';
    if (q.kind === 'agent' && q.subject?.startsWith('c_')) {
      const c = changeRow(q.subject);
      if (c && c.status !== 'needs answer') why = `the change is ${c.status} now`;
    }
    if (q.topic === 'gpu' && q.subject && !awaiting.has(q.subject)) why = 'the task no longer waits for a GPU budget';
    if (q.forwards) {
      const f = getQuestion(q.forwards);
      if (f && !['open', 'asked J'].includes(f.status)) why = `the agent's question was ${f.status}${f.answered_by ? ` by ${f.answered_by}` : ''}`;
    }
    if (why) setQuestion(q.id, { status: 'resolved', answer: `(no longer waiting: ${why})`, answered_by: 'Studio' });
  }
}

const acked = (id: string) => {
  const r = db.prepare('SELECT until FROM inbox_acks WHERE id = ?').get(id) as any;
  return Boolean(r && (r.until == null || r.until > Date.now()));
};
function ack(id: string, by: string, answer: string, until: number | null = null, title: string | null = null) {
  db.prepare('INSERT OR REPLACE INTO inbox_acks (id, at, by, answer, until, title) VALUES (?, ?, ?, ?, ?, ?)').run(id, Date.now(), by, answer.slice(0, 2000), until, title);
}
/** Records an answer to a budget or merge card for "answered lately" (its card goes by itself). */
const record = (id: string, by: string, answer: string, title: string) => ack(`${id}@${Date.now()}`, by, answer, null, title);

/** Whether the PM loop is working here (on the server): then agent questions and ready changes are its first. */
async function pmHandles() {
  const pm = await import('./pm.ts');
  return pm.pmRunning() && pm.pmSettings().enabled;
}

/** Everything waiting on J, sorted by what it blocks most (then oldest first). */
export async function inbox({ tokens = false }: { tokens?: boolean } = {}): Promise<InboxItem[]> {
  tidy();
  const pm = await import('./pm.ts');
  const handled = await pmHandles();
  const settings = pm.pmSettings();
  const out: InboxItem[] = [];

  // Approve / Deny cards waiting (they expire in 15 minutes: first). Their merge or budget card isn't shown twice.
  const cards = listApprovals({ pending: true }, tokens).filter((a) => a.status === 'pending');
  const carded = new Set(cards.map((a) => `${a.kind}:${a.target}`));
  for (const a of cards) {
    out.push({
      id: `approval:${a.id}`, kind: 'approval', title: a.card.title, text: null, product: null, productName: null, context: a.card.lines[0] ?? null,
      asker: a.requested_by ?? 'Studio', recommendation: null, options: [], blocks: `${a.kind} ${a.target}`, since: a.created, weight: 60,
      links: [], subject: a.target, conversation: a.conversation, asks: 1, approval: a,
    });
  }
  const open = listQuestions();
  const forwarded = new Set(open.map((q) => q.forwards).filter(Boolean));
  const gpuQ = new Map(open.filter((q) => q.topic === 'gpu' && q.subject).map((q) => [q.subject!, q]));

  for (const q of open) {
    if (forwarded.has(q.id) || q.topic === 'gpu') continue;
    if (q.kind === 'agent' && q.status === 'open') {
      // The PM answers its agents' questions first (and passes on what it can't); J's own requests are his.
      const c = changeRow(q.subject);
      const pmsWork = c && (c.task || (c.findings.length && !c.request));
      if (handled && pmsWork) continue;
    }
    const a = about(q);
    out.push({
      id: q.id, kind: q.kind === 'agent' ? 'agent' : 'question', title: firstLine(q.text), text: q.text.trim() !== firstLine(q.text) ? q.text : null,
      product: a.product, productName: name(a.product), context: a.context,
      asker: q.asked_by ?? (q.kind === 'agent' ? `agent ${q.subject ?? ''}`.trim() : 'Studio PM'),
      recommendation: q.recommendation, options: q.options, blocks: a.blocks, since: q.at, weight: a.weight, links: a.links,
      subject: q.subject, conversation: q.origin, asks: q.asks,
    });
  }

  for (const t of tasksAwaitingGpu()) {
    if (carded.has(`gpu:${t.id}`)) continue;
    const q = gpuQ.get(t.id);
    const e = t.gpu?.estimate;
    const amount = e && !e.error ? Math.ceil(e.cost * 1.25 * 100) / 100 : null;
    const b = taskBlocks(t, `task "${t.title}" (can't start)`);
    out.push({
      id: q?.id ?? `gpu:${t.id}`, kind: 'gpu',
      title: amount !== null ? `Approve a GPU budget of $${amount.toFixed(2)} for "${t.title}"?` : `"${t.title}" generates on the GPU but couldn't be priced. Price it again?`,
      text: q?.text ?? null, product: t.product, productName: name(t.product),
      context: e && !e.error ? `Task ${t.id}: about ${e.gpuHours} GPU-hours on ${e.servers} server(s), ~$${e.cost.toFixed(2)} ($${e.withIdleTail.toFixed(2)} if the servers idle out), about ${e.wallMinutes} min` : `Task ${t.id}${e?.error ? `: ${e.error}` : ''}`,
      asker: q?.asked_by ?? 'Studio PM', recommendation: q?.recommendation ?? (amount !== null ? `Approve $${amount.toFixed(2)}` : 'Price it again'),
      options: amount !== null ? [`Approve $${amount.toFixed(2)}`, 'Not now'] : ['Price it again', 'Not now'],
      blocks: b.text, since: q?.at ?? t.updated ?? t.created, weight: 25 + b.weight, links: [], subject: t.id, conversation: q?.origin ?? getItem(t.item)?.origin ?? null, asks: q?.asks ?? 1,
    });
  }

  // Product changes merge into beta by themselves (agents.ts autoMergeBeta): the Inbox asks only for Studio/Gen merges
  // into main; one that couldn't auto-merge waits in the Changes tab, and Talk said why.
  const autoBeta = (await import('./agents.ts')).agentSettings().autoMergeBeta;
  for (const c of readyChanges()) {
    if (autoBeta && !c.infra) continue;
    const pmReviews = handled && settings.delegatedMerges && pm.reviewable(c);
    if (pmReviews || carded.has(`merge:${c.id}`)) continue;
    const g = c.infra ? null : gate(c.verify, c.criteria);
    const v = c.verify ?? {};
    const into = c.infra ? 'main' : 'beta';
    const blocker = c.findings.some((f) => (db.prepare('SELECT severity FROM findings WHERE id = ?').get(f) as any)?.severity === 'blocker');
    const why = c.infra ? `a ${name(c.product)} change (merging into main deploys it)` : !pm.reviewable(c) ? (c.request ? 'your own request' : 'from before the PM loop') : 'delegated merges are off';
    out.push({
      id: `merge:${c.id}`, kind: 'merge', title: `Merge "${c.title ?? c.id}" into ${into}?`, text: null, product: c.product, productName: name(c.product),
      context: `Change ${c.id}, ${why}. ${c.infra ? `Checks: ${v.outcome ?? '?'}${v.summary ? `, ${String(v.summary).slice(0, 200)}` : ''}` : `${g?.played ? `Playtest: ${v.outcome ?? '?'} · review ${v.verdict ?? 'n/a'}` : "Not playtested (the agent's checks passed)"}${g && !g.pass ? ` · doesn't pass: ${g.why.join('; ').slice(0, 300)}` : ''}`}`,
      asker: c.origin ? 'Talk' : 'Studio', recommendation: c.infra ? (/pass|success|ok/i.test(String(v.outcome ?? '')) ? `Merge into main` : null) : g?.pass ? 'Merge into beta' : 'Ask for changes',
      options: [`Merge into ${into}`, 'Ask for changes', 'Close'],
      blocks: c.task ? taskBlocks(getTask(c.task)!, `"${c.title}" reaching ${into}`).text : `"${c.title ?? c.id}" reaching ${into}`,
      since: c.updated ?? c.created, weight: 20 + (blocker ? 15 : 0) + (c.task ? taskBlocks(getTask(c.task)!, '').weight : 0), links: changeLinks(c),
      subject: c.id, conversation: c.origin, asks: 1, ...(c.infra ? { confirm: `MERGE ${c.id}` } : {}),
    });
  }

  for (const m of listMilestones({ status: 'reached' })) {
    const key = `milestone:${m.id}:${m.reached_at ?? 0}`;
    if (acked(key)) continue;
    const p = milestoneProgress(m.id);
    // Live, or done by hand (not consumed: done because its tasks were created, which is still to playtest).
    if (p.items.length && p.items.every((i) => i.status === 'live' || (i.status === 'done' && !i.consumed))) continue;
    const products = [...new Set(p.items.map((i) => i.product))];
    const beta = products.map((x) => betaLink(x)).filter(Boolean) as string[];
    out.push({
      id: `milestone:${m.id}`, kind: 'milestone', title: `Milestone reached: "${m.title}". Playtest it?`, text: null,
      product: m.product ?? (products.length === 1 ? products[0] : null), productName: name(m.product ?? (products.length === 1 ? products[0] : null)),
      context: `${p.done}/${p.total} items on beta with their checks passed: ${p.items.map((i) => i.title).join(' · ')}${m.test ? `. You said you'd test: ${m.test}` : ''}`,
      asker: 'Studio PM', recommendation: 'Playtest it on beta', options: ['Go live', 'Something is wrong', 'Later'],
      blocks: `going live with ${p.total} item(s)`, since: m.reached_at ?? m.created, weight: 35,
      links: [...beta.map((url) => ({ label: 'Play it on beta', url })), { label: 'What to test', url: '#ready' }], subject: m.id, conversation: m.origin, asks: 1,
    });
  }

  // What blocks most first; the age of a wait counts too (a day adds as much as a task waiting behind it).
  const score = (x: InboxItem) => x.weight + Math.min((Date.now() - x.since) / HOUR, 96) / 2.4;
  return out.sort((a, b) => score(b) - score(a) || a.since - b.since);
}

/** "3 decisions in your Inbox" (or null when it's empty): what Talk and the PM say instead of listing them. */
export async function inboxLine() {
  const n = (await inbox()).length;
  return n ? `${n} decision${n === 1 ? '' : 's'} in your Inbox` : null;
}

/** Answers lately, with who gave them (the Inbox's "answered" list). */
export function recentAnswers(days = 7) {
  const since = Date.now() - days * 86_400_000;
  const qs = answeredSince(since, 30).filter((q) => q.answered_by !== 'Studio').map((q) => ({ id: q.id, title: firstLine(q.text), answer: q.answer, by: q.answered_by, at: q.answered_at, product: q.product }));
  const acks = (db.prepare('SELECT * FROM inbox_acks WHERE at >= ? ORDER BY at DESC LIMIT 20').all(since) as any[]).map((r) => ({ id: String(r.id).split('@')[0], title: r.title ?? r.id, answer: r.answer, by: r.by, at: r.at, product: null }));
  const cards = (db.prepare(`SELECT id, card, status, decided_by, decided_at, result FROM approvals WHERE decided_at >= ? ORDER BY decided_at DESC LIMIT 20`).all(since) as any[])
    .map((r) => ({ id: r.id, title: parse(r.card)?.title ?? r.id, answer: `${r.status}${r.result ? `: ${r.result}` : ''}`, by: r.decided_by, at: r.decided_at, product: null }));
  return [...qs, ...acks, ...cards].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 30);
}

// ----------------------------------------------------------------- who

const isJ = (s: string | null | undefined) => /^J\b/.test(String(s ?? ''));

/**
 * Who is acting on a request, for every answer, merge, revise and close: J on the dashboard (or the CLI on his PC);
 * J through Talk only during a turn J's own message started; otherwise Talk, or the PM in its conversation, whatever
 * the caller claims (a PM turn never acts as J).
 */
export async function actor(req: http.IncomingMessage, claimed?: unknown): Promise<string> {
  const { callerOf } = await import('./memory-api.ts');
  const c = callerOf(req);
  const claim = typeof claimed === 'string' && claimed.trim() ? claimed.trim().slice(0, 60) : null;
  if (c.who === 'J') return claim ?? 'J';
  if (c.who === 'agent' || c.who === 'scout') return `${c.who} ${c.id}`;
  const { turnBy } = await import('./talk.ts');
  const jTurn = c.id ? turnBy(c.id) === 'J' : false;
  if (c.who === 'pm') return jTurn && (!claim || isJ(claim)) ? 'J (in the PM conversation)' : 'Talk (PM)';
  if (jTurn && (!claim || isJ(claim))) return 'J (via Talk)';
  return claim && /^Talk\b/.test(claim) ? claim : 'Talk';
}

// --------------------------------------------------------------- answering

const YES = /^\s*(yes|y|yep|yeah|ok|okay|sure|do it|go|go ahead|agreed|fine|approve[d]?|sounds good|👍)\b/i;
const NO = /^\s*(no|nope|not now|later|skip|park|don'?t)\b/i;

/**
 * Answers one Inbox card. id: q_... (a question), gpu:k_..., merge:c_..., milestone:n_... answer: one of its options or
 * free text. by: actor(). conversation: the Talk conversation the answer came through (for typed confirmations).
 */
export async function answerInbox(id: string, answer: string, by: string, opts: { confirm?: string; conversation?: string | null } = {}) {
  const text = String(answer ?? '').trim();
  if (!text) throw new StudioError('Say the answer (one of the options, or your own words)');
  const pm = await import('./pm.ts');
  if (id.startsWith('approval:')) throw new StudioError('An Approve / Deny card is decided only by J\'s tap on its buttons (the Inbox or the Talk chat), not by an answer.', 403);
  if (/^q_[0-9a-f]+$/.test(id)) return { answered: id, by, question: await pm.answerQuestion(id, text, by) };
  const jOnly = (what: string) => {
    if (!isJ(by)) throw new StudioError(`${what} is J's call (answered by ${by}). Ask J; he answers in the Inbox or in his own words in Talk.`);
  };
  let m = /^gpu:(k_[0-9a-f]+)$/.exec(id);
  if (m) {
    jOnly('A GPU budget');
    const t = getTask(m[1]);
    if (!t) throw new StudioError(`No task ${m[1]}`, 404);
    const r = await gpuAnswer(t, text, by, null);
    record(id, by, text, `GPU budget for "${t.title}"`);
    return { answered: id, by, ...r };
  }
  m = /^merge:(c_[0-9a-f]+)$/.exec(id);
  if (m) {
    jOnly('Merging this change');
    const c = changeRow(m[1]);
    if (!c) throw new StudioError(`No change ${m[1]}`, 404);
    const agents = await import('./agents.ts');
    if (/^\s*(merge|approve|yes|ok|go|ship)/i.test(text)) {
      const words = `MERGE ${c.id}`;
      if (c.infra) {
        // Into main deploys Studio or Gen: J types the words (the dashboard asks; in Talk, his own latest message).
        const { jTyped } = await import('./guards.ts');
        if (opts.confirm !== words && !jTyped(opts.conversation, words)) throw new StudioError(`Merging ${c.id} into main deploys ${name(c.product)}: J types "${words}" to confirm.`);
      }
      const merged = await agents.approve(c.id, { confirm: words, by, origin: opts.conversation ?? null });
      record(id, by, text, `Merge "${c.title ?? c.id}"`);
      return { answered: id, by, change: merged };
    }
    if (/^\s*close\b/i.test(text)) {
      const closed = await agents.close(c.id, by);
      record(id, by, text, `Merge "${c.title ?? c.id}"`);
      return { answered: id, by, change: closed };
    }
    const note = text.replace(/^\s*ask for changes\s*[:\-–]?\s*/i, '').trim();
    if (!note) throw new StudioError('Say what the agent should change');
    const revised = agents.revise(c.id, note, by);
    record(id, by, text, `Merge "${c.title ?? c.id}"`);
    return { answered: id, by, change: revised };
  }
  m = /^milestone:(n_[0-9a-f]+)$/.exec(id);
  if (m) {
    jOnly('A milestone');
    const ms = getMilestone(m[1]);
    if (!ms) throw new StudioError(`No milestone ${m[1]}`, 404);
    const key = `milestone:${ms.id}:${ms.reached_at ?? 0}`;
    if (/^\s*go live\b/i.test(text)) {
      // Going live stays the deploy plan and J's typed words; the card stays until it's live.
      const products = [...new Set(milestoneProgress(ms.id).items.map((i) => i.product))];
      return { answered: null, by, next: 'deploy', products, note: `Going live is the deploy plan, then "DEPLOY <product>" typed by J (${products.join(', ')}).` };
    }
    if (/^\s*later\b/i.test(text)) {
      ack(key, by, text, Date.now() + 24 * HOUR, `Milestone "${ms.title}"`);
      return { answered: id, by, snoozed: '24 h' };
    }
    const what = text.replace(/^\s*something is wrong\s*[:\-–]?\s*/i, '').trim();
    if (!what) throw new StudioError('Say what is wrong: the PM turns it into tasks');
    addComment(ms.id, what, by);
    pm.pmEvent('feedback', `${by} playtested milestone ${ms.id} ("${ms.title}") and says: "${what}". Turn it into tasks on its items (or a new item in it), and say so in a line.`, ms.id, ms.product);
    ack(key, by, what, null, `Milestone "${ms.title}"`);
    return { answered: id, by, told: 'the PM' };
  }
  throw new StudioError(`No Inbox item ${id}`, 404);
}

/** J's answer about a GPU budget (from its card, or its question): approve, not now, or price it again. */
export async function gpuAnswer(t: Task, text: string, by: string, q: Question | null) {
  const amount = Number(/\$?\s*(\d+(?:\.\d+)?)/.exec(text)?.[1] ?? /\$(\d+(?:\.\d+)?)/.exec(q?.recommendation ?? '')?.[1] ?? NaN);
  const est = t.gpu?.estimate;
  const fallback = est && !est.error ? Math.ceil(est.cost * 1.25 * 100) / 100 : NaN;
  if (/^\s*price/i.test(text)) return { task: await estimateTask(t.id) };
  if (NO.test(text)) {
    return { task: updateTask(t.id, { status: 'idea', note: `GPU budget: not now (${by})` }) };
  }
  if (YES.test(text) || /^\s*approve/i.test(text) || /^\s*\$?\d/.test(text)) {
    const budget = Number.isFinite(amount) ? amount : fallback;
    if (!Number.isFinite(budget)) throw new StudioError('Say the budget in dollars (it could not be priced)');
    return { task: approveGpu(t.id, budget, by) };
  }
  throw new StudioError(`For a GPU budget answer "Approve $<amount>", "Not now" or "Price it again" (got "${text.slice(0, 80)}")`);
}

export const isYes = (s: string) => YES.test(s);
