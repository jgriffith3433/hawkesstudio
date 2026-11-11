// Head-of-line blocking (queue-heal.ts). On 2026-11-10 every queued hawkes-studio change read "queued behind
// c_d24c7d05df35": it had failed publish three times and waited for memory, and as the oldest it was the one that started
// whenever a slot or memory let one go, failed again, and held its product's slot in between. A change that failed
// PARK_AFTER times is now parked: it holds no slot, the next change of its product starts, and it comes back (at the end
// of the line) only after a restart, new code on beta, or a resume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-queue-heal-'));
process.env.STUDIO_PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-queue-heal-projects-'));
const A = await import('../src/agents.ts');
const H = await import('../src/queue-heal.ts');
const { db } = await import('../src/db.ts');
const { listDecisions } = await import('../src/roadmap.ts');
const { undoDecision } = await import('../src/pm.ts');

const P = 'phorigins';
let t0 = 1_000_000;
function add(id: string, o: { status?: string; log?: string[]; created?: number; merged_at?: number } = {}) {
  db.prepare('INSERT INTO changes (id, product, findings, status, detail, repo, base, worktree, title, request, notes, log, created, updated, merged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, P, '[]', o.status ?? 'queued', 'queued (J asked)', 'phoriginsrepo', 'beta', path.join(os.tmpdir(), 'none', id), `Title ${id}`, `Request ${id}`, '[]', JSON.stringify(o.log ?? []), o.created ?? (t0 += 1000), null, o.merged_at ?? null);
}
/** The ops note is written once roadmap.ts is loaded (a dynamic import): a few turns of the event loop. */
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const fails = (n: number) => Array.from({ length: n }, (_, i) => `1${i}:00:00 error: push failed: remote hung up (${i})`);
const shape = { task: null, depends: [], text: 'something else', files: [] };
/** What the pump's look does (agents.ts pumpPass): the queue oldest first, each change through resumeAllowed's hold. */
const pumpable = () => A.listChanges({ status: 'queued', limit: 500 }).reverse().filter((c) => !H.queueHold(c));
const picks = () => A.pickQueued(pumpable().map((c) => ({ id: c.id, product: c.product })), [], 6, { limit: () => 1 });
/** The pump's look at every queued change (queueHold): which it parked and which it woke. */
function look() {
  const parked: string[] = [];
  const woke: string[] = [];
  for (const c of A.listChanges({ status: 'queued', limit: 500 }).reverse()) {
    const before = H.parkedOut(c);
    H.queueHold(c);
    const after = H.parkedOut(A.getChange(c.id)!);
    if (!before && after) parked.push(c.id);
    if (before && !after) woke.push(c.id);
  }
  return { parked, woke };
}

test('failures are counted from the log: errors, failed agent jobs and resumes that could not carry on', () => {
  assert.equal(H.failCount(['10:00:00 agent started', '10:01:00 error: worktree failed', '10:02:00 stderr: [studio] the Cloud Run job failed: gone', "10:03:00 couldn't carry on after the restart: x", '10:04:00 note: error: not at the start']), 3);
  assert.equal(H.failCount(null), 0);
});

// Parking used to leave the change queued until a Studio restart, new code on beta or a resume: on a quiet day, never
// (2026-11-11, "It starts again by itself after a Studio restart"). It now ends the attempt with its cause, and the
// shared recovery plans it again from there (pm.ts afterFailed).
test('a head that failed 3 times is parked: it holds no slot, the next change of its product starts, and it ends with its cause', async () => {
  add('c_head00000001', { log: [...fails(3), '13:00:00 waiting for memory before carrying on (0.7 GB free of 3.8 GB)'] });
  add('c_next00000001');
  const out = look();
  assert.deepEqual(out.parked, [], 'not left in the queue, parked');
  const head = A.getChange('c_head00000001')!;
  assert.equal(head.status, 'failed', 'ended, not left queued until a restart');
  assert.match(String(head.detail), /^failed: its publish or start failed 3 times \(last: error: push failed: remote hung up \(2\)\)\. Ended so it is planned again with that cause/);
  assert.equal(A.phaseOf('c_head00000001')?.failed, true, "a failure on Studio's side: the PM doesn't count it as a try");
  assert.deepEqual(picks(), ['c_next00000001'], 'the next change starts, not the one that keeps failing');
  // It doesn't count as a busy slot for the PM's planning either, nor as a queued change that sits stalled.
  db.prepare(`UPDATE changes SET status = 'merged' WHERE id = 'c_next00000001'`).run();
  assert.equal(A.noRoomFor(P, shape), null, 'a parked change takes no slot of its product');
  assert.equal(A.queueHealth().queued, 0);
  assert.deepEqual(look(), { parked: [], woke: [] });
  // An ops note in the decision log, with an undo.
  await settle();
  const d = listDecisions({ action: 'queue-park' })[0];
  assert.match(d.detail ?? '', /c_head00000001.*parked.*planned again/);
  assert.deepEqual(d.undo, { kind: 'queue-heal', op: 'park', change: 'c_head00000001' });
  db.prepare(`UPDATE changes SET status = 'closed' WHERE id = 'c_head00000001'`).run();
  look();
});

test('the pump parks a change the moment it reaches 3 failures, and it ends then', () => {
  add('c_pump00000001', { log: fails(3) });
  add('c_pump00000002');
  assert.deepEqual(picks().filter((x) => x.startsWith('c_pump')), ['c_pump00000002']);
  assert.equal(A.getChange('c_pump00000001')!.status, 'failed');
  for (const id of ['c_pump00000001', 'c_pump00000002']) db.prepare(`UPDATE changes SET status = 'closed' WHERE id = ?`).run(id);
  look();
});

test("a park an older Studio left queued wakes after a restart at the end of its product's line", () => {
  add('c_old000000001', { log: fails(2) });
  H.legacyPark(A.getChange('c_old000000001')!);
  assert.ok(H.parkedOut(A.getChange('c_old000000001')!));
  add('c_mid000000001');
  H.setBoot('a-later-studio');
  const woke = look();
  assert.deepEqual(woke.woke, ['c_old000000001']);
  assert.match(String(A.getChange('c_old000000001')!.detail), /unparked \(Studio restarted\); at the end of its product's line/);
  // Behind the change that was queued before it woke, though it is older.
  add('c_new000000001', { created: Date.now() + 60_000 });
  assert.deepEqual(picks(), ['c_mid000000001']);
  db.prepare(`UPDATE changes SET status = 'merged' WHERE id = 'c_mid000000001'`).run();
  // Every change queued before it woke has started: its turn (ahead of what was queued after it woke).
  assert.deepEqual(picks(), ['c_old000000001']);
  // One more failure is not three; three new ones end it with its cause.
  db.prepare('UPDATE changes SET log = ? WHERE id = ?').run(JSON.stringify([...fails(2), ...fails(1)]), 'c_old000000001');
  assert.equal(H.queueHold(A.getChange('c_old000000001')!), null);
  db.prepare('UPDATE changes SET log = ? WHERE id = ?').run(JSON.stringify([...fails(2), ...fails(3)]), 'c_old000000001');
  assert.equal(H.queueHold(A.getChange('c_old000000001')!), 'parked');
  assert.equal(A.getChange('c_old000000001')!.status, 'failed');
  for (const id of ['c_old000000001', 'c_new000000001']) db.prepare(`UPDATE changes SET status = 'closed' WHERE id = ?`).run(id);
  look();
});

test('new code on beta wakes a park an older Studio left queued', () => {
  add('c_beta00000001', { log: fails(1) });
  H.legacyPark(A.getChange('c_beta00000001')!);
  assert.ok(H.parkedOut(A.getChange('c_beta00000001')!));
  add('c_landed000001', { status: 'merged', merged_at: Date.now() });
  assert.deepEqual(look().woke, ['c_beta00000001']);
  assert.match(String(A.getChange('c_beta00000001')!.detail), /new code on beta/);
  db.prepare(`UPDATE changes SET status = 'closed' WHERE id = 'c_beta00000001'`).run();
});

test('a resume (the decision\'s undo, or Cancel then Resume) starts it again at once', async () => {
  add('c_undo00000001', { log: fails(3) });
  add('c_wait00000001');
  look();
  await settle();
  const d = listDecisions({ action: 'queue-park' }).find((x) => x.undo?.change === 'c_undo00000001')!;
  const r = await undoDecision(d.id, 'J');
  assert.match(r.detail, /c_undo00000001 unparked/);
  assert.match(String(A.getChange('c_undo00000001')!.detail), /resumed after being parked \(resumed by J\)/);
  assert.equal(H.queueHold(A.getChange('c_undo00000001')!), null, 'a person\'s resume doesn\'t wait at the end of the line');
  // A note on the change (Resume after a Cancel adds one) wakes it the same way.
  add('c_note00000001', { log: fails(3) });
  look();
  db.prepare('UPDATE changes SET notes = ? WHERE id = ?').run(JSON.stringify([{ at: Date.now(), by: 'J', text: 'resumed' }]), 'c_note00000001');
  assert.equal(H.queueHold(A.getChange('c_note00000001')!), null);
  assert.ok(!H.parkedOut(A.getChange('c_note00000001')!));
});

test('the pump\'s look at a change goes through the hold, and a fault in it never holds the queue', () => {
  const src = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  const resume = src.slice(src.indexOf('function resumeAllowed('), src.indexOf('/** Runs queued changes'));
  assert.match(resume, /if \(queueHold\(c\)\) return false;/);
  assert.equal(H.queueHold({ id: 'c_broken', status: 'queued', log: null } as any), null);
});
