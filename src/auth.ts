// Accounts: the sign-in page in front of Studio, Gen's dashboard and the beta sites (Caddy's forward_auth asks
// /auth/check on every request), users and their roles, invites and password resets, and the sign-in log.
//
//   First run: admin@hawkesgen.com with the password "admin". Signing in with it forces a new password before anything
//   else, and "admin" never works again once one is set (only while the account has no password at all).
//   Roles: admin (J: going live, rollbacks, merges into main, money, users) and member (Studio, Talk, the beta sites).
//   Sessions: a random token in an HttpOnly, Secure cookie for .hawkesgen.com; only its SHA-256 is stored, so a copy of
//   the database signs no one in. "Remember this device" keeps it 30 days, otherwise 12 hours.
//   Scripts on J's PC keep the old login (Basic j:<web password>, src/client.ts): checked against WEB_LOGIN_SHA256
//   (deploy.mjs writes it to /etc/hawkes/keys.env), and they count as J.
//   Never logged: passwords, tokens, cookies.

import crypto from 'node:crypto';
import type http from 'node:http';
import { db, newId } from './db.ts';
import { StudioError } from './config.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, role TEXT NOT NULL DEFAULT 'member',
    pw_hash TEXT, must_change INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL, last_seen INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, user TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, remember INTEGER NOT NULL DEFAULT 0,
    ip TEXT, ua TEXT, last_seen INTEGER
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user);
  CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'invite', email TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
    user TEXT, token_hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, expires INTEGER NOT NULL, by TEXT,
    used_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0, sent TEXT
  );
  CREATE TABLE IF NOT EXISTS signin_log (
    at INTEGER NOT NULL, email TEXT, ip TEXT, ok INTEGER NOT NULL, reason TEXT, ua TEXT
  );
  CREATE INDEX IF NOT EXISTS signin_log_at ON signin_log(at);
`);

export const DEFAULT_ADMIN = 'admin@hawkesgen.com';
export const COOKIE = 'hawkes_session';
const DOMAIN = process.env.STUDIO_COOKIE_DOMAIN ?? 'hawkesgen.com';
const DAY = 86_400_000;
const SHORT = 12 * 3600_000;
const LONG = 30 * DAY;
const INVITE_DAYS = 7;
const RESET_HOURS = 24;
export const MIN_PASSWORD = 12;

export type Role = 'admin' | 'member';
export type User = { id: string; email: string; name: string | null; role: Role; must_change: boolean; disabled: boolean; created: number; last_seen: number | null; default_password: boolean };

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');

// ------------------------------------------------------------- passwords

/** scrypt (N=2^15, r=8, p=1) with a random salt: "scrypt$<salt>$<hash>", both base64url. */
export function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function checkPassword(pw: string, stored: string | null | undefined) {
  const [kind, salt, hash] = String(stored ?? '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64url');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64url'), want.length, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(want, got);
}

/** Why a new password won't do, or null. */
export function weakPassword(pw: string, email?: string) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 200) return 'That password is too long (200 characters at most).';
  const low = pw.toLowerCase();
  if (low === 'admin' || /^(.)\1+$/.test(pw) || ['password', 'hawkesgen', 'hawkesstudio', '123456789012'].some((w) => low.includes(w))) return 'That password is too easy to guess.';
  if (email && low.includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length > 3) return 'Don\'t use your email name in the password.';
  return null;
}

// ------------------------------------------------------------- users

function toUser(r: any): User {
  return { id: r.id, email: r.email, name: r.name ?? null, role: r.role === 'admin' ? 'admin' : 'member', must_change: !!r.must_change, disabled: !!r.disabled, created: r.created, last_seen: r.last_seen ?? null, default_password: !r.pw_hash };
}

const normEmail = (e: unknown) => String(e ?? '').trim().toLowerCase();
const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

/** The first admin (admin@hawkesgen.com, password "admin" until changed) when there are no users yet. */
export function ensureDefaultAdmin() {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as any).n;
  if (n) return null;
  const id = newId('u');
  db.prepare('INSERT INTO users (id, email, name, role, pw_hash, must_change, created) VALUES (?, ?, ?, ?, NULL, 1, ?)').run(id, DEFAULT_ADMIN, 'J', 'admin', Date.now());
  return id;
}

export function getUser(id: string) {
  const r = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return r ? toUser(r) : null;
}

export function userByEmail(email: string) {
  const r = db.prepare('SELECT * FROM users WHERE email = ?').get(normEmail(email));
  return r ? toUser(r) : null;
}

export function listUsers() {
  return (db.prepare('SELECT * FROM users ORDER BY created').all() as any[]).map(toUser);
}

const admins = () => (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0`).get() as any).n as number;

/** Change a user's role or disabled flag (an admin's call). There is always at least one active admin. */
export function updateUser(id: string, patch: { role?: string; disabled?: boolean; name?: string }, by: User) {
  const u = getUser(id);
  if (!u) throw new StudioError(`No user ${id}`, 404);
  const role = patch.role === undefined ? u.role : patch.role === 'admin' ? 'admin' : patch.role === 'member' ? 'member' : null;
  if (!role) throw new StudioError('role: admin | member');
  const disabled = patch.disabled === undefined ? u.disabled : !!patch.disabled;
  if (u.role === 'admin' && !u.disabled && (role !== 'admin' || disabled) && admins() <= 1) throw new StudioError('That would leave no admin. Make someone else an admin first.', 409);
  if (u.id === by.id && disabled) throw new StudioError('You can\'t disable yourself.', 409);
  db.prepare('UPDATE users SET role = ?, disabled = ?, name = COALESCE(?, name) WHERE id = ?').run(role, disabled ? 1 : 0, patch.name ?? null, id);
  if (disabled) db.prepare('DELETE FROM sessions WHERE user = ?').run(id);
  return getUser(id)!;
}

export function removeUser(id: string, by: User) {
  const u = getUser(id);
  if (!u) throw new StudioError(`No user ${id}`, 404);
  if (u.id === by.id) throw new StudioError('You can\'t remove yourself.', 409);
  if (u.role === 'admin' && !u.disabled && admins() <= 1) throw new StudioError('That would leave no admin.', 409);
  db.prepare('DELETE FROM sessions WHERE user = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return { removed: id };
}

/** Set a user's password (and optionally their email): the forced first change, a reset, or changing it signed in. */
export function setPassword(id: string, pw: string, { email, current }: { email?: string; current?: string } = {}) {
  const r = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
  if (!r) throw new StudioError('No such user', 404);
  if (current !== undefined && r.pw_hash && !checkPassword(current, r.pw_hash)) throw new StudioError('Your current password isn\'t right.', 403);
  const newEmail = email !== undefined && normEmail(email) !== r.email ? normEmail(email) : null;
  if (newEmail) {
    if (!validEmail(newEmail)) throw new StudioError('That email address doesn\'t look right.');
    if (userByEmail(newEmail)) throw new StudioError('Another account already uses that email.', 409);
  }
  const weak = weakPassword(pw, newEmail ?? r.email);
  if (weak) throw new StudioError(weak);
  db.prepare('UPDATE users SET pw_hash = ?, must_change = 0, email = COALESCE(?, email) WHERE id = ?').run(hashPassword(pw), newEmail, id);
  return getUser(id)!;
}

// ------------------------------------------------------------- signing in

const fails = new Map<string, number[]>(); // "ip:<ip>" or "acct:<email>" -> failure times
const IP_LIMIT = 10; // failures per IP per 15 minutes
const ACCT_LIMIT = 5; // failures per account per 15 minutes, then it's locked for the rest of the window
const WINDOW = 15 * 60_000;

function recent(key: string) {
  const now = Date.now();
  const list = (fails.get(key) ?? []).filter((t) => now - t < WINDOW);
  fails.set(key, list);
  return list;
}

export function logSignin(email: string | null, ip: string | null, ok: boolean, reason: string, ua?: string | null) {
  db.prepare('INSERT INTO signin_log (at, email, ip, ok, reason, ua) VALUES (?, ?, ?, ?, ?, ?)').run(Date.now(), email, ip, ok ? 1 : 0, reason, (ua ?? '').slice(0, 200));
  db.prepare('DELETE FROM signin_log WHERE at < ?').run(Date.now() - 90 * DAY);
}

export function signinLog(limit = 100) {
  return db.prepare('SELECT * FROM signin_log ORDER BY at DESC LIMIT ?').all(limit) as any[];
}

/** Email + password -> a user, or a StudioError (429 when rate-limited). Every attempt is logged (never the password). */
export function signIn(emailIn: string, pw: string, meta: { ip?: string | null; ua?: string | null } = {}) {
  const email = normEmail(emailIn);
  const ip = meta.ip ?? null;
  if (recent(`ip:${ip}`).length >= IP_LIMIT) {
    logSignin(email, ip, false, 'too many attempts from this address', meta.ua);
    throw new StudioError('Too many attempts. Wait 15 minutes and try again.', 429);
  }
  if (recent(`acct:${email}`).length >= ACCT_LIMIT) {
    logSignin(email, ip, false, 'account locked for 15 minutes', meta.ua);
    throw new StudioError('Too many attempts for this account. Wait 15 minutes and try again.', 429);
  }
  const r = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
  // The default password works only while the account has never had one (the first admin, before setup).
  const ok = !!r && !r.disabled && (r.pw_hash ? checkPassword(String(pw ?? ''), r.pw_hash) : String(pw ?? '') === 'admin' && r.email === DEFAULT_ADMIN);
  if (!ok) {
    for (const k of [`ip:${ip}`, `acct:${email}`]) fails.set(k, [...recent(k), Date.now()]);
    logSignin(email, ip, false, !r ? 'no such account' : r.disabled ? 'account disabled' : 'wrong password', meta.ua);
    throw new StudioError('That email and password don\'t match.', 401);
  }
  fails.delete(`acct:${email}`);
  logSignin(email, ip, true, r.pw_hash ? 'signed in' : 'signed in with the default password (must set a new one)', meta.ua);
  return toUser(r);
}

export function startSession(user: User, { remember = false, ip, ua }: { remember?: boolean; ip?: string | null; ua?: string | null } = {}) {
  const t = token();
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id, user, created, expires, remember, ip, ua, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sha(t), user.id, now, now + (remember ? LONG : SHORT), remember ? 1 : 0, ip ?? null, (ua ?? '').slice(0, 200), now);
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
  return { token: t, remember };
}

export function endSession(t: string | null) {
  if (t) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha(t));
}

/** Signs a user out everywhere (after a password reset, or when they're disabled or removed). */
export function endSessionsFor(userId: string, except?: string | null) {
  if (except) db.prepare('DELETE FROM sessions WHERE user = ? AND id != ?').run(userId, sha(except));
  else db.prepare('DELETE FROM sessions WHERE user = ?').run(userId);
}

/** The user behind a session token (sliding: a used 12-hour session stays alive), or null. */
export function sessionUser(t: string | null | undefined): User | null {
  if (!t) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sha(t)) as any;
  if (!s) return null;
  const now = Date.now();
  if (s.expires < now) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
    return null;
  }
  const u = getUser(s.user);
  if (!u || u.disabled) return null;
  if (!s.last_seen || now - s.last_seen > 60_000) {
    db.prepare('UPDATE sessions SET last_seen = ?, expires = ? WHERE id = ?').run(now, s.remember ? s.expires : Math.max(s.expires, now + SHORT), s.id);
    db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now, u.id);
  }
  return u;
}

// ------------------------------------------------------------- invites and resets

/** An invite (new user) or a reset (existing user): a single-use link. Returns the link's token once. */
export function createInvite({ email: emailIn, role = 'member', kind = 'invite', by }: { email: string; role?: string; kind?: 'invite' | 'reset'; by: User | null }) {
  const email = normEmail(emailIn);
  if (!validEmail(email)) throw new StudioError('That email address doesn\'t look right.');
  const existing = userByEmail(email);
  if (kind === 'invite' && existing) throw new StudioError(`${email} already has an account.`, 409);
  if (kind === 'reset' && !existing) throw new StudioError(`No account for ${email}.`, 404);
  const r: Role = role === 'admin' ? 'admin' : 'member';
  // A new link replaces any open one for the same address and kind.
  db.prepare(`UPDATE invites SET revoked = 1 WHERE email = ? AND kind = ? AND used_at IS NULL AND revoked = 0`).run(email, kind);
  const t = token();
  const id = newId(kind === 'invite' ? 'inv' : 'rst');
  const expires = Date.now() + (kind === 'invite' ? INVITE_DAYS * DAY : RESET_HOURS * 3600_000);
  db.prepare('INSERT INTO invites (id, kind, email, role, user, token_hash, created, expires, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, kind, email, kind === 'invite' ? r : existing!.role, existing?.id ?? null, sha(t), Date.now(), expires, by?.email ?? null);
  return { id, token: t, email, kind, role: kind === 'invite' ? r : existing!.role, expires };
}

export function listInvites() {
  return (db.prepare(`SELECT id, kind, email, role, created, expires, by, used_at, revoked, sent FROM invites ORDER BY created DESC LIMIT 100`).all() as any[])
    .map((i) => ({ ...i, revoked: !!i.revoked, status: i.used_at ? 'used' : i.revoked ? 'revoked' : i.expires < Date.now() ? 'expired' : 'open' }));
}

export function revokeInvite(id: string) {
  const r = db.prepare('UPDATE invites SET revoked = 1 WHERE id = ? AND used_at IS NULL').run(id);
  if (!r.changes) throw new StudioError(`No open invite ${id}`, 404);
  return { revoked: id };
}

export function markSent(id: string, how: string) {
  db.prepare('UPDATE invites SET sent = ? WHERE id = ?').run(how.slice(0, 200), id);
}

/** An open invite or reset for a link token, or null. */
export function openInvite(t: string | null | undefined) {
  if (!t) return null;
  const i = db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(sha(t)) as any;
  if (!i || i.used_at || i.revoked || i.expires < Date.now()) return null;
  return i as { id: string; kind: 'invite' | 'reset'; email: string; role: Role; user: string | null };
}

/** Uses a link: an invite makes the account, a reset sets the password (and signs that user out everywhere). */
export function acceptInvite(t: string, pw: string, name?: string) {
  const i = openInvite(t);
  if (!i) throw new StudioError('This link has expired or was already used. Ask for a new one.', 410);
  const weak = weakPassword(pw, i.email);
  if (weak) throw new StudioError(weak);
  let user: User;
  if (i.kind === 'invite') {
    if (userByEmail(i.email)) throw new StudioError(`${i.email} already has an account.`, 409);
    const id = newId('u');
    db.prepare('INSERT INTO users (id, email, name, role, pw_hash, must_change, created) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run(id, i.email, String(name ?? '').trim().slice(0, 80) || null, i.role, hashPassword(pw), Date.now());
    user = getUser(id)!;
  } else {
    user = setPassword(i.user!, pw);
    endSessionsFor(user.id);
  }
  db.prepare('UPDATE invites SET used_at = ? WHERE id = ?').run(Date.now(), i.id);
  return user;
}

// ------------------------------------------------------------- requests

export function cookieToken(req: http.IncomingMessage) {
  const raw = String(req.headers.cookie ?? '');
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** The client's address as Caddy saw it. */
export function clientIp(req: http.IncomingMessage) {
  return String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || null;
}

/** Whether the request came through the web (Caddy) for a hawkesgen.com host, so cookies are Secure and domain-wide. */
function onWeb(req: http.IncomingMessage) {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(':')[0].toLowerCase();
  return host === DOMAIN || host.endsWith(`.${DOMAIN}`);
}

export function sessionCookie(req: http.IncomingMessage, value: string, maxAgeMs: number | null) {
  const web = onWeb(req);
  return [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', ...(web ? ['Secure', `Domain=${DOMAIN}`] : []), ...(maxAgeMs === null ? [] : [`Max-Age=${Math.round(maxAgeMs / 1000)}`])].join('; ');
}

/** The old shared login (Basic j:<web password>) from scripts on J's PC: it counts as J (admin). */
function basicLogin(req: http.IncomingMessage) {
  const m = /^Basic\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''));
  const want = process.env.WEB_LOGIN_SHA256;
  if (!m || !want) return false;
  const [user, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
  const got = Buffer.from(sha(rest.join(':')));
  return user === 'j' && got.length === want.length && crypto.timingSafeEqual(got, Buffer.from(want));
}

/** J as a User when the old login was used (no account row: it's J's script). */
const SCRIPT_J: User = { id: 'u_script_j', email: 'j (script login)', name: 'J', role: 'admin', must_change: false, disabled: false, created: 0, last_seen: null, default_password: false };

/** Who sent a request: a signed-in user, J's script login, or null (no account: Talk, agents and Studio's own calls on the server). */
export function requester(req: http.IncomingMessage): User | null {
  return sessionUser(cookieToken(req)) ?? (basicLogin(req) ? SCRIPT_J : null);
}

/**
 * Refuses a signed-in member what only an admin may do: going live, rolling back, merging into main, deciding approvals,
 * money and limits, users. Requests with no account (Studio's own processes, Talk and the agents, who have their own
 * guards in guards.ts) are not this function's business. null when allowed.
 */
export function memberRefusal(req: http.IncomingMessage, route: string, method: string): string | null {
  if (method === 'GET') return null;
  const u = sessionUser(cookieToken(req));
  if (!u || u.role === 'admin') return null;
  const adminOnly = [
    /^\/api\/deploy\//, /^\/api\/rollback\//, /^\/api\/changes\/c_[0-9a-f]+\/approve$/, /^\/api\/approvals\/a_[0-9a-f]+\/(approve|deny)$/,
    /^\/api\/agents\/settings$/, /^\/api\/pm\/settings$/, /^\/api\/settings$/, /^\/api\/costs\/settings$/, /^\/api\/notify$/,
    /^\/api\/inbox\/answer$/, /^\/api\/roadmap\/.*gpu/, /^\/api\/users/, /^\/api\/invites/, /^\/api\/memory\/seed$/,
    // Through the library tab's Gen relay: making and revising takes, and any job, cost money.
    /^\/api\/gen\/v1\/entities\/.+\/(make|revise)$/, /^\/api\/gen\/v1\/(jobs|run|fleet|builder|playtester|settings)/,
  ];
  return adminOnly.some((r) => r.test(route)) ? `Only an admin can do that (you're signed in as ${u.email}, a member).` : null;
}

/** Where to go after signing in: a hawkesgen.com address or a path on this site; anything else goes to Studio. */
export function safeNext(next: unknown, fallback = '/') {
  const s = String(next ?? '');
  if (/^\/(?!\/)/.test(s) && !s.startsWith('/auth/')) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase();
    if (u.protocol === 'https:' && (host === DOMAIN || host.endsWith(`.${DOMAIN}`)) && !u.pathname.startsWith('/auth/')) return u.toString();
  } catch {}
  return fallback;
}

/** The address of Studio's sign-in page (Caddy's forward_auth redirects every hawkesgen.com host there). */
export const signinBase = () => process.env.STUDIO_PUBLIC_URL || `https://studio.${DOMAIN}`;

/**
 * forward_auth (Caddy, every protected request): 200 with X-Hawkes-User / X-Hawkes-Role for a signed-in user (or J's
 * script login); a browser page load without one goes to the sign-in page (302), anything else gets 401. A user who
 * still has to set their password is sent there first.
 */
export function check(req: http.IncomingMessage): { status: number; headers: Record<string, string>; body?: unknown } {
  const proto = String(req.headers['x-forwarded-proto'] ?? 'https');
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '');
  const uri = String(req.headers['x-forwarded-uri'] ?? '/');
  const original = `${proto}://${host}${uri}`;
  const page = String(req.headers['sec-fetch-mode'] ?? '') === 'navigate' || (/text\/html/.test(String(req.headers.accept ?? '')) && String(req.headers['x-forwarded-method'] ?? 'GET') === 'GET');
  const u = requester(req);
  if (u && u.must_change) {
    if (page) return { status: 302, headers: { Location: `${signinBase()}/auth/set-password?next=${encodeURIComponent(original)}` } };
    return { status: 403, headers: {}, body: { error: 'Set a new password first.', signin: `${signinBase()}/auth/set-password` } };
  }
  if (u) return { status: 200, headers: { 'X-Hawkes-User': u.email, 'X-Hawkes-Role': u.role } };
  if (page) return { status: 302, headers: { Location: `${signinBase()}/auth/signin?next=${encodeURIComponent(original)}` } };
  return { status: 401, headers: {}, body: { error: 'Sign in first.', signin: `${signinBase()}/auth/signin` } };
}

/** Seconds a session cookie lives (null: until the browser closes). */
export const cookieAge = (remember: boolean) => (remember ? LONG : null);
