// What a customer's Studio may use on its plan (docs/studio-customers.md, "Billing" and section 4). J, 2026-10-29:
// "Upgrade prompts appear when a free user reaches a pro feature." Free features work; a pro feature answers 402 with
// { upgrade: { feature, plan, planName } } (gated here in the API, not only on the page) and the dashboard turns that
// into an Upgrade button that opens the Stripe Checkout (billing.ts).
//
// The plan comes from:
//   - J's Studio (not a customer's): everything, always
//   - a cell with a control plane (STUDIO_CONTROL_URL, cells.ts): the control plane bills the org, so the cell asks it
//     (GET /api/cells/self with its cell key), cached; refreshPlan() at start and every 5 minutes
//   - any other customer's Studio (owner mode, STUDIO_CUSTOMER=1): its own subscription (billing.ts)

import { StudioError } from './config.ts';
import { customerStudio } from './tenancy.ts';

// Talk is on every plan once the customer linked their own AI (J, 2026-10-30: "it's just an interface for talking with
// LLMs anyways"): it is not a Feature; aiRefusal still waits for their AI.
export type Feature = 'games' | 'nightly' | 'desktop' | 'agents' | 'pm' | 'cloudBuilds';

export const FEATURE_NAMES: Record<Feature, string> = {
  games: 'More games',
  nightly: 'Nightly runs',
  desktop: 'Desktop builds (Windows, Linux)',
  agents: 'Agent fixes',
  pm: 'The PM',
  cloudBuilds: 'Cloud builds',
};

/** What each plan includes (the portal's entitlements, platform-plan 7). Free is no plan. */
export const PLAN_FEATURES: Record<string, { games: number; features: Feature[] }> = {
  free: { games: 1, features: [] },
  studio_indie: { games: 3, features: ['nightly', 'desktop'] },
  studio_team: { games: 10, features: ['nightly', 'desktop', 'agents', 'pm'] },
  studio_studio: { games: 30, features: ['nightly', 'desktop', 'agents', 'pm', 'cloudBuilds'] },
};
const ORDER = ['free', 'studio_indie', 'studio_team', 'studio_studio'];
/** How a plan ranks (a gift and a subscription: the higher wins, cells.ts effectivePlan); unknown plans rank as free. */
export const planRank = (plan: string) => Math.max(0, ORDER.indexOf(plan));
const NAMES: Record<string, string> = { free: 'Free', studio_indie: 'Indie', studio_team: 'Team', studio_studio: 'Studio' };

export type PlanState = { plan: string; status: string | null; maxGames: number | null; from: 'platform' | 'local' | 'control' };

let cellPlan: { state: PlanState; at: number } | null = null;
/** Tests and refreshPlan set what the control plane said. */
export function setCellPlan(s: PlanState | null) { cellPlan = s ? { state: s, at: Date.now() } : null; }

const controlUrl = () => (process.env.STUDIO_CONTROL_URL ?? '').replace(/\/+$/, '');

/** Asks the control plane for this cell's plan (cells.ts /api/cells/self). Failures keep the last answer. */
export async function refreshPlan(): Promise<PlanState | null> {
  const url = controlUrl();
  const org = process.env.STUDIO_ORG;
  const key = process.env.STUDIO_CELL_KEY;
  if (!url || !org || !key) return null;
  try {
    const r = await fetch(`${url}/api/cells/self`, { headers: { Authorization: `Bearer ${key}`, 'X-Studio-Cell': org }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return cellPlan?.state ?? null;
    const j: any = await r.json();
    setCellPlan({ plan: String(j.plan ?? 'free'), status: j.status ?? null, maxGames: j.maxGames ?? null, from: 'control' });
  } catch { /* the control plane is away: keep what we had */ }
  return cellPlan?.state ?? null;
}

/** Keeps a cell's plan fresh (server.ts at start). */
export function startPlanRefresh(every = 5 * 60_000) {
  if (!controlUrl() || !process.env.STUDIO_ORG) return;
  void refreshPlan();
  setInterval(() => void refreshPlan(), every).unref();
}

/** This Studio's plan. */
export async function planState(): Promise<PlanState> {
  if (!customerStudio()) return { plan: 'platform', status: null, maxGames: null, from: 'platform' };
  if (controlUrl() && process.env.STUDIO_ORG) return cellPlan?.state ?? { plan: 'free', status: null, maxGames: null, from: 'control' };
  const s = (await import('./billing.ts')).currentSubscription();
  return { plan: s?.planId ?? 'free', status: s?.status ?? null, maxGames: s?.plan?.maxGames ?? null, from: 'local' };
}

/** A plan's features; a plan J made himself counts as the default plan nearest below it in games. */
export function featuresOf(plan: string, maxGames: number | null = null) {
  if (PLAN_FEATURES[plan]) return { ...PLAN_FEATURES[plan], games: maxGames ?? PLAN_FEATURES[plan].games };
  const nearest = [...ORDER].reverse().find((p) => PLAN_FEATURES[p].games <= (maxGames ?? 1)) ?? 'free';
  return { ...PLAN_FEATURES[nearest], games: maxGames ?? PLAN_FEATURES[nearest].games };
}

/** The cheapest plan with a feature (what the Upgrade button offers). */
export const planFor = (f: Feature) => ORDER.find((p) => p !== 'free' && (f === 'games' || PLAN_FEATURES[p].features.includes(f))) ?? 'studio_studio';

/** Everything the dashboard needs to show a plan and its Upgrade buttons. */
export async function entitlements() {
  const s = await planState();
  if (s.plan === 'platform') return { plan: 'platform', planName: "Hawkes Studio (the owner's)", status: null, games: null, features: Object.keys(FEATURE_NAMES) as Feature[], locked: [] as Feature[], offers: {} as Record<string, { feature: Feature; name: string; plan: string; planName: string }> };
  const f = featuresOf(s.plan, s.maxGames);
  const all = (Object.keys(FEATURE_NAMES) as Feature[]).filter((x) => x !== 'games');
  const locked = all.filter((x) => !f.features.includes(x));
  // What each locked feature upgrades to (the dashboard's greyed-out controls open that Checkout).
  const offers = Object.fromEntries(locked.map((x) => [x, { feature: x, name: FEATURE_NAMES[x], plan: planFor(x), planName: NAMES[planFor(x)] }]));
  return { plan: s.plan, planName: NAMES[s.plan] ?? s.plan, status: s.status, games: f.games, features: f.features, locked, offers };
}

export class UpgradeNeeded extends StudioError {
  upgrade: { feature: Feature; name: string; plan: string; planName: string };
  constructor(feature: Feature, message?: string) {
    const plan = planFor(feature);
    super(message ?? `${FEATURE_NAMES[feature]} ${feature === 'pm' ? 'is' : 'are'} on the ${NAMES[plan]} plan and up. Upgrade to use ${feature === 'games' ? 'more games' : 'it'}.`, 402);
    this.upgrade = { feature, name: FEATURE_NAMES[feature], plan, planName: NAMES[plan] };
  }
}

/**
 * The plan, asked of the control plane again before refusing (a plan just bought or given works at once, not after
 * the 5-minute refresh); at most every 20 seconds.
 */
let lastAsked = 0;
/** Tests: the next refusal asks again. */
export const forgetPlanAsk = () => { lastAsked = 0; };
async function entitlementsBeforeRefusing(ok: (e: Awaited<ReturnType<typeof entitlements>>) => boolean) {
  let e = await entitlements();
  if (!ok(e) && controlUrl() && Date.now() - lastAsked > 20_000) {
    lastAsked = Date.now();
    await refreshPlan();
    e = await entitlements();
  }
  return e;
}

/** Throws UpgradeNeeded unless this Studio's plan includes the feature. */
export async function requireFeature(f: Exclude<Feature, 'games'>) {
  const e = await entitlementsBeforeRefusing((x) => x.plan === 'platform' || x.features.includes(f));
  if (e.plan !== 'platform' && !e.features.includes(f)) throw new UpgradeNeeded(f);
}

/** Throws UpgradeNeeded when adding a game would pass the plan's count. */
export async function requireRoomForGame(current: number) {
  const e = await entitlementsBeforeRefusing((x) => x.games === null || current < x.games);
  if (e.games !== null && current >= e.games) throw new UpgradeNeeded('games', `Your plan includes ${e.games} game${e.games === 1 ? '' : 's'}. Upgrade to add another.`);
}

/** A product that needs desktop builds (a desktop game, or a Windows, Linux or Proton build target). */
export const needsDesktop = (p: { engine?: string; build?: { target?: string } }) => p.engine === 'desktop' || ['windows', 'linux', 'proton'].includes(String(p.build?.target ?? ''));

/**
 * The API's gate (server.ts, after the platform admin's): which pro feature a request uses, or null. Reading is free;
 * starting the work is the feature.
 */
export function featureOfRoute(route: string, method: string): Exclude<Feature, 'games'> | null {
  if (method === 'GET' || method === 'HEAD') return null;
  if (route === '/api/changes' || /^\/api\/findings\/[\w-]+\/fix$/.test(route)) return 'agents';
  if (route.startsWith('/api/pm/') || route === '/api/scouts') return 'pm';
  if (route === '/api/cloud/daily') return 'nightly';
  return null;
}

/** null, or the 402 body for a request on a plan without its feature. Only in a customer's Studio. */
export async function upgradeRefusal(route: string, method: string): Promise<{ error: string; upgrade: UpgradeNeeded['upgrade'] } | null> {
  if (!customerStudio()) return null;
  const f = featureOfRoute(route, method);
  if (!f) return null;
  try { await requireFeature(f); return null; } catch (e: any) {
    if (e instanceof UpgradeNeeded) return { error: e.message, upgrade: e.upgrade };
    throw e;
  }
}

/** Talk, agents and the PM in a customer's Studio need the customer's own AI linked first (ailink.ts); null when ready. */
export async function aiRefusal(route: string, method: string): Promise<{ error: string; connectAi: true } | null> {
  if (!customerStudio()) return null;
  const talk = method !== 'GET' && (route === '/api/talk' || route === '/api/talk/call' || /^\/api\/talk\/[\w-]+\/(send|messages|answer)$/.test(route));
  const f = featureOfRoute(route, method);
  if (!talk && f !== 'agents' && f !== 'pm') return null;
  if (await (await import('./ailink.ts')).aiReady()) return null;
  return { error: 'Connect your AI first (Settings → Your AI): Talk and the agents run on your own AI, never ours.', connectAi: true };
}
