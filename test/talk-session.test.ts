// Talk's sessions and the harness hold (J, 2026-10-23): a session that can't be resumed (another harness made it: the
// PM's Gemini session failed on Claude every turn all day) starts again in a new session with the conversation so far;
// a real answer on a harness held for its usage lifts the hold, so the agents don't wait hours for the reset time; and
// the model pinned in Settings doesn't override routing on Claude Code. Claude Code is the stand-in fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-talk-session-'));
process.env.STUDIO_DATA = scratch;
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9';
const logFile = path.join(scratch, 'claude.jsonl');
process.env.FAKE_CLAUDE_LOG = logFile;
process.env.TALK_CLAUDE = process.execPath;
process.env.TALK_CLAUDE_ARGS = JSON.stringify([path.join(import.meta.dirname, 'fixture', 'fake-claude.mjs')]);
for (const k of ['HAWKES_BRAIN', 'TALK_MODEL', 'STUDIO_SERVER']) delete process.env[k];

const { startConversation, getConversation, say } = await import('../src/talk.ts');
const hold = await import('../src/harness-hold.ts');
const { modelPin } = await import('../src/routing.ts');
const { saveBrain } = await import('../src/brains.ts');
const { db, J } = await import('../src/db.ts');

Object.assign(hold.holdDeps, { probe: async () => ({ ok: false, note: 'no answer' }), configured: () => true, otherAccounts: async () => [], syncGen: async () => {}, talk: async () => {}, phone: async () => {} });
saveBrain({ harness: 'claude', model: '' }, 'test');

const until = async (f: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const logged = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const starts = () => logged().filter((l) => l.start).map((l) => l.start as string[]);
const idle = (id: string) => getConversation(id)!.status === 'idle';
/** A conversation that already had a turn, on `harness`, with `session` saved. */
function withHistory(session: string, harness: string) {
  const c = startConversation('Studio PM: test');
  const msgs = [
    { role: 'user', text: 'What is ready?', at: Date.now() - 60_000 },
    { role: 'assistant', text: 'Two changes are ready.', at: Date.now() - 59_000, turn: { cost: 0.01, billing: 'subscription', harness, model: 'x' } },
  ];
  db.prepare('UPDATE conversations SET session = ?, messages = ? WHERE id = ?').run(session, J(msgs), c.id);
  return c.id;
}

test('a dead session (an error before any model call) starts again once in a new session, with the conversation so far', { timeout: 20_000 }, async () => {
  const id = withHistory('dead-session', 'claude');
  const before = starts().length;
  say(id, 'Anything new?');
  await until(() => idle(id) && starts().length >= before + 2);
  const [first, second] = starts().slice(before);
  assert.equal(first[first.indexOf('--resume') + 1], 'dead-session');
  assert.ok(!second.includes('--resume'), 'the retry is a new session');
  assert.match(second[second.indexOf('-p') + 1], /continues from an earlier session[\s\S]*Two changes are ready[\s\S]*Anything new\?/);
  const conv = getConversation(id)!;
  assert.equal(conv.session, 'fake-session');
  assert.ok(!conv.messages.some((m) => /stopped: error_during_execution/.test(m.text)), 'the failed try leaves no stop line');
  assert.equal(conv.messages.at(-1)!.text, 'Sure. The trial found two bugs.');
});

test('a session another harness made is not resumed: the turn starts a new one at once', { timeout: 20_000 }, async () => {
  const id = withHistory('gemini-session-1', 'gemini');
  const before = starts().length;
  say(id, 'Status?');
  await until(() => idle(id) && starts().length >= before + 1);
  const run = starts()[before];
  assert.ok(!run.includes('--resume'), 'a Gemini session is never resumed on Claude');
  assert.match(run[run.indexOf('-p') + 1], /continues from an earlier session/);
  assert.equal(starts().length, before + 1, 'one start, no failed try first');
  assert.equal(getConversation(id)!.session, 'fake-session');
});

test('a real Talk answer lifts a usage hold that began before its turn', { timeout: 20_000 }, async () => {
  hold.holdHarness({ kind: 'usage', line: "You've hit your session limit · resets 11:40pm (UTC)", resetsAt: Date.now() + 3 * 3600_000 }, { source: 'test', harness: 'claude', now: Date.now() - 1000 });
  assert.equal(hold.harnessHeld('claude'), true);
  const c = startConversation('Horse');
  say(c.id, 'Why did the horse not get made?');
  await until(() => idle(c.id));
  await until(() => !hold.harnessHeld('claude'), 3000);
  assert.match(hold.getHold('claude')!.log.at(-1)!, /lifted: Talk answered on it/);
  // A turn that started before the hold doesn't count, and billing or login holds wait for J.
  hold.holdHarness({ kind: 'usage', line: 'usage limit', resetsAt: null }, { source: 'test', harness: 'claude' });
  assert.equal(hold.answeredOn('claude', Date.now() - 3600_000, 'old turn'), null);
  const since = hold.getHold('claude')!.since;
  assert.ok(hold.answeredOn('claude', since + 10, 'new turn', since + 20), 'a turn after the hold began lifts it');
  assert.equal(hold.harnessHeld('claude'), false);
  hold.holdHarness({ kind: 'billing', line: 'credit balance is too low', resetsAt: null }, { source: 'test', harness: 'claude' });
  assert.equal(hold.answeredOn('claude', Date.now(), 'turn'), null);
  hold.liftHold('test done', 'claude');
});

test('routing wins over the Settings model pin on Claude Code; other harnesses keep their pin', () => {
  assert.equal(modelPin({ harness: 'claude', model: 'claude-sonnet-5-5' }, { enabled: true }), '');
  assert.equal(modelPin({ harness: 'claude', model: 'claude-sonnet-5-5' }, { enabled: false }), 'claude-sonnet-5-5');
  assert.equal(modelPin({ harness: 'cursor', model: 'grok-4.7' }, { enabled: true }), 'grok-4.7');
  assert.equal(modelPin({ harness: 'claude', model: '' }, { enabled: true }), '');
});

test('with a pin saved, a routed Talk turn still runs on its own model', { timeout: 20_000 }, async () => {
  saveBrain({ harness: 'claude', model: 'claude-sonnet-5-5' }, 'test');
  const c = startConversation('Fable ask');
  const before = starts().length;
  say(c.id, 'Plan the next milestone, and use Fable for it');
  await until(() => idle(c.id) && starts().length >= before + 1);
  const run = starts()[before];
  assert.equal(run[run.indexOf('--model') + 1], 'claude-fable-5-1', 'J asked for Fable: the pin doesn\'t turn it into Sonnet');
  saveBrain({ harness: 'claude', model: '' }, 'test');
});
