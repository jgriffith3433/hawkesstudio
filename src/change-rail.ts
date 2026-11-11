// A change's progress rail (dashboard/rail.js): started, reading the code, editing, checks, pull request, merged to beta,
// beta built, playtested; each with its state (todo, now, done, failed), the time it got there and a one-line detail
// (the failing check's name, the pull request, the build result). A failed step carries its plain reason.
//
// The first six steps come from the change's own row (status, phase, log, verify), so they are worked out in
// `railState` with no database, and `noteRail` (called from agents.ts update(), the one place every change moves) keeps when
// each step first reached each state (`change_rail`) and pushes a `change-step` event on the dashboard's stream (stream.ts
// `changed`, ids only). The last two come from the beta lane: the beta run that started after the change merged, its
// build and playtest steps (`betaPart`); a write to runs or steps pushes the event for the recently merged changes whose
// rail moved. The page redraws a rail from those events only (no timer): it fetches GET /api/changes/<id>/rail for the ids.
// No polling, and nothing is computed for the beta part while no page is connected.

import { db, onDbWrite, parse } from './db.ts';
import { changed, streamClients } from './stream.ts';
import { isInfra as configInfra } from './config.ts';

db.exec(`CREATE TABLE IF NOT EXISTS change_rail (
  change_id TEXT NOT NULL, step TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT,
  PRIMARY KEY (change_id, step, state)
)`);

export type RailState = 'todo' | 'now' | 'done' | 'failed';
export type RailStep = { key: string; label: string; state: RailState; at: number | null; detail: string; href?: string };

const KEYS = ['started', 'reading', 'editing', 'checks', 'pr', 'merged', 'built', 'played'] as const;
const LABELS: Record<(typeof KEYS)[number], string> = {
  started: 'Started', reading: 'Reading the code', editing: 'Editing', checks: 'Checks', pr: 'Pull request',
  merged: 'Merged to beta', built: 'Beta built', played: 'Playtested',
};

/** One plain line: the first line of a text, cut. */
export const oneLine = (s: unknown, n = 160) => {
  const t = String(s ?? '').split('\n')[0].replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

type Row = Record<string, any>;
const EDIT = /^\S+ tool: (Edit|Write|MultiEdit|NotebookEdit)\b/;
const READ = /^\S+ tool: (Read|Grep|Glob)\b/;

/** What the beta lane did with a merged change (betaPart), or null while there is nothing to say. */
export type BetaPart = {
  built: { state: RailState; at: number | null; detail: string } | null;
  played: { state: RailState; at: number | null; detail: string } | null;
};

/**
 * The rail from a change's row (a SELECT * of `changes`, or the next row update() is about to write), the times its steps
 * were first reached (`seen`: step -> state -> at) and the beta lane's part. Pure.
 */
export function railState(c: Row, seen: Record<string, Record<string, number>> = {}, beta: BetaPart | null = null, infra = false): RailStep[] {
  const phase = parse(c.phase) ?? {};
  const log = ((parse(c.log) ?? []) as string[]).filter((l) => typeof l === 'string');
  const verify = parse(c.verify) ?? {};
  const status = String(c.status ?? '');
  const step = phase.step as string | undefined;
  const edits = log.filter((l) => EDIT.test(l)).length;
  const reads = log.filter((l) => READ.test(l)).length;
  const detail = oneLine(c.detail);
  const merged = status === 'merged';
  const hasPr = Boolean(c.pr);
  // Where the change is, as the index of the step that is current (the ones before it are done).
  const failedAt = (() => {
    if (status === 'failed') {
      if (step && ['publish', 'verify', 'finish'].includes(step)) return 3;
      if (/check|typecheck|test|scan|compile|ci\b/i.test(detail) && edits > 0) return 3;
      return step === 'prepare' ? 1 : 2;
    }
    if (status === 'ready' && ['failed', 'build failed'].includes(String(verify.outcome))) return 3;
    return -1;
  })();
  let now: number;
  if (merged) now = 6;
  else if (status === 'ready') now = hasPr ? 5 : 4;
  else if (status === 'queued' || status === 'closed' || status === 'cancelled') now = 0;
  else if (status === 'verifying' || (step && ['verify', 'finish'].includes(step))) now = 3;
  else if (step === 'publish') now = 3;
  else now = edits > 0 || (step && !['prepare', 'agent'].includes(step)) ? 2 : 1;
  if (status === 'failed') now = failedAt;

  const stateOf = (i: number): RailState => {
    if (failedAt === i) return 'failed';
    if (failedAt >= 0) {
      if (i < failedAt) return 'done';
      if (status === 'ready') return i === 4 ? (hasPr ? 'done' : 'todo') : i === 5 ? 'now' : 'todo';
      return 'todo';
    }
    if (merged && i >= 6) return 'todo'; // the beta lane's part below
    return i < now ? 'done' : i === now ? 'now' : 'todo';
  };
  const out: RailStep[] = KEYS.map((key, i) => ({ key, label: LABELS[key], state: i < 6 ? stateOf(i) : 'todo', at: null, detail: '' }));
  if (infra) { out[5].label = 'Merged to main'; }
  const reason = (i: number, ok: string) => (out[i].state === 'failed' ? detail || 'it stopped here' : out[i].state === 'now' ? detail || ok : ok);

  out[0].detail = status === 'queued' ? detail || 'waiting its turn' : `started by ${c.started_by || 'J'}`;
  out[1].detail = reason(1, out[1].state === 'done' ? (reads ? `${reads} read${reads === 1 ? '' : 's'} and searches` : 'read the code') : 'reading the code');
  out[2].detail = reason(2, out[2].state === 'done' ? `${edits ? `${edits} edit${edits === 1 ? '' : 's'}` : 'edited'}${c.diffstat ? `: ${oneLine(c.diffstat, 80)}` : ''}` : 'making the change');
  out[3].detail = reason(3, out[3].state === 'done' ? oneLine(verify.summary || 'checks passed', 120) : 'checking it');
  if (hasPr) { out[4].detail = `pull request #${c.pr}`; if (c.pr_url) out[4].href = String(c.pr_url); }
  else out[4].detail = out[4].state === 'now' ? 'opening the pull request' : '';
  if (out[4].state === 'now' && hasPr) out[4].detail = `#${c.pr} is open${c.auto_merge === 'trying' ? '; merging into beta by itself' : ''}`;
  const am = String(c.auto_merge ?? '');
  if (status === 'ready' && am.startsWith('failed')) { out[5].state = 'failed'; out[5].detail = oneLine(am.replace(/^failed:\s*/, ''), 160); }
  else if (out[5].state === 'now') out[5].detail = am === 'trying' ? 'merging into beta by itself' : am.startsWith('held') ? oneLine(am.replace(/^held:\s*/, 'waits for you: '), 160) : 'ready: waits for approval';
  else if (merged) out[5].detail = oneLine(c.detail, 120);
  if (infra) { out[6].state = 'todo'; }

  if (merged && !infra) {
    const b = beta?.built, p = beta?.played;
    if (b) { out[6].state = b.state; out[6].at = b.at; out[6].detail = b.detail; }
    else { out[6].state = 'now'; out[6].detail = 'waiting for beta\'s next run'; }
    if (p) { out[7].state = p.state; out[7].at = p.at; out[7].detail = p.detail; }
    else if (out[6].state === 'done') { out[7].state = 'now'; out[7].detail = 'waiting for its playtest'; }
    else if (out[6].state === 'failed') out[7].detail = 'not reached: the build failed';
  }
  // When each step got where it is: the first time it was seen in that state (stored), else the change's own times.
  for (let i = 0; i < 6; i++) {
    const s = seen[KEYS[i]] ?? {};
    out[i].at = out[i].state === 'todo' ? null : (s[out[i].state] ?? (out[i].state === 'done' ? s.now : null) ?? (i === 0 ? c.created ?? null : null) ?? null);
    if (i === 5 && merged) out[i].at = c.merged_at ?? out[i].at;
  }
  const rail = infra ? out.filter((x) => x.key !== 'built' && x.key !== 'played') : out;
  return rail;
}

// ------------------------------------------------------------------------------ stored times

const seenCache = new Map<string, string>();
const getSeen = (id: string) => {
  const m: Record<string, Record<string, number>> = {};
  for (const r of db.prepare('SELECT step, state, at FROM change_rail WHERE change_id = ?').all(id) as { step: string; state: string; at: number }[]) (m[r.step] ??= {})[r.state] = r.at;
  return m;
};

// ------------------------------------------------------------------------------ the beta lane's part

/** The beta run that picked a merged change up (the first beta run of its product started after it merged) and what it did. */
export function betaPart(product: string, mergedAt: number | null): BetaPart | null {
  if (!mergedAt) return null;
  let run: { id: string; status: string; started: number; finished: number | null } | undefined;
  try {
    run = db.prepare(`SELECT id, status, started, finished FROM runs WHERE kind = 'beta' AND started >= ? AND products LIKE ? ORDER BY started LIMIT 1`).get(mergedAt - 5_000, `%"${product}"%`) as any;
  } catch { return null; }
  if (!run) return null;
  const steps = db.prepare('SELECT kind, name, status, detail, started, finished FROM steps WHERE run = ? AND product = ? ORDER BY started').all(run.id, product) as { kind: string; name: string; status: string; detail: string | null; started: number; finished: number | null }[];
  const builds = steps.filter((s) => s.kind === 'build' || (s.kind === 'beta' && s.name === 'prebuild'));
  const plays = steps.filter((s) => s.kind === 'playtest');
  const say = (s: { name: string; status: string; detail: string | null }, ok: string) => (s.status === 'failed' ? oneLine(s.detail || `${s.name} failed`) : s.status === 'done' ? oneLine(s.detail && s.detail !== 'starting' ? s.detail : ok) : s.status === 'skipped' ? oneLine(s.detail || 'skipped') : oneLine(s.detail || 'running'));
  const stateOf = (s: { status: string }): RailState => (s.status === 'failed' ? 'failed' : s.status === 'running' ? 'now' : 'done');
  let built: BetaPart['built'] = null;
  if (builds.length) {
    const bad = builds.find((s) => s.status === 'failed');
    const open = builds.find((s) => s.status === 'running');
    const s = bad ?? open ?? builds[builds.length - 1];
    built = { state: stateOf(s), at: s.finished ?? s.started, detail: say(s, 'built') };
  } else if (plays.length) built = { state: 'done', at: plays[0].started, detail: 'the beta site is up' };
  else if (run.status === 'failed') built = { state: 'failed', at: run.finished, detail: 'the beta run failed before it built' };
  let played: BetaPart['played'] = null;
  if (plays.length) {
    const bad = plays.find((s) => s.status === 'failed');
    const open = plays.find((s) => s.status === 'running');
    const s = bad ?? open ?? plays[plays.length - 1];
    played = { state: stateOf(s), at: s.finished ?? s.started, detail: `${s.name}: ${say(s, 'played')}` };
  }
  return { built, played };
}

type ChangeRow = Row & { id: string; product: string };
const isInfra = (product: string) => { try { return configInfra(product); } catch { return false; } };

/** A change's rail, now (GET /api/changes/<id>/rail, and each row of GET /api/changes). */
export function railOf(c: ChangeRow): RailStep[] {
  const infra = isInfra(c.product);
  const merged = c.status === 'merged';
  return railState(c, getSeen(c.id), merged && !infra ? betaPart(c.product, c.merged_at ?? c.updated ?? null) : null, infra);
}

export function railById(id: string) {
  const c = db.prepare('SELECT * FROM changes WHERE id = ?').get(id) as ChangeRow | undefined;
  return c ? railOf(c) : null;
}

const sigOf = (rail: RailStep[]) => rail.map((s) => `${s.key}:${s.state}:${s.detail}`).join('|');

/**
 * A change moved (agents.ts update(), with the row as it was written): remember when each step first reached its state and
 * tell every page (`change-step`, ids only) when the rail is different from the last one told. Never throws.
 */
export function noteRail(next: ChangeRow) {
  try {
    const infra = isInfra(next.product);
    const seen = getSeen(next.id);
    const rail = railState(next, seen, null, infra);
    const at = Date.now();
    const ins = db.prepare('INSERT OR IGNORE INTO change_rail (change_id, step, state, at, detail) VALUES (?, ?, ?, ?, ?)');
    for (const s of rail) if (s.state !== 'todo' && !seen[s.key]?.[s.state]) ins.run(next.id, s.key, s.state, at, s.detail.slice(0, 300));
    const sig = sigOf(rail);
    if (seenCache.get(next.id) !== sig) {
      seenCache.set(next.id, sig);
      changed('change-step', next.id);
    }
  } catch { /* the rail never stops work */ }
}

// A beta run's steps moved: the recently merged changes whose beta part changed get their event (only while a page is open).
let betaTimer: NodeJS.Timeout | null = null;
const betaSigs = new Map<string, string>();
function betaLook() {
  betaTimer = null;
  if (!streamClients()) { betaSigs.clear(); return; }
  try {
    const rows = db.prepare("SELECT id, product, merged_at, updated FROM changes WHERE status = 'merged' AND COALESCE(merged_at, updated) > ? ORDER BY merged_at DESC LIMIT 40").all(Date.now() - 3 * 86_400_000) as ChangeRow[];
    for (const c of rows) {
      if (isInfra(c.product)) continue;
      const b = betaPart(c.product, c.merged_at ?? c.updated ?? null);
      const sig = JSON.stringify(b);
      if (betaSigs.has(c.id) && betaSigs.get(c.id) !== sig) changed('change-step', c.id);
      betaSigs.set(c.id, sig);
    }
  } catch { /* a table not made yet */ }
}
let started = false;
/** Starts listening for beta runs' writes (server.ts, once). A burst of writes is one look, 800 ms later. */
export function startRailWatch() {
  if (started) return;
  started = true;
  onDbWrite((table) => {
    if ((table === 'steps' || table === 'runs') && streamClients() && !betaTimer) {
      betaTimer = setTimeout(betaLook, 800);
      betaTimer.unref?.();
    }
  });
}
