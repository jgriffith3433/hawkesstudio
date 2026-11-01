import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kickFollowups, onFollowupsDue } from '../src/followup-kick.ts';

test('a status write kicks one follow-up look shortly, a burst shares it, and nothing fires with no listener', async () => {
  kickFollowups(); // no listener yet: nothing scheduled
  let n = 0;
  const off = onFollowupsDue(() => n++);
  kickFollowups();
  kickFollowups();
  kickFollowups();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(n, 1);
  kickFollowups();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(n, 2);
  off();
  kickFollowups();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(n, 2);
});
