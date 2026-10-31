// The survey (J, 2026-10-31: "customer first ... smart enough to know how to deal with different customers' projects
// and know how to serve them and connect them ... see what exists, what could be improved and how projects can fit onto
// studio (CI workflows, small changes that go a long way)"). Studio reads a repository through GitHub's API (its file
// list and the few files that say how it's made: no clone) and says what it is, how it's built and hosted today, how it
// connects to other projects, and what would make it fit Studio, each with why and who does it. Talk runs it on every
// project a person brings, before asking them anything a repo can answer.
//
// analyze() is pure (a file list and file contents in, findings out) so every rule is tested without GitHub;
// survey() fetches. Never needs write access; nothing is changed.

import { gh, repoSlug } from './github-app.ts';
import { StudioError } from './config.ts';
import { hookPointsAt, studioAddress } from './handover.ts';

export type Level = 'blocker' | 'improve' | 'info';
/** Who acts on a note: Talk itself (a project setting), an agent (a change in the repo, a pull request into beta), the person. */
export type By = 'talk' | 'agent' | 'person';
export type Note = { level: Level; what: string; why: string; fix: string; by: By; files?: string[] };
export type Part =
  | { kind: 'unity'; path: string; unity: string | null; packages: number }
  | { kind: 'web'; path: string; framework: string | null; build: string | null; out: string | null }
  | { kind: 'static'; path: string }
  | { kind: 'godot'; path: string };
export type Survey = {
  repo: string; ref: string; parts: Part[];
  hosting: { domain: string | null; pages: 'workflow' | 'branch' | null; unityBuildIn: string | null };
  ci: { file: string; on: string[]; does: string[] }[];
  studio: { hook: 'here' | 'elsewhere' | 'missing'; contract: boolean };
  /** Studio project settings that fit what was found (Talk saves them with studio_project add/update). */
  suggest: { engine: string | null; builds: Record<string, unknown>[]; live: string | null };
  notes: Note[];
  truncated: boolean;
};

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.');
const joinPath = (a: string, b: string) => (a === '.' ? b : `${a}/${b}`);

/** The files whose contents the rules read, given the file list (bounded: a big repo costs a few requests, not hundreds). */
export function wanted(paths: string[]): string[] {
  const pick: string[] = [];
  const add = (p: string | undefined) => { if (p && !pick.includes(p)) pick.push(p); };
  for (const p of paths.filter((x) => x.endsWith('ProjectSettings/ProjectVersion.txt')).slice(0, 4)) {
    const root = dirOf(dirOf(p));
    add(p);
    add(paths.find((x) => x === joinPath(root, 'Packages/manifest.json')));
  }
  for (const p of paths.filter((x) => /(^|\/)package\.json$/.test(x) && !x.includes('node_modules/')).sort((a, b) => a.split('/').length - b.split('/').length).slice(0, 4)) add(p);
  for (const p of paths.filter((x) => /(^|\/)index\.html$/.test(x) && !/node_modules\/|(^|\/)(Build|TemplateData|dist|build)\//.test(x)).sort((a, b) => a.split('/').length - b.split('/').length).slice(0, 3)) add(p);
  for (const p of paths.filter((x) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(x)).slice(0, 10)) add(p);
  for (const name of ['CNAME', '.gitattributes']) add(paths.find((x) => x === name));
  for (const p of paths.filter((x) => /(^|\/)project\.godot$/.test(x)).slice(0, 2)) add(p);
  for (const p of paths.filter((x) => /(^|\/)vite\.config\.(js|ts|mjs|mts)$/.test(x) && !x.includes('node_modules/')).slice(0, 2)) add(p);
  return pick;
}

/** The findings from a repository's file list and the wanted files' contents. `studioUrl`: this Studio's address. */
export function analyze(repo: string, ref: string, paths: string[], files: Record<string, string>, o: { truncated?: boolean; studioUrl?: string; unityVersions?: string[] } = {}): Survey {
  const notes: Note[] = [];
  const parts: Part[] = [];
  const builds: Record<string, unknown>[] = [];
  const has = (p: string) => paths.includes(p);
  const studioUrl = (o.studioUrl ?? '').replace(/\/+$/, '');

  // Unity projects: ProjectSettings/ProjectVersion.txt marks each one's folder.
  for (const pv of paths.filter((x) => x.endsWith('ProjectSettings/ProjectVersion.txt'))) {
    const root = dirOf(dirOf(pv));
    const unity = /m_EditorVersion:\s*(\S+)/.exec(files[pv] ?? '')?.[1] ?? null;
    let manifest: any = null;
    const mf = joinPath(root, 'Packages/manifest.json');
    try { manifest = files[mf] ? JSON.parse(files[mf]) : null; } catch { notes.push({ level: 'info', what: `${mf} isn't valid JSON`, why: 'Unity reads it to resolve packages', fix: 'Fix the JSON in the editor (Unity rewrites it)', by: 'agent', files: [mf] }); }
    const deps = Object.entries((manifest?.dependencies ?? {}) as Record<string, string>);
    parts.push({ kind: 'unity', path: root, unity, packages: deps.length });
    // Packages from a folder on someone's computer: the cloud build (and anyone else's clone) can't read them.
    const local = deps.filter(([, v]) => typeof v === 'string' && /^file:/.test(v) && (/^file:([A-Za-z]:[\\/]|\/|~)/.test(v) || !inRepo(root, v.slice(5), paths)));
    if (local.length) notes.push({
      level: 'blocker', what: `${local.length} Unity package${local.length > 1 ? 's' : ''} in ${root} point${local.length > 1 ? '' : 's'} at a folder outside the repository (${local.map(([k, v]) => `${k} → ${v.slice(5, 60)}`).join(', ')})`,
      why: 'A cloud build (and any fresh clone) has only the repository, so Unity fails to resolve them and the build stops',
      fix: "Point each at its git URL with a version tag (com.x: \"https://github.com/owner/repo.git?path=/Packages/com.x#v1.2.3\"), or copy the package into the project's Packages/ folder; Studio's plugins also install them this way",
      by: 'agent', files: [mf],
    });
    if (unity && o.unityVersions?.length && !o.unityVersions.includes(unity)) notes.push({ level: 'blocker', what: `${root} uses Unity ${unity}; Hawkes Gen's cloud builds have ${o.unityVersions.join(', ')}`, why: 'A cloud build runs the exact editor version the project was saved with', fix: `Upgrade the project to ${o.unityVersions[0]} in the editor (a branch first), or build it in your own GitHub Actions with GameCI (the builds skill's template)`, by: 'person' });
    builds.push({ id: parts.filter((x) => x.kind === 'unity').length > 1 ? `web-${root.split('/').pop()!.toLowerCase().replace(/[^a-z0-9-]/g, '-')}` : 'web', tool: 'unity', path: root, target: 'web', on: ['tag'] });
  }

  // Web projects: a package.json with a build script (not a Unity package's), else static HTML.
  for (const pj of Object.keys(files).filter((x) => /(^|\/)package\.json$/.test(x))) {
    let j: any; try { j = JSON.parse(files[pj]); } catch { continue; }
    const root = dirOf(pj);
    if (parts.some((x) => x.kind === 'unity' && (root === x.path || root.startsWith(`${x.path}/`)))) continue;
    if (j.unity || /^com\./.test(String(j.name ?? ''))) continue;
    const deps = { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) };
    const framework = ['next', 'nuxt', 'astro', '@sveltejs/kit', 'vite', 'phaser', '@babylonjs/core', 'babylonjs', 'three', 'react-scripts', 'parcel'].find((d) => deps[d]) ?? null;
    const build = j.scripts?.build ? 'npm run build' : null;
    // Tools installed but nothing to build (a dev server for a static site, say): it ships as it is, so it's static.
    if (!build) continue;
    const out = framework === 'next' ? 'out' : framework === 'react-scripts' ? 'build' : build ? 'dist' : null;
    parts.push({ kind: 'web', path: root, framework, build, out });
    if (build) builds.push({ id: 'site', tool: 'npm', path: root === '.' ? undefined : root, command: 'npm ci && npm run build', out: joinPath(root, out ?? 'dist'), on: ['beta'] });
    const vite = Object.keys(files).find((f) => /vite\.config\./.test(f) && dirOf(f) === root);
    if (framework === 'vite' || vite) {
      const base = /base\s*:\s*['"`]([^'"`]*)['"`]/.exec(vite ? files[vite] : '')?.[1];
      if (base === undefined || base === '/') notes.push({ level: 'improve', what: `${vite ?? 'Vite'} builds with base "/" (the default)`, why: 'The built pages ask for /assets/... at the root of the site, so they only work at a domain root; under a path (GitHub Pages project sites, Studio previews of a change) they come up blank', fix: "Set base: './' in vite.config so the build uses relative paths and works anywhere", by: 'agent', files: vite ? [vite] : [pj] });
    }
    if (framework === 'next' && !/output\s*:\s*['"]export['"]/.test(Object.entries(files).find(([f]) => /next\.config/.test(f))?.[1] ?? '')) notes.push({ level: 'info', what: 'A Next.js app', why: 'Studio publishes static files; a Next.js app needs output: "export" for that, or its own server (a web app project, kind "app")', fix: 'Ask whether it has server routes; static: add output: "export"; a server: add it as an app with its beta and live addresses', by: 'talk' });
  }
  const htmls = Object.keys(files).filter((f) => /(^|\/)index\.html$/.test(f));
  if (!parts.some((x) => x.kind === 'web') && htmls.length) {
    const root = dirOf(htmls.sort((a, b) => a.split('/').length - b.split('/').length)[0]);
    parts.push({ kind: 'static', path: root });
    builds.push({ id: 'site', tool: 'static', ...(root !== '.' ? { path: root } : {}), on: ['beta'] });
  }
  for (const gd of paths.filter((x) => /(^|\/)project\.godot$/.test(x))) parts.push({ kind: 'godot', path: dirOf(gd) });
  if (parts.some((x) => x.kind === 'godot')) notes.push({ level: 'info', what: 'A Godot project', why: "Studio builds Godot in the project's own GitHub Actions (export templates in CI), then publishes the web export", fix: "Add the builds skill's godot-web workflow and a build { tool: 'actions' }", by: 'agent' });

  // Root-absolute links in pages: fine at a domain root, broken under a path.
  for (const h of htmls) {
    const abs = [...(files[h] ?? '').matchAll(/\s(?:src|href)\s*=\s*["']\/(?!\/)([^"'#?]*)/g)].map((m) => `/${m[1]}`).filter((u) => u !== '/');
    if (abs.length >= 2) notes.push({ level: 'improve', what: `${h} links its files from the site root (${[...new Set(abs)].slice(0, 4).join(', ')}${abs.length > 4 ? ', …' : ''})`, why: "Root paths only work when the site is at a domain's root: on GitHub Pages without a custom domain, and inside a change's preview, styles, scripts and links go missing. Studio's beta site covers for it, but the site itself stays fragile", fix: 'Make them relative (css/site.css, Game/) so the site works at any address', by: 'agent', files: [h] });
  }

  // A website serving a Unity WebGL build (Build/*.loader.js under some folder, or a page that starts one with
  // createUnityInstance while the build itself is stored elsewhere): where a Unity project's build goes.
  const loader = paths.find((x) => /(^|\/)Build\/[^/]+\.loader\.js$/.test(x));
  const player = htmls.find((h) => h !== 'index.html' && /createUnityInstance|\.loader\.js/.test(files[h] ?? ''));
  let unityBuildIn: string | null = null;
  if (loader || player) {
    const buildDir = loader ? dirOf(dirOf(loader)) : dirOf(player!);
    unityBuildIn = (/^(.*?)(\/v\d+)?$/.exec(buildDir)?.[1] ?? buildDir) || '.';
    notes.push({ level: 'info', what: `It serves a Unity WebGL build from ${unityBuildIn === '.' ? 'its root' : `${unityBuildIn}/`}`, why: "A Unity project's builds can go straight into this site: Studio commits or mounts each build there, and the site's beta plays the newest", fix: `In the Unity project's build, set publish { project: <this project's id>, path: "${unityBuildIn === '.' ? '' : `${unityBuildIn}/`}" }`, by: 'talk' });
  }

  // CI that exists: what it does today, so Studio fits around it instead of replacing it.
  const ci: Survey['ci'] = [];
  let pages: 'workflow' | 'branch' | null = null;
  let hook: Survey['studio']['hook'] = 'missing';
  for (const f of Object.keys(files).filter((x) => x.startsWith('.github/workflows/'))) {
    const y = files[f];
    const on = [...new Set([...y.matchAll(/^\s{0,4}(push|pull_request|release|schedule|workflow_dispatch|tags|branches)\s*:/gm)].map((m) => m[1]))];
    const does: string[] = [];
    if (/game-ci\/unity-builder|unity-builder@/.test(y)) does.push('builds Unity (GameCI)');
    if (/actions\/deploy-pages|peaceiris\/actions-gh-pages|JamesIves\/github-pages-deploy/.test(y)) { does.push('deploys GitHub Pages'); pages = 'workflow'; }
    if (/npm (ci|install)|pnpm|yarn/.test(y) && /run build|build\b/.test(y)) does.push('builds with npm');
    if (/npm test|vitest|jest|pytest|dotnet test|Unity.*-runTests/i.test(y)) does.push('runs tests');
    if (/api\/hooks\/github/.test(y)) { does.push("tells a Hawkes Studio about pushes"); hook = hookPointsAt(y, studioUrl || undefined).ok ? 'here' : 'elsewhere'; }
    if (/upload-artifact/.test(y)) does.push('keeps an artifact');
    ci.push({ file: f, on, does });
  }
  if (!pages && has('CNAME') && !ci.some((c) => c.does.includes('deploys GitHub Pages'))) pages = 'branch';
  if (hook === 'missing') notes.push({ level: 'improve', what: "Studio doesn't hear about this repo's pushes", why: 'With the push hook, every push to beta rebuilds its beta site and playtests it, and going live is a push to main', fix: 'studio_project setup puts an Approve card up that adds .github/workflows/hawkes-studio.yml (one small file, no secrets)', by: 'talk' });
  if (hook === 'elsewhere') notes.push({ level: 'improve', what: 'Its push hook tells a different Hawkes Studio', why: 'Pushes go there, so this Studio never hears about them', fix: 'studio_project setup repoints it here (an Approve card)', by: 'talk' });
  if (!ci.some((c) => c.does.includes('runs tests')) && parts.some((x) => x.kind === 'web' && x.build)) notes.push({ level: 'improve', what: 'No CI runs its checks', why: "Agents' changes and people's pushes reach beta without anything checking them first", fix: "Set checks on the project (what an agent's change must pass, e.g. npm ci && npm run build) and, if they want it on every push, a small CI workflow", by: 'talk' });

  // Playtest contract and LFS.
  const contract = paths.some((x) => /hawkes-playtest\.(js|mjs|ts)$|com\.hawkes\.playtest/.test(x)) || Object.values(files).some((t) => /hawkesPlaytest|com\.hawkes\.playtest/.test(t));
  if (!contract && parts.length) notes.push({ level: 'improve', what: "It doesn't speak Studio's playtest contract yet", why: 'Without it a playtest can only load the page and look; with it, a bot plays through real input and every change is checked by playing it', fix: "Install the Playtest bot plugin (studio_plugins) and have an agent add a smoke scenario (studio_project contract)", by: 'agent' });
  if (/filter=lfs/.test(files['.gitattributes'] ?? '')) notes.push({ level: 'info', what: 'It keeps large files in Git LFS', why: 'Builds fetch LFS files too, which takes longer and counts against GitHub\'s LFS bandwidth', fix: 'Nothing to do; a very large LFS store may slow the first build', by: 'person' });

  const domain = (files.CNAME ?? '').trim().split(/\s+/)[0] || null;
  if (o.truncated) notes.push({ level: 'info', what: 'The repository is too big for one file list', why: 'GitHub cut the list short, so some parts may be missing from this survey', fix: 'Ask where the project folders are if something looks missing', by: 'talk' });
  const engine = parts.find((x) => x.kind === 'unity') ? 'unity' : parts.find((x) => x.kind === 'godot') ? 'godot' : parts.length ? 'web' : null;
  if (!parts.length) notes.push({ level: 'info', what: "Studio couldn't tell what this repository makes", why: 'No Unity, Godot, web app or HTML pages were found', fix: 'Ask what it is and how it is built; set builds by hand (the builds skill)', by: 'talk' });
  const order: Record<Level, number> = { blocker: 0, improve: 1, info: 2 };
  notes.sort((a, b) => order[a.level] - order[b.level]);
  return {
    repo, ref, parts, hosting: { domain, pages, unityBuildIn }, ci, studio: { hook, contract },
    suggest: { engine, builds, live: domain ? `https://${domain}/` : null }, notes, truncated: Boolean(o.truncated),
  };
}

/** Whether a relative file: package path from a Unity project resolves inside the repository. */
function inRepo(root: string, rel: string, paths: string[]) {
  const parts = joinPath(joinPath(root, 'Packages'), rel).split('/');
  const out: string[] = [];
  for (const p of parts) { if (p === '..') { if (!out.length) return false; out.pop(); } else if (p && p !== '.') out.push(p); }
  const dir = out.join('/');
  return paths.some((x) => x === `${dir}/package.json`);
}

const cache = new Map<string, { at: number; s: Survey }>();

/** Surveys a repository at a ref (default: beta if it has one, else its default branch) with that repo's own token. */
export async function survey(repo: string, o: { ref?: string; fresh?: boolean } = {}): Promise<Survey> {
  const slug = repoSlug(repo);
  if (!slug) throw new StudioError('repo: owner/name', 400);
  const { repoToken } = await import('./ghtoken.ts');
  const token = await repoToken(slug);
  if (!token) throw new StudioError(`Studio can't reach ${slug} yet: install the GitHub App on it (studio_project check gives the link), then survey again.`, 403);
  const info = await gh(token, 'GET', `/repos/${slug}`);
  let ref = o.ref ?? '';
  if (!ref) ref = await gh(token, 'GET', `/repos/${slug}/branches/beta`).then(() => 'beta', () => String(info.default_branch ?? 'main'));
  const key = `${slug.toLowerCase()}@${ref}`;
  const hit = cache.get(key);
  if (!o.fresh && hit && Date.now() - hit.at < 5 * 60_000) return hit.s;
  const tree = await gh(token, 'GET', `/repos/${slug}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  const paths = ((tree.tree ?? []) as { path: string; type: string }[]).filter((t) => t.type === 'blob').map((t) => t.path);
  const files: Record<string, string> = {};
  await Promise.all(wanted(paths).map(async (p) => {
    try {
      const f = await gh(token, 'GET', `/repos/${slug}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
      if (f?.content && Number(f.size ?? 0) < 512 * 1024) files[p] = Buffer.from(String(f.content), 'base64').toString('utf8');
    } catch { /* a file that went away between the list and the read */ }
  }));
  const studioUrl = studioAddress();
  const s = analyze(slug, ref, paths, files, { truncated: Boolean(tree.truncated), studioUrl, unityVersions: unityVersions() });
  cache.set(key, { at: Date.now(), s });
  return s;
}

/** The Unity versions Hawkes Gen's cloud builds have (STUDIO_UNITY_VERSIONS, comma list; default what the build image is). */
export const unityVersions = () => (process.env.STUDIO_UNITY_VERSIONS ?? '6000.3.7f1').split(',').map((x) => x.trim()).filter(Boolean);
