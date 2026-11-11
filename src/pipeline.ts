// The daily run (and its pieces, which also run on their own): for each product, check git and run its
// checks, build it if it's a Unity game whose source changed, start its local server, playtest each
// scenario (locally and on the live site), have Claude review each playtest, and add the findings to the
// backlog. Then write the report.
//
// On the server (the beta lane, beta.ts), "local" means beta: the repos are synced to beta, products with a pre-deploy
// build get it committed to beta, Unity products build beta into their beta website copy, and each local playtest
// records the commit it played (step data "played"), which the report and the deploy plan show. "live" stays live.
//
// Products run side by side; Hawkes Gen's queue keeps builds and browser playtests to one at a time.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { db, newId, J, rowToStep, parse, type Step } from './db.ts';
import { resumeGapMs, RESTART_LOOP, RESTART_WINDOW_MS } from './ops.ts';
import { isRateLimited, scheduleRateRetry } from './transient.ts';
import { loadProducts, getProduct, localUrl, today, PROJECTS, betaPlaytestsOn, managedElsewhere, managedNote, StudioError, type Product, type Playtest, type BuildSpec } from './config.ts';
import { unityBuild } from './buildpkgs.ts';
import { endStatus, runCounts, runCancelled, haltOf, jobCancelDetail, runCancelDetail } from './cancel.ts';
import { creditRefusal, holdRun as creditsHold, creditsWaiting } from './creditwait.ts';
import { gen, genRun, genUp, ensureGen } from './gen.ts';
import { ensureServer, gitState, treeFingerprint, runCheck, serveDir, stopServed } from './local.ts';
import { absorb, applyKnown, expireIdeas, notSeenIn, type ReviewMode } from './backlog.ts';
import { feelFindings, feelSensorFindings } from './feel.ts';
import { audioFindings, audioTimelineSummary, enrichAudio, loudnessFromAsset } from './audio.ts';
import { barState, barHash, reviewedSha, reviewParams } from './review.ts';
import { isGame, effectiveBar, qualityFindings } from './quality.ts';
import { funReview } from './fun-review.ts';
import { reviewJob, viaNote } from './review-cc.ts';
import { writeReport } from './report.ts';
import { assetStatus, makeAsset } from './assets.ts';
import { syncRepos, syncRepo, repoMap, betaFolders, isServer, builtFromGitHub, BETA, BRANCH } from './repos.ts';
import { gitAsync, betaLane, prepareBeta, playedLocal, gameVersions, resetBetaSite, pinBetaVersion, pruneGameVersions, saveBetaBuild, betaBuild, betaSiteDir, betaSiteFolder, betaPort, shaOf, repoDirs, fetchOrigin, betaBuildCurrent, siteBaseOf, refreshBetaSite } from './beta.ts';
import { notifyOnce } from './notify.ts';
import { judgeCriteria, sweepFor, type Sweep } from './acceptance.ts';
import { runGenJob, playtestExtras, playtestData, playtestRunMs, REVIEW_RUN_MS, PLAYTEST_IDLE_MS } from './playtests.ts';
import { tagRun } from './followup.ts';
import { betaTurn, newerBetaRun, supersede, absorbed, supersedingBuild } from './betaqueue.ts';
import { holdBeta, waitForBetaPlays, serveBeta, runBetaBuild, servedMismatch } from './betaplay.ts';
import { resolveScenario, missingScenario, noteScenarios, knownScenarios, isRenamedScenario, contractNotReadyNote } from './scenarios.ts';
import { slowNote, playTime } from './pace.ts';
import { planRun, planChange, notePlaying, progressCheck, expectedSeconds } from './runplan.ts';
import { planCarried, settledAsk, askName, lastCleanPass, noRuntimeChange, type Ask } from './playplan.ts';
import { brainId, harnessStopOf, type Harness } from './brains.ts';
import { harnessHeld, holdHarness, onHoldLifted } from './harness-hold.ts';
import { isBillingError } from './llm.ts';
import { kickFollowups } from './followup-kick.ts';
import { NEUTRAL, hookMissing, libraryProject, openFindingCount } from './verdictwork.ts';
import { PLAY_RULE, claimPlay, playsFor, type PlayCause } from './play-policy.ts';

export type RunOptions = {
  products?: string[];
  /** Skip Unity builds (playtest what's already in the website folder). */
  noBuild?: boolean;
  /** Build even when nothing changed. */
  forceBuild?: boolean;
  /** Only these scenarios (e.g. ["smoke"]). */
  scenarios?: string[];
  /** local, live, or both (default). */
  where?: 'local' | 'live' | 'both';
  noReview?: boolean;
  noChecks?: boolean;
  focus?: string;
  /** The Talk conversation that started it: the result is reported there (followup.ts). */
  origin?: string | null;
};

// -------------------------------------------------------------- run state

export function activeRun() {
  return db.prepare(`SELECT * FROM runs WHERE status = 'running' ORDER BY started DESC LIMIT 1`).get() as any;
}
/** The daily run going now, if any (beta, build and playtest runs going beside it don't count). */
export function activeDaily() {
  return db.prepare(`SELECT * FROM runs WHERE status = 'running' AND kind = 'daily' ORDER BY started DESC LIMIT 1`).get() as any;
}
/** A run still "running" this long after it started is one whose process died: a new run may replace it. */
const STALE_RUN_MS = 6 * 3600_000;

// ------------------------------------------------------------ resuming after a restart
//
// A Studio restart (a deploy) doesn't end a run: resumeRuns() runs it again from the top with its steps so far. Each
// startStep finds the step it made before (same product, kind and name, in order) instead of making a new one, and
// resumedStep() says how it was: a finished step is kept and not done again (no second build, playtest or review, no
// findings filed twice), and a step that was running waits for its Hawkes Gen job again (a playtest of a page Studio
// served is played again: its page server stopped with Studio).

/** Runs being resumed: their steps from before the restart, not matched yet. */
const resuming = new Map<string, Step[]>();
/** The steps matched so far: how each was before the restart. */
const resumed = new Map<string, Step>();

/** How a step was before Studio restarted (null: it is new). */
export const resumedStep = (id: string) => resumed.get(id) ?? null;
/** A step that finished before the restart: its work is done. */
const finishedBefore = (id: string) => {
  const was = resumed.get(id);
  return was && was.status !== 'running' ? was : null;
};
/** Whether a run being resumed had made a step of this kind (e.g. its repo syncs). */
const hadSteps = (run: string, kind: string) => (db.prepare('SELECT COUNT(*) AS n FROM steps WHERE run = ? AND kind = ?').get(run, kind) as any).n > 0 && resuming.has(run);

export function startStep(run: string, product: string, kind: string, name: string, detail = '') {
  const list = resuming.get(run);
  const i = list?.findIndex((s) => s.product === product && s.kind === kind && s.name === name) ?? -1;
  if (list && i >= 0) {
    const [was] = list.splice(i, 1);
    resumed.set(was.id, was);
    return was.id;
  }
  const id = newId('s');
  db.prepare('INSERT INTO steps (id, run, product, kind, name, status, detail, started) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, run, product, kind, name, 'running', detail, Date.now());
  return id;
}
export function updateStep(id: string, patch: { status?: string; detail?: string; job?: string; data?: unknown; cost?: number; finished?: boolean }) {
  const cur = db.prepare('SELECT * FROM steps WHERE id = ?').get(id) as any;
  db.prepare('UPDATE steps SET status = ?, detail = ?, job = ?, data = ?, cost = ?, finished = ? WHERE id = ?').run(
    patch.status ?? cur.status, patch.detail ?? cur.detail, patch.job ?? cur.job, patch.data !== undefined ? J(patch.data) : cur.data,
    patch.cost ?? cur.cost, patch.finished ? Date.now() : cur.finished, id,
  );
}

export function getRun(id: string) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as any;
  if (!run) return null;
  const steps = (db.prepare('SELECT * FROM steps WHERE run = ? ORDER BY started').all(id) as any[]).map(rowToStep);
  return { ...run, products: parse(run.products), options: parse(run.options), report: parse(run.report), steps };
}

export function listRuns(limit = 30) {
  // `where` (a playtest run's local or live): the Go live cards tell a playtest of beta from one of the live site.
  return (db.prepare('SELECT id, kind, status, detail, products, options, started, finished, cost FROM runs ORDER BY started DESC LIMIT ?').all(limit) as any[])
    .map(({ options, ...r }) => ({ ...r, products: parse(r.products), ...(r.kind === 'playtest' ? { where: (parse(options) as any)?.where ?? 'local' } : {}) }));
}

/** The latest finished step of a kind for a product (e.g. the last review of a scenario). */
export function lastStep(product: string, kind: string, name: string, before?: string): Step | null {
  const r = db.prepare(`SELECT * FROM steps WHERE product = ? AND kind = ? AND name = ? AND status = 'done' ${before ? 'AND run != ?' : ''} ORDER BY started DESC LIMIT 1`)
    .get(...([product, kind, name, ...(before ? [before] : [])] as [string, ...string[]]));
  return r ? rowToStep(r) : null;
}

// ------------------------------------------------------------------ runs

/**
 * Starts a run in the background; returns its id at once. One run at a time, except a daily run: it goes beside the
 * beta, build and playtest runs (one of those is almost always going, so a daily run that waited for none never started:
 * 0 daily reports, 2026-11) and its playtests share Gen's queue and capacity with theirs. Only another daily blocks it.
 */
export function startRun(kind: string, options: RunOptions = {}) {
  const running = kind === 'daily' ? activeDaily() : activeRun();
  if (running) {
    // A run whose process died stays "running"; let a new one replace it after 6 hours.
    if (Date.now() - running.started < STALE_RUN_MS) throw new Error(`A run is already going (${running.id}, started ${new Date(running.started).toLocaleTimeString()}).`);
    db.prepare(`UPDATE runs SET status = 'abandoned' WHERE id = ?`).run(running.id);
    kickFollowups();
  }
  // A project handed over to another Studio (config.ts managedBy) is left out of every run that wasn't asked for it by
  // name, and out of daily runs even then.
  const products = (options.products?.length ? options.products.map((p) => getProduct(p)).filter((p) => kind !== 'daily' || !managedElsewhere(p)) : loadProducts().filter((p) => !managedElsewhere(p))).map((p) => p.id);
  const id = newId('r');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, kind, 'running', 'starting', J(products), J(options), Date.now());
  tagRun(id, options.origin);
  if (skipForCredits(id, products[0] ?? null)) return { id, done: Promise.resolve() };
  const done = (async () => {
    try {
      await runAll(id, products, options);
    } catch (e: any) {
      db.prepare(`UPDATE runs SET status = 'failed', detail = ?, finished = ? WHERE id = ?`).run(String(e.message ?? e), Date.now(), id);
      kickFollowups();
    }
  })();
  return { id, done };
}

/**
 * Why the scheduled daily run (POST /api/cloud/daily, 05:00) won't start now, or null: another daily run is still
 * going, or today's daily run already finished. Beta, build and playtest runs never stop it (startRun).
 */
export function dailyRefusal(now = Date.now()): { why: string; run: string } | null {
  const going = activeDaily();
  if (going && now - going.started < STALE_RUN_MS) return { why: `the daily run ${going.id} is still going (started ${new Date(going.started).toLocaleTimeString()})`, run: going.id };
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const ran = db.prepare(`SELECT id FROM runs WHERE kind = 'daily' AND status IN ('done', 'partial') AND started >= ? ORDER BY started DESC LIMIT 1`).get(midnight.getTime()) as any;
  if (ran) return { why: `today's daily run ${ran.id} already ran`, run: ran.id };
  return null;
}

/**
 * A daily run that didn't start, said where J and the PM see it: a run row (kind daily, status skipped, its reason as
 * the detail) in Activity and the Reports list, which the PM reads like any finished daily run (pm.ts). Never silent.
 */
export function recordDailySkip(why: string, by = 'the daily schedule') {
  const id = newId('r');
  const now = Date.now();
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'daily', 'skipped', `daily run not started: ${why}`.slice(0, 600), J([]), J({ skipped: true, by }), now, now);
  console.warn(`[studio] daily run not started (${by}): ${why}`);
  kickFollowups();
  return id;
}

/**
 * The scheduled daily run: starts it beside whatever else is going, or says why not (another daily run, today's already
 * done) and records that refusal, or a failure to start, as a skipped daily run.
 */
export function startScheduledDaily(by = 'the daily schedule'): { started: true; id: string; done: Promise<void> } | { started: false; id: string; run: string | null; why: string; failed: boolean } {
  const no = dailyRefusal();
  if (no) return { started: false, id: recordDailySkip(no.why, by), run: no.run, why: no.why, failed: false };
  try {
    const { id, done } = startRun('daily', {});
    return { started: true, id, done };
  } catch (e: any) {
    const why = `it failed to start: ${String(e?.message ?? e)}`;
    return { started: false, id: recordDailySkip(why, by), run: null, why, failed: true };
  }
}

async function runAll(run: string, ids: string[], o: RunOptions) {
  if (!(await genUp()) && !(await ensureGen())) throw new Error('Hawkes Gen is not running and did not start (see hawkesgen/.data/server.err.log).');
  // On the server, start from what's on GitHub (once: a resumed run plays what it synced before the restart).
  if (isServer() && !hadSteps(run, 'repo')) {
    db.prepare('UPDATE runs SET detail = ? WHERE id = ?').run('updating repos from GitHub', run);
    // On Cloud Run the disk is the instance's memory: only the repos this run's products live in (cloned on demand).
    // Never a Unity game's repos there (source or website, up to 8 GB of Game/v* history): Gen builds from GitHub and the
    // beta sites publish from GitHub. Cloning them filled the memory disk until the
    // instance died, every restart resuming the run and cloning again (the daily run, 2026-10-29).
    // A customer cell's Unity project (its builds in `builds`) is left out too (repos.ts builtFromGitHub), said as a
    // skipped step. Any other big repo is synced on the light path (repos.ts syncGit: partial clone, no LFS, no npm ci).
    let only: string[] | undefined;
    if (process.env.K_SERVICE) {
      const folders = new Set<string>();
      for (const pid of ids) {
        const x = getProduct(pid);
        const skip = builtFromGitHub(x);
        if (skip) {
          updateStep(startStep(run, x.id, 'repo', x.repo.split('/')[0] || x.id, 'skipped'), { status: 'skipped', detail: skip, finished: true });
          continue;
        }
        for (const r of [x.repo, x.site]) if (r) folders.add(r.split('/')[0]);
      }
      only = [...folders];
    }
    // Nothing left to sync on Cloud Run is nothing (an empty list would mean every repo to syncRepos).
    const synced = only && !only.length ? [] : await syncRepos(only);
    // Product source repos are on beta (repos.ts); the staging sites (<sub>.hawkesgen.ai) follow it.
    void import('./previews.ts').then(({ previewsAfterSync }) => previewsAfterSync(synced)).catch(() => {});
    for (const r of synced) {
      const s = startStep(run, 'studio', 'repo', r.folder, r.action);
      updateStep(s, { status: r.action === 'failed' ? 'failed' : 'done', detail: `${r.detail}${r.head ? ` (${r.head})` : ''}`, data: r, finished: true });
    }
  }
  const products = ids.map((p) => getProduct(p));
  // A run plays nothing and builds nothing (play-policy.ts, unitybuild-policy.ts; J, 2026-11-11): games are played once
  // on each milestone's build, at its end. So no GPU is started for a run, and Gen's browser cap is left as it is.
  db.prepare('UPDATE runs SET detail = ? WHERE id = ?').run(`running ${ids.length} products`, run);
  await Promise.all(products.map((p) => runProduct(run, p, o).catch((e) => {
    const s = startStep(run, p.id, 'error', 'pipeline');
    updateStep(s, { status: 'failed', detail: String(e.message ?? e), finished: true });
  })));
  // Ideas not seen for 14 days drop off the ideas list (kept as expired); polish never expires (polish.ts).
  const expired = expireIdeas();
  if (expired) {
    const s = startStep(run, 'studio', 'backlog', 'ideas expired');
    updateStep(s, { status: 'done', detail: `${expired} ideas weren't seen for 14 days and expired`, finished: true });
  }
  // Daily runs: how real players do on each live site (the report's "Players" section; the PM files work from it).
  if ((db.prepare('SELECT kind FROM runs WHERE id = ?').get(run) as any)?.kind === 'daily') await recordPlayers(run, ids);
  const cost = (db.prepare('SELECT COALESCE(SUM(cost), 0) AS c FROM steps WHERE run = ?').get(run) as any).c;
  db.prepare(`UPDATE runs SET status = ?, finished = ?, cost = ? WHERE id = ?`).run(endStatus({ ...runCounts(run), failed: 0 }, runCancelled(run)), Date.now(), cost, run);
  kickFollowups();
  // The critic (critic.ts): when it is due for a game of this run; it adds its step and writes the report again.
  if (isServer() && !runCancelled(run)) await import('./critic.ts').then((m) => m.afterRun(run)).catch(() => {});
  const report = writeReport(run);
  db.prepare(`UPDATE runs SET detail = ?, report = ? WHERE id = ?`).run(report.headline, J({ file: report.file, date: report.date }), run);
  // On the server, agents start on the worst new findings (within the day's budget); J approves the results.
  if (isServer() && !runCancelled(run)) {
    const { autoFix } = await import('./agents.ts');
    const started = autoFix(run);
    if (started.length) db.prepare(`UPDATE runs SET detail = ? WHERE id = ?`).run(`${report.headline} · agents started ${started.length} fixes`, run);
    // The weekly polish pass (polish.ts): a game whose last one is a week old gets a change on its worst polish.
    const { startFix, agentSettings } = await import('./agents.ts');
    if ((db.prepare('SELECT kind FROM runs WHERE id = ?').get(run) as any)?.kind === 'daily' && agentSettings().enabled) {
      const { weeklyPolish } = await import('./polish.ts');
      const games = loadProducts().filter((p) => isGame(p) && !managedElsewhere(p));
      const pass = weeklyPolish(games, startFix);
      if (pass.started.length || pass.skipped.length) {
        const s = startStep(run, 'studio', 'backlog', 'polish pass');
        updateStep(s, { status: pass.started.length ? 'done' : 'skipped', detail: [pass.started.length ? `weekly polish pass started for ${pass.started.map((x) => `${x.product} (${x.findings.length} items, ${x.change})`).join(', ')}` : '', ...pass.skipped.map((x) => `${x.product}: ${x.why}`)].filter(Boolean).join('; ').slice(0, 600), data: pass, finished: true });
      }
    }
    // A project that still reads fix-first or broken with nobody on it: a fixer, or one Inbox card saying why (verdictwork.ts).
    void import('./verdictwork.ts').then((m) => m.actOnRun(run)).catch((e) => console.warn(`[studio] verdicts after ${run}: ${e.message ?? e}`));
  }
  // The morning brief (daily runs): a Talk conversation summarizing the report, and a notification linking to it.
  void import('./brief.ts').then(({ morningBrief }) => morningBrief(run)).catch((e) => console.warn(`[studio] morning brief: ${e.message ?? e}`));
}

/**
 * A "players" step per product: Hawkes Gen's analytics of its real players (live, bots and internal left out:
 * players.ts snapshot) in the step's data. Gen not answering or no players is "skipped", never a failed run.
 */
async function recordPlayers(run: string, ids: string[]) {
  const { snapshot, weekLine } = await import('./players.ts');
  // One product at a time: Gen answers analytics queries synchronously on a small server.
  for (const id of ids) {
    const s = startStep(run, id, 'players', 'live', 'asking Hawkes Gen');
    if (finishedBefore(s)) continue;
    try {
      const snap = await Promise.race([snapshot(id), new Promise<never>((_, no) => setTimeout(() => no(new Error('no answer in 2 minutes')), 120_000).unref())]);
      updateStep(s, { status: snap?.hasData ? 'done' : 'skipped', detail: !snap ? 'no player analytics for it in Hawkes Gen' : snap.hasData ? weekLine(snap) : 'no real players on the live site in 30 days', data: snap, finished: true });
    } catch (e: any) {
      updateStep(s, { status: 'skipped', detail: `Hawkes Gen didn't answer: ${String(e.message ?? e).slice(0, 200)}`, finished: true });
    }
  }
}

/** One product's whole pipeline. */
export async function runProduct(run: string, p: Product, o: RunOptions) {
  // Git.
  const g = startStep(run, p.id, 'git', p.repo);
  const repo = gitState(p.repo);
  const site = p.site !== p.repo ? gitState(p.site) : null;
  updateStep(g, { status: 'done', detail: `${repo.branch}: ${repo.dirty} uncommitted, ${repo.ahead} unpushed${site ? `; site ${site.dirty} uncommitted, ${site.ahead} unpushed` : ''}`, data: { repo, site }, finished: true });

  // Checks (tests, typecheck).
  if (!o.noChecks) {
    for (const c of p.checks ?? []) {
      if (runCancelled(run)) return;
      const s = startStep(run, p.id, 'check', c.cmd, c.dir);
      if (finishedBefore(s)) continue;
      const r = await runCheck(c.dir, c.cmd);
      updateStep(s, { status: r.ok ? 'done' : 'failed', detail: r.ok ? `passed in ${r.seconds} s` : `failed (exit ${r.code}) after ${r.seconds} s`, data: r, finished: true });
    }
  }

  // Generated assets the project's manifest lists: report what's missing or out of date (making them costs money,
  // so the daily run only reports; "studio assets <product> make" makes them).
  try {
    const st = assetStatus(p.id);
    if (st.manifest) {
      const need = st.assets.filter((a) => a.status !== 'current');
      const s = startStep(run, p.id, 'assets', 'manifest');
      updateStep(s, { status: 'done', detail: need.length ? `${need.length} of ${st.assets.length} assets need making: ${need.slice(0, 6).map((a) => `${a.id} (${a.status})`).join(', ')}` : `all ${st.assets.length} assets current`, data: st, finished: true });
    }
  } catch (e: any) {
    const s = startStep(run, p.id, 'assets', 'manifest');
    updateStep(s, { status: 'failed', detail: e.message, finished: true });
  }

  // Beta's pre-deploy build (PH Origins' play/, I Can Be's version), committed to beta so what's played is what ships.
  const wantsLocal = o.where !== 'live';
  if (runCancelled(run)) return;
  if (betaLane() && wantsLocal && p.deploy?.prebuild) await prebuildBeta(run, p);

  // No build and no playtest here (play-policy.ts, unitybuild-policy.ts): a run reports on what the milestones' plays found.
}

/**
 * The playtest a beta run plays: the project's own desktop @local playtest, else its first desktop @live one played on
 * beta. Projects whose saved playtests were all @live had nothing to play on beta, so beta runs and the go-live page's
 * "Playtest this commit" played nothing and the go-live stayed blocked (2026-11-01).
 */
export function betaPlaytestOf(p: Product): Playtest | undefined {
  const own = p.playtests.find((y) => y.where === 'local' && y.device !== 'phone');
  if (own) return own;
  const live = p.playtests.find((y) => y.where === 'live' && y.device !== 'phone');
  return live ? { ...live, where: 'local' } : undefined;
}

/** Stale beta checkouts Talk was told about (once per state, not every playtest). */
const staleTold = new Set<string>();

/**
 * On the server, a web product's local playtest serves its source checkout, kept on beta (repos.ts). It is brought to
 * beta's tip first; when it can't follow (uncommitted changes, local commits), the playtest doesn't play the old commit:
 * it fails with what's in the way, and Talk is told (Studio never throws away changes it didn't make; uncommitted
 * changes only in generated build output are a leftover build, discarded by syncRepo; other uncommitted changes are set
 * aside in a stash by syncRepo, so this fires when that fails or for local commits). Null: up to date.
 */
export async function staleBeta(p: Product): Promise<string | null> {
  const top = p.repo.split('/')[0];
  if (!isServer() || p.build || !repoMap()[top] || !betaFolders().has(top)) return null;
  const dir = repoDirs(p).source;
  const r = await syncRepo(top, repoMap()[top], BRANCH, BETA);
  // Packages that didn't install would only serve a page that never loads: the playtest fails with npm's error.
  const broken = r.install?.find((i) => !i.ok);
  if (broken) return `Not playing: npm ci failed in the server's ${BETA} checkout ${broken.dir} (${broken.why}): ${broken.error}`;
  const want = shaOf(dir, `origin/${BETA}`);
  if (!want) return null; // no beta branch yet: the checkout plays main
  const head = shaOf(dir, 'HEAD') ?? '';
  if (head === want && !r.dirty?.length) return null;
  const why = r.dirty?.length ? `uncommitted changes in ${r.dirty.slice(0, 8).join(', ')}` : r.detail;
  const msg = `Not playing an old copy: the server's ${BETA} checkout of ${top} is at ${head.slice(0, 7)} but ${BETA} is at ${want.slice(0, 7)} (${why}).`;
  const key = `${top}:${head}:${want}:${r.dirty?.join(',') ?? ''}`;
  if (!staleTold.has(key)) {
    staleTold.add(key);
    const diff = r.dirty?.length ? spawnSync('git', ['diff', '--stat', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout?.trim().slice(0, 1500) : '';
    void import('./talk.ts').then(({ postNotice }) => postNotice(`${p.name}: beta checkout is stuck`, `${msg}\n\nThe ${p.name} playtests on beta stop until it follows ${BETA} again.${diff ? `\n\n\`\`\`\n${diff}\n\`\`\`` : ''}\n\nOn the server, in /srv/hawkes/${top}: look at the change (git diff). If it is work worth keeping, commit it to ${BETA}; if it is Studio's own leftover (an install or a build), discard it (git checkout -- <files>). The next playtest picks ${BETA} up.`)).catch(() => {});
  }
  return msg;
}

/** Beta's newest commit as the server's clone knows it, after a sync (null when there's no clone or no beta branch). */
async function betaTipOf(p: Product): Promise<string | null> {
  const top = p.repo.split('/')[0];
  if (!repoMap()[top]) return null;
  await syncRepo(top, repoMap()[top], BRANCH, BETA).catch(() => {});
  return shaOf(repoDirs(p).source, `origin/${BETA}`);
}

export const nameOf = (t: Playtest) => `${t.scenario ?? t.mode ?? 'auto'}@${t.where}${t.device === 'phone' ? ':phone' : ''}`;

/** Runs a product's pre-deploy build on beta and commits it there (beta.ts prepareBeta), then syncs the checkout. */
async function prebuildBeta(run: string, p: Product) {
  if (runCancelled(run)) return;
  const s = startStep(run, p.id, 'beta', 'prebuild', p.deploy?.prebuild ?? '');
  if (finishedBefore(s)) return;
  try {
    const r: any = await prepareBeta(p, (d) => updateStep(s, { detail: d }));
    const top = p.repo.split('/')[0];
    if (r.committed && repoMap()[top]) await syncRepo(top, repoMap()[top], BRANCH, BETA);
    updateStep(s, { status: r.committed ? 'done' : 'skipped', detail: r.committed ? `committed the build to ${BETA}: ${String(r.committed).slice(0, 7)}` : r.skipped, data: r, finished: true });
  } catch (e: any) {
    updateStep(s, { status: 'failed', detail: String(e.message ?? e).slice(0, 1000), finished: true });
  }
}

/**
 * Builds a Unity product on the build server if its source changed (or force). On the beta lane the source checkout is
 * on beta and the build lands in the beta website copy (beta.ts), not the real website folder; the beta site follows.
 */
export async function buildProduct(run: string, p: Product, { force = false, beta = false } = {}): Promise<any> {
  if (!p.build) throw new Error(`${p.name} isn't a Unity product`);
  // Resumed after a restart: a build that finished is what it was; one that was running is waited for again.
  const before = db.prepare(`SELECT * FROM steps WHERE run = ? AND product = ? AND kind = 'build' AND name = 'unity'`).get(run, p.id) as any;
  if (before && resuming.has(run)) {
    const s = startStep(run, p.id, 'build', 'unity');
    const was = resumedStep(s)!;
    if (was.status !== 'running') return was.status === 'done' ? { id: was.job, status: 'done', result: was.data } : was.status === 'skipped' ? null : { id: was.job, status: was.status === 'cancelled' ? 'cancelled' : 'failed' };
    if (was.job) return finishBuild(run, p, s, { fp: was.data?.fingerprint ?? treeFingerprint(p.build.project), head: was.data?.beta ?? '', base: was.data?.base ?? '', siteDir: was.data?.siteDir, placeholder: was.data?.placeholder, job: was.job, beta });
  }
  if (runCancelled(run)) {
    const c = startStep(run, p.id, 'build', 'unity');
    updateStep(c, { status: 'cancelled', detail: runCancelDetail(run, 'cancelled before it started'), data: { cancelled: true }, finished: true });
    return { id: null, status: 'cancelled' };
  }
  const fp = treeFingerprint(p.build.project);
  const last = lastStep(p.id, 'build', 'unity');
  const lane = betaLane();
  const head = shaOf(repoDirs(p).source, 'HEAD') ?? '';
  let bb = lane ? betaBuild(p) : null;
  // The website commit the build sits on counts too (the website's beta, else its main): when a page change merged into
  // the website's beta, the copy moves onto it keeping the build (no new Unity build); when it can't, beta is built again.
  let siteBase: string | null = null;
  if (lane && bb?.ok) {
    try { await fetchOrigin(repoDirs(p).site); } catch {}
    siteBase = siteBaseOf(p);
    if (siteBase && bb.base !== siteBase && bb.sha === head) {
      const moved = await refreshBetaSite(p).catch((e: any) => ({ moved: false, why: String(e.message ?? e) }));
      if (moved.moved) {
        bb = betaBuild(p);
        void import('./previews.ts').then(({ buildPreview }) => buildPreview(p.id)).catch(() => {});
      } else console.warn(`[studio] ${p.id}: the beta website copy couldn't move onto the website's ${BETA} (${moved.why}): building again`);
    }
  }
  const current = !lane || betaBuildCurrent(bb, head, siteBase, fs.existsSync(betaSiteFolder(p)));
  if (!force && last?.data?.fingerprint === fp && current) {
    const s = startStep(run, p.id, 'build', 'unity');
    // The build this run's playtests must play (betaplay.ts servedMismatch): the one in the beta website copy.
    const version = lane && bb?.version ? bb.version : last.data?.version;
    updateStep(s, { status: 'skipped', detail: `no changes since the last build (${version ? `Game/v${version}` : 'last time'})`, data: { fingerprint: fp, version, ...(lane && bb?.ok ? { served: { sha: bb.sha, version: bb.version ?? null } } : {}) }, finished: true });
    return null;
  }
  const s = startStep(run, p.id, 'build', 'unity', 'queued on the build server');
  // A beta run (betaqueue.ts): a newer beta run of the product arrived meanwhile, so it builds instead, from scratch.
  const newer = beta ? newerBetaRun(run, p.id) : null;
  if (newer) return { superseded: newer };
  let siteDir: string | undefined;
  let base = '';
  let pin: ReturnType<typeof pinBetaVersion> | undefined;
  if (lane) {
    // Resetting the copy takes the current beta build away: runs still playing it finish first (betaplay.ts).
    const waited = await waitForBetaPlays(p.id, run, (d) => updateStep(s, { detail: d }), haltOf(run));
    if (runCancelled(run)) {
      updateStep(s, { status: 'cancelled', detail: runCancelDetail(run, 'cancelled before it started; not built'), data: { fingerprint: null, cancelled: true }, finished: true });
      return { id: null, status: 'cancelled' };
    }
    if (waited.length) {
      updateStep(s, { detail: 'queued on the build server' });
      const later = beta ? newerBetaRun(run, p.id) : null;
      if (later) return { superseded: later };
    }
    try {
      const copy = await resetBetaSite(p);
      siteDir = path.relative(PROJECTS, copy.folder).replace(/\\/g, '/');
      base = copy.base;
      // Every beta build gets a Game/v<n> never used before (a reused one plays from the browser's cache).
      pin = pinBetaVersion(p, copy.folder);
    } catch (e: any) {
      updateStep(s, { status: 'failed', detail: `the beta website copy: ${e.message}`, finished: true });
      return null;
    }
  }
  // What the build needs if Studio restarts while it runs (the beta website copy is not reset again then).
  updateStep(s, { data: { fingerprint: fp, beta: head, base, siteDir, pinned: pin?.version, placeholder: pin?.placeholder } });
  return finishBuild(run, p, s, { fp, head, base, siteDir, env: pin?.env, placeholder: pin?.placeholder, beta });
}

/** Builds (or waits again for the build job of) a Unity product, and records the result. */
async function finishBuild(run: string, p: Product, s: string, { fp, head, base, siteDir, env, placeholder, job: prior, beta = false }: { fp: string; head: string; base: string; siteDir?: string; env?: Record<string, string>; placeholder?: boolean; job?: string; beta?: boolean }) {
  const lane = betaLane();
  const job = await unityBuild(p.id, { project: p.build!.project, site: p.build!.site, method: p.build!.method, ...(siteDir ? { siteDir } : {}), ...(env ? { env } : {}) }, (j) => updateStep(s, { job: j.id, detail: j.detail }),
    { job: prior, onSubmit: (id) => updateStep(s, { job: id }), log: (m) => updateStep(s, { detail: m }), halt: haltOf(run) });
  // Cancelled while queued by a newer beta run (betaqueue.ts): not a failed build. The last good beta build stays the
  // beta build (nothing saved), and the run ends superseded (betaBody).
  if (beta && job.status === 'cancelled') {
    const newer = newerBetaRun(run, p.id);
    if (newer) return { ...job, superseded: newer };
  }
  // Cancelled (by J, Talk or the PM, or in Gen itself): not built, and not a failure. Nothing is saved as a beta build,
  // so the next push builds again and nothing is blamed (cancel.ts).
  if (job.status === 'cancelled') {
    updateStep(s, { status: 'cancelled', job: job.id, detail: `${jobCancelDetail(job)}; not built`, data: { fingerprint: null, cancelled: true }, finished: true });
    return { ...job, status: 'cancelled' };
  }
  const r = job.result ?? {};
  // A Hawkes Gen without siteDir would have built into the real website folder: that isn't a beta build.
  const stale = Boolean(siteDir && job.status === 'done' && r.site && r.site.folder !== siteDir);
  const ok = job.status === 'done' && !stale;
  const error = stale ? `Hawkes Gen's unity.build ignored siteDir (update Hawkes Gen); the build went to ${r.site.folder}` : ok ? null : String(job.error ?? job.detail ?? 'build failed');
  if (lane && ok && placeholder && siteDir && Number(r.version) > 0) pruneGameVersions(path.join(PROJECTS, siteDir), Number(r.version));
  if (lane) {
    saveBetaBuild(p, { sha: head, base, ok, at: Date.now(), job: job.id, version: r.version ?? null, cost: job.cost ?? r.cost ?? 0, minutes: Math.round((r.seconds ?? 0) / 60), ...(r.packages ? { packages: r.packages } : {}), ...(error ? { error: error.slice(0, 500) } : {}) });
    void import('./previews.ts').then(({ buildPreview }) => buildPreview(p.id)).catch(() => {});
  }
  updateStep(s, {
    status: ok ? 'done' : 'failed', job: job.id, cost: job.cost ?? r.cost ?? 0,
    detail: ok ? `built ${lane ? `${BETA} ${head.slice(0, 7)} ` : ''}${r.version ? `Game/v${r.version}` : ''} in ${Math.round((r.seconds ?? 0) / 60)} min ($${(r.cost ?? 0).toFixed(2)})` : `failed: ${error}`,
    data: { ...r, fingerprint: ok ? fp : null, error, ...(lane ? { beta: head, siteDir } : {}), ...(lane && ok ? { served: { sha: head, version: r.version ?? null } } : {}) }, finished: true,
  });
  return ok ? job : { ...job, status: 'failed' };
}

/** Runs a Unity product's tests on the build server (so J's editor can stay open). */
export async function testProduct(run: string, p: Product, platform: 'EditMode' | 'PlayMode', category?: string) {
  if (!p.build) throw new Error(`${p.name} isn't a Unity product`);
  if (runCancelled(run)) return { id: null, status: 'cancelled' };
  const s = startStep(run, p.id, 'check', `unity ${platform}${category ? ` ${category}` : ''}`, 'queued on the build server');
  const was = resumedStep(s);
  if (was && was.status !== 'running') return { id: was.job, status: was.status === 'done' ? 'done' : 'failed', result: was.data };
  const job = await genRun('unity.test', p.id, { project: p.build.project, platform, ...(category ? { category } : {}) }, (j) => updateStep(s, { job: j.id, detail: j.detail }), undefined,
    { job: was?.job ?? undefined, onSubmit: (id) => updateStep(s, { job: id }), halt: haltOf(run) });
  if (job.status === 'cancelled') {
    updateStep(s, { status: 'cancelled', job: job.id, detail: jobCancelDetail(job), finished: true });
    return job;
  }
  const r = job.result ?? {};
  const ok = job.status === 'done' && !r.failed;
  updateStep(s, {
    status: ok ? 'done' : 'failed', job: job.id, cost: job.cost ?? r.cost ?? 0,
    detail: job.status === 'done' ? `${r.passed}/${r.total} passed${r.failed ? `, ${r.failed} failed: ${r.failures.slice(0, 3).map((f: any) => f.name.split('.').pop()).join(', ')}` : ''}` : `failed: ${job.error ?? job.detail}`,
    data: { ...r, tail: (r.failures ?? []).map((f: any) => `${f.name}: ${f.message}`).join('\n') }, finished: true,
  });
  return job;
}

/**
 * A contract game's page, with an empty `?playtest=`: pages that load their playtest bot only for a browser under
 * automation (Hawkes Games loads public/playtest/portal.js for navigator.webdriver or `?playtest=`) load it under Gen's
 * playtester too, which doesn't show as automated (2026-11-01: "The page never exposed window.hawkesPlaytest").
 * Web games only: the runner starts a Unity page with its own `?playtest=<id>`. Empty never starts a scenario by itself (the contract's `?playtest=<id>`, docs/playtest.md), and visitors never get it.
 */
export function withPlaytestHint(url: string): string {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || u.searchParams.has('playtest')) return url;
    u.searchParams.set('playtest', '');
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Plays one scenario and (unless review is false) has Claude review it; adds findings to the backlog. mode (review.ts):
 * full (daily; regression-only once the scenario meets the product's quality bar), verify (beta runs, one-off checks),
 * regression (live checks). criteria: a roadmap task's acceptance criteria, judged on this playtest.
 */
export async function playtestProduct(run: string, p: Product, asked: Playtest, opts: PlayOptions = {}) {
  try {
    return await playScenario(run, p, asked, opts);
  } finally {
    await progressCheck(run);
  }
}
type PlayOptions = { review?: boolean; focus?: string; mode?: ReviewMode; criteria?: string[]; abandon?: () => string | null; slot?: number; priority?: number;
  /** Merged tasks' criteria this play's review judges too (acceptance.ts sweepFor): never a reason to review it again. */
  sweep?: Sweep | null };

async function playScenario(run: string, p: Product, asked: Playtest, opts: PlayOptions = {}) {
  const { review = true, focus, mode = 'full', criteria, abandon, slot = 0, priority, sweep } = opts;
  // A renamed scenario (an older task's name) plays under the game's current name (products.json scenarioAliases).
  const renamed = asked.scenario ? resolveScenario(p, asked.scenario) : undefined;
  const t: Playtest = renamed && renamed !== asked.scenario ? { ...asked, scenario: renamed } : asked;
  const name = nameOf(t);
  const s = startStep(run, p.id, 'playtest', name, renamed !== asked.scenario ? `starting (asked for "${asked.scenario}", now "${renamed}")` : 'starting');
  // Not in the run's starting list: a line says which and why (runplan.ts).
  notePlaying(run, p.id, name, renamed !== asked.scenario ? `the game renamed "${asked.scenario}" to "${renamed}"` : 'it was not in the starting list (the run took it up while going)');
  // Resumed after a restart: a playtest that finished is kept (its review carries on); one that was waiting in Gen's
  // queue is waited for again. A local one that was playing lost its page server (it stopped with Studio): it's
  // played again. A live one plays a site Studio doesn't serve: waited for again.
  const was = resumedStep(s);
  if (was && was.status !== 'running') {
    if (was.status !== 'done' || !review || !was.job) return was.job ? { id: was.job, status: was.status } : null;
    const job = await gen.job(was.job).catch(() => null);
    if (!job || job.status !== 'done') return job;
    if (job.result?.software && p.engine !== 'static') return job;
    return reviewPlaytest(run, p, t, job, was.data?.played ?? null, { focus, mode, criteria, sweep });
  }
  // A run that has been going past its total cap plays no more scenarios: the rest are skipped with the reason, and J's phone is told once.
  const over = runOverCap(run);
  if (over && !was?.job) {
    updateStep(s, { status: 'skipped', detail: over.message, data: { runCap: over.capMin }, finished: true });
    void notifyOnce(`runcap:${run}`, 24 * 3600_000, `Run stopped playing: ${p.name}`, `${over.message} (run ${run})`, { priority: 4, tags: ['hourglass'] });
    return null;
  }
  if (runCancelled(run) && !was?.job) {
    updateStep(s, { status: 'cancelled', detail: runCancelDetail(run, 'cancelled before it started'), data: { cancelled: true }, finished: true });
    return null;
  }
  let prior: any = null;
  if (was?.job) {
    prior = await gen.job(was.job).catch(() => null);
    if (prior && t.where === 'local' && !['queued', 'done'].includes(prior.status)) {
      if (prior.status === 'running') await gen.cancel(prior.id).catch(() => {});
      updateStep(s, { detail: 'played again: its page server stopped when Studio restarted' });
      prior = null;
    }
  }
  let url: string;
  // On the server a web product's local playtest plays its beta checkout, which must be beta's tip: never an old copy.
  const stale = t.where === 'local' && !prior ? await staleBeta(p) : null;
  if (stale) {
    updateStep(s, { status: 'failed', detail: stale, data: { played: playedLocal(p), stale: true }, finished: true });
    return null;
  }
  // Unity on the beta lane plays the beta website copy: held while it plays (a newer build waits), one playtest of it at
  // a time (they share its port), and only the build this run built or kept (betaplay.ts).
  const unityBeta = Boolean(p.build && betaLane() && t.where === 'local' && prior?.status !== 'done');
  const release = unityBeta ? holdBeta(p.id, run) : null;
  // Parallel plays of one run (slot 1, 2…: betaBody) serve the same copy on their own ports, so they don't take turns.
  const unlock = unityBeta ? await serveBeta(slot ? `${p.id}#${slot}` : p.id) : null;
  const free = () => { unlock?.(); release?.(); };
  let job: any;
  let played: ReturnType<typeof playedLocal> = null;
  try {
    const now = unityBeta ? playedLocal(p) : null;
    // Local: what's played (beta on the server) is recorded, so the report and the deploy plan know the commit.
    played = t.where === 'local' ? (was?.data?.played ?? (unityBeta ? now : playedLocal(p))) : null;
    // A game added through Talk plays its published beta site: what's played is the commit that site was built from,
    // not this instance's clone (2026-10-31: Star Skipper's beta playtest said it played main, the starter).
    // Any project whose local playtest plays the published beta site, github or not (2026-11-09: Imagine Live TV said it
    // played the server's beta checkout, but played its published site, which lagged the push).
    if (t.where === 'local' && !was?.data?.played && !prior && !p.build && !siteBuildPublish(p.builds) && (await cloudBetaUrl(p))) {
      // The published site must be beta's tip (servedpage.ts ensurePublishedCurrent): behind, it is published again and
      // that is what's played; still behind, the verdict is stale (step stale + wrongBuild: no findings, no fixers).
      const previews = await import('./previews.ts');
      await previews.betaSettled(p.id);
      const cur = await (await import('./servedpage.ts')).ensurePublishedCurrent({
        tip: await betaTipOf(p), published: () => previews.betaPreview(p.id)?.sha, republish: async () => { await previews.buildPreview(p.id); },
      });
      if (!cur.ok) {
        console.warn(`[studio] ${p.id} ${name} (${run}): ${cur.why}`);
        updateStep(s, { status: 'failed', detail: cur.why, data: { stale: true, wrongBuild: true, published: cur.published, tip: cur.tip }, finished: true });
        return null;
      }
      if (cur.republished) updateStep(s, { detail: `the beta site was behind ${BETA}: published again` });
    }
    if (t.where === 'local' && !was?.data?.played && (p.github || !p.build) && (await cloudBetaUrl(p))) {
      const v = (await import('./previews.ts')).betaPreview(p.id);
      if (v?.sha && v.status === 'ready') played = { branch: BETA, sha: v.sha, title: v.ref };
      // A Unity project Studio builds: what's played is the commit the published build was made from (its row's full sha),
      // which can be older than beta's head; the report names it as that (betabuild.ts).
      const BB = await import('./betabuild.ts');
      const ub = BB.unityBuildOf(p);
      const pub = ub ? BB.publishedBuild(p.id, ub.id) : null;
      if (pub?.sha) played = { branch: BETA, sha: pub.sha, title: `${ub!.id} ${pub.version}`, madeFrom: true };
    }
    // A web app its own CI deploys (Product.versionPath): what's played is the commit its beta says it runs.
    if (t.where === 'local' && !was?.data?.played && p.versionPath) {
      const d = await (await import('./deployed.ts')).deployedOf(p, 'beta');
      if (d?.commit) played = { branch: BETA, sha: d.commit, title: `deployed beta${d.version ? ` ${d.version}` : ''}` };
    }
    const build = played ? String(played.build ?? played.sha) : null;
    // Never twice on the same build (play-policy.ts): a scenario that already played to an end on this build, or is
    // being played on it by another run now, is not played again, whoever asked; that play's result stands.
    const before = !prior && !was?.job ? claimPlay(p.id, build, name, s, run) : null;
    if (before) {
      updateStep(s, { status: 'skipped', detail: `${before.status === 'running' ? 'being played on this build' : 'already played on this build'} (run ${before.run}${before.detail && before.status !== 'running' ? `: ${before.detail}` : ''}); ${PLAY_RULE}`.slice(0, 600), data: { played, sameAs: before }, finished: true });
      return null;
    }
    // A scenario this build is known not to have is skipped, not played (scenarios.ts).
    const serveDirOf = path.join(betaSiteDir(p), path.relative(p.site.split('/')[0], p.local.dir));
    const wrong = unityBeta ? servedMismatch(runBetaBuild(run, p.id), now, gameVersions(serveDirOf)) : null;
    if (wrong) {
      console.warn(`[studio] ${p.id} ${name} (${run}): ${wrong}`);
      updateStep(s, { status: 'failed', detail: wrong, data: { played: now, expected: runBetaBuild(run, p.id), wrongBuild: true }, finished: true });
      return null;
    }
    // When this step's job first ran (before a restart): its run time counts from then.
    const since = Number(was?.data?.runningSince) || undefined;
    let port: number | null = null;
    // What installing the local server's packages logged ("dependencies changed: npm ci"): kept on the step.
    const deps: string[] = [];
    try {
      if (t.where === 'live') {
        url = p.live;
        // A library whose "live" is its GitHub page has nothing to play there: its beta demo is the product (config.ts saveProduct).
        const demo = isRepoPage(p.live) ? await cloudBetaUrl(p) : null;
        if (demo) url = demo;
      }
      else if (prior?.status === 'done') url = was?.data?.url ?? localUrl(p);
      else if (p.build && betaLane() && !played) throw new Error(`${BETA} isn't built yet (or its last build failed): nothing to play locally`);
      else if (await cloudBetaUrl(p)) {
        // A beta publish in flight (this product's, or the website its build publishes into) finishes, and its check that
        // the Worker serves it passes, before the playtest opens the site (2026-11-04: it raced the publish and got 404s).
        const previews = await import('./previews.ts');
        const into = siteBuildPublish(p.builds);
        await Promise.all([previews.betaSettled(p.id), ...(into ? [previews.betaSettled(into.project)] : [])]);
        url = (await cloudBetaUrl(p))!;
      }
      else if (p.build && betaLane()) {
        // Unity on the beta lane: the beta build, from its own website copy, on its own port.
        if (!played) throw new Error(`${BETA} isn't built yet (or its last build failed): nothing to play locally`);
        port = betaPort(p) + 1000 * slot;
        stopServed(port);
        url = await serveDir(p, serveDirOf, port);
      } else url = await ensureServer(p, (m) => { deps.push(m); updateStep(s, { detail: m }); });
    } catch (e: any) {
      updateStep(s, { status: 'failed', detail: e.message, data: { played, ...(deps.length ? { deps } : {}) }, finished: true });
      return null;
    }
    updateStep(s, { data: { played, url, ...(deps.length ? { deps } : {}), ...(since ? { runningSince: since } : {}) } });
    // The page must be the commit the report names: a beta site that lags the push says so and isn't judged.
    if (t.where === 'local' && !prior && played && !unityBeta) {
      const off = await (await import('./servedpage.ts')).checkServedPage(url, played);
      if (off) {
        console.warn(`[studio] ${p.id} ${name} (${run}): ${off}`);
        if (port) stopServed(port);
        updateStep(s, { status: 'failed', detail: off, data: { played, url, wrongBuild: true }, finished: true });
        void import('./previews.ts').then((m) => m.buildPreview(p.id)).catch(() => {});
        return null;
      }
    }
    // A scenario this copy is known not to have is skipped, not played (scenarios.ts). The list is the one seen at this
    // page of this build, so a list from another page (the lore site's root) never skips the game's scenarios.
    const has = t.where === 'local' && t.scenario && !prior ? knownScenarios(p.id, build, url) : null;
    if (isRenamedScenario(has, t.scenario!)) {
      if (port) stopServed(port);
      return skipMissing(run, p, s, asked, t.scenario!, has!, played);
    }
    // Live sites may not have the contract yet (it ships with the next deploy): auto falls back to a generic smoke test.
    const params: Record<string, unknown> = { url, mode: t.mode ?? (p.contract && t.where === 'local' ? 'contract' : 'auto'), ...(t.scenario ? { scenario: t.scenario } : {}), ...(t.timeout ? { timeout: t.timeout } : {}), ...(t.seed ? { seed: t.seed } : {}), ...(playOptions(t) ? { options: playOptions(t) } : {}) };
    if (t.mode === 'site') params.maxPages = 40;
    if (p.contract && p.engine === 'web' && (params.mode === 'contract' || params.mode === 'auto')) params.url = withPlaytestHint(String(params.url));
    Object.assign(params, playtestExtras(p.id, name, t));
    // An app behind a sign-in (Product.testSignIn): on its beta, the playtest starts signed in as a test account.
    if (t.where === 'local' && (p.testSignIn?.url || (await import('./playtest-signin.ts')).isStudioProject(p.id)) && !prior) {
      try {
        const signedIn = await (await import('./playtest-signin.ts')).testSignIn(p);
        params.cookies = [...((params.cookies as unknown[]) ?? []), ...signedIn];
        updateStep(s, { detail: 'signed in as the test account' });
      } catch (e: any) {
        updateStep(s, { status: 'failed', detail: `the test sign-in failed: ${e.message}`, data: { played, url, signInFailed: true }, finished: true });
        return null;
      }
    }
    // Timed out (and cancelled) if it hangs, so one stuck browser never holds up the run: the run time counts from the
    // step's first start (kept on the step, so a restart never extends it), and 10 minutes without progress is stuck.
    // share: the same play another run queued (same page, scenario, device, baseline) and Gen hasn't started yet is
    // joined, not queued twice; each run still reviews it. Not a page this run serves on its own port (it stops with the run).
    try {
      const F = await import('./playtest-finish.ts');
      job = await runGenJob('playtest.run', p.id, params, queuedNote(s), {
        runMs: F.cappedRunMs(playtestRunMs(t)), queueMs: F.PLAYTEST_QUEUE_MS(), queueStallMs: F.PLAYTEST_QUEUE_STALL_MS(), queuePosition: queuePlace, job: prior?.id, since, idleMs: PLAYTEST_IDLE_MS(), abandon, priority, halt: haltOf(run), share: port === null,
        onStart: (at) => db.prepare(`UPDATE steps SET data = json_set(COALESCE(data, '{}'), '$.runningSince', ?) WHERE id = ?`).run(at, s),
      });
      // A tab freed up (this playtest is over): a run still queued for more browsers asks Gen for them again.
      void raiseAgain(run);
      // Cut off (a provider with no free worker or a full disk, a Gen or beta restart): one more try on the next backend,
      // then it ends with its reason in one sentence, never a hang.
      const cut = F.classifyFailure(job);
      if (cut && !haltOf(run)()) {
        if (cut.provider) { const B = await import('./gpu-breaker.ts'); B.trip(cut.provider); }
        updateStep(s, { detail: `${F.plainWhy(job, null)} ${cut.kind === 'queue' ? 'Trying once more.' : 'Trying again on the next backend.'}` });
        if (cut.kind === 'beta-restart') { try { await (await import('./previews.ts')).betaSettled(p.id); } catch { /* the retry will say */ } }
        const second = await runGenJob('playtest.run', p.id, F.retryParams(params, cut), queuedNote(s), {
          runMs: F.cappedRunMs(playtestRunMs(t)), queueMs: F.PLAYTEST_QUEUE_MS(), queueStallMs: F.PLAYTEST_QUEUE_STALL_MS(), queuePosition: queuePlace, idleMs: PLAYTEST_IDLE_MS(), abandon, priority, halt: haltOf(run), share: false,
          onStart: (at) => db.prepare(`UPDATE steps SET data = json_set(COALESCE(data, '{}'), '$.runningSince', ?) WHERE id = ?`).run(at, s),
        });
        if (second.status !== 'done') second.error = F.plainWhy(second, cut);
        job = second;
      }
    } catch (e: any) {
      // Refused for credits (or quota, billing): its own outcome, like cancelled. Not a failed playtest, not a failed beta build.
      const why = creditRefusal(e);
      if (!why) {
        // Refused with 429: played again later by itself (transient.ts), the result reaches whoever asked.
        if (isRateLimited(e) && waitForRateLimit(run, p.id, s, t, opts, String((e as any)?.message ?? e), { url, played })) return null;
        throw e;
      }
      waitForCredits(run, p.id, s, why, { url, played });
      return null;
    } finally { if (port) stopServed(port); }
    // The job itself was refused with 429 (the playtest lane's limit): the same outcome.
    if (job.status === 'failed' && isRateLimited({ message: job.error ?? job.detail }) && waitForRateLimit(run, p.id, s, t, opts, String(job.error ?? job.detail), { url, played }, job.id)) return job;
    // The job itself ended on a credit refusal (Gen says so in its error): the same outcome.
    const jobWhy = job.status === 'failed' ? creditRefusal({ message: job.error ?? job.detail }) : null;
    if (jobWhy && /credit|quota|billing|payment/i.test(String(job.error ?? job.detail ?? ''))) {
      waitForCredits(run, p.id, s, jobWhy, { url, played }, job.id);
      return job;
    }
    // A newer beta build waits on this old one (betaqueue.ts supersedingBuild): cancelled, not failed.
    if (job.abandoned) {
      updateStep(s, { status: 'skipped', job: job.id, detail: `cancelled: ${job.error}`, data: { url, played, abandoned: job.error, runningSince: since ?? null }, finished: true });
      return job;
    }
    // Cancelled (J, Talk, the PM, or in Gen): its own outcome. No review, no finding, no criteria judged (cancel.ts).
    if (job.status === 'cancelled') {
      updateStep(s, { status: 'cancelled', job: job.id, detail: jobCancelDetail(job), data: { url, played, cancelled: true }, finished: true });
      return job;
    }
    // The game's own scenario list, for the next playtest of this build; a scenario it doesn't have is skipped, not failed.
    if (t.where === 'local') noteScenarios(p.id, build, job.result?.scenarios, url);
    const missing = t.where === 'local' && job.status !== 'done' ? missingScenario(job.error ?? job.detail) : null;
    if (missing && !missing.has.length) {
      // An empty list is a contract that wasn't ready, never a renamed scenario: fail loudly, a skip would pass unchecked.
      const why = contractNotReadyNote(missing.scenario);
      console.warn(`[studio] ${p.id} ${name} (${run}): ${why}`);
      updateStep(s, { status: 'failed', job: job.id, detail: why, data: { error: why, url, played, contractNotReady: true, asked: asked.scenario ?? null }, finished: true });
      return null;
    }
    if (missing) {
      noteScenarios(p.id, build, missing.has, url);
      return skipMissing(run, p, s, asked, missing.scenario, missing.has, played, job.id);
    }
    // The copy must still hold the build that was served when it started (a newer build waits for this run, unless it waited too long).
    const after = unityBeta && job.status === 'done' ? playedLocal(p) : null;
    if (unityBeta && job.status === 'done' && (!after || after.sha !== now?.sha || String(after.build ?? '') !== String(now?.build ?? ''))) {
      const why = `The beta build changed while this played: it started on ${now?.build ? `Game/v${now.build}` : 'a build'} of beta ${now?.sha.slice(0, 7)}, the copy now holds ${after ? `${after.build ? `Game/v${after.build}` : 'a build'} of beta ${after.sha.slice(0, 7)}` : 'no beta build'}. Not reviewed.`;
      console.warn(`[studio] ${p.id} ${name} (${run}): ${why}`);
      updateStep(s, { status: 'failed', job: job.id, detail: why, data: { error: why, url, played, wrongBuild: true }, finished: true });
      return null;
    }
  } finally {
    free();
  }
  const r = job.result ?? {};
  const ok = job.status === 'done';
  // Nothing to playtest (J, 2026-11-08): a page that never exposed the playtest hook, with no open finding behind it (a
  // library, an SDK's page), is skipped, not failed: no red card, no review, no bad verdict (verdictwork.ts). With an open
  // finding behind it the game is still failed.
  if (!ok && hookMissing(job.error ?? job.detail) && !openFindingCount(p.id)) {
    updateStep(s, {
      status: 'skipped', job: job.id, detail: `nothing to playtest: ${job.error ?? job.detail} (${url}), and no open finding is behind it`,
      data: { url, played, unplayable: true, error: job.error ?? job.detail }, finished: true,
    });
    return job;
  }
  // A task's check (criteria judged) against the scenario budget (pace.ts): over it, the run card warns and the task's
  // agent hears it (pm.ts). Daily "full" runs are long on purpose: not flagged.
  const at = playOptions(t)?.at;
  const slow = ok && criteria?.length ? slowNote(r.seconds) : null;
  updateStep(s, {
    status: ok ? 'done' : 'failed', job: job.id,
    detail: ok ? `${r.outcome} in ${playTime(r.seconds ?? 0)}${at ? ` (from "${at}")` : ''} · ${r.problems?.length ?? 0} problems · ${r.fps?.average ?? '?'} fps${r.mode === 'generic' ? ' · no playtest contract' : ''}${slow ? ` · ⚠ ${slow}` : ''}` : `failed: ${job.error ?? job.detail} (opened ${url})`,
    data: ok ? { ...playtestData(job, url), played, ...(at ? { at } : {}), ...(slow ? { slow } : {}) } : { error: job.error, url, played },
    finished: true,
  });
  if (!ok && /^stuck:/.test(String(job.error ?? ''))) fileStuck(run, p, name, job);
  // A live site failing its check may be down: tell J's phone (once per product and scenario every 6 hours).
  if (t.where === 'live' && (!ok || r.outcome === 'error')) {
    void notifyOnce(`live:${p.id}:${name}`, 6 * 3600_000, `Live check failed: ${p.name}`, `${p.live} (${name}): ${ok ? `the playtest ended in an error${r.problems?.[0]?.message ? `: ${r.problems[0].message}` : ''}` : (job.error ?? job.detail ?? 'the playtest failed')}`.slice(0, 600), { url: p.live, priority: 4, tags: ['rotating_light'] });
  }
  if (!ok || !review) return job;
  // A game rendered in software (no GPU server was free) plays at a few fps: the result says nothing about the game,
  // so it isn't reviewed and files no findings (agents would chase problems that aren't there).
  if (r.software && p.engine !== 'static') {
    // The provider that failed is skipped for a few minutes (gpu-breaker.ts) and told once, not in every playtest.
    const B = await import('./gpu-breaker.ts');
    const tripped = B.trip(r.softwareBecause);
    if (tripped?.fresh) {
      void notifyOnce(`gpu-down:${tripped.provider}`, 6 * 3600_000, `Playtests: ${tripped.provider} is down`, `${String(r.softwareBecause).slice(0, 300)} Playtests skip it for ${Math.round(B.OPEN_MS() / 60000)} minutes and use the next backend.`, { priority: 3, tags: ['warning'] });
    }
    // Not GPU-bound (a web game that played fine in software): reviewed, with the note.
    if (!B.reviewableInSoftware(p, r)) {
      updateStep(s, { status: 'skipped', detail: softwareDetail(r) });
      return job;
    }
    updateStep(s, { detail: `played in software (${r.fps?.average ?? '?'} fps)${r.softwareBecause ? `: ${String(r.softwareBecause).slice(0, 120)}` : ''}; reviewed anyway, it is not GPU-bound` });
  }
  // Audio layer: event timeline metrics always; ebur128 loudness when the recording has a Gen video asset.
  const audioResult = await withAudio(r, job).catch(() => enrichAudio(r));
  if (audioResult?.metrics) {
    try {
      const cur = (db.prepare(`SELECT data FROM steps WHERE id = ?`).get(s) as any)?.data;
      const data = typeof cur === 'string' ? JSON.parse(cur) : (cur ?? {});
      updateStep(s, { data: { ...data, metrics: { ...(data.metrics ?? {}), ...audioResult.metrics }, audio: audioResult.audio ?? null } });
    } catch (e: any) {
      console.warn(`[studio] audio metrics not stored (${p.id} ${name}): ${e.message ?? e}`);
    }
  }
  // Stash the enriched result on the job so the review gets the same audio timeline summary.
  if (audioResult) job.result = { ...r, ...audioResult, metrics: { ...(r.metrics ?? {}), ...(audioResult.metrics ?? {}) } };
  fileFeel(run, p, name, t.scenario ?? name.replace(/@.*$/, ''), job.result ?? audioResult ?? r, mode, playOptions(t)?.at);
  return reviewPlaytest(run, p, t, job, played, { focus, mode, criteria, sweep });
}

/** Enrich a playtest result with audio.* metrics (events + optional ebur128 on the recording). */
async function withAudio(r: any, job: any) {
  const video = r?.video ?? (job?.outputs ?? []).find((x: any) => x.kind === 'video')?.asset ?? null;
  let enriched = enrichAudio(r);
  if (video && typeof (gen as any).download === 'function') {
    try {
      const loud = await loudnessFromAsset(video, (a, f) => (gen as any).download(a, f));
      if (loud.lufsIntegrated != null || loud.truePeakDb != null) {
        enriched = {
          ...enriched,
          metrics: {
            ...enriched.metrics,
            ...(loud.lufsIntegrated != null ? { 'audio.lufsIntegrated': loud.lufsIntegrated } : {}),
            ...(loud.truePeakDb != null ? { 'audio.truePeakDb': loud.truePeakDb } : {}),
          },
        };
      }
    } catch (e: any) {
      console.warn(`[studio] audio loudness skipped: ${e?.message ?? e}`);
    }
  }
  return enriched;
}

/**
 * The feel layer's findings (feel.ts): what the game's sensor flagged and the vision pass saw, one finding per kind
 * and scene, each with the places and a replay (scenario + seed + spot) for the fix and its recheck. Also the audio
 * layer's silent-action / identical-repeat / loudness findings (audio.ts).
 */
function fileFeel(run: string, p: Product, name: string, scenario: string, r: any, mode?: string, at?: unknown) {
  try {
    const list = [
      ...feelSensorFindings(r, { scenario }),
      ...feelFindings(r, { scenario, mode: mode ?? 'full', at: typeof at === 'string' && at ? at : undefined }),
      ...audioFindings(r, { scenario }),
      // A measured limit the play broke (a hitch in play over 250 ms, input latency): a bug the agents fix on beta, so
      // the go-live gate clears by itself (deploy.ts qualityBlockers), never a "fix it" for the owner.
      ...qualityFindings(p, r, scenario),
    ];
    if (!list.length) return;
    const got = absorb(p.id, run, name, list, { mode: 'full' });
    console.log(`[studio] ${p.id} ${name}: feel ${r.feel?.length ?? 0} flags${r.polish?.score != null ? `, polish ${r.polish.score}/10` : ''} audio silent=${r.metrics?.['audio.silentActions'] ?? '?'} -> ${got.added.length} new, ${got.updated.length} seen again, ${got.ideas.length} ideas`);
  } catch (e: any) {
    console.warn(`[studio] feel findings not filed (${p.id} ${name}): ${e.message ?? e}`);
  }
}

/**
 * The step's line for a game Gen played in software: Gen's own reason (result.softwareBecause: why no GPU browser
 * played it, e.g. RunPod out of credit) when it gives one, so the fix is on the card, not a guess.
 */
export function softwareDetail(r: { fps?: { average?: number | null } | null; softwareBecause?: string | null }): string {
  const why = String(r.softwareBecause ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || 'no GPU server was free';
  return `inconclusive: the browser ran in software (${r.fps?.average ?? '?'} fps): ${why}; not reviewed`;
}

/** An address that is a code host's page for the repository, not a running product. */
export const isRepoPage = (u?: string | null) => !u || /^https:\/\/(www\.)?(github|gitlab)\.com\//i.test(u);

/** The most a whole run may take before it plays no more scenarios (J, 2026-10-25: a beta run sat for hours). */
export const RUN_MAX_MS = () => Number(process.env.STUDIO_RUN_MAX_MS ?? 3 * 3600_000);
/** A beta run is a check, not a survey: 90 minutes, then it plays no more (J, 2026-10-25). Daily and one-off runs keep RUN_MAX_MS. */
export const BETA_RUN_MAX_MS = () => Number(process.env.STUDIO_BETA_RUN_MAX_MS ?? 90 * 60_000);
export function runOverCap(run: string): { message: string; capMin: number } | null {
  const row = db.prepare('SELECT started, kind FROM runs WHERE id = ?').get(run) as { started?: number; kind?: string } | undefined;
  const cap = row?.kind === 'beta' ? BETA_RUN_MAX_MS() : RUN_MAX_MS();
  if (!row?.started || cap <= 0 || Date.now() - row.started <= cap) return null;
  const capMin = Math.round(cap / 60000);
  return { capMin, message: `not played: this run has been going for over ${capMin} minutes (the most one run may take), so it plays no more scenarios. Ask for it again to play the rest.` };
}

/** A scenario Studio ended for standing still: a stuck finding with where it stood and its last events, and a note to J's phone. */
function fileStuck(run: string, p: Product, name: string, job: any) {
  const at = String(job.stuckAt ?? '').slice(0, 200);
  const events = (job.stuckLog as string[] | undefined) ?? [];
  const scenario = name.replace(/@.*$/, '');
  try {
    absorb(p.id, run, scenario, [{
      title: `${scenario} got stuck and was ended${at ? `: ${at.slice(0, 80)}` : ''}`,
      severity: 'bug', area: 'gameplay',
      detail: `${job.error}\nWhere it stood: ${at || 'unknown'}\nLast events:\n${events.join('\n')}`.slice(0, 3000),
      fix: 'Find why the bot (or the game) stops making progress at that position: a foothold it cannot leave, a door that never opens, or a scenario step that waits for something that never happens.',
    }], { mode: 'full' });
  } catch (e: any) {
    console.warn(`[studio] stuck finding not filed (${p.id} ${name}): ${e.message ?? e}`);
  }
  void notifyOnce(`stuck:${p.id}:${name}`, 6 * 3600_000, `Playtest stuck: ${p.name} ${scenario}`, `${job.error}${at ? ` Last seen at: ${at}.` : ''} Filed as a stuck finding; the run moved on.`.slice(0, 600), { priority: 3, tags: ['warning'] });
}

/**
 * The options a playtest passes to the game: its own, with its start point (`at`, docs/playtest.md) when it names one.
 * No `at`: today's behaviour, the scenario plays from its start.
 */
export function playOptions(t: Pick<Playtest, 'options' | 'at'>): Record<string, unknown> | undefined {
  const at = typeof t.at === 'string' && t.at.trim() ? t.at.trim() : null;
  return at ? { ...(t.options ?? {}), at } : t.options;
}

/** A queued playtest's place in Gen's line (playtest-capacity.ts), for the queue's stall rule (playtest-finish.ts). */
const queuePlace = (job: string) => import('./playtest-capacity.ts').then((C) => C.queuePosition(job)).catch(() => null);

/** Playtests of a run still waiting or playing: what Gen's browser tabs must cover. */
function playtestsLeft(run: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM steps WHERE run = ? AND kind = 'playtest' AND status NOT IN ('done', 'failed', 'skipped', 'cancelled')`).get(run) as any)?.n ?? 0);
}
/** A tab freed up: a run that still has playtests queued asks Gen for browsers to cover them (raiseForRun never lowers). */
async function raiseAgain(run: string) {
  const left = playtestsLeft(run);
  if (left > 0) await (await import('./playtest-capacity.ts')).raiseForRun(left).catch(() => null);
}

/** A playtest job's updates onto its step; while Gen has it queued, the step says why (tabs in use, how many ahead). */
function queuedNote(step: string) {
  return (j: any) => {
    updateStep(step, { job: j.id, detail: j.detail });
    if (j.status !== 'queued') return;
    void import('./playtest-capacity.ts').then((C) => C.waitReason(j.id)).then((why) => {
      if (!why) return;
      const cur = db.prepare('SELECT status, detail FROM steps WHERE id = ?').get(step) as any;
      if (cur && !['done', 'failed', 'skipped', 'cancelled'].includes(cur.status) && String(cur.detail ?? '') === String(j.detail ?? '')) updateStep(step, { detail: why });
    }).catch(() => {});
  };
}

/** Plays of one beta run at once (the playtester's slots: Hawkes Gen runs 2 playtests at a time on its GPU machine). */
export const BETA_PLAYS_PARALLEL = () => Math.max(1, Number(process.env.STUDIO_BETA_PLAYS_PARALLEL ?? 2) || 1);

/**
 * Runs `each` over `list` with at most `width` at once; each worker gets its slot (0, 1…). `stop` ends the workers
 * before their next item. An error in one item doesn't stop the others: the first is thrown once all are over.
 */
export async function inSlots<T>(list: T[], width: number, each: (x: T, slot: number) => Promise<unknown>, stop: () => unknown = () => null) {
  let next = 0;
  let error: unknown = null;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, list.length)) }, async (_, slot) => {
    while (next < list.length && !stop()) {
      const x = list[next++];
      try {
        await each(x, slot);
      } catch (e) {
        error ??= e;
      }
    }
  }));
  if (error) throw error;
}

/**
 * A scenario the build doesn't have (renamed or dropped since its task's agent wrote it): the step is skipped with one
 * note, and one PM-log line says so. Never a failed step.
 */
function skipMissing(run: string, p: Product, s: string, asked: Playtest, scenario: string, has: string[], played: ReturnType<typeof playedLocal>, job?: string) {
  const what = played?.build ? `Game/v${played.build}` : played ? `beta ${played.sha.slice(0, 7)}` : 'the build';
  if (!has.length) {
    // Never a skip: an empty list means the contract wasn't ready, and a skip would pass with nothing checked.
    const why = contractNotReadyNote(scenario);
    updateStep(s, { status: 'failed', detail: why, ...(job ? { job } : {}), data: { error: why, played, contractNotReady: true, asked: asked.scenario ?? null }, finished: true });
    return null;
  }
  const note = `skipped: ${what} has no scenario "${scenario}"${asked.scenario && asked.scenario !== scenario ? ` (asked for "${asked.scenario}")` : ''}. It has: ${has.join(', ')}. Add an alias in products.json (scenarioAliases) if it was renamed.`;
  updateStep(s, { status: 'skipped', detail: note, ...(job ? { job } : {}), data: { played, missingScenario: scenario, asked: asked.scenario ?? null, has }, finished: true });
  void import('./roadmap.ts').then(({ logDecision }) => logDecision('scenario skipped', run, p.id, `${p.name}: ${note}`)).catch(() => {});
  return null;
}

/** Claude's review of a finished playtest (or, resumed after a restart, the review it already had or was waiting for). */
async function reviewPlaytest(run: string, p: Product, t: Playtest, job: any, played: ReturnType<typeof playedLocal>, { focus, mode = 'full', criteria: asked, sweep }: { focus?: string; mode?: ReviewMode; criteria?: string[]; sweep?: Sweep | null }) {
  const name = nameOf(t);
  const r = job.result ?? {};
  // Reviews cost money: skip one when nothing changed since the last review of this scenario (the same commit for local
  // runs, the same live site for live ones) and the playtest raised no new problem. The last review still stands.
  const sha = t.where === 'local' ? (played ? `${played.sha.slice(0, 12)}${played.dirty ? `+${played.dirty}` : ''}` : gitState(p.site).head?.split(' ')[0] ?? '') : '';
  const problemsKey = (r.problems ?? []).map((x: any) => x.message).sort().join('|');
  // A scenario that meets the product's quality bar gets a regression-only daily review until the build changes meaningfully.
  const fullSha = reviewedSha(p, t.where, played);
  const bar = mode === 'full' ? barState(p, name, fullSha) : null;
  const reviewMode: ReviewMode = bar?.met ? 'regression' : mode;
  const sameKey = `${t.where}:${sha}:${r.outcome}:${problemsKey}:${reviewMode}`;
  const prev = lastStep(p.id, 'review', name, run);
  const ageDays = prev ? (Date.now() - (prev.finished ?? 0)) / 86_400_000 : 99;
  const resumedReview = db.prepare(`SELECT id FROM steps WHERE run = ? AND product = ? AND kind = 'review' AND name = ?`).get(run, p.id, name) && resuming.has(run);
  if (!resumedReview && prev?.data?.reviewKey === sameKey && ageDays < 7 && !focus && !asked?.length) {
    const rs0 = startStep(run, p.id, 'review', name, 'unchanged since the last review');
    updateStep(rs0, { status: 'skipped', detail: `unchanged since the last review (${prev.data.verdict}); not reviewed again`, data: { ...prev.data, reviewKey: sameKey, reused: prev.id }, finished: true });
    return job;
  }
  // What it was asked to judge, then merged tasks' criteria in passing (the same review prompt: no new play or review).
  const swept = (sweep?.criteria ?? []).filter((k) => !asked?.includes(k));
  const criteria = [...(asked ?? []), ...swept];
  const rs = startStep(run, p.id, 'review', name, 'Claude is watching');
  // Resumed: a finished review was filed already (its findings are in the backlog); a running one is waited for again.
  const wasReview = resumedStep(rs);
  if (wasReview && wasReview.status !== 'running') return job;
  const previous = lastStep(p.id, 'review', name, run)?.data ?? null;
  const audioSummary = isGame(p) ? audioTimelineSummary(r) : '';
  const revParams = reviewParams(p, job.id, reviewMode, {
    ...(focus ? { focus } : {}),
    ...(criteria?.length ? { criteria } : {}),
    ...(previous ? { previous: { summary: previous.summary, verdict: previous.verdict, scores: previous.scores, findings: (previous.findings ?? []).map((f: any) => ({ severity: f.severity, title: f.title })) } } : {}),
    // Judges can't hear the tape: a short audio timeline (LUFS, silent actions, sound starts).
    ...(audioSummary ? { audio: audioSummary } : {}),
  });
  // Gen's review, or the same review through Claude Code on the Max plan while Gen's Claude is out of credit (review-cc.ts).
  const rev = await reviewJob(p.id, revParams, () => runGenJob('playtest.review', p.id, revParams, (j) => updateStep(rs, { job: j.id, detail: j.detail }), { runMs: REVIEW_RUN_MS, job: wasReview?.job ?? undefined, halt: haltOf(run) }));
  const pending: PendingReview = { job: job.id, params: revParams, criteria: criteria?.length ? criteria : null, mode: reviewMode, reviewKey: sameKey, sha: fullSha, barMet: Boolean(bar?.met), barWhy: bar?.why ?? null, at: Date.now(), tries: 0, ...(swept.length ? { sweep: sweep!.tasks } : {}) };
  if (rev.status !== 'done') {
    if (rev.status === 'cancelled') {
      updateStep(rs, { status: 'cancelled', job: rev.id, detail: jobCancelDetail(rev), finished: true });
      return job;
    }
    if (waitForAi(rs, rev, pending, `${p.name} ${name}`)) return job;
    updateStep(rs, { status: 'failed', job: rev.id, detail: `failed: ${rev.error ?? rev.detail}`, finished: true });
    return job;
  }
  await fileReview(rs, p, run, name, rev, pending, r);
  // The playtest's own cost is tiny (local); attribute the review's.
  return job;
}

/**
 * A review that waits for the AI (J, 2026-10-20: "make sure playtests will work even if we don't have usage or
 * credits"): what it needs to run later on the playtest that already played. Kept in its step's data (status skipped);
 * catchUpReviews runs it once Claude or Cursor answers, and pm.ts reads its criteria then.
 */
type PendingReview = { job: string; params: any; criteria: string[] | null; mode: ReviewMode; reviewKey: string; sha: string | null; barMet: boolean; barWhy: string | null; at: number; tries: number; superseded?: string;
  /** The merged tasks whose criteria it judges in passing (sweepFor): pm.ts counts it for them, and never sends an unclear one back. */
  sweep?: string[] };

/** Whether a failed review failed on the AI (usage, billing, a login, an outage), not on the playtest. */
export function aiStop(error: string) {
  const stop = harnessStopOf(error);
  if (stop) return stop;
  // Anything else llm.ts calls the provider being down (a quota, a rate limit): the review waits, the harness isn't held.
  return isBillingError(error) ? { kind: 'transient' as const, line: error.slice(0, 300), resetsAt: null } : null;
}

/** Which harness a failed review error came from (so a Claude Code fallback error doesn't hold the active brain). */
export function aiHarnessOf(error: string, fallback: Harness = brainId()): Harness {
  const s = String(error ?? '').replace(/\(Claude Code fallback,\s*Gen:\s*/i, '(');
  if (/Claude Code|Claude\s*\(Max plan\)/i.test(s)) return 'claude';
  if (/\bCursor\b/i.test(s)) return 'cursor';
  if (/\bCopilot\b/i.test(s)) return 'copilot';
  if (/\bAntigravity\b|AGY_ERROR/i.test(s)) return 'antigravity';
  if (/\bGemini\b/i.test(s)) return 'gemini';
  return fallback;
}

/**
 * A review that couldn't run because the AI didn't answer: the step waits (skipped, not failed: the build and the
 * playtest stand, and the run isn't failed), the harness is held (harness-hold.ts), and catchUpReviews runs it later.
 */
export function waitForAi(rs: string, rev: any, pending: PendingReview, what: string) {
  const err = String(rev.error ?? rev.detail ?? '');
  const stop = aiStop(err);
  if (!stop) return false;
  if (stop.kind !== 'transient') holdHarness(stop, { source: `the review of ${what}`, harness: aiHarnessOf(err) });
  updateStep(rs, { status: 'skipped', job: rev.id ?? null, detail: `review waits for the AI (${stop.kind}: ${stop.line.slice(0, 160)}): the playtest itself is done, and the review runs by itself once it answers`, data: { pending }, finished: true });
  return true;
}

/** A finished review filed: findings into the backlog, the step done, a task's criteria judged (pm.ts reads them). */
async function fileReview(rs: string, p: Product, run: string, name: string, rev: any, x: PendingReview, playResult: any) {
  const v = rev.result;
  const merged = absorb(p.id, run, name, v.findings ?? [], { mode: x.mode });
  const known = applyKnown(p.id, run, name, v.known ?? []);
  const parts = [
    `${merged.added.length} new`, merged.ideas.length ? `${merged.ideas.length} to ideas` : '', merged.skipped ? `${merged.skipped} not regressions, not filed` : '',
    known.fixed.length ? `${known.fixed.length} known look fixed` : '', known.present.length ? `${known.present.length} known still there` : '',
  ].filter(Boolean);
  const late = x.tries > 0 || Date.now() - x.at > 60_000 ? ' · reviewed late (it waited for the AI)' : '';
  // A library has nothing to playtest on its own page: its review's verdict reads neutral, never fix-first or broken (verdictwork.ts).
  const verdict = libraryProject(p) && v.verdict !== NEUTRAL ? NEUTRAL : v.verdict;
  // The fun review of a game (fun-review.ts, the quality rubric's living-world rule): full and verify reviews, not
  // regression checks. A "demo" fails the quality gate on going live (deploy.ts qualityBlockers).
  const fun = isGame(p) && x.mode !== 'regression' && !libraryProject(p)
    ? await funReview(p, { review: v, playtest: { ...(playResult ?? {}), scenario: name }, dir: await import('./beta.ts').then((b) => b.repoDirs(p).source).catch(() => null) }).catch(() => null)
    : null;
  updateStep(rs, {
    status: 'done', job: rev.id, cost: rev.cost ?? 0,
    detail: `${verdict} · ${x.mode}${x.barMet ? ' (meets its quality bar)' : ''} · ${(v.findings ?? []).length} findings (${parts.join(', ')})${effectiveBar(p) ? ` · bar: ${v.meetsBar ?? '?'}` : ''}${fun && fun.verdict !== 'unjudged' ? ` · fun: ${fun.verdict}` : ''}${viaNote(rev)}${late}`,
    data: { ...v, ...(fun ? { fun } : {}), ...(verdict !== v.verdict ? { verdict, verdictWas: v.verdict } : {}), added: merged.added, updated: merged.updated, ideas: merged.ideas, skipped: merged.skipped, knownFixed: known.fixed, knownPresent: known.present, reviewKey: x.reviewKey, mode: x.mode, sha: x.sha, barHash: barHash(effectiveBar(p)), bar: x.barWhy }, finished: true,
  });
  // A review that came late (it waited for the AI; its run is long over): act on its verdict now (verdictwork.ts).
  if (late && isServer()) void import('./verdictwork.ts').then((m) => m.actOnVerdict(p.id, 'a late review')).catch(() => {});
  // A roadmap task's acceptance criteria, judged on this playtest (the beta run after a merge; pm.ts reads them).
  if (x.criteria?.length) {
    const checks = await judgeCriteria(x.criteria, v, playResult);
    db.prepare(`UPDATE steps SET data = json_set(data, '$.criteria', json(?), '$.sweep', json(?)) WHERE id = ?`).run(J(checks), J(x.sweep?.length ? x.sweep : null), rs);
  }
}

/** Reviews that wait for the AI are run for this long after their playtest (older ones are only marked stale). */
const PENDING_DAYS = 3;
let catchingUp = false;
/**
 * Reviews that waited for the AI, run now that it may answer: the newest per product and scenario (an older one of the
 * same scenario is superseded: a newer playtest replaced it), a few per pass, never while the harness is held. Each
 * reviews the playtest that already played (its Gen job), so nothing is built or played again.
 */
export async function catchUpReviews({ max = 4 }: { max?: number } = {}) {
  if (catchingUp || harnessHeld()) return [];
  catchingUp = true;
  const out: string[] = [];
  try {
    const rows = (db.prepare(`SELECT * FROM steps WHERE kind = 'review' AND status = 'skipped' AND data LIKE '%"pending":%' ORDER BY started DESC LIMIT 200`).all() as any[]).map(rowToStep);
    const seen = new Set<string>();
    for (const st of rows) {
      const x: PendingReview | undefined = (st.data as any)?.pending;
      if (!x || x.superseded) continue;
      const key = `${st.product}:${st.name}`;
      const newer = seen.has(key) || Boolean(db.prepare(`SELECT 1 FROM steps WHERE product = ? AND kind = 'review' AND name = ? AND status = 'done' AND started > ? LIMIT 1`).get(st.product, st.name, st.started));
      seen.add(key);
      if (newer || Date.now() - x.at > PENDING_DAYS * 86_400_000) {
        updateStep(st.id, { detail: `not reviewed: ${newer ? 'a newer playtest of this scenario replaced it' : `it waited over ${PENDING_DAYS} days for the AI`}`, data: { pending: { ...x, superseded: newer ? 'newer' : 'stale' } } });
        continue;
      }
      if (out.length >= max || harnessHeld()) break;
      let p: Product;
      try { p = getProduct(st.product); } catch { continue; }
      out.push(st.id);
      updateStep(st.id, { detail: 'reviewing now (it waited for the AI)' });
      const play: any = await gen.job(x.job).catch(() => null);
      const rev = await reviewJob(p.id, x.params, () => runGenJob('playtest.review', p.id, x.params, (j) => updateStep(st.id, { job: j.id }), { runMs: REVIEW_RUN_MS }));
      const next = { ...x, tries: x.tries + 1 };
      if (rev.status === 'done') {
        await fileReview(st.id, p, st.run, st.name, rev, next, play?.result ?? {}).catch((e) => console.warn(`[studio] late review ${st.id}: ${e.message ?? e}`));
        continue;
      }
      if (waitForAi(st.id, rev, next, `${p.name} ${st.name}`)) break;
      updateStep(st.id, { status: 'failed', job: rev.id ?? null, detail: `failed (late review): ${rev.error ?? rev.detail}`, data: { pending: { ...next, superseded: 'failed' } } });
    }
  } catch (e: any) {
    console.warn(`[studio] late reviews: ${e.message ?? e}`);
  } finally {
    catchingUp = false;
  }
  return out;
}
// Every 5 minutes, and when a hold lifts (a stand-in took over, or the harness answers again).
setInterval(() => void catchUpReviews(), 5 * 60_000).unref();
onHoldLifted(() => void setTimeout(() => void catchUpReviews(), 5_000).unref());

type PartialOptions = { at?: string; peers?: number; scenario?: string; where?: 'local' | 'live'; device?: 'desktop' | 'phone'; mode?: string; force?: boolean; review?: boolean; focus?: string; reviewMode?: ReviewMode; platform?: 'EditMode' | 'PlayMode'; category?: string; origin?: string | null; seed?: number; options?: Record<string, unknown> };

/** A playtest asked for over the API (studio_playtest, the CLI): device "phone" plays at 390x844 touch, as products.json's device does. */
/**
 * On Cloud Run a web product's beta is its R2 beta site (previews-cloud.ts), published the way the live site is: the
 * live page's path on the beta host. There's no shell or dev server to start there (a playtest that tried ended
 * studio-beta on every start, 2026-10-29). null elsewhere, and for products that serve themselves (`remote`, `app`).
 */
export async function cloudBetaUrl(p: { id: string; live: string; local: { serve: string }; builds?: BuildSpec[] }) {
  if (p.local.serve === 'remote' || p.local.serve === 'app') return null;
  const { remoteSites } = await import('./previews-cloud.ts');
  if (!remoteSites()) return null;
  const previews = await import('./previews.ts');
  // A build that keeps the target site's own game page (publish.page "site") has no page at this project's beta root:
  // the game is the target project's beta page at the publish path (2026-11-03, yoobaland smoke@local waited 150 s).
  const into = siteBuildPublish(p.builds);
  if (into) {
    const target = previews.previewUrl(into.project);
    if (target) return pagePathUrl(target, into.path);
  }
  const root = previews.previewUrl(p.id);
  if (!root) return null;
  // A game added through Talk: its beta site is a path of its own (sites.<domain>/b/<game>/), built with relative
  // paths, so the root is the game; its live address's path (GitHub Pages' /<repo>/) isn't part of it.
  const github = (p as { github?: string }).github;
  if (github) return betaPageUrl(root, p as { site?: string; repo?: string; github?: string; live?: string });
  const live = new URL(p.live);
  return new URL(live.pathname + live.search, root).toString();
}

/** The first build that publishes into another project's site and keeps that site's own page (builds.ts pointPage). */
export function siteBuildPublish(builds?: BuildSpec[]) {
  const b = builds?.find((x) => x.publish?.page === 'site' && x.publish.project);
  return b?.publish ? { project: b.publish.project, path: b.publish.path ?? '' } : null;
}
/** `<root>` plus a publish path ("Game/"), always ending in a slash. */
export function pagePathUrl(root: string, path: string) {
  const sub = String(path ?? '').trim().replace(/^\/+|\/+$/g, '');
  return `${root.replace(/\/?$/, '/')}${sub ? `${sub.split('/').map(encodeURIComponent).join('/')}/` : ''}`;
}

/**
 * A project's page on its beta site: the root, plus its `site` folder when the build publishes the game page there
 * (a Unity build with publish.page "site" lands at <root>/YoobaLand/index.html; the root has no game page).
 * `site` that is only the repo (owner/name, or the repo folder) is not a sub-folder.
 */
export function betaPageUrl(root: string, p: { site?: string; repo?: string; github?: string; live?: string }) {
  const site = String(p.site ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!site || site === '.' || site === p.repo || site === p.github || site === String(p.github ?? p.repo ?? '').split('/').pop()) return livePagePath(root, p);
  return `${root.replace(/\/?$/, '/')}${site.split('/').map(encodeURIComponent).join('/')}/`;
}

/**
 * The game's page under the beta root: its live address's path (phorigins.com/play/game.html is the game, the root is
 * the lore site: 2026-11-08, ph-origins' local playtests played the root, whose contract has only smoke). On GitHub
 * Pages the first segment is the repo's own name (a project page), which the beta root already stands for.
 */
export function livePagePath(root: string, p: { repo?: string; github?: string; live?: string }) {
  let u: URL;
  try { u = new URL(String(p.live ?? '')); } catch { return root; }
  // A library's "live" is its repo page (github.com/<owner>/<name>): that path is not a page of its site, so its beta
  // root is the page (2026-11-08: Hawkes Net's beta playtests opened .../jgriffith3433/hawkesnet-babylon and never found the contract).
  if (isRepoPage(u.toString())) return root;
  let segs = u.pathname.split('/').filter((x, i, a) => x || i === a.length - 1);
  if (/\.github\.io$/i.test(u.hostname)) {
    const name = String(p.github ?? p.repo ?? '').split('/').pop()?.toLowerCase();
    if (segs[0] && segs[0].toLowerCase() === name) segs = segs.slice(1);
  }
  const rest = segs.filter(Boolean).join('/');
  if (!rest) return root;
  return `${root.replace(/\/?$/, '/')}${rest.split('/').map(encodeURIComponent).join('/')}${u.pathname.endsWith('/') ? '/' : ''}${u.search}`;
}

export const playtestRequest = (b: any): PartialOptions => ({ ...(typeof b.at === 'string' && b.at.trim() ? { at: b.at.trim() } : {}), ...(Number(b.peers) > 1 ? { peers: Math.min(4, Math.round(Number(b.peers))) } : {}), scenario: b.scenario, where: b.where, device: b.device === 'phone' ? 'phone' : undefined, mode: b.mode, review: b.review, focus: b.focus, reviewMode: ['full', 'verify', 'regression'].includes(b.reviewMode) ? b.reviewMode : undefined, seed: Number(b.seed) || undefined, options: b.options && typeof b.options === 'object' && !Array.isArray(b.options) ? b.options : undefined });

/** Runs the pipeline pieces on their own (from the API, CLI or MCP) as a small run. */
export function startPartial(kind: 'build' | 'playtest' | 'test', productId: string, opts: PartialOptions = {}) {
  const p = getProduct(productId);
  // A one-off play (Talk, an agent, the API, the CLI) isn't started (play-policy.ts): games are played once on each
  // milestone's build. No run is made: the caller hears why.
  if (kind === 'playtest') throw new StudioError(`${p.name} isn't played on its own: ${PLAY_RULE}.`, 409);
  const id = newId('r');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, kind, 'running', `${kind} ${p.id}`, J([p.id]), J(opts), Date.now());
  tagRun(id, opts.origin);
  if (kind !== 'test' && skipForCredits(id, p.id)) return { id, done: Promise.resolve() };
  return { id, done: partialBody(id, kind, p, opts) };
}

/** Ends a run from its steps: failed if any failed, else cancelled or partial if any were cancelled (cancel.ts), else done. */
export function closeRun(id: string, label: string) {
  const cost = (db.prepare('SELECT COALESCE(SUM(cost), 0) AS c FROM steps WHERE run = ?').get(id) as any).c;
  const n = runCounts(id);
  const status = endStatus(n, runCancelled(id));
  db.prepare(`UPDATE runs SET status = ?, detail = ?, finished = ?, cost = ? WHERE id = ?`).run(status, runCancelDetail(id, `${label}${n.failed ? ' failed' : status === 'done' ? '' : ` ${status}`}`), Date.now(), cost, id);
  kickFollowups();
  // The critic judges the game when any run of it ends and its week is up, and on a milestone's beta run (critic.ts).
  if (isServer() && status !== 'cancelled') void import('./critic.ts').then((m) => m.afterRun(id)).catch(() => {});
  // A one-off playtest or a beta run ended: its review may have left the project fix-first or broken (verdictwork.ts).
  if (isServer() && status !== 'cancelled') void import('./verdictwork.ts').then((m) => m.actOnRun(id)).catch((e) => console.warn(`[studio] verdicts after ${id}: ${e.message ?? e}`));
}

async function partialBody(id: string, kind: string, p: Product, opts: PartialOptions) {
  try {
    if (kind === 'build') await buildProduct(id, p, { force: opts.force ?? true });
    else if (kind === 'test') await testProduct(id, p, opts.platform ?? 'EditMode', opts.category);
    closeRun(id, `${kind} ${p.id}`);
  } catch (e: any) {
    if (runWaitsForCredits(id, p.id, e)) return;
    db.prepare(`UPDATE runs SET status = 'failed', detail = ?, finished = ? WHERE id = ?`).run(String(e.message ?? e), Date.now(), id);
    kickFollowups();
    return;
  }
  await goLiveAfterPlaytest(id, kind, p.id, opts.where);
}

/**
 * A standalone playtest of beta that passed goes live by itself when the owner said to keep going live, as the end of a
 * beta run does (golive-policy.ts autoGoLive checks the policy, the plan, the exact commit tested and the verdicts).
 * Returns whether autoGoLive was asked. `go` is for the tests.
 */
export async function goLiveAfterPlaytest(run: string, kind: string, productId: string, where?: string, go?: (product: string, why: string) => Promise<unknown>): Promise<boolean> {
  if (kind !== 'playtest' || (where ?? 'local') !== 'local' || !betaLane()) return false;
  if ((db.prepare('SELECT status FROM runs WHERE id = ?').get(run) as any)?.status !== 'done') return false;
  await (go ?? (await import('./golive-policy.ts')).autoGoLive)(productId, `playtest ${run}`);
  return true;
}

/**
 * Checked before a run starts its paid steps: while Studio is waiting for credits (creditwait.ts) the run is recorded as
 * `cancelled` ("waiting for credits", not a failure) and starts nothing. True when it was skipped.
 */
function skipForCredits(id: string, product: string | null): boolean {
  const w = creditsWaiting();
  if (!w) return false;
  creditsHold(id, product, w, w.since); // the wait's own start: skipped runs don't stretch it
  db.prepare(`UPDATE runs SET status = 'cancelled', detail = ?, finished = ? WHERE id = ?`).run('waiting for credits (not started; not a failure)', Date.now(), id);
  kickFollowups();
  return true;
}

/**
 * A step refused for credits (or quota, billing): `cancelled` with data.credits, so no review, no finding and nothing is
 * blamed (cancel.ts), and the run is held for the credit-change event (creditwait.ts resumes a beta run once).
 */
function waitForCredits(run: string, product: string, step: string, why: { message: string; need: number | null; have: number | null }, data: Record<string, unknown> = {}, job?: string) {
  creditsHold(run, product, why);
  updateStep(step, { status: 'cancelled', ...(job ? { job } : {}), detail: `waiting for credits: ${why.message.replace(/ Add credits.*$/, '')}`, data: { ...data, credits: true, cancelled: true }, finished: true });
}

/**
 * A playtest refused with HTTP 429: `cancelled` with data.rateLimited (no review, no finding, nothing blamed: cancel.ts),
 * and the same playtest is queued to play again after a backoff (transient.ts). False when the tries are used up: the
 * refusal then stands as the failure it is.
 */
/** Why a beta run may play (play-policy.ts), from its saved options: what a run that plays it again carries. */
export function runPlayOf(run: string): PlayCause | undefined {
  const o = parse((db.prepare('SELECT options FROM runs WHERE id = ?').get(run) as any)?.options ?? null) as any;
  return o?.play === 'milestone' || o?.play === 'golive' ? o.play : undefined;
}

function waitForRateLimit(run: string, product: string, step: string, t: Playtest, opts: PlayOptions, message: string, data: Record<string, unknown> = {}, job?: string): boolean {
  const kind = (db.prepare('SELECT kind FROM runs WHERE id = ?').get(run) as any)?.kind === 'beta' ? 'beta' : 'playtest';
  const spec = kind === 'beta'
    ? { scenario: t.scenario, options: t.options, criteria: opts.criteria, focus: opts.focus, playtest: true, play: runPlayOf(run) }
    : { scenario: t.scenario, mode: t.mode, where: t.where, device: t.device, seed: t.seed, options: t.options, at: t.at, peers: t.peers, review: opts.review, focus: opts.focus, reviewMode: opts.mode };
  const due = scheduleRateRetry({ run, product, kind, spec, why: message });
  if (!due) return false;
  const when = new Date(due).toISOString().slice(11, 16);
  updateStep(step, { status: 'cancelled', ...(job ? { job } : {}), detail: `rate limited (HTTP 429): playing it again at ${when} UTC, by itself (${message.slice(0, 120)})`, data: { ...data, rateLimited: true, retryAt: due, cancelled: true }, finished: true });
  return true;
}

/** A run that threw a credit refusal ends `cancelled` (waiting for credits), never `failed`. True when it was one. */
function runWaitsForCredits(id: string, product: string, e: unknown): boolean {
  const why = creditRefusal(e);
  if (!why) return false;
  creditsHold(id, product, why);
  db.prepare(`UPDATE steps SET status = 'cancelled', detail = ?, finished = ? WHERE status = 'running' AND run = ?`).run(`waiting for credits: ${why.message.replace(/ Add credits.*$/, '')}`, Date.now(), id);
  const n = runCounts(id);
  db.prepare(`UPDATE runs SET status = ?, detail = ?, finished = ? WHERE id = ?`).run(endStatus({ ...n, failed: n.failed, cancelled: Math.max(1, n.cancelled) }), 'waiting for credits (not a failure)', Date.now(), id);
  kickFollowups();
  return true;
}

/**
 * playtest: play beta in this run (default: the betaPlaytests setting, off; asking for a beta run says true).
 * quiet: ms a Unity beta run waits for more pushes before building (default STUDIO_BETA_QUIET_MS, 2 min; J's own Beta
 * button: 0). A newer beta run of the product supersedes one still waiting (betaqueue.ts).
 */
type BetaOptions = { focus?: string; reverify?: boolean;
  /** The play before going live (golive-policy.ts): the merged tasks it judges in passing, chosen for the commit it plays (pm.ts coveredByBetaPlay). Empty: none. */
  sweep?: Sweep; origin?: string | null; criteria?: string[]; scenario?: string; options?: Record<string, unknown>; playtest?: boolean; quiet?: number; plays?: BetaPlay[];
  /** The agent change whose merge into beta started this run (agents.ts approve): a Unity build skips the quiet time
   *  while no other change of the product is on its way into beta (betaqueue.ts mergesInFlight). */
  merge?: string;
  /** A build tag J pushed (tagbuild.ts): this run builds that exact commit in the cloud (GitHub mode) instead of beta's checkout. */
  tag?: { name: string; sha: string };
  /**
   * Who asked for this run, for its Unity build (unitybuild-policy.ts): a person (the Beta button, the API), or a
   * milestone's check (pm.ts milestoneCheck, which asked the rule when it started it). None: automatic, so a Unity build
   * of beta's head runs only once a milestone is complete and nothing else is queued.
   */
  cause?: 'person' | 'milestone';
  /**
   * Why this run may play (play-policy.ts): its milestone's check, or a person taking beta live. None: it builds what it
   * may and plays nothing. Carried to the run that takes it over (absorbed) and to a run that plays it again (429, credits).
   */
  play?: PlayCause };
/** A reached milestone's check (pm.ts milestoneCheck): one scenario (none: the product's first local one) and the criteria judged on it. */
export type BetaPlay = { scenario?: string; options?: Record<string, unknown>; device?: 'desktop' | 'phone'; criteria: string[] };

/**
 * After beta moves (an approved change): the product's beta is brought up to date and played, as a small run in the
 * background. Its pre-deploy build is committed to beta, Unity builds beta, the beta site is rebuilt, and (on the
 * server) the first local scenario is playtested and reviewed.
 */
export function startBeta(productId: string, o: BetaOptions = {}) {
  const p = getProduct(productId);
  if (managedElsewhere(p)) throw new StudioError(managedNote(p), 409);
  const id = newId('r');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'beta', 'running', `beta ${p.id}`, J([p.id]), J({ focus: o.focus, ...(o.reverify ? { reverify: true } : {}), ...(o.sweep ? { sweep: o.sweep } : {}), criteria: o.criteria, scenario: o.scenario, options: o.options, playtest: o.playtest, quiet: o.quiet, plays: o.plays, ...(o.merge ? { merge: o.merge } : {}), ...(o.tag ? { tag: o.tag } : {}), ...(o.cause ? { cause: o.cause } : {}), ...(o.play ? { play: o.play } : {}) }), Date.now());
  tagRun(id, o.origin);
  // Out of credits already: the paid steps (the build, the playtest) aren't started, the run waits (creditwait.ts).
  if ((p.build || o.playtest || o.plays?.length || betaPlaytestsOn()) && skipForCredits(id, p.id)) {
    setImmediate(() => void import('./deploy.ts').then((d) => d.wakeGoLives(p.id, id)).catch(() => {}));
    return { id, done: Promise.resolve() };
  }
  // However the run ends (passed, failed, superseded, waiting for credits), a go live waiting for beta's play looks
  // again (deploy.ts waitForBetaPlay): nothing stays parked on a run that's over.
  const done = betaBody(id, p, o).finally(() => import('./deploy.ts').then((d) => d.wakeGoLives(p.id, id)).catch(() => {}));
  return { id, done };
}

/**
 * Why beta's newest commit needs no new play of a scenario (a sentence), or null: the scenario last passed cleanly on
 * this commit, or on an earlier one with only docs, notes and the like between them (playplan.ts noRuntimeChange).
 */
async function unchangedPass(p: Product, name: string): Promise<string | null> {
  const pass = lastCleanPass(p.id, name);
  const dir = repoDirs(p).source;
  const head = shaOf(dir, 'HEAD');
  if (!pass || !head) return null;
  if (pass.sha === head) return `${name} already passed on beta ${head.slice(0, 7)} (run ${pass.run}): not played again`;
  const diff = await gitAsync(dir, ['diff', '--name-only', pass.sha, head]);
  if (!diff.ok) return null;
  const files = diff.out.split('\n').map((x) => x.trim()).filter(Boolean);
  return noRuntimeChange(files) ? `${name} passed on beta ${pass.sha.slice(0, 7)} (run ${pass.run}); since then only docs and notes changed (${files.length} file(s)): not played again` : null;
}

async function betaBody(id: string, p: Product, { focus, criteria, scenario, options, playtest, quiet, plays, tag, merge, cause, play, sweep: goLiveSweep }: BetaOptions) {
  try {
    // What this beta run was asked to play (runplan.ts): the tasks' scenarios, or beta's one playtest when asked for.
    const nameFor = (x: { scenario?: string; device?: 'desktop' | 'phone' }) => {
      const pt = x.scenario ? { scenario: resolveScenario(p, x.scenario), where: 'local' as const } : betaPlaytestOf(p);
      return pt ? nameOf({ ...pt, ...(x.device === 'phone' ? { device: 'phone' as const } : {}) }) : null;
    };
    if (betaLane()) {
      const asked = plays?.length ? plays.map(nameFor) : playtest ?? betaPlaytestsOn() ? [nameFor({ scenario })] : [];
      planRun(id, [...new Set(asked.filter(Boolean) as string[])].map((name) => ({ product: p.id, name })));
    }
    const lane = betaLane();
    const top = p.repo.split('/')[0];
    // A build tag on Cloud Run needs no source checkout here: Gen builds that commit from GitHub. Cloning a Unity repo onto
    // the instance's memory disk failed with no message and cost every run minutes (2026-10-29).
    const cloudTag = Boolean((tag || p.build) && process.env.K_SERVICE);
    // On Cloud Run a customer's Unity project (its `builds`) isn't cloned either: its builds come from GitHub
    // (repos.ts builtFromGitHub). A big web repo is synced on the light path (repos.ts syncGit).
    const fromGitHub = lane && repoMap()[top] && !hadSteps(id, 'repo') && !cloudTag ? builtFromGitHub(p) : null;
    if (fromGitHub) updateStep(startStep(id, p.id, 'repo', top), { status: 'skipped', detail: fromGitHub, finished: true });
    else if (lane && repoMap()[top] && !hadSteps(id, 'repo') && !cloudTag) {
      const g = startStep(id, p.id, 'repo', top);
      const r = await syncRepo(top, repoMap()[top], BRANCH, betaFolders().has(top) ? BETA : undefined);
      updateStep(g, { status: r.action === 'failed' ? 'failed' : 'done', detail: `${r.detail}${r.head ? ` (${r.head})` : ''}`, data: r, finished: true });
      const broken = r.install?.find((i) => !i.ok);
      if (broken) throw new Error(`npm ci failed in ${broken.dir} (${broken.why}): ${broken.error}`);
    }
    if (p.deploy?.prebuild) await prebuildBeta(id, p);
    // The Beta button (or a push) for a Unity game on Cloud Run: there is no source checkout or beta website copy here, so
    // beta's head on GitHub is built like a build tag (GitHub mode). The local path asked Gen for a website copy it can't
    // have ("siteDir .work/beta/<product>-site doesn't exist", 2026-10-30). The commit already built: nothing to build.
    // A Unity project with its own `build` goes by the same rule as one Studio builds from GitHub (unitybuild-policy.ts,
    // J 2026-11-11): one build at a milestone's end, or what a person asked for. Held, the run ends: nothing is built and
    // nothing plays an older build in its place. A build tag (tag) is a person's.
    if (p.build && !tag && lane) {
      const v = (await import('./unitybuild-policy.ts')).unityBuildGate(p.id, cause ?? 'auto');
      if (!v.go) {
        const s = startStep(id, p.id, 'build', 'unity');
        updateStep(s, { status: 'skipped', detail: v.why, data: { held: v.why }, finished: true });
        return void closeRun(id, `beta ${p.id} (Unity build held)`);
      }
    }
    let cloudBuilt = false;
    if (p.build && !tag && lane && process.env.K_SERVICE) {
      const { branchHead } = await import('./tagbuild.ts');
      const slug = repoMap()[top];
      const sha = slug ? await branchHead(slug, BETA) : null;
      if (!sha) {
        const s = startStep(id, p.id, 'build', 'unity');
        updateStep(s, { status: 'failed', detail: `couldn't read ${BETA}'s commit for ${top} from GitHub${slug ? '' : ' (no "repos" entry in products.json)'}`, finished: true });
        return void closeRun(id, `beta ${p.id}`);
      }
      const bb = betaBuild(p);
      if (bb?.ok && bb.sha === sha) {
        const s = startStep(id, p.id, 'build', 'unity');
        updateStep(s, { status: 'skipped', detail: `${BETA} ${sha.slice(0, 7)} is already built${bb.version ? ` (Game/v${bb.version})` : ''}`, data: { served: { sha, version: bb.version ?? null } }, finished: true });
        cloudBuilt = true;
      } else tag = { name: BETA, sha };
    }
    if (p.build && tag) {
      // A build tag: that exact commit, built in the cloud from GitHub and pushed to the website's beta (tagbuild.ts).
      // No beta queue: it builds one named commit, so it neither waits for pushes nor supersedes anything.
      const { buildTag, studioTagDeps } = await import('./tagbuild.ts');
      const built = await buildTag(id, p, tag, await studioTagDeps(id));
      if (built?.status !== 'done') return void closeRun(id, `beta ${p.id} ${tag.name}`);
    } else if (p.build && lane && !cloudBuilt) {
      // Unity: one build for a burst of pushes (betaqueue.ts). Waiting, a newer beta run of the product takes over.
      const q = startStep(id, p.id, 'beta', 'queue', 'waiting for more pushes');
      const was = resumedStep(q);
      const head = () => shaOf(repoDirs(p).source, 'HEAD');
      if (!was || was.status === 'running') {
        const turn = await betaTurn(id, p.id, {
          halt: haltOf(id),
          ...(quiet !== undefined ? { quiet } : {}),
          afterMerge: Boolean(merge),
          onWait: (detail) => updateStep(q, { detail }),
          onGo: () => updateStep(q, { status: 'done', detail: 'its turn at the build server', finished: true }),
        });
        if ('cancelled' in turn) {
          updateStep(q, { status: 'cancelled', detail: turn.cancelled, finished: true });
          return void closeRun(id, `beta ${p.id}`);
        }
        if ('superseded' in turn) return void supersede(id, p.id, turn.superseded, head());
      }
      const built = await buildProduct(id, p, { beta: true });
      if (built?.superseded) return void supersede(id, p.id, built.superseded, head());
      // Cancelled build: beta is not built, nothing is played on it, and the next push builds again (cancel.ts).
      if (built?.status === 'cancelled') return void closeRun(id, `beta ${p.id}`);
    } else if (lane && p.github && (await import('./betabuild.ts')).unityBuildOf(p) && (await import('./previews-cloud.ts')).remoteSites()) {
      // A Unity project Studio builds from GitHub (its `builds`): beta's head is built, or the build already running is
      // waited for, and nothing plays before it is published (J, 2026-11-08). The step names the commit it was made from.
      const BB = await import('./betabuild.ts');
      const spec = BB.unityBuildOf(p)!;
      const s = startStep(id, p.id, 'build', spec.id, 'beta\'s head, built before it is played');
      const slug = String(p.github);
      // A Unity build only at a milestone's end with nothing else queued, or when a person asked (J, 2026-11-11):
      // unitybuild-policy.ts. Held, the run ends here: nothing is built, and nothing plays an older build in its place.
      const P = await import('./unitybuild-policy.ts');
      const unityCause = cause ?? 'auto';
      const r = await BB.ensureBetaBuild(p.id, spec.id, {
        head: async () => {
          const { repoToken, githubFetch } = await import('./ghtoken.ts');
          const { githubCommit } = await import('./sitestore.ts');
          return githubCommit(slug, BETA, githubFetch(await repoToken(slug)));
        },
        hold: () => { const v = P.unityBuildGate(p.id, unityCause); return v.go ? null : v.why; },
        start: async (sha) => (await import('./builds.ts')).startBuild(p.id, { trigger: 'beta', build: spec.id, sha, ref: BETA, origin: null, cause: unityCause }),
        say: (detail) => updateStep(s, { detail }),
      });
      if (r.how === 'held') {
        updateStep(s, { status: 'skipped', detail: r.detail, data: { held: r.detail, sha: r.sha || null }, finished: true });
        return void closeRun(id, `beta ${p.id} (Unity build held)`);
      }
      // A newer commit's build replaced this one (builds.ts, buildline.ts): this run built nothing and plays nothing; the
      // run of the newer commit plays it. Cancelled, not failed, so nothing is blamed (cancel.ts buildCancelled).
      if (r.how === 'superseded') {
        updateStep(s, { status: 'cancelled', detail: r.detail, data: { cancelled: true, superseded: r.detail, sha: r.sha || null }, finished: true });
        return void closeRun(id, `beta ${p.id} (superseded)`);
      }
      updateStep(s, { status: r.ok ? (r.how === 'already built' ? 'skipped' : 'done') : 'failed', detail: r.detail, data: r.ok ? { built: { sha: r.sha, version: r.version, run: r.run, how: r.how } } : { failed: true, sha: r.sha || null }, finished: true });
      if (!r.ok) return void closeRun(id, `beta ${p.id}`);
    } else void import('./previews.ts').then(({ buildPreview }) => buildPreview(p.id)).catch(() => {});
    // What the beta runs this one superseded asked for comes along: a playtest, their tasks' criteria (pm.ts reads them).
    // Only what still waits for a beta check, once per scenario, within a budget (playplan.ts): a burst of pushes used to
    // hand every later run the whole milestone set (r_fd260676d571: 21 scenarios, 2+ hours, nothing new).
    const carried: BetaPlay[] = [];
    for (const o of absorbed(id)) {
      if (playtest === undefined && o.playtest !== undefined) playtest = o.playtest;
      if (!play && o.play) play = o.play;
      for (const k of o.criteria ?? []) if (!(criteria ??= []).includes(k) && !settledAsk(p.id, { criteria: [k] })) criteria.push(k);
      if (!scenario && o.scenario) ({ scenario, options } = o);
      if (o.plays?.length) carried.push(...o.plays);
    }
    if (plays?.length || carried.length) {
      const plan = planCarried(p.id, plays ?? [], carried, (a) => expectedSeconds(p.id, nameFor(a) ?? 'smoke@local'));
      plays = plan.plays;
      const said = [
        plan.dropped.length ? `left out ${plan.dropped.length} carried-over scenario(s) nothing waits on (${plan.dropped.map((d) => askName(d.ask)).join(', ')}): ${plan.dropped[0].why}` : '',
        plan.deferred.length ? `deferred ${plan.deferred.length} carried-over scenario(s) (${plan.deferred.map((d) => `${askName(d.ask)} ~${Math.round(d.estS / 60)} min`).join(', ')}): ${plan.deferred[0].why}; they play in the next check of their tasks, or when asked for` : '',
      ].filter(Boolean);
      const names = plan.plays.map(nameFor).filter(Boolean) as string[];
      if (said.length || names.length) planChange(id, p.id, names, `this run plays ${names.length} scenario(s) after merging duplicates${said.length ? `; ${said.join('; ')}` : ''}`);
      if (said.length) {
        const q = startStep(id, p.id, 'beta', 'plan', said.join('; ').slice(0, 400));
        updateStep(q, { status: 'done', data: { dropped: plan.dropped.map((d) => d.ask.scenario ?? null), deferred: plan.deferred.map((d) => d.ask.scenario ?? null) }, finished: true });
      }
    }
    // A merged roadmap task: the scenario its agent wrote for its criteria, and the criteria judged again.
    const t: Playtest | undefined = scenario ? { scenario, where: 'local', ...(options ? { options } : {}) } : betaPlaytestOf(p);
    // Beta is played only when asked (J, 2026-10-17): after a merge it is rebuilt, and that's it (Settings > Agents).
    // A milestone's check: each of its tasks' scenarios played once, its tasks' criteria judged on it (pm.ts).
    // Every play of the run plays the build it built or kept: a newer beta build waits until they're over (betaplay.ts).
    // A newer beta run waiting to build (Unity: it replaces the build these play): the rest is cancelled and this run
    // ends superseded, before the copy is released, so the newer run plays its checks again on the new build (absorbed).
    let by: string | null = null;
    const newerBuild = () => {
      by ??= p.build && lane ? supersedingBuild(id, p.id) : null;
      return by ? `superseded by ${by}: a newer beta build is waiting to replace the one this played, and its checks play again there` : null;
    };
    // The owner skips beta playtests for this project (golive-policy.ts betaPlay): nothing is played; CI gates going live.
    const skipPlay = lane && (await import('./golive-policy.ts')).skipsBetaPlay(p.id);
    if (skipPlay) {
      const s = startStep(id, p.id, 'playtest', 'beta');
      updateStep(s, { status: 'skipped', detail: 'not playtested: the owner skips beta playtests for this project; it goes live once CI on beta passes', finished: true });
    } else if (lane && plays?.length && playsFor(play)) {
      const release = p.build ? holdBeta(p.id, id) : null;
      try {
        // Only the scenarios of the tasks it judges (pm.ts playsFor), independent ones in parallel across the playtester's slots.
        await inSlots(plays, BETA_PLAYS_PARALLEL(), async (x, slot) => {
          const base: Playtest | undefined = x.scenario ? { scenario: x.scenario, where: 'local', ...(x.options ? { options: x.options } : {}) } : betaPlaytestOf(p);
          // A task's "[phone]" criteria play at 390x844 touch (pm.ts playsFor).
          const pt: Playtest | undefined = base && x.device === 'phone' ? { ...base, device: 'phone' } : base;
          // What this run was asked for goes ahead of what it carried over in Gen's queue (playplan.ts).
          if (pt) await playtestProduct(id, p, pt, { focus, mode: 'verify', criteria: x.criteria, abandon: newerBuild, slot, ...((x as Ask).carried ? { priority: -1 } : {}) });
        }, () => newerBuild() || runCancelled(id));
        if (by) return void supersede(id, p.id, by, shaOf(repoDirs(p).source, 'HEAD'));
      } finally {
        release?.();
      }
    } else if (lane && t && playsFor(play)) {
      // The smoke every beta build gets (go live needs it) is not played again for a commit that changed nothing a
      // player sees since its last clean pass, unless somebody asked for it (playtest: true), and plays ahead of the queue.
      const bare = !scenario && !criteria?.length;
      const same = bare && playtest === undefined ? await unchangedPass(p, nameOf(t)) : null;
      if (same) {
        const q = startStep(id, p.id, 'beta', 'carry', same);
        updateStep(q, { status: 'done', finished: true });
      } else {
        // A play of beta that isn't a task's own check (the one before going live, the Beta button) judges every merged
        // task's criteria not verified yet in its review (acceptance.ts sweepFor): no play of its own for them.
        const sweep = bare && goLiveSweep ? (goLiveSweep.criteria.length ? goLiveSweep : null) : sweepFor(p.id, { runKind: 'beta', where: t.where === 'live' ? 'live' : 'local', device: t.device, asked: !bare });
        await playtestProduct(id, p, t, { focus, mode: 'verify', criteria, abandon: newerBuild, ...(bare ? { priority: 5 } : {}), ...(sweep ? { sweep } : {}) });
        if (by) return void supersede(id, p.id, by, shaOf(repoDirs(p).source, 'HEAD'));
      }
    } else if (lane && t) {
      const s = startStep(id, p.id, 'playtest', nameOf(t));
      updateStep(s, { status: 'skipped', detail: `not playtested: ${PLAY_RULE}`, data: { held: PLAY_RULE }, finished: true });
    }
    closeRun(id, `beta ${p.id}`);
    // The owner said to keep going live (golive-policy.ts): beta's run passed, so it goes live by itself.
    void (await import('./golive-policy.ts')).autoGoLive(p.id, `beta run ${id}`);
  } catch (e: any) {
    if (runWaitsForCredits(id, p.id, e)) return;
    db.prepare(`UPDATE runs SET status = 'failed', detail = ?, finished = ? WHERE id = ?`).run(String(e.message ?? e), Date.now(), id);
    kickFollowups();
  }
}

/**
 * On the server, an agent change working in a product's repo (its own worktree of /srv/hawkes/<repo>): asset making
 * writes into the server checkout itself, so it waits (startAssets refuses). Null: none, or not on the server.
 */
export function agentWorkingIn(p: Product): { id: string; status: string; repo: string; worktree: string } | null {
  if (!isServer()) return null;
  try {
    return (db.prepare(`SELECT id, status, repo, worktree FROM changes WHERE repo = ? AND status IN ('working', 'revising') ORDER BY created LIMIT 1`).get(p.repo.split('/')[0]) as any) ?? null;
  } catch {
    return null; // no changes table (agents.ts not loaded)
  }
}

/** Makes a product's missing or out-of-date assets (or only some, or forced) as a run. */
export function startAssets(productId: string, { only, force = false, origin }: { only?: string[]; force?: boolean; origin?: string | null } = {}) {
  const p = getProduct(productId);
  const busy = agentWorkingIn(p);
  if (busy) throw new Error(`Not making ${p.name}'s assets now: an agent is working on ${busy.repo} (change ${busy.id}, ${busy.status}). Studio would write them into the server's ${BETA} checkout (${PROJECTS}/${busy.repo}), not the agent's worktree (${busy.worktree}), and stray files there keep ${BETA} from updating (2026-10-18). Let the agent make them in its worktree (Hawkes Gen), or try again once it's done.`);
  const st = assetStatus(p.id);
  if (!st.manifest) throw new Error(`${p.name} has no hawkes.assets.json`);
  const todo = st.assets.filter((a) => (only?.length ? only.includes(a.id) : force || a.status !== 'current')).map((a) => ({ id: a.id, status: a.status }));
  const id = newId('r');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'assets', 'running', `assets ${p.id}: ${todo.length}`, J([p.id]), J({ only, force, todo }), Date.now());
  tagRun(id, origin);
  return { id, todo: todo.map((a) => a.id), done: assetsBody(id, p, todo, { only, force }) };
}

async function assetsBody(id: string, p: Product, todo: { id: string; status: string }[], { only, force = false }: { only?: string[]; force?: boolean }) {
  await Promise.all(todo.map(async (a) => {
    const s = startStep(id, p.id, 'asset', a.id, a.status);
    // Resumed: a made asset is kept; one being made waits for its Gen job again (not made twice: GPU money).
    const was = resumedStep(s);
    if (was && was.status !== 'running') return;
    if (runCancelled(id)) return void updateStep(s, { status: 'cancelled', detail: runCancelDetail(id, 'cancelled before it started'), finished: true });
    try {
      const r: any = await makeAsset(p.id, a.id, { force: force || Boolean(only?.length), job: was?.job ?? undefined, onUpdate: (detail, job) => updateStep(s, { detail, job }) });
      updateStep(s, { status: r.skipped ? 'skipped' : 'done', detail: r.skipped ? `skipped: ${r.skipped}` : `made ${r.files.join(', ')}${r.picked ? ` (picked: ${r.picked.reason})` : ''}`, data: r, cost: r.cost ?? 0, finished: true });
    } catch (e: any) {
      updateStep(s, { status: 'failed', detail: e.message, finished: true });
    }
  }));
  const failed = (db.prepare(`SELECT COUNT(*) AS n FROM steps WHERE run = ? AND status = 'failed'`).get(id) as any).n;
  const cost = (db.prepare('SELECT COALESCE(SUM(cost), 0) AS c FROM steps WHERE run = ?').get(id) as any).c;
  db.prepare('UPDATE runs SET status = ?, detail = ?, finished = ?, cost = ? WHERE id = ?').run(endStatus({ ...runCounts(id), failed }, runCancelled(id)), `assets ${p.id}: ${todo.length - failed} made${failed ? `, ${failed} failed` : ''}`, Date.now(), cost, id);
  kickFollowups();
}

/**
 * After a Studio restart (a deploy): runs that were going carry on (resuming, above) instead of ending as
 * interrupted. Returns the ids. Runs of a kind that can't carry on are marked interrupted, as before.
 */
/**
 * The run's restarts in a row at one step (`key`: its running step), counting this one: one more when the last restart
 * was at the same step and quick (RESTART_WINDOW_MS), else 1. Exported for the tests.
 */
export function runRestarts(prev: { step?: string; n?: number; at?: number } | undefined, key: string | null, now = Date.now()) {
  const n = key && prev?.step === key && now - (prev.at ?? 0) < RESTART_WINDOW_MS ? (prev.n ?? 0) + 1 : 1;
  return { step: key ?? '', n, at: now };
}

/**
 * A build run whose work is in Hawkes Gen right now (2026-11-01, j-studio-4f12): every build still building has a Gen job
 * that hasn't finished. Studio only waits on it, so its restarts (deploys roll the cells) can't be what ends Studio: they
 * don't count toward the restart limits below, and the resume polls the same job. Once the job is done (gen_done), the
 * download and publish are Studio's own work and count again. Exported for the tests.
 */
export function waitingInGen(run: string): boolean {
  try {
    const rows = db.prepare("SELECT gen_job, gen_done, runner FROM builds WHERE run = ? AND status = 'building'").all(run) as any[];
    // A Gen build with no job id yet is being submitted right now (a restart in those seconds is still waiting on Gen:
    // 2026-11-03, sick-of-it-unity v5 was stopped after 4 restarts in 30 minutes, none of them Studio's own work).
    return rows.length > 0 && rows.every((b) => !b.gen_done && (b.gen_job || b.runner === 'gen'));
  } catch {
    return false; // no builds table yet: no project builds here
  }
}


/**
 * A run stopped instead of resumed after restarts: it fails, and the Gen jobs its running steps were waiting on are
 * cancelled. Nothing reads their results any more, and a playtest's job kept its browser tab: on 2026-11-01 seven runs
 * stopped this way held all of the playtest lane's tabs, and every new playtest waited "4 of 4 playtest browser tabs in
 * use" for half an hour. Exported for the tests.
 */
export function stopResumedRun(run: string, why: string, cancel: (job: string) => Promise<unknown> = (job) => import('./cancel.ts').then((C) => C.cancelJob(job, 'Studio', why))) {
  const jobs = [...new Set((db.prepare(`SELECT job FROM steps WHERE run = ? AND status = 'running' AND job IS NOT NULL`).all(run) as { job: string }[]).map((x) => x.job))];
  db.prepare(`UPDATE steps SET status = 'failed', detail = ?, finished = ? WHERE status = 'running' AND run = ?`).run(why, Date.now(), run);
  db.prepare(`UPDATE runs SET status = 'failed', detail = ?, finished = ? WHERE id = ?`).run(why, Date.now(), run);
  kickFollowups();
  db.prepare(`UPDATE builds SET status = 'failed', detail = ?, finished = ? WHERE run = ? AND status = 'building'`).run(why, Date.now(), run);
  console.warn(`[studio] ${run}: ${why}${jobs.length ? ` (cancelling its Gen job${jobs.length > 1 ? 's' : ''} ${jobs.join(', ')})` : ''}`);
  return Promise.all(jobs.map((j) => cancel(j).catch((e: any) => console.warn(`[studio] ${run}: couldn't cancel Gen job ${j}: ${String(e?.message ?? e).slice(0, 200)}`))));
}

export function resumeRuns() {
  const out: string[] = [];
  for (const r of db.prepare(`SELECT * FROM runs WHERE status = 'running' ORDER BY started`).all() as any[]) {
    const options = parse(r.options) ?? {};
    const products: string[] = parse(r.products) ?? [];
    // Cancelled before the restart: it ends cancelled and starts nothing (cancel.ts).
    if (runCancelled(r.id)) {
      db.prepare(`UPDATE steps SET status = 'cancelled', detail = ?, finished = ? WHERE status = 'running' AND run = ?`).run(runCancelDetail(r.id, 'cancelled before Studio restarted'), Date.now(), r.id);
      closeRun(r.id, `${r.kind} ${products[0] ?? ''}`.trim());
      continue;
    }
    // A run that keeps coming back after restarts may be what ends Studio (a clone filling the disk, 2026-10-29): the
    // fourth resume within 30 minutes stops it instead. Deploy restarts are far apart and resume as before.
    const recent = ((options.resumes ?? []) as number[]).filter((t) => Date.now() - t < 30 * 60_000);
    const inGen = r.kind === 'build' && Array.isArray(options.builds) && waitingInGen(r.id);
    if (!inGen && recent.length >= 3) {
      const why = `stopped: Studio restarted ${recent.length + 1} times in 30 minutes while this run was going, so it isn't resumed again (it may be what crashed it)`;
      stopResumedRun(r.id, why);
      continue;
    }
    const steps = (db.prepare('SELECT * FROM steps WHERE run = ? ORDER BY started').all(r.id) as any[]).map(rowToStep);
    // And as changes do (agents.ts resumeChanges): the same unfinished step resumed RESTART_LOOP times in a row, each
    // restart quick after the last, never got past it (a repo step cloning a big repo on every restart). That step fails,
    // said plainly, and the run isn't resumed again.
    const at = steps.filter((s) => s.status === 'running').pop();
    const key = at ? `${at.product}/${at.kind}/${at.name}` : null;
    const loop = runRestarts(options.restarts, key);
    if (!inGen && key && loop.n > RESTART_LOOP) {
      const why = `stopped: Studio restarted ${loop.n - 1} times in a row during this run's ${at!.kind} step (${at!.name}), so it isn't resumed again (start it again once the cause is fixed)`;
      stopResumedRun(r.id, why);
      continue;
    }
    if (!inGen) db.prepare('UPDATE runs SET options = ? WHERE id = ?').run(JSON.stringify({ ...options, resumes: [...recent, Date.now()], ...(key ? { restarts: loop } : {}) }), r.id);
    let body: (() => Promise<unknown>) | null = null;
    try {
      if (r.kind === 'daily' || r.kind === 'manual') body = () => runAll(r.id, products, options).catch((e: any) => {
        db.prepare(`UPDATE runs SET status = 'failed', detail = ?, finished = ? WHERE id = ?`).run(String(e.message ?? e), Date.now(), r.id);
        kickFollowups();
      });
      // A project's builds (builds.ts) carry on through their own resume, never as a Unity product's build.
      else if (r.kind === 'build' && Array.isArray(options.builds)) body = () => import('./builds.ts').then((B) => B.resumeRun(r.id, products[0], options)).catch((e: any) => {
        db.prepare(`UPDATE runs SET status = 'failed', detail = ?, finished = ? WHERE id = ?`).run(String(e.message ?? e), Date.now(), r.id);
        kickFollowups();
      });
      else if (['build', 'test', 'playtest'].includes(r.kind)) body = () => partialBody(r.id, r.kind, getProduct(products[0]), options);
      else if (r.kind === 'beta') body = () => betaBody(r.id, getProduct(products[0]), options);
      else if (r.kind === 'assets' && Array.isArray(options.todo)) body = () => assetsBody(r.id, getProduct(products[0]), options.todo, options);
      else if (r.kind === 'live' && options.sha) body = () => import('./golive.ts').then(({ publishUnity }) => publishUnity(getProduct(products[0]), options.sha, { by: options.by, run: r.id })).catch(() => {});
    } catch {
      body = null; // a product that's gone from products.json
    }
    if (!body) {
      db.prepare(`UPDATE steps SET status = 'failed', detail = 'interrupted (Studio restarted)', finished = ? WHERE status = 'running' AND run = ?`).run(Date.now(), r.id);
      db.prepare(`UPDATE runs SET status = 'interrupted' WHERE id = ?`).run(r.id);
      kickFollowups();
      db.prepare(`UPDATE builds SET status = 'failed', detail = 'interrupted (Studio restarted)', finished = ? WHERE run = ? AND status = 'building'`).run(Date.now(), r.id);
      continue;
    }
    resuming.set(r.id, steps);
    // One every couple of seconds, not all at once (ops.ts resumeGapMs): start-up stays responsive.
    const wait = out.length * resumeGapMs();
    out.push(r.id);
    const run = body;
    void new Promise((ok) => setTimeout(ok, wait)).then(() => run()).finally(() => {
      resuming.delete(r.id);
      for (const s of steps) resumed.delete(s.id);
    });
  }
  return out;
}

export { today, localUrl, gen };
