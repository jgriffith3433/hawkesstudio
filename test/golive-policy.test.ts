// Going live on the owner's word (golive-policy.ts): plain words count, "hold off" doesn't, and the policy is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-golive-'));
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'products.json'), JSON.stringify({ products: [{ id: 'moon', name: 'Moon Rover', engine: 'web', live: 'https://moon.example', playtests: [], story: [] }] }));
process.env.STUDIO_PRODUCTS = path.join(process.env.STUDIO_DATA, 'products.json');
const P = await import('../src/golive-policy.ts');
const G = await import('../src/guards.ts');

test('plain words ask to go live; hold-offs and questions about it don\'t', () => {
  for (const t of ['go live', 'Looks good, take it live', 'ship it', 'yes go ahead and push it live', 'DEPLOY moon', 'deploy the new build', "let's release it"]) assert.ok(P.asksToGoLive(t, 'moon'), t);
  for (const t of ['hold off on going live', "don't ship it yet", 'not yet, wait for the music', 'is it live?', 'what changed since live', 'stop going live']) assert.ok(!P.asksToGoLive(t, 'moon'), t);
  assert.ok(P.asksToRollBack('roll back moon please', 'moon'));
  assert.ok(P.asksToRollBack('revert the release'));
  assert.ok(!P.asksToRollBack("don't roll back"));
});

test('the policy: ask by default, kept with who set it and their words; auto lets Talk go live without new words', () => {
  assert.equal(P.policyOf('moon').policy, 'ask');
  assert.match(String(G.guardRoute('/api/deploy/moon', 'POST', null)), /waits for the owner's word/);
  P.setPolicy('moon', 'auto', 'Talk', 'keep going live whenever it passes');
  const pol = P.policyOf('moon');
  assert.deepEqual([pol.policy, pol.by, pol.words], ['auto', 'Talk', 'keep going live whenever it passes']);
  assert.equal(G.guardRoute('/api/deploy/moon', 'POST', null), null, 'auto: no new words needed');
  P.setPolicy('moon', 'hold', 'Talk', 'hold off for now');
  assert.ok(G.guardRoute('/api/deploy/moon', 'POST', null));
  assert.throws(() => P.setPolicy('moon', 'sometimes' as any, 'x'), /auto \| hold \| ask/);
});

test("autoGoLive waits unless the owner said to keep going live", async () => {
  P.setPolicy('moon', 'hold', 'Talk');
  assert.match(String((await P.autoGoLive('moon', 'test')).waits), /policy is hold/);
  P.setPolicy('moon', 'ask', 'Talk');
  assert.match(String((await P.autoGoLive('moon', 'test')).waits), /policy is ask/);
});

test('auto only ships a beta whose playtests passed: failed, stopped, inconclusive or broken holds it', () => {
  const pass = { name: 'smoke@local', status: 'done', outcome: 'won', verdict: 'ok', blockers: [] };
  assert.deepEqual(P.playtestHolds([pass, { ...pass, name: 'phone@local', outcome: 'done', verdict: null }], 'abc1234'), [], 'passed (a missing review alone doesn\'t hold it)');
  assert.match(P.playtestHolds([], 'abc1234')[0], /hasn't been playtested on abc1234/);
  assert.match(P.playtestHolds([{ ...pass, status: 'failed', detail: 'Studio restarted' }]).join(), /smoke@local failed \(Studio restarted\)/);
  assert.match(P.playtestHolds([{ ...pass, status: 'skipped' }]).join(), /was inconclusive/);
  assert.match(P.playtestHolds([{ ...pass, status: 'stopped' }]).join(), /was stopped/);
  assert.match(P.playtestHolds([{ ...pass, outcome: 'lost' }]).join(), /ended "lost"/);
  assert.match(P.playtestHolds([{ ...pass, verdict: 'broken', summary: 'menu off screen' }]).join(), /said "broken": menu off screen/);
  assert.match(P.playtestHolds([{ ...pass, blockers: ['buttons overlap'] }]).join(), /1 blocker\(s\): buttons overlap/);
  assert.equal(P.holdLine({ tested: { sha: 'abc1234', playtests: [pass] } }), null);
  assert.match(String(P.holdLine({ tested: { sha: 'abc1234', playtests: [{ ...pass, status: 'skipped' }] } })), /waits until beta plays clean: playtest smoke@local on abc1234 was inconclusive/);
});

test('skipping beta playtests is per project, from the owner\'s words; CI on the exact commit is the gate', async () => {
  assert.equal(P.policyOf('moon').betaPlay, 'play', 'games keep their playtests unless the owner says otherwise');
  assert.equal(P.skipsBetaPlay('moon'), false);
  const was = P.policyOf('moon').policy;
  P.setBetaPlay('moon', 'skip', 'Talk', 'skip beta playtests');
  const pol = P.policyOf('moon');
  assert.deepEqual([pol.betaPlay, pol.betaPlayBy, pol.betaPlayWords, pol.policy], ['skip', 'Talk', 'skip beta playtests', was], 'the go-live policy is left as it was');
  assert.equal(P.skipsBetaPlay('moon'), true);
  const { ciSkipFor } = await import('../src/deploy.ts');
  assert.match(String(ciSkipFor('moon', 'abc1234', { sha: 'abc1234', runs: ['Deploy'] })?.by), /CI passed/);
  assert.equal(ciSkipFor('moon', 'abc1234', { sha: 'fff0000', runs: ['Deploy'] }), null, 'CI of another commit');
  assert.equal(ciSkipFor('moon', 'abc1234', undefined), null);
  // CI: waits while a run is going, then green; a failed run is not.
  let n = 0;
  const list = async () => (++n < 3 ? [{ name: 'Deploy', status: 'in_progress', conclusion: null }] : [{ name: 'Deploy', status: 'completed', conclusion: 'success' }, { name: 'Lint', status: 'completed', conclusion: 'skipped' }]);
  const ok = await P.ciOn('o/r', 'abc1234', { every: 5, maxMs: 1000, list });
  assert.deepEqual([ok.ok, n], [true, 3]);
  const bad = await P.ciOn('o/r', 'abc1234', { every: 5, maxMs: 1000, list: async () => [{ name: 'Deploy', status: 'completed', conclusion: 'failure' }] });
  assert.equal(bad.ok, false);
  assert.match(bad.why, /Deploy failure/);
  const slow = await P.ciOn('o/r', 'abc1234', { every: 5, maxMs: 20, list: async () => [] });
  assert.match(slow.why, /no CI run/);
  // The real reader: beta's Deploy is started by workflow_dispatch after an auto-merge (no push run), and it counts;
  // a pull_request run and Studio's own hook don't.
  const was2 = globalThis.fetch;
  const tok = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = tok ?? 't';
  let url = '';
  globalThis.fetch = (async (u: any) => { url = String(u); return new Response(JSON.stringify({ workflow_runs: [
    { name: 'Deploy', path: '.github/workflows/ci.yml', event: 'workflow_dispatch', status: 'completed', conclusion: 'success' },
    { name: 'Beta auto-merge', path: '.github/workflows/beta-automerge.yml', event: 'pull_request', status: 'completed', conclusion: 'failure' },
    { name: 'Hawkes Studio', path: '.github/workflows/hawkes-studio.yml', event: 'push', status: 'in_progress', conclusion: null },
  ] }), { status: 200 }); }) as any;
  try {
    const real = await P.ciOn('o/r', 'abc1234', { every: 5, maxMs: 100 });
    assert.deepEqual([real.ok, real.runs], [true, ['Deploy']], real.why);
    assert.doesNotMatch(url, /event=push/);
  } finally { globalThis.fetch = was2; if (tok === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = tok; }
  P.setBetaPlay('moon', 'play', 'Talk', 'play beta again');
  assert.equal(ciSkipFor('moon', 'abc1234', { sha: 'abc1234', runs: ['Deploy'] }), null, 'back to playtests: CI alone no longer lets it go');
});

test('before going live: ONE beta play per commit, none while one plays, and a played commit is not played again', async () => {
  const { db } = await import('../src/db.ts');
  const starts: any[] = [];
  const start = (product: string, o: any) => {
    const id = `r_bgl${starts.length}`;
    starts.push({ product, ...o });
    db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'beta', 'running', `beta ${product}`, JSON.stringify([product]), JSON.stringify({ focus: o.focus }), Date.now());
    return { id };
  };
  const first = await P.playBeforeGoLive('moon', 'abc1234', 'test', start);
  assert.equal(first.started, 'r_bgl0');
  assert.equal(starts[0].playtest, true);
  assert.equal(starts[0].reverify, true);
  assert.match(starts[0].focus, /abc1234/);
  // Another merge lands while it plays: nothing new starts (the next pass plays the newest commit).
  assert.deepEqual(await P.playBeforeGoLive('moon', 'def5678', 'test', start), { playing: 'r_bgl0' });
  db.prepare(`UPDATE runs SET status = 'failed' WHERE id = 'r_bgl0'`).run();
  // That commit was played (and failed): not played again until beta moves.
  assert.deepEqual(await P.playBeforeGoLive('moon', 'abc1234', 'test', start), { played: 'r_bgl0' });
  // Beta moved: the newest commit gets its one play.
  assert.equal((await P.playBeforeGoLive('moon', 'def5678', 'test', start)).started, 'r_bgl1');
  assert.equal(starts.length, 2);
});
