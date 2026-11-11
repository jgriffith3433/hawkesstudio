// What a build, a playtest and an agent pass came to is read into one of a fixed set (src/outcomes.ts), with a test for
// each member: nothing defaults to "built nothing", to a failure it didn't have, or to "hung" (docs/stall-paths.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILD_OUTCOMES, PLAY_OUTCOMES, PASS_STATES, PLAYED_NOTHING, buildOutcome, playOutcome, passState, type BuildFacts } from '../src/outcomes.ts';

const facts = (o: Partial<BuildFacts> = {}): BuildFacts => ({ runStatus: 'done', failedBuildSteps: 0, failedSteps: 0, ...o });

test('every build outcome is reached by its own facts, and the set is exactly what the docs name', () => {
  const reads: Record<(typeof BUILD_OUTCOMES)[number], BuildFacts[]> = {
    built: [facts(), facts({ runStatus: 'failed', failedSteps: 1 }), facts({ runStatus: 'partial', failedSteps: 2 })],
    failed: [facts({ failedBuildSteps: 1 }), facts({ runStatus: 'failed' }), facts({ runStatus: 'partial' }), facts({ runStatus: 'failed', failedBuildSteps: 2, failedSteps: 2 })],
    unproven: [facts({ proof: { ok: false } })],
    held: [facts({ held: true, runStatus: 'done' })],
    cancelled: [facts({ cancelled: true, failedBuildSteps: 1 })],
    superseded: [facts({ superseded: true }), facts({ runStatus: 'skipped' })],
    waiting: [facts({ runStatus: 'running' }), facts({ runStatus: 'queued' })],
    unread: [facts({ runStatus: 'something-new' }), facts({ runStatus: '' })],
  };
  for (const outcome of BUILD_OUTCOMES) {
    assert.ok(reads[outcome].length, `no case for ${outcome}`);
    for (const f of reads[outcome]) assert.equal(buildOutcome(f), outcome, JSON.stringify(f));
  }
  assert.deepEqual([...BUILD_OUTCOMES].sort(), Object.keys(reads).sort());
});

test('a broken build is a failed build, never "built nothing"; a held, cancelled or unreadable one blames nothing', () => {
  assert.equal(buildOutcome(facts({ runStatus: 'failed', failedBuildSteps: 1 })), 'failed', 'the size guard / a compile error');
  assert.equal(buildOutcome(facts({ runStatus: 'failed' })), 'failed', 'the run itself threw');
  for (const o of [buildOutcome(facts({ held: true })), buildOutcome(facts({ cancelled: true })), buildOutcome(facts({ runStatus: 'mystery' }))]) assert.notEqual(o, 'failed');
  // A built commit without the task's merge proves nothing about it (not failed, not built).
  assert.equal(buildOutcome(facts({ proof: { ok: false } })), 'unproven');
  assert.equal(buildOutcome(facts({ proof: { ok: true } })), 'built');
});

test('every playtest outcome, and which of them checked nothing', () => {
  const reads: Record<(typeof PLAY_OUTCOMES)[number], Parameters<typeof playOutcome>[0][]> = {
    played: [{ status: 'done' }, { status: 'done', detail: 'ok', outcome: 'completed' }],
    stuck: [{ status: 'done', detail: 'bot got stuck at the door' }, { status: 'done', outcome: 'stuck' }],
    failed: [{ status: 'failed', detail: 'the job threw' }],
    skipped: [{ status: 'skipped', detail: 'no scenario in the build' }],
    cancelled: [{ status: 'cancelled' }],
    running: [{ status: 'running' }, { status: 'queued' }],
    unread: [{ status: 'brand-new' }],
  };
  for (const outcome of PLAY_OUTCOMES) { assert.ok(reads[outcome].length); for (const s of reads[outcome]) assert.equal(playOutcome(s), outcome, JSON.stringify(s)); }
  assert.deepEqual([...PLAYED_NOTHING].sort(), ['cancelled', 'failed', 'skipped', 'stuck']);
  assert.ok(!PLAYED_NOTHING.includes('unread') && !PLAYED_NOTHING.includes('running'), 'an unreadable or running play is looked at again, not a check that broke');
});

test('every agent pass state: only a hung or orphaned pass is taken over; a wait with its own end is never "hung"', () => {
  const base = { here: true, idleMs: 0, stallMs: 600_000, orphanMs: 300_000, step: 'agent', waitingForRoom: false, waitingToStart: false, elsewhere: false };
  const reads: Record<(typeof PASS_STATES)[number], Parameters<typeof passState>[0][]> = {
    moving: [base, { ...base, here: false, idleMs: 100_000 }],
    'waiting-for-room': [{ ...base, idleMs: 3_600_000, waitingForRoom: true }],
    'waiting-to-start': [{ ...base, idleMs: 3_600_000, waitingToStart: true }],
    'working-elsewhere': [{ ...base, idleMs: 3_600_000, elsewhere: true }, { ...base, here: false, idleMs: 3_600_000, elsewhere: true }],
    hung: [{ ...base, idleMs: 3_600_000 }, { ...base, idleMs: 3_600_000, step: 'verify', waitingForRoom: true }],
    orphaned: [{ ...base, here: false, idleMs: 3_600_000 }],
  };
  for (const state of PASS_STATES) { assert.ok(reads[state].length); for (const f of reads[state]) assert.equal(passState(f), state, JSON.stringify(f)); }
  // Waiting for CPU room is only a wait at the agent step (the job is in line); at another step silence is silence.
  assert.equal(passState({ ...base, idleMs: 3_600_000, step: 'verify', waitingForRoom: true }), 'hung');
});
