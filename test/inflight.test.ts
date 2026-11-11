// Every agent pass is told what else is in flight on its product (src/inflight.ts, agents.ts passPrompt): the other
// changes and the files they touched, tasks being worked, builds and runs going; never itself or finished work; bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-inflight-'));
const { passPrompt, alreadyDone } = await import('../src/agents.ts');
await import('../src/builds.ts');
await import('../src/roadmap.ts');
const { inFlightFor, inFlightSection, noteTouched, touchedFiles, doneByOf, LIMITS } = await import('../src/inflight.ts');
const { db, J } = await import('../src/db.ts');

let n = 0;
function change(id: string, product: string, status: string, o: { title?: string; request?: string; branch?: string; pr?: number; task?: string } = {}) {
  db.prepare('INSERT INTO changes (id, product, findings, status, title, request, branch, pr, task, notes, log, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, product, '[]', status, o.title ?? id, o.request ?? null, o.branch ?? `agent/${id}`, o.pr ?? null, o.task ?? null, '[]', '[]', Date.now() + n++);
}

test('inFlightFor lists the product\'s other changes, tasks, builds and runs, not itself or finished work', () => {
  change('c_aaaaaaaaaaa1', 'p1', 'working', { title: 'Shop screen', request: 'Make the shop screen', pr: 12, task: 'k_shop' });
  change('c_aaaaaaaaaaa2', 'p1', 'ready', { title: 'Camera fix' });
  change('c_aaaaaaaaaaa3', 'p1', 'queued', { title: 'Me' });
  change('c_aaaaaaaaaaa4', 'p1', 'merged', { title: 'Old work' });
  change('c_aaaaaaaaaaa5', 'p1', 'failed', { title: 'Failed work' });
  change('c_aaaaaaaaaaa6', 'p2', 'working', { title: 'Another product' });
  noteTouched('c_aaaaaaaaaaa1', ['src/shop.ts', 'src/ui/menu.ts', '.hawkes/summary.md']);
  db.prepare("INSERT INTO tasks (id, item, product, title, request, status, change, created) VALUES (?, 'i_1', 'p1', ?, 'x', ?, ?, ?)").run('k_shop', 'Shop', 'working', 'c_aaaaaaaaaaa1', Date.now());
  db.prepare("INSERT INTO tasks (id, item, product, title, request, status, change, created) VALUES (?, 'i_1', 'p1', ?, 'x', ?, ?, ?)").run('k_inv', 'Inventory', 'review', 'c_gone00000000', Date.now());
  db.prepare("INSERT INTO tasks (id, item, product, title, request, status, change, created) VALUES (?, 'i_1', 'p1', ?, 'x', ?, ?, ?)").run('k_done', 'Done', 'merged', null, Date.now());
  db.prepare("INSERT INTO builds (id, product, build, version, status, runner, target, run, started) VALUES (?, 'p1', 'web', 7, ?, 'gen', 'web', ?, ?)").run('b_1', 'building', 'r_1', Date.now());
  db.prepare("INSERT INTO builds (id, product, build, version, status, runner, target, run, started) VALUES (?, 'p1', 'web', 6, ?, 'gen', 'web', ?, ?)").run('b_0', 'ready', 'r_0', Date.now());
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run('r_1', 'beta', 'running', 'beta p1', J(['p1']), J({ focus: 'After c_aaaaaaaaaaa2 merged' }), Date.now());
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run('r_0', 'beta', 'done', 'beta p1', J(['p1']), J({}), Date.now());

  const f = inFlightFor('p1', 'c_aaaaaaaaaaa3');
  assert.deepEqual(f.changes.map((c) => c.id), ['c_aaaaaaaaaaa1', 'c_aaaaaaaaaaa2'], 'other in-flight changes of p1 only, oldest first');
  assert.deepEqual(f.changes[0].files, ['src/shop.ts', 'src/ui/menu.ts'], 'recorded files, Studio notes aside');
  assert.equal(f.changes[0].pr, 12);
  assert.deepEqual(f.tasks.map((t) => t.id), ['k_inv'], 'a task already shown by its change is not listed twice');
  assert.deepEqual(f.builds.map((b) => b.id), ['b_1']);
  assert.match(f.builds[0].cause, /r_1/);
  assert.deepEqual(f.runs.map((r) => r.id), ['r_1']);
  assert.match(f.runs[0].cause, /After c_aaaaaaaaaaa2 merged/);

  const text = inFlightSection('Product One', f);
  assert.match(text, /## Other work in flight on Product One/);
  assert.match(text, /c_aaaaaaaaaaa1 \[working\] Shop screen \(task k_shop, branch agent\/c_aaaaaaaaaaa1, PR #12\)/);
  assert.match(text, /Files: src\/shop\.ts, src\/ui\/menu\.ts/);
  assert.match(text, /build b_1: web v7/);
  assert.match(text, /Already done by <its change id>/);
  assert.match(text, /Never start or ask for a build/);
  assert.doesNotMatch(text, /c_aaaaaaaaaaa3|c_aaaaaaaaaaa4|c_aaaaaaaaaaa5|c_aaaaaaaaaaa6|b_0|r_0/);

  // Nothing else in flight: the rules all the same.
  const alone = inFlightSection('Lonely', inFlightFor('p9', null));
  assert.match(alone, /Nothing else is in flight on Lonely/);
  assert.match(alone, /never trigger one with an empty commit, a tag or a/);
});

test('the section stays bounded however much is in flight', () => {
  for (let i = 0; i < 40; i++) {
    const id = `c_bbbbbbbbb${String(i).padStart(3, '0')}`;
    change(id, 'busy', 'working', { title: 'T'.repeat(400), request: 'R'.repeat(4000) });
    noteTouched(id, Array.from({ length: 300 }, (_, k) => `src/file${k}.ts`));
  }
  assert.equal(touchedFiles('c_bbbbbbbbb000').length, 200, 'at most 200 files kept per change');
  const f = inFlightFor('busy', 'c_none');
  assert.equal(f.changes.length, LIMITS.changes);
  assert.equal(f.moreChanges, 40 - LIMITS.changes);
  const text = inFlightSection('Busy', f);
  assert.ok(text.length <= LIMITS.text, `${text.length} chars`);
  assert.match(text, /and 28 more|cut for length/);
  assert.match(text, /\(\+185 more\)/);
  assert.match(text, /Never start or ask for a build/, "the rules survive the cut");
});

test('every pass\'s prompt carries the section; "Already done by" counts as already done', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-inflight-wt-'));
  change('c_cccccccccc01', 'p3', 'working', { title: 'Mine' });
  change('c_cccccccccc02', 'p3', 'verifying', { title: 'Neighbour' });
  const first = passPrompt({ id: 'c_cccccccccc01', product: 'p3', worktree: wt, infra: false }, 'Read .hawkes/brief.md and do what it says.');
  assert.match(first, /^Read \.hawkes\/brief\.md and do what it says\.\n\n## Other work in flight on p3/);
  assert.match(first, /c_cccccccccc02 \[verifying\] Neighbour/);
  assert.doesNotMatch(first, /c_cccccccccc01/);
  // A resumed session (an answer, a conflict pass) gets it too, read again as it starts.
  change('c_cccccccccc03', 'p3', 'queued', { title: 'Newcomer' });
  const resumed = passPrompt({ id: 'c_cccccccccc01', product: 'p3', worktree: wt, infra: false }, 'The answer to your question: yes.', true);
  assert.match(resumed, /^The answer to your question: yes\.\n\n## Other work in flight/);
  assert.match(resumed, /c_cccccccccc03 \[queued\] Newcomer/);
  // The handoff note still comes first for a new session after a cut-off.
  fs.mkdirSync(path.join(wt, '.hawkes'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.hawkes', 'handoff.md'), 'x');
  assert.match(passPrompt({ id: 'c_cccccccccc01', product: 'p3', worktree: wt, infra: false }, 'Go.'), /^Go\.\n\nFirst read \.hawkes\/handoff\.md[^\n]*\n\n## Other work in flight/);

  assert.equal(doneByOf('Already done by c_cccccccccc02: its branch has the shop screen.'), 'c_cccccccccc02');
  assert.equal(doneByOf('Nothing here.'), null);
  assert.ok(alreadyDone('Done by c_cccccccccc02 (checked its diff).'));
});

test('the overlap rule sees the files a running change recorded (no worktree needed)', async () => {
  const { noRoomFor } = await import('../src/agents.ts');
  db.prepare(`INSERT INTO changes (id, product, findings, status, title, created) VALUES ('c_ddddddddddd1', 'sickofit', '[]', 'working', 'Shop rework', ?)`).run(Date.now());
  try {
    const next = { task: 't_shop2', text: 'Shop prices', files: ['Assets/Scripts/Shop.cs'] };
    assert.equal(noRoomFor('sickofit', next), null, 'nothing recorded: runs beside');
    noteTouched('c_ddddddddddd1', ['Assets/Scripts/Shop.cs']);
    assert.match(noRoomFor('sickofit', next) ?? '', /both touch Assets\/Scripts\/Shop\.cs/);
  } finally {
    db.prepare(`DELETE FROM changes WHERE id = 'c_ddddddddddd1'`).run();
  }
});
