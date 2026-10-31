// The platform admin's features (docs/studio-customers.md, "What only J can do"). Studio's `admin` role is not enough
// for these: customers are admins of their own Studio. Only a platform admin may use them:
//   - J's owner key (STUDIO_OWNER_KEY: his CLI and scripts) or his old script login, or
//   - a session made by Continue with Google (sessions.via = 'google') for an account linked to a Google id, whose email
//     is on STUDIO_PLATFORM_ADMINS (tenancy.ts, default piercehawkes3@gmail.com). A password sign-in never is.
//
// In J's Studio the platform admin is only for managing the platform for customers (J, 2026-10-30: "admin should just be
//   for managing the platform for customers"): customers' Studios (/api/cells: the orgs, hibernation, the roll), the
//   plans and their prices (/api/billing/plans), the waitlist (/api/signups), and Stripe's keys (server.ts). Everything
//   else there, merges, Approve cards, settings, products, users, Claude accounts, going live, is Studio's admin role
//   (auth.ts memberRefusal); Talk and the agents keep their own guards (guards.ts).
//   A session from before sessions recorded how (via empty) counts as Google on Cloud Run, where that is the only way in.
// In a customer's Studio these stay the platform admin's, never its own admins':
//   On Air (/api/broadcast*), Social (/api/social*), the studio's costs and resources (/api/costs*, /api/ledger,
//   /api/resources, /api/brief/cost), self-deploys and restarts (/api/self-deploys, /api/services*), the Antigravity
//   login, seeding the shared memory from J's canon, the plans, customers' Studios, Hawkes Gen's machinery through the
//   library relay (fleet, builder, playtester, settings…), Studio or Gen themselves (infra agents, merging one, its
//   card), and Analytics and Screening for now.
// A customer's admins keep their own: their games, going live with them, their settings, their users, their own Claude.
//
// Who isn't a user (Studio's own calls, Talk and the agents with the agents' key) is guards.ts's business in J's Studio;
// in a customer's Studio nothing without a platform admin reaches these. J's PC (not on the cloud, not a customer's
// Studio) has no lockdown: everyone there is J.

import type http from 'node:http';
import { db } from './db.ts';
import { isInfra } from './config.ts';
import { cloudMode } from './cloudauth.ts';
import { adminOnlyRoute, cookieToken, requester, sessionVia, sessionUnmarked, OWNER_J, SCRIPT_J, type User } from './auth.ts';
import { customerStudio, platformAdmins } from './tenancy.ts';

/** The platform admin behind a request, or null. */
export function platformAdminOf(req: http.IncomingMessage): User | null {
  const u = requester(req);
  if (!u) return null;
  if (u.id === OWNER_J.id || u.id === SCRIPT_J.id) return u;
  if (!u.google || !platformAdmins().includes(u.email.toLowerCase())) return null;
  const token = cookieToken(req);
  // A session made before sessions recorded how (via empty) was a Google sign-in on Cloud Run, where Continue with Google
  // is the only way in (J was refused his own Approve card with one, 2026-10-30).
  return sessionVia(token) === 'google' || (cloudMode() && sessionUnmarked(token)) ? u : null;
}

/** Whether the lockdown applies here at all (not on J's PC). */
export const lockdownOn = () => cloudMode() || customerStudio();

const ALWAYS: [RegExp, string][] = [
  [/^\/api\/broadcast(\/|$)/, 'On Air (the Twitch broadcast)'],
  [/^\/api\/social(\/|$)/, 'Social (YouTube and TikTok)'],
  [/^\/api\/(costs|ledger|resources)(\/|$)/, "The studio's costs and resources"],
  [/^\/api\/brief\/cost$/, "The studio's costs"],
  [/^\/api\/(self-deploys|services)(\/|$)/, 'Self-deploys and restarts'],
  [/^\/api\/memory\/seed$/, 'Seeding the shared memory'],
  [/^\/api\/billing\/plans$/, 'Setting the plans and their prices'],
  [/^\/api\/cells(\/|$)/, "Customers' Studios (the control plane)"],
  [/^\/api\/gen\/v1\/(fleet|machines|builder|playtester|settings|storage|clients|workflows|usage|keys|users)(\/|\?|$)/, "Hawkes Gen's machinery"],
];
/** The change an infra route acts on, when it is a change to Studio or Gen. */
function infraChange(id: string) {
  try {
    const c = db.prepare('SELECT product FROM changes WHERE id = ?').get(id) as { product: string } | undefined;
    return Boolean(c && isInfra(c.product));
  } catch { return false; }
}

/** Running the platform for customers: the one thing the platform admin is for in J's Studio. */
const PLATFORM: [RegExp, string][] = [
  [/^\/api\/cells(\/|$)/, "Customers' Studios (the control plane)"],
  [/^\/api\/billing\/plans$/, 'Setting the plans and their prices'],
  [/^\/api\/signups(\/|$)/, 'The waitlist'],
];

/** What a route is, when it is the platform admin's alone (a short name), else null. */
export function platformFeature(route: string, method: string): string | null {
  // J's Studio: the platform admin is only for managing the platform for customers (J, 2026-10-30: "admin should just
  // be for managing the platform for customers"). Everything else is Studio's admin role (auth.ts memberRefusal), and
  // Talk and the agents keep their own guards (guards.ts).
  if (!customerStudio()) {
    for (const [re, what] of PLATFORM) if (re.test(route)) return what;
    return null;
  }
  for (const [re, what] of ALWAYS) if (re.test(route)) return what;
  if (method !== 'GET') {
    let m = /^\/api\/(?:changes|pm\/(?:merge|revise))\/(c_[0-9a-f]+)(?:\/[\w-]+)?$/.exec(route);
    if (m && infraChange(m[1])) return 'Changing Hawkes Studio or Hawkes Gen';
    m = /^\/api\/approvals\/(a_[0-9a-f]+)\/(approve|deny|dismiss)$/.exec(route);
    if (m) {
      let a: { kind: string; target: string } | undefined;
      try { a = db.prepare('SELECT kind, target FROM approvals WHERE id = ?').get(m[1]) as typeof a; } catch { /* no cards yet */ }
      if (a?.kind === 'merge' && infraChange(a.target)) return 'Changing Hawkes Studio or Hawkes Gen';
    }
  }
  // A customer's Studio: Analytics and Screening are the platform admin's for now (J, 2026-10-30: "lets not handle
  // analytics for customers yet"; Screening "is more of a Gen feature"). Their dashboard hides the tabs (groups.js).
  if (/^\/api\/(analytics|videos)(\/|$)/.test(route)) return 'Analytics and Screening';
  return null;
}

const refusal = (what: string) => `${what}: only the platform admin can do that (Hawkes Studio's owner, signed in with Google), not this Studio's admins.`;

/** null when the request may go on; otherwise why it is refused (403). */
export function platformRefusal(req: http.IncomingMessage, route: string, method: string): string | null {
  if (!lockdownOn()) return null;
  const what = platformFeature(route, method);
  if (!what || platformAdminOf(req)) return null;
  // Studio's own calls, Talk and the agents (no user): guards.ts decides in J's Studio.
  if (!requester(req) && !customerStudio()) return null;
  return refusal(what);
}

/** For a body-dependent case (server.ts): starting an agent on Studio or Gen themselves. null when allowed. */
export function infraRefusal(req: http.IncomingMessage, product: string): string | null {
  // J's Studio: Studio's admin role (the platform admin is only for customers' things); Talk and agents: guards.ts.
  if (!customerStudio()) return null;
  if (!lockdownOn() || !isInfra(product) || platformAdminOf(req)) return null;
  if (!requester(req) && !customerStudio()) return null;
  return refusal('Changing Hawkes Studio or Hawkes Gen');
}

/** What the dashboard hides from this viewer (tabs and boxes of the platform admin's features). */
export function hiddenFor(req: http.IncomingMessage) {
  const admin = !lockdownOn() || Boolean(platformAdminOf(req));
  if (admin) return { platformAdmin: true, hide: [] as string[] };
  // J's Studio: its admins see everything (only the customers' platform pages refuse them); its members don't.
  if (!customerStudio() && requester(req)?.role === 'admin') return { platformAdmin: false, hide: [] as string[] };
  return { platformAdmin: false, hide: ['costs', 'resources', 'social', 'onair', 'services', 'antigravity', ...(customerStudio() ? [] : ['users', 'claude'])] };
}
