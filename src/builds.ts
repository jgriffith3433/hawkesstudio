// Builds (docs/builds.md; J, 2026-10-31: "customer first and flexible and powerful"): a project's `builds` say how it is
// built, separately from its engine. Each build is a run (Activity, Runs, and back to the Talk conversation that asked),
// its output is published once under its version and stays playable, beta is a pointer to one of them, and a build can
// also be mounted into another project's site (a Unity game in its website's Game/) or committed into that repo.
//
// Runners: unity → Hawkes Gen (unity.build customer mode, the repo's own token per job, the output as a library asset);
// npm/static → Studio's Cloud Run job, or the files as they are; actions → the project's own GitHub Actions (its last
// step tells Studio, server.ts hooks; Studio downloads that run's artifact).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type http from 'node:http';
import { db, newId } from './db.ts';
import { getProduct, loadProducts, StudioError, managedElsewhere, type BuildSpec, type Product } from './config.ts';
import { folderFilesAsync } from './sitestore.ts';

db.exec(`CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY, product TEXT NOT NULL, build TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
  sha TEXT, ref TEXT, runner TEXT NOT NULL, target TEXT NOT NULL, files INTEGER, bytes INTEGER, url TEXT, run TEXT,
  change TEXT, detail TEXT, started INTEGER NOT NULL, finished INTEGER
)`);
try { db.exec('ALTER TABLE builds ADD COLUMN gen_job TEXT'); } catch { /* there already */ }
// When the Gen job finished: until then a restart only waits on Gen and isn't counted (pipeline.ts waitingInGen).
try { db.exec('ALTER TABLE builds ADD COLUMN gen_done INTEGER'); } catch { /* there already */ }
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS builds_version ON builds (product, build, version)'); } catch { /* there */ }
// publish.commit: the repo and the commit on its beta that holds this build (going live fast-forwards that repo's main to it).
for (const col of ['commit_repo', 'commit_sha']) { try { db.exec(`ALTER TABLE builds ADD COLUMN ${col} TEXT`); } catch { /* there */ } }

export type BuildRow = { id: string; product: string; build: string; version: number; status: 'building' | 'ready' | 'failed' | 'pruned'; sha: string | null; ref: string | null; runner: string; target: string; files: number | null; bytes: number | null; url: string | null; run: string | null; change: string | null; detail: string | null; started: number; finished: number | null; commit_repo?: string | null; commit_sha?: string | null };
export type BuildTrigger = 'beta' | 'tag';
export type StartOptions = {
  /** After a restart: the build row it carries on (its version) and the Gen job it waits for. */
  resume?: { row: string; version: number; job: string | null };
  /** One build by id (else every build the trigger starts, or all of them when asked). */
  build?: string;
  ref?: string; sha?: string;
  /** What started it: a push to beta, a build-* tag; none = asked (Talk, the dashboard, the API). */
  trigger?: BuildTrigger;
  origin?: string | null;
  /** An agent change's preview: published at c/<change>/, no version, beta untouched. */
  change?: string;
  /** An Actions build that finished: its workflow run and artifact (server.ts hooks). */
  artifact?: { runId: string; name?: string };
};

/** A project's builds: its own, else a web project's implicit one (its beta branch built, or published as it is). */
export function buildsOf(p: Product): BuildSpec[] {
  if (p.builds?.length) return p.builds;
  // A web app with its own server and beta (p.beta, kind app) is built and served where it's hosted: no build here,
  // which used to fail on every push (2026-10-31 review).
  return (p.engine as string) === 'web' && (p as any).github && !p.beta && (p as any).kind !== 'app' ? [{ id: 'web', tool: 'npm', target: 'web' }] : [];
}
/** When a build runs by itself: actions builds start themselves (their own workflow's triggers), the rest on beta pushes. */
export const triggersOf = (b: BuildSpec): BuildTrigger[] => b.on ?? (b.tool === 'actions' ? [] : ['beta']);
const runnerOf = (b: BuildSpec) => (b.tool === 'unity' ? 'gen' : b.tool === 'actions' ? 'actions' : 'studio');

const rowOf = (r: any): BuildRow => r;
export function buildHistory(product: string, limit = 50): BuildRow[] {
  return (db.prepare('SELECT * FROM builds WHERE product = ? ORDER BY started DESC LIMIT ?').all(product, limit) as any[]).map(rowOf);
}
const nextVersion = (product: string, build: string) => ((db.prepare('SELECT MAX(version) AS v FROM builds WHERE product = ? AND build = ?').get(product, build) as any)?.v ?? 0) + 1;

/** The projects whose repo this is (a customer's Studio, or games added to J's), for hooks. */
export function projectsForRepo(slug: string): Product[] {
  const s = slug.toLowerCase();
  return loadProducts().filter((p) => String((p as any).github ?? '').toLowerCase() === s);
}

// ------------------------------------------------------------------ hosting

/** Where a project's site is: its R2 prefix (previews.ts subOf) and its address. */
async function siteOf(p: Product) {
  const P = await import('./previews.ts');
  const sub = P.subOf(p.id);
  // A web app with a beta server of its own (Hawkes Net, Gen) is played there, so it has no beta site here; what its own
  // builds make (an SDK, a package, a demo) is still published, at its place in the org's sites (2026-11-01: Hawkes Net's
  // release build failed after building, with nowhere to go).
  if (!sub && p.builds?.length) {
    const { siteOrg, orgPrefix } = await import('./sitekeys.ts');
    const org = siteOrg();
    if (org) return { sub: `o/${org}/${p.id}`, root: `https://sites.${P.DOMAIN}${orgPrefix(org)}/${p.id}/` };
  }
  if (!sub) throw new StudioError(`${p.name} has no hosted site here (a project with a beta address of its own is played there)`, 409);
  const root = P.previewUrl(p.id)!;
  return { sub, root };
}
async function siteStore() {
  const { workerStore, sitesUrl } = await import('./sitestore.ts');
  const { DOMAIN } = await import('./previews.ts');
  return workerStore(sitesUrl(DOMAIN));
}

/** Makes one of a project's builds its beta (or rolls beta back to it): the pointer the sites Worker reads. */
export async function setBeta(projectId: string, build: string, version: number) {
  const p = getProduct(projectId);
  const row = db.prepare("SELECT * FROM builds WHERE product = ? AND build = ? AND version = ? AND status = 'ready' AND change IS NULL").get(p.id, build, version) as BuildRow | undefined;
  if (!row) throw new StudioError(`${p.name} has no finished build ${build} ${version}`, 404);
  const { sub } = await siteOf(p);
  const store = await siteStore();
  await store.put(`${sub}/beta.json`, Buffer.from(JSON.stringify({ build, version, sha: row.sha, at: Date.now() })), 'application/json');
  return { project: p.id, build, version, url: row.url };
}

/** How many versions of each build stay published (J, 2026-10-31: "Just keep only the latest version of the build"); beta's and mounted ones always stay. */
export const BUILDS_KEEP = Math.max(1, Number(process.env.STUDIO_BUILDS_KEEP) || 1);

/**
 * Removes a build's older versions from the sites (R2 storage grows with every Unity build otherwise): the newest
 * BUILDS_KEEP stay, and so do the one beta points at and any mounted into a site. Their rows stay, marked pruned.
 */
async function prune(p: Product, build: string, sub: string) {
  const rows = db.prepare("SELECT * FROM builds WHERE product = ? AND build = ? AND status = 'ready' AND change IS NULL ORDER BY version DESC").all(p.id, build) as BuildRow[];
  if (rows.length <= BUILDS_KEEP) return;
  const store = await siteStore();
  const beta = await store.get(`${sub}/beta.json`).then((x) => (x ? JSON.parse(x.toString('utf8')) : null)).catch(() => null);
  const mounted = new Set<string>();
  for (const q of loadProducts()) {
    const qs = (await import('./previews.ts')).subOf(q.id);
    if (!qs) continue;
    const m = await store.get(`${qs}/mounts.json`).then((x) => (x ? JSON.parse(x.toString('utf8')) : {})).catch(() => ({}));
    for (const v of Object.values(m)) mounted.add(String(v));
  }
  const { removeSite } = await import('./sitestore.ts');
  // Versions a website serves from the public builds address (commitInto) stay: the newest 3 of them, so what's live and
  // what a rollback goes back to keep working.
  let publicKept = 0;
  for (const r of rows.slice(BUILDS_KEEP)) {
    const base = `${sub}/b/${build}/${r.version}`;
    if ((beta?.build === build && beta?.version === r.version) || mounted.has(base)) continue;
    if ((r as any).commit_sha && publicKept < 3 && (await store.get(`${base}/.public`).catch(() => null))) { publicKept++; continue; }
    await removeSite(store, base);
    db.prepare("UPDATE builds SET status = 'pruned', url = NULL WHERE id = ?").run(r.id);
  }
}

/** A build mounted into another project's site at a path (the Worker serves it there): YoobaLand's in YoobaLandGame/Game/. */
async function mount(target: Product, at: string, base: string) {
  const { sub } = await siteOf(target);
  const store = await siteStore();
  const cur = await store.get(`${sub}/mounts.json`).then((b) => (b ? JSON.parse(b.toString('utf8')) : {})).catch(() => ({}));
  cur[at] = base;
  await store.put(`${sub}/mounts.json`, Buffer.from(JSON.stringify(cur)), 'application/json');
}

/** Takes a mount away, so the target's beta site serves its own files at that path again (publish.page "site"). */
async function unmount(target: Product, at: string) {
  const { sub } = await siteOf(target);
  const store = await siteStore();
  const cur = await store.get(`${sub}/mounts.json`).then((b) => (b ? JSON.parse(b.toString('utf8')) : null)).catch(() => null);
  if (!cur || !(at in cur)) return;
  delete cur[at];
  await store.put(`${sub}/mounts.json`, Buffer.from(JSON.stringify(cur)), 'application/json');
}

/**
 * publish.page "site": the site's own page names the build's address in window.HAWKES_BUILD_URL (the folder the build's
 * files are under, ending in /). Replaces the one already there, else goes first in <head> (before the page's loader).
 */
export function pointPage(html: string, url: string): string {
  const line = `window.HAWKES_BUILD_URL = ${JSON.stringify(url)};`;
  const there = /window\.HAWKES_BUILD_URL\s*=\s*("[^"\n]*"|'[^'\n]*')\s*;?/;
  if (there.test(html)) return html.replace(there, line);
  const head = /<head(\s[^>]*)?>/i.exec(html);
  const tag = `<script>${line}</script>`;
  return head ? html.slice(0, head.index + head[0].length) + `\n  ${tag}` + html.slice(head.index + head[0].length) : `${tag}\n${html}`;
}

// ------------------------------------------------------------------ runs

/**
 * Starts a build run of a project: its builds the trigger starts (or the one asked for, or all of them), one after the
 * other. Returns the run (null when nothing builds for that trigger).
 */
export async function startBuild(projectId: string, o: StartOptions = {}): Promise<{ id: string; builds: string[]; done: Promise<void> } | null> {
  const p = getProduct(projectId);
  const all = buildsOf(p);
  if (!all.length) throw new StudioError(`${p.name} has no builds (docs/builds.md: set "builds" on the project)`, 409);
  const specs = o.build ? all.filter((b) => b.id === o.build) : o.trigger ? all.filter((b) => triggersOf(b).includes(o.trigger!)) : all;
  if (o.build && !specs.length) throw new StudioError(`${p.name} has no build "${o.build}" (it has ${all.map((b) => b.id).join(', ')})`, 404);
  if (!specs.length) return null;
  if (specs.some((b) => b.tool === 'unity')) await requireCloudBuilds();
  const { tagRun } = await import('./followup.ts');
  const id = newId('r');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'build', 'running', `build ${p.id}`, JSON.stringify([p.id]), JSON.stringify({ builds: specs.map((b) => b.id), ref: o.ref, trigger: o.trigger, change: o.change }), Date.now());
  tagRun(id, o.origin);
  const done = (async () => {
    const { closeRun } = await import('./pipeline.ts');
    try {
      for (const b of specs) await buildOne(id, p, b, o);
    } finally {
      closeRun(id, `build ${p.id}`);
    }
  })().catch((e) => console.warn(`[builds] ${p.id}: ${e?.message ?? e}`));
  return { id, builds: specs.map((b) => b.id), done };
}

/**
 * A build run that was going when Studio restarted (every deploy rolls the cells): each of its builds carries on where it
 * was. One still building waits for its Gen job (no second Unity build, no second charge); one not started yet starts;
 * finished ones stay done. Before this, the run was resumed as J's Unity build and lost (2026-10-31 review).
 */
export async function resumeRun(run: string, productId: string, options: { builds?: string[]; ref?: string; trigger?: BuildTrigger; change?: string }) {
  const p = getProduct(productId);
  const { closeRun } = await import('./pipeline.ts');
  try {
    for (const id of options.builds ?? []) {
      const b = buildsOf(p).find((x) => x.id === id);
      if (!b) continue;
      const row = db.prepare('SELECT id, version, status, sha, gen_job FROM builds WHERE run = ? AND build = ? ORDER BY started DESC LIMIT 1').get(run, id) as any;
      if (row && row.status !== 'building') continue;
      await buildOne(run, p, b, { ref: options.ref, trigger: options.trigger, change: options.change, ...(row ? { sha: row.sha, resume: { row: row.id, version: row.version, job: row.gen_job ?? null } } : {}) });
    }
  } finally {
    closeRun(run, `build ${p.id}`);
  }
}

async function requireCloudBuilds() {
  const { customerStudio } = await import('./tenancy.ts');
  if (customerStudio()) await (await import('./entitlements.ts')).requireFeature('cloudBuilds');
}

type Output = { files: import('./sitestore.ts').SiteFile[]; bytes: number; cleanup: () => void; detail?: string };

async function buildOne(run: string, p: Product, b: BuildSpec, o: StartOptions) {
  const { startStep, updateStep } = await import('./pipeline.ts');
  const step = startStep(run, p.id, 'build', b.id, `${b.tool}${b.target && b.target !== 'web' ? ` (${b.target})` : ''}`);
  const say = (detail: string) => updateStep(step, { detail: detail.slice(0, 300) });
  const slug = String((p as any).github ?? '');
  let rowId: string | null = null;
  let out: Output | null = null;
  try {
    if (!slug) throw new Error(`${p.name} has no GitHub repo to build from`);
    const { repoToken, githubFetch } = await import('./ghtoken.ts');
    const token = await repoToken(slug);
    const gh = githubFetch(token);
    const { githubCommit } = await import('./sitestore.ts');
    const ref = o.ref ?? 'beta';
    const sha = o.sha ?? (await githubCommit(slug, ref, gh)) ?? (await githubCommit(slug, 'main', gh));
    if (!sha) throw new Error(`${slug} has no ${ref} or main branch on GitHub`);
    // A push or the nightly sync asking again for a commit already built: nothing to build (a Unity build costs money).
    if (o.trigger && !o.artifact && !o.change) {
      const had = db.prepare("SELECT version, url FROM builds WHERE product = ? AND build = ? AND sha = ? AND status = 'ready' AND change IS NULL ORDER BY version DESC LIMIT 1").get(p.id, b.id, sha) as any;
      if (had) { updateStep(step, { status: 'done', detail: `${sha.slice(0, 7)} is built already (${b.id} ${had.version})`, data: { url: had.url, version: had.version, sha }, finished: true }); return; }
    }
    // The same commit already building (a push, the nightly sync and a rebuild at once): not built twice (2026-10-31 review).
    if (!o.resume && !o.artifact && !o.change) {
      // Only a build whose run is still going counts: a run stopped after restarts (pipeline.ts resumeRuns) left its row
      // "building", which blocked every new build of that commit for 4 hours (2026-11-01, Hawkes Net for Unity's demo).
      const busy = db.prepare("SELECT b.version, b.run FROM builds b JOIN runs r ON r.id = b.run WHERE b.product = ? AND b.build = ? AND b.sha = ? AND b.status = 'building' AND b.change IS NULL AND b.started > ? AND r.status = 'running' LIMIT 1").get(p.id, b.id, sha, Date.now() - 4 * 3600_000) as any;
      if (busy) { updateStep(step, { status: 'done', detail: `${sha.slice(0, 7)} is already building (${b.id} ${busy.version}, run ${busy.run})`, finished: true }); return; }
    }
    // An Actions build Studio was only asked for: start the workflow; it reports when it's built (a run of its own).
    if (b.tool === 'actions' && !o.artifact) {
      if (!b.workflow) throw new Error(`build ${b.id} runs in ${slug}'s own GitHub Actions: it starts from its workflow's own triggers (set "workflow" so Studio can start it)`);
      say(`starting ${b.workflow} on ${ref}`);
      const r = await gh(`https://api.github.com/repos/${slug}/actions/workflows/${encodeURIComponent(b.workflow)}/dispatches`, { method: 'POST', headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'hawkes-studio' }, body: JSON.stringify({ ref }) });
      if (!r.ok) throw new Error(`GitHub wouldn't start ${b.workflow}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      updateStep(step, { status: 'done', detail: `started ${b.workflow} on ${ref}: its build reports back when it's done (a run of its own)`, finished: true });
      return;
    }
    // Resumed after a restart: the same row and version, and a Unity build waits for the Gen job it started.
    const version = o.resume ? o.resume.version : o.change ? 0 : nextVersion(p.id, b.id);
    rowId = o.resume?.row ?? newId('b');
    if (!o.resume) db.prepare('INSERT INTO builds (id, product, build, version, status, sha, ref, runner, target, run, change, started) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(rowId, p.id, b.id, version || -Date.now(), 'building', sha, ref, runnerOf(b), b.target ?? 'web', run, o.change ?? null, Date.now());
    say(`${sha.slice(0, 7)} (${ref})${o.resume ? ', carrying on after a restart' : ''}`);
    const row = rowId;
    out = b.tool === 'unity' ? await viaGen(p, b, slug, sha, ref, token, say, { job: o.resume?.job ?? undefined, onSubmit: (id) => db.prepare('UPDATE builds SET gen_job = ?, gen_done = NULL WHERE id = ?').run(id, row), onDone: () => db.prepare('UPDATE builds SET gen_done = ? WHERE id = ?').run(Date.now(), row) })
      : b.tool === 'actions' ? await viaActions(b, slug, o.artifact!, gh, say)
      : await viaStudio(p, b, slug, sha, token, gh, say);
    // Publish: once, under its version (or the change's preview), behind the Studio's sign-in.
    const { sub, root } = await siteOf(p);
    const base = o.change ? `${sub}/c/${o.change}` : `${sub}/b/${b.id}/${version}`;
    const url = o.change ? `${root}c/${o.change}/` : `${root}b/${b.id}/${version}/`;
    say(`publishing ${out.files.length} files`);
    const store = await siteStore();
    const { publishSite } = await import('./sitestore.ts');
    const page = (b.target ?? 'web') === 'web' ? await pageInfo(p, sha, ref, o.change, new URL(url).pathname.replace(/\/+$/, '')) : undefined;
    const r = await publishSite(store, base, out.files, { page, build: { sha: sha.slice(0, 7), version, build: b.id, at: Date.now() }, progress: say });
    db.prepare("UPDATE builds SET status = 'ready', files = ?, bytes = ?, url = ?, detail = ?, finished = ? WHERE id = ?").run(out.files.length, out.bytes, url, out.detail ?? null, Date.now(), rowId);
    // Beta moves only forward (2026-10-31 review): to a build of beta's newest commit, asked for or triggered, and never
    // behind a newer version that already finished. Anything else (an old tag, a pull request's workflow, a slower
    // build of an older commit) is published as its version and leaves beta, its mounts and commits alone.
    const newer = db.prepare("SELECT 1 FROM builds WHERE product = ? AND build = ? AND status = 'ready' AND change IS NULL AND version > ? LIMIT 1").get(p.id, b.id, version);
    const head = await githubCommit(slug, 'beta', gh).catch(() => null);
    const movesBeta = !o.change && !newer && (head ? head === sha : ref === 'beta');
    if (!o.change && !movesBeta) say(`${b.id} ${version} is published at its own address; beta stays (${newer ? 'a newer build is ready' : `${sha.slice(0, 7)} isn't beta's newest commit`})`);
    if (movesBeta && (b.target ?? 'web') === 'web') {
      await setBeta(p.id, b.id, version);
      (await import('./previews.ts')).noteBeta(p.id, { status: 'ready', at: Date.now(), sha: sha.slice(0, 7), ref, files: out.files.length, version: `${b.id} ${version}` });
    }
    if (!o.change) await prune(p, b.id, sub).catch((e) => say(`old builds not pruned: ${e.message}`));
    // Into another project's site too: mounted (its beta site serves it there) and, when asked, committed to its repo.
    const linked: string[] = [];
    if (b.publish?.page === 'site' && movesBeta) {
      // The site keeps its own page (a game page with its own loader, sound prompt and links): the build stays at its own
      // public address and only a pointer goes into the site, never the build's template index.html over the page.
      const target = getProduct(b.publish.project);
      const publicUrl = `${new URL(root).origin}/builds/${sub}/b/${b.id}/${version}/`;
      await (await siteStore()).put(`${base}/.public`, Buffer.from(JSON.stringify({ at: Date.now(), into: (target as any).github ?? target.id, page: 'site' })), 'application/json');
      await unmount(target, b.publish.path);
      const c = await pointInto(target, b.publish.path, publicUrl, { version, build: b.id, sha: sha.slice(0, 7) }, `Build ${b.id} ${version} of ${p.name} (${sha.slice(0, 7)}): point ${b.publish.path || '/'}index.html at it`, say);
      db.prepare('UPDATE builds SET commit_repo = ?, commit_sha = ? WHERE id = ?').run(c.slug, c.sha, rowId);
      linked.push(`${target.name} ${b.publish.path || '/'} (its own page, pointed at ${publicUrl})`, c.line);
    } else if (b.publish && movesBeta) {
      const target = getProduct(b.publish.project);
      await mount(target, b.publish.path, base);
      linked.push(`${target.name} ${b.publish.path || '/'}`);
      if (b.publish.commit) {
        const c = await commitInto(target, b.publish.path, out.files, `Build ${b.id} ${version} of ${p.name} (${sha.slice(0, 7)})`, say, { base, publicUrl: `${new URL(root).origin}/builds/${sub}/b/${b.id}/${version}/` });
        db.prepare('UPDATE builds SET commit_repo = ?, commit_sha = ? WHERE id = ?').run(c.slug, c.sha, rowId);
        linked.push(c.line);
      }
    }
    updateStep(step, { status: 'done', detail: `${b.id} ${version || o.change}: ${out.files.length} files, ${Math.round(out.bytes / 1e5) / 10} MB${linked.length ? `; also in ${linked.join(', ')}` : ''}`, data: { url, version, sha, sent: r.sent }, finished: true });
    if (movesBeta && (b.target ?? 'web') === 'web' && b.playtest !== false) await playIt(run, p, b.publish ? getProduct(b.publish.project) : p);
    else if (movesBeta && (b.target ?? 'web') !== 'web' && b.playtest !== false) await playDesktop(run, p, b, url);
    // The owner said to keep going live (golive-policy.ts): what just passed goes live by itself.
    if (!o.change && movesBeta) await (await import('./golive-policy.ts')).autoGoLive(p.id, `build ${b.id} ${version}`);
  } catch (e: any) {
    const why = String(e?.message ?? e).slice(0, 500);
    // In the log too: a customer's Studio is only visible to the platform through its logs (2026-10-31: a refused build
    // left no trace anywhere J or Claude could read).
    console.warn(`[builds] ${p.id} ${b.id} failed: ${why}`);
    if (rowId) db.prepare("UPDATE builds SET status = 'failed', detail = ?, finished = ? WHERE id = ?").run(why, Date.now(), rowId);
    updateStep(step, { status: 'failed', detail: why, finished: true });
  } finally {
    out?.cleanup();
  }
}

/** The 🐞 widget's page info for a published page (previews-cloud.ts: a customer's Studio posts with its report key). */
async function pageInfo(p: Product, sha: string, ref: string, change: string | undefined, root: string) {
  const { siteOrg } = await import('./sitekeys.ts');
  const own = siteOrg() ? await import('./reportkey.ts').then((R) => R.reportInfo(p.id)) : null;
  return { product: p.id, sha: sha.slice(0, 7), ref, ...(change ? { change } : {}), root, ...(own ? { src: own.widget, endpoint: own.endpoint, errors: own.errors } : {}), built: Date.now() };
}

// ------------------------------------------------------------------ runners

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hs-build-'));
const sizeOf = (files: { size: number }[]) => files.reduce((n, f) => n + f.size, 0);

/** npm or static: Studio's Cloud Run job runs the command (or the files are published as they are, with no package.json). */
async function viaStudio(p: Product, b: BuildSpec, slug: string, sha: string, token: string | null, gh: typeof fetch, say: (s: string) => void): Promise<Output> {
  const { githubFiles } = await import('./sitestore.ts');
  const dir = b.path && b.path !== '.' ? b.path : '';
  // Only GitHub's 404 means "no package.json" (a rate limit or an outage used to publish the unbuilt source as the build,
  // 2026-10-31 review); a package.json with no build script is a static site with tools (a dev server).
  let hasPkg = false;
  if (b.tool === 'npm') {
    const r = await gh(`https://api.github.com/repos/${slug}/contents/${dir ? `${encodeURI(dir)}/` : ''}package.json?ref=${sha}`, { headers: { 'User-Agent': 'hawkes-studio', Accept: 'application/vnd.github.raw' } });
    if (!r.ok && r.status !== 404) throw new Error(`GitHub couldn't read ${slug}'s package.json (${r.status}); the build waits for the next try rather than publish unbuilt files`);
    let scripts: Record<string, string> = {};
    if (r.ok) { try { scripts = JSON.parse(await r.text()).scripts ?? {}; } catch { scripts = {}; } }
    hasPkg = r.ok && (Boolean(scripts.build) || Boolean(b.command));
  }
  if (b.tool === 'static' || !hasPkg) {
    const from = [dir, b.tool === 'static' && b.out ? b.out : ''].filter(Boolean).join('/');
    say(`${b.tool === 'npm' ? 'no package.json: ' : ''}publishing ${from || 'the repo'} as it is`);
    const files = await githubFiles(slug, sha, { sub: from, fetcher: gh });
    return { files, bytes: sizeOf(files), cleanup: () => {} };
  }
  const { runCloudBuild } = await import('./cloudjob.ts');
  const cd = dir ? `cd '${dir.replace(/'/g, '')}' && ` : '';
  // The package manager its lockfile names (in its folder or the repo's root, for workspaces); skipped when the build's
  // own command installs. CI stays off unless the project sets it (Create React App fails every warning with CI on).
  const root = `/tmp/build/${p.id}`;
  const lock = (f: string) => `{ [ -f ${f} ] || [ -f "${root}/${f}" ]; }`;
  const install = `if ${lock('pnpm-lock.yaml')}; then npx --yes pnpm@9 install --frozen-lockfile; elif ${lock('yarn.lock')}; then npx --yes yarn@1 install --frozen-lockfile; elif ${lock('bun.lockb')} || ${lock('bun.lock')}; then npx --yes bun install; elif [ -f package-lock.json ]; then npm ci --no-audit --no-fund --loglevel=error; else npm install --no-audit --no-fund --loglevel=error; fi`;
  const outDir = path.posix.join(dir || '.', b.out ?? 'dist');
  const command = b.command ?? 'npm run build';
  const installs = /\b(npm (ci|install|i)\b|pnpm( [\w@.-]+)? install|yarn( [\w@.-]+)? install|bun install)/.test(command);
  const env = Object.entries({ CI: 'false', ...(b.env ?? {}) }).map(([k, v]) => `export ${k}='${String(v).replace(/'/g, `'\\''`)}'`).join('; ');
  say(`building ${sha.slice(0, 7)} in a Cloud Run job (${command})`);
  const r = await runCloudBuild(`build-${p.id}-${b.id}-${Date.now().toString(36)}`, {
    remote: `https://github.com/${slug}.git`, head: sha, cwd: root, command: `${env}; ${cd}${installs ? '' : `(${install}) && `}${command}`, outputs: [outDir], gitToken: token,
    onLine: (l) => { if (/^\[job\]|error|built in/i.test(l)) say(l); },
  });
  const tail = r.log.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400);
  if (r.error || r.code !== 0) throw new Error(`${command} failed${r.error ? `: ${r.error}` : ` (exit ${r.code})`}${tail ? `: ${tail}` : ''}`);
  if (!r.outputs) throw new Error(`the build made no ${outDir}/`);
  const tmp = tmpDir();
  await untar(r.outputs, tmp);
  return await folderOutput(path.join(tmp, outDir), tmp);
}

/**
 * Gen's word that a build lost or was refused its repo token, so it is worth one more try with a fresh one. Gen says
 * "The GitHub token for this build is gone (Gen restarted, or it expired)" (hawkesgen customer.ts customerToken), which
 * the first pattern ("token is gone") missed: sick-of-it-unity v3 and v4 failed on it (2026-11-01). Exported for the tests.
 */
export function tokenLost(error: unknown): boolean {
  return /token\b[^.]{0,40}?\b(is gone|gone|expired)|GitHub refused|can't read the repo|Bad credentials|\b401\b/i.test(String(error ?? ''));
}

/** unity: Hawkes Gen builds that commit in the cloud with the repo's own token, and hands back the output as an asset. */
async function viaGen(p: Product, b: BuildSpec, slug: string, sha: string, ref: string, token: string | null, say: (s: string) => void, resume: { job?: string; onSubmit?: (id: string) => void; onDone?: () => void } = {}): Promise<Output> {
  if (!token) throw new Error(`Studio has no GitHub access to ${slug}: connect GitHub and install the app on it`);
  const { genRun, gen } = await import('./gen.ts');
  say('Hawkes Gen is building it (Unity WebGL, in the cloud)');
  const submit = (tok: string, r: typeof resume) => genRun('unity.build', p.id, {
    github: { repo: slug, commit: sha, token: tok, ref }, ...(b.path ? { path: b.path } : {}), ...(b.method ? { method: b.method } : {}), target: 'web', out: 'artifact',
  }, (j) => { if (j?.progress?.step || j?.status) say(`Hawkes Gen: ${j.progress?.step ?? j.status}`); }, 3 * 60 * 60 * 1000, r);
  let job: any = await submit(token, { job: resume.job, onSubmit: resume.onSubmit });
  // The repo's token lasts an hour and lives only in Gen's memory: a build that waited in Gen's queue, or a Gen that
  // restarted, can lose it. Once, with a fresh token (2026-10-31 review); a real access problem fails the same way again.
  if (job.status === 'failed' && tokenLost(job.error)) {
    const { forgetRepoTokens, repoToken } = await import('./ghtoken.ts');
    forgetRepoTokens();
    const fresh = await repoToken(slug);
    if (fresh) { say('the GitHub token had run out while it waited: building again with a fresh one'); job = await submit(fresh, { onSubmit: resume.onSubmit }); }
  }
  if (job.status !== 'done') throw new Error(`the Unity build ${job.status}: ${job.error ?? 'no reason given'}`);
  resume.onDone?.();
  const asset = job.result?.artifact?.asset;
  if (!asset) throw new Error('Hawkes Gen finished without the build output');
  say('downloading the build');
  const tmp = tmpDir();
  // Streamed from Gen straight into tar (2026-11-01): a Unity build with its Addressables content is hundreds of MB, and
  // holding it in memory (arrayBuffer, a Buffer copy, spawnSync's input) on top of the unpacked files (Cloud Run's disk
  // is memory too) went over a customer's Studio's 2 GiB, which restarted it mid-build until the run was stopped.
  await untarStream(await gen.request(`/files/${asset}`, { raw: true }), tmp);
  return { ...(await folderOutput(tmp, tmp)), detail: job.result?.unity ? `Unity ${job.result.unity}` : undefined };
}

/** actions: the workflow run's artifact (its contents are the build: index.html at the root for the web). */
async function viaActions(b: BuildSpec, slug: string, a: { runId: string; name?: string }, gh: typeof fetch, say: (s: string) => void): Promise<Output> {
  const name = a.name ?? b.artifact ?? b.id;
  say(`downloading artifact ${name} of run ${a.runId}`);
  const list = await gh(`https://api.github.com/repos/${slug}/actions/runs/${encodeURIComponent(a.runId)}/artifacts?per_page=100`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hawkes-studio' } });
  if (!list.ok) throw new Error(`GitHub: the run's artifacts: ${list.status}`);
  const art = ((await list.json()) as any).artifacts?.find((x: any) => x.name === name && !x.expired);
  if (!art) throw new Error(`run ${a.runId} has no artifact named ${name} (upload it with actions/upload-artifact under that name)`);
  const zip = await gh(art.archive_download_url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hawkes-studio' } });
  if (!zip.ok) throw new Error(`GitHub: downloading ${name}: ${zip.status}`);
  const data = Buffer.from(await zip.arrayBuffer());
  // A web build is served from its files; any other target is one download, as it came.
  if ((b.target ?? 'web') !== 'web') {
    const file = `${b.target}.zip`;
    const { gitOid } = await import('./sitestore.ts');
    return { files: [{ path: file, oid: gitOid(data), size: data.length, read: async () => data }], bytes: data.length, cleanup: () => {} };
  }
  const tmp = tmpDir();
  unzip(data, tmp);
  return await folderOutput(tmp, tmp);
}

async function folderOutput(dir: string, tmp: string): Promise<Output> {
  if (!fs.existsSync(dir)) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error('the build made no output'); }
  // An output that is one folder (an artifact zipped around its folder): its contents are the site.
  const entries = fs.readdirSync(dir);
  const root = entries.length === 1 && fs.statSync(path.join(dir, entries[0])).isDirectory() && !fs.existsSync(path.join(dir, 'index.html')) ? path.join(dir, entries[0]) : dir;
  const files = await folderFilesAsync(root);
  if (!files.length) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error('the build output is empty'); }
  return { files, bytes: sizeOf(files), cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

/** Unpacks a .tar.gz response into dir as it downloads, never holding the archive in memory. */
export async function untarStream(res: Response, dir: string) {
  if (!res.body) throw new Error('unpacking the build: the download was empty');
  const { spawn } = await import('node:child_process');
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  const tar = spawn('tar', ['-xzf', '-'], { cwd: dir, stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  tar.stderr.on('data', (d) => { if (err.length < 2000) err += String(d); });
  const exited = new Promise<number>((ok) => tar.on('close', (code) => ok(code ?? 1)));
  let piping: Error | null = null;
  await pipeline(Readable.fromWeb(res.body as any), tar.stdin).catch((e) => { piping = e; });
  const code = await exited;
  if (code !== 0 || piping) throw new Error(`unpacking the build: ${(err.trim() || (piping as Error | null)?.message || `tar exited ${code}`).slice(0, 300)}`);
}

/** Unpacks a .tar.gz held in memory without blocking the event loop (tar runs as a child process, not spawnSync). */
export async function untar(data: Buffer, dir: string) {
  const { spawn } = await import('node:child_process');
  const tar = spawn('tar', ['-xzf', '-'], { cwd: dir, stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  tar.stderr.on('data', (d) => { if (err.length < 2000) err += String(d); });
  const exited = new Promise<number>((ok) => { tar.on('error', (e) => { err += String(e.message); ok(1); }); tar.on('close', (code) => ok(code ?? 1)); });
  tar.stdin.on('error', () => {});
  tar.stdin.end(data);
  const code = await exited;
  if (code !== 0) throw new Error(`unpacking the build: ${err.trim().slice(0, 300)}`);
}
function unzip(data: Buffer, dir: string) {
  const zip = path.join(dir, '.artifact.zip');
  fs.writeFileSync(zip, data);
  const script = 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])';
  let ok = false;
  for (const py of ['python3', 'python', 'py']) {
    const x = spawnSync(py, ['-c', script, zip, dir], { encoding: 'utf8' });
    if (x.status === 0) { ok = true; break; }
  }
  fs.rmSync(zip, { force: true });
  if (!ok) throw new Error('unpacking the artifact: no Python here to read the zip');
}

/** Commits a build's files into another project's repo at a path on its beta branch (GitHub's Git Data API, one commit). */
/** Files GitHub's API takes as blobs comfortably (its limit is around 40 MB of base64; git itself refuses 100 MB). */
const BLOB_MAX = 25 * 1024 * 1024;

/**
 * The files to commit for a build going into a website, and the public address of the folder too big for git. A build
 * with files over BLOB_MAX (a Unity game's .data, .wasm) keeps that folder on the public builds address (the Worker's
 * /builds/o/<org>/..., marked public), and the committed pages point there (Unity's buildUrl, src="Build/...");
 * everything else is committed (2026-10-31: Yooba Land's 160 MB build couldn't be committed).
 */
export function splitForGit(files: { path: string; size: number }[], publicUrl: string) {
  const big = files.filter((f) => f.size > BLOB_MAX);
  if (!big.length) return { commit: files.map((f) => f.path), external: null as string | null, rewrite: (_p: string, t: string) => t };
  const dirs = [...new Set(big.map((f) => (f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : '')))];
  if (dirs.includes('') || dirs.length > 1) throw new Error(`build files too big for git (${big.map((f) => `${f.path} ${Math.round(f.size / 1e6)} MB`).join(', ')}) aren't all in one folder, so they can't be served from the public builds address: keep the big files in one folder (Unity's Build/), or mount the build instead of committing it (publish without commit)`);
  const dir = dirs[0];
  const esc = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    commit: files.filter((f) => !f.path.startsWith(`${dir}/`)).map((f) => f.path),
    external: `${publicUrl}${dir}/`,
    // "Build", "Build/x.loader.js", './Build/...' in the committed pages and scripts point at the public address.
    rewrite: (p: string, t: string) => (/\.(html?|js|mjs|json|css)$/i.test(p) ? t.replace(new RegExp(`(["'\`(=]\\s*)(?:\\./)?${esc}(?=["'\`/)])`, 'g'), `$1${publicUrl}${dir}`) : t),
  };
}

/** publish.page "site": <path>build.json and window.HAWKES_BUILD_URL in <path>index.html, on the target's beta. */
async function pointInto(target: Product, at: string, url: string, info: { version: number; build: string; sha: string }, message: string, say: (s: string) => void) {
  const slug = String((target as any).github ?? '');
  if (!slug) throw new Error(`${target.name} has no GitHub repo to point at the build`);
  const { repoToken, githubFetch } = await import('./ghtoken.ts');
  const token = await repoToken(slug);
  if (!token) throw new Error(`Studio has no GitHub access to ${slug}`);
  const gh = githubFetch(token);
  const read = async (ref: string) => {
    const r = await gh(`https://api.github.com/repos/${slug}/contents/${encodeURI(`${at}index.html`)}?ref=${ref}`, { headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'hawkes-studio' } });
    return r.ok ? r.text() : null;
  };
  const page = (await read('beta')) ?? (await read('main'));
  if (page == null) throw new Error(`${slug} has no ${at}index.html to point at the build (publish.page "site" keeps the site's own page)`);
  const json = { version: info.version, base: url, build: info.build, sha: info.sha, at: new Date().toISOString() };
  const file = (path: string, text: string) => { const b = Buffer.from(text, 'utf8'); return { path, oid: '', size: b.length, read: async () => b }; };
  say(`pointing ${slug} ${at}index.html at ${url}`);
  return commitInto(target, at, [file('index.html', pointPage(page, url)), file('build.json', `${JSON.stringify(json, null, 2)}\n`)], message, say, null);
}

async function commitInto(target: Product, at: string, files: import('./sitestore.ts').SiteFile[], message: string, say: (s: string) => void, pub: { base: string; publicUrl: string } | null = null) {
  if (pub) {
    const split = splitForGit(files, pub.publicUrl);
    if (split.external) {
      const store = await siteStore();
      await store.put(`${pub.base}/.public`, Buffer.from(JSON.stringify({ at: Date.now(), into: (target as any).github ?? target.id })), 'application/json');
      say(`files too big for git stay on the public builds address (${split.external}); the pages point there`);
      const keep = new Set(split.commit);
      // Only text files are rewritten (an image or a binary stays byte for byte).
      files = files.filter((f) => keep.has(f.path)).map((f) => (/\.(html?|js|mjs|json|css)$/i.test(f.path) && f.size < 5 * 1024 * 1024 ? { ...f, read: async () => Buffer.from(split.rewrite(f.path, (await f.read()).toString('utf8'))) } : f)) as typeof files;
    }
  }
  const slug = String((target as any).github ?? '');
  if (!slug) throw new Error(`${target.name} has no GitHub repo to commit the build into`);
  const { repoToken, githubFetch } = await import('./ghtoken.ts');
  const token = await repoToken(slug);
  if (!token) throw new Error(`Studio has no GitHub access to ${slug}`);
  const gh = githubFetch(token);
  const api = (p: string, init: any = {}) => gh(`https://api.github.com/repos/${slug}${p}`, { ...init, headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'hawkes-studio' } }).then(async (r) => {
    if (!r.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${p}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json() as any;
  });
  say(`committing ${files.length} files into ${slug} beta ${at || '/'}`);
  const head = await api('/git/ref/heads/beta').catch(() => null) ?? await api('/git/ref/heads/main');
  const base = await api(`/git/commits/${head.object.sha}`);
  const tree: { path: string; mode: string; type: string; sha: string }[] = [];
  for (const f of files) {
    const blob = await api('/git/blobs', { method: 'POST', body: JSON.stringify({ content: (await f.read()).toString('base64'), encoding: 'base64' }) });
    tree.push({ path: `${at}${f.path}`, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const t = await api('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: base.tree.sha, tree }) });
  const c = await api('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: t.sha, parents: [head.object.sha] }) });
  const branch = head.ref?.endsWith('/beta') ? 'beta' : null;
  if (branch) await api('/git/refs/heads/beta', { method: 'PATCH', body: JSON.stringify({ sha: c.sha, force: false }) });
  else await api('/git/refs', { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/beta', sha: c.sha }) });
  return { line: `${slug} beta (${c.sha.slice(0, 7)})`, slug, sha: String(c.sha) };
}

// ------------------------------------------------------------------ playing it

/** A web build plays where it is beta now (its own site, or the site it is mounted into): the project's own scenario. */
async function playIt(run: string, built: Product, site: Product) {
  const { playtestProduct } = await import('./pipeline.ts');
  const p = site;
  const t = p.contract ? { scenario: 'smoke', where: 'local' as const } : { mode: 'site' as const, where: 'local' as const };
  try { await playtestProduct(run, p, t as any, { review: true, mode: 'verify', focus: `the new build of ${built.name}` }); }
  catch (e: any) { console.warn(`[builds] playtest of ${p.id}: ${e?.message ?? e}`); }
}

/** A desktop build plays on Hawkes Gen's playtesters (windows, linux, proton), downloaded from its own address. */
async function playDesktop(run: string, p: Product, b: BuildSpec, url: string) {
  const { startStep, updateStep } = await import('./pipeline.ts');
  const step = startStep(run, p.id, 'playtest', `${b.id}@${b.target}`, 'on a Hawkes Gen playtester');
  try {
    const { genRun } = await import('./gen.ts');
    const { withPass } = await import('./sitekeys.ts');
    const job: any = await genRun('playtest.run', p.id, { build: { url: `${url}${b.target}.zip` }, target: b.target === 'linux' ? 'linux' : 'windows', scenario: p.contract ? 'smoke' : undefined, ...withPass() }, undefined, 45 * 60 * 1000);
    updateStep(step, { status: job.status === 'done' ? 'done' : 'failed', detail: job.status === 'done' ? (job.result?.outcome ?? 'played') : String(job.error ?? job.status).slice(0, 300), job: job.id, finished: true });
  } catch (e: any) {
    updateStep(step, { status: 'failed', detail: String(e?.message ?? e).slice(0, 300), finished: true });
  }
}

// ------------------------------------------------------------------ API

/**
 *   GET  /api/projects/<id>/builds                       its builds and their history (each with its address)
 *   POST /api/projects/<id>/builds   {build?, ref?}      builds it now (a run; Talk's conversation hears back)
 *   POST /api/projects/<id>/builds/<build>/<n>/beta      makes that build beta (or rolls beta back to it)
 */
export async function handleBuildRoutes(req: http.IncomingMessage, res: http.ServerResponse, route: string, method: string, readJson: (r: http.IncomingMessage) => Promise<any>) {
  const m = /^\/api\/(?:projects|games)\/([a-z][a-z0-9-]{1,39})\/builds(?:\/([a-z0-9-]+)\/(\d+)\/beta)?$/.exec(route);
  if (!m) return false;
  const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const p = getProduct(m[1]);
  if (!m[2] && method === 'GET') {
    const { previewUrl } = await import('./previews.ts');
    return send(200, { project: p.id, builds: buildsOf(p), beta: previewUrl(p.id), history: buildHistory(p.id) }), true;
  }
  if (!m[2] && method === 'POST') {
    const b = await readJson(req);
    const { originOf } = await import('./followup.ts');
    const r = await startBuild(p.id, { build: b.build ? String(b.build) : undefined, ref: b.ref ? String(b.ref) : undefined, origin: originOf(req) });
    return send(200, r ? { run: r.id, builds: r.builds } : { run: null, note: 'nothing to build' }), true;
  }
  if (m[2] && method === 'POST') return send(200, await setBeta(p.id, m[2], Number(m[3]))), true;
  return send(405, { error: 'GET or POST' }), true;
}

/**
 * GitHub's push hook for a project's repo (server.ts, after its OIDC check): beta pushes and build-* tags start the
 * builds they trigger; an Actions build's "built" notice publishes its artifact. null when no project here has this repo.
 */
export async function onRepoHook(claims: Record<string, any>, body: any) {
  const mine = projectsForRepo(String(claims.repository ?? ''));
  if (!mine.length) return null;
  // Handed over to another Studio (config.ts managedBy): heard, and left alone.
  const projects = mine.filter((p) => !managedElsewhere(p));
  if (!projects.length) return { ok: true, managedBy: managedElsewhere(mine[0]), note: `managed by ${managedElsewhere(mine[0])}: this Studio leaves it alone`, runs: {} as Record<string, string> };
  const ref = String(claims.ref ?? '');
  const sha = String(claims.sha ?? '');
  const out: Record<string, string> = {};
  if (body?.kind === 'build') {
    const build = String(body.build ?? '');
    for (const p of projects) {
      if (!buildsOf(p).some((b) => b.id === build && b.tool === 'actions')) continue;
      const r = await startBuild(p.id, { build, sha, ref: ref.replace(/^refs\/(heads|tags)\//, ''), artifact: { runId: String(claims.run_id ?? ''), name: body.artifact ? String(body.artifact) : undefined } });
      if (r) out[p.id] = r.id;
    }
    return { ok: true, kind: 'build', runs: out };
  }
  const trigger: BuildTrigger | null = ref === 'refs/heads/beta' ? 'beta' : /^refs\/tags\/build-/.test(ref) ? 'tag' : null;
  if (!trigger) return null;
  for (const p of projects) {
    const r = await startBuild(p.id, { trigger, sha, ref: trigger === 'beta' ? 'beta' : ref.replace(/^refs\/tags\//, '') }).catch((e) => { out[p.id] = `not built: ${e.message}`; return null; });
    if (r) out[p.id] = r.id;
  }
  return { ok: true, trigger, runs: out };
}
