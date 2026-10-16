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
import { loadProducts, getProduct, localUrl, today, PROJECTS, type Product, type Playtest } from './config.ts';
import { gen, genRun, genUp, ensureGen } from './gen.ts';
import { ensureServer, gitState, treeFingerprint, runCheck, serveDir, stopServed } from './local.ts';
import { absorb, applyKnown, expireIdeas, notSeenIn, type ReviewMode } from './backlog.ts';
import { barState, barHash, reviewedSha, reviewParams } from './review.ts';
import { writeReport } from './report.ts';
import { assetStatus, makeAsset } from './assets.ts';
import { syncRepos, syncRepo, repoMap, betaFolders, isServer, BETA, BRANCH } from './repos.ts';
import { betaLane, prepareBeta, playedLocal, resetBetaSite, saveBetaBuild, betaBuild, betaSiteDir, betaSiteFolder, betaPort, shaOf, repoDirs } from './beta.ts';
import { notifyOnce } from './notify.ts';
import { judgeCriteria } from './acceptance.ts';
import { runGenJob, playtestExtras, playtestData, playtestRunMs, REVIEW_RUN_MS } from './playtests.ts';
import { tagRun } from './followup.ts';

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

export function startStep(run: string, product: string, kind: string, name: string, detail = '') {
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
  return (db.prepare('SELECT id, kind, status, detail, products, started, finished, cost FROM runs ORDER BY started DESC LIMIT ?').all(limit) as any[]).map((r) => ({ ...r, products: parse(r.products) }));
}

/** The latest finished step of a kind for a product (e.g. the last review of a scenario). */
export function lastStep(product: string, kind: string, name: string, before?: string): Step | null {
  const r = db.prepare(`SELECT * FROM steps WHERE product = ? AND kind = ? AND name = ? AND status = 'done' ${before ? 'AND run != ?' : ''} ORDER BY started DESC LIMIT 1`)
    .get(...([product, kind, name, ...(before ? [before] : [])] as [string, ...string[]]));
  return r ? rowToStep(r) : null;
}

// ------------------------------------------------------------------ runs

/** Starts a run in the background; returns its id at once. One run at a time. */
export function startRun(kind: string, options: RunOptions = {}) {
  const running = activeRun();
  if (running) {
    // A run whose process died stays "running"; let a new one replace it after 6 hours.
    if (Date.now() - running.started < 6 * 3600_000) throw new Error(`A run is already going (${running.id}, started ${new Date(running.started).toLocaleTimeString()}).`);
    db.prepare(`UPDATE runs SET status = 'abandoned' WHERE id = ?`).run(running.id);
  }
  const products = (options.products?.length ? options.products.map((p) => getProduct(p)) : loadProducts()).map((p) => p.id);
  const id = newId('r');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, kind, 'running', 'starting', J(products), J(options), Date.now());
  tagRun(id, options.origin);
  const done = (async () => {
    try {
      await runAll(id, products, options);
    } catch (e: any) {
      db.prepare(`UPDATE runs SET status = 'failed', detail = ?, finished = ? WHERE id = ?`).run(String(e.message ?? e), Date.now(), id);
    }
  })();
  return { id, done };
}

async function runAll(run: string, ids: string[], o: RunOptions) {
  if (!(await genUp()) && !(await ensureGen())) throw new Error('Hawkes Gen is not running and did not start (see hawkesgen/.data/server.err.log).');
  // On the server, start from what's on GitHub.
  if (isServer()) {
    db.prepare('UPDATE runs SET detail = ? WHERE id = ?').run('updating repos from GitHub', run);
    const synced = syncRepos();
    // Product source repos are on beta (repos.ts); the staging sites (<sub>.hawkesgen.com) follow it.
    void import('./previews.ts').then(({ previewsAfterSync }) => previewsAfterSync(synced)).catch(() => {});
    for (const r of synced) {
      const s = startStep(run, 'studio', 'repo', r.folder, r.action);
      updateStep(s, { status: r.action === 'failed' ? 'failed' : 'done', detail: `${r.detail}${r.head ? ` (${r.head})` : ''}`, data: r, finished: true });
    }
  }
  const products = ids.map((p) => getProduct(p));
  // Games need a GPU to be judged fairly. On the server, the playtester (a T4 machine, about $0.53/hr) starts now, boots
  // while Unity builds, and game playtests wait for it; the run stops it at the end. STUDIO_GPU_PLAYTESTS: playtester
  // (default), fleet (a big GPU server instead, about $1.86/hr), off (games play in software and come out inconclusive).
  const gpuMode = process.env.STUDIO_GPU_PLAYTESTS || 'playtester';
  let usedPlaytester = false;
  if (isServer() && gpuMode !== 'off' && products.some((p) => p.engine !== 'static')) {
    const s = startStep(run, 'studio', 'gpu', 'playtests', gpuMode === 'fleet' ? 'checking for a ready GPU server' : 'starting the playtester (T4 GPU)');
    usedPlaytester = gpuMode !== 'fleet';
    gpuGate = (gpuMode === 'fleet' ? ensureGpu((d) => updateStep(s, { detail: d })) : ensurePlaytester((d) => updateStep(s, { detail: d })))
      .then((detail) => updateStep(s, { status: 'done', detail, finished: true }))
      .catch((e: any) => updateStep(s, { status: 'failed', detail: `${e.message} (games are played in software instead)`, finished: true }));
  }
  db.prepare('UPDATE runs SET detail = ? WHERE id = ?').run(`running ${ids.length} products`, run);
  await Promise.all(products.map((p) => runProduct(run, p, o).catch((e) => {
    const s = startStep(run, p.id, 'error', 'pipeline');
    updateStep(s, { status: 'failed', detail: String(e.message ?? e), finished: true });
  })));
  // Ideas (polish, ideas) not seen for 14 days drop off the ideas list (kept as expired).
  const expired = expireIdeas();
  if (expired) {
    const s = startStep(run, 'studio', 'backlog', 'ideas expired');
    updateStep(s, { status: 'done', detail: `${expired} ideas weren't seen for 14 days and expired`, finished: true });
  }
  // The games are played: the playtester stops (unless a playtest outside this run is still on it; then its idle stop does).
  if (gpuGate) {
    await gpuGate;
    gpuGate = null;
    if (usedPlaytester) await gen.request('/playtester/stop', { method: 'POST', body: { ifIdle: true } }).catch((e: any) => console.warn(`[studio] couldn't stop the playtester: ${e.message}`));
  }
  const cost = (db.prepare('SELECT COALESCE(SUM(cost), 0) AS c FROM steps WHERE run = ?').get(run) as any).c;
  db.prepare(`UPDATE runs SET status = 'done', finished = ?, cost = ? WHERE id = ?`).run(Date.now(), cost, run);
  const report = writeReport(run);
  db.prepare(`UPDATE runs SET detail = ?, report = ? WHERE id = ?`).run(report.headline, J({ file: report.file, date: report.date }), run);
  // On the server, agents start on the worst new findings (within the day's budget); J approves the results.
  if (isServer()) {
    const { autoFix } = await import('./agents.ts');
    const started = autoFix(run);
    if (started.length) db.prepare(`UPDATE runs SET detail = ? WHERE id = ?`).run(`${report.headline} · agents started ${started.length} fixes`, run);
  }
  // The morning brief (daily runs): a Talk conversation summarizing the report, and a notification linking to it.
  void import('./brief.ts').then(({ morningBrief }) => morningBrief(run)).catch((e) => console.warn(`[studio] morning brief: ${e.message ?? e}`));
}

/** Set while a run is getting a GPU machine ready: game playtests wait for it (it boots while Unity builds). */
let gpuGate: Promise<unknown> | null = null;

/** Starts the playtester (T4) and waits until its browser server answers. */
async function ensurePlaytester(onDetail: (d: string) => void) {
  const status = () => gen.request('/playtester');
  let st = await status();
  if (!st.exists) throw new Error('there is no playtester (hawkesgen playtester launch)');
  if (st.state === 'running' && st.stage?.stage === 'ready') return `using the playtester ${st.id}`;
  await gen.request('/playtester/start', { method: 'POST', body: { confirm: true } });
  const end = Date.now() + 15 * 60_000;
  while (Date.now() < end) {
    await new Promise((res) => setTimeout(res, 10_000));
    st = await status().catch(() => st);
    onDetail(`playtester ${st.state}${st.stage ? `: ${st.stage.stage}` : ''}`);
    if (st.state === 'running' && st.stage?.stage === 'ready') return `started the playtester ${st.id} (T4)`;
  }
  throw new Error('the playtester was not ready within 15 minutes');
}

/** Makes sure one GPU fleet server is ready (starting the most recently used one if none is). */
async function ensureGpu(onDetail: (d: string) => void) {
  const readyNow = async () => ((await gen.fleet()).servers ?? []).find((s: any) => s.state === 'running' && s.boot?.stage === 'ready');
  let r = await readyNow();
  if (r) return `using ${r.id} (${r.region})`;
  onDetail('starting a GPU server for the playtests');
  await gen.fleetAction('start', { confirm: true });
  const end = Date.now() + 15 * 60_000;
  while (Date.now() < end) {
    await new Promise((res) => setTimeout(res, 15_000));
    r = await readyNow().catch(() => null);
    if (r) return `started ${r.id} (${r.region})`;
  }
  throw new Error('no GPU server became ready within 15 minutes');
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
      const s = startStep(run, p.id, 'check', c.cmd, c.dir);
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
  if (betaLane() && wantsLocal && p.deploy?.prebuild) await prebuildBeta(run, p);

  // Build (Unity), only when the source changed since the last good build.
  if (p.build && !o.noBuild && wantsLocal) {
    const built = await buildProduct(run, p, { force: o.forceBuild });
    if (built?.status === 'done') for (const platform of p.build.tests ?? []) await testProduct(run, p, platform);
  }

  // Playtests.
  const tests = p.playtests.filter((t) => (o.where === 'local' ? t.where === 'local' : o.where === 'live' ? t.where === 'live' : true))
    .filter((t) => !o.scenarios?.length || o.scenarios.includes(t.scenario ?? t.mode ?? ''));
  const ran: string[] = [];
  for (const t of tests) {
    // The daily review is full; live desktop runs check for regressions only (beta's full review sees the same code first).
    const res = await playtestProduct(run, p, t, { review: !o.noReview, focus: o.focus, mode: t.where === 'live' && t.device !== 'phone' ? 'regression' : 'full' });
    if (res) ran.push(nameOf(t));
  }
  // Open findings from these scenarios that no review mentioned this time.
  const quiet = notSeenIn(run, p.id, ran);
  if (quiet.length) {
    const s = startStep(run, p.id, 'backlog', 'not seen');
    updateStep(s, { status: 'done', detail: `${quiet.length} open findings weren't seen this time (maybe fixed)`, data: { ids: quiet.map((f) => f.id) }, finished: true });
  }
}

/** Stale beta checkouts Talk was told about (once per state, not every playtest). */
const staleTold = new Set<string>();

/**
 * On the server, a web product's local playtest serves its source checkout, kept on beta (repos.ts). It is brought to
 * beta's tip first; when it can't follow (uncommitted changes, local commits), the playtest doesn't play the old commit:
 * it fails with what's in the way, and Talk is told (Studio never throws away changes it didn't make). Null: up to date.
 */
export function staleBeta(p: Product): string | null {
  const top = p.repo.split('/')[0];
  if (!isServer() || p.build || !repoMap()[top] || !betaFolders().has(top)) return null;
  const dir = repoDirs(p).source;
  const r = syncRepo(top, repoMap()[top], BRANCH, BETA);
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

export const nameOf = (t: Playtest) => `${t.scenario ?? t.mode ?? 'auto'}@${t.where}${t.device === 'phone' ? ':phone' : ''}`;

/** Runs a product's pre-deploy build on beta and commits it there (beta.ts prepareBeta), then syncs the checkout. */
async function prebuildBeta(run: string, p: Product) {
  const s = startStep(run, p.id, 'beta', 'prebuild', p.deploy?.prebuild ?? '');
  try {
    const r: any = await prepareBeta(p, (d) => updateStep(s, { detail: d }));
    const top = p.repo.split('/')[0];
    if (r.committed && repoMap()[top]) syncRepo(top, repoMap()[top], BRANCH, BETA);
    updateStep(s, { status: r.committed ? 'done' : 'skipped', detail: r.committed ? `committed the build to ${BETA}: ${String(r.committed).slice(0, 7)}` : r.skipped, data: r, finished: true });
  } catch (e: any) {
    updateStep(s, { status: 'failed', detail: String(e.message ?? e).slice(0, 1000), finished: true });
  }
}

/**
 * Builds a Unity product on the build server if its source changed (or force). On the beta lane the source checkout is
 * on beta and the build lands in the beta website copy (beta.ts), not the real website folder; the beta site follows.
 */
export async function buildProduct(run: string, p: Product, { force = false } = {}) {
  if (!p.build) throw new Error(`${p.name} isn't a Unity product`);
  const fp = treeFingerprint(p.build.project);
  const last = lastStep(p.id, 'build', 'unity');
  const lane = betaLane();
  const head = shaOf(repoDirs(p).source, 'HEAD') ?? '';
  const bb = lane ? betaBuild(p) : null;
  const current = !lane || Boolean(bb?.ok && bb.sha === head && fs.existsSync(betaSiteFolder(p)));
  if (!force && last?.data?.fingerprint === fp && current) {
    const s = startStep(run, p.id, 'build', 'unity');
    updateStep(s, { status: 'skipped', detail: `no changes since the last build (${last.data?.version ? `Game/v${last.data.version}` : 'last time'})`, data: { fingerprint: fp, version: last.data?.version }, finished: true });
    return null;
  }
  const s = startStep(run, p.id, 'build', 'unity', 'queued on the build server');
  let siteDir: string | undefined;
  let base = '';
  if (lane) {
    try {
      const copy = resetBetaSite(p);
      siteDir = path.relative(PROJECTS, copy.folder).replace(/\\/g, '/');
      base = copy.base;
    } catch (e: any) {
      updateStep(s, { status: 'failed', detail: `the beta website copy: ${e.message}`, finished: true });
      return null;
    }
  }
  const job = await genRun('unity.build', p.id, { project: p.build.project, site: p.build.site, method: p.build.method, ...(siteDir ? { siteDir } : {}) }, (j) => updateStep(s, { job: j.id, detail: j.detail }));
  const r = job.result ?? {};
  // A Hawkes Gen without siteDir would have built into the real website folder: that isn't a beta build.
  const stale = Boolean(siteDir && job.status === 'done' && r.site && r.site.folder !== siteDir);
  const ok = job.status === 'done' && !stale;
  const error = stale ? `Hawkes Gen's unity.build ignored siteDir (update Hawkes Gen); the build went to ${r.site.folder}` : ok ? null : String(job.error ?? job.detail ?? 'build failed');
  if (lane) {
    saveBetaBuild(p, { sha: head, base, ok, at: Date.now(), job: job.id, version: r.version ?? null, cost: job.cost ?? r.cost ?? 0, minutes: Math.round((r.seconds ?? 0) / 60), ...(error ? { error: error.slice(0, 500) } : {}) });
    void import('./previews.ts').then(({ buildPreview }) => buildPreview(p.id)).catch(() => {});
  }
  updateStep(s, {
    status: ok ? 'done' : 'failed', job: job.id, cost: job.cost ?? r.cost ?? 0,
    detail: ok ? `built ${lane ? `${BETA} ${head.slice(0, 7)} ` : ''}${r.version ? `Game/v${r.version}` : ''} in ${Math.round((r.seconds ?? 0) / 60)} min ($${(r.cost ?? 0).toFixed(2)})` : `failed: ${error}`,
    data: { ...r, fingerprint: ok ? fp : null, error, ...(lane ? { beta: head, siteDir } : {}) }, finished: true,
  });
  return ok ? job : { ...job, status: 'failed' };
}

/** Runs a Unity product's tests on the build server (so J's editor can stay open). */
export async function testProduct(run: string, p: Product, platform: 'EditMode' | 'PlayMode', category?: string) {
  if (!p.build) throw new Error(`${p.name} isn't a Unity product`);
  const s = startStep(run, p.id, 'check', `unity ${platform}${category ? ` ${category}` : ''}`, 'queued on the build server');
  const job = await genRun('unity.test', p.id, { project: p.build.project, platform, ...(category ? { category } : {}) }, (j) => updateStep(s, { job: j.id, detail: j.detail }));
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
 * Plays one scenario and (unless review is false) has Claude review it; adds findings to the backlog. mode (review.ts):
 * full (daily; regression-only once the scenario meets the product's quality bar), verify (beta runs, one-off checks),
 * regression (live checks). criteria: a roadmap task's acceptance criteria, judged on this playtest.
 */
export async function playtestProduct(run: string, p: Product, t: Playtest, { review = true, focus, mode = 'full', criteria }: { review?: boolean; focus?: string; mode?: ReviewMode; criteria?: string[] } = {}) {
  const name = nameOf(t);
  const s = startStep(run, p.id, 'playtest', name, 'starting');
  let url: string;
  // On the server a web product's local playtest plays its beta checkout, which must be beta's tip: never an old copy.
  const stale = t.where === 'local' ? staleBeta(p) : null;
  if (stale) {
    updateStep(s, { status: 'failed', detail: stale, data: { played: playedLocal(p), stale: true }, finished: true });
    return null;
  }
  // Local: what's played (beta on the server) is recorded, so the report and the deploy plan know the commit.
  const played = t.where === 'local' ? playedLocal(p) : null;
  let port: number | null = null;
  try {
    if (t.where === 'live') url = p.live;
    else if (p.build && betaLane()) {
      // Unity on the beta lane: the beta build, from its own website copy, on its own port.
      if (!played) throw new Error(`${BETA} isn't built yet (or its last build failed): nothing to play locally`);
      port = betaPort(p);
      stopServed(port);
      url = await serveDir(p, path.join(betaSiteDir(p), path.relative(p.site.split('/')[0], p.local.dir)), port);
    } else url = await ensureServer(p);
  } catch (e: any) {
    updateStep(s, { status: 'failed', detail: e.message, data: { played }, finished: true });
    return null;
  }
  // Live sites may not have the contract yet (it ships with the next deploy): auto falls back to a generic smoke test.
  const params: Record<string, unknown> = { url, mode: t.mode ?? (p.contract && t.where === 'local' ? 'contract' : 'auto'), ...(t.scenario ? { scenario: t.scenario } : {}), ...(t.timeout ? { timeout: t.timeout } : {}), ...(t.seed ? { seed: t.seed } : {}), ...(t.options ? { options: t.options } : {}) };
  if (t.mode === 'site') params.maxPages = 40;
  Object.assign(params, playtestExtras(p.id, name, t));
  if (gpuGate && p.engine !== 'static') {
    updateStep(s, { detail: 'waiting for the GPU machine' });
    await gpuGate;
  }
  // Timed out (and cancelled) if it hangs, so one stuck browser never holds up the run.
  const job = await runGenJob('playtest.run', p.id, params, (j) => updateStep(s, { job: j.id, detail: j.detail }), { runMs: playtestRunMs(t) })
    .finally(() => { if (port) stopServed(port); });
  const r = job.result ?? {};
  const ok = job.status === 'done';
  updateStep(s, {
    status: ok ? 'done' : 'failed', job: job.id,
    detail: ok ? `${r.outcome} in ${Math.round(r.seconds ?? 0)} s · ${r.problems?.length ?? 0} problems · ${r.fps?.average ?? '?'} fps${r.mode === 'generic' ? ' · no playtest contract' : ''}` : `failed: ${job.error ?? job.detail}`,
    data: ok ? { ...playtestData(job, url), played } : { error: job.error, url, played },
    finished: true,
  });
  // A live site failing its check may be down: tell J's phone (once per product and scenario every 6 hours).
  if (t.where === 'live' && (!ok || r.outcome === 'error')) {
    void notifyOnce(`live:${p.id}:${name}`, 6 * 3600_000, `Live check failed: ${p.name}`, `${p.live} (${name}): ${ok ? `the playtest ended in an error${r.problems?.[0]?.message ? `: ${r.problems[0].message}` : ''}` : (job.error ?? job.detail ?? 'the playtest failed')}`.slice(0, 600), { url: p.live, priority: 4, tags: ['rotating_light'] });
  }
  if (!ok || !review) return job;
  // A game rendered in software (no GPU server was free) plays at a few fps: the result says nothing about the game,
  // so it isn't reviewed and files no findings (agents would chase problems that aren't there).
  if (r.software && p.engine !== 'static') {
    updateStep(s, { status: 'skipped', detail: `inconclusive: no GPU server was free, the browser ran in software (${r.fps?.average ?? '?'} fps); not reviewed` });
    return job;
  }

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
  if (prev?.data?.reviewKey === sameKey && ageDays < 7 && !focus && !criteria?.length) {
    const rs0 = startStep(run, p.id, 'review', name, 'unchanged since the last review');
    updateStep(rs0, { status: 'skipped', detail: `unchanged since the last review (${prev.data.verdict}); not reviewed again`, data: { ...prev.data, reviewKey: sameKey, reused: prev.id }, finished: true });
    return job;
  }
  const rs = startStep(run, p.id, 'review', name, 'Claude is watching');
  const previous = lastStep(p.id, 'review', name, run)?.data ?? null;
  const rev = await runGenJob('playtest.review', p.id, reviewParams(p, job.id, reviewMode, {
    ...(focus ? { focus } : {}),
    ...(criteria?.length ? { criteria } : {}),
    ...(previous ? { previous: { summary: previous.summary, verdict: previous.verdict, scores: previous.scores, findings: (previous.findings ?? []).map((f: any) => ({ severity: f.severity, title: f.title })) } } : {}),
  }), (j) => updateStep(rs, { job: j.id, detail: j.detail }), { runMs: REVIEW_RUN_MS });
  if (rev.status !== 'done') {
    updateStep(rs, { status: 'failed', job: rev.id, detail: `failed: ${rev.error ?? rev.detail}`, finished: true });
    return job;
  }
  const v = rev.result;
  const merged = absorb(p.id, run, name, v.findings ?? [], { mode: reviewMode });
  const known = applyKnown(p.id, run, name, v.known ?? []);
  const parts = [
    `${merged.added.length} new`, merged.ideas.length ? `${merged.ideas.length} to ideas` : '', merged.skipped ? `${merged.skipped} not regressions, not filed` : '',
    known.fixed.length ? `${known.fixed.length} known look fixed` : '', known.present.length ? `${known.present.length} known still there` : '',
  ].filter(Boolean);
  updateStep(rs, {
    status: 'done', job: rev.id, cost: rev.cost ?? 0,
    detail: `${v.verdict} · ${reviewMode}${bar?.met ? ' (meets its quality bar)' : ''} · ${(v.findings ?? []).length} findings (${parts.join(', ')})${p.quality ? ` · bar: ${v.meetsBar ?? '?'}` : ''}`,
    data: { ...v, added: merged.added, updated: merged.updated, ideas: merged.ideas, skipped: merged.skipped, knownFixed: known.fixed, knownPresent: known.present, reviewKey: sameKey, mode: reviewMode, sha: fullSha, barHash: barHash(p.quality), bar: bar?.why ?? null }, finished: true,
  });
  // A roadmap task's acceptance criteria, judged on this playtest (the beta run after a merge; pm.ts reads them).
  if (criteria?.length) {
    const checks = await judgeCriteria(criteria, v, r);
    db.prepare(`UPDATE steps SET data = json_set(data, '$.criteria', json(?)) WHERE id = ?`).run(J(checks), rs);
  }
  // The playtest's own cost is tiny (local); attribute the review's.
  return job;
}

/** Runs the pipeline pieces on their own (from the API, CLI or MCP) as a small run. */
export function startPartial(kind: 'build' | 'playtest' | 'test', productId: string, opts: { scenario?: string; where?: 'local' | 'live'; device?: 'desktop' | 'phone'; mode?: string; force?: boolean; review?: boolean; focus?: string; reviewMode?: ReviewMode; platform?: 'EditMode' | 'PlayMode'; category?: string; origin?: string | null; seed?: number; options?: Record<string, unknown> } = {}) {
  const p = getProduct(productId);
  const id = newId('r');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, kind, 'running', `${kind} ${p.id}`, J([p.id]), J(opts), Date.now());
  tagRun(id, opts.origin);
  const done = (async () => {
    try {
      if (kind === 'build') await buildProduct(id, p, { force: opts.force ?? true });
      else if (kind === 'test') await testProduct(id, p, opts.platform ?? 'EditMode', opts.category);
      else await playtestProduct(id, p, { scenario: opts.scenario ?? (opts.mode ? undefined : 'smoke'), mode: (opts.mode as any) ?? undefined, where: opts.where ?? 'local', device: opts.device, seed: opts.seed, options: opts.options }, { review: opts.review !== false, focus: opts.focus, mode: opts.reviewMode ?? (opts.where === 'live' ? 'regression' : 'verify') });
      const cost = (db.prepare('SELECT COALESCE(SUM(cost), 0) AS c FROM steps WHERE run = ?').get(id) as any).c;
      const failed = (db.prepare(`SELECT COUNT(*) AS n FROM steps WHERE run = ? AND status = 'failed'`).get(id) as any).n;
      db.prepare(`UPDATE runs SET status = ?, detail = ?, finished = ?, cost = ? WHERE id = ?`).run(failed ? 'failed' : 'done', `${kind} ${p.id}${failed ? ' failed' : ''}`, Date.now(), cost, id);
    } catch (e: any) {
      db.prepare(`UPDATE runs SET status = 'failed', detail = ?, finished = ? WHERE id = ?`).run(String(e.message ?? e), Date.now(), id);
    }
  })();
  return { id, done };
}

/**
 * After beta moves (an approved change): the product's beta is brought up to date and played, as a small run in the
 * background. Its pre-deploy build is committed to beta, Unity builds beta, the beta site is rebuilt, and (on the
 * server) the first local scenario is playtested and reviewed.
 */
export function startBeta(productId: string, { focus, origin, criteria, scenario, options }: { focus?: string; origin?: string | null; criteria?: string[]; scenario?: string; options?: Record<string, unknown> } = {}) {
  const p = getProduct(productId);
  const id = newId('r');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'beta', 'running', `beta ${p.id}`, J([p.id]), J({ focus }), Date.now());
  tagRun(id, origin);
  const done = (async () => {
    try {
      const lane = betaLane();
      const top = p.repo.split('/')[0];
      if (lane && repoMap()[top]) {
        const g = startStep(id, p.id, 'repo', top);
        const r = syncRepo(top, repoMap()[top], BRANCH, betaFolders().has(top) ? BETA : undefined);
        updateStep(g, { status: r.action === 'failed' ? 'failed' : 'done', detail: `${r.detail}${r.head ? ` (${r.head})` : ''}`, data: r, finished: true });
      }
      if (p.deploy?.prebuild) await prebuildBeta(id, p);
      if (p.build && lane) await buildProduct(id, p);
      else void import('./previews.ts').then(({ buildPreview }) => buildPreview(p.id)).catch(() => {});
      // A merged roadmap task: the scenario its agent wrote for its criteria, and the criteria judged again.
      const t: Playtest | undefined = scenario ? { scenario, where: 'local', ...(options ? { options } : {}) } : p.playtests.find((x) => x.where === 'local' && x.device !== 'phone');
      if (lane && t) await playtestProduct(id, p, t, { focus, mode: 'verify', criteria });
      const cost = (db.prepare('SELECT COALESCE(SUM(cost), 0) AS c FROM steps WHERE run = ?').get(id) as any).c;
      const failed = (db.prepare(`SELECT COUNT(*) AS n FROM steps WHERE run = ? AND status = 'failed'`).get(id) as any).n;
      db.prepare(`UPDATE runs SET status = ?, detail = ?, finished = ?, cost = ? WHERE id = ?`).run(failed ? 'failed' : 'done', `beta ${p.id}${failed ? ' failed' : ''}`, Date.now(), cost, id);
    } catch (e: any) {
      db.prepare(`UPDATE runs SET status = 'failed', detail = ?, finished = ? WHERE id = ?`).run(String(e.message ?? e), Date.now(), id);
    }
  })();
  return { id, done };
}

/** Makes a product's missing or out-of-date assets (or only some, or forced) as a run. */
export function startAssets(productId: string, { only, force = false, origin }: { only?: string[]; force?: boolean; origin?: string | null } = {}) {
  const p = getProduct(productId);
  const st = assetStatus(p.id);
  if (!st.manifest) throw new Error(`${p.name} has no hawkes.assets.json`);
  const todo = st.assets.filter((a) => (only?.length ? only.includes(a.id) : force || a.status !== 'current'));
  const id = newId('r');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'assets', 'running', `assets ${p.id}: ${todo.length}`, J([p.id]), J({ only, force }), Date.now());
  tagRun(id, origin);
  const done = (async () => {
    await Promise.all(todo.map(async (a) => {
      const s = startStep(id, p.id, 'asset', a.id, a.status);
      try {
        const r: any = await makeAsset(p.id, a.id, { force: force || Boolean(only?.length), onUpdate: (detail, job) => updateStep(s, { detail, job }) });
        updateStep(s, { status: r.skipped ? 'skipped' : 'done', detail: r.skipped ? `skipped: ${r.skipped}` : `made ${r.files.join(', ')}${r.picked ? ` (picked: ${r.picked.reason})` : ''}`, data: r, cost: r.cost ?? 0, finished: true });
      } catch (e: any) {
        updateStep(s, { status: 'failed', detail: e.message, finished: true });
      }
    }));
    const failed = (db.prepare(`SELECT COUNT(*) AS n FROM steps WHERE run = ? AND status = 'failed'`).get(id) as any).n;
    const cost = (db.prepare('SELECT COALESCE(SUM(cost), 0) AS c FROM steps WHERE run = ?').get(id) as any).c;
    db.prepare('UPDATE runs SET status = ?, detail = ?, finished = ?, cost = ? WHERE id = ?').run(failed ? 'failed' : 'done', `assets ${p.id}: ${todo.length - failed} made${failed ? `, ${failed} failed` : ''}`, Date.now(), cost, id);
  })();
  return { id, todo: todo.map((a) => a.id), done };
}

export { today, localUrl, gen };
