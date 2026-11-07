// Settings (settings.ts): one API over every section, call settings stored in Studio's database, validation, and the
// rule that a change from Talk that can raise costs needs J's own words quoted from that conversation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-settings-'));
const { allSettings, saveSettings, callSettings, costRaising } = await import('../src/settings.ts');
const { startConversation, getConversation } = await import('../src/talk.ts');
const { db, J } = await import('../src/db.ts');
const { guardRoute } = await import('../src/guards.ts');

/** A conversation where J said these words (as if he typed them). */
function convWith(text: string) {
  const c = startConversation('Settings');
  const conv = getConversation(c.id)!;
  conv.messages.push({ role: 'user', text, at: Date.now() });
  db.prepare('UPDATE conversations SET messages = ? WHERE id = ?').run(J(conv.messages), c.id);
  return c.id;
}

test('defaults: the browser voice, push to talk on a computer and a phone, no barge-in', async () => {
  const s = await allSettings();
  assert.equal(s.call.engine, 'browser');
  assert.deepEqual(s.call.mode, { computer: 'push', phone: 'push' });
  assert.equal(s.call.bargeIn, false);
  assert.equal(s.call.saved, null);
  assert.ok(s.prices.elevenPerMinute > 0.1 && s.prices.elevenPerMinute < 0.2);
  for (const k of ['agents', 'pm', 'notify', 'costs']) assert.ok((s as any)[k], k);
});

test('call settings are saved in the database and validated', async () => {
  const r = await saveSettings('call', { rate: 1.2, mode: { phone: 'hands-free' }, engine: 'browser' }, { conversation: null });
  assert.equal(r.rate, 1.2);
  assert.deepEqual(r.mode, { computer: 'push', phone: 'hands-free' });
  assert.ok(callSettings().saved);
  await assert.rejects(saveSettings('call', { rate: 3 }, { conversation: null }), /0\.8 to 1\.4/);
  await assert.rejects(saveSettings('call', { engine: 'openai' }, { conversation: null }), /kokoro \| browser \| eleven/);
  await assert.rejects(saveSettings('nope', {}, { conversation: null }), /section/);
  await assert.rejects(saveSettings('agents', { colour: 'red' }, { conversation: null }), /not a setting/);
});

test('from Talk, raising costs needs J\'s quoted yes; lowering them does not', async () => {
  const conv = convWith('yes, let four agents run at once please');
  assert.deepEqual(costRaising('agents', { maxConcurrent: 4 }, { maxConcurrent: 2 }), ['maxConcurrent 2 → 4']);
  assert.deepEqual(costRaising('agents', { maxConcurrent: 1 }, { maxConcurrent: 2 }), []);
  await assert.rejects(saveSettings('agents', { maxConcurrent: 4 }, { conversation: conv }), /raise costs/);
  await assert.rejects(saveSettings('agents', { maxConcurrent: 4 }, { conversation: conv, quote: 'go ahead and do it' }), /raise costs/);
  assert.equal((await saveSettings('agents', { maxConcurrent: 4 }, { conversation: conv, quote: 'let four agents run at once' })).maxConcurrent, 4);
  assert.equal((await saveSettings('agents', { maxConcurrent: 3 }, { conversation: conv })).maxConcurrent, 3);
  // The paid voice is a cost too; the free ones aren't.
  await assert.rejects(saveSettings('call', { engine: 'eleven' }, { conversation: conv }), /ElevenLabs/);
  assert.equal((await saveSettings('call', { engine: 'kokoro', rate: 1.1 }, { conversation: conv })).engine, 'kokoro');
  // The notification topic stays the dashboard's.
  await assert.rejects(saveSettings('notify', { rotate: true }, { conversation: conv }), /dashboard/);
  // The dashboard (no conversation) may do all of it.
  assert.equal((await saveSettings('costs', { budget: 500 }, { conversation: null })).budget, 500);
});

test('the sandbox may change settings only from a Talk conversation', () => {
  assert.match(guardRoute('/api/settings', 'POST', null) ?? '', /Talk conversation/);
  assert.equal(guardRoute('/api/settings', 'POST', 't_123456'), null);
});

test('builds: the Unity compile gate is a setting; turning it on or raising its limit needs J\'s yes from Talk', async () => {
  const s = await allSettings();
  assert.deepEqual((s as any).builds, { unityCompile: true, unityCompileMaxCost: 3, handleFailures: true });
  const off = await saveSettings('builds', { unityCompile: false }, { conversation: null });
  assert.equal(off.unityCompile, false);
  const talk = convWith('hello');
  await assert.rejects(saveSettings('builds', { unityCompile: true }, { conversation: talk }), /raise costs/);
  const yes = convWith('yes, turn the compile check on');
  assert.equal((await saveSettings('builds', { unityCompile: true }, { conversation: yes, quote: 'yes, turn the compile check on' })).unityCompile, true);
  assert.equal((await saveSettings('builds', { unityCompile: false }, { conversation: talk })).unityCompile, false);
  await assert.rejects(saveSettings('builds', { unityCompileMaxCost: 500 }, { conversation: null }), /0\.10 to 100/);
});
