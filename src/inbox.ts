// The Inbox: one place for everything waiting on J, across every Talk conversation, agent and the PM loop.
//
//   questions   decisions filed with askJ (the PM's, Talk's, an agent's question passed on) and agent questions nobody
//               else will answer (J's own requests, or no PM loop running here)
//   GPU budgets content tasks that wait for J to approve a budget (roadmap.ts tasksAwaitingGpu)
//   merges      ready changes only J may merge: Studio and Gen (into main, which deploys), changes the PM doesn't
//               review (J's own requests, work from before the loop), everything while delegated merges are off
//   milestones  reached: every task merged and built on beta, its criteria judged by one beta playtest; J's turn to playtest (with the beta link)
//
// Each card says what it blocks and since when, who asked and what they recommend, with options, a free-text answer and
// links. Cards are sorted by what they block most. Answering routes the way it always did (an agent resumes, the PM's
// next turn hears J's decision, a budget is approved, a change merges) and the card goes. Answers record who gave them
// (actor()): J on the dashboard, J through Talk only in a turn J started, otherwise Talk or the PM by name.
// No phone notifications here: the dashboard's badge is the signal.

import { isVideoTask, listVideos } from './videos.ts';
import type http from 'node:http';
import { db, parse } from './db.ts';
import { getProduct, getInfra, isInfra, loadProducts, managedElsewhere, StudioError } from './config.ts';
import { fixerNow, latestChain, attemptsText, type FixerNow } from './buildfix.ts';
import { openAccess, recheckAccess, accessLinks, accessGroups, type AccessRow } from './buildaccess.ts';
import { failingBuilds, failSignature, lastBuilds } from './buildfail.ts';
import {
  listQuestions, getQuestion, setQuestion, answeredSince, getTask, getItem, getMilestone, listMilestones, milestoneProgress, milestoneTasks, tasksAwaitingGpu,
  approveGpu, updateTask, estimateTask, addComment, gpuBudgetFor, gpuAutoApprovedToday, gpuDigestTasks, type Question, type Task,
} from './roadmap.ts';
import { walkAwayOn, walkAwaySettings, gpuAutoApproveLimit } from './walkaway.ts';
import { gate } from './acceptance.ts';
import { listApprovals, type Approval } from './approvals.ts';
import { contradictionSettled } from './memory-curate.ts';
import { creditsWaiting, creditsBack } from './creditwait.ts';
import { closeCleared, causeOf, cardCause, logCards, mergeByCause, openFix, logCause, causeLog, fixingNow, settledLately, RETRY_LIMIT, SELF_BY } from './causes.ts';

// Answers to the cards that aren't questions (budgets, merges, milestones): what was answered, by whom, and for a
// milestone how long its card stays away (until; null: for good).
db.exec(`CREATE TABLE IF NOT EXISTS inbox_acks (id TEXT PRIMARY KEY, at INTEGER NOT NULL, by TEXT, answer TEXT, until INTEGER)`);
try { db.exec('ALTER TABLE inbox_acks ADD COLUMN title TEXT'); } catch { /* already there */ }

export type InboxLink = { label: string; url?: string; video?: string };
export type InboxItem = {
  /** q_... for a question; gpu:k_..., merge:c_..., milestone:n_... for the others. */
  id: string;
  kind: 'question' | 'agent' | 'gpu' | 'merge' | 'milestone' | 'approval' | 'video' | 'build' | 'access' | 'credits' | 'ai';
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
  /** Its cause key (causes.ts: token-expired, studio-restart, conflict, access:<permission>@<repo>, ...), or null. */
  cause?: string | null;
  /** Cards with the same cause and product folded into this one: how many in all, and the ids an answer also reaches. */
  count?: number; merged?: string[];
  /** The Studio fix task for its cause (causes.ts), when the cause came up twice in a week: "Fixing the cause". */
  fixing?: { task: string; title: string; status: string } | null;
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
    // A task found already done (pm.ts everyTrySaidDone, or by hand) has nothing left to decide; what's left that needs J stays.
    if (q.subject?.startsWith('k_') && q.topic !== 'needs J' && getTask(q.subject)?.status === 'done') why = 'the task is already done';
    if (q.forwards) {
      const f = getQuestion(q.forwards);
      if (f && !['open', 'asked J'].includes(f.status)) why = `the agent's question was ${f.status}${f.answered_by ? ` by ${f.answered_by}` : ''}`;
    }
    // Memory curation's contradiction cards: one side deleted, faded or settled, or its twin answered.
    if (!why) why = contradictionSettled(q);
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

/**
 * A failed build whose earlier attempt (same project and build) failed the same way and had its card answered (Build again,
 * Dismiss): it isn't filed again, so a rebuild that fails identically doesn't make the card go and come back. A different
 * reason is a new card (buildfail.ts failSignature).
 */
function buildCardAnswered(f: { id: string; product: string; build: string; class: string | null; reason: string }): boolean {
  const sig = failSignature({ build: f.build, fail_class: f.class, detail: f.reason });
  // A chain the fixers gave up on is the owner's card, even when the same failure's earlier card was answered by the rebuild.
  if (latestChain(f.product, f.build)?.status === 'escalated') return false;
  const rows = db.prepare("SELECT id, build, fail_class, detail FROM builds WHERE product = ? AND build = ? AND change IS NULL AND status = 'failed' AND id != ?").all(f.product, f.build, f.id) as any[];
  return rows.some((r) => failSignature(r) === sig && acked(`build:${r.id}`));
}

/** What the automatic fixer is doing about a code failure (buildfix.ts fixerNow): the sentence and the change's link. */
function fixLine(f: { kind: string | null; class: string | null; build: string; reason: string; product: string }): { text: string; links: InboxLink[] } {
  if (f.kind !== 'code') return { text: '', links: [] };
  const now: FixerNow = fixerNow(failSignature({ build: f.build, fail_class: f.class, detail: f.reason }), f.product);
  if (now.state === 'exhausted') {
    // What was tried, with each change linked (buildfix.ts chain): the owner starts from there.
    const chain = latestChain(f.product, f.build);
    const tried = chain?.attempts.length ? `\n\nWhat was tried:\n${attemptsText(chain, { full: false })}` : '';
    return { text: `\n\nAgents already tried to fix this and the build still fails: it needs you.${chain?.reason ? ` ${chain.reason}.` : ''}${tried}`, links: (chain?.attempts ?? []).map((a, i) => ({ label: `Attempt ${i + 1}: change ${a.change}`, url: `#changes/${a.change}` })) };
  }
  // f.plain already carries the working / merged sentence (buildfail.ts withFixer).
  return { text: '', links: now.url ? [{ label: `Fix change ${now.change}`, url: now.url }] : [] };
}

/**
 * A rebuild started: the failed builds' cards are answered ("Build again"), so they go now and don't wait for the new
 * build to show a row. Called by builds.ts startBuild, whichever button started it.
 */
export async function resolveBuildCards(product: string, builds: string[], by: string) {
  for (const r of lastBuilds(product)) {
    if (r.status !== 'failed' || !builds.includes(r.build) || acked(`build:${r.id}`)) continue;
    ack(`build:${r.id}`, by, 'Build again', null, `Build ${r.build} of ${product}`);
  }
}

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

  // Approve / Deny cards waiting (they wait until he answers: first). Their merge or budget card isn't shown twice.
  // Ones whose action already happened (a merged or closed change, a go live since) were settled by listApprovals.
  const cards = listApprovals({ pending: true }, tokens).filter((a) => a.status === 'pending');
  const carded = new Set(cards.map((a) => `${a.kind}:${a.target}`));
  for (const a of cards) {
    out.push({
      id: `approval:${a.id}`, kind: 'approval', title: a.card.title, text: null, product: null, productName: null, context: a.card.lines[0] ?? null,
      asker: a.requested_by ?? 'Studio', recommendation: null, options: [], blocks: `${a.kind} ${a.target}`, since: a.created, weight: 60,
      links: [], subject: a.target, conversation: a.conversation, asks: 1, approval: a,
    });
  }
  await closeCleared().catch((e) => console.warn(`[inbox] closing cards whose cause cleared: ${e?.message ?? e}`));
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
      subject: q.subject, conversation: q.origin, asks: q.asks, cause: (q as any).cause ?? null,
    });
  }

  // Walk-away mode: Studio approved what fits its caps; what's above them is ONE digest card (not a card per task).
  const walk = walkAwayOn();
  const gpuWaits = tasksAwaitingGpu();
  // Only what's really above the caps (roadmap.ts gpuDigestTasks): $0 and what fits are Studio's, unpriced ones it prices.
  const threshold = await gpuAutoApproveLimit();
  const digest = walk && gpuWaits.length ? gpuDigestTasks({ threshold }) : [];
  if (digest.length) {
    const total = digest.reduce((a, x) => a + (x.amount ?? 0), 0);
    const wa = walkAwaySettings();
    const ask = total > 0 ? `Approve all ($${total.toFixed(2)})` : 'Price them again';
    out.push({
      id: 'gpu:digest', kind: 'gpu',
      title: total > 0 ? `Approve GPU budgets for ${digest.length} task(s), $${total.toFixed(2)} in all?` : `${digest.length} task(s) generate on the GPU but couldn't be priced. Price them again?`,
      text: digest.map((x) => `- "${x.task.title}" (${name(x.task.product)}): ${x.amount !== null ? `$${x.amount.toFixed(2)}` : "couldn't be priced"}`).join('\n'),
      product: null, productName: null,
      context: `Above what Studio approves by itself in walk-away mode ($${threshold} a task, $${wa.walkAwayGpuPerDay} a day; $${gpuAutoApprovedToday().toFixed(2)} approved today)`,
      asker: 'Studio PM', recommendation: ask, options: [ask, 'Not now'],
      blocks: `${digest.length} task(s) can't start`, since: Math.min(...digest.map((x) => x.task.updated ?? x.task.created)), weight: 25 + digest.length * 5, links: [],
      subject: null, conversation: null, asks: 1,
    });
  }
  for (const t of walk ? [] : gpuWaits) {
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
    // Videos are screened, not merged (videos.ts): their own card below.
    if (isVideoTask(c.task)) continue;
    // J approved it already; main moved and it merges once CI is green (agents.ts mergeApprovedInfra).
    if (c.infra && (c as any).approved) continue;
    // Walk-away mode: Studio/Gen changes merge by themselves once green; only one held for J shows (protected files,
    // failed after its tries).
    if (c.infra && walk && !String((c as any).auto_merge ?? '').startsWith('held')) continue;
    const pmReviews = handled && settings.delegatedMerges && pm.reviewable(c);
    if (pmReviews || carded.has(`merge:${c.id}`)) continue;
    const g = c.infra ? null : gate(c.verify, c.criteria);
    const v = c.verify ?? {};
    const into = c.infra ? 'main' : 'beta';
    const blocker = c.findings.some((f) => (db.prepare('SELECT severity FROM findings WHERE id = ?').get(f) as any)?.severity === 'blocker');
    const held = String((c as any).auto_merge ?? '').startsWith('held') ? String((c as any).auto_merge).slice(6) : null;
    const why = c.infra ? `a ${name(c.product)} change (merging into main deploys it)${held ? `; it waits for you: ${held}` : ''}` : !pm.reviewable(c) ? (c.request ? 'your own request' : 'from before the PM loop') : 'delegated merges are off';
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

  // A build that failed for good (its automatic retries used up): what failed, why in plain words, and the Build again button.
  // It goes by itself when a newer build of it works; "Dismiss" hides it (buildfail.ts).
  for (const p of loadProducts()) {
    if (managedElsewhere(p)) continue;
    for (const f of failingBuilds(p.id)) {
      if (!f.finished || Date.now() - f.finished > 7 * 24 * HOUR || acked(`build:${f.id}`) || buildCardAnswered(f)) continue;
      // The gate (causes.ts): a build that failed for a transient reason (an expired token, the network, a restart) is built
      // again by Studio, up to RETRY_LIMIT times a day; only the last failure shows, saying what was tried.
      const cause = f.kind === 'code' ? null : causeOf(f.reason);
      const tried = cause?.cls === 'transient' ? causeLog(cause.key, 24 * HOUR).filter((r) => r.kind === 'rebuilt' && r.subject === `${p.id}/${f.build}`) : [];
      if (cause?.cls === 'transient' && tried.length < RETRY_LIMIT && (await rebuildForCause(p.id, f, cause))) continue;
      const triedLine = tried.length ? `\n\nAlready tried: Studio built it again ${tried.length} time${tried.length === 1 ? '' : 's'} by itself (${tried.map((r) => new Date(r.at).toISOString().slice(11, 16)).join(', ')} UTC) because it looked like ${cause!.label}, and it still fails.` : '';
      out.push({
        id: `build:${f.id}`, kind: 'build', title: `${p.name}: build ${f.build} ${f.version} failed${f.sha ? ` (${f.sha.slice(0, 7)})` : ''}`,
        text: `${f.plain}${fixLine(f).text}${triedLine}\n\nReason: ${f.reason}${f.genJob ? `\nGen job: ${f.genJob}` : ''}`.slice(0, 1800),
        product: p.id, productName: p.name, context: `${f.kind === 'infrastructure' ? 'Infrastructure' : f.kind === 'code' ? 'The code' : 'Cause unclear'}${f.stepWords ? `, while ${f.stepWords}` : ''}${f.tries > 1 ? `, after ${f.tries} tries` : ''}. ${f.plain}`.slice(0, 400),
        asker: 'Studio', recommendation: f.kind === 'code' ? null : 'Build again', options: ['Build again', 'Dismiss'], blocks: `${p.name} going live (the build is what ships)`,
        since: f.finished, weight: 50, links: [...fixLine(f).links, { label: 'Why did this fail?', url: `#build-why/${p.id}/${f.id}` }, ...(f.run ? [{ label: 'The run', url: '#runs' }] : [])],
        subject: p.id, conversation: null, asks: 1, cause: cause?.key ?? null,
      });
    }
  }

  // GitHub access a build needs (buildaccess.ts): ONE card per project with the exact fix and the link. Looked at now, as the
  // Inbox opens (never on a timer): access back means the builds start again and the card goes.
  // One card per fix, not per project: projects on the same GitHub account missing the same thing share it, since one
  // accept on that account's installation page fixes them all (ghperms.ts).
  await recheckAccess().catch((e) => console.warn(`[inbox] checking GitHub access: ${e?.message ?? e}`));
  for (const group of accessGroups(openAccess())) {
    const named = group.map((a) => ({ a, p: loadProducts().find((x) => x.id === a.product) })).filter((x) => x.p && !managedElsewhere(x.p));
    if (!named.length) continue;
    const { a, p } = named[0] as { a: AccessRow; p: NonNullable<(typeof named)[0]['p']> };
    const names = named.map((x) => x.p!.name);
    const builds = named.flatMap((x) => x.a.builds.map((b) => (named.length > 1 ? `${x.p!.name} ${b}` : b)));
    const where = named.length > 1 ? `${a.slug?.split('/')[0] ?? 'GitHub'} (${names.join(', ')})` : a.slug ?? 'the repository';
    const links = await accessLinks(a);
    out.push({
      id: `access:${a.id}`, kind: 'access', title: `${named.length > 1 ? names.join(', ') : p.name}: Studio needs ${a.what === 'permission' ? `"${a.permission}"` : a.what === 'install' ? 'its GitHub app installed' : 'access'} on ${where}`,
      text: `${a.detail ?? ''}\n\nWaiting: ${builds.join(', ')}. Studio checks again by itself when GitHub says it's done or you come back here; "Check again" looks right now.`.trim(),
      product: p.id, productName: p.name, context: a.detail, asker: 'Studio', recommendation: 'Check again', options: ['Check again'],
      blocks: `${names.join(', ')} builds (${builds.join(', ')})`, since: Math.min(...named.map((x) => x.a.opened)), weight: 55, links, subject: p.id, conversation: null, asks: 1,
      cause: `access:${String(a.what === 'permission' ? a.permission ?? 'permission' : a.what).toLowerCase().replace(/\s+/g, '')}@${a.slug ?? p.id}`,
    });
  }

  // Out of credits (creditwait.ts): ONE card, not one per refused run. Nothing failed; paid work starts again by itself when
  // credits are added (the ledger's write), or on "Check again".
  const cw = creditsWaiting();
  if (cw) {
    out.push({
      id: 'credits:wait', kind: 'credits', title: 'Waiting for credits: paid work is paused',
      text: `${cw.message}\n\nNothing failed and no agent was sent back: ${cw.runs.length} run${cw.runs.length === 1 ? ' was' : 's were'} held. Add credits (Settings → Plan and credits); the waiting beta playtest plays once by itself when they arrive.`,
      product: null, productName: null, context: cw.need != null && cw.have != null ? `Needs ${cw.need.toLocaleString('en-US')}, ${cw.have.toLocaleString('en-US')} left.` : null,
      asker: 'Studio', recommendation: 'Check again', options: ['Check again'], blocks: 'beta playtests and new agent work',
      since: cw.since, weight: 60, links: [{ label: 'Plan and credits', url: '#settings' }], subject: null, conversation: null, asks: 1,
    });
  }

  // The AI providers (providers.ts): ONE card, only when J is truly needed: a provider he uses is signed out or needs
  // billing, or nothing at all can take work (every provider limited or broken). Usage limits and outages with another
  // provider answering heal by themselves (the work moves; the provider comes back when a probe answers), so no card.
  // The card goes away by itself once healed: it is rebuilt from the holds every time.
  const ai = await import('./providers.ts').then((P) => ({ P, t: P.providerTrouble() })).catch(() => null);
  if (ai?.t) {
    const { P, t } = ai;
    const { LABEL, needsJ, whenUtc } = await import('./harness-hold.ts');
    const signedOut = t.holds.filter((h) => needsJ(h.kind));
    const s = P.providerSettings();
    const resets = t.holds.filter((h) => !needsJ(h.kind)).map((h) => `${LABEL[h.harness]} ${h.reset ? 'resets' : 'is tried again'} ${whenUtc(h.until)}`);
    const title = t.stuck
      ? `AI work is paused: no provider can take it${signedOut.length ? ` (${signedOut.map((h) => LABEL[h.harness]).join(', ')} need${signedOut.length === 1 ? 's' : ''} you)` : ''}`
      : signedOut.length === 1 ? `${LABEL[signedOut[0].harness]} needs you: ${signedOut[0].why}` : `${signedOut.length} AI providers need you`;
    const fix = signedOut.map((h) => h.kind === 'auth' && h.harness === 'copilot' && /classic personal access token|ghp_/i.test(`${h.why} ${h.line ?? ''}`)
      ? 'Copilot was given a classic GitHub token (ghp_), which it refuses: Settings → AI providers → Copilot → Sign in (your GitHub account), or a fine-grained token with the account permission "Copilot Requests".'
      : h.kind === 'auth' ? `Sign ${LABEL[h.harness]} in again: Settings → AI providers → Sign in.` : `${LABEL[h.harness]}: pay or raise what its account asks for, then Check again.`);
    const text = [
      t.lines.join('\n'),
      fix.join('\n'),
      t.stuck
        ? `Nothing failed: agent passes and scouts are parked with their work and continue by themselves the moment any provider answers.${resets.length ? ` ${resets.join('; ')}.` : ''}${s.mode === 'one' && t.others.length ? ` Other providers are signed in (${t.others.map((h) => LABEL[h]).join(', ')}): "Use every signed-in provider" lets them take the work now.` : ' Signing in another provider (Settings → AI providers) lets it take the work now.'}`
        : `Nothing stopped: ${P.readyHarnesses(s).map((h) => LABEL[h]).join(', ')} carr${P.readyHarnesses(s).length === 1 ? 'ies' : 'y'} the work meanwhile.`,
    ].filter(Boolean).join('\n\n');
    const options = ['Check again'];
    if (s.mode === 'one' && t.others.length) options.push('Use every signed-in provider');
    for (const h of signedOut.slice(0, 2)) if (P.readyHarnesses(s).length || t.others.some((x) => x !== h.harness)) options.push(`Stop using ${LABEL[h.harness]}`);
    out.push({
      id: 'ai:providers', kind: 'ai', title, text, product: null, productName: null, context: t.lines[0] ?? null,
      asker: 'Studio', recommendation: signedOut.length ? null : 'Check again', options,
      blocks: t.stuck ? 'every agent pass, scout and PM start' : `${signedOut.map((h) => LABEL[h.harness]).join(', ')} (the others carry on)`,
      since: t.since, weight: t.stuck ? 70 : 40,
      links: [{ label: signedOut.length ? 'Sign in (Settings → AI providers)' : 'AI providers', url: '#settings/ai' }], subject: null, conversation: null, asks: 1,
    });
  }

  // A video version waiting for J to screen it (videos.ts): watch it here or in the Screening tab; a typed answer is a note.
  for (const v of (await listVideos()).filter((x) => (x.state === 'ready to screen' || x.state === 'animatic ready') && x.latest)) {
    const anim = v.state === 'animatic ready';
    if (acked(`video:${v.id}:${v.latest!.n}`)) continue;
    out.push({
      id: `video:${v.id}`, kind: 'video', title: `${anim ? 'Animatic ready' : 'Ready to screen'}: "${v.title.replace(/^Video:\s*/, '')}" v${v.latest!.n}`, text: v.latest!.summary, product: v.product, productName: name(v.product),
      context: v.latest!.summary ? `v${v.latest!.n}: ${v.latest!.summary.slice(0, 300)}` : null, asker: 'Studio', recommendation: null,
      options: anim ? ['Approve the animatic'] : ['Approve', 'Approve and post drafts'], blocks: anim ? 'the final render of this video' : 'the next version of this video', since: v.latest!.at, weight: 25,
      links: [{ label: `Watch v${v.latest!.n}`, video: v.latest!.asset }, { label: 'Open in Screening', url: `#videos/${v.id}` }],
      subject: v.id, conversation: null, asks: 1,
    });
  }

  for (const m of listMilestones({ status: 'reached' })) {
    const key = `milestone:${m.id}:${m.reached_at ?? 0}`;
    if (acked(key)) continue;
    const p = milestoneProgress(m.id);
    // Live, or done by hand (not consumed: done because its tasks were created, which is still to playtest).
    if (p.items.length && p.items.every((i) => i.state === 'live' || (i.status === 'done' && !i.consumed))) continue;
    const products = [...new Set(p.items.map((i) => i.product))];
    const beta = products.map((x) => betaLink(x)).filter(Boolean) as string[];
    // Reached with criteria still missed (only after its tries, pm.ts milestoneCheck): the card says what's left.
    const left = milestoneTasks(m.id).flatMap((t) => (t.checks?.where === 'beta' ? t.checks.results : [])).filter((r) => r.met !== 'yes');
    out.push({
      id: `milestone:${m.id}`, kind: 'milestone', title: left.length ? `Milestone "${m.title}": ${left.length} criteria still not met on beta after its tries. Playtest it?` : `Milestone reached: "${m.title}". Playtest it?`,
      text: left.length ? `What's left: ${left.map((r) => `${r.criterion} (${r.met}${r.evidence ? `: ${r.evidence}` : ''})`).join('; ')}`.slice(0, 1500) : null,
      product: m.product ?? (products.length === 1 ? products[0] : null), productName: name(m.product ?? (products.length === 1 ? products[0] : null)),
      context: `${p.done}/${p.total} items on beta (every task merged and built)${(() => {
        // The milestone's beta playtest (pm.ts milestoneCheck): how many of its tasks' criteria it saw met.
        const results = milestoneTasks(m.id).flatMap((t) => (t.checks?.where === 'beta' ? t.checks.results : []));
        return results.length ? `; beta's playtest: ${results.filter((r) => r.met === 'yes').length} of ${results.length} criteria met` : '';
      })()}: ${p.items.map((i) => i.title).join(' · ')}${m.test ? `. You said you'd test: ${m.test}` : ''}`,
      asker: 'Studio PM', recommendation: 'Playtest it on beta', options: ['Go live', 'Something is wrong', 'Later'],
      blocks: `going live with ${p.total} item(s)`, since: m.reached_at ?? m.created, weight: 35,
      links: [...beta.map((url) => ({ label: 'Play it on beta', url })), { label: 'What to test', url: '#ready' }], subject: m.id, conversation: m.origin, asks: 1,
    });
  }

  // What blocks most first; the age of a wait counts too (a day adds as much as a task waiting behind it).
  const score = (x: InboxItem) => x.weight + Math.min((Date.now() - x.since) / HOUR, 96) / 2.4;
  out.sort((a, b) => score(b) - score(a) || a.since - b.since);
  // Each card's cause (causes.ts), logged the first time it shows (the second time a cause comes up in a week opens a
  // Studio fix task); one card per cause and product (the most blocking one, with a count); the fix task linked.
  for (const x of out) if (x.cause === undefined) x.cause = cardCause(x)?.key ?? null;
  logCards(out);
  const merged = mergeByCause(out);
  for (const x of merged) x.fixing = x.cause ? openFix(x.cause) : null;
  return merged;
}

/** A transient build failure Studio builds again itself instead of filing (the card is answered "Build again" by it). */
async function rebuildForCause(product: string, f: { id: string; build: string; reason: string }, cause: ReturnType<typeof causeOf> & {}) {
  try {
    const r = await (await import('./builds.ts')).startBuild(product, { build: f.build });
    ack(`build:${f.id}`, SELF_BY, `Build again (${cause.label})`, null, `Build ${f.build} of ${product}`);
    logCause(cause, { product, kind: 'rebuilt', ref: f.id, subject: `${product}/${f.build}`, detail: `built again (${r?.id ?? 'no run'}): ${f.reason}`, dedup: `rebuilt:${f.id}` });
    return true;
  } catch (e: any) {
    console.warn(`[inbox] ${product}/${f.build}: couldn't build it again by itself: ${e?.message ?? e}`);
    return false;
  }
}

/** What the Inbox page shows above the cards: the causes being fixed, and what Studio settled itself in the last day. */
export function selfHealing() {
  return { fixing: fixingNow(), settled: settledLately() };
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
  // A card that folded others with the same cause (causes.ts mergeByCause): its answer reaches each of them.
  // Questions: the other open ones with its cause and product (the table says); other cards: what the Inbox folded.
  let merged: string[] = [];
  const q = /^q_[0-9a-f]+$/.test(id) ? (db.prepare('SELECT cause, product FROM questions WHERE id = ?').get(id) as any) : null;
  if (q?.cause) merged = (db.prepare(`SELECT id FROM questions WHERE cause = ? AND COALESCE(product, '') = ? AND id != ? AND status IN ('open', 'asked J') AND kind = 'decision' AND COALESCE(topic, '') != 'gpu'`).all(q.cause, q.product ?? '', id) as any[]).map((r) => r.id);
  else if (!q && /^(build|access):/.test(id)) merged = (await inbox()).find((x) => x.id === id)?.merged ?? [];
  const out = await answerOne(id, answer, by, opts);
  const also: string[] = [];
  for (const m of merged) {
    try { await answerOne(m, answer, by, opts); also.push(m); } catch (e: any) { console.warn(`[inbox] ${m} (same cause as ${id}): ${e?.message ?? e}`); }
  }
  return also.length ? { ...out, alsoAnswered: also } : out;
}

async function answerOne(id: string, answer: string, by: string, opts: { confirm?: string; conversation?: string | null } = {}) {
  const text = String(answer ?? '').trim();
  if (!text) throw new StudioError('Say the answer (one of the options, or your own words)');
  const pm = await import('./pm.ts');
  if (id.startsWith('approval:')) throw new StudioError('An Approve / Deny card is decided only by J\'s tap on its buttons (the Inbox or the Talk chat), not by an answer.', 403);
  if (/^q_[0-9a-f]+$/.test(id)) return { answered: id, by, question: await pm.answerQuestion(id, text, by) };
  const jOnly = (what: string) => {
    if (!isJ(by)) throw new StudioError(`${what} is J's call (answered by ${by}). Ask J; he answers in the Inbox or in his own words in Talk.`);
  };
  if (id === 'gpu:digest') {
    jOnly('GPU budgets');
    // What the card showed: the tasks above the caps (roadmap.ts gpuDigestTasks), not every waiting one.
    const waits = gpuDigestTasks({ threshold: await gpuAutoApproveLimit() }).map((x) => x.task);
    const out: unknown[] = [];
    for (const t of waits) {
      const est = t.gpu?.estimate;
      if (NO.test(text)) out.push(await gpuAnswer(t, text, by, null));
      else if (est && !est.error) out.push(await gpuAnswer(t, `Approve $${gpuBudgetFor(est.cost).toFixed(2)}`, by, null));
      else out.push(await gpuAnswer(t, 'Price it again', by, null));
    }
    record(id, by, text, `GPU budgets for ${waits.length} task(s)`);
    return { answered: id, by, tasks: out.length };
  }
  // A video: Approve (and post drafts), or anything else is a note for the next version (videos.ts).
  const vm = /^video:(k_[0-9a-f]+)$/.exec(id);
  if (vm) {
    const videos = await import('./videos.ts');
    if (/^approve/i.test(text)) {
      jOnly('Approving a video');
      // "Approve the animatic, but make Exit Punk louder": what follows the approval is J's guidance for the final.
      const guidance = text.replace(/^approve( the animatic| and post drafts)?[\s,.:;!-]*(but|and|with)?\s*/i, '').trim();
      const r = await videos.approveVideo(vm[1], { by, post: /post/i.test(text), guidance: guidance || undefined });
      record(id, by, text, `approved ${vm[1]}`);
      return { answered: id, by, video: r.video.task.id, social: r.social?.id ?? null };
    }
    const r = await videos.noteVideo(vm[1], text, { by });
    return { answered: id, by, note: r.sent ? 'sent to the agent' : 'kept for its next pass' };
  }
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
      // His "go live" here is his word (golive-policy.ts asksToGoLive): each product goes through the same plan and gate as
      // any go live (beta's exact playtested commit, no blockers), with nothing for him to type. One that can't says why.
      const products = [...new Set(milestoneProgress(ms.id).items.map((i) => i.product))];
      const { deployPlan, queueLive } = await import('./deploy.ts');
      const went: string[] = [];
      const waits: string[] = [];
      for (const pr of products) {
        try {
          const plan: any = await deployPlan(pr, { notesWaitMs: 0 });
          if (plan.blockers?.length) { waits.push(`${pr}: ${plan.blockers.join(' ').slice(0, 300)}`); continue; }
          queueLive('golive', { product: pr, confirm: plan.confirm, by: `${by} (go live on the milestone card)`, beta: plan.beta?.sha });
          went.push(pr);
        } catch (e: any) { waits.push(`${pr}: ${String(e?.message ?? e).slice(0, 300)}`); }
      }
      if (!went.length) return { answered: null, by, next: 'deploy', products, note: `Nothing went live yet. ${waits.join(' | ')}` };
      record(id, by, text, `Milestone "${ms.title}"`);
      return { answered: id, by, wentLive: went, waits, note: `Going live: ${went.join(', ')}.${waits.length ? ` Waiting: ${waits.join(' | ')}` : ''}` };
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
  // The AI card (providers.ts): look again now, switch a provider off, or let every signed-in one take work.
  if (id === 'ai:providers') {
    const P = await import('./providers.ts');
    const H = await import('./harness-hold.ts');
    const off = /^stop using (.+)$/i.exec(text);
    if (off) {
      jOnly('Switching an AI provider off');
      const h = (Object.keys(H.LABEL) as (keyof typeof H.LABEL)[]).find((k) => H.LABEL[k].toLowerCase() === off[1].trim().toLowerCase() || k === off[1].trim().toLowerCase());
      if (!h) throw new StudioError(`No provider "${off[1]}"`);
      P.saveProviders({ use: { [h]: false } }, by);
      return { answered: id, by, off: h, resolved: !P.providerTrouble() };
    }
    if (/every signed-in provider|spread/i.test(text)) {
      jOnly('Using every AI provider');
      P.saveProviders({ mode: 'spread' }, by);
      return { answered: id, by, mode: 'spread', resolved: !P.providerTrouble() };
    }
    await H.recheckHolds();
    const still = P.providerTrouble();
    if (still) throw new StudioError(`Still stopped: ${still.lines.join('; ')}. Studio keeps checking by itself and this card goes away once it answers.`);
    return { answered: id, by, resolved: true };
  }
  // The access card: look again now; back means it rebuilt and resolved, still missing says what is missing.
  if (id === 'credits:wait') {
    const { startBeta } = await import('./pipeline.ts');
    const started = creditsBack((product, o) => startBeta(product, o));
    return { answered: id, by, resolved: true, resumed: started };
  }
  const am = /^access:(x_[0-9a-f]+)$/.exec(id);
  if (am) {
    const row = db.prepare('SELECT product, status FROM build_access WHERE id = ?').get(am[1]) as any;
    if (!row) throw new StudioError(`No access card ${am[1]}`, 404);
    if (row.status !== 'open') return { answered: id, by, resolved: true };
    // The whole card: every project it groups (one accept fixes them all).
    const first = openAccess().find((x) => x.id === am[1]);
    const group = first ? accessGroups(openAccess()).find((g) => g.some((x) => x.id === first.id)) ?? [first] : [];
    let back = false;
    for (const product of new Set(group.map((x) => x.product).concat(row.product))) {
      const r = (await recheckAccess({ product, force: true }))[0];
      back = back || Boolean(r?.back);
    }
    if (!back) throw new StudioError('GitHub still refuses: it is not accepted yet. Open the installation page (the card has the link), press Review request, then Accept new permissions; Studio notices by itself.');
    return { answered: id, by, resolved: true, rebuilding: true };
  }
  // A failed build: build it again (a run), or dismiss the card (the failure stays in the build history).
  const bm = /^build:(b_[0-9a-f]+)$/.exec(id);
  if (bm) {
    const row = db.prepare('SELECT product, build FROM builds WHERE id = ?').get(bm[1]) as any;
    if (!row) throw new StudioError(`No build ${bm[1]}`, 404);
    if (/^\s*build again/i.test(text)) {
      const r = await (await import('./builds.ts')).startBuild(row.product, { build: row.build });
      ack(id, by, text, null, `Build ${row.build} of ${row.product}`);
      return { answered: id, by, run: r?.id ?? null };
    }
    ack(id, by, text, null, `Build ${row.build} of ${row.product}`);
    return { answered: id, by, dismissed: true };
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
