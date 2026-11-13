// Out of credits is its own outcome (J, 2026-11-07: "the same roadmap task runs again and again when Studio is out of
// credits"). On Nov 6 Dose of Destruction's beta playtest was refused ("This studio is out of credits: playtest.run needs 9
// and 1 is left"), the run read as a failed beta build, the PM blamed the change that had just merged and sent its task back
// to an agent, which found nothing wrong; four agent changes ran for nothing.
//
// Here, the whole path in one place:
//   - creditRefusal(): is this error a refusal for credits / quota / billing (never a bug in the game or in a change)
//   - holdRun(): a run (or one of its steps) refused for credits is recorded WAITING: its step reads `cancelled` with
//     data.credits (so no review, no finding, nothing blamed: cancel.ts), and the PM leaves its tasks alone (heldRun)
//   - creditsWaiting(): the one "waiting for credits" state; paid starts (beta runs, playtests, PM dispatch) check it first
//     and skip instead of starting; ONE Inbox card (inbox.ts) says so
//   - resumeWaiting(): when credits come back (a write to billing_credits that adds some, or "Check again" on the card) the
//     waiting beta runs are played once, never twice
// No polling: the hold ends on the credit-change event. A hold also lapses after HOLD_MS, so a Studio whose balance lives in
// the control plane (a cell hears no event) tries once more instead of waiting for ever; one refusal makes it wait again.

import { db, onDbWrite, newId } from './db.ts';
import { CreditsNeeded } from './billing.ts';
import { parkEvent } from './parkevents.ts';

export const HOLD_MS = 60 * 60_000;

db.exec(`CREATE TABLE IF NOT EXISTS credit_waits (
  id TEXT PRIMARY KEY, run TEXT, product TEXT, message TEXT NOT NULL, need INTEGER, have INTEGER,
  since INTEGER NOT NULL, resumed INTEGER, resume_run TEXT
)`);

const QUOTA = /out of credits|credits? (?:are |is )?(?:needed|short|required)|insufficient (?:credit|fund|balance)|payment required|exceeded your (?:current )?quota|quota (?:exceeded|exhausted)|billing (?:hard )?limit|credit balance is too low/i;

/** The refusal behind an error (a CreditsNeeded, a 402, or words saying so), or null when it is anything else. */
export function creditRefusal(e: unknown): { message: string; need: number | null; have: number | null } | null {
  if (!e) return null;
  const any = e as any;
  const message = String(any.message ?? e);
  if (e instanceof CreditsNeeded || any.name === 'CreditsNeeded') return { message, need: any.credits?.need ?? null, have: any.credits?.have ?? null };
  if (any.status === 402 || QUOTA.test(message)) {
    const m = /needs ([\d,]+) and ([\d,]+) (?:is|are) left/.exec(message);
    return { message, need: m ? Number(m[1].replace(/,/g, '')) : null, have: m ? Number(m[2].replace(/,/g, '')) : null };
  }
  return null;
}

export type CreditWait = { since: number; message: string; need: number | null; have: number | null; runs: string[]; products: string[] };

/** Records that a run was refused for credits (once per run) and returns the wait. */
export function holdRun(run: string | null, product: string | null, why: { message: string; need: number | null; have: number | null }, since = Date.now()) {
  if (run && db.prepare('SELECT 1 FROM credit_waits WHERE run = ?').get(run)) return creditsWaiting();
  db.prepare('INSERT INTO credit_waits (id, run, product, message, need, have, since) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(newId('cw'), run, product, why.message.slice(0, 500), why.need, why.have, since);
  console.warn(`[credits] waiting for credits${run ? ` (run ${run})` : ''}: ${why.message.slice(0, 160)}`);
  return creditsWaiting();
}

/** Runs refused for credits, whatever has happened since: their steps and failures are not the game's or a change's. */
export function heldRun(run: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM credit_waits WHERE run = ?').get(run));
}

/** The one "waiting for credits" state, or null: refused recently and credits have not come back. */
export function creditsWaiting(now = Date.now()): CreditWait | null {
  const rows = db.prepare('SELECT * FROM credit_waits WHERE resumed IS NULL AND since > ? ORDER BY since').all(now - HOLD_MS) as any[];
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  return {
    since: rows[0].since, message: last.message, need: last.need ?? null, have: last.have ?? null,
    runs: rows.map((r) => r.run).filter(Boolean), products: [...new Set(rows.map((r) => r.product).filter(Boolean))] as string[],
  };
}

/** The sentence for why paid work isn't starting, or null. */
export function creditsWaitReason(now = Date.now()): string | null {
  const w = creditsWaiting(now);
  return w ? `waiting for credits: ${w.message.replace(/ Add credits.*$/, '')} It starts again by itself when credits are added.` : null;
}

/** Starts the waiting beta runs again, each once. Returns the new run ids. `startBeta` is pipeline.ts's (a parameter: no import cycle). */
export function resumeWaiting(startBeta: (product: string, o: { focus: string; playtest: boolean; play?: 'milestone' | 'golive'; plays?: any[]; cause?: 'person' | 'milestone' }) => { id: string }, now = Date.now()): string[] {
  const rows = db.prepare('SELECT * FROM credit_waits WHERE resumed IS NULL').all() as any[];
  const started: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    // Marked before it starts: a second event while this runs can't start it twice.
    const took = db.prepare('UPDATE credit_waits SET resumed = ? WHERE id = ? AND resumed IS NULL').run(now, r.id);
    if (!Number(took.changes)) continue;
    // Only a beta run is played again (a one-off playtest or a daily run is asked for again by whoever wanted it).
    const held = db.prepare('SELECT kind, options FROM runs WHERE id = ?').get(r.run) as any;
    const kind = held?.kind;
    if (!r.product || kind !== 'beta' || seen.has(r.product)) continue; // one beta run per product, however many waited
    seen.add(r.product);
    try {
      // Started again for what started it (play-policy.ts): a milestone's (or a person's go live) play still plays, once
      // (a scenario it already played on this build isn't played again); any other run only builds beta again.
      let o: any = {};
      try { o = JSON.parse(held?.options || '{}'); } catch { o = {}; }
      const play = o.play === 'milestone' || o.play === 'golive' ? o.play : undefined;
      const b = startBeta(r.product, { focus: play ? 'Playing beta again: the earlier playtest was waiting for credits.' : 'Building beta again: the earlier run was waiting for credits.', playtest: Boolean(play), ...(play ? { play } : {}), ...(play && o.plays ? { plays: o.plays } : {}), ...(o.cause ? { cause: o.cause } : {}) });
      db.prepare('UPDATE credit_waits SET resume_run = ? WHERE id = ?').run(b.id, r.id);
      started.push(b.id);
    } catch (e: any) {
      console.warn(`[credits] couldn't resume ${r.product}: ${e?.message ?? e}`);
    }
  }
  return started;
}

/** Credits were added (a grant): the waiting runs carry on. */
export function creditsBack(startBeta: Parameters<typeof resumeWaiting>[0]) {
  const ids = resumeWaiting(startBeta);
  parkEvent('credits-added'); // tasks parked until credits are back look again (parks.ts)
  if (ids.length) console.log(`[credits] credits are back: resumed ${ids.join(', ')}`);
  return ids;
}

let watching: (() => void) | null = null;
/**
 * Resumes on the credit-change event, not on a timer: a write to billing_credits that adds credits (billing.ts
 * grantCredits). Started by server.ts.
 */
export function watchCredits(startBeta: Parameters<typeof resumeWaiting>[0]) {
  if (watching) return watching;
  let queued = false;
  watching = onDbWrite((table) => {
    if (table !== 'billing_credits' || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const last = db.prepare('SELECT delta FROM billing_credits ORDER BY created DESC, rowid DESC LIMIT 1').get() as { delta: number } | undefined;
      if ((last?.delta ?? 0) > 0) creditsBack(startBeta);
    });
  });
  return watching;
}
