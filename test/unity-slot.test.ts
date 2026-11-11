// One Unity build per product in Hawkes Gen (J, 2026-11-11: "THERE SHOULD NEVER BE THAT MANY QUEUED BUILDS"; that day 77
// unity.build executions sat queued in us-west1). Every Unity build goes through gen.ts genRun('unity.build'), which sends
// it through its product's slot (unityslot.ts). A stand-in Gen (submit, job, jobs, cancel) counts what is outstanding per
// project at every step; nothing real is touched.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-unity-slot-'));

const { genRun } = await import('../src/gen.ts');
const { noEvents } = await import('../src/genevents.ts');
const { resetUnitySlots, unitySlotState, nudgeUnitySlot, unityIdentity } = await import('../src/unityslot.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 5000, what = 'it') {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}

const OPEN = new Set(['queued', 'running']);

/** A stand-in Gen: unity.build jobs by id, with the most ever outstanding for one project at once. */
function fakeGen() {
  const jobs = new Map<string, any>();
  const submits: any[] = [];
  const cancels: string[] = [];
  let n = 0;
  let maxOutstanding = 0;
  // A submit while Gen already held an outstanding unity.build of the same project.
  let badSubmits = 0;
  const outstanding = (project: string) => [...jobs.values()].filter((j) => j.project === project && OPEN.has(j.status)).length;
  const check = () => {
    for (const p of new Set([...jobs.values()].map((j) => j.project))) maxOutstanding = Math.max(maxOutstanding, outstanding(p));
  };
  const api = {
    async submit(tool: string, body: any) {
      if (outstanding(body.project) > 0) badSubmits++;
      const j = { id: `j_${++n}`, tool, project: body.project, params: body.params, status: 'queued', detail: 'queued' };
      jobs.set(j.id, j);
      submits.push(j);
      check();
      return { ...j };
    },
    async job(id: string) {
      const j = jobs.get(id);
      if (!j) throw Object.assign(new Error('no such job'), { status: 404 });
      return { ...j };
    },
    async jobs(q: Record<string, string>) {
      return [...jobs.values()].filter((j) => (!q.tool || j.tool === q.tool) && (!q.status || j.status === q.status)).map((j) => ({ id: j.id, tool: j.tool, project: j.project, status: j.status }));
    },
    async cancel(id: string) {
      cancels.push(id);
      const j = jobs.get(id);
      if (j && OPEN.has(j.status)) j.status = 'cancelled';
      return j ? { ...j } : {};
    },
  };
  return {
    api, jobs, submits, cancels, outstanding, check,
    get maxOutstanding() { return maxOutstanding; },
    get badSubmits() { return badSubmits; },
    /** A job Gen holds from before (another Studio process, a restart). */
    preload(j: any) { jobs.set(j.id, { tool: 'unity.build', status: 'queued', ...j }); check(); },
    settle(id: string, status = 'done') { const j = jobs.get(id); j.status = status; if (status === 'done') j.result = { ok: true }; },
    open(project?: string) { return [...jobs.values()].filter((j) => OPEN.has(j.status) && (!project || j.project === project)); },
  };
}

const build = (sha: string, path = 'Game') => ({ github: { repo: 'x/game', commit: sha, token: 't', ref: 'beta' }, path, target: 'web', out: 'artifact' });
const compile = (sha: string, path = 'Game') => ({ github: { repo: 'x/game', commit: sha, token: 't', ref: 'task/x' }, check: true, path, target: 'web' });
const packageBuild = () => ({ project: 'Game', site: 'site', method: 'Build.Web', projectDir: 'work/game', siteDir: 'work/site' });

let g: ReturnType<typeof fakeGen>;
const run = (product: string, params: Record<string, unknown>, o: Record<string, any> = {}) =>
  genRun('unity.build', product, params, o.onUpdate, o.timeoutMs ?? 600_000, { api: g.api as any, events: noEvents, pollMs: 2, ...o });

beforeEach(() => { resetUnitySlots(); g = fakeGen(); });

test('identity: the commit, compile check or player build, and the path; a local folder build or a site push matches nothing', () => {
  assert.equal(unityIdentity(build('ABC')), 'build|abc|Game');
  assert.equal(unityIdentity(compile('abc')), 'check|abc|Game');
  assert.notEqual(unityIdentity(build('abc', 'A')), unityIdentity(build('abc', 'B')));
  assert.equal(unityIdentity(packageBuild()), null);
  assert.equal(unityIdentity({ github: { repo: 'r', commit: 'abc', siteRepo: 's', branch: 'beta' } }), null);
});

test('a build, a compile check and a package build at once: one in Gen, one waiting, the replaced one ends at once', async () => {
  const a = run('p', build('aaa'));
  await until(() => g.submits.length === 1, 5000, 'the first submit');
  const b = run('p', compile('bbb'));
  await until(() => unitySlotState('p').waiter?.key === 'check|bbb|Game', 5000, 'the check waiting');
  const c = run('p', packageBuild());
  // The compile check that waited is replaced by the newer package build, at once (not when the slot frees).
  const rb: any = await b;
  assert.equal(rb.status, 'cancelled');
  assert.equal(rb.superseded, true);
  assert.equal(rb.halted, true);
  assert.equal(g.submits.length, 1, 'nothing more went to Gen while the first holds the slot');
  assert.ok(unitySlotState('p').waiter?.key.startsWith('once:'), 'the package build is the one waiting');
  g.settle('j_1');
  assert.equal((await a).status, 'done');
  await until(() => g.submits.length === 2, 5000, 'the package build submitted');
  assert.equal(g.submits[1].params.projectDir, 'work/game');
  g.settle('j_2');
  assert.equal((await c).status, 'done');
  assert.equal(g.maxOutstanding, 1, 'never two unity.build jobs of one product outstanding');
  assert.deepEqual(unitySlotState('p'), { holder: null, waiter: null });
});

test('the same build asked twice (a push and a retry of one commit): one submit, both get its result', async () => {
  const ids: string[] = [];
  const a = run('p', build('abc'), { onSubmit: (id: string) => ids.push(id) });
  const b = run('p', build('abc'), { onSubmit: (id: string) => ids.push(id) });
  await until(() => g.submits.length === 1);
  const c = run('p', compile('zzz'));
  await until(() => unitySlotState('p').waiter !== null);
  // The same build again while another waits: it joins the one in Gen, not the waiting one.
  const d = run('p', build('abc'));
  await sleep(20);
  assert.equal(g.submits.length, 1);
  g.settle('j_1');
  const [ra, rb, rd]: any[] = await Promise.all([a, b, d]);
  assert.equal(ra.id, 'j_1');
  assert.equal(rb.id, 'j_1');
  assert.equal(rd.id, 'j_1');
  assert.equal(rb.status, 'done');
  assert.deepEqual(ids, ['j_1'], 'one submit, one onSubmit');
  await until(() => g.submits.length === 2);
  g.settle('j_2');
  assert.equal((await c).status, 'done');
  // A request the same as the one waiting joins that one.
  const e = run('p', build('e1'));
  await until(() => g.submits.length === 3);
  const f1 = run('p', compile('f'));
  const f2 = run('p', compile('f'));
  await until(() => unitySlotState('p').waiter !== null);
  g.settle('j_3');
  await e;
  await until(() => g.submits.length === 4);
  g.settle('j_4');
  const [r1, r2]: any[] = await Promise.all([f1, f2]);
  assert.equal(r1.id, 'j_4');
  assert.equal(r2.id, 'j_4');
  assert.equal(g.maxOutstanding, 1);
});

test('the slot is per product: another product builds at once', async () => {
  const a = run('p1', build('aaa'));
  await until(() => g.submits.length === 1);
  const b = run('p2', build('aaa'));
  await until(() => g.submits.length === 2, 5000, "p2's submit while p1 builds");
  assert.equal(g.submits[1].project, 'p2');
  g.settle('j_1');
  g.settle('j_2');
  assert.equal((await a).status, 'done');
  assert.equal((await b).status, 'done');
});

test('a wait that times out cancels its Gen job, and the next request gets the slot', async () => {
  const pa = run('p', build('slow'), { timeoutMs: 30 });
  await until(() => g.submits.length === 1);
  g.jobs.get('j_1').status = 'running'; // the limit counts from Gen's start (genWait fromStart), not the submit
  const a: any = await pa;
  assert.equal(a.timedOut, true);
  assert.deepEqual(g.cancels, ['j_1'], 'the timed-out job is cancelled, never left behind');
  assert.equal(g.jobs.get('j_1').status, 'cancelled');
  const b = run('p', build('next'));
  await until(() => g.submits.length === 2);
  g.settle('j_2');
  assert.equal((await b).status, 'done');
  assert.equal(g.maxOutstanding, 1);
});

test('a job still queued in Gen is never timed out; the limit starts when Gen starts it', async () => {
  const p = run('p', build('queued'), { timeoutMs: 30 });
  await until(() => g.submits.length === 1);
  await sleep(120); // four times the limit, queued
  assert.deepEqual(g.cancels, [], 'still waiting in the queue: not cancelled');
  g.jobs.get('j_1').status = 'running';
  await sleep(10);
  g.settle('j_1');
  const r: any = await p;
  assert.equal(r.status, 'done');
  assert.ok(r.queuedMs >= 100, `queue time told apart: ${r.queuedMs}`);
  assert.ok(r.ranMs >= 0 && r.ranMs < 30);
  assert.deepEqual(g.cancels, []);
});

test('a halt cancels the Gen job; a halt while waiting for the slot leaves at once on the nudge, with nothing submitted', async () => {
  let stop: string | null = null;
  const a = run('p', build('aaa'), { halt: () => stop });
  await until(() => g.submits.length === 1);
  let stopB: string | null = null;
  const b = run('p', build('bbb'), { halt: () => stopB });
  await until(() => unitySlotState('p').waiter !== null);
  stopB = 'run cancelled by J';
  nudgeUnitySlot('p');
  const rb: any = await b;
  assert.equal(rb.status, 'cancelled');
  assert.equal(rb.error, 'run cancelled by J');
  assert.equal(unitySlotState('p').waiter, null);
  stop = 'run cancelled by Studio';
  const ra: any = await a;
  assert.equal(ra.halted, true);
  assert.ok(g.cancels.includes('j_1'));
  assert.equal(g.submits.length, 1, 'the halted waiter submitted nothing');
});

test('Gen is the ground truth: an orphan of the product is cancelled before a submit, or adopted when it is the same build', async () => {
  // Left from before a restart: another commit's build, and another product's (left alone).
  g.preload({ id: 'old_1', project: 'p', params: build('old') });
  g.preload({ id: 'old_2', project: 'p', params: compile('old'), status: 'running' });
  g.preload({ id: 'other', project: 'q', params: build('old') });
  const a = run('p', build('new'));
  await until(() => g.submits.length === 1);
  assert.deepEqual(g.cancels.sort(), ['old_1', 'old_2']);
  assert.equal(g.jobs.get('other').status, 'queued');
  assert.equal(g.open('p').length, 1);
  g.settle('j_1');
  await a;
  // The same compile check left in Gen by a restart: carried on, not submitted again.
  g.preload({ id: 'left', project: 'p', params: compile('sha9') });
  const ids: string[] = [];
  const b = run('p', compile('sha9'), { onSubmit: (id: string) => ids.push(id) });
  await until(() => unitySlotState('p').holder?.job === 'left');
  assert.equal(g.submits.length, 1, 'adopted, nothing new submitted');
  assert.deepEqual(ids, ['left']);
  g.settle('left');
  assert.equal(((await b) as any).id, 'left');
  assert.equal(g.badSubmits, 0, 'nothing was submitted while p had a job outstanding');
});

test("a restart's job while another build holds the slot: cancelled now and built again at its turn; one already done is its answer", async () => {
  const a = run('p', build('aaa'));
  await until(() => g.submits.length === 1);
  g.preload({ id: 'was', project: 'p', params: build('bbb'), status: 'running' });
  const b = run('p', build('bbb'), { job: 'was' });
  await until(() => g.jobs.get('was').status === 'cancelled', 5000, 'the restart job cancelled');
  g.settle('j_1');
  await a;
  await until(() => g.submits.length === 2, 5000, 'built again at its turn');
  g.settle('j_2');
  assert.equal(((await b) as any).id, 'j_2');
  const c = run('p', build('ccc'));
  await until(() => g.submits.length === 3);
  g.preload({ id: 'fin', project: 'p', params: build('ddd'), status: 'done' });
  const d: any = await run('p', build('ddd'), { job: 'fin' });
  assert.equal(d.id, 'fin');
  assert.equal(d.status, 'done');
  g.settle('j_3');
  await c;
});

test("a build a person asked for is never replaced by an automatic request; a newer person's request replaces it", async () => {
  const a = run('p', compile('auto1'));
  await until(() => g.submits.length === 1);
  const mine = run('p', build('asked'), { priority: 'person' });
  await until(() => unitySlotState('p').waiter?.priority === 'person');
  const auto: any = await run('p', compile('auto2'));
  assert.equal(auto.status, 'cancelled');
  assert.equal(auto.superseded, true);
  assert.match(auto.error, /a person asked for is already waiting/);
  assert.equal(unitySlotState('p').waiter?.key, 'build|asked|Game');
  // An automatic request joining the person's build doesn't lower it.
  const join = run('p', build('asked'));
  assert.equal(unitySlotState('p').waiter?.priority, 'person');
  g.settle('j_1');
  await a;
  await until(() => g.submits.length === 2);
  assert.equal(g.submits[1].params.github.commit, 'asked');
  g.settle('j_2');
  assert.equal(((await mine) as any).status, 'done');
  assert.equal(((await join) as any).id, 'j_2');
  // A person's waiting build replaced by a newer person's request (the newest wins).
  const h = run('p', build('h'));
  await until(() => g.submits.length === 3);
  const p1 = run('p', build('p1'), { priority: 'person' });
  await until(() => unitySlotState('p').waiter !== null);
  const p2 = run('p', build('p2'), { priority: 'person' });
  assert.equal(((await p1) as any).superseded, true);
  g.settle('j_3');
  await h;
  await until(() => g.submits.length === 4);
  g.settle('j_4');
  assert.equal(((await p2) as any).status, 'done');
});

test('property: 200 random requests and settles across 3 products never leave two unity.build jobs of one product outstanding', async () => {
  let seed = 20261111;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const products = ['pa', 'pb', 'pc'];
  const pending: Promise<any>[] = [];
  const results: any[] = [];
  let violations = 0;
  const watch = () => { for (const p of products) if (g.outstanding(p) > 1) violations++; };
  for (let step = 0; step < 200; step++) {
    const r = rand();
    if (r < 0.55 || !g.open().length) {
      const product = pick(products);
      const sha = pick(['s1', 's2', 's3', 's4']);
      const params = pick([() => build(sha), () => compile(sha), () => packageBuild()])();
      const o: Record<string, any> = { priority: rand() < 0.2 ? 'person' : 'auto' };
      if (rand() < 0.1) o.timeoutMs = 5;
      // Now and then something Gen holds from before (a restart) appears: Studio must sweep or adopt it.
      if (rand() < 0.08 && !unitySlotState(product).holder && !g.open(product).length) g.preload({ id: `orph_${step}`, project: product, params: build(pick(['s1', 's9'])) });
      pending.push(run(product, params, o).then((x) => { results.push(x); return x; }));
    } else {
      const j = pick(g.open());
      g.settle(j.id, rand() < 0.8 ? 'done' : 'failed');
    }
    await sleep(rand() < 0.5 ? 0 : 3);
    watch();
  }
  // Drain: settle whatever Gen holds until every request has its answer.
  let settled = false;
  void Promise.all(pending).then(() => { settled = true; });
  const end = Date.now() + 20_000;
  while (!settled) {
    if (Date.now() > end) throw new Error('requests never ended');
    for (const j of g.open()) g.settle(j.id);
    await sleep(3);
    watch();
  }
  assert.equal(results.length, pending.length);
  for (const p of products) assert.deepEqual(unitySlotState(p), { holder: null, waiter: null });
  assert.equal(g.badSubmits, 0, 'no submit while its product had a job outstanding');
  assert.ok(g.submits.length > 10, `it built things (${g.submits.length} submits)`);
  assert.equal(violations, 0, 'outstanding unity.build jobs per product <= 1 at every step');
});

test('two requests with no commit in their params but the same identity (a beta run\'s build) share one Gen build', async () => {
  const { unitySlot, resetUnitySlots } = await import('../src/unityslot.ts');
  resetUnitySlots();
  let submits = 0;
  const deps: any = {
    submit: async () => { submits++; return { id: `j_same${submits}` }; },
    wait: async (id: string) => { await new Promise((r) => setTimeout(r, 30)); return { id, status: 'done', result: { ok: true } }; },
    job: async (id: string) => ({ id, status: 'done' }),
    outstanding: async () => [],
    cancel: async () => ({}),
  };
  const params = { project: 'Game', site: 'Site', method: 'Deploy' };
  const [a, b, c] = await Promise.all([
    unitySlot({ product: 'beta-twice', params, identity: 'beta|beta-twice|abc|site|Game' }, deps),
    unitySlot({ product: 'beta-twice', params, identity: 'beta|beta-twice|abc|site|Game' }, deps),
    unitySlot({ product: 'beta-twice', params, identity: 'beta|beta-twice|def|site|Game' }, deps),
  ]);
  assert.equal(a.id, 'j_same1');
  assert.equal(b.id, 'j_same1', 'the second joined the first');
  assert.equal(c.status, 'done');
  assert.equal(submits, 2, 'a different commit builds after it, once');
});
