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
  publicUrl: string; controlUrl: string; genUrl: string; googleClientId: string; lane: 'live' | 'beta'; studioService: string;
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
    genUrl: env.HAWKESGEN_URL || '',
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
    ...(c.genUrl ? { HAWKESGEN_URL: c.genUrl, GEN_PUBLIC_URL: c.genUrl } : {}),
    // Its own Gen key (cells.ts ensureGenKey): role user, only its Gen org's projects; its jobs run as org_<hex>.<game>.
    ...(gen ? { HAWKESGEN_KEY: gen.key, AGENT_GEN_KEY: gen.key, HAWKESGEN_PROJECT_PREFIX: `${gen.genOrg}.` } : {}),
    ...(c.googleClientId ? { STUDIO_GOOGLE_CLIENT_ID: c.googleClientId } : {}),
    ...cellKeyEnv(org),
  };
}

/** The service body for a cell (Cloud Run Admin API v2 Service). */
export function cellService(org: string, owner: { sub: string; email: string }, image: string, c = cellsConfig(), gen?: CellGen) {
  return {
    labels: { 'hawkes-studio-cell': '1', 'hawkes-org': org, 'hawkes-lane': c.lane },
    ingress: 'INGRESS_TRAFFIC_ALL',
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
        resources: { limits: { cpu: '1', memory: '2Gi' }, cpuIdle: false },
      }],
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
  const op = await call('POST', `${base(c)}/services?serviceId=${name}`, cellService(org, owner, image, c, gen), o);
  await call('POST', `${base(c)}/services/${name}:setIamPolicy`, { policy: { bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] } }, o);
  return { service: name, url: serviceUrl(org, c), operation: op?.name ?? null, dry: dryRun(o) };
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

/** Puts a service on a new image (a new revision; everything else as it was). */
export async function setImage(service: string, image: string, o: { dry?: boolean } = {}, c = cellsConfig()) {
  const url = `${base(c)}/services/${service}`;
  if (dryRun(o)) return call('PATCH', `${url}?updateMask=template.containers`, { template: { containers: [{ image }] } }, o);
  const s = await gapi(url);
  const containers = (s.template?.containers ?? [{}]).map((ct: any, i: number) => (i === 0 ? { ...ct, image } : ct));
  return call('PATCH', `${url}?updateMask=template.containers`, { template: { containers } }, o);
}

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
  return { ...r, done: [c.studioService, ...r.done] };
}

/**
 * The awake cells onto an image, one at a time, each checked healthy before the next; the first that isn't stops the
 * roll (the rest stay on what they had, which works). J's Studio isn't touched: it rolls them after its own deploy
 * (cells.ts followRoll). Hibernated cells wake on J's Studio's image anyway.
 */
export async function rollCells(image: string, o: { dry?: boolean; health?: (url: string) => Promise<boolean>; log?: (s: string) => void } = {}, c = cellsConfig()) {
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
    if (!dryRun(o) && !(await health(serviceUrl(cell.org, c)))) {
      log(`${cell.service} is not healthy on the new image: the roll stops here (${cells.length - done.length} left on the old one)`);
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
