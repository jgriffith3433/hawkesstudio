// A Google quota a part of Studio needs and can't raise itself is one Approve card in the owner's Inbox (quota.ts; J,
// 2026-11-10: "Jaycee taps it, and nobody runs a workflow by hand"): CPU and disk asks for one region merge into one
// card that says current → target, why and the cost; walk-away never approves it itself; a quota Google already gives
// asks nothing; J's tap files the request with Google (the Quotas API, else the ops-admin workflow), and nothing else does.
//
// One card per ask, ever (J, 2026-11-11: "This keeps showing up in my inbox over and over"): the disk card came back
// after every restart, because each start asked again and only a still-pending card was remembered, and both of J's
// Approves had died in ops-admin unseen. These tests fail if any of that comes back.
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
const tap = (id: string, d: 'approve' | 'deny') => ap.decideApproval(id, ap.getApproval(id, true)!.token!, d, jPage());
const cards = (region?: string) => ap.listApprovals({ pending: true }).filter((a) => a.kind === 'quota' && (!region || a.target === `proj-x:${region}`));

// Google's QuotaInfo as the Cloud Quotas API gives it: quotaDisplayName and metricUnit (there is no displayName or unit),
// and a disk quota with only the default value (no region of its own), as hawkes-staging's was on 2026-11-11.
let cpuMilli = 24_000;
let diskBytes = 50 * 1024 ** 3;
let readable = true;
qt.quotaHooks.list = async () => readable ? [
  { quotaId: 'CpuAllocPerProjectRegion', quotaDisplayName: 'Total CPU allocation, per project per region', metricUnit: 'milli-vCPU', dimensionsInfos: [{ dimensions: { region: 'us-east4' }, details: { value: String(cpuMilli) } }, { dimensions: {} as Record<string, string>, details: { value: '200000' } }] },
  { quotaId: 'EphemeralDiskAllocPerProjectRegion', quotaDisplayName: 'Total ephemeral disk allocation, per project per region', metricUnit: 'By', dimensionsInfos: [{ dimensions: {} as Record<string, string>, details: { value: String(diskBytes) } }] },
] : null;
const filed: any[] = [];
const dispatched: any[] = [];
let directWorks = true;
let dispatchWorks = true;
qt.quotaHooks.file = async (a, info) => { if (!directWorks) throw new Error('PERMISSION_DENIED'); filed.push({ ...a, info }); return `filed ${a.kind}`; };
qt.quotaHooks.dispatch = async (a, apply) => { if (!dispatchWorks) throw new Error('GitHub answered 422'); dispatched.push({ ...a, apply }); return `ops-admin ${a.kind}${apply ? '' : ' (read only)'}`; };

test('google units become card units, from the fields Google really sends', async () => {
  assert.equal(qt.inUnit('cpu', 24_000, 'milli'), 24);
  assert.equal(qt.inUnit('disk', 10 * 1024 ** 3, 'By/{project}/{region}'), 10);
  assert.equal(qt.toUnit('disk', 100, 'By'), 100 * 1024 ** 3);
  assert.equal(qt.inUnit('disk', 10240, 'MiB'), 10);
  assert.equal(qt.inUnit('disk', 10, 'GiBy'), 10);
  assert.equal(qt.inUnit('cpu', 100, ''), 100);
  // metricUnit is read (not a missing "unit"), and a region with no value of its own takes the default.
  const disk = await qt.quotaNow('disk', 'us-east4');
  assert.equal(disk?.unit, 'By');
  assert.equal(disk?.value, 50);
  assert.equal((await qt.quotaNow('cpu', 'us-east4'))?.value, 24);
});

test('CPU and disk asks for one region are one card, with current → target, why and cost; walk-away leaves it for J', async () => {
  cpuMilli = 24_000;
  const a1 = await qt.askForQuota([{ kind: 'disk', region: 'us-east4', value: 100, why: 'the cell runs without its working disk' }]);
  const a2 = await qt.askForQuota([{ kind: 'cpu', region: 'us-east4', value: 100, why: 'an agent job never started' }]);
  assert.ok(a1 && a2);
  assert.equal(a2!.id, a1!.id, 'one card for the region');
  const pending = cards();
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
  const c = cards('us-east4')[0];
  directWorks = false;
  const done: any = await tap(c.id, 'approve');
  assert.equal(done.status, 'approved', JSON.stringify(done));
  assert.deepEqual(dispatched.map((d) => [d.kind, d.value, d.apply]).sort(), [['cpu', 100, true], ['disk', 100, true]]);
  assert.match(done.result, /ops-admin cpu/);
  assert.equal(qt.askRecord('disk', 'us-east4')?.state, 'filing');
  assert.equal(qt.askRecord('disk', 'us-east4')?.approval, c.id);
  directWorks = true;
});

test('while Google is deciding, nothing asks again: not a restart, not another job', async () => {
  process.env.K_SERVICE = 'studio-o-x'; process.env.STUDIO_ORG = 'x';
  try {
    for (let i = 0; i < 5; i++) assert.equal(await qt.askDiskIfMissing(false), null, `start ${i + 1} makes no card`);
    assert.equal(await qt.askForQuota([{ kind: 'cpu', region: 'us-east4', value: 100, why: 'another job waited' }]), null);
    assert.equal(cards().length, 0, 'no card in the Inbox');
  } finally { delete process.env.K_SERVICE; delete process.env.STUDIO_ORG; }
});

test("a filing that fails opens the same card again, with the real error and Approve: try again; never a new card", async () => {
  const id = qt.askRecord('disk', 'us-east4')!.approval!;
  await qt.onReport({ kind: 'disk', region: 'us-east4', value: 100, apply: true, ok: false, error: "unexpected unit ''", run: '20' });
  const open = cards('us-east4');
  assert.equal(open.length, 1);
  assert.equal(open[0].id, id, 'the same card');
  assert.equal(open[0].card.approve, 'Approve: try again');
  assert.match(open[0].card.warnings.join(' '), /Filing with Google failed \(ops-admin run 20\): unexpected unit ''.*Approve tries again/);
  assert.equal(qt.askRecord('disk', 'us-east4')?.state, 'failed');
  // Asking again (a restart) merges into that card.
  const again = await qt.askForQuota([{ kind: 'disk', region: 'us-east4', value: 100, why: 'the cell runs without its working disk' }]);
  assert.equal(again?.id, id);
  assert.equal(cards('us-east4').length, 1);
});

test('a dispatch GitHub refuses opens the card again too, not a dead "failed" card', async () => {
  const id = cards('us-east4')[0].id;
  dispatchWorks = false;
  directWorks = false;
  const done: any = await tap(id, 'approve');
  assert.equal(done.status, 'pending');
  assert.match(done.card.warnings.join(' '), /GitHub answered 422/);
  dispatchWorks = true;
  directWorks = true;
});

test('the retry files it; the report says Google is deciding, and the card shows it', async () => {
  const id = cards('us-east4')[0].id;
  directWorks = false;
  dispatched.length = 0;
  assert.equal((await tap(id, 'approve') as any).status, 'approved');
  directWorks = true;
  const rec = await qt.onReport({ kind: 'disk', region: 'us-east4', value: 100, apply: true, ok: true, current: 10, granted: 10, preferred: 100, reconciling: true, run: '21' });
  assert.equal(rec?.state, 'filed');
  const card = ap.getApproval(id)!;
  assert.equal(card.status, 'approved');
  assert.match(card.result ?? '', /Filed with Google: 100 GiB in us-east4 \(ops-admin run 21\); Google is deciding \(now 10 GiB\)/);
  assert.equal(cards().length, 0);
});

test("Google's answer comes on the next event that would have asked, read only, at most every few hours", async () => {
  readable = false; // Studio's own account can't read Cloud Quotas (as on hawkes-staging)
  dispatched.length = 0;
  await qt.askForQuota([{ kind: 'disk', region: 'us-east4', value: 100, why: 'x' }]);
  await qt.askForQuota([{ kind: 'disk', region: 'us-east4', value: 100, why: 'x' }]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(dispatched.map((d) => [d.kind, d.apply]), [['disk', false]], 'one read-only run');
  assert.equal(cards().length, 0);
  await qt.onReport({ kind: 'disk', region: 'us-east4', value: 100, apply: false, ok: true, current: 100, granted: 100, preferred: 100, reconciling: false, run: '22' });
  assert.equal(qt.askRecord('disk', 'us-east4')?.state, 'granted');
  assert.match(ap.getApproval(qt.askRecord('disk', 'us-east4')!.approval!)!.result ?? '', /Google gives 100 GiB/);
  // The card shows the value ops-admin read when Studio can't read it itself.
  const lines = await qt.describeQuota([{ kind: 'disk', region: 'us-east4', value: 150, why: 'y' }]);
  assert.match(lines[0], /ephemeral disk in us-east4: 100 \(read \d+ min ago\) → 150 GiB/);
  readable = true;
});

test('Google refusing an amount: never asked again for that much', async () => {
  // The CPU half of the us-east4 card is still filing; Google answers 20 of the 100.
  await qt.onReport({ kind: 'cpu', region: 'us-east4', value: 100, apply: false, ok: true, current: 20, granted: 20, preferred: 100, reconciling: false });
  assert.equal(qt.askRecord('cpu', 'us-east4')?.state, 'refused');
  cpuMilli = 20_000;
  assert.equal(await qt.askForQuota([{ kind: 'cpu', region: 'us-east4', value: 100, why: 'z' }]), null);
  assert.equal(await qt.askForQuota([{ kind: 'cpu', region: 'us-east4', value: 60, why: 'z' }]), null);
  assert.equal(cards().length, 0);
});

test("after Deny the same value isn't asked again; a bigger one is", async () => {
  cpuMilli = 24_000; diskBytes = 10 * 1024 ** 3;
  const c = await qt.askForQuota([{ kind: 'disk', region: 'us-west1', value: 50, why: 'w' }]);
  assert.ok(c);
  assert.equal((await tap(c!.id, 'deny') as any).status, 'denied');
  assert.equal(qt.askRecord('disk', 'us-west1')?.state, 'denied');
  assert.equal(await qt.askForQuota([{ kind: 'disk', region: 'us-west1', value: 50, why: 'w' }]), null);
  assert.equal(await qt.askForQuota([{ kind: 'disk', region: 'us-west1', value: 30, why: 'w' }]), null);
  // A read-only report doesn't undo the Deny.
  await qt.onReport({ kind: 'disk', region: 'us-west1', value: 50, apply: false, ok: true, current: 10 });
  assert.equal(qt.askRecord('disk', 'us-west1')?.state, 'denied');
  const bigger = await qt.askForQuota([{ kind: 'disk', region: 'us-west1', value: 80, why: 'w' }]);
  assert.ok(bigger && bigger.id !== c!.id, 'a bigger ask is a new question');
});

test('a quota Google already gives asks nothing', async () => {
  cpuMilli = 200_000;
  diskBytes = 200 * 1024 ** 3;
  assert.equal(await qt.askForQuota([{ kind: 'cpu', region: 'us-east4', value: 100, why: 'x' }, { kind: 'disk', region: 'us-east4', value: 100, why: 'y' }]), null);
  assert.equal(cards('us-east4').length, 0);
});

test('a cell without its working disk asks; a real disk or a non-cell asks nothing', async () => {
  cpuMilli = 24_000; diskBytes = 10 * 1024 ** 3;
  process.env.STUDIO_GCP_REGION = 'us-central1';
  try {
    assert.equal(await qt.askDiskIfMissing(false), null, 'not on Cloud Run');
    process.env.K_SERVICE = 'studio-o-x'; process.env.STUDIO_ORG = 'x';
    assert.equal(await qt.askDiskIfMissing(true), null, 'on a real disk');
    const a = await qt.askDiskIfMissing(false);
    assert.ok(a && a.kind === 'quota');
    assert.equal(a!.params.asks[0].value, qt.QUOTAS.disk.target);
    const b = await qt.askDiskIfMissing(false);
    assert.equal(b?.id, a!.id, 'a second start is the same card');
    assert.equal(cards('us-central1').length, 1);
  } finally { delete process.env.K_SERVICE; delete process.env.STUDIO_ORG; process.env.STUDIO_GCP_REGION = 'us-east4'; }
});

test('only ops-admin, on main, in production, may report', () => {
  const ok = { repository: 'jgriffith3433/hawkesstudio', ref: 'refs/heads/main', workflow_ref: 'jgriffith3433/hawkesstudio/.github/workflows/ops-admin.yml@refs/heads/main', environment: 'production' };
  assert.equal(qt.reportRefused(ok), null);
  assert.ok(qt.reportRefused({ ...ok, repository: 'someone/else' }));
  assert.ok(qt.reportRefused({ ...ok, ref: 'refs/heads/beta' }));
  assert.ok(qt.reportRefused({ ...ok, workflow_ref: 'jgriffith3433/hawkesstudio/.github/workflows/ci.yml@refs/heads/main' }));
  assert.ok(qt.reportRefused({ ...ok, environment: undefined }));
});

test('the ops-admin workflow reads the fields Google sends and reports back to Studio', () => {
  const wf = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.github', 'workflows', 'ops-admin.yml'), 'utf8');
  assert.match(wf, /\.metricUnit/);
  assert.match(wf, /\.quotaDisplayName/);
  assert.match(wf, /api\/hooks\/quota/);
  assert.match(wf, /if: always\(\)/);
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'quota.ts'), 'utf8');
  assert.doesNotMatch(src, /let diskAsked/, 'no once-per-start memory: the answer is kept in quota_asks');
});
