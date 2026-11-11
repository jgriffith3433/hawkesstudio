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
//
// One card per ask, ever (J, 2026-11-11: "This keeps showing up in my inbox over and over"). Each ask's answer is kept
// in quota_asks, not in memory: a cell asked again on every restart, and an ask only merged into a card still pending,
// so every restart after J's Approve put up a new card, and Studio never learned that both of his Approves had died in
// the ops-admin run (a gcloud prompt, then a field name). Now:
//   - after Approve the ask is "filing", then "filed" (Google is deciding): nothing asks again while it is;
//   - ops-admin reports every run back (POST /api/hooks/quota, GitHub's OIDC token): filed with Google's state, or the
//     real error, which reopens the same card (Approve tries again) instead of a silent new one;
//   - after Deny, or once Google refused that much, the same value is never asked again; a bigger one may be;
//   - Google's answer arrives on the next event that would have asked (a cell start, a job that waited): Studio starts a
//     read-only ops-admin run for a filed ask then, at most every few hours. No watcher, no timer.

import { db } from './db.ts';

export type QuotaKind = 'cpu' | 'disk';
export type QuotaAsk = { kind: QuotaKind; region: string; value: number; why: string };

/**
 * Google's QuotaInfo (Cloud Quotas API v1). Its fields are quotaDisplayName and metricUnit: displayName and unit were
 * never there, so every unit read as '' (ops-admin run 20, 2026-11-11: "unexpected unit ''" and nothing was filed).
 */
type QuotaInfo = { quotaId?: string; quotaDisplayName?: string; metricDisplayName?: string; metricUnit?: string; displayName?: string; unit?: string; dimensionsInfos?: { dimensions?: Record<string, string>; details?: { value?: string | number } }[] };
const qName = (q: QuotaInfo) => `${q.quotaDisplayName ?? ''} ${q.metricDisplayName ?? ''} ${q.displayName ?? ''}`;
const qUnit = (q: QuotaInfo) => q.metricUnit ?? q.unit ?? '';

export const QUOTAS: Record<QuotaKind, { label: string; unit: string; action: string; target: number; match: (q: QuotaInfo) => boolean; cost: string }> = {
  cpu: {
    label: 'Cloud Run CPU', unit: 'vCPU', action: 'run-cpu-quota', target: 100,
    match: (q) => /CPU allocation, per project per region/i.test(qName(q)) || /^CpuAllocPerProjectRegion$/.test(q.quotaId ?? ''),
    cost: 'only CPU actually used is billed',
  },
  disk: {
    // What the cells use: 10 GiB each (cellrun.ts CELL_DISK, max one instance), the live and the beta cell, each twice
    // while a roll runs both revisions: 40. 50 leaves room. Asked 100 before: a smaller, explained ask is likelier to
    // be granted to a young project (Google refused this project's CPU raises in us-east4 on 2026-11-11).
    label: 'Cloud Run ephemeral disk', unit: 'GiB', action: 'run-disk-quota', target: 50,
    match: (q) => /ephemeral/i.test(`${qName(q)} ${q.quotaId ?? ''}`),
    cost: 'only disk that running instances use is billed (each cell asks for 10 GiB)',
  },
};

export const project = () => process.env.STUDIO_CELLS_PROJECT || process.env.STUDIO_GCP_PROJECT || 'hawkes-staging';
export const region = () => process.env.STUDIO_CELLS_REGION || process.env.STUDIO_GCP_REGION || 'us-east4';
/** The repo whose ops-admin workflow files the request when Studio's own account may not. */
export const opsRepo = () => process.env.STUDIO_OPS_REPO || 'jgriffith3433/hawkesstudio';

const QI = (p: string) => `https://cloudquotas.googleapis.com/v1/projects/${p}/locations/global/services/run.googleapis.com/quotaInfos?pageSize=500`;

/** The tests' stand-in for Google's quota list and Studio's ways of filing a request. */
export const quotaHooks: { list?: () => Promise<QuotaInfo[] | null>; file?: (a: QuotaAsk, info: { quotaId: string; unit: string; raw: number } | null) => Promise<string>; dispatch?: (a: QuotaAsk, apply: boolean) => Promise<string> } = {};

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
  return Number.isFinite(raw) ? { value: inUnit(kind, raw, qUnit(q)), raw, quotaId: q.quotaId, unit: qUnit(q) } : null;
}

// ---- Each ask's answer, kept (one row per project, region and quota) ----
db.exec(`CREATE TABLE IF NOT EXISTS quota_asks (
  project TEXT NOT NULL, region TEXT NOT NULL, kind TEXT NOT NULL, value REAL NOT NULL, state TEXT NOT NULL,
  approval TEXT, detail TEXT, current REAL, current_at INTEGER, refreshed INTEGER, updated INTEGER NOT NULL,
  PRIMARY KEY (project, region, kind)
)`);

/**
 * filing: J approved, ops-admin is filing it. filed: Google has the request and is deciding. granted: Google gives at
 * least the value. refused: Google answered with less. denied: J tapped Deny. failed: filing didn't reach Google (the
 * card is open again, with the error).
 */
export type AskState = 'filing' | 'filed' | 'granted' | 'refused' | 'denied' | 'failed';
export type AskRecord = { project: string; region: string; kind: QuotaKind; value: number; state: AskState; approval: string | null; detail: string | null; current: number | null; current_at: number | null; refreshed: number | null; updated: number };

export function askRecord(kind: QuotaKind, at = region(), p = project()): AskRecord | null {
  return (db.prepare('SELECT * FROM quota_asks WHERE project = ? AND region = ? AND kind = ?').get(p, at, kind) as AskRecord | undefined) ?? null;
}
function note(kind: QuotaKind, at: string, fields: Partial<AskRecord>) {
  const was = askRecord(kind, at);
  const r = { project: project(), region: at, kind, value: 0, state: 'filing' as AskState, approval: null, detail: null, current: null, current_at: null, refreshed: null, ...(was ?? {}), ...fields, updated: Date.now() };
  db.prepare(`INSERT INTO quota_asks (project, region, kind, value, state, approval, detail, current, current_at, refreshed, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (project, region, kind) DO UPDATE SET value = excluded.value, state = excluded.state, approval = excluded.approval, detail = excluded.detail,
      current = excluded.current, current_at = excluded.current_at, refreshed = excluded.refreshed, updated = excluded.updated`)
    .run(r.project, r.region, r.kind, r.value, r.state, r.approval, r.detail, r.current, r.current_at, r.refreshed, r.updated);
  return askRecord(kind, at)!;
}

/**
 * Why this ask needs no card, or null when it does. An answer already given covers the same value or less: Google
 * gives it, Google is deciding it, J denied it, or Google refused it. A failed filing reopened its own card (asks merge
 * into that one), and a bigger value than any answer is a new question.
 */
export function settled(a: QuotaAsk, rec = askRecord(a.kind, a.region)): string | null {
  if (!rec || rec.state === 'failed' || a.value > rec.value) return null;
  const what = `${rec.value} ${QUOTAS[a.kind].unit} of ${QUOTAS[a.kind].label} in ${a.region}`;
  if (rec.state === 'granted') return `Google gives ${what}`;
  if (rec.state === 'filing' || rec.state === 'filed') return `asked Google for ${what}; Google is deciding`;
  if (rec.state === 'denied') return `J denied asking for ${what}`;
  if (rec.state === 'refused') return `Google refused ${what}`;
  return null;
}

/** How often a filed ask may start a read-only ops-admin run to learn Google's answer (only on an event that asks). */
const REFRESH_MS = () => Number(process.env.STUDIO_QUOTA_REFRESH_MS ?? 6 * 3600_000);

/**
 * One card for these asks (merged into the pending quota card for the same project and region). Never throws: a part
 * that needs a quota carries on as it can, and the card is how it gets it. An ask already answered makes no card
 * (settled); one Google is deciding learns Google's answer instead (a read-only ops-admin run, at most every few hours).
 */
export async function askForQuota(asks: QuotaAsk[], by = 'Studio') {
  try {
    const { requestApproval, listApprovals } = await import('./approvals.ts');
    // Only what Google doesn't already give and nobody answered yet.
    const need: QuotaAsk[] = [];
    for (const a of asks) {
      const now = await quotaNow(a.kind, a.region).catch(() => null);
      if (now && askRecord(a.kind, a.region)) note(a.kind, a.region, { current: now.value, current_at: Date.now() });
      if (now && now.value >= a.value) { note(a.kind, a.region, { state: 'granted', value: Math.max(a.value, askRecord(a.kind, a.region)?.value ?? 0), detail: `Google gives ${Math.round(now.value * 10) / 10} ${QUOTAS[a.kind].unit}` }); continue; }
      const rec = askRecord(a.kind, a.region);
      if (settled(a, rec)) {
        if (rec?.state === 'filed' && Date.now() - (rec.refreshed ?? 0) > REFRESH_MS()) {
          note(a.kind, a.region, { refreshed: Date.now() });
          void dispatchOps({ ...a, value: rec.value }, false).catch((e) => console.warn(`[quota] couldn't read Google's answer: ${e?.message ?? e}`));
        }
        continue;
      }
      need.push(a);
    }
    if (!need.length) return null;
    asks = need;
    const target = `${project()}:${asks[0]?.region ?? region()}`;
    const open = listApprovals({ pending: true }).find((a: any) => a.kind === 'quota' && a.target === target);
    // The newest ask for a quota is what's needed now (a target lowered in a release lowers the waiting card too).
    const merged = new Map<QuotaKind, QuotaAsk>();
    for (const a of [...((open?.params?.asks ?? []) as QuotaAsk[]), ...asks]) {
      const was = merged.get(a.kind);
      merged.set(a.kind, was ? { ...was, value: a.value, why: was.why === a.why ? was.why : `${was.why}; ${a.why}`.slice(0, 400) } : { ...a });
    }
    return await requestApproval('quota', target, { asks: [...merged.values()] }, { by });
  } catch (e: any) {
    console.warn(`[quota] couldn't put up the quota card: ${e?.message ?? e}`);
    return null;
  }
}

const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60_000); return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

/** The card's lines: each quota now (when Studio, or ops-admin's last run, could read it) and what is asked, why, and what it costs. */
export async function describeQuota(asks: QuotaAsk[]) {
  const lines: string[] = [];
  for (const a of asks) {
    const q = QUOTAS[a.kind];
    const now = await quotaNow(a.kind, a.region).catch(() => null);
    const rec = askRecord(a.kind, a.region);
    const cur = now ? `${Math.round(now.value * 10) / 10}` : rec?.current !== null && rec?.current !== undefined && rec.current_at ? `${Math.round(rec.current * 10) / 10} (read ${ago(rec.current_at)})` : 'current value not readable by Studio';
    lines.push(`${q.label} in ${a.region}: ${cur} → ${a.value} ${q.unit}. Why: ${a.why}. Cost: asking is free; ${q.cost}.`);
  }
  return lines;
}

/** Studio's public address: where ops-admin reports back (its OIDC token's audience). */
const studioUrl = () => (process.env.STUDIO_PUBLIC_URL || 'https://studio.hawkesgen.ai').replace(/\/+$/, '');

/** Starts ops-admin for one ask: apply files it with Google; without, it only reads the quota and the request. */
async function dispatchOps(x: QuotaAsk, apply: boolean): Promise<string> {
  if (quotaHooks.dispatch) return quotaHooks.dispatch(x, apply);
  const token = (await (await import('./ghtoken.ts')).repoToken(opsRepo()).catch(() => null)) ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error(`no GitHub token for ${opsRepo()}`);
  const r = await fetch(`https://api.github.com/repos/${opsRepo()}/actions/workflows/ops-admin.yml/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'hawkes-studio', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs: { action: QUOTAS[x.kind].action, apply: String(apply), project: project(), region: x.region, value: String(Math.round(x.value)), studio: studioUrl() } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`GitHub answered ${r.status} starting ops-admin: ${(await r.text()).slice(0, 200)}`);
  return `started ops-admin ${QUOTAS[x.kind].action}${apply ? ' (apply)' : ' (read only)'} for ${x.value} ${QUOTAS[x.kind].unit} in ${x.region}`;
}

/**
 * Files one ask with Google (J approved card `approval`): the Cloud Quotas API as Studio's own account, else the
 * ops-admin workflow (apply), which reports back when it ends (onReport). Throws when neither could start: the card
 * then opens again with the error (approvals.ts carryOut).
 */
export async function raiseQuota(a: QuotaAsk, approval: string | null = null): Promise<string> {
  const now = await quotaNow(a.kind, a.region).catch(() => null);
  const direct = quotaHooks.file ?? (async (x: QuotaAsk, info: { quotaId: string; unit: string; raw: number } | null) => {
    if (!info) throw new Error('quota not readable');
    const { gapi } = await import('./gcp.ts');
    // The same preference ops-admin files (run-cpu-<region>, run-disk-<region>): one request per quota and region.
    const id = `run-${x.kind}-${x.region}`;
    const body = { service: 'run.googleapis.com', quotaId: info.quotaId, quotaConfig: { preferredValue: String(Math.round(toUnit(x.kind, x.value, info.unit, info.raw))) }, dimensions: { region: x.region }, justification: `Hawkes Studio: ${x.why}`.slice(0, 500) };
    const base = `https://cloudquotas.googleapis.com/v1/projects/${project()}/locations/global/quotaPreferences`;
    await gapi(`${base}/${id}?allowMissing=true&updateMask=quotaConfig.preferredValue,justification`, { method: 'PATCH', body: { ...body, name: `projects/${project()}/locations/global/quotaPreferences/${id}` }, timeoutMs: 30_000 });
    return `asked Google for ${x.value} ${QUOTAS[x.kind].unit} of ${QUOTAS[x.kind].label} in ${x.region} (quota preference ${id}); Google is deciding`;
  });
  try {
    const done = await direct(a, now ? { quotaId: now.quotaId, unit: now.unit, raw: now.raw } : null);
    note(a.kind, a.region, { value: a.value, state: 'filed', approval, detail: done });
    return done;
  } catch (e: any) {
    try {
      const started = await dispatchOps(a, true);
      const done = `${started}; this card shows Google's answer when the run ends (Studio's own account couldn't file it: ${String(e?.message ?? e).slice(0, 120)})`;
      note(a.kind, a.region, { value: a.value, state: 'filing', approval, detail: done });
      return done;
    } catch (e2: any) {
      note(a.kind, a.region, { value: a.value, state: 'failed', approval, detail: String(e2?.message ?? e2).slice(0, 500) });
      throw e2;
    }
  }
}

/** J tapped Deny on a quota card: the same values are never asked again (a bigger one may be). */
export function noteDenied(asks: QuotaAsk[], approval: string) {
  for (const a of asks) note(a.kind, a.region, { value: a.value, state: 'denied', approval, detail: `J denied asking for ${a.value} ${QUOTAS[a.kind].unit}` });
}

/** Why a report's GitHub token may not report (null when it may): only ops-admin, on the ops repo's main, in production. */
export function reportRefused(claims: Record<string, any>): string | null {
  const repo = opsRepo().toLowerCase();
  if (String(claims.repository ?? '').toLowerCase() !== repo) return `${claims.repository} doesn't run ops-admin for this Studio`;
  if (claims.ref !== 'refs/heads/main') return `only main reports (got ${claims.ref})`;
  if (!String(claims.workflow_ref ?? '').toLowerCase().startsWith(`${repo}/.github/workflows/ops-admin.yml@`)) return 'only the ops-admin workflow reports quota runs';
  if (claims.environment !== 'production') return 'only the production environment reports';
  return null;
}

/** What an ops-admin quota run reports (its last step, POST /api/hooks/quota). current/granted/preferred in card units. */
export type OpsReport = { kind: QuotaKind; region: string; value: number; apply: boolean; ok: boolean; error?: string | null; current?: number | null; granted?: number | null; preferred?: number | null; reconciling?: boolean | null; run?: string | null };

/**
 * An ops-admin quota run ended. Applied and ok: filed (Google is deciding, or already answered). Applied and failed:
 * the card opens again with the real error (Approve tries again), never a silent new card. Read only: Google's answer
 * to a filed ask (granted or refused), or just the current value. Returns what was recorded.
 */
export async function onReport(r: OpsReport): Promise<AskRecord | null> {
  if (!QUOTAS[r.kind] || !/^[a-z]+-[a-z]+\d$/.test(String(r.region))) throw new Error('kind (cpu | disk) and region');
  const unit = QUOTAS[r.kind].unit;
  const at = r.region;
  const run = r.run ? ` (ops-admin run ${r.run})` : '';
  const num = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const current = num(r.current);
  const granted = num(r.granted) ?? current;
  const known = current === null ? {} : { current, current_at: Date.now() };
  const rec = askRecord(r.kind, at);
  const value = num(r.value) ?? rec?.value ?? 0;
  const asked = rec?.state === 'filing' || rec?.state === 'filed';
  let state: AskState | null = null;
  let detail = '';
  if (r.apply && !r.ok) {
    state = 'failed';
    detail = `Filing with Google failed${run}: ${String(r.error || 'the run gave no error').slice(0, 400)}`;
  } else if (granted !== null && value > 0 && granted >= value) {
    state = 'granted';
    detail = `Google gives ${granted} ${unit} in ${at}${run}.`;
  } else if (r.ok && asked && r.reconciling === false && num(r.preferred) !== null && granted !== null) {
    state = 'refused';
    detail = `Google answered ${granted} ${unit} of the ${value} asked in ${at}${run}. Studio won't ask for that much again.`;
  } else if (r.apply && r.ok) {
    state = 'filed';
    detail = `Filed with Google: ${value} ${unit} in ${at}${run}; Google is deciding${current !== null ? ` (now ${current} ${unit})` : ''}.`;
  }
  // A read-only run only says what Google answered: it never undoes J's Deny or a failure he hasn't retried.
  if (!state || (!r.apply && !asked && state !== 'granted')) return rec || current !== null ? note(r.kind, at, rec ? known : { ...known, value: current!, state: 'granted', detail: `Google gives ${current} ${unit}` }) : null;
  const out = note(r.kind, at, { ...known, state, detail, value: state === 'granted' ? Math.max(value, granted ?? 0) : value });
  const { quotaOutcome } = await import('./approvals.ts');
  if (out.approval) await quotaOutcome(out.approval, state === 'failed' ? { error: detail } : { result: detail });
  return out;
}

/**
 * A cell running without its working disk (Google refused it, cellrun.ts rollCells) asks for the disk quota on start.
 * Only on Cloud Run, only in a cell. Asking again after a restart is harmless: an answered ask makes no card (settled).
 */
export async function askDiskIfMissing(onDisk: boolean) {
  if (onDisk || !process.env.K_SERVICE || !process.env.STUDIO_ORG) return null;
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
