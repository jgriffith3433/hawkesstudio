// Studio subscriptions (billing.ts), against a local Stripe stand-in (STRIPE_API_BASE) and webhooks signed the way
// Stripe signs them: Checkout tagged product=studio with this Studio's id, credits once per paid invoice, past due,
// cancel and resume at the period's end, the billing portal, and every other event on the shared account (the
// portal's, Gen's, another Studio's) answered without acting.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-billing-'));
process.env.STUDIO_MAIL = 'off';
delete process.env.STUDIO_ORG;
const WHSEC = 'whsec_test_studio_endpoint';
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'stripe.json'), JSON.stringify({ secretKey: 'sk_test_studio', webhookSecret: WHSEC }));

// The stand-in: records each call (path, form) and answers like Stripe.
const calls: { method: string; path: string; form: URLSearchParams; auth: string }[] = [];
const stand = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  calls.push({ method: req.method!, path: req.url!, form: new URLSearchParams(body), auth: String(req.headers.authorization ?? '') });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url === '/v1/checkout/sessions') return res.end(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.test/cs_test_1' }));
  if (req.url === '/v1/billing_portal/sessions') return res.end(JSON.stringify({ id: 'bps_1', url: 'https://billing.stripe.test/p/1' }));
  if (req.url?.startsWith('/v1/subscriptions/')) return res.end(JSON.stringify({ id: req.url.split('/').pop() }));
  res.end('{}');
});
await new Promise<void>((r) => stand.listen(0, '127.0.0.1', () => r()));
process.env.STRIPE_API_BASE = `http://127.0.0.1:${(stand.address() as any).port}`;
after(() => stand.close());

const B = await import('../src/billing.ts');

const sign = (body: string, secret = WHSEC, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const deliver = (event: unknown, secret = WHSEC) => {
  const body = JSON.stringify(event);
  return B.handleStripeWebhook(Buffer.from(body), sign(body, secret));
};
const ME = () => ({ product: 'studio', studio_id: B.studioId(), plan_id: 'studio_indie', user_id: 'u_owner' });

test('plans: the provisional defaults, J changes a price', () => {
  assert.deepEqual(B.listPlans().map((p) => [p.id, p.priceCents, p.creditsPerMonth, p.maxGames]), [['studio_indie', 2900, 1500, 3], ['studio_team', 9900, 5000, 10], ['studio_studio', 29900, 15000, 30]]);
  assert.equal(B.savePlan({ id: 'studio_team', priceCents: 8900 }).priceCents, 8900);
  assert.throws(() => B.savePlan({ id: 'studio_team', priceCents: -1 }), /whole number/);
  B.savePlan({ id: 'studio_team', priceCents: 9900 });
  assert.match(B.studioId(), /^st_[0-9a-f]{16}$/);
  assert.equal(B.studioId(), B.studioId(), 'made once');
  assert.deepEqual(B.stripeStatus(), { configured: true, webhook: true, mode: 'test', publishableKey: null });
});

test('checkout: subscription mode, tagged studio with this Studio\'s id on the session and the subscription', async () => {
  const r = await B.checkout('studio_indie', { id: 'u_owner', email: 'dev@indie.example' }, 'https://studio-beta.hawkesgen.ai');
  assert.equal(r.url, 'https://checkout.stripe.test/cs_test_1');
  const c = calls.find((x) => x.path === '/v1/checkout/sessions')!;
  assert.equal(c.auth, 'Bearer sk_test_studio');
  const f = c.form;
  assert.equal(f.get('mode'), 'subscription');
  for (const pre of ['metadata', 'subscription_data[metadata]']) {
    assert.equal(f.get(`${pre}[product]`), 'studio');
    assert.equal(f.get(`${pre}[studio_id]`), B.studioId());
    assert.equal(f.get(`${pre}[plan_id]`), 'studio_indie');
  }
  assert.equal(f.get('customer_email'), 'dev@indie.example');
  assert.equal(f.get('line_items[0][price_data][unit_amount]'), '2900');
  assert.equal(f.get('line_items[0][price_data][recurring][interval]'), 'month');
  assert.equal(f.get('success_url'), 'https://studio-beta.hawkesgen.ai/?checkout=success#settings');
  await assert.rejects(B.checkout('nope', { id: 'u', email: 'a@b.c' }, 'https://x'), /Unknown plan/);
});

test('the webhook: bad signatures are refused; other products\' and other Studios\' events get 200 untouched', () => {
  const body = JSON.stringify({ type: 'invoice.paid', data: { object: {} } });
  assert.throws(() => B.handleStripeWebhook(body, sign(body, 'whsec_someone_else')), /Invalid Stripe webhook signature/);
  assert.throws(() => B.handleStripeWebhook(body, ''), /malformed/);
  assert.throws(() => B.handleStripeWebhook(body, sign(body, WHSEC, Math.floor(Date.now() / 1000) - 3600)), /tolerance/);
  for (const product of ['gen', 'portal']) {
    const r = deliver({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: `sub_${product}`, customer: 'cus_x', metadata: { product, plan_id: 'studio_indie' } } } });
    assert.match(String(r.ignored), /not this Studio's/);
  }
  const other = deliver({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_other', customer: 'cus_other', metadata: { ...ME(), studio_id: 'st_0000000000000000' } } } });
  assert.match(String(other.ignored), /not this Studio's/);
  assert.match(String(deliver({ type: 'invoice.paid', data: { object: { id: 'in_untagged', subscription: 'sub_unknown', customer: 'cus_unknown' } } }).ignored), /not this Studio's/);
  assert.equal(B.currentSubscription(), null);
  assert.equal(B.creditBalance(), 0);
});

test('a paid month: the checkout records the plan, each paid invoice grants credits once', () => {
  deliver({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', metadata: ME() } } });
  const s = B.currentSubscription()!;
  assert.equal(s.planId, 'studio_indie');
  assert.equal(s.status, 'active');
  assert.equal(B.planGames(), 3);
  const invoice = (id: string) => ({ type: 'invoice.paid', data: { object: { id, customer: 'cus_1', parent: { subscription_details: { subscription: 'sub_1', metadata: ME() } }, lines: { data: [{ period: { start: 1_800_000_000, end: 1_802_600_000 } }] } } } });
  assert.equal(deliver(invoice('in_1')).creditsAdded, 1500);
  assert.equal(deliver(invoice('in_1')).duplicate, true, 'Stripe\'s retry grants nothing');
  assert.equal(B.creditBalance(), 1500);
  deliver(invoice('in_2'));
  assert.equal(B.creditBalance(), 3000);
  assert.equal(B.currentSubscription()!.periodEnd, 1_802_600_000 * 1000);
  // Untagged, but about a customer this Studio knows: it is ours.
  assert.ok(B.isStudioEvent({ type: 'charge.refunded', data: { object: { customer: 'cus_1' } } }));
});

test('a failed payment: past due, still the current plan', () => {
  deliver({ type: 'invoice.payment_failed', data: { object: { id: 'in_3', customer: 'cus_1', subscription: 'sub_1' } } });
  const s = B.currentSubscription()!;
  assert.equal(s.status, 'past_due');
  assert.equal(B.planGames(), 3);
  assert.equal(B.creditBalance(), 3000, 'credits already granted stay');
});

test('cancel and resume at the period\'s end, the billing portal, then Stripe ends it', async () => {
  assert.equal((await B.setCancelAtPeriodEnd(true))!.cancelAtPeriodEnd, true);
  const c = calls.filter((x) => x.path === '/v1/subscriptions/sub_1').pop()!;
  assert.equal(c.form.get('cancel_at_period_end'), 'true');
  assert.equal((await B.setCancelAtPeriodEnd(false))!.cancelAtPeriodEnd, false);
  const p = await B.billingPortal('https://studio-beta.hawkesgen.ai');
  assert.equal(p.url, 'https://billing.stripe.test/p/1');
  assert.equal(calls.filter((x) => x.path === '/v1/billing_portal/sessions').pop()!.form.get('customer'), 'cus_1');
  deliver({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active', cancel_at_period_end: true, metadata: ME(), items: { data: [{ current_period_end: 1_805_000_000 }] } } } });
  assert.equal(B.currentSubscription()!.cancelAtPeriodEnd, true);
  assert.equal(B.currentSubscription()!.status, 'active');
  await assert.rejects(B.checkout('studio_team', { id: 'u_owner', email: 'dev@indie.example' }, 'https://x'), /already has a plan/);
  deliver({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', status: 'canceled', metadata: ME() } } });
  assert.equal(B.currentSubscription(), null);
  assert.equal(B.planGames(), null);
  // A new checkout pays as the same Stripe customer.
  await B.checkout('studio_team', { id: 'u_owner', email: 'dev@indie.example' }, 'https://x');
  assert.equal(calls.filter((x) => x.path === '/v1/checkout/sessions').pop()!.form.get('customer'), 'cus_1');
});

test('without keys: payments are not set up (503), and an unsigned webhook is refused', async () => {
  fs.rmSync(path.join(process.env.STUDIO_DATA!, 'stripe.json'));
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  assert.equal(B.stripeStatus().configured, false);
  await assert.rejects(B.checkout('studio_indie', { id: 'u', email: 'a@b.c' }, 'https://x'), (e: any) => e.status === 503);
  assert.throws(() => B.handleStripeWebhook('{}', 't=1,v1=00'), (e: any) => e.status === 503);
  process.env.STRIPE_SECRET_KEY = 'sk_live_from_env';
  assert.equal(B.stripeStatus().mode, 'live', 'the environment is the fallback');
  delete process.env.STRIPE_SECRET_KEY;
});

test('the platform admin sets the keys: checked, kept in the data folder, never returned', async () => {
  const Bm = await import('../src/billing.ts');
  assert.throws(() => Bm.saveStripeConfig({ secretKey: 'not-a-key' }), /doesn't look like/);
  Bm.saveStripeConfig({ webhookSecret: 'whsec_kept1' });
  const st = Bm.saveStripeConfig({ secretKey: 'sk_test_newkey123', publishableKey: 'pk_test_abc', webhookSecret: '' });
  assert.deepEqual([st.configured, st.mode, st.webhook], [true, 'test', true], 'an empty webhook secret leaves the old one');
  assert.ok(!JSON.stringify(st).includes('sk_test_newkey123'));
  assert.equal(Bm.stripeKeys().secretKey, 'sk_test_newkey123');
  assert.equal(Bm.stripeKeys().webhookSecret, 'whsec_kept1');
  Bm.saveStripeConfig({ secretKey: 'sk_test_studio' });
});

test('credit packs: a payment-mode Checkout tagged studio with the pack; credits once per paid session, none before it is paid', async () => {
  assert.deepEqual(B.listPacks().map((p) => [p.id, p.priceCents, p.credits]), [['credits_1000', 1000, 1000], ['credits_2750', 2500, 2750], ['credits_12000', 10000, 12000]]);
  fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'stripe.json'), JSON.stringify({ secretKey: 'sk_test_studio', webhookSecret: WHSEC }));
  calls.length = 0;
  const r = await B.buyCredits('credits_2750', { id: 'u_owner', email: 'dev@indie.example' }, 'https://studio-beta.hawkesgen.ai');
  assert.equal(r.pack.credits, 2750);
  const f = calls.find((x) => x.path === '/v1/checkout/sessions')!.form;
  assert.equal(f.get('mode'), 'payment');
  for (const pre of ['metadata', 'payment_intent_data[metadata]']) {
    assert.equal(f.get(`${pre}[product]`), 'studio');
    assert.equal(f.get(`${pre}[studio_id]`), B.studioId());
    assert.equal(f.get(`${pre}[pack_id]`), 'credits_2750');
  }
  assert.equal(f.get('line_items[0][price_data][unit_amount]'), '2500');
  assert.equal(f.get('line_items[0][price_data][recurring][interval]'), null, 'a one-off payment');
  assert.equal(f.get('success_url'), 'https://studio-beta.hawkesgen.ai/?checkout=credits#settings');
  await assert.rejects(B.buyCredits('credits_free', { id: 'u', email: 'a@b.c' }, 'https://x'), /Unknown credit pack/);

  const before = B.creditBalance();
  const meta = { product: 'studio', studio_id: B.studioId(), pack_id: 'credits_2750', credits: '2750', user_id: 'u_owner' };
  // A delayed payment method: completed but not paid yet grants nothing; async_payment_succeeded does, once.
  let w = deliver({ type: 'checkout.session.completed', data: { object: { id: 'cs_pack_1', mode: 'payment', payment_status: 'unpaid', customer: 'cus_pack', metadata: meta } } });
  assert.match(String(w.ignored), /not paid yet/);
  assert.equal(B.creditBalance(), before);
  w = deliver({ type: 'checkout.session.async_payment_succeeded', data: { object: { id: 'cs_pack_1', mode: 'payment', payment_status: 'paid', customer: 'cus_pack', metadata: meta } } });
  assert.equal(w.creditsAdded, 2750);
  w = deliver({ type: 'checkout.session.completed', data: { object: { id: 'cs_pack_1', mode: 'payment', payment_status: 'paid', customer: 'cus_pack', metadata: meta } } });
  assert.equal(w.duplicate, true, 'once per payment, whichever event comes');
  assert.equal(B.creditBalance(), before + 2750);
  assert.equal(B.creditLedger(1)[0].kind, 'credit_pack');
  // Another Studio's pack, or a pack the metadata only claims: nothing.
  w = deliver({ type: 'checkout.session.completed', data: { object: { id: 'cs_pack_2', mode: 'payment', payment_status: 'paid', metadata: { ...meta, studio_id: 'st_someone_else' } } } });
  assert.match(String(w.ignored), /not this Studio's/);
  w = deliver({ type: 'checkout.session.completed', data: { object: { id: 'cs_pack_3', mode: 'payment', payment_status: 'paid', metadata: { ...meta, pack_id: 'credits_infinite', credits: '99999999' } } } });
  assert.match(String(w.ignored), /not a credit pack/);
  assert.equal(B.creditBalance(), before + 2750);
});

test('charging credits: refused with a clear message and nothing taken when short; once per ref', () => {
  const have = B.creditBalance();
  assert.throws(() => B.chargeCredits(have + 1, 'gen_work', 'too much', 'gen:test:big', undefined, 'unity.build'), (e: any) => {
    assert.equal(e.status, 402);
    assert.deepEqual(e.credits, { need: have + 1, have, topUp: true });
    assert.match(e.message, /^This studio is out of credits: unity\.build needs .+ Add credits or upgrade your plan in Settings → Plan and credits\.$/);
    return true;
  });
  assert.equal(B.creditBalance(), have);
  assert.equal(B.chargeCredits(10, 'gen_work', 'a playtest', 'gen:test:small').balance, have - 10);
  assert.equal(B.chargeCredits(10, 'gen_work', 'a playtest', 'gen:test:small').duplicate, true);
  assert.equal(B.creditBalance(), have - 10);
  assert.ok(B.billingView().packs.length === 3);
});
