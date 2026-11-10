// Going live where beta playtests are skipped looks at CI once and holds no wait (golive-policy.ts autoGoLive): beta's
// CI tells Studio when it ends (.github/workflows/beta-ci-ended.yml). 2026-11-10 21:42 to 21:48: Studio restarted four
// times while it waited in memory for CI, and nothing went live. And when the tip's CI was cancelled because a newer
// merge's run took its place, it gave up instead of taking the newest commit whose CI passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeGitHub, sha } from './fake-github.ts';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-golive-ci-event-'));
process.env.STUDIO_MAIL = 'off';
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9';
process.env.GITHUB_TOKEN = 'ghp_test';
delete process.env.STUDIO_CUSTOMER;
delete process.env.K_SERVICE;
fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'agents.json'), JSON.stringify({ enabled: true }));
fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'products.json'), JSON.stringify({ products: [
  { id: 'tool', name: 'Tool', engine: 'web', repo: 'me/tool', github: 'me/tool', about: '', contract: true, playtests: [], story: [] },
] }));
process.env.STUDIO_PRODUCTS = path.join(process.env.STUDIO_DATA!, 'products.json');

const gh = fakeGitHub({
  'me/tool': { refs: { main: sha('1'), beta: sha('4') }, commits: {
    [sha('1')]: { parents: [], tree: 't1' },
    [sha('2')]: { parents: [sha('1')], tree: 't2', title: 'Fix A' },
    [sha('3')]: { parents: [sha('2')], tree: 't3', title: 'Fix B' },
    [sha('4')]: { parents: [sha('3')], tree: 't4', title: 'Fix C' },
  } },
});
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => (new URL(String(input instanceof Request ? input.url : input)).host === 'api.github.com' ? gh.f(input, init) : realFetch(input, init))) as typeof fetch;
test.after(() => { globalThis.fetch = realFetch; });

const P = await import('../src/golive-policy.ts');
const { getOp } = await import('../src/ops.ts');
await import('../src/builds.ts');
P.setBetaPlay('tool', 'skip', 'Talk', 'skip beta playtests');
P.setPolicy('tool', 'auto', 'Talk', 'keep going live');

const ci: Record<string, { status: string; conclusion: string | null }> = {};
let looks = 0;
P.goLiveCi.list = async (_slug, at) => { looks++; const r = ci[at]; return r ? [{ name: 'Deploy', ...r }] : []; };

test('CI still running: one look, no wait held, and it says Studio looks again when CI ends', async () => {
  ci[sha('4')] = { status: 'in_progress', conclusion: null };
  const t0 = Date.now();
  const r = await P.autoGoLive('tool', 'beta moved');
  assert.ok(r.waits, JSON.stringify(r));
  assert.ok(Date.now() - t0 < 5000, 'it did not sit waiting for CI');
});

test("the tip's run cancelled by a newer merge's run: the newest commit whose CI passed goes live", async () => {
  ci[sha('4')] = { status: 'completed', conclusion: 'cancelled' };
  ci[sha('3')] = { status: 'completed', conclusion: 'success' };
  ci[sha('2')] = { status: 'completed', conclusion: 'success' };
  const r = await P.autoGoLive('tool', "beta's CI ended");
  assert.ok(r.went, JSON.stringify(r));
  assert.equal(getOp(r.went!)!.payload.beta, sha('3'), 'the newest green commit, not the cancelled tip or an older one');
});

test('nothing green on beta: it waits, and goes live once the CI-ended call finds the tip green', async () => {
  gh.repos['me/tool'].refs.main = sha('3');
  ci[sha('4')] = { status: 'completed', conclusion: 'failure' };
  // The op from the test above may have taken main to 3 already; either way only 4 is left.
  const r = await P.autoGoLive('tool', "beta's CI ended");
  assert.ok(r.waits, JSON.stringify(r));
  ci[sha('4')] = { status: 'completed', conclusion: 'success' };
  const again = await P.autoGoLive('tool', "beta's CI ended");
  assert.ok(again.went, JSON.stringify(again));
  assert.equal(getOp(again.went!)!.payload.beta, sha('4'));
});
