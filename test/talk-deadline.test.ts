// Talk turns that never end (2026-11-01: conversations showed "Claude is answering" for 12 to 14 hours after Studio's
// Cloud Run instance restarted). A turn has an overall deadline: its process is stopped, and if the stop doesn't land (a
// detached process Studio lost), the conversation is let go of anyway, idle with a line saying the answer timed out. A
// turn resumed after a restart is followed again on Cloud Run even when it was cut off before its first line was saved,
// and a Cloud Run job whose execution can't be found any more ends instead of being followed forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-talk-deadline-'));
process.env.STUDIO_DATA = scratch;
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9';
process.env.STUDIO_DETACH = 'off';
process.env.TALK_CLAUDE = process.execPath;
process.env.TALK_CLAUDE_ARGS = JSON.stringify([path.join(import.meta.dirname, 'fixture', 'fake-claude.mjs')]);
process.env.FAKE_CLAUDE_SLOW_MS = '4000';
process.env.TALK_TURN_DEADLINE_MS = '1000'; // the deadline's floor is 5 s: it fires then
process.env.TALK_TURN_KILL_GRACE_MS = '500';
process.env.STUDIO_JOB_POLL_MS = '50';
process.env.STUDIO_JOB_UNKNOWN_MS = '300';
for (const k of ['HAWKES_BRAIN', 'TALK_MODEL', 'STUDIO_SERVER']) delete process.env[k];

const { startConversation, getConversation, say, resumeTalk, isStopMarker } = await import('../src/talk.ts');
const { saveBrain } = await import('../src/brains.ts');
const { db, J } = await import('../src/db.ts');
const { setJobRunner, reattachCloudJob } = await import('../src/cloudjob.ts');
const { DetachedChild } = await import('../src/detach.ts');
saveBrain({ harness: 'claude', model: '' }, 'test');

const until = async (f: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const idle = (id: string) => getConversation(id)!.status === 'idle';

/** A fake bucket and Cloud Run job (cloudjob.ts JobRunner). */
function fakeRunner(bucket: Map<string, Buffer>) {
  return () => ({
    put: async (k: string, d: Buffer | string) => void bucket.set(k, Buffer.from(d)),
    get: async (k: string) => bucket.get(k) ?? null,
    list: async (prefix: string) => [...bucket.keys()].filter((k) => k.startsWith(prefix)),
    remove: async (k: string) => void bucket.delete(k),
    start: async () => 'executions/never',
    state: async () => ({ done: false, message: '' }),
    cancel: async () => {},
  });
}

/** A conversation Studio left "thinking" with a detached turn recorded (as a restart finds it). */
function thinking(rec: Record<string, unknown>, offset = 0) {
  const c = startConversation('Studio PM: test');
  const userAt = Date.now() - 1000;
  const msgs = [{ role: 'user', text: 'What is ready?', at: userAt }];
  db.prepare("UPDATE conversations SET status = 'thinking', messages = ?, proc = ? WHERE id = ?").run(J(msgs), J({ rec, offset, userAt, auto: false, billing: 'subscription', harness: 'claude', model: 'x' }), c.id);
  return c.id;
}

test('a turn past the deadline is stopped: idle again, what it wrote kept, and a line saying it timed out', { timeout: 30_000 }, async () => {
  const c = startConversation('Slow one');
  say(c.id, 'a slow answer please');
  assert.equal(getConversation(c.id)!.status, 'thinking');
  await until(() => idle(c.id));
  const conv = getConversation(c.id)!;
  const last = conv.messages.at(-1)!;
  assert.match(last.text, /^\(Claude\b.* stopped: the answer timed out after 1 min, so Studio ended it\. Ask again/);
  assert.ok(isStopMarker(last), 'the line is a stop marker');
  assert.equal(last.turn?.stopped, true);
  assert.ok(conv.messages.some((m) => /^One\. .*…$/.test(m.text)), 'what Claude had written stays');
  assert.equal(conv.messages.filter((m) => /couldn't answer/.test(m.text)).length, 0);
  // The conversation takes a new message at once.
  process.env.FAKE_CLAUDE_SLOW_MS = '5';
  say(c.id, 'Anything new?');
  await until(() => idle(c.id));
  assert.equal(getConversation(c.id)!.messages.at(-1)!.text, 'Sure. The trial found two bugs.');
});

test('a resumed turn whose process Studio lost (its stop never lands) is let go of after the grace', { timeout: 30_000 }, async () => {
  // A Cloud Run job Studio can't follow (no workspace recorded): nothing will ever write its end.
  const id = thinking({ unit: `hawkes-talk-lost-${Date.now().toString(36)}`, mode: 'cloudrun', started: Date.now() - 12 * 3600_000 });
  assert.ok(resumeTalk().includes(id));
  await until(() => idle(id));
  const conv = getConversation(id)!;
  assert.match(conv.messages.at(-1)!.text, /timed out .* Ask again to get an answer/);
  assert.equal((db.prepare('SELECT proc FROM conversations WHERE id = ?').get(id) as any).proc, null, 'its process record is cleared');
  assert.deepEqual(resumeTalk().filter((x) => x === id), [], 'a later restart leaves it alone');
});

test('a Cloud Run turn cut off before its first line was saved is followed again after a restart and gets its answer', { timeout: 30_000 }, async () => {
  const bucket = new Map<string, Buffer>();
  setJobRunner(fakeRunner(bucket));
  try {
    const unit = `hawkes-talk-cut-${Date.now().toString(36)}`;
    const lines = [
      { type: 'system', subtype: 'init', session_id: 'job-session', apiKeySource: 'none' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done after the restart.' }] } },
      { type: 'result', subtype: 'success', session_id: 'job-session', total_cost_usd: 0.01, duration_ms: 5 },
    ];
    bucket.set(`jobs/${unit}/execution.txt`, Buffer.from('executions/e1'));
    bucket.set(`jobs/${unit}/out/log-000001`, Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n'));
    bucket.set(`jobs/${unit}/out/exit.json`, Buffer.from(JSON.stringify({ code: 0, signal: null })));
    // offset 0: the old instance died before it saved any line (it used to mean nobody followed the job again).
    const id = thinking({ unit, mode: 'cloudrun', started: Date.now() - 60_000, cwd: scratch }, 0);
    assert.ok(resumeTalk().includes(id));
    await until(() => idle(id));
    const conv = getConversation(id)!;
    assert.equal(conv.messages.at(-1)!.text, 'Done after the restart.');
    assert.equal(conv.session, 'job-session');
  } finally {
    setJobRunner(null);
  }
});

test('a reattached Cloud Run job whose execution is nowhere ends with the reason instead of being followed forever', { timeout: 20_000 }, async () => {
  setJobRunner(fakeRunner(new Map()));
  try {
    const unit = `hawkes-talk-gone-${Date.now().toString(36)}`;
    const rec = { unit, mode: 'cloudrun' as const, started: Date.now() - 60_000, cwd: scratch };
    reattachCloudJob(unit, scratch);
    const child = new DetachedChild(rec, { reattached: true });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 1);
    const exit = JSON.parse(fs.readFileSync(path.join(scratch, 'detached', `${unit}.exit`), 'utf8'));
    assert.match(exit.error, /can't be found/);
  } finally {
    setJobRunner(null);
  }
});
