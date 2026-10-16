// Critical sections (drain.ts): what a Studio deploy waits for. They're listed while they run, gone after (even when
// they throw), and a new one waits while a deploy is pending, so the restart comes first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-drain-'));
process.env.STUDIO_DATA = scratch;
const { critical, criticalSync, criticalNow, deployPending } = await import('../src/drain.ts');

test('critical sections are listed while they run, and gone after', async () => {
  let inside: { what: string }[] = [];
  await critical('pushing c_1', async () => {
    inside = criticalNow();
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.deepEqual(inside.map((s) => s.what), ['pushing c_1']);
  assert.deepEqual(criticalNow(), []);
  assert.throws(() => criticalSync('merging c_2', () => { throw new Error('conflict'); }), /conflict/);
  await assert.rejects(critical('merging c_3', async () => { throw new Error('refused'); }), /refused/);
  assert.deepEqual(criticalNow(), []);
  assert.equal(criticalSync('a sync one', () => criticalNow().length), 1);
});

test('a new critical section waits while a deploy is pending', async () => {
  const flag = path.join(scratch, 'deploy-pending');
  fs.writeFileSync(flag, 'a deploy waits');
  assert.equal(deployPending(), true);
  let ran = false;
  const p = critical('pushing c_4', () => { ran = true; });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(ran, false, 'it waits for the deploy');
  fs.rmSync(flag);
  await p;
  assert.equal(ran, true);
});
