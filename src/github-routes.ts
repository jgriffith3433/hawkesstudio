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
import { requester } from './auth.ts';

type Send = (res: http.ServerResponse, status: number, body: unknown) => void;

const baseOf = (req: http.IncomingMessage) =>
  (process.env.STUDIO_PUBLIC_URL || (req.headers['x-forwarded-host'] ? `https://${req.headers['x-forwarded-host']}` : `http://${req.headers.host ?? '127.0.0.1'}`)).replace(/\/+$/, '');

const html = (res: http.ServerResponse, status: number, body: string) => {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};
const redirect = (res: http.ServerResponse, to: string) => { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const done = (title: string, text: string, back = '/') => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>
<body style="font:16px system-ui;max-width:560px;margin:60px auto;padding:0 16px"><h1 style="font-size:22px">${title}</h1><p>${text}</p><p><a href="${back}">Back to Studio</a></p></body>`;

/**
 * Whose GitHub sign-in a request means: the signed-in person, else (Talk and the agents have none) the admin who
 * linked GitHub. In J's Studio that is J.
 */
export async function githubUserFor(req: http.IncomingMessage): Promise<string | null> {
  const own = requester(req)?.id ?? G.linkedAdmin();
  if (own) return own;
  // A customer's Studio: the control plane keeps its people's GitHub sign-ins; Talk uses the first one's.
  const cell = await (await import('./cellside.ts')).cellGithub().catch(() => null);
  return cell?.linked?.[0] ?? null;
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
    return html(res, 200, done('GitHub is connected', 'Studio can work on the repositories you chose. Go back to Studio and tell Talk which game it is.')), true;
  }
  if (route === '/api/github/connect' && method === 'GET') {
    const u = requester(req);
    if (!u) return redirect(res, `/auth/signin?next=${encodeURIComponent(route)}`), true;
    // A customer's Studio: sign in through Hawkes Studio's app (the control plane keeps it under this org).
    if (!G.appConfig()) {
      const cell = await (await import('./cellside.ts')).cellGithub(`${base}/`, u.id).catch(() => null);
      if (cell?.connect) return redirect(res, cell.connect), true;
      if (cell?.user) {
        const next = cell.installations.length || !cell.install ? '' : ` Next, <a href="${esc(cell.install)}">choose the repositories</a> Studio may work on.`;
        return html(res, 200, done('Signed in with GitHub', `You're signed in as ${esc(cell.user.login)}.${next}`)), true;
      }
    }
    // No app yet: make it first, then come back here (one link does both).
    if (!G.appConfig()) return redirect(res, '/api/github/app/setup'), true;
    return redirect(res, G.connectUrl(base, u.id)), true;
  }
  if (route === '/api/github/callback' && method === 'GET') {
    const r = await G.userCallback(base, String(url.searchParams.get('code') ?? ''), String(url.searchParams.get('state') ?? ''), url.searchParams.get('installation_id'), requester(req)?.id ?? null);
    // An install from a customer's Studio: linked to their org; back to their Studio.
    if (r.org && r.account) return html(res, 200, done('GitHub is connected', `Your Studio can now work on the repositories you chose in ${esc(r.account)}. Go back to your Studio and tell Talk which game it is.`, r.back ?? '/')), true;
    // Installed before signing in with GitHub from a Studio: nothing linked yet.
    if ((r as any).unlinked) return html(res, 200, done('Installed', `Hawkes Studio is installed on ${esc(r.account ?? '')}. To finish, go back to your Studio and choose Sign in with GitHub there: it links this installation by itself.`)), true;
    // A customer's GitHub sign-in: next, choosing the repositories (the install page), unless it's done already.
    if (r.org) {
      const installed = (await G.orgInstallations(r.org).catch(() => [])).length > 0;
      const next = installed ? '' : ` Next, choose which repositories Studio may work on: <a href="${esc(G.installUrl() ?? '')}">choose repositories on GitHub</a>.`;
      return html(res, 200, done('Signed in with GitHub', `Your Studio can now make repositories as ${esc(r.login ?? '')}.${next}`, r.back ?? '/')), true;
    }
    return html(res, 200, done('Signed in with GitHub', `Studio can now make repositories as ${r.login}. Go back to Studio.`)), true;
  }
  if (route === '/api/github/user' && method === 'DELETE') {
    const u = requester(req);
    if (!u) throw new StudioError('Sign in to Studio first.', 401);
    G.disconnectUser(u.id);
    return send(res, 200, { disconnected: true }), true;
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
