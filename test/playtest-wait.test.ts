import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-playwait-'));
const { capacityApi, waitReason, raiseForRun } = await import('../src/playtest-capacity.ts');
await import('../src/settings.ts');

test('waitReason says tabs in use and how many are ahead', async () => {
  const orig = capacityApi.request;
  capacityApi.request = async () => ({ lanes: { used: 4, limit: 4 }, playing: [{}, {}, {}, {}], waiting: [{ job: 'a' }, { job: 'b' }] });
  try {
    assert.match((await waitReason('b'))!, /4 of 4 browser tabs are in use, 1 ahead/);
    assert.equal(await waitReason('zzz'), null);
  } finally { capacityApi.request = orig; }
});

test('raiseForRun lifts Gen\'s cap when J has not chosen one', async () => {
  const orig = capacityApi.request;
  const puts: any[] = [];
  capacityApi.request = async (_p: string, o: any = {}) => { if (o.method === 'PUT') { puts.push(o.body); return { browsers: o.body.browsers }; } return { browsers: 4 }; };
  try {
    const n = await raiseForRun(9);
    assert.equal(n, 9);
    assert.deepEqual(puts, [{ browsers: 9 }]);
  } finally { capacityApi.request = orig; }
});

test("waitReason gives Gen's own reason for the job when it has one (the lane it really waits on)", async () => {
  const real = capacityApi.request;
  capacityApi.request = async () => ({ lanes: { used: 1, limit: 1 }, playing: [], waiting: [{ job: 'a', detail: 'waiting: 8 of 8 playtest browser tabs in use' }, { job: 'b', detail: 'waiting: this project already has 2 playtest tabs running (its share)' }] });
  try {
    assert.equal(await waitReason('a'), 'waiting for a free browser: 8 of 8 playtest browser tabs in use, 0 ahead in the queue');
    assert.match((await waitReason('b'))!, /this project already has 2 playtest tabs running \(its share\), 1 ahead/);
  } finally {
    capacityApi.request = real;
  }
});
