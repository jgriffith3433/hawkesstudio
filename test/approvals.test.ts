// Approve / Deny cards (approvals.ts) on a scratch database: only J's own dashboard page decides one (never the sandbox,
// Talk's or an agent's headers, the MCP key, or a call that isn't the page), the token is one-time and belongs to its
// card, a card expires, goes stale when its target changes, deny closes it and tells the conversation, and the Inbox
// shows it but can't answer it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-approvals-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.TALK_CLAUDE = 'no-such-claude-here';
process.env.TALK_FOLLOWUP_BATCH_MS = '600000';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'aptest', name: 'Approval test', framing: 'test', engine: 'static', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: 'site', port: 8797, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
}] }));

const { db } = await import('../src/db.ts');
await import('../src/agents.ts');
const talk = await import('../src/talk.ts');
const pm = await import('../src/pm.ts');
const rm = await import('../src/roadmap.ts');
const ap = await import('../src/approvals.ts');
const ib = await import('../src/inbox.ts');
const { guardRoute } = await import('../src/guards.ts');
const { saveSettings, callSettings } = await import('../src/settings.ts');

const req = (headers: Record<string, string> = {}) => ({ headers, socket: {} }) as any;
/** J's dashboard page: what the browser and approval.js send. */
const jPage = () => req({ 'sec-fetch-site': 'same-origin', 'x-studio-click': '1' });
const token = (id: string) => ap.getApproval(id, true)!.token!;
const status = async (p: Promise<unknown>) => { try { await p; return 200; } catch (e: any) { return e.status ?? 500; } };

const change = (id: string, patch: Record<string, unknown> = {}) => {
  const c = { id, product: 'aptest', findings: '[]', status: 'ready', title: `Change ${id}`, created: Date.now(), request: 'J asked for it', verify: JSON.stringify({ outcome: 'passed', verdict: 'ship', sha: 'aaaaaaa1' }), pr: 7, pr_url: 'https://github.com/x/y/pull/7', ...patch };
  const cols = Object.keys(c);
  db.prepare(`INSERT INTO changes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(c) as any[]);
};

test('only J\'s own page decides a card: not the sandbox, Talk, an agent, the MCP key or a plain call', async () => {
  const q = pm.askJ('Start the shop rework?', { product: 'aptest', options: ['Yes', 'Not now'], recommend: 'Yes' });
  const a = await ap.requestApproval('decision', q.id, {}, { by: 'Talk', conversation: null });
  const t = token(a.id);
  const callers: Record<string, string>[] = [
    { 'sec-fetch-site': 'same-origin', 'x-studio-click': '1', 'x-talk-conversation': 't_123456' },
    { 'sec-fetch-site': 'same-origin', 'x-studio-click': '1', 'x-studio-agent': 'c_123456789abc' },
    { 'sec-fetch-site': 'same-origin', 'x-studio-click': '1', authorization: 'Bearer hs_key' },
    { 'x-studio-click': '1' },
    { 'sec-fetch-site': 'same-origin' },
    {},
  ];
  for (const h of callers) {
    assert.equal(await status(ap.decideApproval(a.id, t, 'approve', req(h))), 403, JSON.stringify(h));
    assert.equal(await status(ap.decideApproval(a.id, t, 'deny', req(h))), 403, JSON.stringify(h));
  }
  assert.equal(ap.getApproval(a.id)!.status, 'pending', 'nothing decided it');
  // The sandbox's own requests to decide are refused before they reach the handler; asking for one is fine.
  assert.match(guardRoute(`/api/approvals/${a.id}/approve`, 'POST', 't_123456')!, /J's tap/);
  assert.match(guardRoute(`/api/approvals/${a.id}/deny`, 'POST', null)!, /J's tap/);
  assert.equal(guardRoute('/api/approvals', 'POST', 't_123456'), null);
  // The token is only for J's page.
  assert.equal(ap.getApproval(a.id)!.token, undefined);
  assert.ok(ap.listApprovals({ pending: true }).every((x) => x.token === undefined));
  assert.equal(ap.notJClick(jPage()), null);
  // J's tap: answered with the recommendation, recorded as J with the time, one time only.
  const done = await ap.decideApproval(a.id, t, 'approve', jPage());
  assert.equal(done.status, 'approved');
  assert.equal(done.decided_by, 'J');
  assert.ok(done.decided_at! > Date.now() - 5000);
  assert.equal(rm.getQuestion(q.id)!.answer, 'Yes');
  assert.equal(await status(ap.decideApproval(a.id, t, 'approve', jPage())), 409, 'a used card can\'t be approved again');
});

test('the token belongs to its card, and a wrong one is refused', async () => {
  const q1 = pm.askJ('Use gold for the shop?', { product: 'aptest', options: ['Yes', 'No'] });
  const q2 = pm.askJ('Delete the old levels?', { product: 'aptest', options: ['Yes', 'No'] });
  const a1 = await ap.requestApproval('decision', q1.id);
  const a2 = await ap.requestApproval('decision', q2.id);
  assert.notEqual(a1.id, a2.id);
  assert.equal(await status(ap.decideApproval(a2.id, token(a1.id), 'approve', jPage())), 403, 'card 1\'s token on card 2');
  assert.equal(await status(ap.decideApproval(a2.id, '', 'approve', jPage())), 403);
  assert.equal(await status(ap.decideApproval(a2.id, 'f'.repeat(36), 'approve', jPage())), 403);
  assert.equal(ap.getApproval(a2.id)!.status, 'pending');
  // Asking again for the same thing gives the same card.
  assert.equal((await ap.requestApproval('decision', q1.id)).id, a1.id);
});

test('a card expires after 15 minutes', async () => {
  const q = pm.askJ('Park the boss fight?', { product: 'aptest', options: ['Yes', 'No'] });
  const a = await ap.requestApproval('decision', q.id);
  const t = token(a.id);
  assert.ok(a.expires - a.created >= 14 * 60_000 && a.expires - a.created <= 16 * 60_000);
  db.prepare('UPDATE approvals SET expires = ? WHERE id = ?').run(Date.now() - 1, a.id);
  assert.equal(await status(ap.decideApproval(a.id, t, 'approve', jPage())), 410);
  assert.equal(ap.getApproval(a.id)!.status, 'expired');
  assert.equal(rm.getQuestion(q.id)!.status === 'open' || rm.getQuestion(q.id)!.status === 'asked J', true, 'nothing was answered');
});

test('a card goes stale when its target changes: a revised change, a setting changed meanwhile', async () => {
  change('c_aaaaaaaaaaa1');
  const a = await ap.requestApproval('merge', 'c_aaaaaaaaaaa1');
  assert.match(a.card.title, /Merge "Change c_aaaaaaaaaaa1" into beta/);
  const t = token(a.id);
  // The agent pushed again: a different verified commit is not what the card showed.
  db.prepare('UPDATE changes SET verify = ? WHERE id = ?').run(JSON.stringify({ outcome: 'passed', verdict: 'ship', sha: 'bbbbbbb2' }), 'c_aaaaaaaaaaa1');
  assert.equal(await status(ap.decideApproval(a.id, t, 'approve', jPage())), 409);
  assert.equal(ap.getApproval(a.id)!.status, 'stale');
  // A newer card replaces an older one for the same target.
  const b = await ap.requestApproval('merge', 'c_aaaaaaaaaaa1');
  assert.notEqual(b.id, a.id);
  const c = await ap.requestApproval('settings', 'call', { patch: { rate: 1.2 } });
  assert.equal(ap.getApproval(b.id)!.status, 'pending', 'a card on another target stays');
  await saveSettings('call', { rate: 0.9 }, { conversation: null, by: 'J' });
  assert.equal(await status(ap.decideApproval(c.id, token(c.id), 'approve', jPage())), 409);
  assert.equal(callSettings().rate, 0.9, 'the stale card changed nothing');
  // A fresh card for the same patch applies it.
  const d = await ap.requestApproval('settings', 'call', { patch: { rate: 1.2 } });
  assert.equal((await ap.decideApproval(d.id, token(d.id), 'approve', jPage())).status, 'approved');
  assert.equal(callSettings().rate, 1.2);
  // Blockers show on the card, and approving is refused while there are any.
  change('c_aaaaaaaaaaa2', { status: 'working' });
  const e = await ap.requestApproval('merge', 'c_aaaaaaaaaaa2');
  assert.match(e.card.blockers.join(' '), /working, not ready/);
  assert.equal(await status(ap.decideApproval(e.id, token(e.id), 'approve', jPage())), 409);
});

test('a change that was not playtested: plain information on its merge card, no blocker or warning', async () => {
  change('c_aaaaaaaaaaa3', { verify: JSON.stringify({ sha: 'ccccccc3', preview: null }) });
  const a = await ap.requestApproval('merge', 'c_aaaaaaaaaaa3');
  assert.deepEqual([a.card.blockers, a.card.warnings], [[], []]);
  assert.match(a.card.lines.join(' '), /Not playtested/);
});

test('deny closes the card and tells the conversation; the Inbox shows cards but can\'t answer them', async () => {
  const conv = talk.startConversation('Approvals');
  const q = pm.askJ('Raise the shop prices?', { product: 'aptest', options: ['Yes', 'No'] });
  const a = await ap.requestApproval('decision', q.id, {}, { by: 'Talk', conversation: conv.id });
  const items = await ib.inbox({ tokens: true });
  const card = items.find((x) => x.id === `approval:${a.id}`)!;
  assert.ok(card, 'in the Inbox');
  assert.equal(card.approval!.token, token(a.id), 'J\'s page gets the token');
  assert.equal((await ib.inbox()).find((x) => x.id === `approval:${a.id}`)!.approval!.token, undefined, 'others don\'t');
  assert.equal(await status(ib.answerInbox(`approval:${a.id}`, 'yes', 'J')), 403);
  assert.ok(ap.listApprovals({ conversation: conv.id }).some((x) => x.id === a.id), 'in the conversation');
  const d = await ap.decideApproval(a.id, token(a.id), 'deny', jPage());
  assert.equal(d.status, 'denied');
  assert.equal(d.decided_by, 'J');
  assert.equal(rm.getQuestion(q.id)!.answer, 'No');
  assert.ok(talk.getConversation(conv.id)!.messages.some((m) => m.notice && /J denied/.test(m.text)), 'Talk is told');
  assert.ok(!(await ib.inbox()).some((x) => x.id === `approval:${a.id}`), 'gone from the Inbox');
  assert.ok(ib.recentAnswers().some((x) => x.id === a.id && x.by === 'J'), 'in "answered lately"');
});
