// "Go live anyway" (J, 2026-11-01: "Add a bypass button for going live for projects that haven't playtested the current
// commit"): a go-live card whose only blocker is beta's commit not being playtested offers it in place of "Can't approve
// yet"; a person's tap, after a confirm step naming the commit, takes exactly that commit live, and who, when and which
// commit are recorded on the go live and shown in the release history. Talk, agents, the sandbox, walk-away and auto
// going live never can: they don't decide cards, deploy() without the card's own record still refuses an unplayed beta,
// and any other blocker still stops it. GitHub and the control plane are stand-ins, as in deploy-github.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { fakeGitHub, sha } from './fake-github.ts';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-golive-anyway-'));
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_CUSTOMER = '1';
process.env.STUDIO_PUBLIC_URL = 'https://studio.hawkesgen.ai/o/acme';
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9';
process.env.TALK_CLAUDE = 'no-such-claude-here';
process.env.TALK_FOLLOWUP_BATCH_MS = '600000';
delete process.env.STUDIO_PRODUCTS;
delete process.env.K_SERVICE;

const cp = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const b = JSON.parse(body || '{}');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url === '/api/cells/self/github-token') return res.end(JSON.stringify(String(b.repo).startsWith('acme/') ? { token: `ghs_${String(b.repo).split('/')[1]}`, expires: Date.now() + 3600_000 } : { token: null }));
  res.end('{}');
});
await new Promise<void>((r) => cp.listen(0, '127.0.0.1', () => r()));
test.after(() => cp.close());
process.env.STUDIO_CONTROL_URL = `http://127.0.0.1:${(cp.address() as any).port}`;
process.env.STUDIO_ORG = 'org_acme';
process.env.STUDIO_CELL_KEY = 'cell-key';
fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'agents.json'), JSON.stringify({ enabled: true }));
fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'pm.json'), JSON.stringify({ walkAway: true, walkAwayCards: true }));

const game = (id: string) => ({ id, name: id[0].toUpperCase() + id.slice(1), engine: 'web', repo: `acme/${id}`, about: '', contract: true, playtests: [], story: [] });
fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'products.json'), JSON.stringify({ products: [game('webby'), game('diverged')] }));

const gh = fakeGitHub({
  'acme/webby': { refs: { main: sha('1'), beta: sha('3') }, commits: { [sha('1')]: { parents: [], tree: 't1' }, [sha('2')]: { parents: [sha('1')], tree: 't2', title: 'Faster jumps' }, [sha('3')]: { parents: [sha('2')], tree: 't3', title: 'A new level' } } },
  // Live has a commit beta lacks: not only the playtest stops it.
  'acme/diverged': { refs: { main: sha('x'), beta: sha('y') }, commits: { [sha('w')]: { parents: [], tree: 'tw' }, [sha('x')]: { parents: [sha('w')], tree: 'tx', title: 'Hotfix on live' }, [sha('y')]: { parents: [sha('w')], tree: 'ty', title: 'New on beta' } } },
});
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => (new URL(String(input instanceof Request ? input.url : input)).host === 'api.github.com' ? gh.f(input, init) : realFetch(input, init))) as typeof fetch;
test.after(() => { globalThis.fetch = realFetch; });

const D = await import('../src/deploy.ts');
const ap = await import('../src/approvals.ts');
const { db } = await import('../src/db.ts');
const { getOp } = await import('../src/ops.ts');
const { guardRoute } = await import('../src/guards.ts');
const { setPolicy, autoGoLive } = await import('../src/golive-policy.ts');
await import('../src/builds.ts');

const req = (headers: Record<string, string> = {}) => ({ headers, socket: {} }) as any;
const jPage = () => req({ 'sec-fetch-site': 'same-origin', 'x-studio-click': '1' });
const token = (id: string) => ap.getApproval(id, true)!.token!;
const status = async (p: Promise<unknown>) => { try { await p; return 200; } catch (e: any) { return e.status ?? 500; } };
const webby = () => gh.repos['acme/webby'];
const S3 = sha('3').slice(0, 7);

async function opDone(approval: string) {
  for (let i = 0; i < 200; i++) {
    const row = db.prepare(`SELECT id FROM ops WHERE kind = 'golive' AND payload LIKE ?`).get(`%${approval}%`) as any;
    const op = row && getOp(row.id);
    if (op && (op.status === 'done' || op.status === 'failed')) return op;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the go live never finished');
}

test('a plan whose only blocker is the unplayed commit says so, and its card offers "Go live anyway" for that commit', async () => {
  const plan = await D.deployPlan('webby');
  assert.match(plan.blockers.join('\n'), /hasn't been playtested yet/);
  assert.equal(plan.playtestOnly, true);
  const a = await ap.requestApproval('deploy', 'webby', {}, { by: 'J' });
  assert.equal(a.status, 'pending', "walk-away doesn't approve a card with blockers, and a customer's go live is the owner's");
  assert.deepEqual(a.card.skip, { sha: sha('3'), short: S3, why: plan.blockers });
  const other = await D.deployPlan('diverged');
  assert.ok(other.blockers.length > 1 || !other.blockers.every(D.isPlaytestBlocker), 'live ahead of beta is a blocker of its own');
  assert.equal(other.playtestOnly, false);
  assert.equal((await ap.requestApproval('deploy', 'diverged')).card.skip, null);
});

test('only a person on the dashboard can go live anyway: not Talk, an agent, the API key, the sandbox or a plain call', async () => {
  const a = await ap.requestApproval('deploy', 'webby');
  const t = token(a.id);
  const callers: Record<string, string>[] = [
    { 'sec-fetch-site': 'same-origin', 'x-studio-click': '1', 'x-talk-conversation': 't_123456' },
    { 'sec-fetch-site': 'same-origin', 'x-studio-click': '1', 'x-studio-agent': 'c_123456789abc' },
    { 'sec-fetch-site': 'same-origin', 'x-studio-click': '1', authorization: 'Bearer hs_key' },
    { 'x-studio-click': '1' },
    {},
  ];
  for (const h of callers) assert.equal(await status(ap.decideApproval(a.id, t, 'anyway', req(h), { commit: S3 })), 403, JSON.stringify(h));
  assert.match(String(guardRoute(`/api/approvals/${a.id}/anyway`, 'POST', 't_123456') ?? ''), /J's tap/, 'the sandbox may never call it');
  assert.equal(ap.getApproval(a.id)!.status, 'pending');
  assert.equal(webby().refs.main, sha('1'), 'nothing moved');
});

test('the confirm step names the commit: without it, or with another commit, nothing goes live', async () => {
  const a = await ap.requestApproval('deploy', 'webby');
  assert.equal(await status(ap.decideApproval(a.id, token(a.id), 'anyway', jPage())), 409);
  assert.equal(await status(ap.decideApproval(a.id, token(a.id), 'anyway', jPage(), { commit: sha('2').slice(0, 7) })), 409);
  assert.equal(await status(ap.decideApproval(a.id, token(a.id), 'approve', jPage())), 409, 'plain Approve still can\'t');
  assert.equal(ap.getApproval(a.id)!.status, 'pending');
  assert.equal(webby().refs.main, sha('1'));
});

test("deploy() past an unplayed beta needs the card's own record: auto, Talk's typed words, walk-away or a forged id can't", async () => {
  await assert.rejects(D.deploy('webby', { confirm: 'DEPLOY webby', beta: sha('3') }), /hasn't been playtested/);
  await assert.rejects(D.deploy('webby', { confirm: 'DEPLOY webby', beta: sha('3'), approval: 'a_000000000000' }), /hasn't been playtested/);
  // A card walk-away (or anyone) claimed without a person's "Go live anyway" on it.
  db.prepare(`INSERT INTO approvals (id, kind, target, params, bind, token, card, status, decided_by, created, expires) VALUES ('a_walkaway001', 'deploy', 'webby', '{}', '[]', '', '{}', 'approving', 'Studio (walk-away)', ?, ?)`).run(Date.now(), Date.now() + 60_000);
  await assert.rejects(D.deploy('webby', { confirm: 'DEPLOY webby', beta: sha('3'), approval: 'a_walkaway001' }), /hasn't been playtested/);
  // A skip recorded for another commit isn't one for this one.
  db.prepare(`INSERT INTO approvals (id, kind, target, params, bind, token, card, status, decided_by, created, expires) VALUES ('a_othersha01', 'deploy', 'webby', ?, '[]', '', '{}', 'approving', 'J', ?, ?)`).run(JSON.stringify({ skipPlaytest: { by: 'J', at: 1, sha: sha('2'), why: [] } }), Date.now(), Date.now() + 60_000);
  await assert.rejects(D.deploy('webby', { confirm: 'DEPLOY webby', beta: sha('3'), approval: 'a_othersha01' }), /hasn't been playtested/);
  setPolicy('webby', 'auto', 'owner', 'keep going live');
  // Beta plays after merges here (the before-go-live play is golive-policy.test.ts's), so auto only waits.
  fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'agents.json'), JSON.stringify({ betaPlayWhen: 'merge' }));
  const auto = await autoGoLive('webby', 'test');
  fs.rmSync(path.join(process.env.STUDIO_DATA!, 'agents.json'), { force: true });
  assert.ok(!auto.went && /hasn't been playtested/.test(String(auto.waits)), 'auto still waits for a passing playtest');
  setPolicy('webby', 'ask', 'owner');
  assert.equal(webby().refs.main, sha('1'));
});

test('"Go live anyway" past another blocker is refused', async () => {
  const a = await ap.requestApproval('deploy', 'diverged');
  assert.equal(await status(ap.decideApproval(a.id, token(a.id), 'anyway', jPage(), { commit: sha('y').slice(0, 7) })), 409);
  assert.equal(gh.repos['acme/diverged'].refs.main, sha('x'));
});

test('a card stopped only by live having commits beta lacks offers "Bring beta up to date": one tap merges live into beta, nothing goes live', async () => {
  const a = await ap.requestApproval('deploy', 'diverged');
  assert.equal(ap.getApproval(a.id, true)!.card.catchUp, true);
  const mainBefore = gh.repos['acme/diverged'].refs.main;
  const betaBefore = gh.repos['acme/diverged'].refs.beta;
  // Talk, an agent or a plain call can't tap it either.
  assert.equal(await status(ap.decideApproval(a.id, token(a.id), 'catchup', req())), 403);
  const done = await ap.decideApproval(a.id, token(a.id), 'catchup', jPage());
  assert.equal(done.status, 'stale');
  for (let i = 0; i < 200 && gh.repos['acme/diverged'].refs.beta === betaBefore; i++) await new Promise((r) => setTimeout(r, 25));
  assert.notEqual(gh.repos['acme/diverged'].refs.beta, betaBefore, 'beta took main\'s commits');
  assert.equal(gh.repos['acme/diverged'].refs.main, mainBefore, 'nothing went live');
  // A card that can go live has no such button.
  const w = await ap.requestApproval('deploy', 'webby');
  assert.ok(!ap.getApproval(w.id, true)!.card.catchUp);
});

test("a person's confirmed tap takes exactly that commit live, records who skipped the playtest, and the history shows it", async () => {
  const a = await ap.requestApproval('deploy', 'webby');
  const r = await ap.decideApproval(a.id, token(a.id), 'anyway', jPage(), { commit: S3 });
  assert.equal(r.status, 'approving');
  assert.deepEqual({ ...r.params.skipPlaytest, at: 0 }, { by: 'J', at: 0, sha: sha('3'), why: a.card.blockers });
  const op = await opDone(a.id);
  assert.equal(op.status, 'done', op.error ?? '');
  assert.equal(op.result.skippedPlaytest.by, 'J');
  assert.equal(webby().refs.main, sha('3'), 'main is the commit the person confirmed');
  assert.equal(ap.getApproval(a.id)!.status, 'approved');
  const d: any = db.prepare(`SELECT * FROM deploys WHERE product = 'webby' AND kind = 'deploy' ORDER BY at DESC`).get();
  assert.equal(d.after, sha('3'));
  assert.deepEqual({ ...JSON.parse(d.skipped_playtest), at: 0 }, { by: 'J', at: 0, sha: sha('3'), why: a.card.blockers, approval: a.id });
  const plan = await D.deployPlan('webby');
  assert.equal(plan.previous[0].skippedPlaytest!.sha, sha('3'));
  assert.equal(plan.previous[0].skippedPlaytest!.approval, a.id);
  const page: any = {};
  vm.runInNewContext(fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'golive.js'), 'utf8'), page);
  const h = page.GoLiveHistory.html(plan.previous);
  assert.match(h, /Release history/);
  assert.match(h, new RegExp(`without a playtest of ${S3} \\(J,`));
  assert.equal(page.GoLiveHistory.html([]), '');
});

// The card on the page (dashboard/approval.js), without a DOM.
const page: any = vm.runInNewContext(`${fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'approval.js'), 'utf8')}\napprovals`, {
  esc: (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
  ago: () => '1 min ago',
});
const deployCard = (skip: any, blockers = ["beta hasn't been playtested yet"]) => ({
  id: 'a_1', kind: 'deploy', target: 'webby', status: 'pending', created: 1, expires: Date.now() + 600_000, token: 'tok', requested_by: 'J', decided_by: null, decided_at: null, result: null, dismissed: null,
  card: { title: 'Go live with Webby?', lines: [], blockers, warnings: [], links: [], approve: 'Approve: go live', deny: 'Deny', skip },
});

test('the page: "Go live anyway" in place of "Can\'t approve yet", its confirm step names the commit, other blockers stay as before', () => {
  const skip = { sha: sha('3'), short: S3, why: ["beta hasn't been playtested yet"] };
  const h = page.html(deployCard(skip));
  assert.match(h, /data-apanyway[^>]*>Go live anyway</);
  assert.doesNotMatch(h, /Can't approve yet|data-apdecide="anyway"/, 'one tap only opens the confirm step');
  assert.match(h, /Not playtested yet:/);
  assert.match(h, /data-apgolive[^>]*>Playtest it on the Go live page</, 'the playtest button stays beside it');
  const c = page.html(deployCard(skip), { confirm: true });
  assert.match(c, /Go live without a playtest\?/);
  assert.match(c, new RegExp(`Commit ${S3} hasn't passed a playtest`));
  assert.match(c, /health check and rollback after it work as usual/);
  assert.match(c, new RegExp(`data-apdecide="anyway" data-commit="${S3}">Yes, go live without a playtest<`));
  assert.match(c, /data-apcancel>Cancel</);
  const blocked = page.html(deployCard(null, ['Nothing to go live']));
  assert.match(blocked, /disabled>Can't approve yet</);
  assert.doesNotMatch(blocked, /data-apanyway/);
});
