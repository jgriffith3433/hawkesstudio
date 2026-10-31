// A customer's Studio paying for its Hawkes Gen work out of its one balance (docs/studio-customers.md, "Billing").
//
// The balance is the org's credits in the control plane (billing.ts's ledger under the org's id, cells.ts): plans grant
// them per paid invoice, gifts and the free allowance each month, packs per purchase, the platform admin by hand. A cell
// (STUDIO_CONTROL_URL, STUDIO_ORG, STUDIO_CELL_KEY) charges every Gen job it submits through gen.ts:
//   1. Gen prices it (POST /v1/billing/quote: the same quote Gen charges its own accounts, 1 credit = $0.01)
//   2. the control plane takes that from the balance (POST /api/cells/self/credits/charge), or refuses with 402 and
//      nothing is submitted: the refusal says how many it needs, how many are left, and where to add more
//   3. the job is submitted; a job Gen hands back instead of making (reuse, the same key) is refunded at once
//   4. settleGenCharges (every 2 minutes) gives back the credits of jobs that failed or were cancelled
// Jobs on the customer's own AI (their Claude: playtest reviews, llm.*) cost no credits: Anthropic bills them.
// A Gen that refuses for lack of credits itself (402) is told the same way (genRefusal).
// STUDIO_METER_GEN=0 turns charging off (a cell still on a control plane without this route).
//
// One bank, enforced by Gen (hawkesgen src/orgcredits.ts): a Gen with the control plane's key charges every job the
// cell's key makes, on any path (its MCP, reruns, entity make), before the job exists, and refunds failures itself.
// Then this side must not charge again: genCharges() asks Gen (/v1/health `orgCredits`, cached 5 minutes) unless
// STUDIO_GEN_CHARGES says (`gen`: Gen charges; `studio`: this side does). A Gen that doesn't charge orgs (older, or not
// set up) keeps the old path below. Should the check be wrong, a job Gen says it charged (label `orgCredits`) is
// refunded here at once, so a job is never paid twice, nor free.

import crypto from 'node:crypto';
import { db } from './db.ts';
import { CreditsNeeded, outOfCredits } from './billing.ts';

db.exec(`CREATE TABLE IF NOT EXISTS gen_charges (job TEXT PRIMARY KEY, charge TEXT NOT NULL, credits INTEGER NOT NULL, tool TEXT, created INTEGER NOT NULL, settled INTEGER)`);

/** Tools that run on the customer's own AI (their Claude key or subscription): no credits. */
export const OWN_AI_TOOLS = new Set(['playtest.review', 'llm.text', 'llm.json']);

const controlUrl = () => (process.env.STUDIO_CONTROL_URL ?? '').replace(/\/+$/, '');
/** Whether this Studio charges its Gen work to its balance: a cell of a control plane. */
export const meteringOn = () => Boolean(controlUrl() && process.env.STUDIO_ORG && process.env.STUDIO_CELL_KEY) && process.env.STUDIO_METER_GEN !== '0';

/** The control plane's credits routes, with the cell's key. A 402 becomes CreditsNeeded with its numbers. */
async function control(what: 'charge' | 'refund', body: Record<string, unknown>) {
  const r = await fetch(`${controlUrl()}/api/cells/self/credits/${what}`, {
    method: 'POST', signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${process.env.STUDIO_CELL_KEY}`, 'X-Studio-Cell': String(process.env.STUDIO_ORG), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j: any = await r.json().catch(() => ({}));
  if (r.status === 402) throw new CreditsNeeded(j.error ?? outOfCredits(Number(body.credits) || 0, j.credits?.have ?? 0), j.credits?.need ?? null, j.credits?.have ?? null);
  if (!r.ok) throw Object.assign(new Error(j.error ?? `The control plane answered ${r.status}`), { status: r.status });
  return j;
}

type Raw = (path: string, o?: any) => Promise<any>;

let enforced: { at: number; on: boolean } | null = null;
/** Whether Hawkes Gen charges this cell's jobs to its balance itself (then this side only reads the balance). */
export async function genCharges(raw: Raw, now = Date.now()): Promise<boolean> {
  const set = (process.env.STUDIO_GEN_CHARGES ?? '').trim().toLowerCase();
  if (set === 'gen') return true;
  if (set === 'studio') return false;
  if (enforced && now - enforced.at < 5 * 60_000) return enforced.on;
  try {
    const h = await raw('/health');
    enforced = { at: now, on: h?.orgCredits === true };
    return enforced.on;
  } catch {
    return false; // unknown: the old path, and a job Gen says it charged is refunded here (meteredSubmit)
  }
}
/** Forget what Gen said (tests). */
export function resetGenCharges() { enforced = null; }

/** What Gen would charge for one job spec (0 for the customer's own AI). */
async function quote(raw: Raw, s: any): Promise<number> {
  if (OWN_AI_TOOLS.has(String(s?.tool ?? ''))) return 0;
  try {
    const q = await raw('/billing/quote', { method: 'POST', body: { project: s.project, tool: s.tool, preset: s.preset, params: s.params ?? {}, count: s.count } });
    return Math.max(0, Math.round(Number(q?.credits) || 0));
  } catch (e: any) {
    // An unknown tool or preset: Gen refuses the submit the same way, so nothing is charged.
    if (e?.status === 404 || e?.status === 400) return 0;
    throw e;
  }
}

const refund = (charge: string, credits: number, part: string, detail: string) => control('refund', { charge, credits, part, detail });

/**
 * POST /jobs (one spec or { jobs: [...] }) for a cell: priced, charged, submitted; reused jobs refunded at once and each
 * new job recorded for settling. `raw` is the unmetered request.
 */
export async function meteredSubmit(raw: Raw, path: string, o: any) {
  // Gen charges the balance itself: nothing to take here (its 402 says what's short: genRefusal).
  if (await genCharges(raw)) return raw(path, o);
  const body = o?.body ?? {};
  const specs: any[] = Array.isArray(body.jobs) ? body.jobs : [body];
  const quotes = await Promise.all(specs.map((s) => quote(raw, s)));
  const total = quotes.reduce((a, b) => a + b, 0);
  if (!total) return raw(path, o);
  const charge = `gc_${crypto.randomBytes(8).toString('hex')}`;
  const what = specs.length === 1 ? String(specs[0].tool ?? specs[0].preset ?? 'this job') : `these ${specs.length} jobs`;
  await control('charge', { charge, credits: total, what, detail: `Hawkes Gen: ${specs.length === 1 ? what : `${specs.length} jobs (${[...new Set(specs.map((s) => s.tool))].join(', ').slice(0, 120)})`}` });
  const started = Date.now();
  let r: any;
  try { r = await raw(path, o); } catch (e) {
    await refund(charge, total, 'unsent', 'Hawkes Gen did not take the job: credits back').catch((x) => console.warn(`[credits] refund of ${charge}: ${x.message}`));
    throw e;
  }
  const jobs: any[] = Array.isArray(r?.jobs) ? r.jobs : [];
  let back = 0;
  specs.forEach((s, i) => {
    const q = quotes[i];
    if (!q) return;
    const j = jobs[i];
    // Handed back rather than made (reuse, or the same key as before): nothing new to pay for.
    if (!j?.id || j.reused || (Number(j.created) > 0 && Number(j.created) < started - 2000)) { back += q; return; }
    // Gen charged it too (it charges orgs now): ours goes back, so it's paid once.
    if (Number(j.labels?.orgCredits) > 0) { back += q; enforced = { at: Date.now(), on: true }; return; }
    const ins = db.prepare('INSERT OR IGNORE INTO gen_charges (job, charge, credits, tool, created) VALUES (?, ?, ?, ?, ?)').run(j.id, charge, q, String(s.tool ?? ''), Date.now());
    if (!ins.changes) back += q;
  });
  if (back) await refund(charge, back, 'reused', 'Hawkes Gen had it already: credits back').catch((x) => console.warn(`[credits] refund of ${charge}: ${x.message}`));
  return r;
}

/** Gives back the credits of charged jobs that failed or were cancelled (and stops watching finished or old ones). */
export async function settleGenCharges(getJob: (id: string) => Promise<any>, now = Date.now()) {
  const out = { refunded: [] as string[], settled: 0 };
  const rows = db.prepare('SELECT * FROM gen_charges WHERE settled IS NULL ORDER BY created LIMIT 200').all() as { job: string; charge: string; credits: number; tool: string; created: number }[];
  for (const row of rows) {
    let j: any;
    try { j = await getJob(row.job); } catch (e: any) {
      if (e?.status === 404 || now - row.created > 3 * 86_400_000) db.prepare('UPDATE gen_charges SET settled = ? WHERE job = ?').run(now, row.job);
      continue;
    }
    if (j?.status === 'failed' || j?.status === 'cancelled') {
      try {
        await refund(row.charge, row.credits, row.job, `Hawkes Gen ${row.tool || 'job'} ${j.status}: credits back`);
        out.refunded.push(row.job);
      } catch (e: any) { console.warn(`[credits] refund for ${row.job}: ${e.message}`); continue; }
    } else if (j?.status !== 'done' && now - row.created < 3 * 86_400_000) continue;
    db.prepare('UPDATE gen_charges SET settled = ? WHERE job = ?').run(now, row.job);
    out.settled++;
  }
  return out;
}

/** Settles every 2 minutes in a metered cell (server.ts at start). */
export function startCreditSettler(getJob: (id: string) => Promise<any>, every = 2 * 60_000) {
  if (!meteringOn()) return;
  setInterval(() => void settleGenCharges(getJob).catch((e) => console.warn(`[credits] settling: ${e.message}`)), every).unref();
}

/** Gen's own refusal for lack of credits (402), told the way Studio tells it; anything else unchanged. */
export function genRefusal(e: any) {
  if (e instanceof CreditsNeeded) return e;
  if (e?.status === 402 && (e.kind === 'credits' || /credit/i.test(String(e.message ?? '')))) {
    const msg = String(e.message ?? '');
    // The control plane's own words, passed on by Gen when it charges the studio (hawkesgen src/orgcredits.ts).
    const cp = /^This studio is out of credits: .*? needs ([\d,]+) and ([\d,]+) (?:is|are) left/.exec(msg);
    if (cp) return new CreditsNeeded(msg, Number(cp[1].replace(/,/g, '')), Number(cp[2].replace(/,/g, '')));
    const m = /need (\d+), have (\d+)/i.exec(String(e.message ?? ''));
    return new CreditsNeeded(m ? outOfCredits(Number(m[1]), Number(m[2])) : `This studio is out of credits for Hawkes Gen (${String(e.message ?? '').slice(0, 160)}). Add credits or upgrade your plan in Settings → Plan and credits.`, m ? Number(m[1]) : null, m ? Number(m[2]) : null);
  }
  return e;
}
