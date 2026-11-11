// An auth wall (J, 2026-11-11, finding f_b3bf8e33e26c): a playtest of a gated beta site that landed on Studio's own sign-in
// card, or went on to accounts.google.com, never reached the game. Gen called such a run "done, 0 problems". Studio reads the
// result (the page's final address, its navigations, the text it saw) and ends the run failed with an "auth wall" problem.
// Only a *navigation* to Google counts: a game's own Google button loads accounts.google.com frames and requests all the time.

/** The words on Studio's sign-in card (auth-pages.ts signinPage). */
export const STUDIO_SIGNIN_TEXT = /Hawkes Studio, Gen and the beta sites/i;
const GOOGLE_HOST = /^(?:[a-z0-9-]+\.)*accounts\.google\.com$/i;

const hostOf = (u: unknown): string | null => { try { return new URL(String(u)).hostname; } catch { return null; } };
const urlsIn = (v: unknown): string[] => {
  if (typeof v === 'string') return [v];
  if (v && typeof v === 'object') return urlsIn((v as any).url ?? (v as any).to ?? null);
  return [];
};
const asText = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : (() => { try { return JSON.stringify(v); } catch { return ''; } })());

export type AuthWall = { kind: 'studio-signin' | 'google'; message: string; shot: string | null };

/** The auth wall a playtest result shows, or null. `r` is Gen's result (`job.result`). */
export function authWallOf(r: any): AuthWall | null {
  if (!r || typeof r !== 'object') return null;
  const shots = Array.isArray(r.shots) ? r.shots : [];
  const shot: string | null = shots.length ? (shots[shots.length - 1]?.asset ?? null) : null;
  const events: any[] = Array.isArray(r.events) ? r.events : [];
  // Where the page ended up, and where it went.
  const places = [r.finalUrl, r.pageUrl, r.url, r.page?.url, ...(Array.isArray(r.navigations) ? r.navigations : [])]
    .concat(events.filter((e) => /^(nav|navigat|url|page)/i.test(String(e?.type ?? ''))).map((e) => e.url ?? e.detail))
    .flatMap(urlsIn);
  const google = places.find((u) => { const h = hostOf(u); return !!h && GOOGLE_HOST.test(h); });
  if (google) return { kind: 'google', shot, message: `auth wall: the page went to Google's sign-in (${hostOf(google)}) instead of the game` };
  // What the page said: its title, its text, the walls and notes the bot kept.
  const said = [r.title, r.pageTitle, r.text, r.pageText, r.bodyText, ...events.filter((e) => /wall|note|text|dev-ui/i.test(String(e?.type ?? ''))).map((e) => asText(e.detail)), ...(Array.isArray(r.problems) ? r.problems.map((p: any) => p?.message) : [])];
  if (said.some((x) => typeof x === 'string' && STUDIO_SIGNIN_TEXT.test(x))) {
    return { kind: 'studio-signin', shot, message: `auth wall: the page is Studio's sign-in card ("Hawkes Studio, Gen and the beta sites"), not the game` };
  }
  return null;
}

/** The same result as a failed one: outcome failed and the problem on it. */
export function failedByAuthWall(r: any, wall: AuthWall) {
  const problem = { severity: 'blocker', code: 'auth-wall', message: wall.message, ...(wall.shot ? { shot: wall.shot } : {}) };
  return { ...r, outcome: 'failed', problems: [...(Array.isArray(r?.problems) ? r.problems : []), problem] };
}
