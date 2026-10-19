// The studio's pace (J, 2026-10-19: "Make this entire system faster"): beta checks play their tasks' scenarios in
// parallel across the playtester's slots, with a start point ("at") when the task gave one; a scenario over its time
// budget is flagged; idle agent slots with nothing to start get ONE question for J with scouts' proposals; and
// "where the time goes" adds up today. Scratch database, no agents, GitHub, Gen or Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-pace-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_PM_TALK = 'off';
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE', 'NTFY_TOPIC', 'STUDIO_BETA_PLAYS_PARALLEL', 'STUDIO_SCENARIO_BUDGET_S', 'STUDIO_IDLE_MS']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'notify.json'), JSON.stringify({ enabled: false, topic: 'test' }));
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
const ids = ['pcbusy', 'pcidle', 'pcbug'];
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: Object.fromEntries(ids.map((id) => [id, `x/${id}`])),
  products: ids.map((id) => ({
    id, name: id, framing: 'test', engine: 'static', repo: id, site: id, live: 'http://127.0.0.1:9/',
    local: { serve: 'static', dir: id, port: 8794, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
  })),
  infra: [],
}));

const pace = await import('../src/pace.ts');
const pipeline = await import('../src/pipeline.ts');
const rm = await import('../src/roadmap.ts');
const pm = await import('../src/pm.ts');
const { db, J } = await import('../src/db.ts');
await import('../src/agents.ts'); // the changes table

test('independent plays run in parallel across the slots; stop ends them; one error never stops the others', async () => {
  let running = 0;
  let most = 0;
  const seen: [string, number][] = [];
  await pipeline.inSlots(['a', 'b', 'c', 'd', 'e'], 2, async (x, slot) => {
    running++;
    most = Math.max(most, running);
    seen.push([x, slot]);
    await new Promise((r) => setTimeout(r, 20));
    running--;
  });
  assert.equal(most, 2, 'two at a time');
  assert.deepEqual(seen.map(([x]) => x).sort(), ['a', 'b', 'c', 'd', 'e'], 'each played once');
  assert.deepEqual([...new Set(seen.map(([, s]) => s))].sort(), [0, 1], 'on their own slots (ports)');
  // A newer build: the rest isn't started.
  const played: string[] = [];
  await pipeline.inSlots(['a', 'b', 'c'], 1, async (x) => { played.push(x); }, () => played.length >= 1);
  assert.deepEqual(played, ['a']);
  // An error is thrown once every play is over.
  const done: string[] = [];
  await assert.rejects(pipeline.inSlots(['bad', 'ok1', 'ok2'], 2, async (x) => {
    if (x === 'bad') throw new Error('boom');
    await new Promise((r) => setTimeout(r, 10));
    done.push(x);
  }), /boom/);
  assert.deepEqual(done.sort(), ['ok1', 'ok2']);
  assert.equal(pipeline.BETA_PLAYS_PARALLEL(), 2, "the playtester's two slots by default");
});

test('a start point ("at") goes to the game in its options; none is today\'s behaviour', () => {
  assert.equal(pipeline.playOptions({}), undefined);
  assert.deepEqual(pipeline.playOptions({ options: { stage: 'pit' } }), { stage: 'pit' });
  assert.deepEqual(pipeline.playOptions({ options: { stage: 'pit' }, at: 'chapter-3' }), { stage: 'pit', at: 'chapter-3' });
  assert.deepEqual(pipeline.playOptions({ at: '  ' }), undefined);
  // Over the API too (studio_playtest { at }).
  assert.equal(pipeline.playtestRequest({ scenario: 'story2', at: 'gloob-house' }).at, 'gloob-house');
  assert.equal('at' in pipeline.playtestRequest({ scenario: 'story2' }), false);
});

test("the web helper hands the start point to the bot and logs it; without it nothing changes", async () => {
  const g = globalThis as any;
  const saved = { window: g.window, location: g.location, addEventListener: g.addEventListener, requestAnimationFrame: g.requestAnimationFrame };
  g.window = {};
  g.location = { search: '' };
  g.addEventListener = () => {};
  g.requestAnimationFrame = () => 0;
  try {
    const { installPlaytest } = await import('../clients/web/hawkes-playtest.js' as string);
    const got: (string | null)[] = [];
    const api = installPlaytest({ product: 'x', scenarios: [{ id: 'story', title: 'Story', seconds: 60, starts: ['chapter-3'] }], start: async (_id: string, _o: any, t: any) => { got.push(t.at); t.finish('done'); } });
    await api.start('story', { at: 'chapter-3' });
    assert.deepEqual(got, ['chapter-3']);
    assert.ok(api.report().events.some((e: any) => e.type === 'start-at' && e.detail === 'chapter-3'));
    await api.start('story');
    assert.deepEqual(got, ['chapter-3', null]);
    assert.ok(!api.report().events.some((e: any) => e.type === 'start-at'));
  } finally {
    Object.assign(g, saved);
  }
});

test('a scenario over its time budget is flagged; the evidence "not reached" is told apart from "can\'t tell"', () => {
  assert.equal(pace.slowNote(599), null);
  assert.match(pace.slowNote(601)!, /over the 10-minute budget/);
  assert.equal(pace.playTime(725), '12 min 5 s');
  assert.equal(pace.playTime(45), '45 s');
  const unclear = (evidence: string) => ({ criterion: evidence, met: 'unclear' as const, evidence });
  const reached = ['the playtest never reached the boss', 'Not reached: the bot stopped at floor 2', 'the run ended before the shop opened', "the bot didn't get to the second chapter", 'no event shows the door opening', 'not seen in any frame']
    .map(unclear);
  assert.equal(pace.notReached(reached).length, reached.length);
  assert.equal(pace.notReached([unclear('only one page checked'), unclear('the frames are too dark to tell'), { criterion: 'x', met: 'no', evidence: 'never reached' }]).length, 0);
});

test('idle slots with nothing to start: a scout per idle product, then ONE question for J, merged, not repeated', async () => {
  const now0 = Date.now();
  const asked: { text: string; o: any }[] = [];
  const scouts = new Map<string, { status: string; report: string | null; detail: string | null }>();
  let n = 0;
  const deps = (idle: string[]) => ({
    idleProducts: () => idle,
    startScout: (product: string) => {
      if ([...scouts.values()].filter((s) => s.status === 'running').length >= 2) throw new Error('Two scouts are already running');
      const id = `x_${product}${++n}`;
      scouts.set(id, { status: 'running', report: null, detail: 'reading' });
      return { id };
    },
    getScout: (id: string) => scouts.get(id) ?? null,
    askJ: (text: string, o: any) => { asked.push({ text, o }); return { id: 'q_idle' }; },
    log: () => {},
  });
  const d = deps(['pcidle', 'pcbug', 'pcbusy']);
  assert.equal(pace.idleWatch({ free: 0, started: 0 }, d, now0), 'busy');
  assert.equal(pace.idleWatch({ free: 2, started: 0 }, d, now0), 'waiting');
  assert.equal(pace.idleWatch({ free: 2, started: 0 }, d, now0 + 10 * 60_000), 'waiting', 'not before 30 minutes');
  // Something started: the clock starts again.
  assert.equal(pace.idleWatch({ free: 2, started: 1 }, d, now0 + 20 * 60_000), 'busy');
  assert.equal(pace.idleWatch({ free: 2, started: 0 }, d, now0 + 21 * 60_000), 'waiting');
  const t1 = now0 + 52 * 60_000;
  assert.equal(pace.idleWatch({ free: 2, started: 0 }, d, t1), 'scouting');
  assert.equal(scouts.size, 2, 'two scouts at a time');
  assert.equal(asked.length, 0, 'nothing asked while they read');
  // The two report; the third starts, then reports.
  for (const [id, s] of scouts) scouts.set(id, { ...s, status: 'done', report: `## What's there now\nstuff\n## Proposed roadmap item\n- Title: Next for ${id}\n- Goal: more\n## Questions for J\nnone` });
  assert.equal(pace.idleWatch({ free: 2, started: 0 }, d, t1 + 60_000), 'scouting');
  assert.equal(scouts.size, 3);
  for (const [id, s] of scouts) if (s.status === 'running') scouts.set(id, { ...s, status: 'failed', report: null, detail: 'the worktree failed' });
  assert.equal(pace.idleWatch({ free: 2, started: 0 }, d, t1 + 2 * 60_000), 'asked');
  assert.equal(asked.length, 1, 'ONE question');
  const q = asked[0];
  assert.equal(q.o.subject, pace.IDLE_SUBJECT, 'merged by subject');
  assert.equal(q.o.topic, 'idle');
  assert.match(q.text, /pcidle.*Title: Next for x_pcidle/);
  assert.match(q.text, /pcbusy.*no proposal \(the worktree failed\)/);
  assert.doesNotMatch(q.text, /Questions for J/, 'only the proposal');
  assert.match(q.text, /Nothing is added without your yes/);
  // Not repeated for the same idle products.
  assert.equal(pace.idleWatch({ free: 2, started: 0 }, d, t1 + 3 * 3600_000), 'already asked');
  assert.equal(asked.length, 1);
  // Nothing idle: nothing asked.
  assert.equal(pace.idleWatch({ free: 2, started: 0 }, deps([]), t1 + 4 * 3600_000), 'nothing idle');
});

test("the idle products are those with no planned or running work; the idle question is J's alone to answer", async () => {
  const it = rm.addItem({ product: 'pcbusy', title: 'Work', status: 'planned' });
  rm.addTask({ item: it.id, request: 'Something to do' });
  db.prepare(`INSERT INTO findings (id, product, key, title, severity, status, first_seen, last_seen, seen) VALUES ('f_pcbug0000001', 'pcbug', 'k', 'Crash', 'bug', 'open', 0, 0, 1)`).run();
  assert.deepEqual(pm.idleProducts(), ['pcidle']);
  const q = rm.addQuestion({ kind: 'decision', subject: pace.IDLE_SUBJECT, text: 'Idle: add these?', topic: 'idle', options: ['Yes: add them', 'Not now'] });
  await assert.rejects(pm.answerQuestion(q.id, 'yes', 'Talk (PM)'), /J's call/);
  const a = await pm.answerQuestion(q.id, 'Not now', 'J');
  assert.equal(a!.status, 'answered');
});

test('where the time goes: agents, merge to verified, builds, playtests, parked on Gen/GPU and idle slot-hours today', () => {
  const now = new Date(new Date().setHours(12, 0, 0, 0)).getTime();
  const min = 60_000;
  const change = (id: string, product: string, created: number, merged: number) => db.prepare(`INSERT INTO changes (id, product, findings, status, repo, title, notes, log, created, updated, merged_at) VALUES (?, ?, '[]', 'merged', ?, 'x', '[]', '[]', ?, ?, ?)`).run(id, product, product, created, merged, merged);
  change('c_pace00000001', 'pcbusy', now - 60 * min, now - 50 * min); // 10 min
  change('c_pace00000002', 'pcbusy', now - 60 * min, now - 30 * min); // 30 min
  change('c_pace00000003', 'pcidle', now - 60 * min, now - 40 * min); // 20 min
  change('c_pace00000004', 'hawkesstudio', now - 300 * min, now - 10 * min); // infra: left out
  const it = rm.addItem({ product: 'pcidle', title: 'Done', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'A thing' });
  rm.setTask(t.id, { status: 'verified', merged_at: now - 100 * min, verified_at: now - 40 * min }); // 60 min
  db.prepare(`INSERT INTO runs (id, kind, status, detail, products, started, finished) VALUES ('r_pace00000001', 'beta', 'done', 'beta', '["pcidle"]', ?, ?)`).run(now - 90 * min, now - 10 * min);
  const step = (id: string, kind: string, mins: number, data: any = {}) => db.prepare(`INSERT INTO steps (id, run, product, kind, name, status, data, started, finished) VALUES (?, 'r_pace00000001', 'pcidle', ?, ?, 'done', ?, ?, ?)`).run(id, kind, kind, J(data), now - 80 * min, now - 80 * min + mins * min);
  step('s_pace00000001', 'build', 6);
  step('s_pace00000002', 'playtest', 4);
  step('s_pace00000003', 'playtest', 14, { slow: 'over the 10-minute budget' });
  pace.samplePace({ freeSlots: 3, parked: 1 }, now - 60 * min);
  pace.samplePace({ freeSlots: 3, parked: 1 }, now - 57 * min); // 3 slots x 3 min, 1 x 3 min
  pace.samplePace({ freeSlots: 2, parked: 0 }, now - 27 * min); // a 30-minute gap counts 5 minutes: 2 x 5
  const r = pace.whereTimeGoes(now, (p) => p === 'hawkesstudio');
  assert.deepEqual(r.agent, { median: 20, n: 3 });
  assert.deepEqual(r.mergeToVerified, { median: 60, n: 1 });
  assert.deepEqual(r.build, { median: 6, total: 6, n: 1 });
  assert.deepEqual(r.playtest, { median: 9, total: 18, n: 2, slow: 1 });
  assert.equal(r.idleSlotHours, Math.round((9 + 10) / 6) / 10);
  assert.equal(r.parkedHours, 0.1);
  assert.match(r.lines.join('\n'), /Agents: median 20 min from start to merged \(3 changes today\)/);
  assert.match(r.lines.join('\n'), /1 over the 10-minute budget/);
  assert.match(r.lines.join('\n'), /Idle agent slots: 0\.3 slot-hours/);
});
