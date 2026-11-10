// The Activity panel's "seen" (J, 2026-11-10: "How do we make that go away after 'seeing' it"): the header's red
// "N failed" counts only failures this person hasn't seen; opening the panel marks them seen; Clear hides what finished.
// Kept per person on the server (src/activity-seen.ts), the same rule on the page (dashboard/activity.js ActivitySeen),
// and pushed (the stream's "activity-seen" event), never polled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-activity-seen-'));
const S = await import('../src/activity-seen.ts');

const page: any = { document: undefined };
vm.runInNewContext(fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'activity.js'), 'utf8'), page);
const P = page.ActivitySeen;

const failures = [{ key: 'op:op_a', at: 1000 }, { key: 'op:op_b', at: 2000 }, { key: 'scout:x_c', at: 3000 }];

test('a person who never opened the panel sees every failure counted; opening it makes the count go away, for them only', () => {
  assert.deepEqual(S.seenOf('u_jaycee'), { seenAt: 0, clearedAt: 0 });
  assert.equal(S.unseen(failures, S.seenOf('u_jaycee')).length, 3);
  S.markSeen('u_jaycee', 2500);
  assert.deepEqual(S.unseen(failures, S.seenOf('u_jaycee')).map((f) => f.key), ['scout:x_c'], 'only what came after they looked');
  assert.equal(S.unseen(failures, S.seenOf('u_other')).length, 3, 'another person still has theirs');
  // Seen never goes backwards (a slow tab marking an older time).
  S.markSeen('u_jaycee', 100);
  assert.equal(S.seenOf('u_jaycee').seenAt, 2500);
  S.markSeen('u_jaycee', 5000);
  assert.equal(S.unseen(failures, S.seenOf('u_jaycee')).length, 0);
});

test('Clear hides what finished up to then and counts it as seen; restore brings it back', () => {
  const s = S.clearActivity('u_clear', 2500);
  assert.equal(s.clearedAt, 2500);
  assert.equal(s.seenAt, 2500);
  assert.equal(S.unseen(failures, s).length, 1);
  assert.equal(P.shows(2000, s), false, 'cleared');
  assert.equal(P.shows(3000, s), true, 'finished after the Clear');
  assert.equal(P.shows(2000, s, true), true, 'Show cleared');
  assert.equal(S.clearActivity('u_clear', 0).clearedAt, 0);
});

test('the page counts the same way as the server', () => {
  for (const s of [{ seenAt: 0, clearedAt: 0 }, { seenAt: 1500, clearedAt: 0 }, { seenAt: 0, clearedAt: 2500 }, { seenAt: 9999, clearedAt: 1 }]) {
    assert.deepEqual(P.unseen(failures, s).map((f: any) => f.key), S.unseen(failures, s).map((f) => f.key), JSON.stringify(s));
  }
  assert.equal(P.isNew(3000, 2500), true);
  assert.equal(P.isNew(2000, 2500), false);
  assert.equal(S.viewerKey({ id: 'u_1', email: 'a@b' }), 'u_1');
  assert.equal(S.viewerKey(null), 'owner');
});

test('the page asks the server, and is told by the push stream: no timer for any of it', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'activity.js'), 'utf8');
  assert.match(src, /studioStream\.on\('activity-seen'/);
  assert.match(src, /\/api\/activity\/seen', \{ method: 'POST'/);
  assert.match(src, /\/api\/activity\/clear'/);
  assert.doesNotMatch(src.slice(src.indexOf('var ActivitySeen')), /setInterval\(\s*(markSeen|loadSeen)/);
});
