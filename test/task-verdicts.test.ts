// Roadmap tasks get their criteria verdict from playtests that already run (acceptance.ts; 2026-11-10: of 347 tasks
// merged, verified or live, 22 had every criterion judged). No new playtest anywhere:
// - a change's own playtest before its merge passed every criterion: that is the verdict once beta built it, unless beta
//   moved in the same files (changeVerdictHolds, against a real git repository);
// - the play before going live (a bare beta play) and the daily run's plays of beta judge every merged task's criteria
//   (sweepCriteria / sweepFor), phone criteria on a phone play; pm.ts reads them per run (runVerdicts): all met is
//   verified, a "no" sends it back the usual way, unclear only waits (no agent change for it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-verdicts-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_PM_TALK = 'off';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
const product = (id: string) => ({
  id, name: id, framing: 'test', engine: 'static', repo: id, site: id, live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: id, port: 8790, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }, { scenario: 'smoke', where: 'local', device: 'phone' }], story: [], about: 'A fixture.',
});
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: ['tvsweep', 'tvdaily', 'tvcarry', 'tvmiss'].map(product), repos: {} }));

const rm = await import('../src/roadmap.ts');
const A = await import('../src/acceptance.ts');
const pm = await import('../src/pm.ts');
await import('../src/agents.ts'); // the changes table
const { db, J, newId } = await import('../src/db.ts');

pm.savePmSettings({ walkAway: false });

/** A merged task beta built (landed), with a change on record. */
function mergedTask(productId: string, criteria: string[], { landed = true, mergedAgo = 10 * 60_000, title = 'Task' }: { landed?: boolean; mergedAgo?: number; title?: string } = {}) {
  const it = rm.addItem({ product: productId, title, status: 'planned' });
  const t = rm.addTask({ item: it.id, request: title, criteria });
  const change = newId('c');
  const at = Date.now() - mergedAgo;
  db.prepare(`INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, title, notes, log, created, updated, task, merged_at)
    VALUES (?, ?, '[]', 'merged', 'merged', ?, ?, 'task/x', 'beta', ?, ?, '[]', '[]', ?, ?, ?, ?)`).run(change, productId, productId, `x/${productId}`, path.join(tmp, 'none', change), title, at, at, t.id, at);
  rm.setTask(t.id, { status: 'merged', change, changes: [change], merged_at: at, build: landed ? { ok: true, run: 'r_built', at: at + 60_000, detail: 'built OK' } : null });
  return { task: rm.getTask(t.id)!, change };
}
/** A run with a done playtest and its review step judging `criteria` (sweep: the task ids it judged in passing). */
function reviewed(productId: string, kind: string, name: string, criteria: any[], sweep: string[] | null, run = newId('r'), status = 'done') {
  const at = Date.now() - 30_000;
  if (!db.prepare('SELECT 1 FROM runs WHERE id = ?').get(run)) db.prepare('INSERT INTO runs (id, kind, status, detail, products, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?)').run(run, kind, status, kind, J([productId]), at - 60_000, Date.now());
  db.prepare(`INSERT INTO steps (id, run, product, kind, name, status, data, started) VALUES (?, ?, ?, 'playtest', ?, 'done', ?, ?)`).run(newId('s'), run, productId, name, J({ outcome: 'passed' }), at - 1000);
  db.prepare(`INSERT INTO steps (id, run, product, kind, name, status, data, started) VALUES (?, ?, ?, 'review', ?, 'done', ?, ?)`).run(newId('s'), run, productId, name, J({ verdict: 'ship', criteria, sweep }), at);
  return run;
}
const yes = (criterion: string) => ({ criterion, met: 'yes', evidence: 'seen' });

test('sweepCriteria: merged tasks beta built, longest-waiting first, phone criteria on the phone play, whole tasks up to the cap', () => {
  const a = mergedTask('tvsweep', ['The shop opens', 'On a phone the shop button fits at 390x844'], { mergedAgo: 60 * 60_000 }).task;
  const b = mergedTask('tvsweep', ['The score shows'], { mergedAgo: 30 * 60_000 }).task;
  mergedTask('tvsweep', ['Not built yet'], { landed: false });
  const v = mergedTask('tvsweep', ['Already verified']).task;
  rm.setTask(v.id, { status: 'verified' });

  // No phone play: everything on the desktop play, oldest merge first.
  assert.deepEqual(A.sweepCriteria('tvsweep'), { criteria: [...a.criteria, ...b.criteria], tasks: [a.id, b.id] });
  // A phone play too: the phone criterion goes there.
  assert.deepEqual(A.sweepCriteria('tvsweep', { phonePlay: true }).criteria, ['The shop opens', 'The score shows']);
  assert.deepEqual(A.sweepCriteria('tvsweep', { device: 'phone', phonePlay: true }), { criteria: ['On a phone the shop button fits at 390x844'], tasks: [a.id] });
  // The cap keeps whole tasks.
  process.env.STUDIO_SWEEP_MAX_CRITERIA = '2';
  try {
    assert.deepEqual(A.sweepCriteria('tvsweep').tasks, [a.id]);
  } finally { delete process.env.STUDIO_SWEEP_MAX_CRITERIA; }
  // A task judged unclear on beta goes to the back.
  rm.setTask(a.id, { checks: { where: 'beta', at: Date.now(), run: 'r_x', results: [] } });
  assert.deepEqual(A.sweepCriteria('tvsweep').tasks, [b.id, a.id]);

  // Which plays judge them: a play of beta in a beta or daily run that isn't a task's own check.
  assert.deepEqual(A.sweepFor('tvsweep', { runKind: 'beta', where: 'local' })?.tasks, [b.id, a.id]);
  assert.ok(A.sweepFor('tvsweep', { runKind: 'daily', where: 'local', device: 'phone', phonePlay: true }));
  assert.equal(A.sweepFor('tvsweep', { runKind: 'daily', where: 'live' }), null, 'live is not beta');
  assert.equal(A.sweepFor('tvsweep', { runKind: 'beta', where: 'local', asked: true }), null, "a task's own check judges only its criteria");
  assert.equal(A.sweepFor('tvsweep', { runKind: 'manual', where: 'local' }), null);
  assert.equal(A.sweepFor('tvdaily', { runKind: 'daily', where: 'local' }), null, 'nothing waiting');
});

test('runVerdicts: a run judged them all across its plays; no wins, then yes; the newest such run', () => {
  const crit = ['Shop opens', 'Fits on a phone'];
  const steps = [
    { id: 's3', run: 'r_new', started: 30, data: { criteria: [yes('Shop opens')], sweep: ['k_1'] } },
    { id: 's2', run: 'r_old', started: 20, data: { verdict: 'ship', criteria: [yes('Shop opens'), { criterion: 'Fits on a phone', met: 'unclear' }], sweep: ['k_1'] } },
    { id: 's1', run: 'r_old', started: 10, data: { verdict: 'ship', criteria: [yes('Fits on a phone')], sweep: ['k_1'] } },
  ];
  const v = A.runVerdicts(steps, crit)!;
  assert.equal(v.run, 'r_old', 'the newer run judged only one of them');
  assert.deepEqual(v.results.map((r) => r.met), ['yes', 'yes'], "the phone play's yes over the desktop's unclear");
  assert.equal(v.sweep, true);
  assert.equal(v.started, 20);
  const no = A.runVerdicts([{ id: 'a', run: 'r', started: 1, data: { criteria: [yes('Shop opens'), yes('Fits on a phone')] } }, { id: 'b', run: 'r', started: 2, data: { criteria: [{ criterion: 'Shop opens', met: 'no', evidence: 'no shop' }] } }], crit)!;
  assert.deepEqual(no.results.map((r) => r.met), ['no', 'yes']);
  assert.equal(no.sweep, false, "a task's own check");
  assert.equal(A.runVerdicts([{ id: 'a', run: 'r', started: 1, data: { criteria: [yes('Shop opens')] } }], crit), null);
});

// ------------------------------------------------------------ the change's own playtest, carried

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
/**
 * A repository with origin: beta, a change branch played at `played`, beta moving in `betaTouches` (a line added at its
 * end, merged cleanly with the change), then the squash merge "(#pr)".
 */
function repoWithMerge(name: string, pr: number, betaTouches: string) {
  const origin = path.join(tmp, `${name}.git`);
  const dir = path.join(tmp, name);
  fs.mkdirSync(origin);
  git(origin, 'init', '--bare', '-q', '-b', 'beta');
  git(tmp, 'clone', '-q', origin, dir);
  git(dir, 'checkout', '-q', '-b', 'beta');
  fs.mkdirSync(path.join(dir, '.hawkes'));
  for (const f of ['shop.js', 'score.js', '.hawkes/summary.md']) fs.writeFileSync(path.join(dir, f), `${f}\n2\n3\n4\n5\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'start');
  git(dir, 'push', '-q', 'origin', 'beta');
  git(dir, 'checkout', '-q', '-b', 'task/shop');
  fs.writeFileSync(path.join(dir, 'shop.js'), 'the shop opens\n2\n3\n4\n5\n');
  fs.writeFileSync(path.join(dir, '.hawkes', 'summary.md'), 'notes\n2\n3\n4\n5\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'shop');
  const played = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'beta');
  fs.appendFileSync(path.join(dir, betaTouches), 'beta moved\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'another merge');
  git(dir, 'merge', '-q', '--squash', 'task/shop');
  git(dir, 'commit', '-q', '-m', `Shop (#${pr})`);
  git(dir, 'push', '-q', 'origin', 'beta');
  return { dir, played };
}
const passed = (criteria: string[], played: string) => ({ outcome: 'passed', playtest: 'j_1', verdict: 'ship', changeWorked: 'yes', criteria: criteria.map(yes), played });

test('changeVerdictHolds: its own playtest stands when beta moved elsewhere, not when beta changed its files', async () => {
  const crit = ['The shop opens'];
  const elsewhere = repoWithMerge('carry-ok', 7, 'score.js');
  const ok = await A.changeVerdictHolds({ verify: passed(crit, elsewhere.played) }, crit, A.localGitDeps(elsewhere.dir, 'beta', 7));
  assert.equal(ok.holds, true, ok.why);
  assert.match(ok.why, /met all 1 criteria.*touched its 2 file/);
  // Agents' notes never count as the same files.
  const notes = repoWithMerge('carry-notes', 8, '.hawkes/summary.md');
  assert.equal((await A.changeVerdictHolds({ verify: passed(crit, notes.played) }, crit, A.localGitDeps(notes.dir, 'beta', 8))).holds, true);
  const same = repoWithMerge('carry-same', 9, 'shop.js');
  const moved = await A.changeVerdictHolds({ verify: passed(crit, same.played) }, crit, A.localGitDeps(same.dir, 'beta', 9));
  assert.equal(moved.holds, false);
  assert.match(moved.why, /beta changed 1 of its files.*shop\.js/);
  // Not played, a criterion not met, another task's criteria, no merge found, no played commit: never carried.
  const deps = A.localGitDeps(elsewhere.dir, 'beta', 7);
  assert.match((await A.changeVerdictHolds({ verify: { outcome: 'not played' } }, crit, deps)).why, /not playtested/);
  assert.match((await A.changeVerdictHolds({ verify: { ...passed(crit, elsewhere.played), criteria: [{ criterion: crit[0], met: 'unclear' }] } }, crit, deps)).why, /didn't pass|didn't judge/);
  assert.match((await A.changeVerdictHolds({ verify: passed(crit, elsewhere.played) }, ['Something else'], deps)).why, /didn't judge every/);
  assert.match((await A.changeVerdictHolds({ verify: passed(crit, elsewhere.played) }, crit, A.localGitDeps(elsewhere.dir, 'beta', 99))).why, /merge commit/);
  assert.match((await A.changeVerdictHolds({ verify: { ...passed(crit, ''), played: undefined } }, crit, deps)).why, /no record of the commit/);
});

test('the PM verifies a merged task from its change playtest once beta built it (once per change)', async () => {
  const crit = ['The shop opens'];
  const { task, change } = mergedTask('tvcarry', crit, { landed: false });
  db.prepare('UPDATE changes SET verify = ? WHERE id = ?').run(J(passed(crit, 'abc1234')), change);
  rm.setTask(task.id, { checks: { where: 'change', at: Date.now(), change, results: crit.map(yes) } });
  const holds = { merge: async () => 'm', fork: async () => 'f', files: async (a: string) => (a === 'f' ? ['shop.js'] : ['score.js']) };
  // Not built on beta yet: nothing carried.
  assert.equal(await pm.carryChangeVerdict(rm.getTask(task.id)!, holds), false);
  rm.setTask(task.id, { build: { ok: true, run: 'r_b', at: Date.now(), detail: 'built OK' } });
  assert.equal(await pm.carryChangeVerdict(rm.getTask(task.id)!, holds), true);
  const t = rm.getTask(task.id)!;
  assert.equal(t.status, 'verified');
  assert.match(t.checks?.carried ?? '', /met all 1 criteria/);
  assert.ok(rm.listDecisions({ action: 'verified' }).some((d) => d.subject === task.id));

  // Beta changed the same file: stays merged, said once, and beta's plays judge it.
  const other = mergedTask('tvcarry', crit);
  db.prepare('UPDATE changes SET verify = ? WHERE id = ?').run(J(passed(crit, 'abc1234')), other.change);
  rm.setTask(other.task.id, { checks: { where: 'change', at: Date.now(), change: other.change, results: crit.map(yes) } });
  const clash = { ...holds, files: async () => ['shop.js'] };
  assert.equal(await pm.carryChangeVerdict(rm.getTask(other.task.id)!, clash), false);
  assert.equal(await pm.carryChangeVerdict(rm.getTask(other.task.id)!, holds), false, 'one comparison per change');
  assert.equal(rm.getTask(other.task.id)!.status, 'merged');
  assert.equal(rm.listDecisions({ action: 'carry' }).filter((d) => d.subject === other.task.id).length, 1);
  // A task the beta's sweep now verifies (the daily run's play of beta judged it in passing).
  reviewed('tvcarry', 'daily', 'smoke@local', [yes('The shop opens')], [other.task.id]);
  await pm.syncTasks();
  assert.equal(rm.getTask(other.task.id)!.status, 'verified');
});

test("the daily run's plays of beta verify merged tasks: desktop and phone reviews together", async () => {
  const crit = ['The score shows', 'On a phone the score fits'];
  const { task } = mergedTask('tvdaily', crit);
  const run = reviewed('tvdaily', 'daily', 'smoke@local', [yes(crit[0]), { criterion: crit[1], met: 'unclear', evidence: 'desktop' }], [task.id]);
  // Its live play failed: says nothing about the play of beta.
  db.prepare(`INSERT INTO steps (id, run, product, kind, name, status, started) VALUES (?, ?, 'tvdaily', 'playtest', 'smoke@live', 'failed', ?)`).run(newId('s'), run, Date.now());
  await pm.syncTasks();
  assert.equal(rm.getTask(task.id)!.status, 'merged', 'unclear on the phone criterion: waits');
  assert.equal(rm.getTask(task.id)!.checks?.run, run, 'what the play saw is on the task');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM changes WHERE task = ?').get(task.id) as any).n, 1, 'no scenario fix: no agent change for a swept unclear');
  assert.ok(rm.listDecisions({ action: 'beta-check' }).some((d) => d.subject === task.id && /judged in run/.test(d.detail ?? '')));
  reviewed('tvdaily', 'daily', 'smoke@local:phone', [yes(crit[1])], [task.id], run);
  await pm.syncTasks();
  const t = rm.getTask(task.id)!;
  assert.equal(t.status, 'verified');
  assert.deepEqual(t.checks?.results.map((r) => r.met), ['yes', 'yes']);
  assert.equal(pm.pendingPmEvents().filter((e) => e.subject === task.id).length, 0, 'no PM turn for a swept verdict');

  // A review that swept other tasks never counts for one it didn't (beta hadn't built it when it played).
  const late = mergedTask('tvdaily', ['The menu opens']).task;
  reviewed('tvdaily', 'daily', 'smoke@local', [yes('The menu opens')], ['k_someoneelse']);
  await pm.syncTasks();
  assert.equal(rm.getTask(late.id)!.status, 'merged');
});

test('a "no" in the play before going live sends the task back the usual way', async () => {
  const crit = ['The door opens'];
  const { task } = mergedTask('tvmiss', crit);
  // The go-live play is a beta run: its playtest step is clean (brokenCheck), its review swept the task.
  reviewed('tvmiss', 'beta', 'smoke@local', [{ criterion: crit[0], met: 'no', evidence: 'the door stayed shut' }], [task.id], newId('r'), 'done');
  await pm.syncTasks();
  const t = rm.getTask(task.id)!;
  assert.equal(t.status, 'failed');
  assert.match(t.note ?? '', /the door stayed shut/);
  assert.ok(rm.listQuestions().some((q) => q.subject === task.id && /misses criteria/.test(q.text)));
});
