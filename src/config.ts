// Paths, settings and the product list.

import { customerStudio, touchesPlatformRepo } from './tenancy.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Every project lives next to Studio: C:\Projects. STUDIO_PROJECTS and STUDIO_DATA move them (tests use temp folders). */
export const PROJECTS = process.env.STUDIO_PROJECTS ? path.resolve(process.env.STUDIO_PROJECTS) : path.resolve(ROOT, '..');
export const DATA = process.env.STUDIO_DATA ? path.resolve(process.env.STUDIO_DATA) : path.join(ROOT, '.data');

/**
 * Whether beta is playtested after every change lands on it (agents' merges, Talk's fast lane, a Unity beta build,
 * the PM's check of a merged task). Off by default (J, 2026-10-17): a beta playtest is something to ask for (studio beta,
 * the Beta button, studio_playtest); the go-live check and the 5 AM daily run still play. Settings > Agents
 * (agents.json betaPlaytests); read here so the pipeline, the PM and the roadmap agree without importing agents.ts.
 */
export function betaPlaytestsOn() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, 'agents.json'), 'utf8')).betaPlaytests === true;
  } catch {
    return false;
  }
}
export const PORT = Number(process.env.STUDIO_PORT) || 8791;
export const GEN_URL = process.env.HAWKESGEN_URL || 'http://127.0.0.1:8790';
/** Where browsers reach Hawkes Gen (screenshots, videos): the public address on the server, else the same as GEN_URL. */
export const GEN_PUBLIC_URL = process.env.GEN_PUBLIC_URL || GEN_URL;

export const paths = {
  db: path.join(DATA, 'studio.db'),
  logs: path.join(DATA, 'logs'),
  reports: path.join(ROOT, 'reports'),
  dashboard: path.join(ROOT, 'dashboard'),
  /** STUDIO_PRODUCTS points at another products file (tests use a fixture). A customer's Studio (tenancy.ts: an org
   *  cell, STUDIO_ORG, or one a customer claimed) keeps its own in its data folder, which Cloud Run syncs to the cell's bucket (cloudhost.ts); onboarding writes it. */
  products: process.env.STUDIO_PRODUCTS || (customerStudio() ? path.join(DATA, 'products.json') : path.join(ROOT, 'products.json')),
  /** Games added in J's Studio through Talk or the dashboard (J, 2026-10-30: "Studio's data", not a commit): beside the
   *  hand-edited products.json, in the data folder Cloud Run syncs. A customer's Studio keeps all its games in `products`. */
  games: process.env.STUDIO_GAMES || path.join(DATA, 'games.json'),
};
for (const d of [DATA, paths.logs, paths.reports]) {
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch {
    // The agent sandbox's user can't see Studio's data (its MCP server only talks to Studio over HTTP).
  }
}

export type AppConf = {
  start: string;
  health: string;
  portEnv: string;
  dataEnv: string;
  urlEnv?: string;
  gen?: { keyEnv: string; urlEnv: string; projects: string[] };
  env?: Record<string, string>;
  open?: string;
};

/** device "phone": a 390x844 touch phone (the review also judges touch controls, text size and layout). */
export type Playtest = { scenario?: string; mode?: 'auto' | 'contract' | 'generic' | 'site'; where: 'local' | 'live'; device?: 'desktop' | 'phone'; daily?: boolean; timeout?: number; seed?: number; options?: Record<string, unknown>;
  /** Where the scenario starts (a named place, chapter or level the game loads: docs/playtest.md); none: from its start. */
  at?: string;
  /** Real players: 2 to 4 browsers on the same ?room=<id> (Gen playtest.run peers), for a multiplayer scenario. */
  peers?: number };

export type Product = {
  id: string;
  name: string;
  framing: string;
  engine: 'web' | 'unity' | 'static';
  repo: string;
  /** A game added in J's Studio: its GitHub repo (owner/name); `repo` is then the folder it is cloned into. */
  github?: string;
  site: string;
  live: string;
  /** A customer's game: where its test version plays (its beta), when it has one. Playtests "on beta" play it. */
  beta?: string;
  /** serve "app": the product is a server Studio runs itself (`app`, apps.ts), on this port for local playtests.
   *  serve "remote": its beta is deployed elsewhere by the repo's own CI (the customer portal on Firebase: a push to
   *  beta deploys https://hawkes-staging.web.app); `url` is that beta, and local playtests play it. */
  local: { serve: 'npm' | 'static' | 'app' | 'remote'; dir: string; port: number; path: string; url?: string };
  /**
   * A web product that is a server with its own database (the customer portal): its beta site and agent changes run
   * as processes (apps.ts) behind the front door instead of static files (previews.ts). start: the command, in the
   * checkout; health: a path answering 200 once it's up; portEnv/dataEnv/urlEnv: the variables it reads its port, a
   * data folder of its own and its public address from; gen: its own Gen key (made by Studio, scoped to `projects`)
   * and Gen's address go in keyEnv/urlEnv; env: anything else; open: paths (a regex) reachable without Studio's login,
   * for pages a sandboxed frame loads with no cookies (Caddy, deploy/caddyfile.mjs).
   */
  app?: AppConf;
  /** Unity: the project, its website folder, the batch deploy method, and test platforms to run on the build server when the source changes. */
  /** versionEnv: the environment variable the deploy method takes its Game/v<n> number from (beta.ts pinBetaVersion). */
  // r2: the game's name in R2 when its builds are served from there, not committed (docs/unity-builds-storage.md).
  build?: { project: string; site: string; method: string; tests?: ('EditMode' | 'PlayMode')[]; versionEnv?: string; r2?: string };
  /** The product implements the playtest contract (docs/playtest.md): playtests wait for it instead of falling back to a generic smoke test. */
  contract?: boolean;
  checks?: { dir: string; cmd: string }[];
  /**
   * prebuild: a command run on beta before a go live. via "ec2": main isn't published by GitHub Pages but by the product's
   * own server (the portal, hawkesgenwebsite): its box pulls main; box says which one.
   */
  deploy?: { prebuild?: string; via?: 'ec2' | 'firebase'; box?: string };
  /**
   * Developing on beta (dev.ts): front = the /dev/ front door's port (Caddy sends https://<sub>.<domain>/dev/* there),
   * port = the dev server's port (web products; Unity products have none), path = the devtools page under /dev/,
   * env = extra environment for the dev server (${PROJECTS} is replaced).
   */
  dev?: { front: number; port?: number; path?: string; env?: Record<string, string> };
  playtests: Playtest[];
  /** Renamed scenarios: an old name (stored on older tasks' changes) → the game's current one (scenarios.ts). */
  scenarioAliases?: Record<string, string>;
  story: string[];
  /** An org cell's game: its story and art direction as text, from onboarding (no files on this machine). */
  storyText?: string;
  about: string;
  /**
   * The quality bar: what "done" means for this product, in a few sentences. Reviews judge against it; once a full
   * review says the build meets it, the daily review of that scenario is regression-only until the build changes
   * meaningfully (review.ts). Unset: no bar (full daily reviews, still capped).
   */
  quality?: string;
  /** The public voice of its "What's new" (release.ts): voice, and words its notes never use. Unset: a game's player's-eye voice. */
  releaseVoice?: { voice: string; never?: string[] };
};

export function loadProducts(): Product[] {
  // A new org cell has no products until onboarding adds one.
  if (customerStudio() && !fs.existsSync(paths.products)) return [];
  const all = JSON.parse(fs.readFileSync(paths.products, 'utf8')).products as Product[];
  // A customer's games with a GitHub repo are products agents work on too (asAddedGame), the rest are played where they are.
  if (customerStudio()) return all.map(asAddedGame);
  // J's Studio: products.json first; a game added here never shadows one of its ids.
  const ids = new Set(all.map((p) => p.id));
  return [...all, ...addedGames().filter((p) => !ids.has(p.id)).map(asAddedGame)];
}

/** The folder an added game's repo is cloned into (beside the others), and its GitHub repo, for repos.ts repoMap. */
export function addedRepoFolders(): Record<string, string> {
  const own = customerStudio() ? {} : JSON.parse(fs.readFileSync(paths.products, 'utf8')).repos ?? {};
  const taken = new Set(Object.keys(own).map((k) => k.toLowerCase()));
  const out: Record<string, string> = {};
  // J's added games, or a customer's games (their whole products file: a cell has nothing else).
  const games = customerStudio() ? (fs.existsSync(paths.products) ? (JSON.parse(fs.readFileSync(paths.products, 'utf8')).products ?? []) as Product[] : []) : addedGames();
  for (const p of games) {
    const slug = /^[\w.-]+\/[\w.-]+$/.test(String(p.repo ?? '')) ? String(p.repo) : null;
    if (!slug) continue;
    const [owner, name] = slug.split('/');
    let folder = name;
    if (taken.has(folder.toLowerCase())) folder = `${owner}-${name}`;
    taken.add(folder.toLowerCase());
    out[folder] = slug;
  }
  return out;
}

/**
 * A game added in J's Studio, as a product agents can work on (J, 2026-10-30: Talk makes games and agents build them):
 * its GitHub repo cloned into its own folder like products.json's (repos.ts repoMap), the build as its check, and
 * played where it is deployed (local serve "remote" at its beta, else live).
 */
export function asAddedGame(p: Product): Product {
  const g = asCustomerGame(p);
  const folder = Object.entries(addedRepoFolders()).find(([, slug]) => slug === p.repo)?.[0];
  if (!folder) return g;
  return {
    ...g, repo: folder, site: folder, github: p.repo,
    // A web game's beta is Studio's own beta site, built from its beta branch (previews.ts ADDED_RECIPE: npm run build,
    // dist/), never "its CI deploys it": with "remote" its beta was never built and beta playtests played the live
    // site (Star Skipper, 2026-10-31). Here (J's PC) the built dist/ is served.
    local: p.engine === 'web' && !p.beta ? { serve: 'static', dir: `${folder}/dist`, port: 0, path: '/' } : { ...g.local, dir: folder },
    // The build as the check when it has one (a plain site without package.json has none to run).
    checks: p.checks ?? (p.engine === 'web' ? [{ dir: folder, cmd: 'test ! -f package.json || (npm install --no-audit --no-fund && npm run build --if-present)' }] : []),
  } as Product;
}

/** The games added in J's Studio (paths.games), as stored. */
export function addedGames(): Product[] {
  if (customerStudio() || !fs.existsSync(paths.games)) return [];
  try { return (JSON.parse(fs.readFileSync(paths.games, 'utf8')).products ?? []) as Product[]; } catch { return []; }
}

/** Where saveProduct and removeProduct write: the cell's products file, or J's added games. */
const storeFile = () => (customerStudio() ? paths.products : paths.games);
const storedGames = () => (customerStudio() ? (fs.existsSync(paths.products) ? loadProducts() : []) : addedGames());
function writeGames(all: Product[]) {
  const file = storeFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ products: all }, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * A customer's game has no checkout or local server here (no `local`, maybe no `repo`): it is played where it is
 * deployed. It reads as a product served "remote" at its live address, so code written for J's products (localUrl,
 * ensureServer, previews, the pipeline) treats it as one that is already up elsewhere instead of crashing on `local`.
 */
export function asCustomerGame(p: Product): Product {
  const live = p.live ?? '';
  return {
    ...p,
    repo: p.repo ?? '',
    site: p.site ?? p.repo ?? '',
    live,
    playtests: p.playtests ?? [],
    story: p.story ?? [],
    about: p.about ?? '',
    // Its "local" playtests are its beta's: the beta address when it has one, else where it plays.
    local: p.local ?? { serve: 'remote', dir: '', port: 0, path: '/', ...(p.beta || live ? { url: p.beta || live } : {}) },
  };
}

/** Whether there is a checkout of this product here (J's products; never a customer's game). */
export const hasCheckout = (p: Product) => Boolean(p.local?.dir) && !customerStudio();

/** A customer's game as onboarding describes it (an org cell): what Studio needs to play and review it. */
export type ProductInput = {
  id: string; name: string; engine: 'web' | 'unity' | 'godot' | 'desktop';
  /** Where the build is played: a web address (web builds), or the build source for desktop games. */
  live?: string; beta?: string; build?: { source: 'url' | 'upload' | 'github'; target?: 'web' | 'linux' | 'proton' | 'windows'; exe?: string; repo?: string };
  repo?: string; about?: string; quality?: string; story?: string; contract?: boolean;
  playtests?: { scenario?: string; mode?: 'site'; where: 'live'; device?: 'phone' }[];
};

/**
 * Adds or replaces one game (onboarding, the Add game dialog, Talk's studio_game, PUT /api/products/:id): an org cell's
 * own products file, or in J's Studio the added games beside products.json. Only the fields a customer's game has (no
 * local servers, deploy steps or devtools: those are products.json's), checked; written whole.
 */
export function saveProduct(input: ProductInput): Product {
  if (!customerStudio() && JSON.parse(fs.readFileSync(paths.products, 'utf8')).products.some((p: Product) => p.id === String(input.id ?? '').trim().toLowerCase())) {
    throw new StudioError(`"${input.id}" is one of products.json's (edited in git); pick another id for a new game.`, 409);
  }
  const id = String(input.id ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) throw new StudioError('id: 2-40 lower-case letters, digits or dashes, starting with a letter', 400);
  const name = String(input.name ?? '').trim().slice(0, 80);
  if (!name) throw new StudioError('name: required', 400);
  if (!['web', 'unity', 'godot', 'desktop'].includes(input.engine)) throw new StudioError('engine: web, unity, godot or desktop', 400);
  const live = input.live ? String(input.live).trim() : undefined;
  if (live && !/^https:\/\/[^\s]+$/.test(live)) throw new StudioError('live: an https:// address', 400);
  if (!live && !input.build) throw new StudioError('Give live (a web address) or build (where builds come from)', 400);
  const beta = input.beta ? String(input.beta).trim() : undefined;
  if (beta && !/^https:\/\/[^\s]+$/.test(beta)) throw new StudioError('beta: an https:// address', 400);
  // A customer's Studio never takes on one of J's repos (lockdown: anything touching jgriffith3433 is the platform's).
  if (customerStudio() && (touchesPlatformRepo(input.repo) || touchesPlatformRepo(input.build?.repo))) throw new StudioError("That repository belongs to Hawkes Studio's owner; add your own game's repository.", 403);
  const playtests = (input.playtests?.length ? input.playtests : [{ scenario: 'smoke', where: 'live' as const }]).slice(0, 20).map((t) => ({
    ...(t.mode === 'site' ? { mode: 'site' as const } : { scenario: String(t.scenario ?? 'smoke').slice(0, 60) }),
    where: 'live' as const, ...(t.device === 'phone' ? { device: 'phone' as const } : {}),
  }));
  const product: any = {
    id, name, engine: input.engine, ...(live ? { live } : {}), ...(beta ? { beta } : {}), ...(input.build ? { build: input.build } : {}),
    ...(input.repo ? { repo: String(input.repo).slice(0, 200) } : {}),
    about: String(input.about ?? '').slice(0, 2000), ...(input.quality ? { quality: String(input.quality).slice(0, 2000) } : {}),
    ...(input.story ? { storyText: String(input.story).slice(0, 20000) } : {}), contract: input.contract === true, playtests, story: [],
  };
  const all = storedGames().filter((p) => p.id !== id);
  all.push(product);
  writeGames(all);
  return customerStudio() ? product : asCustomerGame(product);
}

/**
 * A cell's first game from the sign-up (cells.ts seedGame left it as onboarding.json in its state): added through
 * saveProduct's checks, then the file is removed here and in the bucket, so a game removed later never comes back.
 */
export async function applyOnboardingSeed() {
  const file = path.join(DATA, 'onboarding.json');
  if (!customerStudio() || !fs.existsSync(file)) return null;
  let added: Product | null = null;
  try {
    const { game } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (game && !loadProducts().some((p) => p.id === game.id)) added = saveProduct(game);
  } catch (e: any) {
    console.warn(`[onboarding] the sign-up's first game: ${e.message ?? e}`);
  }
  fs.rmSync(file, { force: true });
  const bucket = process.env.STUDIO_STATE_BUCKET;
  if (bucket) {
    const { statePrefix } = await import('./cloudhost.ts');
    await (await import('./gcp.ts')).gcsDelete(bucket, `${statePrefix()}state/onboarding.json`).catch(() => {});
  }
  return added;
}

/** Removes a game added through saveProduct (an org cell's, or one added in J's Studio). */
export function removeProduct(id: string) {
  const all = storedGames();
  if (!all.some((p) => p.id === id)) {
    throw new StudioError(customerStudio() || !loadProducts().some((p) => p.id === id) ? `No product "${id}"` : `"${id}" is one of products.json's (edited in git), not an added game.`, customerStudio() ? 404 : 409);
  }
  writeGames(all.filter((p) => p.id !== id));
}

export function getProduct(id: string): Product {
  const p = loadProducts().find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase());
  if (!p) throw new StudioError(`No product "${id}". Products: ${loadProducts().map((x) => x.id).join(', ')}`, 404);
  return p;
}

/**
 * Hawkes Studio and Hawkes Gen as agent targets (products.json "infra"): not products (no playtests, no beta lane).
 * An agent change is a pull request into main; main deploys itself to the control server once CI passes.
 * smoke: how agents.ts starts the changed service on a spare port for its smoke check (portEnv/dataEnv point it at
 * that port and a scratch data folder; health must answer { ok: true }; scripts are node --check'ed).
 */
export type Infra = {
  id: string;
  name: string;
  repo: string;
  slug: string;
  about: string;
  checks: string[];
  smoke: { start: string; portEnv: string; dataEnv: string; health: string; scripts: string; env?: Record<string, string> };
};

export function loadInfra(): Infra[] {
  return JSON.parse(fs.readFileSync(paths.products, 'utf8')).infra ?? [];
}
export const isInfra = (id: string) => loadInfra().some((x) => x.id === id);
export function getInfra(id: string): Infra {
  const t = loadInfra().find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase());
  if (!t) throw new StudioError(`No infra target "${id}"`, 404);
  return t;
}

export const localUrl = (p: Product) => (p.local.serve === 'remote' && p.local.url ? p.local.url : `http://localhost:${p.local.port}${p.local.path}`);
export const abs = (rel: string) => path.join(PROJECTS, rel);

/** The product's story doc(s), trimmed for prompts. */
export function storyOf(p: Product, max = 12000) {
  let out = '';
  // An org cell's game keeps its story as text (onboarding: config.ts saveProduct).
  if (p.storyText) out += `--- story
${p.storyText}
`;
  for (const rel of p.story) {
    try {
      out += `--- ${rel}\n${fs.readFileSync(abs(rel), 'utf8')}\n`;
    } catch {
      // A missing doc just isn't included.
    }
  }
  return out.slice(0, max);
}

export class StudioError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Hawkes Net for beta pages: a beta site plays on beta Hawkes Net (hawkesnet.<domain>, products.json "hawkesnet"), its live
 *  site on net.hawkesgen.ai. The SDK (1.2.1+) and the Unity package read window.HAWKES_NET_ENDPOINT before their default;
 *  a page that names its own keeps it. Live pages never get this script. */
export const BETA_NET = (process.env.STUDIO_BETA_NET || `https://hawkesnet.${process.env.STUDIO_DOMAIN || 'hawkesgen.ai'}`).replace(/\/+$/, '');
/** What a beta (non-live) playtest's page is told before it loads: beta Hawkes Net (Gen playtest.run `globals`). */
export const betaPageGlobals = () => ({ HAWKES_NET_ENDPOINT: BETA_NET });
