// Build failures that handle themselves (J, 2026-11-07: Hawkes Games' firebase build r_f936ac44d25c failed with 403
// "Resource not accessible by integration" when Studio started firebase.yml, and the customer had to relay it to the PM).
// Customers don't deal with config: this works by default (Settings → Builds → "Handle build failures by itself", on).
//
//   failType(): every failure is `transient` (network, 5xx, rate limit, "getting the commit" at 0 s), `access` (403/404 from
//     the GitHub App's token: a missing permission or install) or `code` (the project's own); anything else is `other` and
//     is handled as before.
//   transient: retried by itself with a backoff (3 attempts in all, over about 10 minutes), saying nothing unless the last
//     one fails too. The retry state is a table, so a restart carries on (resumeRetries). The waits are a backoff, not a poll:
//     nothing is fetched while waiting.
//   access: never retried. ONE Inbox card per project (build_access), with the permission that is missing in plain words and
//     the direct link to the installation page. It is looked at when the card is opened (inbox.ts) and when the next build
//     starts (the preflight), never on a timer; once access is back the failed builds start again and the card resolves.
//   preflight(): before an Actions build is started, the app's permissions on the repo are read (GET /repos/<repo>/installation
//     with the app's key), so a missing Actions: write shows the card at once instead of a failed build.
//   code: unchanged (buildfail.ts announce → buildfix.ts, a fixer and the backlog).

import { db, newId } from './db.ts';
import { acceptSteps, stepsText, grants } from './ghperms.ts';

export type FailType = 'transient' | 'access' | 'code' | 'other';

// ------------------------------------------------------------------ classifying

/** What a GitHub refusal says is missing: a permission of the app (`Actions: write`), the install on the repo, or neither known. */
export type AccessCause = { what: 'permission' | 'install' | 'unknown'; permission: string | null; key: string | null; workflow: string | null; status: number | null; message: string };

const RATE = /rate limit|abuse detection|secondary rate|too many requests|\b429\b/i;
const NETWORK = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network (error|is unreachable)|connection (reset|refused|closed)|UND_ERR|TLS|aborted|bad gateway|service unavailable|gateway time-?out|temporarily unavailable|try again/i;
const SERVER = /(^|[^\d])(50[0-4]|52[0-9])([^\d]|$)/;

/** The refusal's HTTP status and GitHub's message out of an error text ("… 403 {"message":"Resource not accessible …"}"). */
export function githubStatus(error: unknown): { status: number | null; message: string } {
  const e = String(error ?? '');
  const s = /\b(401|403|404|422|429|50\d)\b/.exec(e);
  const m = /"message"\s*:\s*"([^"]+)"/.exec(e);
  return { status: s ? Number(s[1]) : null, message: m ? m[1] : '' };
}

const PERMISSIONS: { re: RegExp; key: string; word: string }[] = [
  { re: /start [\w.\-]+\.ya?ml|workflow|dispatch|actions/i, key: 'actions', word: 'Actions' },
  { re: /pull request|\bpull\b/i, key: 'pull_requests', word: 'Pull requests' },
  { re: /contents|commit(ting)? into|push/i, key: 'contents', word: 'Contents' },
];

/** Why GitHub refused, or null when the error isn't an access problem. Exported for the tests. */
export function accessCause(error: unknown): AccessCause | null {
  const e = String(error ?? '');
  if (RATE.test(e) && !/not accessible by integration/i.test(e)) return null;
  const { status, message } = githubStatus(e);
  const integration = /resource not accessible by integration/i.test(e);
  const notInstalled = /isn't installed|not installed|no GitHub access|has no GitHub access|can't (see|reach) (the )?(repo|repository)/i.test(e);
  const githubWords = /github|installation|integration/i.test(e);
  if (!integration && !notInstalled && !((status === 403 || status === 404) && githubWords)) return null;
  const workflow = /(?:start|starting|dispatch(?:ing)?)\s+([\w.\-]+\.ya?ml)/i.exec(e)?.[1] ?? /([\w\-]+\.ya?ml)/i.exec(e)?.[1] ?? null;
  if (notInstalled || (status === 404 && !integration && !workflow)) return { what: 'install', permission: null, key: null, workflow, status, message };
  const hit = integration || workflow ? PERMISSIONS.find((p) => p.re.test(e)) ?? PERMISSIONS[0] : null;
  if (hit) return { what: 'permission', permission: `${hit.word}: write`, key: hit.key, workflow, status, message };
  return { what: 'unknown', permission: null, key: null, workflow, status, message };
}

/**
 * The fix, in plain words, for an access cause on a repo (the card adds the links). A missing permission is walked
 * through step by step (ghperms.ts acceptSteps): accepting it on the installation's page, and adding it to the app
 * first only when the app doesn't ask for it yet (`appHas` false; unknown counts as asked, the usual case).
 */
export function accessFix(cause: AccessCause, slug: string | null, o: { appHas?: boolean | null; account?: string | null; ownsApp?: boolean } = {}): string {
  const repo = slug || 'the repository';
  if (cause.what === 'permission') {
    const doing = cause.workflow ? `start ${cause.workflow}` : cause.key === 'actions' ? 'start its workflows' : 'make changes there';
    const why = cause.key === 'actions'
      ? ` Studio's own builds don't need it (they run in Studio's cloud); it's only for a build that runs in ${repo}'s own GitHub Actions.`
      : '';
    return `Studio's GitHub app doesn't have "${cause.permission}" on ${repo} yet, which it needs to ${doing}.${why}\n\n${stepsText(acceptSteps({ what: cause.permission ?? 'the permission', account: o.account ?? slug?.split('/')[0] ?? null, appHas: o.appHas !== false, ownsApp: o.ownsApp }))}`;
  }
  if (cause.what === 'install') return `Hawkes Studio's GitHub app isn't installed on ${repo} (or can't see it). Install it on that repository (the link opens with it chosen) and Studio rebuilds by itself.`;
  return `GitHub refused Studio's access to ${repo}${cause.status ? ` (${cause.status}${cause.message ? ` ${cause.message}` : ''})` : ''}. Check that Hawkes Studio's GitHub app is installed on it with access to its code and Actions, and Studio rebuilds by itself.`;
}

/**
 * The type of a failure. `code` is the caller's word (buildfail.ts: a compile error or the project's own build command
 * failing); access comes before transient so a 403 for a permission is never retried, and a rate limit (also a 403) is.
 * Exported for the tests.
 */
export function failType(error: unknown, o: { stage?: string | null; kind?: string | null } = {}): FailType {
  const e = String(error ?? '');
  if (o.kind === 'code') return 'code';
  if (RATE.test(e) && !/not accessible by integration/i.test(e)) return 'transient';
  if (accessCause(e)) return 'access';
  if (NETWORK.test(e) || SERVER.test(e)) return 'transient';
  // "Getting the commit" failing with nothing more to say (Gen or GitHub didn't answer), but not a repo or branch that isn't there.
  if (o.stage === 'checkout' && !/has no (GitHub repo|beta or main)|no GitHub repo|has no builds|no build "/i.test(e)) return 'transient';
  return 'other';
}

// ------------------------------------------------------------------ the setting (Settings → Builds)

/** Whether failures handle themselves (default on). Read at run time, no restart. */
export function selfHandling(): boolean {
  try {
    const r = db.prepare(`SELECT value FROM settings WHERE key = 'builds'`).get() as { value: string } | undefined;
    const v = r ? JSON.parse(r.value) : {};
    return v.handleFailures !== false;
  } catch { return true; } // no settings table yet, or unreadable: the default is on
}

// ------------------------------------------------------------------ retries

/** Attempts in all (the first and two more), and the waits before the second and the third: about ten minutes in all. */
export const MAX_TRIES = 3;
export const RETRY_WAITS_MS = [2 * 60_000, 8 * 60_000];

db.exec(`CREATE TABLE IF NOT EXISTS build_retry (
  product TEXT NOT NULL, build TEXT NOT NULL, row TEXT, attempt INTEGER NOT NULL, due INTEGER NOT NULL, ref TEXT, sha TEXT, why TEXT,
  PRIMARY KEY (product, build)
)`);

const timers = new Map<string, NodeJS.Timeout>();
/** Replaced by the tests (nothing really builds). */
export const hooks: { start: (product: string, o: { build: string; ref?: string; sha?: string; retry: number }) => Promise<unknown>; notify: (title: string, body: string, url: string) => Promise<unknown> } = {
  start: async (product, o) => (await import('./builds.ts')).startBuild(product, { build: o.build, ref: o.ref, sha: o.sha, retry: o.retry }),
  notify: async (title, body, url) => { const { notify, PUBLIC_URL } = await import('./notify.ts'); return notify(title, body, { url: `${PUBLIC_URL}/${url.replace(/^\//, '')}`, priority: 4, tags: ['key'] }); },
};

/** A failed row that is waiting for its retry is not a failure yet: no card, no push, no "failed" badge. */
export function retryPending(rowId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM build_retry WHERE row = ?').get(rowId));
}
export function retryState(product: string, build: string) {
  return db.prepare('SELECT * FROM build_retry WHERE product = ? AND build = ?').get(product, build) as { attempt: number; due: number; why: string } | undefined;
}
export function clearRetry(product: string, build: string) {
  db.prepare('DELETE FROM build_retry WHERE product = ? AND build = ?').run(product, build);
  const k = `${product}/${build}`;
  const t = timers.get(k);
  if (t) { clearTimeout(t); timers.delete(k); }
}

function arm(product: string, build: string, ms: number) {
  const k = `${product}/${build}`;
  const old = timers.get(k);
  if (old) clearTimeout(old);
  const t = setTimeout(() => { timers.delete(k); void fireRetry(product, build); }, Math.max(0, ms));
  t.unref?.();
  timers.set(k, t);
}

export async function fireRetry(product: string, build: string) {
  const r = db.prepare('SELECT * FROM build_retry WHERE product = ? AND build = ?').get(product, build) as any;
  if (!r) return;
  try {
    // The row stays until the retry has started (a restart in between re-arms it); the new attempt's own failure replaces it.
    await hooks.start(product, { build, ref: r.ref ?? undefined, sha: r.sha ?? undefined, retry: Number(r.attempt) });
  } catch (e: any) {
    console.warn(`[builds] ${product} ${build}: the retry couldn't start: ${String(e?.message ?? e).slice(0, 200)}`);
    clearRetry(product, build);
  }
}

/** After a restart: retries that were waiting carry on (late ones a few seconds from now). */
export function resumeRetries() {
  for (const r of db.prepare('SELECT product, build, due FROM build_retry').all() as any[]) arm(r.product, r.build, Math.max(5_000, r.due - Date.now()));
}

export type Handled = { handled: boolean; type: FailType; retry?: { attempt: number; inMs: number }; card?: string };

/**
 * A build failed (builds.ts buildOne): what Studio does about it by itself. `handled` true means nobody is told now: a retry
 * is waiting, or the access card was filed. Not handled: code and unknown failures, a retry used up, the setting off.
 * `attempt` is this build's try (1 for the first).
 */
export async function handleFailure(rowId: string, o: { product: string; build: string; slug: string | null; error: unknown; stage?: string | null; kind?: string | null; attempt?: number; ref?: string | null; sha?: string | null; workflow?: string | null }): Promise<Handled> {
  const type = failType(o.error, { stage: o.stage, kind: o.kind });
  if (!selfHandling()) return { handled: false, type };
  const attempt = Math.max(1, o.attempt ?? 1);
  if (type === 'transient') {
    if (attempt >= MAX_TRIES) { clearRetry(o.product, o.build); return { handled: false, type }; }
    const inMs = RETRY_WAITS_MS[Math.min(attempt - 1, RETRY_WAITS_MS.length - 1)];
    db.prepare('INSERT OR REPLACE INTO build_retry (product, build, row, attempt, due, ref, sha, why) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(o.product, o.build, rowId, attempt + 1, Date.now() + inMs, o.ref ?? null, o.sha ?? null, String(o.error ?? '').slice(0, 300));
    arm(o.product, o.build, inMs);
    return { handled: true, type, retry: { attempt: attempt + 1, inMs } };
  }
  clearRetry(o.product, o.build);
  if (type === 'access') {
    const cause = accessCause(o.error)!;
    const card = await fileAccessCard(o.product, o.build, o.slug, cause, o.workflow);
    return { handled: true, type, card };
  }
  return { handled: false, type };
}

// ------------------------------------------------------------------ the access card

db.exec(`CREATE TABLE IF NOT EXISTS build_access (
  id TEXT PRIMARY KEY, product TEXT NOT NULL, slug TEXT, builds TEXT NOT NULL DEFAULT '[]', what TEXT NOT NULL, permission TEXT, key TEXT,
  workflow TEXT, status TEXT NOT NULL, detail TEXT, opened INTEGER NOT NULL, checked INTEGER, resolved INTEGER
)`);

export type AccessRow = { id: string; product: string; slug: string | null; builds: string[]; what: string; permission: string | null; key: string | null; workflow: string | null; status: string; detail: string | null; opened: number; checked: number | null; resolved: number | null };
const view = (r: any): AccessRow => ({ ...r, builds: (() => { try { return JSON.parse(r.builds); } catch { return []; } })() });

/** The open access cards (one per project). */
export function openAccess(product?: string): AccessRow[] {
  return (db.prepare(`SELECT * FROM build_access WHERE status = 'open' ${product ? 'AND product = ?' : ''} ORDER BY opened`).all(...(product ? [product] : [])) as any[]).map(view);
}

/**
 * Open cards that one fix covers: the same cause on repos of the same GitHub account (one installation, one accept).
 * The Inbox shows each group as one card.
 */
export function accessGroups(rows: AccessRow[]): AccessRow[][] {
  const by = new Map<string, AccessRow[]>();
  for (const r of rows) {
    const k = `${r.what}|${r.permission ?? ''}|${(r.slug?.split('/')[0] ?? r.product).toLowerCase()}`;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  return [...by.values()];
}

/**
 * ONE open card per project: a second build failing the same way adds itself to the card (so they all rebuild when access
 * is back) and says nothing more; a different problem on the same project replaces the card's cause. Returns the card's id.
 */
/** What the walk-through needs from a probe: whether the app already asks for the permission, whose installation, whose app. */
export function fixContext(p: Probe | null, key: string | null) {
  if (!p?.known) return {};
  return { appHas: p.appPermissions && key ? grants(p.appPermissions, key, 'write') : null, account: p.account, ownsApp: p.ownsApp };
}

export async function fileAccessCard(product: string, build: string, slug: string | null, cause: AccessCause, workflow?: string | null, probe?: Probe | null): Promise<string> {
  // The probe says whether the app already asks for it (accept only) or its owner adds it first. Looked at once, here.
  if (!probe && slug && cause.what === 'permission') probe = await probeHook.run(slug).catch(() => null);
  const detail = accessFix(cause, slug, fixContext(probe ?? null, cause.key));
  const have = openAccess(product)[0];
  if (have) {
    const builds = [...new Set([...have.builds, build])];
    db.prepare('UPDATE build_access SET builds = ?, what = ?, permission = ?, key = ?, workflow = COALESCE(?, workflow), detail = ?, slug = COALESCE(?, slug) WHERE id = ?')
      .run(JSON.stringify(builds), cause.what, cause.permission, cause.key, workflow ?? cause.workflow, detail, slug, have.id);
    return have.id;
  }
  // Another project on the same GitHub account already waits on the same fix: this one joins its card, told nothing new.
  const sameFix = openAccess().some((r) => r.what === cause.what && (r.permission ?? '') === (cause.permission ?? '') && (r.slug?.split('/')[0] ?? '').toLowerCase() === (slug?.split('/')[0] ?? '').toLowerCase() && Boolean(slug));
  const id = newId('x');
  db.prepare("INSERT INTO build_access (id, product, slug, builds, what, permission, key, workflow, status, detail, opened) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)")
    .run(id, product, slug, JSON.stringify([build]), cause.what, cause.permission, cause.key, workflow ?? cause.workflow, detail, Date.now());
  // Told once, when the card is made (repeated failures add to it silently).
  if (sameFix) return id;
  void (async () => {
    let name = product;
    try { name = (await import('./config.ts')).getProduct(product).name; } catch { /* keep the id */ }
    await hooks.notify(`${name}: Studio needs one step on GitHub`, detail.slice(0, 500), '#inbox');
  })().catch((e: any) => console.warn(`[builds] couldn't tell about the access card for ${product}: ${e?.message ?? e}`));
  return id;
}

export type Probe = { ok: boolean; permissions: Record<string, string> | null; installId: number | null; account: string | null; type: string | null; known: boolean; manage?: string | null; appPermissions?: Record<string, string> | null; ownsApp?: boolean };
/** Replaced by the tests: what the app can do on a repo. `known: false` means Studio can't tell (no app key here). */
export const probeHook: { run: (slug: string) => Promise<Probe> } = { run: probeApp };

/** The app's installation on a repo and its permissions, read with the app's own key (not an installation token). */
export async function probeApp(slug: string): Promise<Probe> {
  const unknown: Probe = { ok: true, permissions: null, installId: null, account: null, type: null, known: false };
  try {
    const A = await import('./github-app.ts');
    if (!A.appConfig()) {
      // A customer's Studio: the shared app's installation, asked through the control plane (it holds the app's key).
      const c = await (await import('./cellside.ts')).cellGithubProbe(slug).catch(() => null);
      if (!c) return unknown;
      if (!c.installed) return { ok: false, permissions: null, installId: null, account: null, type: null, known: true };
      // pending: what the app asks for and this installation hasn't accepted; the app's own list is the two together.
      const appPermissions: Record<string, string> = { ...(c.permissions ?? {}) };
      for (const k of c.pending ?? []) appPermissions[k] = appPermissions[k] === 'read' || !appPermissions[k] ? 'write' : appPermissions[k];
      return { ok: true, permissions: c.permissions ?? {}, installId: c.id ?? null, account: c.account ?? null, type: c.type ?? null, known: true, manage: c.manage ?? null, appPermissions, ownsApp: false };
    }
    const d = await A.gh(A.appJwt(), 'GET', `/repos/${slug}/installation`, undefined, { jwt: true });
    const account = d?.account?.login ?? null, type = d?.account?.type ?? null, installId = Number(d?.id) || null;
    return { ok: true, permissions: d?.permissions ?? {}, installId, account, type, known: true, manage: installId && account ? A.manageUrl(installId, account, type ?? 'User') : null, appPermissions: await A.appPermissions().catch(() => null), ownsApp: true };
  } catch (e: any) {
    // 404: the app isn't installed on it. Anything else (GitHub down, the app's key not for this Studio): can't tell.
    if (e?.status === 404 || /: 404 /.test(String(e?.message))) return { ok: false, permissions: null, installId: null, account: null, type: null, known: true };
    return unknown;
  }
}

const RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** Whether the app can do what the card says on its repo. Studio can't tell → true (the build itself will say). */
export async function accessOk(row: Pick<AccessRow, 'slug' | 'what' | 'key'>): Promise<boolean> {
  if (!row.slug) return true;
  const p = await probeHook.run(row.slug);
  if (!p.known) return true;
  if (!p.ok) return false;
  if (row.what === 'permission' && row.key) return (RANK[p.permissions?.[row.key] ?? ''] ?? 0) >= RANK.write;
  return true;
}

/** Before an Actions build starts: can the app start workflows on this repo? Fine → true. Not → the card is filed and false. */
export async function preflight(product: string, build: string, slug: string, workflow: string | null): Promise<{ ok: true } | { ok: false; card: string; message: string }> {
  if (!selfHandling()) return { ok: true };
  const p = await probeHook.run(slug);
  if (p.known && !p.ok) {
    const cause: AccessCause = { what: 'install', permission: null, key: null, workflow, status: 404, message: 'not installed' };
    return { ok: false, card: await fileAccessCard(product, build, slug, cause, workflow), message: accessFix(cause, slug) };
  }
  if (p.known && (RANK[p.permissions?.actions ?? ''] ?? 0) < RANK.write) {
    const cause: AccessCause = { what: 'permission', permission: 'Actions: write', key: 'actions', workflow, status: 403, message: 'Resource not accessible by integration' };
    return { ok: false, card: await fileAccessCard(product, build, slug, cause, workflow, p), message: accessFix(cause, slug, fixContext(p, 'actions')) };
  }
  // Fine now: a card left open from before has nothing left to wait for (the build that is starting is the rebuild).
  await resolveAccess(product, 'Studio (access is back)', { rebuild: false });
  return { ok: true };
}

/** Closes a project's open card; `rebuild` starts the builds that failed on it again. */
export async function resolveAccess(product: string, by: string, o: { rebuild?: boolean } = {}): Promise<string[]> {
  const rows = openAccess(product);
  const started: string[] = [];
  for (const r of rows) {
    db.prepare("UPDATE build_access SET status = 'resolved', resolved = ? WHERE id = ? AND status = 'open'").run(Date.now(), r.id);
    if (r.slug) { try { (await import('./ghtoken.ts')).forgetRepoToken(r.slug); } catch { /* none cached */ } }
    if (o.rebuild !== false) {
      for (const b of r.builds) {
        try { await hooks.start(product, { build: b, retry: 1 }); started.push(b); } catch (e: any) { console.warn(`[builds] ${product} ${b}: couldn't rebuild after access came back: ${String(e?.message ?? e).slice(0, 200)}`); }
      }
    }
  }
  if (rows.length) console.log(`[builds] ${product}: GitHub access is back (${by})${started.length ? `, rebuilding ${started.join(', ')}` : ''}`);
  return started;
}

/**
 * Looks at the open cards when the Inbox is opened (inbox.ts): access back → rebuild by itself and resolve. Looks at most
 * once a minute per card, and only at open cards: an Inbox without one makes no request.
 */
export async function recheckAccess(o: { product?: string; force?: boolean } = {}): Promise<{ product: string; back: boolean }[]> {
  const out: { product: string; back: boolean }[] = [];
  for (const r of openAccess(o.product)) {
    if (!o.force && r.checked && Date.now() - r.checked < 60_000) continue;
    db.prepare('UPDATE build_access SET checked = ? WHERE id = ?').run(Date.now(), r.id);
    const back = await accessOk(r).catch(() => false);
    out.push({ product: r.product, back });
    if (back) await resolveAccess(r.product, 'Studio (access is back)');
  }
  return out;
}

/** Links for a card: the installation's settings page (where a new permission is accepted), the app's own permissions, the install page. */
export async function accessLinks(row: AccessRow): Promise<{ label: string; url: string }[]> {
  const links: { label: string; url: string }[] = [];
  try {
    const A = await import('./github-app.ts');
    const app = A.appConfig();
    const p = row.slug ? await probeHook.run(row.slug) : null;
    const manage = p?.manage ?? (p?.installId && p.account ? A.manageUrl(p.installId, p.account, p.type ?? 'User') : null);
    if (manage) links.push({ label: row.what === 'permission' ? 'Installation page on GitHub' : 'The app on this repository', url: manage });
    else {
      const install = (await (await import('./repokit.ts')).linksFor(row.slug)).install ?? A.installUrl();
      if (install) links.push({ label: 'Install the GitHub app', url: install });
    }
    // The app's own Permissions page only when the app doesn't ask for it yet, and only for the app's owner (this Studio's app).
    const asks = row.key && p?.appPermissions ? grants(p.appPermissions, row.key, 'write') : true;
    if (app && row.what === 'permission' && !asks) links.push({ label: "The app's Permissions on GitHub", url: `${A.WEB()}/settings/apps/${app.slug}/permissions` });
  } catch { /* no app here: the card still says what to do */ }
  return links;
}
