// Going live on the owner's word (J, 2026-10-31: "I want users to not have to baby sit the studio ... If the user says
// it's okay to keep going live do that. If they say hold off on going live do that. Stop building in stop guards,
// start building in smart processes and automation").
//
// Each project has a go-live policy its owner sets in their own words through Talk:
//   auto  "keep going live", "ship it when it's ready": Studio goes live by itself whenever beta's newest playtested
//         commit passes its checks (the go-live plan has no blockers), and Talk may take it live without asking again.
//   hold  "hold off", "don't ship yet": nothing goes live until they say so.
//   ask   (the default) Talk goes live when the owner's message asks for it in plain words ("go live", "ship it").
// The plan's checks (beta playtested at that exact commit, nothing broken, nothing to merge) stay: they're what make
// going live by itself safe, not a person.

import { db } from './db.ts';
import { getProduct, managedElsewhere } from './config.ts';

export type Policy = 'auto' | 'hold' | 'ask';

db.exec(`CREATE TABLE IF NOT EXISTS golive_policy (product TEXT PRIMARY KEY, policy TEXT NOT NULL, by TEXT, words TEXT, at INTEGER NOT NULL)`);

export function policyOf(product: string): { policy: Policy; by: string | null; words: string | null; at: number | null } {
  const r = db.prepare('SELECT policy, by, words, at FROM golive_policy WHERE product = ?').get(product) as any;
  return r ? { policy: (['auto', 'hold', 'ask'].includes(r.policy) ? r.policy : 'ask') as Policy, by: r.by, words: r.words, at: r.at } : { policy: 'ask', by: null, words: null, at: null };
}

export function setPolicy(product: string, policy: Policy, by: string, words?: string | null) {
  getProduct(product);
  if (!['auto', 'hold', 'ask'].includes(policy)) throw new Error('policy: auto | hold | ask');
  db.prepare('INSERT INTO golive_policy (product, policy, by, words, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(product) DO UPDATE SET policy = excluded.policy, by = excluded.by, words = excluded.words, at = excluded.at')
    .run(product, policy, by, words ? String(words).slice(0, 500) : null, Date.now());
  return policyOf(product);
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
 * Nothing new, or the plan says it can't go (not playtested at that commit, something broken, main ahead): it waits,
 * and says why in the log. Never throws (it runs at the end of builds and beta runs).
 */
export async function autoGoLive(productId: string, why: string): Promise<{ went?: string; waits?: string }> {
  try {
    const p = getProduct(productId);
    if (managedElsewhere(p)) return { waits: 'managed by another Studio' };
    const pol = policyOf(p.id);
    if (pol.policy !== 'auto') return { waits: `go-live policy is ${pol.policy}` };
    const { deployPlan, queueLive } = await import('./deploy.ts');
    const plan: any = await deployPlan(p.id, { notesWaitMs: 0 });
    if (!plan.commits?.length && !plan.github?.targets?.some((t: any) => t.move)) return { waits: 'nothing new on beta' };
    if (plan.blockers?.length) {
      console.log(`[golive] ${p.id}: not going live by itself yet (${why}): ${plan.blockers.join(' | ').slice(0, 400)}`);
      return { waits: plan.blockers.join(' ') };
    }
    const { op } = queueLive('golive', { product: p.id, confirm: plan.confirm, by: `Studio (the owner said to keep going live${pol.words ? `: "${pol.words.slice(0, 80)}"` : ''})`, beta: plan.beta?.sha });
    console.log(`[golive] ${p.id}: going live by itself (${why}): ${op.id}`);
    return { went: op.id };
  } catch (e: any) {
    console.warn(`[golive] ${productId}: ${e?.message ?? e}`);
    return { waits: String(e?.message ?? e) };
  }
}
