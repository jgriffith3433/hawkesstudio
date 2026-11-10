// The beta auto-merge (.github/workflows/beta-automerge.yml) merges with the workflow's own token, and GitHub starts no
// other workflow for such a merge. So besides beta's deploy it starts Studio's hook (hawkes-studio.yml) itself: that is
// how Studio hears beta moved, runs beta and goes live by itself (golive-policy.ts autoGoLive). PRs #309 and #310 sat on
// beta without going live because the hook never ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const wf = (f: string) => fs.readFileSync(path.join(import.meta.dirname, '..', '.github', 'workflows', f), 'utf8');

test("after merging, the auto-merge starts beta's deploy and Studio's hook on beta", () => {
  const y = wf('beta-automerge.yml');
  assert.match(y, /gh workflow run ci\.yml --repo "\$\{\{ github\.repository \}\}" --ref beta/);
  assert.match(y, /if: env\.MERGED == '1'\n\s+env:\n\s+GH_TOKEN: \$\{\{ github\.token \}\}\n\s+run: gh workflow run hawkes-studio\.yml --repo "\$\{\{ github\.repository \}\}" --ref beta/);
  assert.match(y, /actions: write/, 'starting a workflow needs actions: write');
});

test('the hook can be started by hand (workflow_dispatch), and Studio takes a dispatched hook like a push', () => {
  assert.match(wf('hawkes-studio.yml'), /\n  workflow_dispatch:/);
  const server = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'server.ts'), 'utf8');
  assert.match(server, /claims\.event_name !== 'push' && claims\.event_name !== 'workflow_dispatch'/);
});
