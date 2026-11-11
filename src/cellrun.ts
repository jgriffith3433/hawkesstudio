// Customers' Studios on Cloud Run (docs/studio-customers.md, section 2): one Cloud Run service per customer org, made
// from Studio's own image through the Cloud Run Admin API v2 (no gcloud, no SDK: gcp.ts gapi). Nothing per customer
// costs money or uses a quota beyond the service itself:
//   - every cell runs as ONE shared service account (STUDIO_CELLS_SA), never one per customer (~100 per project)
//   - no Secret Manager secret per customer: its keys are derived from the master (cellkeys.ts) and set as plain env
//   - one shared bucket (STUDIO_CELLS_BUCKET), each cell under its own prefix o/<org>/ (cloudhost.ts statePrefix)
//   - one shared agents' job (STUDIO_CELLS_AGENT_JOB, default studio-cell-agent)
// Services are labelled hawkes-studio-cell=1 and hawkes-org=<org>, so a roll finds the awake ones without the control
// plane's records.
//
// Dry run (STUDIO_CELLS_DRY_RUN=1, or { dry: true }): nothing is sent; each call returns the request it would have made.

import crypto from 'node:crypto';
import { gapi } from './gcp.ts';
import { StudioError } from './config.ts';
import { cellKeyEnv } from './cellkeys.ts';

export type CellsConfig = {
  project: string; projectNumber: string; region: string; serviceAccount: string; bucket: string; agentJob: string;
  publicUrl: string; controlUrl: string; genUrl: string; genPublicUrl: string; googleClientId: string; lane: 'live' | 'beta'; studioService: string;
};

export function cellsConfig(env: NodeJS.ProcessEnv = process.env): CellsConfig {
  const lane = env.STUDIO_LANE === 'beta' ? 'beta' : 'live';
  return {
    project: env.STUDIO_CELLS_PROJECT || env.STUDIO_GCP_PROJECT || '',
    projectNumber: env.STUDIO_CELLS_PROJECT_NUMBER || '',
    region: env.STUDIO_CELLS_REGION || env.STUDIO_GCP_REGION || 'us-east4',
    serviceAccount: env.STUDIO_CELLS_SA || '',
    bucket: env.STUDIO_CELLS_BUCKET || '',
    agentJob: env.STUDIO_CELLS_AGENT_JOB || 'studio-cell-agent',
    publicUrl: (env.STUDIO_PUBLIC_URL || (lane === 'beta' ? 'https://studio-beta.hawkesgen.ai' : 'https://studio.hawkesgen.ai')).replace(/\/+$/, ''),
    controlUrl: (env.STUDIO_SERVICE_URL || env.STUDIO_PUBLIC_URL || '').replace(/\/+$/, ''),
    // Gen's own address for server calls (Cloud Run's run.app, not the Cloudflare edge) and its public one for browsers.
    genUrl: env.HAWKESGEN_URL || '',
    genPublicUrl: env.GEN_PUBLIC_URL || env.HAWKESGEN_URL || '',
    googleClientId: env.STUDIO_GOOGLE_CLIENT_ID || '',
    lane,
    studioService: env.K_SERVICE || env.STUDIO_SERVICE || (lane === 'beta' ? 'studio-beta' : 'studio'),
  };
}

export function missingConfig(c = cellsConfig()) {
  return (['project', 'projectNumber', 'serviceAccount', 'bucket'] as const).filter((k) => !c[k]);
}

export const dryRun = (o?: { dry?: boolean }) => o?.dry ?? process.env.STUDIO_CELLS_DRY_RUN === '1';

/** A cell's service name: studio-o-<org> (studio-beta-o-<org> on the beta lane). Cloud Run allows 49 characters. */
export const serviceName = (org: string, c = cellsConfig()) => `${c.lane === 'beta' ? 'studio-beta' : 'studio'}-o-${org}`.slice(0, 49);
/** Cloud Run's deterministic address for it (the Worker computes the same). */
export const serviceUrl = (org: string, c = cellsConfig()) => `https://${serviceName(org, c)}-${c.projectNumber}.${c.region}.run.app`;
const base = (c: CellsConfig) => `https://run.googleapis.com/v2/projects/${c.project}/locations/${c.region}`;

export type Planned = { method: string; url: string; body?: unknown };
/** Every request a dry run would have made (tests and the dry-run summary read it). */
export const planned: Planned[] = [];

async function call(method: string, url: string, body: unknown, o: { dry?: boolean; missingOk?: boolean } = {}) {
  if (dryRun(o)) {
    planned.push({ method, url, ...(body === undefined ? {} : { body }) });
    return { dry: true, method, url };
  }
  return gapi(url, { method, body, missingOk: o.missingOk, timeoutMs: 120_000 });
}

/** What a cell runs with. `owner` is the control-plane account that claims it (only that Google account can). */
export type CellGen = { genOrg: string; key: string };

export function cellEnv(org: string, owner: { sub: string; email: string }, c = cellsConfig(), gen?: CellGen): Record<string, string> {
  return {
    STUDIO_ORG: org,
    STUDIO_SIGNUP: 'owner',
    STUDIO_OWNER_SUB: owner.sub,
    STUDIO_LANE: c.lane,
    STUDIO_STATE_BUCKET: c.bucket,
    STUDIO_STATE_PREFIX: `o/${org}/`,
    STUDIO_GCP_PROJECT: c.project,
    STUDIO_GCP_REGION: c.region,
    STUDIO_AGENT_JOB: c.agentJob,
    STUDIO_PUBLIC_URL: `${c.publicUrl}/o/${org}`,
    STUDIO_SERVICE_URL: serviceUrl(org, c),
    STUDIO_CONTROL_URL: c.controlUrl,
    // Its own session cookie, for this host only: never J's (hawkes_session for all of hawkesgen.ai).
    STUDIO_COOKIE_NAME: `hs_o_${org.replace(/-/g, '_')}`,
    STUDIO_COOKIE_HOST_ONLY: '1',
    STUDIO_GOOGLE_EMAILS: '',
    ...(c.genUrl ? { HAWKESGEN_URL: c.genUrl, GEN_PUBLIC_URL: c.genPublicUrl || c.genUrl } : {}),
    // Its own Gen key (cells.ts ensureGenKey): role user, only its Gen org's projects; its jobs run as org_<hex>.<game>.
    ...(gen ? { HAWKESGEN_KEY: gen.key, AGENT_GEN_KEY: gen.key, HAWKESGEN_PROJECT_PREFIX: `${gen.genOrg}.` } : {}),
    ...(c.googleClientId ? { STUDIO_GOOGLE_CLIENT_ID: c.googleClientId } : {}),
    ...cellKeyEnv(org),
  };
}

/**
 * A cell's size. 2 GiB ran out when several beta-site publishes overlapped (J's Studio restarted in a loop, 2026-11-01);
 * J, 2026-11-01: "For now just scale the memory up." One vCPU then ran full on a busy day and Cloud Run answered 429 with
 * two requests in flight (J's Studio, 2026-11-06); on two it stopped refusing, and J raised every customer's the same day.
 */
export const CELL_LIMITS = { cpu: '2', memory: '4Gi' } as const;
/**
 * How long a Studio may take from start to listening: the lease (up to ~30 s for the old instance to hand over),
 * `litestream restore` (at most an hour of WAL: litestream.yml's hourly snapshots), the state pull. Cloud Run's default
 * TCP probe allows 4 minutes in one attempt, and three deploys of J's Studio ran past it on 2026-11-02; this checks the
 * port every 10 s for up to 10 minutes. The same numbers as tools/studio-cloudrun/deploy.mjs STARTUP_PROBE.
 */
export const CELL_STARTUP_PROBE = { initialDelaySeconds: 0, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 60, tcpSocket: { port: 8080 } } as const;
const mib = (v: unknown) => { const m = /^(\d+(?:\.\d+)?)(Mi|Gi|M|G)?$/.exec(String(v ?? '')); if (!m) return 0; const n = Number(m[1]); return m[2] === 'Gi' ? n * 1024 : m[2] === 'G' ? (n * 1e9) / 1048576 : m[2] === 'M' ? (n * 1e6) / 1048576 : m[2] === 'Mi' ? n : n / 1048576; };
const cpus = (v: unknown) => { const m = /^(\d+(?:\.\d+)?)(m)?$/.exec(String(v ?? '')); if (!m) return 0; return m[2] ? Number(m[1]) / 1000 : Number(m[1]); };
/** A container's limits with at least a cell's CPU and memory (never lowered; anything else kept). */
export function withCellLimits(limits: Record<string, string> | undefined): Record<string, string> {
  const l = { ...(limits ?? {}) };
  if (mib(l.memory) < mib(CELL_LIMITS.memory)) l.memory = CELL_LIMITS.memory;
  if (cpus(l.cpu) < cpus(CELL_LIMITS.cpu)) l.cpu = CELL_LIMITS.cpu;
  return l;
}

/**
 * Studio's working disk: product clones, agents' worktrees, dependency installs, temp files and the npm cache. Without it
 * they live on Cloud Run's in-memory filesystem and count against the 4 GiB limit: after a restart the disk filled
 * memory within about an hour and the memory gate held half the agents (2026-11-10, 5.7 idle slot-hours that day).
 * A Cloud Run ephemeral disk (gen2, Preview: the service carries launchStage BETA) is real disk, wiped when the instance
 * ends, which is all this needs (clones and worktrees are made again on demand). The entrypoint moves STUDIO_PROJECTS,
 * TMPDIR and the npm cache onto it when it is mounted. 10 GiB is the default per-instance allowance.
 */
export const CELL_DISK = { name: 'studio-work', mountPath: '/disk', sizeLimit: '10Gi' } as const;
export const cellDiskVolume = () => ({ name: CELL_DISK.name, emptyDir: { medium: 'DISK', sizeLimit: CELL_DISK.sizeLimit } });
/** A container's mounts with the working disk's (once). */
export const withDiskMount = (mounts: any[] | undefined) => [...(mounts ?? []).filter((m) => m?.name !== CELL_DISK.name && m?.mountPath !== CELL_DISK.mountPath), { name: CELL_DISK.name, mountPath: CELL_DISK.mountPath }];
/** A service's volumes with the working disk's (once). */
export const withDiskVolume = (volumes: any[] | undefined) => [...(volumes ?? []).filter((v) => v?.name !== CELL_DISK.name), cellDiskVolume()];
/**
 * When Google refuses the disk: the same mount, in memory, with a size limit. Without any volume the working files went
 * to the instance's unbounded in-memory filesystem: on 2026-11-10 23:29-23:38 they held 3 GB of J's 3.9 GB, memory
 * free sat at 0-12 MB, and the kernel's reclaim froze the whole process for up to 105 s at a time (the event loop
 * "blocked" with almost nothing on the profile), long enough that claude.ai's connector timed out and signed out. A
 * sized in-memory volume makes a write past the limit fail with ENOSPC (infra-failure.ts: an infra failure, retried,
 * no start used) instead of starving Studio: 4 GiB less 2560 MiB leaves about 1.5 GiB for Studio, Litestream and a pass.
 */
export const CELL_MEMORY_DISK = { sizeLimit: '2560Mi' } as const;
export const memoryDiskVolume = () => ({ name: CELL_DISK.name, emptyDir: { medium: 'MEMORY', sizeLimit: CELL_MEMORY_DISK.sizeLimit } });
/** The working disk's volume swapped for the in-memory one (`plain`: no volume at all, the last resort). */
export function withoutDisk(body: any, plain = false) {
  const b = structuredClone(body);
  delete b.launchStage;
  if (b.template) {
    b.template.volumes = (b.template.volumes ?? []).filter((v: any) => v?.name !== CELL_DISK.name);
    if (!plain) b.template.volumes.push(memoryDiskVolume());
    if (!b.template.volumes.length) delete b.template.volumes;
    b.template.containers = (b.template.containers ?? []).map((ct: any, i: number) => {
      const m = (ct.volumeMounts ?? []).filter((x: any) => x?.name !== CELL_DISK.name);
      if (!plain && i === 0) return { ...ct, volumeMounts: withDiskMount(m) };
      const { volumeMounts: _drop, ...rest } = ct;
      return m.length ? { ...rest, volumeMounts: m } : rest;
    });
  }
  return b;
}
/** Google refused the request because of the disk (or its launch stage), not something else: try without it. */
const diskRefused = (e: any) => /\b400\b|INVALID_ARGUMENT|launch.?stage|emptyDir|ephemeral|volume|quota/i.test(String(e?.message ?? e));

/** The service body for a cell (Cloud Run Admin API v2 Service). */
export function cellService(org: string, owner: { sub: string; email: string }, image: string, c = cellsConfig(), gen?: CellGen) {
  return {
    labels: { 'hawkes-studio-cell': '1', 'hawkes-org': org, 'hawkes-lane': c.lane },
    ingress: 'INGRESS_TRAFFIC_ALL',
    launchStage: 'BETA',
    template: {
      labels: { 'hawkes-studio-cell': '1', 'hawkes-org': org },
      // Its own account when isolated (cellAccount below), else the shared studio-cells@.
      serviceAccount: cellAccount(org, c),
      scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
      timeout: '3600s',
      executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2',
      maxInstanceRequestConcurrency: 80,
      containers: [{
        image,
        env: Object.entries(cellEnv(org, owner, c, gen)).map(([name, value]) => ({ name, value })),
        resources: { limits: { ...CELL_LIMITS }, cpuIdle: false },
        startupProbe: CELL_STARTUP_PROBE,
        volumeMounts: withDiskMount(undefined),
      }],
      volumes: [cellDiskVolume()],
    },
  };
}

function needConfig(c: CellsConfig, o: { dry?: boolean }) {
  const miss = missingConfig(c);
  if (miss.length && !dryRun(o)) throw new StudioError(`Customers' Studios aren't set up here (missing: ${miss.join(', ')}; docs/studio-customers.md "One-time setup").`, 503);
}

/** The cell's service, or null when there is none (never made, or hibernated). */
export async function getCell(org: string, o: { dry?: boolean } = {}, c = cellsConfig()) {
  if (dryRun(o)) return null;
  return gapi(`${base(c)}/services/${serviceName(org, c)}`, { missingOk: true });
}

/** Makes the cell's service from `image` (and lets anyone reach it: the cell's own sign-in guards it, as Studio's does). */
export async function createCell(org: string, owner: { sub: string; email: string }, image: string, o: { dry?: boolean } = {}, c = cellsConfig(), gen?: CellGen) {
  needConfig(c, o);
  const name = serviceName(org, c);
  // A 409: it exists already (another wake made it) or is still being deleted after hibernation: wait and try again,
  // up to a minute, instead of failing the wake (2026-10-31 review).
  let op: any = null;
  for (let i = 0; ; i++) {
    try { op = await call('POST', `${base(c)}/services?serviceId=${name}`, cellService(org, owner, image, c, gen), o); break; }
    catch (e: any) {
      if (!/409/.test(String(e?.message ?? e)) && diskRefused(e)) {
        console.warn(`[cells] ${name}: Cloud Run refused the working disk (${String(e?.message ?? e).slice(0, 300)}); made on the in-memory one`);
        try { op = await call('POST', `${base(c)}/services?serviceId=${name}`, withoutDisk(cellService(org, owner, image, c, gen)), o); }
        catch (e2: any) {
          if (!diskRefused(e2)) throw e2;
          op = await call('POST', `${base(c)}/services?serviceId=${name}`, withoutDisk(cellService(org, owner, image, c, gen), true), o);
        }
        break;
      }
      if (!/409/.test(String(e?.message ?? e)) || i >= 6) throw e;
      if (await getCell(org, o, c).catch(() => null)) break;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  await call('POST', `${base(c)}/services/${name}:setIamPolicy`, { policy: { bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] } }, o);
  return { service: name, url: serviceUrl(org, c), operation: op?.name ?? null, dry: dryRun(o) };
}

/**
 * A cell's CPU and memory up to CELL_LIMITS now, on the image it already runs (a new revision; nothing else changes).
 * Nothing when it's there already.
 */
export async function sizeCell(org: string, o: { dry?: boolean } = {}, c = cellsConfig()) {
  const url = `${base(c)}/services/${serviceName(org, c)}`;
  const s = dryRun(o) ? { template: { containers: [{}] } } : await gapi(url);
  const ct = s.template?.containers?.[0] ?? {};
  const was = ct.resources?.limits;
  const limits = withCellLimits(was);
  if (!dryRun(o) && limits.memory === was?.memory && limits.cpu === was?.cpu) return { service: serviceName(org, c), cpu: limits.cpu, memory: limits.memory, changed: false };
  const containers = (s.template?.containers ?? [{}]).map((x: any, i: number) => (i === 0 ? { ...x, resources: { ...(x.resources ?? {}), limits } } : x));
  await call('PATCH', `${url}?updateMask=template.containers`, { template: { containers } }, o);
  return { service: serviceName(org, c), cpu: limits.cpu, memory: limits.memory, changed: true };
}

/** Deletes the service; the data stays in the bucket (hibernation). */
export async function deleteCell(org: string, o: { dry?: boolean } = {}, c = cellsConfig()) {
  needConfig(c, o);
  await call('DELETE', `${base(c)}/services/${serviceName(org, c)}`, undefined, { ...o, missingOk: true });
  return { service: serviceName(org, c), dry: dryRun(o) };
}

/** Every awake cell of this lane (by label), with its image. */
export async function listCells(o: { dry?: boolean } = {}, c = cellsConfig()): Promise<{ org: string; service: string; image: string }[]> {
  if (dryRun(o)) return [];
  const out: { org: string; service: string; image: string }[] = [];
  let page = '';
  do {
    const j = await gapi(`${base(c)}/services?pageSize=500${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
    for (const s of j.services ?? []) {
      if (s.labels?.['hawkes-studio-cell'] !== '1' || (s.labels?.['hawkes-lane'] ?? 'live') !== c.lane) continue;
      out.push({ org: s.labels['hawkes-org'], service: String(s.name).split('/').pop()!, image: s.template?.containers?.[0]?.image ?? '' });
    }
    page = j.nextPageToken ?? '';
  } while (page);
  return out;
}

/** The image a service runs. */
export async function serviceImage(service: string, c = cellsConfig()): Promise<string | null> {
  const s = await gapi(`${base(c)}/services/${service}`, { missingOk: true });
  return s?.template?.containers?.[0]?.image ?? null;
}

/**
 * Puts a service on a new image (a new revision; everything else as it was, except that a cell made smaller than
 * CELL_LIMITS gets raised and every one gets CELL_STARTUP_PROBE: the roll after a deploy is what brings
 * older cells up to date).
 */
export async function setImage(service: string, image: string, o: { dry?: boolean; disk?: boolean | 'none'; retry?: number } = {}, c = cellsConfig()) {
  const url = `${base(c)}/services/${service}`;
  if (dryRun(o)) return call('PATCH', `${url}?updateMask=template.containers`, { template: { containers: [{ image }] } }, o);
  const s = await gapi(url);
  // retry: the same image again as a new revision (an unchanged template makes none); the try's number in its env does it.
  const env = (ct: any) => (o.retry ? { env: [...(ct.env ?? []).filter((v: any) => v?.name !== 'STUDIO_ROLL_TRY'), { name: 'STUDIO_ROLL_TRY', value: String(o.retry) }] } : {});
  const containers = (s.template?.containers ?? [{}]).map((ct: any, i: number) => (i === 0 ? { ...ct, image, ...env(ct), resources: { ...(ct.resources ?? {}), limits: withCellLimits(ct.resources?.limits) }, startupProbe: CELL_STARTUP_PROBE } : ct));
  // With the working disk (CELL_DISK): the roll after a deploy brings every cell onto it. Refused (a launch stage or a
  // quota Google won't take): the image alone, as before, so a deploy never fails for the disk.
  // Without the disk: the same mount in memory, sized (CELL_MEMORY_DISK), so the working files can't starve Studio;
  // 'none' (that was refused too): no volume, as before.
  const plainBody = (none = false) => {
    const t = withoutDisk({ template: { containers, volumes: s.template?.volumes ?? [] } }, none).template;
    return { template: { containers: t.containers, volumes: t.volumes ?? [] } };
  };
  // Without the disk (disk: false): the revision with it was refused after the update was taken (Google's ephemeral disk
  // quota is checked when the revision starts, not when it's asked for), so the image goes out on the in-memory one.
  if (o.disk === false || o.disk === 'none') return call('PATCH', `${url}?updateMask=template.containers,template.volumes`, plainBody(o.disk === 'none'), o);
  const withDisk = { launchStage: 'BETA', template: { containers: containers.map((ct: any, i: number) => (i === 0 ? { ...ct, volumeMounts: withDiskMount(ct.volumeMounts) } : ct)), volumes: withDiskVolume(s.template?.volumes) } };
  try {
    return await call('PATCH', `${url}?updateMask=launchStage,template.containers,template.volumes`, withDisk, o);
  } catch (e: any) {
    if (!diskRefused(e)) throw e;
    console.warn(`[cells] ${service}: Cloud Run refused the working disk (${String(e?.message ?? e).slice(0, 300)}); new image on the in-memory one`);
    try {
      return await call('PATCH', `${url}?updateMask=template.containers,template.volumes`, plainBody(), o);
    } catch (e2: any) {
      if (!diskRefused(e2)) throw e2;
      console.warn(`[cells] ${service}: Cloud Run refused the in-memory working volume too (${String(e2?.message ?? e2).slice(0, 300)}); new image with no volume`);
      return call('PATCH', `${url}?updateMask=template.containers,template.volumes`, plainBody(true), o);
    }
  }
}

/**
 * The customers' agents' job onto an image (Talk, agents and scouts of every cell run there). It used to be left on the
 * image it was made with, so a deploy reached the cells but their Talk kept old tools (2026-10-31: customer Talk had no
 * studio_project). Nothing when it's already there; a missing job is left alone (cells-setup.mjs makes it).
 */
export async function followAgentJob(image: string, o: { dry?: boolean; log?: (s: string) => void } = {}, c = cellsConfig()) {
  const url = `${base(c)}/jobs/${c.agentJob}`;
  if (dryRun(o)) return call('PATCH', url, { template: { template: { containers: [{ image }] } } }, o);
  const j = await gapi(url, { missingOk: true });
  if (!j) return { job: c.agentJob, skipped: 'no such job' };
  const containers = (j.template?.template?.containers ?? [{}]) as any[];
  if (containers[0]?.image === image) return { job: c.agentJob, image, changed: false };
  (o.log ?? console.log)(`${c.agentJob} (customers' agents) → ${image}`);
  // Jobs take no update mask in v2 (only services do): the whole job goes back with the image changed, its output-only
  // fields left out, its etag kept so a change made meanwhile isn't overwritten.
  const out = Object.fromEntries(Object.entries(j).filter(([k]) => !JOB_OUTPUT_ONLY.has(k)));
  out.template = { ...j.template, template: { ...j.template.template, containers: containers.map((ct, i) => (i === 0 ? { ...ct, image } : ct)) } };
  await call('PATCH', url, out, o);
  return { job: c.agentJob, image, changed: true };
}
const JOB_OUTPUT_ONLY = new Set(['uid', 'generation', 'createTime', 'updateTime', 'deleteTime', 'expireTime', 'creator', 'lastModifier', 'observedGeneration', 'terminalCondition', 'conditions', 'executionCount', 'latestCreatedExecution', 'reconciling', 'satisfiesPzs']);

/**
 * A rolling upgrade: J's Studio first (it is also the control plane, and the image hibernated cells wake on), then every
 * awake cell, one at a time, each checked healthy before the next. Hibernated cells aren't touched: they wake on J's
 * Studio's image. Stops at the first cell that fails, so one bad image reaches at most one customer.
 */
export async function rollImage(image: string, o: { dry?: boolean; health?: (url: string) => Promise<boolean>; log?: (s: string) => void } = {}, c = cellsConfig()) {
  if (!/^[\w.-]+(:\d+)?\/[\w./-]+(@sha256:[0-9a-f]{64}|:[\w.-]+)$/.test(image)) throw new StudioError(`Not an image reference: ${image}`);
  const log = o.log ?? ((s: string) => console.log(`[cells] ${s}`));
  const health = o.health ?? (async (url: string) => {
    for (let i = 0; i < 20; i++) {
      try { if ((await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(20_000) })).ok) return true; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 6000));
    }
    return false;
  });
  log(`${c.studioService} (J's Studio) → ${image}`);
  await setImage(c.studioService, image, o, c);
  const r = await rollCells(image, { ...o, health, log }, c);
  // The customers' agents' job only once every cell is on the image (a stopped roll leaves them all on the old one).
  if (!r.failed) await followAgentJob(image, { ...o, log }, c);
  return { ...r, done: [c.studioService, ...r.done] };
}

/**
 * The awake cells onto an image, one at a time, each checked healthy before the next; the first that isn't stops the
 * roll (the rest stay on what they had, which works). J's Studio isn't touched: it rolls them after its own deploy
 * (cells.ts followRoll). Hibernated cells wake on J's Studio's image anyway.
 */
/** Whether a service's newest revision runs `image`, is ready, and takes the traffic (waits up to ~11 minutes: the
 * startup probe allows 10). */
export async function newRevisionServes(service: string, image: string, c = cellsConfig(), waitMs = 11 * 60_000): Promise<boolean> {
  return (await newRevisionOutcome(service, image, c, waitMs)).ok;
}

/** Why a service's revision failed, in Google's words (its failed conditions), or null. */
const failureOf = (sv: any): string | null => {
  const bad = [sv?.terminalCondition, ...(sv?.conditions ?? [])].filter((x: any) => x?.state === 'CONDITION_FAILED' && x?.message);
  return bad.length ? bad.map((x: any) => String(x.message)).join(' ').slice(0, 500) : null;
};
/** The revision was refused for its working disk (Google's ephemeral disk quota, or the disk itself), not for the image. */
export const diskFailure = (why: string | null | undefined) => /ephemeral (disk|storage)|emptyDir|volume .*(disk|quota)|disk allocation/i.test(String(why ?? ''));

/** Google said the revision got no CPU (the region's Cloud Run CPU quota), not that the image failed. */
export const cpuFailure = (why: string | null | undefined) => /cpu[ _]?allocation|quota.{0,40}\bcpu\b|\bcpu\b.{0,40}quota|no available instance|insufficient (cpu|resources)/i.test(String(why ?? ''));

/** Jobs that give way to a cell's own server when the region has no CPU left for it, in this order (Unity builds first). */
export const YIELD_JOBS = (c = cellsConfig()) => [...String(process.env.STUDIO_CELLS_YIELD_JOBS ?? 'hawkes-unity-build,hawkes-unity-build-customer').split(',').map((x) => x.trim()).filter(Boolean), c.agentJob];

/**
 * Whether the region is out of CPU now: Cloud Run is holding job executions it hasn't started for want of room
 * (queued ones count for more than the running ones). A revision that timed out starting while that is so got no CPU.
 */
export async function regionShortOfCpu(c = cellsConfig()): Promise<boolean> {
  const r = await (await import('./gcp.ts')).regionJobCpu(c.project, c.region).catch(() => null);
  return Boolean(r && r.vcpu > r.running);
}

/**
 * Frees the region's CPU for a cell's own server: cancels the open executions of the yielding jobs (YIELD_JOBS, Unity
 * builds first, then the agents'). Their work isn't lost: an agent pass whose job ends with no result starts again
 * (cloudjob.ts lost), and once the cell runs again its own jobs leave its server room (cpuroom.ts).
 */
export async function yieldJobCpu(o: { dry?: boolean; log?: (s: string) => void } = {}, c = cellsConfig()): Promise<string[]> {
  const log = o.log ?? ((s: string) => console.log(`[cells] ${s}`));
  const G = await import('./gcp.ts');
  const names = ((await gapi(`${base(c)}/jobs?pageSize=500`).catch(() => null))?.jobs ?? []).map((j: any) => String(j.name).split('/').pop()!);
  const out: string[] = [];
  for (const want of YIELD_JOBS(c)) {
    for (const job of names.filter((n: string) => n === want)) {
      const open = await G.listOpenExecutions({ project: c.project, region: c.region, job }).catch(() => []);
      for (const e of open) {
        if (dryRun(o)) planned.push({ method: 'POST', url: `https://run.googleapis.com/v2/${e.name}:cancel`, body: {} });
        else await G.cancelExecution(e.name);
        out.push(e.name);
      }
      if (open.length) log(`${job}: cancelled ${open.length} open execution${open.length === 1 ? '' : 's'} to give the cell's server CPU`);
    }
  }
  return out;
}

/** newRevisionServes with Google's reason when it doesn't. */
export async function newRevisionOutcome(service: string, image: string, c = cellsConfig(), waitMs = 11 * 60_000): Promise<{ ok: boolean; why: string | null }> {
  const end = Date.now() + waitMs;
  let why: string | null = null;
  while (Date.now() < end) {
    const sv = await gapi(`${base(c)}/services/${service}`, { missingOk: true }).catch(() => null);
    const created = sv?.latestCreatedRevision, ready = sv?.latestReadyRevision;
    const failed = (sv?.conditions ?? []).some((x: any) => x.type === 'RoutesReady' && x.state === 'CONDITION_FAILED') || sv?.terminalCondition?.state === 'CONDITION_FAILED';
    if (sv?.template?.containers?.[0]?.image === image && created && created === ready && !sv?.reconciling) {
      const tr = (sv.trafficStatuses ?? sv.traffic_statuses ?? []) as any[];
      if (!tr.length || tr.some((t) => (t.percent ?? 0) === 100 && (t.type === 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST' || String(t.revision ?? '').endsWith(String(ready).split('/').pop()!)))) return { ok: true, why: null };
    }
    why = failureOf(sv) ?? why;
    if (failed && !sv?.reconciling) return { ok: false, why };
    await new Promise((r) => setTimeout(r, Math.min(5000, Math.max(0, end - Date.now()))));
  }
  return { ok: false, why: why ?? 'the new revision wasn\'t serving in time' };
}

export async function rollCells(image: string, o: { dry?: boolean; health?: (url: string) => Promise<boolean>; log?: (s: string) => void; outcome?: typeof newRevisionOutcome; shortOfCpu?: typeof regionShortOfCpu; yieldCpu?: typeof yieldJobCpu } = {}, c = cellsConfig()) {
  const log = o.log ?? ((s: string) => console.log(`[cells] ${s}`));
  const health = o.health ?? (async (url: string) => {
    for (let i = 0; i < 20; i++) {
      try { if ((await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(20_000) })).ok) return true; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 6000));
    }
    return false;
  });
  const done: string[] = [];
  const cells = await listCells(o, c);
  for (const cell of cells) {
    if (cell.image === image) continue;
    log(`${cell.service} → ${image}`);
    await setImage(cell.service, image, o, c);
    // Healthy means the NEW revision is ready and serving, then answering: the old one answers /api/health until it's
    // replaced, so a bad image used to pass every cell (2026-10-31 review). A cell that fails goes back to its image.
    let out = dryRun(o) ? { ok: true, why: null } : await (o.outcome ?? newRevisionOutcome)(cell.service, image, c);
    let disk: boolean | 'none' = true;
    // Refused for its working disk, not its image (2026-11-10 22:41: "Quota exceeded for total allowable ephemeral disk
    // allocation per project per region", and every fix on main stayed off J's Studio): the same image without the disk.
    // The next roll asks for the disk again, so the cell gets it back once Google allows it.
    if (!out.ok && diskFailure(out.why)) {
      log(`${cell.service}: Google refused the new revision's working disk (${String(out.why).slice(0, 200)}); the new image without it`);
      disk = false;
      await setImage(cell.service, image, { ...o, disk: false }, c);
      out = await (o.outcome ?? newRevisionOutcome)(cell.service, image, c);
      // The sized in-memory volume refused too (never seen; it needs no quota): the image with no volume at all.
      if (!out.ok && diskFailure(out.why)) {
        log(`${cell.service}: the in-memory working volume was refused too (${String(out.why).slice(0, 200)}); the new image with no volume`);
        disk = 'none';
        await setImage(cell.service, image, { ...o, disk: 'none' }, c);
        out = await (o.outcome ?? newRevisionOutcome)(cell.service, image, c);
      }
    }
    // No CPU for the new revision (2026-11-11 00:07: 00098 never got an instance while ~26 Unity build and agent job
    // executions held us-east4's CPU quota; the roll went back and the old revision lost its instance too, so the site
    // went down). The roll itself frees the room: the jobs give way (Unity builds first, then agent passes) and the
    // same image is tried once more. The new cell's own jobs then leave its server room (cpuroom.ts).
    if (!dryRun(o) && !out.ok && !diskFailure(out.why) && (cpuFailure(out.why) || (await (o.shortOfCpu ?? regionShortOfCpu)(c).catch(() => false)))) {
      log(`${cell.service}: the new revision got no CPU in ${c.region}${out.why ? ` (${String(out.why).slice(0, 200)})` : ''}; jobs give way and the roll tries again`);
      await (o.yieldCpu ?? yieldJobCpu)({ ...o, log }, c).catch((e: any) => log(`${cell.service}: couldn't stop the jobs (${e.message})`));
      await setImage(cell.service, image, { ...o, ...(disk === true ? {} : { disk }), retry: Date.now() }, c);
      out = await (o.outcome ?? newRevisionOutcome)(cell.service, image, c);
    }
    if (!dryRun(o) && !(out.ok && (await health(serviceUrl(cell.org, c))))) {
      log(`${cell.service} is not healthy on the new image${out.why ? ` (${String(out.why).slice(0, 200)})` : ''}: back to ${cell.image.split(':').pop()}, and the roll stops here (${cells.length - done.length - 1} left on the old one)`);
      await setImage(cell.service, cell.image, { ...o, disk }, c).catch((e) => log(`${cell.service}: couldn't put it back (${e.message})`));
      return { image, done, failed: cell.service, left: cells.filter((x) => !done.includes(x.service) && x.service !== cell.service).map((x) => x.service) };
    }
    done.push(cell.service);
  }
  return { image, done, failed: null as string | null, left: [] as string[] };
}

// ------------------------------------------------------------------ one identity per cell (isolation)
// docs/studio-customers.md "Isolation". With STUDIO_CELLS_ISOLATE=1 every cell runs as its own service account,
// cell-<b|l>-<hash>@ (from the org id: service account ids are 6-30 characters), which can reach only its own data:
//   - a managed folder o/<org>/ in the cells' bucket, with objectAdmin for that account alone (the folder's own IAM
//     policy: no bucket-wide grant, no per-cell condition piling up on the bucket's policy)
//   - running the shared agents' job (jobsExecutorWithOverrides and run.viewer on that job), whose runs reach their
//     own folder through the broker only (jobbroker.ts)
// The account is made with the cell and deleted with its data (cells.ts). Without STUDIO_CELLS_ISOLATE cells run as
// the shared studio-cells@, as before (until J has run the setup's isolation step). Quota: 100 service accounts per
// project by default (a raise is a request to Google, free): beta and live cells share hawkes-staging's.


export const isolated = () => process.env.STUDIO_CELLS_ISOLATE === '1';
export const cellSaId = (org: string, c = cellsConfig()) => `cell-${c.lane === 'beta' ? 'b' : 'l'}-${crypto.createHash('sha256').update(org).digest('hex').slice(0, 20)}`;
export const cellSaEmail = (org: string, c = cellsConfig()) => `${cellSaId(org, c)}@${c.project}.iam.gserviceaccount.com`;
/** The account a cell runs as: its own when isolated, else the shared one. */
export const cellAccount = (org: string, c = cellsConfig()) => (isolated() ? cellSaEmail(org, c) : c.serviceAccount);
export const cellFolder = (org: string) => `o/${org}/`;

const iamBase = (c: CellsConfig) => `https://iam.googleapis.com/v1/projects/${c.project}/serviceAccounts`;
const folderUrl = (org: string, c: CellsConfig) => `https://storage.googleapis.com/storage/v1/b/${c.bucket}/managedFolders/${encodeURIComponent(cellFolder(org))}`;
const JOB_ROLES = ['roles/run.jobsExecutorWithOverrides', 'roles/run.viewer'];

/** 409 (already there) is fine when making something idempotently. */
async function made(method: string, url: string, body: unknown, o: { dry?: boolean }) {
  try { return await call(method, url, body, o); } catch (e: any) { if (/answered 409/.test(String(e.message))) return { exists: true }; throw e; }
}

/** Adds (or removes) a member to the given roles of the shared agents' job's IAM policy (read, change, write). */
async function jobMember(member: string, add: boolean, o: { dry?: boolean }, c: CellsConfig) {
  const url = `${base(c)}/jobs/${c.agentJob}`;
  if (dryRun(o)) { planned.push({ method: 'POST', url: `${url}:setIamPolicy`, body: { [add ? 'add' : 'remove']: member, roles: JOB_ROLES } }); return; }
  const policy = (await gapi(`${url}:getIamPolicy`)) ?? {};
  const bindings: { role: string; members: string[] }[] = policy.bindings ?? [];
  for (const role of JOB_ROLES) {
    let b = bindings.find((x) => x.role === role && !(x as any).condition);
    if (!b && add) bindings.push((b = { role, members: [] }));
    if (!b) continue;
    b.members = add ? [...new Set([...b.members, member])] : b.members.filter((m) => m !== member);
  }
  await gapi(`${url}:setIamPolicy`, { body: { policy: { ...policy, bindings: bindings.filter((b) => b.members.length) } } });
}

/**
 * A grant naming an account made moments ago: Google's IAM takes up to a minute or so to know it, and answers 400
 * "Service account ... does not exist" until then (seen on beta, 2026-10-29). Tries again for about 90 seconds.
 */
export async function whenAccountKnown<T>(fn: () => Promise<T>, o: { waits?: number[] } = {}): Promise<T> {
  const waits = o.waits ?? [2000, 4000, 8000, 15000, 30000, 30000];
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e: any) {
      if (i >= waits.length || !/does not exist/i.test(String(e?.message))) throw e;
      await new Promise((r) => setTimeout(r, waits[i]));
    }
  }
}

/** The cell's own service account and its grants: its folder, the agents' job. Idempotent. */
export async function ensureCellIdentity(org: string, o: { dry?: boolean } = {}, c = cellsConfig()) {
  const email = cellSaEmail(org, c);
  await made('POST', iamBase(c), { accountId: cellSaId(org, c), serviceAccount: { displayName: `Hawkes Studio cell ${org}`.slice(0, 100), description: `Customer Studio ${org} (${c.lane}): only ${cellFolder(org)} in ${c.bucket}` } }, o);
  await made('POST', `https://storage.googleapis.com/storage/v1/b/${c.bucket}/managedFolders`, { name: cellFolder(org) }, o);
  // The folder's whole policy: this cell's account alone (setting it whole also drops anyone else put there).
  await whenAccountKnown(() => call('PUT', `${folderUrl(org, c)}/iam`, { bindings: [{ role: 'roles/storage.objectAdmin', members: [`serviceAccount:${email}`] }] }, o));
  await whenAccountKnown(() => jobMember(`serviceAccount:${email}`, true, o, c));
  return { email, folder: cellFolder(org) };
}

/** Undoes ensureCellIdentity (the data is deleted): the job grant, the folder (empty by now), the account. */
export async function removeCellIdentity(org: string, o: { dry?: boolean } = {}, c = cellsConfig()) {
  const email = cellSaEmail(org, c);
  await jobMember(`serviceAccount:${email}`, false, o, c).catch((e) => console.warn(`[cells] ${org}: job grant: ${e.message}`));
  await call('DELETE', folderUrl(org, c), undefined, { ...o, missingOk: true }).catch((e) => console.warn(`[cells] ${org}: folder: ${e.message}`));
  await call('DELETE', `${iamBase(c)}/${email}`, undefined, { ...o, missingOk: true });
  return { email };
}

/** Moves a running cell onto its own account (a new revision; everything else as it was). */
export async function setCellAccount(org: string, email: string, o: { dry?: boolean } = {}, c = cellsConfig()) {
  return call('PATCH', `${base(c)}/services/${serviceName(org, c)}?updateMask=template.serviceAccount`, { template: { serviceAccount: email } }, o);
}
