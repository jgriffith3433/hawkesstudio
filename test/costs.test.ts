// Costs: what an AWS charge is, EC2's XML, periods, the Claude usage split (Max plan vs billed), and when J's phone
// hears about money. No AWS calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-costs-'));
const { parseXml, xitems, xget, xtext, xtags } = await import('../src/aws.ts');
const costs = await import('../src/costs.ts');
const { db } = await import('../src/db.ts');
await import('../src/talk.ts');
await import('../src/agents.ts');

test('EC2 XML: instances, their state, tags and launch time', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>r</requestId>
<reservationSet><item><reservationId>r-1</reservationId><instancesSet><item>
  <instanceId>i-abc</instanceId><instanceType>g6e.xlarge</instanceType><instanceState><code>16</code><name>running</name></instanceState>
  <launchTime>2026-10-16T08:00:00.000Z</launchTime><tagSet><item><key>Name</key><value>hawkesgen-comfy</value></item><item><key>Project</key><value>hawkes-gen &amp; co</value></item></tagSet>
</item></instancesSet></item></reservationSet></DescribeInstancesResponse>`;
  const root = xget(parseXml(xml), 'DescribeInstancesResponse');
  const inst = xitems(xitems(root, 'reservationSet')[0], 'instancesSet');
  assert.equal(inst.length, 1);
  assert.equal(xtext(inst[0], 'instanceState/name'), 'running');
  assert.equal(xtext(inst[0], 'launchTime'), '2026-10-16T08:00:00.000Z');
  assert.deepEqual(xtags(inst[0]), { Name: 'hawkesgen-comfy', Project: 'hawkes-gen & co' });
});

test('a server is its Name tag, else its instance type', () => {
  assert.equal(costs.roleOf('hawkes-control', 't3.large'), 'control');
  assert.equal(costs.roleOf('hawkesgen-builder', 'm7i.2xlarge'), 'builder');
  assert.equal(costs.roleOf('hawkesgen-playtester', 'g4dn.xlarge'), 'playtester');
  assert.equal(costs.roleOf('dod-comfy', 'g6e.xlarge'), 'gpu');
  assert.equal(costs.roleOf('', 'g6e.xlarge'), 'gpu');
  assert.equal(costs.roleOf('', 'c5.large'), 'other');
});

test('Cost Explorer lines become parts of the studio, and regions', () => {
  const ec2 = 'Amazon Elastic Compute Cloud - Compute';
  assert.equal(costs.componentOf(ec2, 'USE2-BoxUsage:g6e.xlarge'), 'GPU servers');
  assert.equal(costs.componentOf(ec2, 'BoxUsage:t3.large'), 'Control server');
  assert.equal(costs.componentOf(ec2, 'BoxUsage:g4dn.xlarge'), 'Playtester (T4)');
  assert.equal(costs.componentOf('EC2 - Other', 'EBS:VolumeUsage.gp3'), 'Disks');
  assert.equal(costs.componentOf('EC2 - Other', 'USW2-EBS:SnapshotUsage'), 'Snapshots');
  assert.equal(costs.componentOf('Amazon Virtual Private Cloud', 'USE1-PublicIPv4:InUseAddress'), 'Public IP addresses');
  assert.equal(costs.componentOf('Amazon Simple Storage Service', 'TimedStorage-ByteHrs'), 'S3 (playtest videos, library)');
  assert.equal(costs.componentOf('Amazon Route 53', 'HostedZone'), 'Route 53 (DNS)');
  assert.equal(costs.regionOfUsage('USE2-BoxUsage:g6e.xlarge'), 'us-east-2');
  assert.equal(costs.regionOfUsage('EUN1-EBS:VolumeUsage.gp3'), 'eu-north-1');
  assert.equal(costs.regionOfUsage('BoxUsage:t3.large'), 'us-east-1');
  assert.equal(costs.regionOfUsage('DataTransfer-Out-Bytes'), 'us-east-1');
});

test('periods are UTC days', () => {
  const now = new Date('2026-10-16T15:30:00Z');
  const m = costs.periodOf('month', now);
  assert.equal(new Date(m.start).toISOString(), '2026-10-01T00:00:00.000Z');
  const w = costs.periodOf('week', now);
  assert.equal(new Date(w.start).toISOString(), '2026-10-10T00:00:00.000Z');
  const l = costs.periodOf('lastmonth', now);
  assert.equal(new Date(l.start).toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(new Date(l.end).toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(costs.periodOf('30d', now).start, Date.parse('2026-09-17T00:00:00Z'));
});

test("agents' Claude usage leaves out their builds; Max-plan usage isn't billed", () => {
  assert.equal(costs.buildCostsInLog(['agent started', 'build: Game/v12 in 9 min ($0.12)', 'build: Game/v13 in 8 min ($0.10)', 'build failed: x']), 0.22);
  const t = Date.now();
  db.prepare("INSERT INTO changes (id, product, findings, status, cost, log, created) VALUES ('c_1', 'sickofit', '[]', 'ready', 1.5, ?, ?)").run(JSON.stringify(['build: Game/v1 in 5 min ($0.50)']), t);
  db.prepare("INSERT INTO conversations (id, title, status, messages, cost, created) VALUES ('t_1', 'x', 'idle', ?, 0.3, ?)").run(JSON.stringify([
    { role: 'user', text: 'hi', at: t },
    { role: 'assistant', text: 'a', at: t, turn: { cost: 0.4, billing: 'subscription' } },
    { role: 'assistant', text: 'b', at: t, turn: { cost: 0.3, billing: 'api' } },
  ]), t);
  const c = costs.claudeCosts(costs.periodOf('today'));
  assert.equal(c.agents.usage, 1);
  assert.equal(c.talk.usage, 0.7);
  assert.equal(c.talk.billed, 0.3);
  assert.equal(c.perProduct.sickofit.runs, 1);
});

test('settings: budget and subscriptions, bad values ignored', () => {
  const s = costs.saveCostSettings({ budget: 120, gpuHours: -1 as any, subscriptions: { 'Claude Max': 100, ' ': 5, Free: 0 } });
  assert.equal(s.budget, 120);
  assert.equal(s.gpuHours, 3);
  assert.deepEqual(s.subscriptions, { 'Claude Max': 100 });
});

test("J's phone: forecast over budget, servers left running, other regions; nothing otherwise", () => {
  const settings = { ...costs.costSettings(), budget: 100 };
  const server = (role: any, hours: number) => ({ id: `i-${role}`, region: 'us-east-1', name: role, role, type: 'x', state: 'running', launched: 1, hours, perHour: 1, diskGb: 0, diskPerMonth: 0 });
  const running = [server('gpu', 4), server('builder', 1), server('control', 500)];
  const left = costs.leftRunning(running as any, settings);
  assert.deepEqual(left.map((s) => s.role), ['gpu']);
  const base = { settings, aws: { month: { soFar: 50 }, otherRegions: [] as any[] } as any, resources: { leftRunning: [] as any[] } as any };
  assert.deepEqual(costs.costAlerts({ ...base, totals: { forecast: 90, api: 1 } as any }), []);
  const over = costs.costAlerts({ ...base, totals: { forecast: 130, api: 1 } as any, resources: { leftRunning: left } as any, aws: { month: { soFar: 50 }, otherRegions: [{ region: 'eu-north-1', cost: 4 }] } as any }, '2026-10');
  assert.deepEqual(over.map((a) => a.key), ['budget:2026-10:125', 'running:i-gpu:1', 'region:2026-10:eu-north-1']);
});
