// A customer's cell as the control plane makes it (cellrun.ts cellEnv): only its owner's Google account claims it, its
// own host-only cookie, its data under its own prefix, its plan from the control plane (entitlements.ts) with pro
// features refused in the API (402 + what to upgrade to), Talk and agents only on the customer's own AI (ailink.ts),
// sealed at rest, and the sign-up's first game added on start (config.ts applyOnboardingSeed).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cell-'));
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_CLOUD = '1';
process.env.STUDIO_ORG = 'acme-1a2b';
process.env.STUDIO_SIGNUP = 'owner';
process.env.STUDIO_OWNER_SUB = '8000001';
process.env.STUDIO_COOKIE_NAME = 'hs_o_acme_1a2b';
process.env.STUDIO_COOKIE_HOST_ONLY = '1';
process.env.STUDIO_STATE_PREFIX = 'o/acme-1a2b/';
process.env.STUDIO_SECRETS_KEY = 'acme-secrets-key';
process.env.STUDIO_CELL_KEY = 'acme-cell-key';
process.env.HAWKESGEN_PROJECT_PREFIX = 'org_0123456789abcdef.';
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-JsOwnMaxPlanTokenNeverForCustomers';
delete process.env.STUDIO_PRODUCTS;
delete process.env.STUDIO_STATE_BUCKET;

// The control plane, standing in: it answers the cell's plan question when the key and org match.
let plan = { plan: 'free', status: null as string | null, maxGames: null as number | null };
const asked: string[] = [];
const cp = http.createServer((req, res) => {
  asked.push(`${req.method} ${req.url} ${req.headers['x-studio-cell']} ${req.headers.authorization}`);
  const ok = req.headers.authorization === 'Bearer acme-cell-key' && req.headers['x-studio-cell'] === 'acme-1a2b';
  res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(ok ? { org: 'acme-1a2b', ...plan, credits: 0 } : { error: 'cell key' }));
});
await new Promise<void>((r) => cp.listen(0, '127.0.0.1', () => r()));
process.env.STUDIO_CONTROL_URL = `http://127.0.0.1:${(cp.address() as any).port}`;
after(() => cp.close());

const A = await import('../src/auth.ts');
const E = await import('../src/entitlements.ts');
const CL = await import('../src/claude.ts');
const CFG = await import('../src/config.ts');
const H = await import('../src/cloudhost.ts');
const AI = await import('../src/ailink.ts');
const K = await import('../src/cellkeys.ts');

test('only the owner the control plane named claims the cell', () => {
  assert.throws(() => A.googleUser({ email: 'first@stranger.example', sub: '9999999' }), /no account here/, 'first to arrive is not enough');
  const owner = A.googleUser({ email: 'dev@acme.example', sub: '8000001', name: 'Acme Dev' });
  assert.equal(owner.role, 'admin');
});

test('its own cookie, for its host only, never J\'s; its data under its own prefix', () => {
  assert.equal(A.COOKIE, 'hs_o_acme_1a2b');
  const req: any = { headers: { 'x-forwarded-host': 'studio.hawkesgen.ai' } };
  const c = A.sessionCookie(req, 'tok', 1000);
  assert.match(c, /^hs_o_acme_1a2b=tok; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=1$/);
  assert.ok(!/Domain=/.test(c));
  assert.equal(H.statePrefix(), 'o/acme-1a2b/');
});

test('the free plan: pro features answer 402 with the plan to upgrade to; reading stays free', async () => {
  await E.refreshPlan();
  assert.ok(asked.some((a) => a.startsWith('GET /api/cells/self acme-1a2b Bearer acme-cell-key')));
  const e = await E.entitlements();
  assert.equal(e.plan, 'free');
  assert.equal(e.games, 1);
  assert.deepEqual(e.locked.sort(), ['agents', 'cloudBuilds', 'desktop', 'nightly', 'pm', 'talk']);
  for (const [route, feature, planId] of [['/api/changes', 'agents', 'studio_team'], ['/api/talk', 'talk', 'studio_team'], ['/api/pm/tick', 'pm', 'studio_team'], ['/api/cloud/daily', 'nightly', 'studio_indie']] as const) {
    const r = await E.upgradeRefusal(route, 'POST');
    assert.equal(r?.upgrade.feature, feature, route);
    assert.equal(r?.upgrade.plan, planId, route);
  }
  assert.equal(await E.upgradeRefusal('/api/changes', 'GET'), null, 'reading is free');
  await E.requireRoomForGame(0);
  await assert.rejects(E.requireRoomForGame(1), (err: any) => err.status === 402 && err.upgrade.feature === 'games');
  await assert.rejects(E.requireFeature('desktop'), (err: any) => err.status === 402);
  assert.ok(E.needsDesktop({ engine: 'web', build: { target: 'windows' } }));
});

test('a plan from the control plane opens its features; Talk and agents still wait for the customer\'s own AI', async () => {
  plan = { plan: 'studio_team', status: 'active', maxGames: 10 };
  await E.refreshPlan();
  assert.equal(await E.upgradeRefusal('/api/changes', 'POST'), null);
  assert.equal((await E.entitlements()).games, 10);
  assert.ok((await E.upgradeRefusal('/api/cells/x', 'POST')) === null);
  const no = await E.aiRefusal('/api/talk', 'POST');
  assert.equal(no?.connectAi, true);
  // The control plane away: the last answer stands.
  const url = process.env.STUDIO_CONTROL_URL;
  process.env.STUDIO_CONTROL_URL = 'http://127.0.0.1:9';
  await E.refreshPlan();
  assert.equal((await E.entitlements()).plan, 'studio_team');
  process.env.STUDIO_CONTROL_URL = url;
});

test('linking their AI: Claude the only provider; the key sealed on disk, shown as its last 4, used only for them', async () => {
  const links = (await AI.aiLinks())!;
  assert.deepEqual(links.providers.map((p) => p.id), ['claude']);
  assert.deepEqual(links.providers[0].methods.map((m) => m.id), ['subscription', 'api-key']);
  assert.equal(links.ready, false);
  const key = 'sk-ant-api03-AcmeOwnKey_abcdefghijklmnopqrstu';
  const r = CL.setCustomerKey(key);
  assert.deepEqual(r, { ready: true, via: 'api-key', keyTail: 'rstu' });
  const disk = fs.readFileSync(path.join(process.env.STUDIO_DATA!, 'claude', 'customer-key.json'), 'utf8');
  assert.ok(!disk.includes('AcmeOwnKey') && K.isSealed(JSON.parse(disk).key), 'ciphertext at rest');
  const env = CL.claudeEnv();
  assert.equal(env.ANTHROPIC_API_KEY, key);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined, "never J's plan");
  assert.equal(await E.aiRefusal('/api/talk', 'POST'), null);
  assert.equal((await AI.aiLinks())!.providers[0].keyTail, 'rstu');
});

test('the sign-up\'s first game is added on start, through onboarding\'s checks, and never again', async () => {
  fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'onboarding.json'), JSON.stringify({ game: { id: 'moon', name: 'Moon', engine: 'web', live: 'https://moon.example' } }));
  const g = await CFG.applyOnboardingSeed();
  assert.equal(g?.id, 'moon');
  assert.deepEqual(CFG.loadProducts().map((p) => p.id), ['moon']);
  assert.equal(fs.existsSync(path.join(process.env.STUDIO_DATA!, 'onboarding.json')), false);
  assert.equal(await CFG.applyOnboardingSeed(), null);
  // A J repository in the seed is refused like in onboarding.
  fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'onboarding.json'), JSON.stringify({ game: { id: 'theirs', name: 'X', engine: 'web', live: 'https://x.example', repo: 'jgriffith3433/sickofitgame-unity' } }));
  assert.equal(await CFG.applyOnboardingSeed(), null);
  assert.deepEqual(CFG.loadProducts().map((p) => p.id), ['moon']);
});

test("its Gen jobs are in its own Gen org's projects (its key works nowhere else)", async () => {
  const G = await import('../src/gen.ts');
  assert.equal(G.genProject('moon'), 'org_0123456789abcdef.moon');
  assert.equal(G.genProject('org_0123456789abcdef.moon'), 'org_0123456789abcdef.moon');
  const sent: any[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => { sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null }); return new Response('{"id":"j1"}', { headers: { 'Content-Type': 'application/json' } }); }) as typeof fetch;
  try {
    await G.gen.request('/jobs', { method: 'POST', body: { tool: 'playtest.run', project: 'moon', params: {} } });
    await G.gen.request('/entities?project=moon&kind=x');
  } finally { globalThis.fetch = real; }
  assert.equal(sent[0].body.project, 'org_0123456789abcdef.moon');
  assert.match(sent[1].url, /project=org_0123456789abcdef\.moon/);
});

test("a customer's game without `local` (as onboarding writes it) reads as served at its live address", async () => {
  fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'products.json'), JSON.stringify({ products: [{ id: 'jgame', name: 'JGame', engine: 'web', live: 'https://icanbe.ai', about: '', contract: false, playtests: [{ scenario: 'smoke', where: 'live' }], story: [] }] }));
  const p = CFG.loadProducts()[0];
  assert.deepEqual(p.local, { serve: 'remote', dir: '', port: 0, path: '/', url: 'https://icanbe.ai' });
  assert.equal(CFG.localUrl(p), 'https://icanbe.ai');
  assert.equal(p.repo, '');
  const { gitState } = await import('../src/local.ts');
  assert.deepEqual(gitState(p.repo), { branch: '', head: '', dirty: 0, ahead: 0, lastPush: '', files: [] }, 'no checkout to read');
});

test("Settings: a customer's Studio runs only on Claude, and the server's budgets and alerts aren't theirs", async () => {
  const S = await import('../src/settings.ts');
  await assert.rejects(S.saveSettings('brain', { harness: 'cursor' }, { by: 'dev@acme.example', conversation: null }), (e: any) => e.status === 403);
  await assert.rejects(S.saveSettings('costs', { monthlyBudget: 1 }, { by: 'dev@acme.example', conversation: null }), (e: any) => e.status === 403);
  await assert.rejects(S.saveSettings('resources', { memoryPct: 99 }, { by: 'dev@acme.example', conversation: null }), (e: any) => e.status === 403);
});
