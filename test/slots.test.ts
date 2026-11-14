// Studio's request slots (slots.ts; 2026-11-14 07:00-07:17Z J's pages got Cloud Run's "no available instance" 503):
// requests that stay open (event streams, streamed tool calls, waits) are held to HELD_MAX of the SLOTS, so page loads
// always get in; a stream over the cap ends the oldest stream, and every stream ends itself after STREAM_MAX_MS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-slots-'));

const slots = await import('../src/slots.ts');
const stream = await import('../src/stream.ts');
const { serveFeed } = await import('../src/feeds.ts');

/** A server like Studio's: tracks every request; /s is a dashboard stream, /f a feed, /mcp a slow tool call, else a page. */
function studio() {
  const server = http.createServer((req, res) => {
    const route = new URL(req.url ?? '/', 'http://x').pathname;
    slots.track(req, res, route);
    if (route === '/s') return stream.handleStream(req, res);
    if (route === '/f') return serveFeed(req, res, 'test-feed', { read: async () => ({ ok: 1 }) });
    if (route === '/mcp') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); slots.hold(res, 'mcp'); return void setTimeout(() => res.end('{}'), 60_000).unref(); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html>page');
  });
  server.keepAliveTimeout = 1;
  return server;
}

const agent = new http.Agent({ keepAlive: false, maxSockets: 500 });
/** Opens a stream; resolves when its headers arrive, and records when the server ends it. */
function openStream(port: number, p = '/s') {
  return new Promise<{ ended: () => boolean; close: () => void }>((resolve, reject) => {
    let done = false;
    const req = http.get({ host: '127.0.0.1', port, path: p, agent }, (res) => {
      res.on('data', () => {});
      res.on('end', () => { done = true; });
      res.on('close', () => { done = true; });
      resolve({ ended: () => done, close: () => req.destroy() });
    });
    req.on('error', () => { done = true; });
    req.on('error', reject);
  });
}
const until = async (f: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); }
};

test('streams never take more than HELD_MAX slots: a new one ends the oldest, and pages still load', async () => {
  slots.resetSlots();
  const server = studio();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const opened: { ended: () => boolean; close: () => void }[] = [];
  try {
    // Many more streams than the cap, as abandoned tabs and reconnects pile up (half dashboard, half feeds).
    for (let i = 0; i < slots.HELD_MAX + 25; i++) opened.push(await openStream(port, i % 2 ? '/f' : '/s'));
    await until(() => slots.summary().held <= slots.HELD_MAX);
    const s = slots.summary();
    assert.ok(s.held <= slots.HELD_MAX, `held ${s.held}`);
    assert.ok(s.ended.cap >= 25, `ended over the cap: ${s.ended.cap}`);
    // The oldest were ended (their pages reconnect), the newest are still open.
    await until(() => opened.slice(0, 25).every((o) => o.ended()));
    assert.ok(opened.slice(-slots.HELD_MAX).every((o) => !o.ended()), 'the newest streams stay open');
    // Room is left for everything else: a page load answers at once.
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /page/);
    assert.ok(slots.summary().open <= slots.SLOTS / 2 + 5, `open ${slots.summary().open}`);
  } finally {
    opened.forEach((o) => o.close());
    server.closeAllConnections();
    server.close();
  }
});

test('one stream per tab: a reload or reconnect from the same tab replaces its stream, other tabs keep theirs', async () => {
  slots.resetSlots();
  const server = studio();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const all: { ended: () => boolean; close: () => void }[] = [];
  try {
    const first = await openStream(port, '/s?tab=tabAAAAAA');
    const other = await openStream(port, '/s?tab=tabBBBBBB');
    all.push(first, other);
    for (let i = 0; i < 5; i++) all.push(await openStream(port, '/s?tab=tabAAAAAA')); // five reloads of tab A
    await until(() => slots.summary().held === 2);
    assert.equal(slots.summary().ended.replaced, 5);
    await until(() => first.ended());
    assert.ok(!other.ended(), "tab B's stream stays");
    assert.ok(!all[all.length - 1].ended(), "tab A's newest stream stays");
  } finally {
    all.forEach((o) => o.close());
    server.closeAllConnections();
    server.close();
  }
});

test('tool calls are counted as held but never cut; streams make room around them', async () => {
  slots.resetSlots();
  const server = studio();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const calls: { ended: () => boolean; close: () => void }[] = [];
  const streams: { ended: () => boolean; close: () => void }[] = [];
  try {
    for (let i = 0; i < 10; i++) calls.push(await openStream(port, '/mcp'));
    for (let i = 0; i < slots.HELD_MAX; i++) streams.push(await openStream(port, '/s'));
    await until(() => slots.summary().held <= slots.HELD_MAX);
    assert.equal(slots.summary().kinds.mcp, 10);
    assert.ok(calls.every((c) => !c.ended()), 'no tool call was cut');
    await until(() => streams.slice(0, 10).every((s) => s.ended()));
  } finally {
    [...calls, ...streams].forEach((o) => o.close());
    server.closeAllConnections();
    server.close();
  }
});

test('a stream ends itself after STREAM_MAX_MS, so one whose page left silently frees its slot', async (t) => {
  slots.resetSlots();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ended: string[] = [];
  const res = Object.assign(new (await import('node:events')).EventEmitter(), { writableEnded: false, end(this: any) { ended.push("x"); this.writableEnded = true; this.emit("close"); } }) as any;
  slots.track({} as any, res, '/api/stream');
  slots.hold(res, 'stream', slots.endStream(res));
  assert.equal(slots.summary().held, 1);
  t.mock.timers.tick(slots.STREAM_MAX_MS - 1);
  assert.equal(ended.length, 0);
  t.mock.timers.tick(1);
  assert.equal(ended.length, 1);
  assert.equal(slots.summary().open, 0);
  assert.equal(slots.summary().ended.age, 1);
});

test('crowded: Studio logs once what holds its requests, and again only after it calmed down', () => {
  slots.resetSlots();
  const lines: string[] = [];
  slots.setSlotLog((l) => lines.push(l));
  const EventEmitter = require_ee();
  const ress = Array.from({ length: slots.CROWDED + 5 }, () => new EventEmitter());
  ress.forEach((r, i) => slots.track({} as any, r as any, i % 3 ? '/api/stream' : '/api/projects/x/builds'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[slots\] 60 of 80 requests open .*\/api\/stream \d+/);
  ress.forEach((r) => r.emit('close'));
  assert.equal(slots.summary().open, 0);
  ress.forEach((r) => slots.track({} as any, r as any, '/x'));
  assert.equal(lines.length, 2);
  slots.setSlotLog((l) => console.log(l));
});

test('every request Studio holds open goes through the ledger (no stream or wait bypasses it)', () => {
  const src = (f: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', f), 'utf8');
  // Every text/event-stream response in Studio is held.
  for (const f of ['stream.ts', 'feeds.ts', 'mcp-core.ts', 'server.ts']) {
    const s = src(f);
    const streams = s.split("'Content-Type': 'text/event-stream'").length - 1;
    const holds = (s.match(/\bhold\(res, '(stream|mcp)'/g) ?? []).length;
    assert.ok(streams > 0 && holds >= streams, `${f}: ${streams} event streams, ${holds} held`);
  }
  // server.ts tracks every request before it routes it, and holds the waits.
  const server = src('server.ts');
  assert.ok(server.indexOf('track(req, res, route)') > 0 && server.indexOf('track(req, res, route)') < server.indexOf('handleMcp(req, res, route)'));
  assert.equal((server.match(/hold\(res, 'wait'\)/g) ?? []).length, 2);
  // The slots match the cell's Cloud Run concurrency.
  assert.match(src('cellrun.ts'), new RegExp(`maxInstanceRequestConcurrency: ${slots.SLOTS}\\b`));
});

function require_ee() {
  return class extends (globalThis as any).__EE {} as any;
}
(globalThis as any).__EE = (await import('node:events')).EventEmitter;
