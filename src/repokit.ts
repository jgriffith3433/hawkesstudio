// Getting a game ready for Studio, and making new ones (J, 2026-10-30: Talk walks the person through "getting a game
// project able to be iterated on and built in studio", and can "MAKE games for the user and it would start a repo and
// everything"). Two halves:
//   - readiness(): what a game has and lacks, item by item, each with who can do it (Talk now, an Approve tap, the
//     person on GitHub) and how. Talk reads it out and works down the list.
//   - plans: the outward-facing steps (a new repo, Studio's hook, the dev and beta branches, GitHub Pages) as one plan,
//     shown on an Approve card (approvals.ts kind "github"; J: "Approve card") and run on the tap with the best token
//     Studio has for the repo (github-app.ts accessFor). Adding the game to Studio, builds and playtests need no card.

import crypto from 'node:crypto';
import { StudioError, getProduct, saveProduct, loadProducts, managedElsewhere, type Product } from './config.ts';
import { accessFor, gh, repoSlug, githubStatus, userToken, appConfig, installUrl, userInstallationFor } from './github-app.ts';
import { starterFiles, starterFor, liveUrlFor, STARTERS, type GameSeed } from './starters.ts';
import { customerStudio } from './tenancy.ts';
import { hookPointsAt, repointHook } from './handover.ts';

export type Step = 'hook' | 'repoint' | 'branches' | 'pages';
export const STEPS: Record<Step, string> = {
  hook: "add Hawkes Studio's push hook (.github/workflows/hawkes-studio.yml, on main, beta and dev) so Studio hears about pushes to beta and main",
  repoint: "point this repo's hook at this Studio: rewrite .github/workflows/hawkes-studio.yml (on main, and beta and dev where they have it) with this Studio's address, so pushes come here instead of the Studio it names now",
  branches: 'make the dev and beta branches from main (dev -> beta -> main)',
  pages: 'turn on GitHub Pages from GitHub Actions, so main is the live game',
};

/** A plan for an existing repo, or a new game (create the repo from a starter, then every step). */
export type Plan =
  | { kind: 'setup'; product: string; repo: string; steps: Step[] }
  | { kind: 'new'; id: string; name: string; pitch: string; starter: string; owner: string; repoName: string; private: boolean; user: string };

type Item = { id: string; ok: boolean; what: string; fix?: string; by?: 'talk' | 'approve' | 'person'; step?: Step; link?: string };

const studioLink = (p: string) => `${studioBase()}${p}`;

/**
 * The exact pages a person might need for a game, so they never hunt through GitHub (J, 2026-10-30: "give the user Links
 * to where they need to go"). The app's install page for this one repository when GitHub says which it is.
 */
export async function linksFor(repo: string | null, p?: Product | null) {
  const out: Record<string, string> = {};
  if (p?.live) out.live = p.live;
  if (p?.beta) out.beta = p.beta;
  // Its beta site on Google Cloud (previews.ts: products.json's own hosts, or sites.<domain>/g/<game>/ for an added game).
  if (p && !p.beta) {
    const beta = await import('./previews.ts').then((m) => m.previewUrl(p.id)).catch(() => null);
    if (beta) out.beta = beta;
  }
  if (!repo) return out;
  const web = 'https://github.com';
  out.repo = `${web}/${repo}`;
  out.actions = `${web}/${repo}/actions`;
  out.pages = `${web}/${repo}/settings/pages`;
  out.branches = `${web}/${repo}/branches`;
  out.hook = `${web}/${repo}/blob/HEAD/.github/workflows/hawkes-studio.yml`;
  const app = appConfig();
  // A customer's Studio: the shared app's install page, with this org signed into it (cellside.ts).
  const cell = !app ? await import('./cellside.ts').then((m) => m.cellGithub()).catch(() => null) : null;
  if (cell?.install) out.install = cell.install;
  else if (app) {
    // GitHub's documented install page (the person picks the account and this repository there).
    out.install = installUrl()!;
  } else if (!cell) {
    out.connectGitHub = studioLink('/api/github/app/setup');
  }
  // The fallback: a fine-grained token with exactly what Studio needs, the form filled in on GitHub.
  const [owner] = repo.split('/');
  out.token = `${web}/settings/personal-access-tokens/new?${new URLSearchParams({ name: `Hawkes Studio: ${repo}`.slice(0, 40), description: 'Lets Hawkes Studio set up and work on this game', target_name: owner, expires_in: '90', contents: 'write', workflows: 'write', pages: 'write', metadata: 'read' })}`;
  return out;
}

const studioBase = () => (process.env.STUDIO_PUBLIC_URL || 'https://studio.hawkesgen.ai').replace(/\/+$/, '');

async function exists(token: string, url: string) {
  try { await gh(token, 'GET', url); return true; } catch (e: any) { if (e.status === 404) return false; throw e; }
}

/** What a game has and still needs, in order: the walk-through Talk follows. */
export async function readiness(productId: string, userId?: string | null) {
  const p = getProduct(productId);
  const items: Item[] = [];
  const slug = repoSlug(p.github ?? p.repo);
  // Handed over to another Studio (config.ts managedBy): said first; this Studio leaves it alone.
  const elsewhere = managedElsewhere(p);
  if (elsewhere) items.push({ id: 'managed', ok: true, what: `Managed by another Studio (${elsewhere}): this Studio doesn't run, build, change or deploy it` });
  items.push(slug
    ? { id: 'repo', ok: true, what: `Repository: ${slug}` }
    : { id: 'repo', ok: false, what: 'No GitHub repository yet', fix: 'Ask for its GitHub repository (owner/name) and save it with studio_project update, or make a new one (studio_project new).', by: 'talk' });
  let token: string | null = null;
  if (slug) {
    const access = await accessFor(slug, userId);
    token = access?.token ?? null;
    items.push(access
      ? { id: 'access', ok: true, what: `Studio can reach it (${access.via === 'app' ? 'the GitHub App' : access.via === 'user' ? 'your GitHub sign-in' : access.via === 'pasted' ? 'a pasted token' : "Studio's own token"})` }
      : { id: 'access', ok: false, what: "Studio can't reach the repository", by: 'person', ...(appConfig() || (await linksFor(slug)).install ? { fix: 'Install the GitHub App on it (the link opens with this repository chosen), then check again.', link: (await linksFor(slug)).install } : { fix: 'Connect Studio to GitHub first: choose where its app lives (your account or an organization), then install it on this repository.', link: studioLink('/api/github/app/setup') }) });
  }
  if (slug && token) {
    const info = await gh(token, 'GET', `/repos/${slug}`);
    const main = String(info.default_branch ?? 'main');
    // The hook, and where it sends pushes: the Studio address and OIDC audience inside it (handover.ts).
    const yml = await hookFile(token, slug, main);
    if (yml === null) items.push({ id: 'hook', ok: false, what: "Studio's push hook is missing", by: 'approve', step: 'hook', fix: STEPS.hook });
    else {
      const at = hookPointsAt(yml, studioBase());
      items.push(at.ok ? { id: 'hook', ok: true, what: "Studio's push hook is in the repo and points at this Studio" }
        : { id: 'hook', ok: false, what: at.elsewhere.length ? `Studio's push hook points at another Studio (${at.elsewhere.join(', ')}), so its pushes go there, not here` : "The repo's hook workflow doesn't name this Studio, so its pushes don't come here", by: 'approve', step: 'repoint', fix: STEPS.repoint });
    }
    const beta = await exists(token, `/repos/${slug}/branches/beta`);
    const dev = await exists(token, `/repos/${slug}/branches/dev`);
    // On main but not beta: a push runs its own branch's workflow, so beta's pushes never reach Studio.
    const hookItem = items.find((i) => i.id === 'hook');
    if (hookItem?.ok && beta && main !== 'beta') {
      const onBeta = await hookFile(token, slug, 'beta').catch(() => null);
      if (onBeta === null || !hookPointsAt(onBeta, studioBase()).ok) Object.assign(hookItem, { ok: false, what: onBeta === null ? "Studio's push hook is on main but not on beta, so beta's pushes never reach Studio" : "beta's copy of the push hook points somewhere else, so beta's pushes don't come here", by: 'approve', step: onBeta === null ? 'hook' : 'repoint', fix: onBeta === null ? STEPS.hook : STEPS.repoint });
    }
    items.push(beta && dev ? { id: 'branches', ok: true, what: 'dev and beta branches exist' } : { id: 'branches', ok: false, what: `Missing branch${beta || dev ? '' : 'es'}: ${[dev ? null : 'dev', beta ? null : 'beta'].filter(Boolean).join(', ')}`, by: 'approve', step: 'branches', fix: STEPS.branches });
    if (p.engine === 'web' && !p.live) {
      const pages = await gh(token, 'GET', `/repos/${slug}/pages`).catch(() => null);
      items.push(pages?.html_url
        ? { id: 'live', ok: false, what: `GitHub Pages is on (${pages.html_url}) but the project has no live address`, by: 'talk', fix: `Save live: ${pages.html_url} with studio_project update.` }
        : { id: 'live', ok: false, what: 'The project has no live address', by: 'approve', step: 'pages', fix: `${STEPS.pages}, or ask where it is played and save it with studio_project update.` });
    }
  }
  if (p.live) items.push({ id: 'live', ok: true, what: `Played at ${p.live}` });
  // How it's built and its beta site (builds.ts, docs/builds.md): any engine, any runner.
  if (slug && !elsewhere) {
    const B = await import('./builds.ts');
    const specs = B.buildsOf(p);
    items.push(specs.length
      ? { id: 'builds', ok: true, what: `How it's built: ${specs.map((b) => `${b.id} (${b.tool}${b.target && b.target !== 'web' ? `, ${b.target}` : ''}${b.publish ? ` → ${b.publish.project}/${b.publish.path}` : ''})`).join(', ')}` }
      : { id: 'builds', ok: false, what: `Studio doesn't know how to build it yet (a ${p.engine} project)`, by: 'talk', fix: "Load the builds skill, ask how they want it built (Unity in Hawkes Gen's cloud, or their own GitHub Actions for anything), and set builds with studio_project update." });
    // What would stop a cloud build or a fresh clone (survey.ts): said here, before a build fails on it.
    if (token) {
      const sv = await import('./survey.ts').then((m) => m.survey(slug)).catch(() => null);
      for (const n of sv?.notes.filter((x) => x.level === 'blocker') ?? []) items.push({ id: 'survey', ok: false, what: n.what, fix: `${n.fix}${n.by === 'agent' ? ' (an agent task: studio_task)' : ''}`, by: n.by === 'person' ? 'person' : 'talk' });
      if (sv && !sv.notes.some((x) => x.level === 'blocker')) items.push({ id: 'survey', ok: true, what: `Nothing in the repository stops a cloud build${sv.notes.some((x) => x.level === 'improve') ? ` (studio_project survey has ${sv.notes.filter((x) => x.level === 'improve').length} small improvements to offer)` : ''}` });
    }
    if (specs.some((b) => (b.target ?? 'web') === 'web') && !p.beta) {
      const last = B.buildHistory(p.id, 20).find((h) => !h.change);
      const { previewUrl } = await import('./previews.ts');
      items.push(last?.status === 'ready' || last?.status === 'pruned'
        ? { id: 'beta-site', ok: true, what: `Beta site: ${previewUrl(p.id) ?? last.url} (${last.build} ${last.version})` }
        : { id: 'beta-site', ok: false, what: last?.status === 'failed' ? `Its last build failed: ${String(last.detail ?? '').slice(0, 160)}` : last?.status === 'building' ? 'Its first build is running' : 'Not built yet, so it has no beta site', by: 'talk', fix: 'Build it now with studio_project build (it reports back when done).' });
    }
  }
  items.push(p.contract
    ? { id: 'contract', ok: true, what: "It speaks Studio's playtest contract (a bot plays it with real input)" }
    : { id: 'contract', ok: false, what: "No playtest contract yet: playtests can only load it and look", by: 'talk', fix: "Studio's agents can add window.hawkesPlaytest with a smoke scenario (studio_task); until then playtests run the generic smoke and site checks." });
  const plays = p.playtests?.length ? p.playtests.map((t) => `${(t as any).scenario ?? (t as any).mode}@${t.where}`).join(', ') : 'none';
  items.push({ id: 'playtests', ok: Boolean(p.playtests?.length), what: `Playtests: ${plays}`, ...(p.playtests?.length ? {} : { by: 'talk' as const, fix: 'Add a smoke playtest with studio_project update.' }) });
  const steps = items.filter((i) => !i.ok && i.step).map((i) => i.step!) as Step[];
  // Each item that waits on a GitHub page links straight to it.
  const links = await linksFor(slug, p);
  for (const i of items) if (!i.ok && !i.link) i.link = i.id === 'hook' ? links.repo : i.id === 'branches' ? links.branches : i.id === 'live' ? links.pages : undefined;
  return {
    product: p.id, name: p.name, ready: items.every((i) => i.ok),
    items, links,
    next: items.find((i) => !i.ok) ?? null,
    approve: steps.length ? { kind: 'setup', product: p.id, repo: slug, steps } : null,
  };
}

// ------------------------------------------------------------------ plans: described for the card, run on the tap

export function planHash(plan: Plan) {
  return crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 24);
}

/** The card's words for a plan, and what blocks it now. */
export async function describePlan(plan: Plan) {
  const blockers: string[] = [];
  if (plan.kind === 'setup') {
    const access = await accessFor(plan.repo).catch(() => null);
    if (!access) blockers.push(`Studio can't reach ${plan.repo} on GitHub yet: install the GitHub App on it.`);
    return {
      title: `Set up ${plan.repo} for Hawkes Studio?`,
      lines: [`Game: ${getProduct(plan.product).name} (${plan.product})`, ...plan.steps.map((s) => `• ${STEPS[s]}`), 'Nothing is pushed to main except these files, and nothing goes live.'],
      blockers,
    };
  }
  const s = starterFor(plan.starter);
  if (!s) blockers.push(`No starter "${plan.starter}".`);
  const u = await userToken(plan.user).catch(() => null);
  if (!u) blockers.push('Sign in with GitHub first (studio_github connect): the new repository is made in your account.');
  // A GitHub App's sign-in only reaches accounts the app is installed on: no install there, no repo (GitHub refuses).
  else if (!(await userInstallationFor(u.token, plan.owner || u.login).catch(() => null))) {
    blockers.push(`Install Studio's GitHub App on ${plan.owner || u.login} first (studio_github status has the link): GitHub only lets the app make repositories where it's installed.`);
  }
  if (loadProducts().some((p) => p.id === plan.id)) blockers.push(`Studio already has a game "${plan.id}".`);
  const repo = `${plan.owner}/${plan.repoName}`;
  return {
    title: `Make a new game, "${plan.name}"?`,
    lines: [
      `A new ${plan.private ? 'private' : 'public'} repository ${repo} on GitHub, from the ${s?.title ?? plan.starter} starter: a small game that already plays, with Studio's playtest bot.`,
      `Pitch: ${plan.pitch.slice(0, 400)}`,
      `Then: ${STEPS.branches}; ${STEPS.pages} (live at ${liveUrlFor({ repo } as GameSeed)}); Studio's push hook; the game added to Studio.`,
      ...(plan.private ? ['A private repository needs a paid GitHub plan for GitHub Pages.'] : []),
    ],
    blockers,
  };
}

/** Runs a plan with the best token Studio has. Returns a line per step done. */
export async function applyPlan(plan: Plan, { origin = null }: { origin?: string | null } = {}): Promise<string[]> {
  if (plan.kind === 'setup') {
    const access = await accessFor(plan.repo);
    if (!access) throw new StudioError(`Studio can't reach ${plan.repo}: install the GitHub App on it.`, 409);
    const done: string[] = [];
    for (const step of plan.steps) done.push(await runStep(access.token, plan.repo, step));
    return done;
  }
  const u = await userToken(plan.user);
  if (!u) throw new StudioError('Sign in with GitHub first: the new repository is made in your account.', 409);
  const owner = plan.owner || u.login;
  const isOrg = owner.toLowerCase() !== u.login.toLowerCase();
  const created = await gh(u.token, 'POST', isOrg ? `/orgs/${owner}/repos` : '/user/repos', {
    name: plan.repoName, description: plan.pitch.slice(0, 300), private: plan.private, auto_init: true, has_wiki: false,
  });
  const repo = String(created.full_name);
  const done = [`Made ${created.html_url}`];
  // An install that covers chosen repositories only doesn't cover a new one: add it, so Studio can push the starter.
  const inst = await userInstallationFor(u.token, owner).catch(() => null);
  if (inst?.selection === 'selected') {
    await gh(u.token, 'PUT', `/user/installations/${inst.id}/repositories/${created.id}`).catch((e) => done.push(`(couldn't add it to the app's chosen repositories: ${e.message}; add it on GitHub)`));
  }
  const seed: GameSeed = { id: plan.id, name: plan.name, pitch: plan.pitch, owner, repo, studioUrl: studioBase() };
  // Pages first, so the first push to main (the starter) deploys.
  done.push(await runStep(u.token, repo, 'pages').catch((e) => `GitHub Pages: not turned on (${e.message}); turn it on in the repo's Settings > Pages > GitHub Actions.`));
  await putFiles(u.token, repo, String(created.default_branch ?? 'main'), starterFiles(plan.starter, seed), `${plan.name}: a new game from Hawkes Studio (${plan.starter} starter)`);
  done.push(`Pushed the ${plan.starter} starter to main (it publishes to ${liveUrlFor(seed)} in a minute or two).`);
  done.push(await runStep(u.token, repo, 'branches'));
  saveProduct({ id: plan.id, name: plan.name, engine: 'web', live: liveUrlFor(seed), repo, about: plan.pitch, contract: true, playtests: [{ scenario: 'smoke', where: 'live' }] });
  done.push(`Added "${plan.name}" to Studio (${plan.id}): playtests play ${liveUrlFor(seed)}.`);
  // The game they described, built by an agent on top of the starter (a pull request into beta; merged when it's ready).
  try {
    const { startTask } = await import('./agents.ts');
    const b = firstVersionBrief(plan.name, plan.pitch, plan.starter);
    const change = startTask(plan.id, b.request, { criteria: b.criteria, title: b.title });
    (await import('./followup.ts')).tagChange(String(change), origin, 'Talk');
    done.push(`Started an agent on the first playable version (${change}): it builds what you described on top of the starter; you'll hear here when it's ready.`);
  } catch (e: any) {
    done.push(`The first version wasn't started (${e.message}); ask for it with studio_task.`);
  }
  done.push(`Links: the repo ${created.html_url} · its first publish ${created.html_url}/actions · the game ${liveUrlFor(seed)} (live once the publish finishes, a minute or two)`);
  return done;
}

/** A repo's hook workflow on a branch (its text), or null when it has none. */
async function hookFile(token: string, repo: string, branch: string): Promise<string | null> {
  try {
    const f = await gh(token, 'GET', `/repos/${repo}/contents/.github/workflows/hawkes-studio.yml?ref=${encodeURIComponent(branch)}`);
    return Buffer.from(String(f?.content ?? ''), 'base64').toString('utf8');
  } catch (e: any) {
    if (e.status === 404) return null;
    throw e;
  }
}

/** Studio's own hook workflow, naming this Studio. */
async function hookTemplate(repo: string) {
  const { starterFiles: files } = await import('./starters.ts');
  return files('web-3d', { id: 'x', name: 'x', pitch: '', owner: '', repo, studioUrl: studioBase() })['.github/workflows/hawkes-studio.yml'];
}

async function runStep(token: string, repo: string, step: Step): Promise<string> {
  const info = await gh(token, 'GET', `/repos/${repo}`);
  const main = String(info.default_branch ?? 'main');
  if (step === 'repoint') {
    // main first (it always gets the hook), then beta and dev where they have one: a push runs the workflow of its own branch.
    const done: string[] = [];
    for (const branch of [main, 'beta', 'dev'].filter((b, i, a) => a.indexOf(b) === i)) {
      const yml = await hookFile(token, repo, branch).catch(() => null);
      if (yml === null && branch !== main) continue;
      if (yml !== null && hookPointsAt(yml, studioBase()).ok) continue;
      const next = (yml !== null ? repointHook(yml, studioBase()) : null) ?? (await hookTemplate(repo));
      await putFiles(token, repo, branch, { '.github/workflows/hawkes-studio.yml': next }, `Point Hawkes Studio's push hook at ${studioBase()}`);
      done.push(branch);
    }
    return done.length ? `Pointed ${repo}'s hook at ${studioBase()} (${done.join(', ')}).` : `${repo}'s hook already points at ${studioBase()}.`;
  }
  if (step === 'hook') {
    // On main, beta and dev (where they exist): a push runs the workflow file of its own branch, so a hook on main alone
    // never hears beta's pushes (2026-10-31). Each branch is read back after, so the answer says what's really there.
    const yml = await hookTemplate(repo);
    const done: string[] = [];
    for (const branch of [main, 'beta', 'dev'].filter((b, i, a) => a.indexOf(b) === i)) {
      if (branch !== main && !(await exists(token, `/repos/${repo}/branches/${encodeURIComponent(branch)}`))) continue;
      const cur = await hookFile(token, repo, branch).catch(() => null);
      if (cur !== null && hookPointsAt(cur, studioBase()).ok) { done.push(branch); continue; }
      await putFiles(token, repo, branch, { '.github/workflows/hawkes-studio.yml': cur !== null ? (repointHook(cur, studioBase()) ?? yml) : yml }, "Hawkes Studio's push hook");
      if ((await hookFile(token, repo, branch).catch(() => null)) === null) throw new StudioError(`The hook didn't land on ${repo}'s ${branch} (GitHub accepted the commit but the file isn't there): check that the GitHub App may change workflows (its "Workflows: write" permission).`, 502);
      done.push(branch);
    }
    return `Studio's push hook is on ${repo}'s ${done.join(', ')}.`;
  }
  if (step === 'branches') {
    const head = (await gh(token, 'GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(main)}`)).object.sha;
    const made: string[] = [];
    for (const b of ['beta', 'dev']) {
      if (await exists(token, `/repos/${repo}/branches/${b}`)) continue;
      await gh(token, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${b}`, sha: head });
      made.push(b);
    }
    return made.length ? `Made ${made.join(' and ')} from ${main}.` : 'dev and beta were already there.';
  }
  const on = await gh(token, 'GET', `/repos/${repo}/pages`).catch(() => null);
  if (on) {
    // Already published (from a branch or a workflow): left exactly as it is. Switching a branch-published site to
    // Actions takes it down until a Pages workflow exists, and the live site is the person's.
    return `GitHub Pages already publishes it (${on.html_url}, ${on.build_type === 'workflow' ? 'from Actions' : `from the ${on.source?.branch ?? 'chosen'} branch`}); left as it is.`;
  }
  const p = await gh(token, 'POST', `/repos/${repo}/pages`, { build_type: 'workflow' });
  return `Turned on GitHub Pages (${p.html_url ?? 'from Actions'}).`;
}

/** One commit of whole files onto a branch (the Git Data API: blobs inline in one tree). */
export async function putFiles(token: string, repo: string, branch: string, files: Record<string, string>, message: string) {
  const ref = await gh(token, 'GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const parent = await gh(token, 'GET', `/repos/${repo}/git/commits/${ref.object.sha}`);
  const tree = await gh(token, 'POST', `/repos/${repo}/git/trees`, {
    base_tree: parent.tree.sha,
    tree: Object.entries(files).map(([p, content]) => ({ path: p, mode: '100644', type: 'blob', content })),
  });
  const commit = await gh(token, 'POST', `/repos/${repo}/git/commits`, { message, tree: tree.sha, parents: [ref.object.sha] });
  await gh(token, 'PATCH', `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha });
  return commit.sha as string;
}

/** A new game's plan from what Talk learned (checked, nothing made yet). */
export async function newGamePlan(input: { name?: unknown; pitch?: unknown; starter?: unknown; owner?: unknown; repo?: unknown; private?: unknown; id?: unknown }, user: string): Promise<Plan> {
  const name = String(input.name ?? '').trim().slice(0, 80);
  if (!name) throw new StudioError('name: what the game is called', 400);
  const pitch = String(input.pitch ?? '').trim().slice(0, 2000);
  if (pitch.length < 10) throw new StudioError('pitch: what the game is, in a sentence or two (ask the person what kind of game they want)', 400);
  const starter = String(input.starter ?? '');
  if (!starterFor(starter)) throw new StudioError(`starter: ${STARTERS.map((s) => `${s.id} (${s.fits})`).join('; ')}`, 400);
  const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 39);
  const id = slugOf(String(input.id ?? name)).replace(/^[^a-z]+/, '') || 'game';
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) throw new StudioError('id: 2-40 lower-case letters, digits or dashes', 400);
  const repoName = String(input.repo ?? id).trim().replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 100);
  const u = await userToken(user).catch(() => null);
  const owner = String(input.owner ?? u?.login ?? '').trim();
  if (customerStudio() && owner.toLowerCase() === 'jgriffith3433') throw new StudioError("That account belongs to Hawkes Studio's owner.", 403);
  return { kind: 'new', id, name, pitch, starter, owner, repoName, private: input.private === true, user };
}

export { githubStatus, STARTERS };
export type { Product };

// ------------------------------------------------------------------ one call: everything about a game

/**
 * Everything about one game for Talk, in one answer (J, 2026-10-30: Talk "very capable"): what it is, how it's doing
 * (its last playtests with their videos and verdicts), what's broken (open findings), what agents are doing on it, what
 * it still needs, and every link. Each part fails soft: one that can't be read says so, the rest still answer.
 */
export async function gameStatus(productId: string, base: string, userId?: string | null) {
  const p = getProduct(productId);
  const soft = async <T>(f: () => Promise<T> | T): Promise<T | { error: string }> => { try { return await f(); } catch (e: any) { return { error: String(e.message ?? e) }; } };
  const abs = (u: string | null | undefined) => (u ? (/^https?:/.test(u) ? u : `${base}${u.startsWith('/') ? '' : '/'}${u}`) : null);
  const [ready, plays, findings, changes] = await Promise.all([
    soft(() => readiness(p.id, userId)),
    soft(async () => (await import('./playtests.ts')).listPlaytests({ product: p.id, limit: 6 }).playtests.map((t: any) => ({
      name: t.name, outcome: t.outcome, when: t.finished ?? t.started, verdict: t.review?.verdict ?? null, score: t.review?.score ?? null,
      findings: t.review?.findings ?? 0, video: abs(t.video), seconds: t.seconds, fps: t.fps, problems: t.problems,
    }))),
    soft(async () => {
      const list = (await import('./backlog.ts')).listFindings({ product: p.id, status: 'open,fixing', limit: 200 }) as any[];
      const by: Record<string, number> = {};
      for (const f of list) by[f.severity] = (by[f.severity] ?? 0) + 1;
      return { open: list.length, bySeverity: by, worst: list.slice(0, 5).map((f) => ({ id: f.id, severity: f.severity, title: f.title, status: f.status })) };
    }),
    soft(async () => (await import('./agents.ts')).listChanges({ product: p.id }).filter((c: any) => !['merged', 'closed'].includes(c.status)).slice(0, 8)
      .map((c: any) => ({ id: c.id, title: c.title, status: c.status, pr: c.pr_url ?? null, preview: c.verify?.preview ?? null }))),
  ]);
  const links: Record<string, string> = await linksFor(repoSlug(p.github ?? p.repo), p).catch(() => ({}));
  return {
    game: { id: p.id, name: p.name, engine: p.engine, about: p.about, live: p.live || null, beta: p.beta ?? null, repo: p.github ?? (repoSlug(p.repo) ?? null), contract: Boolean(p.contract), playtests: (p.playtests ?? []).map((t: any) => `${t.scenario ?? t.mode}@${t.where}${t.device ? `:${t.device}` : ''}`) },
    ready: 'error' in (ready as any) ? ready : { ready: (ready as any).ready, next: (ready as any).next, missing: (ready as any).items.filter((i: any) => !i.ok).map((i: any) => i.what) },
    playtests: plays, findings, changes,
    links: { ...links, studio: `${base}/#today`, playtestsPage: `${base}/#playtests`, backlog: `${base}/#backlog` } as Record<string, string>,
  };
}

// ------------------------------------------------------------------ agent briefs for a new game

/** The first agent task on a brand-new game: build what the person described on top of the starter. */
export function firstVersionBrief(name: string, pitch: string, starter: string) {
  return {
    title: `${name}: the first playable version`,
    request: `Make the first playable version of "${name}" from what the person described, on top of the ${starter} starter that's in the repo now.

What they want: ${pitch}

- Replace the starter's demo (the ball and orbs, or the box and stars) with this game's own core loop: what the player does, a goal, a way to win or lose, a score or progress on screen. Small and fun beats big and broken: one solid loop first.
- Keep the playtest contract working (src/playtest.js): its bot plays through real key presses. Update the smoke scenario so it plays this game's core loop and finishes 'done' when it reaches a point a player would (scores, clears, survives). Add a scenario for anything else worth checking.
- Shapes and colors are fine for art now; leave clear names where real art, sound and music will go (Hawkes Gen makes them later).
- \`npm run build\` must pass. Update README.md and AGENTS.md to describe the game as it now is.`,
    criteria: ['The game opens and its own core loop is playable (not the starter demo)', 'The smoke playtest plays the core loop with real input and finishes done', 'npm run build passes'],
  };
}

/** Adding Studio's playtest contract to a game that hasn't got it (the bot that plays it with real input). */
export function contractBrief(p: Product) {
  return {
    title: `${p.name}: Studio's playtest bot`,
    request: `Add Hawkes Studio's playtest contract to ${p.name}, so Studio's bot can play it with real input and Claude can review what it sees.

- Copy hawkes-playtest.js and hawkes-perf.js (Studio's clients/web; for Unity, the com.hawkes.playtest package) into the game and call installPlaytest once at startup (the file's header shows how; the spec is Studio's docs/playtest.md).
- One scenario first: smoke. It boots the game, gets past any menu, plays the core loop for 20 to 40 seconds by pressing keys or clicking like a player (never moving things directly), and finishes 'done' when it got somewhere a player would.
- Report scenes (t.scene), events at the moments that matter (t.event), progress (t.progress) and problems the game can detect (t.problem).
- Keep the game's own checks passing.`,
    criteria: ['window.hawkesPlaytest is installed and lists a smoke scenario', 'The smoke scenario plays with real input and finishes done', "The game's checks pass"],
  };
}
