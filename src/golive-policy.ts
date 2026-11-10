// Going live on the owner's word (J, 2026-10-31: "I want users to not have to baby sit the studio ... If the user says
// it's okay to keep going live do that. If they say hold off on going live do that. Stop building in stop guards,
// start building in smart processes and automation").
//
// Each project has a go-live policy its owner sets in their own words through Talk:
//   auto  "keep going live", "ship it when it's ready": Studio goes live by itself whenever beta's newest playtested
//         commit passes its checks (the go-live plan has no blockers) and every playtest of that commit passed with no
//         review calling it broken (playtestHolds), and Talk may take it live on the same terms without asking again.
//   hold  "hold off", "don't ship yet": nothing goes live until they say so.
//   ask   (the default) Talk goes live when the owner's message asks for it in plain words ("go live", "ship it").
// The plan's checks (beta playtested at that exact commit, nothing broken, nothing to merge) stay: they're what make
// going live by itself safe, not a person.

import { db } from './db.ts';
import { getProduct, managedElsewhere } from './config.ts';

export type Policy = 'auto' | 'hold' | 'ask';

db.exec(`CREATE TABLE IF NOT EXISTS golive_policy (product TEXT PRIMARY KEY, policy TEXT NOT NULL, by TEXT, words TEXT, at INTEGER NOT NULL)`);
// betaPlay "skip" (J, 2026-11-10: "skip beta playtests", for Hawkes Studio's own changes): beta isn't playtested; on
// policy auto it goes live once CI on beta's commit passed (the beta deploy's health check is part of CI). Games keep
// their playtests: it is per project, and off unless the owner says so for that project.
for (const col of ['beta_play TEXT', 'beta_play_by TEXT', 'beta_play_words TEXT']) try { db.exec(`ALTER TABLE golive_policy ADD COLUMN ${col}`); } catch { /* already there */ }

export type BetaPlay = 'play' | 'skip';

export function policyOf(product: string): { policy: Policy; by: string | null; words: string | null; at: number | null; betaPlay: BetaPlay; betaPlayBy: string | null; betaPlayWords: string | null } {
  const r = db.prepare('SELECT policy, by, words, at, beta_play, beta_play_by, beta_play_words FROM golive_policy WHERE product = ?').get(product) as any;
  const betaPlay: BetaPlay = r?.beta_play === 'skip' ? 'skip' : 'play';
  return r
    ? { policy: (['auto', 'hold', 'ask'].includes(r.policy) ? r.policy : 'ask') as Policy, by: r.by, words: r.words, at: r.at, betaPlay, betaPlayBy: r.beta_play_by ?? null, betaPlayWords: r.beta_play_words ?? null }
    : { policy: 'ask', by: null, words: null, at: null, betaPlay, betaPlayBy: null, betaPlayWords: null };
}

/** Whether beta is playtested before going live (play, the default) or only CI gates it (skip), from the owner's words. */
export function setBetaPlay(product: string, betaPlay: BetaPlay, by: string, words?: string | null) {
  getProduct(product);
  if (betaPlay !== 'play' && betaPlay !== 'skip') throw new Error('playtest: play | skip');
  db.prepare(`INSERT INTO golive_policy (product, policy, at) VALUES (?, 'ask', ?) ON CONFLICT(product) DO NOTHING`).run(product, Date.now());
  db.prepare('UPDATE golive_policy SET beta_play = ?, beta_play_by = ?, beta_play_words = ? WHERE product = ?').run(betaPlay, by, words ? String(words).slice(0, 500) : null, product);
  return policyOf(product);
}
export const skipsBetaPlay = (product: string) => { try { return policyOf(product).betaPlay === 'skip'; } catch { return false; } };

export type CiResult = { ok: boolean; sha: string; runs: string[]; why: string };
type CiRun = { name: string; status: string; conclusion: string | null };

/**
 * CI on one commit (every push workflow run for it, Studio's own hook aside), waited for while it runs: a deploy on
 * GitHub's runners has no callback to Studio, so this looks every 20 s for at most `maxMs`, as verifyLive does. Green:
 * every run completed as success or skipped, and at least one ran.
 */
export async function ciOn(slug: string, sha: string, { maxMs = 40 * 60_000, every = 20_000, list }: { maxMs?: number; every?: number; list?: (slug: string, sha: string) => Promise<CiRun[] | null> } = {}): Promise<CiResult> {
  const read = list ?? (async (s: string, h: string) => {
    const token = (await (await import('./ghtoken.ts')).repoToken(s).catch(() => null)) ?? process.env.GITHUB_TOKEN;
    if (!token) return null;
    const r = await fetch(`https://api.github.com/repos/${s}/actions/runs?head_sha=${h}&per_page=50`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    const j: any = r?.ok ? await r.json() : null;
    // Beta's CI is its Deploy run (ci.yml: build, deploy, health check; no tests on GitHub, J 2026-10-25). The auto-merge
    // starts it with workflow_dispatch, since a merge made with a workflow's token starts no push run: count both.
    return j ? (j.workflow_runs ?? []).filter((x: any) => ['push', 'workflow_dispatch'].includes(String(x.event)) && !/hawkes-studio/i.test(`${x.name} ${x.path}`)).map((x: any) => ({ name: String(x.name), status: String(x.status), conclusion: x.conclusion ?? null })) : null;
  });
  const end = Date.now() + maxMs;
  for (;;) {
    const runs = await read(slug, sha);
    if (runs?.length && runs.every((x) => x.status === 'completed')) {
      const bad = runs.filter((x) => !['success', 'skipped', 'neutral'].includes(String(x.conclusion)));
      return bad.length
        ? { ok: false, sha, runs: runs.map((x) => x.name), why: `CI on ${sha.slice(0, 7)} didn't pass: ${bad.map((x) => `${x.name} ${x.conclusion}`).join(', ')}` }
        : { ok: true, sha, runs: runs.map((x) => x.name), why: `CI passed on ${sha.slice(0, 7)} (${runs.map((x) => x.name).join(', ')})` };
    }
    if (Date.now() + every > end) return { ok: false, sha, runs: (runs ?? []).map((x) => x.name), why: runs?.length ? `CI on ${sha.slice(0, 7)} is still running` : `no CI run for ${sha.slice(0, 7)} yet` };
    await new Promise((r) => setTimeout(r, every));
  }
}

export function setPolicy(product: string, policy: Policy, by: string, words?: string | null) {
  getProduct(product);
  if (!['auto', 'hold', 'ask'].includes(policy)) throw new Error('policy: auto | hold | ask');
  db.prepare('INSERT INTO golive_policy (product, policy, by, words, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(product) DO UPDATE SET policy = excluded.policy, by = excluded.by, words = excluded.words, at = excluded.at')
    .run(product, policy, by, words ? String(words).slice(0, 500) : null, Date.now());
  return policyOf(product);
}

/** One playtest of the beta commit as the go-live plan lists it (deploy.ts playOf). */
export type PlayedTest = { name: string; status: string; outcome: string | null; detail?: string | null; verdict: string | null; summary?: string | null; blockers?: string[] };

/**
 * Why beta can't go live without a person (J, 2026-11-01: "Change first, then auto"): on policy auto, every playtest of
 * the exact beta commit has to have passed (done, outcome won or done), and no review of it may say "broken" or find a
 * blocker. A failed, stopped or inconclusive playtest (no GPU, Studio restarting mid-play) holds it until beta plays
 * clean. The plan shows these as warnings, so the owner can still take it live in their own words. [] when it may go.
 */
export function playtestHolds(tested: PlayedTest[] | null | undefined, short?: string | null): string[] {
  const out: string[] = [];
  const at = short ? ` on ${short}` : '';
  if (!tested?.length) return [`beta hasn't been playtested${at} yet`];
  for (const t of tested) {
    if (t.status !== 'done' || !['won', 'done'].includes(String(t.outcome))) out.push(`playtest ${t.name}${at} ${t.status === 'done' ? `ended "${t.outcome}"` : t.status === 'skipped' ? 'was inconclusive' : t.status === 'stopped' ? 'was stopped' : 'failed'}${t.detail ? ` (${String(t.detail).slice(0, 160)})` : ''}`);
    if (t.verdict === 'broken') out.push(`the review of ${t.name} said "broken"${t.summary ? `: ${String(t.summary).slice(0, 160)}` : ''}`);
    if (t.blockers?.length) out.push(`the review of ${t.name} found ${t.blockers.length} blocker(s): ${t.blockers.join('; ').slice(0, 200)}`);
  }
  return out;
}

/** The plan's holds as one line: "waits until beta plays clean: ...". null when nothing holds it. */
export function holdLine(plan: any): string | null {
  const holds = playtestHolds(plan?.tested?.playtests, plan?.tested?.sha ?? plan?.beta?.short);
  return holds.length ? `Going live by itself waits until beta plays clean: ${holds.join('; ')}. Run beta's playtest again (studio beta), or the owner can say "go live" to ship it anyway.` : null;
}

const NO = /\b(don'?t|do not|not yet|hold( off)?|wait|stop|pause|never|no)\b/i;
/** Whether a message asks to go live, in plain words ("go live", "ship it", "take it live", "deploy", "DEPLOY x"). */
export function asksToGoLive(text: string | null | undefined, product?: string): boolean {
  const t = String(text ?? '');
  if (product && new RegExp(`\\bDEPLOY\\s+${product.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)) return true;
  // "DEPLOY <another project>" names that one: not a go-ahead for this one.
  if (product && /\bDEPLOY\s+[\w-]+/.test(t)) return false;
  if (!/\b(go(ing)?|take|put|push|send|ship|make)\b[^.!?\n]{0,30}\blive\b|\bship (it|this|that)\b|\bdeploy\b|\brelease (it|this|that)\b|\bgo ahead\b[^.!?\n]{0,30}\b(live|release|ship|deploy)/i.test(t)) return false;
  return !NO.test(t);
}

/** Whether a message asks to roll back ("roll back", "revert the release", "undo the deploy", "ROLLBACK x"). */
export function asksToRollBack(text: string | null | undefined, product?: string): boolean {
  const t = String(text ?? '');
  if (product && new RegExp(`\\bROLLBACK\\s+${product.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)) return true;
  if (product && /\bROLLBACK\s+[\w-]+/.test(t)) return false;
  return /\broll(ing)?[- ]?back\b|\brevert (the |that |this )?(release|deploy|go[- ]live|live)\b|\bundo (the |that |this )?(release|deploy|go[- ]live)\b/i.test(t) && !/\b(don'?t|do not|no need)\b/i.test(t);
}

/**
 * After beta was built and playtested: when the owner said to keep going live (policy auto), go live with what passed.
 * Nothing new, the plan says it can't go (not playtested at that commit, main ahead), or a playtest of that commit
 * didn't pass or was reviewed as broken (playtestHolds): it waits, and says why in the log. Never throws (it runs at the end of builds and beta runs).
 */
export async function autoGoLive(productId: string, why: string): Promise<{ went?: string; waits?: string }> {
  try {
    const p = getProduct(productId);
    if (managedElsewhere(p)) return { waits: 'managed by another Studio' };
    const pol = policyOf(p.id);
    if (pol.policy !== 'auto') return { waits: `go-live policy is ${pol.policy}` };
    const { deployPlan, queueLive, isOverridable } = await import('./deploy.ts');
    let plan: any = await deployPlan(p.id, { notesWaitMs: 0 });
    if (!plan.commits?.length && !plan.github?.targets?.some((t: any) => t.move)) return { waits: 'nothing new on beta' };
    // The owner skips beta playtests for this project: CI on beta's exact commit is the gate instead.
    if (pol.betaPlay === 'skip' && plan.github?.slug && plan.beta?.sha) {
      const left = (plan.blockers ?? []).filter((b: string) => !isOverridable(b));
      if (left.length) {
        console.log(`[golive] ${p.id}: not going live by itself yet (${why}): ${left.join(' | ').slice(0, 400)}`);
        return { waits: left.join(' ') };
      }
      const ci = await ciOn(plan.github.slug, plan.beta.sha);
      if (!ci.ok) {
        console.log(`[golive] ${p.id}: not going live by itself yet (${why}): ${ci.why}`);
        return { waits: ci.why };
      }
      // Beta may have moved while CI ran: the newer commit gets its own pass when its CI is done.
      plan = await deployPlan(p.id, { notesWaitMs: 0 });
      if (plan.beta?.sha !== ci.sha) return { waits: `beta moved to ${plan.beta?.short ?? '?'} while CI ran on ${ci.sha.slice(0, 7)}` };
      const { op } = queueLive('golive', { product: p.id, confirm: plan.confirm, by: `Studio (${ci.why}; the owner said to skip beta playtests${pol.betaPlayWords ? `: "${pol.betaPlayWords.slice(0, 60)}"` : ''})`, beta: ci.sha, ciPassed: { sha: ci.sha, runs: ci.runs } });
      console.log(`[golive] ${p.id}: going live by itself on green CI (${why}): ${op.id}`);
      return { went: op.id };
    }
    // The one blocker is live having commits beta lacks: merge them into beta (its push builds and playtests it, and the
    // next pass goes live by itself). Anything else waits, said in the log.
    if (plan.blockers?.length === 1 && /can't be fast-forwarded/.test(plan.blockers[0]) && plan.github) {
      const { op } = queueLive('golive', { product: p.id, confirm: plan.confirm, by: 'Studio (merging live into beta before going live)', mergeMain: true });
      console.log(`[golive] ${p.id}: merging live into beta first (${why}): ${op.id}`);
      return { waits: 'merging live into beta first; it goes live once beta passes again' };
    }
    if (plan.blockers?.length) {
      console.log(`[golive] ${p.id}: not going live by itself yet (${why}): ${plan.blockers.join(' | ').slice(0, 400)}`);
      return { waits: plan.blockers.join(' ') };
    }
    // Only a beta whose playtests passed goes live with no one approving it.
    // ...and only at the exact commit that ships: the playtests listed must be of the beta commit being released.
    if (plan.tested?.sha && plan.beta?.short && plan.tested.sha !== plan.beta.short && plan.played?.short !== plan.tested.sha) return { waits: `beta moved to ${plan.beta.short} since its playtest (${plan.tested.sha})` };
    const held = holdLine(plan);
    if (held) {
      console.log(`[golive] ${p.id}: not going live by itself yet (${why}): ${held.slice(0, 400)}`);
      return { waits: held };
    }
    const { op } = queueLive('golive', { product: p.id, confirm: plan.confirm, by: `Studio (the owner said to keep going live${pol.words ? `: "${pol.words.slice(0, 80)}"` : ''})`, beta: plan.beta?.sha });
    console.log(`[golive] ${p.id}: going live by itself (${why}): ${op.id}`);
    return { went: op.id };
  } catch (e: any) {
    console.warn(`[golive] ${productId}: ${e?.message ?? e}`);
    return { waits: String(e?.message ?? e) };
  }
}
