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
const agents = await import('../src/agents.ts');
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

test('product changes merge into beta by themselves: no merge card for one, unless that is turned off', async () => {
  change('c_aaaaaaaaaa00');
  assert.equal(agents.agentSettings().autoMergeBeta, true);
  await assert.rejects(ap.requestApproval('merge', 'c_aaaaaaaaaa00'), /merge into beta by themselves/);
  db.prepare(`UPDATE changes SET auto_merge = ? WHERE id = ?`).run('failed: a merge conflict in a.json', 'c_aaaaaaaaaa00');
  await assert.rejects(ap.requestApproval('merge', 'c_aaaaaaaaaa00'), /a merge conflict in a\.json.*Changes tab/);
  agents.saveAgentSettings({ autoMergeBeta: false });
  assert.match((await ap.requestApproval('merge', 'c_aaaaaaaaaa00')).card.title, /into beta/);
});

test('a card goes stale when its target changes: a revised change, a setting changed meanwhile', async () => {
  // Merge cards for product changes are for when automatic merges into beta are off (the test above turned them off).
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

test('× closes a card in the chat without deciding it: still pending, still in the Inbox, still answerable; never from Talk', async () => {
  const conv = talk.startConversation('Dismiss');
  const q = pm.askJ('Rename the shop?', { product: 'aptest', options: ['Yes', 'No'] });
  const a = await ap.requestApproval('decision', q.id, {}, { by: 'Talk', conversation: conv.id });
  const t = token(a.id);
  const callers: Record<string, string>[] = [{ 'sec-fetch-site': 'same-origin', 'x-studio-click': '1', 'x-talk-conversation': conv.id }, { 'x-studio-click': '1' }, {}];
  for (const h of callers) {
    assert.throws(() => ap.dismissApproval(a.id, req(h)), (e: any) => e.status === 403, JSON.stringify(h));
  }
  assert.match(guardRoute(`/api/approvals/${a.id}/dismiss`, 'POST', conv.id)!, /J's tap/);
  const told = talk.getConversation(conv.id)!.messages.length;
  const d = ap.dismissApproval(a.id, jPage());
  assert.equal(d.status, 'pending', 'closing is not a deny');
  assert.ok(d.dismissed! > Date.now() - 5000);
  assert.equal(d.decided_by, null);
  assert.equal(rm.getQuestion(q.id)!.answer ?? null, null, 'nothing was answered');
  assert.equal(talk.getConversation(conv.id)!.messages.length, told, 'Talk isn\'t told');
  assert.ok(ap.listApprovals({ conversation: conv.id }).find((x) => x.id === a.id)!.dismissed, 'the chat knows it was closed');
  assert.ok((await ib.inbox({ tokens: true })).some((x) => x.id === `approval:${a.id}`), 'still in the Inbox');
  // J can still approve it from the Inbox, with the same token.
  assert.equal((await ap.decideApproval(a.id, t, 'approve', jPage())).status, 'approved');
});

test('a card whose action already happened leaves the Inbox: merged or closed by any path, live or rolled back since', async () => {
  agents.saveAgentSettings({ autoMergeBeta: false });
  change('c_aaaaaaaaaab1');
  change('c_aaaaaaaaaab2');
  const m = await ap.requestApproval('merge', 'c_aaaaaaaaaab1');
  const c = await ap.requestApproval('merge', 'c_aaaaaaaaaab2');
  assert.ok((await ib.inbox()).some((x) => x.id === `approval:${m.id}`), 'waiting while the change is ready');
  // Merged some other way (typed MERGE, the Changes tab, the PM, GitHub), and closed: the cards go.
  db.prepare(`UPDATE changes SET status = 'merged' WHERE id = ?`).run('c_aaaaaaaaaab1');
  db.prepare(`UPDATE changes SET status = 'closed' WHERE id = ?`).run('c_aaaaaaaaaab2');
  const items = await ib.inbox();
  assert.ok(!items.some((x) => x.id === `approval:${m.id}` || x.id === `approval:${c.id}`), 'gone from the Inbox');
  assert.ok(!items.some((x) => x.id === 'merge:c_aaaaaaaaaab1'), 'no merge item either');
  assert.deepEqual([ap.getApproval(m.id)!.status, ap.getApproval(m.id)!.result], ['stale', 'already merged']);
  assert.deepEqual([ap.getApproval(c.id)!.status, ap.getApproval(c.id)!.result], ['stale', 'closed']);
  assert.equal(await status(ap.decideApproval(m.id, 'x', 'approve', jPage())), 409, 'and can\'t be approved');
  // A go live (or rollback) since a deploy card was made settles it; an older go live doesn't.
  const now = Date.now();
  const ins = db.prepare(`INSERT INTO approvals (id, kind, target, params, bind, token, card, status, created, expires) VALUES (?, ?, 'aptest', '{}', 'b', 'tok', ?, 'pending', ?, ?)`);
  const cardJ = JSON.stringify({ title: 'Go live?', lines: [], blockers: [], warnings: [], links: [], approve: 'Approve', deny: 'Deny' });
  db.prepare(`INSERT INTO deploys (id, product, kind, repo, after, at) VALUES ('d_old', 'aptest', 'deploy', 'site', 'x', ?)`).run(now - 60_000);
  ins.run('a_deploy0001', 'deploy', cardJ, now - 30_000, now + 600_000);
  assert.equal(ap.getApproval('a_deploy0001')!.status, 'pending', 'an older go live leaves it');
  db.prepare(`INSERT INTO deploys (id, product, kind, repo, after, at) VALUES ('d_new', 'aptest', 'deploy', 'site', 'y', ?)`).run(now - 10_000);
  assert.deepEqual([ap.getApproval('a_deploy0001')!.status, ap.getApproval('a_deploy0001')!.result], ['stale', 'already live']);
  ins.run('a_rollbk0001', 'rollback', cardJ, now - 5_000, now + 600_000);
  db.prepare(`INSERT INTO deploys (id, product, kind, repo, after, at) VALUES ('d_rb', 'aptest', 'rollback', 'site', 'z', ?)`).run(now);
  assert.equal(ap.getApproval('a_rollbk0001')!.result, 'already rolled back');
  assert.ok(!(await ib.inbox()).some((x) => x.kind === 'approval' && ['a_deploy0001', 'a_rollbk0001'].includes(x.approval!.id)));
});

// The page's side (dashboard/approval.js), loaded the way the browser does, without a DOM.
const vm = await import('node:vm');
const page: any = vm.runInNewContext(`${fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'approval.js'), 'utf8')}\napprovals`, {
  esc: (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
  ago: () => '1 min ago',
});
const card = (id: string, status: string, patch: Record<string, unknown> = {}) => ({
  id, kind: 'merge', target: 'c_1', status, created: 1000, expires: Date.now() + 600_000, token: status === 'pending' ? 'tok' : undefined,
  requested_by: 'Talk', decided_by: status === 'pending' || status === 'expired' || status === 'stale' ? null : 'J', decided_at: 2000, result: null, dismissed: null,
  card: { title: 'Merge "Shop" into beta?', lines: ['Merges into beta.'], blockers: [], warnings: [], links: [], approve: 'Approve: merge into beta', deny: 'Deny' }, ...patch,
});

test('the page: approved, denied, expired and stale cards are one line without buttons; a waiting one has its buttons and × in the chat', () => {
  for (const [status, label] of [['approved', 'Approved'], ['denied', 'Denied'], ['expired', 'Expired'], ['stale', 'Out of date']]) {
    const h = page.html(card('a_1', status));
    assert.match(h, /ap-line/, status);
    assert.match(h, new RegExp(`${label}</span> <span class="ap-what">Merge &#34;Shop&#34; into beta</span>`), status);
    assert.doesNotMatch(h, /data-apdecide|data-apdismiss|<ul>/, `${status}: no buttons, no details`);
  }
  const p = page.html(card('a_1', 'pending'), { chat: true });
  assert.match(p, /data-apdecide="approve"/);
  assert.match(p, /data-apdecide="deny"/);
  assert.match(p, /data-apdismiss/);
  assert.match(p, /data-guide="off"/, 'the guide can\'t press it');
  assert.doesNotMatch(page.html(card('a_1', 'pending')), /data-apdismiss/, 'no × in the Inbox or the go-live dialog');
});

test('the page: cards sit in the chat where they were asked, one waiting card in full, closed ones hidden', () => {
  const messages = [{ at: 500 }, { at: 1500 }, { at: 2500 }, { at: 3500 }];
  const placed = page.place(messages, [
    card('a_old', 'pending', { created: 1000 }),
    card('a_done', 'approved', { created: 2000 }),
    card('a_new', 'pending', { created: 3000 }),
    card('a_shut', 'pending', { created: 3200, dismissed: 3300 }),
  ]);
  assert.deepEqual(placed.map((x: any) => x.after), [1, 2, 3], 'after the messages before each was asked; the closed one isn\'t shown');
  assert.match(placed[0].html, /ap-line/, 'an older waiting card is a line');
  assert.match(placed[0].html, /data-apshow/, 'that J can open');
  assert.match(placed[1].html, /ap-line/, 'a decided one is a line');
  assert.match(placed[2].html, /data-apdecide="approve"/, 'the newest waiting card is in full');
  assert.equal(placed.filter((x: any) => /data-apdecide/.test(x.html)).length, 1, 'never stacked');
});

test('during a call the chat, with its cards, stays on screen (only the input row gives way to the call pane)', () => {
  const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'style.css'), 'utf8');
  const inCall = css.split('\n').filter((l) => /body\.in-call/.test(l) && /display:\s*none/.test(l));
  assert.ok(inCall.length, 'the call rules are where this test looks');
  for (const l of inCall) assert.doesNotMatch(l, /talk-log|\.approval|talk-main/, l);
});
