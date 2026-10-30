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
const done = (title: string, text: string, back = '/') => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>
<body style="font:16px system-ui;max-width:560px;margin:60px auto;padding:0 16px"><h1 style="font-size:22px">${title}</h1><p>${text}</p><p><a href="${back}">Back to Studio</a></p></body>`;

/**
 * Whose GitHub sign-in a request means: the signed-in person, else (Talk and the agents have none) the admin who
 * linked GitHub. In J's Studio that is J.
 */
export function githubUserFor(req: http.IncomingMessage): string | null {
  return requester(req)?.id ?? G.linkedAdmin();
}

export async function handleGithubRoutes(req: http.IncomingMessage, res: http.ServerResponse, route: string, method: string, url: URL, send: Send, readJson: (r: http.IncomingMessage) => Promise<any>, origin: string | null): Promise<boolean> {
  const base = baseOf(req);
  if (route === '/api/github' && method === 'GET') return send(res, 200, await G.githubStatus(base, githubUserFor(req))), true;
  if (route === '/api/github/app/setup' && method === 'GET') {
    // Making the app is an admin's (in J's Studio the platform admin's): it's opened in a browser, so the check is here.
    const u = requester(req);
    const { platformAdminOf } = await import('./lockdown.ts');
    const { customerStudio } = await import('./tenancy.ts');
    if (!u || u.role !== 'admin' || (!customerStudio() && !platformAdminOf(req))) throw new StudioError('Only an admin of this Studio connects it to GitHub.', 403);
    if (G.appConfig()) return redirect(res, G.installUrl()!), true;
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
    if (!u) throw new StudioError('Sign in to Studio first.', 401);
    return redirect(res, G.connectUrl(base, u.id)), true;
  }
  if (route === '/api/github/callback' && method === 'GET') {
    const r = await G.userCallback(base, String(url.searchParams.get('code') ?? ''), String(url.searchParams.get('state') ?? ''));
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
    const user = githubUserFor(req);
    if (!user) throw new StudioError('Nobody has signed in with GitHub here yet: open /api/github/connect (studio_github connect) first.', 409);
    const { newGamePlan } = await import('./repokit.ts');
    const plan = await newGamePlan(b, user);
    return send(res, 200, await card(`new:${plan.kind === 'new' ? plan.id : ''}`, plan, b)), true;
  }
  const m = /^\/api\/games\/([a-z][a-z0-9-]{1,39})\/(readiness|setup)$/.exec(route);
  if (m && m[2] === 'readiness' && method === 'GET') {
    const { readiness } = await import('./repokit.ts');
    return send(res, 200, await readiness(m[1], githubUserFor(req))), true;
  }
  if (m && m[2] === 'setup' && method === 'POST') {
    const b = await readJson(req);
    const { readiness } = await import('./repokit.ts');
    const r = await readiness(m[1], githubUserFor(req));
    if (!r.approve) throw new StudioError(r.ready ? `${r.name} is ready: nothing to set up.` : `Nothing Studio can set up on GitHub for ${r.name} right now. Next: ${r.next?.what}${r.next?.fix ? `: ${r.next.fix}` : ''}`, 409);
    return send(res, 200, await card(r.approve.repo!, r.approve, b)), true;
  }
  return false;
}
