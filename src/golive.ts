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
import { loadProducts, PROJECTS, managedElsewhere, type Product } from './config.ts';
import { db, newId, J } from './db.ts';
import { MAIN, AUTHOR, must, repoDirs, fetchOrigin, shaOf, betaBuild, betaSiteDir, scratch, WORK, commitsIn, git as gitIn, gitAsync } from './beta.ts';
import { addReleaseTo, releaseLine, STUDIO_RELEASE } from './release.ts';
import { unityBuild } from './buildpkgs.ts';
import { startStep, updateStep, resumedStep } from './pipeline.ts';
import { critical } from './drain.ts';
import { repoMap } from './repos.ts';
import { verifyLive, repoSlug, publisherOf } from './deploy.ts';
import { repoToken } from './ghtoken.ts';
import { kickFollowups } from './followup-kick.ts';

const rel = (abs: string) => path.relative(PROJECTS, abs).replace(/\\/g, '/');

/** A run in the dashboard for one go live (its steps: build if needed, publish). */
function liveRun(p: Product, sha: string, by: string, resumed?: string) {
  const id = resumed ?? newId('r');
  if (!resumed) db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'live', 'running', `go live ${p.id} ${sha.slice(0, 7)}`, J([p.id]), J({ sha, by }), Date.now());
  const end = (status: 'done' | 'failed', detail: string) => {
    const cost = (db.prepare('SELECT COALESCE(SUM(cost), 0) AS c FROM steps WHERE run = ?').get(id) as any).c;
    db.prepare('UPDATE runs SET status = ?, detail = ?, finished = ?, cost = ? WHERE id = ?').run(status, detail, Date.now(), cost, id);
    kickFollowups();
  };
  return { id, end };
}

/** Whether the copy's HEAD has commits that `main` (the website's main as fetched before) doesn't. */
export async function unpublished(copy: string, main: string) {
  const r = await gitAsync(copy, ['rev-list', '--count', `${main}..HEAD`]);
  return r.ok && Number(r.out.trim()) > 0;
}

const liveAlready = (p: Product, sha: string) =>
  db.prepare(`SELECT id FROM deploys WHERE product = ? AND kind = 'deploy' AND (after = ? OR beta = ? OR source_after = ?) AND rolled_back IS NULL ORDER BY at DESC LIMIT 1`).get(p.id, sha, sha, sha) as { id: string } | undefined;

/**
 * Publishes a Unity game's source commit: its build goes to the website repo's main (GitHub Pages serves it).
 * Uses the beta build when it is of this commit, else builds the commit first.
 */
export async function publishUnity(p: Product, sha: string, { by = 'a push to main', run: resumed }: { by?: string; run?: string } = {}) {
  if (!p.build) throw new Error(`${p.name} isn't a Unity product`);
  if (p.build.r2 && process.env.K_SERVICE) return publishFromBeta(p, sha, by, resumed);
  const { source, site } = repoDirs(p);
  const done = liveAlready(p, sha);
  if (done) {
    if (resumed) liveRun(p, sha, by, resumed).end('done', `live: ${p.name} ${sha.slice(0, 7)} (${done.id})`);
    return { skipped: `${sha.slice(0, 7)} is already live (${done.id})` };
  }
  // Resumed after a Studio restart (pipeline.ts resumeRuns): the same run, and its build job waited for again.
  const run = liveRun(p, sha, by, resumed);
  try {
    await fetchOrigin(source);
    await fetchOrigin(site);
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
      const s = startStep(run.id, p.id, 'build', 'unity', `building ${sha.slice(0, 7)} for live`);
      // Resumed with its build running or done: the scratch copies hold its work (and maybe its output); not reset.
      const prior = resumedStep(s);
      const src = prior?.job ? path.join(WORK(), `${p.id}-live-src`) : await scratch(source, `${p.id}-live-src`, sha);
      copy = prior?.job ? path.join(WORK(), `${p.id}-live-site`) : await scratch(site, `${p.id}-live-site`, before);
      const projectDir = rel(path.join(src, path.relative(p.repo.split('/')[0], p.build.project)));
      const siteDir = rel(path.join(copy, path.relative(p.site.split('/')[0], p.site)));
      const job = await unityBuild(p.id, { project: p.build.project, site: p.build.site, method: p.build.method, projectDir, siteDir }, (j) => updateStep(s, { job: j.id, detail: j.detail }),
        { job: prior?.job ?? undefined, onSubmit: (id) => updateStep(s, { job: id }) });
      const r = job.result ?? {};
      if (job.status !== 'done') {
        updateStep(s, { status: 'failed', detail: `failed: ${job.error ?? job.detail}`, job: job.id, cost: job.cost ?? 0, finished: true });
        throw new Error(`the live build of ${sha.slice(0, 7)} failed: ${job.error ?? job.detail}`);
      }
      updateStep(s, { status: 'done', detail: `built ${sha.slice(0, 7)}${r.version ? ` Game/v${r.version}` : ''} in ${Math.round((r.seconds ?? 0) / 60)} min`, job: job.id, cost: job.cost ?? r.cost ?? 0, data: r, finished: true });
      version = r.version ?? null;
      what = `a build of ${sha.slice(0, 7)}${version ? ` (Game/v${version})` : ''}`;
    }
    // The release entry in the website's releases.json, inside the build commit (never stops going live).
    let release: Awaited<ReturnType<typeof addReleaseTo>> | null = null;
    try {
      const last = db.prepare(`SELECT source_after FROM deploys WHERE product = ? AND kind = 'deploy' AND source_after IS NOT NULL AND rolled_back IS NULL ORDER BY at DESC LIMIT 1`).get(p.id) as { source_after: string } | undefined;
      const fallbackCommits = (last ? commitsIn(source, `${last.source_after}..${sha}`) : commitsIn(source, sha, 20)).filter((c) => !c.title.startsWith(STUDIO_RELEASE));
      release = await addReleaseTo(p, path.join(copy, path.relative(p.site.split('/')[0], p.site)), { source, target: sha, build: String(version ?? sha.slice(0, 7)), fallbackCommits });
      if (release) what += ` · ${releaseLine(release)}`;
    } catch (e: any) {
      console.warn(`[studio] ${p.id}: no release entry for ${sha.slice(0, 7)}: ${e.message ?? e}`);
    }
    const s = startStep(run.id, p.id, 'deploy', p.site, `publishing ${what}`);
    // Pushing the website's main and recording it are one critical section (drain.ts): a deploy of Studio waits for it.
    return critical(`publishing ${p.name} live`, async () => {
      must(await gitAsync(copy, ['add', '-A']), 'git add');
      let after = before;
      const staged = !(await gitAsync(copy, ['diff', '--cached', '--quiet'])).ok;
      if (staged) must(await gitAsync(copy, [...AUTHOR, 'commit', '--quiet', '-m', `Go live: ${p.name}${version ? ` Game/v${version}` : ''} (${p.repo.split('/')[0]} ${sha.slice(0, 7)}, ${by})`]), 'committing the build');
      // A tag build (tagbuild.ts) is already committed: the copy sits on the website's beta commit that holds it, with
      // nothing staged. Either way, whatever the copy has that main lacks goes live.
      if (staged || (await unpublished(copy, before))) {
        // The website's main may have moved since the copy was made: put the build on top of it.
        must(await gitAsync(copy, ['fetch', '--quiet', 'origin', MAIN]), 'fetching the website');
        must(await gitAsync(copy, ['rebase', '--quiet', `origin/${MAIN}`]), `rebasing onto ${p.site}'s ${MAIN}`);
        must(await gitAsync(copy, ['push', '--quiet', 'origin', `HEAD:refs/heads/${MAIN}`], 30 * 60_000), `pushing ${p.site}'s ${MAIN}`);
        after = shaOf(copy, 'HEAD')!;
      }
      const id = newId('d');
      db.prepare('INSERT INTO deploys (id, product, kind, repo, before, after, beta, source, source_before, source_after, version, by, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, p.id, 'deploy', p.site, before, after, sha, p.repo, null, sha, version, by, `published ${what}`, Date.now());
      updateStep(s, { status: 'done', detail: after === before ? 'the build was already on the website' : `${p.site} ${MAIN} -> ${after.slice(0, 7)}: ${what}`, finished: true });
      run.end('done', `live: ${p.name} ${what}`);
      await fetchOrigin(site);
      if (after !== before) void verifyLive(p.id, after, `Just went live (${p.repo.split('/')[0]} ${sha.slice(0, 7)}, ${by})`);
      return { deploy: id, website: p.site, before: before.slice(0, 7), after: after.slice(0, 7), what, release: release && { version: release.version, title: release.title } };
    });
  } catch (e: any) {
    run.end('failed', `go live ${p.id} ${sha.slice(0, 7)} failed: ${String(e.message ?? e).slice(0, 300)}`);
    throw e;
  }
}

/**
 * Going live for a game whose builds are in R2 (docs/unity-builds-storage.md), on Cloud Run: the website's beta commit
 * the tag build pushed already has the page and Game/build.json naming that build, and the files are in R2, so live is
 * the website's main fast-forwarded to that commit through GitHub's API. Nothing is cloned (Sick Of It's website repo
 * is 8 GB) and nothing is built: a commit not built on beta is refused with the way to build it.
 */
async function publishFromBeta(p: Product, sha: string, by: string, resumed?: string) {
  const run = liveRun(p, sha, by, resumed);
  try {
    const bb = betaBuild(p);
    if (!(bb?.ok && bb.sha === sha && bb.base)) throw new Error(`${sha.slice(0, 7)} has no beta build: push a build tag on it (git tag build-<name> ${sha.slice(0, 7)}), let it pass on beta, then go live`);
    const slug = repoMap()[p.site.split('/')[0]];
    // The repo's own token (ghtoken.ts: J's for his repos, the GitHub App's for anyone else's).
    const token = slug ? await repoToken(slug) : null;
    if (!slug || !token) throw new Error(`no GitHub repo or token for ${p.site}`);
    const api = (route: string, init: RequestInit = {}) => fetch(`https://api.github.com/repos/${slug}/${route}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'hawkes-studio' }, signal: AbortSignal.timeout(30_000) });
    const ref: any = await (await api(`git/ref/heads/${MAIN}`)).json();
    const before = String(ref?.object?.sha ?? '');
    if (!before) throw new Error(`couldn't read ${slug} ${MAIN}`);
    const what = `the beta build of ${sha.slice(0, 7)}${bb.version ? ` (Game/v${bb.version}, from R2)` : ''}`;
    const s = startStep(run.id, p.id, 'deploy', p.site, `publishing ${what}`);
    return await critical(`publishing ${p.name} live`, async () => {
      if (before !== bb.base) {
        const r = await api(`git/refs/heads/${MAIN}`, { method: 'PATCH', body: JSON.stringify({ sha: bb.base, force: false }) });
        if (!r.ok) throw new Error(r.status === 422 ? `${slug} ${MAIN} has commits its beta lacks: merge ${MAIN} into beta (studio deploy ${p.id} --merge-main), build again, then go live` : `moving ${slug} ${MAIN} failed (HTTP ${r.status})`);
      }
      const after = bb.base!;
      const id = newId('d');
      db.prepare('INSERT INTO deploys (id, product, kind, repo, before, after, beta, source, source_before, source_after, version, by, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, p.id, 'deploy', p.site, before, after, sha, p.repo, null, sha, bb.version ?? null, by, `published ${what}`, Date.now());
      updateStep(s, { status: 'done', detail: after === before ? 'the build was already on the website' : `${p.site} ${MAIN} -> ${after.slice(0, 7)}: ${what}`, finished: true });
      run.end('done', `live: ${p.name} ${what}`);
      if (after !== before) void verifyLive(p.id, after, `Just went live (${p.repo.split('/')[0]} ${sha.slice(0, 7)}, ${by})`);
      return { deploy: id, website: p.site, before: before.slice(0, 7), after: after.slice(0, 7), what, release: null };
    });
  } catch (e: any) {
    run.end('failed', `go live ${p.id} ${sha.slice(0, 7)} failed: ${String(e.message ?? e).slice(0, 300)}`);
    throw e;
  }
}

/**
 * A site whose repo builds itself on GitHub (.github/workflows/pages.yml) but whose Pages still publishes the branch:
 * switch Pages to "GitHub Actions" and run the workflow (the run the push started fails at its deploy step while Pages
 * is set to the branch). Happens once per site, the first time the workflow reaches main. Needs the repo's token with
 * Pages and Actions write on the repo.
 */
async function ensurePagesWorkflow(slug: string, sha: string) {
  const token = await repoToken(slug);
  if (!token) return `no GitHub token for ${slug}`;
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

/**
 * A push to main of a project's GitHub repo in any Studio (a customer's: builds.ts projectsForRepo), by anyone: recorded
 * as a go live (rollback needs the commit before it) and checked live, unless Studio's own go live already recorded it.
 */
export async function onMainPushGitHub(slug: string, sha: string) {
  const { projectsForRepo } = await import('./builds.ts');
  const out: Record<string, unknown> = {};
  let followed = false;
  for (const p of projectsForRepo(slug).filter((x) => !managedElsewhere(x))) {
    if (liveAlready(p, sha)) { out[p.id] = { skipped: 'already recorded' }; continue; }
    // Pushed to main some other way than Studio's go live: beta takes main's commits now (one merge per repo), so the
    // next go live isn't stopped by "main has commits beta lacks".
    if (!followed) followed = followMainIntoBeta(p, sha);
    const last = db.prepare(`SELECT after FROM deploys WHERE product = ? ORDER BY at DESC LIMIT 1`).get(p.id) as { after: string } | undefined;
    const id = newId('d');
    db.prepare('INSERT INTO deploys (id, product, kind, repo, before, after, beta, source, source_before, source_after, version, by, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, p.id, 'deploy', slug, last && last.after !== sha ? last.after : null, sha, null, null, null, null, null, 'a push to main', `pushed to main; ${publisherOf(p).says} it`, Date.now());
    if (p.live) void verifyLive(p.id, sha, `Just went live (pushed to main, ${sha.slice(0, 7)})`);
    out[p.id] = { deploy: id, note: p.live ? `${publisherOf(p).done}; Studio playtests the live site when it is out` : 'recorded (no live address to check)' };
  }
  return out;
}

/**
 * After a push to main that wasn't Studio's own go live (a pull request merged straight into main, a person's push):
 * merge main back into beta, queued like the Go live page's "Merge main into beta" (nothing goes live; beta's push
 * redeploys and playtests it). 2026-11-02: three PRs merged into Studio's main left beta behind, and going live
 * stopped at "main has 5 commit(s) beta lacks". A merge with nothing to bring is a no-op; a conflict fails the op with
 * how to resolve it. STUDIO_FOLLOW_MAIN=0 turns it off. Returns whether a merge was queued.
 */
export function followMainIntoBeta(p: Product, sha: string): boolean {
  if (process.env.STUDIO_FOLLOW_MAIN === '0' || p.build) return false;
  void import('./deploy.ts')
    .then(({ queueLive }) => {
      const { op } = queueLive('golive', { product: p.id, confirm: `DEPLOY ${p.id}`, by: `Studio (main moved to ${sha.slice(0, 7)} outside a go live: bringing beta up to date)`, mergeMain: true });
      console.log(`[golive] ${p.id}: main moved outside a go live (${sha.slice(0, 7)}); merging it into beta: ${op.id}`);
    })
    .catch((e: any) => console.warn(`[golive] ${p.id}: couldn't queue merging main into beta: ${e?.message ?? e}`));
  return true;
}

/** A push to a product source repo's main (from its workflow): publish Unity games; record and check web products. */
export async function onMainPush(folder: string, sha: string) {
  // A project handed over to another Studio (config.ts managedBy) goes live there, not here.
  const products = loadProducts().filter((p) => p.repo.split('/')[0] === folder && !managedElsewhere(p));
  const out: Record<string, unknown> = {};
  for (const p of products) {
    if (p.build) {
      out[p.id] = await publishUnity(p, sha).catch((e: any) => ({ error: String(e.message ?? e) }));
      continue;
    }
    // A web product: Pages publishes it. Record it (rollback needs the previous commit) and playtest it once live.
    const slug = repoSlug(p.site);
    const own = publisherOf(p).box; // its own server, not Pages: nothing to switch on GitHub
    const pages = slug && !own ? await ensurePagesWorkflow(slug, sha).catch((e: any) => `checking Pages failed: ${e.message ?? e}`) : null;
    if (liveAlready(p, sha)) { out[p.id] = { skipped: 'already recorded', pages }; continue; }
    followMainIntoBeta(p, sha);
    const { site } = repoDirs(p);
    const before = shaOf(site, `origin/${MAIN}`);
    await fetchOrigin(site);
    const id = newId('d');
    db.prepare('INSERT INTO deploys (id, product, kind, repo, before, after, beta, source, source_before, source_after, version, by, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, p.id, 'deploy', p.site, before === sha ? null : before, sha, null, null, null, null, null, 'a push to main', own ? 'pushed to main; its own server pulls it' : 'pushed to main; GitHub Pages publishes it', Date.now());
    void verifyLive(p.id, sha, `Just went live (pushed to main, ${sha.slice(0, 7)})`);
    out[p.id] = { deploy: id, pages, note: own ? `${publisherOf(p).done}; Studio playtests the live site when it is out` : 'GitHub Pages publishes it; Studio playtests the live site when it is out' };
  }
  return out;
}
