// Going live. Pushing a website repo's main branch publishes it (GitHub Pages, or DoD's Actions workflow) within
// minutes, so main only ever moves here, and only on J's word:
//
//   deployPlan(product)  what going live ships: the commits on beta that main lacks (titles, authors), the beta commit
//                        that was playtested and how those playtests and reviews went, blockers and warnings. Read-only.
//   deploy(product, { confirm: "DEPLOY <product>" })
//                        fast-forwards main to the playtested beta commit (never a merge, never a force push). Refused
//                        when beta moved since it was played, or main has commits beta lacks (mergeMain() first).
//                        Unity: the beta website copy (the website's beta, its page changes, plus the beta build's
//                        Game/v<n>) is committed and fast-forwards the website repo's main (and its beta follows), and the
//                        source repo's main is fast-forwarded to beta. Studio then playtests live.
//   rollbackPlan / rollback(product, { confirm: "ROLLBACK <product>" })
//                        puts main back to what was live before the last go live: a new commit with that commit's
//                        files (never a force push). Beta keeps its commits: fix forward there.
//
// Every go live and rollback is a row in `deploys` (beta.ts), so "the previous live commit" is known.
// Only J gives the confirmations; agents (and Talk) show the plan and wait for his exact words.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { critical } from './drain.ts';
import { getProduct, StudioError, type Product } from './config.ts';
import { git } from './local.ts';
import { startPartial } from './pipeline.ts';
import { db, newId, rowToStep, type Step } from './db.ts';
import { previewUrl } from './previews.ts';
import { noRuntimeChange } from './playplan.ts';
import { opLog, registerOp, enqueue, queuePosition, getOp, type Op } from './ops.ts';
import {
  BETA, MAIN, STUDIO_ROLLBACK, AUTHOR, must, repoDirs, compareBeta, NotClonedError, fetchOrigin, shaOf, commitOf, commitsIn, betaBuild, saveBetaBuild,
  betaSiteDir, betaSiteFolder, scratch, listDeploys, mergeMainIntoBeta, prebuilt, git as gitIn, gitAsync, type Commit, type DeployRow,
} from './beta.ts';
import { STUDIO_RELEASE, RELEASES, playedCommit, releasesAt, releasesPath, readReleases, draftWithin, addReleaseTo, releaseLine, releaseNotesLine, type Draft } from './release.ts';

const brief = (c: Commit | null) => c && { sha: c.sha, short: c.short, title: c.title, author: c.author, date: c.date };

/** The latest local playtest of each scenario that played `sha` (clean), with its review. */
export function testedAt(productId: string, sha: string | undefined, carries: (from: string) => boolean = () => false) {
  const steps = (db.prepare(`SELECT * FROM steps WHERE product = ? AND kind IN ('playtest', 'review') AND name LIKE '%@local%' ORDER BY started DESC LIMIT 300`).all(productId) as any[]).map(rowToStep);
  const plays = steps.filter((s) => s.kind === 'playtest' && s.status !== 'running');
  const last = plays.find((s) => s.data?.played) ?? null;
  const byName = new Map<string, Step>();
  if (sha) for (const s of plays) if (s.data?.played?.sha === sha && !s.data.played.dirty && !byName.has(s.name)) byName.set(s.name, s);
  // A clean pass of an earlier commit counts when nothing a player can see changed since (only docs and notes): a beta
  // run doesn't replay it (pipeline.ts unchangedPass), so go live must not ask for it either. Exact plays win.
  const carried = new Set<string>();
  if (sha) {
    const tried = new Map<string, boolean>();
    for (const s of plays) {
      const from = s.data?.played?.sha;
      if (byName.has(s.name) || s.status !== 'done' || !['won', 'done'].includes(s.data?.outcome) || !from || from === sha || s.data.played.dirty) continue;
      if (!tried.has(from)) tried.set(from, carries(from));
      if (tried.get(from)) { byName.set(s.name, s); carried.add(s.name); }
    }
  }
  const tested = [...byName.values()].map((s) => {
    const rv = steps.find((r) => r.kind === 'review' && r.run === s.run && r.name === s.name && ['done', 'skipped'].includes(r.status));
    return {
      name: s.name, status: s.status, outcome: s.data?.outcome ?? null, detail: carried.has(s.name) ? `passed on ${String(s.data.played.sha).slice(0, 7)}; only docs and notes changed since, so it isn't played again` : s.detail, when: s.finished, run: s.run, video: s.data?.video ?? null,
      carriedFrom: carried.has(s.name) ? String(s.data.played.sha).slice(0, 7) : null,
      verdict: rv?.data?.verdict ?? null, summary: rv?.data?.summary ?? null, scores: rv?.data?.scores ?? null,
      blockers: (rv?.data?.findings ?? []).filter((f: any) => f.severity === 'blocker').map((f: any) => f.title),
    };
  });
  return { tested, last: last && { name: last.name, when: last.finished, played: last.data.played } };
}

/**
 * The beta-only step that clears a plan blocker (the Go live cards' button): "merge-main" merges live into beta (it
 * also makes a missing beta) and then plays beta; "beta" is the beta run (pre-deploy build, Unity build, beta site, a
 * local playtest); "rebuild" is a forced Unity build of beta on top of live. None of them goes live. null: no button.
 */
export type BlockerFix = 'merge-main' | 'beta' | 'rebuild' | 'sync';
export function blockerFix(blocker: string): BlockerFix | null {
  if (/^git: \S+ isn't cloned on this server yet/.test(blocker)) return 'sync';
  if (/^git:|^Nothing to go live/.test(blocker)) return null;
  if (/ has no \S+ branch yet|commit\(s\) \S+ lacks/.test(blocker)) return 'merge-main';
  if (/'s \S+ moved since the beta build/.test(blocker)) return 'rebuild';
  if (/hasn't been playtested|isn't its pre-deploy build|The beta build is of|has no build yet|The last build of|The beta website copy sits on/.test(blocker)) return 'beta';
  return null;
}
/**
 * The one button for a plan's blockers: merging live in first (it plays beta after), then the beta run (it rebuilds
 * too). None when there's nothing to go live.
 */
export function planFix(blockers: string[]): BlockerFix | null {
  if (blockers.some((b) => b.startsWith('Nothing to go live'))) return null;
  const fixes = new Set(blockers.map(blockerFix));
  return (['sync', 'merge-main', 'beta', 'rebuild'] as const).find((f) => fixes.has(f)) ?? null;
}

/** notesWaitMs: how long to wait for the release notes being written (the Approve card waits longer, to show them). */
export async function deployPlan(productId: string, { notesWaitMs = 20_000 }: { notesWaitMs?: number } = {}) {
  const p = getProduct(productId);
  const { source, site, unity } = repoDirs(p);
  const blockers: string[] = [];
  const warnings: string[] = [];
  let cmp: Awaited<ReturnType<typeof compareBeta>> = { main: null, beta: null, ahead: [], behind: [] };
  // Unity: the website repo's own beta (page changes by agents) vs its main.
  let web: typeof cmp = { main: null, beta: null, ahead: [], behind: [] };
  let notCloned: string | null = null;
  try {
    cmp = await compareBeta(source);
    if (unity && site !== source) web = await compareBeta(site);
  } catch (e: any) {
    if (e instanceof NotClonedError) notCloned = e.folder;
    blockers.push(`git: ${e.message}`);
  }
  const beta = cmp.beta;
  if (!beta && !notCloned) blockers.push(`${p.repo.split('/')[0]} has no ${BETA} branch yet. It's made from ${MAIN} when the first agent change starts (or "studio deploy ${p.id} --merge-main" makes it now).`);
  if (cmp.behind.length) {
    const rollbacks = cmp.behind.every((c) => c.title.startsWith(STUDIO_ROLLBACK));
    blockers.push(`${MAIN} has ${cmp.behind.length} commit(s) ${BETA} lacks (${cmp.behind.slice(0, 5).map((c) => `"${c.title}"`).join(', ')}), so ${MAIN} can't be fast-forwarded. Merge ${MAIN} into ${BETA} first (studio deploy ${p.id} --merge-main${rollbacks ? `; they're rollbacks, so the merge keeps ${BETA}'s files` : ''}), then playtest ${BETA}.`);
  }
  if (web.behind.length) {
    const rollbacks = web.behind.every((c) => c.title.startsWith(STUDIO_ROLLBACK));
    blockers.push(`${p.site}'s ${MAIN} has ${web.behind.length} commit(s) ${BETA} lacks (${web.behind.slice(0, 5).map((c) => `"${c.title}"`).join(', ')}), so the website's ${MAIN} can't be fast-forwarded. Merge ${MAIN} into ${BETA} first (studio deploy ${p.id} --merge-main${rollbacks ? `; they're rollbacks, so the merge keeps ${BETA}'s files` : ''}), then playtest ${BETA}.`);
  }

  // The playtests of the exact beta commit (a Studio release commit on top, only releases.json, doesn't count as moving it).
  const played = beta ? playedCommit(source, beta) : null;
  const { tested, last } = testedAt(p.id, played?.sha, (from) => {
    const d = gitIn(source, ['diff', '--name-only', from, played!.sha]);
    return d.ok && noRuntimeChange(d.out.split('\n').map((x) => x.trim()).filter(Boolean));
  });
  if (played && !tested.length) {
    blockers.push(last ? `${BETA} hasn't been playtested at ${played.short} (the last local playtest played ${last.played.branch} ${String(last.played.sha).slice(0, 7)}${last.played.dirty ? ' with uncommitted changes' : ''}). Playtest ${BETA} first (the daily run, or "studio beta ${p.id}").` : `${BETA} hasn't been playtested yet (the daily run on the server plays it, or "studio beta ${p.id}").`);
  }
  for (const t of tested) {
    if (t.status !== 'done' || !['won', 'done'].includes(t.outcome)) warnings.push(`Playtest ${t.name} on ${beta?.short} ${t.status === 'done' ? `ended "${t.outcome}"` : t.status === 'skipped' ? 'was inconclusive' : 'failed'}${t.detail ? ` (${t.detail})` : ''}.`);
    if (t.verdict === 'broken') warnings.push(`The review of ${t.name} said "broken": ${t.summary ?? ''}`);
    if (t.blockers.length) warnings.push(`The review of ${t.name} found ${t.blockers.length} blocker(s): ${t.blockers.join('; ')}`);
    if (!t.verdict) warnings.push(`${t.name} on ${beta?.short} has no review.`);
  }

  // The pre-deploy build lives on beta (beta.ts prepareBeta), so the playtested commit is exactly what ships.
  if (played && p.deploy?.prebuild && !prebuilt(p, played.sha, played.title)) {
    blockers.push(`${BETA}'s newest commit isn't its pre-deploy build (${p.deploy.prebuild}). Run "studio beta ${p.id}" (it builds, commits to ${BETA} and playtests it).`);
  }

  // Unity: the beta build in its website copy is what goes to the website repo's main.
  let build: any = null;
  if (unity) {
    const b = betaBuild(p);
    const siteMain = shaOf(site, `origin/${MAIN}`);
    const siteBeta = web.beta?.sha ?? null;
    const files = b?.ok ? (await gitAsync(betaSiteDir(p), ['status', '--porcelain'])).out.split('\n').filter(Boolean) : [];
    build = b && { ...b, files: files.length, sample: files.slice(0, 20) };
    if (!b) blockers.push(`${BETA} has no build yet (the daily run on the server builds it, or "studio build ${p.id}").`);
    else if (!b.ok) blockers.push(`The last build of ${BETA} failed: ${b.error ?? '?'}`);
    else {
      if (beta && b.sha !== beta.sha) blockers.push(`The beta build is of ${b.sha.slice(0, 7)}, but ${BETA} is ${beta.short}: build ${BETA} again ("studio beta ${p.id}").`);
      // The copy sits on the website's beta (its page changes); before the website had a beta, on its main.
      // (A copy ahead of the website's beta is a go live whose beta update a restart cut off: merging main into beta fixes it.)
      if (siteBeta && b.base !== siteBeta && !gitIn(site, ['merge-base', '--is-ancestor', siteBeta, b.base]).ok) blockers.push(`The beta website copy sits on ${b.base.slice(0, 7)}, but ${p.site}'s ${BETA} is ${siteBeta.slice(0, 7)} now: run ${BETA} again ("studio beta ${p.id}": it moves the build onto the new pages, or builds again).`);
      else if (!siteBeta && siteMain && b.base !== siteMain) blockers.push(`${p.site}'s ${MAIN} moved since the beta build (${b.base.slice(0, 7)} -> ${siteMain.slice(0, 7)}): build ${BETA} again so it sits on what's live.`);
      if (!files.length && !cmp.ahead.length && !web.ahead.length) blockers.push(`Nothing to go live: the beta build matches what's live and ${BETA} has no new commits.`);
    }
  } else if (beta && !cmp.ahead.length && !cmp.behind.length) {
    blockers.push(`Nothing to go live: ${MAIN} already is ${BETA} (${beta.short}).`);
  }

  // The release going live adds to releases.json (release.ts): its version and notes (waited for, so the plan shows
  // what ships), or the entry already on beta, kept.
  let release: Awaited<ReturnType<typeof draftWithin>> | null = null;
  if (beta && played && !blockers.some((b) => /^Nothing to go live|^git:/.test(b))) {
    try {
      const fallbackCommits = [...cmp.ahead, ...web.ahead].filter((c) => !c.title.startsWith(STUDIO_RELEASE));
      const live = unity ? releasesAt(site, `origin/${MAIN}`, releasesPath(p)) : releasesAt(source, `origin/${MAIN}`, releasesPath(p));
      const data = unity ? readReleases(path.join(betaSiteFolder(p), RELEASES)) ?? live : releasesAt(source, beta.sha, releasesPath(p));
      if (data) release = await draftWithin(p, unity
        ? { data, live, source, target: beta.sha, build: String(build?.version ?? beta.short), fallbackCommits }
        : { data, live, source, target: played.sha, build: played.short, fallbackCommits }, notesWaitMs);
    } catch (e: any) {
      warnings.push(`The release notes couldn't be drafted (${e.message}); going live still works, without a new release entry.`);
    }
  }
  const relNote = release ? ` ${releaseNotesLine(release)}${release.since ? ` (notes cover ${release.commits} commit(s) since the last release entry, ${release.since.slice(0, 7)})` : ''}.` : '';

  const previous = listDeploys(p.id, 5);
  const players = await livePlayers(p.id);
  return {
    product: p.id, name: p.name, live: p.live, betaSite: previewUrl(p.id), repo: p.repo, site: p.site, unity,
    main: brief(cmp.main), beta: brief(beta), played: brief(played), release,
    commits: cmp.ahead.map(brief), mainOnly: cmp.behind.map(brief),
    // Unity: the website's page changes going live with the build (its beta's commits), and its main's commits beta lacks.
    siteCommits: web.ahead.map(brief), siteMainOnly: web.behind.map(brief),
    tested: { sha: beta?.short ?? null, playtests: tested }, lastPlayed: last,
    build,
    previous: previous.map((d) => ({ id: d.id, kind: d.kind, at: d.at, by: d.by, before: d.before?.slice(0, 7) ?? null, after: d.after.slice(0, 7), beta: d.beta?.slice(0, 7) ?? null, detail: d.detail, rolledBack: d.rolled_back })),
    // How the build that's live now does with real players (players.ts), so the next release can be compared.
    players,
    blockers, warnings, canDeploy: !blockers.length, fix: planFix(blockers), notCloned,
    confirm: `DEPLOY ${p.id}`,
    what: unity
      ? `Commits ${BETA}'s build${build?.version ? ` (Game/v${build.version})` : ''} to ${p.site}'s ${MAIN}${web.ahead.length ? ` together with ${web.ahead.length} website commit(s) from its ${BETA} (${web.ahead.slice(0, 3).map((c) => `"${c.title}"`).join(', ')})` : ''} and fast-forwards ${p.repo.split('/')[0]}'s ${MAIN} to ${beta?.short ?? BETA}; GitHub Pages publishes ${p.live}.${relNote}`
      : `Fast-forwards ${p.site}'s ${MAIN} to ${BETA}${played ? ` ${played.short}` : ''} (${cmp.ahead.length} commit(s))${release && !release.existing ? ', with a release entry on top' : ''}; ${publisherOf(p).says} ${p.live}.${relNote}`,
  };
}

/**
 * Who publishes a product's main: GitHub Pages (the default), or the product's own server (products.json deploy.via
 * "ec2": its box pulls it; Studio only moves main and plays the live site).
 */
export function publisherOf(p: Product) {
  if (p.deploy?.via !== 'ec2') return { box: false as const, says: 'GitHub Pages publishes', done: 'GitHub Pages publishes within a few minutes' };
  const box = p.deploy.box ?? 'its own server';
  return { box: true as const, says: `${box} pulls it and restarts (health check, rollback if unhealthy)`, done: `${box} pulls it within a couple of minutes (no tests there; it rolls back if unhealthy)` };
}

/** Going live (pushing main, recording it) is a critical section (drain.ts): a Studio deploy waits for it. */
export const deploy = (...a: Parameters<typeof deployNow>) => critical(`going live: ${a[0]}`, () => deployNow(...a));
async function deployNow(productId: string, { confirm, by = 'J', mergeMain, origin, beta: expect }: { confirm?: string; by?: string; mergeMain?: boolean; message?: string; origin?: string | null; beta?: string }) {
  const p = getProduct(productId);
  if (mergeMain) return { ok: true, product: p.id, ...(await mergeMainIntoBeta(p, by)), note: `Nothing went live. Playtest ${BETA} again before going live.` };
  opLog(`making the plan for ${p.name}`);
  const plan = await deployPlan(p.id);
  if (confirm !== plan.confirm) throw new StudioError(`Going live publishes ${plan.live}: ${plan.what} Show J the plan, then send confirm: "${plan.confirm}" (J's call).`);
  if (plan.blockers.length) throw new StudioError(`Not going live:\n- ${plan.blockers.join('\n- ')}`);
  // An Approve card (approvals.ts) is for one beta commit: a different one now isn't what J approved.
  if (expect && plan.beta?.sha !== expect && plan.played?.sha !== expect) throw new StudioError(`${BETA} is ${plan.beta?.short ?? '?'} now, not ${expect.slice(0, 7)} that J approved; look at the plan again.`);
  const { source, site, unity } = repoDirs(p);
  const beta = plan.beta!;
  const log: string[] = [];
  let before: string | null;
  let after: string;
  let sourceAfter: string | null = null;
  let release: Draft | null = null;
  const fallbackCommits = [...(plan.commits as Commit[]), ...(plan.siteCommits as Commit[])].filter((c) => !c.title.startsWith(STUDIO_RELEASE));
  // Beta must still be the commit that was played (it could have moved while J read the plan).
  await fetchOrigin(source);
  if (shaOf(source, `origin/${BETA}`) !== beta.sha) throw new StudioError(`${BETA} moved since the plan was made; look at the plan again.`);
  if (!unity) {
    before = plan.main?.sha ?? null;
    // The release entry: a commit on beta on top of the playtested commit (already there when a restart cut this short).
    let target = beta.sha;
    if (plan.played && plan.played.sha === beta.sha) {
      try {
        opLog('writing the release notes');
        const r = await commitRelease(p, source, beta, fallbackCommits);
        release = r.release;
        if (r.sha && release) {
          target = r.sha;
          log.push(`${BETA}: ${releaseLine(release)} (${r.sha.slice(0, 7)}, on top of ${beta.short})`);
        }
      } catch (e: any) {
        log.push(`warning: no release entry this time (${String(e.message ?? e).split('\n')[0]}); going live without it`);
      }
    }
    // A plain push of the commit: git refuses anything that isn't a fast-forward (and pushing it again is a no-op).
    opLog(`pushing ${p.site}'s ${MAIN} to ${target.slice(0, 7)}`);
    log.push(must(await gitAsync(source, ['push', 'origin', `${target}:refs/heads/${MAIN}`]), `pushing ${MAIN}`) || `${MAIN} -> ${target.slice(0, 7)}`);
    after = target;
  } else {
    const copy = betaSiteDir(p);
    await fetchOrigin(site);
    before = shaOf(site, `origin/${MAIN}`);
    const b = betaBuild(p)!;
    // The website's beta must still be what the copy sits on (a page change could have merged while J read the plan).
    const siteBeta = shaOf(site, `origin/${BETA}`);
    if (siteBeta && siteBeta !== b.base && !gitIn(site, ['merge-base', '--is-ancestor', siteBeta, shaOf(copy, 'HEAD') ?? b.base]).ok) throw new StudioError(`${p.site}'s ${BETA} moved since the plan was made; look at the plan again.`);
    // The release entry goes into the website copy, inside the build commit (never stops going live).
    try {
      release = await addReleaseTo(p, betaSiteFolder(p), { source, target: beta.sha, build: String(b.version ?? beta.short), fallbackCommits, live: releasesAt(site, `origin/${MAIN}`, releasesPath(p)) });
      if (release && release.source !== 'existing') log.push(`${p.site}: ${releaseLine(release)}`);
    } catch (e: any) {
      log.push(`warning: no release entry this time (${String(e.message ?? e).split('\n')[0]}); going live without it`);
    }
    must(await gitAsync(copy, ['add', '-A']), 'git add');
    if (!(await gitAsync(copy, ['diff', '--cached', '--quiet'])).ok) {
      opLog(`committing the build${b.version ? ` (Game/v${b.version})` : ''}`);
      must(await gitAsync(copy, [...AUTHOR, 'commit', '--quiet', '-m', `Go live: ${p.name}${b.version ? ` Game/v${b.version}` : ''}${release ? ` ${release.version}` : ''} (${BETA} ${beta.short}, by ${by})`]), 'committing the build');
    }
    const head = shaOf(copy, 'HEAD')!;
    // A build commit not on main yet: just made, or made before a restart cut this short. Pushing it is the go live.
    if (before && head !== before && gitIn(copy, ['merge-base', '--is-ancestor', before, head]).ok) {
      opLog(`pushing ${p.site}'s ${MAIN} (the build: this can take a few minutes)`);
      must(await gitAsync(copy, ['push', 'origin', `HEAD:refs/heads/${MAIN}`], 30 * 60_000), `pushing ${p.site}'s ${MAIN}`);
      after = head;
      log.push(`${p.site}: ${MAIN} -> ${after.slice(0, 7)} (the beta build${b.version ? `, Game/v${b.version}` : ''}${plan.siteCommits.length ? ` and ${plan.siteCommits.length} website commit(s) from ${BETA}` : ''})`);
      saveBetaBuild(p, { ...b, base: after });
      // The website's beta follows (a fast-forward: it then has the build too, so its main has nothing beta lacks). When
      // a page change merged meanwhile it can't: merging main into beta (the plan's fix) brings it in.
      const fb = await gitAsync(copy, ['push', '--quiet', 'origin', `HEAD:refs/heads/${BETA}`]);
      log.push(fb.ok ? `${p.site}: ${BETA} -> ${after.slice(0, 7)}` : `warning: ${p.site}'s ${BETA} wasn't fast-forwarded to the go live (${fb.err.split('\n').pop()}): merge ${MAIN} into ${BETA} before the next go live`);
    } else {
      after = before!;
      log.push(`${p.site}: the build is already live`);
    }
    // The source's main follows (it doesn't publish anything); a failure here is reported, not fatal.
    if (plan.commits.length) {
      const r = await gitAsync(source, ['push', 'origin', `${beta.sha}:refs/heads/${MAIN}`]);
      if (r.ok) sourceAfter = beta.sha;
      log.push(r.ok ? `${p.repo.split('/')[0]}: ${MAIN} -> ${beta.short}` : `warning: ${p.repo.split('/')[0]}'s ${MAIN} wasn't fast-forwarded: ${r.err.split('\n').pop()}`);
    }
  }
  for (const l of log) opLog(l);
  const id = newId('d');
  db.prepare('INSERT INTO deploys (id, product, kind, repo, before, after, beta, source, source_before, source_after, version, by, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, p.id, 'deploy', p.site, before, after, plan.played?.sha ?? beta.sha, unity ? p.repo : null, unity ? plan.main?.sha ?? null : null, sourceAfter, plan.build?.version ?? null, by, `${plan.commits.length} commit(s): ${plan.commits.slice(0, 8).map((c) => c!.title).join('; ')}${plan.siteCommits.length ? ` · website ${plan.siteCommits.length} commit(s): ${plan.siteCommits.slice(0, 8).map((c) => c!.title).join('; ')}` : ''}`.slice(0, 1000), Date.now());
  await fetchOrigin(site);
  if (after !== before) void verifyLive(p.id, after, `Just went live (${BETA} ${beta.short}: ${plan.commits.slice(0, 3).map((c) => c!.title).join('; ')})`, origin);
  const rel = release && { version: release.version, title: release.title, notes: release.notes, build: release.build };
  return { ok: true, product: p.id, deploy: id, live: p.live, main: after.slice(0, 7), beta: beta.short, release: rel, log, note: `${publisherOf(p).done}; Studio waits for it, then playtests the live site (a run appears in the dashboard). If it went wrong: the rollback plan.` };
}

/** The go-live plan's players line: the live build's numbers from Hawkes Gen (builds, last 30 days), or null within 5 s. */
async function livePlayers(product: string): Promise<string | null> {
  try {
    const { liveBuildLine } = await import('./players.ts');
    const { gen } = await import('./gen.ts');
    const b = await Promise.race([gen.request(`/analytics/${encodeURIComponent(product)}/builds?range=30d`), new Promise<null>((ok) => setTimeout(() => ok(null), 5000).unref())]);
    return liveBuildLine(b);
  } catch {
    return null;
  }
}

/**
 * Web: the release entry as a commit on beta on top of the playtested commit, pushed (a fast-forward of beta: refused if
 * beta moved). sha: the new commit, or null when the entry was already there.
 */
async function commitRelease(p: ReturnType<typeof getProduct>, source: string, beta: Commit | { sha: string; short: string }, fallbackCommits: Commit[]) {
  const wt = await scratch(source, `${p.id}-release`, beta.sha);
  const release = await addReleaseTo(p, path.join(wt, path.dirname(releasesPath(p))), { source, target: beta.sha, build: beta.short, fallbackCommits, live: releasesAt(source, `origin/${MAIN}`, releasesPath(p)) });
  if (!release || release.source === 'existing') return { release, sha: null };
  must(await gitAsync(wt, ['add', releasesPath(p)]), 'git add');
  must(await gitAsync(wt, [...AUTHOR, 'commit', '--quiet', '-m', `${STUDIO_RELEASE} ${p.name} ${release.version}: ${release.title}`]), 'committing the release entry');
  must(await gitAsync(wt, ['push', '--quiet', 'origin', `HEAD:refs/heads/${BETA}`]), `pushing ${BETA}`);
  await fetchOrigin(source);
  // The beta working copy (devtools saves) catches up, as after any merge into beta.
  void import('./dev.ts').then(({ pullDev }) => pullDev(p.id, 'after the release entry')).catch(() => {});
  return { release, sha: shaOf(wt, 'HEAD')! };
}

// ----------------------------------------------------------------- rollback

const lastLive = (product: string) => db.prepare(`SELECT * FROM deploys WHERE product = ? AND kind = 'deploy' AND rolled_back IS NULL ORDER BY at DESC LIMIT 1`).get(product) as DeployRow | undefined;

export async function rollbackPlan(productId: string) {
  const p = getProduct(productId);
  const { site } = repoDirs(p);
  const blockers: string[] = [];
  const warnings: string[] = [];
  await fetchOrigin(site);
  const main = shaOf(site, `origin/${MAIN}`);
  const d = lastLive(p.id);
  if (!d) blockers.push(`No go live by Studio is recorded for ${p.name} (or each one was rolled back already), so the previous live commit isn't known. Roll back by hand (git revert on ${p.site}).`);
  else if (!d.before) blockers.push(`The last go live (${d.id}) has no previous commit recorded.`);
  const undo = d?.before && main ? commitsIn(site, `${d.before}..${main}`) : [];
  if (p.deploy?.via === 'ec2') warnings.push(`${p.name} runs on its own server with a database: a rollback puts the previous code back through the same CI and pull, but nothing in the database (accounts, credits, payments, migrations) is undone.`);
  if (d && main && main !== d.after) warnings.push(`${MAIN} moved since that go live (${d.after.slice(0, 7)} -> ${main.slice(0, 7)}): rolling back also undoes those commits.`);
  if (d?.before && main === d.before) blockers.push(`${MAIN} already is ${d.before.slice(0, 7)}.`);
  return {
    product: p.id, name: p.name, live: p.live, repo: p.site,
    main: brief(main ? commitOf(site, main) : null), to: brief(d?.before ? commitOf(site, d.before) : null),
    deploy: d ? { id: d.id, at: d.at, by: d.by, after: d.after.slice(0, 7), beta: d.beta?.slice(0, 7) ?? null, detail: d.detail } : null,
    undo: undo.map(brief), blockers, warnings, canRollback: !blockers.length,
    confirm: `ROLLBACK ${p.id}`,
    what: `A new commit on ${p.site}'s ${MAIN} with the files of ${d?.before?.slice(0, 7) ?? '?'} (what was live before the last go live: its build and its pages); never a force push. ${BETA} keeps its commits: fix forward there, merge ${MAIN} into ${BETA} (it keeps ${BETA}'s files), playtest, and go live again.`,
  };
}

/** A rollback (pushing main, recording it) is a critical section too. */
export const rollback = (...a: Parameters<typeof rollbackNow>) => critical(`rolling back: ${a[0]}`, () => rollbackNow(...a));
async function rollbackNow(productId: string, { confirm, by = 'J', origin }: { confirm?: string; by?: string; origin?: string | null }) {
  const plan = await rollbackPlan(productId);
  if (confirm !== plan.confirm) throw new StudioError(`Rolling back publishes ${plan.live}: ${plan.what} Show J the rollback plan, then send confirm: "${plan.confirm}" (J's call).`);
  if (plan.blockers.length) throw new StudioError(`Not rolling back:\n- ${plan.blockers.join('\n- ')}`);
  const p = getProduct(productId);
  const { site } = repoDirs(p);
  const d = lastLive(p.id)!;
  const wt = await scratch(site, `${p.id}-rollback`, plan.main!.sha);
  must(await gitAsync(wt, ['read-tree', '-u', '--reset', d.before!]), 'restoring the files');
  if ((await gitAsync(wt, ['diff', '--cached', '--quiet'])).ok) throw new StudioError(`${MAIN} already has the files of ${d.before!.slice(0, 7)}; nothing to roll back.`);
  must(gitIn(wt, [...AUTHOR, 'commit', '--quiet', '-m', `${STUDIO_ROLLBACK} ${p.name} to ${d.before!.slice(0, 7)} (undoes go live ${d.id}, ${d.after.slice(0, 7)}; by ${by})`]), 'committing the rollback');
  must(await gitAsync(wt, ['push', 'origin', `HEAD:refs/heads/${MAIN}`]), `pushing ${MAIN}`);
  const after = shaOf(wt, 'HEAD')!;
  const id = newId('d');
  db.prepare('INSERT INTO deploys (id, product, kind, repo, before, after, by, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, p.id, 'rollback', p.site, plan.main!.sha, after, by, `to ${d.before!.slice(0, 7)}, undoing ${d.id}`, Date.now());
  db.prepare('UPDATE deploys SET rolled_back = ? WHERE id = ?').run(id, d.id);
  gitIn(site, ['worktree', 'remove', '--force', wt]);
  await fetchOrigin(site);
  void verifyLive(p.id, after, `Just rolled back to ${d.before!.slice(0, 7)} (undoing ${d.after.slice(0, 7)}). Check the live site works.`, origin);
  return { ok: true, product: p.id, rollback: id, live: p.live, main: after.slice(0, 7), to: d.before!.slice(0, 7), note: `${publisherOf(p).done}; Studio then playtests live. ${BETA} still has the rolled-back commits: fix forward there.` };
}

// ------------------------------------------------------------------- live

/** owner/repo from the site repo's origin URL. */
export function repoSlug(site: string) {
  const url = git(site, ['remote', 'get-url', 'origin']).out;
  const m = url.match(/github\.com[/:]([^/]+\/[^/.]+?)(\.git)?$/);
  return m ? m[1] : null;
}

const gh = (args: string[]) => {
  const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? r.error?.message ?? '').trim() };
};

// Waiting never keeps a process alive by itself (the CLI and tests exit; the service runs anyway).
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());

/** Waits for GitHub to publish a commit (its Pages or Actions runs, through gh when signed in), then playtests live. */
export async function verifyLive(productId: string, sha: string, focus: string, origin?: string | null) {
  const p = getProduct(productId);
  const slug = repoSlug(p.site);
  const end = Date.now() + 15 * 60_000;
  let published = false;
  const own = publisherOf(p).box;
  // GitHub's API with the server's token (the gh CLI isn't on the server): Pages has built this commit, or (sites that
  // publish through a workflow, like Dose Of Destruction's pages.yml) every workflow run for it finished.
  const token = process.env.GITHUB_TOKEN;
  if (slug && token) {
    const api = async (route: string) => {
      const r = await fetch(`https://api.github.com/repos/${slug}/${route}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
      return r?.ok ? r.json() : null;
    };
    while (Date.now() < end && !published) {
      await sleep(20_000);
      if (own) {
        // The product's own server: its CI (every workflow but Studio's hook) is done; its box pulls a passing commit
        // on its own timer (2 minutes), so give it that and a little more before the live playtest.
        const runs: any = await api(`actions/runs?head_sha=${sha}&event=push`);
        const ci = (runs?.workflow_runs ?? []).filter((r: any) => !/hawkes-studio/i.test(`${r.name} ${r.path}`));
        if (ci.length && ci.every((r: any) => r.status === 'completed')) { published = true; await sleep(3 * 60_000); }
        continue;
      }
      const build: any = await api('pages/builds/latest');
      if (build?.commit === sha && build.status === 'built') published = true;
      const runs: any = await api(`actions/runs?head_sha=${sha}&event=push`);
      const pagesRuns = (runs?.workflow_runs ?? []).filter((r: any) => /pages/i.test(`${r.name} ${r.path}`));
      if (pagesRuns.length && pagesRuns.every((r: any) => r.status === 'completed')) published = true;
    }
  } else if (slug && gh(['auth', 'status']).ok) {
    while (Date.now() < end && !published) {
      await sleep(20_000);
      const runs = gh(['api', `repos/${slug}/actions/runs?head_sha=${sha}`, '--jq', '[.workflow_runs[] | {status, conclusion}]']);
      try {
        const list = JSON.parse(runs.out || '[]') as { status: string; conclusion: string | null }[];
        if (list.length && list.every((r) => r.status === 'completed')) published = true;
      } catch {
        // Not readable yet.
      }
    }
  } else {
    await sleep((own ? 7 : 4) * 60_000);
  }
  const t = p.playtests.find((x) => x.where === 'live');
  startPartial('playtest', p.id, { where: 'live', scenario: t?.scenario, mode: t?.mode, focus: `${focus} Check the live site works and nothing regressed.`, origin });
}


// ------------------------------------------------------------------- the queue

/**
 * Going live and rolling back run as queued operations (ops.ts): an Approve tap or an API call is accepted at once, one
 * product goes at a time, two products at most in all, and Studio answers throughout (all git here is async). A restart
 * puts a running one back in the queue: going live again is a no-op once main is the approved beta commit.
 */
type LiveJob = { product: string; confirm: string; by?: string; origin?: string | null; beta?: string; approval?: string; mergeMain?: boolean };

/** The approval card an operation came from hears how it ended, and so does the conversation that asked. */
async function settleApproval(op: Op, ok: boolean, text: string) {
  const a = op.payload?.approval as string | undefined;
  if (a) db.prepare(`UPDATE approvals SET status = ?, result = ? WHERE id = ?`).run(ok ? 'approved' : 'failed', text.slice(0, 2000), a);
  const conv = op.origin ?? (a ? (db.prepare('SELECT conversation FROM approvals WHERE id = ?').get(a) as any)?.conversation : null);
  if (conv) await import('./talk.ts').then((t) => t.studioSays(conv, `${op.title}: ${text}`)).catch(() => {});
  // Going live failing is "something went wrong": J's phone hears it.
  if (!ok) await import('./notify.ts').then((n) => n.notify(`${op.title} failed`, text.slice(0, 300), { tags: ['warning'], priority: 4 })).catch(() => {});
}

registerOp('golive', async (j: LiveJob, ctx) => {
  ctx.step(j.mergeMain ? `merging main into ${j.product}'s beta` : `going live with ${j.product}`);
  try {
    return await deploy(j.product, { confirm: j.confirm, by: j.by, origin: j.origin, beta: j.beta, mergeMain: j.mergeMain });
  } catch (e: any) {
    // A second attempt after a restart that finds it already done: that's the first attempt's success.
    if (ctx.op.attempts > 1 && /Nothing to go live/.test(String(e.message))) {
      const d = db.prepare(`SELECT * FROM deploys WHERE product = ? AND kind = 'deploy' AND at >= ? ORDER BY at DESC LIMIT 1`).get(j.product, ctx.op.created) as DeployRow | undefined;
      if (d && (!j.beta || d.beta === j.beta)) return { ok: true, product: j.product, deploy: d.id, main: d.after.slice(0, 7), beta: d.beta?.slice(0, 7) ?? null, note: 'went live before Studio restarted' };
    }
    throw e;
  }
}, {
  done: (op) => settleApproval(op, true, op.result?.main ? `Live: main is ${op.result.main} (beta ${op.result.beta}).${op.result.release ? ` ${releaseLine(op.result.release)}.` : ''} ${op.result.note ?? ''}`.trim() : String(op.result?.detail ?? 'done')),
  failed: (op) => settleApproval(op, false, op.error ?? 'failed'),
});

registerOp('rollback', async (j: LiveJob, ctx) => {
  ctx.step(`rolling back ${j.product}`);
  return rollback(j.product, { confirm: j.confirm, by: j.by, origin: j.origin });
}, {
  done: (op) => settleApproval(op, true, `Rolled back: main is ${op.result?.main}. ${op.result?.note ?? ''}`.trim()),
  failed: (op) => settleApproval(op, false, op.error ?? 'failed'),
});

/** Queues going live (or a rollback) and returns at once: the operation, and where it is in the queue. */
export function queueLive(kind: 'golive' | 'rollback', j: LiveJob) {
  const p = getProduct(j.product);
  const title = kind === 'rollback' ? `Rolling back ${p.name}` : j.mergeMain ? `Merging main into ${p.name}'s beta` : `Going live with ${p.name}`;
  const op = enqueue(kind, { product: p.id, title, payload: j, by: j.by ?? null, origin: j.origin ?? null });
  return { op, ahead: queuePosition(op.id) };
}

/** Queues it and waits for it (the API and the CLI want the answer); Studio keeps answering meanwhile. */
export async function runLive(kind: 'golive' | 'rollback', j: LiveJob, maxMs = 45 * 60_000) {
  const { op } = queueLive(kind, j);
  const end = Date.now() + maxMs;
  for (;;) {
    const now = getOp(op.id)!;
    if (now.status === 'done') return now.result;
    if (now.status === 'failed') throw new StudioError(now.error ?? 'failed', 409);
    if (Date.now() > end) throw new StudioError(`${now.title} is still ${now.status} (${now.step ?? ''}); it carries on: see Activity.`, 202);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
