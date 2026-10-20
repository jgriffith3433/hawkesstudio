// The On Air show (J, 2026-10-20): an AI developer and playtester hosting its own studio, live on Twitch, with Yooba
// as the host. It always shows the most interesting thing happening, down a ladder:
//
//   1. playtest   games being played now: it moves between the live takes and talks about what each one tests and
//                 the work that just went into that product
//   2. work       no playtest: the agents' work in progress (what each is building, why, how far it got)
//   3. roadmap    no work: what's planned next, product by product
//   4. showcase   nothing planned: what the studio made (songs, clips, turntables, art) from the Gen library
//
// A higher rung that comes back cuts in (a playtest starting interrupts the showcase). The clock runs here, in Studio,
// so the desk page, the clean capture and the encoder all follow one show. Yooba's lines are written by Claude (Haiku,
// through llm.ts) from the segment's facts, cached per subject, with templates as the fallback; each is spoken through
// Gen audio.voice and paced by its length. Two daily budgets keep it cheap: new lines written, characters spoken.
// Over a budget the show goes on with templates or captions only. Lines are kept on disk per subject and facts (a few
// wordings each, taking turns) and every sentence's mp3 is cached, so the same roadmap aired again costs nothing.
//
// Only titles, steps, statuses and the agents' own notes reach the screen or the prompt, through safeLine (no paths,
// URLs with tokens, keys, prompts or recipes).

import fs from 'node:fs';
import path from 'node:path';
import { listChanges } from './agents.ts';
import { DATA, loadProducts } from './config.ts';
import { J } from './db.ts';
import { gen } from './gen.ts';
import { askClaude } from './llm.ts';
import { jobModel } from './roles.ts';
import { listItems, listMilestones } from './roadmap.ts';
import { listMemories } from './memory.ts';
import { safeLine, speakLine, takeOf, TALK_DEFAULT, WEIGHTS_DEFAULT, type Moment, type Take, type Talk } from './broadcast.ts';
import { HOST_IDS, hostById, hostCard, type Host } from './hosts.ts';

// ------------------------------------------------------------------ types

export type Kind = 'playtest' | 'work' | 'roadmap' | 'showcase' | 'lore';
export const LADDER: Kind[] = ['playtest', 'work', 'roadmap', 'showcase', 'lore'];

/** Recent work that went into a product: what a playtest is checking. */
export type Landed = { title: string; note: string; ago: string };

export type PlaytestCard = Take & { by: string; checks: string; landed: Landed[] };
export type WorkCard = {
  id: string; product: string; productName: string; title: string; status: string; why: string;
  notes: string[]; tools: string[]; criteria: string[]; minutes: number; size: string; still: string | null;
};
export type RoadItem = {
  title: string;
  /** Said on air: in progress, making the art, on beta, verified, planned, idea. Never Studio's internal states. */
  state: string;
  /** Tasks merged of its tasks (0 when none are planned yet): the bar is real, never a placeholder. */
  pct: number;
  /** "2 of 5 tasks done", or '' before it has tasks. */
  tasks: string;
  /** Why it's on the roadmap: the first sentence of the item's why (or goal). */
  why: string;
  /** The task an agent is on right now, if one is. */
  now: string;
  /** Part of the milestone on screen. */
  inMilestone: boolean;
};
export type RoadCard = {
  product: string; productName: string; milestone: string | null; goal: string; done: number; total: number;
  items: RoadItem[];
  /** Tasks merged in the last week, newest first. */
  recent: Landed[];
  /** Items with an agent on them now. */
  working: number;
  still: string | null;
};
export type ShowItem = {
  asset: string; kind: 'song' | 'video' | 'image'; product: string; productName: string; title: string; what: string;
  src: string; seconds: number; cover: string | null; bpm?: number | null; key?: string | null;
};

/**
 * A piece of a product's lore, from the shared memory's canon (the story bible agents, Talk and J keep: docs/memory.md),
 * with what the studio is building for that product now, so the host can say why the work matters to the world.
 */
export type LoreCard = { id: string; product: string; productName: string; title: string; body: string; related: string[]; still: string | null };

export type Rungs = { playtest: PlaytestCard[]; work: WorkCard[]; roadmap: RoadCard[]; showcase: ShowItem[]; lore: LoreCard[] };

export type Line = { text: string; voice: string | null; ms: number };

export type Segment = {
  id: string;
  kind: Kind;
  subject: string;
  started: number;
  /** When the segment may hand over (a cut-in from a higher rung can come sooner). */
  until: number;
  lines: Line[];
  /** The line being said now, and when it started. -1 before the first. */
  at: number;
  lineStarted: number;
  /** Where the lines came from: Claude, the templates, a cue J typed, or nobody (the host sat this one out). */
  by: 'brain' | 'template' | 'cue' | 'silent';
  /** The host on air for this segment. */
  host: string;
  /** The take ended while on screen: its outcome, said once before moving on. */
  wrap?: string;
  /** The card as it was when the segment began (what the screen shows once its subject is gone). */
  card: any;
};

export type ShowState = {
  seg: Segment | null; cursor: Record<Kind, number>; skip: number; history: string[];
  /** Playtests already seen on the board: only a new one cuts in under the shuffle. */
  seenTakes?: string[];
  /** The host on air, since when, and who handed over (the next segment says hello). */
  host?: string; hostSince?: number; handoffFrom?: string;
  /** When the host last started talking (the gap between talking). */
  lastSpoke?: number;
};

export type ShowDesk = {
  screen: string; take: string; clip: string; paused: boolean; voice: boolean; brain: boolean; cue: string; skip: number; product: string | null; priority: string[];
  /** The director's ladder: the rungs that run, highest first (absent: LADDER). A rung left out never goes on screen. */
  ladder?: Kind[];
  /** Seconds each rung holds a subject (absent: DWELL). Songs and clips still hold for their own length. */
  dwell?: Partial<Record<Kind, number>>;
  /** Wordings Yooba keeps per subject before he repeats them (each one voiced once, then free). */
  variety?: number;
  /** shuffle (weighted random pick, the default on the desk) or ladder (the highest rung with something wins). */
  mix?: 'shuffle' | 'ladder';
  weights?: Partial<Record<Kind, number>>;
  /** A new playtest interrupts (shuffle). */
  cutIn?: boolean;
  talk?: Talk;
  hosts?: string[];
  host?: string;
  rotateMin?: number;
};

// ------------------------------------------------------------------ pacing (pure)

/** How long each rung holds one subject, at least. A song or a clip holds for its own length (capped). */
export const DWELL: Record<Kind, number> = { playtest: 45_000, work: 35_000, roadmap: 28_000, showcase: 14_000, lore: 30_000 };
const GAP_MS = 700;
const SONG_CAP_MS = 75_000;

/** Speech length when there's no mp3 to measure: about 14 characters a second. */
export const speakMs = (text: string) => Math.max(1500, Math.round((text.length / 14) * 1000) + 400);

export function dwellFor(kind: Kind, card: any, dwell: Partial<Record<Kind, number>> = {}): number {
  const set = Number(dwell[kind]) > 0 ? Number(dwell[kind]) * 1000 : 0;
  if (kind === 'showcase' && card) {
    const s = Number(card.seconds) || 0;
    if (card.kind === 'song') return Math.min(SONG_CAP_MS, Math.max(30_000, s * 1000));
    if (card.kind === 'video') return Math.max(10_000, Math.min(30_000, s * 1000 || 12_000));
    return set || DWELL.showcase;
  }
  return set || DWELL[kind];
}

/** The highest rung with something on it (or the one the director holds, when it has something). */
export function topRung(r: Rungs, hold?: Kind | null, order: Kind[] = LADDER): Kind {
  if (hold && r[hold]?.length) return hold;
  for (const k of order) if (r[k]?.length) return k;
  return order.includes('showcase') || !order.length ? 'showcase' : order[order.length - 1];
}

export const subjectOf = (kind: Kind, card: any): string =>
  kind === 'playtest' ? String(card?.job ?? '') : kind === 'work' || kind === 'lore' ? String(card?.id ?? '') : kind === 'roadmap' ? String(card?.product ?? '') : String(card?.asset ?? '');

export function cardFor(r: Rungs, seg: Pick<Segment, 'kind' | 'subject'> | null): any {
  if (!seg) return null;
  return ((r[seg.kind] ?? []) as any[]).find((c) => subjectOf(seg.kind, c) === seg.subject) ?? null;
}

/**
 * What's on next. Keeps the current segment until its time is up and its lines are said, unless a higher rung has
 * something (it cuts in), the subject is gone (a take ended: one wrap line first), or the director skipped. Moving on
 * goes round the rung's subjects in order, so every live take and every agent gets its turn.
 */
export type DecideOpt = {
  hold?: Kind | null; holdSubject?: string; skip?: number; order?: Kind[];
  /** shuffle: a weighted random rung each time (J, 2026-10-20: "it should be some sort of random pick between them all"). */
  mix?: 'shuffle' | 'ladder';
  weights?: Partial<Record<Kind, number>>;
  /** shuffle: a playtest that just appeared interrupts (default on). */
  cutIn?: boolean;
  /** 0..1, for tests. */
  rng?: () => number;
};

export function decide(state: ShowState, r: Rungs, now: number, opt: DecideOpt = {}): { kind: Kind; card: any; reason: string } | null {
  const seg = state.seg;
  const order = opt.order?.length ? opt.order : LADDER;
  const top = topRung(r, opt.hold ?? null, order);
  const rank = (k: Kind) => (order.includes(k) ? order.indexOf(k) : order.length);
  const skipped = (opt.skip ?? 0) !== state.skip;
  // A hold on a rung with nothing on it (Playtests held after the take ended) holds nothing: the mix runs as usual.
  const shuffle = opt.mix === 'shuffle' && !(opt.hold && r[opt.hold]?.length);
  const choose = (reason: string) => pick(state, r, shuffle ? shuffleRung(state, r, order, opt.weights, opt.rng) : top, seg, reason);
  if (opt.holdSubject && opt.hold) {
    const held = ((r[opt.hold] ?? []) as any[]).find((c) => subjectOf(opt.hold!, c) === opt.holdSubject);
    if (held && (!seg || seg.subject !== opt.holdSubject)) return { kind: opt.hold, card: held, reason: 'held' };
    if (held && !skipped) return null;
  }
  const midSentence = !!seg && seg.at >= 0 && now < seg.lineStarted + (seg.lines[seg.at]?.ms ?? 0);
  // Under the shuffle only a playtest that wasn't on the board before cuts in (one already running comes up by its
  // weight), so a long playtest doesn't pin the screen to itself.
  const takes = r.playtest.map((c) => c.job);
  const fresh = r.playtest.filter((c) => !(state.seenTakes ?? []).includes(c.job));
  const seenAll = () => { state.seenTakes = takes; };
  if (!seg) { seenAll(); return choose('start'); }
  const card = cardFor(r, seg);
  const speaking = seg.at < seg.lines.length - 1 || midSentence;
  if (skipped) { seenAll(); return choose('skip'); }
  if (shuffle) {
    if (fresh.length && opt.cutIn !== false && seg.kind !== 'playtest' && order.includes('playtest')) {
      if (midSentence) return null;
      seenAll();
      state.cursor.playtest = r.playtest.indexOf(fresh[0]);
      return pick(state, r, 'playtest', null, 'cut-in');
    }
    if (seg.kind === 'playtest' || opt.cutIn === false) seenAll();
  } else if (rank(top) < rank(seg.kind) && !midSentence) {
    // A higher rung came back: cut in after the current sentence.
    return pick(state, r, top, seg, 'cut-in');
  }
  if (!card) return seg.wrap && speaking ? null : choose('gone');
  if (now < seg.until || speaking) return null;
  // Time's up: the ladder stays on the rung (next subject); the shuffle picks again.
  return choose('next');
}

/**
 * The shuffle's pick: rungs that are on and have something, by weight (the desk's 0-10, else WEIGHTS_DEFAULT), with
 * the rung just shown at a third of its weight and one shown twice in the last three at a quarter, so the screen keeps
 * changing even when one rung is heavy. Nothing with weight: the ladder's top.
 */
export function shuffleRung(state: Pick<ShowState, 'history'>, r: Rungs, order: Kind[], weights: Partial<Record<Kind, number>> = {}, rng: () => number = Math.random): Kind {
  const recent = state.history.slice(-3).map((h) => h.split(':')[0]);
  const last = recent[recent.length - 1];
  const scored = order
    .filter((k) => ((r[k] ?? []) as any[]).length)
    .map((k) => {
      let w = Math.max(0, Number(weights[k] ?? WEIGHTS_DEFAULT[k] ?? 0));
      if (k === last) w *= 1 / 3;
      if (recent.filter((x) => x === k).length >= 2) w *= 1 / 4;
      return { k, w };
    })
    .filter((x) => x.w > 0);
  if (!scored.length) return topRung(r, null, order);
  let roll = rng() * scored.reduce((n, x) => n + x.w, 0);
  for (const x of scored) { roll -= x.w; if (roll < 0) return x.k; }
  return scored[scored.length - 1].k;
}

/**
 * Whether the host talks in a segment (pure): the moment must be on; a new host always says hello; otherwise they wait
 * `gapSec` since they last talked, then speak on `chance` percent of segments.
 */
export function talkNow(talk: Talk | undefined, moment: Moment, lastSpoke: number, now: number, roll: number): boolean {
  const t = talk ?? TALK_DEFAULT;
  if (!t.moments?.[moment]) return false;
  if (moment === 'handoff') return true;
  if (lastSpoke && now - lastSpoke < t.gapSec * 1000) return false;
  return roll * 100 < t.chance;
}

/** The moment a segment is: a wrap, a new host's hello, a cut-in, else its rung. */
export const momentOf = (kind: Kind, o: { wrap?: string; cutIn?: boolean; handoff?: boolean }): Moment =>
  o.wrap ? 'wrap' : o.handoff ? 'handoff' : o.cutIn ? 'cutIn' : kind;

/**
 * Who hosts the next segment. One pinned host holds; else the roster takes turns every `rotateMin` minutes (0: never).
 * Changes only at a segment boundary; the newcomer's first segment says hello (`handoffFrom`).
 */
export function nextHost(state: ShowState, desk: Pick<ShowDesk, 'hosts' | 'host' | 'rotateMin'>, now: number): string {
  const roster = (desk.hosts?.length ? desk.hosts : HOST_IDS).filter((h) => HOST_IDS.includes(h));
  const list = roster.length ? roster : HOST_IDS;
  let want = state.host ?? '';
  if (desk.host && HOST_IDS.includes(desk.host)) want = desk.host;
  else if (!want || !list.includes(want)) want = list[0];
  else if ((desk.rotateMin ?? 0) > 0 && list.length > 1 && now - (state.hostSince ?? now) >= (desk.rotateMin ?? 0) * 60_000) {
    want = list[(list.indexOf(want) + 1) % list.length];
  }
  if (want !== state.host) {
    state.handoffFrom = state.host || undefined;
    state.host = want;
    state.hostSince = now;
  }
  return want;
}

function pick(state: ShowState, r: Rungs, kind: Kind, seg: Segment | null, reason: string) {
  const list = (r[kind] ?? []) as any[];
  if (!list.length) return { kind, card: null, reason };
  let i = state.cursor[kind] ?? 0;
  if (seg && seg.kind === kind && list.length > 1) {
    const cur = list.findIndex((c) => subjectOf(kind, c) === seg.subject);
    i = cur >= 0 ? cur + 1 : i;
  }
  i = ((i % list.length) + list.length) % list.length;
  state.cursor[kind] = i;
  return { kind, card: list[i], reason };
}

/** Moves the line cursor on by the clock: each line plays for its length plus a short gap. */
export function advanceLines(seg: Segment, now: number): boolean {
  if (!seg.lines.length) return false;
  if (seg.at < 0) { seg.at = 0; seg.lineStarted = now; return true; }
  const cur = seg.lines[seg.at];
  if (seg.at < seg.lines.length - 1 && now >= seg.lineStarted + (cur?.ms ?? 0) + GAP_MS) {
    seg.at += 1;
    seg.lineStarted = now;
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ Yooba's lines

/**
 * The host's instructions (J, 2026-10-20: "instead of just reading the notes it should be more conversational"). The
 * screen already shows titles and numbers, so the host reacts: their take, what it means for the game and its world
 * (the canon given), why it matters to players, a question to chat now and then, a callback to what they said.
 */
export function hostSystem(host: Host, maxLines = 2): string {
  const n = Math.max(1, Math.min(3, maxLines));
  return [
    `${host.persona} You're hosting Hawkes Studio's live stream on Twitch. The studio is run by AI agents that build and playtest the games of the Hawkes universe around the clock, and you're talking with chat about it.`,
    'Talk about it; never read the screen out. The screen already shows the titles, steps and numbers, so react: give your take, say what it means for the game and its world, why it matters to players, and now and then ask chat something or call back to what you said earlier. One idea, said well, beats a list.',
    `Say ${n === 1 ? 'one short spoken line' : `at most ${n} short spoken lines`}, each under 25 words, in your own voice. Sound like a person talking, not a report.`,
    'Use only the facts and the lore you are given; the lore is canon, so never add to it or change it. Never invent features, numbers, names, dates or results. When something failed, be honest and upbeat. No file paths, URLs, code, keys, model names or prompts. Keep it PG. Do not name real people. Vary how you open, and never introduce yourself unless you are taking over the show.',
  ].join(' ');
}

const SCHEMA = {
  type: 'object',
  properties: { lines: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 } },
  required: ['lines'],
  additionalProperties: false,
};

export type Extra = {
  wrap?: string; cutIn?: boolean; others?: number;
  /** Canon about this product, for context (a lore segment carries its own). */
  lore?: string[];
  /** What the host said in the last few segments: continuity, and no repeats. */
  said?: string[];
  /** The host taking over from this one. */
  handoff?: string;
};

/** The facts for one segment, as plain text for the prompt (and the cache key's signature). */
export function factsOf(kind: Kind, card: any, extra: Extra = {}): string {
  const out: string[] = [];
  if (extra.handoff) out.push(`You are taking over the show from ${extra.handoff}. Say hello to chat briefly, then talk about what's on.`);
  if (extra.cutIn) out.push('This interrupts what was on before: a playtest just started.');
  if (kind === 'playtest' && card) {
    out.push(`On screen: a live playtest of ${card.productName}. A bot is playing the game through real input.`);
    if (card.scenario) out.push(`What it tests: ${card.scenario}.`);
    if (card.checks) out.push(`Why it's playing: ${card.checks}.`);
    if (card.note || card.step) out.push(`Right now: ${card.note || card.step}.`);
    if (card.problems) out.push(`Problems spotted so far on this run: ${card.problems}.`);
    if (card.landed?.length) out.push(`Work that just went into ${card.productName}: ${card.landed.map((l: Landed) => `"${l.title}" (${l.ago})${l.note ? `: ${l.note}` : ''}`).join('; ')}.`);
    if (extra.others) out.push(`${extra.others} other playtest${extra.others === 1 ? ' is' : 's are'} running at the same time.`);
  } else if (kind === 'work' && card) {
    out.push(`On screen: an AI agent working on ${card.productName}. No playtest is running right now.`);
    out.push(`The task: "${card.title}" (${card.status}, ${card.minutes} minute${card.minutes === 1 ? '' : 's'} so far).`);
    if (card.why) out.push(`What was asked: ${card.why}.`);
    if (card.notes?.length) out.push(`The agent's latest notes: ${card.notes.join(' / ')}.`);
    if (card.criteria?.length) out.push(`Done means: ${card.criteria.slice(0, 3).join('; ')}.`);
    if (card.size) out.push(`So far it changed: ${card.size}.`);
    if (extra.others) out.push(`${extra.others} other agent${extra.others === 1 ? ' is' : 's are'} working too.`);
  } else if (kind === 'roadmap' && card) {
    out.push(`On screen: the roadmap for ${card.productName}, straight from the studio's planning board. No playtest is running this minute.`);
    if (card.milestone) out.push(`Next milestone: "${card.milestone}" (${card.done} of ${card.total} items done)${card.goal ? `. Its goal: ${card.goal}` : ''}.`);
    for (const i of card.items ?? []) {
      out.push(`- "${i.title}": ${i.state}${i.tasks ? `, ${i.tasks}` : ''}${i.now ? `; an agent is working on "${i.now}" right now` : ''}${i.why ? `. Why: ${i.why}` : ''}${i.inMilestone ? ' (part of the milestone)' : ''}`);
    }
    if (card.recent?.length) out.push(`Merged this week: ${card.recent.map((r: Landed) => `"${r.title}" (${r.ago})`).join('; ')}.`);
    out.push('Only talk about what is listed here. Do not invent dates, features or numbers.');
  } else if (kind === 'showcase' && card) {
    out.push('On screen: something the studio made with its generative tools. Nothing is planned or running right now, so you are showing off.');
    if (card.kind === 'song') out.push(`A song made for ${card.productName}${card.what ? `, used as ${card.what}` : ''}${card.bpm ? `, ${card.bpm} BPM` : ''}${card.key ? ` in ${card.key}` : ''}. It is playing now.`);
    else if (card.kind === 'video') out.push(`A ${card.what || 'clip'} of ${card.title || 'a character'} from ${card.productName}.`);
    else out.push(`Art from ${card.productName}: ${card.title || card.what || 'a picture'}.`);
  } else if (kind === 'lore' && card) {
    out.push(`On screen: a piece of ${card.productName}'s lore, from the studio's story bible.`);
    out.push(`The lore: ${card.title}. ${card.body}`);
    if (card.related?.length) out.push(`What the studio is building for ${card.productName} right now: ${card.related.join('; ')}.`);
    out.push('Tell chat about this piece of the world in your own words, like a fan who knows it well, and if it fits, why the work going on now matters to it.');
  }
  if (extra.wrap) out.push(`That playtest just finished: ${extra.wrap}. Wrap it up in one line.`);
  if (extra.lore?.length && kind !== 'lore') out.push(`Lore of this game (canon, for context; bring it in only where it fits): ${extra.lore.join(' / ')}`);
  if (extra.said?.length) out.push(`You said recently: ${extra.said.map((s) => `"${s}"`).join(' ')} Don't repeat yourself.`);
  return out.map((l) => safeLine(l, 600)).filter(Boolean).join('\n');
}

/** Lines that need no Claude: always available, used first and whenever the brain is off or over budget. */
export function templateLines(kind: Kind, card: any, extra: Extra = {}): string[] {
  if (extra.wrap) return [`And that run's done: ${extra.wrap}.`];
  if (!card) return ['The studio is catching its breath. Stick around, something always starts.'];
  if (extra.handoff) return [`Hey chat, I'm taking it from here.`];
  if (kind === 'lore') return [`A bit of ${card.productName} lore: ${card.title}.`];
  const hey = extra.cutIn ? 'Oh! Hold on, ' : '';
  if (kind === 'playtest') {
    const lines = [`${hey}${extra.cutIn ? 'a' : 'Live now: a'} bot is playing ${card.productName}${card.scenario ? `, testing ${card.scenario}` : ''}.`];
    if (card.landed?.[0]) lines.push(`This build has "${card.landed[0].title}" in it, so that's what we're checking.`);
    if (card.note || card.step) lines.push(`Right now it's on: ${card.note || card.step}.`);
    return lines.slice(0, 3);
  }
  if (kind === 'work') {
    const lines = [`No playtests this second, so let's peek at the agents. One's working on ${card.productName}: "${card.title}".`];
    if (card.notes?.[0]) lines.push(`Its latest note says: ${card.notes[card.notes.length - 1]}`);
    return lines;
  }
  if (kind === 'roadmap') {
    const active = (card.items ?? []).find((i: RoadItem) => i.now);
    const first = card.items?.[0];
    const fresh = card.recent?.[0];
    return [
      `Here's what's coming for ${card.productName}${card.milestone ? `: the "${card.milestone}" milestone, ${card.done} of ${card.total} done` : ''}.`,
      ...(active ? [`Right now an agent is on "${active.now}", part of "${active.title}".`] : first ? [`Next up on the list: "${first.title}"${first.tasks ? `, ${first.tasks}` : ''}.`] : []),
      ...(fresh ? [`And "${fresh.title}" just merged, ${fresh.ago}.`] : []),
    ];
  }
  if (card.kind === 'song') return [`Quiet floor, so here's a song the studio made for ${card.productName}${card.what ? `, the ${card.what}` : ''}. Turn it up!`];
  if (card.kind === 'video') return [`Check this out: ${card.title || 'one of ours'} from ${card.productName}${card.what ? `, the ${card.what}` : ''}.`];
  return [`Some art the studio made for ${card.productName}${card.title ? `: ${card.title}` : ''}.`];
}

/** Cache key for a segment's lines: the subject and the facts that would change what Yooba says. */
export function scriptKey(kind: Kind, card: any): string {
  const sig = kind === 'playtest' ? [card?.job, card?.step, card?.problems, card?.landed?.[0]?.title]
    : kind === 'work' ? [card?.id, card?.status, card?.notes?.[card?.notes?.length - 1]]
      : kind === 'roadmap' ? [card?.product, card?.milestone, card?.done, card?.items?.map((i: any) => `${i.title}:${i.state}:${i.tasks}:${i.now}`).join(','), card?.recent?.[0]?.title]
        : kind === 'lore' ? [card?.id, card?.related?.[0]]
          : [card?.asset];
  return `${kind}:${sig.map((s) => String(s ?? '')).join('|')}`;
}

/** Canon text as said on air: no file names, internal ids or "J (…):" quotes from the memory's sources. */
export function cleanLore(s: unknown, n = 360): string {
  return safeLine(String(s ?? '')
    .replace(/\([^)]*(?:\/|\\|\.(?:json|md|txt|cs|ts|js|mjs))[^)]*\)/g, '')
    .replace(/\bJ\s*\([^)]*\):\s*/g, '')
    .replace(/\b[qm]_[0-9a-f]{6,}\b/g, '')
    .replace(/\bFighter id [\w-]+\.?\s*/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([,.;:])/g, '$1'), n);
}

/** Strips what a model shouldn't put on a public stream, and the line it should never open with. */
export function cleanLines(lines: unknown, max = 3): string[] {
  if (!Array.isArray(lines)) return [];
  return lines
    .map((l) => safeLine(String(l ?? '').replace(/https?:\/\/\S+/g, '').replace(/^yooba here[.!,]?\s*/i, ''), 200))
    .filter((l) => l.length >= 3)
    .slice(0, Math.max(1, Math.min(3, max)));
}

// ------------------------------------------------------------------ budgets

const USAGE = path.join(DATA, 'broadcast', 'usage.json');
/** Defaults: about 400 new lines written a day (Haiku, cents) and 12,000 new characters spoken (ElevenLabs Flash). */
export const BUDGET = { brainCalls: Number(process.env.STUDIO_SHOW_BRAIN_PER_DAY ?? 400), voiceChars: Number(process.env.STUDIO_SHOW_VOICE_CHARS_PER_DAY ?? 12_000) };
/** reused: segments that took a saved wording (no Claude call); voiceCached: characters spoken from the voice cache (free). */
type Usage = { day: string; brainCalls: number; voiceChars: number; reused: number; voiceCached: number };
const today = () => new Date().toISOString().slice(0, 10);
function usage(): Usage {
  try {
    const u = JSON.parse(fs.readFileSync(USAGE, 'utf8'));
    if (u?.day === today()) return { day: u.day, brainCalls: Number(u.brainCalls) || 0, voiceChars: Number(u.voiceChars) || 0, reused: Number(u.reused) || 0, voiceCached: Number(u.voiceCached) || 0 };
  } catch { /* new day or first run */ }
  return { day: today(), brainCalls: 0, voiceChars: 0, reused: 0, voiceCached: 0 };
}
function spend(patch: Partial<Omit<Usage, 'day'>>) {
  const u = usage();
  const next: Usage = { ...u };
  for (const k of ['brainCalls', 'voiceChars', 'reused', 'voiceCached'] as const) next[k] = u[k] + (patch[k] ?? 0);
  try { fs.mkdirSync(path.dirname(USAGE), { recursive: true }); fs.writeFileSync(USAGE, J(next)); } catch { /* the show goes on */ }
  return next;
}
export const showUsage = () => ({ ...usage(), budget: BUDGET });

// ------------------------------------------------------------------ the facts (Studio + Gen)

const names = () => new Map(loadProducts().map((p) => [p.id, p.name] as [string, string]));
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function ago(ms: number, now = Date.now()): string {
  const m = Math.max(1, Math.round((now - ms) / 60_000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} hour${h === 1 ? '' : 's'} ago` : `${Math.round(h / 24)} days ago`;
}

/** The first plain sentence of an agent's summary (Markdown headings, code and lists dropped). */
export function firstSentence(md: unknown, n = 160): string {
  const text = String(md ?? '')
    .replace(/```[\s\S]*?(```|$)/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(#|```|\||[-*] \[|>)/.test(l))
    .join(' ')
    .replace(/`[^`]*`/g, '')
    .replace(/\*\*?|__/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(text);
  return safeLine(m ? m[1] : text, n);
}

/** What landed on a product's beta lately: the work a playtest of it is checking. */
export function landedFor(changes: any[], product: string, now = Date.now()): Landed[] {
  return changes
    .filter((c) => c.product === product && ['merged', 'verified', 'live'].includes(String(c.status)) && now - num(c.merged_at || c.updated) < 72 * 3600_000)
    .sort((a, b) => num(b.merged_at || b.updated) - num(a.merged_at || a.updated))
    .slice(0, 3)
    .map((c) => ({ title: safeLine(c.title, 90), note: firstSentence(c.summary, 140), ago: ago(num(c.merged_at || c.updated), now) }))
    .filter((l) => l.title);
}

/** An agent's own words from its log ("agent: ...") and the tools it used, newest last. */
export function workNotes(log: unknown): { notes: string[]; tools: string[] } {
  const lines = Array.isArray(log) ? log.map(String) : [];
  const notes: string[] = [];
  const tools: string[] = [];
  for (const l of lines.slice(-80)) {
    const a = /\bagent:\s+(.{4,})$/.exec(l);
    if (a && !/^(stopped|reattached|it reached|runs as)/i.test(a[1])) notes.push(safeLine(a[1], 140));
    const t = /\btool:\s+([A-Za-z]+)/.exec(l);
    if (t) tools.push(t[1]);
  }
  return { notes: notes.slice(-4), tools: tools.slice(-8) };
}

const WORKING = ['working', 'needs answer', 'review'];

export function workCards(changes: any[], stills: Map<string, string>, now = Date.now()): WorkCard[] {
  const n = names();
  return changes
    .filter((c) => WORKING.includes(String(c.status)))
    .slice(0, 8)
    .map((c) => {
      const { notes, tools } = workNotes(c.log);
      const why = safeLine(String(c.request ?? '').replace(/^J[^:]{0,40}:\s*/, '').split('\n')[0], 220);
      return {
        id: String(c.id), product: String(c.product), productName: n.get(String(c.product)) ?? safeLine(c.product, 40),
        title: safeLine(c.title, 100).replace(/^J \([^)]*\):\s*/, ''), status: String(c.status), why, notes, tools,
        criteria: (Array.isArray(c.criteria) ? c.criteria : []).map((x: any) => safeLine(typeof x === 'string' ? x : x?.text ?? x?.criterion ?? '', 120)).filter(Boolean).slice(0, 4),
        minutes: Math.max(1, Math.round((now - num(c.created)) / 60_000)), size: safeLine(c.diffstat ?? '', 80), still: stills.get(String(c.product)) ?? null,
      };
    });
}

/** Studio's item states as said on a public stream (the ones about J's queue or budget stay off air). */
export function publicState(state: string): string {
  if (['working', 'needs you'].includes(state)) return 'in progress';
  if (/gpu/i.test(state)) return 'making the art';
  if (state === 'on beta') return 'on beta';
  if (['verified', 'idea', 'planned'].includes(state)) return state;
  return 'planned';
}
const STATE_RANK: Record<string, number> = { 'in progress': 0, 'making the art': 1, 'on beta': 2, verified: 3, planned: 4, idea: 5 };
const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };

/**
 * One roadmap card per product, from Studio's roadmap as it is: the product's next open milestone (its goal and how many
 * of its items are done) and the items that belong to it first, then the rest of what's planned (work in progress first,
 * then by priority and order; ideas only when there's little else). Each item's bar is its tasks merged; "now" is the
 * task an agent is on. `recent` is what merged for the product this week.
 */
export function roadCards(items: any[], milestones: any[], stills: Map<string, string>, now = Date.now()): RoadCard[] {
  const n = names();
  const byProduct = new Map<string, any[]>();
  for (const i of items) {
    const st = String(i.progress?.state ?? i.status ?? '');
    if (['dropped', 'live', 'done'].includes(st) || i.status === 'dropped') continue;
    const p = String(i.product ?? '');
    if (p) byProduct.set(p, [...(byProduct.get(p) ?? []), i]);
  }
  const cards: RoadCard[] = [];
  for (const [p, list] of byProduct) {
    // The next milestone: the first open one (a reached one is J's to playtest, not what's next).
    const m = milestones.find((x) => x.product === p && x.status === 'open') ?? null;
    const inM = new Set<string>((m?.items ?? []).map((x: any) => String(x.id)));
    const tasksOf = (i: any) => (i.tasks ?? []).filter((t: any) => !['dropped', 'idea'].includes(t.status));
    const rows = list.map((i) => {
      const state = publicState(String(i.progress?.state ?? i.status ?? 'planned'));
      const tasks = tasksOf(i);
      const merged = num(i.progress?.merged);
      const total = num(i.progress?.total) || tasks.length;
      const on = tasks.find((t: any) => t.status === 'working');
      const item: RoadItem = {
        title: safeLine(i.title, 80), state,
        pct: total ? Math.min(1, merged / total) : ['on beta', 'verified'].includes(state) ? 1 : 0,
        tasks: total ? `${merged} of ${total} task${total === 1 ? '' : 's'} done` : '',
        why: firstSentence(i.why || i.goal, 140),
        now: on ? safeLine(on.title, 90) : '',
        inMilestone: inM.has(String(i.id)),
      };
      return { raw: i, item };
    });
    const committed = rows.filter((r) => r.item.state !== 'idea');
    const pool = committed.length >= 2 ? committed : rows;
    pool.sort((a, b) => Number(b.item.inMilestone) - Number(a.item.inMilestone)
      || (STATE_RANK[a.item.state] ?? 9) - (STATE_RANK[b.item.state] ?? 9)
      || (PRIORITY_RANK[a.raw.priority] ?? 1) - (PRIORITY_RANK[b.raw.priority] ?? 1)
      || num(a.raw.ord) - num(b.raw.ord));
    const recent: Landed[] = list.flatMap((i) => (i.tasks ?? []).filter((t: any) => t.merged_at && now - num(t.merged_at) < 7 * 24 * 3600_000))
      .sort((a: any, b: any) => num(b.merged_at) - num(a.merged_at))
      .slice(0, 3)
      .map((t: any) => ({ title: safeLine(t.title, 90), note: '', ago: ago(num(t.merged_at), now) }))
      .filter((l: Landed) => l.title);
    const shown = pool.slice(0, 5).map((r) => r.item);
    if (!shown.length) continue;
    cards.push({
      product: p, productName: n.get(p) ?? p,
      milestone: m ? safeLine(m.title, 80) : null, goal: m ? firstSentence(m.goal, 160) : '',
      done: m ? num(m.done) : 0, total: m ? num(m.total) : 0,
      items: shown, recent, working: rows.filter((r) => r.item.state === 'in progress').length,
      still: stills.get(p) ?? null,
    });
  }
  return cards;
}

/** The take cards: live takes with who asked for them and what just landed in that product. */
export function playtestCards(live: any, changes: any[], now = Date.now()): PlaytestCard[] {
  return (live?.playing ?? [])
    .map((p: any) => {
      const t = takeOf(p, 'playing');
      if (!t) return null;
      const by = p.ctx?.by === 'Agent check' ? 'agent check' : p.ctx?.by === 'Studio run' ? 'studio run' : 'playtest';
      const checks = p.ctx?.changeTitle ? `checking the agent change "${safeLine(String(p.ctx.changeTitle).replace(/^J \([^)]*\):\s*/, ''), 100)}"` : p.ctx?.by === 'Studio run' ? 'the studio\'s regular playtest of the newest build' : '';
      return { ...t, by, checks, landed: landedFor(changes, t.product, now) };
    })
    .filter(Boolean) as PlaytestCard[];
}

/** A finished take's outcome in a few words, for the wrap line. */
export function wrapOf(live: any, job: string): string {
  const f = (live?.finished ?? []).find((x: any) => x.job === job);
  if (!f) return '';
  const n = num(f.problems?.count);
  const out = String(f.outcome ?? f.status ?? 'done');
  return safeLine(`${out === 'pass' || out === 'passed' ? 'it passed' : out === 'error' || f.status === 'failed' ? 'it hit an error' : `it ended: ${out}`}${n ? `, ${n} problem${n === 1 ? '' : 's'} logged` : ', no problems logged'}`, 120);
}

// ------------------------------------------------------------------ lore (the shared memory's canon)

type LoreEntry = { id: string; product: string; title: string; body: string };
let loreMemo: { at: number; book: LoreEntry[] } | null = null;

/** The canon as the show uses it, read every 5 minutes: agents, Talk and J keep it (docs/memory.md), so it stays current. */
export function loreBook(read: () => any[] = () => listMemories({ kind: 'canon', status: 'active', limit: 500 })): LoreEntry[] {
  if (loreMemo && Date.now() - loreMemo.at < 5 * 60_000) return loreMemo.book;
  let rows: any[] = [];
  try { rows = read(); } catch { rows = []; }
  const book = rows
    .map((m) => ({ id: String(m.id), product: String(m.product ?? ''), title: cleanLore(m.title, 100), body: cleanLore(m.body, 360) }))
    .filter((e) => e.title && e.body.length >= 20);
  loreMemo = { at: Date.now(), book };
  return book;
}

const wordsOf = (s: string) => new Set(String(s).toLowerCase().match(/[a-z][a-z']{3,}/g) ?? []);

/** A couple of canon lines for a product that share the most words with `about` (else its first ones), for context. */
export function loreHints(book: LoreEntry[], product: string, about: string, n = 2): string[] {
  const own = book.filter((e) => e.product === product);
  if (!own.length) return [];
  const want = wordsOf(about);
  const scored = own.map((e, i) => ({ e, i, s: [...wordsOf(`${e.title} ${e.body}`)].filter((w) => want.has(w)).length }));
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, n).map(({ e }) => cleanLore(`${e.title}: ${e.body}`, 240));
}

/**
 * One card per canon entry, products taking turns (so the lore rung isn't fifty Yooba Land facts in a row), each with
 * what the studio is building for that product now: its agents' tasks and the roadmap items in progress.
 */
export function loreCards(book: LoreEntry[], work: WorkCard[], road: RoadCard[], pics: Map<string, string>): LoreCard[] {
  const n = names();
  const related = (p: string) => [
    ...work.filter((w) => w.product === p).map((w) => w.title),
    ...(road.find((c) => c.product === p)?.items ?? []).filter((i) => i.state !== 'idea').map((i) => i.title),
  ].filter(Boolean).slice(0, 3);
  const by = new Map<string, LoreEntry[]>();
  for (const e of book) by.set(e.product, [...(by.get(e.product) ?? []), e]);
  const out: LoreCard[] = [];
  const lanes = [...by.values()];
  while (out.length < book.length && out.length < 80) {
    let moved = false;
    for (const lane of lanes) {
      const e = lane.shift();
      if (!e) continue;
      moved = true;
      out.push({
        id: e.id, product: e.product, productName: e.product ? n.get(e.product) ?? e.product : 'the Hawkes universe',
        title: e.title, body: e.body, related: e.product ? related(e.product) : [], still: e.product ? pics.get(e.product) ?? null : null,
      });
    }
    if (!moved) break;
  }
  return out;
}

// The library's showcase (songs, art, clips), refreshed every 10 minutes; stills (a product's newest playtest
// screenshot) every 5. None of it starts a job.
let shelf: { at: number; items: ShowItem[] } | null = null;
let stillMemo: { at: number; map: Map<string, string> } | null = null;

const fileUrl = (asset: string) => `/api/gen/v1/files/${asset}`;
const ASSET = /^a_[0-9a-f]{8,}$/;

export async function stills(): Promise<Map<string, string>> {
  if (stillMemo && Date.now() - stillMemo.at < 5 * 60_000) return stillMemo.map;
  const map = new Map<string, string>();
  const r: any = await gen.assets({ tool: 'playtest.run', kind: 'image', limit: '200' }).catch(() => null);
  for (const a of r?.items ?? []) {
    const p = String(a?.project ?? '');
    if (p && !map.has(p) && ASSET.test(String(a?.id ?? ''))) map.set(p, fileUrl(String(a.id)));
  }
  stillMemo = { at: Date.now(), map };
  return map;
}

const labelText = (labels: any) => {
  if (!labels || typeof labels !== 'object') return '';
  const v = labels.use ?? labels.role ?? labels.clip ?? labels.screen ?? labels.piece ?? '';
  return safeLine(String(v).replace(/[-_]/g, ' '), 40);
};

export async function showcase(reelVideos: { asset: string; product: string; name: string; what: string; src: string }[]): Promise<ShowItem[]> {
  if (shelf && Date.now() - shelf.at < 10 * 60_000) return shelf.items;
  const n = names();
  const covers = await stills();
  const [songs, paint, gen2, pano] = await Promise.all([
    gen.assets({ tool: 'audio.music', kind: 'audio', limit: '80' }).catch(() => null),
    gen.assets({ tool: 'image.paint', kind: 'image', limit: '30' }).catch(() => null),
    gen.assets({ tool: 'image.generate', kind: 'image', limit: '40' }).catch(() => null),
    gen.assets({ tool: 'image.panorama', kind: 'image', limit: '10' }).catch(() => null),
  ]) as any[];
  const items: ShowItem[] = [];
  for (const a of songs?.items ?? []) {
    if (!ASSET.test(String(a?.id ?? ''))) continue;
    const p = a.recipe?.params ?? {};
    items.push({
      asset: a.id, kind: 'song', product: String(a.project ?? ''), productName: n.get(String(a.project)) ?? safeLine(a.project, 40),
      title: 'song', what: labelText(a.labels), src: fileUrl(a.id), seconds: num(p.seconds) || 60, cover: covers.get(String(a.project)) ?? null,
      bpm: num(p.bpm) || null, key: p.key ? safeLine(p.key, 20) : null,
    });
  }
  for (const a of [...(paint?.items ?? []), ...(pano?.items ?? []), ...(gen2?.items ?? [])]) {
    if (!ASSET.test(String(a?.id ?? '')) || a.project === 'hawkesgen') continue;
    const title = a.title && !/^save image$/i.test(a.title) ? safeLine(a.title, 60) : '';
    items.push({ asset: a.id, kind: 'image', product: String(a.project ?? ''), productName: n.get(String(a.project)) ?? safeLine(a.project, 40), title, what: labelText(a.labels) || (a.tool === 'image.panorama' ? 'panorama' : 'art'), src: fileUrl(a.id), seconds: 14, cover: null });
  }
  // The reel's clips carry the product's name, not its id: they show whatever product the show is locked to.
  for (const v of reelVideos) items.push({ asset: v.asset, kind: 'video', product: '', productName: v.product, title: v.name, what: v.what, src: v.src, seconds: 12, cover: null });
  shelf = { at: Date.now(), items: interleave(items) };
  return shelf.items;
}

/** Songs, clips and art taking turns, and products mixed, so the showcase never runs ten pictures in a row. */
export function interleave(items: ShowItem[]): ShowItem[] {
  const lanes: Record<string, ShowItem[]> = { video: [], song: [], image: [] };
  for (const i of items) lanes[i.kind]?.push(i);
  for (const k of Object.keys(lanes)) {
    // Spread products inside a lane: round-robin by product.
    const by = new Map<string, ShowItem[]>();
    for (const i of lanes[k]) by.set(i.product, [...(by.get(i.product) ?? []), i]);
    const out: ShowItem[] = [];
    while (out.length < lanes[k].length) for (const l of by.values()) { const x = l.shift(); if (x) out.push(x); }
    lanes[k] = out;
  }
  const order: ('video' | 'song' | 'image')[] = ['video', 'image', 'song', 'image'];
  const out: ShowItem[] = [];
  let i = 0;
  while (lanes.video.length || lanes.song.length || lanes.image.length) {
    const k = order[i++ % order.length];
    const x = lanes[k].shift();
    if (x) out.push(x);
  }
  return out;
}

// ------------------------------------------------------------------ the running show

const state: ShowState = { seg: null, cursor: { playtest: 0, work: 0, roadmap: 0, showcase: 0, lore: 0 }, skip: 0, history: [] };
/** What the hosts said lately (newest last), for continuity in the next prompt. */
let said: string[] = [];
/**
 * Yooba's lines per subject and facts (scriptKey), kept on disk so a restart or a deploy doesn't make him rewrite (and
 * pay to voice) the roadmap he already said. Each key keeps up to `variety` wordings; once it has them they take turns,
 * and every sentence is already in the voice cache (broadcast.ts speakLine), so a repeat costs nothing. A changed fact
 * (a roadmap item done, a new step) is a new key.
 */
type Script = { at: number; variants: string[][]; next: number };
const SCRIPTS_FILE = path.join(DATA, 'broadcast', 'scripts.json');
const SCRIPTS_MAX = 600;
export const VARIETY_DEFAULT = 3;
const scripts = new Map<string, Script>();
try {
  const saved = JSON.parse(fs.readFileSync(SCRIPTS_FILE, 'utf8'));
  for (const [k, v] of Object.entries(saved ?? {}) as [string, any][]) {
    const variants = (Array.isArray(v?.variants) ? v.variants : []).map(cleanLines).filter((l: string[]) => l.length);
    if (variants.length) scripts.set(k, { at: Number(v.at) || 0, variants, next: Number(v.next) || 0 });
  }
} catch { /* first run */ }
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveScripts() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    while (scripts.size > SCRIPTS_MAX) scripts.delete(scripts.keys().next().value as string);
    try { fs.mkdirSync(path.dirname(SCRIPTS_FILE), { recursive: true }); fs.writeFileSync(SCRIPTS_FILE, J(Object.fromEntries(scripts))); } catch { /* the show goes on */ }
  }, 2_000);
  saveTimer.unref?.();
}

/** The next saved wording for a key, taking turns (and marking it used, newest last for the cap). */
export function takeScript(key: string, variety: number, map = scripts): string[] | null {
  const hit = map.get(key);
  if (!hit || hit.variants.length < Math.max(1, variety)) return null;
  const n = Math.min(hit.variants.length, Math.max(1, variety));
  const lines = hit.variants[hit.next % n];
  hit.next = (hit.next + 1) % n;
  map.delete(key);
  map.set(key, { ...hit, at: Date.now() });
  return lines;
}

/** Keeps a new wording for a key (up to `variety`; past that the oldest goes). */
export function keepScript(key: string, lines: string[], variety: number, map = scripts): void {
  const hit = map.get(key) ?? { at: 0, variants: [], next: 0 };
  const variants = [...hit.variants, lines].slice(-Math.max(1, variety));
  map.delete(key);
  map.set(key, { at: Date.now(), variants, next: hit.next });
}
let seq = 0;

const HOLD: Record<string, Kind> = { take: 'playtest', work: 'work', roadmap: 'roadmap', reel: 'showcase', showcase: 'showcase', lore: 'lore' };

/**
 * Writes the host's lines for a segment: a saved wording, else Claude within budget, else the templates. Saved wordings
 * are per host (Yooba's keys stay as they were, so his saved lines carry over).
 */
async function writeLines(kind: Kind, card: any, extra: Extra, brainOn: boolean, variety = VARIETY_DEFAULT, host: Host = hostById('yooba'), maxLines = 2): Promise<{ lines: string[]; by: Segment['by'] }> {
  const key = scriptKey(kind, card) + (extra.wrap ? `|wrap:${extra.wrap}` : '') + (extra.cutIn ? '|cut' : '') + (extra.handoff ? '|hello' : '') + (host.id === 'yooba' ? '' : `|host:${host.id}`);
  const fit = (l: string[]) => l.slice(0, Math.max(1, maxLines));
  const saved = takeScript(key, variety);
  if (saved) { spend({ reused: 1 }); return { lines: fit(saved), by: 'brain' }; }
  if (brainOn && usage().brainCalls < BUDGET.brainCalls) {
    spend({ brainCalls: 1 });
    try {
      const job: any = await askClaude({
        system: hostSystem(host, maxLines),
        prompt: `${factsOf(kind, card, extra)}\n\nWrite what you say now, as JSON {"lines": [...]}.`,
        schema: SCHEMA, model: jobModel('host'), effort: 'low', maxTokens: 400, timeoutMs: 20_000, purpose: 'broadcast',
      });
      const lines = cleanLines(job?.result?.value?.lines, maxLines);
      if (job?.status === 'done' && lines.length) {
        keepScript(key, lines, variety);
        saveScripts();
        return { lines, by: 'brain' };
      }
    } catch { /* a saved wording, else the templates */ }
  }
  // Out of budget or Claude down: any wording already said for this subject (voiced, so free) beats a template.
  const any = scripts.get(key)?.variants;
  if (any?.length) return { lines: fit(any[Math.floor(Math.random() * any.length)]), by: 'brain' };
  return { lines: fit(templateLines(kind, card, extra)), by: 'template' };
}

/** Voices each line in the host's voice within the day's character budget; over it (or with voice off), captions only. */
async function voice(lines: string[], on: boolean, host = 'yooba'): Promise<Line[]> {
  const out: Line[] = [];
  for (const text of lines) {
    let v: { url: string; ms: number; paid: boolean } | null = null;
    if (on && usage().voiceChars + text.length <= BUDGET.voiceChars) {
      v = await speakLine(text, { host });
      if (v?.paid) spend({ voiceChars: text.length });
      else if (v) spend({ voiceCached: text.length });
    } else if (on) {
      // Over budget: a line already in the cache is still free.
      v = await speakLine(text, { cachedOnly: true, host });
      if (v) spend({ voiceCached: text.length });
    }
    out.push({ text, voice: v?.url ?? null, ms: v?.ms ?? speakMs(text) });
  }
  return out;
}

let flight: Promise<void> | null = null;

/** The product a card is about (for its lore). */
const productOf = (kind: Kind, card: any): string => String(kind === 'showcase' ? card?.product ?? '' : card?.product ?? '');
const aboutOf = (card: any): string => [card?.title, card?.why, card?.scenario, card?.milestone, card?.what, ...(card?.items ?? []).map((i: any) => i.title)].filter(Boolean).join(' ');

/**
 * Starts a new segment. The host on air may change here (rotation). Whether they talk is the desk's talk settings
 * (talkNow); a quiet segment costs nothing: no Claude call, no voice. When they talk, Claude's lines (or a saved wording)
 * are voiced and swapped in when ready.
 */
function begin(kind: Kind, card: any, reason: string, desk: ShowDesk, r: Rungs, wrap?: string) {
  const now = Date.now();
  const hostId = nextHost(state, desk, now);
  const host = hostById(hostId);
  const handoff = state.handoffFrom ? hostById(state.handoffFrom).name : undefined;
  state.handoffFrom = undefined;
  const cutIn = reason === 'cut-in';
  const seg: Segment = {
    id: `seg_${(++seq).toString(36)}_${now.toString(36)}`, kind, subject: subjectOf(kind, card), started: now,
    until: now + (wrap ? 6_000 : dwellFor(kind, card, desk.dwell)), lines: [], at: -1, lineStarted: now, by: 'silent', wrap, card, host: hostId,
  };
  state.seg = seg;
  state.history = [...state.history.slice(-19), `${kind}:${seg.subject}`];
  const talk = desk.talk ?? TALK_DEFAULT;
  if (!talkNow(talk, momentOf(kind, { wrap, cutIn, handoff: !!handoff }), state.lastSpoke ?? 0, now, Math.random())) return;
  state.lastSpoke = now;
  seg.by = 'template';
  const product = productOf(kind, card);
  const extra: Extra = {
    wrap, cutIn, handoff, others: Math.max(0, (r[kind]?.length ?? 1) - 1),
    lore: kind === 'lore' || !product ? undefined : loreHints(loreBook(), product, aboutOf(card)),
    said: said.slice(-3),
  };
  flight = (async () => {
    const { lines, by } = await writeLines(kind, card, extra, desk.brain, desk.variety, host, talk.maxLines);
    const voiced = await voice(lines, desk.voice, host.id);
    if (state.seg !== seg) return;
    seg.lines = voiced;
    seg.by = by;
    seg.at = -1;
    said = [...said, ...lines].slice(-6);
    // A segment's time counts from when the host starts talking, so the lines get said.
    const spoken = voiced.reduce((n, l) => n + l.ms + GAP_MS, 0);
    seg.until = Math.max(seg.until, Date.now() + spoken + 1500);
    state.lastSpoke = Date.now();
  })().finally(() => { flight = null; });
}

let lastCue = '';

/**
 * Advances the show by the clock. Called by every /api/broadcast poll (the page and the encoder); cheap when nothing
 * changes. `say` is J pressing Say: his cue is spoken now, over whatever is on.
 */
export function tick(r: Rungs, desk: ShowDesk, live: any, say = false): void {
  const now = Date.now();
  if (flight) return;
  const seg = state.seg;
  // J's own line: said once, right away, inside the current segment.
  const cue = desk.cue ? safeLine(desk.cue, 200) : '';
  if (cue && (cue !== lastCue || say)) {
    lastCue = cue;
    if (seg) {
      flight = voice([cue], desk.voice, seg.host).then((lines) => {
        if (state.seg !== seg) return;
        seg.lines = lines; seg.at = -1; seg.by = 'cue';
        seg.until = Math.max(seg.until, Date.now() + lines[0].ms + 1500);
      }).finally(() => { flight = null; });
      return;
    }
  }
  if (!cue) lastCue = '';
  if (desk.screen === 'quiet') { if (seg) advanceLines(seg, now); return; }
  const hold = desk.screen && desk.screen !== 'auto' ? HOLD[desk.screen] ?? null : null;
  const holdSubject = desk.screen === 'take' ? desk.take : desk.screen === 'reel' || desk.screen === 'showcase' ? desk.clip : '';
  // A take that ended while on screen gets one wrap line before the show moves on.
  if (seg && seg.kind === 'playtest' && !seg.wrap && !cardFor(r, seg)) {
    const w = wrapOf(live, seg.subject);
    if (w) { begin('playtest', seg.card, 'wrap', desk, r, w); return; }
  }
  const skip = desk.skip !== state.skip;
  const next = decide(state, r, now, { hold, holdSubject, skip: desk.skip, order: desk.ladder, mix: desk.mix, weights: desk.weights, cutIn: desk.cutIn });
  state.skip = desk.skip;
  if (next && (!desk.paused || !seg || skip)) {
    begin(next.kind, next.card, next.reason, desk, r);
    return;
  }
  if (seg) advanceLines(seg, now);
}

/** What the page and the encoder need about the show right now. */
export function showNow(r: Rungs, desk: ShowDesk) {
  const seg = state.seg;
  const card = cardFor(r, seg) ?? seg?.card ?? null;
  const line = seg && seg.at >= 0 ? seg.lines[seg.at] : null;
  const now = Date.now();
  const speaking = !!(line && now < seg!.lineStarted + line.ms);
  const counts = { playtest: r.playtest.length, work: r.work.length, roadmap: r.roadmap.length, showcase: r.showcase.length, lore: r.lore?.length ?? 0 };
  const song = seg?.kind === 'showcase' && card?.kind === 'song' ? card : null;
  const host = hostById(seg?.host ?? state.host ?? desk.host ?? 'yooba');
  return {
    id: seg?.id ?? null,
    kind: desk.screen === 'quiet' ? 'quiet' : seg?.kind ?? 'showcase',
    card,
    wrap: seg?.wrap ?? null,
    caption: line?.text ?? '',
    line: seg && seg.at >= 0 ? { id: `${seg.id}:${seg.at}`, text: line?.text ?? '', voice: line?.voice ?? null, ms: line?.ms ?? 0, started: seg.lineStarted, speaking } : null,
    by: seg?.by ?? 'template',
    host: hostCard(host),
    /** Minutes until the next host takes over (null: no rotation). */
    hostFor: !desk.host && (desk.rotateMin ?? 0) > 0 && (desk.hosts?.length ?? HOST_IDS.length) > 1 && state.hostSince
      ? Math.max(0, Math.ceil(((desk.rotateMin ?? 0) * 60_000 - (now - state.hostSince)) / 60_000)) : null,
    lastSpoke: state.lastSpoke ?? 0,
    music: song ? { id: seg!.id, src: song.src, started: seg!.started } : null,
    counts,
    upNext: upNext(r, seg),
    remaining: seg ? Math.max(0, seg.until - now) : 0,
    usage: showUsage(),
  };
}

/** The other things on the ladder (other live takes first), for the "also live" rail. */
function upNext(r: Rungs, seg: Segment | null) {
  const take = (c: PlaytestCard) => ({ kind: 'playtest', id: c.job, title: c.productName, sub: c.scenario || c.step, stream: c.stream });
  const others = r.playtest.filter((c) => c.job !== seg?.subject).slice(0, 3).map(take);
  const work = r.work.filter((c) => c.id !== seg?.subject).slice(0, 3).map((c) => ({ kind: 'work', id: c.id, title: c.productName, sub: c.title, stream: null }));
  return [...others, ...work].slice(0, 4);
}

/** The director's lineup on top of the rungs: a rung left off the ladder has nothing, the showcase only the kinds asked for. */
export function directed(r: Rungs, opt: { ladder?: Kind[]; showcaseKinds?: string[] } = {}): Rungs {
  const on = (k: Kind) => !opt.ladder || opt.ladder.includes(k);
  const kinds = opt.showcaseKinds;
  return {
    playtest: on('playtest') ? r.playtest : [],
    work: on('work') ? r.work : [],
    roadmap: on('roadmap') ? r.roadmap : [],
    showcase: on('showcase') ? (kinds ? r.showcase.filter((i) => kinds.includes(i.kind)) : r.showcase) : [],
    lore: on('lore') ? r.lore ?? [] : [],
  };
}

/** Every rung's cards, for one poll. Gen being down still leaves the work and the roadmap. */
export async function rungs(live: any, reelVideos: { asset: string; product: string; name: string; what: string; src: string }[], product?: string): Promise<Rungs> {
  const changes = listChanges({ limit: 120 });
  const pics = await stills().catch(() => new Map<string, string>());
  const items = listItems();
  const milestones = listMilestones({ status: 'open,reached' });
  const lock = (x: { product: string }) => !product || !x.product || x.product === product;
  const work = workCards(changes, pics);
  const road = roadCards(items, milestones, pics);
  return {
    playtest: playtestCards(live, changes).filter(lock),
    work: work.filter(lock),
    roadmap: road.filter(lock),
    showcase: (await showcase(reelVideos).catch(() => [] as ShowItem[])).filter(lock),
    lore: loreCards(loreBook(), work, road, pics).filter(lock),
  };
}

/** For tests. */
export function resetShow() {
  state.seg = null;
  state.cursor = { playtest: 0, work: 0, roadmap: 0, showcase: 0, lore: 0 };
  state.skip = 0;
  state.history = [];
  state.seenTakes = undefined;
  state.host = undefined;
  state.hostSince = undefined;
  state.handoffFrom = undefined;
  state.lastSpoke = undefined;
  said = [];
  scripts.clear();
  shelf = null;
  stillMemo = null;
  loreMemo = null;
}
export const showState = () => state;
