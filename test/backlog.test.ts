// Reviews converge (backlog.ts, review.ts): bugs to the backlog, polish and ideas to the ideas list, only regressions and
// blockers outside a full review, known findings judged by id, ideas expiring after 14 days unseen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-backlog-'));
const { db } = await import('../src/db.ts');
const { absorb, applyKnown, expireIdeas, knownFindings, moveOldPolishToIdeas, getFinding, updateFinding } = await import('../src/backlog.ts');

const f = (severity: string, title: string, regression = false) => ({ severity, title, regression, detail: 'd', fix: 'x' });
const P = 'testgame';

test('a full review: bugs open, polish and ideas to the ideas list; a repeat updates instead of adding', () => {
  const r = absorb(P, 'r_1', 'smoke@local', [f('bug', 'Score counter overlaps the pause button'), f('polish', 'Menu font looks placeholder'), f('idea', 'Add a combo meter')]);
  assert.equal(r.added.length, 1);
  assert.equal(r.ideas.length, 2);
  assert.equal(getFinding(r.added[0])!.status, 'open');
  assert.equal(getFinding(r.ideas[0])!.status, 'idea');
  const again = absorb(P, 'r_2', 'smoke@local', [f('polish', 'Menu font looks like a placeholder')]);
  assert.deepEqual([again.added.length, again.ideas.length, again.updated.length], [0, 0, 1]);
  // Reported as a bug, an idea moves to the backlog.
  const worse = absorb(P, 'r_3', 'smoke@local', [f('bug', 'Add a combo meter')]);
  assert.equal(getFinding(worse.updated[0])!.status, 'open');
});

test('verify and regression reviews take only regressions and blockers', () => {
  const r = absorb(P, 'r_4', 'smoke@local', [f('bug', 'Jump sound plays twice'), f('bug', 'Enemies stopped spawning', true), f('blocker', 'Black screen after the title')], { mode: 'verify' });
  assert.equal(r.skipped, 1);
  assert.equal(r.added.length, 2);
});

test('known findings: the list a review gets, "present" counts as seen, "fixed" closes an open one of the same scenario', () => {
  const known = knownFindings(P);
  assert.ok(known.every((k) => ['open', 'fixing', 'idea', 'wontfix'].includes(k.status)));
  const bug = known.find((k) => k.title.startsWith('Score counter'))!;
  const seenBefore = getFinding(bug.id)!.seen;
  applyKnown(P, 'r_5', 'smoke@local', [{ id: bug.id, status: 'present', note: 'still overlaps' }]);
  assert.equal(getFinding(bug.id)!.seen, seenBefore + 1);
  const out = applyKnown(P, 'r_6', 'smoke@local', [{ id: bug.id, status: 'fixed', note: 'gone' }, { id: 'f_nothere', status: 'fixed' }]);
  assert.deepEqual(out.fixed, [bug.id]);
  assert.equal(getFinding(bug.id)!.status, 'fixed');
  // Another scenario's review can't close it; a fixed one reported again comes back.
  const other = absorb(P, 'r_7', 'smoke@local', [f('bug', 'Score counter overlaps the pause button')]);
  assert.equal(getFinding(other.updated[0])!.status, 'open');
  applyKnown(P, 'r_8', 'menus@local', [{ id: bug.id, status: 'fixed', note: 'not shown here' }]);
  assert.equal(getFinding(bug.id)!.status, 'open');
});

test('ideas expire after 14 days unseen; old open polish moves to the ideas list once', () => {
  const idea = knownFindings(P).find((k) => k.status === 'idea')!;
  db.prepare('UPDATE findings SET last_seen = ? WHERE id = ?').run(Date.now() - 15 * 86_400_000, idea.id);
  assert.equal(expireIdeas(), 1);
  assert.equal(getFinding(idea.id)!.status, 'expired');
  const r = absorb(P, 'r_9', 'smoke@local', [f('bug', 'Old polish that was filed as a bug')]);
  db.prepare(`UPDATE findings SET severity = 'polish' WHERE id = ?`).run(r.added[0]);
  assert.equal(moveOldPolishToIdeas(), 1);
  assert.equal(getFinding(r.added[0])!.status, 'idea');
  updateFinding(r.added[0], { status: 'open' });
  assert.equal(moveOldPolishToIdeas(), 0);
  assert.equal(getFinding(r.added[0])!.status, 'open');
});
