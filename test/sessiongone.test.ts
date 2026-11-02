// A resumed agent session that Claude Code no longer has is recognised (agents.ts agentPass starts a new one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionGone, freshSessionPrompt } from '../src/sessiongone.ts';

test("sessionGone: Claude Code's message for a session it doesn't have", () => {
  assert.equal(sessionGone('No conversation found with session ID: 3f2a9c1e-1b2c-4d5e-8f90-123456789abc'), true);
  assert.equal(sessionGone('[job] exit\nError: No conversation found with session ID: abc\n'), true);
  assert.equal(sessionGone('no conversation found with session id: abc'), true);
  assert.equal(sessionGone('clone failed: GitHub token expired'), false);
  assert.equal(sessionGone(''), false);
  assert.equal(sessionGone(null), false);
  assert.equal(sessionGone(undefined), false);
});

test('freshSessionPrompt: the brief first, the work in the worktree, then what was asked', () => {
  const p = freshSessionPrompt('Commit your work.');
  assert.match(p, /^Read \.hawkes\/brief\.md/);
  assert.match(p, /git status/);
  assert.ok(p.endsWith('Commit your work.'));
});
