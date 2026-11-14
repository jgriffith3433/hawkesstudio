// A milestone's play is a batch of work, not one item (J, 2026-11-11: "playtests don't need to be so frequent either",
// "Do it during milestones"; 2026-11-10: fewer, higher quality roadmap items). That day 88 of 125 milestones held one
// item each, so a product reached a milestone, and played it on RunPod, every 20 to 60 minutes: about 315 plays a day
// with nothing else playing. A milestone that held one item was just a play per item under another name.
//
// The rule, in this one place, for milestones of one product (a milestone spanning products goes alone):
//   1. Complete milestones of a product are checked together: one beta run per product plays all of them at once, on one
//      build (pm.ts reachMilestones -> milestoneCheck with the group).
//   2. They wait while the product has more milestone work on its way (another open milestone with a task being worked
//      on, merged, or planned and able to start by itself), until they hold BATCH_ITEMS items between them.
//   3. A wait ends after BATCH_WAIT_MS from when the first of them was found complete, so work never waits for ever
//      behind a milestone that grinds. Read on the PM's own pass (no timer, no polling of its own).
// Planning follows the same line at the source (roadmap.ts addMilestone, the roadmap tools): a new milestone of a
// product that already has an open one with room is refused, with the milestone to add the items to instead.
import * as R from './roadmap.ts';

/** Items a product's milestones hold between them before their play starts while more work is on its way. */
export const BATCH_ITEMS = 4;
/** The longest a complete milestone waits for others of its product to join its play. */
export const BATCH_WAIT_MS = 6 * 3600_000;
/** Items a milestone holds at most when the planner adds one: a batch J can still test by hand in one sitting. */
export const MILESTONE_MAX_ITEMS = 6;

export type Ready = { id: string; product: string | null; items: number; since: number };
export type BatchVerdict = { go: string[][]; wait: { id: string; why: string }[] };

/** The rule. Pure: complete milestones, what each product still has coming, and the time give the same answer. */
export function batchVerdict(ready: Ready[], coming: (product: string) => string[], now = Date.now()): BatchVerdict {
  const out: BatchVerdict = { go: [], wait: [] };
  const groups = new Map<string, Ready[]>();
  for (const r of ready) {
    const k = r.product ?? `milestone:${r.id}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const [k, g] of groups) {
    const ids = g.map((r) => r.id);
    if (k.startsWith('milestone:')) { out.go.push(ids); continue; }
    const items = g.reduce((n, r) => n + r.items, 0);
    const more = coming(k);
    const oldest = Math.min(...g.map((r) => r.since));
    if (items >= BATCH_ITEMS || !more.length || now - oldest >= BATCH_WAIT_MS) { out.go.push(ids); continue; }
    const why = `waits to be played with more of ${k}'s work: ${items} item${items === 1 ? '' : 's'} complete, under the ${BATCH_ITEMS} a milestone's play covers, and ${more.length} more milestone${more.length === 1 ? '' : 's'} on the way (${more.join(', ')}); played together then, or by ${new Date(oldest + BATCH_WAIT_MS).toISOString().slice(11, 16)} UTC at the latest`;
    for (const id of ids) out.wait.push({ id, why });
  }
  return out;
}

const ACTIVE = ['working', 'needs answer', 'review', 'merged'];

/** Other open milestones of the product with work on its way: a task being worked on or merged, or planned and able to start by itself. */
export function milestonesComing(product: string, except: Set<string>): string[] {
  const out: string[] = [];
  for (const m of R.listMilestones({ product, status: 'open' }) as any[]) {
    if (except.has(m.id) || m.product !== product) continue;
    const live = R.milestoneTasks(m.id).some((t) => {
      if (ACTIVE.includes(t.status)) return true;
      if (t.status !== 'planned') return false;
      if (R.blockedBy(t).some((d) => R.STUCK_DEPENDENCY.includes(d.status))) return false;
      return R.gpuCleared(t);
    });
    if (live) out.push(`"${m.title}"`);
  }
  return out;
}

/** When a milestone was first found complete and waiting (its first batch decision), or now. */
export function waitingSince(id: string, now = Date.now()) {
  const rows = R.listDecisions({ since: 0, action: 'milestone-batch', limit: 10_000, subject: id });
  return rows.length ? rows[rows.length - 1].at : now;
}

/** The open milestone of the product a new one's items belong in instead (one with room, not complete), or null. */
export function milestoneWithRoom(product: string | null): { id: string; title: string; total: number } | null {
  if (!product) return null;
  const open = (R.listMilestones({ product, status: 'open' }) as any[]).filter((m) => m.product === product && !R.milestoneComplete(m) && m.total < MILESTONE_MAX_ITEMS);
  open.sort((a, b) => a.ord - b.ord || a.created - b.created);
  return open[0] ? { id: open[0].id, title: open[0].title, total: open[0].total } : null;
}
