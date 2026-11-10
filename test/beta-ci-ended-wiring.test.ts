// Beta's CI must tell Studio when it ends, by an event GitHub actually starts. A workflow_run trigger never fired
// (2026-11-10: #362's CI went green at 22:57 and nothing woke Studio's go-live): beta's Deploy runs are started by
// GITHUB_TOKEN, and GitHub starts no workflow from a GITHUB_TOKEN run's events except workflow_dispatch. So the Deploy
// run's last job dispatches beta-ci-ended.yml with its run id, which waits for the run to be over and tells Studio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
const ended = fs.readFileSync('.github/workflows/beta-ci-ended.yml', 'utf8');

test("the Deploy run's last job dispatches beta-ci-ended with its run id, on beta, whatever the deploy's outcome", () => {
  const job = ci.slice(ci.indexOf('\n  ended:'));
  assert.ok(job.length > 20, 'ci.yml has an "ended" job');
  assert.match(job, /needs: deploy/);
  assert.match(job, /if: always\(\) && github\.ref_name == 'beta'/);
  assert.match(job, /actions: write/);
  assert.match(job, /gh workflow run beta-ci-ended\.yml .*--ref beta -f run_id="\$GITHUB_RUN_ID"/);
});

test('beta-ci-ended starts on workflow_dispatch (not workflow_run), waits for that run, then tells Studio', () => {
  const on = ended.slice(ended.indexOf('\non:'), ended.indexOf('\npermissions:'));
  assert.match(on, /workflow_dispatch:/);
  assert.doesNotMatch(on, /workflow_run/);
  assert.match(on, /run_id:/);
  const watch = ended.indexOf('gh run watch "$RUN_ID"');
  const tell = ended.indexOf('gh workflow run hawkes-studio.yml');
  assert.ok(watch > 0 && tell > watch, 'waits for the run, then tells Studio');
  assert.match(ended, /\[\[ "\$RUN_ID" =~ \^\[0-9\]\+\$ \]\]/);
});
