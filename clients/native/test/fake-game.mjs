// A pretend game for testing the native transport: speaks the game side of the protocol over Node's built-in
// WebSocket client, the way the Unity and Godot SDKs do. FAKE_GAME_MODE picks a behaviour:
//   normal (default) | crash (exits mid-run) | silent (never connects) | old (hello version 1) | hang (never finishes)

import { addressFrom } from '../protocol.mjs';

const mode = process.env.FAKE_GAME_MODE || 'normal';
const url = addressFrom(process.argv.slice(2), process.env);
if (!url) {
  console.log('no playtest address: playing normally');
  process.exit(0);
}
if (mode === 'silent') setTimeout(() => process.exit(0), 60000);
else play();

function play() {
  const scenarios = [
    { id: 'smoke', title: 'Boot and win', seconds: 2, tags: ['smoke'] },
    { id: 'long', title: 'Never ends', seconds: 1 },
  ];
  let ready = false;
  let run = null;
  const ws = new WebSocket(url);
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  const now = () => (run ? Math.round((Date.now() - run.t0) / 100) / 10 : 0);
  const state = () =>
    run
      ? { ready, status: run.status, scene: run.scene, progress: run.progress, fps: 60, metrics: { ...run.metrics } }
      : { ready, status: 'idle', fps: 60 };
  const event = (type, detail) => {
    const e = { t: now(), type, ...(detail === undefined ? {} : { detail: String(detail) }) };
    run.events.push(e);
    send({ type: 'event', event: e });
  };
  const report = () =>
    run && {
      scenario: run.id, outcome: run.status === 'running' ? 'stuck' : run.status, seconds: now(),
      metrics: { ...run.metrics }, events: run.events.slice(), problems: run.problems.slice(), log: [],
    };
  const finish = (outcome) => {
    if (!run || run.status !== 'running') return;
    event('finish', outcome);
    run.status = outcome;
    send({ type: 'state', state: state() });
    send({ type: 'report', report: report() });
  };

  ws.onopen = () => {
    send({ type: 'hello', version: mode === 'old' ? 1 : 2, product: 'fakegame', scenarios, engine: 'custom', sdk: 'fake-game@1', platform: process.platform, ready });
    setTimeout(() => { ready = true; send({ type: 'state', state: state() }); }, 100);
    setInterval(() => send({ type: 'state', state: state() }), 200).unref();
  };
  ws.onclose = () => process.exit(0);
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    const ack = (ok, error) => m.id !== undefined && send({ type: 'ack', re: m.id, ok, ...(error ? { error } : {}) });
    switch (m.type) {
      case 'start': {
        const sc = scenarios.find((s) => s.id === m.scenario);
        run = { id: m.scenario, t0: Date.now(), status: 'running', progress: 0, scene: 'Menu', metrics: {}, events: [], problems: [], options: m.options ?? {} };
        if (!sc) {
          run.problems.push({ severity: 'bug', message: `no playtest scenario "${m.scenario}"` });
          finish('error');
          ack(false, `no playtest scenario "${m.scenario}"`);
          break;
        }
        ack(true);
        event('start', m.scenario);
        send({ type: 'log', level: 'info', line: `seed ${run.options.seed ?? 1}` });
        if (m.scenario === 'long' || mode === 'hang') break;
        setTimeout(() => { run.scene = 'Level 1'; run.progress = 0.5; run.metrics.coins = 3; event('scene', 'Level 1'); }, 150);
        setTimeout(() => {
          if (mode === 'crash') process.exit(3);
          run.progress = 1;
          finish('won');
        }, 350);
        break;
      }
      case 'stop':
        finish('done');
        ack(true);
        break;
      case 'input':
        send({ type: 'log', level: 'info', line: `input ${m.action} ${m.down}` });
        ack(true);
        break;
      case 'state?':
        send({ type: 'state', re: m.id, state: state() });
        break;
      case 'report?':
        send({ type: 'report', re: m.id, report: report() ?? null });
        break;
      case 'quit':
        ack(true);
        setTimeout(() => process.exit(0), 20);
        break;
      default:
        break;
    }
  };
}
