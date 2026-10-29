// Tests for the native playtest transport: frames, the server, the runner's session, and whole runs against a fake
// game.   node --test clients/native/test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { encodeFrame, FrameReader, OP, ProtocolError, acceptKey, listen } from '../ws-server.mjs';
import { RunnerSession, parseMessage, helloProblem, addressFrom, launchWith, CLOSE } from '../protocol.mjs';
import { runPlaytest, parseArgs } from '../test-runner.mjs';

const FAKE = fileURLToPath(new URL('./fake-game.mjs', import.meta.url));
const MASK = [1, 2, 3, 4];

test('accept key matches RFC 6455 example', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('frames round-trip at every length encoding, masked', () => {
  for (const len of [0, 5, 125, 126, 65535, 65536, 200000]) {
    const payload = Buffer.alloc(len, 'x');
    const r = new FrameReader();
    const [m] = r.push(encodeFrame(OP.text, payload, MASK));
    assert.equal(m.opcode, OP.text);
    assert.equal(m.payload.length, len);
    assert.ok(m.payload.equals(payload));
  }
});

test('frames arriving a byte at a time are assembled', () => {
  const r = new FrameReader();
  const bytes = Buffer.concat([encodeFrame(OP.text, '{"a":1}', MASK), encodeFrame(OP.text, '{"b":2}', MASK)]);
  const out = [];
  for (const b of bytes) out.push(...r.push(Buffer.from([b])));
  assert.deepEqual(out.map((m) => m.payload.toString()), ['{"a":1}', '{"b":2}']);
});

test('fragmented messages join, with a ping in between', () => {
  const r = new FrameReader();
  const first = encodeFrame(OP.text, 'hel', MASK);
  first[0] &= 0x7f; // FIN off
  const middle = encodeFrame(OP.cont, 'lo ', MASK);
  middle[0] &= 0x7f;
  const out = r.push(Buffer.concat([first, encodeFrame(OP.ping, 'p', MASK), middle, encodeFrame(OP.cont, 'world', MASK)]));
  assert.deepEqual(out.map((m) => [m.opcode, m.payload.toString()]), [[OP.ping, 'p'], [OP.text, 'hello world']]);
});

test('unmasked client frames, oversize messages and stray continuations are protocol errors', () => {
  assert.throws(() => new FrameReader().push(encodeFrame(OP.text, 'x')), ProtocolError);
  assert.throws(() => new FrameReader({ maxMessage: 10 }).push(encodeFrame(OP.text, Buffer.alloc(11), MASK)), (e) => e.code === 1009);
  assert.throws(() => new FrameReader().push(encodeFrame(OP.cont, 'x', MASK)), ProtocolError);
});

test('server: only the token path, only one client, text both ways', async () => {
  let conn;
  const got = [];
  const srv = await listen({ token: 'abc123', onConnection: (c) => { conn = c; c.on('text', (t) => { got.push(t); c.send(`echo ${t}`); }); } });
  try {
    const wrong = await openWs(`ws://127.0.0.1:${srv.port}/nope`);
    assert.equal(wrong.ok, false);
    const ws = new WebSocket(srv.url);
    const reply = await new Promise((resolve, reject) => {
      ws.onopen = () => ws.send('hi '.repeat(50000)); // > 64 KiB: the 8-byte length
      ws.onmessage = (e) => resolve(e.data);
      ws.onerror = reject;
    });
    assert.equal(reply, `echo ${'hi '.repeat(50000)}`);
    const second = await openWs(srv.url);
    assert.equal(second.ok, false);
    const closed = new Promise((r) => conn.on('close', r));
    ws.close(1000, 'bye');
    const info = await closed;
    assert.equal(info.code, 1000);
    assert.equal(info.clean, true);
    assert.equal(got.length, 1);
  } finally {
    await srv.close();
  }
});

function openWs(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.onopen = () => { ws.close(); resolve({ ok: true }); };
    ws.onerror = () => resolve({ ok: false });
  });
}

const hello = (extra = {}) => JSON.stringify({ type: 'hello', version: 2, product: 'g', scenarios: [{ id: 'smoke', title: 'S', seconds: 5 }], ready: false, ...extra });

function session() {
  const sent = [];
  const s = new RunnerSession((t) => sent.push(JSON.parse(t)));
  return { s, sent };
}

test('parseMessage and helloProblem', () => {
  assert.equal(parseMessage('nope').ok, false);
  assert.equal(parseMessage('[1]').ok, false);
  assert.equal(parseMessage('{"x":1}').ok, false);
  assert.equal(parseMessage('{"type":"state"}').ok, true);
  assert.equal(helloProblem({ version: 2, product: 'p', scenarios: [] }), null);
  assert.match(helloProblem({ version: 3, product: 'p', scenarios: [] }), /unsupported/);
  assert.match(helloProblem({ version: 2, scenarios: [] }), /product/);
});

test('hello is answered with welcome and sets the first state', () => {
  const { s, sent } = session();
  s.handle(hello());
  assert.deepEqual(sent, [{ type: 'welcome', version: 2 }]);
  assert.equal(s.state.ready, false);
  assert.equal(s.scenarios[0].id, 'smoke');
});

test('an unsupported version is fatal with 4000', () => {
  const { s } = session();
  let fatal;
  s.on('fatal', (f) => (fatal = f));
  s.handle(hello({ version: 1 }));
  assert.equal(fatal.code, CLOSE.version);
  assert.equal(s.hello, null);
});

test('replies match their requests by id, in any order; pushes have no re', async () => {
  const { s, sent } = session();
  s.handle(hello());
  const st = s.getState();
  const rp = s.getReport();
  const [stateReq, reportReq] = sent.slice(1);
  assert.equal(stateReq.type, 'state?');
  assert.equal(reportReq.type, 'report?');
  assert.notEqual(stateReq.id, reportReq.id);
  let pushed = null;
  s.on('report', (r) => (pushed = r));
  s.handle(JSON.stringify({ type: 'report', re: reportReq.id, report: { scenario: 'smoke', outcome: 'won' } }));
  s.handle(JSON.stringify({ type: 'state', state: { ready: true, status: 'running' } })); // a push in between
  s.handle(JSON.stringify({ type: 'state', re: stateReq.id, state: { ready: true, status: 'won' } }));
  assert.equal((await st).status, 'won');
  assert.equal((await rp).outcome, 'won');
  assert.equal(pushed, null, 'a reply is not a push');
  assert.equal(s.timeline.length, 3);
  s.handle(JSON.stringify({ type: 'report', report: { scenario: 'smoke', outcome: 'lost' } }));
  assert.equal(pushed.outcome, 'lost');
});

test('start resolves ok:false with the error the game gives', async () => {
  const { s, sent } = session();
  s.handle(hello());
  const p = s.start('nope', { seed: 4 });
  const req = sent.at(-1);
  assert.deepEqual(req, { type: 'start', id: req.id, scenario: 'nope', options: { seed: 4 } });
  s.handle(JSON.stringify({ type: 'ack', re: req.id, ok: false, error: 'no playtest scenario "nope"' }));
  assert.deepEqual(await p, { ok: false, error: 'no playtest scenario "nope"' });
});

test('input has no id; events and logs are kept; unknown types are ignored', () => {
  const { s, sent } = session();
  s.handle(hello());
  s.input('jump', 1);
  assert.deepEqual(sent.at(-1), { type: 'input', action: 'jump', down: true });
  s.handle(JSON.stringify({ type: 'event', event: { t: 1.5, type: 'scene', detail: 'L1' } }));
  s.handle(JSON.stringify({ type: 'log', level: 'loud', line: 'x' }));
  s.handle(JSON.stringify({ type: 'telemetry', whatever: 1 }));
  assert.equal(s.events[0].detail, 'L1');
  assert.equal(s.logs[0].level, 'info');
  assert.equal(s.badMessages, 0);
});

test('messages before hello and garbage count as bad; ten close the connection with 4002', () => {
  const { s } = session();
  let fatal = null;
  s.on('fatal', (f) => (fatal = f));
  s.handle(JSON.stringify({ type: 'state', state: {} }));
  for (let i = 0; i < 8; i++) s.handle('garbage');
  assert.equal(fatal, null);
  s.handle('garbage');
  assert.equal(fatal.code, CLOSE.protocol);
});

test('closing fails requests still waiting', async () => {
  const { s } = session();
  s.handle(hello());
  const p = s.getState();
  s.closedBy({ code: 1006 });
  await assert.rejects(p, /closed/);
});

test('addressFrom: the argument wins over the variable; both forms of the argument', () => {
  const env = { HAWKES_PLAYTEST: 'ws://127.0.0.1:1/env' };
  assert.equal(addressFrom([], env), 'ws://127.0.0.1:1/env');
  assert.equal(addressFrom(['--hawkes-playtest=ws://127.0.0.1:1/arg'], env), 'ws://127.0.0.1:1/arg');
  assert.equal(addressFrom(['--hawkes-playtest', 'ws://127.0.0.1:1/sp'], {}), 'ws://127.0.0.1:1/sp');
  assert.equal(addressFrom(['-x'], {}), null);
  const l = launchWith('ws://u', 'arg', { HAWKES_PLAYTEST: 'old', PATH: 'p' }, ['a']);
  assert.equal(l.env.HAWKES_PLAYTEST, undefined);
  assert.deepEqual(l.args, ['a', '--hawkes-playtest=ws://u']);
});

test('parseArgs', () => {
  const o = parseArgs(['--scenario', 'level-2', '--at', 'boss', '--options', '{"stage":"x","seed":9}', '--', 'game.exe', '-batch']);
  assert.equal(o.command, 'game.exe');
  assert.deepEqual(o.args, ['-batch']);
  assert.deepEqual(o.options, { stage: 'x', seed: 1, speed: 1, at: 'boss' });
  assert.throws(() => parseArgs(['--scenario', 'x']), /executable/);
});

const run = (extra = {}, mode = 'normal') =>
  runPlaytest({ command: process.execPath, args: [FAKE], bootSeconds: 20, env: { ...process.env, FAKE_GAME_MODE: mode }, ...extra });

test('a whole run against the fake game: won, with report, events and logs', async () => {
  const r = await run();
  assert.equal(r.outcome, 'won', r.error);
  assert.equal(r.report.scenario, 'smoke');
  assert.equal(r.report.metrics.coins, 3);
  assert.ok(r.events.some((e) => e.type === 'finish'));
  assert.ok(r.logs.some((l) => l.line === 'seed 1'));
  assert.equal(r.crashed, false);
  assert.equal(r.hello.product, 'fakegame');
});

test('the address by argument works too', async () => {
  const r = await run({ via: 'arg', scenario: 'smoke' });
  assert.equal(r.outcome, 'won', r.error);
});

test('an unknown scenario ends as error with the game saying so', async () => {
  const r = await run({ scenario: 'nope' });
  assert.equal(r.outcome, 'error');
  assert.match(r.report.problems[0].message, /no playtest scenario/);
});

test('a run past its limit is stopped and called stuck', async () => {
  const r = await run({ scenario: 'long', timeoutSeconds: 1 });
  assert.equal(r.outcome, 'stuck');
  assert.equal(r.report.outcome, 'done'); // the game finished it when told to stop
});

test('a crash mid-run is recorded as a crash', async () => {
  const r = await run({}, 'crash');
  assert.equal(r.crashed, true);
  assert.equal(r.outcome, 'error');
  assert.equal(r.exitCode, 3);
});

test('a game that never connects, and one on an old version', async () => {
  const silent = await run({ bootSeconds: 1 }, 'silent');
  assert.equal(silent.outcome, 'error');
  assert.equal(silent.noProtocol, true);
  const old = await run({ bootSeconds: 3 }, 'old');
  assert.equal(old.outcome, 'error');
  assert.match(old.error, /unsupported contract version 1/);
});
