// The roadmap board (dashboard/roadmap.js): each milestone says "N of M items done", each item says its state and what
// blocks it in words, and the page learns of changes by the push stream's `roadmap` topic (no timer, no polling).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-roadmap-board-'));

const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'roadmap.js'), 'utf8');

/** Pulls the pure helpers out of the page script (it is a classic script that touches the DOM at load). */
function helpers() {
  const grab = (re: RegExp) => { const m = re.exec(src); assert.ok(m, `roadmap.js has ${re}`); return m![0]; };
  const code = [
    "const DONE_STATES = ['on beta', 'verified', 'live', 'done'];",
    grab(/function blockerWords\(it\) \{[\s\S]*?\n\}\n/),
  ].join('\n');
  const ctx: any = {};
  vm.runInNewContext(`${code}\nthis.blockerWords = blockerWords;`, ctx);
  return ctx.blockerWords as (it: any) => string;
}

test('an item says in words what it waits on, or that nothing blocks it', () => {
  const blockerWords = helpers();
  assert.match(blockerWords({ status: 'done', tasks: [], progress: { state: 'on beta' } }), /Nothing blocks it/);
  assert.match(blockerWords({ status: 'idea', tasks: [] }), /only an idea/);
  assert.match(blockerWords({ status: 'planned', tasks: [{ title: 'Do it', status: 'failed' }], progress: { state: 'needs you' } }), /Blocked on you: "Do it" failed/);
  assert.match(blockerWords({ status: 'planned', tasks: [{ title: 'Ask', status: 'needs answer' }], progress: { state: 'needs you' } }), /has a question for you/);
  assert.match(blockerWords({ status: 'planned', tasks: [], progress: { state: 'waiting for your GPU budget' } }), /GPU budget/);
  assert.match(blockerWords({ status: 'planned', tasks: [{ status: 'planned', blocked_by: ['t_1'] }], progress: { state: 'planned', next: 'it waits for t_1' } }), /^Blocked: it waits for t_1\.$/);
  assert.match(blockerWords({ status: 'planned', tasks: [], progress: { state: 'in progress', next: 'an agent is building it' } }), /^Waiting: an agent is building it\.$/);
});

test('the board shows items done of total per milestone and is redrawn by the roadmap push topic', () => {
  assert.match(src, /\$\{m\.done\} of \$\{m\.total\} items done/);
  assert.match(src, /studioStream\.on\(\['changes', 'inbox', 'roadmap'\]/);
  assert.doesNotMatch(src, /setInterval/);
});

test('the stream pushes `roadmap` when an item, task or milestone changes, and is quiet otherwise', async () => {
  const stream = await import('../src/stream.ts');
  const rm = await import('../src/roadmap.ts');
  stream.setProbes({ activity: async () => ({ count: 0, at: Date.now() }), inbox: async () => ({ count: 0, ids: [] }) });
  const server = http.createServer((req, res) => stream.handleStream(req, res, {}));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/stream`, { signal: ac.signal });
  const events: any[] = [];
  void (async () => {
    let buf = '';
    try {
      for await (const chunk of res.body as any) {
        buf += Buffer.from(chunk).toString();
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const data = /^data: (.*)$/m.exec(buf.slice(0, i))?.[1];
          buf = buf.slice(i + 2);
          if (data) events.push(JSON.parse(data));
        }
      }
    } catch { /* closed */ }
  })();
  const waitFor = async (pred: (e: any) => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!events.find(pred)) {
      if (Date.now() > end) throw new Error(`no such event; got ${JSON.stringify(events)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  try {
    await waitFor((e) => e.topic === 'activity');
    await new Promise((r) => setTimeout(r, 200));
    events.length = 0;
    const item = rm.addItem({ product: 'hawkesstudio', title: 'Board item', status: 'planned' });
    await waitFor((e) => e.topic === 'roadmap');
    events.length = 0;
    rm.addMilestone({ product: 'hawkesstudio', title: 'Board milestone', items: [item.id] });
    await waitFor((e) => e.topic === 'roadmap');
    events.length = 0;
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(events.filter((e) => e.topic === 'roadmap').length, 0, 'quiet again: nothing is pushed');
  } finally {
    ac.abort();
    for (let i = 0; i < 60 && stream.streamClients() > 0; i++) await new Promise((r) => setTimeout(r, 50));
    server.close();
  }
});
