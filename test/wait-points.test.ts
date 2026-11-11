// One test per wait point (docs/stall-paths.md, src/waitpoints.ts): each plays the real gate and proves the wait ends on
// its own at its deadline, carries on in its lesser way, and never files a question for the owner. The test's name starts
// with the point's id in brackets; test/stall-paths.test.ts fails when a point listed as recorded here has no test.
// A scratch database; no GitHub, Gen, agents or Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-waitpoints-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_PM_TALK = 'off';
process.env.STUDIO_PM = 'off';
process.env.STUDIO_CHECKOUTS = '1';
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9'; // Gen doesn't answer
process.env.STUDIO_GEN_WAIT_END_MS = String(3600_000);
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE', 'NTFY_TOPIC']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'notify.json'), JSON.stringify({ enabled: false, topic: 'test' }));
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'agents.json'), JSON.stringify({ maxConcurrent: 1, perProduct: 1 }));
const ids = ['wpa', 'wpb', 'wpc', 'wpd', 'wpgame'];
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: Object.fromEntries(ids.map((id) => [id, `x/${id}`])),
  products: ids.map((id) => ({
    id, name: id, framing: 'test', engine: id === 'wpgame' ? 'babylon' : 'static', repo: id, site: id, live: 'http://127.0.0.1:9/',
    local: { serve: 'static', dir: id, port: 8794, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
  })),
  infra: [],
}));

const W = await import('../src/waits.ts');
const { pointOf } = await import('../src/waitpoints.ts');
const A = await import('../src/agents.ts');
const C = await import('../src/cpuroom.ts');
const U = await import('../src/unitybuild-policy.ts');
const CG = await import('../src/critic-gate.ts');
const { CRITIC_DIMENSIONS } = await import('../src/config.ts');
const rm = await import('../src/roadmap.ts');
const pm = await import('../src/pm.ts');
const ops = await import('../src/ops.ts');
const pace = await import('../src/pace.ts');
const { db, J } = await import('../src/db.ts');
const { providerDeps } = await import('../src/providers.ts');
Object.assign(providerDeps, { configured: () => true, installed: () => true, held: () => null });
const keep = setInterval(() => {}, 1000); // the waits' one timer is unref'd, like Studio's

const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const until = async (f: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };
/** The wait's row, its deadline moved into the past: the time it waited has run out. */
const runOut = (point: string, subject: string) => db.prepare('UPDATE waits SET deadline = ? WHERE point = ? AND subject = ?').run(Date.now() - 1, point, subject);
/** No question for the owner was filed: nothing in the questions table (the deadline never ends on him). */
const noQuestion = () => assert.equal(((() => { try { return (db.prepare('SELECT COUNT(*) AS n FROM questions').get() as any).n; } catch { return 0; } })()), 0, 'a wait that ran out asked the owner');
const row = (point: string, subject: string) => W.waitOf(point, subject)!;

let t0 = 5_000_000;
function addChange(id: string, product: string, status = 'queued', phase: unknown = null, extra: Record<string, unknown> = {}) {
  db.prepare('INSERT INTO changes (id, product, findings, status, detail, repo, base, worktree, title, request, notes, log, created, updated, phase) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, product, '[]', status, 'queued (test)', `${product}repo`, 'beta', (extra.worktree as string) ?? path.join(process.env.STUDIO_PROJECTS!, '.work', id), `Title ${id}`, `Request ${id}`, '[]', '[]', (t0 += 1000), null, phase ? J(phase) : null);
}
/** A stand-in for a change's pass: recorded when started, it ends when the test says. */
function passes() {
  const started: string[] = [];
  const enders = new Map<string, () => void>();
  A.passInternals.setRunPass(async (id: string) => {
    started.push(id);
    db.prepare(`UPDATE changes SET status = 'working' WHERE id = ?`).run(id);
    await new Promise<void>((r) => enders.set(id, r));
    A.patchChange(id, { status: 'merged', detail: 'merged (test)' });
  });
  return { started, end: (id: string) => enders.get(id)?.() };
}

test('[queue-slot] a change that waited past its deadline for a slot takes ONE overflow slot beside the full one', async () => {
  const p = passes();
  addChange('c_wp_q1', 'wpa'); addChange('c_wp_q2', 'wpb'); addChange('c_wp_q3', 'wpc');
  await A.pumpNow(); await settle();
  assert.deepEqual(p.started, ['c_wp_q1'], 'one slot: the oldest starts');
  const w2 = row('queue-slot', 'c_wp_q2');
  assert.equal(w2.state, 'pending');
  assert.ok(w2.deadline - w2.started <= pointOf('queue-slot')!.maxMs, 'its deadline is within the point\'s');
  assert.equal(W.waitOf('queue-slot', 'c_wp_q1'), null, 'the one that started waits for nothing');
  // Its time in the queue runs out (the others too): it starts beside the full slot; the next does not (one overflow).
  runOut('queue-slot', 'c_wp_q2'); runOut('queue-slot', 'c_wp_q3');
  await W.fireDue(); await settle();
  await A.pumpNow(); await settle();
  assert.deepEqual(p.started, ['c_wp_q1', 'c_wp_q2'], 'one overflow, in line order');
  assert.match(A.getChange('c_wp_q2')!.log.join('\n'), /overflow slot/);
  assert.equal(W.waitOf('queue-slot', 'c_wp_q2'), null, 'started: its wait is over');
  noQuestion();
  // Everything ends and the last one goes by the normal rule.
  p.end('c_wp_q1'); p.end('c_wp_q2'); await settle(40);
  await A.pumpNow(); await settle();
  assert.ok(p.started.includes('c_wp_q3'));
  p.end('c_wp_q3'); await settle(40);
});

test('[checkout-turn] a checkout that hangs passes its turn on at the deadline, recorded as ended by it', async () => {
  let finish!: () => void;
  const hung = A.checkoutSlot(() => new Promise<void>((r) => { finish = r; }), { turnMs: 40 });
  const next = A.checkoutSlot(async () => 'went', { turnMs: 5000 });
  assert.equal(await next, 'went');
  const ended = (db.prepare(`SELECT how FROM waits WHERE point = 'checkout-turn' AND state = 'ended'`).all() as { how: string }[]).map((r) => r.how);
  assert.ok(ended.includes('deadline'), 'the hung turn ended by its deadline');
  finish(); await hung;
  assert.equal(W.pendingWaits('checkout-turn').length, 0);
  noQuestion();
});

test('[cpu-turn] a start held for CPU room goes ahead at its deadline, and the turn is recorded', async () => {
  C.resetCpuRoom();
  delete process.env.STUDIO_CPU_ROOM;
  process.env.STUDIO_CPU_MAX_HOLD_MS = '60'; process.env.STUDIO_CPU_WAIT_MS = '10';
  C.roomHooks.limit = async () => 100; C.roomHooks.used = async () => 100; // full, and it stays full
  const t = Date.now();
  await C.cpuTurn(2, 'unit-wp-1');
  assert.ok(Date.now() - t < 2000, 'it did not wait for room that never came');
  assert.equal(row('cpu-turn', 'unit-wp-1').how, 'deadline');
  assert.ok(C.MAX_HOLD_MS() <= pointOf('cpu-turn')!.maxMs);
  delete process.env.STUDIO_CPU_MAX_HOLD_MS; delete process.env.STUDIO_CPU_WAIT_MS;
  C.resetCpuRoom();
  noQuestion();
});

test('[harness-cap] a change the harness stopped three times in an hour waits for the hour, then goes by itself', async () => {
  const p = passes();
  const now = Date.now();
  // Three stops in the last hour: capped. 'x' is no provider, so no stand-in takes it (providers.ts).
  addChange('c_wp_h1', 'wpd', 'queued', { step: 'agent', since: now, harness: { on: 'x', kind: 'usage', at: now - 1000, parks: [now - 3000, now - 2000, now - 1000] } });
  await A.pumpNow(); await settle();
  assert.ok(!p.started.includes('c_wp_h1'), 'capped: it does not start');
  const w = row('harness-cap', 'c_wp_h1');
  assert.equal(w.state, 'pending');
  assert.ok(w.deadline <= now + 3600_000 + 1000, 'its end is the hour: the oldest stop plus one hour');
  noQuestion();
  assert.notEqual(A.getChange('c_wp_h1')!.status, 'needs answer', 'never "needs answer" for the owner');
  // The hour passes (the stops are an hour old): it goes.
  db.prepare('UPDATE changes SET phase = ? WHERE id = ?').run(J({ step: 'agent', since: now, harness: { on: 'x', kind: 'usage', at: now - 4 * 3600_000, parks: [now - 4 * 3600_000, now - 5 * 3600_000, now - 6 * 3600_000], capped: true } }), 'c_wp_h1');
  await A.pumpNow(); await settle();
  assert.ok(p.started.includes('c_wp_h1'));
  assert.equal(row('harness-cap', 'c_wp_h1').how, 'event');
  p.end('c_wp_h1'); await settle(40);
});

test('[gen-wait] a change parked on Gen goes on without a job that never came, at the deadline, also after a restart', async () => {
  const wt = path.join(tmp, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  spawnSync('git', ['init', '-q', wt]);
  spawnSync('git', ['-C', wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x']);
  const since = Date.now() - 3 * 3600_000;
  addChange('c_wp_g1', 'wpd', 'waiting on Gen', { step: 'agent', since, gen: { since, jobs: [{ id: 'j_never', status: 'running' }] } }, { worktree: wt });
  A.saveAgentSettings({ maxConcurrent: 0 }); // nothing starts: only the wait is under test
  // The old process recorded the wait with its deadline (since + the end of the wait) and died: the new one finds it due.
  W.beginWait('gen-wait', 'c_wp_g1', { waitsOn: 'Gen job j_never', deadlineAt: since + A.genWaitEndMs(), since });
  assert.ok(W.waitOverdue('gen-wait', 'c_wp_g1'));
  const r = await W.rearmWaits();
  assert.ok(r.overdue >= 1);
  await until(() => A.getChange('c_wp_g1')!.status === 'queued');
  assert.equal(A.phaseOf('c_wp_g1')!.gen!.jobs[0].status, 'timed out', 'the unfinished job is given up on, the agent goes on without it');
  assert.equal(row('gen-wait', 'c_wp_g1').how, 'deadline');
  A.saveAgentSettings({ maxConcurrent: 1 });
  noQuestion();
});

test('[unity-hold] merged Unity work held for the milestone\'s build is built anyway once it has waited 6 h', () => {
  const now = Date.now();
  const work = (since: number) => ({ name: 'Game', milestone: null, changes: ['c_x'], tasks: [], unbuiltSince: since, now });
  const held = U.unityBuildVerdict('auto', work(now - 3600_000));
  assert.equal(held.go, false);
  U.recordHold('wpgame', work(now - 3600_000), held);
  const w = row('unity-hold', 'wpgame');
  assert.equal(w.state, 'pending');
  assert.equal(w.deadline, now - 3600_000 + U.UNITY_HOLD_MAX_MS(), 'the deadline is 6 h after the oldest unbuilt merge');
  assert.ok(U.UNITY_HOLD_MAX_MS() <= pointOf('unity-hold')!.maxMs);
  const due = U.unityBuildVerdict('auto', work(now - U.UNITY_HOLD_MAX_MS() - 1000));
  assert.equal(due.go, true, 'past the deadline: one build of beta\'s head');
  U.recordHold('wpgame', work(now - U.UNITY_HOLD_MAX_MS() - 1000), due);
  assert.equal(row('unity-hold', 'wpgame').how, 'event', 'the hold is over');
  noQuestion();
});

let n = 0;
const mergedTask = (product: string, title: string, at: number) => {
  const it = rm.addItem({ product, title, status: 'planned' });
  const t = rm.addTask({ item: it.id, request: title });
  const c = `c_wpm${String(++n).padStart(9, '0')}`;
  db.prepare(`INSERT INTO changes (id, product, findings, status, repo, slug, branch, base, worktree, title, notes, log, created, updated, task, verify, merged_at)
    VALUES (?, ?, '[]', 'merged', ?, ?, 'task/x', 'beta', ?, 'A change', '[]', '[]', ?, ?, ?, '{}', ?)`).run(c, product, product, `x/${product}`, path.join(tmp, 'none', c), Date.now(), Date.now(), t.id, at);
  rm.setTask(t.id, { status: 'merged', change: c, changes: [c], tries: 1, merged_at: at + 2000 });
  return t.id;
};
const betaRun = (product: string, status: string, started: number) => {
  const id = `r_wpm${String(++n).padStart(9, '0')}`;
  db.prepare(`INSERT INTO runs (id, kind, status, detail, products, started, finished) VALUES (?, 'beta', ?, ?, ?, ?, ?)`).run(id, status, `beta ${product}`, J([product]), started, started + 1000);
  return id;
};

test('[beta-build] merged work waits for beta\'s own build with a recorded deadline, and a run that built ends it', async () => {
  const at = Date.now() - 5 * 60_000;
  mergedTask('wpb', 'A merged task', at);
  await pm.followBuilds();
  const w = row('beta-build', 'wpb');
  assert.equal(w.state, 'pending');
  assert.ok(w.deadline <= Date.now() + 15 * 60_000 + 1000, 'the PM starts the build 20 min after the merge');
  assert.equal(w.started, at, 'counted from the merge, not from when it was first looked at');
  betaRun('wpb', 'done', at + 1000);
  await pm.followBuilds();
  assert.equal(row('beta-build', 'wpb').how, 'event');
  noQuestion();
});

test('[milestone-recheck] a milestone waiting for beta\'s next build has a recorded deadline, and a run of the product ends it', () => {
  const m = rm.addMilestone({ product: 'wpc', title: 'A milestone' });
  const at = Date.now() - 60_000;
  rm.logDecision('milestone-recheck', m.id, 'wpc', 'not reached: checked again after beta\'s next build');
  const decided = rm.listDecisions({ since: 0, action: 'milestone-recheck', limit: 10 }).find((d) => d.subject === m.id)!;
  assert.equal(pm.recheckDue(m.id, ['wpc']), false, 'no build since: it waits');
  const w = row('milestone-recheck', m.id);
  assert.equal(w.state, 'pending');
  assert.equal(w.deadline, decided.at + 2 * 3600_000 + 1000, 'a miss waits at most 2 h for a build');
  assert.ok(w.deadline - w.started <= pointOf('milestone-recheck')!.maxMs);
  betaRun('wpc', 'done', decided.at + 5000);
  assert.equal(pm.recheckDue(m.id, ['wpc']), true, 'beta built again: the check is due');
  assert.equal(row('milestone-recheck', m.id).how, 'event');
  void at; noQuestion();
});

test('[milestone-critic] a milestone no critic ever agrees to is reached at the deadline without it; a newer critic opens it sooner', () => {
  const mk = (title: string) => {
    const m = rm.addMilestone({ product: 'wpgame', title });
    const it = rm.addItem({ product: 'wpgame', title: `${title} item`, status: 'planned', milestone: m.id });
    const t = rm.addTask({ item: it.id, request: 'make it feel good', axis: 'feel' });
    rm.setTask(t.id, { status: 'merged', bar: { axis: 'feel' } } as any);
    return m.id;
  };
  const a = mk('Frozen');
  const first = CG.milestoneCriticStatus(a);
  assert.equal(first.waiting, true, 'no critic yet: waiting');
  assert.equal(row('milestone-critic', a).state, 'pending');
  assert.ok(row('milestone-critic', a).deadline - row('milestone-critic', a).started <= pointOf('milestone-critic')!.maxMs);
  // The deadline: it is reached without the critic, and says so. Never a question.
  runOut('milestone-critic', a);
  const late = CG.milestoneCriticStatus(a);
  assert.equal(late.ready, true);
  assert.match(late.line, /didn't agree within 6 h/);
  assert.equal(row('milestone-critic', a).how, 'deadline');
  // The frozen check runs: a critic that ran on a beta run AFTER the check opens the gate before the deadline.
  const b = mk('Newer critic');
  assert.equal(CG.milestoneCriticStatus(b).waiting, true);
  const r = betaRun('wpgame', 'done', Date.now() + 1000);
  const scores = CRITIC_DIMENSIONS.map((dimension) => ({ dimension, score: 9, why: 'good', fix: 'none', reference: 'Hades' }));
  db.prepare(`INSERT INTO steps (id, run, product, kind, name, status, detail, data, started) VALUES (?, ?, 'wpgame', 'critic', 'critic', 'done', '', ?, ?)`).run(`s_wp_critic`, r, J({ verdict: 'judged', scores, summary: 's' }), Date.now() + 2000);
  const opened = CG.milestoneCriticStatus(b);
  assert.equal(opened.ready, true, 'the critic that ran after the check counts, not only the frozen check runs');
  assert.equal(row('milestone-critic', b).how, 'event');
  noQuestion();
});

test('[investigation-recheck] a re-check that played nothing plays again or is settled in the log: never forgotten, never a question', async () => {
  const t1 = mergedTask('wpd', 'Held under an investigation', Date.now() - 3600_000);
  const state = path.join(process.env.STUDIO_DATA!, 'pm-state.json');
  const write = (run: string, tries: number) => fs.writeFileSync(state, JSON.stringify({ rechecks: { wpd: { run, tasks: [t1], at: Date.now() - 60_000, tries, change: 'c_inv' } } }));
  pm.savePmSettings({ enabled: false }); // the replay itself (a beta run) is not under test; the end of the wait is
  // No run was ever started: the wait is read as "played nothing", the tasks are left for the milestone's check, said in the log.
  write('', 3);
  W.beginWait('investigation-recheck', 'wpd', { waitsOn: 'a beta run (none started)', renew: true });
  await pm.settleRechecks();
  assert.equal(row('investigation-recheck', 'wpd').state, 'ended', 'the wait is over');
  assert.match(rm.listDecisions({ action: 'recheck', limit: 20 }).map((d) => d.detail).join('\n'), /played nothing/);
  assert.equal(rm.getTask(t1)!.status, 'merged', 'not failed, not a try');
  // A run that played (a done playtest, nothing broke) ends it as played.
  const run = betaRun('wpd', 'done', Date.now() - 30_000);
  db.prepare(`INSERT INTO steps (id, run, product, kind, name, status, detail, data, started) VALUES ('s_wp_play', ?, 'wpd', 'playtest', 'smoke', 'done', '', NULL, ?)`).run(run, Date.now() - 20_000);
  write(run, 0);
  W.beginWait('investigation-recheck', 'wpd', { waitsOn: 'a beta run', renew: true });
  await pm.settleRechecks();
  assert.equal(row('investigation-recheck', 'wpd').how, 'event');
  // A run still going past the deadline is read as one that played nothing too (its deadline ends the wait).
  const going = `r_wp_going`;
  db.prepare(`INSERT INTO runs (id, kind, status, detail, products, started) VALUES (?, 'beta', 'running', 'beta wpd', ?, ?)`).run(going, J(['wpd']), Date.now() - 30_000);
  write(going, 3);
  W.beginWait('investigation-recheck', 'wpd', { waitsOn: 'a beta run', renew: true });
  runOut('investigation-recheck', 'wpd');
  await pm.settleRechecks();
  assert.equal(row('investigation-recheck', 'wpd').state, 'ended');
  assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).rechecks?.wpd, undefined, 'the re-check is closed');
  pm.savePmSettings({ enabled: true });
  noQuestion();
});

test('[ops-wait] an operation parked on a run is woken by its end, or by its deadline when no event comes', async () => {
  ops.registerOp('test-wp-wait', async (_p, ctx) => { if (!ctx.op.log.some((l) => /woken|running again/.test(l))) throw new ops.OpWaits('beta is being played', 'r_never'); return { went: true }; });
  const o = ops.enqueue('test-wp-wait', { product: 'wpa', title: 'waits on a run', payload: {} });
  await until(() => ops.getOp(o.id)!.status === 'waiting');
  const w = row('ops-wait', o.id);
  assert.equal(w.state, 'pending');
  assert.ok(w.deadline - w.started <= pointOf('ops-wait')!.maxMs);
  // The run it waits on never ends (nobody sends the event): the deadline wakes it and it runs again from the top.
  runOut('ops-wait', o.id);
  await W.fireDue();
  await until(() => ops.getOp(o.id)!.status === 'done');
  assert.equal(row('ops-wait', o.id).how, 'deadline');
  assert.match(ops.getOp(o.id)!.log.join('\n'), /running again from the top/);
  // And the event still ends it first when it comes.
  const e = ops.enqueue('test-wp-wait', { product: 'wpb', title: 'woken by its run', payload: { again: 1 } });
  await until(() => ops.getOp(e.id)!.status === 'waiting');
  assert.equal(ops.wakeOps({ product: 'wpb', run: 'r_never' }), 1);
  assert.equal(row('ops-wait', e.id).how, 'event');
  await until(() => ops.getOp(e.id)!.status === 'done');
  noQuestion();
});

test('[idle-roadmap] idle slots are a recorded wait; at its deadline the scouts go, and the owner is asked only after they report or their own deadline', () => {
  const now = Date.now();
  const asked: unknown[] = [];
  const deps = { idleProducts: () => ['wpa'], startScout: () => ({ id: 'x_wp1' }), getScout: () => ({ status: 'running', report: null, detail: null }), askJ: (...a: unknown[]) => { asked.push(a); return { id: 'q' }; }, log: () => {} };
  assert.equal(pace.idleWatch({ free: 2, started: 0 }, deps, now), 'waiting');
  const w = row('idle-roadmap', 'idle-slots');
  assert.equal(w.state, 'pending');
  assert.equal(w.deadline, now + pace.IDLE_MS(), 'the deadline is the idle time');
  assert.equal(pace.idleWatch({ free: 2, started: 0 }, deps, now + pace.IDLE_MS() + 1000), 'scouting', 'the deadline: the scouts go');
  assert.equal(asked.length, 0, 'nothing asked yet: the scouts get their own time');
  assert.equal(row('idle-roadmap', 'scouts').state, 'pending');
  assert.equal(pace.idleWatch({ free: 2, started: 0 }, deps, now + pace.IDLE_MS() + 4 * 3600_000), 'asked', 'past the scouts\' deadline it goes on with what is in');
  assert.equal(row('idle-roadmap', 'scouts').how, 'deadline');
  assert.equal(pace.idleWatch({ free: 0, started: 0 }, deps, now + 5 * 3600_000), 'busy');
  assert.equal(row('idle-roadmap', 'idle-slots').how, 'event', 'work arriving ends the wait');
  clearInterval(keep);
});
