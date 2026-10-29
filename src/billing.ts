// Studio subscriptions (docs/studio-customers.md, "Billing"; built like Hawkes Gen's src/subscriptions.ts so the
// three products behave alike). J, 2026-10-29: one Stripe account for the portal, Gen and Studio; test keys on beta.
//
// A plan is a monthly price that grants credits each paid month (1 credit = $0.01) and sets how many games this Studio
// may have. The subscription belongs to this Studio (studioId(): the org cell's org, else an id made once), bought by
// one of its admins. Stripe does the money:
//   - a Checkout session in subscription mode, tagged metadata[product]=studio (on the session and subscription_data)
//     with this Studio's id
//   - the webhook (POST /api/billing/webhook, Stripe's signature checked with this endpoint's secret):
//       checkout.session.completed      records the subscription
//       invoice.paid                    grants that month's credits once per invoice (ledger key invoice:<id>)
//       invoice.payment_failed          marks it past due (still the current plan; credits already granted stay)
//       customer.subscription.updated / deleted   keep its status, period and cancel-at-period-end
//   - cancel and resume act at the period's end; the Stripe billing portal manages cards and receipts.
// The portal and Gen share the Stripe account, and every Studio cell has its own endpoint on it, so every endpoint gets
// every event: this Studio acts only on events tagged studio with its own id, or about a subscription or customer it
// already knows, and answers 200 without acting to everything else (an error makes Stripe retry, then disable the
// endpoint).
//
// Keys (never logged, never in the API): .data/stripe.json ({ secretKey, webhookSecret, publishableKey }, 0600, synced
// to the state bucket as state/stripe.json on Cloud Run), else the environment: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
// STRIPE_PUBLISHABLE_KEY. STRIPE_API_BASE points the calls at a stand-in (tests).
//
// Plans are seeded when the table is empty; prices are provisional until J sets them (POST /api/billing/plans, the
// platform admin's: lockdown.ts).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, newId } from './db.ts';
import { DATA, StudioError } from './config.ts';
import { cellOrg } from './platform.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS billing_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS billing_plans (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL, credits_per_month INTEGER NOT NULL,
    max_games INTEGER NOT NULL, stripe_price_id TEXT, active INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS billing_subscriptions (
    id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, stripe_subscription_id TEXT NOT NULL UNIQUE, stripe_customer_id TEXT,
    status TEXT NOT NULL, period_start INTEGER, period_end INTEGER, cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    by_user TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS billing_credits (
    id TEXT PRIMARY KEY, delta INTEGER NOT NULL, balance_after INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT,
    ref TEXT UNIQUE, created INTEGER NOT NULL
  );
`);
// Which Studio a row is for: this one, or (in the control plane, cells.ts) a customer's org billed here. Rows from before
// the column are this Studio's (scope below).
for (const t of ['billing_subscriptions', 'billing_credits']) {
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN studio_id TEXT`); } catch { /* already there */ }
}

// ------------------------------------------------------------------ keys

const CONFIG = () => path.join(DATA, 'stripe.json');

export function stripeKeys() {
  let f: Record<string, string> = {};
  try { f = JSON.parse(fs.readFileSync(CONFIG(), 'utf8')) ?? {}; } catch { /* none */ }
  const pick = (a: string, b: string) => String(f[a] ?? f[b] ?? '').trim() || process.env[b]?.trim() || undefined;
  return { secretKey: pick('secretKey', 'STRIPE_SECRET_KEY'), webhookSecret: pick('webhookSecret', 'STRIPE_WEBHOOK_SECRET'), publishableKey: pick('publishableKey', 'STRIPE_PUBLISHABLE_KEY') };
}

/**
 * Sets this Studio's Stripe keys (POST /api/billing/config, the platform admin only): written to .data/stripe.json
 * (0600; synced to the state bucket on Cloud Run, so a restart keeps it). Empty values leave a key as it was.
 */
export function saveStripeConfig(input: { secretKey?: unknown; webhookSecret?: unknown; publishableKey?: unknown }) {
  let f: Record<string, string> = {};
  try { f = JSON.parse(fs.readFileSync(CONFIG(), 'utf8')) ?? {}; } catch { /* none */ }
  const set = (k: 'secretKey' | 'webhookSecret' | 'publishableKey', re: RegExp) => {
    const v = typeof input[k] === 'string' ? (input[k] as string).trim() : '';
    if (!v) return;
    if (!re.test(v)) throw new StudioError(`That ${k} doesn't look like one of Stripe's`, 400);
    f[k] = v;
  };
  set('secretKey', /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/);
  set('webhookSecret', /^whsec_[A-Za-z0-9]+$/);
  set('publishableKey', /^pk_(test|live)_[A-Za-z0-9]+$/);
  fs.writeFileSync(CONFIG(), JSON.stringify(f, null, 2), { mode: 0o600 });
  return stripeStatus();
}

/** Whether payments are set up, and in which mode (never a key). */
export function stripeStatus() {
  const k = stripeKeys();
  const mode = [k.secretKey, k.publishableKey].some((x) => x?.includes('_live_')) ? 'live' : [k.secretKey, k.publishableKey].some((x) => x?.includes('_test_')) ? 'test' : null;
  return { configured: Boolean(k.secretKey), webhook: Boolean(k.webhookSecret), mode, publishableKey: k.publishableKey ?? null };
}

async function stripe(pathname: string, form?: URLSearchParams, method = form ? 'POST' : 'GET') {
  const { secretKey } = stripeKeys();
  if (!secretKey) throw new StudioError('Payments are not set up on this Studio yet.', 503);
  const base = (process.env.STRIPE_API_BASE ?? 'https://api.stripe.com').replace(/\/+$/, '');
  const r = await fetch(`${base}/v1/${pathname}`, {
    method, headers: { Authorization: `Bearer ${secretKey}`, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: form?.toString(), signal: AbortSignal.timeout(20_000),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new StudioError(data?.error?.message ?? `Stripe error (HTTP ${r.status})`, 502);
  return data;
}

// ------------------------------------------------------------------ this Studio

/** This Studio's id on Stripe's events: the org cell's org, else one made the first time it's asked for. */
export function studioId(): string {
  const org = cellOrg();
  if (org) return org;
  const r = db.prepare(`SELECT value FROM billing_state WHERE key = 'studio_id'`).get() as { value: string } | undefined;
  if (r) return r.value;
  const id = `st_${crypto.randomBytes(8).toString('hex')}`;
  db.prepare(`INSERT OR IGNORE INTO billing_state (key, value) VALUES ('studio_id', ?)`).run(id);
  return (db.prepare(`SELECT value FROM billing_state WHERE key = 'studio_id'`).get() as { value: string }).value;
}

let owned = false;
/** The id rows are kept under (`sid`, else this Studio's); rows made before studio_id existed become this Studio's. */
function scope(sid?: string) {
  const own = studioId();
  if (!owned) {
    for (const t of ['billing_subscriptions', 'billing_credits']) db.prepare(`UPDATE ${t} SET studio_id = ? WHERE studio_id IS NULL`).run(own);
    owned = true;
  }
  return sid || own;
}

// The control plane (cells.ts) bills customers' orgs here too: it says which ids are its, and hears of new plans.
let knownStudio: (sid: string) => boolean = () => false;
let subscribed: (sid: string, plan: Plan) => void = () => {};
export function setStudioHooks(h: { known?: (sid: string) => boolean; subscribed?: (sid: string, plan: Plan) => void }) {
  if (h.known) knownStudio = h.known;
  if (h.subscribed) subscribed = h.subscribed;
}

// ------------------------------------------------------------------ plans

export type Plan = { id: string; name: string; priceCents: number; creditsPerMonth: number; maxGames: number; stripePriceId: string | null; active: boolean };

/** Provisional plans (J sets the real ones): the portal's draft prices and Studio entitlements (platform-plan 7). */
export const DEFAULT_PLANS = [
  { id: 'studio_indie', name: 'Indie', priceCents: 2900, creditsPerMonth: 1500, maxGames: 3 },
  { id: 'studio_team', name: 'Team', priceCents: 9900, creditsPerMonth: 5000, maxGames: 10 },
  { id: 'studio_studio', name: 'Studio', priceCents: 29900, creditsPerMonth: 15000, maxGames: 30 },
] as const;

const toPlan = (r: any): Plan => ({ id: r.id, name: r.name, priceCents: r.price_cents, creditsPerMonth: r.credits_per_month, maxGames: r.max_games, stripePriceId: r.stripe_price_id ?? null, active: !!r.active });

function seedPlans() {
  if ((db.prepare('SELECT COUNT(*) AS n FROM billing_plans').get() as any).n) return;
  DEFAULT_PLANS.forEach((p, i) => db.prepare('INSERT INTO billing_plans (id, name, price_cents, credits_per_month, max_games, active, position) VALUES (?, ?, ?, ?, ?, 1, ?)').run(p.id, p.name, p.priceCents, p.creditsPerMonth, p.maxGames, i));
}

export function listPlans({ all = false } = {}) {
  seedPlans();
  return (db.prepare(`SELECT * FROM billing_plans ${all ? '' : 'WHERE active = 1'} ORDER BY position, price_cents`).all() as any[]).map(toPlan);
}

export function getPlan(id: string) {
  seedPlans();
  const r = db.prepare('SELECT * FROM billing_plans WHERE id = ?').get(id);
  return r ? toPlan(r) : null;
}

/** Adds or changes a plan (the platform admin's: J sets the real prices). A new price applies to new checkouts only. */
export function savePlan(input: Partial<Plan> & { id: string }) {
  const id = String(input.id ?? '').trim();
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(id)) throw new StudioError('id: 2-40 lower-case letters, digits or _');
  const cur = getPlan(id);
  const num = (v: unknown, fallback: number | undefined, what: string) => {
    const n = v === undefined ? fallback : Number(v);
    if (n === undefined || !Number.isInteger(n) || n < 0) throw new StudioError(`${what}: a whole number, 0 or more`);
    return n;
  };
  const p = {
    name: String(input.name ?? cur?.name ?? '').trim().slice(0, 60),
    priceCents: num(input.priceCents, cur?.priceCents, 'priceCents'),
    creditsPerMonth: num(input.creditsPerMonth, cur?.creditsPerMonth, 'creditsPerMonth'),
    maxGames: num(input.maxGames, cur?.maxGames, 'maxGames'),
    stripePriceId: input.stripePriceId === undefined ? cur?.stripePriceId ?? null : input.stripePriceId ? String(input.stripePriceId).trim() : null,
    active: input.active === undefined ? cur?.active ?? true : Boolean(input.active),
  };
  if (!p.name) throw new StudioError('name: required');
  db.prepare(`INSERT INTO billing_plans (id, name, price_cents, credits_per_month, max_games, stripe_price_id, active, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM billing_plans))
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, price_cents = excluded.price_cents, credits_per_month = excluded.credits_per_month,
      max_games = excluded.max_games, stripe_price_id = excluded.stripe_price_id, active = excluded.active`)
    .run(id, p.name, p.priceCents, p.creditsPerMonth, p.maxGames, p.stripePriceId, p.active ? 1 : 0);
  return getPlan(id)!;
}

// ------------------------------------------------------------------ the subscription

export type Subscription = { id: string; planId: string; plan: Plan | null; stripeSubscriptionId: string; status: 'active' | 'trialing' | 'past_due' | 'canceled'; periodStart: number | null; periodEnd: number | null; cancelAtPeriodEnd: boolean; by: string | null; created: number };

const toSub = (r: any): Subscription => ({ id: r.id, planId: r.plan_id, plan: getPlan(r.plan_id), stripeSubscriptionId: r.stripe_subscription_id, status: r.status, periodStart: r.period_start ?? null, periodEnd: r.period_end ?? null, cancelAtPeriodEnd: !!r.cancel_at_period_end, by: r.by_user ?? null, created: r.created });

/** The current plan: the newest subscription that isn't canceled (past due still counts), else null. */
export function currentSubscription(sid?: string): Subscription | null {
  const r = db.prepare(`SELECT * FROM billing_subscriptions WHERE studio_id = ? AND status != 'canceled' ORDER BY created DESC LIMIT 1`).get(scope(sid));
  return r ? toSub(r) : null;
}

/** The Stripe customer this Studio pays as (from its first checkout), or null. */
const customerKey = (sid: string) => (sid === studioId() ? 'stripe_customer' : `stripe_customer:${sid}`);
const customerId = (sid?: string) => (db.prepare(`SELECT value FROM billing_state WHERE key = ?`).get(customerKey(scope(sid))) as { value: string } | undefined)?.value ?? null;

/** How many games this Studio's plan allows; null without a plan (onboarding's own rules apply). */
export function planGames(sid?: string): number | null {
  const s = currentSubscription(sid);
  return s?.plan ? s.plan.maxGames : null;
}

// ------------------------------------------------------------------ credits

export function creditBalance(sid?: string): number {
  return (db.prepare('SELECT balance_after FROM billing_credits WHERE studio_id = ? ORDER BY created DESC, rowid DESC LIMIT 1').get(scope(sid)) as { balance_after: number } | undefined)?.balance_after ?? 0;
}

/** Adds credits once per ref (Stripe retries webhooks: a second grant with the same ref changes nothing). */
export function grantCredits(delta: number, kind: string, detail: string, ref: string | null, sid?: string) {
  const id = scope(sid);
  if (ref && db.prepare('SELECT 1 FROM billing_credits WHERE ref = ?').get(ref)) return { duplicate: true, balance: creditBalance(id) };
  const balance = creditBalance(id) + delta;
  db.prepare('INSERT INTO billing_credits (id, delta, balance_after, kind, detail, ref, created, studio_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(newId('cr'), delta, balance, kind, detail, ref, Date.now(), id);
  return { duplicate: false, balance };
}

export function creditLedger(limit = 50, sid?: string) {
  return db.prepare('SELECT id, delta, balance_after, kind, detail, created FROM billing_credits WHERE studio_id = ? ORDER BY created DESC, rowid DESC LIMIT ?').all(scope(sid), limit) as any[];
}

// ------------------------------------------------------------------ checkout, cancel, resume, portal

/** A Stripe Checkout session for a plan: the admin goes to `url`, pays, and comes back to Settings. */
export async function checkout(planId: string, by: { id: string; email: string }, origin: string, o: { sid?: string; successUrl?: string; cancelUrl?: string } = {}) {
  const plan = getPlan(String(planId ?? ''));
  if (!plan || !plan.active) throw new StudioError(`Unknown plan "${planId}"`, 404);
  const sid = scope(o.sid);
  if (currentSubscription(sid)) throw new StudioError('This Studio already has a plan: manage it from Settings.', 409);
  const f = new URLSearchParams();
  f.set('mode', 'subscription');
  f.set('client_reference_id', sid);
  const cust = customerId(sid);
  if (cust) f.set('customer', cust);
  else if (/@/.test(by.email) && !by.email.endsWith('@accounts.hawkesgen.ai')) f.set('customer_email', by.email);
  f.set('success_url', o.successUrl ?? `${origin}/?checkout=success#settings`);
  f.set('cancel_url', o.cancelUrl ?? `${origin}/?checkout=cancelled#settings`);
  // The product tag and this Studio's id: the portal, Gen and other Studios share the account and skip what isn't theirs.
  for (const pre of ['metadata', 'subscription_data[metadata]']) {
    f.set(`${pre}[product]`, 'studio');
    f.set(`${pre}[studio_id]`, sid);
    f.set(`${pre}[plan_id]`, plan.id);
    f.set(`${pre}[user_id]`, by.id);
  }
  f.set('line_items[0][quantity]', '1');
  if (plan.stripePriceId) f.set('line_items[0][price]', plan.stripePriceId);
  else {
    f.set('line_items[0][price_data][currency]', 'usd');
    f.set('line_items[0][price_data][unit_amount]', String(plan.priceCents));
    f.set('line_items[0][price_data][recurring][interval]', 'month');
    f.set('line_items[0][price_data][product_data][name]', `Hawkes Studio ${plan.name}`);
  }
  const s = await stripe('checkout/sessions', f);
  return { url: s.url as string, sessionId: s.id as string, plan };
}

/** Cancels at the end of the paid month (resume undoes it before then). */
export async function setCancelAtPeriodEnd(cancel: boolean, sid?: string) {
  const sub = currentSubscription(sid);
  if (!sub) throw new StudioError('This Studio has no plan.', 404);
  await stripe(`subscriptions/${encodeURIComponent(sub.stripeSubscriptionId)}`, new URLSearchParams({ cancel_at_period_end: cancel ? 'true' : 'false' }));
  db.prepare('UPDATE billing_subscriptions SET cancel_at_period_end = ?, updated = ? WHERE id = ?').run(cancel ? 1 : 0, Date.now(), sub.id);
  return currentSubscription(sid);
}

/** Stripe's billing portal: cards, receipts, cancel. */
export async function billingPortal(origin: string, o: { sid?: string; returnUrl?: string } = {}) {
  const cust = customerId(o.sid);
  if (!cust) throw new StudioError('Nothing to manage yet: this Studio has not paid for anything.', 404);
  const s = await stripe('billing_portal/sessions', new URLSearchParams({ customer: cust, return_url: o.returnUrl ?? `${origin}/#settings` }));
  return { url: s.url as string };
}

// ------------------------------------------------------------------ the webhook

/** Checks Stripe's signature (Stripe-Signature: t=<seconds>,v1=<hmac>) with this endpoint's secret. Throws why. */
export function verifyStripeSignature(raw: Buffer | string, header: string, secret = stripeKeys().webhookSecret, toleranceSec = 300) {
  if (!secret) throw new StudioError('The Stripe webhook is not set up on this Studio (no webhook secret).', 503);
  let t = 0;
  const sigs: string[] = [];
  for (const part of String(header ?? '').split(',')) {
    const [k, v] = part.trim().split('=', 2);
    if (k === 't') t = Number(v);
    else if (k === 'v1' && v) sigs.push(v);
  }
  if (!(t > 0) || !sigs.length) throw new StudioError('Missing or malformed Stripe-Signature header', 400);
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSec) throw new StudioError('Stripe webhook timestamp outside the tolerance window', 400);
  const want = crypto.createHmac('sha256', secret).update(`${t}.${typeof raw === 'string' ? raw : raw.toString('utf8')}`, 'utf8').digest();
  const ok = sigs.some((s) => /^[0-9a-f]{64}$/i.test(s) && crypto.timingSafeEqual(Buffer.from(s, 'hex'), want));
  if (!ok) throw new StudioError('Invalid Stripe webhook signature', 400);
}

const subByStripe = (id: string) => (id ? db.prepare('SELECT * FROM billing_subscriptions WHERE stripe_subscription_id = ?').get(id) as any : undefined);
const subIdOf = (event: any) => {
  const o = event?.data?.object ?? {};
  return String((String(event?.type ?? '').startsWith('customer.subscription.') ? o.id : o.subscription ?? o.parent?.subscription_details?.subscription) ?? '');
};
const metaOf = (o: any) => ({ ...(o.parent?.subscription_details?.metadata ?? {}), ...(o.subscription_details?.metadata ?? {}), ...(o.metadata ?? {}) });

/**
 * Whose event this is: this Studio's id, or a customer org the control plane bills here (cells.ts), when it is tagged
 * studio with that id or is about a subscription or customer already known; null for everyone else's.
 */
export function studioOfEvent(event: any): string | null {
  const o = event?.data?.object ?? {};
  const meta = metaOf(o);
  const own = scope();
  if (typeof meta.product === 'string' && meta.product) {
    const sid = String(meta.studio_id ?? '');
    return meta.product === 'studio' && sid && (sid === own || knownStudio(sid)) ? sid : null;
  }
  const sub = subByStripe(subIdOf(event));
  if (sub) return sub.studio_id ?? own;
  if (typeof o.customer !== 'string' || !o.customer) return null;
  const r = db.prepare(`SELECT key FROM billing_state WHERE (key = 'stripe_customer' OR key LIKE 'stripe_customer:%') AND value = ?`).get(o.customer) as { key: string } | undefined;
  return r ? (r.key === 'stripe_customer' ? own : r.key.slice('stripe_customer:'.length)) : null;
}

/** Whether an event is this Studio's (or one of the orgs billed here). */
export const isStudioEvent = (event: any) => studioOfEvent(event) !== null;

const secs = (v: unknown) => (Number(v) > 0 ? Number(v) * 1000 : null);
const STATUS: Record<string, Subscription['status']> = { active: 'active', trialing: 'trialing', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled', incomplete_expired: 'canceled' };

/** One of this Studio's events. Throws only on an event that is this Studio's and can't be applied (Stripe retries). */
function apply(event: any, sid: string): Record<string, unknown> {
  const o = event?.data?.object ?? {};
  const type = String(event?.type ?? 'unknown');
  const now = Date.now();
  switch (type) {
    case 'checkout.session.completed': {
      if (o.mode !== 'subscription') return { ok: true, type, ignored: 'not a subscription checkout' };
      const meta = metaOf(o);
      const plan = getPlan(String(meta.plan_id ?? ''));
      const stripeId = String(o.subscription ?? '');
      if (!plan || !stripeId) throw new StudioError('A Studio checkout without a plan or subscription', 400);
      if (typeof o.customer === 'string') db.prepare(`INSERT OR IGNORE INTO billing_state (key, value) VALUES (?, ?)`).run(customerKey(sid), o.customer);
      if (!subByStripe(stripeId)) {
        db.prepare(`INSERT INTO billing_subscriptions (id, plan_id, stripe_subscription_id, stripe_customer_id, status, period_start, period_end, by_user, created, updated, studio_id)
          VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`).run(newId('sub'), plan.id, stripeId, typeof o.customer === 'string' ? o.customer : null, now, now + 31 * 86_400_000, meta.user_id ? String(meta.user_id) : null, now, now, sid);
        try { subscribed(sid, plan); } catch (e: any) { console.warn(`[billing] after ${sid} subscribed: ${e.message ?? e}`); }
      }
      return { ok: true, type, subscription: stripeId, studio: sid };
    }
    case 'invoice.paid': {
      const stripeId = subIdOf(event);
      if (!stripeId) return { ok: true, type, ignored: 'not a subscription invoice' };
      const sub = subByStripe(stripeId);
      const plan = getPlan(sub?.plan_id ?? String(metaOf(o).plan_id ?? ''));
      if (!plan) throw new StudioError(`An invoice for an unknown Studio plan (${stripeId})`, 400);
      // Once per invoice: Stripe retries, and the ledger refuses a second grant for the same invoice.
      const r = grantCredits(plan.creditsPerMonth, 'subscription_credits', `${plan.name} plan: this month's credits`, `invoice:${o.id}`, sid);
      const period = o.lines?.data?.[0]?.period;
      if (sub) db.prepare('UPDATE billing_subscriptions SET status = ?, period_start = COALESCE(?, period_start), period_end = COALESCE(?, period_end), updated = ? WHERE id = ?').run('active', secs(period?.start), secs(period?.end), now, sub.id);
      return { ok: true, type, duplicate: r.duplicate, creditsAdded: r.duplicate ? 0 : plan.creditsPerMonth };
    }
    case 'invoice.payment_failed': {
      const sub = subByStripe(subIdOf(event));
      if (!sub) return { ok: true, type, ignored: 'unknown subscription' };
      db.prepare(`UPDATE billing_subscriptions SET status = 'past_due', updated = ? WHERE id = ?`).run(now, sub.id);
      return { ok: true, type };
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = subByStripe(String(o.id ?? ''));
      if (!sub) return { ok: true, type, ignored: 'unknown subscription' };
      const item = o.items?.data?.[0] ?? {};
      const status = type === 'customer.subscription.deleted' ? 'canceled' : STATUS[o.status] ?? 'active';
      db.prepare('UPDATE billing_subscriptions SET status = ?, cancel_at_period_end = ?, period_start = COALESCE(?, period_start), period_end = COALESCE(?, period_end), updated = ? WHERE id = ?')
        .run(status, o.cancel_at_period_end ? 1 : 0, secs(o.current_period_start ?? item.current_period_start), secs(o.current_period_end ?? item.current_period_end), now, sub.id);
      return { ok: true, type, status };
    }
    default:
      return { ok: true, type, ignored: 'not an event Studio acts on' };
  }
}

/** POST /api/billing/webhook: the signature, then this Studio's events only; everyone else's get 200 untouched. */
export function handleStripeWebhook(raw: Buffer | string, signature: string): Record<string, unknown> {
  verifyStripeSignature(raw, signature);
  let event: any;
  try { event = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); } catch { throw new StudioError('The body is not JSON', 400); }
  const sid = studioOfEvent(event);
  if (!sid) return { ok: true, type: event?.type ?? 'unknown', ignored: "not this Studio's event" };
  return apply(event, sid);
}

/** What Settings shows: the plans, this Studio's plan, credits and whether payments are set up (never a key). */
export function billingView(sid?: string) {
  return { plans: listPlans(), subscription: currentSubscription(sid), credits: creditBalance(sid), ledger: creditLedger(20, sid), stripe: stripeStatus(), studio: scope(sid) };
}
