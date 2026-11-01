// The Go live cards' "Playtest this commit" (J, 2026-11-01: "when the current commit hasn't been playtested, add a
// button for playtesting it"): dashboard/golive.js PlayState says whether beta's exact commit was played and passed,
// with the same rule as going live by itself (golive-policy.ts playtestHolds), and the runs list tells a playtest of
// beta from one of the live site (pipeline.ts listRuns), so a card follows a beta play started anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-golive-playtest-'));
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [] }));

const page: any = {};
vm.runInNewContext(fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'golive.js'), 'utf8'), page);
const S = page.PlayState;
const { playtestHolds } = await import('../src/golive-policy.ts');

const pass = { name: 'smoke@local', status: 'done', outcome: 'won', verdict: 'good', summary: null, blockers: [] as string[] };
const plan = (playtests: any[], extra: any = {}) => ({ product: 'site', beta: { sha: 'abc1234def', short: 'abc1234' }, tested: { sha: 'abc1234', playtests }, ...extra });

test('a commit nobody played offers the button', () => {
  const s = S.of(plan([]));
  assert.equal(s.state, 'untested');
  assert.equal(s.sha, 'abc1234');
  assert.match(s.text, /abc1234\) hasn't been playtested/);
  assert.equal(S.canPlay(s), true);
});

test('a clean pass needs no button', () => {
  const s = S.of(plan([pass, { ...pass, name: 'phone@local', outcome: 'done' }]));
  assert.equal(s.state, 'passed');
  assert.match(s.text, /passed its playtests/);
  assert.equal(S.canPlay(s), false);
});

test("a play that didn't pass offers to play it again, and says why", () => {
  const cases: [any, RegExp][] = [
    [{ ...pass, status: 'failed', outcome: null }, /smoke2@local failed/],
    [{ ...pass, status: 'skipped', outcome: null }, /was inconclusive/],
    [{ ...pass, status: 'stopped', outcome: null }, /was stopped/],
    [{ ...pass, outcome: 'lost' }, /ended "lost"/],
    [{ ...pass, verdict: 'broken' }, /reviewed as broken/],
    [{ ...pass, blockers: ['Crash on start'] }, /1 blocker/],
  ];
  for (const [t, why] of cases) {
    const s = S.of(plan([pass, { ...t, name: 'smoke2@local' }]));
    assert.equal(s.state, 'failed', JSON.stringify(t));
    assert.match(s.text, why);
    assert.equal(S.canPlay(s), true);
  }
});

test('the card agrees with going live by itself (playtestHolds)', () => {
  const sets = [[], [pass], [{ ...pass, verdict: 'broken' }], [{ ...pass, status: 'skipped' }], [pass, { ...pass, outcome: 'timeout' }], [{ ...pass, blockers: ['x'] }]];
  for (const t of sets) assert.equal(S.of(plan(t)).state === 'passed', playtestHolds(t as any, 'abc1234').length === 0, JSON.stringify(t));
});

test('while beta is being played, no button (the card shows the run instead)', () => {
  const s = S.of(plan([]), { going: { step: 'playtest: smoke@local' } });
  assert.equal(s.state, 'running');
  assert.match(s.text, /Playtesting abc1234: playtest: smoke@local/);
  assert.equal(S.canPlay(s), false);
  assert.equal(S.of(plan([{ ...pass, verdict: 'broken' }]), { going: {} }).state, 'running');
});

test('nothing to go live, no beta, an error or an address-only game: nothing to say', () => {
  assert.equal(S.of(plan([]), { ahead: false }), null);
  assert.equal(S.of(plan([], { beta: null })), null);
  assert.equal(S.of({ error: 'GitHub: 502' }), null);
  assert.equal(S.of({ urlOnly: true, beta: 'https://beta.example.com' }), null);
  assert.equal(S.of(null), null);
  assert.equal(S.canPlay(null), false);
  // A plan without tested.sha falls back to beta's own short commit.
  assert.equal(S.of({ beta: { sha: 'fff0000aaa', short: 'fff0000' }, tested: { playtests: [] } }).sha, 'fff0000');
});

test("the runs list says where a playtest run plays, so a card follows a beta play started elsewhere", async () => {
  const { db, J } = await import('../src/db.ts');
  const { listRuns } = await import('../src/pipeline.ts');
  const add = (id: string, kind: string, options: any, started: number) => db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, kind, 'running', kind, J(['site']), J(options), started);
  add('r_pt_local', 'playtest', { where: 'local', scenario: 'smoke' }, 3);
  add('r_pt_live', 'playtest', { where: 'live' }, 2);
  add('r_beta', 'beta', { playtest: true }, 1);
  const runs = listRuns(10);
  const by = Object.fromEntries(runs.map((r: any) => [r.id, r]));
  assert.equal(by.r_pt_local.where, 'local');
  assert.equal(by.r_pt_live.where, 'live');
  assert.equal('where' in by.r_beta, false);
  assert.equal('options' in by.r_beta, false, 'the options stay on the run itself (GET /api/runs/<id>)');
  assert.deepEqual(by.r_beta.products, ['site']);
});
