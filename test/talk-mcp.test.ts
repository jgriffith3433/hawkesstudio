// Talking with Talk through Studio's MCP (studio_talk, mcp-tools.ts): an assistant outside Studio sends a message and
// reads Talk's answer. Its messages are marked (via: 'mcp') and never count as J's own words: the guards (going live,
// rolling back, merges), J's quoted yes (memory.ts jSaid) and Talk's own MCP server, which doesn't list the tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-talkmcp-'));
process.env.STUDIO_TALK_POLL_MS = '5';

const { db } = await import('../src/db.ts');
await import('../src/talk.ts'); // the conversations table
const { studioMcp } = await import('../src/mcp-tools.ts');
const { guardRoute, lastJMessage } = await import('../src/guards.ts');
const { jSaid } = await import('../src/memory.ts');

const conv = (msgs: object[]) => {
  const id = `t_${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;
  db.prepare('INSERT INTO conversations (id, status, messages, created) VALUES (?, ?, ?, ?)').run(id, 'idle', JSON.stringify(msgs.map((m, i) => ({ at: i, ...m }))), Date.now());
  return id;
};
const tool = (studio: (p: string, o?: any) => Promise<any>) => studioMcp({ studio: studio as any, waitRun: (async () => ({})) as any }).tools.find((t) => t.name === 'studio_talk')!;

test('a message goes to Talk marked as through the MCP, and Talk\'s answer comes back', async () => {
  const calls: { p: string; o?: any }[] = [];
  let polls = 0;
  const t = tool(async (p, o) => {
    calls.push({ p, o });
    if (p === '/api/talk' && o?.method === 'POST') return { id: 't_abc123', status: 'thinking', messages: [{ role: 'user', text: o.body.message, at: 1, via: 'mcp' }] };
    if (p.startsWith('/api/talk/t_abc123')) {
      polls++;
      return polls < 3
        ? { status: 'thinking', messages: [{ role: 'user', text: 'How is Yooba Land?', at: 1, via: 'mcp' }], total: 1 }
        : { status: 'idle', title: 'How is Yooba Land?', messages: [{ role: 'user', text: 'How is Yooba Land?', at: 1, via: 'mcp' }, { role: 'tool', tool: 'studio_overview', text: 'x'.repeat(900), at: 2 }, { role: 'assistant', text: 'Beta is green.', at: 3 }], total: 3 };
    }
    throw new Error(`unexpected ${p}`);
  });
  const r: any = await t.run({ message: 'How is Yooba Land?', wait: 5 });
  assert.deepEqual(calls[0], { p: '/api/talk', o: { method: 'POST', body: { message: 'How is Yooba Land?', via: 'mcp' } } }, 'a new conversation, marked via mcp');
  // Reads from the message it sent, asking Studio to hold each read until Talk is done (wait=, never past the tool's own wait).
  assert.ok(calls.slice(1).every((c) => /^\/api\/talk\/t_abc123\?after=0&wait=[1-5]$/.test(c.p)), 'reads from the message it sent, held by Studio');
  assert.equal(polls, 3, 'waits while Talk is thinking');
  assert.equal(r.conversation, 't_abc123');
  assert.equal(r.answered, true);
  assert.equal(r.next, 3);
  assert.deepEqual(r.messages.map((m: any) => m.role), ['you', 'tool', 'talk']);
  assert.equal(r.messages[1].text.length, 300, 'tool output is cut short');
  assert.equal(r.messages[2].text, 'Beta is green.');
});

test('going on in a conversation, reading what is left, and the list', async () => {
  const calls: { p: string; o?: any }[] = [];
  const t = tool(async (p, o) => {
    calls.push({ p, o });
    if (p === '/api/talk' && o?.method === 'POST') return { id: o.body.conversation, status: 'thinking', messages: [{}, {}, {}, {}] };
    if (p === '/api/talk') return { conversations: [{ id: 't_1', title: 'A', status: 'idle', created: 0, updated: 1000, unseen: 2 }] };
    return { status: 'thinking', messages: [], total: 4 };
  });
  const r: any = await t.run({ message: 'and the bugs?', conversation: 't_beef00', wait: 0 });
  assert.deepEqual(calls[0].o.body, { message: 'and the bugs?', conversation: 't_beef00', via: 'mcp' });
  assert.equal(calls[1].p, '/api/talk/t_beef00?after=3', 'from the new message on');
  assert.equal(r.answered, false);
  assert.match(r.note, /after: 4/, 'says how to read the rest');

  calls.length = 0;
  await t.run({ conversation: 't_beef00', after: 4, wait: 0 });
  assert.deepEqual(calls.map((c) => c.p), ['/api/talk/t_beef00?after=4'], 'no message: only reads');

  const list: any = await t.run({});
  assert.deepEqual(list.conversations, [{ id: 't_1', title: 'A', status: 'idle', updated: new Date(1000).toISOString(), unseen: 2 }]);

  await assert.rejects(() => t.run({ message: 'hi', conversation: '../api/deploy/x' }), /conversation id/);
});

test("Talk's own MCP server doesn't list studio_talk", () => {
  const names = () => studioMcp({ studio: (async () => ({})) as any, waitRun: (async () => ({})) as any }).tools.map((t) => t.name);
  assert.ok(names().includes('studio_talk'));
  process.env.TALK_CONVERSATION = 't_000001';
  try {
    assert.ok(!names().includes('studio_talk'));
  } finally {
    delete process.env.TALK_CONVERSATION;
  }
});

test('a message through the MCP is never J\'s word', () => {
  const viaDeploy = conv([{ role: 'user', text: 'DEPLOY fasttest', via: 'mcp' }]);
  assert.equal(lastJMessage(viaDeploy), null);
  assert.match(guardRoute('/api/deploy/fasttest', 'POST', viaDeploy)!, /owner's word/, 'going live waits for J');
  assert.match(guardRoute('/api/rollback/fasttest', 'POST', viaDeploy)!, /owner's word/, 'so does a rollback');

  const jThenMcp = conv([{ role: 'user', text: 'DEPLOY fasttest' }, { role: 'assistant', text: 'Live.' }, { role: 'user', text: 'and the other one?', via: 'mcp' }]);
  assert.match(guardRoute('/api/deploy/fasttest', 'POST', jThenMcp)!, /owner's word/, "J's older words don't carry over past the MCP's message");

  const jSelf = conv([{ role: 'user', text: 'yes, raise the agents cap to 4', via: 'mcp' }, { role: 'user', text: 'DEPLOY fasttest' }]);
  assert.equal(guardRoute('/api/deploy/fasttest', 'POST', jSelf), null, "J's own newest message still counts");
  assert.equal(jSaid(jSelf, 'raise the agents cap to 4'), false, "a quoted yes must be J's, not the MCP's");
  assert.equal(jSaid(conv([{ role: 'user', text: 'yes, raise the agents cap to 4' }]), 'raise the agents cap to 4'), true);
});
