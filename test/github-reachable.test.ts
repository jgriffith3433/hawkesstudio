// Walk-away in an org cell (2026-11-01): the PM's starts, the daily auto-fix and the merged-on-GitHub sync were gated on
// GITHUB_TOKEN, which a customer's Studio never has (its repos' tokens come from the control plane), so walk-away never
// started a bug there. githubReachable is the gate now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubReachable } from '../src/ghtoken.ts';

const keep = { token: process.env.GITHUB_TOKEN, org: process.env.STUDIO_ORG, customer: process.env.STUDIO_CUSTOMER, signup: process.env.STUDIO_SIGNUP };
const restore = () => {
  for (const [k, v] of [['GITHUB_TOKEN', keep.token], ['STUDIO_ORG', keep.org], ['STUDIO_CUSTOMER', keep.customer], ['STUDIO_SIGNUP', keep.signup]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
};
test.afterEach(restore);
const clear = () => { delete process.env.GITHUB_TOKEN; delete process.env.STUDIO_ORG; delete process.env.STUDIO_CUSTOMER; delete process.env.STUDIO_SIGNUP; };

test("J's Studio: reachable only with GITHUB_TOKEN", () => {
  clear();
  assert.equal(githubReachable(), false);
  process.env.GITHUB_TOKEN = 'ghp_test';
  assert.equal(githubReachable(), true);
});

test('an org cell with no GITHUB_TOKEN is reachable (per-repo tokens from the control plane)', () => {
  clear();
  process.env.STUDIO_ORG = 'org_eb0d5c82e8da8c2d';
  assert.equal(githubReachable(), true);
});

test('a customer Studio (STUDIO_CUSTOMER=1) with no GITHUB_TOKEN is reachable', () => {
  clear();
  process.env.STUDIO_CUSTOMER = '1';
  assert.equal(githubReachable(), true);
});

test('git commands that check out files from a light clone get the repo token too', async () => {
  const { gitNeedsAuth } = await import('../src/beta.ts');
  for (const a of [['fetch'], ['push'], ['worktree', 'add', '-b', 'x', 'dir', 'origin/beta'], ['checkout', 'x']]) assert.equal(gitNeedsAuth(a), true, a.join(' '));
  for (const a of [['status'], ['rev-parse', 'HEAD'], ['worktree'].slice(1)]) assert.equal(gitNeedsAuth(a as string[]), false, a.join(' '));
});
