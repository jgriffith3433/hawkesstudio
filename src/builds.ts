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
import { getProduct, loadProducts, StudioError, type BuildSpec, type Product } from './config.ts';
import { folderFiles } from './sitestore.ts';

db.exec(`CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY, product TEXT NOT NULL, build TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
  sha TEXT, ref TEXT, runner TEXT NOT NULL, target TEXT NOT NULL, files INTEGER, bytes INTEGER, url TEXT, run TEXT,
  change TEXT, detail TEXT, started INTEGER NOT NULL, finished INTEGER
)`);
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS builds_version ON builds (product, build, version)'); } catch { /* there */ }

export type BuildRow = { id: string; product: string; build: string; version: number; status: 'building' | 'ready' | 'failed'; sha: string | null; ref: string | null; runner: string; target: string; files: number | null; bytes: number | null; url: string | null; run: string | null; change: string | null; detail: string | null; started: number; finished: number | null };
export type BuildTrigger = 'beta' | 'tag';
export type StartOptions = {
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
  return (p.engine as string) === 'web' && (p as any).github ? [{ id: 'web', tool: 'npm', target: 'web' }] : [];
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

/** How many versions of each build stay published (J, 2026-10-31: keep it cheap); beta's and mounted ones always stay. */
export const BUILDS_KEEP = Math.max(1, Number(process.env.STUDIO_BUILDS_KEEP) || 5);

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
  for (const r of rows.slice(BUILDS_KEEP)) {
    const base = `${sub}/b/${build}/${r.version}`;
    if ((beta?.build === build && beta?.version === r.version) || mounted.has(base)) continue;
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
    // An Actions build Studio was only asked for: start the workflow; it reports when it's built (a run of its own).
    if (b.tool === 'actions' && !o.artifact) {
      if (!b.workflow) throw new Error(`build ${b.id} runs in ${slug}'s own GitHub Actions: it starts from its workflow's own triggers (set "workflow" so Studio can start it)`);
      say(`starting ${b.workflow} on ${ref}`);
      const r = await gh(`https://api.github.com/repos/${slug}/actions/workflows/${encodeURIComponent(b.workflow)}/dispatches`, { method: 'POST', headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'hawkes-studio' }, body: JSON.stringify({ ref }) });
      if (!r.ok) throw new Error(`GitHub wouldn't start ${b.workflow}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      updateStep(step, { status: 'done', detail: `started ${b.workflow} on ${ref}: its build reports back when it's done (a run of its own)`, finished: true });
      return;
    }
    const version = o.change ? 0 : nextVersion(p.id, b.id);
    rowId = newId('b');
    db.prepare('INSERT INTO builds (id, product, build, version, status, sha, ref, runner, target, run, change, started) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(rowId, p.id, b.id, version || -Date.now(), 'building', sha, ref, runnerOf(b), b.target ?? 'web', run, o.change ?? null, Date.now());
    say(`${sha.slice(0, 7)} (${ref})`);
    out = b.tool === 'unity' ? await viaGen(p, b, slug, sha, ref, token, say)
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
    if (!o.change && (b.target ?? 'web') === 'web') {
      await setBeta(p.id, b.id, version);
      (await import('./previews.ts')).noteBeta(p.id, { status: 'ready', at: Date.now(), sha: sha.slice(0, 7), ref, files: out.files.length, version: `${b.id} ${version}` });
    }
    if (!o.change) await prune(p, b.id, sub).catch((e) => say(`old builds not pruned: ${e.message}`));
    // Into another project's site too: mounted (its beta site serves it there) and, when asked, committed to its repo.
    const linked: string[] = [];
    if (b.publish && !o.change) {
      const target = getProduct(b.publish.project);
      await mount(target, b.publish.path, base);
      linked.push(`${target.name} ${b.publish.path || '/'}`);
      if (b.publish.commit) linked.push(await commitInto(target, b.publish.path, out.files, `Build ${b.id} ${version} of ${p.name} (${sha.slice(0, 7)})`, say));
    }
    updateStep(step, { status: 'done', detail: `${b.id} ${version || o.change}: ${out.files.length} files, ${Math.round(out.bytes / 1e5) / 10} MB${linked.length ? `; also in ${linked.join(', ')}` : ''}`, data: { url, version, sha, sent: r.sent }, finished: true });
    if (!o.change && (b.target ?? 'web') === 'web' && b.playtest !== false) await playIt(run, p, b.publish ? getProduct(b.publish.project) : p);
    else if (!o.change && (b.target ?? 'web') !== 'web' && b.playtest !== false) await playDesktop(run, p, b, url);
  } catch (e: any) {
    const why = String(e?.message ?? e).slice(0, 500);
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
  const hasPkg = b.tool === 'npm' && (await gh(`https://api.github.com/repos/${slug}/contents/${dir ? `${encodeURI(dir)}/` : ''}package.json?ref=${sha}`, { method: 'HEAD', headers: { 'User-Agent': 'hawkes-studio' } })).ok;
  if (b.tool === 'static' || !hasPkg) {
    const from = [dir, b.tool === 'static' && b.out ? b.out : ''].filter(Boolean).join('/');
    say(`${b.tool === 'npm' ? 'no package.json: ' : ''}publishing ${from || 'the repo'} as it is`);
    const files = await githubFiles(slug, sha, { sub: from, fetcher: gh });
    return { files, bytes: sizeOf(files), cleanup: () => {} };
  }
  const { runCloudBuild } = await import('./cloudjob.ts');
  const cd = dir ? `cd '${dir.replace(/'/g, '')}' && ` : '';
  const install = 'if [ -f package-lock.json ]; then npm ci --no-audit --no-fund --loglevel=error; else npm install --no-audit --no-fund --loglevel=error; fi';
  const outDir = path.posix.join(dir || '.', b.out ?? 'dist');
  const command = b.command ?? 'npm run build';
  say(`building ${sha.slice(0, 7)} in a Cloud Run job (${command})`);
  const r = await runCloudBuild(`build-${p.id}-${b.id}-${Date.now().toString(36)}`, {
    remote: `https://github.com/${slug}.git`, head: sha, cwd: `/tmp/build/${p.id}`, command: `${cd}(${install}) && ${command}`, outputs: [outDir], gitToken: token,
    onLine: (l) => { if (/^\[job\]|error|built in/i.test(l)) say(l); },
  });
  const tail = r.log.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400);
  if (r.error || r.code !== 0) throw new Error(`${command} failed${r.error ? `: ${r.error}` : ` (exit ${r.code})`}${tail ? `: ${tail}` : ''}`);
  if (!r.outputs) throw new Error(`the build made no ${outDir}/`);
  const tmp = tmpDir();
  untar(r.outputs, tmp);
  return folderOutput(path.join(tmp, outDir), tmp);
}

/** unity: Hawkes Gen builds that commit in the cloud with the repo's own token, and hands back the output as an asset. */
async function viaGen(p: Product, b: BuildSpec, slug: string, sha: string, ref: string, token: string | null, say: (s: string) => void): Promise<Output> {
  if (!token) throw new Error(`Studio has no GitHub access to ${slug}: connect GitHub and install the app on it`);
  const { genRun, gen } = await import('./gen.ts');
  say('Hawkes Gen is building it (Unity WebGL, in the cloud)');
  const job: any = await genRun('unity.build', p.id, {
    github: { repo: slug, commit: sha, token, ref }, ...(b.path ? { path: b.path } : {}), ...(b.method ? { method: b.method } : {}), target: 'web', out: 'artifact',
  }, (j) => { if (j?.progress?.step || j?.status) say(`Hawkes Gen: ${j.progress?.step ?? j.status}`); }, 3 * 60 * 60 * 1000);
  if (job.status !== 'done') throw new Error(`the Unity build ${job.status}: ${job.error ?? 'no reason given'}`);
  const asset = job.result?.artifact?.asset;
  if (!asset) throw new Error('Hawkes Gen finished without the build output');
  say('downloading the build');
  const tmp = tmpDir();
  untar(Buffer.from(await gen.bytes(asset)), tmp);
  return { ...folderOutput(tmp, tmp), detail: job.result?.unity ? `Unity ${job.result.unity}` : undefined };
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
  return folderOutput(tmp, tmp);
}

function folderOutput(dir: string, tmp: string): Output {
  if (!fs.existsSync(dir)) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error('the build made no output'); }
  // An output that is one folder (an artifact zipped around its folder): its contents are the site.
  const entries = fs.readdirSync(dir);
  const root = entries.length === 1 && fs.statSync(path.join(dir, entries[0])).isDirectory() && !fs.existsSync(path.join(dir, 'index.html')) ? path.join(dir, entries[0]) : dir;
  const files = folderFiles(root);
  if (!files.length) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error('the build output is empty'); }
  return { files, bytes: sizeOf(files), cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

function untar(data: Buffer, dir: string) {
  const x = spawnSync('tar', ['-xzf', '-'], { cwd: dir, input: data, maxBuffer: 64 * 1024 * 1024 });
  if (x.status !== 0) throw new Error(`unpacking the build: ${String(x.stderr).trim().slice(0, 300)}`);
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
async function commitInto(target: Product, at: string, files: import('./sitestore.ts').SiteFile[], message: string, say: (s: string) => void) {
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
  return `${slug} beta (${c.sha.slice(0, 7)})`;
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
    const job: any = await genRun('playtest.run', p.id, { build: { url: `${url}${b.target}.zip`, target: b.target === 'linux' ? 'linux' : 'windows' }, scenario: p.contract ? 'smoke' : undefined, ...withPass() }, undefined, 45 * 60 * 1000);
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
  const projects = projectsForRepo(String(claims.repository ?? ''));
  if (!projects.length) return null;
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
