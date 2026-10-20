// The live show (dashboard/broadcast.html): one 1920×1080 page a headless browser can send to Twitch.
// It is built only from titles, steps and notes Studio already shows on the Playtests page and the roadmap.
// Between takes it plays a reel of videos already in the Hawkes Gen library (no new GPU job).
// The director desk (settings key broadcast.desk) steers product priority, screen mode and Yooba's line;
// ?clean=1 hides the desk (that is what bin/broadcast-stream.mjs captures). Yooba speaks via Gen audio.voice
// (Sick Of It Yooba, cached per sentence); the streamer mixes the mp3 into RTMP (no sound card on this machine).
// Raw agent logs, diffs, terminals, prompts, file paths and URLs with query strings never leave this module.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { listChanges } from './agents.ts';
import { DATA, loadProducts, StudioError } from './config.ts';
import { db, J, parse } from './db.ts';
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
  /** The reel before the director rotates it, so the picker can list every clip. */
  reelAll?: ReelItem[];
  /** What the director asked the screen to show. Absent on a frame that has not been directed. */
  picture?: 'live' | 'replay' | 'reel' | 'quiet';
  /** Takes the director can hold on screen, newest rank first. */
  takes?: Take[];
  desk?: Desk;
  /** Every product, for the director's product list. */
  lineup?: { id: string; name: string }[];
  host: string;
  /**
   * Same-origin mp3 of the current host line when voice is on and a clip is ready.
   * Never a path, key or Gen recipe. The clean page and ffmpeg both use this.
   */
  hostAudio?: string | null;
  /** Exact sentence that hostAudio speaks (for the mouth and the cache). */
  say?: string;
  /** One-line status for the director strip: picture, product, clip/take. */
  status?: string;
  disclose: string;
};

/** What the On air director has set. The stream page and this browser both follow it. */
export type Desk = {
  /** null keeps each page's own ?product= link. '' is every product. A product id locks to one. */
  product: string | null;
  /** Auto mode prefers live takes and reel clips in this order (yoobaland first by default). */
  priority: string[];
  screen: 'auto' | 'take' | 'reel' | 'quiet';
  take: string;
  clip: string;
  paused: boolean;
  reelAt: number;
  showRoadmap: boolean;
  showTicker: boolean;
  showHost: boolean;
  showPips: boolean;
  showFlash: boolean;
  /** Host voice for the show (Gen + ffmpeg mix). Off = silent stream, captions still show. */
  voice: boolean;
  cue: string;
  banner: string;
};

export const DESK_DEFAULT: Desk = {
  product: null,
  priority: [],
  screen: 'auto',
  take: '',
  clip: '',
  paused: false,
  reelAt: 0,
  showRoadmap: true,
  showTicker: true,
  showHost: true,
  showPips: true,
  showFlash: true,
  voice: true,
  cue: '',
  banner: '',
};

/** Yooba Land first (the show opened on it), then the rest in products.json order. */
export function defaultPriority(products: string[]): string[] {
  const ids = products.filter(Boolean);
  if (!ids.includes('yoobaland')) return [...ids];
  return ['yoobaland', ...ids.filter((p) => p !== 'yoobaland')];
}

/** Keep known ids, fill missing ones after, yoobaland-first when empty. */
export function normalizePriority(raw: unknown, products: string[]): string[] {
  const base = defaultPriority(products);
  if (!Array.isArray(raw)) return base;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of raw) {
    const id = String(x ?? '');
    if (!products.includes(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const id of base) if (!seen.has(id)) out.push(id);
  return out;
}

export function priorityIndex(priority: string[], product: string): number {
  if (!priority.length) return 0;
  const i = priority.indexOf(product);
  return i < 0 ? priority.length + 1 : i;
}

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
 * The quiet-floor reel. Turntables first (priority, then newest), then one current clip per entity and clip name.
 * Rejected takes, test slots, `_takes` files and playtest.run never get in. About 12.
 */
export function selectReel(hits: ReelSource[], opts: { product?: string; priority?: string[]; cap?: number } = {}): ReelItem[] {
  const cap = opts.cap ?? REEL_CAP;
  const lock = opts.product ? String(opts.product) : '';
  const priority = opts.priority ?? [];
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
  const byPri = (a: ReelSource, b: ReelSource) => {
    const d = priorityIndex(priority, String(a.project ?? '')) - priorityIndex(priority, String(b.project ?? ''));
    return d || fresh(a, b);
  };
  const turntables = pool.filter((h) => isTurntable(h) && h.status !== 'discarded' && !blocked(String(h.slot ?? ''), String(h.title ?? ''))).sort(byPri);
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
  }).sort(byPri);
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

const TAKE_ID = /^(?:j_[0-9a-f]+|wait-[a-z0-9-]+)$/;
const SHOW_FLAGS = ['showRoadmap', 'showTicker', 'showHost', 'showPips', 'showFlash', 'voice'] as const;

/** Force a director cue into Yooba's voice (paths and keys stripped). */
export function cueLine(cue: string): string {
  const clean = safeLine(cue, 180);
  if (!clean) return '';
  return safeLine(/^yooba\b/i.test(clean) ? clean : `Yooba here. ${clean}`, 220);
}

function blankDesk(products: string[]): Desk {
  return { ...DESK_DEFAULT, priority: defaultPriority(products), voice: true };
}

/** A stored desk. Unknown or removed products are dropped rather than thrown. */
export function deskFrom(raw: unknown, products: string[]): Desk {
  const d = blankDesk(products);
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as any;
  if (r.product === null) d.product = null;
  else if (typeof r.product === 'string' && (r.product === '' || products.includes(r.product))) d.product = r.product;
  d.priority = normalizePriority(r.priority, products);
  if (r.screen === 'auto' || r.screen === 'take' || r.screen === 'reel' || r.screen === 'quiet') d.screen = r.screen;
  if (typeof r.take === 'string' && (!r.take || TAKE_ID.test(r.take))) d.take = r.take;
  if (typeof r.clip === 'string' && (!r.clip || ASSET.test(r.clip))) d.clip = r.clip;
  if (typeof r.paused === 'boolean') d.paused = r.paused;
  if (Number.isInteger(r.reelAt) && r.reelAt >= 0 && r.reelAt <= 500) d.reelAt = r.reelAt;
  for (const k of SHOW_FLAGS) if (typeof r[k] === 'boolean') d[k] = r[k];
  if (typeof r.cue === 'string') d.cue = safeLine(r.cue, 180);
  if (typeof r.banner === 'string') d.banner = safeLine(r.banner, 80);
  return d;
}

/** One director change. `pool` is the reel in show order, used by next, previous and advance. */
export function patchDesk(cur: Desk, patch: any, products: string[], pool: { asset: string }[] = []): Desk {
  if (!patch || typeof patch !== 'object') return { ...cur, priority: [...cur.priority] };
  if (patch.reset === true) return blankDesk(products);
  const next: Desk = { ...cur, priority: [...cur.priority] };
  if (patch.product === null) next.product = null;
  else if (patch.product !== undefined) {
    const p = String(patch.product);
    if (p !== '' && !products.includes(p)) throw new StudioError(`No product "${p}"`);
    next.product = p;
  }
  if (patch.priority !== undefined) next.priority = normalizePriority(patch.priority, products);
  if (patch.movePriority && typeof patch.movePriority === 'object') {
    const id = String(patch.movePriority.id ?? '');
    const dir = Number(patch.movePriority.dir);
    if (!products.includes(id) || (dir !== 1 && dir !== -1)) throw new StudioError('movePriority: { id, dir: 1|-1 }');
    const list = [...next.priority];
    const i = list.indexOf(id);
    if (i >= 0) {
      const j = i + dir;
      if (j >= 0 && j < list.length) {
        const tmp = list[i];
        list[i] = list[j];
        list[j] = tmp;
        next.priority = list;
      }
    }
  }
  if (patch.screen !== undefined) {
    if (!['auto', 'take', 'reel', 'quiet'].includes(patch.screen)) throw new StudioError('screen: auto, take, reel or quiet');
    next.screen = patch.screen;
  }
  if (patch.take !== undefined) {
    const t = String(patch.take);
    if (t && !TAKE_ID.test(t)) throw new StudioError('take: a playtest on the board');
    next.take = t;
    if (t) next.screen = 'take';
  }
  if (patch.clip !== undefined) {
    const c = String(patch.clip);
    if (c && !ASSET.test(c)) throw new StudioError('clip: a library video');
    next.clip = c;
    if (c) {
      next.screen = 'reel';
      const i = pool.findIndex((r) => r.asset === c);
      if (i >= 0) next.reelAt = i;
    }
  }
  if (patch.paused !== undefined) next.paused = Boolean(patch.paused);
  if (patch.reelAt !== undefined && patch.advance !== true && patch.nudge === undefined) {
    const n = Number(patch.reelAt);
    if (!Number.isInteger(n) || n < 0 || n > 500) throw new StudioError('reelAt: 0 to 500');
    next.reelAt = n;
  }
  for (const k of SHOW_FLAGS) if (patch[k] !== undefined) next[k] = Boolean(patch[k]);
  if (patch.cue !== undefined) next.cue = safeLine(patch.cue, 180);
  if (patch.banner !== undefined) next.banner = safeLine(patch.banner, 80);
  if (patch.nudge === 1 || patch.nudge === -1) {
    if (pool.length) {
      let i = next.clip ? pool.findIndex((r) => r.asset === next.clip) : next.reelAt % pool.length;
      if (i < 0) i = 0;
      i = (i + patch.nudge + pool.length) % pool.length;
      next.screen = 'reel';
      next.clip = pool[i].asset;
      next.reelAt = i;
      next.paused = false;
    }
  } else if (patch.nudge !== undefined) throw new StudioError('nudge: 1 or -1');
  if (patch.advance === true && next.screen === 'reel' && pool.length) {
    const from = Number(patch.from);
    if (Number.isInteger(from) && from === cur.reelAt) {
      const i = (from + 1) % pool.length;
      next.reelAt = i;
      next.clip = pool[i].asset;
    }
  }
  if (patch.screen === 'auto') {
    next.clip = '';
    next.reelAt = 0;
    next.paused = false;
    next.take = '';
  }
  return next;
}

function orderReel(reel: ReelItem[], desk: Desk): ReelItem[] {
  if (!reel.length) return [];
  let i = desk.reelAt % reel.length;
  if (desk.clip) {
    const found = reel.findIndex((r) => r.asset === desk.clip);
    if (found >= 0) i = found;
  }
  return [...reel.slice(i), ...reel.slice(0, i)];
}

function pictureOf(focus: Take | null, reel: ReelItem[]): NonNullable<Broadcast['picture']> {
  if (focus?.phase === 'playing' && focus.stream) return 'live';
  if (focus?.replay) return 'replay';
  if (!focus && reel.length) return 'reel';
  return 'quiet';
}

/** Plain status for the director strip (and tests). No paths. */
export function statusLine(frame: Broadcast): string {
  const pic = frame.picture || pictureOf(frame.focus, frame.reel ?? []);
  if (pic === 'live' && frame.focus) return `Live · ${frame.focus.productName} · ${frame.focus.scenario || frame.focus.step || 'take'}`;
  if (pic === 'replay' && frame.focus) return `Replay · ${frame.focus.productName} · ${frame.focus.outcome || 'wrapped'}`;
  if (pic === 'reel' && frame.reel?.[0]) return `Reel · ${frame.reel[0].label}`;
  if (pic === 'quiet') return 'Quiet card';
  return frame.focus ? `${frame.focus.productName} · ${frame.focus.phase}` : 'Between takes';
}

/**
 * Applies the director on top of a frame. The default desk leaves the frame as compose built it.
 * A cue replaces Yooba's line. Paths and keys in that cue are stripped.
 */
export function applyDesk(frame: Broadcast, desk: Desk, lineup: { id: string; name: string }[] = []): Broadcast {
  const reelAll = frame.reel ?? [];
  const next: Broadcast = {
    ...frame,
    also: desk.showPips ? frame.also : [],
    reel: reelAll,
    reelAll,
    takes: frame.takes ?? [],
    desk,
    lineup,
    flash: desk.showFlash ? frame.flash : null,
  };
  if (desk.screen === 'quiet') {
    next.focus = null;
    next.reel = [];
    next.picture = 'quiet';
  } else if (desk.screen === 'take') {
    const hit = (frame.takes ?? []).find((t) => t.job === desk.take) ?? null;
    next.focus = hit;
    next.picture = pictureOf(hit, []);
  } else if (desk.screen === 'reel') {
    next.focus = null;
    next.reel = orderReel(reelAll, desk);
    next.picture = next.reel.length ? 'reel' : 'quiet';
  } else {
    next.picture = pictureOf(frame.focus, reelAll);
  }
  if (desk.cue) next.host = cueLine(desk.cue);
  else if (desk.screen !== 'auto') next.host = hostOf(next.focus, frame.ticker, next.picture === 'reel' ? next.reel : []);
  next.status = statusLine(next);
  return next;
}

/**
 * The whole frame. `product` locks the show to one product; otherwise a live take beats a waiting one,
 * which beats a replay. `priority` breaks ties (and biases the reel) toward earlier products.
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
  priority?: string[];
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
  const priority = input.priority ?? [];
  const pool = lock ? all.filter((t) => t.product === lock) : all;
  const rank = (t: Take) => (t.phase === 'playing' ? 3 : t.phase === 'waiting' ? 2 : 1);
  const ordered = [...pool].sort((a, b) => {
    const r = rank(b) - rank(a);
    if (r) return r;
    return priorityIndex(priority, a.product) - priorityIndex(priority, b.product);
  });
  const focus = ordered[0] ?? null;
  const also = playing.filter((t) => t.job !== focus?.job && (!lock || t.product === lock)).slice(0, 3);
  const takes = ordered.slice(0, 12);

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
  const reel = selectReel(input.library ?? [], { product: lock || undefined, priority });

  const frame: Broadcast = {
    at: now,
    focus,
    also,
    products,
    milestone: ms ? { title: safeLine(ms.title, 80), done: num(ms.done), total: num(ms.total) } : null,
    bars,
    ticker,
    flash,
    reel,
    reelAll: reel,
    takes,
    host: hostOf(focus, ticker, reel),
    disclose: 'Made by AI agents. The host is generated.',
  };
  frame.picture = pictureOf(focus, reel);
  frame.status = statusLine(frame);
  return frame;
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

db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL, by TEXT)`);
const DESK_KEY = 'broadcast.desk';

/** Sick Of It Yooba (decision m_da90c727873c). */
export const YOOBA_VOICE_ID = 'EdDvd8GSdCyZwUcsPawi';
export const YOOBA_VOICE_MODEL = 'eleven_flash_v2_5';
const VOICE_DIR = path.join(DATA, 'broadcast', 'voice');
const VOICE_CURRENT = path.join(DATA, 'broadcast', 'voice-current.mp3');
const VOICE_META = path.join(DATA, 'broadcast', 'voice-current.json');
const VOICE_HASH = /^[a-f0-9]{16,64}$/;
const VOICE_GAP_MS = 60_000;

/** Exact-sentence cache key (sha256 hex, short). */
export function voiceCacheKey(text: string): string {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 24);
}

export function voiceFilePath(key: string): string {
  if (!VOICE_HASH.test(key)) throw new StudioError('voice key');
  return path.join(VOICE_DIR, `${key}.mp3`);
}

function productIds(): string[] {
  return loadProducts().map((p) => p.id);
}

export function readDesk(products = productIds()): Desk {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(DESK_KEY) as { value: string } | undefined;
    return deskFrom(parse(r?.value), products);
  } catch {
    return blankDesk(products);
  }
}

function writeDesk(desk: Desk): Desk {
  db.prepare('INSERT INTO settings (key, value, updated, by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, by = excluded.by')
    .run(DESK_KEY, J(desk), Date.now(), 'desk');
  return desk;
}

/** Set when J presses Say: next broadcast synthesizes immediately. */
let pendingSay = false;
/** Last unique line we paid Gen to speak (rate limit). */
let lastSynthAt = 0;
let lastSynthKey = '';
/** Detect live landing / bug flash for urgent speech. */
let lastFocusJob = '';
let lastFlashId = '';
let lastHostAudio: { key: string; url: string; text: string } | null = null;
let voiceFlight: Promise<string | null> | null = null;

function pointCurrentVoice(key: string, text: string): void {
  try {
    fs.mkdirSync(path.dirname(VOICE_CURRENT), { recursive: true });
    const src = voiceFilePath(key);
    if (!fs.existsSync(src)) return;
    fs.copyFileSync(src, VOICE_CURRENT);
    fs.writeFileSync(VOICE_META, J({ key, text: safeLine(text, 220), at: Date.now(), url: `/api/broadcast/voice/${key}.mp3` }));
  } catch { /* streamer just stays silent */ }
}

/**
 * On-demand Yooba line. Cache hit is free. New unique lines wait ~1 minute unless urgent
 * (live take landing, BUG/MERGED stinger, or director Say). Never batch-generates.
 */
export async function ensureHostAudio(text: string, opts: { urgent?: boolean; voiceOn?: boolean } = {}): Promise<string | null> {
  const line = safeLine(text, 220);
  if (!opts.voiceOn || !line) return null;
  const key = voiceCacheKey(line);
  const file = voiceFilePath(key);
  const url = `/api/broadcast/voice/${key}.mp3`;
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    pointCurrentVoice(key, line);
    lastHostAudio = { key, url, text: line };
    return url;
  }
  if (lastHostAudio?.key === key && lastHostAudio.url) return lastHostAudio.url;
  const urgent = opts.urgent === true;
  if (!urgent && lastSynthKey && lastSynthKey !== key && Date.now() - lastSynthAt < VOICE_GAP_MS) {
    return lastHostAudio?.url ?? null;
  }
  if (voiceFlight) return voiceFlight;
  voiceFlight = (async () => {
    try {
      fs.mkdirSync(VOICE_DIR, { recursive: true });
      const job = await gen.run('audio.voice', {
        project: 'hawkesstudio',
        params: { text: line, voice: YOOBA_VOICE_ID, model: YOOBA_VOICE_MODEL, format: 'mp3_44100_128' },
        labels: { from: 'broadcast', kind: 'host' },
        key: `broadcast-voice-${key}`,
        timeoutMs: 45_000,
      });
      const asset = String(job?.outputs?.[0]?.asset ?? job?.outputs?.[0]?.id ?? '');
      if (!ASSET.test(asset)) return lastHostAudio?.url ?? null;
      await gen.download(asset, file);
      if (!fs.existsSync(file) || fs.statSync(file).size < 64) return lastHostAudio?.url ?? null;
      lastSynthAt = Date.now();
      lastSynthKey = key;
      pointCurrentVoice(key, line);
      lastHostAudio = { key, url, text: line };
      return url;
    } catch {
      return lastHostAudio?.url ?? null;
    } finally {
      voiceFlight = null;
    }
  })();
  return voiceFlight;
}

/** Serves a cached host mp3 (same-origin for the page and the streamer). */
export function readVoiceFile(key: string): string | null {
  const k = String(key ?? '').replace(/\.mp3$/i, '');
  if (!VOICE_HASH.test(k)) return null;
  const file = voiceFilePath(k);
  return fs.existsSync(file) ? file : null;
}

/** Absolute path of the latest host mp3 for ffmpeg (empty when silent). */
export function currentVoicePath(): string | null {
  try {
    if (fs.existsSync(VOICE_CURRENT) && fs.statSync(VOICE_CURRENT).size > 64) return VOICE_CURRENT;
  } catch { /* ignore */ }
  return null;
}

/** Saves a director change. Next and previous use the reel for the product the desk is about to show. */
export async function updateDesk(patch: any, productHint?: string): Promise<Desk> {
  const ids = productIds();
  const cur = readDesk(ids);
  if (patch?.say === true) pendingSay = true;
  const draft = patch?.reset === true ? blankDesk(ids) : patchDesk(cur, { ...patch, nudge: undefined, advance: undefined, say: undefined }, ids);
  const product = draft.product === null ? (productHint || undefined) : (draft.product || undefined);
  const library = await showcaseSources().catch(() => [] as ReelSource[]);
  const pool = selectReel(library, { product, priority: draft.priority });
  const next = patch?.reset === true ? blankDesk(ids) : patchDesk(cur, { ...patch, say: undefined }, ids, pool);
  return writeDesk(next);
}

/** Live frame for the page. Gen being down still returns the roadmap and the ticker. */
export async function broadcastNow(q: { product?: string } = {}): Promise<Broadcast> {
  const lineup = loadProducts().map((p) => ({ id: p.id, name: p.name }));
  const desk = readDesk(lineup.map((p) => p.id));
  const product = desk.product === null ? (q.product || undefined) : (desk.product || undefined);
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
  const frame = applyDesk(
    composeBroadcast({ ...live, changes, milestones, items, product, library, priority: desk.priority }),
    desk,
    lineup,
  );
  const focusJob = frame.focus?.phase === 'playing' ? frame.focus.job : '';
  const flashId = frame.flash?.id || '';
  const urgent = pendingSay
    || (Boolean(focusJob) && focusJob !== lastFocusJob)
    || (Boolean(flashId) && flashId !== lastFlashId);
  pendingSay = false;
  if (focusJob) lastFocusJob = focusJob;
  if (flashId) lastFlashId = flashId;
  frame.say = frame.host;
  if (desk.voice) {
    // Cap wait so a slow Gen does not stall the 2 s poll; a later poll picks up the cache.
    frame.hostAudio = await within(ensureHostAudio(frame.host, { urgent, voiceOn: true }), urgent ? 8_000 : 1_500, lastHostAudio?.url ?? null);
  } else {
    frame.hostAudio = null;
  }
  return frame;
}
