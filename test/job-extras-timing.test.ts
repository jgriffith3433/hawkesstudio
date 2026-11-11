// The job starts the agent as soon as its own workspace is out (J, 2026-11-11: each pass waited 2 to 13 minutes while the
// runner cloned up to 30 sibling repos one after another), clones the siblings in the background, at most 4 at a time, each
// with a `.ready` marker; and every change keeps its phase times (change-timing.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-extras-'));
process.env.STUDIO_DATA = scratch;
process.env.TALK_FOLLOWUP_BATCH_MS = '60000';

const R = await import('../src/cloudjob-run.ts');
const { db } = await import('../src/db.ts');
const { getChange } = await import('../src/agents.ts');
const T = await import('../src/change-timing.ts');

const until = async (f: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
};
const memStore = () => {
  const o = new Map<string, Buffer>();
  return {
    o,
    store: {
      put: async (k: string, d: Buffer | string) => void o.set(k, Buffer.isBuffer(d) ? d : Buffer.from(d)),
      get: async (k: string) => o.get(k) ?? null,
      list: async (p: string) => [...o.keys()].filter((k) => k.startsWith(p)),
      remove: async (k: string) => void o.delete(k),
    } as any,
    errText: () => Buffer.concat([...o].filter(([k]) => k.includes('/out/err')).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v)).toString(),
  };
};
const repoOf = (root: string, name: string) => ({ slug: `o/${name}`, remote: `https://github.com/o/${name}.git`, token: null, dir: path.join(root, 'w.repos', name) });

/** A pass whose agent says hello, then waits for `release` before it ends. */
function setup(unit: string, names: string[]) {
  const root = fs.mkdtempSync(path.join(scratch, 'job-'));
  const cwd = path.join(root, 'w');
  const sessions = path.join(root, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const started = path.join(root, 'started');
  const release = path.join(root, 'release');
  const script = `echo hello; touch ${started}; while [ ! -f ${release} ]; do sleep 0.05; done`;
  const m = memStore();
  m.o.set(`jobs/${unit}/spec.json`, Buffer.from(JSON.stringify({ file: 'sh', args: ['-c', script], cwd, sessions, env: {}, git: null, repos: names.map((n) => repoOf(root, n)) })));
  return { root, cwd, started, release, ...m };
}
const markers = (root: string, names: string[]) => names.filter((n) => fs.existsSync(path.join(root, 'w.repos', n, R.EXTRA_READY)));

test('the agent starts before the slow sibling clones finish, and each copy gets its marker as it lands', { timeout: 30_000 }, async () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  const s = setup('u-slow', names);
  let gate!: () => void;
  const open = new Promise<void>((r) => { gate = r; });
  let running = 0, peak = 0;
  const slow = async (r: any) => {
    running++; peak = Math.max(peak, running);
    await open;
    fs.mkdirSync(path.join(r.dir), { recursive: true });
    fs.writeFileSync(path.join(r.dir, 'README'), r.slug);
    running--;
    return true;
  };
  const done = R.runUnit('u-slow', s.store, { every: 60_000, cloneExtra: slow as any });
  await until(() => fs.existsSync(s.started));
  assert.equal(fs.readFileSync(path.join(s.cwd, '..', 'started'), 'utf8'), '', 'the agent is running');
  assert.deepEqual(markers(s.root, names), [], 'no clone has finished yet');
  assert.equal(running, R.EXTRA_CLONES_AT_ONCE, 'but four are under way, not one after another and not all six');
  gate();
  await until(() => markers(s.root, names).length === names.length);
  assert.equal(peak, 4, 'never more than 4 at once');
  fs.writeFileSync(s.release, '1');
  assert.equal(await done, 0, s.errText());
  assert.match(s.errText(), /read-only copy of o\/a/);
});

test('a failed clone leaves only that repo out, with no marker and no folder', { timeout: 30_000 }, async () => {
  const names = ['good', 'bad', 'also'];
  const s = setup('u-fail', names);
  const clone = async (r: any, _at: any, log: (s: string) => void) => {
    if (r.slug === 'o/bad') { fs.mkdirSync(r.dir, { recursive: true }); fs.rmSync(r.dir, { recursive: true }); log('[job] o/bad not copied: repository not found'); return false; }
    fs.mkdirSync(r.dir, { recursive: true });
    return true;
  };
  const done = R.runUnit('u-fail', s.store, { every: 60_000, cloneExtra: clone as any });
  await until(() => markers(s.root, names).length === 2);
  assert.deepEqual(markers(s.root, names).sort(), ['also', 'good']);
  assert.equal(fs.existsSync(path.join(s.root, 'w.repos', 'bad')), false);
  fs.writeFileSync(s.release, '1');
  assert.equal(await done, 0, 'the pass itself is fine');
  assert.match(s.errText(), /o\/bad not copied/);
});

test('a clone that throws is only that repo too; the real clone of an unreachable remote fails cleanly', { timeout: 30_000 }, async () => {
  const root = fs.mkdtempSync(path.join(scratch, 'job-'));
  const logs: string[] = [];
  const landed = await R.cloneExtras([repoOf(root, 'x'), repoOf(root, 'y')], (p) => p, (l) => logs.push(l), {
    clone: async (r: any) => { if (r.slug === 'o/x') throw new Error('boom'); fs.mkdirSync(r.dir, { recursive: true }); return true; },
  });
  assert.deepEqual(landed, ['o/y']);
  assert.ok(logs.some((l) => /o\/x not copied: boom/.test(l)));
  // Not a github remote: refused without running git.
  assert.equal(await R.cloneExtra({ ...repoOf(root, 'z'), remote: 'file:///nope' }, (p) => p, () => {}), false);
});

test('the timing fields are set across one pass', { timeout: 30_000 }, async () => {
  const id = 'c_0123456789ab';
  const t0 = Date.now() - 60_000;
  db.prepare('INSERT INTO changes (id, product, findings, status, worktree, notes, log, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'shop', '[]', 'queued', path.join(scratch, id), '[]', '[]', t0, t0);
  assert.deepEqual(Object.keys(getChange(id)!.timing!).filter((k) => !['spans', 'total_s'].includes(k)), ['created']);

  assert.equal(T.noteTiming(id, 'dispatched', t0 + 5_000), true);
  // The job's runner prints its times; Studio reads them from the output it pulls (cloudjob.ts pull).
  const unit = `hawkes-agent-${id}-1`;
  const s = setup(unit, ['a']);
  const done = R.runUnit(unit, s.store, { every: 60_000, cloneExtra: (async (r: any) => { fs.mkdirSync(r.dir, { recursive: true }); return true; }) as any });
  await until(() => fs.existsSync(s.started));
  fs.writeFileSync(s.release, '1');
  await done;
  assert.ok(T.noteJobTiming(unit, s.errText()) >= 3);
  assert.equal(T.noteJobTiming(unit, s.errText()), 0, 'the first time stays');
  T.noteTiming(id, 'pr_opened', Date.now() + 1_000);
  T.noteTiming(id, 'checks_done', Date.now() + 2_000);
  T.noteTiming(id, 'merged', Date.now() + 3_000);
  const t = getChange(id)!.timing!;
  for (const p of ['created', 'dispatched', 'job_started', 'workspace_ready', 'first_output', 'pr_opened', 'checks_done', 'merged'] as const) assert.ok(t[p], `${p} is set`);
  assert.ok(t.job_started! <= t.workspace_ready! && t.workspace_ready! <= t.first_output!, 'in order');
  assert.equal(t.spans.created_to_dispatched, 5);
  assert.ok(t.total_s! >= 60);
  // Beta's part is derived from the beta lane and the task's verification, then kept.
  db.prepare("UPDATE changes SET status = 'merged', merged_at = ?, task = 'k_x' WHERE id = ?").run(Date.now() + 3_000, id);
  const row = db.prepare('SELECT * FROM changes WHERE id = ?').get(id) as any;
  const full = T.timingOf(row, { beta: () => ({ built: { state: 'done', at: 5_000_000_000_000 }, played: { state: 'done', at: 5_000_000_100_000 } }), verified: () => 5_000_000_200_000 });
  assert.equal(full.beta_built, 5_000_000_000_000);
  assert.equal(full.first_verdict, 5_000_000_200_000, "the task's own verification wins over the playtest step");
  assert.ok(JSON.parse((db.prepare('SELECT timing FROM changes WHERE id = ?').get(id) as any).timing).beta_built, 'kept in the change');
  assert.equal(T.noteTiming(id, 'beta_built', 1), false);
});
