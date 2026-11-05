// The Customers page's API (J, 2026-11-05: "an admin-only Customers page where I can manage them and gift credits").
// Every route here is the platform admin's: checked in this file on every call (adminRefusal), and again by lockdown.ts's
// platformRefusal in front of it. It reuses cells.ts (orgs, suspend state) and billing.ts (the ledger), nothing of its own.
//
//   GET  /api/admin/customers                       every customer studio: owner, plan, credits, created, activity, projects, status
//   GET  /api/admin/customers/<org>                 one: members, the recent ledger, the last 30 days' usage, gift, suspension
//   POST /api/admin/customers/<org>/suspend         {reason}   hibernates it and refuses wake-ups, charges and nightly runs
//   POST /api/admin/customers/<org>/unsuspend
//   POST /api/admin/customers/<org>/gift-credits    {amount, reason, confirm: true, key?}  a labeled admin gift in its ledger
import type http from 'node:http';
import crypto from 'node:crypto';
import { StudioError } from './config.ts';
import { db } from './db.ts';
import * as C from './cells.ts';
import * as Bill from './billing.ts';

type Send = (res: http.ServerResponse, status: number, body: unknown) => unknown;
type ReadJson = (req: http.IncomingMessage) => Promise<any>;

/** null when the caller is the platform admin (or, on J's PC where there's no lockdown, a signed-in admin); else why not (403). */
export async function adminRefusal(req: http.IncomingMessage): Promise<string | null> {
  const { platformAdminOf, lockdownOn } = await import('./lockdown.ts');
  if (platformAdminOf(req)) return null;
  const { requester } = await import('./auth.ts');
  if (!lockdownOn() && requester(req)?.role === 'admin') return null;
  return "Customers: only the platform admin (Hawkes Studio's owner, signed in with Google) can see or change customers' studios.";
}

const DAY = 86_400_000;

/** One studio's row in the list. */
async function row(o: C.Org) {
  const B = Bill;
  const e = await C.effectivePlan(o.id);
  const people = (db.prepare('SELECT COUNT(DISTINCT email) AS n FROM (SELECT email FROM cp_members WHERE org = ? UNION SELECT email FROM cp_access WHERE org = ?)').get(o.id, o.id) as { n: number }).n;
  const last = Math.max(o.lastActive ?? 0, o.lastSignin ?? 0) || null;
  return {
    id: o.id, name: o.name, ownerEmail: o.ownerEmail, state: o.state, status: o.state === 'deleted' ? 'deleted' : o.suspended ? 'suspended' : o.state,
    plan: { id: e.planId, status: e.status }, credits: B.creditBalance(o.id), created: o.created, lastActivity: last,
    projects: o.projects, members: Math.max(people, 1), suspended: o.suspended, error: o.error,
  };
}

export async function listCustomers() {
  return { cellsOn: C.cellsOn(), customers: await Promise.all(C.listOrgs().map(row)), giftMax: C.cellsSettings().giftMaxCredits };
}

export async function customerDetail(id: string) {
  const o = C.getOrg(id);
  if (!o) throw new StudioError(`No studio "${id}"`, 404);
  const B = Bill;
  const members = (db.prepare(`SELECT email, name, role, 'owner' AS kind, created AS since FROM cp_members WHERE org = ?
    UNION ALL SELECT email, NULL, role, kind, updated FROM cp_access WHERE org = ? AND email NOT IN (SELECT email FROM cp_members WHERE org = ?)`).all(id, id, id) as any[]);
  const since = Date.now() - 30 * DAY;
  const usage = B.creditUsage(since, id);
  return {
    ...(await row(o)), genOrg: o.genOrg, image: o.image, hibernatedAt: o.hibernatedAt, gift: o.gift,
    members, ledger: B.creditLedger(50, id),
    usage: { days: 30, byKind: usage, spent: -usage.reduce((a, u) => a + (u.credits < 0 ? u.credits : 0), 0), added: usage.reduce((a, u) => a + (u.credits > 0 ? u.credits : 0), 0) },
    giftMax: C.cellsSettings().giftMaxCredits,
  };
}

export async function suspend(id: string, reason: unknown, by: string) {
  const o = C.getOrg(id);
  if (!o || o.state === 'deleted') throw new StudioError(`No studio "${id}"`, 404);
  const why = String(reason ?? '').trim().slice(0, 200);
  if (why.length < 3) throw new StudioError('reason: say why (3 to 200 characters)', 400);
  C.setOrg(id, { suspended_at: Date.now(), suspended_by: by, suspended_reason: why });
  console.log(`[admin] ${id} suspended by ${by}: ${why}`);
  // Its cell stops now (its data stays); a failure to stop it doesn't undo the suspension, which refuses every wake-up.
  if (o.state === 'awake') await C.hibernate(id).catch((e) => console.warn(`[admin] ${id} did not stop: ${e.message}`));
  return C.getOrg(id)!;
}

export function unsuspend(id: string, by: string) {
  const o = C.getOrg(id);
  if (!o || o.state === 'deleted') throw new StudioError(`No studio "${id}"`, 404);
  C.setOrg(id, { suspended_at: null, suspended_by: null, suspended_reason: null });
  console.log(`[admin] ${id} unsuspended by ${by}`);
  return C.getOrg(id)!;
}

/**
 * A gift of credits: whole credits, 1 to the cap (Settings of the control plane, giftMaxCredits, 100,000 at first), a
 * reason of 3 to 200 characters and an explicit `confirm: true` (the page asks first; the API insists). Written to the
 * org's ledger as kind `admin_gift`, its detail saying who gave it and why (the ledger's own date says when); the
 * balance is read and written in one synchronous transaction, so two gifts can't both start from the same balance.
 * `key` (the page's, one per dialog) makes a double click one gift.
 */
export function giftCredits(id: string, input: { amount?: unknown; reason?: unknown; confirm?: unknown; key?: unknown }, by: string) {
  const o = C.getOrg(id);
  if (!o || o.state === 'deleted') throw new StudioError(`No studio "${id}"`, 404);
  const max = C.cellsSettings().giftMaxCredits;
  const amount = typeof input.amount === 'number' ? input.amount : Number(String(input.amount ?? '').trim() || NaN);
  if (!Number.isInteger(amount) || amount < 1 || amount > max) throw new StudioError(`amount: whole credits, 1 to ${max.toLocaleString('en-US')}`, 400);
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 3 || reason.length > 200) throw new StudioError('reason: say why (3 to 200 characters)', 400);
  if (input.confirm !== true) throw new StudioError('confirm: send confirm true once the gift has been checked', 400);
  const key = typeof input.key === 'string' && /^[\w-]{6,64}$/.test(input.key) ? input.key : crypto.randomBytes(8).toString('hex');
  const detail = `Admin gift from ${by}: ${reason}`.slice(0, 300);
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = Bill.grantCredits(amount, 'admin_gift', detail, `admingift:${id}:${key}`, id);
    db.exec('COMMIT');
    console.log(`[admin] ${id} +${amount} credits (gift) by ${by}: ${reason}`);
    return { org: id, added: r.duplicate ? 0 : amount, duplicate: r.duplicate, credits: r.balance };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** The router (server.ts): true when the route was ours. */
export async function handleAdminApi(req: http.IncomingMessage, res: http.ServerResponse, route: string, method: string, send: Send, readJson: ReadJson): Promise<boolean> {
  if (!/^\/api\/admin(\/|$)/.test(route)) return false;
  const no = await adminRefusal(req);
  if (no) return send(res, 403, { error: no }), true;
  const { platformAdminOf } = await import('./lockdown.ts');
  const { requester } = await import('./auth.ts');
  const by = (platformAdminOf(req) ?? requester(req))?.email ?? 'the platform admin';
  try {
    if (route === '/api/admin/customers' && method === 'GET') return send(res, 200, await listCustomers()), true;
    const m = /^\/api\/admin\/customers\/([a-z0-9-]+)(?:\/(suspend|unsuspend|gift-credits))?$/.exec(route);
    if (!m) return send(res, 404, { error: 'No such admin page.' }), true;
    if (!m[2] && method === 'GET') return send(res, 200, await customerDetail(m[1])), true;
    if (m[2] && method === 'POST') {
      const b = await readJson(req);
      if (m[2] === 'suspend') await suspend(m[1], b.reason, by);
      else if (m[2] === 'unsuspend') unsuspend(m[1], by);
      else return send(res, 200, { ...giftCredits(m[1], b, by), detail: await customerDetail(m[1]) }), true;
      return send(res, 200, await customerDetail(m[1])), true;
    }
    return send(res, 405, { error: 'Method not allowed.' }), true;
  } catch (e: any) {
    return send(res, e.status ?? 400, { error: e.message ?? String(e) }), true;
  }
}
