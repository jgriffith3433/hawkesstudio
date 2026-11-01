// How soon an agent parked on Gen jobs carries on (agents.ts genPollDue): its jobs are looked at every 30 s while the
// wait is young (it was every 3 minutes, so a finished job sat up to 3 minutes before the agent's session resumed), and
// every 3 minutes once it has waited 15 minutes (a long GPU queue needs no more).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-gen-poll-'));
delete process.env.STUDIO_GEN_POLL_MS;
const { genPollDue } = await import('../src/agents.ts');

const s = 1000;
const min = 60 * s;
const t0 = 1_800_000_000_000;

test('never looked at: due at once (the look right after it parks, and after a restart)', () => {
  assert.equal(genPollDue({ since: t0 }, t0), true);
  assert.equal(genPollDue({ since: t0 - 5 * 3600_000 }, t0), true);
});

test('a young wait is looked at every 30 s', () => {
  const w = { since: t0, checked: t0 + 2 * min };
  assert.equal(genPollDue(w, t0 + 2 * min + 10 * s), false);
  assert.equal(genPollDue(w, t0 + 2 * min + 30 * s), true);
  assert.equal(genPollDue(w, t0 + 2 * min + 29.5 * s), true, "a tick's jitter doesn't skip a whole interval");
});

test('after 15 minutes of waiting: every 3 minutes', () => {
  const w = { since: t0, checked: t0 + 20 * min };
  assert.equal(genPollDue(w, t0 + 20 * min + 30 * s), false);
  assert.equal(genPollDue(w, t0 + 22 * min), false);
  assert.equal(genPollDue(w, t0 + 23 * min), true);
});

test('a slower base (STUDIO_GEN_POLL_MS) is never sped up', () => {
  const w = { since: t0, checked: t0 + min };
  assert.equal(genPollDue(w, t0 + 3 * min, 5 * min), false);
  assert.equal(genPollDue(w, t0 + 6 * min, 5 * min), true);
});
