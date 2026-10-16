// What the studio costs, in one place (the Costs tab, GET /api/costs, Talk's studio_costs, a line in the morning brief):
//
//   AWS          Cost Explorer (needs ce:GetCostAndUsage and ce:GetCostForecast on hawkes/hawkes-control): this month
//                by service and by component (control server, build server, playtester, GPU servers, disks, S3, DNS…,
//                from the usage type), daily totals and the forecast. Without the permission: an estimate (the fixed
//                table in docs/cloud.md prorated, plus the pay-per-use Hawkes Gen recorded). Each Cost Explorer request
//                costs $0.01, so results are cached (about 3 requests a day).
//   Idle money   EC2 Describe* (free) in the US regions: stopped servers' disks, unattached volumes, unused Elastic IPs,
//                snapshots, and servers running longer than they should.
//   Claude       Talk, agents and scouts run Claude Code on J's Max plan: what Claude Code reports is usage, not billed.
//                API-billed Claude (Gen's llm/review tools, Talk without the subscription token) is money.
//   Generation   Hawkes Gen's usage per project and provider (GPU hours, build server, ElevenLabs characters, Claude API).
//   Per product  Gen's usage by project, playtester time from Gen's playtest jobs, agents' Claude usage.
//
// Read-only: nothing here starts, stops or deletes anything in AWS. Alerts (checkCosts, hourly on the server) go to
// J's phone only when something looks wrong: the month's forecast over his budget, a server left running, spending in
// a region nothing should run in.

import fs from 'node:fs';
import path from 'node:path';
import { DATA, loadProducts, loadInfra } from './config.ts';
import { db, parse } from './db.ts';
import { gen } from './gen.ts';
import { usingSubscription } from './claude.ts';
import { notify, PUBLIC_URL } from './notify.ts';
import { isServer } from './repos.ts';
import { costExplorer, ec2, xitems, xtext, xtags, xget } from './aws.ts';

// ------------------------------------------------------------- prices, settings

/** On-demand US prices, for estimates and attribution (the bill itself comes from Cost Explorer). */
export const PRICES = { gpu: 1.861, playtester: 0.526, builder: 0.77, control: 0.0416, gp3: 0.08, gp2: 0.1, snapshot: 0.05, ipv4Month: 3.65, ceRequest: 0.01 };

/** The fixed monthly costs (docs/cloud.md, "Costs"), for the estimate when Cost Explorer isn't allowed. */
export const FIXED = [
  { name: 'Control server', perMonth: 30 },
  { name: 'Disks', perMonth: 16 + 24 + 20 + 6 },
  { name: 'Route 53, Secrets Manager, S3', perMonth: 3 },
];
export const FIXED_MONTHLY = FIXED.reduce((n, f) => n + f.perMonth, 0);

const REGIONS = (process.env.HAWKES_REGIONS ?? 'us-east-1,us-east-2,us-west-2').split(',').map((r) => r.trim()).filter(Boolean);

export type CostSettings = {
  /** The month's budget in USD for AWS plus pay-per-use APIs (not subscriptions). */
  budget: number;
  /** Phone alerts on (forecast over budget, servers left running, other regions). */
  alerts: boolean;
  /** Hours a server may run before it counts as left running. */
  gpuHours: number; builderHours: number; playtesterHours: number;
  /** Monthly subscriptions Studio can't see (Claude Max, ElevenLabs…), shown with the totals: { name: USD per month }. */
  subscriptions: Record<string, number>;
};
const DEFAULTS: CostSettings = { budget: 150, alerts: true, gpuHours: 3, builderHours: 2, playtesterHours: 3, subscriptions: {} };

type State = { settings?: Partial<CostSettings>; cache?: Record<string, { at: number; data: any }>; ce?: { month: string; requests: number; denied?: { at: number; message: string } }; sent?: Record<string, number> };
const FILE = () => path.join(DATA, 'costs.json');
function load(): State {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    return {};
  }
}
function save(s: State) {
  fs.writeFileSync(FILE(), JSON.stringify(s, null, 2));
}

export function costSettings(): CostSettings {
  return { ...DEFAULTS, ...(load().settings ?? {}) };
}
export function saveCostSettings(patch: Partial<CostSettings>) {
  const s = load();
  const cur = costSettings();
  const num = (v: unknown, d: number) => (v === undefined || v === null || v === '' ? d : Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  const subs = patch.subscriptions && typeof patch.subscriptions === 'object'
    ? Object.fromEntries(Object.entries(patch.subscriptions).filter(([k, v]) => k.trim() && Number(v) > 0).map(([k, v]) => [k.trim().slice(0, 40), Number(v)]))
    : cur.subscriptions;
  s.settings = {
    budget: num(patch.budget, cur.budget), alerts: patch.alerts ?? cur.alerts,
    gpuHours: num(patch.gpuHours, cur.gpuHours), builderHours: num(patch.builderHours, cur.builderHours), playtesterHours: num(patch.playtesterHours, cur.playtesterHours),
    subscriptions: subs,
  };
  save(s);
  return costSettings();
}

// ------------------------------------------------------------- periods

const DAY = 86_400_000;
const ymd = (d: Date | number) => new Date(d).toISOString().slice(0, 10);
const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const monthStart = (d: Date, add = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + add, 1));
const daysIn = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
const r2 = (n: number) => Math.round(n * 100) / 100;

export type Period = { key: string; label: string; start: number; end: number };
/** today | week (the last 7 days) | month (this month so far) | lastmonth | <n>d. Days are UTC, like AWS's. */
export function periodOf(key = 'month', now = new Date()): Period {
  const today = utcDay(now).getTime();
  const end = now.getTime();
  const n = /^(\d{1,3})d$/.exec(key);
  if (key === 'today') return { key, label: 'today', start: today, end };
  if (key === 'week') return { key, label: 'the last 7 days', start: today - 6 * DAY, end };
  if (key === 'lastmonth') {
    const s = monthStart(now, -1);
    return { key, label: s.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }), start: s.getTime(), end: monthStart(now).getTime() };
  }
  if (n) return { key, label: `the last ${n[1]} days`, start: today - (Number(n[1]) - 1) * DAY, end };
  return { key: 'month', label: `${monthStart(now).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} so far`, start: monthStart(now).getTime(), end };
}

// ------------------------------------------------------------- what an AWS charge is

export type Role = 'control' | 'builder' | 'playtester' | 'gpu' | 'other';
export const ROLE_NAMES: Record<Role, string> = { control: 'Control server', builder: 'Build server', playtester: 'Playtester (T4)', gpu: 'GPU servers', other: 'Other servers' };

/** A server's job, from its Name tag, else its instance type. */
export function roleOf(name: string, type: string): Role {
  if (name === 'hawkes-control') return 'control';
  if (name === 'hawkesgen-builder') return 'builder';
  if (name === 'hawkesgen-playtester') return 'playtester';
  if (/comfy/.test(name)) return 'gpu';
  if (/^g4dn\./.test(type)) return 'playtester';
  if (/^(g5|g6|g6e|g7e|p\d)\./.test(type)) return 'gpu';
  if (/^(t3|t3a|t4g)\./.test(type)) return 'control';
  if (/^m7i\./.test(type)) return 'builder';
  return 'other';
}

const REGION_PREFIX: Record<string, string> = {
  USE1: 'us-east-1', USE2: 'us-east-2', USW1: 'us-west-1', USW2: 'us-west-2', CAN1: 'ca-central-1', EUN1: 'eu-north-1', EUC1: 'eu-central-1',
  EUW1: 'eu-west-1', EUW2: 'eu-west-2', EUW3: 'eu-west-3', EU: 'eu-west-1', APN1: 'ap-northeast-1', APN2: 'ap-northeast-2', APS1: 'ap-southeast-1',
  APS2: 'ap-southeast-2', APS3: 'ap-south-1', SAE1: 'sa-east-1',
};
/** The region a Cost Explorer usage type is in ("USE2-BoxUsage:g6e.xlarge"); no prefix means us-east-1 or global. */
export function regionOfUsage(usageType: string) {
  const m = /^([A-Z]{2,4}\d?)-/.exec(usageType);
  return m ? REGION_PREFIX[m[1]] ?? m[1] : 'us-east-1';
}

/** Which part of the studio a Cost Explorer line is: a server role, disks, snapshots, IPs, S3, DNS… */
export function componentOf(service: string, usageType: string) {
  const ut = usageType.replace(/^[A-Z]{2,4}\d?-/, '');
  if (/BoxUsage|SpotUsage|DedicatedUsage|HostUsage/.test(ut)) return ROLE_NAMES[roleOf('', ut.split(':')[1] ?? '')];
  if (/^EBS:Snapshot/.test(ut)) return 'Snapshots';
  if (/^EBS:/.test(ut)) return 'Disks';
  if (/PublicIPv4|ElasticIP/.test(ut)) return 'Public IP addresses';
  if (/DataTransfer|-Bytes$|AWS-Out|AWS-In|CloudFront/.test(ut)) return 'Data transfer';
  if (/Simple Storage Service/.test(service)) return 'S3 (playtest videos, library)';
  if (/Route 53/.test(service)) return 'Route 53 (DNS)';
  if (/Secrets Manager/.test(service)) return 'Secrets Manager';
  if (/Cost Explorer/.test(service)) return 'Cost Explorer requests';
  if (/CloudWatch/.test(service)) return 'CloudWatch logs';
  if (/^Tax$/.test(service)) return 'Tax';
  return service.replace(/^Amazon |^AWS /, '');
}

// ------------------------------------------------------------- Cost Explorer (cached)

const CE_DENIED_HELP = 'Cost Explorer is not allowed for the server role yet (needs ce:GetCostAndUsage and ce:GetCostForecast on hawkes/hawkes-control; docs/cloud.md, "Costs").';

/** A Cost Explorer request through the cache: the current month is refreshed after `ttl`, closed months kept. */
async function ce(key: string, ttl: number, action: 'GetCostAndUsage' | 'GetCostForecast', request: any, force = false) {
  const s = load();
  const hit = s.cache?.[key];
  // A forced refresh still reuses anything fetched in the last hour (each request is $0.01).
  if (hit && Date.now() - hit.at < (force ? 3600_000 : ttl)) return hit.data;
  if (s.ce?.denied && Date.now() - s.ce.denied.at < 3600_000 && !force) throw Object.assign(new Error(s.ce.denied.message), { denied: true });
  let data: any;
  try {
    if (action === 'GetCostForecast') data = await costExplorer(action, request);
    else {
      // Grouped results can come in pages.
      data = { ResultsByTime: [] };
      let token: string | undefined;
      let pages = 0;
      do {
        const page = await costExplorer(action, { ...request, ...(token ? { NextPageToken: token } : {}) });
        pages++;
        for (const r of page.ResultsByTime ?? []) {
          const same = data.ResultsByTime.find((x: any) => x.TimePeriod.Start === r.TimePeriod.Start);
          if (same) same.Groups = [...(same.Groups ?? []), ...(r.Groups ?? [])];
          else data.ResultsByTime.push(r);
        }
        token = page.NextPageToken;
      } while (token && pages < 10);
      countRequests(pages - 1);
    }
  } catch (e: any) {
    const st = load();
    if (e.denied) st.ce = { ...(st.ce ?? { month: ymd(Date.now()).slice(0, 7), requests: 0 }), denied: { at: Date.now(), message: CE_DENIED_HELP } };
    save(st);
    throw e.denied ? Object.assign(new Error(CE_DENIED_HELP), { denied: true }) : e;
  }
  countRequests(1);
  const st = load();
  st.cache = { ...(st.cache ?? {}), [key]: { at: Date.now(), data } };
  if (st.ce) delete st.ce.denied;
  // Drop cache entries over 70 days old.
  for (const [k, v] of Object.entries(st.cache)) if (Date.now() - v.at > 70 * DAY) delete st.cache[k];
  save(st);
  return data;
}
function countRequests(n: number) {
  if (n <= 0) return;
  const s = load();
  const month = ymd(Date.now()).slice(0, 7);
  s.ce = s.ce?.month === month ? { ...s.ce, requests: s.ce.requests + n } : { month, requests: n };
  save(s);
}

const amount = (x: any) => Number(x?.UnblendedCost?.Amount ?? x?.Amount) || 0;

/** This month (or a closed month) by service and usage type: one request. */
async function ceMonth(start: Date, end: Date, force: boolean) {
  const closed = end.getTime() <= utcDay(new Date()).getTime() - 3 * DAY;
  const key = `month:${ymd(start)}:${closed ? ymd(end) : 'open'}`;
  const d = await ce(key, closed ? 365 * DAY : 20 * 3600_000, 'GetCostAndUsage', {
    TimePeriod: { Start: ymd(start), End: ymd(end) }, Granularity: 'MONTHLY', Metrics: ['UnblendedCost'],
    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }, { Type: 'DIMENSION', Key: 'USAGE_TYPE' }],
  }, force);
  const lines: { service: string; usageType: string; cost: number }[] = [];
  for (const r of d.ResultsByTime ?? []) for (const g of r.Groups ?? []) lines.push({ service: g.Keys[0], usageType: g.Keys[1], cost: amount(g.Metrics?.UnblendedCost) });
  return lines.filter((l) => Math.abs(l.cost) >= 0.0001);
}

/** Daily totals from the first of last month to today: one request. */
async function ceDaily(now: Date, force: boolean) {
  const start = monthStart(now, -1);
  const end = new Date(utcDay(now).getTime() + DAY);
  const d = await ce(`daily:${ymd(start)}`, 20 * 3600_000, 'GetCostAndUsage', { TimePeriod: { Start: ymd(start), End: ymd(end) }, Granularity: 'DAILY', Metrics: ['UnblendedCost'] }, force);
  return (d.ResultsByTime ?? []).map((r: any) => ({ date: r.TimePeriod.Start as string, cost: r2(amount(r.Total?.UnblendedCost)) }));
}

/** The rest of this month, forecast by AWS: one request (none on the last day of the month). */
async function ceForecast(now: Date, force: boolean) {
  const start = new Date(utcDay(now).getTime() + DAY);
  const end = monthStart(now, 1);
  if (start >= end) return 0;
  const d = await ce(`forecast:${ymd(start)}`, 20 * 3600_000, 'GetCostForecast', { TimePeriod: { Start: ymd(start), End: ymd(end) }, Granularity: 'MONTHLY', Metric: 'UNBLENDED_COST' }, force);
  return Number(d.Total?.Amount) || 0;
}

// ------------------------------------------------------------- EC2: servers and idle money

export type Server = { id: string; region: string; name: string; role: Role; type: string; state: string; launched: number | null; hours: number | null; perHour: number; diskGb: number; diskPerMonth: number };
export type Idle = { kind: 'stopped-disk' | 'unattached-volume' | 'unused-ip' | 'snapshot'; id: string; region: string; what: string; perMonth: number; note?: string };

const perHourOf = (role: Role, type: string) => (role === 'gpu' ? (type === 'g6e.2xlarge' ? 2.242 : type === 'g7e.2xlarge' ? 3.36 : PRICES.gpu) : role === 'playtester' ? PRICES.playtester : role === 'builder' ? PRICES.builder : role === 'control' ? (type === 't3.large' ? 0.0832 : PRICES.control) : 0);
const diskPrice = (type: string) => (type === 'gp2' ? PRICES.gp2 : type === 'st1' ? 0.045 : type === 'sc1' ? 0.015 : type === 'standard' ? 0.05 : PRICES.gp3);

let scanCache: { at: number; data: Awaited<ReturnType<typeof scanNow>> } | null = null;
/** Servers, disks, addresses and snapshots in the US regions, and the idle money among them (cached 10 minutes). */
export async function scanResources(force = false) {
  if (!force && scanCache && Date.now() - scanCache.at < 10 * 60_000) return scanCache.data;
  const data = await scanNow();
  scanCache = { at: Date.now(), data };
  return data;
}

async function scanNow() {
  const servers: Server[] = [];
  const idle: Idle[] = [];
  const errors: string[] = [];
  let disksPerMonth = 0;
  await Promise.all(REGIONS.map(async (region) => {
    try {
      const [inst, vols, addrs, snaps] = await Promise.all([
        ec2(region, 'DescribeInstances'),
        ec2(region, 'DescribeVolumes', { MaxResults: '500' }),
        ec2(region, 'DescribeAddresses'),
        ec2(region, 'DescribeSnapshots', { 'Owner.1': 'self', MaxResults: '500' }),
      ]);
      const volumes = xitems(xget(vols, 'DescribeVolumesResponse'), 'volumeSet').map((v) => ({
        id: xtext(v, 'volumeId'), size: Number(xtext(v, 'size')) || 0, type: xtext(v, 'volumeType'), status: xtext(v, 'status'),
        instance: xtext(xitems(v, 'attachmentSet')[0], 'instanceId'), name: xtags(v).Name ?? '',
      }));
      for (const v of volumes) disksPerMonth += v.size * diskPrice(v.type);
      for (const res of xitems(xget(inst, 'DescribeInstancesResponse'), 'reservationSet')) {
        for (const i of xitems(res, 'instancesSet')) {
          const state = xtext(i, 'instanceState/name');
          if (state === 'terminated' || state === 'shutting-down') continue;
          const id = xtext(i, 'instanceId');
          const type = xtext(i, 'instanceType');
          const name = xtags(i).Name ?? id;
          const role = roleOf(name, type);
          const launched = Date.parse(xtext(i, 'launchTime')) || null;
          const mine = volumes.filter((v) => v.instance === id);
          const diskGb = mine.reduce((n, v) => n + v.size, 0);
          const diskPerMonth = r2(mine.reduce((n, v) => n + v.size * diskPrice(v.type), 0));
          servers.push({ id, region, name, role, type, state, launched, hours: state === 'running' && launched ? Math.round(((Date.now() - launched) / 3600_000) * 10) / 10 : null, perHour: perHourOf(role, type), diskGb, diskPerMonth });
          if (state === 'stopped' && diskPerMonth > 0) {
            const kept = role === 'builder' || role === 'playtester' ? 'kept so it starts in a minute' : role === 'gpu' ? 'keeps the models; terminate spare GPU servers in Gen (fleet)' : undefined;
            idle.push({ kind: 'stopped-disk', id, region, what: `${name} (stopped): ${diskGb} GB of disk`, perMonth: diskPerMonth, ...(kept ? { note: kept } : {}) });
          }
        }
      }
      for (const v of volumes.filter((v) => v.status === 'available')) idle.push({ kind: 'unattached-volume', id: v.id, region, what: `Unattached disk ${v.name || v.id}: ${v.size} GB ${v.type}`, perMonth: r2(v.size * diskPrice(v.type)), note: 'attached to nothing: delete it if nothing needs it' });
      for (const a of xitems(xget(addrs, 'DescribeAddressesResponse'), 'addressesSet')) {
        if (xtext(a, 'associationId') || xtext(a, 'instanceId')) continue;
        idle.push({ kind: 'unused-ip', id: xtext(a, 'allocationId'), region, what: `Elastic IP ${xtext(a, 'publicIp')} (${xtags(a).Name ?? 'no name'}), attached to nothing`, perMonth: PRICES.ipv4Month, note: 'release it (deploy/release-ips.mjs)' });
      }
      for (const sn of xitems(xget(snaps, 'DescribeSnapshotsResponse'), 'snapshotSet')) {
        const gb = Number(xtext(sn, 'volumeSize')) || 0;
        idle.push({ kind: 'snapshot', id: xtext(sn, 'snapshotId'), region, what: `Snapshot ${xtext(sn, 'snapshotId')} of a ${gb} GB disk (${xtext(sn, 'startTime').slice(0, 10)})${xtext(sn, 'description') ? `: ${xtext(sn, 'description').slice(0, 60)}` : ''}`, perMonth: r2(gb * PRICES.snapshot), note: 'at most this much (snapshots store changed blocks only)' });
      }
    } catch (e: any) {
      errors.push(`${region}: ${e.message}`);
    }
  }));
  servers.sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
  idle.sort((a, b) => b.perMonth - a.perMonth);
  return { at: Date.now(), regions: REGIONS, servers, idle, idlePerMonth: r2(idle.reduce((n, i) => n + i.perMonth, 0)), disksPerMonth: r2(disksPerMonth), errors };
}

/** Servers running longer than J's limits allow (settings), worth a look. */
export function leftRunning(servers: Server[], s = costSettings()) {
  const limit = (r: Role) => (r === 'gpu' ? s.gpuHours : r === 'builder' ? s.builderHours : r === 'playtester' ? s.playtesterHours : Infinity);
  return servers.filter((x) => x.state === 'running' && x.hours !== null && x.hours > limit(x.role));
}

// ------------------------------------------------------------- AWS

export type AwsCosts = {
  source: 'cost-explorer' | 'estimate'; why?: string; fetchedAt: number | null; ceRequests: number;
  total: number; month: { soFar: number; forecast: number; days: number; elapsedDays: number; lastMonth: number | null };
  byService: { name: string; cost: number }[]; byComponent: { name: string; cost: number }[]; otherRegions: { region: string; cost: number }[];
  daily: { date: string; cost: number }[];
};

const sumBy = <T>(xs: T[], key: (x: T) => string, val: (x: T) => number) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + val(x));
  return [...m].map(([name, cost]) => ({ name, cost: r2(cost) })).filter((x) => Math.abs(x.cost) >= 0.01).sort((a, b) => b.cost - a.cost);
};

export async function awsCosts(p: Period, { force = false, gu }: { force?: boolean; gu?: GenUsage } = {}): Promise<AwsCosts> {
  const now = new Date();
  const days = daysIn(now);
  const elapsedDays = (now.getTime() - monthStart(now).getTime()) / DAY;
  try {
    const [daily, monthLines, rest] = await Promise.all([
      ceDaily(now, force),
      p.key === 'lastmonth' ? ceMonth(monthStart(now, -1), monthStart(now), force) : ceMonth(monthStart(now), new Date(utcDay(now).getTime() + DAY), force),
      ceForecast(now, force).catch(() => null),
    ]);
    const inMonth = (m: Date) => daily.filter((d: any) => d.date.slice(0, 7) === ymd(m).slice(0, 7)).reduce((n: number, d: any) => n + d.cost, 0);
    const soFar = r2(inMonth(now));
    const total = r2(daily.filter((d: any) => Date.parse(d.date) >= utcDay(new Date(p.start)).getTime() && Date.parse(d.date) < p.end).reduce((n: number, d: any) => n + d.cost, 0));
    const s = load();
    const fetchedAt = Math.min(...['daily:', 'month:'].map((k) => Math.max(0, ...Object.entries(s.cache ?? {}).filter(([key]) => key.startsWith(k)).map(([, v]) => v.at))));
    return {
      source: 'cost-explorer', fetchedAt, ceRequests: s.ce?.month === ymd(now).slice(0, 7) ? s.ce.requests : 0, total,
      month: { soFar, forecast: r2(rest === null ? (soFar / Math.max(elapsedDays, 0.5)) * days : soFar + rest), days, elapsedDays: Math.round(elapsedDays * 10) / 10, lastMonth: r2(inMonth(monthStart(now, -1))) },
      byService: sumBy(monthLines, (l) => l.service.replace(/^Amazon |^AWS /, ''), (l) => l.cost),
      byComponent: sumBy(monthLines, (l) => componentOf(l.service, l.usageType), (l) => l.cost),
      otherRegions: sumBy(monthLines.filter((l) => !REGIONS.includes(regionOfUsage(l.usageType))), (l) => regionOfUsage(l.usageType), (l) => l.cost).map((x) => ({ region: x.name, cost: x.cost })),
      daily: daily.slice(-35),
    };
  } catch (e: any) {
    return estimateAws(p, e.denied ? CE_DENIED_HELP : `Cost Explorer failed: ${String(e.message).slice(0, 120)}`, gu);
  }
}

/** Without Cost Explorer: the fixed costs prorated, plus the AWS time Hawkes Gen recorded (GPU, build server). */
async function estimateAws(p: Period, why: string, g?: GenUsage): Promise<AwsCosts> {
  const now = new Date();
  const days = daysIn(now);
  const elapsedDays = (now.getTime() - monthStart(now).getTime()) / DAY;
  const fixedFor = (ms: number) => (FIXED_MONTHLY * ms) / (days * DAY);
  const mStart = monthStart(now).getTime();
  const month = g && g.period.start === mStart ? g : await genUsage(periodOf('month', now));
  const periodGen = g && g.period.start === p.start ? g : await genUsage(p);
  const awsOf = (u: GenUsage) => u.byProvider.filter((x) => x.provider.startsWith('aws-')).reduce((n, x) => n + x.cost, 0);
  const soFar = fixedFor(now.getTime() - mStart) + awsOf(month);
  const payPerUse = awsOf(month);
  const comp = [
    ...FIXED.map((f) => ({ name: f.name, cost: r2(fixedFor(now.getTime() - mStart) * (f.perMonth / FIXED_MONTHLY)) })),
    ...month.byProvider.filter((x) => x.provider.startsWith('aws-')).map((x) => ({ name: x.provider === 'aws-gpu' ? ROLE_NAMES.gpu : x.provider === 'aws-builder' ? ROLE_NAMES.builder : x.provider, cost: r2(x.cost) })),
  ].filter((x) => x.cost >= 0.01).sort((a, b) => b.cost - a.cost);
  return {
    source: 'estimate', why, fetchedAt: null, ceRequests: 0,
    total: r2(fixedFor(p.end - p.start) + awsOf(periodGen)),
    month: { soFar: r2(soFar), forecast: r2(FIXED_MONTHLY + (payPerUse / Math.max(elapsedDays, 0.5)) * days), days, elapsedDays: Math.round(elapsedDays * 10) / 10, lastMonth: null },
    byService: [], byComponent: comp, otherRegions: [], daily: [],
  };
}

// ------------------------------------------------------------- Hawkes Gen

export const PROVIDER_NAMES: Record<string, string> = {
  'aws-gpu': 'GPU servers (AWS)', 'aws-builder': 'Build server (AWS)', anthropic: 'Claude API (billed)', elevenlabs: 'ElevenLabs (voice, SFX)',
  comfy: 'ComfyUI', local: 'This server (free)', playtest: 'Playtests', pipeline: 'Pipelines',
};
const UNIT_NAMES: Record<string, string> = { gpu_seconds: 'GPU hours', seconds: 'hours', characters: 'characters', tokens: 'tokens' };
export const unitAmount = (unit: string, amount: number) => (unit === 'gpu_seconds' || unit === 'seconds' ? `${(amount / 3600).toFixed(1)} ${UNIT_NAMES[unit]}` : `${Math.round(amount).toLocaleString('en-US')} ${UNIT_NAMES[unit] ?? unit}`);

type Row = { grp: string; provider: string; unit: string; amount: number; cost: number; jobs: number };
export type GenUsage = { period: Period; ok: boolean; error?: string; total: number; byProvider: { provider: string; unit: string; amount: number; cost: number }[]; byProject: Row[] };

/** Gen's usage over a period (Gen only filters by "since": a closed period subtracts what came after it). */
export async function genUsage(p: Period): Promise<GenUsage> {
  try {
    const after = p.end < Date.now() - 60_000;
    const [a, b] = await Promise.all([gen.usage({ since: String(p.start), by: 'project' }), after ? gen.usage({ since: String(p.end), by: 'project' }) : Promise.resolve({ rows: [] })]);
    const key = (r: any) => `${r.grp}|${r.provider}|${r.unit}`;
    const minus = new Map((b.rows as any[]).map((r) => [key(r), r]));
    const byProject: Row[] = (a.rows as any[]).map((r) => {
      const m = minus.get(key(r));
      return { grp: r.grp, provider: r.provider, unit: r.unit, amount: (Number(r.amount) || 0) - (Number(m?.amount) || 0), cost: (Number(r.cost) || 0) - (Number(m?.cost) || 0), jobs: (Number(r.jobs) || 0) - (Number(m?.jobs) || 0) };
    }).filter((r) => r.amount > 0 || r.cost > 0);
    const prov = new Map<string, { provider: string; unit: string; amount: number; cost: number }>();
    for (const r of byProject) {
      const k = `${r.provider}|${r.unit}`;
      const cur = prov.get(k) ?? { provider: r.provider, unit: r.unit, amount: 0, cost: 0 };
      cur.amount += r.amount;
      cur.cost += r.cost;
      prov.set(k, cur);
    }
    const byProvider = [...prov.values()].map((x) => ({ ...x, cost: r2(x.cost) })).sort((x, y) => y.cost - x.cost);
    return { period: p, ok: true, total: r2(byProject.reduce((n, r) => n + r.cost, 0)), byProvider, byProject };
  } catch (e: any) {
    return { period: p, ok: false, error: `Hawkes Gen: ${e.message}`, total: 0, byProvider: [], byProject: [] };
  }
}

let ptCache: { at: number; jobs: any[] } | null = null;
/** Playtester time per project from Gen's playtest jobs that ran on a GPU host (site crawls run on the server, free). */
export async function playtesterTime(p: Period) {
  if (!ptCache || Date.now() - ptCache.at > 10 * 60_000) ptCache = { at: Date.now(), jobs: await gen.jobs({ tool: 'playtest.run', limit: '500' }).catch(() => []) };
  const out = new Map<string, { minutes: number; cost: number; runs: number }>();
  for (const j of ptCache.jobs) {
    const browser = String(j.result?.browser ?? '');
    if (!browser.startsWith('GPU server') || !j.started || !j.finished || j.started < p.start || j.started >= p.end) continue;
    const minutes = (j.finished - j.started) / 60000;
    const rate = /comfy/.test(browser) ? PRICES.gpu : PRICES.playtester;
    const cur = out.get(j.project) ?? { minutes: 0, cost: 0, runs: 0 };
    cur.minutes += minutes;
    cur.cost += (minutes / 60) * rate;
    cur.runs++;
    out.set(j.project, cur);
  }
  return out;
}

// ------------------------------------------------------------- Claude

/** Build costs an agent change's log records ("build: ... ($0.12)"); changes.cost holds builds plus Claude. */
export function buildCostsInLog(log: string[]) {
  return log.reduce((n, line) => n + (Number(/^build: .*\(\$(\d+(?:\.\d+)?)\)\s*$/.exec(line)?.[1]) || 0), 0);
}

export type ClaudeCosts = {
  plan: 'subscription' | 'api'; billed: number; usage: number;
  talk: { usage: number; billed: number; turns: number }; agents: { usage: number; billed: number; runs: number }; scouts: { usage: number; billed: number; runs: number };
  perDay: { date: string; usage: number; billed: number }[]; perProduct: Record<string, { usage: number; billed: number; runs: number }>;
};

export function claudeCosts(p: Period): ClaudeCosts {
  const plan = usingSubscription() ? 'subscription' : 'api';
  const perDay = new Map<string, { usage: number; billed: number }>();
  const day = (t: number, usage: number, billed: number) => {
    const d = perDay.get(ymd(t)) ?? { usage: 0, billed: 0 };
    d.usage += usage;
    d.billed += billed;
    perDay.set(ymd(t), d);
  };
  const talk = { usage: 0, billed: 0, turns: 0 };
  for (const c of db.prepare('SELECT messages FROM conversations WHERE COALESCE(updated, created) >= ?').all(p.start) as any[]) {
    for (const m of (parse(c.messages) ?? []) as any[]) {
      if (!m?.turn || m.at < p.start || m.at >= p.end) continue;
      const cost = Number(m.turn.cost) || 0;
      const billed = m.turn.billing === 'api' ? cost : 0;
      talk.usage += cost;
      talk.billed += billed;
      talk.turns++;
      day(m.at, cost, billed);
    }
  }
  const perProduct: ClaudeCosts['perProduct'] = {};
  const agents = { usage: 0, billed: 0, runs: 0 };
  for (const c of db.prepare('SELECT product, cost, log, created FROM changes WHERE created >= ? AND created < ?').all(p.start, p.end) as any[]) {
    const usage = Math.max(0, (Number(c.cost) || 0) - buildCostsInLog(parse(c.log) ?? []));
    const billed = plan === 'api' ? usage : 0;
    agents.usage += usage;
    agents.billed += billed;
    agents.runs++;
    const pp = (perProduct[c.product] ??= { usage: 0, billed: 0, runs: 0 });
    pp.usage += usage;
    pp.billed += billed;
    pp.runs++;
    day(c.created, usage, billed);
  }
  const scouts = { usage: 0, billed: 0, runs: 0 };
  try {
    for (const s of db.prepare('SELECT product, cost, created FROM scouts WHERE created >= ? AND created < ?').all(p.start, p.end) as any[]) {
      const usage = Number(s.cost) || 0;
      const billed = plan === 'api' ? usage : 0;
      scouts.usage += usage;
      scouts.billed += billed;
      scouts.runs++;
      const pp = (perProduct[s.product] ??= { usage: 0, billed: 0, runs: 0 });
      pp.usage += usage;
      pp.billed += billed;
      day(s.created, usage, billed);
    }
  } catch {
    // No scouts table yet.
  }
  const round = <T extends Record<string, number>>(o: T) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === 'turns' || k === 'runs' ? v : r2(v)])) as T;
  return {
    plan, usage: r2(talk.usage + agents.usage + scouts.usage), billed: r2(talk.billed + agents.billed + scouts.billed),
    talk: round(talk), agents: round(agents), scouts: round(scouts),
    perDay: [...perDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, usage: r2(v.usage), billed: r2(v.billed) })),
    perProduct: Object.fromEntries(Object.entries(perProduct).map(([k, v]) => [k, round(v)])),
  };
}

// ------------------------------------------------------------- per product

export type ProductCosts = {
  id: string; name: string; gpu: number; builder: number; playtester: number; playtesterMinutes: number; claudeApi: number; voice: number; otherGen: number;
  money: number; agentUsage: number; agentRuns: number; jobs: number; detail: string[];
};

export function perProduct(g: GenUsage, pt: Map<string, { minutes: number; cost: number; runs: number }>, c: ClaudeCosts): ProductCosts[] {
  const names = new Map<string, string>([...loadProducts().map((x) => [x.id, x.name] as [string, string]), ...loadInfra().map((x: any) => [x.id, x.name ?? x.id] as [string, string])]);
  const ids = new Set<string>([...g.byProject.map((r) => r.grp), ...pt.keys(), ...Object.keys(c.perProduct)]);
  const rows = [...ids].map((id) => {
    const mine = g.byProject.filter((r) => r.grp === id);
    const of = (prov: string) => mine.filter((r) => r.provider === prov).reduce((n, r) => n + r.cost, 0);
    const gpu = of('aws-gpu'), builder = of('aws-builder'), claudeApi = of('anthropic'), voice = of('elevenlabs');
    const otherGen = mine.filter((r) => !['aws-gpu', 'aws-builder', 'anthropic', 'elevenlabs'].includes(r.provider)).reduce((n, r) => n + r.cost, 0);
    const t = pt.get(id);
    const playtester = t?.cost ?? 0;
    const a = c.perProduct[id];
    return {
      id, name: names.get(id) ?? id, gpu: r2(gpu), builder: r2(builder), playtester: r2(playtester), playtesterMinutes: Math.round(t?.minutes ?? 0), claudeApi: r2(claudeApi), voice: r2(voice), otherGen: r2(otherGen),
      money: r2(gpu + builder + playtester + claudeApi + voice + otherGen + (a?.billed ?? 0)), agentUsage: r2(a?.usage ?? 0), agentRuns: a?.runs ?? 0,
      jobs: mine.reduce((n, r) => Math.max(n, r.jobs), 0),
      detail: mine.filter((r) => r.amount > 0).map((r) => `${PROVIDER_NAMES[r.provider] ?? r.provider}: ${unitAmount(r.unit, r.amount)}${r.cost ? ` ($${r.cost.toFixed(2)})` : ''}`),
    };
  });
  return rows.filter((r) => r.money > 0 || r.agentUsage > 0 || r.jobs > 0).sort((a, b) => b.money - a.money || b.agentUsage - a.agentUsage);
}

// ------------------------------------------------------------- the whole picture

export async function costReport(periodKey = 'month', { force = false } = {}) {
  const p = periodOf(periodKey);
  const settings = costSettings();
  const g = await genUsage(p);
  const [aws, pt, resources] = await Promise.all([
    awsCosts(p, { force, gu: g }),
    playtesterTime(p).catch(() => new Map()),
    scanResources(force).catch((e: any) => ({ at: Date.now(), regions: REGIONS, servers: [] as Server[], idle: [] as Idle[], idlePerMonth: 0, disksPerMonth: 0, errors: [String(e.message)] })),
  ]);
  const claude = claudeCosts(p);
  const products = perProduct(g, pt, claude);
  // Money outside AWS: Claude through the API (Gen's tools, Talk/agents without the subscription), ElevenLabs, and
  // anything else Gen priced that isn't AWS time (that is already in the AWS bill).
  const apiMoney = r2(g.byProvider.filter((x) => !x.provider.startsWith('aws-')).reduce((n, x) => n + x.cost, 0) + claude.billed);
  const subsMonthly = Object.values(settings.subscriptions).reduce((n, v) => n + v, 0);
  // The budget's forecast: AWS's forecast plus this month's API money at its pace so far.
  const monthApi = p.key === 'month' ? apiMoney : await (async () => {
    const mp = periodOf('month');
    const mg = await genUsage(mp);
    return mg.byProvider.filter((x) => !x.provider.startsWith('aws-')).reduce((n, x) => n + x.cost, 0) + claudeCosts(mp).billed;
  })();
  const forecast = r2(aws.month.forecast + (monthApi / Math.max(aws.month.elapsedDays, 0.5)) * aws.month.days);
  const playtesterAttributed = [...pt.values()].reduce((n, x) => n + x.cost, 0);
  const awsAttributed = r2(g.byProvider.filter((x) => x.provider.startsWith('aws-')).reduce((n, x) => n + x.cost, 0) + playtesterAttributed);
  const notes: string[] = [];
  if (aws.source === 'estimate' && aws.why) notes.push(aws.why);
  if (!g.ok && g.error) notes.push(g.error);
  for (const e of resources.errors) notes.push(`EC2 ${e}`);
  return {
    period: p, generatedAt: Date.now(), settings,
    totals: { money: r2(aws.total + apiMoney), aws: aws.total, api: apiMoney, subscriptionsPerMonth: r2(subsMonthly), forecast, budget: settings.budget, overBudget: settings.budget > 0 && forecast > settings.budget },
    aws, claude, gen: g, products,
    shared: { awsUnattributed: r2(Math.max(0, aws.total - awsAttributed)), talkUsage: claude.talk.usage, talkBilled: claude.talk.billed },
    resources: { ...resources, leftRunning: leftRunning(resources.servers, settings) },
    notes,
  };
}
export type CostReport = Awaited<ReturnType<typeof costReport>>;

// ------------------------------------------------------------- words (brief, Talk)

const $ = (n: number) => `$${n.toFixed(2)}`;

/** The morning brief's line: the month so far, the forecast against the budget, and idle money. */
export async function costLine() {
  const r = await costReport('month');
  const a = r.aws;
  const parts = [
    `Costs: AWS ${a.source === 'estimate' ? 'about ' : ''}${$(a.month.soFar)} this month so far${a.source === 'estimate' ? ' (estimate)' : ''}`,
    `${r.totals.api ? `, APIs ${$(r.totals.api)}` : ''}; forecast ${$(r.totals.forecast)}${r.settings.budget ? ` of the ${$(r.settings.budget)} budget${r.totals.overBudget ? ' (OVER)' : ''}` : ''}`,
    r.resources.idlePerMonth >= 1 ? `; idle money ${$(r.resources.idlePerMonth)}/month (${r.resources.idle.length} item(s), Costs tab)` : '',
    r.resources.leftRunning.length ? `; left running: ${r.resources.leftRunning.map((s) => `${s.name} ${s.hours} h`).join(', ')}` : '',
    '.',
  ];
  return parts.join('');
}

/** A Markdown answer to "what did this week cost?" (Talk's studio_costs). */
export function costMarkdown(r: CostReport) {
  const a = r.aws;
  const L: string[] = [];
  L.push(`# Costs: ${r.period.label}`);
  L.push(`**Money spent:** ${$(r.totals.money)} = AWS ${a.source === 'estimate' ? 'about ' : ''}${$(a.total)}${a.source === 'estimate' ? ' (estimate)' : ' (Cost Explorer)'} + APIs ${$(r.totals.api)}.`);
  L.push(`**This month:** AWS ${$(a.month.soFar)} so far, forecast ${$(r.totals.forecast)} with APIs${r.settings.budget ? ` (budget ${$(r.settings.budget)}${r.totals.overBudget ? ', **over**' : ''})` : ''}.${a.month.lastMonth !== null ? ` Last month's AWS: ${$(a.month.lastMonth)}.` : ''}`);
  if (r.totals.subscriptionsPerMonth) L.push(`Subscriptions (fixed, not counted above): ${Object.entries(r.settings.subscriptions).map(([k, v]) => `${k} ${$(v)}`).join(', ')}.`);
  if (a.byComponent.length) L.push('', `## AWS this month by part`, ...a.byComponent.slice(0, 12).map((x) => `- ${x.name}: ${$(x.cost)}`));
  if (a.otherRegions.length) L.push('', `Charges outside the US regions: ${a.otherRegions.map((x) => `${x.region} ${$(x.cost)}`).join(', ')}.`);
  L.push('', '## Generation (Hawkes Gen)', ...(r.gen.byProvider.length ? r.gen.byProvider.map((x) => `- ${PROVIDER_NAMES[x.provider] ?? x.provider}: ${unitAmount(x.unit, x.amount)}, ${$(x.cost)}`) : ['- nothing recorded']));
  const c = r.claude;
  L.push('', '## Claude', c.plan === 'subscription'
    ? `Talk, agents and scouts run on J's Max plan: Claude Code reports ${$(c.usage)} of usage at API prices (Talk ${$(c.talk.usage)} over ${c.talk.turns} answers, agents ${$(c.agents.usage)} over ${c.agents.runs} changes). **Not billed.**`
    : `Claude Code is on the API key (no subscription token): ${$(c.billed)} billed (Talk ${$(c.talk.billed)}, agents ${$(c.agents.billed)}).`);
  const api = r.gen.byProvider.find((x) => x.provider === 'anthropic');
  if (api) L.push(`Claude API through Hawkes Gen (reviews, llm tools): ${$(api.cost)}, billed.`);
  if (r.products.length) {
    L.push('', '## Per product (money; agents\' Claude usage not billed)');
    for (const x of r.products) L.push(`- ${x.name}: ${$(x.money)}${[x.gpu && `GPU ${$(x.gpu)}`, x.builder && `builds ${$(x.builder)}`, x.playtester && `playtester ${$(x.playtester)} (${x.playtesterMinutes} min)`, x.claudeApi && `reviews/Claude API ${$(x.claudeApi)}`, x.voice && `ElevenLabs ${$(x.voice)}`].filter(Boolean).map((s) => `, ${s}`).join('')}${x.agentRuns ? `; agents ${x.agentRuns} run(s), ${$(x.agentUsage)} usage` : ''}`);
    L.push(`- Shared (control server, disks, S3, DNS, idle time): AWS ${$(r.shared.awsUnattributed)}`);
  }
  const res = r.resources;
  if (res.leftRunning.length) L.push('', `**Left running:** ${res.leftRunning.map((s) => `${s.name} (${s.type}, ${s.region}) ${s.hours} h, about ${$(s.hours! * s.perHour)}`).join('; ')}.`);
  if (res.idle.length) L.push('', `## Idle money: ${$(res.idlePerMonth)}/month`, ...res.idle.map((i) => `- ${i.what}: ${$(i.perMonth)}/month${i.note ? ` (${i.note})` : ''}`));
  if (r.notes.length) L.push('', ...r.notes.map((n) => `_${n}_`));
  return L.join('\n');
}

// ------------------------------------------------------------- alerts

/** notify once per key, remembered across restarts (alerts are rare: a month's budget, one server's launch). */
async function alertOnce(key: string, title: string, message: string) {
  const s = load();
  s.sent ??= {};
  if (s.sent[key]) return false;
  s.sent[key] = Date.now();
  for (const [k, at] of Object.entries(s.sent)) if (Date.now() - at > 45 * DAY) delete s.sent[k];
  save(s);
  return notify(title, message, { url: `${PUBLIC_URL}/#costs`, tags: ['moneybag'], priority: 4 });
}

/** What would go to J's phone now (pure, for tests and the check below). */
export function costAlerts(r: Pick<CostReport, 'totals' | 'settings' | 'aws' | 'resources'>, month = ymd(Date.now()).slice(0, 7)) {
  const out: { key: string; title: string; message: string }[] = [];
  const t = r.totals;
  if (r.settings.budget > 0 && t.forecast > r.settings.budget) {
    const level = t.forecast > r.settings.budget * 1.25 ? '125' : '100';
    out.push({ key: `budget:${month}:${level}`, title: `Costs: this month's forecast is ${$(t.forecast)}`, message: `Over your ${$(r.settings.budget)} budget${level === '125' ? ' by more than a quarter' : ''}. AWS ${$(r.aws.month.soFar)} so far, APIs ${$(t.api)}. The Costs tab shows where it goes.` });
  }
  for (const s of r.resources.leftRunning) out.push({ key: `running:${s.id}:${s.launched}`, title: `${ROLE_NAMES[s.role].replace(/s$/, '')} left running: ${s.name}`, message: `${s.name} (${s.type}, ${s.region}) has run ${s.hours} h, about ${$(s.hours! * s.perHour)} so far. It should stop itself when idle; check Hawkes Gen.` });
  for (const x of r.aws.otherRegions.filter((x) => x.cost >= 1)) out.push({ key: `region:${month}:${x.region}`, title: `AWS charges in ${x.region}: ${$(x.cost)}`, message: `Nothing should run outside ${REGIONS.join(', ')}. The Costs tab lists the charges.` });
  return out;
}

export async function checkCosts() {
  const s = costSettings();
  if (!s.alerts) return [];
  const r = await costReport('month');
  const sent: string[] = [];
  for (const a of costAlerts(r)) if (await alertOnce(a.key, a.title, a.message)) sent.push(a.key);
  return sent;
}

let watch: NodeJS.Timeout | null = null;
/** The hourly check, on the server (or on J's PC with STUDIO_COST_WATCH=on). */
export function startCostWatch() {
  if (watch || !(isServer() || process.env.STUDIO_COST_WATCH === 'on')) return;
  const tick = () => checkCosts().catch((e) => console.warn(`[studio] cost check failed: ${e.message}`));
  setTimeout(tick, 3 * 60_000);
  watch = setInterval(tick, 3600_000);
}
