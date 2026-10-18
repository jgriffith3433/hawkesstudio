// The dashboard's push stream (stream.ts, GET /api/stream): a page gets a hello with the badges' counts, a "talk" event
// when a conversation is saved (with its id and the Talk tab's badge), and the watcher's events when what the activity
// panel or the Inbox shows moved; nothing is pushed or watched without a page connected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-stream-'));
process.env.STUDIO_STREAM_TICK_MS = '40';

const stream = await import('../src/stream.ts');
const talk = await import('../src/talk.ts');

/** A page: reads the stream's events as they come. */
async function connect(port: number) {
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/stream`, { signal: ac.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const events: any[] = [];
  const waiters: (() => void)[] = [];
  void (async () => {
    let buf = '';
    try {
      for await (const chunk of res.body as any) {
        buf += Buffer.from(chunk).toString();
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (data) events.push(JSON.parse(data));
          waiters.splice(0).forEach((w) => w());
        }
      }
    } catch { /* closed */ }
  })();
  const next = async (pred: (e: any) => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      const e = events.find(pred);
      if (e) return e;
      if (Date.now() > end) throw new Error(`no such event; got ${JSON.stringify(events)}`);
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  };
  return { events, next, close: () => ac.abort() };
}

test('hello, talk changes and the watcher reach a connected page', async () => {
  let count = 1;
  let inboxIds = ['q_1'];
  stream.setProbes({
    activity: async () => ({ count, changes: [], at: Date.now() }),
    inbox: async () => ({ count: inboxIds.length, ids: inboxIds }),
  });
  const id = talk.postNotice('Stream test', 'something came back'); // nobody connected: nothing to push
  const server = http.createServer((req, res) => stream.handleStream(req, res, { talkUnseen: talk.unseenConversations() }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const page = await connect(port);
  try {
    const hello = await page.next((e) => e.topic === 'hello');
    assert.equal(hello.talkUnseen, 1, "the Talk tab's badge comes with the hello");
    // The watcher's first look: the counts only, for the badges.
    assert.deepEqual(await page.next((e) => e.topic === 'activity'), { topic: 'activity', count: 1, badge: true });
    assert.equal((await page.next((e) => e.topic === 'inbox')).count, 1);

    // A conversation saved: its id and the badge.
    const c = talk.getConversation(id)!;
    c.messages.push({ role: 'assistant', text: 'and another', at: Date.now() });
    talk.saveConversation(c);
    const ev = await page.next((e) => e.topic === 'talk');
    assert.deepEqual(ev.ids, [id]);
    assert.equal(ev.unseen, 1);

    // What moves on its own (the time of the read) is no change; a real one is, with the new count.
    page.events.length = 0;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(page.events.filter((e) => e.topic === 'activity').length, 0, 'nothing changed: no event');
    count = 2;
    assert.deepEqual(await page.next((e) => e.topic === 'activity'), { topic: 'activity', count: 2 });
    inboxIds = ['q_1', 'q_2'];
    stream.poke();
    assert.equal((await page.next((e) => e.topic === 'inbox')).count, 2);
    assert.equal(stream.streamClients(), 1);
  } finally {
    page.close();
    await new Promise((r) => setTimeout(r, 100));
    server.close();
  }
  assert.equal(stream.streamClients(), 0, 'the page went away');
});

test('the activity signature ignores what moves by itself', () => {
  const a = { at: 1, count: 1, commands: [{ cmd: 'git fetch', seconds: 3, slow: false }], loop: { lastMinute: { max: 4 }, blocks: [] } };
  const b = { at: 2, count: 1, commands: [{ cmd: 'git fetch', seconds: 9, slow: true }], loop: { lastMinute: { max: 7 }, blocks: [] } };
  assert.equal(stream.signature(a), stream.signature(b));
  assert.notEqual(stream.signature(a), stream.signature({ ...b, commands: [] }));
});
