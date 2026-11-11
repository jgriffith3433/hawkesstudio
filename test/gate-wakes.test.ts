// Gates wake the queue themselves (architecture §11 step 4; queuewake.ts): a pending deploy's end, a customer's AI
// linked, a plan change. No timer has to find out later; a drain flag nobody takes away is the pass's own deadline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-gate-wakes-'));
process.env.STUDIO_DATA = scratch;
const Q = await import('../src/queuewake.ts');
const A = await import('../src/agents.ts');

const woke: string[] = [];
Q.onQueueWake((why) => woke.push(why));

test('a gate opening wakes every listener, and a listener that throws stops no other', () => {
  Q.onQueueWake(() => { throw new Error('boom'); });
  const before = woke.length;
  Q.queueWake('a test gate opened');
  assert.deepEqual(woke.slice(before), ['a test gate opened']);
});

test('the deploy drain ending wakes the queue', async () => {
  const flag = path.join(scratch, 'deploy-pending');
  fs.writeFileSync(flag, 'a deploy waits');
  await A.pumpNow();
  const before = woke.length;
  fs.rmSync(flag);
  const end = Date.now() + 3000;
  while (!woke.slice(before).includes('the deploy drain ended') && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  assert.ok(woke.slice(before).includes('the deploy drain ended'), `woke: ${woke.slice(before).join(', ') || 'nothing'}`);
});

test('a pending deploy sets the pass\'s own deadline at the flag\'s age limit; a flag past it goes at once', async () => {
  const flag = path.join(scratch, 'deploy-pending');
  fs.writeFileSync(flag, 'a deploy waits');
  const since = fs.statSync(flag).mtimeMs;
  await A.pumpNow();
  const at = A.pumpWakeAt();
  assert.ok(at != null && at <= since + 20 * 60_000 + 1000, `wake at ${at}`);
  const old = (Date.now() - 25 * 60_000) / 1000;
  fs.utimesSync(flag, old, old);
  await A.pumpNow();
  assert.equal(fs.existsSync(flag), false, 'a flag left by a deploy that died is taken away by the pass itself');
});

test('a Claude key linked in a customer\'s Studio wakes the queue (its agents waited for "connect your AI first")', async () => {
  const src = fs.readFileSync(new URL('../src/claude.ts', import.meta.url), 'utf8');
  assert.match(src.slice(src.indexOf('export function setCustomerKey')), /queueWake\('a Claude key was linked'\)/);
  for (const [file, why] of [['ailink.ts', 'an AI provider was linked'], ['claude-accounts.ts', 'a Claude account changed'], ['entitlements.ts', 'the plan changed']]) {
    assert.match(fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), new RegExp(`queueWake\\('${why}`), file);
  }
});
