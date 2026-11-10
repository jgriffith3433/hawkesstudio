// Going live on green CI where beta playtests are skipped (golive-policy.ts betaPlay skip, Hawkes Studio's own repo).
// 2026-11-10: merges landed on beta every few minutes and its CI takes about ten, so by the time CI on a commit passed,
// beta's tip had moved, and Studio waited for a tip whose CI was done. Twenty fixes sat on beta for 70 minutes. Now main
// goes to the newest beta commit whose CI passed, even when beta is ahead of it; never past it, never off beta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeGitHub, sha } from './fake-github.ts';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-golive-ancestor-'));
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
const D = await import('../src/deploy.ts');
await import('../src/builds.ts'); // the builds table
P.setBetaPlay('tool', 'skip', 'Talk', 'skip beta playtests');

test('green CI on an older beta commit takes main to that commit, not to the newer tip', async () => {
  const plan = await D.deployPlan('tool');
  assert.equal(plan.beta?.sha, sha('4'));
  assert.match(plan.blockers.join('\n'), /hasn't been playtested/, 'the tip is unplayed: only CI gates it here');
  const r: any = await D.deploy('tool', { confirm: plan.confirm, by: 'Studio (CI passed)', beta: sha('3'), ciPassed: { sha: sha('3'), runs: ['Deploy'] } } as any);
  assert.equal(r.ok, true);
  const w = gh.repos['me/tool'];
  assert.equal(w.refs.main, sha('3'), 'main is at the commit whose CI passed');
  assert.equal(w.refs.beta, sha('4'), 'beta is untouched');
  const after = await D.deployPlan('tool');
  assert.deepEqual(after.commits.map((c) => c!.title), ['Fix C'], 'only the newer tip is left to go live');
});

test('a commit main already has is a no-op, never a move backwards', async () => {
  const plan = await D.deployPlan('tool');
  const r: any = await D.deploy('tool', { confirm: plan.confirm, by: 'Studio (CI passed)', beta: sha('2'), ciPassed: { sha: sha('2'), runs: ['Deploy'] } } as any);
  assert.equal(r.nothing, true);
  assert.equal(gh.repos['me/tool'].refs.main, sha('3'));
});

test('without green CI for that commit, an older commit is still refused as not what was approved', async () => {
  const w = gh.repos['me/tool'];
  w.commits[sha('5')] = { parents: [sha('4')], tree: 't5', title: 'Fix D' };
  w.refs.beta = sha('5');
  const plan = await D.deployPlan('tool');
  await assert.rejects(D.deploy('tool', { confirm: plan.confirm, by: 'someone', beta: sha('4') }), /Not going live|not 4444444/);
  assert.equal(w.refs.main, sha('3'));
});

test('the go live itself refuses a commit that is not on beta', async () => {
  const { goLiveOnGitHub } = await import('../src/deploy-github.ts');
  const C = await import('../src/config.ts');
  const w = gh.repos['me/tool'];
  w.commits[sha('9')] = { parents: [sha('3')], tree: 't9', title: 'Off to the side' };
  await assert.rejects(goLiveOnGitHub(C.getProduct('tool'), { beta: { sha: sha('9'), short: sha('9').slice(0, 7) }, main: { sha: sha('3') }, commits: [{}], ancestorOk: true } as any), /moved since the plan/);
  assert.equal(w.refs.main, sha('3'));
});

test('a CI look that fails (GitHub slow) is retried, not the end of the wait', async () => {
  let n = 0;
  const list = async () => {
    if (++n === 1) throw new Error('The operation was aborted due to timeout');
    return [{ name: 'Deploy', status: 'completed', conclusion: 'success' }];
  };
  const r = await P.ciOn('me/tool', sha('4'), { every: 5, maxMs: 1000, list });
  assert.equal(r.ok, true);
  assert.equal(n, 2);
});
