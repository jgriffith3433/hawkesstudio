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
//                                           when the token is wrong or used. Cards never expire by time; when the target
//                                           changed since the card was made, the card updates itself to the current plan
//                                           and asks again (nothing runs). Approve
//                                           runs the action as J, through the same code and refusals as before (CI
//                                           green for a Studio/Gen merge, the deploy blockers); deny closes it. Either
//                                           way who decided and when is recorded and the conversation is told.
//
// Talk's tools can ask for and read cards (studio_approval) but have no way to decide one; the guide's driver refuses
// the card's buttons (dashboard/guide.js). The typed words still work as a fallback (guards.ts).

import crypto from 'node:crypto';
import type http from 'node:http';
import { db, newId, parse, J } from './db.ts';
import { changed, poke } from './stream.ts';
import { StudioError, getInfra, isInfra, getProduct } from './config.ts';
import { requestUser } from './sandbox.ts';
import { sessionUser, cookieToken } from './auth.ts';
import { getTask, getQuestion, tasksAwaitingGpu } from './roadmap.ts';
import { walkAwayOn, walkAwayCardsOn, walkAwaySettings, gpuAutoApproveLimit, WALK_AWAY_BY } from './walkaway.ts';
import { customerStudio } from './tenancy.ts';

db.exec(`CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, params TEXT, bind TEXT NOT NULL, token TEXT NOT NULL,
  card TEXT NOT NULL, status TEXT NOT NULL, requested_by TEXT, conversation TEXT, created INTEGER NOT NULL,
  expires INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER, result TEXT
)`);
// J's × on a card in the chat: hidden from the conversation, still pending (and answerable) in the Inbox.
try { db.exec('ALTER TABLE approvals ADD COLUMN dismissed INTEGER'); } catch { /* already there */ }

export const KINDS = ['merge', 'deploy', 'rollback', 'gpu', 'settings', 'decision', 'github'] as const;
export type Kind = (typeof KINDS)[number];
/**
 * A card never expires by time (J, 2026-11-09: the go-live card for Studio's restart fix lapsed after 15 minutes before
 * he saw it, and the release waited hours). It waits until he answers; what keeps it honest is the re-check at tap time
 * (decide: the plan is rebuilt, and a changed target refreshes the card in place instead of running). `expires` stays
 * in the table (NOT NULL) as this far-off value; old rows that already expired stay expired.
 */
export const NEVER = Number.MAX_SAFE_INTEGER;

/** What J sees: a title, plain lines, links, blockers (approving is refused while there are any) and warnings. */
export type Card = { title: string; lines: string[]; blockers: string[]; warnings: string[]; links: { label: string; url: string }[]; approve: string; deny: string; skip?: Skip | null; catchUp?: boolean };
/**
 * A go-live card whose only blockers are beta's commit not being playtested: a person may still take it live with
 * "Go live anyway" (decideApproval 'anyway', after a confirm step that names the commit). Walk-away, auto go-live, Talk
 * and agents never can: they don't decide cards, and walk-away waits while a card has blockers.
 */
export type Skip = { sha: string; short: string; why: string[] };
export type Approval = {
  id: string; kind: Kind; target: string; params: Record<string, any>; status: 'pending' | 'approving' | 'approved' | 'denied' | 'expired' | 'stale' | 'failed';
  card: Card; requested_by: string | null; conversation: string | null; created: number; expires: number;
  decided_by: string | null; decided_at: number | null; result: string | null; dismissed: number | null; token?: string;
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
      // Not being playtested is plain information (playtests of a change run only on request), never a warning.
      lines.push(g.played ? `Playtest: ${v.outcome ?? '?'} · review ${v.verdict ?? 'n/a'}` : "Not playtested (the agent's checks passed; beta's playtest follows the merge).");
      if (!g.pass) warnings.push(`It doesn't pass its acceptance gate: ${g.why.join('; ').slice(0, 300)}`);
    }
    const links = [c.pr_url ? { label: `Pull request #${c.pr}`, url: c.pr_url } : null, v.preview ? { label: 'Preview', url: v.preview } : null].filter(Boolean) as Card['links'];
    return { bind: J([c.status, v.sha ?? null, c.pr ?? null]), card: { title: `Merge "${c.title ?? c.id}" into ${infra ? 'main' : 'beta'}?`, lines, blockers, warnings, links, approve: infra ? 'Approve: merge into main' : 'Approve: merge into beta', deny: 'Deny' } };
  }
  if (kind === 'deploy') {
    const { deployPlan } = await import('./deploy.ts');
    // The card waits for the release notes: J sees exactly what the What's new will say before he taps.
    const p = await deployPlan(target, { notesWaitMs: 100_000 });
    const lines = [p.what, `Live (main): ${p.main ? `${p.main.short} ${p.main.title}` : 'none'} · beta: ${p.beta ? `${p.beta.short} ${p.beta.title}` : 'none'}`];
    lines.push(p.commits.length ? `${p.commits.length} commit(s) go live: ${p.commits.slice(0, 8).map((c) => `${c!.short} ${c!.title} (${c!.author})`).join('; ')}${p.commits.length > 8 ? '; …' : ''}` : 'No new commits.');
    if (p.siteCommits.length) lines.push(`${p.siteCommits.length} website commit(s) go live with it (${p.site}): ${p.siteCommits.slice(0, 8).map((c) => `${c!.short} ${c!.title} (${c!.author})`).join('; ')}${p.siteCommits.length > 8 ? '; …' : ''}`);
    if (p.players) lines.push(p.players);
    lines.push(p.tested.playtests.length ? `Playtests of beta ${p.tested.sha}: ${p.tested.playtests.map((t) => `${t.name} ${t.outcome ?? t.status}${t.verdict ? `, review "${t.verdict}"` : ''}`).join(' · ')}` : `Beta ${p.tested.sha ?? ''} hasn't been playtested.`);
    return {
      // Bound to the playtested commit: a Studio release commit on top of it (only releases.json) isn't beta moving.
      bind: J([p.played?.sha ?? p.beta?.sha ?? null, p.main?.sha ?? null]),
      card: {
        title: `Go live with ${p.name}?`, lines, blockers: p.blockers, warnings: p.warnings, links: [p.betaSite ? { label: 'Beta site', url: p.betaSite } : null, { label: 'Live site', url: p.live }].filter(Boolean) as Card['links'], approve: `Approve: go live`, deny: 'Deny',
        // Only live having commits beta lacks stops it: one tap brings beta up to date (nothing goes live), not a dead end.
        catchUp: p.fix === 'merge-main',
        skip: p.playtestOnly && (p.played ?? p.beta) ? { sha: (p.played ?? p.beta)!.sha, short: (p.played ?? p.beta)!.short, why: p.blockers } : null,
      },
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
  if (kind === 'github') {
    // Outward-facing GitHub steps (repokit.ts; J, 2026-10-30: a new repo, Studio's hook, Pages go through a card).
    const rk = await import('./repokit.ts');
    const plan = params.plan as import('./repokit.ts').Plan;
    if (!plan || (plan.kind !== 'setup' && plan.kind !== 'new')) throw new StudioError('github: plan, from studio_game check (approve) or studio_game new');
    const d = await rk.describePlan(plan);
    const repo = plan.kind === 'setup' ? plan.repo : `${plan.owner}/${plan.repoName}`;
    return { bind: rk.planHash(plan), card: { title: d.title, lines: d.lines, blockers: d.blockers, warnings: [], links: plan.kind === 'setup' ? [{ label: repo, url: `https://github.com/${repo}` }] : [], approve: plan.kind === 'new' ? 'Approve: make it' : 'Approve: set it up', deny: 'Deny' } };
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

/** Ones already done are settled (read paths call this first). Cards don't expire by time (NEVER). */
function expire() {
  settleDone();
}

/**
 * The target changed since the card was made (beta moved, the change was revised, a setting changed): the card is
 * rebuilt from the current plan, in place (same id, a new token, still waiting), and shows what changed. Nothing runs;
 * J reads the new plan and taps again. A dismissed card shows again.
 */
function refreshCard(id: string, now: { bind: string; card: Card }) {
  const card = { ...now.card, warnings: [...now.card.warnings, 'This card changed since you last saw it (the target moved). It now shows the current plan: read it, then approve again.'] };
  db.prepare(`UPDATE approvals SET bind = ?, card = ?, token = ?, dismissed = NULL WHERE id = ? AND status = 'pending'`).run(now.bind, J(card), crypto.randomBytes(18).toString('hex'), id);
}

/**
 * Pending cards whose action already happened, by whatever path (another card, typed MERGE, the Changes tab, the PM,
 * the automatic merge, a merge on GitHub Studio noticed; a go live or rollback since the card was made): stale, with
 * why, so they leave the Inbox and the chat. Read paths run it, so leftovers from before vanish too.
 */
export function settleDone() {
  const now = Date.now();
  try {
    db.prepare(`UPDATE approvals SET status = 'stale', token = '', decided_by = 'Studio', decided_at = ?,
        result = CASE (SELECT status FROM changes WHERE changes.id = approvals.target) WHEN 'merged' THEN 'already merged' ELSE 'closed' END
      WHERE status = 'pending' AND kind = 'merge' AND target IN (SELECT id FROM changes WHERE status IN ('merged', 'closed'))`).run(now);
  } catch { /* no changes table in this process yet */ }
  // Walk-away mode: a merge card whose change isn't ready (being revised, failed, waiting on an answer) can never be
  // approved as it stands: stale at once, never "Can't approve yet". Studio/Gen changes merge by themselves, so their
  // cards go too, unless the change waits for J (auto_merge 'held: ...': protected files, failed after its tries).
  if (walkAwayOn()) try {
    db.prepare(`UPDATE approvals SET status = 'stale', token = '', decided_by = 'Studio', decided_at = ?,
        result = 'the change is ' || (SELECT status FROM changes WHERE changes.id = approvals.target) || ' now, not ready to merge'
      WHERE status = 'pending' AND kind = 'merge' AND target IN (SELECT id FROM changes WHERE status NOT IN ('ready', 'merged', 'closed'))`).run(now);
    {
      const infra = (db.prepare(`SELECT a.id, c.product, c.auto_merge FROM approvals a JOIN changes c ON c.id = a.target WHERE a.status = 'pending' AND a.kind = 'merge' AND c.status = 'ready'`).all() as any[])
        .filter((r) => isInfra(r.product) && !String(r.auto_merge ?? '').startsWith('held'));
      for (const r of infra) db.prepare(`UPDATE approvals SET status = 'stale', token = '', decided_by = 'Studio', decided_at = ?, result = ? WHERE id = ? AND status = 'pending'`).run(now, 'walk-away mode: Studio merges it by itself once CI is green', r.id);
    }
  } catch { /* no changes table in this process yet */ }
  try {
    db.prepare(`UPDATE approvals SET status = 'stale', token = '', decided_by = 'Studio', decided_at = ?,
        result = (SELECT CASE d.kind WHEN 'rollback' THEN 'already rolled back' ELSE 'already live' END FROM deploys d WHERE d.product = approvals.target AND d.at > approvals.created ORDER BY d.at DESC LIMIT 1)
      WHERE status = 'pending' AND kind IN ('deploy', 'rollback') AND EXISTS (SELECT 1 FROM deploys d WHERE d.product = approvals.target AND d.at > approvals.created)`).run(now);
  } catch { /* no deploys table in this process yet */ }
  // GPU budgets already approved (another card, the under-$5 auto approval) and questions already answered: nothing
  // left to approve, so the card doesn't sit in the Inbox with an Approve that can never work.
  const settle = db.prepare(`UPDATE approvals SET status = 'stale', token = '', decided_by = 'Studio', decided_at = ?, result = ? WHERE id = ? AND status = 'pending'`);
  try {
    const open = db.prepare(`SELECT id, kind, target FROM approvals WHERE status = 'pending' AND kind IN ('gpu', 'decision')`).all() as any[];
    const waiting = open.some((a) => a.kind === 'gpu') ? new Set(tasksAwaitingGpu().map((t) => t.id)) : new Set<string>();
    for (const a of open) {
      const why = a.kind === 'gpu' ? gpuMoot(a.target, waiting) : decisionMoot(a.target);
      if (why) settle.run(now, why, a.id);
    }
  } catch { /* no roadmap tables in this process yet */ }
}

/** Why a GPU budget card has nothing left to approve (the task no longer waits for one), or null while it waits. */
function gpuMoot(task: string, waiting = new Set(tasksAwaitingGpu().map((t) => t.id))): string | null {
  if (waiting.has(task)) return null;
  const t = getTask(task);
  if (!t) return 'the task is gone';
  const g = t.gpu as any;
  if (typeof g?.budget === 'number') return `already approved ($${g.budget.toFixed(2)}${g.approvedBy ? ` by ${g.approvedBy}` : ''})`;
  return `the task no longer waits for a GPU budget (it is ${t.status})`;
}

/** Why a decision card has nothing left to decide (the question was answered or closed), or null while it is open. */
function decisionMoot(question: string): string | null {
  const q = getQuestion(question);
  if (!q) return 'the question is gone';
  return ['open', 'asked J'].includes(q.status) ? null : `already ${q.status}${q.answered_by ? ` by ${q.answered_by}` : ''}`;
}

/**
 * A new card (or the same pending one, when that action on that target is already waiting as it stands now). params:
 * gpu { amount }, settings { patch }. by: who asked (inbox.ts actor). conversation: the Talk conversation to show it in.
 */
export async function requestApproval(kind: string, target: string, params: Record<string, any> = {}, { by = null, conversation = null }: { by?: string | null; conversation?: string | null } = {}) {
  if (!KINDS.includes(kind as Kind)) throw new StudioError(`kind: ${KINDS.join(' | ')}`);
  target = String(target ?? '').trim();
  if (!target) throw new StudioError('target: the change id, product, task id, settings section or question id');
  // Product changes merge into beta by themselves (agents.ts autoMergeBeta): no card asks J for one. One that couldn't
  // waits for a person in the Changes tab (its Merge button); Studio and Gen merges into main stay J's cards.
  if (kind === 'merge') {
    const { getChange, agentSettings } = await import('./agents.ts');
    const c = getChange(target);
    if (c?.infra && walkAwayOn() && !String(c.auto_merge ?? '').startsWith('held')) throw new StudioError(`${target} is a ${getInfra(c.product).name} change: in walk-away mode those merge into main by themselves once their checks pass and CI is green (no Approve card). It is ${c.status}${c.auto_merge ? ` (${c.auto_merge})` : ''}.`);
    if (c && !c.infra && agentSettings().autoMergeBeta) throw new StudioError(`${target} is a product change: those merge into beta by themselves once ready (no Approve card). ${c.auto_merge?.startsWith('failed') ? `It couldn't (${c.auto_merge.slice(8, 300)}): merge it from the Changes tab, or revise it.` : c.status === 'merged' ? 'It is merged.' : `It is ${c.status}.`}`);
  }
  // Already approved or answered: no card (it could only sit there with an Approve that never works).
  const moot = kind === 'gpu' && getTask(target) ? gpuMoot(target) : kind === 'decision' && getQuestion(target) ? decisionMoot(target) : null;
  if (moot) throw new StudioError(`Nothing to approve for ${target}: ${moot}.`, 409);
  const clean = kind === 'github' ? { plan: params.plan } : kind === 'gpu' ? { amount: params.amount === undefined || params.amount === null || params.amount === '' ? undefined : Number(params.amount) } : kind === 'settings' ? { patch: params.patch } : {};
  const { bind, card } = await describe(kind as Kind, target, clean);
  expire();
  // The same action on the same target is one card: asked again, it's shown where it was asked again too (the newest
  // conversation) with today's words; if the target moved meanwhile, that card is updated in place (superseded cards
  // merge into one, so J only ever sees one card per thing). Any extra pending duplicates are closed.
  const waiting = db.prepare(`SELECT * FROM approvals WHERE status = 'pending' AND kind = ? AND target = ? ORDER BY created DESC`).all(kind, target) as any[];
  const same = waiting.find((w) => w.bind === bind) ?? waiting[0];
  if (same) {
    const token = same.bind === bind ? same.token : crypto.randomBytes(18).toString('hex');
    db.prepare('UPDATE approvals SET card = ?, bind = ?, params = ?, token = ?, dismissed = CASE WHEN bind = ? THEN dismissed ELSE NULL END, conversation = COALESCE(?, conversation) WHERE id = ?').run(J(card), bind, J(clean), token, bind, conversation, same.id);
    for (const w of waiting) if (w.id !== same.id) db.prepare(`UPDATE approvals SET status = 'stale', token = '', result = 'merged into the newer card for the same thing' WHERE id = ? AND status = 'pending'`).run(w.id);
    cardChanged(conversation ?? same.conversation);
    return getApproval(same.id)!;
  }
  // Routine go-lives need no card (J, 2026-11-09): the owner's policy is auto and walk-away is on, and the plan passes.
  const auto = kind === 'deploy' ? await autoGoLiveInstead(target, card) : null;
  if (auto) return auto;
  const id = newId('a');
  const now = Date.now();
  db.prepare('INSERT INTO approvals (id, kind, target, params, bind, token, card, status, requested_by, conversation, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, kind, target, J(clean), bind, crypto.randomBytes(18).toString('hex'), J(card), 'pending', by, conversation, now, NEVER);
  // Walk-away mode: the card approves itself now, unless it is one that still waits (walkAwayHold).
  await selfApprove(id).catch((e) => console.warn(`[approvals] walk-away approving ${id}: ${e.message ?? e}`));
  cardChanged(conversation);
  return getApproval(id)!;
}

/**
 * Why a pending card still waits for J in walk-away mode, or null when Studio approves it itself (J, 2026-11-01: "Make
 * it so all cards auto approve when in walk away mode"). What still waits: GPU budgets past the walk-away caps (per task
 * gpuAutoApproveLimit, per day walkAwayGpuPerDay), settings that raise costs (settings.ts costRaising), Studio/Gen
 * merges held for protected files (agents.ts guardFiles), and, in a customer's Studio, going live and rolling back
 * (theirs, or their go-live policy's). Nothing a card does deletes a repo, a project or data.
 */
export async function walkAwayHold(a: Approval): Promise<string | null> {
  if (!walkAwayCardsOn()) return 'walk-away mode is off';
  if (a.kind === 'merge') {
    const { getChange } = await import('./agents.ts');
    const c = getChange(a.target);
    if (String(c?.auto_merge ?? '').startsWith('held')) return `held for J: ${String(c!.auto_merge).slice(6, 300)}`;
    return null;
  }
  if ((a.kind === 'deploy' || a.kind === 'rollback') && customerStudio()) return "going live and rolling back are the owner's";
  if (a.kind === 'gpu') {
    const t = getTask(a.target);
    const e = t?.gpu?.estimate;
    const amount = Number(a.params.amount ?? (e && !e.error ? Math.ceil(e.cost * 1.25 * 100) / 100 : NaN));
    if (!Number.isFinite(amount)) return 'no price for it yet';
    const limit = await gpuAutoApproveLimit();
    if (!(amount < limit)) return `$${amount.toFixed(2)} is over the $${limit} a task Studio approves by itself`;
    const { gpuAutoApprovedToday } = await import('./roadmap.ts');
    const day = walkAwaySettings().walkAwayGpuPerDay;
    if (gpuAutoApprovedToday() + amount > day) return `$${amount.toFixed(2)} would pass the $${day} a day Studio approves by itself`;
    return null;
  }
  if (a.kind === 'settings') {
    const { costRaising, allSettings } = await import('./settings.ts');
    const cur = ((await allSettings()) as any)[a.target] ?? {};
    const raising = costRaising(a.target as any, a.params.patch ?? {}, cur);
    if (raising.length) return `it raises costs (${raising.join(', ')})`;
    return null;
  }
  return null;
}

/**
 * Walk-away mode: a pending card approves itself, as "Studio (walk-away)", through the same checks and code as J's tap
 * (stale when its target changed, nothing while it has blockers), with a line in the PM log and the conversation told.
 * Returns what happened, or null when it still waits (walkAwayHold) or can't go yet.
 */
export async function selfApprove(id: string): Promise<string | null> {
  const r = row(id);
  if (!r || r.status !== 'pending') return null;
  const a = toApproval(r);
  if (await walkAwayHold(a)) return null;
  let now: { bind: string; card: Card };
  try {
    now = await describe(a.kind, a.target, a.params);
  } catch (e: any) {
    db.prepare(`UPDATE approvals SET status = 'stale', result = ? WHERE id = ? AND status = 'pending'`).run(String(e.message ?? e).slice(0, 500), id);
    return null;
  }
  if (now.bind !== r.bind) {
    refreshCard(id, now);
    cardChanged(a.conversation);
    return null;
  }
  // Can't go as things stand (a deploy plan's blockers, a merge's red CI): it waits, and is tried again later.
  if (now.card.blockers.length) return null;
  if (!claim(id, 'approving', WALK_AWAY_BY)) return null;
  const { logDecision } = await import('./roadmap.ts');
  const product = await productOf(a);
  try {
    const result = await carryOut(a, WALK_AWAY_BY, `${WALK_AWAY_BY} approved`);
    logDecision('walk-away approve', a.target, product, `Approved by walk-away: ${a.card.title} (${a.id}). ${result}`);
    return result;
  } catch (e: any) {
    logDecision('walk-away approve', a.target, product, `Approved by walk-away, but it failed: ${a.card.title} (${a.id}): ${e.message ?? e}`);
    return null;
  } finally {
    cardChanged(a.conversation);
  }
}

/** Walk-away mode: every pending card that may approve itself does (the PM's tick; cards from before it was on). */
export async function selfApproveWaiting(): Promise<string[]> {
  if (!walkAwayCardsOn()) return [];
  expire();
  const out: string[] = [];
  for (const { id } of db.prepare(`SELECT id FROM approvals WHERE status = 'pending' ORDER BY created`).all() as any[]) {
    if (await selfApprove(id).catch(() => null)) out.push(id);
  }
  return out;
}

async function productOf(a: Approval): Promise<string | null> {
  if (a.kind === 'deploy' || a.kind === 'rollback') return a.target;
  if (a.kind === 'merge') return (await import('./agents.ts')).getChange(a.target)?.product ?? null;
  if (a.kind === 'gpu') return getTask(a.target)?.product ?? null;
  if (a.kind === 'github') return a.params.plan?.product ?? a.params.plan?.id ?? null;
  return null;
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
  if (h['x-studio-click'] !== '1' || !(h['sec-fetch-site'] ? h['sec-fetch-site'] === 'same-origin' : ownPage(req))) return 'it isn\'t a click on Studio\'s dashboard';
  // A signed-in member's click isn't J's: approving is an admin's (auth.ts).
  const u = sessionUser(cookieToken(req));
  if (u && u.role !== 'admin') return `${u.email} is a member, not an admin`;
  return null;
}

/**
 * For browsers that don't send Sec-Fetch-Site (Safari before 16.4, some home-screen apps): the page's own address
 * (Origin, else Referer) is on Studio's host. A header that is there decides; neither means no.
 */
function ownPage(req: http.IncomingMessage) {
  const h = req.headers;
  const from = h.origin ?? h.referer;
  if (!from) return false;
  try {
    const host = new URL(String(from)).host.toLowerCase();
    return [h.host, h['x-forwarded-host']].some((x) => typeof x === 'string' && x.toLowerCase() === host);
  } catch { return false; }
}

/** Open dashboards redraw the card (its conversation) and the Inbox (stream.ts). */
function cardChanged(conversation: string | null | undefined) {
  if (conversation) changed('talk', conversation);
  poke();
}

/** J's tap on Approve or Deny. Runs the bound action on approve; tells the conversation either way. */
export async function decideApproval(id: string, token: string, decision: string, req: http.IncomingMessage, extra: { commit?: string } = {}) {
  try {
    return await decide(id, token, decision, req, extra);
  } finally {
    cardChanged((row(id) as any)?.conversation);
  }
}

async function decide(id: string, token: string, decision: string, req: http.IncomingMessage, extra: { commit?: string } = {}) {
  const why = notJClick(req);
  if (why) throw new StudioError(`Only J approves or denies, with a tap on the card: ${why}.`, 403);
  if (!['approve', 'deny', 'anyway', 'catchup'].includes(decision)) throw new StudioError('decision: approve | deny | anyway | catchup');
  expire();
  const r = row(id);
  if (!r) throw new StudioError(`No approval ${id}`, 404);
  if (r.status === 'expired') throw new StudioError('This card expired (an old one, from before cards stopped expiring). Ask for a new one.', 410);
  if (r.status !== 'pending') throw new StudioError(`This card is ${r.status}${r.decided_by ? ` (by ${r.decided_by})` : ''}.`, 409);
  const a = toApproval(r);
  const expect = Buffer.from(String(r.token));
  const got = Buffer.from(String(token ?? ''));
  if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) throw new StudioError('Wrong token for this card.', 403);
  if ((decision === 'anyway' || decision === 'catchup') && a.kind !== 'deploy') throw new StudioError(`"${decision === 'anyway' ? 'Go live anyway' : 'Bring beta up to date'}" is only for going live.`, 400);
  // Who tapped: the signed-in admin's name (or J's own page without a session, as before).
  const u = sessionUser(cookieToken(req));
  const by = decision === 'anyway' && u ? (u.name || u.email) : 'J';
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
    // Not stale and not run: the card shows the current plan, in place, and asks again.
    refreshCard(id, now);
    throw new StudioError('What this card was about changed since you last saw it (beta moved, the change was revised, or a setting changed). It now shows the current plan: read it and tap again. Nothing was run.', 409);
  }
  // Walk-away mode: a merge that can't happen as things stand: the card is stale now (it never sits there as "Can't approve yet").
  if (now.card.blockers.length && a.kind === 'merge' && walkAwayOn()) {
    db.prepare(`UPDATE approvals SET status = 'stale', token = '', decided_by = 'Studio', decided_at = ?, result = ? WHERE id = ? AND status = 'pending'`).run(Date.now(), now.card.blockers.join(' ').slice(0, 500), id);
    throw new StudioError(`This card no longer applies: ${now.card.blockers.join(' ')}`, 409);
  }
  // "Bring beta up to date" (2026-11-02: main had commits beta lacked and the card was a dead end): merges main into beta
  // (nothing goes live); beta's push redeploys and plays it, and a new card comes once it passes. In walk-away mode an
  // Approve tap on such a card does the same, since that is the only way forward.
  if (now.card.catchUp && (decision === 'catchup' || (decision === 'approve' && walkAwayOn()))) {
    if (!claim(id, 'approving', by)) throw new StudioError('This card was just decided.', 409);
    const { queueLive } = await import('./deploy.ts');
    const { op } = queueLive('golive', { product: a.target, confirm: `DEPLOY ${a.target}`, by: `${by} (bringing beta up to date)`, mergeMain: true });
    db.prepare(`UPDATE approvals SET status = 'stale', token = '', decided_by = ?, decided_at = ?, result = ? WHERE id = ?`)
      .run(by, Date.now(), `Bringing beta up to date with main (${op.id}). Nothing went live: beta is deployed and playtested again, then it can go live.`, id);
    return getApproval(id)!;
  }
  // "Go live anyway": a person going live past beta not being playtested, and past nothing else. The confirm step on the
  // card names the commit; the tap sends it back, so it is for exactly the commit they were shown.
  if (decision === 'anyway' && now.card.blockers.length) {
    const skip = now.card.skip;
    if (!skip) throw new StudioError(`Can't go live anyway: not only the playtest stops it:\n- ${now.card.blockers.join('\n- ')}`, 409);
    const c = String(extra.commit ?? '');
    if (!c || !(c === skip.short || c === skip.sha)) throw new StudioError(`Confirm going live without a playtest of ${skip.short}: tap "Go live anyway" again.`, 409);
    if (!claim(id, 'approving', by)) throw new StudioError('This card was just decided.', 409);
    const rec = { by, at: Date.now(), sha: skip.sha, why: skip.why };
    db.prepare('UPDATE approvals SET params = ?, card = ? WHERE id = ?').run(J({ ...a.params, skipPlaytest: rec }), J(now.card), id);
    await carryOut({ ...a, params: { ...a.params, skipPlaytest: rec } }, by, `${by} went live without a playtest of ${skip.short}`);
    return getApproval(id)!;
  }
  if (now.card.blockers.length) throw new StudioError(`Can't approve yet:\n- ${now.card.blockers.join('\n- ')}`, 409);
  // One time: only one tap moves it on.
  if (!claim(id, 'approving', by)) throw new StudioError('This card was just decided.', 409);
  await carryOut(a, by, decision === 'anyway' ? `${by} approved (it was playtested meanwhile)` : 'J approved');
  return getApproval(id)!;
}

/**
 * An approved card's action, once claimed: going live and rolling back are queued (deploy.ts, ops.ts), so the tap is
 * answered now, one product goes at a time, and the card (and the conversation) hears the result when it's done; the
 * rest run now. who: how the conversation hears it ("J approved", "Studio (walk-away) approved").
 */
async function carryOut(a: Approval, by: string, who: string) {
  const id = a.id;
  if (a.kind === 'deploy' || a.kind === 'rollback') {
    const { queueLive } = await import('./deploy.ts');
    const kind = a.kind === 'deploy' ? 'golive' : 'rollback';
    const q = queueLive(kind, { product: a.target, confirm: `${a.kind === 'deploy' ? 'DEPLOY' : 'ROLLBACK'} ${a.target}`, by, origin: a.conversation, beta: a.kind === 'deploy' ? (parse(row(a.id).bind) as any[])[0] : undefined, approval: id });
    const where = q.ahead > 1 ? `queued (${q.ahead - 1} ahead of it)` : 'starting now';
    const result = `${q.op.title}: ${where}. Follow it in Activity.`;
    db.prepare(`UPDATE approvals SET result = ? WHERE id = ?`).run(result, id);
    await tell(a, `${who}: ${a.card.title} (${a.id}). ${q.op.title}: ${where}; the result follows here.`);
    return result;
  }
  try {
    const result = await run(a, by);
    db.prepare(`UPDATE approvals SET status = 'approved', result = ? WHERE id = ?`).run(String(result).slice(0, 2000), id);
    await tell(a, `${who}: ${a.card.title} (${a.id}). ${result}`);
    return result;
  } catch (e: any) {
    db.prepare(`UPDATE approvals SET status = 'failed', result = ? WHERE id = ?`).run(String(e.message ?? e).slice(0, 2000), id);
    await tell(a, `${who} ${a.card.title} (${a.id}), but it failed: ${e.message ?? e}`);
    throw e;
  }
}

/**
 * J's × on a card in the Talk chat: the chat stops showing it while it waits; it stays pending in the Inbox, where he
 * can still approve or deny it until it expires. Not a decision: nothing runs, nothing is recorded as denied, Talk isn't
 * told. Only from J's page, like deciding (Talk can't hide his cards).
 */
export function dismissApproval(id: string, req: http.IncomingMessage) {
  const why = notJClick(req);
  if (why) throw new StudioError(`Only J closes a card, with a tap on it: ${why}.`, 403);
  expire();
  if (!row(id)) throw new StudioError(`No approval ${id}`, 404);
  db.prepare(`UPDATE approvals SET dismissed = ? WHERE id = ? AND dismissed IS NULL`).run(Date.now(), id);
  cardChanged((row(id) as any)?.conversation);
  return getApproval(id, true)!;
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
    return `Live: main is ${r.main} (beta ${r.beta}).${r.release ? ` Releases ${r.release.version}: ${r.release.title}.` : ''} ${r.note}`;
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
  if (a.kind === 'github') {
    const { applyPlan } = await import('./repokit.ts');
    return (await applyPlan(a.params.plan, { origin })).join(' ');
  }
  await answerDecision(a, a.card.approve, by);
  return `Answered "${a.card.approve}".`;
}

/**
 * Walk-away mode, a go-live card asked for, and the owner's go-live policy is auto: a routine go-live (beta playtested at
 * the exact commit, no blockers, nothing holding it) isn't a card at all. Studio takes it itself (golive-policy.ts
 * autoGoLive: the same checks), which queues the go-live (a line in Activity), and a line goes in the PM log. Returns a
 * record that is not stored as a card, or null when a card is needed (any blocker, a playtest hold, policy not auto).
 */
async function autoGoLiveInstead(product: string, card: Card): Promise<Approval | null> {
  if (!walkAwayCardsOn() || card.blockers.length) return null;
  try {
    const { policyOf, autoGoLive } = await import('./golive-policy.ts');
    if (policyOf(product).policy !== 'auto') return null;
    const r = await autoGoLive(product, 'a go-live card was asked for and walk-away mode is on');
    if (!r.went) return null;
    const { logDecision } = await import('./roadmap.ts');
    const result = `Studio took it live itself (go-live policy auto, walk-away on, beta playtested at this commit, no blockers): ${r.went}. Follow it in Activity.`;
    logDecision('walk-away approve', product, product, `No card: ${card.title} ${result}`);
    return { id: '', kind: 'deploy', target: product, params: {}, status: 'approved', card, requested_by: null, conversation: null, created: Date.now(), expires: NEVER, decided_by: WALK_AWAY_BY, decided_at: Date.now(), result, dismissed: null };
  } catch (e: any) {
    console.warn(`[approvals] automatic go-live of ${product}: ${e?.message ?? e}`);
    return null;
  }
}

/** The conversation that asked hears the decision (a notice, then a short turn of Talk's). */
async function tell(a: Approval, text: string) {
  if (!a.conversation) return;
  await import('./talk.ts').then((t) => t.studioSays(a.conversation!, text)).catch(() => {});
}
