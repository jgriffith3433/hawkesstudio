// Going live is pushing main. Whoever pushes it (J from his PC or GitHub, Studio's "Go live", an agent), each product
// source repo's GitHub Actions workflow (.github/workflows/hawkes-studio.yml) tells Studio, and Studio takes it from
// there (POST /api/hooks/github, ref refs/heads/main):
//
// - Web products: GitHub Pages publishes main by itself (Dose Of Destruction through its pages.yml; products with a build
//   step build it in their own workflow). Studio records the deploy and playtests the live site once Pages is done.
// - Unity games: the source repo's main doesn't publish anything; the game is served from the website repo's Game/v<n>.
//   Studio publishes: when that exact commit has a beta build, that tested build is committed to the website repo's
//   main; otherwise the commit is built on the build server first (into a scratch copy of the website). Then Pages
//   publishes the website and Studio playtests it.
//
// A commit that already went live (Studio's own go live records it) is not published twice.

import fs from 'node:fs';
import path from 'node:path';
import { loadProducts, PROJECTS, type Product } from './config.ts';
import { db, newId, J } from './db.ts';
import { MAIN, AUTHOR, must, repoDirs, fetchOrigin, shaOf, betaBuild, betaSiteDir, scratch, git as gitIn } from './beta.ts';
import { genRun } from './gen.ts';
import { startStep, updateStep } from './pipeline.ts';
import { verifyLive, repoSlug } from './deploy.ts';

const rel = (abs: string) => path.relative(PROJECTS, abs).replace(/\\/g, '/');

/** A run in the dashboard for one go live (its steps: build if needed, publish). */
function liveRun(p: Product, sha: string) {
  const id = newId('r');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'live', 'running', `go live ${p.id} ${sha.slice(0, 7)}`, J([p.id]), J({ sha }), Date.now());
  const end = (status: 'done' | 'failed', detail: string) => {
    const cost = (db.prepare('SELECT COALESCE(SUM(cost), 0) AS c FROM steps WHERE run = ?').get(id) as any).c;
    db.prepare('UPDATE runs SET status = ?, detail = ?, finished = ?, cost = ? WHERE id = ?').run(status, detail, Date.now(), cost, id);
  };
  return { id, end };
}

const liveAlready = (p: Product, sha: string) =>
  db.prepare(`SELECT id FROM deploys WHERE product = ? AND kind = 'deploy' AND (after = ? OR beta = ? OR source_after = ?) AND rolled_back IS NULL ORDER BY at DESC LIMIT 1`).get(p.id, sha, sha, sha) as { id: string } | undefined;

/**
 * Publishes a Unity game's source commit: its build goes to the website repo's main (GitHub Pages serves it).
 * Uses the beta build when it is of this commit, else builds the commit first.
 */
export async function publishUnity(p: Product, sha: string, { by = 'a push to main' } = {}) {
  if (!p.build) throw new Error(`${p.name} isn't a Unity product`);
  const done = liveAlready(p, sha);
  if (done) return { skipped: `${sha.slice(0, 7)} is already live (${done.id})` };
  const { source, site } = repoDirs(p);
  const run = liveRun(p, sha);
  try {
    fetchOrigin(source);
    fetchOrigin(site);
    const before = shaOf(site, `origin/${MAIN}`)!;
    let copy: string;
    let version: string | null = null;
    let what: string;
    const bb = betaBuild(p);
    if (bb?.ok && bb.sha === sha && fs.existsSync(betaSiteDir(p))) {
      copy = betaSiteDir(p);
      version = bb.version ?? null;
      what = `the beta build of ${sha.slice(0, 7)}${version ? ` (Game/v${version})` : ''}`;
    } else {
      // Not built on beta (a commit pushed straight to main, or beta moved on): build this commit for live.
      const src = scratch(source, `${p.id}-live-src`, sha);
      copy = scratch(site, `${p.id}-live-site`, before);
      const projectDir = rel(path.join(src, path.relative(p.repo.split('/')[0], p.build.project)));
      const siteDir = rel(path.join(copy, path.relative(p.site.split('/')[0], p.site)));
      const s = startStep(run.id, p.id, 'build', 'unity', `building ${sha.slice(0, 7)} for live`);
      const job = await genRun('unity.build', p.id, { project: p.build.project, site: p.build.site, method: p.build.method, projectDir, siteDir }, (j) => updateStep(s, { job: j.id, detail: j.detail }));
      const r = job.result ?? {};
      if (job.status !== 'done') {
        updateStep(s, { status: 'failed', detail: `failed: ${job.error ?? job.detail}`, job: job.id, cost: job.cost ?? 0, finished: true });
        throw new Error(`the live build of ${sha.slice(0, 7)} failed: ${job.error ?? job.detail}`);
      }
      updateStep(s, { status: 'done', detail: `built ${sha.slice(0, 7)}${r.version ? ` Game/v${r.version}` : ''} in ${Math.round((r.seconds ?? 0) / 60)} min`, job: job.id, cost: job.cost ?? r.cost ?? 0, data: r, finished: true });
      version = r.version ?? null;
      what = `a build of ${sha.slice(0, 7)}${version ? ` (Game/v${version})` : ''}`;
    }
    const s = startStep(run.id, p.id, 'deploy', p.site, `publishing ${what}`);
    must(gitIn(copy, ['add', '-A']), 'git add');
    let after = before;
    if (!gitIn(copy, ['diff', '--cached', '--quiet']).ok) {
      must(gitIn(copy, [...AUTHOR, 'commit', '--quiet', '-m', `Go live: ${p.name}${version ? ` Game/v${version}` : ''} (${p.repo.split('/')[0]} ${sha.slice(0, 7)}, ${by})`]), 'committing the build');
      // The website's main may have moved since the copy was made: put the build on top of it.
      must(gitIn(copy, ['fetch', '--quiet', 'origin', MAIN]), 'fetching the website');
      must(gitIn(copy, ['rebase', '--quiet', `origin/${MAIN}`]), `rebasing onto ${p.site}'s ${MAIN}`);
      must(gitIn(copy, ['push', '--quiet', 'origin', `HEAD:refs/heads/${MAIN}`]), `pushing ${p.site}'s ${MAIN}`);
      after = shaOf(copy, 'HEAD')!;
    }
    const id = newId('d');
    db.prepare('INSERT INTO deploys (id, product, kind, repo, before, after, beta, source, source_before, source_after, version, by, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, p.id, 'deploy', p.site, before, after, sha, p.repo, null, sha, version, by, `published ${what}`, Date.now());
    updateStep(s, { status: 'done', detail: after === before ? 'the build was already on the website' : `${p.site} ${MAIN} -> ${after.slice(0, 7)}: ${what}`, finished: true });
    run.end('done', `live: ${p.name} ${what}`);
    fetchOrigin(site);
    if (after !== before) void verifyLive(p.id, after, `Just went live (${p.repo.split('/')[0]} ${sha.slice(0, 7)}, ${by})`);
    return { deploy: id, website: p.site, before: before.slice(0, 7), after: after.slice(0, 7), what };
  } catch (e: any) {
    run.end('failed', `go live ${p.id} ${sha.slice(0, 7)} failed: ${String(e.message ?? e).slice(0, 300)}`);
    throw e;
  }
}

/**
 * A site whose repo builds itself on GitHub (.github/workflows/pages.yml) but whose Pages still publishes the branch:
 * switch Pages to "GitHub Actions" and run the workflow (the run the push started fails at its deploy step while Pages
 * is set to the branch). Happens once per site, the first time the workflow reaches main. Needs GITHUB_TOKEN with
 * Pages and Actions write on the repo.
 */
async function ensurePagesWorkflow(slug: string, sha: string) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return 'no GITHUB_TOKEN';
  const api = (route: string, init: RequestInit = {}) =>
    fetch(`https://api.github.com/repos/${slug}/${route}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000) });
  const wf = await api(`contents/.github/workflows/pages.yml?ref=${sha}`);
  if (!wf.ok) return 'no pages.yml: Pages publishes the branch';
  const pages: any = await (await api('pages')).json().catch(() => ({}));
  if (pages.build_type === 'workflow') return 'Pages already builds with GitHub Actions';
  const put = await api('pages', { method: 'PUT', body: JSON.stringify({ build_type: 'workflow' }) });
  if (!put.ok) return `couldn't switch Pages to GitHub Actions (HTTP ${put.status}): switch it in the repo's Settings > Pages`;
  const run = await api('actions/workflows/pages.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: MAIN }) });
  return run.ok ? 'switched Pages to GitHub Actions and started the build' : `switched Pages to GitHub Actions; starting the build failed (HTTP ${run.status}): run it from the Actions tab`;
}

/** A push to a product source repo's main (from its workflow): publish Unity games; record and check web products. */
export async function onMainPush(folder: string, sha: string) {
  const products = loadProducts().filter((p) => p.repo.split('/')[0] === folder);
  const out: Record<string, unknown> = {};
  for (const p of products) {
    if (p.build) {
      out[p.id] = await publishUnity(p, sha).catch((e: any) => ({ error: String(e.message ?? e) }));
      continue;
    }
    // A web product: Pages publishes it. Record it (rollback needs the previous commit) and playtest it once live.
    const slug = repoSlug(p.site);
    const pages = slug ? await ensurePagesWorkflow(slug, sha).catch((e: any) => `checking Pages failed: ${e.message ?? e}`) : null;
    if (liveAlready(p, sha)) { out[p.id] = { skipped: 'already recorded', pages }; continue; }
    const { site } = repoDirs(p);
    const before = shaOf(site, `origin/${MAIN}`);
    fetchOrigin(site);
    const id = newId('d');
    db.prepare('INSERT INTO deploys (id, product, kind, repo, before, after, beta, source, source_before, source_after, version, by, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, p.id, 'deploy', p.site, before === sha ? null : before, sha, null, null, null, null, null, 'a push to main', 'pushed to main; GitHub Pages publishes it', Date.now());
    void verifyLive(p.id, sha, `Just went live (pushed to main, ${sha.slice(0, 7)})`);
    out[p.id] = { deploy: id, pages, note: 'GitHub Pages publishes it; Studio playtests the live site when it is out' };
  }
  return out;
}
