// Approve / Deny cards: J's approval as one tap instead of typed words (MERGE <id>, DEPLOY <product>, ROLLBACK <product>,
// a quoted yes). Anyone may ask for one (Talk, the PM, an agent, the dashboard itself); only J's click approves.
//
//   requestApproval(kind, target, params)   a card: what will happen in plain words (the deploy plan's commits, verdicts
//                                           and blockers; the change, its checks and "this restarts Studio"), bound to
//                                           the exact action and target and a fingerprint of it (the change's verified
//                                           commit, beta's commit for a deploy, the patch and today's values for a
//                                           setting), with a one-time token. It shows in the Talk conversation it came
//                                           from (also during a call) and in the Inbox.
//   decideApproval(id, token, 'approve' | 'deny', req)
//                                           only from J's own browser session (jClick): never the agent sandbox's user,
//                                           never a call carrying Talk's or an agent's headers or the MCP key. Refused
//                                           when the token is wrong or used, after 15 minutes (expired), or when the
//                                           target changed since the card was made (stale: ask for a new card). Approve
//                                           runs the action as J, through the same code and refusals as before (CI
//                                           green for a Studio/Gen merge, the deploy blockers); deny closes it. Either
//                                           way who decided and when is recorded and the conversation is told.
//
// Talk's tools can ask for and read cards (studio_approval) but have no way to decide one; the guide's driver refuses
// the card's buttons (dashboard/guide.js). The typed words still work as a fallback (guards.ts).

import crypto from 'node:crypto';
import type http from 'node:http';
import { db, newId, parse, J } from './db.ts';
import { StudioError, getInfra, isInfra, getProduct } from './config.ts';
import { requestUser } from './sandbox.ts';
import { sessionUser, cookieToken } from './auth.ts';

db.exec(`CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, params TEXT, bind TEXT NOT NULL, token TEXT NOT NULL,
  card TEXT NOT NULL, status TEXT NOT NULL, requested_by TEXT, conversation TEXT, created INTEGER NOT NULL,
  expires INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER, result TEXT
)`);

export const KINDS = ['merge', 'deploy', 'rollback', 'gpu', 'settings', 'decision'] as const;
export type Kind = (typeof KINDS)[number];
/** How long a card can be approved. */
export const TTL_MS = () => Number(process.env.STUDIO_APPROVAL_TTL_MS ?? 15 * 60_000);

/** What J sees: a title, plain lines, links, blockers (approving is refused while there are any) and warnings. */
export type Card = { title: string; lines: string[]; blockers: string[]; warnings: string[]; links: { label: string; url: string }[]; approve: string; deny: string };
export type Approval = {
  id: string; kind: Kind; target: string; params: Record<string, any>; status: 'pending' | 'approving' | 'approved' | 'denied' | 'expired' | 'stale' | 'failed';
  card: Card; requested_by: string | null; conversation: string | null; created: number; expires: number;
  decided_by: string | null; decided_at: number | null; result: string | null; token?: string;
};

const toApproval = (r: any): Approval => ({ ...r, params: parse(r.params) ?? {}, card: parse(r.card) });
const row = (id: string) => db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as any;
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);

/** The card and its fingerprint for an action as things stand now (asked again at approval time: different = stale). */
async function describe(kind: Kind, target: string, params: Record<string, any>): Promise<{ bind: string; card: Card }> {
  if (kind === 'merge') {
    const { getChange } = await import('./agents.ts');
    const c = getChange(target);
    if (!c) throw new StudioError(`No change ${target}`, 404);
    const v = c.verify ?? {};
    const infra = isInfra(c.product);
    const name = infra ? getInfra(c.product).name : getProduct(c.product).name;
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (c.status !== 'ready') blockers.push(`The change is ${c.status}, not ready to merge.`);
    if (!c.pr) blockers.push('It has no pull request.');
    const lines = [`${name}: "${c.title ?? c.id}" (${c.id}${c.pr ? `, pull request #${c.pr}` : ''})`];
    if (infra) {
      lines.push(`Merges into main. ${name} deploys itself once CI passes: ${c.product === 'hawkesstudio' ? 'Studio restarts' : `${name} restarts`} (running work carries on) and rolls back if it isn't healthy.`);
      lines.push(`Checks: ${v.outcome ?? 'not run'}${v.summary ? `: ${String(v.summary).slice(0, 240)}` : ''}`);
      const ci = v.ci?.state;
      if (ci && ci !== 'success') blockers.push(`CI on the pull request isn't green (${ci}${v.ci?.detail ? `: ${String(v.ci.detail).slice(0, 160)}` : ''}). Studio refuses to merge into main until it is.`);
      if (v.outcome && v.outcome !== 'passed') warnings.push(`The checks ${v.outcome}.`);
    } else {
      const { gate } = await import('./acceptance.ts');
      const g = gate(c.verify, c.criteria);
      lines.push('Merges into beta: the beta site and a beta playtest follow. Nothing goes live.');
      lines.push(`Verification: ${v.outcome ?? 'not playtested'} · review ${v.verdict ?? 'n/a'}`);
      if (!g.pass) warnings.push(`It doesn't pass its acceptance gate: ${g.why.join('; ').slice(0, 300)}`);
    }
    const links = [c.pr_url ? { label: `Pull request #${c.pr}`, url: c.pr_url } : null, v.preview ? { label: 'Preview', url: v.preview } : null].filter(Boolean) as Card['links'];
    return { bind: J([c.status, v.sha ?? null, c.pr ?? null]), card: { title: `Merge "${c.title ?? c.id}" into ${infra ? 'main' : 'beta'}?`, lines, blockers, warnings, links, approve: infra ? 'Approve: merge into main' : 'Approve: merge into beta', deny: 'Deny' } };
  }
  if (kind === 'deploy') {
    const { deployPlan } = await import('./deploy.ts');
    const p = await deployPlan(target);
    const lines = [p.what, `Live (main): ${p.main ? `${p.main.short} ${p.main.title}` : 'none'} · beta: ${p.beta ? `${p.beta.short} ${p.beta.title}` : 'none'}`];
    lines.push(p.commits.length ? `${p.commits.length} commit(s) go live: ${p.commits.slice(0, 8).map((c) => `${c!.short} ${c!.title} (${c!.author})`).join('; ')}${p.commits.length > 8 ? '; …' : ''}` : 'No new commits.');
    lines.push(p.tested.playtests.length ? `Playtests of beta ${p.tested.sha}: ${p.tested.playtests.map((t) => `${t.name} ${t.outcome ?? t.status}${t.verdict ? `, review "${t.verdict}"` : ''}`).join(' · ')}` : `Beta ${p.tested.sha ?? ''} hasn't been playtested.`);
    return {
      bind: J([p.beta?.sha ?? null, p.main?.sha ?? null]),
      card: { title: `Go live with ${p.name}?`, lines, blockers: p.blockers, warnings: p.warnings, links: [p.betaSite ? { label: 'Beta site', url: p.betaSite } : null, { label: 'Live site', url: p.live }].filter(Boolean) as Card['links'], approve: `Approve: go live`, deny: 'Deny' },
    };
  }
  if (kind === 'rollback') {
    const { rollbackPlan } = await import('./deploy.ts');
    const p = await rollbackPlan(target);
    const lines = [p.what, `Live now: ${p.main ? `${p.main.short} ${p.main.title}` : '?'} · back to: ${p.to ? `${p.to.short} ${p.to.title}` : '?'}`];
    if (p.undo.length) lines.push(`Undoes ${p.undo.length} commit(s): ${p.undo.slice(0, 8).map((c) => `${c!.short} ${c!.title}`).join('; ')}`);
    return { bind: J([p.main?.sha ?? null, p.deploy?.id ?? null]), card: { title: `Roll back ${p.name}?`, lines, blockers: p.blockers, warnings: p.warnings, links: [{ label: 'Live site', url: p.live }], approve: 'Approve: roll back', deny: 'Deny' } };
  }
  if (kind === 'gpu') {
    const rm = await import('./roadmap.ts');
    const t = rm.getTask(target);
    if (!t) throw new StudioError(`No task ${target}`, 404);
    const e = t.gpu?.estimate;
    const amount = Number(params.amount ?? (e && !e.error ? Math.ceil(e.cost * 1.25 * 100) / 100 : NaN));
    if (!(amount >= 0)) throw new StudioError('gpu: say the budget (amount, dollars); the task could not be priced');
    const blockers = rm.tasksAwaitingGpu().some((x) => x.id === t.id) ? [] : ['The task no longer waits for a GPU budget.'];
    const lines = [`Task ${t.id}: ${t.title}`, e && !e.error ? `About ${e.gpuHours} GPU-hours on ${e.servers} server(s), ~$${e.cost.toFixed(2)} ($${e.withIdleTail.toFixed(2)} if the servers idle out), about ${e.wallMinutes} min.` : 'Not priced.'];
    return { bind: J([t.status, amount, e?.cost ?? null]), card: { title: `Approve a GPU budget of $${amount.toFixed(2)} for "${t.title}"?`, lines, blockers, warnings: [], links: [], approve: `Approve $${amount.toFixed(2)}`, deny: 'Deny' } };
  }
  if (kind === 'settings') {
    const st = await import('./settings.ts');
    if (!st.SECTIONS.includes(target as any)) throw new StudioError(`settings: the section (${st.SECTIONS.join(' | ')})`);
    const patch = params.patch;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) throw new StudioError('settings: patch, the fields to change');
    const cur = (await st.allSettings())[target as keyof Awaited<ReturnType<typeof st.allSettings>>] as Record<string, any>;
    const raising = st.costRaising(target as any, patch, cur);
    const lines = Object.entries(patch).map(([k, v]) => `${target}.${k}: ${J(cur?.[k])} → ${J(v)}`);
    return { bind: hash(J([target, patch, Object.fromEntries(Object.keys(patch).map((k) => [k, cur?.[k] ?? null]))])), card: { title: `Change ${target} settings?`, lines, blockers: [], warnings: raising.length ? [`This can raise costs: ${raising.join(', ')}`] : [], links: [], approve: 'Approve', deny: 'Deny' } };
  }
  if (kind === 'decision') {
    const rm = await import('./roadmap.ts');
    const q = rm.getQuestion(target);
    if (!q) throw new StudioError(`No question ${target}`, 404);
    const open = ['open', 'asked J'].includes(q.status);
    const yes = q.recommendation ?? q.options[0] ?? 'Yes';
    const no = q.options.find((o) => /^(no|not now|later|skip|don'?t)\b/i.test(o)) ?? 'No';
    return { bind: J([open, hash(q.text)]), card: { title: q.text.split('\n')[0].slice(0, 220), lines: [q.text.includes('\n') ? q.text : '', q.context ?? ''].filter(Boolean), blockers: open ? [] : [`It was already ${q.status}${q.answered_by ? ` by ${q.answered_by}` : ''}.`], warnings: [], links: [], approve: yes, deny: no } };
  }
  throw new StudioError(`kind: ${KINDS.join(' | ')}`);
}

/** Pending cards past their time are expired (read paths call this first). */
function expire() {
  db.prepare(`UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires <= ?`).run(Date.now());
}

/**
 * A new card (or the same pending one, when that action on that target is already waiting as it stands now). params:
 * gpu { amount }, settings { patch }. by: who asked (inbox.ts actor). conversation: the Talk conversation to show it in.
 */
export async function requestApproval(kind: string, target: string, params: Record<string, any> = {}, { by = null, conversation = null }: { by?: string | null; conversation?: string | null } = {}) {
  if (!KINDS.includes(kind as Kind)) throw new StudioError(`kind: ${KINDS.join(' | ')}`);
  target = String(target ?? '').trim();
  if (!target) throw new StudioError('target: the change id, product, task id, settings section or question id');
  const clean = kind === 'gpu' ? { amount: params.amount === undefined || params.amount === null || params.amount === '' ? undefined : Number(params.amount) } : kind === 'settings' ? { patch: params.patch } : {};
  const { bind, card } = await describe(kind as Kind, target, clean);
  expire();
  const same = db.prepare(`SELECT * FROM approvals WHERE status = 'pending' AND kind = ? AND target = ? AND bind = ? ORDER BY created DESC LIMIT 1`).get(kind, target, bind) as any;
  if (same) {
    // Shown where it was asked again too (the newest conversation), with today's words.
    db.prepare('UPDATE approvals SET card = ?, conversation = COALESCE(?, conversation) WHERE id = ?').run(J(card), conversation, same.id);
    return getApproval(same.id)!;
  }
  // An older card for the same action and target no longer matches: it's stale.
  db.prepare(`UPDATE approvals SET status = 'stale', result = 'a newer card replaced it' WHERE status = 'pending' AND kind = ? AND target = ?`).run(kind, target);
  const id = newId('a');
  const now = Date.now();
  db.prepare('INSERT INTO approvals (id, kind, target, params, bind, token, card, status, requested_by, conversation, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, kind, target, J(clean), bind, crypto.randomBytes(18).toString('hex'), J(card), 'pending', by, conversation, now, now + TTL_MS());
  return getApproval(id)!;
}

/** A card. The token only for J's own dashboard (withToken); Talk and agents never see it. */
export function getApproval(id: string, withToken = false): Approval | null {
  expire();
  const r = row(id);
  if (!r) return null;
  const a = toApproval(r);
  if (!withToken || a.status !== 'pending') delete a.token;
  return a;
}

/** Cards for a conversation (pending, and decided in the last hour), or every pending one (the Inbox). */
export function listApprovals({ conversation, pending }: { conversation?: string | null; pending?: boolean } = {}, withToken = false) {
  expire();
  const rows = conversation
    ? db.prepare(`SELECT * FROM approvals WHERE conversation = ? AND (status IN ('pending', 'approving') OR COALESCE(decided_at, created) > ?) ORDER BY created`).all(conversation, Date.now() - 3600_000)
    : db.prepare(`SELECT * FROM approvals WHERE status IN ('pending', 'approving')${pending ? '' : ` OR decided_at > ${Date.now() - 7 * 86_400_000}`} ORDER BY created DESC LIMIT 50`).all();
  return (rows as any[]).map((r) => getApproval(r.id, withToken)!);
}

/**
 * Whether a request is J's own click in his browser: not from the agent sandbox's Linux user, no Talk conversation or
 * agent header (Talk's and the agents' MCP servers always send them), no MCP key, sent by the dashboard's page itself
 * (the browser's Sec-Fetch-Site and the dashboard's X-Studio-Click). null when it is; otherwise why not.
 */
export function notJClick(req: http.IncomingMessage): string | null {
  const h = req.headers;
  if (requestUser(req) === 'agent') return 'it comes from the agent sandbox (Talk, the PM or an agent)';
  if (h['x-talk-conversation'] || h['x-studio-agent']) return 'it comes from Talk, the PM or an agent';
  if (/^\s*bearer\s/i.test(String(h.authorization ?? ''))) return 'it comes with an API key, not J\'s login';
  if (h['sec-fetch-site'] !== 'same-origin' || h['x-studio-click'] !== '1') return 'it isn\'t a click on Studio\'s dashboard';
  // A signed-in member's click isn't J's: approving is an admin's (auth.ts).
  const u = sessionUser(cookieToken(req));
  if (u && u.role !== 'admin') return `${u.email} is a member, not an admin`;
  return null;
}

/** J's tap on Approve or Deny. Runs the bound action on approve; tells the conversation either way. */
export async function decideApproval(id: string, token: string, decision: string, req: http.IncomingMessage) {
  const why = notJClick(req);
  if (why) throw new StudioError(`Only J approves or denies, with a tap on the card: ${why}.`, 403);
  if (decision !== 'approve' && decision !== 'deny') throw new StudioError('decision: approve | deny');
  expire();
  const r = row(id);
  if (!r) throw new StudioError(`No approval ${id}`, 404);
  if (r.status === 'expired') throw new StudioError('This card expired (15 minutes). Ask for a new one.', 410);
  if (r.status !== 'pending') throw new StudioError(`This card is ${r.status}${r.decided_by ? ` (by ${r.decided_by})` : ''}.`, 409);
  const a = toApproval(r);
  const expect = Buffer.from(String(r.token));
  const got = Buffer.from(String(token ?? ''));
  if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) throw new StudioError('Wrong token for this card.', 403);
  const by = 'J';
  if (decision === 'deny') {
    if (!claim(id, 'denied', by)) throw new StudioError('This card was just decided.', 409);
    if (a.kind === 'decision') await answerDecision(a, a.card.deny, by).catch(() => {});
    await tell(a, `J denied: ${a.card.title} (${a.id}). Nothing was done.`);
    return getApproval(id)!;
  }
  // Stale: the target changed since the card was made (beta moved, the change was revised, the setting changed).
  let now: { bind: string; card: Card };
  try {
    now = await describe(a.kind, a.target, a.params);
  } catch (e: any) {
    db.prepare(`UPDATE approvals SET status = 'stale', result = ? WHERE id = ? AND status = 'pending'`).run(String(e.message ?? e).slice(0, 500), id);
    throw new StudioError(`This card no longer applies: ${e.message ?? e}`, 409);
  }
  if (now.bind !== r.bind) {
    db.prepare(`UPDATE approvals SET status = 'stale', result = 'what it was about changed since the card was made', card = ? WHERE id = ? AND status = 'pending'`).run(J(now.card), id);
    throw new StudioError('What this card was about changed since it was made (stale). Look at the new card.', 409);
  }
  if (now.card.blockers.length) throw new StudioError(`Can't approve yet:\n- ${now.card.blockers.join('\n- ')}`, 409);
  // One time: only one tap moves it on.
  if (!claim(id, 'approving', by)) throw new StudioError('This card was just decided.', 409);
  // Going live and rolling back are queued (deploy.ts, ops.ts): the tap is answered now, one product goes at a time,
  // and the card (and the conversation) hears the result when it's done. Studio stays responsive meanwhile.
  if (a.kind === 'deploy' || a.kind === 'rollback') {
    const { queueLive } = await import('./deploy.ts');
    const kind = a.kind === 'deploy' ? 'golive' : 'rollback';
    const q = queueLive(kind, { product: a.target, confirm: `${a.kind === 'deploy' ? 'DEPLOY' : 'ROLLBACK'} ${a.target}`, by, origin: a.conversation, beta: a.kind === 'deploy' ? (parse(row(a.id).bind) as any[])[0] : undefined, approval: id });
    const where = q.ahead > 1 ? `queued (${q.ahead - 1} ahead of it)` : 'starting now';
    db.prepare(`UPDATE approvals SET result = ? WHERE id = ?`).run(`${q.op.title}: ${where}. Follow it in Activity.`, id);
    await tell(a, `J approved: ${a.card.title} (${a.id}). ${q.op.title}: ${where}; the result follows here.`);
    return getApproval(id)!;
  }
  try {
    const result = await run(a, by);
    db.prepare(`UPDATE approvals SET status = 'approved', result = ? WHERE id = ?`).run(String(result).slice(0, 2000), id);
    await tell(a, `J approved:${a.card.title} (${a.id}). ${result}`);
  } catch (e: any) {
    db.prepare(`UPDATE approvals SET status = 'failed', result = ? WHERE id = ?`).run(String(e.message ?? e).slice(0, 2000), id);
    await tell(a, `J approved ${a.card.title} (${a.id}), but it failed: ${e.message ?? e}`);
    throw e;
  }
  return getApproval(id)!;
}

const claim = (id: string, status: string, by: string) => Number(db.prepare(`UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, token = '' WHERE id = ? AND status = 'pending'`).run(status, by, Date.now(), id).changes) === 1;

async function answerDecision(a: Approval, answer: string, by: string) {
  const pm = await import('./pm.ts');
  await pm.answerQuestion(a.target, answer, by);
}

/** The action itself, as J, through the code that always did it (and its refusals). A line on what happened. */
async function run(a: Approval, by: string): Promise<string> {
  const origin = a.conversation;
  if (a.kind === 'merge') {
    const { approve } = await import('./agents.ts');
    const c = await approve(a.target, { confirm: `MERGE ${a.target}`, by, origin });
    return c?.detail ?? `Merged ${a.target}.`;
  }
  if (a.kind === 'deploy') {
    const { deploy } = await import('./deploy.ts');
    const r: any = await deploy(a.target, { confirm: `DEPLOY ${a.target}`, by, origin, beta: (parse(row(a.id).bind) as any[])[0] });
    return `Live: main is ${r.main} (beta ${r.beta}). ${r.note}`;
  }
  if (a.kind === 'rollback') {
    const { rollback } = await import('./deploy.ts');
    const r: any = await rollback(a.target, { confirm: `ROLLBACK ${a.target}`, by, origin });
    return `Rolled back: main is ${r.main}. ${r.note ?? ''}`.trim();
  }
  if (a.kind === 'gpu') {
    const rm = await import('./roadmap.ts');
    const t = rm.getTask(a.target)!;
    const e = t.gpu?.estimate;
    const amount = Number(a.params.amount ?? (e && !e.error ? Math.ceil(e.cost * 1.25 * 100) / 100 : NaN));
    rm.approveGpu(a.target, amount, by);
    void import('./pm.ts').then((pm) => pm.kick()).catch(() => {});
    return `GPU budget $${amount.toFixed(2)} approved for task ${a.target}.`;
  }
  if (a.kind === 'settings') {
    const { saveSettings } = await import('./settings.ts');
    await saveSettings(a.target, a.params.patch, { conversation: null, by });
    return `Saved ${a.target}: ${Object.keys(a.params.patch).join(', ')}.`;
  }
  await answerDecision(a, a.card.approve, by);
  return `Answered "${a.card.approve}".`;
}

/** The conversation that asked hears the decision (a notice, then a short turn of Talk's). */
async function tell(a: Approval, text: string) {
  if (!a.conversation) return;
  await import('./talk.ts').then((t) => t.studioSays(a.conversation!, text)).catch(() => {});
}
