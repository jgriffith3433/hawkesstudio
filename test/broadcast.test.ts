import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeLine, buildLabel, composeBroadcast } from '../src/broadcast.ts';

test('on-screen text drops paths and keys', () => {
  const line = safeLine('hopping to the castle C:\\keys\\secret.pem and sk-abc123456789 plus /home/ubuntu/.ssh/id_ed25519 token=hg_live_secret');
  assert.match(line, /hopping to the castle/);
  assert.doesNotMatch(line, /secret\.pem|sk-|\/home\/|hg_live|token=/);
});

test('a build label keeps the host and drops the query', () => {
  assert.equal(buildLabel('https://beta.example.com/v112/3f2a1c9/play?key=sekret'), 'beta.example.com · build v112 · 3f2a1c9');
  assert.equal(buildLabel(''), 'beta');
});

test('a live take beats a replay, and a lock stays on that product', () => {
  const playing = [{ job: 'j_aaa', ctx: { product: 'yoobaland', productName: 'Yooba Land', name: 'Castle' }, step: 'hop', url: 'https://yooba.example/v3/', players: [{ state: { note: 'at the waystone' } }] }];
  const finished = [{ job: 'j_bbb', ctx: { product: 'dod', productName: 'DoD' }, outcome: 'won', url: 'https://dod.example/' }];
  const open = composeBroadcast({ playing, finished, now: 1_000 });
  assert.equal(open.focus?.product, 'yoobaland');
  assert.equal(open.focus?.stream, '/api/gen/v1/jobs/j_aaa/live.mjpeg?player=0&fps=8');
  assert.match(open.host, /Yooba here/);
  assert.match(open.host, /waystone/);
  const locked = composeBroadcast({ playing, finished, product: 'dod', now: 1_000 });
  assert.equal(locked.focus?.product, 'dod');
  assert.equal(locked.focus?.phase, 'finished');
});

test('the frame never includes a log, a diff or a query string', () => {
  const frame = composeBroadcast({
    playing: [{
      job: 'j_ccc', ctx: { product: 'yoobaland', productName: 'Yooba Land' },
      url: 'https://yooba.example/play?api_key=sekret',
      step: 'see /srv/hawkes/gen.env',
      log: 'AWS_SECRET=should-not-leak',
      players: [{ state: { note: 'fine' } }],
    }],
    changes: [{ id: 'c_1', product: 'yoobaland', title: 'fix the fence', status: 'merged', updated: 1_000, detail: 'diff --git /home/ubuntu/x', log: ['secret'] }],
    now: 5_000,
  });
  const blob = JSON.stringify(frame);
  assert.doesNotMatch(blob, /sekret|AWS_SECRET|diff --git|gen\.env|should-not-leak/);
  assert.equal(frame.ticker[0].kind, 'merged');
  assert.equal(frame.flash?.kind, 'MERGED');
});

test('roadmap bars come from the open milestone', () => {
  const frame = composeBroadcast({
    milestones: [{ product: 'yoobaland', title: 'Castle stands', done: 1, total: 3, items: [
      { title: 'Waystone', state: 'on beta', display: 'on beta' },
      { title: 'Carrot field', state: 'working', display: 'working (1 of 4 merged)' },
    ] }],
    now: 1,
  });
  assert.equal(frame.milestone?.title, 'Castle stands');
  assert.equal(frame.bars[0].pct, 1);
  assert.ok(frame.bars[1].pct > 0 && frame.bars[1].pct < 1);
  assert.match(frame.host, /between takes/);
});
