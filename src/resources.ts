// The Resources tab (GET /api/resources, Talk's studio_resources): what the studio runs on, right now and over the last
// week, with what needs action first.
//
//   This server   /proc (CPU, load, memory, swap, network, uptime), statfs per mounted disk, and the cgroup v2 files of
//                 each systemd unit (memory.current minus page cache, cpu.stat): Studio, Gen, Caddy, each agent's and
//                 Talk's Claude Code unit (detach.ts names them hawkes-agent-<change>-…, hawkes-talk-<conversation>-…).
//                 Inside Studio's own unit: Studio itself, its dev servers (dev.ts) and the commands it waits on (ops.ts).
//   The fleet     Hawkes Gen's machine monitor (GET /v1/machines without live: its last reading, no SSH, no new AWS
//                 calls): GPU servers, the build server and the playtester, each one's state, idle time, job, $/hr and
//                 when it stops itself, plus Gen's own alerts. Agents and the PM against their limits, Gen's job queue.
//   History       a sample every 30 s into resource_samples; after 24 h they are averaged into 5-minute rows; 7 days kept.
//   Alerts        to J's phone only for real trouble (resourceSettings): memory or disk over the limit for some minutes,
//                 a GPU or build server idle but still running past its own stop time.
//
// Light on purpose (the server is small): one sample reads a few dozen small files asynchronously, nothing runs a
// command, and nothing polls while no page is open apart from the 30 s sampler (a page hears "resources" on the stream).

import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { db, J, parse } from './db.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS resource_samples (
    at INTEGER NOT NULL, step INTEGER NOT NULL, cpu REAL, load1 REAL, mem REAL, swap REAL, disk REAL, net_in REAL, net_out REAL,
    studio REAL, gen REAL, agents REAL, talk REAL, dev REAL, other REAL
  );
  CREATE INDEX IF NOT EXISTS resource_samples_at ON resource_samples(at);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL, by TEXT);
`);

const SAMPLE_MS = 30_000;
const KEEP_MS = 7 * 86_400_000;
const FULL_MS = 86_400_000; // 30 s rows are kept this long, then averaged into 5-minute rows
const COARSE_MS = 5 * 60_000;
const MB = 1024 * 1024;

// ------------------------------------------------------------- settings

export type ResourceSettings = {
  /** Phone alerts on. */
  alerts: boolean;
  /** Memory (used, page cache not counted) and the fullest disk: alert past these percents… */
  memoryPct: number; diskPct: number;
  /** …held for this many minutes. */
  minutes: number;
  /** A GPU server, the build server or the playtester idle and still running this many minutes past its own stop time. */
  pastStopMinutes: number;
};
export const RESOURCE_DEFAULTS: ResourceSettings = { alerts: true, memoryPct: 90, diskPct: 90, minutes: 5, pastStopMinutes: 15 };

export function resourceSettings(): ResourceSettings {
  const r = db.prepare(`SELECT value FROM settings WHERE key = 'resources'`).get() as { value: string } | undefined;
  return { ...RESOURCE_DEFAULTS, ...((r ? parse(r.value) : null) ?? {}) };
}

export function saveResourceSettings(patch: Record<string, any>, by = 'J'): ResourceSettings {
  const next = resourceSettings();
  const range = { memoryPct: [50, 99], diskPct: [50, 99], minutes: [1, 120], pastStopMinutes: [0, 240] } as const;
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (k === 'alerts') { next.alerts = v === true; continue; }
    if (!(k in range)) throw new Error(`resources.${k}: not a setting (${Object.keys(RESOURCE_DEFAULTS).join(', ')})`);
    const [lo, hi] = range[k as keyof typeof range];
    const n = Number(v);
    if (!(Number.isFinite(n) && n >= lo && n <= hi)) throw new Error(`resources.${k}: ${lo} to ${hi}`);
    (next as any)[k] = Math.round(n);
  }
  db.prepare('INSERT INTO settings (key, value, updated, by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, by = excluded.by')
    .run('resources', J(next), Date.now(), by);
  return next;
}

// ------------------------------------------------------------- reading /proc (pure parsers, tested)

/** The first line of /proc/stat: all CPU time and the idle part (jiffies). */
export function parseCpu(text: string) {
  const v = (text.split('\n')[0] ?? '').trim().split(/\s+/).slice(1).map(Number);
  return { total: v.reduce((a, b) => a + (b || 0), 0), idle: (v[3] || 0) + (v[4] || 0), cpus: (text.match(/^cpu\d+ /gm) ?? []).length || 1 };
}

/** /proc/meminfo in bytes. */
export function parseMeminfo(text: string) {
  const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0) * 1024;
  const total = kb('MemTotal'), available = kb('MemAvailable');
  return { total, available, used: Math.max(0, total - available), swapTotal: kb('SwapTotal'), swapUsed: Math.max(0, kb('SwapTotal') - kb('SwapFree')) };
}

/** /proc/net/dev: bytes received and sent on every interface but loopback. */
export function parseNetDev(text: string) {
  let rx = 0, tx = 0;
  for (const line of text.split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (!rest || name.trim() === 'lo') continue;
    const f = rest.trim().split(/\s+/).map(Number);
    rx += f[0] || 0;
    tx += f[8] || 0;
  }
  return { rx, tx };
}

/** /proc/mounts: real disks only (a /dev/ device, not a snap squashfs), one line per mount point. */
export function parseMounts(text: string) {
  const seen = new Set<string>();
  const out: { dev: string; mount: string; type: string }[] = [];
  for (const line of text.split('\n')) {
    const [dev, mount, type] = line.split(' ');
    if (!dev?.startsWith('/dev/') || !mount || /^(squashfs|tmpfs|devtmpfs|overlay)$/.test(type) || seen.has(mount)) continue;
    seen.add(mount);
    out.push({ dev, mount: mount.replace(/\\040/g, ' '), type });
  }
  return out;
}

/** /proc/<pid>/stat: parent, CPU ticks used (user + system) and resident memory (pages). The name may hold spaces and ")". */
export function parseProcStat(text: string) {
  const end = text.lastIndexOf(')');
  const name = text.slice(text.indexOf('(') + 1, end);
  const f = text.slice(end + 2).split(' ');
  return { name, ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]), rssPages: Number(f[21]) };
}

/** memory.stat's page cache (active_file + inactive_file): reclaimable, so not counted as a group's memory. */
export function cacheOf(memStat: string) {
  const n = (k: string) => Number(new RegExp(`^${k} (\\d+)`, 'm').exec(memStat)?.[1] ?? 0);
  return n('active_file') + n('inactive_file');
}

/** What a systemd unit of the studio is (detach.ts names: hawkes-agent-<change>-<time>, hawkes-talk-<conversation>-<time>). */
export function unitKind(unit: string): { kind: 'agent' | 'talk' | 'studio' | 'gen' | 'caddy' | 'other'; id: string | null } {
  const u = unit.replace(/\.service$/, '');
  let m = /^hawkes-agent-(c_[a-z0-9]+)-/.exec(u);
  if (m) return { kind: 'agent', id: m[1] };
  m = /^hawkes-talk-(t_[a-z0-9]+)-/.exec(u);
  if (m) return { kind: 'talk', id: m[1] };
  if (u === 'hawkes-studio') return { kind: 'studio', id: null };
  if (u === 'hawkes-gen') return { kind: 'gen', id: null };
  if (u === 'caddy') return { kind: 'caddy', id: null };
  return { kind: 'other', id: null };
}

// ------------------------------------------------------------- one sample of this server

export type Group = { kind: string; id: string | null; name: string; unit: string | null; mem: number; cpu: number | null; procs?: number; detail?: string };
export type Host = {
  at: number; uptime: number; cpus: number; cpu: number | null; load: [number, number, number];
  mem: { total: number; used: number; available: number; pct: number }; swap: { total: number; used: number; pct: number };
  disks: { mount: string; dev: string; size: number; used: number; free: number; pct: number }[];
  net: { inPerSec: number | null; outPerSec: number | null };
  groups: Group[]; sampleMs: number;
};

const read = (f: string) => fs.readFile(f, 'utf8');
const readOr = (f: string, d = '') => read(f).catch(() => d);
const CG = '/sys/fs/cgroup';
const TICK = 100; // USER_HZ on Linux

/** The previous reading (CPU percents and network rates are differences). */
type Prev = { at: number; cpu: { total: number; idle: number }; net: { rx: number; tx: number }; units: Map<string, number>; pids: Map<number, number> };
let prev: Prev | null = null;

/** The cgroup v2 folders of the studio's units: system ones (Studio, Gen, Caddy) and the user managers' hawkes-* ones. */
async function unitDirs() {
  const out: string[] = [];
  const self = (await readOr('/proc/self/cgroup')).split('\n').find((l) => l.startsWith('0::'))?.slice(3).trim();
  if (self && self !== '/') out.push(path.join(CG, self));
  for (const u of ['hawkes-studio.service', 'hawkes-gen.service', 'caddy.service']) out.push(path.join(CG, 'system.slice', u));
  const users = await fs.readdir(path.join(CG, 'user.slice')).catch(() => [] as string[]);
  for (const s of users.filter((x) => /^user-\d+\.slice$/.test(x))) {
    const mgrs = await fs.readdir(path.join(CG, 'user.slice', s)).catch(() => [] as string[]);
    for (const m of mgrs.filter((x) => /^user@\d+\.service$/.test(x))) {
      const app = path.join(CG, 'user.slice', s, m, 'app.slice');
      for (const u of await fs.readdir(app).catch(() => [] as string[])) if (/^hawkes-.*\.service$/.test(u)) out.push(path.join(app, u));
    }
  }
  return [...new Set(out)];
}

async function readUnit(dir: string) {
  const [cur, stat, cpu, procs] = await Promise.all([read(path.join(dir, 'memory.current')), readOr(path.join(dir, 'memory.stat')), readOr(path.join(dir, 'cpu.stat')), readOr(path.join(dir, 'cgroup.procs'))]);
  return {
    unit: path.basename(dir), mem: Math.max(0, Number(cur) - cacheOf(stat)),
    usec: Number(/^usage_usec (\d+)/m.exec(cpu)?.[1] ?? 0), pids: procs.split('\n').map(Number).filter(Boolean),
  };
}

/** Names for agents' and Talk's units (their change's or conversation's title). */
function titleOf(kind: string, id: string | null) {
  if (!id) return null;
  try {
    if (kind === 'agent') return (db.prepare('SELECT title, product FROM changes WHERE id = ?').get(id) as any) ?? null;
    if (kind === 'talk') return (db.prepare('SELECT title FROM conversations WHERE id = ?').get(id) as any) ?? null;
  } catch { /* a table not made yet */ }
  return null;
}

/** Reads this server once. Null where there is no /proc (J's Windows PC). */
export async function readHost(): Promise<Host | null> {
  const t0 = performance.now();
  const at = Date.now();
  let stat: string;
  try {
    stat = await read('/proc/stat');
  } catch {
    return null;
  }
  const [meminfo, loadavg, netdev, uptime, mounts, dirs] = await Promise.all([read('/proc/meminfo'), read('/proc/loadavg'), readOr('/proc/net/dev'), readOr('/proc/uptime', '0'), readOr('/proc/mounts'), unitDirs()]);
  const cpu = parseCpu(stat);
  const mem = parseMeminfo(meminfo);
  const net = parseNetDev(netdev);
  const disks = (await Promise.all(parseMounts(mounts).map(async (m) => {
    try {
      const s = await fs.statfs(m.mount);
      const size = s.blocks * s.bsize, free = s.bavail * s.bsize, used = size - s.bfree * s.bsize;
      return size > 0 ? { mount: m.mount, dev: m.dev, size, used, free, pct: Math.round((1000 * used) / (used + free)) / 10 } : null;
    } catch {
      return null;
    }
  }))).filter((d) => d !== null);
  const units = (await Promise.all(dirs.map((d) => readUnit(d).catch(() => null)))).filter((u) => u !== null);

  const dt = prev ? (at - prev.at) / 1000 : 0;
  const pctOf = (usecNow: number, usecBefore: number | undefined) => (prev && usecBefore !== undefined && dt > 0 ? Math.max(0, Math.round((usecNow - usecBefore) / 1e4 / dt * 10) / 10) : null);
  const groups: Group[] = [];
  const pidTicks = new Map<number, number>();
  for (const u of units) {
    const k = unitKind(u.unit);
    if (k.kind === 'studio' || (k.kind === 'other' && u.pids.includes(process.pid))) {
      // Studio's own unit: Studio itself, its dev servers and the commands it runs, from the processes in it.
      groups.push(...(await studioParts(u, dt, pidTicks)));
      continue;
    }
    const t = titleOf(k.kind, k.id);
    const name = k.kind === 'agent' ? `Agent ${k.id}${t?.title ? `: ${t.title}` : ''}` : k.kind === 'talk' ? `Talk: ${t?.title ?? k.id}` : k.kind === 'gen' ? 'Hawkes Gen' : k.kind === 'caddy' ? 'Caddy (web server)' : u.unit.replace(/\.service$/, '');
    groups.push({ kind: k.kind, id: k.id, name, unit: u.unit, mem: u.mem, cpu: pctOf(u.usec, prev?.units.get(u.unit)), procs: u.pids.length, ...(t?.product ? { detail: t.product } : {}) });
  }
  groups.sort((a, b) => b.mem - a.mem);

  const cpuPct = prev && cpu.total > prev.cpu.total ? Math.round(1000 * (1 - (cpu.idle - prev.cpu.idle) / (cpu.total - prev.cpu.total))) / 10 : null;
  const rate = (now: number, before: number | undefined) => (prev && before !== undefined && dt > 0 && now >= before ? Math.round((now - before) / dt) : null);
  const host: Host = {
    at, uptime: Math.round(Number(uptime.split(' ')[0]) || 0), cpus: cpu.cpus, cpu: cpuPct,
    load: loadavg.split(' ').slice(0, 3).map(Number) as [number, number, number],
    mem: { total: mem.total, used: mem.used, available: mem.available, pct: mem.total ? Math.round((1000 * mem.used) / mem.total) / 10 : 0 },
    swap: { total: mem.swapTotal, used: mem.swapUsed, pct: mem.swapTotal ? Math.round((1000 * mem.swapUsed) / mem.swapTotal) / 10 : 0 },
    disks, net: { inPerSec: rate(net.rx, prev?.net.rx), outPerSec: rate(net.tx, prev?.net.tx) }, groups, sampleMs: 0,
  };
  prev = { at, cpu, net, units: new Map(units.map((u) => [u.unit, u.usec])), pids: pidTicks };
  host.sampleMs = Math.round(performance.now() - t0);
  return host;
}

/** Studio's unit split into Studio itself, each dev server (its process and children) and the commands Studio waits on. */
async function studioParts(u: { unit: string; mem: number; usec: number; pids: number[] }, dt: number, pidTicks: Map<number, number>): Promise<Group[]> {
  const page = 4096;
  const procs = (await Promise.all(u.pids.map(async (pid) => {
    try {
      return { pid, ...parseProcStat(await read(`/proc/${pid}/stat`)) };
    } catch {
      return null; // ended between the list and the read
    }
  }))).filter((p) => p !== null);
  const parent = new Map(procs.map((p) => [p.pid, p.ppid]));
  const { devPids } = await import('./dev.ts');
  const { runningCommands } = await import('./ops.ts');
  const devs = devPids();
  const devOf = (pid: number) => {
    for (let p: number | undefined = pid, n = 0; p && n < 30; p = parent.get(p), n++) {
      const d = devs.find((x) => x.pid === p);
      if (d) return d.product;
    }
    return null;
  };
  const parts = new Map<string, Group>();
  const add = (key: string, g: Omit<Group, 'mem' | 'cpu'>, p: { pid: number; ticks: number; rssPages: number }) => {
    const x = parts.get(key) ?? { ...g, mem: 0, cpu: prev ? 0 : null, procs: 0 };
    x.mem += p.rssPages * page;
    x.procs = (x.procs ?? 0) + 1;
    const before = prev?.pids.get(p.pid);
    if (x.cpu !== null && before !== undefined && dt > 0) x.cpu = Math.round((x.cpu + ((p.ticks - before) / TICK / dt) * 100) * 10) / 10;
    pidTicks.set(p.pid, p.ticks);
    parts.set(key, x);
  };
  const cmds = runningCommands();
  // Studio is this process; read from another process (a test, a script), the unit's root process.
  const here = procs.some((p) => p.pid === process.pid);
  for (const p of procs) {
    if (here ? p.pid === process.pid : !parent.has(p.ppid)) add('studio', { kind: 'studio', id: null, name: 'Hawkes Studio', unit: u.unit }, p);
    else {
      const dev = devOf(p.pid);
      if (dev) add(`dev:${dev}`, { kind: 'dev', id: dev, name: `Dev server: ${dev}`, unit: u.unit }, p);
      else add('commands', { kind: 'commands', id: null, name: 'Commands Studio is running', unit: u.unit, detail: cmds.map((c) => `${c.cmd} (${c.seconds} s)`).join('; ').slice(0, 400) || undefined }, p);
    }
  }
  return [...parts.values()];
}

// ------------------------------------------------------------- history

const COLS = ['cpu', 'load1', 'mem', 'swap', 'disk', 'net_in', 'net_out', 'studio', 'gen', 'agents', 'talk', 'dev', 'other'] as const;

/** One history row from a reading: percents, the 1-minute load, bytes/s, and memory per kind of group (MB). */
export function rowOf(h: Host) {
  const mb = (f: (g: Group) => boolean) => Math.round(h.groups.filter(f).reduce((n, g) => n + g.mem, 0) / MB);
  return {
    at: h.at, cpu: h.cpu, load1: h.load[0], mem: h.mem.pct, swap: h.swap.pct, disk: Math.max(0, ...h.disks.map((d) => d.pct)),
    net_in: h.net.inPerSec, net_out: h.net.outPerSec,
    studio: mb((g) => g.kind === 'studio' || g.kind === 'commands'), gen: mb((g) => g.kind === 'gen'), agents: mb((g) => g.kind === 'agent'),
    talk: mb((g) => g.kind === 'talk'), dev: mb((g) => g.kind === 'dev'), other: mb((g) => g.kind === 'caddy' || g.kind === 'other'),
  };
}

export function storeSample(r: ReturnType<typeof rowOf>) {
  db.prepare(`INSERT INTO resource_samples (at, step, ${COLS.join(', ')}) VALUES (?, 30, ${COLS.map(() => '?').join(', ')})`).run(r.at, ...COLS.map((c) => r[c] ?? null));
}

/** Rows over a day old become 5-minute averages; rows over a week old go. Returns the rows folded. */
export function downsample(now = Date.now()) {
  const cutoff = Math.floor((now - FULL_MS) / COARSE_MS) * COARSE_MS;
  const n = (db.prepare('SELECT COUNT(*) AS n FROM resource_samples WHERE step = 30 AND at < ?').get(cutoff) as any).n as number;
  if (n) {
    db.exec('BEGIN');
    try {
      db.prepare(`INSERT INTO resource_samples (at, step, ${COLS.join(', ')})
        SELECT (at / ${COARSE_MS}) * ${COARSE_MS} + ${COARSE_MS / 2}, 300, ${COLS.map((c) => `avg(${c})`).join(', ')}
        FROM resource_samples WHERE step = 30 AND at < ? GROUP BY at / ${COARSE_MS}`).run(cutoff);
      db.prepare('DELETE FROM resource_samples WHERE step = 30 AND at < ?').run(cutoff);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  db.prepare('DELETE FROM resource_samples WHERE at < ?').run(now - KEEP_MS);
  return n;
}

export const RANGES: Record<string, number> = { '1h': 3600_000, '24h': FULL_MS, '7d': KEEP_MS };

/** The history of a range, averaged into at most `points` buckets. */
export function history(range = '1h', { points = 180, now = Date.now() } = {}) {
  const ms = RANGES[range] ?? RANGES['1h'];
  const bucket = Math.max(SAMPLE_MS, Math.ceil(ms / points / SAMPLE_MS) * SAMPLE_MS);
  const r1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);
  const rows = db.prepare(`SELECT (at / ${bucket}) * ${bucket} AS t, ${COLS.map((c) => `avg(${c}) AS ${c}`).join(', ')}, max(mem) AS mem_max, max(cpu) AS cpu_max
    FROM resource_samples WHERE at >= ? GROUP BY t ORDER BY t`).all(now - ms) as any[];
  return {
    range: RANGES[range] ? range : '1h', bucketSeconds: bucket / 1000,
    points: rows.map((r) => ({ at: r.t + bucket / 2, ...Object.fromEntries([...COLS, 'mem_max', 'cpu_max'].map((c) => [c, r1(r[c])])) })),
  };
}

// ------------------------------------------------------------- the rest of the fleet

type Machine = { id: string; kind: 'gpu' | 'builder' | 'playtester'; name: string; state: string; region: string | null; type: string | null; pricePerHour: number; jobs: { tool: string; project: string; detail: string }[]; idle: { minutes: number; stopsAt: number | null; action: string; busy: boolean } | null; error: string | null };
let fleetCache: { at: number; data: { ok: boolean; error?: string; machines: Machine[]; alerts: { level: string; machine: string; text: string }[] } } | null = null;

/** Hawkes Gen's machines from its last reading (GET /v1/machines, not live: no SSH), reused for 30 s. */
export async function fleet(maxAge = SAMPLE_MS) {
  if (fleetCache && Date.now() - fleetCache.at < maxAge) return fleetCache.data;
  const { gen } = await import('./gen.ts');
  let data;
  try {
    const r = await gen.request('/machines', { signal: AbortSignal.timeout(10_000) });
    data = { ok: true, machines: (r.machines ?? []) as Machine[], alerts: r.alerts ?? [] };
  } catch (e: any) {
    data = { ok: false, error: `Hawkes Gen didn't answer: ${String(e?.message ?? e).slice(0, 200)}`, machines: [], alerts: [] };
  }
  fleetCache = { at: Date.now(), data };
  return data;
}

/** Agents (running, queued, waiting on Gen) against their limits, the PM's capacity, Gen's job queue. */
async function work() {
  const { agentSettings, perProductLimit } = await import('./agents.ts');
  const s = agentSettings();
  const rows = db.prepare(`SELECT id, product, title, status FROM changes WHERE status IN ('queued', 'working', 'verifying', 'revising', 'waiting on Gen')`).all() as any[];
  const running = rows.filter((r) => ['working', 'verifying', 'revising'].includes(r.status));
  const perProduct: Record<string, { running: number; limit: number }> = {};
  for (const r of running) (perProduct[r.product] ??= { running: 0, limit: perProductLimit(r.product, s) }).running++;
  let pm: ({ enabled: boolean } & ReturnType<typeof import('./pm.ts').capacity>) | null = null;
  try {
    const { capacity, pmSettings } = await import('./pm.ts');
    pm = { ...capacity(), enabled: pmSettings().enabled };
  } catch { /* no PM here */ }
  let jobs = { ok: false, queued: 0, running: 0 };
  try {
    const { gen } = await import('./gen.ts');
    const list = (await gen.jobs({ status: 'queued,running', limit: 200 })) as any[];
    jobs = { ok: true, queued: list.filter((j) => j.status === 'queued').length, running: list.filter((j) => j.status === 'running').length };
  } catch { /* Gen down: shown as unknown */ }
  return {
    agents: {
      running: running.length, queued: rows.filter((r) => r.status === 'queued').length, waitingOnGen: rows.filter((r) => r.status === 'waiting on Gen').length,
      maxConcurrent: s.maxConcurrent, perProduct: s.perProduct, productLimits: s.productLimits, byProduct: perProduct, enabled: s.enabled,
      list: rows.map((r) => ({ id: r.id, product: r.product, title: r.title, status: r.status })),
    },
    pm, jobs,
  };
}

// ------------------------------------------------------------- what needs action

const pct = (n: number) => `${Math.round(n)}%`;
const gb = (b: number) => `${(b / 1024 ** 3).toFixed(b < 10 * 1024 ** 3 ? 1 : 0)} GB`;
const rateText = (b: number | null) => (b == null ? '?' : b < 1024 ? `${b} B/s` : b < MB ? `${Math.round(b / 1024)} KB/s` : `${(b / MB).toFixed(1)} MB/s`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type Attention = { level: 'bad' | 'warn'; text: string };

/** What needs action, worst first, as plain sentences (pure: tested). */
export function attentionOf(host: Host | null, w: Awaited<ReturnType<typeof work>> | null, fl: { ok: boolean; error?: string; alerts: { level: string; text: string }[] } | null, s = resourceSettings()): Attention[] {
  const out: Attention[] = [];
  if (host) {
    const agents = host.groups.filter((g) => g.kind === 'agent').length, talk = host.groups.filter((g) => g.kind === 'talk').length, devs = host.groups.filter((g) => g.kind === 'dev').length;
    const running = [agents && plural(agents, 'agent'), talk && plural(talk, 'Talk answer'), devs && plural(devs, 'dev server')].filter(Boolean).join(', ');
    if (host.mem.pct >= s.memoryPct - 10) out.push({ level: host.mem.pct >= s.memoryPct ? 'bad' : 'warn', text: `Memory is at ${pct(host.mem.pct)} (${gb(host.mem.available)} free)${running ? `: ${running} running` : ''}. The biggest: ${host.groups.slice(0, 2).map((g) => `${g.name} ${Math.round(g.mem / MB)} MB`).join(', ')}.` });
    if (host.swap.total && host.swap.pct >= 50) out.push({ level: 'warn', text: `Swap is ${pct(host.swap.pct)} used: the server is short of memory and slows down.` });
    for (const d of host.disks) if (d.pct >= s.diskPct - 10) out.push({ level: d.pct >= s.diskPct ? 'bad' : 'warn', text: `Disk ${d.mount} is ${pct(d.pct)} full (${gb(d.free)} free).` });
    if (host.load[0] > host.cpus * 2) out.push({ level: 'warn', text: `The server is overloaded: load ${host.load[0].toFixed(1)} on ${plural(host.cpus, 'CPU')}.` });
  }
  if (w) {
    if (w.agents.queued && w.agents.running >= w.agents.maxConcurrent) out.push({ level: 'warn', text: `${plural(w.agents.queued, 'agent change')} waiting: all ${w.agents.maxConcurrent} agent slots are busy.` });
    if (w.jobs.ok && w.jobs.queued >= 10) out.push({ level: 'warn', text: `Hawkes Gen has ${w.jobs.queued} jobs waiting in its queue.` });
  }
  if (fl && !fl.ok) out.push({ level: 'warn', text: fl.error ?? "Hawkes Gen didn't answer: the GPU servers, build server and playtester aren't shown." });
  for (const a of fl?.alerts ?? []) out.push({ level: a.level === 'bad' ? 'bad' : 'warn', text: a.text });
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1));
}

/** The page's one sentence: the worst problem, or that all is fine with the main numbers. */
export function headline(host: Host | null, attention: Attention[], w: Awaited<ReturnType<typeof work>> | null) {
  if (attention.length) return attention[0].text;
  if (!host) return "This machine has no /proc (not Linux): only the fleet and the agents are shown.";
  const agents = w ? `; ${plural(w.agents.running, 'agent')} working${w.agents.queued ? `, ${w.agents.queued} waiting` : ''}` : '';
  return `All fine: memory ${pct(host.mem.pct)}, CPU ${host.cpu == null ? '…' : pct(host.cpu)}, disk ${pct(Math.max(0, ...host.disks.map((d) => d.pct)))}${agents}.`;
}

// ------------------------------------------------------------- the sampler and alerts

let latest: Host | null = null;
let timer: NodeJS.Timeout | null = null;
let ticks = 0;

/** Readings in a window, newest last (for "held for N minutes"). */
function recent(minutes: number, now = Date.now()) {
  return db.prepare('SELECT at, mem, disk FROM resource_samples WHERE at >= ? ORDER BY at').all(now - minutes * 60_000) as { at: number; mem: number | null; disk: number | null }[];
}

/** Held over the threshold for the whole window: enough samples (one may be missing) and every one over it. Pure. */
export function sustained(rows: { at: number; [k: string]: number | null }[], key: string, threshold: number, minutes: number, now = Date.now()) {
  const inWindow = rows.filter((r) => r.at >= now - minutes * 60_000);
  const need = Math.max(1, Math.floor((minutes * 60_000) / SAMPLE_MS) - 1);
  return inWindow.length >= need && inWindow.every((r) => r[key] != null && (r[key] as number) >= threshold);
}

/** Machines idle and still running past their own stop time (Gen's idle clock) by more than the grace. Pure. */
export function pastStop(machines: Machine[], graceMinutes: number, now = Date.now()) {
  return machines.filter((m) => (m.kind === 'gpu' || m.kind === 'builder' || m.kind === 'playtester') && m.state === 'running' && m.idle && !m.idle.busy && m.idle.stopsAt && now > m.idle.stopsAt + graceMinutes * 60_000);
}

/** What would go to J's phone now (keys dedupe them). */
export async function resourceAlerts(now = Date.now(), s = resourceSettings()) {
  const out: { key: string; title: string; message: string }[] = [];
  const rows = recent(s.minutes, now);
  const h = latest;
  if (sustained(rows, 'mem', s.memoryPct, s.minutes, now)) out.push({ key: 'mem', title: `Studio server memory at ${pct(h?.mem.pct ?? rows.at(-1)?.mem ?? 0)}`, message: `Over ${s.memoryPct}% for ${s.minutes} minutes. Using the most: ${(h?.groups ?? []).slice(0, 3).map((g) => `${g.name} ${Math.round(g.mem / MB)} MB`).join(', ') || 'see the Resources tab'}.` });
  if (sustained(rows, 'disk', s.diskPct, s.minutes, now)) {
    const d = [...(h?.disks ?? [])].sort((a, b) => b.pct - a.pct)[0];
    out.push({ key: 'disk', title: `Studio server disk ${d ? `${d.mount} ` : ''}at ${pct(d?.pct ?? rows.at(-1)?.disk ?? 0)}`, message: `Over ${s.diskPct}% for ${s.minutes} minutes${d ? `, ${gb(d.free)} free` : ''}. Old worktrees, logs and previews are the usual cause.` });
  }
  const fl = await fleet(5 * 60_000);
  for (const m of pastStop(fl.machines, s.pastStopMinutes, now)) {
    const over = Math.round((now - m.idle!.stopsAt!) / 60_000);
    out.push({ key: `idle:${m.id}`, title: `${m.name} idle but still running`, message: `Idle ${m.idle!.minutes} min, ${over} min past the time it should have stopped itself, at $${m.pricePerHour.toFixed(2)}/hr. Stop it in Hawkes Gen (Machines).` });
  }
  return out;
}

async function checkAlerts() {
  const s = resourceSettings();
  if (!s.alerts) return [];
  const { notifyOnce, PUBLIC_URL } = await import('./notify.ts');
  const sent: string[] = [];
  for (const a of await resourceAlerts(Date.now(), s)) {
    // Once every 6 hours while it lasts (a machine: once a day).
    if (await notifyOnce(`resources:${a.key}`, a.key.startsWith('idle:') ? 86_400_000 : 6 * 3600_000, a.title, a.message, { url: `${PUBLIC_URL}/#resources`, tags: ['warning'], priority: 4 })) sent.push(a.key);
  }
  return sent;
}

/** One tick: read, store, tell connected pages; every 10th (5 min) the alerts, every 120th (an hour) the downsampling. */
export async function sampleOnce() {
  const h = await readHost();
  if (!h) return null;
  latest = h;
  storeSample(rowOf(h));
  const n = ticks++;
  if (n % 120 === 0) downsample();
  const { changed } = await import('./stream.ts');
  changed('resources');
  const { isServer } = await import('./repos.ts');
  if (n % 10 === 9 && (isServer() || process.env.STUDIO_RESOURCE_ALERTS === 'on')) void checkAlerts().catch((e) => console.warn(`[resources] alert check failed: ${e.message ?? e}`));
  return h;
}

/** The 30 s sampler (Linux only; the first reading only primes the CPU and network differences). */
export function startResourceSampler() {
  if (timer || process.platform === 'win32') return;
  const tick = () => void sampleOnce().then((h) => { if (h && h.sampleMs > 200) console.warn(`[resources] a sample took ${h.sampleMs} ms`); }).catch((e) => console.warn(`[resources] sample failed: ${e.message ?? e}`));
  void readHost().then((h) => { latest = h; }).catch(() => {});
  timer = setInterval(tick, SAMPLE_MS);
  timer.unref();
}

// ------------------------------------------------------------- the API and Talk

/** GET /api/resources: now (this server, its process groups, the event loop, the fleet, agents) and a range's history. */
export async function resources({ range = '1h' } = {}) {
  // Without the sampler (tests, a fresh start) a reading now; CPU percents need the second one.
  const host = latest && Date.now() - latest.at < 2 * SAMPLE_MS ? latest : (latest = await readHost());
  const [w, fl] = await Promise.all([work().catch(() => null), fleet()]);
  const { loopHealth, runningCommands } = await import('./ops.ts');
  const attention = attentionOf(host, w, fl);
  const s = resourceSettings();
  return {
    at: Date.now(), headline: headline(host, attention, w), attention, host, loop: loopHealth(), commands: runningCommands(),
    fleet: fl, work: w, settings: s, history: history(range), spark: range === '1h' ? undefined : history('1h', { points: 60 }),
  };
}

/** The same in Markdown, for Talk ("why is the server slow?", "what's using memory?"). */
export function resourcesMarkdown(r: Awaited<ReturnType<typeof resources>>) {
  const L = [`# Resources`, '', r.headline, ''];
  if (r.attention.length > 1) L.push('## Needs action', ...r.attention.map((a) => `- ${a.level === 'bad' ? '**' : ''}${a.text}${a.level === 'bad' ? '**' : ''}`), '');
  const h = r.host;
  if (h) {
    L.push('## This server', `- CPU ${h.cpu ?? '?'}% (${h.cpus} CPUs), load ${h.load.join(' / ')}, up ${Math.round(h.uptime / 3600)} h`,
      `- Memory ${h.mem.pct}% used (${gb(h.mem.used)} of ${gb(h.mem.total)}, ${gb(h.mem.available)} available), swap ${h.swap.pct}%`,
      ...h.disks.map((d) => `- Disk ${d.mount}: ${d.pct}% (${gb(d.free)} free of ${gb(d.size)})`),
      `- Network: in ${rateText(h.net.inPerSec)}, out ${rateText(h.net.outPerSec)}`,
      '', '## Using memory and CPU', ...h.groups.map((g) => `- ${g.name}: ${Math.round(g.mem / MB)} MB, CPU ${g.cpu ?? '?'}%${g.procs ? `, ${plural(g.procs, 'process', 'processes')}` : ''}${g.detail ? ` (${g.detail})` : ''}`), '');
  }
  const lm = r.loop.lastMinute;
  L.push(`## Studio's event loop`, `- ${lm ? `delay p50 ${lm.p50ms} ms, p99 ${lm.p99ms} ms, max ${lm.maxms} ms in the last minute` : 'not measured yet'}; ${plural(r.loop.blocksLastHour, 'freeze')} over a second in the last hour`, ...r.loop.blocks.slice(0, 3).map((b) => `- froze ${b.ms} ms at ${new Date(b.at).toISOString().slice(11, 19)}${b.running.length ? ` while: ${b.running.join('; ').slice(0, 200)}` : ''}`), '');
  if (r.work) {
    const a = r.work.agents;
    L.push('## Work', `- Agents: ${a.running} working of ${a.maxConcurrent} at once (${a.perProduct} per product${Object.keys(a.productLimits ?? {}).length ? `, ${Object.entries(a.productLimits).map(([p, n]) => `${p} ${n}`).join(', ')}` : ''}), ${a.queued} queued, ${a.waitingOnGen} waiting on Gen`,
      ...(r.work.pm ? [`- PM: ${r.work.pm.enabled ? 'on' : 'paused'}, ${r.work.pm.active} working of ${r.work.pm.maxConcurrent}, ${r.work.pm.started} of ${r.work.pm.maxStartsPerDay} starts today`] : []),
      `- Hawkes Gen jobs: ${r.work.jobs.ok ? `${r.work.jobs.running} running, ${r.work.jobs.queued} queued` : 'unknown (Gen not answering)'}`, '');
  }
  L.push('## Fleet (Hawkes Gen)');
  if (!r.fleet.ok) L.push(`- ${r.fleet.error}`);
  for (const m of r.fleet.machines) {
    const idle = m.idle ? (m.idle.busy ? ', busy' : `, idle ${m.idle.minutes} min${m.idle.stopsAt ? `, ${m.idle.action} ${m.idle.stopsAt > Date.now() ? `in ${Math.round((m.idle.stopsAt - Date.now()) / 60_000)} min` : 'any minute (past its stop time)'}` : ''}`) : '';
    L.push(`- ${m.name}: ${m.state}${m.region ? ` (${m.region})` : ''}${m.state === 'running' ? `, $${m.pricePerHour.toFixed(2)}/hr` : ''}${idle}${m.jobs.length ? `, running ${m.jobs.map((j) => `${j.tool} for ${j.project}`).join(', ')}` : ''}`);
  }
  return L.join('\n');
}
