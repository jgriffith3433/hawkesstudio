// Resources (resources.ts, the Resources tab): reading /proc and cgroup files, the history and its downsampling, what
// needs action, when J's phone hears about it, and its settings. Reads this machine's /proc where there is one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-resources-'));
const r = await import('../src/resources.ts');
const { db } = await import('../src/db.ts');
const { saveSettings, allSettings } = await import('../src/settings.ts');

test('parsers: /proc/stat, meminfo, net/dev, mounts, a process stat, memory.stat, unit names', () => {
  const cpu = r.parseCpu('cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 50 0 25 400 25 0 0 0\ncpu1 50 0 25 400 25 0 0 0\nintr 1');
  assert.deepEqual(cpu, { total: 1000, idle: 850, cpus: 2 });
  const mem = r.parseMeminfo('MemTotal:        4000000 kB\nMemFree:  100 kB\nMemAvailable:    1000000 kB\nSwapTotal:  2000 kB\nSwapFree:  500 kB\n');
  assert.equal(mem.total, 4000000 * 1024);
  assert.equal(mem.used, 3000000 * 1024);
  assert.equal(mem.swapUsed, 1500 * 1024);
  const net = r.parseNetDev('Inter-|   Receive\n face |bytes    packets\n    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0\n  ens5: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\n');
  assert.deepEqual(net, { rx: 1000, tx: 2000 });
  const mounts = r.parseMounts('/dev/root / ext4 rw 0 0\ntmpfs /run tmpfs rw 0 0\n/dev/loop1 /snap/core squashfs ro 0 0\n/dev/nvme0n1p15 /boot/efi vfat rw 0 0\n/dev/root / ext4 rw 0 0\n');
  assert.deepEqual(mounts.map((m) => m.mount), ['/', '/boot/efi']);
  const p = r.parseProcStat('4242 (node (dev) x) S 77 4242 4242 0 -1 4194304 1 0 0 0 150 50 0 0 20 0 11 0 100 1000000 2500 18446744073709551615');
  assert.deepEqual(p, { name: 'node (dev) x', ppid: 77, ticks: 200, rssPages: 2500 });
  assert.equal(r.cacheOf('anon 100\nfile 900\nactive_file 300\ninactive_file 400\n'), 700);
  assert.deepEqual(r.unitKind('hawkes-agent-c_5f8afc6f4638-mvena7sa.service'), { kind: 'agent', id: 'c_5f8afc6f4638' });
  assert.deepEqual(r.unitKind('hawkes-talk-t_0d84dc39e51e-mvenb5bk.service'), { kind: 'talk', id: 't_0d84dc39e51e' });
  assert.equal(r.unitKind('hawkes-studio.service').kind, 'studio');
  assert.equal(r.unitKind('caddy.service').kind, 'caddy');
});

test('reading this server is quick and, the second time, has CPU and network rates', { skip: !fs.existsSync('/proc/stat') }, async () => {
  await r.readHost();
  await new Promise((x) => setTimeout(x, 300));
  const h = (await r.readHost())!;
  assert.ok(h.mem.total > 0 && h.mem.pct > 0 && h.mem.pct < 100);
  assert.ok(h.disks.some((d) => d.mount === '/'));
  assert.equal(typeof h.cpu, 'number');
  // Wall time of an async read while other test files run beside it: a busy CI machine is slow, not broken. The
  // service itself warns past 200 ms; this only catches a sample that blocks for real.
  assert.ok(h.sampleMs < 1000, `a sample took ${h.sampleMs} ms`);
  const row = r.rowOf(h);
  assert.equal(row.mem, h.mem.pct);
});

const host = (over: Partial<any> = {}): any => ({
  at: Date.now(), uptime: 3600, cpus: 2, cpu: 20, load: [0.5, 0.5, 0.5],
  mem: { total: 4e9, used: 1e9, available: 3e9, pct: 25 }, swap: { total: 0, used: 0, pct: 0 },
  disks: [{ mount: '/', dev: '/dev/root', size: 1e11, used: 4e10, free: 6e10, pct: 40 }], net: { inPerSec: 10, outPerSec: 20 },
  groups: [{ kind: 'agent', id: 'c_1', name: 'Agent c_1', unit: 'u', mem: 9e8, cpu: 5 }, { kind: 'agent', id: 'c_2', name: 'Agent c_2', unit: 'u2', mem: 5e8, cpu: 1 }, { kind: 'dev', id: 'dod', name: 'Dev server: dod', unit: 's', mem: 3e8, cpu: 0 }],
  sampleMs: 3, ...over,
});
const work: any = { agents: { running: 2, queued: 0, maxConcurrent: 2, waitingOnGen: 0 }, jobs: { ok: true, queued: 0, running: 1 } };

test('what needs action: the page opens with the worst problem, else "all fine" with the numbers', () => {
  const s = { ...r.RESOURCE_DEFAULTS };
  assert.deepEqual(r.attentionOf(host(), work, { ok: true, alerts: [] }, s), []);
  assert.match(r.headline(host(), [], work), /^All fine: memory 25%, CPU 20%, disk 40%; 2 agents working\.$/);

  const full = host({ mem: { total: 4e9, used: 3.7e9, available: 3e8, pct: 92 }, disks: [{ mount: '/', dev: '/dev/root', size: 1e11, used: 8.8e10, free: 1.2e10, pct: 88 }] });
  const att = r.attentionOf(full, { ...work, agents: { ...work.agents, queued: 3 } }, { ok: true, alerts: [{ level: 'warn', text: 'GPU server i-1 idle 50 min, $1.86/hr' }] }, s);
  assert.equal(att[0].level, 'bad');
  assert.match(att[0].text, /^Memory is at 92% \(0\.3 GB free\): 2 agents, 1 dev server running\. The biggest: Agent c_1 858 MB/);
  assert.ok(att.some((a) => /Disk \/ is 88% full/.test(a.text) && a.level === 'warn'));
  assert.ok(att.some((a) => /3 agent changes waiting: all 2 agent slots are busy/.test(a.text)));
  assert.ok(att.some((a) => a.text === 'GPU server i-1 idle 50 min, $1.86/hr'));
  assert.equal(r.headline(full, att, work), att[0].text);
  assert.match(r.attentionOf(host(), work, { ok: false, error: "Hawkes Gen didn't answer: down", alerts: [] }, s)[0].text, /Gen didn't answer/);
});

test('alerts only for trouble that lasts: held over the limit for the whole window', () => {
  const now = 10_000_000;
  const rows = (vals: number[]) => vals.map((v, i) => ({ at: now - (vals.length - 1 - i) * 30_000, mem: v }));
  assert.equal(r.sustained(rows(Array(10).fill(93)), 'mem', 90, 5, now), true);
  assert.equal(r.sustained(rows([93, 93, 93, 80, 93, 93, 93, 93, 93, 93]), 'mem', 90, 5, now), false, 'one dip below');
  assert.equal(r.sustained(rows([95, 95, 95]), 'mem', 90, 5, now), false, 'not long enough yet');
});

test('a machine idle past its own stop time (plus the grace) is an alert; a busy one or one still within it is not', () => {
  const now = Date.now();
  const m = (over: any) => ({ id: 'i-1', kind: 'gpu', name: 'GPU server i-1', state: 'running', region: 'us-west-2', type: 'g6e.xlarge', pricePerHour: 1.86, jobs: [], error: null, idle: { minutes: 90, busy: false, action: 'stops', stopsAt: now - 30 * 60_000 }, ...over });
  assert.deepEqual(r.pastStop([m({})] as any, 15, now).map((x) => x.id), ['i-1']);
  assert.equal(r.pastStop([m({ idle: { minutes: 0, busy: true, action: 'stops', stopsAt: now - 30 * 60_000 } })] as any, 15, now).length, 0);
  assert.equal(r.pastStop([m({ idle: { minutes: 65, busy: false, action: 'stops', stopsAt: now - 5 * 60_000 } })] as any, 15, now).length, 0);
  assert.equal(r.pastStop([m({ state: 'stopped' })] as any, 15, now).length, 0);
});

test('history: samples every 30 s, averaged into 5-minute rows after a day, gone after a week', () => {
  const now = Date.UTC(2026, 9, 19, 12, 0, 0);
  const base = { cpu: 10, load1: 1, mem: 50, swap: 0, disk: 40, net_in: 100, net_out: 100, studio: 300, gen: 400, agents: 600, talk: 0, dev: 0, other: 50 };
  db.exec('DELETE FROM resource_samples');
  // Two days ago: 10 samples in one 5-minute bucket; an hour ago: 4; eight days ago: 1.
  for (let i = 0; i < 10; i++) r.storeSample({ ...base, at: now - 2 * 86_400_000 + i * 30_000, mem: 40 + i * 2 });
  for (let i = 0; i < 4; i++) r.storeSample({ ...base, at: now - 3600_000 + i * 30_000 });
  r.storeSample({ ...base, at: now - 8 * 86_400_000 });
  assert.equal(r.downsample(now), 11);
  const rows = db.prepare('SELECT step, mem FROM resource_samples ORDER BY at').all() as any[];
  assert.deepEqual(rows.map((x) => x.step), [300, 30, 30, 30, 30]);
  assert.equal(rows[0].mem, 49); // the average of 40..58
  const h = r.history('7d', { now });
  assert.equal(h.range, '7d');
  assert.ok(h.points.length >= 2);
  assert.equal(r.history('1h', { now }).points.length >= 1, true);
  assert.equal(r.history('nonsense', { now }).range, '1h');
});

test('settings: thresholds in the resources section, checked; never cost-raising', async () => {
  assert.deepEqual((await allSettings()).resources, r.RESOURCE_DEFAULTS);
  const s = await saveSettings('resources', { memoryPct: 85, minutes: 10, alerts: false }, { conversation: null });
  assert.equal(s.memoryPct, 85);
  assert.equal(s.alerts, false);
  assert.equal(r.resourceSettings().minutes, 10);
  await assert.rejects(saveSettings('resources', { memoryPct: 20 }, { conversation: null }), /50 to 99/);
  await assert.rejects(saveSettings('resources', { nope: 1 }, { conversation: null }), /not a setting/);
  // From Talk without J's quote: allowed (alert limits spend nothing).
  assert.equal((await saveSettings('resources', { alerts: true }, { conversation: 't_none' })).alerts, true);
});

test('the Markdown for Talk names the groups, the loop, the work and the fleet', () => {
  const md = r.resourcesMarkdown({
    at: Date.now(), headline: 'All fine.', attention: [], host: host(), commands: [],
    loop: { lastMinute: { p50ms: 1, p99ms: 12, maxms: 30 }, blocks: [], blocksLastHour: 0 },
    fleet: { ok: true, alerts: [], machines: [{ id: 'i-1', kind: 'gpu', name: 'GPU server i-1', state: 'running', region: 'us-west-2', type: 'g6e.xlarge', pricePerHour: 1.86, jobs: [{ tool: 'image.make', project: 'sickofit', detail: '' }], error: null, idle: { minutes: 0, busy: true, action: 'stops', stopsAt: null } }] },
    work: { agents: { running: 1, queued: 0, waitingOnGen: 0, maxConcurrent: 2, perProduct: 1, productLimits: { sickofit: 2 }, byProduct: {}, enabled: true, list: [] }, pm: null, jobs: { ok: true, queued: 2, running: 1 } },
    settings: r.RESOURCE_DEFAULTS, history: { range: '1h', bucketSeconds: 30, points: [] }, spark: undefined,
  } as any);
  assert.match(md, /Agent c_1: 858 MB, CPU 5%/);
  assert.match(md, /p99 12 ms/);
  assert.match(md, /Agents: 1 working of 2 at once \(1 per product, sickofit 2\)/);
  assert.match(md, /GPU server i-1: running \(us-west-2\), \$1\.86\/hr, busy, running image\.make for sickofit/);
});
