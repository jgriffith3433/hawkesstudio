// Calls (talk.ts): a call keeps one warm Claude Code process for the conversation (each message goes to its stdin),
// asks for spoken answers, streams the text as events, interrupts instead of killing on stop, and after hanging up the
// conversation goes on as a normal chat (a process per turn again).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-call-'));
process.env.STUDIO_DATA = scratch;
const logFile = path.join(scratch, 'claude.jsonl');
process.env.FAKE_CLAUDE_LOG = logFile;
process.env.TALK_CLAUDE = process.execPath;
process.env.TALK_CLAUDE_ARGS = JSON.stringify([path.join(import.meta.dirname, 'fixture', 'fake-claude.mjs')]);

const { startConversation, getConversation, say, stop, startCall, endCall, callInfo, talkEvents } = await import('../src/talk.ts');

const until = async (f: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const logged = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const starts = () => logged().filter((l) => l.start);
const idle = (id: string) => getConversation(id)!.status === 'idle';

test('a call answers every turn from one warm process, spoken-style, streaming events', { timeout: 20_000 }, async () => {
  const c = startConversation('Call');
  const events: any[] = [];
  talkEvents.on(c.id, (e) => events.push(e));
  assert.equal(startCall(c.id).active, true);
  await until(() => starts().length === 1);
  const warm = starts()[0].start as string[];
  assert.ok(warm.includes('--input-format'));
  assert.match(warm[warm.indexOf('--append-system-prompt') + 1], /voice call/);

  say(c.id, 'What did the trial find?', [], { voice: true });
  await until(() => idle(c.id));
  say(c.id, 'And yesterday?', [], { voice: true });
  await until(() => idle(c.id) && getConversation(c.id)!.messages.length >= 4);

  const conv = getConversation(c.id)!;
  assert.equal(starts().length, 1, 'both turns ran in the warm process');
  assert.deepEqual(conv.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(conv.messages[0].voice, true);
  assert.equal(conv.messages[1].text, 'Sure. The trial found two bugs.');
  assert.equal(conv.messages[1].turn?.call, true);
  assert.equal(conv.session, 'fake-session');
  const types = events.map((e) => e.type);
  assert.deepEqual(types.slice(0, 6), ['turn', 'start', 'delta', 'delta', 'end', 'idle']);
  assert.equal(events.filter((e) => e.type === 'delta').slice(0, 2).map((e) => e.text).join(''), 'Sure. The trial found two bugs.');
  endCall(c.id);
});

test('stop interrupts a call turn: what was said stays, the process goes on', { timeout: 20_000 }, async () => {
  const c = startConversation('Barge-in');
  startCall(c.id);
  const before = starts().length;
  await until(() => starts().length === before + 1);
  say(c.id, 'Count slowly', [], { voice: true });
  await until(() => (getConversation(c.id)!.partial ?? '').includes('Two'));
  assert.equal(stop(c.id), true);
  await until(() => idle(c.id));
  let conv = getConversation(c.id)!;
  const last = conv.messages.at(-1)!;
  assert.match(last.text, /^One\. Two\..* …$/);
  assert.equal(last.turn?.stopped, true);
  assert.ok(logged().some((l) => l.interrupt));

  say(c.id, 'Go on', [], { voice: true });
  await until(() => idle(c.id) && getConversation(c.id)!.messages.at(-1)!.text === 'Sure. The trial found two bugs.');
  assert.equal(starts().length, before + 1, 'the same process answered after the interrupt');

  // Hanging up: the process ends, and the next message is a normal chat turn (its own process, no voice prompt).
  assert.equal(endCall(c.id), true);
  assert.equal(callInfo(c.id).active, false);
  say(c.id, 'Typed now');
  await until(() => idle(c.id) && getConversation(c.id)!.messages.at(-1)!.role === 'assistant' && getConversation(c.id)!.messages.length >= 6);
  const chat = starts().at(-1)!.start as string[];
  assert.ok(!chat.includes('--input-format'));
  assert.doesNotMatch(chat[chat.indexOf('--append-system-prompt') + 1], /voice call/);
  assert.equal(chat[chat.indexOf('--resume') + 1], 'fake-session');
  conv = getConversation(c.id)!;
  assert.equal(conv.messages.at(-1)!.turn?.call, undefined);
});
