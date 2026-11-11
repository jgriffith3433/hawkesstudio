// A Google quota a part of Studio needs and can't raise itself becomes one Approve card in the owner's Inbox (J,
// 2026-11-10, through the coordinator: "a quota a part needs and can't raise itself becomes one approval card", "Jaycee
// taps it, and nobody runs a workflow by hand"). Two parts ask today:
//   - the cell's working disk (cellrun.ts CELL_DISK): Google refused the revision with "Quota exceeded for total
//     allowable ephemeral disk allocation per project per region", so the cell runs without it, in memory (index.ts at
//     start: a cell not on a real disk asks);
//   - Cloud Run CPU: an agent job Cloud Run never started for want of room (cloudjob.ts JOB_START_MS) asks.
// Every ask for the same project and region is one card (each quota once, the larger value). Tapping Approve files a
// quota preference with Google: through the Cloud Quotas API as Studio's own account when it may, else by starting the
// ops-admin workflow (apply) on Studio's repo, which runs as ops-admin@ with roles/cloudquotas.admin. The card never
// approves itself in walk-away mode (approvals.ts walkAwayHold): it is the owner's.

export type QuotaKind = 'cpu' | 'disk';
export type QuotaAsk = { kind: QuotaKind; region: string; value: number; why: string };

type QuotaInfo = { quotaId?: string; displayName?: string; unit?: string; dimensionsInfos?: { dimensions?: Record<string, string>; details?: { value?: string | number } }[] };

export const QUOTAS: Record<QuotaKind, { label: string; unit: string; action: string; target: number; match: (q: QuotaInfo) => boolean; cost: string }> = {
  cpu: {
    label: 'Cloud Run CPU', unit: 'vCPU', action: 'run-cpu-quota', target: 100,
    match: (q) => /CPU allocation, per project per region/i.test(q.displayName ?? '') || /^CpuAllocPerProjectRegion$/.test(q.quotaId ?? ''),
    cost: 'only CPU actually used is billed',
  },
  disk: {
    label: 'Cloud Run ephemeral disk', unit: 'GiB', action: 'run-disk-quota', target: 100,
    match: (q) => /ephemeral/i.test(`${q.displayName ?? ''} ${q.quotaId ?? ''}`),
    cost: 'only disk that running instances use is billed (each cell asks for 10 GiB)',
  },
};

export const project = () => process.env.STUDIO_CELLS_PROJECT || process.env.STUDIO_GCP_PROJECT || 'hawkes-staging';
export const region = () => process.env.STUDIO_CELLS_REGION || process.env.STUDIO_GCP_REGION || 'us-east4';
/** The repo whose ops-admin workflow files the request when Studio's own account may not. */
export const opsRepo = () => process.env.STUDIO_OPS_REPO || 'jgriffith3433/hawkesstudio';

const QI = (p: string) => `https://cloudquotas.googleapis.com/v1/projects/${p}/locations/global/services/run.googleapis.com/quotaInfos?pageSize=500`;

/** The tests' stand-in for Google's quota list and Studio's ways of filing a request. */
export const quotaHooks: { list?: () => Promise<QuotaInfo[] | null>; file?: (a: QuotaAsk, info: { quotaId: string; unit: string; raw: number } | null) => Promise<string>; dispatch?: (a: QuotaAsk) => Promise<string> } = {};

async function quotaInfos(): Promise<QuotaInfo[] | null> {
  if (quotaHooks.list) return quotaHooks.list();
  try {
    const { gapi } = await import('./gcp.ts');
    const j = await gapi(QI(project()), { timeoutMs: 20_000 });
    return (j?.quotaInfos ?? []) as QuotaInfo[];
  } catch { return null; }
}

/** How many of Google's units make one card unit (vCPU, GiB): Google gives CPU in milli-vCPU and disk in bytes or MiB. */
function perUnit(kind: QuotaKind, raw: number, unit: string): number {
  if (kind === 'cpu') return /milli/i.test(unit) || raw >= 10_000 ? 1000 : 1;
  if (/^(GiB|GB)|gibibyte|gigabyte/i.test(unit)) return 1;
  if (/^(MiB|MB)|mebibyte|megabyte/i.test(unit)) return 1024;
  if (/^By\b|byte/i.test(unit)) return 1024 ** 3;
  // No unit Studio knows: no project gets a petabyte, so a big number is bytes.
  return raw >= 1024 ** 3 ? 1024 ** 3 : raw >= 1024 * 1024 ? 1024 : 1;
}
/** A quota's value in its card unit (vCPU, GiB) from Google's. */
export const inUnit = (kind: QuotaKind, raw: number, unit = '') => raw / perUnit(kind, raw, unit);
/** The other way, for the request (unit and the current raw value say which Google unit). */
export const toUnit = (kind: QuotaKind, value: number, unit = '', raw = 0) => value * perUnit(kind, raw, unit);

/** The quota as Google has it now in that region, or null when Studio may not read it. */
export async function quotaNow(kind: QuotaKind, at = region()): Promise<{ value: number; raw: number; quotaId: string; unit: string } | null> {
  const all = await quotaInfos();
  const q = all?.find(QUOTAS[kind].match);
  if (!q?.quotaId) return null;
  const d = (q.dimensionsInfos ?? []).find((x) => (x.dimensions?.region ?? '') === at) ?? (q.dimensionsInfos ?? []).find((x) => !x.dimensions?.region);
  const raw = Number(d?.details?.value);
  return Number.isFinite(raw) ? { value: inUnit(kind, raw, q.unit), raw, quotaId: q.quotaId, unit: q.unit ?? '' } : null;
}

/**
 * One card for these asks (merged into the pending quota card for the same project and region). Never throws: a part
 * that needs a quota carries on as it can, and the card is how it gets it.
 */
export async function askForQuota(asks: QuotaAsk[], by = 'Studio') {
  try {
    const { requestApproval, listApprovals } = await import('./approvals.ts');
    // Only what Google doesn't already give: a quota at or past the ask needs no card.
    const need: QuotaAsk[] = [];
    for (const a of asks) { const now = await quotaNow(a.kind, a.region).catch(() => null); if (!now || now.value < a.value) need.push(a); }
    if (!need.length) return null;
    asks = need;
    const target = `${project()}:${asks[0]?.region ?? region()}`;
    const open = listApprovals({ pending: true }).find((a: any) => a.kind === 'quota' && a.target === target);
    const merged = new Map<QuotaKind, QuotaAsk>();
    for (const a of [...((open?.params?.asks ?? []) as QuotaAsk[]), ...asks]) {
      const was = merged.get(a.kind);
      merged.set(a.kind, was ? { ...was, value: Math.max(was.value, a.value), why: was.why === a.why ? was.why : `${was.why}; ${a.why}`.slice(0, 400) } : { ...a });
    }
    return await requestApproval('quota', target, { asks: [...merged.values()] }, { by });
  } catch (e: any) {
    console.warn(`[quota] couldn't put up the quota card: ${e?.message ?? e}`);
    return null;
  }
}

/** The card's lines: each quota now (when Studio may read it) and what is asked, why, and what it costs. */
export async function describeQuota(asks: QuotaAsk[]) {
  const lines: string[] = [];
  for (const a of asks) {
    const q = QUOTAS[a.kind];
    const now = await quotaNow(a.kind, a.region).catch(() => null);
    lines.push(`${q.label} in ${a.region}: ${now ? `${Math.round(now.value * 10) / 10}` : 'current value not readable by Studio'} → ${a.value} ${q.unit}. Why: ${a.why}. Cost: asking is free; ${q.cost}.`);
  }
  return lines;
}

/** Files one ask with Google: the Cloud Quotas API as Studio's own account, else the ops-admin workflow (apply). */
export async function raiseQuota(a: QuotaAsk): Promise<string> {
  const now = await quotaNow(a.kind, a.region).catch(() => null);
  const direct = quotaHooks.file ?? (async (x: QuotaAsk, info: { quotaId: string; unit: string; raw: number } | null) => {
    if (!info) throw new Error('quota not readable');
    const { gapi } = await import('./gcp.ts');
    // The same preference ops-admin files (run-cpu-<region>, run-disk-<region>): one request per quota and region.
    const id = `run-${x.kind}-${x.region}`;
    const body = { service: 'run.googleapis.com', quotaId: info.quotaId, quotaConfig: { preferredValue: String(Math.round(toUnit(x.kind, x.value, info.unit, info.raw))) }, dimensions: { region: x.region }, justification: `Hawkes Studio: ${x.why}`.slice(0, 500) };
    const base = `https://cloudquotas.googleapis.com/v1/projects/${project()}/locations/global/quotaPreferences`;
    await gapi(`${base}/${id}?allowMissing=true&updateMask=quotaConfig.preferredValue,justification`, { method: 'PATCH', body: { ...body, name: `projects/${project()}/locations/global/quotaPreferences/${id}` }, timeoutMs: 30_000 });
    return `asked Google for ${x.value} ${QUOTAS[x.kind].unit} of ${QUOTAS[x.kind].label} in ${x.region} (quota preference ${id})`;
  });
  try { return await direct(a, now ? { quotaId: now.quotaId, unit: now.unit, raw: now.raw } : null); } catch (e: any) {
    const dispatch = quotaHooks.dispatch ?? (async (x: QuotaAsk) => {
      const token = (await (await import('./ghtoken.ts')).repoToken(opsRepo()).catch(() => null)) ?? process.env.GITHUB_TOKEN;
      if (!token) throw new Error(`no GitHub token for ${opsRepo()}`);
      const r = await fetch(`https://api.github.com/repos/${opsRepo()}/actions/workflows/ops-admin.yml/dispatches`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'hawkes-studio', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'main', inputs: { action: QUOTAS[x.kind].action, apply: 'true', project: project(), region: x.region, value: String(x.value) } }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) throw new Error(`GitHub answered ${r.status} starting ops-admin: ${(await r.text()).slice(0, 200)}`);
      return `started ops-admin ${QUOTAS[x.kind].action} (apply) for ${x.value} ${QUOTAS[x.kind].unit} in ${x.region}`;
    });
    return `${await dispatch(a)} (Studio's own account couldn't file it: ${String(e?.message ?? e).slice(0, 120)})`;
  }
}

let diskAsked = false;
/**
 * A cell running without its working disk (Google refused it, cellrun.ts rollCells) asks for the disk quota, once per
 * start. Only on Cloud Run, only in a cell.
 */
export async function askDiskIfMissing(onDisk: boolean) {
  if (diskAsked || onDisk || !process.env.K_SERVICE || !process.env.STUDIO_ORG) return null;
  diskAsked = true;
  return askForQuota([{ kind: 'disk', region: region(), value: QUOTAS.disk.target, why: 'this Studio runs without its 10 GiB working disk because Google refused it for the project\'s ephemeral disk quota, so its working files fill memory and hold agents back' }]);
}

/** The region in a Cloud Run execution's name (projects/p/locations/<region>/jobs/j/executions/e), or null. */
export const executionRegion = (name?: string | null) => /\/locations\/([a-z0-9-]+)\//.exec(String(name ?? ''))?.[1] ?? null;

let cpuAskedAt = 0;
/** An agent job Cloud Run never started for want of room: ask for more CPU (at most once an hour; the card merges). */
export async function askCpuForJobs(minutes: number, said?: string | null, execution?: string | null) {
  if (Date.now() - cpuAskedAt < 60 * 60_000) return null;
  cpuAskedAt = Date.now();
  // The region the job waited in: its execution's own, else where starts land now (jobsproject.ts startPlace). Not the
  // configured jobs' region: on 2026-11-11 that region refused the jobs, they waited beside the server in us-east4, and
  // the card asked for us-east1, a region the project can't use.
  const where = executionRegion(execution) ?? (await import('./jobsproject.ts')).startPlace().region;
  return askForQuota([{ kind: 'cpu', region: where, value: QUOTAS.cpu.target, why: `an agent job waited ${minutes} min and Cloud Run never started it${said ? ` (Cloud Run: ${String(said).slice(0, 140)})` : ''}; the region's CPU quota is shared by agent jobs, builds and Gen` }]);
}
