// The Inbox (inbox.ts) on a scratch database: questions merge by subject and by wording, what it shows and in which
// order, answers route where they always went (the agent's question with the decision passing it on, GPU budgets,
// milestones), "yes" takes the recommendation, and who answered is recorded: the PM is never "J".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-inbox-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.TALK_CLAUDE = 'no-such-claude-here';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'ibtest', name: 'Inbox test', framing: 'test', engine: 'static', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: 'site', port: 8796, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
}] }));

const { db } = await import('../src/db.ts');
await import('../src/agents.ts');
const talk = await import('../src/talk.ts');
const rm = await import('../src/roadmap.ts');
const pm = await import('../src/pm.ts');
const ib = await import('../src/inbox.ts');

const change = (id: string, patch: Record<string, unknown> = {}) => {
  const c = { id, product: 'ibtest', findings: '[]', status: 'ready', title: `Change ${id}`, created: Date.now() - 3600_000, request: 'J asked for it', verify: JSON.stringify({ outcome: 'passed', verdict: 'ship', preview: 'https://ibtest.example/c/1/', video: 'a_vid' }), pr: 7, pr_url: 'https://github.com/x/y/pull/7', ...patch };
  const cols = Object.keys(c);
  db.prepare(`INSERT INTO changes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(c) as any[]);
};
const fakeReq = (headers: Record<string, string> = {}) => ({ headers, socket: {} }) as any;

test('the same question on the same subject, or in nearly the same words, is one question', () => {
  const a = pm.askJ('Should I start fixes for Sick Of It Level 3 death?', { product: 'ibtest', options: ['yes', 'no'], recommend: 'yes' });
  const b = pm.askJ('Should I start the fixes for the Level 3 death in Sick Of It?', { product: 'ibtest', options: ['yes', 'not now'] });
  assert.equal(a.id, b.id, 'reworded: merged');
  const q = rm.getQuestion(a.id)!;
  assert.equal(q.asks, 2);
  assert.deepEqual(q.options, ['yes', 'not now'], 'the newest options win');
  assert.equal(q.recommendation, 'yes', 'a repeat without a recommendation keeps it');
  const other = pm.askJ('Which palette for the shop: green or gold?', { product: 'ibtest' });
  assert.notEqual(other.id, a.id);
  // On one subject: one open question per topic, whatever the words.
  const it = rm.addItem({ product: 'ibtest', title: 'Shop', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'Make the shop' });
  const x = pm.askJ('It failed 3 times. Try again?', { subject: t.id, product: 'ibtest' });
  const y = pm.askJ('Still failing after 3 tries: what now?', { subject: t.id, product: 'ibtest' });
  assert.equal(x.id, y.id);
  const g = pm.askJ('Approve a GPU budget?', { subject: t.id, product: 'ibtest', topic: 'gpu' });
  assert.notEqual(g.id, x.id, 'a GPU budget on the same task is its own question');
  for (const id of [a.id, other.id, x.id, g.id]) rm.setQuestion(id, { status: 'resolved' });
});

test('the inbox shows what blocks most first; answering a forwarded agent question resumes it', async () => {
  // An agent asked on J's own request; the PM passed it on to J.
  change('c_aaaaaaaaaaaa', { status: 'needs answer', title: 'Shop screen' });
  const agentQ = rm.addQuestion({ kind: 'agent', subject: 'c_aaaaaaaaaaaa', product: 'ibtest', text: 'Coins or gems?', askedBy: 'agent c_aaaaaaaaaaaa' });
  rm.setQuestion(agentQ.id, { status: 'asked J' });
  const dec = pm.askJ('An agent working on "Shop screen" asks: Coins or gems?', { subject: 'c_aaaaaaaaaaaa', product: 'ibtest', forwards: agentQ.id, topic: 'agent question', recommend: 'Coins', options: ['Coins', 'Gems'] });
  const low = pm.askJ('Rename the product line page?', { product: 'ibtest' });
  const items = await ib.inbox();
  const ids = items.map((x) => x.id);
  assert.ok(ids.includes(dec.id) && !ids.includes(agentQ.id), 'one card: the decision passing the agent question on');
  assert.ok(ids.indexOf(dec.id) < ids.indexOf(low.id), 'a paused agent comes before a question that blocks nothing');
  const card = items.find((x) => x.id === dec.id)!;
  assert.match(card.blocks, /\(paused\)/);
  assert.equal(card.recommendation, 'Coins');
  assert.ok(card.links.some((l) => l.label === 'Preview') && card.links.some((l) => l.video === 'a_vid') && card.links.some((l) => /Pull request/.test(l.label)));
  // "yes" takes the recommendation; the agent's question is answered with it; J is recorded as the one who answered.
  // (The change is moved on first, so no real agent resumes in a test.)
  db.prepare(`UPDATE changes SET status = 'working' WHERE id = 'c_aaaaaaaaaaaa'`).run();
  await ib.answerInbox(dec.id, 'yes', 'J');
  assert.match(rm.getQuestion(dec.id)!.answer!, /^Coins/);
  assert.equal(rm.getQuestion(agentQ.id)!.status, 'answered');
  assert.equal(rm.getQuestion(agentQ.id)!.answered_by, 'J');
  assert.ok(!(await ib.inbox()).some((x) => x.id === dec.id), 'the card goes');
  assert.ok(ib.recentAnswers().some((a) => a.id === dec.id && a.by === 'J'));
  rm.setQuestion(low.id, { status: 'resolved' });
});

test('the PM answering is labelled as the PM, and the decided event says so', async () => {
  const q = pm.askJ('Keep the old intro video?', { product: 'ibtest', options: ['keep', 'drop'] });
  await pm.answerQuestion(q.id, 'keep', 'Talk (PM)');
  assert.equal(rm.getQuestion(q.id)!.answered_by, 'Talk (PM)');
  const log = rm.listDecisions({ action: 'answer', limit: 1 })[0];
  assert.match(log.detail!, /^Talk \(PM\) answered/);
  assert.doesNotMatch(log.detail!, /J decided/);
});

test('who acts: J on the dashboard, never the PM conversation, Talk only as J in a turn J started', async () => {
  assert.equal(await ib.actor(fakeReq()), 'J');
  const c = talk.startConversation('Studio PM: test');
  try { db.exec('ALTER TABLE conversations ADD COLUMN kind TEXT'); } catch { /* already there */ }
  db.prepare(`UPDATE conversations SET kind = 'pm' WHERE id = ?`).run(c.id);
  assert.equal(await ib.actor(fakeReq({ 'x-talk-conversation': c.id }), 'J (via Claude)'), 'Talk (PM)', 'the PM claiming to be J is still the PM');
  const t = talk.startConversation('Chat');
  assert.equal(await ib.actor(fakeReq({ 'x-talk-conversation': t.id }), 'J'), 'Talk', 'no turn of J\'s running: not J');
  assert.equal(await ib.actor(fakeReq({ 'x-talk-conversation': t.id }), 'Talk (PM)'), 'Talk (PM)');
});

test('GPU budgets: a card per waiting task, J only, approving clears it', async () => {
  const it = rm.addItem({ product: 'ibtest', title: 'Stage', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'Make the stage', gpu: [{ tool: 'image.edit', count: 10 }] });
  db.prepare('UPDATE tasks SET gpu = ? WHERE id = ?').run(JSON.stringify({ items: t.gpu!.items, estimate: { gpuHours: 0.5, cost: 1, withIdleTail: 2, servers: 1, wallMinutes: 30, at: Date.now() } }), t.id);
  const card = (await ib.inbox()).find((x) => x.subject === t.id && x.kind === 'gpu')!;
  assert.equal(card.id, `gpu:${t.id}`);
  assert.equal(card.recommendation, 'Approve $1.25');
  await assert.rejects(ib.answerInbox(card.id, 'Approve $1.25', 'Talk (PM)'), /J's call/);
  await ib.answerInbox(card.id, card.recommendation!, 'J (via Talk)');
  assert.equal(rm.getTask(t.id)!.gpu!.budget, 1.25);
  assert.equal(rm.getTask(t.id)!.gpu!.approvedBy, 'J (via Talk)');
  assert.ok(!(await ib.inbox()).some((x) => x.subject === t.id));
  // Filed as a question too (the PM asks once): answering the question approves it; an open one goes when it's approved.
  const t2 = rm.addTask({ item: it.id, request: 'Paint the sky', gpu: [{ tool: 'image.edit', count: 2 }] });
  db.prepare('UPDATE tasks SET gpu = ? WHERE id = ?').run(JSON.stringify({ items: t2.gpu!.items, estimate: { gpuHours: 0.1, cost: 2, withIdleTail: 3, servers: 1, wallMinutes: 5, at: Date.now() } }), t2.id);
  const q = pm.askJ('Approve a budget?', { subject: t2.id, product: 'ibtest', topic: 'gpu', recommend: 'Approve $2.50', options: ['Approve $2.50', 'Not now'] });
  assert.equal((await ib.inbox()).find((x) => x.subject === t2.id)!.id, q.id, 'the card is the question');
  await ib.answerInbox(q.id, 'not now', 'J');
  assert.equal(rm.getTask(t2.id)!.status, 'idea', 'not now parks the task');
});

test('changes only J may merge, and milestones reached', async () => {
  change('c_bbbbbbbbbbbb', { title: 'Better jump' });
  const m = (await ib.inbox()).find((x) => x.id === 'merge:c_bbbbbbbbbbbb')!;
  assert.ok(m, 'J\'s own request, ready: his to merge');
  assert.equal(m.recommendation, 'Merge into beta');
  await assert.rejects(ib.answerInbox(m.id, 'Merge into beta', 'Talk (PM)'), /J's call/);
  db.prepare(`UPDATE changes SET status = 'merged' WHERE id = 'c_bbbbbbbbbbbb'`).run();

  const it = rm.addItem({ product: 'ibtest', title: 'Controls', status: 'planned' });
  const ms = rm.addMilestone({ product: 'ibtest', title: 'Controls done', items: [it.id] });
  rm.markReached(ms.id);
  const card = (await ib.inbox()).find((x) => x.id === `milestone:${ms.id}`)!;
  assert.ok(card.links.some((l) => l.url === '#ready'));
  const go = await ib.answerInbox(card.id, 'Go live', 'J');
  assert.equal((go as any).next, 'deploy', 'going live stays the deploy plan and DEPLOY');
  await ib.answerInbox(card.id, 'Something is wrong: the dash button sticks', 'J');
  assert.ok(!(await ib.inbox()).some((x) => x.id === card.id));
  assert.ok(rm.commentsOn(ms.id).some((c) => /dash button sticks/.test(c.text) && c.by === 'J'));
  await assert.rejects(ib.answerInbox('milestone:n_000000000000', 'Later', 'J'), /No milestone/);
});
