// The control plane for customers' Studios (docs/studio-customers.md, section 2). J, 2026-10-29: cells, one Studio per
// customer; studio.hawkesgen.ai is where you sign in to your own; with none, you sign up and subscribe.
//
// It lives in J's Studio (STUDIO_CELLS=on there, never in a cell), because that is what answers studio.hawkesgen.ai:
//   - The front door. Continue with Google on studio.hawkesgen.ai: the platform admin (J) goes to J's Studio as now; anyone
//     else gets a control-plane session (cookie hs_cp, signed with a key derived from the master; never a session in J's
//     Studio) and goes to /auth/start: into their Studio at /o/<org>/, or a short sign-up (name the studio, then the
//     first game or a plan).
//   - The records: accounts and orgs in three tables of J's Studio's own database (cp_orgs, cp_members, cp_config).
//     Why SQLite here rather than Firestore: it is already streamed to Cloud Storage by Litestream, needs no new service,
//     credentials or client library, and the control plane is one process that is always the only writer.
//   - Cells are made lazily: signing up writes only the org record. The Cloud Run service (cellrun.ts) is made when the
//     customer adds their first game or subscribes (billing.ts tells us), never at sign-up.
//   - Hibernation (sweep, from the central cron): an awake cell idle for `idleDays` (no sign-in, no run; default 14) loses
//     its service and keeps its data in the bucket; the next visit makes it again ("waking your studio"). An org with no
//     sign-in for `deleteDays` (90) and no plan is emailed, and its data deleted `warnDays` (14) later unless they return.
//   - One central cron (POST /api/cells/cron, one Cloud Scheduler job): the sweep, then the nightly run of every paying
//     org whose plan has nightly runs (woken first). No scheduler job per customer.
//   - The router's questions (the Worker, server/studio-edge, with the edge key): where an org is, wake it, it was seen.
//   - The cells' questions (each cell, with its cell key): its plan, and its billing (Checkout, cancel, resume, the
//     portal), since the one Stripe webhook arrives here and the Stripe key stays here.
//   - Rolling upgrades: cellrun.ts rollImage (J's Studio first, then every awake cell; hibernated cells wake on J's image).

import crypto from 'node:crypto';
import type http from 'node:http';
import { db } from './db.ts';
import { StudioError } from './config.ts';
import { customerStudio } from './tenancy.ts';
import { deriveKey, isCellKey, isEdgeKey, sealWith, unsealWith, validOrg } from './cellkeys.ts';
import * as R from './cellrun.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS cp_orgs (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_sub TEXT NOT NULL, owner_email TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'new', service TEXT, image TEXT, error TEXT,
    created INTEGER NOT NULL, last_active INTEGER, last_signin INTEGER,
    hibernated_at INTEGER, warned_at INTEGER, deleted_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS cp_members (
    org TEXT NOT NULL, sub TEXT NOT NULL, email TEXT NOT NULL, name TEXT, role TEXT NOT NULL, created INTEGER NOT NULL,
    PRIMARY KEY (org, sub)
  );
  CREATE TABLE IF NOT EXISTS cp_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- Who else may enter an org (its cell reports them: members and open invites, by email; sub once they've signed in).
  CREATE TABLE IF NOT EXISTS cp_access (
    org TEXT NOT NULL, email TEXT NOT NULL, sub TEXT, role TEXT NOT NULL, kind TEXT NOT NULL, updated INTEGER NOT NULL,
    PRIMARY KEY (org, email)
  );
`);
// The org's Hawkes Gen identity: its Gen org (org_<hex>), the user key made for its cell (sealed under a key derived
// from the master: a woken cell gets it again) and that key's client id (disabled when the data is deleted).
for (const c of ['gen_org TEXT', 'gen_client TEXT', 'gen_key TEXT']) {
  try { db.exec(`ALTER TABLE cp_orgs ADD COLUMN ${c}`); } catch { /* already there */ }
}

/** J's Studio is the control plane (and never a cell). */
export const cellsOn = () => process.env.STUDIO_CELLS === 'on' && !customerStudio();

export type OrgState = 'new' | 'creating' | 'awake' | 'hibernated' | 'deleted';
export type Org = { id: string; name: string; ownerSub: string; ownerEmail: string; state: OrgState; service: string | null; image: string | null; error: string | null; created: number; lastActive: number | null; lastSignin: number | null; hibernatedAt: number | null; warnedAt: number | null; deletedAt: number | null; genOrg: string | null; genClient: string | null };
const toOrg = (r: any): Org => ({ id: r.id, name: r.name, ownerSub: r.owner_sub, ownerEmail: r.owner_email, state: r.state, service: r.service, image: r.image, error: r.error, created: r.created, lastActive: r.last_active, lastSignin: r.last_signin, hibernatedAt: r.hibernated_at, warnedAt: r.warned_at, deletedAt: r.deleted_at, genOrg: r.gen_org ?? null, genClient: r.gen_client ?? null });

export const getOrg = (id: string) => { const r = db.prepare('SELECT * FROM cp_orgs WHERE id = ?').get(id); return r ? toOrg(r) : null; };
export const listOrgs = () => (db.prepare(`SELECT * FROM cp_orgs ORDER BY created DESC`).all() as any[]).map(toOrg);
/** The orgs someone may enter: theirs, and those whose cell lists them (a member, or an open invite to their email). */
export const orgsOf = (sub: string, email?: string) => (db.prepare(`SELECT o.* FROM cp_orgs o WHERE o.state != 'deleted' AND (
    o.id IN (SELECT org FROM cp_members WHERE sub = ?)
    OR o.id IN (SELECT org FROM cp_access WHERE sub = ? OR (? != '' AND email = ?))
  ) ORDER BY o.created`).all(sub, sub, (email ?? '').toLowerCase(), (email ?? '').toLowerCase()) as any[]).map(toOrg);
/** The orgs someone owns (the sign-up's limit counts these). */
const ownedBy = (sub: string) => (db.prepare(`SELECT COUNT(*) AS n FROM cp_members WHERE sub = ?`).get(sub) as { n: number }).n;
const setOrg = (id: string, f: Record<string, unknown>) => {
  const keys = Object.keys(f);
  db.prepare(`UPDATE cp_orgs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k] as any), id);
};

// ------------------------------------------------------------------ settings

export type CellsSettings = { idleDays: number; deleteDays: number; warnDays: number };
export const CELLS_DEFAULTS: CellsSettings = { idleDays: 14, deleteDays: 90, warnDays: 14 };

export function cellsSettings(): CellsSettings {
  const r = db.prepare(`SELECT value FROM cp_config WHERE key = 'settings'`).get() as { value: string } | undefined;
  return { ...CELLS_DEFAULTS, ...(r ? JSON.parse(r.value) : {}) };
}

/** The platform admin changes them (POST /api/cells/config). */
export function saveCellsSettings(patch: Partial<CellsSettings>) {
  const cur = cellsSettings();
  for (const k of Object.keys(CELLS_DEFAULTS) as (keyof CellsSettings)[]) {
    if (patch[k] === undefined) continue;
    const n = Number(patch[k]);
    if (!Number.isInteger(n) || n < 1 || n > 3650) throw new StudioError(`${k}: whole days, 1 to 3650`);
    cur[k] = n;
  }
  db.prepare(`INSERT INTO cp_config (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(cur));
  return cur;
}

// ------------------------------------------------------------------ the control plane's session (hs_cp)

export const CP_COOKIE = 'hs_cp';
const CP_DAYS = 30;
export type CpAccount = { sub: string; email: string; name: string | null };

export function cpToken(a: CpAccount, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ ...a, exp: now + CP_DAYS * 86_400_000 })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', deriveKey('cp-session', '*')).update(body).digest('base64url')}`;
}

export function cpAccount(req: http.IncomingMessage, now = Date.now()): CpAccount | null {
  const raw = String(req.headers.cookie ?? '').split(';').map((p) => p.trim()).find((p) => p.startsWith(`${CP_COOKIE}=`))?.slice(CP_COOKIE.length + 1);
  if (!raw) return null;
  const [body, sig] = decodeURIComponent(raw).split('.');
  if (!body || !sig) return null;
  let want: string;
  try { want = crypto.createHmac('sha256', deriveKey('cp-session', '*')).update(body).digest('base64url'); } catch { return null; }
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return v.exp > now && v.sub && v.email ? { sub: String(v.sub), email: String(v.email), name: v.name ?? null } : null;
  } catch { return null; }
}

export const cpCookie = (a: CpAccount | null) => `${CP_COOKIE}=${a ? encodeURIComponent(cpToken(a)) : ''}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${a ? CP_DAYS * 86400 : 0}`;

/**
 * Continue with Google for someone with no account in J's Studio (auth-pages.ts): their control-plane session, and
 * where to go (their Studio, else the sign-up).
 */
export function frontDoor(profile: { email: string; sub: string | null; name: string | null }, now = Date.now(), want?: string | null) {
  if (!profile.sub) throw new StudioError('That Google sign-in has no account id.', 401);
  const a: CpAccount = { sub: profile.sub, email: profile.email.toLowerCase(), name: profile.name };
  const orgs = orgsOf(a.sub, a.email);
  for (const o of orgs) setOrg(o.id, { last_signin: now, warned_at: null });
  // An invite found by email: from now on it is theirs by Google's id too.
  db.prepare(`UPDATE cp_access SET sub = ? WHERE email = ? AND sub IS NULL`).run(a.sub, a.email);
  // Where they were going (a page or link of a Studio, like /api/github/connect) goes on in their own Studio, so a link
  // Talk gave them still works after the front door (2026-10-30: it ended on the Games page instead).
  const path = want && /^\/(?!\/|auth\/|o\/)[^\s]*$/.test(want) && want !== '/' ? want.replace(/^\/+/, '') : '';
  return { cookie: cpCookie(a), next: orgs.length === 1 ? `/o/${orgs[0].id}/${path}` : '/auth/start' };
}

// ------------------------------------------------------------------ orgs

/** The org id for a studio's name: its slug and 4 random hex (unique, never reused, safe in a hostname label). */
export function orgIdFor(name: string) {
  const slug = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '') || 'studio';
  for (let i = 0; i < 20; i++) {
    const id = `${/^[a-z]/.test(slug) ? slug : `s-${slug}`}-${crypto.randomBytes(2).toString('hex')}`.slice(0, 32);
    if (validOrg(id) && !getOrg(id)) return id;
  }
  throw new StudioError('Could not find a free id for that name; try another.', 409);
}

/** Signing up: the account's org record. No Cloud Run service yet (lazily, ensureCell). */
export function createOrg(a: CpAccount, name: string, now = Date.now()) {
  const n = String(name ?? '').trim().slice(0, 60);
  if (n.length < 2) throw new StudioError('Name your studio (2 to 60 characters).');
  if (ownedBy(a.sub) >= 3) throw new StudioError('You already have 3 studios.', 409);
  const id = orgIdFor(n);
  db.prepare(`INSERT INTO cp_orgs (id, name, owner_sub, owner_email, state, created, last_signin) VALUES (?, ?, ?, ?, 'new', ?, ?)`).run(id, n, a.sub, a.email, now, now);
  db.prepare(`INSERT INTO cp_members (org, sub, email, name, role, created) VALUES (?, ?, ?, ?, 'owner', ?)`).run(id, a.sub, a.email, a.name, now);
  return getOrg(id)!;
}

const isMember = (org: string, a: CpAccount) => orgsOf(a.sub, a.email).some((o) => o.id === org);
const isOwner = (org: string, sub: string) => Boolean(db.prepare('SELECT 1 FROM cp_members WHERE org = ? AND sub = ?').get(org, sub));

/**
 * A cell's people, as it reports them (POST /api/cells/self/members, its cell key): its users (email, Google sub, role)
 * and open invites (email, role). Replaces what it said before, so someone removed there can't enter from here.
 */
export function setAccess(org: string, people: { email: string; sub?: string | null; role?: string; kind?: string }[], now = Date.now()) {
  const clean = people.slice(0, 1000).map((p) => ({ email: String(p.email ?? '').trim().toLowerCase(), sub: p.sub ? String(p.sub).slice(0, 255) : null, role: p.role === 'admin' ? 'admin' : 'member', kind: p.kind === 'invite' ? 'invite' : 'member' }))
    .filter((p) => /^[^@\s]+@[^@\s]+$/.test(p.email) && !p.email.endsWith('@accounts.hawkesgen.ai'));
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM cp_access WHERE org = ?').run(org);
    for (const p of clean) db.prepare(`INSERT OR REPLACE INTO cp_access (org, email, sub, role, kind, updated) VALUES (?, ?, ?, ?, ?, ?)`).run(org, p.email, p.sub, p.role, p.kind, now);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return clean.length;
}

// ------------------------------------------------------------------ Hawkes Gen for a cell
// Each org gets its own Gen key (J, 2026-10-29): role user, scoped to its Gen org's projects (org_<hex>, org_<hex>.*),
// asked of Gen with J's Gen owner key (STUDIO_GEN_OWNER_KEY, only in the control plane) and given to the cell with its
// other keys. Gen treats org_* projects as customers': their Claude calls run only on the org's own key or subscription
// (hawkesgen orgsecrets.ts), which the cell's Connect your AI sets through here (setGenAi). Disabled with the data.

const genUrl = () => (process.env.HAWKESGEN_URL ?? '').replace(/\/+$/, '');
const genOwner = () => process.env.STUDIO_GEN_OWNER_KEY?.trim() || '';
const cpSealKey = () => deriveKey('cp-secrets', '*');

/** Gen's API, as J's Gen owner (the control plane only). Tests swap it. */
export let genCall = async (method: string, path: string, body?: unknown): Promise<any> => {
  if (!genUrl() || !genOwner()) throw new StudioError('Hawkes Gen is not set up for customers\' Studios here (HAWKESGEN_URL, STUDIO_GEN_OWNER_KEY).', 503);
  const r = await fetch(`${genUrl()}/v1${path}`, { method, headers: { Authorization: `Bearer ${genOwner()}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new StudioError(`Hawkes Gen answered ${r.status}: ${j.error ?? ''}`, 502);
  return j;
};
export function setGenCall(f: typeof genCall) { genCall = f; }

/** The org's Gen key, made the first time (never at sign-up: with its cell). Returns {genOrg, key}. */
export async function ensureGenKey(orgId: string, o: { dry?: boolean } = {}): Promise<{ genOrg: string; key: string } | null> {
  const org = getOrg(orgId);
  if (!org) return null;
  const genOrg = org.genOrg ?? `org_${crypto.randomBytes(8).toString('hex')}`;
  if (!org.genOrg) setOrg(orgId, { gen_org: genOrg });
  const row = db.prepare('SELECT gen_key FROM cp_orgs WHERE id = ?').get(orgId) as { gen_key: string | null };
  if (row.gen_key) return { genOrg, key: unsealWith(row.gen_key, cpSealKey()) };
  if (R.dryRun(o)) { R.planned.push({ method: 'POST', url: `${genUrl() || '<gen>'}/v1/clients`, body: { name: `Studio cell ${orgId}`, role: 'user', projects: [genOrg, `${genOrg}.*`] } }); return { genOrg, key: 'dry-run' }; }
  const made = await genCall('POST', '/clients', { name: `Hawkes Studio cell ${orgId}`, role: 'user', projects: [genOrg, `${genOrg}.*`] });
  if (!made?.key) throw new StudioError('Hawkes Gen made no key for the cell.', 502);
  setOrg(orgId, { gen_client: made.client?.id ?? made.id ?? null, gen_key: sealWith(String(made.key), cpSealKey()) });
  return { genOrg, key: String(made.key) };
}

/** Disables the org's Gen key and removes its Claude credentials from Gen (its data is being deleted). */
async function revokeGen(org: Org, o: { dry?: boolean }) {
  if (!org.genOrg) return;
  if (R.dryRun(o)) { R.planned.push({ method: 'POST', url: `<gen>/v1/clients/${org.genClient}/disable` }); return; }
  if (org.genClient) await genCall('POST', `/clients/${org.genClient}/disable`);
  for (const kind of ['anthropic', 'claude-subscription']) await genCall('DELETE', `/org/keys/${kind}?org=${org.genOrg}`).catch(() => null);
  setOrg(org.id, { gen_key: null });
}

/** The cell's Connect your AI, mirrored into Gen for its org (reviews and Gen's own Claude calls use it). null removes. */
export async function setGenAi(orgId: string, kind: 'anthropic' | 'claude-subscription', key: string | null) {
  const org = getOrg(orgId);
  if (!org?.genOrg) throw new StudioError('This studio has no Hawkes Gen org yet.', 409);
  return key ? genCall('PUT', `/org/keys/${kind}?org=${org.genOrg}`, { key }) : genCall('DELETE', `/org/keys/${kind}?org=${org.genOrg}`);
}

// ------------------------------------------------------------------ cells: made lazily, hibernated, woken

/** The image new and woken cells run: J's Studio's own (the roll puts it there first), else STUDIO_CELLS_IMAGE. */
export async function currentImage(): Promise<string> {
  const fixed = process.env.STUDIO_CELLS_IMAGE?.trim();
  if (fixed || R.dryRun()) return fixed || 'dry-run/studio:latest';
  const img = await R.serviceImage(R.cellsConfig().studioService);
  if (!img) throw new StudioError("Couldn't read J's Studio's image to start a customer's Studio (set STUDIO_CELLS_IMAGE).", 503);
  return img;
}

/**
 * The first game from the sign-up, left for the cell in its state (onboarding.json): the cell pulls its state before it
 * starts, adds the game through its own onboarding checks (config.ts applyOnboardingSeed) and removes the file.
 */
async function seedGame(org: string, game: Record<string, unknown>, o: { dry?: boolean }) {
  const key = `o/${org}/state/onboarding.json`;
  if (R.dryRun(o)) { R.planned.push({ method: 'PUT', url: `gs://${R.cellsConfig().bucket}/${key}`, body: { game } }); return; }
  const { gcsWrite } = await import('./gcp.ts');
  await gcsWrite(R.cellsConfig().bucket, key, Buffer.from(JSON.stringify({ game })), 'application/json');
}

const making = new Map<string, Promise<Org>>();

/**
 * The org's Cloud Run service exists: made the first time (a first game, a plan) and again after hibernation. One at a
 * time per org. `game` is the first game from the sign-up, seeded before the cell starts.
 */
export function ensureCell(orgId: string, why: string, o: { dry?: boolean; game?: Record<string, unknown> } = {}): Promise<Org> {
  const cur = making.get(orgId);
  if (cur) return cur;
  const p = (async () => {
    const org = getOrg(orgId);
    if (!org) throw new StudioError(`No studio "${orgId}"`, 404);
    if (org.state === 'deleted') throw new StudioError('This studio was deleted.', 410);
    if (o.game) await seedGame(orgId, o.game, o);
    if (org.state === 'awake' && (R.dryRun(o) || (await R.getCell(orgId)))) return org;
    setOrg(orgId, { state: 'creating', error: null });
    try {
      const image = await currentImage();
      const g = await ensureGenKey(orgId, o).catch((e) => { console.warn(`[cells] ${orgId} has no Gen key: ${e.message}`); return null; });
      // Isolated cells (cellrun.ts): its own service account, reaching only its own folder, made before the service.
      if (R.isolated()) await R.ensureCellIdentity(orgId, o);
      const made = await R.createCell(orgId, { sub: org.ownerSub, email: org.ownerEmail }, image, o, undefined, g ?? undefined);
      setOrg(orgId, { state: 'awake', service: made.service, image, hibernated_at: null, last_active: Date.now() });
      console.log(`[cells] ${orgId} is up (${why}${made.dry ? ', dry run' : ''})`);
    } catch (e: any) {
      setOrg(orgId, { state: org.state === 'hibernated' ? 'hibernated' : 'new', error: String(e.message ?? e).slice(0, 500) });
      throw e;
    }
    return getOrg(orgId)!;
  })().finally(() => making.delete(orgId));
  making.set(orgId, p);
  return p;
}

/** Deletes an awake cell's service and keeps its data (it wakes on the next visit). */
export async function hibernate(orgId: string, o: { dry?: boolean } = {}) {
  const org = getOrg(orgId);
  if (!org || org.state !== 'awake') return org;
  await R.deleteCell(orgId, o);
  setOrg(orgId, { state: 'hibernated', hibernated_at: Date.now() });
  console.log(`[cells] ${orgId} hibernated${R.dryRun(o) ? ' (dry run)' : ''}`);
  return getOrg(orgId);
}

/** Someone used the org (a sign-in through the front door, a request through the router, a run). */
export function touch(orgId: string, kind: 'signin' | 'active', now = Date.now()) {
  if (!getOrg(orgId)) return;
  setOrg(orgId, kind === 'signin' ? { last_signin: now, last_active: now, warned_at: null } : { last_active: now });
}

const DAY = 86_400_000;

/** Hibernation and old data: what the cron's sweep does. Returns what it did. */
export async function sweep(o: { dry?: boolean; now?: number; mail?: (to: string, subject: string, text: string) => Promise<unknown> } = {}) {
  const now = o.now ?? Date.now();
  const s = cellsSettings();
  const B = await import('./billing.ts');
  const out = { hibernated: [] as string[], warned: [] as string[], deleted: [] as string[], errors: [] as string[] };
  const mail = o.mail ?? (async (to: string, subject: string, text: string) => (await import('./mail.ts')).sendMail({ to, subject, text }));
  for (const org of listOrgs()) {
    if (org.state === 'deleted') continue;
    try {
      const seen = Math.max(org.lastActive ?? 0, org.lastSignin ?? 0, org.created);
      if (org.state === 'awake' && now - seen > s.idleDays * DAY) {
        await hibernate(org.id, o);
        out.hibernated.push(org.id);
      }
      const signedIn = Math.max(org.lastSignin ?? 0, org.created);
      const paying = Boolean(B.currentSubscription(org.id));
      if (paying || now - signedIn <= s.deleteDays * DAY) continue;
      if (!org.warnedAt) {
        await mail(org.ownerEmail, `Your Hawkes Studio "${org.name}" will be deleted in ${s.warnDays} days`,
          `Nobody has signed in to your studio "${org.name}" for ${s.deleteDays} days, and it has no plan.\n\nWe'll delete it and its data in ${s.warnDays} days. To keep it, sign in once at ${R.cellsConfig().publicUrl}/o/${org.id}/ before then.\n\nHawkes Studio`);
        setOrg(org.id, { warned_at: now });
        out.warned.push(org.id);
      } else if (now - org.warnedAt > s.warnDays * DAY) {
        await deleteOrgData(org.id, o);
        out.deleted.push(org.id);
      }
    } catch (e: any) {
      out.errors.push(`${org.id}: ${e.message ?? e}`);
    }
  }
  return out;
}

/** Deletes the cell and every object under its prefix; the record stays, marked deleted. */
export async function deleteOrgData(orgId: string, o: { dry?: boolean } = {}) {
  await R.deleteCell(orgId, o);
  const org = getOrg(orgId);
  if (org) await revokeGen(org, o);
  const prefix = `o/${orgId}/`;
  const bucket = R.cellsConfig().bucket;
  if (R.dryRun(o)) R.planned.push({ method: 'DELETE', url: `gs://${bucket}/${prefix}*` });
  else {
    const { gcsList, gcsDelete } = await import('./gcp.ts');
    for (const obj of await gcsList(bucket, prefix)) await gcsDelete(bucket, obj.name);
  }
  // Its own account, folder and job grant go with the data (always tried: a cell made while isolated may be deleted after).
  await R.removeCellIdentity(orgId, o).catch((e) => console.warn(`[cells] ${orgId}: removing its identity: ${e.message}`));
  setOrg(orgId, { state: 'deleted', deleted_at: Date.now(), service: null });
  console.log(`[cells] ${orgId}'s data deleted${R.dryRun(o) ? ' (dry run)' : ''}`);
}

/**
 * Moves every cell onto its own service account (the setup's isolation step; docs/studio-customers.md "Isolation"):
 * for each org not deleted, its account, folder and job grant; a running cell then gets a new revision as that account.
 * Hibernated and new ones get it when they are made. Idempotent: run it again any time.
 */
export async function isolateCells(o: { dry?: boolean } = {}) {
  if (!R.isolated() && !R.dryRun(o)) throw new StudioError('Turn isolation on first (STUDIO_CELLS_ISOLATE=1 on this service: cells-setup.mjs step 8).', 409);
  const out = { moved: [] as string[], prepared: [] as string[], errors: [] as string[] };
  for (const org of listOrgs()) {
    if (org.state === 'deleted') continue;
    try {
      const id = await R.ensureCellIdentity(org.id, o);
      if (org.state === 'awake') { await R.setCellAccount(org.id, id.email, o); out.moved.push(`${org.id} → ${id.email}`); }
      else out.prepared.push(org.id);
    } catch (e: any) {
      out.errors.push(`${org.id}: ${e.message ?? e}`);
    }
  }
  return out;
}

/** Nightly runs of every paying org whose plan has them: woken first, then asked (its owner key) to run. */
export async function nightly(o: { dry?: boolean; call?: (url: string, key: string) => Promise<number> } = {}) {
  const B = await import('./billing.ts');
  const { featuresOf } = await import('./entitlements.ts');
  const out = { started: [] as string[], skipped: [] as string[], errors: [] as string[] };
  const call = o.call ?? (async (url: string, key: string) => (await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(120_000) })).status);
  for (const org of listOrgs()) {
    if (org.state === 'deleted' || org.state === 'new') continue;
    const sub = B.currentSubscription(org.id);
    if (!sub || sub.status === 'canceled' || !featuresOf(sub.planId, sub.plan?.maxGames ?? null).features.includes('nightly')) { out.skipped.push(org.id); continue; }
    try {
      await ensureCell(org.id, 'nightly run', o);
      if (R.dryRun(o)) R.planned.push({ method: 'POST', url: `${R.serviceUrl(org.id)}/api/cloud/daily` });
      else {
        const status = await call(`${R.serviceUrl(org.id)}/api/cloud/daily`, deriveKey('owner', org.id));
        if (status >= 300) throw new Error(`the cell answered ${status}`);
      }
      touch(org.id, 'active');
      out.started.push(org.id);
    } catch (e: any) {
      out.errors.push(`${org.id}: ${e.message ?? e}`);
    }
  }
  return out;
}

// ------------------------------------------------------------------ billing for the orgs (the one webhook is here)

/** billing.ts asks whose events are ours, and tells us when an org subscribes (its cell is made then). */
export async function wireBilling() {
  if (!cellsOn()) return;
  (await import('./billing.ts')).setStudioHooks({
    known: (sid) => Boolean(getOrg(sid)),
    subscribed: (sid) => { if (getOrg(sid)) void ensureCell(sid, 'subscribed').catch((e) => console.warn(`[cells] ${sid} after subscribing: ${e.message}`)); },
  });
}

/** What a cell's plan is (GET /api/cells/self). */
export async function cellPlan(orgId: string) {
  const B = await import('./billing.ts');
  const sub = B.currentSubscription(orgId);
  return { org: orgId, plan: sub?.planId ?? 'free', status: sub?.status ?? null, maxGames: sub?.plan?.maxGames ?? null, credits: B.creditBalance(orgId), cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false, periodEnd: sub?.periodEnd ?? null };
}

const orgUrl = (orgId: string) => `${R.cellsConfig().publicUrl}/o/${orgId}`;

async function orgBilling(orgId: string, what: string, b: any) {
  const B = await import('./billing.ts');
  const back = orgUrl(orgId);
  if (what === 'checkout') return B.checkout(String(b.plan ?? ''), { id: String(b.user?.id ?? 'owner'), email: String(b.user?.email ?? getOrg(orgId)?.ownerEmail ?? '') }, back, { sid: orgId, successUrl: `${back}/?checkout=success#settings`, cancelUrl: `${back}/?checkout=cancelled#settings` });
  if (what === 'cancel' || what === 'resume') return { subscription: await B.setCancelAtPeriodEnd(what === 'cancel', orgId) };
  if (what === 'portal') return B.billingPortal(back, { sid: orgId, returnUrl: `${back}/#settings` });
  if (what === 'view') return B.billingView(orgId);
  throw new StudioError('Unknown billing action', 404);
}

// ------------------------------------------------------------------ the routes

const bearer = (req: http.IncomingMessage) => /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? null;

type Send = (res: http.ServerResponse, status: number, body: unknown) => void;
type ReadJson = (req: http.IncomingMessage) => Promise<any>;

/**
 * The routes with their own keys, handled before Studio's guards (server.ts): the router's (/api/cells/edge/*, the edge
 * key), the cells' (/api/cells/self*, the cell's key). true when handled.
 */
export async function handleCellsKeyed(req: http.IncomingMessage, res: http.ServerResponse, route: string, method: string, send: Send, readJson: ReadJson): Promise<boolean> {
  let m = /^\/api\/cells\/edge\/([a-z0-9-]+)(?:\/(wake|seen))?$/.exec(route);
  if (m) {
    if (!cellsOn()) return send(res, 404, { error: 'not the control plane' }), true;
    if (!isEdgeKey(bearer(req))) return send(res, 401, { error: 'edge key' }), true;
    const org = getOrg(m[1]);
    if (!org || org.state === 'deleted') return send(res, 404, { state: 'none' }), true;
    if (m[2] === 'seen' && method === 'POST') { touch(org.id, 'active'); return send(res, 200, { ok: true }), true; }
    if (m[2] === 'wake' && method === 'POST') {
      if (org.state === 'new') return send(res, 200, { state: 'new', next: '/auth/start' }), true;
      void ensureCell(org.id, 'woken by a visit').catch((e) => console.warn(`[cells] waking ${org.id}: ${e.message}`));
      touch(org.id, 'active');
      // Never asleep before: the waking page says it is being set up, not that it was asleep.
      return send(res, 202, { state: getOrg(org.id)!.state, first: !org.hibernatedAt }), true;
    }
    return send(res, 200, { state: org.state, first: !org.hibernatedAt, url: org.state === 'awake' ? R.serviceUrl(org.id) : null, error: org.error }), true;
  }
  if (route === '/api/cells/broker') {
    if (!cellsOn()) return send(res, 404, { error: 'not the control plane' }), true;
    const B = await import('./jobbroker.ts');
    await B.handleBroker(req, res, new URL(req.url ?? route, 'http://x'), await B.defaultBrokerDeps(R.cellsConfig().bucket));
    return true;
  }
  // GitHub through J's app (github-app.ts): a cell's install link and linked installations, and a token for one of its
  // org's repos, scoped to that repo. Never a repo of an installation another org linked.
  const gh = /^\/api\/cells\/self\/(github|github-token|github-user|github-disconnect)$/.exec(route);
  if (gh && method === 'POST') {
    if (!cellsOn()) return send(res, 404, { error: 'not the control plane' }), true;
    const orgId = String(req.headers['x-studio-cell'] ?? '');
    if (!isCellKey(orgId, bearer(req)) || !getOrg(orgId)) return send(res, 401, { error: 'cell key' }), true;
    const b = await readJson(req);
    const G = await import('./github-app.ts');
    try {
      const back = typeof b.back === 'string' && /^https:\/\//.test(b.back) ? b.back : null;
      const user = typeof b.user === 'string' && /^[\w-]{1,64}$/.test(b.user) ? b.user : null;
      if (gh[1] === 'github') {
        const app = G.appConfig();
        // Its people sign in with GitHub here (the app's OAuth comes back to this Studio), kept under the org.
        const base = (process.env.STUDIO_PUBLIC_URL || 'https://studio.hawkesgen.ai').replace(/\/+$/, '');
        const signedIn = user ? await G.userToken(user, orgId).catch(() => null) : null;
        // An install they made before signing in with GitHub here is linked now (their account can reach it).
        if (signedIn && user) await G.syncOrgInstallations(orgId, user).catch(() => []);
        return send(res, 200, {
          app: app ? { slug: app.slug } : null, install: G.installLinkFor(orgId, back), installations: app ? await G.orgInstallations(orgId) : [],
          user: signedIn ? { login: signedIn.login } : null, connect: app && user && !signedIn ? G.connectUrl(base, user, { org: orgId, back }) : null,
          linked: G.orgGithubUsers(orgId),
        }), true;
      }
      if (gh[1] === 'github-disconnect') {
        if (!user) return send(res, 400, { error: 'user' }), true;
        return send(res, 200, await G.disconnectUser(user, orgId, { installations: b.installations === true })), true;
      }
      if (gh[1] === 'github-user') {
        if (!user) return send(res, 400, { error: 'user' }), true;
        return send(res, 200, (await G.userToken(user, orgId)) ?? { token: null }), true;
      }
      const t = await G.orgRepoToken(orgId, String(b.repo ?? ''));
      return send(res, 200, t ?? { token: null }), true;
    } catch (e: any) { return send(res, e.status ?? 400, { error: e.message ?? String(e) }), true; }
  }
  const self = /^\/api\/cells\/self\/(members|ai)$/.exec(route);
  if (self && method === 'POST') {
    if (!cellsOn()) return send(res, 404, { error: 'not the control plane' }), true;
    const orgId = String(req.headers['x-studio-cell'] ?? '');
    if (!isCellKey(orgId, bearer(req)) || !getOrg(orgId)) return send(res, 401, { error: 'cell key' }), true;
    const b = await readJson(req);
    try {
      if (self[1] === 'members') return send(res, 200, { ok: true, people: setAccess(orgId, Array.isArray(b.people) ? b.people : []) }), true;
      const kind = b.kind === 'claude-subscription' ? 'claude-subscription' : 'anthropic';
      return send(res, 200, await setGenAi(orgId, kind, b.key ? String(b.key) : null)), true;
    } catch (e: any) { return send(res, e.status ?? 400, { error: e.message ?? String(e) }), true; }
  }
  m = /^\/api\/cells\/self(?:\/billing\/(checkout|cancel|resume|portal|view))?$/.exec(route);
  if (m) {
    if (!cellsOn()) return send(res, 404, { error: 'not the control plane' }), true;
    const orgId = String(req.headers['x-studio-cell'] ?? '');
    if (!isCellKey(orgId, bearer(req)) || !getOrg(orgId)) return send(res, 401, { error: 'cell key' }), true;
    touch(orgId, 'active');
    if (!m[1]) return send(res, 200, await cellPlan(orgId)), true;
    try { return send(res, 200, await orgBilling(orgId, m[1], method === 'POST' ? await readJson(req) : {})), true; } catch (e: any) {
      return send(res, e.status ?? 400, { error: e.message ?? String(e) }), true;
    }
  }
  return false;
}

/** The platform admin's view and switches (GET /api/cells, POST /api/cells/config|roll|<org>/wake|hibernate). */
export async function handleCellsAdmin(req: http.IncomingMessage, res: http.ServerResponse, route: string, method: string, send: Send, readJson: ReadJson): Promise<boolean> {
  if (route !== '/api/cells' && !route.startsWith('/api/cells/')) return false;
  const { platformAdminOf, lockdownOn } = await import('./lockdown.ts');
  if (lockdownOn() && !platformAdminOf(req)) return send(res, 403, { error: "Customers' Studios: only the platform admin." }), true;
  if (route === '/api/cells' && method === 'GET') {
    return send(res, 200, { on: cellsOn(), settings: cellsSettings(), missing: R.missingConfig(), dryRun: R.dryRun(), orgs: listOrgs() }), true;
  }
  const b = method === 'POST' ? await readJson(req) : {};
  if (route === '/api/cells/config' && method === 'POST') return send(res, 200, { settings: saveCellsSettings(b) }), true;
  if (route === '/api/cells/roll' && method === 'POST') return send(res, 200, await R.rollImage(String(b.image ?? ''), { dry: b.dry === true ? true : undefined })), true;
  if (route === '/api/cells/isolate' && method === 'POST') return send(res, 200, await isolateCells({ dry: b.dry === true ? true : undefined })), true;
  if (route === '/api/cells/sweep' && method === 'POST') return send(res, 200, await sweep({ dry: b.dry === true ? true : undefined })), true;
  const m = /^\/api\/cells\/([a-z0-9-]+)\/(wake|hibernate)$/.exec(route);
  if (m && method === 'POST') return send(res, 200, { org: m[2] === 'wake' ? await ensureCell(m[1], 'woken by the platform admin') : await hibernate(m[1]) }), true;
  return false;
}

/** The central cron (POST /api/cells/cron: Cloud Scheduler's token or the owner key, checked by server.ts). */
export async function cron() {
  // The nightly catch-up: a cell a roll missed (it failed, or the cell woke mid-deploy) comes onto J's Studio's image.
  return { sweep: await sweep(), nightly: await nightly(), roll: await followRoll('nightly').catch((e) => ({ error: String(e.message ?? e) })) };
}

// ------------------------------------------------------------------ rolling every deploy (J, 2026-10-30: "Do roll on every deploy")

let rolling: Promise<unknown> | null = null;
/** Whether a roll of the cells is under way (cloudhost.ts busy keeps the instance up for it). */
export const rollingCells = () => rolling !== null;

/**
 * The awake cells onto the image J's Studio runs now, in the background: after a deploy (Studio starts on a new image)
 * and in the nightly cron. One at a time, each checked healthy, stopping at the first that isn't; J's phone hears only
 * when a roll stops on one. Nothing to do when every awake cell is already on it.
 */
export async function followRoll(why: 'deploy' | 'nightly' = 'deploy', o: { health?: (url: string) => Promise<boolean> } = {}) {
  if (!cellsOn() || process.env.STUDIO_CELLS_DRY_RUN === '1') return { skipped: 'not the control plane' };
  if (rolling) return { skipped: 'a roll is under way' };
  const R = await import('./cellrun.ts');
  const c = R.cellsConfig();
  const image = await R.serviceImage(c.studioService, c);
  if (!image) return { skipped: `couldn't read ${c.studioService}'s image` };
  const behind = (await R.listCells({}, c)).filter((x) => x.image !== image);
  if (!behind.length) return { image, done: [], behind: 0 };
  console.log(`[cells] ${why}: ${behind.length} awake cell(s) onto ${image}`);
  const run = R.rollCells(image, { health: o.health }, c);
  rolling = run;
  try {
    const r = await run;
    if (r.failed) {
      const { notify } = await import('./notify.ts');
      await notify('Customer Studio update stopped', `${r.failed} wasn't healthy on the new version (${image.split(':').pop()}), so the update stopped there; ${r.left.length} other customer Studio(s) stay on the old version until the next deploy or tonight's catch-up.`, { priority: 4, tags: ['warning'] }).catch(() => {});
    }
    return { ...r, behind: behind.length };
  } finally {
    rolling = null;
  }
}

// ------------------------------------------------------------------ the sign-up pages (/auth/start…)

const GAME_ENGINES = ['web', 'unity', 'godot', 'desktop'];

/** /auth/start…: the front door's pages for a control-plane account. true when handled. */
export async function handleStart(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const route = url.pathname;
  if (!route.startsWith('/auth/start')) return false;
  const P = await import('./auth-pages.ts');
  const method = req.method ?? 'GET';
  const a = cpAccount(req);
  if (!a) return P.redirect(res, `/auth/signin?next=${encodeURIComponent('/auth/start')}`), true;
  const orgs = orgsOf(a.sub, a.email);
  const fail = (e: any, back: () => string) => P.html(res, e.status ?? 400, P.page('Hawkes Studio', `<div class="err">${P.esc(e.message ?? e)}</div>${back()}`));
  if (route === '/auth/start/signout' && method === 'POST') return P.redirect(res, '/auth/signin', { 'Set-Cookie': cpCookie(null) }), true;
  if (route === '/auth/start' && method === 'GET') {
    if (!orgs.length) return P.html(res, 200, P.page('Name your studio', nameForm(a))), true;
    return P.html(res, 200, P.page('Your studios', `<h1>Your studios</h1><p>Signed in as ${P.esc(a.email)}.</p>
${orgs.map((o) => o.state === 'new' ? (isOwner(o.id, a.sub) ? `<p><b>${P.esc(o.name)}</b> · <a href="/auth/start/${o.id}">add your first game</a></p>` : `<p><b>${P.esc(o.name)}</b> · <span>not started yet</span></p>`) : `<p><a href="/o/${o.id}/"><b>${P.esc(o.name)}</b></a></p>`).join('')}
${ownedBy(a.sub) < 3 ? '<p><a href="/auth/start/new">Make your own studio</a></p>' : ''}${signOut()}`)), true;
  }
  if (route === '/auth/start/new' && method === 'GET') return P.html(res, 200, P.page('Name your studio', nameForm(a))), true;
  if (route === '/auth/start' && method === 'POST') {
    const f = await P.form(req);
    try {
      const org = createOrg(a, String(f.name ?? ''));
      return P.redirect(res, `/auth/start/${org.id}`), true;
    } catch (e: any) { return fail(e, () => nameForm(a)), true; }
  }
  const m = /^\/auth\/start\/([a-z0-9-]+)(?:\/(game|subscribe))?$/.exec(route);
  if (!m) return false;
  const org = getOrg(m[1]);
  if (!org || !isMember(org.id, a) || org.state === 'deleted') return P.html(res, 404, P.page('Not found', '<h1>Not found</h1><p><a href="/auth/start">Your studios</a></p>')), true;
  if (!m[2] && method === 'GET') {
    if (org.state !== 'new' || !isOwner(org.id, a.sub)) return P.redirect(res, `/o/${org.id}/`), true;
    return P.html(res, 200, P.page('Your first game', await gameForm(org))), true;
  }
  if ((m[2] === 'game' || m[2] === 'subscribe') && !isOwner(org.id, a.sub)) return P.html(res, 403, P.page('Not yours', '<h1>Only its owner starts a studio</h1><p><a href="/auth/start">Your studios</a></p>')), true;
  if (m[2] === 'game' && method === 'POST') {
    const f = await P.form(req);
    // No game yet (J, 2026-10-30: the first 10 minutes): the studio starts empty and Talk opens on making one.
    if (f.make) {
      try {
        await ensureCell(org.id, 'make a game with Talk');
        return P.redirect(res, `/o/${org.id}/?ask=make#talk`), true;
      } catch (e: any) { const back = await gameForm(org); return fail(e, () => back), true; }
    }
    try {
      const name = String(f.name ?? '').trim().slice(0, 80);
      const engine = GAME_ENGINES.includes(String(f.engine)) ? String(f.engine) : 'web';
      const live = String(f.live ?? '').trim();
      if (!name) throw new StudioError("Your game's name, please.");
      if (live && !/^https:\/\/\S+$/.test(live)) throw new StudioError('Where it plays: an https:// address.');
      if (!live && !String(f.repo ?? '').trim()) throw new StudioError('Where it plays (a web address), or its repository.');
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'game';
      await ensureCell(org.id, 'first game', { game: { id: /^[a-z]/.test(id) ? id : `g-${id}`, name, engine, ...(live ? { live } : {}), ...(f.repo ? { repo: String(f.repo).trim().slice(0, 200) } : {}) } });
      return P.redirect(res, `/o/${org.id}/`), true;
    } catch (e: any) { const back = await gameForm(org); return fail(e, () => back), true; }
  }
  if (m[2] === 'subscribe' && method === 'POST') {
    const f = await P.form(req);
    try {
      const r: any = await orgBilling(org.id, 'checkout', { plan: f.plan, user: { id: a.sub, email: a.email } });
      return P.redirect(res, r.url), true;
    } catch (e: any) { return fail(e, () => `<p><a href="/auth/start/${org.id}">Back</a></p>`), true; }
  }
  return false;
}

const htmlText = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function nameForm(a: CpAccount) {
  return `<h1>Name your studio</h1><p>Hi ${a.name ? htmlText(a.name.split(' ')[0]) : 'there'}. Your own Hawkes Studio: it plays your games every day, reviews them and keeps the bugs. Free for one game.</p>
<form method="post" action="/auth/start"><label for="name">Studio name</label><input id="name" name="name" type="text" maxlength="60" required autofocus placeholder="Moonlight Games">
<button type="submit">Next</button></form>
<p style="margin-top:12px"><small>By continuing you agree to Hawkes Studio's <a href="/legal" target="_blank" rel="noopener">terms, privacy policy and refunds</a>.</small></p>${signOut()}`;
}

async function gameForm(org: Org) {
  const { listPlans } = await import('./billing.ts');
  const plans = listPlans();
  const opt = (v: string, l: string) => `<option value="${v}">${l}</option>`;
  const { esc } = await import('./auth-pages.ts');
  return `<h1>${esc(org.name)}: your first game</h1><p>Studio starts when you add a game. It plays it with a bot, has Claude review the video and keeps a backlog of what it finds.</p>
<form method="post" action="/auth/start/${org.id}/game">
<label for="name">Game</label><input id="name" name="name" type="text" maxlength="80" required autofocus>
<label for="engine">Made with</label><select id="engine" name="engine" style="width:100%;padding:12px;border-radius:9px;font-size:16px">${opt('web', 'A web game')}${opt('unity', 'Unity')}${opt('godot', 'Godot')}${opt('desktop', 'A desktop game')}</select>
<label for="live">Where it plays (https://…)</label><input id="live" name="live" type="text" inputmode="url" placeholder="https://mygame.example">
<label for="repo">Or its GitHub repository</label><input id="repo" name="repo" type="text" placeholder="owner/game">
<button type="submit">Start my studio</button></form>
<form method="post" action="/auth/start/${org.id}/game" style="margin-top:10px"><input type="hidden" name="make" value="1"><button type="submit" style="background:transparent;border:1px solid var(--muted);color:inherit">No game yet? Make one with Talk</button></form>
<details style="margin-top:16px"><summary><small>Or pick a plan first</small></summary>
${plans.map((p) => `<form method="post" action="/auth/start/${org.id}/subscribe"><input type="hidden" name="plan" value="${esc(p.id)}"><button type="submit">${esc(p.name)}: $${(p.priceCents / 100).toFixed(0)} a month · ${p.maxGames} games</button></form>`).join('')}
</details>${signOut()}`;
}

const signOut = () => '<form method="post" action="/auth/start/signout"><button type="submit" style="background:transparent;color:var(--muted);margin-top:12px">Sign out</button></form>';
