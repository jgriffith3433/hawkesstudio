// The router Worker in front of studio.hawkesgen.ai (server/studio-edge): J's Studio as before, /o/<org>/ to that org's
// cell with its prefix taken off, the dashboard's absolute /api/ calls routed by their referrer, cookies kept apart,
// redirects put back under the prefix, and a hibernated cell woken with a "waking" page. Cloudflare's fetch is a stand-in.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const W = await import('../server/studio-edge/src/index.ts');
const worker = W.default;
const env = { STUDIO_ORIGIN: 'https://studio-123.us-east4.run.app', CELLS_PROJECT_NUMBER: '123', CELLS_REGION: 'us-east4', CELLS_SERVICE_PREFIX: 'studio', EDGE_KEY: 'edge-key' };

type Seen = { url: string; method: string; headers: Headers };
let seen: Seen[] = [];
let answer: (url: string, init: any) => Response = () => new Response('{}');
const real = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  seen.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers) });
  return answer(url, init);
}) as typeof fetch;
afterEach(() => { seen = []; answer = () => new Response('{}'); });
process.on('exit', () => { globalThis.fetch = real; });

const at = (path: string, headers: Record<string, string> = {}, method = 'GET') => new Request(`https://studio.hawkesgen.ai${path}`, { method, headers });
const cell = (status = 200, headers: Record<string, string> = {}) => new Response('ok', { status, headers: { 'X-Studio-Cell': 'acme-1a2b', ...headers } });

test("J's Studio: as before, with the cells' cookies taken off", async () => {
  answer = () => new Response('j');
  await worker.fetch(at('/api/overview', { Cookie: 'hawkes_session=j; hs_o_acme_1a2b=c; hs_cp=x' }), env);
  assert.equal(seen[0].url, 'https://studio-123.us-east4.run.app/api/overview');
  assert.equal(seen[0].headers.get('Cookie'), 'hawkes_session=j; hs_cp=x');
  assert.equal(seen[0].headers.get('X-Forwarded-Host'), 'studio.hawkesgen.ai');
  assert.equal(seen[0].headers.get('X-Forwarded-Prefix'), null);
});

test('/o/<org>/ goes to its cell without the prefix, with only its own cookie', async () => {
  answer = () => cell();
  const r = await worker.fetch(at('/o/acme-1a2b/api/me?x=1', { Cookie: 'hawkes_session=j; hs_cp=x; hs_o_acme_1a2b=mine; hs_o_other_9z9z=theirs; g_state=1' }), env);
  assert.equal(r.status, 200);
  assert.equal(seen[0].url, 'https://studio-o-acme-1a2b-123.us-east4.run.app/api/me?x=1');
  assert.equal(seen[0].headers.get('Cookie'), 'hs_o_acme_1a2b=mine; g_state=1', "never J's session, the control plane's or another cell's");
  assert.equal(seen[0].headers.get('X-Forwarded-Prefix'), '/o/acme-1a2b');
  assert.equal(r.headers.get('Referrer-Policy'), 'same-origin');
  const bare = await worker.fetch(at('/o/acme-1a2b'), env);
  assert.equal(bare.status, 302);
  assert.equal(bare.headers.get('Location'), '/o/acme-1a2b/');
});

test("the dashboard's absolute paths follow the page they came from; a navigation out of the cell comes back", async () => {
  answer = () => cell();
  await worker.fetch(at('/api/overview', { Referer: 'https://studio.hawkesgen.ai/o/acme-1a2b/#today' }), env);
  assert.equal(seen[0].url, 'https://studio-o-acme-1a2b-123.us-east4.run.app/api/overview');
  const nav = await worker.fetch(at('/', { Referer: 'https://studio.hawkesgen.ai/o/acme-1a2b/auth/signin', 'Sec-Fetch-Mode': 'navigate' }), env);
  assert.equal(nav.status, 302);
  assert.equal(nav.headers.get('Location'), '/o/acme-1a2b/');
  // The sign-up stays with the control plane whoever links it; another site's referrer routes nothing.
  seen = [];
  await worker.fetch(at('/auth/start', { Referer: 'https://studio.hawkesgen.ai/o/acme-1a2b/' }), env);
  assert.equal(new URL(seen[0].url).host, 'studio-123.us-east4.run.app');
  // GitHub's answers go to J's Studio (it holds the GitHub App) even when a customer's page started the trip.
  seen = [];
  const back = await worker.fetch(at('/api/github/callback?code=c&state=s', { Referer: 'https://studio.hawkesgen.ai/o/acme-1a2b/#today', 'Sec-Fetch-Mode': 'navigate' }), env);
  assert.notEqual(back.status, 302);
  assert.equal(new URL(seen[0].url).host, 'studio-123.us-east4.run.app');
  seen = [];
  await worker.fetch(at('/api/me', { Referer: 'https://evil.example/o/acme-1a2b/' }), env);
  assert.equal(new URL(seen[0].url).host, 'studio-123.us-east4.run.app');
});

test("a cell's redirects come back under its prefix", async () => {
  answer = () => cell(302, { Location: '/auth/signin?next=%2F' });
  const r = await worker.fetch(at('/o/acme-1a2b/'), env);
  assert.equal(r.headers.get('Location'), '/o/acme-1a2b/auth/signin?next=%2F');
  answer = () => cell(302, { Location: 'https://checkout.stripe.com/x' });
  assert.equal((await worker.fetch(at('/o/acme-1a2b/'), env)).headers.get('Location'), 'https://checkout.stripe.com/x');
});

test('a hibernated cell: the control plane is asked to wake it, the visitor sees the waking page until it answers', async () => {
  answer = (url) => (url.includes('/api/cells/edge/') ? Response.json({ state: 'hibernated' }, { status: 202 }) : new Response('Not found', { status: 404 }));
  const r = await worker.fetch(at('/o/acme-1a2b/', { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' }), env);
  assert.equal(r.status, 503);
  assert.match(await r.text(), /Waking your studio/);
  const wake = seen.find((s) => s.url.endsWith('/api/cells/edge/acme-1a2b/wake'))!;
  assert.equal(wake.method, 'POST');
  assert.equal(wake.headers.get('Authorization'), 'Bearer edge-key');
  const api = await worker.fetch(at('/o/acme-1a2b/api/overview'), env);
  assert.equal(api.status, 503);
  assert.equal((await api.json()).waking, true);
  // The page's question: ready once the cell's own health answers.
  answer = (url) => (url.endsWith('/api/health') ? cell() : Response.json({ state: 'awake' }));
  assert.deepEqual(await (await worker.fetch(at('/o/acme-1a2b/__waking'), env)).json(), { ready: true });
});

test('an org with no cell yet goes to the sign-up; an unknown one is a 404', async () => {
  answer = (url) => (url.includes('/wake') ? Response.json({ state: 'new', next: '/auth/start' }) : new Response('', { status: 404 }));
  const r = await worker.fetch(at('/o/acme-1a2b/', { 'Sec-Fetch-Mode': 'navigate' }), env);
  assert.equal(r.headers.get('Location'), '/auth/start');
  answer = (url) => (url.includes('/wake') ? Response.json({ state: 'none' }, { status: 404 }) : new Response('', { status: 404 }));
  assert.equal((await worker.fetch(at('/o/nobody-0000/'), env)).status, 404);
});

test('the cell host is the same as the control plane computes (cellrun.ts serviceUrl)', async () => {
  process.env.STUDIO_CELLS_PROJECT_NUMBER = '123';
  process.env.STUDIO_CELLS_REGION = 'us-east4';
  delete process.env.STUDIO_LANE;
  const R = await import('../src/cellrun.ts');
  assert.equal(`https://${W.cellHost('acme-1a2b', env)}`, R.serviceUrl('acme-1a2b'));
});

test('the waking page: "Setting up your studio" the first time, "Waking" after hibernation', async () => {
  answer = (url) => (url.includes('/wake') ? Response.json({ state: 'creating', first: true }, { status: 202 }) : new Response('', { status: 404 }));
  const first = await (await worker.fetch(at('/o/acme-1a2b/', { 'Sec-Fetch-Mode': 'navigate' }), env)).text();
  assert.match(first, /Setting up your studio/);
  assert.doesNotMatch(first, /asleep/);
  answer = (url) => (url.includes('/wake') ? Response.json({ state: 'hibernated', first: false }, { status: 202 }) : new Response('', { status: 404 }));
  assert.match(await (await worker.fetch(at('/o/acme-1a2b/', { 'Sec-Fetch-Mode': 'navigate' }), env)).text(), /Waking your studio[\s\S]*asleep/);
});
