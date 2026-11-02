// No polling (J, 2026-11-02: "Please stop implementing polling if at all possible it causes all the problems"; polling
// through the hawkes-studio-edge Worker burned 100k requests in a day). The dashboard learns of changes from the push
// stream (src/stream.ts, src/feeds.ts) or fetches on page open / a user action / an event. This test keeps it that way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-nopoll-'));

const { serveFeed, pokeFeeds, feedClients } = await import('../src/feeds.ts');

const dash = path.join(import.meta.dirname, '..', 'dashboard');
const files = fs.readdirSync(dash).filter((f) => f.endsWith('.js'));
const read = (f: string) => fs.readFileSync(path.join(dash, f), 'utf8');

/**
 * Every setInterval in dashboard/*.js, with why it is not a poll. A new one needs a written reason here: it must not
 * fetch on a timer. (setTimeout that fetches again and again is the same thing: don't.)
 */
const INTERVALS: Record<string, { count: number; why: string }> = {
  'activity.js': { count: 1, why: 'plays the screenshots already loaded in the Activity panel (an animation); fetches only when the push stream says the run moved' },
  'call.js': { count: 1, why: 'a call\'s 20 s check-in tells the server the call is still open (a heartbeat that keeps its Claude process warm), it asks for nothing' },
  'report-widget.js': { count: 3, why: 'the 🐞 widget\'s local HUD, scene probe and fps badge: no requests' },
};

test('the dashboard has no timer that asks the server again and again', () => {
  for (const f of files) {
    const n = (read(f).match(/\bsetInterval\s*\(/g) ?? []).length;
    const allowed = INTERVALS[f]?.count ?? 0;
    assert.equal(n, allowed, `${f}: ${n} setInterval (allowed ${allowed}). No polling: use the push stream (studioStream.on) or an on-demand fetch; a timer needs a written reason in this test.`);
  }
  for (const f of Object.keys(INTERVALS)) assert.ok(files.includes(f), `${f} is gone: drop it from INTERVALS`);
});

test('the polls that were removed stay removed', () => {
  const stream = read('stream.js');
  assert.ok(!/safety/i.test(stream.replace(/\/\/.*$/gm, '')), "the stream has no safety tick");
  const live = read('live.js');
  assert.ok(!/frame\?player|FRAME_EVERY|toPoll/.test(live), 'the Playtests page has no single-frame fallback');
  assert.ok(!/setTimeout\(\s*poll/.test(live), 'no repeating frame request');
  assert.ok(!/ptSchedule/.test(read('playtests.js')), 'the playtest history list does not refresh itself on a timer');
  assert.ok(!/setInterval/.test(read('broadcast.js')), "On Air has no fallback timer (the feed is pushed)");
  assert.ok(!/svcTimer/.test(read('settings.js')), 'the restart box does not poll');
});

test('a pushed feed reads when poked, not on a timer', async () => {
  let reads = 0;
  let value = 1;
  const server = http.createServer((req, res) => serveFeed(req, res, 'playtest:j_a', { read: async () => { reads++; return { value }; } }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const got: any[] = [];
  const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (c: string) => { for (const m of c.matchAll(/^data: (.+)$/gm)) got.push(JSON.parse(m[1])); });
  });
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(feedClients('playtest:j_a'), 1);
    assert.deepEqual(got, [{ value: 1 }], 'read once when the page opened');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(reads, 1, 'idle: no read at all');
    value = 2;
    pokeFeeds('playtest', 20);
    pokeFeeds('playtest', 20); // a burst is one read
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(reads, 2);
    assert.deepEqual(got.at(-1), { value: 2 }, 'a Gen event pokes the feed and the page gets the new state');
    pokeFeeds('broadcast', 20);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(reads, 2, 'only feeds with that prefix');
  } finally {
    req.destroy();
    await new Promise((r) => setTimeout(r, 100));
    server.close();
  }
});
