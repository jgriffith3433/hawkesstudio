// The live show (dashboard/broadcast.html): one 1920×1080 page a headless browser can send to Twitch.
// It is built only from titles, steps and notes Studio already shows on the Playtests page and the roadmap.
// Between takes it plays a reel of videos already in the Hawkes Gen library (no new GPU job).
// Raw agent logs, diffs, terminals, prompts, file paths and URLs with query strings never leave this module.
//
// bin/broadcast-stream.mjs is the sender. It does not start until a stream key is set, and it does not
// encode on this process: a separate ffmpeg reads the page.

import { listChanges } from './agents.ts';
import { loadProducts } from './config.ts';
import { gen } from './gen.ts';
import { livePlaytests } from './livetests.ts';
import { listItems, listMilestones } from './roadmap.ts';

const SECRET = /\b(?:sk-|hg_|AKIA|ghp_|github_pat_|xai-)[A-Za-z0-9_-]{6,}\b/g;
const WINPATH = /[A-Za-z]:\\[^\s'"]+/g;
const UNIXPATH = /\/(?:home|Users|srv|run|etc|opt|root)\/[^\s'"]+/g;
const ASSIGN = /\b(?:api[_-]?key|token|secret|password|stream[_-]?key)\s*[:=]\s*\S+/gi;

/** On-screen text: one line, no paths, no keys. */
export function safeLine(s: unknown, n = 160): string {
  return String(s ?? '')
    .replace(WINPATH, '')
    .replace(UNIXPATH, '')
    .replace(ASSIGN, '')
    .replace(SECRET, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}

/** Host plus a build tag from the path. The query string is dropped (it can carry a token). */
export function buildLabel(url: unknown): string {
  const raw = String(url ?? '').trim();
  if (!raw) return 'beta';
  try {
    const u = new URL(raw);
    const v = u.pathname.match(/\/v(\d+)\b/i);
    const sha = u.pathname.match(/\/([0-9a-f]{7,40})\b/i);
    const host = u.host.replace(/^www\./, '');
    return [host, v ? `build v${v[1]}` : 'beta', sha ? sha[1].slice(0, 7) : ''].filter(Boolean).join(' · ');
  } catch {
    return 'beta';
  }
}

export type Take = {
  job: string;
  /** playing | waiting | finished */
  phase: 'playing' | 'waiting' | 'finished';
  product: string;
  productName: string;
  scenario: string;
  step: string;
  note: string;
  outcome: string;
  build: string;
  /** Studio-proxied MJPEG. Null unless the job id is one Gen minted. */
  stream: string | null;
  /** Saved playtest video, when the step id is known. */
  replay: string | null;
  problems: number;
};

export type Bar = { title: string; label: string; pct: number };
export type Tick = { id: string; at: number; kind: string; text: string };

export type Broadcast = {
  at: number;
  focus: Take | null;
  /** Other live takes, for the small tiles. */
  also: Take[];
  /** Products that have anything on the board, so the page can switch. */
  products: { id: string; name: string }[];
  milestone: { title: string; done: number; total: number } | null;
  bars: Bar[];
  ticker: Tick[];
  /** A moment worth a full-screen flash, only if it happened in the last few seconds. */
  flash: { id: string; kind: string; text: string } | null;
  /**
   * Showcase videos for the quiet floor (newest turntables, then current clips).
   * A take still wins: the page plays this only while `focus` is null.
   * Labels are safeLine text. Prompts, paths and keys are not copied here.
   */
  reel: ReelItem[];
  host: string;
  disclose: string;
};

/** One library video the reel may consider. `prompt` and `path` are never copied onto the reel. */
export type ReelSource = {
  asset: string;
  tool: string;
  title?: string | null;
  kind?: string | null;
  mime?: string | null;
  created?: number;
  project?: string | null;
  projectName?: string | null;
  /** Entity id, for dedupe only. Never shown. */
  entity?: string | null;
  entityName?: string | null;
  slot?: string | null;
  /** current | take | old | discarded. Clips need current. */
  status?: string | null;
  prompt?: string | null;
  path?: string | null;
};

export type ReelItem = {
  asset: string;
  /** Same-origin Gen relay. The page plays this. */
  src: string;
  product: string;
  name: string;
  /** "turntable" or the clip name. */
  what: string;
  label: string;
};

const ASSET = /^a_[0-9a-f]+$/;
const REEL_CAP = 12;

function videoFile(h: ReelSource): boolean {
  return h.kind === 'video' || String(h.mime ?? '').startsWith('video/');
}

/** A slot or title we will not put on the show: test fixtures and rejected-take folders. */
function blocked(slot: string, title: string): boolean {
  const s = slot.toLowerCase();
  const t = title.toLowerCase();
  return s.startsWith('test') || t.startsWith('test') || s.includes('_takes') || t.includes('_takes');
}

function looksLikeId(s: string): boolean {
  return /^(?:[a-z]{1,3}_[0-9a-f]{4,}|[a-z0-9-]+\/[a-z0-9-]+)$/i.test(s);
}

/** mesh.rig's spinning preview: title "turntable", or the walk video filed on preview/turntable. */
function isTurntable(h: ReelSource): boolean {
  if (h.tool !== 'mesh.rig') return false;
  const title = String(h.title ?? '').trim().toLowerCase();
  const slot = String(h.slot ?? '').trim().toLowerCase();
  if (title === 'turntable') return true;
  if (slot === 'preview/turntable' || slot.endsWith('/turntable')) return true;
  return false;
}

function clipName(h: ReelSource): string {
  const part = String(h.slot ?? '').split('/').filter(Boolean).pop() ?? '';
  if (part && part.toLowerCase() !== 'turntable') return part.replace(/[-_]+/g, ' ');
  const title = String(h.title ?? '').trim();
  const tail = (title.includes('/') ? title.split('/').pop()! : title).replace(/\.[a-z0-9]+$/i, '').trim();
  if (!tail || tail.length > 40) return 'clip';
  return tail.replace(/[-_]+/g, ' ');
}

function humanEntity(h: ReelSource): string {
  const name = String(h.entityName ?? '').trim();
  if (name && !looksLikeId(name)) return name;
  const slug = String(h.entity ?? '').split('/').pop() ?? '';
  if (slug && !looksLikeId(slug)) return slug.replace(/[-_]+/g, ' ');
  return '';
}

function productLabel(h: ReelSource): string {
  const named = String(h.projectName ?? '').trim();
  if (named) return named;
  const p = String(h.project ?? '').trim();
  if (!p || p.includes('/') || looksLikeId(p)) return '';
  return p;
}

/**
 * The quiet-floor reel. Turntables first (newest), then one current clip per entity and clip name.
 * Rejected takes, test slots, `_takes` files and playtest.run never get in. About 12.
 */
export function selectReel(hits: ReelSource[], opts: { product?: string; cap?: number } = {}): ReelItem[] {
  const cap = opts.cap ?? REEL_CAP;
  const lock = opts.product ? String(opts.product) : '';
  const pool = (hits ?? []).filter((h) => {
    if (!h || !ASSET.test(String(h.asset ?? ''))) return false;
    if (!videoFile(h)) return false;
    const tool = String(h.tool ?? '');
    if (tool === 'playtest.run' || tool.startsWith('playtest.')) return false;
    if (lock && h.project && h.project !== lock) return false;
    if (lock && !h.project) return false;
    return true;
  });

  const fresh = (a: ReelSource, b: ReelSource) => (b.created ?? 0) - (a.created ?? 0);
  const turntables = pool.filter((h) => isTurntable(h) && h.status !== 'discarded' && !blocked(String(h.slot ?? ''), String(h.title ?? ''))).sort(fresh);
  const seenTurn = new Set<string>();
  const turns: ReelSource[] = [];
  for (const h of turntables) {
    const key = h.entity || h.asset;
    if (seenTurn.has(key)) continue;
    seenTurn.add(key);
    turns.push(h);
  }

  const clips = pool.filter((h) => {
    if (isTurntable(h)) return false;
    const tool = String(h.tool ?? '');
    if (tool !== 'video.i2v' && tool !== 'video.animate' && tool !== 'mesh.rig') return false;
    if (h.status !== 'current') return false;
    if (blocked(String(h.slot ?? ''), String(h.title ?? ''))) return false;
    return true;
  }).sort(fresh);
  const seenClip = new Set<string>();
  const picked: ReelSource[] = [];
  for (const h of clips) {
    const key = `${h.entity || h.asset}::${clipName(h).toLowerCase()}`;
    if (seenClip.has(key)) continue;
    seenClip.add(key);
    picked.push(h);
  }

  const out: ReelItem[] = [];
  for (const h of [...turns, ...picked]) {
    if (out.length >= cap) break;
    if (out.some((x) => x.asset === h.asset)) continue;
    const product = safeLine(productLabel(h), 60);
    const name = safeLine(humanEntity(h), 60);
    const what = safeLine(isTurntable(h) ? 'turntable' : clipName(h), 40) || (isTurntable(h) ? 'turntable' : 'clip');
    const label = safeLine([product, name, what].filter(Boolean).join(' · '), 120);
    out.push({ asset: h.asset, src: `/api/gen/v1/files/${h.asset}`, product, name, what, label });
  }
  return out;
}

const JOB = /^j_[0-9a-f]+$/;
const STEP = /^s_[0-9a-f]+$/;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** One playtest row (live, waiting or just finished) reduced to what the show may say. */
export function takeOf(raw: any, phase: Take['phase']): Take | null {
  if (!raw || typeof raw !== 'object') return null;
  const job = String(raw.job ?? '');
  if (phase !== 'waiting' && !JOB.test(job)) return null;
  const product = safeLine(raw.ctx?.product ?? raw.project ?? '', 40);
  const productName = safeLine(raw.ctx?.productName ?? product ?? 'a product', 60) || 'a product';
  const scenario = safeLine(raw.ctx?.name || raw.scenario?.title || raw.scenario?.id || raw.scenario || '', 80);
  const player = raw.players?.[0]?.state ?? {};
  const stepId = STEP.test(String(raw.ctx?.step ?? '')) ? String(raw.ctx.step) : STEP.test(String(raw.stepId ?? '')) ? String(raw.stepId) : '';
  const problems = phase === 'playing'
    ? num(raw.problems?.length ?? raw.players?.[0]?.problems?.length)
    : num(raw.problems?.length ?? (Array.isArray(raw.problems?.last) ? raw.problems.last.length : 0));
  return {
    job: job || `wait-${product}`,
    phase,
    product,
    productName,
    scenario,
    step: safeLine(phase === 'playing' ? raw.step : (raw.detail || raw.outcome || raw.status), 140),
    note: safeLine(phase === 'playing' ? [player.scene, player.note].filter(Boolean).join(' — ') : '', 140),
    outcome: safeLine(raw.outcome || raw.status || '', 40),
    build: buildLabel(raw.url),
    stream: phase === 'playing' && JOB.test(job) ? `/api/gen/v1/jobs/${job}/live.mjpeg?player=0&fps=8` : null,
    replay: phase === 'finished' && stepId ? `/api/playtests/${stepId}/video` : null,
    problems,
  };
}

function pctOf(state: string, merged: number, total: number): number {
  if (total > 0) return Math.max(0, Math.min(1, merged / total));
  if (['on beta', 'verified', 'live', 'done'].includes(state)) return 1;
  if (state === 'working' || state === 'waiting for GPU jobs') return 0.45;
  return 0.08;
}

const STATUS_KIND: Record<string, string> = {
  working: 'working',
  'needs answer': 'working',
  review: 'review',
  'ready to merge': 'ready',
  merged: 'merged',
  verified: 'merged',
  live: 'merged',
  failed: 'bug',
};

/** Recent agent work, titles and statuses only. */
export function tickerOf(changes: any[], names: Map<string, string>, now: number): Tick[] {
  const out: Tick[] = [];
  for (const c of changes) {
    const kind = STATUS_KIND[String(c?.status ?? '')];
    if (!kind) continue;
    const title = safeLine(c.title, 90);
    if (!title) continue;
    const product = String(c.product ?? '');
    const who = names.get(product) || safeLine(product, 40) || 'Studio';
    const verb = kind === 'working' ? 'is in the code' : kind === 'merged' ? 'landed on beta' : kind === 'bug' ? 'hit a snag' : kind === 'ready' ? 'is ready to land' : 'is in review';
    out.push({
      id: safeLine(c.id, 40),
      at: num(c.updated ?? c.created) || now,
      kind,
      text: safeLine(`${who}: “${title}” ${verb}`, 140),
    });
    if (out.length >= 8) break;
  }
  return out;
}

function hostOf(focus: Take | null, ticker: Tick[], reel: ReelItem[]): string {
  if (focus?.phase === 'playing') {
    const doing = focus.note || focus.step;
    return safeLine(`Yooba here. They're making me on camera. ${focus.productName}, ${focus.build}.${doing ? ` Right now: ${doing}.` : ''}${focus.problems ? ` ${focus.problems} bug${focus.problems === 1 ? '' : 's'} on this take.` : ''}`);
  }
  if (focus?.phase === 'waiting') {
    return safeLine(`Yooba here. A take of ${focus.productName} is waiting for a browser. ${focus.scenario || 'The next scenario'} is next.`);
  }
  // The reel is on screen only when nothing is playing, waiting or just finished.
  if (!focus && reel[0]?.label) return safeLine(`Yooba here. The studio is between takes. On screen: ${reel[0].label}.`);
  const work = ticker.find((t) => t.kind === 'working' || t.kind === 'ready');
  if (work) return safeLine(`Yooba here. Nothing is on camera. ${work.text}`);
  if (focus) return safeLine(`Yooba here. Last take of ${focus.productName}: ${focus.outcome || 'wrapped'}. ${focus.scenario}`);
  return 'Yooba here. The studio is between takes. The roadmap is still on the wall.';
}

/**
 * The whole frame. `product` locks the show to one product; otherwise a live take beats a waiting one,
 * which beats a replay.
 */
export function composeBroadcast(input: {
  playing?: any[];
  waiting?: any[];
  finished?: any[];
  changes?: any[];
  milestones?: any[];
  items?: any[];
  /** Library videos already made. Nothing here starts a job. */
  library?: ReelSource[];
  product?: string;
  now?: number;
}): Broadcast {
  const now = input.now ?? Date.now();
  const playing = (input.playing ?? []).map((p) => takeOf(p, 'playing')).filter((t): t is Take => !!t);
  const waiting = (input.waiting ?? []).map((p) => takeOf(p, 'waiting')).filter((t): t is Take => !!t);
  const finished = (input.finished ?? []).map((p) => takeOf(p, 'finished')).filter((t): t is Take => !!t);
  const all = [...playing, ...waiting, ...finished];
  const names = new Map<string, string>();
  for (const t of all) if (t.product) names.set(t.product, t.productName);
  const lock = input.product ? String(input.product) : '';
  const pool = lock ? all.filter((t) => t.product === lock) : all;
  const rank = (t: Take) => (t.phase === 'playing' ? 3 : t.phase === 'waiting' ? 2 : 1);
  const ordered = [...pool].sort((a, b) => rank(b) - rank(a));
  const focus = ordered[0] ?? null;
  const also = playing.filter((t) => t.job !== focus?.job && (!lock || t.product === lock)).slice(0, 3);

  const products: { id: string; name: string }[] = [];
  for (const t of all) {
    if (!t.product || products.some((p) => p.id === t.product)) continue;
    products.push({ id: t.product, name: t.productName });
  }

  const pid = focus?.product || lock;
  const milestones = input.milestones ?? [];
  const ms = milestones.find((m) => pid ? m.product === pid : true) ?? milestones.find((m) => m.product == null);
  const fromMs: Bar[] = (ms?.items ?? []).slice(0, 6).map((i: any) => ({
    title: safeLine(i.title, 80),
    label: safeLine(i.display || i.state || '', 40),
    pct: pctOf(String(i.state ?? ''), num(i.merged), num(i.total)),
  }));
  const fromItems: Bar[] = fromMs.length ? [] : (input.items ?? [])
    .filter((i) => !pid || i.product === pid)
    .slice(0, 6)
    .map((i) => ({
      title: safeLine(i.title, 80),
      label: safeLine(i.progress?.label || i.progress?.state || i.status || '', 40),
      pct: pctOf(String(i.progress?.state ?? i.status ?? ''), num(i.progress?.merged), num(i.progress?.total)),
    }));
  const bars = (fromMs.length ? fromMs : fromItems).filter((b) => b.title);

  const ticker = tickerOf(input.changes ?? [], names, now);
  const hot = ticker.find((t) => (t.kind === 'merged' || t.kind === 'bug') && now - t.at < 20_000);
  const flash = hot ? { id: hot.id, kind: hot.kind === 'bug' ? 'BUG' : 'MERGED', text: hot.text } : null;
  const reel = selectReel(input.library ?? [], { product: lock || undefined });

  return {
    at: now,
    focus,
    also,
    products,
    milestone: ms ? { title: safeLine(ms.title, 80), done: num(ms.done), total: num(ms.total) } : null,
    bars,
    ticker,
    flash,
    reel,
    host: hostOf(focus, ticker, reel),
    disclose: 'Made by AI agents. The host is generated.',
  };
}

/** Where a mesh.rig / clip job filed this output (saves map by title), else the job's own slot. */
function filedSlot(labels: any, title: string): string | null {
  const slots = labels?.slots;
  if (slots && typeof slots === 'object') {
    if (typeof slots[title] === 'string') return slots[title];
    const base = title.split('.')[0];
    if (base && typeof slots[base] === 'string') return slots[base];
  }
  return typeof labels?.slot === 'string' ? labels.slot : null;
}

function mergeHit(prev: ReelSource | undefined, h: ReelSource): ReelSource {
  if (!prev) return h;
  const currentSlot = h.status === 'current' && h.slot ? h.slot : prev.status === 'current' && prev.slot ? prev.slot : (h.slot || prev.slot);
  return {
    asset: h.asset,
    tool: h.tool || prev.tool,
    title: h.title || prev.title,
    kind: h.kind || prev.kind,
    mime: h.mime || prev.mime,
    created: Math.max(h.created ?? 0, prev.created ?? 0),
    project: h.project || prev.project,
    projectName: h.projectName || prev.projectName,
    entity: h.entity || prev.entity,
    entityName: h.entityName || prev.entityName,
    slot: currentSlot,
    status: h.status === 'current' || prev.status === 'current' ? 'current' : (h.status || prev.status),
  };
}

/**
 * Videos already in the library. Reads only: asset lists and entity slots. Never submits a job.
 * Cached so the page's 2-second poll does not ask Gen every time.
 */
const REEL_MS = 30_000;
let reelMemo: { at: number; hits: ReelSource[] } | null = null;
let reelFlight: Promise<ReelSource[]> | null = null;

function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

async function fetchShowcase(): Promise<ReelSource[]> {
  const names = new Map(loadProducts().map((p) => [p.id, p.name]));
  const [rig, i2v, anim, ents] = await Promise.all([
    gen.assets({ tool: 'mesh.rig', kind: 'video', limit: '80' }).catch(() => null),
    gen.assets({ tool: 'video.i2v', kind: 'video', limit: '80' }).catch(() => null),
    gen.assets({ tool: 'video.animate', kind: 'video', limit: '80' }).catch(() => null),
    gen.entities({ limit: '500' }).catch(() => null),
  ]);
  const byAsset = new Map<string, ReelSource>();
  const put = (h: ReelSource) => { if (ASSET.test(h.asset)) byAsset.set(h.asset, mergeHit(byAsset.get(h.asset), h)); };
  for (const a of [...(rig?.items ?? []), ...(i2v?.items ?? []), ...(anim?.items ?? [])]) {
    const asset = String(a?.id ?? '');
    if (!ASSET.test(asset)) continue;
    const title = a?.title == null ? '' : String(a.title);
    const labels = a?.labels && typeof a.labels === 'object' ? a.labels : {};
    put({
      asset,
      tool: String(a?.tool ?? ''),
      title: title || null,
      kind: a?.kind == null ? null : String(a.kind),
      created: num(a?.created),
      project: a?.project == null ? null : String(a.project),
      projectName: names.get(String(a?.project ?? '')) ?? '',
      entity: typeof labels.entity === 'string' ? labels.entity : null,
      slot: filedSlot(labels, title),
      status: 'take',
    });
  }
  const entityNames = new Map<string, string>();
  for (const e of ents?.items ?? []) {
    const entity = String(e?.id ?? '');
    if (!entity) continue;
    if (e?.name) entityNames.set(entity, String(e.name));
    const project = e?.project == null ? null : String(e.project);
    for (const [slot, s] of Object.entries<any>(e?.slots ?? {})) {
      const cur = s?.current;
      const file = cur?.file;
      if (!cur || !file) continue;
      if (file.kind !== 'video' && !String(file.mime ?? '').startsWith('video/')) continue;
      const tool = String(file.tool ?? '');
      if (tool !== 'mesh.rig' && tool !== 'video.i2v' && tool !== 'video.animate') continue;
      const asset = String(cur.asset ?? '');
      put({
        asset,
        tool,
        title: file.title == null ? null : String(file.title),
        kind: 'video',
        created: num(cur.created),
        project,
        projectName: names.get(String(project ?? '')) ?? '',
        entity,
        entityName: e?.name == null ? null : String(e.name),
        slot,
        status: 'current',
      });
    }
  }
  for (const h of byAsset.values()) {
    if (!h.entityName && h.entity && entityNames.has(h.entity)) h.entityName = entityNames.get(h.entity) ?? null;
  }
  return [...byAsset.values()];
}

async function showcaseSources(): Promise<ReelSource[]> {
  if (reelMemo && Date.now() - reelMemo.at < REEL_MS) return reelMemo.hits;
  if (!reelFlight) {
    reelFlight = fetchShowcase()
      .then((hits) => { reelMemo = { at: Date.now(), hits }; return hits; })
      .catch(() => reelMemo?.hits ?? [])
      .finally(() => { reelFlight = null; });
  }
  if (reelMemo) return reelMemo.hits;
  return within(reelFlight, 4_000, []);
}

/** Live frame for the page. Gen being down still returns the roadmap and the ticker. */
export async function broadcastNow(q: { product?: string } = {}): Promise<Broadcast> {
  let live: any = { playing: [], waiting: [], finished: [] };
  try { live = await livePlaytests(); } catch { /* the show keeps the roadmap up */ }
  const milestones = listMilestones({ status: 'open,reached' }).map((m) => ({
    id: m.id, product: m.product, title: m.title, status: m.status, done: m.done, total: m.total, items: m.items,
  }));
  const items = listItems().map((i) => ({
    product: i.product, title: i.title, status: i.status,
    progress: { label: i.progress.label, state: i.progress.state, merged: i.progress.merged, total: i.progress.total },
  }));
  const changes = listChanges({ limit: 30 }).map((c) => ({
    id: c.id, product: c.product, title: c.title, status: c.status, updated: c.updated, created: c.created,
  }));
  const library = await showcaseSources().catch(() => [] as ReelSource[]);
  return composeBroadcast({ ...live, changes, milestones, items, product: q.product, library });
}
