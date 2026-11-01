// A customer's Studio paying for its Hawkes Gen work out of its one balance (credits.ts, through gen.ts): each job is
// priced by Gen, charged to the org's credits in the control plane before it is submitted, refused with a clear message
// (402, how many it needs and where to add more) when the balance is short, refunded when Gen hands back a job it already
// had or the job fails, and free on the customer's own AI. Gen refusing for lack of credits itself reads the same way.
// Stand-ins for Gen and for the control plane's credits routes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-credits-'));
process.env.STUDIO_MAIL = 'off';

const listen = async (h: http.RequestListener) => { const s = http.createServer(h); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); after(() => s.close()); return `http://127.0.0.1:${(s.address() as any).port}`; };
const body = async (req: http.IncomingMessage) => { let b = ''; for await (const c of req) b += c; return b ? JSON.parse(b) : {}; };
const json = (res: http.ServerResponse, status: number, j: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };

// Hawkes Gen: quotes, jobs (one already made, for reuse), job states, and its own refusal for a tool.
const submitted: any[] = [];
const jobState = new Map<string, string>();
let n = 0;
const GEN = await listen(async (req, res) => {
  const b = req.method === 'POST' ? await body(req) : {};
  if (req.url === '/v1/billing/quote') return json(res, 200, { tool: b.tool, credits: b.tool === 'unity.build' ? 100 : 6, project: b.project });
  if (req.url === '/v1/jobs' && req.method === 'POST') {
    const specs = Array.isArray(b.jobs) ? b.jobs : [b];
    if (specs.some((s: any) => s.tool === 'audio.music')) return json(res, 402, { error: 'Insufficient credits (need 20, have 3). Buy credits to run this generation.', kind: 'credits' });
    submitted.push(...specs);
    return json(res, 200, { jobs: specs.map((s: any) => (s.reuse ? { id: 'j_old', status: 'done', reused: true, created: 1 } : { id: `j_${++n}`, status: 'queued', created: Date.now(), project: s.project })) });
  }
  const m = /^\/v1\/jobs\/(j_\w+)$/.exec(String(req.url));
  if (m) return jobState.has(m[1]) ? json(res, 200, { id: m[1], status: jobState.get(m[1]) }) : json(res, 404, { error: 'No such job' });
  json(res, 404, { error: 'no stand-in' });
});

// The control plane's credits routes for this cell (cells.ts cellCredits), with a balance.
let balance = 250;
const charges = new Map<string, number>();
const refunds = new Map<string, number>();
const controlCalls: { what: string; body: any; auth: string; cell: string }[] = [];
const CONTROL = await listen(async (req, res) => {
  const b = await body(req);
  const what = String(req.url).split('/').pop()!;
  controlCalls.push({ what, body: b, auth: String(req.headers.authorization), cell: String(req.headers['x-studio-cell']) });
  if (what === 'charge') {
    if (charges.has(b.charge)) return json(res, 200, { ok: true, duplicate: true, credits: balance });
    if (balance < b.credits) return json(res, 402, { error: `This studio is out of credits: ${b.what ?? 'this'} needs ${b.credits} and ${balance} are left. Add credits or upgrade your plan in Settings → Plan and credits.`, credits: { need: b.credits, have: balance, topUp: true } });
    charges.set(b.charge, b.credits);
    balance -= b.credits;
    return json(res, 200, { ok: true, credits: balance });
  }
  const key = `${b.charge}:${b.part}`;
  if (refunds.has(key)) return json(res, 200, { ok: true, refunded: 0, credits: balance });
  refunds.set(key, b.credits);
  balance += b.credits;
  json(res, 200, { ok: true, refunded: b.credits, credits: balance });
});

process.env.HAWKESGEN_URL = GEN;
process.env.HAWKESGEN_KEY = 'hg_cell_test';
process.env.HAWKESGEN_PROJECT_PREFIX = 'org_0123456789abcdef.';
process.env.STUDIO_CONTROL_URL = CONTROL;
process.env.STUDIO_ORG = 'metered-cell-0001';
process.env.STUDIO_CELL_KEY = 'cell-key-test';

const { gen, genRun } = await import('../src/gen.ts');
const Cr = await import('../src/credits.ts');
const { db } = await import('../src/db.ts');

test('a Unity build is charged its 100 credits before it is submitted, with the cell\'s key; the job is watched for settling', async () => {
  assert.equal(Cr.meteringOn(), true);
  const job = await gen.submit('unity.build', { project: 'mygame', params: { repo: 'me/game' } });
  assert.equal(job.id, 'j_1');
  assert.equal(balance, 150);
  const c = controlCalls.find((x) => x.what === 'charge')!;
  assert.equal(c.body.credits, 100);
  assert.equal(c.auth, 'Bearer cell-key-test');
  assert.equal(c.cell, 'metered-cell-0001');
  assert.equal(submitted.at(-1).project, 'org_0123456789abcdef.mygame', 'still in the org\'s own projects');
  assert.equal((db.prepare('SELECT credits FROM gen_charges WHERE job = ?').get('j_1') as any).credits, 100);
});

test('short of credits: refused with how many it needs, how many are left and where to add more; nothing reaches Gen', async () => {
  balance = 50;
  const before = submitted.length;
  await assert.rejects(gen.submit('unity.build', { project: 'mygame', params: {} }), (e: any) => {
    assert.equal(e.status, 402);
    assert.deepEqual(e.credits, { need: 100, have: 50, topUp: true });
    assert.match(e.message, /out of credits: unity\.build needs 100 and 50 are left\. Add credits or upgrade your plan in Settings → Plan and credits/);
    return true;
  });
  assert.equal(submitted.length, before, 'not submitted');
  // genRun (builds, playtests, assets) gives up at once with the same message: no retries.
  await assert.rejects(genRun('unity.build', 'mygame', {}), /out of credits/);
  balance = 250;
});

test('reviews and Claude calls on the customer\'s own AI cost nothing; a job Gen already had is refunded at once', async () => {
  const charged = controlCalls.filter((x) => x.what === 'charge').length;
  await gen.submit('playtest.review', { project: 'mygame', params: {} });
  await gen.submit('llm.json', { project: 'mygame', params: {} });
  assert.equal(controlCalls.filter((x) => x.what === 'charge').length, charged, 'own AI: no charge');
  const b0 = balance;
  await gen.submit('image.generate', { project: 'mygame', params: { prompt: 'a cat' }, reuse: true });
  assert.equal(balance, b0, 'charged 6, then 6 back');
  assert.equal(controlCalls.at(-1)!.what, 'refund');
  assert.equal(controlCalls.at(-1)!.body.part, 'reused');
});

test('a batch is one charge; failed and cancelled jobs get their credits back once when settled', async () => {
  const b0 = balance;
  const jobs = await gen.submitMany([{ tool: 'image.generate', params: {} }, { tool: 'image.generate', params: {} }, { tool: 'unity.build', params: {} }].map((s) => ({ ...s, project: 'mygame' })));
  assert.equal(balance, b0 - 112);
  jobState.set(jobs[0].id, 'done');
  jobState.set(jobs[1].id, 'failed');
  jobState.set(jobs[2].id, 'running');
  jobState.set('j_1', 'cancelled');
  const r = await Cr.settleGenCharges((id) => gen.job(id));
  assert.deepEqual(r.refunded.sort(), [jobs[1].id, 'j_1'].sort());
  assert.equal(balance, b0 - 112 + 6 + 100);
  // Again: the running one is still watched, nothing is refunded twice.
  const again = await Cr.settleGenCharges((id) => gen.job(id));
  assert.equal(again.refunded.length, 0);
  jobState.set(jobs[2].id, 'failed');
  await Cr.settleGenCharges((id) => gen.job(id));
  assert.equal(balance, b0 - 6 + 100, "only the finished image is paid for; the first build (j_1, cancelled) came back too");
});

test('Gen refusing for lack of credits itself reads as a clear message with the way to add more', async () => {
  // Charged first by Studio, refused by Gen: refunded, and the refusal is told plainly.
  const b0 = balance;
  await assert.rejects(gen.submit('audio.music', { project: 'mygame', params: {} }), (e: any) => {
    assert.equal(e.status, 402);
    assert.equal(e.credits.topUp, true);
    assert.match(e.message, /^This studio is out of credits: this needs 20 and 3 are left\. Add credits or upgrade your plan in Settings → Plan and credits\.$/);
    return true;
  });
  assert.equal(balance, b0, 'what Studio charged came back');
  // Without Studio's charging (STUDIO_METER_GEN=0): the same message from Gen's own 402.
  process.env.STUDIO_METER_GEN = '0';
  try {
    await assert.rejects(gen.submit('audio.music', { project: 'mygame', params: {} }), /^Error: This studio is out of credits/);
  } finally { delete process.env.STUDIO_METER_GEN; }
  const other = Cr.genRefusal(Object.assign(new Error('Hawkes Gen /jobs: HTTP 500'), { status: 500 }));
  assert.equal(other.message, 'Hawkes Gen /jobs: HTTP 500', 'anything else unchanged');
});

// One bank, enforced by Gen (hawkesgen src/orgcredits.ts): a Gen that charges orgs itself is never charged again here.
test('when Gen charges the studio itself (health orgCredits), the cell charges nothing and passes Gen\'s 402 on', async () => {
  Cr.resetGenCharges();
  const calls: string[] = [];
  const raw = async (p: string, o: any = {}) => {
    calls.push(`${o.method ?? 'GET'} ${p}`);
    if (p === '/health') return { ok: true, orgCredits: true };
    if (p === '/jobs') return { jobs: [{ id: 'j_gen1', status: 'queued', created: Date.now(), labels: { orgCredits: 6 } }] };
    throw new Error(`unexpected ${p}`);
  };
  const before = controlCalls.length, bal = balance;
  const r = await Cr.meteredSubmit(raw, '/jobs', { method: 'POST', body: { tool: 'image.generate', project: 'org_0123456789abcdef.g', params: {} } });
  assert.equal(r.jobs[0].id, 'j_gen1');
  assert.equal(controlCalls.length, before, 'no charge or refund from the cell');
  assert.equal(balance, bal);
  assert.ok(!calls.some((c) => c.includes('/billing/quote')), 'not even a quote');
  // Cached: the next submit doesn't ask again.
  await Cr.meteredSubmit(raw, '/jobs', { method: 'POST', body: { tool: 'image.generate', project: 'org_0123456789abcdef.g', params: {} } });
  assert.equal(calls.filter((c) => c.endsWith('/health')).length, 1);
  // Gen's refusal in the control plane's words reads as CreditsNeeded with the numbers.
  const e = Cr.genRefusal(Object.assign(new Error('This studio is out of credits: unity.build needs 100 and 1,250 are left. Add credits or upgrade your plan in Settings → Plan and credits.'), { status: 402, kind: 'credits' }));
  assert.equal(e.status, 402);
  assert.deepEqual([e.credits.need, e.credits.have], [100, 1250]);
  assert.match(e.message, /^This studio is out of credits: unity\.build needs 100/);
  Cr.resetGenCharges();
});

test('STUDIO_GEN_CHARGES decides without asking; a job Gen says it charged is refunded here, so it is paid once', async () => {
  process.env.STUDIO_GEN_CHARGES = 'gen';
  let asked = 0;
  const r1 = await Cr.meteredSubmit(async (p: string) => { if (p === '/health') asked++; return { jobs: [{ id: 'j_x', status: 'queued', created: Date.now() }] }; }, '/jobs', { method: 'POST', body: { tool: 'image.generate', project: 'p', params: {} } });
  assert.equal(r1.jobs[0].id, 'j_x');
  assert.equal(asked, 0);
  // `studio`: the old path, even against a Gen that charged it too (an older health check, a mixed rollout).
  process.env.STUDIO_GEN_CHARGES = 'studio';
  const before = balance;
  const raw = async (p: string) => {
    if (p === '/billing/quote') return { credits: 6 };
    if (p === '/jobs') return { jobs: [{ id: 'j_both', status: 'queued', created: Date.now(), labels: { orgCredits: 6 } }] };
    throw Object.assign(new Error('no'), { status: 404 });
  };
  await Cr.meteredSubmit(raw, '/jobs', { method: 'POST', body: { tool: 'image.generate', project: 'p', params: {} } });
  const mine = controlCalls.filter((c) => c.what === 'charge').at(-1)!;
  const back = controlCalls.filter((c) => c.what === 'refund' && c.body.charge === mine.body.charge);
  assert.equal(back.length, 1);
  assert.equal(back[0].body.credits, 6);
  assert.equal(balance, before, 'charged and given back: Gen\'s charge is the only one');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM gen_charges WHERE job = ?').get('j_both') as any).n, 0, 'not watched for settling: Gen refunds it');
  delete process.env.STUDIO_GEN_CHARGES;
  Cr.resetGenCharges();
});

test("a job's end pushed by Gen (genevents.ts) is settled at once from the event, and a sweep beside it never refunds it twice", async () => {
  const b0 = balance;
  const [job] = await gen.submitMany([{ tool: 'image.generate', params: {}, project: 'mygame' }]);
  assert.equal(balance, b0 - 6);
  let push!: (type: string, data: any) => void;
  const asked: string[] = [];
  Cr.startCreditSettler(async (id) => { asked.push(id); return gen.job(id); }, 3600_000, { live: () => true, onEvent: (cb) => { push = cb; } });
  jobState.set(job.id, 'failed');
  push('job', { id: job.id, status: 'failed' });
  await Cr.settleGenCharges((id) => gen.job(id));
  assert.equal(balance, b0, 'given back once');
  assert.equal(controlCalls.filter((x) => x.what === 'refund' && x.body.part === job.id).length, 1);
  assert.deepEqual(asked, [], 'from the event itself: Gen not asked');
});
