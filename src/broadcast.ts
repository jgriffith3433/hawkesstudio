// The live show (dashboard/broadcast.html): one 1920×1080 page a headless browser can send to Twitch.
// It is built only from titles, steps and notes Studio already shows on the Playtests page and the roadmap.
// Raw agent logs, diffs, terminals and URLs with query strings never leave this module.
//
// bin/broadcast-stream.mjs is the sender. It does not start until a stream key is set, and it does not
// encode on this process: a separate ffmpeg reads the page.

import { listChanges } from './agents.ts';
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
  host: string;
  disclose: string;
};

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

function hostOf(focus: Take | null, ticker: Tick[]): string {
  if (focus?.phase === 'playing') {
    const doing = focus.note || focus.step;
    return safeLine(`Yooba here. They're making me on camera. ${focus.productName}, ${focus.build}.${doing ? ` Right now: ${doing}.` : ''}${focus.problems ? ` ${focus.problems} bug${focus.problems === 1 ? '' : 's'} on this take.` : ''}`);
  }
  if (focus?.phase === 'waiting') {
    return safeLine(`Yooba here. A take of ${focus.productName} is waiting for a browser. ${focus.scenario || 'The next scenario'} is next.`);
  }
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
  const ms = (input.milestones ?? []).find((m) => !pid || m.product === pid || m.product == null);
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

  return {
    at: now,
    focus,
    also,
    products,
    milestone: ms ? { title: safeLine(ms.title, 80), done: num(ms.done), total: num(ms.total) } : null,
    bars,
    ticker,
    flash,
    host: hostOf(focus, ticker),
    disclose: 'Made by AI agents. The host is generated.',
  };
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
  return composeBroadcast({ ...live, changes, milestones, items, product: q.product });
}
