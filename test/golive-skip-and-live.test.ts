// 2026-11-10: Hawkes Studio's main sat at dc3c81f, 49 commits behind beta, for hours. Two go-live bugs held it:
//  1. a go live said "already live" with main behind beta: "already live" was concluded from a commit missing from the
//     list of commits main lacks, never from main's own commits;
//  2. the go-live plan refused because beta wasn't playtested, though the owner skips beta playtests for this project
//     (golive-policy.ts betaPlay skip): only autoGoLive knew about the skip, not the plan or a go live someone asked for.
// Each test below failed before the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeGitHub, sha } from './fake-github.ts';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-golive-skip-live-'));
process.env.STUDIO_MAIL = 'off';
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9';
process.env.GITHUB_TOKEN = 'ghp_test';
delete process.env.STUDIO_CUSTOMER;
delete process.env.K_SERVICE;
fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'agents.json'), JSON.stringify({ enabled: true }));
fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'products.json'), JSON.stringify({ products: [
  { id: 'tool', name: 'Tool', engine: 'web', repo: 'me/tool', github: 'me/tool', about: '', contract: true, playtests: [], story: [] },
  { id: 'game', name: 'Game', engine: 'web', repo: 'me/game', github: 'me/game', about: '', contract: true, playtests: [], story: [] },
] }));
process.env.STUDIO_PRODUCTS = path.join(process.env.STUDIO_DATA!, 'products.json');

const gh = fakeGitHub({
  'me/tool': { refs: { main: sha('1'), beta: sha('4') }, commits: {
    [sha('1')]: { parents: [], tree: 't1' },
    [sha('2')]: { parents: [sha('1')], tree: 't2', title: 'Fix A' },
    [sha('3')]: { parents: [sha('2')], tree: 't3', title: 'Fix B' },
    [sha('4')]: { parents: [sha('3')], tree: 't4', title: 'Fix C' },
    [sha('9')]: { parents: [sha('1')], tree: 't9', title: 'Off to the side' },
  } },
  'me/game': { refs: { main: sha('a'), beta: sha('b') }, commits: {
    [sha('a')]: { parents: [], tree: 'ta' },
    [sha('b')]: { parents: [sha('a')], tree: 'tb', title: 'New level' },
  } },
});
let emptyCompare = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const u = new URL(String(input instanceof Request ? input.url : input));
  if (u.host !== 'api.github.com') return realFetch(input, init);
  // GitHub answering main...beta without its commits (what made an empty list read as "already live").
  if (emptyCompare && /\/compare\/main\.\.\.beta$/.test(u.pathname)) return new Response(JSON.stringify({ status: 'ahead', ahead_by: 3, behind_by: 0, commits: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  return gh.f(input, init);
}) as typeof fetch;
test.after(() => { globalThis.fetch = realFetch; });

const P = await import('../src/golive-policy.ts');
const D = await import('../src/deploy.ts');
await import('../src/builds.ts');
P.setBetaPlay('tool', 'skip', 'Talk', 'skip beta playtests');
// CI per commit: the tip's run cancelled by a newer merge's, the one before it green.
const ci: Record<string, string> = { [sha('4')]: 'cancelled', [sha('3')]: 'success', [sha('2')]: 'success' };
P.goLiveCi.list = async (_s, at) => (ci[at] ? [{ name: 'Deploy', status: 'completed', conclusion: ci[at] }] : null);

test('the plan of a project that skips beta playtests is not blocked by beta not being playtested', async () => {
  const plan: any = await D.deployPlan('tool');
  assert.doesNotMatch(plan.blockers.join('\n'), /hasn't been playtested/);
  assert.equal(plan.canDeploy, true);
  assert.equal(plan.ciGate, true);
  assert.match(plan.warnings.join('\n'), /playtests are skipped/);
  // A project that plays beta keeps its playtest blocker.
  const game: any = await D.deployPlan('game');
  assert.match(game.blockers.join('\n'), /hasn't been playtested/);
  assert.notEqual(game.ciGate, true);
});

test('a go live someone asks for goes live at the newest beta commit whose CI passed, with no playtest', async () => {
  const plan = await D.deployPlan('tool');
  const r: any = await D.deploy('tool', { confirm: plan.confirm, by: 'the coordinator' });
  assert.equal(r.ok, true);
  assert.equal(r.nothing, undefined);
  assert.equal(gh.repos['me/tool'].refs.main, sha('3'), 'main is at the green commit, not the cancelled tip');
  assert.ok(r.skippedPlaytest, 'the record says CI was the gate');
});

test('no beta commit with green CI: the go live waits for CI, it does not fail on the playtest', async () => {
  ci[sha('4')] = 'in_progress';
  P.goLiveCi.list = async (_s, at) => (at === sha('4') ? [{ name: 'Deploy', status: 'in_progress', conclusion: null }] : null);
  const plan = await D.deployPlan('tool');
  await assert.rejects(D.deploy('tool', { confirm: plan.confirm, by: 'someone' }), (e: any) => e instanceof D.NeedsCi && !/playtest/.test(e.message));
  assert.equal(gh.repos['me/tool'].refs.main, sha('3'));
});

test('"already live" only when main has the commit: a commit main lacks that is off beta is refused, not called live', async () => {
  const plan = await D.deployPlan('tool');
  await assert.rejects(
    D.deploy('tool', { confirm: plan.confirm, by: 'Studio (CI passed)', beta: sha('9'), ciPassed: { sha: sha('9'), runs: ['Deploy'] } } as any),
    (e: any) => /isn't on beta/.test(e.message) && !/already/i.test(e.message),
  );
  const r: any = await D.deploy('tool', { confirm: plan.confirm, by: 'Studio (CI passed)', beta: sha('2'), ciPassed: { sha: sha('2'), runs: ['Deploy'] } } as any);
  assert.equal(r.nothing, true, 'main already has 2222222');
  assert.match(r.note, /has 2222222/);
});

test('an empty commit list from GitHub with main and beta on different commits is not "Nothing to go live"', async () => {
  emptyCompare = true;
  try {
    const plan: any = await D.deployPlan('tool');
    assert.doesNotMatch(plan.blockers.join('\n'), /Nothing to go live/);
    assert.match(plan.blockers.join('\n'), /listed no commits though they differ/);
    const r: any = await D.deploy('tool', { confirm: plan.confirm, by: 'someone' }).catch((e) => ({ error: e.message }));
    assert.notEqual(r.nothing, true, 'not reported as already live');
  } finally { emptyCompare = false; }
});

test('Studio by itself: an older green commit not ahead of main is only "already live" when main has it', async () => {
  P.setPolicy('tool', 'auto', 'Talk', 'keep going live');
  P.goLiveCi.list = async (_s, at) => (at === sha('3') ? [{ name: 'Deploy', status: 'completed', conclusion: 'success' }] : [{ name: 'Deploy', status: 'completed', conclusion: 'cancelled' }]);
  const r = await P.autoGoLive('tool', 'test');
  // main is at 3333333 already and beta's tip 4444444 isn't green: nothing goes, and it never claims main has 4444444.
  assert.equal(r.went, undefined);
  assert.doesNotMatch(String(r.waits), /4444444 is already live/);
});
