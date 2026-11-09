// A go-live card is never a dead end (J, 2026-11-09: "there should always be a way for the user to at least handle
// this situation"). The living-world goal and what the vision judge saw on a play whose review says "ship" don't hold
// going live (they stay warnings and fixes on beta); every blocker that is a playtest's quality break or a missing
// playtest is one a person may go live past; what makes going live impossible is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-golive-way-out-'));
const D = await import('../src/deploy.ts');

const fail = (rule: string, check: string, kind: any) => ({ check, rule, title: rule, evidence: `${check} seen`, kind });

test('the living-world goal never holds going live, whatever the review said', () => {
  const q = D.qualityBlockers([{ name: 'smoke@local', verdict: 'fix-first', quality: { fails: [fail('living-world', 'fun-review', 'review')], unmeasured: [] } }], 'abc1234');
  assert.deepEqual(q.blockers, []);
  assert.match(q.warnings[0], /^Not holding go live/);
});

test("the vision judge's sightings don't hold going live when the review says ship, and do otherwise", () => {
  const f = fail('ground-contact', 'floating-sunk', 'vision');
  assert.deepEqual(D.qualityBlockers([{ name: 'smoke@local', verdict: 'ship', quality: { fails: [f], unmeasured: [] } }], 'abc1234').blockers, []);
  const held = D.qualityBlockers([{ name: 'smoke@local', verdict: 'fix-first', quality: { fails: [f], unmeasured: [] } }], 'abc1234');
  assert.equal(held.blockers.length, 1);
  assert.ok(D.isQualityBlocker(held.blockers[0]));
  assert.match(held.blockers[0], /Go live anyway/);
});

test('measured breaks still hold going live, and a person may go past them', () => {
  const q = D.qualityBlockers([{ name: 'smoke@local', verdict: 'ship', quality: { fails: [fail('no-z-fighting', 'clipping', 'playtest')], unmeasured: [] } }], 'abc1234');
  assert.equal(q.blockers.length, 1);
  assert.ok(D.overridableOnly(q.blockers));
  assert.ok(D.overridableOnly([...q.blockers, "beta hasn't been playtested yet (the daily run on the server plays it)."]));
});

test('what makes going live impossible is never gone past', () => {
  assert.equal(D.overridableOnly(['Nothing to go live: main is beta.']), false);
  assert.equal(D.overridableOnly(["site's main has 2 commit(s) beta lacks"]), false);
  assert.equal(D.overridableOnly([]), false);
});

test("fixWork is empty on a server with nothing running", () => {
  const w = D.fixWork('no-such-product', ['r_x']);
  assert.deepEqual(w, { changes: [], open: [] });
});

test("an AI sighting of any rule doesn't hold going live when the review says ship; the same rule measured does", () => {
  const seen = (how: 'vision' | 'measured') => ({ ...fail('no-z-fighting', 'clipping', 'playtest'), seen: how });
  assert.deepEqual(D.qualityBlockers([{ name: 'smoke@local', verdict: 'ship', quality: { fails: [seen('vision')], unmeasured: [] } }], 'abc1234').blockers, []);
  assert.equal(D.qualityBlockers([{ name: 'smoke@local', verdict: 'ship', quality: { fails: [seen('measured')], unmeasured: [] } }], 'abc1234').blockers.length, 1);
});

test('the quality gate marks what the vision pass saw apart from what the game measured', async () => {
  const Q = await import('../src/quality.ts');
  const p = { id: 'way-out-game', engine: 'web', kind: 'game', world: '3d' } as any;
  const hit = { kind: 'clipping', severity: 'bug', title: 'clipping', scene: 'Night bedroom', detail: 'looks like it clips' };
  const vision = Q.qualityGate(p, { polish: [hit] }).fails.filter((f) => f.check === 'clipping');
  const measured = Q.qualityGate(p, { feel: [hit] }).fails.filter((f) => f.check === 'clipping');
  assert.ok(vision.length && vision.every((f) => f.seen === 'vision'));
  assert.ok(measured.length && measured.every((f) => f.seen === 'measured'));
});

test('a go-live card is only made or kept when someone can act on it', async () => {
  const A = await import('../src/approvals.ts');
  assert.equal(A.deadEnd({ blockers: [] }), null);
  assert.equal(A.deadEnd({ blockers: ['x'], skip: { sha: 'a', short: 'a', why: ['x'] } as any }), null);
  assert.equal(A.deadEnd({ blockers: ['x'], catchUp: true }), null);
  assert.match(A.deadEnd({ blockers: ['Nothing to go live: main already is beta (594db2a).'] })!, /^nothing to approve or go live past yet/);
});
