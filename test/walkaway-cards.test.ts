// Walk-away mode's cards approve themselves (approvals.ts selfApprove, walkaway.ts walkAwayCards; J, 2026-11-01: "Make
// it so all cards auto approve when in walk away mode"): as "Studio (walk-away)", recorded in the card, the Inbox's
// history and the PM log; GPU budgets only within the walk-away caps; cost-raising settings and protected-file merges
// still wait; nothing when walk-away (or walkAwayCards) is off; in a customer's Studio going live stays the owner's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-walkcards-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.TALK_CLAUDE = 'no-such-claude-here';
process.env.TALK_FOLLOWUP_BATCH_MS = '600000';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'wctest', name: 'Walk cards test', framing: 'test', engine: 'static', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: 'site', port: 8797, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
}] }));
const PM_FILE = path.join(process.env.STUDIO_DATA, 'pm.json');
const pmFile = (j: Record<string, unknown>) => fs.writeFileSync(PM_FILE, JSON.stringify(j));

const { db } = await import('../src/db.ts');
const pm = await import('../src/pm.ts');
const rm = await import('../src/roadmap.ts');
const ap = await import('../src/approvals.ts');
const W = await import('../src/walkaway.ts');
const ib = await import('../src/inbox.ts');
const { callSettings } = await import('../src/settings.ts');

const log = (id: string) => rm.listDecisions({ action: 'walk-away approve' }).filter((d) => d.subject === id);

test("J's Studio: walk-away and its cards are on by default", () => {
  pmFile({});
  assert.equal(W.walkAwaySettings().walkAwayCards, true);
  assert.equal(W.walkAwayCardsOn(), true);
});

test('a decision card approves itself, as Studio (walk-away), with a line in the PM log and the Inbox history', async () => {
  pmFile({});
  const q = pm.askJ('Start the shop rework?', { product: 'wctest', options: ['Yes', 'Not now'], recommend: 'Yes' });
  const a = await ap.requestApproval('decision', q.id, {}, { by: 'Talk', conversation: null });
  assert.equal(a.status, 'approved');
  assert.equal(a.decided_by, W.WALK_AWAY_BY);
  assert.equal(rm.getQuestion(q.id)!.status === 'open', false, 'the question was answered');
  assert.equal(log(q.id).length, 1);
  assert.match(log(q.id)[0].detail!, /Approved by walk-away: Start the shop rework\?/);
  const decided = (db.prepare('SELECT decided_by FROM approvals WHERE id = ?').get(a.id) as any).decided_by;
  assert.equal(decided, 'Studio (walk-away)');
  assert.equal(ap.listApprovals({ pending: true }).some((x) => x.id === a.id), false, 'not waiting in the Inbox');
  assert.equal((await ib.inbox()).some((x: any) => JSON.stringify(x).includes(a.id)), false);
  const hist = ib.recentAnswers().find((x: any) => x.id === a.id);
  assert.equal(hist?.by, 'Studio (walk-away)', "the Inbox's answered list says who approved it");
  assert.match(String(hist?.answer), /^approved/);
});

test('a settings card that raises nothing approves itself; one that raises costs waits for J', async () => {
  pmFile({});
  const before = callSettings().rate;
  const s = await ap.requestApproval('settings', 'call', { patch: { rate: before === 1.2 ? 1.1 : 1.2 } });
  assert.equal(s.status, 'approved');
  assert.notEqual(callSettings().rate, before);
  const r = await ap.requestApproval('settings', 'agents', { patch: { maxConcurrent: 50 } });
  assert.equal(r.status, 'pending');
  assert.match((await ap.walkAwayHold(r))!, /raises costs.*maxConcurrent/);
  assert.equal(log('agents').length, 0);
});

test('a GPU budget card approves itself only within the walk-away caps', async () => {
  // J's per-task limit is costs.gpuAutoApprove (default $5): a $20 budget waits.
  pmFile({});
  const it = rm.addItem({ product: 'wctest', title: 'Stage', status: 'planned' });
  const big = rm.addTask({ item: it.id, request: 'Make the stage', gpu: [{ tool: 'image.edit', count: 40 }] });
  db.prepare('UPDATE tasks SET gpu = ? WHERE id = ?').run(JSON.stringify({ items: big.gpu!.items, estimate: { gpuHours: 8, cost: 16, withIdleTail: 18, servers: 1, wallMinutes: 240, at: Date.now() } }), big.id);
  const a = await ap.requestApproval('gpu', big.id);
  assert.equal(a.status, 'pending');
  assert.match((await ap.walkAwayHold(a))!, /over the \$\d+ a task/);
  // Under the per-task limit but past the day's cap: waits too.
  const small = rm.addTask({ item: it.id, request: 'Make a prop', gpu: [{ tool: 'image.edit', count: 2 }] });
  db.prepare('UPDATE tasks SET gpu = ? WHERE id = ?').run(JSON.stringify({ items: small.gpu!.items, estimate: { gpuHours: 1, cost: 2, withIdleTail: 2.5, servers: 1, wallMinutes: 30, at: Date.now() } }), small.id);
  pmFile({ walkAwayGpuPerDay: 1 });
  const b = await ap.requestApproval('gpu', small.id);
  assert.equal(b.status, 'pending');
  assert.match((await ap.walkAwayHold(b))!, /a day/);
  // Room in the day: the waiting card approves itself on the PM's sweep.
  pmFile({ walkAwayGpuPerDay: 25 });
  const done = await ap.selfApproveWaiting();
  assert.ok(done.includes(b.id));
  assert.equal(ap.getApproval(b.id)!.status, 'approved');
  assert.equal(rm.getTask(small.id)!.gpu!.approvedBy, W.WALK_AWAY_BY);
  assert.equal(ap.getApproval(a.id)!.status, 'pending', 'the big one still waits');
});

test('with walk-away off, or its cards off, every card waits for a tap; turning them on approves the waiting ones', async () => {
  pmFile({ walkAway: false });
  const q1 = pm.askJ('Rename the shop?', { product: 'wctest', options: ['Yes', 'No'] });
  const a1 = await ap.requestApproval('decision', q1.id);
  assert.equal(a1.status, 'pending');
  assert.equal(await ap.walkAwayHold(a1), 'walk-away mode is off');
  assert.deepEqual(await ap.selfApproveWaiting(), []);
  pmFile({ walkAwayCards: false });
  const q2 = pm.askJ('Recolour the shop?', { product: 'wctest', options: ['Yes', 'No'] });
  const a2 = await ap.requestApproval('decision', q2.id);
  assert.equal(a2.status, 'pending');
  pmFile({});
  const done = await ap.selfApproveWaiting();
  assert.ok(done.includes(a1.id) && done.includes(a2.id));
  assert.equal(ap.getApproval(a1.id)!.decided_by, W.WALK_AWAY_BY);
});

test("a customer's Studio: off until the owner turns it on; going live and rolling back stay the owner's", async () => {
  process.env.STUDIO_CUSTOMER = '1';
  try {
    pmFile({});
    assert.equal(W.walkAwayCardsOn(), false, 'walk-away is off in a customer Studio by default');
    pmFile({ walkAway: true });
    const fake = (kind: string) => ({ id: 'a_x', kind, target: 'wctest', params: {}, status: 'pending', card: { title: '', lines: [], blockers: [], warnings: [], links: [], approve: 'Approve', deny: 'Deny' } }) as any;
    assert.match((await ap.walkAwayHold(fake('deploy')))!, /owner's/);
    assert.match((await ap.walkAwayHold(fake('rollback')))!, /owner's/);
    assert.equal(await ap.walkAwayHold(fake('decision')), null);
    // GPU: their own per-task cap, 0 at first: every budget waits.
    const it = rm.addItem({ product: 'wctest', title: 'Shop', status: 'planned' });
    const t = rm.addTask({ item: it.id, request: 'Make a sign', gpu: [{ tool: 'image.edit', count: 1 }] });
    db.prepare('UPDATE tasks SET gpu = ? WHERE id = ?').run(JSON.stringify({ items: t.gpu!.items, estimate: { gpuHours: 0.1, cost: 0.2, withIdleTail: 0.3, servers: 1, wallMinutes: 5, at: Date.now() } }), t.id);
    assert.match((await ap.walkAwayHold({ ...fake('gpu'), target: t.id }))!, /over the \$0 a task/);
  } finally {
    delete process.env.STUDIO_CUSTOMER;
  }
});
