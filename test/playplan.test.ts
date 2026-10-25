// What a playtest has to earn (J, 2026-10-25, beta run r_fd260676d571): a beta run plays each carried-over scenario once,
// never for a task that is already verified, within a budget; a commit that only changed docs doesn't replay a clean
// pass, and go live accepts that pass; the audit counts what playtests cost and found. A scratch database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-playplan-'));
const { db, J } = await import('../src/db.ts');
const { mergeAsks, settledAsk, planCarried, noRuntimeChange, lastCleanPass } = await import('../src/playplan.ts');
const { auditRows, newIn } = await import('../src/playaudit.ts');
const { testedAt } = await import('../src/deploy.ts');
const { runGenJob } = await import('../src/playtests.ts');
await import('../src/roadmap.ts'); // the tasks table

const task = (id: string, status: string, criteria: string[]) =>
  db.prepare('INSERT INTO tasks (id, item, product, title, request, criteria, status, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'i_1', 'sickofit', id, 'x', J(criteria), status, Date.now());
task('t_done', 'verified', ['dash works', 'wall jump works']);
task('t_wait', 'merged', ['shop opens']);
task('t_mixed_a', 'verified', ['same words']);
task('t_mixed_b', 'merged', ['same words']);

test('plays of the same scenario and options are one play with the criteria joined', () => {
  const m = mergeAsks([
    { scenario: 'smoke', criteria: ['a'] }, { scenario: 'smoke', criteria: ['a', 'b'] },
    { scenario: 'smoke', options: { floor: 2 }, criteria: ['c'] }, { criteria: ['d'] }, { criteria: ['d'] },
  ]);
  assert.deepEqual(m.map((x) => [x.scenario ?? null, x.options ?? null, x.criteria]), [['smoke', null, ['a', 'b']], ['smoke', { floor: 2 }, ['c']], [null, null, ['d']]]);
});

test('a play is settled only when every criterion belongs to tasks that no longer wait for a beta check', () => {
  assert.equal(settledAsk('sickofit', { criteria: ['dash works', 'wall jump works'] }), true);
  assert.equal(settledAsk('sickofit', { criteria: ['shop opens'] }), false, 'a merged task still waits');
  assert.equal(settledAsk('sickofit', { criteria: ['same words'] }), false, 'one of two owners still waits');
  assert.equal(settledAsk('sickofit', { criteria: ['Fixed: a finding'] }), false, 'a fix has no task: kept');
  assert.equal(settledAsk('sickofit', { criteria: [] }), false);
  assert.equal(settledAsk('yoobaland', { criteria: ['dash works'] }), false, 'another product');
});

test('the carried plays are deduped, settled ones dropped, the rest fit a budget shortest first, the run\'s own always play', () => {
  const est = (a: { scenario?: string }) => ({ own: 100, long: 900, mid: 300, short: 120, settled: 60 } as Record<string, number>)[a.scenario ?? 'own'] ?? 100;
  const own = [{ scenario: 'own', criteria: ['x'] }];
  const carried = [
    { scenario: 'long', criteria: ['shop opens'] }, { scenario: 'short', criteria: ['shop opens'] }, { scenario: 'mid', criteria: ['shop opens'] },
    { scenario: 'short', criteria: ['more'] }, { scenario: 'settled', criteria: ['dash works'] }, { scenario: 'own', criteria: ['y'] },
  ];
  const plan = planCarried('sickofit', own, carried, est, { max: 6, budgetS: 600 });
  assert.deepEqual(plan.plays.map((x) => x.scenario), ['own', 'short', 'mid'], 'the long one is over the 10 minutes');
  assert.deepEqual(plan.plays[0].criteria, ['x', 'y'], 'the same scenario carried over joins the run\'s own play');
  assert.deepEqual(plan.plays[1].criteria, ['shop opens', 'more']);
  assert.deepEqual(plan.plays.map((x) => Boolean(x.carried)), [false, true, true]);
  assert.deepEqual(plan.dropped.map((d) => d.ask.scenario), ['settled']);
  assert.deepEqual(plan.deferred.map((d) => d.ask.scenario), ['long']);
  assert.match(plan.deferred[0].why, /10 minutes/);
  const capped = planCarried('sickofit', [], carried, est, { max: 1, budgetS: 3600 });
  assert.equal(capped.plays.length, 1);
  assert.equal(capped.deferred.length, 3, "long, mid and the carried copy of own: four unsettled, one fits");
  assert.match(capped.deferred[0].why, /1 carried-over/);
});

test('only changes a player can\'t see leave a clean pass standing', () => {
  assert.equal(noRuntimeChange([]), false, 'a merge that kept the files is played again');
  assert.equal(noRuntimeChange(['docs/Story.md', 'LevelDesign.md', '.hawkes/summary.md', 'videos/a/cut.json', 'README.md']), true);
  assert.equal(noRuntimeChange(['docs/Story.md', 'Assets/GameConfig/levels.json']), false);
  assert.equal(noRuntimeChange(['src/game/main.ts']), false);
});

let n = 0;
const play = (name: string, sha: string, o: { outcome?: string; status?: string; dirty?: boolean; at?: number } = {}) =>
  db.prepare('INSERT INTO steps (id, run, product, kind, name, status, data, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`s_pp${++n}`, 'r_pp', 'sickofit', 'playtest', name, o.status ?? 'done', J({ outcome: o.outcome ?? 'won', played: { sha, dirty: o.dirty ? 3 : 0 } }), o.at ?? Date.now() + n, (o.at ?? Date.now()) + 60_000 + n);

test('the last clean pass of a scenario: won or done, clean checkout', () => {
  play('smoke@local', 'aaa111', { at: 1000 });
  play('smoke@local', 'bbb222', { outcome: 'error', at: 2000 });
  play('smoke@local', 'ccc333', { dirty: true, at: 3000 });
  play('smoke@local', 'ddd444', { status: 'failed', at: 4000 });
  assert.equal(lastCleanPass('sickofit', 'smoke@local')?.sha, 'aaa111');
  assert.equal(lastCleanPass('sickofit', 'nothing@local'), null);
});

test('go live accepts a clean pass of an earlier commit when only docs changed since, and never an error or a code change', () => {
  const sha = 'eee555';
  play('menus@local', 'fff666', { at: 5000 });          // clean, earlier commit, docs only since
  play('layout@local', 'ggg777', { at: 5000 });         // clean, earlier commit, code changed since
  play('codex@local', 'hhh888', { outcome: 'error', at: 5000 }); // errored: never carried
  play('smoke@local', sha, { at: 6000 });               // exact play
  const seen: string[] = [];
  const r = testedAt('sickofit', sha, (from) => { seen.push(from); return from === 'fff666' || from === 'aaa111'; });
  const by = Object.fromEntries(r.tested.map((t) => [t.name, t]));
  assert.ok(by['smoke@local'] && !by['smoke@local'].carriedFrom, 'the exact play stands as it was');
  assert.equal(by['menus@local'].carriedFrom, 'fff666');
  assert.match(by['menus@local'].detail as string, /only docs and notes changed/);
  assert.equal(by['layout@local'], undefined);
  assert.equal(by['codex@local'], undefined);
  assert.equal(testedAt('sickofit', sha).tested.length, 1, 'with no way to compare, only the exact play counts');
  assert.equal(new Set(seen).size, seen.length, 'each earlier commit is compared once');
});

test('the audit counts plays, minutes, outcomes, reviews with nothing new, and the findings a scenario filed', () => {
  const t0 = Date.now() - 86400_000;
  const runs = [
    { id: 'r1', kind: 'beta', status: 'done', started: t0 }, { id: 'r2', kind: 'beta', status: 'skipped', started: t0 }, { id: 'r3', kind: 'daily', status: 'done', started: t0 },
  ];
  const st = (run: string, kind: string, name: string, status: string, data: unknown, detail: string | null, min: number) =>
    ({ run, product: 'sickofit', kind, name, status, detail, data, started: t0, finished: t0 + min * 60000 });
  const steps = [
    st('r1', 'playtest', 'smoke@local', 'done', { outcome: 'won' }, null, 2), st('r1', 'review', 'smoke@local', 'done', { findings: [] }, 'ship · verify · 0 findings (0 new, 1 known still there)', 0),
    st('r1', 'playtest', 'style@local', 'done', { outcome: 'error' }, null, 1), st('r1', 'review', 'style@local', 'done', { findings: [{}] }, 'fix-first · verify · 1 findings (1 new)', 0),
    st('r2', 'playtest', 'smoke@local', 'skipped', null, 'cancelled', 5),
    st('r3', 'playtest', 'smoke@local', 'failed', null, 'stuck: ran for over 60 min', 60),
  ];
  const findings = [
    { product: 'sickofit', scenario: 'style@local', severity: 'bug', status: 'fixed', first_seen: t0, source: null },
    { product: 'sickofit', scenario: 'style@local', severity: 'polish', status: 'wontfix', first_seen: t0, source: null },
    { product: 'sickofit', scenario: 'J', severity: 'bug', status: 'fixed', first_seen: t0, source: 'J' },
  ];
  const a = auditRows(runs, steps as any, findings as any, t0 - 1000);
  const smoke = a.scenarios.find((x) => x.key === 'sickofit/smoke@local')!;
  assert.deepEqual([smoke.plays, smoke.skipped, smoke.ok, smoke.failed, smoke.reviews, smoke.nothingNew, smoke.minutes], [2, 1, 1, 1, 1, 1, 62]);
  const style = a.scenarios.find((x) => x.key === 'sickofit/style@local')!;
  assert.deepEqual([style.error, style.newFindings, style.filed, style.real, style.fixed], [1, 1, 2, 1, 1]);
  assert.equal(a.scenarios.find((x) => x.key === 'sickofit/J'), undefined, "J's own reports are not a scenario's catch");
  const beta = a.kinds.find((k) => k.kind === 'beta')!;
  assert.deepEqual([beta.runs, beta.superseded, beta.plays, beta.longest], [2, 1, 2, 2]);
  assert.equal(newIn('x · 3 findings (2 new, 1 known)', null), 2);
});

test('a job can be queued ahead of the others (priority) and normal jobs send none', async () => {
  const sent: any[] = [];
  const api = { submit: async (_t: string, b: any) => (sent.push(b), { id: 'j1', status: 'done', detail: '' }), job: async () => ({ id: 'j1', status: 'done' }), cancel: async () => ({}) };
  await runGenJob('playtest.run', 'sickofit', {}, () => {}, { runMs: 1000, api, pollMs: 1, priority: 5 });
  await runGenJob('playtest.run', 'sickofit', {}, () => {}, { runMs: 1000, api, pollMs: 1 });
  assert.equal(sent[0].priority, 5);
  assert.equal('priority' in sent[1], false);
});

test('a run that takes over plays says so in its plan: scenarios added once, one note', async () => {
  const { planRun, planChange, planView } = await import('../src/runplan.ts');
  db.prepare('INSERT INTO runs (id, kind, status, options, started) VALUES (?, ?, ?, ?, ?)').run('r_pc', 'beta', 'running', '{}', Date.now());
  planRun('r_pc', [{ product: 'sickofit', name: 'smoke@local' }]);
  planChange('r_pc', 'sickofit', ['smoke@local', 'menus@local'], 'this run plays 2 scenario(s); deferred 1');
  const v = planView('r_pc')!;
  assert.deepEqual(v.items.map((x) => x.name), ['smoke@local', 'menus@local']);
  assert.equal(v.notes.length, 1);
  assert.match(v.notes[0].text, /deferred 1/);
});
