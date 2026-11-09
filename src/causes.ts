// Causes: the one gate in front of J's Inbox, one card per cause, and the root-cause log (J, 2026-11-08: "How come so many
// issues are popping up in my inbox and how come the system doesn't resolve the issues on its own and have you been fixing
// the root cause of all of these problems?").
//
//   causeOf()      every card and every failure gets a cause key: studio-restart, killed-run, token-expired, network,
//                  server-error, rate-limit, gen-restart, cloud-quota, conflict, access:<permission>@<repo>, harness,
//                  or null (no known cause: nothing is merged or counted for it).
//   gateQuestion() askJ (pm.ts) asks it before a question is shown. In order:
//                    1. J-only (money above his caps, a GitHub permission or install, secrets, anything sent as J, going
//                       live): filed as before.
//                    2. a transient cause with a "try again" option: held (never shown) and answered "try again" by Studio
//                       after a backoff (2, 10, 30 minutes; transient.ts heldRetry, a row per wait so a restart carries it
//                       on). Only the last failure of the limit is filed, and it says what was already tried.
//                    3. walk-away mode and a recommendation that spends nothing: the PM answers it with the
//                       recommendation, logged (at most AUTO_ANSWERS times per subject a week, then it's J's).
//   gateCard()     the Inbox's other cards (inbox.ts): a build whose cause is transient and that wasn't retried yet is
//                  built again by Studio (no card); the card that does show says what was tried.
//   mergeByCause() one card per cause and product: the rest fold into it with a count (answering it answers them all).
//   the log        cause_log: every card shown and every failure Studio settled itself, with its cause. The second time a
//                  cause comes up within 7 days (another subject), the PM opens ONE Studio fix task for it (product
//                  hawkesstudio) with the evidence, unless one is open; the cards link to it ("Fixing the cause").
//
// Nothing here runs on a timer that fetches: the gate runs when a card would be filed or the Inbox is read, the fix task
// when a cause is logged, a held retry on its own one-shot timer.

import { db, newId } from './db.ts';
import { isRateLimited, heldRetry, onHeldRetry, heldRetriesOf } from './transient.ts';
import { walkAwayOn } from './walkaway.ts';
import { addItem, addTask, logDecision } from './roadmap.ts';

export type CauseClass = 'transient' | 'j-only' | 'other';
export type Cause = { key: string; label: string; cls: CauseClass };

/** Words that would put a secret into the log: tokens, keys, bearer headers. Never stored. */
export function redact(s: unknown): string {
  return String(s ?? '')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|sk-[A-Za-z0-9_\-]{10,}|xox[abp]-[A-Za-z0-9\-]{10,}|AKIA[0-9A-Z]{12,})/g, '[secret]')
    .replace(/(bearer|token|authorization|password|secret|api[_-]?key)(\s*[:=]\s*|\s+)["']?[A-Za-z0-9_\-.\/+=]{12,}["']?/gi, '$1$2[secret]')
    .replace(/(https?:\/\/)[^\s:@\/]+:[^\s@\/]+@/g, '$1[secret]@');
}

const LABELS: Record<string, string> = {
  'studio-restart': 'Studio restarting',
  'killed-run': 'runs killed or orphaned',
  'token-expired': 'an expired or lost GitHub token',
  network: 'the network',
  'server-error': 'a server error (5xx)',
  'rate-limit': 'a rate limit',
  'gen-restart': 'Hawkes Gen restarting',
  'cloud-quota': 'a cloud quota',
  conflict: 'merge conflicts',
  harness: 'the AI harness stopping',
};
/** Transient: Studio retries them itself. conflict counts as one: a conflict that isn't real goes away on a fresh try. */
const TRANSIENT = new Set(['studio-restart', 'killed-run', 'token-expired', 'network', 'server-error', 'rate-limit', 'gen-restart', 'cloud-quota', 'conflict']);

const mk = (key: string, cls?: CauseClass): Cause => ({ key, label: LABELS[key] ?? key.replace(/^access:/, 'GitHub access: '), cls: cls ?? (TRANSIENT.has(key) ? 'transient' : 'other') });

/** The cause of a failure or a card from its words (most specific first), or null when it isn't one Studio knows. */
export function causeOf(text: unknown, o: { permission?: string | null; repo?: string | null } = {}): Cause | null {
  const e = String(text ?? '');
  if (o.permission || /resource not accessible by integration|isn't installed|not installed on/i.test(e)) {
    const perm = (o.permission ?? /"?([A-Z][a-z]+(?: requests)?: (?:write|read))"? permission/.exec(e)?.[1] ?? 'install').toLowerCase().replace(/\s+/g, '');
    const repo = o.repo ?? /\b([\w.\-]+\/[\w.\-]+)\b(?=[^/]*$)/.exec(e.replace(/https?:\/\/\S+/g, ''))?.[1] ?? 'repo';
    return mk(`access:${perm}@${repo}`, 'j-only');
  }
  if (/studio restarted|restarted \d+ times in a row|stopped by (a|studio'?s?) restart|killed by (a|studio'?s?) restart|studio('s)? restarts?/i.test(e)) return mk('studio-restart');
  if (/hawkes gen (restarted|was restarting|is restarting|didn't answer|is down|unavailable)|gen restarted/i.test(e)) return mk('gen-restart');
  if (/bad credentials|token (has |had )?expired|expired (github |installation )?token|token (was |is )?lost|tokenLost|lost (its|the) token|requires authentication|\b401\b.*github|github.*\b401\b/i.test(e)) return mk('token-expired');
  if (/\bkilled\b|orphan(ed)?|SIGKILL|SIGTERM|exit(ed)? (code |with )?137|signal 9|out of memory|OOM/i.test(e)) return mk('killed-run');
  if (/usage limit|AI harness|billing (is )?out|credit balance is too low/i.test(e)) return mk('harness');
  if (isRateLimited(e)) return mk('rate-limit');
  if (/quota|RESOURCE_EXHAUSTED/i.test(e)) return mk('cloud-quota');
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network (error|is unreachable)|connection (reset|refused|closed)/i.test(e)) return mk('network');
  if (/(^|[^\d$.])(500|502|503|504)([^\d]|$)|bad gateway|service unavailable|gateway time-?out|internal server error/i.test(e)) return mk('server-error');
  if (/merge conflict|conflicts? with|still conflicts|conflicted with/i.test(e)) return mk('conflict');
  return null;
}

/** What only J may decide, whatever its cause: money above his caps, permissions and installs, secrets, as J, going live. */
export function jOnly(q: { text: string; topic?: string | null; options?: string[]; recommendation?: string | null }): string | null {
  const all = `${q.text}\n${(q.options ?? []).join(' ')}\n${q.recommendation ?? ''}`;
  if (q.topic === 'gpu') return 'money (a GPU budget)';
  // Ideas he left undecided (the stall watch asks about ideas holding others up) and new work are direction: his.
  if (q.topic === 'needs J' || q.topic === 'idle' || q.topic === 'stall') return 'what to do next is his';
  if (/\bGPU\b/.test(q.text)) return 'money (GPU generation)';
  if (/\$\s?\d/.test(`${(q.options ?? []).join(' ')} ${q.recommendation ?? ''}`)) return 'money';
  if (/\b(secret|api key|password|private key|credentials? (for|to))\b/i.test(all)) return 'a secret';
  if (/permission|install (the|its|hawkes)|installation page|grant (access|the)/i.test(all)) return 'a GitHub permission or install';
  if (/\bas (you|J)\b|in your name|on your behalf|post (it )?(publicly|public)|make (it )?public/i.test(all)) return 'sent as J';
  if (/\bgo(ing)? live\b|\bdeploy\b|\broll ?back\b/i.test(all)) return 'going live';
  return null;
}

// ------------------------------------------------------------------ the log

db.exec(`CREATE TABLE IF NOT EXISTS cause_log (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, cause TEXT NOT NULL, product TEXT, kind TEXT NOT NULL, ref TEXT, subject TEXT, detail TEXT, dedup TEXT UNIQUE
)`);
db.exec('CREATE INDEX IF NOT EXISTS cause_log_cause ON cause_log(cause, at)');
db.exec(`CREATE TABLE IF NOT EXISTS cause_fixes (cause TEXT PRIMARY KEY, task TEXT NOT NULL, item TEXT, opened INTEGER NOT NULL, evidence TEXT)`);
// A question's cause, so the Inbox folds questions with the same one (roadmap.ts owns the table; the column is ours).
try { db.exec('ALTER TABLE questions ADD COLUMN cause TEXT'); } catch { /* already there */ }

export type LogKind = 'card' | 'retried' | 'answered' | 'rebuilt' | 'filed-after-tries';
export type LogRow = { id: string; at: number; cause: string; product: string | null; kind: LogKind; ref: string | null; subject: string | null; detail: string | null };

const WEEK = 7 * 86_400_000;
/** The infra product a fix task goes to. */
export const STUDIO_PRODUCT = 'hawkesstudio';

/** Replaced by the tests: opens the Studio fix task (roadmap.ts), or null where Studio isn't a product (a customer's Studio). */
export const hooks: {
  openFix: (cause: Cause, evidence: LogRow[]) => { task: string; item: string } | null;
  answer: (question: string, answer: string, by: string) => Promise<unknown>;
} = {
  openFix: (cause, evidence) => openFixTask(cause, evidence),
  answer: async (q, a, by) => {
    // A held question (never shown) opens only for the moment its answer is given.
    db.prepare(`UPDATE questions SET status = 'open' WHERE id = ? AND status = 'held'`).run(q);
    return (await import('./pm.ts')).answerQuestion(q, a, by);
  },
};

/**
 * Records one card or self-settled failure with its cause (once per `dedup`), and opens the fix task when the cause comes
 * up a second time within 7 days. Returns the log row, or null when it was logged already.
 */
export function logCause(cause: Cause, o: { product?: string | null; kind: LogKind; ref?: string | null; subject?: string | null; detail?: string | null; dedup?: string | null }): LogRow | null {
  const id = newId('u');
  const r = db.prepare('INSERT OR IGNORE INTO cause_log (id, at, cause, product, kind, ref, subject, detail, dedup) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, Date.now(), cause.key, o.product ?? null, o.kind, o.ref ?? null, o.subject ?? null, redact(o.detail ?? '').slice(0, 600) || null, o.dedup ?? null);
  if (!r.changes) return null;
  try { recurring(cause); } catch (e: any) { console.warn(`[studio] cause ${cause.key}: couldn't open its fix task: ${e?.message ?? e}`); }
  return db.prepare('SELECT * FROM cause_log WHERE id = ?').get(id) as LogRow;
}

export function causeLog(cause?: string, sinceMs = WEEK): LogRow[] {
  return db.prepare(`SELECT * FROM cause_log WHERE at >= ? ${cause ? 'AND cause = ?' : ''} ORDER BY at`).all(...[Date.now() - sinceMs, ...(cause ? [cause] : [])]) as LogRow[];
}

/** The cause's open fix task, if any (dropped or done ones don't count; merged ones for a day, while it deploys). */
export function openFix(cause: string): { task: string; title: string; status: string; opened: number } | null {
  const r = db.prepare('SELECT * FROM cause_fixes WHERE cause = ?').get(cause) as any;
  if (!r) return null;
  const t = db.prepare('SELECT id, title, status, merged_at FROM tasks WHERE id = ?').get(r.task) as any;
  if (!t) return null;
  if (['dropped', 'done', 'verified', 'live'].includes(t.status)) return null;
  if (t.status === 'merged' && t.merged_at && Date.now() - Number(t.merged_at) > 86_400_000) return null;
  return { task: t.id, title: t.title, status: t.status, opened: r.opened };
}

/** The second time a cause comes up (another subject) within 7 days: one Studio fix task for it. */
function recurring(cause: Cause) {
  if (cause.key.startsWith('access:') || openFix(cause.key)) return null;
  const rows = causeLog(cause.key);
  const subjects = new Set(rows.map((r) => r.subject ?? r.ref ?? r.id));
  if (subjects.size < 2) return null;
  const made = hooks.openFix(cause, rows);
  if (!made) return null;
  db.prepare('INSERT OR REPLACE INTO cause_fixes (cause, task, item, opened, evidence) VALUES (?, ?, ?, ?, ?)').run(cause.key, made.task, made.item, Date.now(), JSON.stringify(rows.map((r) => r.id)));
  return made;
}

function openFixTask(cause: Cause, rows: LogRow[]): { task: string; item: string } | null {
  const R = { addItem, addTask, logDecision };
  let item;
  try {
    item = R.addItem({ product: STUDIO_PRODUCT, title: `Fix the cause: ${cause.label}`, goal: `Stop "${cause.label}" from reaching J's Inbox or stopping work again.`, status: 'planned', by: 'Studio PM (root cause)' });
  } catch {
    return null; // No Hawkes Studio product here (a customer's Studio): the log still shows it.
  }
  const evidence = rows.slice(-12).map((r) => `- ${new Date(r.at).toISOString()} ${r.kind} ${r.ref ?? ''}${r.subject && r.subject !== r.ref ? ` (${r.subject})` : ''}${r.product ? ` [${r.product}]` : ''}: ${r.detail ?? ''}`).join('\n');
  const request = `The same cause, "${cause.label}" (cause key \`${cause.key}\`), came up ${rows.length} times in the last 7 days across ${new Set(rows.map((r) => r.subject ?? r.ref)).size} different things. Studio retries or settles each one (src/causes.ts), but it keeps happening: find the root cause in Studio and fix it so it stops happening, not only the symptom.\n\nEvidence (cause_log):\n${evidence}`;
  const task = R.addTask({
    item: item.id, title: `Fix the cause: ${cause.label}`, request,
    criteria: [`The root cause of "${cause.label}" is found and fixed in Studio, with a test that reproduces it`, `The summary names the cause and the evidence ids it explains`],
  });
  R.logDecision('cause-fix', task.id, STUDIO_PRODUCT, `"${cause.label}" came up ${rows.length} times in 7 days: opened ${task.id} to fix its root cause (evidence ${rows.map((r) => r.id).slice(-12).join(', ')})`);
  return { task: task.id, item: item.id };
}

// ------------------------------------------------------------------ the gate for questions (askJ)

/** Tries Studio makes by itself for one subject and transient cause before J hears of it, and the waits between them. */
export const RETRY_LIMIT = 3;
/** A cause that needs fewer: a conflict an agent already tried to resolve gets one fresh try on top of the moved base. */
export const RETRY_LIMITS: Record<string, number> = { conflict: 1 };
export const retryLimit = (cause: string) => RETRY_LIMITS[cause] ?? RETRY_LIMIT;
export const RETRY_WAITS_MS = [2, 10, 30].map((m) => m * 60_000);
/** Times a week the PM answers questions on one subject with their recommendation before they are J's. */
export const AUTO_ANSWERS = 2;
export const SELF_BY = 'Studio PM (self-healing)';

const retryOption = (options: string[] = []) => options.find((o) => /^(try|retry|resume|again|rebuild|build again)/i.test(o.trim())) ?? null;

export type Gate =
  | { file: true; cause: Cause | null; note: string | null }
  | { file: false; cause: Cause | null; action: 'retry'; answer: string; inMs: number; attempt: number }
  | { file: false; cause: Cause | null; action: 'answer'; answer: string };

/** What happens to a question askJ is about to file (see the top of this file). Pure apart from reading the log. */
export function gateQuestion(q: { text: string; context?: string | null; subject?: string | null; product?: string | null; options?: string[]; recommendation?: string | null; topic?: string | null; forwards?: string | null; asker?: string | null }): Gate {
  const cause = causeOf(`${q.text}\n${q.context ?? ''}`);
  const subject = q.subject ?? q.product ?? 'studio';
  // Talk's and J's own questions, agents' questions passed on, and a question asked with no automatic path named (the PM
  // asking in its own words) are theirs to ask: the gate settles what Studio's automatic paths would file (askJ's `from`).
  if (q.forwards || !q.asker || /^(Talk|J\b|agent)/.test(q.asker)) return { file: true, cause, note: null };
  if (jOnly(q)) return { file: true, cause, note: null };
  if (cause?.cls === 'transient') {
    const again = retryOption(q.options);
    if (again) {
      // Counted over the week, so a failure that keeps coming back isn't retried forever, a day at a time.
      const tried = causeLog(cause.key, WEEK).filter((r) => r.kind === 'retried' && r.subject === subject);
      if (tried.length < retryLimit(cause.key)) return { file: false, cause, action: 'retry', answer: again, inMs: RETRY_WAITS_MS[tried.length], attempt: tried.length + 1 };
      return { file: true, cause, note: `Already tried: Studio answered "${again}" by itself ${tried.length} times (${tried.map((r) => new Date(r.at).toISOString().slice(11, 16)).join(', ')} UTC) because it looked like ${cause.label}, and it still fails.` };
    }
  }
  if (q.recommendation && walkAwayOn()) {
    const done = db.prepare(`SELECT COUNT(*) AS n FROM cause_log WHERE kind = 'answered' AND subject = ? AND at >= ?`).get(subject, Date.now() - WEEK) as any;
    const opt = (q.options ?? []).find((o) => o.toLowerCase() === q.recommendation!.toLowerCase() || q.recommendation!.toLowerCase().startsWith(o.toLowerCase())) ?? q.recommendation;
    if (Number(done?.n ?? 0) < AUTO_ANSWERS) return { file: false, cause, action: 'answer', answer: opt };
    return { file: true, cause, note: `Studio already answered "${opt}" on this ${done.n} times this week and it came back.` };
  }
  return { file: true, cause, note: null };
}

/** Carries out a gate that didn't file: the question (already added, held) is retried later or answered now. */
export function settleQuestion(qid: string, g: Gate & { file: false }, o: { product?: string | null; subject?: string | null; text: string }) {
  const cause = g.cause ?? mk('recommended', 'other');
  const subject = o.subject ?? o.product ?? 'studio';
  if (g.action === 'retry') {
    logCause(cause, { product: o.product, kind: 'retried', ref: qid, subject, detail: `retry ${g.attempt} of ${retryLimit(cause.key)} in ${Math.round(g.inMs / 60_000)} min ("${g.answer}"): ${o.text}`, dedup: `retried:${qid}` });
    heldRetry({ id: qid, kind: 'question', ref: qid, attempt: g.attempt, waitMs: g.inMs, why: `${cause.key}: ${o.text}` });
    return;
  }
  // Answered by the PM with the recommendation now (logged in the PM log by answerQuestion, and here).
  if (g.cause) logCause(g.cause, { product: o.product, kind: 'answered', ref: qid, subject, detail: `answered "${g.answer}": ${o.text}`, dedup: `answered:${qid}` });
  else db.prepare('INSERT OR IGNORE INTO cause_log (id, at, cause, product, kind, ref, subject, detail, dedup) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(newId('u'), Date.now(), 'recommended', o.product ?? null, 'answered', qid, subject, redact(`answered "${g.answer}": ${o.text}`).slice(0, 600), `answered:${qid}`);
  void Promise.resolve().then(() => hooks.answer(qid, g.answer, SELF_BY)).catch((e) => console.warn(`[studio] ${qid}: the PM couldn't answer it with its recommendation: ${e?.message ?? e}`));
}

// The held question's retry fires: Studio answers it with its retry option (an agent resumes, a task is planned again).
onHeldRetry('question', async (ref) => {
  const q = db.prepare('SELECT status FROM questions WHERE id = ?').get(ref) as any;
  if (!q || q.status !== 'held') return;
  const h = heldRetriesOf(ref)[0];
  const opts = (() => { try { return JSON.parse((db.prepare('SELECT options FROM questions WHERE id = ?').get(ref) as any)?.options ?? '[]'); } catch { return []; } })();
  await hooks.answer(ref, retryOption(opts) ?? 'try again', `${SELF_BY}, retry ${h?.attempt ?? '?'}`);
});

// ------------------------------------------------------------------ the Inbox's cards

export type CardLike = { id: string; kind: string; title: string; text: string | null; context: string | null; product: string | null; subject: string | null; asks: number };

/** A card's cause, from its kind and words (access cards from their row). */
export function cardCause(x: CardLike, extra: { permission?: string | null; repo?: string | null } = {}): Cause | null {
  if (x.kind === 'access') return causeOf(x.text, { permission: extra.permission ?? 'install', repo: extra.repo });
  if (['gpu', 'milestone', 'credits', 'approval', 'video'].includes(x.kind)) return null;
  return causeOf(`${x.title}\n${x.context ?? ''}\n${x.text ?? ''}`);
}

/** Logs each card the first time it shows, with its cause. */
export function logCards(items: (CardLike & { cause?: string | null })[]) {
  for (const x of items) {
    const c = x.cause ? (x.cause.startsWith('access:') ? mk(x.cause, 'j-only') : mk(x.cause)) : null;
    if (c) logCause(c, { product: x.product, kind: 'card', ref: x.id, subject: x.subject ?? x.id, detail: x.title, dedup: `card:${x.id}` });
  }
}

/**
 * One card per cause and product: later cards with the same cause fold into the first (kept first by the caller's order),
 * which says how many and lists them; `merged` names the folded ids so an answer reaches each one.
 */
export function mergeByCause<T extends CardLike & { cause?: string | null; merged?: string[]; count?: number }>(items: T[]): T[] {
  const out: T[] = [];
  const first = new Map<string, T>();
  for (const x of items) {
    const k = x.cause && x.kind !== 'approval' ? `${x.cause}|${x.product ?? ''}` : null;
    const head = k ? first.get(k) : undefined;
    if (!head) { if (k) first.set(k, x); out.push(x); continue; }
    head.merged = [...(head.merged ?? []), x.id];
    head.count = (head.count ?? 1) + 1;
    head.asks += x.asks;
    head.text = `${head.text ?? ''}\n\nAlso from the same cause (${mk(x.cause!).label}):\n- ${x.title}`.trim().slice(0, 3000);
  }
  for (const x of out) if (x.count && x.count > 1) x.title = `${x.title} (and ${x.count - 1} more with the same cause)`;
  return out;
}

/** The open fix tasks with how often their cause came up this week: the Inbox's "Fixing the cause". */
export function fixingNow() {
  const out: { cause: string; label: string; task: string; title: string; status: string; opened: number; seen: number; selfSettled: number; last: number }[] = [];
  for (const r of db.prepare('SELECT cause FROM cause_fixes ORDER BY opened DESC').all() as any[]) {
    const f = openFix(r.cause);
    if (!f) continue;
    const rows = causeLog(r.cause);
    out.push({ cause: r.cause, label: mk(r.cause).label, ...f, seen: rows.length, selfSettled: rows.filter((x) => x.kind !== 'card' && x.kind !== 'filed-after-tries').length, last: rows.at(-1)?.at ?? f.opened });
  }
  return out;
}

/** What Studio settled by itself lately (retried, answered, rebuilt): the Inbox's quiet line. */
export function settledLately(sinceMs = 86_400_000) {
  return (db.prepare(`SELECT kind, COUNT(*) AS n FROM cause_log WHERE at >= ? AND kind IN ('retried', 'answered', 'rebuilt') GROUP BY kind`).all(Date.now() - sinceMs) as any[])
    .reduce((a, r) => ({ ...a, [r.kind]: Number(r.n) }), {} as Record<string, number>);
}

export { mk as causeFromKey };
