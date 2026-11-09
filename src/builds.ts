// Builds (docs/builds.md; J, 2026-10-31: "customer first and flexible and powerful"): a project's `builds` say how it is
// built, separately from its engine. Each build is a run (Activity, Runs, and back to the Talk conversation that asked),
// its output is published once under its version and stays playable, beta is a pointer to one of them, and a build can
// also be mounted into another project's site (a Unity game in its website's Game/) or committed into that repo.
//
// Runners: unity → Hawkes Gen (unity.build customer mode, the repo's own token per job, the output as a library asset);
// npm/static → Studio's Cloud Run job, or the files as they are; actions → the project's own GitHub Actions (its last
// step tells Studio, server.ts hooks; Studio downloads that run's artifact).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type http from 'node:http';
import { db, newId } from './db.ts';
import { getProduct, loadProducts, hasOwnBeta, StudioError, managedElsewhere, setBuildMachine, type BuildSpec, type BuildMachine, type Product } from './config.ts';
import { folderFilesAsync } from './sitestore.ts';
import { BuildFailure, LOG_LINES, extractLog, recordFailure, announce, settleFailure } from './buildfail.ts';
import { asFirebase } from './firebasebuild.ts';

db.exec(`CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY, product TEXT NOT NULL, build TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
  sha TEXT, ref TEXT, runner TEXT NOT NULL, target TEXT NOT NULL, files INTEGER, bytes INTEGER, url TEXT, run TEXT,
  change TEXT, detail TEXT, started INTEGER NOT NULL, finished INTEGER
)`);
try { db.exec('ALTER TABLE builds ADD COLUMN gen_job TEXT'); } catch { /* there already */ }
// When the Gen job finished: until then a restart only waits on Gen and isn't counted (pipeline.ts waitingInGen).
try { db.exec('ALTER TABLE builds ADD COLUMN gen_done INTEGER'); } catch { /* there already */ }
// When a token went to Gen with the submit, and when Gen last asked for a fresh one: how long a token sits is measurable.
try { db.exec('ALTER TABLE builds ADD COLUMN token_sent INTEGER'); } catch { /* there already */ }
try { db.exec('ALTER TABLE builds ADD COLUMN token_at INTEGER'); } catch { /* there already */ }
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS builds_version ON builds (product, build, version)'); } catch { /* there */ }
// publish.commit: the repo and the commit on its beta that holds this build (going live fast-forwards that repo's main to it).
for (const col of ['commit_repo', 'commit_sha']) { try { db.exec(`ALTER TABLE builds ADD COLUMN ${col} TEXT`); } catch { /* there */ } }
// Why a build failed (buildfail.ts): the class (token / restart / compile / publish / timeout ...), infrastructure or code,
// the plain words, the stage it stopped at, the last ~200 log lines Gen kept, every Gen job tried, and when J was told.
for (const col of ['fail_class', 'fail_kind', 'fail_plain', 'fail_step', 'fail_log', 'gen_jobs']) { try { db.exec(`ALTER TABLE builds ADD COLUMN ${col} TEXT`); } catch { /* there */ } }
try { db.exec('ALTER TABLE builds ADD COLUMN notified INTEGER'); } catch { /* there */ }

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
  /** Which try this is when Studio retries a transient failure by itself (buildaccess.ts): 1 or none = the first. */
  retry?: number;
  /** An Actions build that finished: its workflow run and artifact (server.ts hooks). */
  artifact?: { runId: string; name?: string };
};

/** A project's builds: its own, else a web project's implicit one (its beta branch built, or published as it is). */
export function buildsOf(p: Product): BuildSpec[] {
  // A Firebase workflow build runs in Studio's own cloud build now (firebasebuild.ts), never in GitHub Actions.
  if (p.builds?.length) return p.builds.map(asFirebase);
  // A web app with its own server and beta (p.beta, kind app) is built and served where it's hosted: no build here,
  // which used to fail on every push (2026-10-31 review).
  return (p.engine as string) === 'web' && (p as any).github && !hasOwnBeta(p) && (p as any).kind !== 'app' ? [{ id: 'web', tool: 'npm', target: 'web' }] : [];
}
/** When a build runs by itself: actions builds start themselves (their own workflow's triggers), the rest on beta pushes. */
export const triggersOf = (b: BuildSpec): BuildTrigger[] => b.on ?? (b.tool === 'actions' ? [] : ['beta']);
/**
 * How a project's builds really start, for the messages that tell a person what will build it (J, 2026-11-03: go live
 * said "a push to beta" for a project whose builds run only on a "build-" tag). Exported for the tests.
 */
export function buildHint(p: Product): string {
  const bs = buildsOf(p);
  if (!bs.length) return `this project has no builds set up`;
  const byPush = bs.filter((b) => triggersOf(b).includes('beta')).map((b) => b.id);
  const byTag = bs.filter((b) => triggersOf(b).includes('tag')).map((b) => b.id);
  const parts = [] as string[];
  if (byPush.length) parts.push(`a push to beta builds ${byPush.join(', ')}`);
  if (byTag.length) parts.push(`a build-* tag builds ${byTag.join(', ')}`);
  const manual = bs.filter((b) => !triggersOf(b).includes('beta') && !triggersOf(b).includes('tag')).map((b) => b.id);
  if (manual.length) parts.push(`${manual.join(', ')} ${manual.length > 1 ? 'start' : 'starts'} only from its own workflow or the Build button`);
  return `${parts.join('; ')}${byPush.length === bs.length ? '' : '; a plain push to beta does not build everything'}; the Build button builds any of them now`;
}

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
  const { siteStore: store } = await import('./sitestore.ts');
  const { DOMAIN } = await import('./previews.ts');
  return store(DOMAIN);
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
export async function prune(p: Product, build: string, sub: string) {
  const rows = db.prepare("SELECT * FROM builds WHERE product = ? AND build = ? AND status = 'ready' AND change IS NULL ORDER BY version DESC").all(p.id, build) as BuildRow[];
  if (rows.length <= BUILDS_KEEP) return;
  // The versions a website's main (live) and beta name in their <path>build.json stay however many newer builds exist.
  // Unreadable (not just missing) means nothing is pruned: the error reaches the caller's "old builds not pruned" line.
  const pinned = await pinnedVersions(p, build);
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
    if ((beta?.build === build && beta?.version === r.version) || mounted.has(base) || pinned.has(r.version)) continue;
    if ((r as any).commit_sha && publicKept < 3 && (await store.get(`${base}/.public`).catch(() => null))) { publicKept++; continue; }
    await removeSite(store, base);
    db.prepare("UPDATE builds SET status = 'pruned', url = NULL WHERE id = ?").run(r.id);
  }
}

/**
 * Versions of one build that the publish target's main or beta point at (publish.page "site": <path>build.json, read
 * through GitHub with the target repo's own token). Live and beta each keep working however many newer builds exist.
 * A file that isn't there pins nothing; any other failure to read it throws.
 */
export async function pinnedVersions(p: Product, build: string): Promise<Set<number>> {
  const pins = new Set<number>();
  const spec = buildsOf(p).find((x) => x.id === build);
  if (spec?.publish?.page !== 'site') return pins;
  const target = getProduct(spec.publish.project);
  const slug = String((target as any).github ?? '');
  if (!slug) return pins;
  const { repoToken, githubFetch } = await import('./ghtoken.ts');
  const token = await repoToken(slug);
  if (!token) throw new Error(`Studio has no GitHub access to ${slug} to see which builds its pages use`);
  const gh = githubFetch(token);
  for (const ref of ['main', 'beta']) {
    const r = await gh(`https://api.github.com/repos/${slug}/contents/${encodeURI(`${spec.publish.path}build.json`)}?ref=${ref}`, { headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'hawkes-studio' } });
    if (r.status === 404) continue;
    if (!r.ok) throw new Error(`GitHub: ${slug} ${spec.publish.path}build.json on ${ref}: ${r.status}`);
    let j: any;
    try { j = JSON.parse(await r.text()); } catch { throw new Error(`${slug} ${spec.publish.path}build.json on ${ref} isn't JSON`); }
    const v = Number(j?.version);
    if ((j?.build == null || j.build === build) && Number.isInteger(v)) pins.add(v);
  }
  return pins;
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
  // A stuck "building" row from before (its run gone) is settled now, so it never stands in this build's way.
  await reconcileBuilds({ product: p.id }).catch((e) => console.warn(`[builds] ${p.id}: reconciling: ${e?.message ?? e}`));
  const { tagRun } = await import('./followup.ts');
  const id = newId('r');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'build', 'running', `build ${p.id}`, JSON.stringify([p.id]), JSON.stringify({ builds: specs.map((b) => b.id), ref: o.ref, trigger: o.trigger, change: o.change }), Date.now());
  tagRun(id, o.origin);
  // A rebuild is the answer to the failed build's Inbox card: it goes now, and comes back only if this one fails differently.
  if (!o.change) await (await import('./inbox.ts')).resolveBuildCards(p.id, specs.map((b) => b.id), o.origin ? 'Talk' : 'J').catch((e) => console.warn(`[builds] ${p.id}: resolving the failed build's card: ${e?.message ?? e}`));
  // Building in Studio's own cloud: a card still waiting on GitHub's "Actions: write" for this project has nothing to wait for.
  if (specs.some((b) => b.tool === 'firebase')) await (await import('./firebasebuild.ts')).retireActionsCards({ product: p.id }).catch((e) => console.warn(`[builds] ${p.id}: closing the Actions card: ${e?.message ?? e}`));
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

/** The longest a build may stay "building": Gen's own wait ends at 3 h; past this, nobody is going to finish it. */
export const BUILD_MAX_MS = () => Number(process.env.STUDIO_BUILD_MAX_MS) > 0 ? Number(process.env.STUDIO_BUILD_MAX_MS) : 4 * 3600_000;

export type Reconciled = { build: string; version: number; product: string; job: string | null; outcome: string };

/**
 * Settles builds that say "building" but that nothing is going to finish (2026-11-02: sick-of-it-unity v1 stayed "building"
 * for 12 hours with its Gen job long gone). A row is looked at when its run isn't running any more (stopped, failed,
 * interrupted, deleted), or when it has been building longer than BUILD_MAX_MS. Rows whose run is going stay alone: that
 * run is waiting on the job (and a restart re-attaches to it, pipeline.ts waitingInGen).
 * With a Gen job, Gen is asked once for its state: failed or cancelled → the build fails with Gen's reason; done → the
 * build fails saying Gen did finish and Studio didn't publish it (start it again); still going → cancelled, and the build
 * fails ("timed out" when it ran past the maximum). Gen unreachable → the row is left for the next look; Gen not
 * knowing the job (404) → failed. No polling: called when Studio starts (after the runs are resumed), when a build starts,
 * and when Gen says a Unity build ended (the event listener below). `only`: one Gen job (that event).
 */
export async function reconcileBuilds(o: { only?: string; product?: string; now?: number; job?: (id: string) => Promise<any>; cancel?: (id: string, why: string) => Promise<unknown> } = {}): Promise<Reconciled[]> {
  const now = o.now ?? Date.now();
  const rows = db.prepare(`SELECT b.id, b.product, b.build, b.version, b.gen_job, b.started, b.run, r.status AS run_status FROM builds b LEFT JOIN runs r ON r.id = b.run
    WHERE b.status = 'building' ${o.product ? 'AND b.product = ?' : ''}`).all(...(o.product ? [o.product] : [])) as any[];
  const out: Reconciled[] = [];
  for (const b of rows) {
    if (o.only && b.gen_job !== o.only) continue;
    const orphan = b.run_status !== 'running';
    const old = now - b.started > BUILD_MAX_MS();
    if (!orphan && !old) continue;
    const age = `${Math.round((now - b.started) / 360_000) / 10} h`;
    const why = orphan ? `its run ${b.run_status ?? 'is gone'} while the build was still going` : `it ran past ${Math.round(BUILD_MAX_MS() / 360_000) / 10} h`;
    const fail = (detail: string, gone?: any) => {
      const r = db.prepare("UPDATE builds SET status = 'failed', detail = ?, finished = ? WHERE id = ? AND status = 'building'").run(detail.slice(0, 500), now, b.id);
      if (!Number(r.changes)) return;
      out.push({ build: b.build, version: b.version, product: b.product, job: b.gen_job ?? null, outcome: detail });
      // Keep the reason, the log Gen has, and tell J once (buildfail.ts).
      void settleFailure(b.id, detail.slice(0, 500), { job: gone, stage: 'build' }).catch((e) => console.warn(`[builds] couldn't record why ${b.id} failed: ${e?.message ?? e}`));
    };
    if (!b.gen_job) { fail(orphan ? `stopped: ${why}, with no Gen job to wait for` : `timed out after ${age}: no result`); continue; }
    let job: any;
    try {
      job = await (o.job ?? ((id) => import('./gen.ts').then((G) => G.gen.job(id))))(b.gen_job);
    } catch (e: any) {
      if (e?.status === 404 || /not found|no such job/i.test(String(e?.message))) { fail(`Hawkes Gen doesn't know job ${b.gen_job} any more (${why}); build again`); continue; }
      console.warn(`[builds] ${b.product} ${b.build} ${b.version}: couldn't ask Gen about ${b.gen_job}: ${String(e?.message ?? e).slice(0, 160)}`);
      continue;
    }
    const status = String(job?.status ?? '');
    if (status === 'done') {
      db.prepare('UPDATE builds SET gen_done = ? WHERE id = ? AND gen_done IS NULL').run(now, b.id);
      fail(`Hawkes Gen finished job ${b.gen_job}, but Studio stopped before publishing it (${why}); build again`, job);
    } else if (status === 'failed' || status === 'cancelled') {
      db.prepare('UPDATE builds SET gen_done = ? WHERE id = ? AND gen_done IS NULL').run(now, b.id);
      fail(`the Unity build ${status}: ${job?.error ?? 'no reason given'}`, job);
    } else {
      const text = old ? `timed out after ${age} in Hawkes Gen (job ${b.gen_job} was still ${status || 'running'}); cancelled it` : `stopped: ${why}; cancelled Gen job ${b.gen_job}`;
      fail(text, job);
      await (o.cancel ?? ((id, w) => import('./cancel.ts').then((C) => C.cancelJob(id, 'Studio', w))))(b.gen_job, text).catch((e: any) => console.warn(`[builds] couldn't cancel Gen job ${b.gen_job}: ${String(e?.message ?? e).slice(0, 160)}`));
    }
  }
  if (out.length) console.warn(`[builds] settled ${out.length} stuck build(s): ${out.map((x) => `${x.product} ${x.build} ${x.version}`).join(', ')}`);
  return out;
}

/** Gen says a Unity build ended: a build row still waiting on it, whose run is gone, is settled at once. */
let watching = false;
export async function watchGenBuilds() {
  if (watching) return;
  watching = true;
  const { genEvents } = await import('./gen.ts');
  const { terminal } = await import('./genevents.ts');
  genEvents.onEvent((type, job) => {
    if (type !== 'job' || !job?.id || !terminal(job)) return;
    if (!db.prepare("SELECT 1 FROM builds WHERE gen_job = ? AND status = 'building'").get(String(job.id))) return;
    void reconcileBuilds({ only: String(job.id) }).catch((e) => console.warn(`[builds] reconciling ${job.id}: ${e?.message ?? e}`));
  });
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
  // Where it is, for the failure ("failed while publishing"): buildfail.ts Stage.
  let stage: import('./buildfail.ts').Stage = 'checkout';
  let shaSeen: string | null = o.sha ?? null;
  // Downloading the output, unpacking and publishing hold Studio's one heavy slot (heavyslot.ts); the build itself and
  // its playtest don't.
  const slot: { release: (() => void) | null } = { release: null };
  const hold = async () => { if (!slot.release) slot.release = await (await import('./heavyslot.ts')).heavySlot(say); };
  const release = () => slot.release?.();
  try {
    if (!slug) throw new Error(`${p.name} has no GitHub repo to build from`);
    const { repoToken, githubFetch } = await import('./ghtoken.ts');
    const token = await repoToken(slug);
    const gh = githubFetch(token);
    const { githubCommit } = await import('./sitestore.ts');
    const ref = o.ref ?? 'beta';
    const sha = o.sha ?? (await githubCommit(slug, ref, gh)) ?? (await githubCommit(slug, 'main', gh));
    if (!sha) throw new Error(`${slug} has no ${ref} or main branch on GitHub`);
    shaSeen = sha;
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
      // Before dispatching: can the app start workflows here? If not, the access card shows at once (buildaccess.ts).
      const pre = await (await import('./buildaccess.ts')).preflight(p.id, b.id, slug, b.workflow);
      if (!pre.ok) throw new Error(`GitHub wouldn't start ${b.workflow} in ${slug}: 403 Resource not accessible by integration (preflight: the app has no Actions: write)`);
      say(`starting ${b.workflow} on ${ref}`);
      const r = await gh(`https://api.github.com/repos/${slug}/actions/workflows/${encodeURIComponent(b.workflow)}/dispatches`, { method: 'POST', headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'hawkes-studio' }, body: JSON.stringify({ ref }) });
      if (!r.ok) throw new Error(`GitHub wouldn't start ${b.workflow} in ${slug}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      updateStep(step, { status: 'done', detail: `started ${b.workflow} on ${ref}: its build reports back when it's done (a run of its own)`, finished: true });
      return;
    }
    // Resumed after a restart: the same row and version, and a Unity build waits for the Gen job it started.
    const version = o.resume ? o.resume.version : o.change ? 0 : nextVersion(p.id, b.id);
    rowId = o.resume?.row ?? newId('b');
    if (!o.resume) db.prepare('INSERT INTO builds (id, product, build, version, status, sha, ref, runner, target, run, change, started) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(rowId, p.id, b.id, version || -Date.now(), 'building', sha, ref, runnerOf(b), b.target ?? 'web', run, o.change ?? null, Date.now());
    say(`${sha.slice(0, 7)} (${ref})${o.resume ? ', carrying on after a restart' : ''}`);
    const row = rowId;
    stage = 'build';
    out = b.tool === 'unity' ? await viaGen(p, b, slug, sha, ref, token, say, { job: o.resume?.job ?? undefined, row, onSubmit: (id) => db.prepare('UPDATE builds SET gen_job = ?, gen_done = NULL, token_sent = ?, token_at = ? WHERE id = ?').run(id, Date.now(), Date.now(), row), onDone: () => db.prepare('UPDATE builds SET gen_done = ? WHERE id = ?').run(Date.now(), row) }, hold)
      : b.tool === 'actions' ? await viaActions(b, slug, o.artifact!, gh, say, hold)
      : b.tool === 'firebase' ? await viaFirebase(p, b, slug, sha, ref, token, gh, say, hold)
      : await viaStudio(p, b, slug, sha, token, gh, say, hold);
    await hold();
    stage = 'publish';
    // Publish: once, under its version (or the change's preview), behind the Studio's sign-in.
    const { sub, root } = await siteOf(p);
    const base = o.change ? `${sub}/c/${o.change}` : `${sub}/b/${b.id}/${version}`;
    const url = o.change ? `${root}c/${o.change}/` : `${root}b/${b.id}/${version}/`;
    say(`publishing ${out.files.length} files`);
    const store = await siteStore();
    const { publishSite } = await import('./sitestore.ts');
    const page = (b.target ?? 'web') === 'web' ? await pageInfo(p, sha, ref, o.change, widgetRoot(root)) : undefined;
    const r = await publishSite(store, base, out.files, { page, build: { sha: sha.slice(0, 7), version, build: b.id, at: Date.now() }, progress: say });
    db.prepare("UPDATE builds SET status = 'ready', files = ?, bytes = ?, url = ?, detail = ?, finished = ? WHERE id = ?").run(out.files.length, out.bytes, url, out.detail ?? null, Date.now(), rowId);
    // A project's own build working again verifies the fixers of its failure chain (buildfix.ts); a preview doesn't.
    if (!o.change) { void import('./buildfix.ts').then((m) => m.buildPassed(p.id, b.id)).catch(() => {}); void import('./buildaccess.ts').then((m) => m.clearRetry(p.id, b.id)).catch(() => {}); }
    // Beta moves only forward (2026-10-31 review): to a build of beta's newest commit, asked for or triggered, and never
    // behind a newer version that already finished. Anything else (an old tag, a pull request's workflow, a slower
    // build of an older commit) is published as its version and leaves beta, its mounts and commits alone.
    const newer = db.prepare("SELECT 1 FROM builds WHERE product = ? AND build = ? AND status = 'ready' AND change IS NULL AND version > ? LIMIT 1").get(p.id, b.id, version);
    // A token minted now: the one this build started with can be hours old after a Unity build.
    const ghNow = githubFetch(await repoToken(slug));
    const head = await githubCommit(slug, 'beta', ghNow).catch(() => null);
    // A Firebase deploy of main is the live site going out (deploy.ts deployMain): it never moves beta.
    const movesBeta = !o.change && !newer && !(b.tool === 'firebase' && ref === 'main') && (head ? head === sha : ref === 'beta');
    if (!o.change && !movesBeta) say(`${b.id} ${version} is published at its own address; beta stays (${newer ? 'a newer build is ready' : `${sha.slice(0, 7)} isn't beta's newest commit`})`);
    if (movesBeta && (b.target ?? 'web') === 'web') {
      await setBeta(p.id, b.id, version);
      (await import('./previews.ts')).noteBeta(p.id, { status: 'ready', at: Date.now(), sha: sha.slice(0, 7), ref, files: out.files.length, version: `${b.id} ${version}` });
    }
    if (!o.change) await prune(p, b.id, sub).catch((e) => say(`old builds not pruned: ${e.message}`));
    // Into another project's site too: mounted (its beta site serves it there) and, when asked, committed to its repo.
    const linked: string[] = [];
    stage = 'mount';
    if (b.publish?.page === 'site' && movesBeta) {
      // The site keeps its own page (a game page with its own loader, sound prompt and links): the build stays at its own
      // public address and only a pointer goes into the site, never the build's template index.html over the page.
      const target = getProduct(b.publish.project);
      const publicUrl = `${new URL(root).origin}/builds/${sub}/b/${b.id}/${version}/`;
      // Before anything changes on the site: a build without a loader the page can reach would break its beta.
      assertLoader(out.files, b.id, version);
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
    // Published: its files are no longer needed in memory, and the playtest doesn't hold the slot.
    out.cleanup();
    out = null;
    release();
    stage = 'playtest';
    if (movesBeta && (b.target ?? 'web') === 'web' && b.playtest !== false) await playIt(run, p, b.publish ? getProduct(b.publish.project) : p);
    else if (movesBeta && (b.target ?? 'web') !== 'web' && b.playtest !== false) await playDesktop(run, p, b, url);
    // The owner said to keep going live (golive-policy.ts): what just passed goes live by itself.
    if (!o.change && movesBeta) await (await import('./golive-policy.ts')).autoGoLive(p.id, `build ${b.id} ${version}`);
  } catch (e: any) {
    const why = String(e?.message ?? e).slice(0, 500);
    // In the log too: a customer's Studio is only visible to the platform through its logs (2026-10-31: a refused build
    // left no trace anywhere J or Claude could read).
    console.warn(`[builds] ${p.id} ${b.id} failed: ${why}`);
    // The reason, the class (infrastructure or code), the log Gen kept and every Gen job tried stay on the row; Studio's own
    // retries are over by here, so J is told once (buildfail.ts).
    // Failing before there was a row (no GitHub access, no such branch, a workflow GitHub wouldn't start) used to leave no
    // trace but a step; it is a failed build like any other now, so it shows where builds show.
    if (!rowId && !o.resume && !o.artifact) {
      rowId = newId('b');
      db.prepare('INSERT INTO builds (id, product, build, version, status, sha, ref, runner, target, run, change, started) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(rowId, p.id, b.id, o.change ? -Date.now() : nextVersion(p.id, b.id), 'failed', shaSeen, o.ref ?? 'beta', runnerOf(b), b.target ?? 'web', run, o.change ?? null, Date.now());
    }
    if (rowId) {
      const c = recordFailure(rowId, e, { stage, slug });
      // Transient: retried by itself, quietly. Access: one Inbox card with the fix. Code and the rest: told as before (buildaccess.ts).
      const h = o.change ? { handled: false } : await (await import('./buildaccess.ts')).handleFailure(rowId, { product: p.id, build: b.id, slug, error: why, stage, kind: c.kind, attempt: o.retry, ref: o.ref ?? null, sha: shaSeen, workflow: b.workflow ?? null }).catch((err: any) => { console.warn(`[builds] ${p.id} ${b.id}: handling the failure: ${err?.message ?? err}`); return { handled: false }; });
      updateStep(step, { status: 'failed', detail: why, data: { failure: { class: c.class, kind: c.kind, plain: c.plain, stage, build: rowId, ...((h as any).retry ? { retryIn: Math.round((h as any).retry.inMs / 1000) } : {}) } }, finished: true });
      if (!h.handled) void announce(rowId);
    } else updateStep(step, { status: 'failed', detail: why, finished: true });
  } finally {
    out?.cleanup();
    release();
  }
}

/**
 * Where the widget's endpoints (/dev/__studio/build, report.js, report) live: the project's site root, never the build's
 * own folder (/b/<build>/<n>/). The sites Worker serves /dev/__studio/ only relative to the project's path, so a root
 * inside the build 404'd on the widget's "newer build" check and failed playtests (2026-11-02, package builds).
 */
export function widgetRoot(siteRoot: string) {
  return new URL(siteRoot).pathname.replace(/\/+$/, '');
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

/**
 * firebase: `firebase deploy` of the commit in Studio's Cloud Run job, signed in keylessly as the Firebase project's
 * deployer (firebasebuild.ts); beta deploys the staging project, main the live one. Its output is the build record.
 */
async function viaFirebase(p: Product, b: BuildSpec, slug: string, sha: string, ref: string, token: string | null, gh: typeof fetch, say: (s: string) => void, hold: () => Promise<void> = async () => {}): Promise<Output> {
  const F = await import('./firebasebuild.ts');
  const dir = b.path && b.path !== '.' ? b.path : '';
  const read = async (name: string) => {
    const r = await gh(`https://api.github.com/repos/${slug}/contents/${dir ? `${encodeURI(dir)}/` : ''}${name}?ref=${sha}`, { headers: { 'User-Agent': 'hawkes-studio', Accept: 'application/vnd.github.raw' } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub couldn't read ${slug}'s ${name} (${r.status})`);
    try { return JSON.parse(await r.text()); } catch { throw new Error(`${slug}'s ${name} isn't JSON`); }
  };
  const json = await read('firebase.json');
  if (!json) throw new Error(`${slug} has no firebase.json${dir ? ` in ${dir}` : ''}, so there is nothing to deploy to Firebase`);
  const project = F.projectFor(ref, b.firebase, await read('.firebaserc'));
  if (!project) throw new Error(`no Firebase project for ${ref}: set the build's firebase.${ref === 'main' ? 'live' : 'beta'}, or a "${ref === 'main' ? 'prod' : 'staging'}" alias in .firebaserc`);
  const only = b.firebase?.only ?? F.deployOnly(json);
  if (!only) throw new Error(`${slug}'s firebase.json has nothing firebase deploy knows (hosting, functions, firestore, storage)`);
  const deployer = F.deployerOf(project, b.firebase);
  const { url, health } = F.addressesOf(p as any, ref, project, b.firebase);
  say(`signing in to Firebase ${project} as ${deployer}`);
  const t = await F.deployerToken(deployer);
  const root = `/tmp/build/${p.id}`;
  const command = `${dir ? `cd ${JSON.stringify(dir)} && ` : ''}${F.deployScript({ project, deployer, only, sources: F.functionsOf(json).map((x) => x.source), health, url, ref, sha, name: p.name })}`;
  say(`deploying ${sha.slice(0, 7)} (${ref}) to Firebase ${project}: ${only}`);
  const { runCloudBuild } = await import('./cloudjob.ts');
  const outDir = path.posix.join(dir || '.', 'studio-build');
  const r = await runCloudBuild(`build-${p.id}-${b.id}-${Date.now().toString(36)}`, {
    remote: `https://github.com/${slug}.git`, head: sha, cwd: root, command, outputs: [outDir], gitToken: token,
    secretEnv: { HAWKES_DEPLOY_TOKEN: t.token, HAWKES_DEPLOY_AS: deployer, HAWKES_DEPLOY_PROJECT: project, HAWKES_DEPLOY_EXPIRES: String(t.expires) },
    timeoutMs: 45 * 60_000,
    onLine: (l) => { if (/^\[job\]|error|Deploy complete|health/i.test(l)) say(F.scrub(l, t.token)); }, beforeOutputs: hold,
  });
  const log = F.scrub(r.log, t.token);
  if (r.error || r.code !== 0) {
    const { digestLog } = await import('./buildfail.ts');
    const d = digestLog(log, 'firebase deploy');
    const real = d.errors.length ? d.errors.slice(0, 3).join(' | ') : log.split('\n').filter(Boolean).slice(-3).join(' | ');
    throw new BuildFailure(F.scrub(`firebase deploy to ${project} failed${r.error ? `: ${r.error}` : ` (exit ${r.code})`}${d.step ? `, at ${d.step}` : ''}${real ? `: ${real}` : ''}`, t.token).slice(0, 500), { jobs: [], log: log.split('\n').slice(-LOG_LINES).join('\n') });
  }
  if (!r.outputs) throw new Error('the deploy made no build record (studio-build/)');
  const tmp = tmpDir();
  await untar(r.outputs, tmp);
  const out = await folderOutput(path.join(tmp, outDir), tmp);
  return { ...out, detail: `Firebase ${project} (${only}) at ${url}` };
}

/** npm or static: Studio's Cloud Run job runs the command (or the files are published as they are, with no package.json). */
async function viaStudio(p: Product, b: BuildSpec, slug: string, sha: string, token: string | null, gh: typeof fetch, say: (s: string) => void, hold: () => Promise<void> = async () => {}): Promise<Output> {
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
    await hold();
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
    onLine: (l) => { if (/^\[job\]|error|built in/i.test(l)) say(l); }, beforeOutputs: hold,
  });
  if (r.error || r.code !== 0) {
    // The real error, not the tail (Vite's chunk-size warnings hid DoD's): the first error lines and the failing step, and the
    // whole log kept on the row (fail_log) for "Why did this fail?".
    const { digestLog } = await import('./buildfail.ts');
    const d = digestLog(r.log, command);
    const real = d.errors.length ? d.errors.slice(0, 3).join(' | ') : r.log.split('\n').filter(Boolean).slice(-3).join(' | ');
    const msg = `${command.length > 80 ? `${command.slice(0, 80)}…` : command} failed${r.error ? `: ${r.error}` : ` (exit ${r.code})`}${d.step ? `, at ${d.step}` : ''}${real ? `: ${real}` : ''}`.slice(0, 500);
    throw new BuildFailure(msg, { jobs: [], log: r.log.split('\n').slice(-LOG_LINES).join('\n') });
  }
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
  // Gen's cloud build also says "couldn't fetch <repo> at <sha> (is the commit pushed, and can the GitHub token read the
  // repo?)" when the source fetch failed. Studio only builds commits it read from GitHub, so that is the token (an hour's
  // installation token outlived by a long queue), never the code: sick-of-it-unity v13 (2026-11-03) was called a compile
  // error for it.
  return /token\b[^.]{0,40}?\b(is gone|gone|expired)|token\b[^.]{0,60}?\d+ minutes old|too old to start a build|resubmit it with a fresh token|GitHub refused|can't read the repo|can the GitHub token read the repo|couldn't fetch [^\n]{0,200}? at [0-9a-f]{7,40}\b|Bad credentials|\b401\b/i.test(String(error ?? ''));
}

/**
 * Unity's own failure line: "Unity exited with code N" with N not 0. Gen's job log also says "[Hawkes] Unity exited with code 0"
 * on a build that went fine, which is no compile failure (builds.ts infraLost, buildfail.ts classify). Exported for the tests.
 */
export const UNITY_FAILED = /Unity exited with code (?!0\b)\d+/i;

/**
 * Gen's word that the build died of infrastructure, not of the project: its token gone, or Gen/its worker restarted,
 * lost the job, was preempted or unreachable. Worth a fresh submit; a Unity compile error or a failed script never is.
 * Exported for the tests.
 */
export function infraLost(error: unknown): boolean {
  const e = String(error ?? '');
  if ((/error CS\d+|compil(e|ation) (error|failed)|BuildFailedException|build method .* (failed|threw)|out of memory/i.test(e) || UNITY_FAILED.test(e)) && !tokenLost(e)) return false;
  return tokenLost(e) || /Gen (restarted|was restarted|is restarting)|restarted while|server (restarted|shut ?down)|worker (lost|restarted|was preempted)|preempted|job (was )?(lost|interrupted|orphaned)|interrupted \(|instance (was )?(terminated|stopped)|\b50[234]\b|ECONNRESET|socket hang up/i.test(e);
}

/** How many times a Unity build that Gen lost to infrastructure (token, restart) is submitted again, each with a fresh token. */
export const TOKEN_RETRIES = 3;

/**
 * How Gen asks Studio for a fresh GitHub token for one build (docs/builds.md, "The token Gen asks for"): every submit
 * carries github.refresh = { url, build, key }; Gen POSTs { job, build, key } to url when the job is about to start (or
 * its token is missing or past its hour) and gets { token, repo, commit, expiresAt }. key is an HMAC of the build row
 * under a secret only Studio holds, so it opens that one build's one repo and nothing else.
 */
/**
 * OFF until Hawkes Gen accepts it: Gen's admitCustomer (src/providers/builder/customer.ts) rejects any github key other
 * than repo, commit, token and ref ("customer builds take github { repo, commit, token, ref? } (not refresh)"), so
 * sending github.refresh failed every customer Unity build since #211. The endpoint and genTokenFor stay; turn this on
 * (STUDIO_GEN_REFRESH=1) once Gen has a handler for it.
 */
export const SEND_GITHUB_REFRESH = process.env.STUDIO_GEN_REFRESH === '1';
const refreshSecret = () => process.env.STUDIO_BUILD_KEY || process.env.STUDIO_OWNER_KEY || process.env.HAWKESGEN_KEY || '';
export const refreshKey = (build: string) => crypto.createHmac('sha256', refreshSecret()).update(`gen-github-token|${build}`).digest('hex');
export const refreshUrl = () => `${(process.env.STUDIO_PUBLIC_URL || 'https://studio.hawkesgen.ai').replace(/\/+$/, '')}/api/builds/gen-token`;

/** The fresh token Gen asked for (null: refused, with the reason). Minted now, never taken from what was sent at submit. */
export async function genTokenFor(body: any, mint: (slug: string) => Promise<string | null> = async (slug) => { const T = await import('./ghtoken.ts'); T.forgetRepoToken(slug); return T.repoToken(slug); }): Promise<{ status: number; body: Record<string, unknown> }> {
  const build = String(body?.build ?? '');
  if (!refreshSecret() || !build || !/^[0-9a-f]{64}$/.test(String(body?.key ?? '')) || !crypto.timingSafeEqual(Buffer.from(String(body.key)), Buffer.from(refreshKey(build)))) return { status: 401, body: { error: 'not a build Studio started' } };
  const row = db.prepare('SELECT product, sha, status, gen_job FROM builds WHERE id = ?').get(build) as any;
  if (!row || row.status !== 'building') return { status: 409, body: { error: 'that build is not running here any more' } };
  const job = String(body?.job ?? '');
  if (job && row.gen_job && job !== row.gen_job) return { status: 409, body: { error: `that build now runs as ${row.gen_job}` } };
  const slug = String((getProduct(row.product) as any)?.github ?? '');
  if (!slug) return { status: 404, body: { error: 'the project has no GitHub repo' } };
  const token = await mint(slug);
  if (!token) return { status: 502, body: { error: `Studio has no GitHub access to ${slug}` } };
  db.prepare('UPDATE builds SET token_at = ? WHERE id = ?').run(Date.now(), build);
  return { status: 200, body: { token, repo: slug, commit: row.sha, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() } };
}

/** The github object a Unity build submit carries: repo, commit, token, ref (plus refresh only when SEND_GITHUB_REFRESH). */
export function githubFor(repo: string, commit: string, token: string, ref: string, row?: string, withRefresh = SEND_GITHUB_REFRESH): Record<string, unknown> {
  return { repo, commit, token, ref, ...(withRefresh && row && refreshSecret() ? { refresh: { url: refreshUrl(), build: row, key: refreshKey(row) } } : {}) };
}

/** The only github keys Hawkes Gen's customer builds accept (hawkesgen src/providers/builder/customer.ts admitCustomer). */
export const GEN_GITHUB_KEYS = ['repo', 'commit', 'token', 'ref'] as const;

/**
 * Everything a customer Unity build submit sends Gen (unity.build params), in the one shape admitCustomer takes: github
 * { repo, commit, token, ref } and nothing else under it (never refresh unless SEND_GITHUB_REFRESH), out "artifact".
 * Anything Gen would refuse is refused here first, in plain words, so a bad shape can't ride to Gen and fail in 0 s.
 * Exported for the tests.
 */
export function genBuildParams(b: BuildSpec, slug: string, sha: string, ref: string, token: string, row?: string): Record<string, unknown> {
  const github = githubFor(slug, sha, token, ref, row);
  const extra = Object.keys(github).filter((k) => !(GEN_GITHUB_KEYS as readonly string[]).includes(k));
  if (extra.length) throw new Error(`Studio would send Hawkes Gen github.${extra.join(', github.')}, which customer builds don't take (repo, commit, token, ref): not sent`);
  return { github, ...(b.path ? { path: b.path } : {}), ...(b.method ? { method: b.method } : {}), ...(b.machine ? { machine: b.machine } : {}), target: 'web', out: 'artifact' };
}

/** unity: Hawkes Gen builds that commit in the cloud with the repo's own token, and hands back the output as an asset. */
async function viaGen(p: Product, b: BuildSpec, slug: string, sha: string, ref: string, token: string | null, say: (s: string) => void, resume: { job?: string; row?: string; onSubmit?: (id: string) => void; onDone?: () => void } = {}, hold: () => Promise<void> = async () => {}): Promise<Output> {
  if (!token) throw new Error(`Studio has no GitHub access to ${slug}: connect GitHub and install the app on it`);
  const { genRun, gen } = await import('./gen.ts');
  say('Hawkes Gen is building it (Unity WebGL, in the cloud)');
  const submit = (tok: string, r: typeof resume) => genRun('unity.build', p.id, genBuildParams(b, slug, sha, ref, tok, resume.row), (j) => { if (j?.progress?.step || j?.status) say(`Hawkes Gen: ${j.progress?.step ?? j.status}`); }, 3 * 60 * 60 * 1000, r);
  // Minted now, as late as there is: a token made at the start of the run could be an hour old by the time Gen reads it.
  // Gen also asks Studio for a new one when the job starts (refresh, genTokenFor), so no build rides on this one.
  const { forgetRepoToken, repoToken } = await import('./ghtoken.ts');
  let first = token;
  if (!resume.job) { forgetRepoToken(slug); first = (await repoToken(slug)) ?? token; }
  // Every Gen job this build tried and why each failed, and what Gen kept of the last one (buildfail.ts): the failure keeps them.
  const tried: { id: string; error: string }[] = [];
  const note = (j: any) => { if (j?.status === 'failed' || j?.status === 'cancelled') tried.push({ id: String(j.id ?? ''), error: String(j.error ?? 'no reason given').slice(0, 300) }); };
  let job: any = await submit(first, { job: resume.job, onSubmit: resume.onSubmit });
  note(job);
  // A Gen that restarted (Cloud Run scales it to zero) or lost the token is infrastructure, not the project: the same
  // build is submitted again with a freshly minted token, up to TOKEN_RETRIES times, and the run says so (sick-of-it-unity
  // v3 to v7 failed on it). Each resubmit is a new Gen job, recorded on the row. A Unity compile error is never retried,
  // and a real access problem fails every time and ends here.
  for (let n = 1; job.status === 'failed' && infraLost(job.error) && n <= TOKEN_RETRIES; n++) {
    forgetRepoToken(slug);
    const fresh = await repoToken(slug);
    if (!fresh) break;
    say(`Hawkes Gen lost this build (${String(job.error).slice(0, 120)}): Studio is building it again by itself with a fresh GitHub token (try ${n + 1} of ${TOKEN_RETRIES + 1})`);
    job = await submit(fresh, { row: resume.row, onSubmit: resume.onSubmit });
    note(job);
  }
  if (job.status !== 'done') throw new BuildFailure(`the Unity build ${job.status}: ${job.error ?? 'no reason given'}`, { jobs: tried, log: extractLog(job) });
  resume.onDone?.();
  const asset = job.result?.artifact?.asset;
  if (!asset) throw new Error('Hawkes Gen finished without the build output');
  await hold();
  say('downloading the build');
  const tmp = tmpDir();
  // Streamed from Gen straight into tar (2026-11-01): a Unity build with its Addressables content is hundreds of MB, and
  // holding it in memory (arrayBuffer, a Buffer copy, spawnSync's input) on top of the unpacked files (Cloud Run's disk
  // is memory too) went over a customer's Studio's 2 GiB, which restarted it mid-build until the run was stopped.
  await untarStream(await gen.request(`/files/${asset}`, { raw: true }), tmp);
  const learned = learnMachine(p.id, b, job.result);
  if (learned) say(learned);
  const ran = job.result?.machine?.name ? `on ${job.result.machine.name} (${job.result.machine.cpu} vCPU, ${job.result.machine.memoryGiB} GiB)` : '';
  const detail = [job.result?.unity ? `Unity ${job.result.unity}` : '', ran, learned ?? ''].filter(Boolean).join('; ');
  // A site with its own game page loads the build's own folder (PlaceDepartment/Build/...): never unwrap it.
  return { ...(await folderOutput(tmp, tmp, b.publish?.page === 'site')), detail: detail || undefined };
}

/**
 * Hawkes Gen built it a size up after it ran out of memory (result.retried, result.machine: hawkesgen docs/unity-cloudrun.md,
 * "Machine sizes"): that size becomes the build's own (config.ts setBuildMachine), so the next build starts there instead
 * of running out of memory first. The line for the build's history, or null when nothing changed. Exported for the tests.
 */
export function learnMachine(productId: string, b: BuildSpec, result: any): string | null {
  const ran = result?.machine;
  const from = result?.retried?.from;
  if (!result?.ok || !result?.retried || !ran?.name) return null;
  // A size Gen names (s, m, l, xl) is saved by name; numbers it made up (4c12g) as { cpu, memoryGiB }.
  const keep: BuildMachine = /^\d+c\d+g$/.test(String(ran.name)) ? { cpu: Number(ran.cpu), memoryGiB: Number(ran.memoryGiB) } : String(ran.name);
  let where: string;
  try { where = setBuildMachine(productId, b.id, keep); } catch (e: any) { return `ran on ${ran.name} after ${from} ran out of memory; couldn't save ${ran.name} as this build's size (${String(e?.message ?? e).slice(0, 120)})`; }
  return where === 'none'
    ? `ran on ${ran.name} after ${from} ran out of memory`
    : `ran on ${ran.name} after ${from} ran out of memory; saved ${ran.name} as this build's size`;
}

/** actions: the workflow run's artifact (its contents are the build: index.html at the root for the web). */
async function viaActions(b: BuildSpec, slug: string, a: { runId: string; name?: string }, gh: typeof fetch, say: (s: string) => void, hold: () => Promise<void> = async () => {}): Promise<Output> {
  const name = a.name ?? b.artifact ?? b.id;
  say(`downloading artifact ${name} of run ${a.runId}`);
  const list = await gh(`https://api.github.com/repos/${slug}/actions/runs/${encodeURIComponent(a.runId)}/artifacts?per_page=100`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hawkes-studio' } });
  if (!list.ok) throw new Error(`GitHub: the run's artifacts: ${list.status}`);
  const art = ((await list.json()) as any).artifacts?.find((x: any) => x.name === name && !x.expired);
  if (!art) throw new Error(`run ${a.runId} has no artifact named ${name} (upload it with actions/upload-artifact under that name)`);
  await hold();
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

export async function folderOutput(dir: string, tmp: string, keepFolder = false): Promise<Output> {
  if (!fs.existsSync(dir)) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error('the build made no output'); }
  // An output that is one folder (an artifact zipped around its folder): its contents are the site.
  const entries = fs.readdirSync(dir);
  const root = !keepFolder && entries.length === 1 && fs.statSync(path.join(dir, entries[0])).isDirectory() && !fs.existsSync(path.join(dir, 'index.html')) ? path.join(dir, entries[0]) : dir;
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

/**
 * publish.page "site": the published files must hold a Unity loader the site's page can reach, <dir>/Build/<name>.loader.js
 * (the build's own folder, kept by folderOutput) or Build/<name>.loader.js. Else the pointer would send the page to a 404
 * (2026-11-02: The Place Department's live Game/ pointed at web 5, published without PlaceDepartment/). Exported for tests.
 */
export function assertLoader(files: { path: string }[], build: string, version: number) {
  if (files.some((f) => /^(?:[^/]+\/)?Build\/[^/]+\.loader\.js$/.test(f.path))) return;
  throw new Error(`build ${build} ${version} has no Unity loader (<folder>/Build/*.loader.js) in its published files, so the site's page would 404; its beta was left pointing at the earlier build`);
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

/**
 * A desktop build's playtest job, with the pipeline's limits (playtests.ts runGenJob): the scenario's run time once it
 * starts, PLAYTEST_IDLE_MS without progress is stuck (cancelled, failed "stuck: ..."), and at most 45 min in Gen's queue
 * (the whole wait used to be). Priority 0, as a daily play: behind agents' verify plays and the go-live smoke. The
 * build is downloaded from its public address, not a page this run serves, so the same play another caller queued is
 * joined (share). api, pollMs: tests' stand-ins.
 */
export async function playDesktopJob(project: string, params: Record<string, unknown>, onUpdate: (job: any) => void = () => {}, { api, pollMs }: { api?: any; pollMs?: number } = {}) {
  const { runGenJob, playtestRunMs, PLAYTEST_IDLE_MS } = await import('./playtests.ts');
  return runGenJob('playtest.run', project, params, onUpdate, { runMs: playtestRunMs({ where: 'local' }), queueMs: 45 * 60_000, idleMs: PLAYTEST_IDLE_MS(), priority: 0, share: true, ...(api ? { api } : {}), ...(pollMs ? { pollMs } : {}) });
}

/** A desktop build plays on Hawkes Gen's playtesters (windows, linux, proton), downloaded from its own address. */
async function playDesktop(run: string, p: Product, b: BuildSpec, url: string) {
  const { startStep, updateStep } = await import('./pipeline.ts');
  const step = startStep(run, p.id, 'playtest', `${b.id}@${b.target}`, 'on a Hawkes Gen playtester');
  try {
    const { withPass } = await import('./sitekeys.ts');
    const job: any = await playDesktopJob(p.id, { build: { url: `${url}${b.target}.zip` }, target: b.target === 'linux' ? 'linux' : 'windows', scenario: p.contract ? 'smoke' : undefined, ...withPass() },
      (j) => updateStep(step, { job: j.id, detail: j.detail }));
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
/** POST /api/builds/gen-token (open to the gate: the build's own HMAC key is the check): Gen asking for a fresh GitHub token. */
export async function handleGenToken(req: http.IncomingMessage, res: http.ServerResponse, readJson: (r: http.IncomingMessage) => Promise<any>) {
  const r = await genTokenFor(await readJson(req).catch(() => ({})));
  res.writeHead(r.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(r.body));
}

export async function handleBuildRoutes(req: http.IncomingMessage, res: http.ServerResponse, route: string, method: string, readJson: (r: http.IncomingMessage) => Promise<any>) {
  const m = /^\/api\/(?:projects|games)\/([a-z][a-z0-9-]{1,39})\/builds(?:\/([a-z0-9-]+)\/(\d+)\/beta|\/(b_[0-9a-f]+)\/why)?$/.exec(route);
  if (!m) return false;
  const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const p = getProduct(m[1]);
  // "Why did this fail?": the whole record of one build, with the log Gen kept (buildfail.ts).
  if (m[4]) {
    if (method !== 'GET') return send(405, { error: 'GET' }), true;
    const w = (await import('./buildfail.ts')).whyFailed(m[4]);
    return w && w.product === p.id ? send(200, w) : send(404, { error: `No build ${m[4]} in ${p.id}` }), true;
  }
  if (!m[2] && method === 'GET') {
    const { previewUrl } = await import('./previews.ts');
    const F = await import('./buildfail.ts');
    // The history carries each failure's class, kind and plain words (not its log: that is /builds/<id>/why).
    const history = buildHistory(p.id).map(({ fail_log: _log, ...h }: any) => ({ ...h, ...(h.status === 'failed' ? { failure: F.failureOf({ ...h, fail_log: _log }) } : {}) }));
    return send(200, { project: p.id, builds: buildsOf(p), beta: previewUrl(p.id), history, failing: F.failingBuilds(p.id), running: F.buildsRunning(p.id), done: F.buildsDone(p.id) }), true;
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
