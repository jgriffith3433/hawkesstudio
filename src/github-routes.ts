// The routes behind Talk's game tools and the GitHub connection (github-app.ts, repokit.ts, starters.ts):
//   GET  /api/github                    the connection: the app, its installations, the person's GitHub sign-in
//   GET  /api/github/app/setup[?org=]   the page that sends the person to GitHub to make the app (one click there)
//   GET  /api/github/app/created        GitHub's answer to the manifest (state-checked): the app saved, then install it
//   GET  /api/github/installed          where GitHub returns after an install: back to the dashboard
//   GET  /api/github/connect            sign in with GitHub (the app's OAuth), for the signed-in person
//   GET  /api/github/callback           GitHub's sign-in answer (state-checked)
//   DELETE /api/github/user             forget the person's GitHub sign-in
//   POST /api/github/token              a pasted fine-grained token for one repo (the fallback)
//   GET  /api/games/:id/readiness       what a game has and lacks (repokit.readiness)
//   POST /api/games/:id/setup           an Approve card for the outward steps readiness found (J's tap runs them)
//   POST /api/games/new                 an Approve card that makes a new game's repo from a starter
//   GET  /api/games/starters            the starters
// Making the app and pasting tokens are admins' (memberRefusal: /api/github is an admin route) and, in J's Studio, the
// platform admin's (lockdown.ts). The cards are J's tap (approvals.ts).

import type http from 'node:http';
import { StudioError } from './config.ts';
import * as G from './github-app.ts';
import { requester, sessionUser, cookieToken, platformBearerUser } from './auth.ts';
import { flowPage, backTo } from './github-pages.ts';

type Send = (res: http.ServerResponse, status: number, body: unknown) => void;

const baseOf = (req: http.IncomingMessage) =>
  (process.env.STUDIO_PUBLIC_URL || (req.headers['x-forwarded-host'] ? `https://${req.headers['x-forwarded-host']}` : `http://${req.headers.host ?? '127.0.0.1'}`)).replace(/\/+$/, '');

const html = (res: http.ServerResponse, status: number, body: string) => {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};
const redirect = (res: http.ServerResponse, to: string) => { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); };

/**
 * Whose GitHub sign-in a request means: the signed-in person, else (Talk and the agents have none) the admin who
 * linked GitHub. In J's Studio that is J.
 */
export async function githubUserFor(req: http.IncomingMessage): Promise<string | null> {
  // A person signed in to Studio: their own GitHub (their status shows their own connect link until they sign in).
  const person = sessionUser(cookieToken(req)) ?? platformBearerUser(req);
  if (person) return person.id;
  // Talk, agents and Studio's own keys (the owner key, scripts) have no GitHub of their own: they use whoever signed in
  // here, an admin first (2026-10-30: the owner key never reached J's sign-in, so making a game said nobody had).
  const key = requester(req)?.id ?? null;
  if (G.appConfig()) return (key && G.isLinked(key) ? key : G.linkedAdmin()) ?? key;
  // A customer's Studio: the control plane keeps its people's GitHub sign-ins; Talk uses the first one's.
  const cell = await (await import('./cellside.ts')).cellGithub().catch(() => null);
  return cell?.linked?.[0] ?? key;
}

export async function handleGithubRoutes(req: http.IncomingMessage, res: http.ServerResponse, route: string, method: string, url: URL, send: Send, readJson: (r: http.IncomingMessage) => Promise<any>, origin: string | null): Promise<boolean> {
  const base = baseOf(req);
  if (route === '/api/github' && method === 'GET') return send(res, 200, await G.githubStatus(base, (await githubUserFor(req)))), true;
  if (route === '/api/github/app/setup' && method === 'GET') {
    // Anyone signed in to this Studio may connect it (J, 2026-10-30: "You shouldn't have to be admin to do this"). It is
    // made once: with an app already here the link goes straight to installing it, so nobody replaces it this way.
    if (!requester(req)) return redirect(res, `/auth/signin?next=${encodeURIComponent(`${route}${url.search}`)}`), true;
    if (G.appConfig()) return redirect(res, G.installUrl()!), true;
    // A customer's Studio shares Hawkes Studio's app: straight to installing it, with this org signed into the link.
    const cell = await (await import('./cellside.ts')).cellGithub(`${base}/`).catch(() => null);
    if (cell) {
      if (!cell.install) throw new StudioError("GitHub isn't set up for Studio yet: Hawkes Studio's team turns it on.", 409);
      return redirect(res, cell.install), true;
    }
    return html(res, 200, G.setupPage(base, url.searchParams.get('org'))), true;
  }
  if (route === '/api/github/app/created' && method === 'GET') {
    const r = await G.appCreated(String(url.searchParams.get('code') ?? ''), String(url.searchParams.get('state') ?? ''));
    return redirect(res, r.install!), true;
  }
  if (route === '/api/github/installed' && method === 'GET') {
    return html(res, 200, flowPage({ title: 'GitHub is connected', text: 'Studio can work on the repositories you chose. Taking you back…', done: ['signin', 'repos'], at: 'back', next: backTo(base, 'installed'), nextLabel: 'Back to Studio' })), true;
  }
  if (route === '/api/github/connect' && method === 'GET') {
    const u = requester(req);
    if (!u) return redirect(res, `/auth/signin?next=${encodeURIComponent(route)}`), true;
    // A customer's Studio: sign in through Hawkes Studio's app (the control plane keeps it under this org).
    if (!G.appConfig()) {
      const cell = await (await import('./cellside.ts')).cellGithub(`${base}/`, u.id).catch(() => null);
      if (cell?.connect) return redirect(res, cell.connect), true;
      // Already signed in: on to choosing repositories when none are chosen yet, else straight back.
      if (cell?.user) return redirect(res, !cell.installations.length && cell.install ? cell.install : backTo(base, 'connected')), true;
    }
    // No app yet: make it first, then come back here (one link does both).
    if (!G.appConfig()) return redirect(res, '/api/github/app/setup'), true;
    return redirect(res, G.connectUrl(base, u.id)), true;
  }
  if (route === '/api/github/callback' && method === 'GET') {
    let r: Awaited<ReturnType<typeof G.userCallback>>;
    try {
      r = await G.userCallback(base, String(url.searchParams.get('code') ?? ''), String(url.searchParams.get('state') ?? ''), url.searchParams.get('installation_id'), requester(req)?.id ?? null);
    } catch (e: any) {
      // GitHub sent them back with something Studio can't use: the same card, saying what happened, with a way back.
      return html(res, e.status && e.status < 500 ? e.status : 400, flowPage({ title: "That didn't work", text: String(e.message ?? e), tone: 'error', back: base, next: null })), true;
    }
    const studio = r.back ?? `${base}/`;
    // An install linked to a customer's Studio (or J's own): done, back to the Studio.
    if (r.account && r.org) return html(res, 200, flowPage({ title: 'GitHub is connected', text: `Studio can work on the repositories you chose in ${r.account}. Taking you back to your Studio…`, done: ['signin', 'repos'], at: 'back', next: backTo(studio, 'installed'), nextLabel: 'Back to your Studio' })), true;
    // Installed before signing in with GitHub from a Studio: one step left, from their Studio (its front door finds it).
    if ((r as any).unlinked) return html(res, 200, flowPage({ title: 'Installed', text: `Hawkes Studio is installed on ${r.account ?? 'your account'}. One step left: sign in with GitHub from your Studio, and it links by itself.`, done: ['repos'], at: 'signin', next: `${base}/`, nextLabel: 'Go to your Studio', delayMs: 3000 })), true;
    // Signed in: an install their account made before is linked now; then on to choosing repositories when none are
    // chosen yet, else back to the Studio.
    if (r.org && r.user) await G.syncOrgInstallations(r.org, r.user).catch(() => []);
    const installed = r.org ? (await G.orgInstallations(r.org).catch(() => [])).length > 0 : (await G.installations().catch(() => [])).length > 0;
    const install = G.installUrl();
    if (!installed && install) return html(res, 200, flowPage({ title: `Signed in as ${r.login}`, text: 'Next, choose which repositories Studio may work on. Taking you to GitHub…', done: ['signin'], at: 'repos', next: install, nextLabel: 'Choose repositories', back: studio })), true;
    return html(res, 200, flowPage({ title: `Signed in as ${r.login}`, text: 'Your GitHub is connected. Taking you back to your Studio…', done: ['signin', 'repos'], at: 'back', next: backTo(studio, 'connected'), nextLabel: 'Back to your Studio' })), true;
  }
  // Disconnecting GitHub: the signed-in person's sign-in forgotten and revoked on GitHub; ?installations=1 (an admin's)
  // also stops this Studio using the repos it was given. In a customer's Studio the control plane does it.
  if (route === '/api/github/user' && method === 'DELETE') {
    // The signed-in person, or for Talk (no person; it acts only when they ask) the one whose GitHub it uses.
    const u = requester(req);
    const who = u?.id ?? (await githubUserFor(req));
    if (!who) throw new StudioError('Nobody here is signed in with GitHub.', 404);
    const all = url.searchParams.get('installations') === '1';
    if (all && u && u.role !== 'admin') throw new StudioError('Only an admin of this Studio can stop it using the repositories.', 403);
    const before = await G.githubStatus(base, who).catch(() => null);
    const r = G.appConfig() ? await G.disconnectUser(who, null, {}) : await (await import('./cellside.ts')).cellGithubDisconnect(who, all);
    (await import('./ghtoken.ts')).forgetRepoTokens();
    // Where to remove Studio from GitHub itself (only the person can, on GitHub).
    return send(res, 200, { disconnected: true, ...r, removeOnGitHub: (before?.installations ?? []).map((i: any) => ({ account: i.account, url: i.manage })) }), true;
  }
  if (route === '/api/github/token' && method === 'POST') {
    const b = await readJson(req);
    return send(res, 200, await G.savePastedToken(String(b.repo ?? ''), String(b.token ?? ''))), true;
  }
  if (route === '/api/games/starters' && method === 'GET') {
    const { STARTERS } = await import('./starters.ts');
    return send(res, 200, { starters: STARTERS }), true;
  }
  const by = async (b: any) => (await import('./inbox.ts')).actor(req, b?.by);
  const card = async (target: string, plan: unknown, b: any) => {
    const ap = await import('./approvals.ts');
    const a = await ap.requestApproval('github', target, { plan }, { by: await by(b), conversation: origin ?? (typeof b?.conversation === 'string' && /^t_[0-9a-f]{6,32}$/.test(b.conversation) ? b.conversation : null) });
    return ap.getApproval(a.id);
  };
  if (route === '/api/games/new' && method === 'POST') {
    const b = await readJson(req);
    const user = (await githubUserFor(req));
    if (!user) throw new StudioError('Nobody has signed in with GitHub here yet: open /api/github/connect (studio_github connect) first.', 409);
    const { newGamePlan } = await import('./repokit.ts');
    const plan = await newGamePlan(b, user);
    return send(res, 200, await card(`new:${plan.kind === 'new' ? plan.id : ''}`, plan, b)), true;
  }
  const m = /^\/api\/games\/([a-z][a-z0-9-]{1,39})\/(readiness|setup|status|contract)$/.exec(route);
  if (m && m[2] === 'status' && method === 'GET') {
    const { gameStatus } = await import('./repokit.ts');
    return send(res, 200, await gameStatus(m[1], base, (await githubUserFor(req)))), true;
  }
  if (m && m[2] === 'contract' && method === 'POST') {
    // An agent adds Studio's playtest bot (a pull request into beta, like any task): no card, it changes nothing live.
    const { getProduct } = await import('./config.ts');
    const { contractBrief } = await import('./repokit.ts');
    const p = getProduct(m[1]);
    if (p.contract) throw new StudioError(`${p.name} already speaks Studio's playtest contract.`, 409);
    const b = contractBrief(p);
    const { startTask } = await import('./agents.ts');
    const change = startTask(p.id, b.request, { criteria: b.criteria, title: b.title });
    (await import('./followup.ts')).tagChange(String(change), origin, 'Talk');
    return send(res, 200, { ok: true, change, note: 'An agent is adding the playtest bot; once its change is in beta, mark the game contract: true (studio_game update) and playtest it.' }), true;
  }
  if (m && m[2] === 'readiness' && method === 'GET') {
    const { readiness } = await import('./repokit.ts');
    return send(res, 200, await readiness(m[1], (await githubUserFor(req)))), true;
  }
  if (m && m[2] === 'setup' && method === 'POST') {
    const b = await readJson(req);
    const { readiness } = await import('./repokit.ts');
    const r = await readiness(m[1], (await githubUserFor(req)));
    if (!r.approve) throw new StudioError(r.ready ? `${r.name} is ready: nothing to set up.` : `Nothing Studio can set up on GitHub for ${r.name} right now. Next: ${r.next?.what}${r.next?.fix ? `: ${r.next.fix}` : ''}`, 409);
    return send(res, 200, await card(r.approve.repo!, r.approve, b)), true;
  }
  return false;
}
