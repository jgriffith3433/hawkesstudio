// The Analytics tab's server side (src/analytics.ts): only Gen's analytics read routes and their filters go through to
// Hawkes Gen, the overview gets a studio-wide total and says which products have no data yet, and Gen's failures come
// back as plain errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-analytics-'));
const { genPath, withTotals, hasData, handleAnalyticsApi } = await import('../src/analytics.ts');

const P = (s: string) => new URLSearchParams(s);

test('the routes map to Gen\'s analytics read routes, and nothing else does', () => {
  assert.equal(genPath('/api/analytics/overview', P('')), '/analytics/overview');
  assert.equal(genPath('/api/analytics/products', P('range=7d')), '/analytics/products');
  assert.equal(genPath('/api/analytics/sickofit', P('range=7d')), '/analytics/sickofit?range=7d');
  assert.equal(genPath('/api/analytics/sickofit/levels', P('')), '/analytics/sickofit/levels');
  assert.equal(genPath('/api/analytics/sickofit/sessions/list', P('limit=50&offset=10')), '/analytics/sickofit/sessions/list?limit=50&offset=10');
  assert.equal(genPath('/api/analytics/sickofit/sessions/s_k2j3h4g5f6d7', P('range=7d')), '/analytics/sickofit/sessions/s_k2j3h4g5f6d7');
  for (const bad of ['/api/analytics/', '/api/analytics/sickofit/nope', '/api/analytics/Sick..Of/levels', '/api/analytics/sickofit/sessions/x', '/api/analytics/sickofit/levels/more', '/api/analytics/../jobs', '/api/analytics/overview/x', '/api/jobs']) {
    assert.equal(genPath(bad, P('')), null, bad);
  }
});

test('only the filters Gen takes are passed on, each checked', () => {
  const q = genPath('/api/analytics/sickofit', P('range=90d&env=live,beta&build=1.4.2&device=phone&browser=Chrome&country=US&bots=1&internal=1&key=hg_secret&steps=x'))!;
  const p = new URLSearchParams(q.split('?')[1]);
  assert.deepEqual(Object.fromEntries(p), { range: '90d', env: 'live,beta', build: '1.4.2', device: 'phone', browser: 'Chrome', country: 'US', bots: '1', internal: '1' });
  // Wrong values are dropped (Gen's defaults apply): a made-up range, an unknown env, bots=yes.
  assert.equal(genPath('/api/analytics/sickofit', P('range=forever&env=prod&bots=yes')), '/analytics/sickofit');
  assert.equal(genPath('/api/analytics/sickofit', P('env=all&from=2026-10-01&to=2026-10-18')), '/analytics/sickofit?from=2026-10-01&to=2026-10-18&env=all');
  assert.equal(genPath('/api/analytics/sickofit', P('from=yesterday')), '/analytics/sickofit');
  // Each route's own params, only on that route.
  assert.equal(genPath('/api/analytics/sickofit/funnel', P('steps=game_ready,level_start:level=1&by=session')), `/analytics/sickofit/funnel?${new URLSearchParams({ steps: 'game_ready,level_start:level=1', by: 'session' })}`);
  assert.equal(genPath('/api/analytics/sickofit/builds', P('a=1.0&b=1.1&what=events')), '/analytics/sickofit/builds?a=1.0&b=1.1');
  assert.equal(genPath('/api/analytics/sickofit/export', P('what=sessions&format=csv&limit=500')), '/analytics/sickofit/export?what=sessions&format=csv&limit=500');
  assert.equal(genPath('/api/analytics/sickofit/export', P('what=everything&format=xls')), '/analytics/sickofit/export');
});

const prod = (id: string, n: number, prev = 0) => ({
  product: id, name: id, activeNow: n ? 1 : 0,
  today: { sessions: n, visitors: n, previous: { sessions: prev, visitors: prev }, trend: {} },
  '7d': { sessions: n * 2, visitors: n, previous: { sessions: prev, visitors: prev }, trend: {} },
  '30d': { sessions: n * 3, visitors: n * 2, previous: { sessions: prev, visitors: prev }, trend: {} },
  daily: [{ day: '2026-10-18', sessions: n, visitors: n }, { day: '2026-10-19', sessions: n * 2, visitors: n }],
});

test('the overview: a studio-wide total, and products with no data yet say so', () => {
  const o = withTotals({ from: 1, to: 2, env: ['live'], products: [prod('sickofit', 4, 2), prod('phorigins', 1, 1), prod('yoobaland', 0)] });
  assert.deepEqual(o.products.map((p: any) => [p.product, p.hasData]), [['sickofit', true], ['phorigins', true], ['yoobaland', false]]);
  assert.equal(o.total.activeNow, 2);
  assert.equal(o.total.withData, 2);
  assert.equal(o.total.products, 3);
  assert.deepEqual(o.total['30d'], { sessions: 15, visitors: 10, previous: { sessions: 3, visitors: 3 }, trend: { sessions: 4, visitors: 2.333 } });
  assert.deepEqual(o.total.daily, [{ day: '2026-10-18', sessions: 5, visitors: 5 }, { day: '2026-10-19', sessions: 10, visitors: 5 }]);
  // Gen with no products at all (or an empty answer): zeros, no trend, no crash.
  const none = withTotals({});
  assert.deepEqual(none.products, []);
  assert.equal(none.total.activeNow, 0);
  assert.deepEqual(none.total.today, { sessions: 0, visitors: 0, previous: { sessions: 0, visitors: 0 }, trend: { sessions: null, visitors: null } });
  assert.deepEqual(none.total.daily, []);
  // Last month's players still count as data (a quiet month isn't "the SDK isn't on it").
  assert.equal(hasData({ activeNow: 0, '30d': { sessions: 0, previous: { sessions: 3 } } }), true);
  assert.equal(hasData(undefined), false);
});

/** The handler with a stand-in for Gen: what it asked for, and what it answered. */
async function call(pathAndQuery: string, gen: (p: string) => Promise<any>, method = 'GET') {
  const asked: string[] = [];
  let status = 0;
  let body: any;
  const res: any = {};
  const send = (_r: any, s: number, b: unknown) => { status = s; body = b; };
  await handleAnalyticsApi({ method } as any, res, new URL(`http://x${pathAndQuery}`), send, (p) => { asked.push(p); return gen(p); });
  return { status, body, asked };
}

test('the API proxy asks Gen and answers with its data (the overview with totals)', async () => {
  const r = await call('/api/analytics/overview?env=beta&range=7d', async () => ({ products: [prod('sickofit', 2)] }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.asked, ['/analytics/overview?range=7d&env=beta']);
  assert.equal(r.body.total.activeNow, 1);
  assert.equal(r.body.products[0].hasData, true);

  const s = await call('/api/analytics/sickofit/levels?range=30d&device=phone', async () => [{ level: '1', attempts: 3 }]);
  assert.equal(s.status, 200);
  assert.deepEqual(s.asked, ['/analytics/sickofit/levels?range=30d&device=phone']);
  assert.deepEqual(s.body, [{ level: '1', attempts: 3 }]);
});

test('the API proxy refuses what isn\'t a read route, and says when Gen fails', async () => {
  const never = async () => { throw new Error('should not ask Gen'); };
  assert.equal((await call('/api/analytics/sickofit/nope', never)).status, 404);
  assert.equal((await call('/api/analytics/overview', never, 'POST')).status, 405);

  const offline = await call('/api/analytics/overview', async () => { throw Object.assign(new Error("Can't reach Hawkes Gen"), { status: 0, kind: 'offline' }); });
  assert.equal(offline.status, 502);
  assert.equal(offline.body.offline, true);
  assert.match(offline.body.error, /isn't answering/);

  const unknown = await call('/api/analytics/nosuchgame', async () => { throw Object.assign(new Error('No analytics product nosuchgame'), { status: 404 }); });
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.error, /No analytics product/);
});

test('the new sections, one account, and the account filter go through; a bad account id does not', () => {
  const P = (s: string) => new URLSearchParams(s);
  for (const s of ['segments', 'engagement', 'frustration', 'accounts']) assert.equal(genPath(`/api/analytics/hawkesgen/${s}`, P('')), `/analytics/hawkesgen/${s}`);
  assert.equal(genPath('/api/analytics/hawkesgen/accounts', P('limit=20&offset=40')), '/analytics/hawkesgen/accounts?limit=20&offset=40');
  assert.equal(genPath('/api/analytics/hawkesgen/accounts/usr_0123456789abcdef', P('range=7d')), '/analytics/hawkesgen/accounts/usr_0123456789abcdef?range=7d');
  assert.equal(genPath('/api/analytics/hawkesgen/frustration', P('user=usr_0123456789abcdef')), '/analytics/hawkesgen/frustration?user=usr_0123456789abcdef');
  assert.equal(genPath('/api/analytics/hawkesgen/frustration', P('user=a b')), '/analytics/hawkesgen/frustration');
  assert.equal(genPath('/api/analytics/hawkesgen/accounts/../x', P('')), null);
});

test('players and marks go through to Gen; a mark posts only a checked kind and value', async () => {
  assert.equal(genPath('/api/analytics/players', P('range=30d&env=live&limit=300&steps=x')), '/analytics/players?range=30d&env=live&limit=300');
  assert.equal(genPath('/api/analytics/marks', P('range=30d')), '/analytics/marks');
  assert.equal(genPath('/api/analytics/players/x', P('')), null);
  const asked: any[] = [];
  let status = 0;
  let body: any;
  const send = (_: any, s: number, b: any) => { status = s; body = b; };
  const post = (b: any) => handleAnalyticsApi({ method: 'POST' } as any, {} as any, new URL('http://x/api/analytics/marks'), send, async (p, o) => { asked.push([p, o]); return { ok: true, sessions: 3 }; }, async () => b);
  await post({ kind: 'net', value: 'n_abcdef1234567890', me: true, extra: 'dropped' });
  assert.equal(status, 200);
  assert.equal(body.sessions, 3);
  assert.deepEqual(asked[0], ['/analytics/marks', { method: 'POST', body: { kind: 'net', value: 'n_abcdef1234567890', what: 'me', on: true } }]);
  await post({ kind: 'anon', value: 'a_1234', me: false, note: 'old phone' });
  assert.deepEqual(asked[1][1].body, { kind: 'anon', value: 'a_1234', what: 'me', on: false, note: 'old phone' });
  await post({ kind: 'net', value: 'n_abcdef1234567890', what: 'bot' });
  assert.deepEqual(asked[2][1].body, { kind: 'net', value: 'n_abcdef1234567890', what: 'bot', on: true });
  assert.equal(genPath('/api/analytics/sickofit/levels', P('engaged=1&range=7d')), '/analytics/sickofit/levels?range=7d&engaged=1');
  assert.equal(genPath('/api/analytics/sickofit/levels', P('engaged=yes')), '/analytics/sickofit/levels');
  for (const bad of [{ kind: 'ip', value: 'n_abcdef' }, { kind: 'net', value: '1.2.3.4' }, { kind: 'net' }]) {
    await post(bad);
    assert.equal(status, 400, JSON.stringify(bad));
  }
  assert.equal(asked.length, 3);
  await handleAnalyticsApi({ method: 'POST' } as any, {} as any, new URL('http://x/api/analytics/sickofit'), send, async () => ({}));
  assert.equal(status, 405);
});
