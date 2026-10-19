// Walk-away mode's decisions (J, 2026-10-18: "Make it so the system is able to make decisions on it's own"): the PM
// decides a criteria miss on beta itself (try again, park, or ONE investigation when several tasks miss the same way),
// the questions already in J's Inbox are taken over, GPU budgets are approved within a daily cap (the rest is one
// digest card), and merge cards that can't be approved settle at once. Off: as before. Scratch database, no GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-walkaway-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.TALK_CLAUDE = 'no-such-claude-here';
for (const k of ['STUDIO_SERVER', 'NTFY_TOPIC']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'notify.json'), JSON.stringify({ enabled: false, server: 'http://127.0.0.1:9', topic: 'test' }));
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ repos: { site: 'x/site' }, products: [{
  id: 'watest', name: 'Walk test', framing: 'test', engine: 'static', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: 'site', port: 8797, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
}] }));

const { db, J } = await import('../src/db.ts');
const rm = await import('../src/roadmap.ts');
const pm = await import('../src/pm.ts');
const ib = await import('../src/inbox.ts');
const ap = await import('../src/approvals.ts');
await import('../src/agents.ts');

const it = rm.addItem({ product: 'watest', title: 'Levels', status: 'planned' });
/** A task merged into beta (as if its change merged), with its criteria and tries used. */
const mergedTask = (title: string, criteria: string[], tries = 1) => {
  const t = rm.addTask({ item: it.id, request: title, title, criteria });
  return rm.setTask(t.id, { status: 'merged', tries, merged_at: Date.now() - 3600_000 });
};
const checks = (run: string) => ({ where: 'beta' as const, at: Date.now(), run, verdict: 'ship' });
const no = (criterion: string) => ({ criterion, met: 'no' as const, evidence: 'not seen' });
const investigationsOf = () => db.prepare(`SELECT id, status, title FROM changes WHERE product = 'watest' AND title LIKE 'Investigate%'`).all() as any[];

test('walk-away is on by default and in the PM settings', () => {
  assert.equal(pm.pmSettings().walkAway, true);
  assert.equal(pm.pmSettings().walkAwayGpuPerDay, 25);
});

test('a task missing its criteria on beta: the PM tries again (no question for J), and parks it after its tries', async () => {
  const before = rm.listQuestions().length;
  const t = mergedTask('Door opens', ['The door opens']);
  assert.equal(await pm.decideMiss(t, checks('r_wa0000000001'), [no('The door opens')]), 'retry');
  assert.equal(rm.getTask(t.id)!.status, 'planned', 'it starts again (a try)');
  assert.equal(rm.listQuestions().length, before, 'nothing asked');
  const d = rm.listDecisions({ action: 'retry' }).find((x) => x.subject === t.id)!;
  assert.ok(d.undo, 'with undo');
  // Undo puts it back as it was.
  await pm.undoDecision(d.id);
  assert.equal(rm.getTask(t.id)!.status, 'merged');
  // Out of tries: first a scout's investigation and a fresh round (pm-moving.test.ts), still no question.
  pm.rescueDeps.scout = async () => 'x_wa0000000001';
  const u = mergedTask('Lamp lights', ['The lamp lights'], pm.pmSettings().maxTries);
  assert.equal(await pm.decideMiss(u, checks('r_wa0000000002'), [no('The lamp lights')]), 'rescue');
  assert.equal(rm.getTask(u.id)!.status, 'failed');
  assert.equal(rm.listQuestions().length, before);
  // That round used up too: parked as an idea with a note, and J asked (in his Inbox).
  rm.setTask(u.id, { status: 'merged' });
  assert.equal(await pm.decideMiss(rm.getTask(u.id)!, checks('r_wa0000000002'), [no('The lamp lights')]), 'park');
  assert.equal(rm.getTask(u.id)!.status, 'idea');
  assert.match(rm.getTask(u.id)!.note ?? '', /parked by the PM/);
  assert.equal(rm.listQuestions().filter((q) => q.subject === u.id && q.status === 'asked J').length, 1);
});

test('several tasks missing on the same beta run: ONE investigation, the tasks held until it is done', async () => {
  const a = mergedTask('Boss appears', ['The boss appears']);
  const b = mergedTask('Boss music', ['Boss music plays']);
  const results = [no('The boss appears'), no('Boss music plays')];
  assert.equal(await pm.decideMiss(a, checks('r_wa0000000003'), results), 'investigate');
  assert.equal(await pm.decideMiss(rm.getTask(b.id)!, checks('r_wa0000000003'), results), 'held');
  const inv = investigationsOf();
  assert.equal(inv.length, 1, 'one investigation');
  for (const t of [a, b]) {
    assert.equal(rm.getTask(t.id)!.status, 'failed');
    assert.equal(pm.heldFor(t.id)?.change, inv[0].id);
  }
  assert.ok(rm.listDecisions({ action: 'investigate' }).some((d) => d.subject === a.id));
  // Not done yet: still held. Closed: each task decided on its own (try again).
  assert.deepEqual(await pm.releaseInvestigations(), []);
  db.prepare(`UPDATE changes SET status = 'closed' WHERE id = ?`).run(inv[0].id);
  assert.deepEqual(await pm.releaseInvestigations(), [inv[0].id]);
  assert.equal(rm.getTask(a.id)!.status, 'planned');
  assert.equal(rm.getTask(b.id)!.status, 'planned');
  assert.equal(pm.heldFor(a.id), null);
});

test("the \"misses criteria\" questions already in J's Inbox are taken over: held under the change already fixing beta", async () => {
  // Like Sick Of It's: a change already fixing beta's stale build data, and two questions from before walk-away.
  db.prepare(`INSERT INTO changes (id, product, findings, status, title, request, created) VALUES ('c_wafix0000001', 'watest', '[]', 'working', 'Fix stale build data on beta', 'Beta builds use stale data', ?)`).run(Date.now());
  const qs = ['Jump pad', 'Spring'].map((title) => {
    const t = mergedTask(title, [`${title} works`]);
    rm.setTask(t.id, { status: 'failed', note: `on beta: ${title} works (no: not seen)` });
    return pm.askJ(`"${title}" (Walk test) is merged into beta but misses criteria there (try 1 of 3): ${title} works. Try again on top of beta, change the criteria, or drop it?`, { subject: t.id, product: 'watest', options: ['try again', 'change the criteria', 'drop it'] });
  });
  const settled = await pm.settleMissQuestions();
  assert.deepEqual(settled.sort(), qs.map((q) => q.id).sort());
  for (const q of qs) {
    assert.equal(rm.getQuestion(q.id)!.status, 'resolved');
    assert.equal(pm.heldFor(q.subject!)?.change, 'c_wafix0000001');
  }
  assert.ok(!(await ib.inbox()).some((x) => qs.some((q) => q.id === x.id)), 'gone from the Inbox');
  db.prepare(`UPDATE changes SET status = 'closed' WHERE id = 'c_wafix0000001'`).run();
  await pm.releaseInvestigations();
});

test('GPU budgets: Studio approves within the daily cap; above it, one digest card for J', async () => {
  const priced = (cost: number) => {
    const t = rm.addTask({ item: it.id, request: `Paint ${cost}`, gpu: [{ tool: 'image.edit', count: 2 }] });
    db.prepare('UPDATE tasks SET gpu = ? WHERE id = ?').run(J({ items: t.gpu!.items, estimate: { gpuHours: 0.2, cost, withIdleTail: cost + 1, servers: 1, wallMinutes: 10, at: Date.now() } }), t.id);
    return t.id;
  };
  const under = async () => ({ spent: 10, budget: 150, over: false });
  const wa = { walkAway: true, walkAwayGpuPerDay: 3 };
  // The Inbox reads the cap from the settings: only what passes it is J's (a digest within the caps is never filed).
  pm.savePmSettings({ walkAwayGpuPerDay: 3 });
  const a = priced(1);
  assert.equal((await rm.autoApproveGpu(a, { spend: under, tell: false, walkAway: wa }))!.gpu!.budget, 1.25);
  assert.equal(rm.gpuAutoApprovedToday(), 1.25);
  const b = priced(1.5);
  const c = priced(2);
  assert.equal(await rm.autoApproveGpu(b, { spend: under, tell: false, walkAway: wa }), null, '$1.88 more would pass $3 a day');
  assert.ok(rm.listDecisions({ action: 'gpu ask' }).some((d) => d.subject === b && /\$3\/day/.test(d.detail ?? '')));
  const cards = (await ib.inbox()).filter((x) => x.kind === 'gpu');
  assert.equal(cards.length, 1, 'one digest card, not one per task');
  assert.equal(cards[0].id, 'gpu:digest');
  await assert.rejects(ib.answerInbox('gpu:digest', 'Approve all', 'Talk (PM)'), /J's call/);
  await ib.answerInbox('gpu:digest', cards[0].recommendation!, 'J');
  assert.equal(rm.getTask(b)!.gpu!.budget, 1.88);
  assert.equal(rm.getTask(c)!.gpu!.budget, 2.5);
  assert.ok(!(await ib.inbox()).some((x) => x.kind === 'gpu'));
  // Within the caps (a $0.50 task, room left today at $25 a day): Studio's, no digest card.
  pm.savePmSettings({ walkAwayGpuPerDay: 25 });
  const d = priced(0.5);
  assert.ok(!(await ib.inbox()).some((x) => x.kind === 'gpu'), 'a digest within the caps is never filed');
  assert.equal((await rm.autoApproveGpu(d, { spend: under, tell: false }))!.gpu!.budget, 0.63);
});

test("merge cards that can't be approved settle at once (walk-away); off, they stay as before", async () => {
  const card = (id: string, target: string) => db.prepare(`INSERT INTO approvals (id, kind, target, params, bind, token, card, status, created, expires) VALUES (?, 'merge', ?, '{}', '[]', 't', ?, 'pending', ?, ?)`)
    .run(id, target, J({ title: 'Merge?', lines: [], blockers: [], warnings: [], links: [], approve: 'Approve', deny: 'Deny' }), Date.now(), Date.now() + 600_000);
  db.prepare(`INSERT INTO changes (id, product, findings, status, title, created) VALUES ('c_warev0000001', 'watest', '[]', 'revising', 'Being revised', ?)`).run(Date.now());
  pm.savePmSettings({ walkAway: false });
  try {
    card('a_waoff0000001', 'c_warev0000001');
    assert.equal(ap.getApproval('a_waoff0000001')!.status, 'pending', 'off: as before');
  } finally {
    pm.savePmSettings({ walkAway: true });
  }
  const a = ap.getApproval('a_waoff0000001')!;
  assert.equal(a.status, 'stale');
  assert.match(a.result ?? '', /revising now, not ready to merge/);
});
