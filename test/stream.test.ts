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
    assert.equal(page.events.length, 0, 'an idle page is sent nothing: no timer looks for changes');
    count = 2;
    stream.poke(); // nothing looks by itself: a database write, a Gen event or a poke does
    assert.deepEqual(await page.next((e) => e.topic === 'activity'), { topic: 'activity', count: 2 });
    inboxIds = ['q_1', 'q_2'];
    stream.poke();
    assert.equal((await page.next((e) => e.topic === 'inbox')).count, 2);
    assert.equal(stream.streamClients(), 1);
  } finally {
    page.close();
    // The server hears the page go away on its own time (slower on a busy CI machine).
    for (let i = 0; i < 60 && stream.streamClients() > 0; i++) await new Promise((r) => setTimeout(r, 50));
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

test('a database write is what makes the watcher look, and nothing else does', async () => {
  const { db, onDbWrite } = await import('../src/db.ts');
  let seen: string[] = [];
  const off = onDbWrite((t) => seen.push(t));
  db.prepare('INSERT INTO runs (id, kind, status, started) VALUES (?, ?, ?, ?)').run('r_streamtest', 'daily', 'running', Date.now());
  db.prepare('UPDATE runs SET status = ? WHERE id = ?').run('done', 'r_streamtest');
  db.prepare('SELECT * FROM runs').all();
  off();
  assert.deepEqual(seen, ['runs', 'runs'], 'inserts and updates are reported with their table; reads are not');

  let count = 1;
  stream.setProbes({ activity: async () => ({ count, at: Date.now() }), inbox: async () => ({ count: 0, ids: [] }) });
  const server = http.createServer((req, res) => stream.handleStream(req, res, {}));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const page = await connect((server.address() as any).port);
  try {
    await page.next((e) => e.topic === 'activity' && e.badge);
    page.events.length = 0;
    db.prepare('INSERT INTO runs (id, kind, status, started) VALUES (?, ?, ?, ?)').run('r_streamtest2', 'daily', 'running', Date.now());
    assert.ok(await page.next((e) => e.topic === 'runs'), 'a run written: the runs topic, without any polling');
    page.events.length = 0;
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(page.events.length, 0, 'quiet again: nothing is sent');
  } finally {
    page.close();
    for (let i = 0; i < 60 && stream.streamClients() > 0; i++) await new Promise((r) => setTimeout(r, 50));
    server.close();
    db.prepare('DELETE FROM runs WHERE id LIKE ?').run('r_streamtest%');
  }
});
