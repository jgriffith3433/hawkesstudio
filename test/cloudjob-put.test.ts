// The job folder's put (cloudjob.ts for Studio, cloudjob-run.ts in the job) sends a string as its contents: gcsWrite reads
// a string as a file path, which made every spec.json and exit.json write fail on Cloud Run (2026-10-29: beta-site builds
// failed with "ENOENT ... open '{"kind":"build"...'"). Both stores must keep turning strings into bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test("both job-folder stores send a string's contents, never read it as a path", () => {
  for (const file of ['src/cloudjob.ts', 'src/cloudjob-run.ts']) {
    assert.match(fs.readFileSync(file, 'utf8'), /gcsWrite\([^)]*typeof d(ata)? === 'string' \? Buffer\.from\(d(ata)?\)/, file);
  }
});
