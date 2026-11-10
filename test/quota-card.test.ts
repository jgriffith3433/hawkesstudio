// A Google quota a part of Studio needs and can't raise itself is one Approve card in the owner's Inbox (quota.ts; J,
// 2026-11-10: "Jaycee taps it, and nobody runs a workflow by hand"): CPU and disk asks for one region merge into one
// card that says current → target, why and the cost; walk-away never approves it itself; a quota Google already gives
// asks nothing; J's tap files the request with Google (the Quotas API, else the ops-admin workflow), and nothing else does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-quota-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_GCP_PROJECT = 'proj-x';
process.env.STUDIO_GCP_REGION = 'us-east4';
process.env.TALK_CLAUDE = 'no-such-claude-here';
process.env.TALK_FOLLOWUP_BATCH_MS = '600000';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
// Walk-away on, with its cards (the default): the quota card must still wait for J.
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'pm.json'), JSON.stringify({}));
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [] }));

const ap = await import('../src/approvals.ts');
const qt = await import('../src/quota.ts');

const jPage = () => ({ headers: { 'sec-fetch-site': 'same-origin', 'x-studio-click': '1' }, socket: {} }) as any;
let cpuMilli = 24_000;
let diskBytes = 50 * 1024 ** 3;
qt.quotaHooks.list = async () => [
  { quotaId: 'CpuAllocPerProjectRegion', displayName: 'CPU allocation, per project per region', unit: 'milli-vCPU/{project}/{region}', dimensionsInfos: [{ dimensions: { region: 'us-east4' }, details: { value: String(cpuMilli) } }, { dimensions: {} as Record<string, string>, details: { value: '200000' } }] },
  { quotaId: 'EphemeralStorageAllocPerProjectRegion', displayName: 'Total ephemeral disk allocation, per project per region', unit: 'By/{project}/{region}', dimensionsInfos: [{ dimensions: { region: 'us-east4' }, details: { value: String(diskBytes) } }] },
];
const filed: any[] = [];
const dispatched: any[] = [];
let directWorks = true;
qt.quotaHooks.file = async (a, info) => { if (!directWorks) throw new Error('PERMISSION_DENIED'); filed.push({ ...a, info }); return `filed ${a.kind}`; };
qt.quotaHooks.dispatch = async (a) => { dispatched.push(a); return `ops-admin ${a.kind}`; };

test('google units become card units', () => {
  assert.equal(qt.inUnit('cpu', 24_000, 'milli'), 24);
  assert.equal(qt.inUnit('disk', 10 * 1024 ** 3, 'By/{project}/{region}'), 10);
  assert.equal(qt.toUnit('disk', 100, 'By'), 100 * 1024 ** 3);
  assert.equal(qt.inUnit('disk', 10240, 'MiB'), 10);
  assert.equal(qt.inUnit('cpu', 100, ''), 100);
});

test('CPU and disk asks for one region are one card, with current → target, why and cost; walk-away leaves it for J', async () => {
  cpuMilli = 24_000;
  const a1 = await qt.askForQuota([{ kind: 'disk', region: 'us-east4', value: 100, why: 'the cell runs without its working disk' }]);
  const a2 = await qt.askForQuota([{ kind: 'cpu', region: 'us-east4', value: 100, why: 'an agent job never started' }]);
  assert.ok(a1 && a2);
  assert.equal(a2!.id, a1!.id, 'one card for the region');
  const pending = ap.listApprovals({ pending: true }).filter((a) => a.kind === 'quota');
  assert.equal(pending.length, 1);
  const c = pending[0];
  assert.equal(c.status, 'pending', 'walk-away does not approve a quota raise');
  assert.equal(c.target, 'proj-x:us-east4');
  const text = [c.card.title, ...c.card.lines].join('\n');
  assert.match(text, /Cloud Run CPU in us-east4: 24 → 100 vCPU/);
  assert.match(text, /Cloud Run ephemeral disk in us-east4: 50 → 100 GiB/);
  assert.match(text, /Why: the cell runs without its working disk/);
  assert.match(text, /Why: an agent job never started/);
  assert.match(text, /Cost: asking is free/);
  assert.equal(await ap.walkAwayHold(c), "raising a Google quota is the owner's");
  assert.equal(filed.length + dispatched.length, 0, 'nothing filed before the tap');
});

test("J's tap files both with Google from Studio; if Studio's account may not, the ops-admin workflow does", async () => {
  const c = ap.listApprovals({ pending: true }).find((a) => a.kind === 'quota')!;
  directWorks = false;
  const done: any = await ap.decideApproval(c.id, ap.getApproval(c.id, true)!.token!, 'approve', jPage());
  assert.equal(done.status, 'approved', JSON.stringify(done));
  assert.deepEqual(dispatched.map((d) => [d.kind, d.value]).sort(), [['cpu', 100], ['disk', 100]]);
  assert.match(done.result, /ops-admin cpu/);
  directWorks = true;
});

test('a quota Google already gives asks nothing', async () => {
  cpuMilli = 200_000;
  diskBytes = 200 * 1024 ** 3;
  assert.equal(await qt.askForQuota([{ kind: 'cpu', region: 'us-east4', value: 100, why: 'x' }, { kind: 'disk', region: 'us-east4', value: 100, why: 'y' }]), null);
  assert.equal(ap.listApprovals({ pending: true }).filter((a) => a.kind === 'quota').length, 0);
});

test('a cell without its working disk asks once; a real disk or a non-cell asks nothing', async () => {
  cpuMilli = 24_000; diskBytes = 50 * 1024 ** 3;
  assert.equal(await qt.askDiskIfMissing(false), null, 'not on Cloud Run');
  process.env.K_SERVICE = 'studio-o-x'; process.env.STUDIO_ORG = 'x';
  assert.equal(await qt.askDiskIfMissing(true), null, 'on a real disk');
  const a = await qt.askDiskIfMissing(false);
  assert.ok(a && a.kind === 'quota');
  assert.equal(await qt.askDiskIfMissing(false), null, 'once per start');
  delete process.env.K_SERVICE; delete process.env.STUDIO_ORG;
});
