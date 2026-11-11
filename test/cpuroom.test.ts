// A job start leaves Studio's own server its share of the region's Cloud Run CPU (src/cpuroom.ts). 2026-11-11: queued
// Unity builds and agent jobs held all of us-east4's CPU, Studio's new revision never started and the site went down.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/cpuroom.ts';
import { regionJobCpu, setGcpFetch } from '../src/gcp.ts';

const saved = { ...process.env };
beforeEach(() => { C.resetCpuRoom(); delete process.env.STUDIO_CPU_ROOM; process.env.STUDIO_CPU_RESERVE = '8'; process.env.STUDIO_CPU_WAIT_MS = '20'; });
afterEach(() => { C.resetCpuRoom(); process.env = { ...saved }; });

test('a start that would eat the reserve waits; one that leaves it goes', () => {
  assert.equal(C.fits({ limit: 100, used: 90, reserve: 8, need: 2 }), true);
  assert.equal(C.fits({ limit: 100, used: 91, reserve: 8, need: 2 }), false);
});

test('the incident: jobs hold the whole quota, so the start waits until one of Studio\'s jobs ends', async () => {
  let used = 100;
  C.roomHooks.limit = async () => 100;
  C.roomHooks.used = async () => used;
  process.env.STUDIO_CPU_WAIT_MS = '60000'; // only the job-end event can wake it in time
  let started = false;
  const turn = C.cpuTurn(2).then(() => { started = true; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(started, false);
  assert.ok(C.cpuHold(), 'the hold is visible');
  used = 80; // a Unity build ended
  C.cpuFreed();
  await turn;
  assert.equal(started, true);
  assert.equal(C.cpuHold(), null);
});

test('room that comes back without Studio being told (another job ended) is found by the backoff look', async () => {
  let used = 100;
  C.roomHooks.limit = async () => 100;
  C.roomHooks.used = async () => used;
  setTimeout(() => { used = 10; }, 10);
  await C.cpuTurn(2);
});

test('starts are admitted one at a time', async () => {
  let used = 89;
  C.roomHooks.limit = async () => 100;
  C.roomHooks.used = async () => used;
  const order: number[] = [];
  const a = C.cpuTurn(2).then(() => { order.push(1); });
  const b = C.cpuTurn(2).then(() => { order.push(2); });
  await a;
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(order, [1], 'the second would cross the reserve: the first counts before Cloud Run lists it');
  used = 70; C.cpuFreed();
  await b;
  assert.deepEqual(order, [1, 2]);
});

test("a gate that can't see the quota never holds work", async () => {
  C.roomHooks.limit = async () => null;
  C.roomHooks.used = async () => 1000;
  await C.cpuTurn(2);
});

test('the quota is learned from what Cloud Run granted when it left a job unstarted', async () => {
  delete process.env.STUDIO_GCP_PROJECT;
  C.roomHooks.running = async () => 64;
  await C.learnFromNoRoom();
  C.roomHooks.used = async () => 60;
  let started = false;
  const turn = C.cpuTurn(2).then(() => { started = true; });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(started, false, '60 + 2 > 64 - 8');
  C.roomHooks.used = async () => 40;
  C.cpuFreed();
  await turn;
});

test('off: never holds', async () => {
  process.env.STUDIO_CPU_ROOM = 'off';
  C.roomHooks.limit = async () => 1;
  C.roomHooks.used = async () => 1000;
  await C.cpuTurn(2);
});

test('regionJobCpu counts every open execution in the region, queued ones too', async () => {
  const pages: any[] = [{ executions: [
    { name: 'a', taskCount: 1, runningCount: 1, template: { containers: [{ resources: { limits: { cpu: '2' } } }] } },
    { name: 'b', taskCount: 1, runningCount: 0, template: { containers: [{ resources: { limits: { cpu: '8000m' } } }] } },
    { name: 'c', completionTime: '2026-11-11T00:00:00Z', taskCount: 1, template: { containers: [{ resources: { limits: { cpu: '8' } } }] } },
  ] }];
  let url = '';
  setGcpFetch((async (u: any) => { url = String(u); return new Response(JSON.stringify(pages.shift() ?? {}), { status: 200 }); }) as any, 'test-token');
  try {
    const r = await regionJobCpu('p', 'us-east4');
    assert.match(url, /locations\/us-east4\/jobs\/-\/executions/);
    assert.deepEqual(r, { vcpu: 10, running: 2, open: 2 });
  } finally { setGcpFetch(null); }
});
