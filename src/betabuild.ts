// A beta or milestone run of a Unity project that Studio builds (its `builds` list, builds.ts) plays beta's HEAD, so it
// builds that head first, or waits for the build already running, and plays only once that build is published.
// (J, 2026-11-08: Sick of It's milestone check played the build from before #269, "built from GitHub: no checkout
// needed", and every task showed "built OK". Nothing was built.) Waiting is on the build row's own writes (db.ts
// onDbWrite), never a timer; the one timer is the deadline.
import { db, onDbWrite, parse } from './db.ts';
import type { Product } from './config.ts';

type Spec = { id: string; tool?: string; target?: string };

/** The Unity build of a project Studio builds from GitHub (not a product with its own `build` batch): its first unity entry. */
export function unityBuildOf(p: { build?: unknown; builds?: Spec[]; github?: unknown }): Spec | null {
  if (p.build || !p.github) return null;
  return p.builds?.find((b) => b.tool === 'unity') ?? null;
}

export type Row = { id: string; version: number; status: string; sha: string | null; run: string | null; started: number; detail?: string | null; build?: string };

/** What the build rows of one commit say now: published, building (its run still going), failed (after `since`), or nothing. */
export function stateOf(product: string, build: string, sha: string, since = 0): { state: 'ready' | 'building' | 'failed' | 'none'; row?: Row } {
  const rows = db.prepare("SELECT b.id, b.version, b.status, b.sha, b.run, b.started, b.detail, b.build, r.status AS run_status FROM builds b LEFT JOIN runs r ON r.id = b.run WHERE b.product = ? AND b.build = ? AND b.sha = ? AND b.change IS NULL ORDER BY b.started DESC").all(product, build, sha) as (Row & { run_status?: string })[];
  const ready = rows.find((r) => r.status === 'ready');
  if (ready) return { state: 'ready', row: ready };
  const building = rows.find((r) => r.status === 'building' && r.run_status === 'running');
  if (building) return { state: 'building', row: building };
  const failed = rows.find((r) => r.status === 'failed' && r.started >= since);
  return failed ? { state: 'failed', row: failed } : { state: 'none' };
}

/** The newest published (ready) build of a project's unity build: the commit it was made from, and its version. */
export function publishedBuild(product: string, build: string): Row | null {
  return (db.prepare("SELECT id, version, status, sha, run, started, detail, build FROM builds WHERE product = ? AND build = ? AND status = 'ready' AND change IS NULL ORDER BY started DESC, version DESC LIMIT 1").get(product, build) as Row | undefined) ?? null;
}

export type Ensured = { ok: boolean; how: 'already built' | 'built' | 'waited for a build' | 'failed'; sha: string; version: number | null; run: string | null; detail: string };

export type EnsureDeps = {
  /** Beta's head on GitHub. */
  head: () => Promise<string | null>;
  /** Starts the cloud build of that commit (builds.ts startBuild); its `done` may include the build's own playtest. */
  start: (sha: string) => Promise<{ id: string; done: Promise<unknown> } | null>;
  /** The deadline for the whole wait. */
  maxMs?: number;
  /** Test seam: how a listener hears of a write. */
  on?: typeof onDbWrite;
  say?: (s: string) => void;
};

/**
 * Makes sure beta's head is built and published before anything plays it. Already published: nothing to do. Building
 * already (a push's run, the nightly sync): waits for that one, no second Unity build. Else starts it and waits for it.
 * Never throws: `ok: false` says why.
 */
export async function ensureBetaBuild(product: string, build: string, d: EnsureDeps): Promise<Ensured> {
  const say = d.say ?? (() => {});
  const fail = (sha: string, detail: string): Ensured => ({ ok: false, how: 'failed', sha, version: null, run: null, detail });
  let sha: string | null;
  try { sha = await d.head(); } catch (e: any) { return fail('', `couldn't read beta's commit from GitHub: ${String(e?.message ?? e).slice(0, 200)}`); }
  if (!sha) return fail('', "couldn't read beta's commit from GitHub");
  const short = sha.slice(0, 7);
  const t0 = Date.now();
  const first = stateOf(product, build, sha);
  if (first.state === 'ready') return { ok: true, how: 'already built', sha, version: first.row!.version, run: first.row!.run, detail: `beta ${short} is already built and published (${build} ${first.row!.version})` };
  let how: Ensured['how'] = 'built';
  let started: { id: string; done: Promise<unknown> } | null = null;
  if (first.state === 'building') { how = 'waited for a build'; say(`beta ${short} is building already (run ${first.row!.run}): waiting for it`); }
  else {
    try { started = await d.start(sha); } catch (e: any) { return fail(sha, `couldn't start the build of beta ${short}: ${String(e?.message ?? e).slice(0, 300)}`); }
    say(`building beta ${short} in the cloud${started ? ` (run ${started.id})` : ''}`);
  }
  const maxMs = d.maxMs ?? 4 * 3600_000;
  const on = d.on ?? onDbWrite;
  // Conclusive: published, or failed after we asked. A start that ended without a row (refused) is a failure too.
  const verdict = (ended: boolean): Ensured | null => {
    const s = stateOf(product, build, sha!, t0 - 1000);
    if (s.state === 'ready') return { ok: true, how, sha: sha!, version: s.row!.version, run: s.row!.run, detail: `beta ${short} ${how === 'built' ? 'built' : 'was built'} and published (${build} ${s.row!.version}, run ${s.row!.run})` };
    if (s.state === 'failed') return fail(sha!, `the build of beta ${short} failed (${build} ${s.row!.version}): ${String(s.row!.detail ?? 'no reason recorded').slice(0, 300)}`);
    if (ended && s.state === 'none') return fail(sha!, `the build of beta ${short} didn't happen (no build was recorded)`);
    return null;
  };
  return await new Promise<Ensured>((resolve) => {
    let over = false;
    const finish = (r: Ensured) => { if (over) return; over = true; stop(); clearTimeout(deadline); resolve(r); };
    const look = (ended = false) => { const v = verdict(ended); if (v) finish(v); };
    const stop = on((table) => { if (table === 'builds') look(); });
    const deadline = setTimeout(() => finish(fail(sha!, `beta ${short} was still not built after ${Math.round(maxMs / 60_000)} minutes`)), maxMs);
    // The start's own end: a refusal leaves no row; a finished build has been seen by the write listener already.
    void started?.done.then(() => look(true), () => look(true));
    look();
  });
}

// ------------------------------------------------------------------ what a task's build proves

/** GitHub's compare status for merge...built: the built commit contains the merge when it is the same or ahead of it. */
export const containsMerge = (status: string | null | undefined) => status === 'ahead' || status === 'identical';

/** Whether `built` includes `merge` (the task's merge commit), by GitHub's compare API. null: couldn't tell. */
export async function includesMerge(slug: string, merge: string, built: string, gh: (url: string, init?: any) => Promise<Response>): Promise<boolean | null> {
  if (merge === built) return true;
  try {
    const r = await gh(`https://api.github.com/repos/${slug}/compare/${merge}...${built}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hawkes-studio' } });
    if (!r.ok) return null;
    return containsMerge(((await r.json()) as any)?.status);
  } catch {
    return null;
  }
}

/** The commit a beta run's build step says it built or kept (build step data `built`, or `served` for a kept build). */
export function builtBy(run: string, product: string): { sha: string; version: number | null } | null {
  const steps = db.prepare("SELECT status, data FROM steps WHERE run = ? AND product = ? AND kind = 'build' ORDER BY started, rowid").all(run, product) as any[];
  for (const s of steps.reverse()) {
    if (s.status !== 'done' && s.status !== 'skipped') continue;
    const d = parse(s.data);
    const b = d?.built ?? d?.served;
    if (b?.sha) return { sha: String(b.sha), version: b.version ?? null };
  }
  return null;
}

/**
 * Whether a beta run built (or kept) a build that counts as a task's build. A Unity project Studio builds needs a build
 * step with the commit it was made from, and that commit must include the task's merge; the run that only played the last
 * published build is not a build of anything.
 * ok: true counts; why: plain words for the task when not.
 */
export function buildProof(o: { unity: boolean; built: { sha: string } | null; includes: boolean | null }): { ok: boolean; why: string | null } {
  if (!o.unity) return { ok: true, why: null };
  if (!o.built) return { ok: false, why: 'this run built nothing (no build step): it played the last published build, which may predate the merge' };
  if (o.includes === false) return { ok: false, why: `the build it played was made from ${o.built.sha.slice(0, 7)}, which doesn't include this task's merge` };
  if (o.includes === null) return { ok: false, why: `couldn't confirm that the build (${o.built.sha.slice(0, 7)}) includes this task's merge` };
  return { ok: true, why: null };
}

// ------------------------------------------------------------------ a milestone check that checked nothing

/** The playtest steps a run skipped because the build has no such scenario (pipeline.ts skipMissing): they judged nothing. */
export function missingScenarioSkips(run: string, product?: string): { name: string; scenario: string }[] {
  const rows = db.prepare(`SELECT name, status, data FROM steps WHERE run = ? AND kind = 'playtest'${product ? ' AND product = ?' : ''}`).all(...(product ? [run, product] : [run])) as any[];
  return rows.filter((s) => s.status === 'skipped' && parse(s.data)?.missingScenario).map((s) => ({ name: s.name, scenario: String(parse(s.data).missingScenario) }));
}

export type { Product };
