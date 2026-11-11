// The sign-in pages (/auth/*) and the Users API (/api/users, /api/invites) for auth.ts. The pages are plain HTML forms
// (no script needed), sized for a phone, with the autocomplete hints the iPhone's Passwords app uses to save and fill.

import type http from 'node:http';
import { StudioError } from './config.ts';
import * as A from './auth.ts';
import { requestUser } from './sandbox.ts';
import { cloudMode, googleClientId, verifyGoogleProfile } from './cloudauth.ts';
import { laneOf, makePass, orgPrefix, passReturn, passSetCookie, siteKeys, siteOrg } from './sitekeys.ts';

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Hawkes Studio</title><meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%23101418'/><path d='M8 8v16M24 8v16M8 16h16' stroke='%2333d6a6' stroke-width='3.5' stroke-linecap='round'/></svg>">
<style>
:root{--bg:#0d1115;--card:#161c22;--line:#26303a;--text:#e6edf3;--muted:#8b98a5;--accent:#33d6a6;--bad:#ff7b72}
@media (prefers-color-scheme: light){:root{--bg:#f4f6f8;--card:#fff;--line:#d5dde5;--text:#111820;--muted:#5b6774;--accent:#0f9d74;--bad:#c62828}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--text);font:16px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;padding:16px}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px 24px}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;margin-bottom:18px}.mark{width:30px;height:30px;border-radius:8px;background:#101418;color:var(--accent);display:grid;place-items:center;font-weight:800}
h1{font-size:20px;margin:0 0 6px}p{margin:0 0 16px;color:var(--muted)}label{display:block;font-size:14px;margin:14px 0 6px}
input[type=email],input[type=password],input[type=text]{width:100%;padding:12px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--text);font-size:16px}
input:focus{outline:2px solid var(--accent);outline-offset:1px}.row{display:flex;align-items:center;gap:8px;margin:14px 0 0;font-size:14px;color:var(--muted)}
button{width:100%;margin-top:20px;padding:12px;border:0;border-radius:9px;background:var(--accent);color:#04241a;font-size:16px;font-weight:600;cursor:pointer}
.err{background:color-mix(in srgb,var(--bad) 14%,transparent);color:var(--bad);border-radius:8px;padding:10px 12px;margin:0 0 12px;font-size:14px}
.ok{background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent);border-radius:8px;padding:10px 12px;margin:0 0 12px;font-size:14px}
small{color:var(--muted)}a{color:var(--accent)}
/* GIS Continue with Google: reserved 44px row (no layout jump), full card width on phones, transparent (no white box).
   GIS "large" is 40px; scale to 44px so the tap target matches the phone rules (f_f2966d06e2c3). */
.g-tap{width:100%;min-height:44px;height:44px;margin:4px 0 6px;display:flex;align-items:center;justify-content:center;background:transparent;overflow:hidden}
#g{width:100%;height:40px;background:transparent;line-height:0;transform:scale(1.1);transform-origin:center center}
#g>div,#g iframe{background:transparent!important}
</style></head><body><main><div class="brand"><span class="mark">H</span>Hawkes Studio</div>${body}</main></body></html>`;
}

/** Sent on Studio's own pages. Never no-referrer or same-origin: Google's sign-in button checks the Referer of its
 *  requests against the client's authorized origins, and with none it answers 400 "The given origin is not allowed
 *  for the given client ID" (live, 2026-11-01). strict-origin-when-cross-origin sends other sites only the origin, so no
 *  path or token leaves, and keeps the full same-origin referrer the edge routes a cell's /api/... by. */
export const REFERRER_POLICY = 'strict-origin-when-cross-origin';

/** Google's sign-in opens a popup and watches window.closed. A strict `same-origin` here (or from a proxy) cuts that link;
 *  `same-origin-allow-popups` keeps the page isolated from others yet lets it keep a handle on popups it opens. */
export const COOP = 'same-origin-allow-popups';

export function html(res: http.ServerResponse, status: number, body: string, headers: Record<string, string | string[]> = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': REFERRER_POLICY, 'Cross-Origin-Opener-Policy': COOP, ...headers });
  res.end(body);
}

export function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

export function redirect(res: http.ServerResponse, to: string, headers: Record<string, string | string[]> = {}) {
  res.writeHead(303, { Location: to, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

export async function form(req: http.IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16_384) throw new StudioError('Too much data.', 413);
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (/json/.test(String(req.headers['content-type'] ?? ''))) {
    try { return JSON.parse(raw || '{}'); } catch { throw new StudioError('The body is not JSON'); }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

/** A form posted from another site is refused (the cookie is SameSite=Lax too). */
function sameSite(req: http.IncomingMessage) {
  const o = String(req.headers.origin ?? '');
  if (!o || o === 'null') return true;
  try {
    const h = new URL(o).hostname;
    // Studio's own address too (Cloud Run's run.app, before studio.hawkesgen.ai points at it).
    const self = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(':')[0].toLowerCase();
    return h === 'hawkesgen.ai' || h.endsWith('.hawkesgen.ai') || h === '127.0.0.1' || h === 'localhost' || h === self;
  } catch {
    return false;
  }
}

const meta = (req: http.IncomingMessage) => ({ ip: A.clientIp(req), ua: String(req.headers['user-agent'] ?? '') });

/**
 * Continue with Google (cloudauth.ts), when this Studio has a client id: Google's own button gives the page an ID token,
 * which goes to /auth/google; Studio checks it with Google and signs the account in. The password form stays below it.
 * Locale is forced to English (hl=en + locale:'en') so a Romanian (or any) browser still reads "Continue with Google"
 * like the rest of the card (f_98f714b98705). Theme follows the card (filled_black / outline). The .g-tap row is a
 * full-width 44px tap area with a transparent background so no white box shows on phones (f_f2966d06e2c3).
 */
function googleBlock(next: string) {
  const id = googleClientId();
  if (!id) return '';
  return `<div class="g-tap"><div id="g"></div></div><div class="err" id="gerr" hidden></div><button type="button" id="gbusy" disabled hidden style="margin-top:4px;opacity:.7">Opening Google…</button><button type="button" id="gretry" hidden>Try again</button>
<script src="https://accounts.google.com/gsi/client?hl=en" async onload="hsGoogle()" onerror="var e=document.getElementById('gerr');e.hidden=false;e.textContent='Google sign-in could not load. Check your connection or blockers, then reload.'"></script>
<script>function hsGoogle(){var el=document.getElementById('g');var tap=el&&el.parentElement;var w=tap?Math.floor(tap.getBoundingClientRect().width):0;var dark=!window.matchMedia||!window.matchMedia('(prefers-color-scheme: light)').matches;var phone=!!(window.matchMedia&&window.matchMedia('(pointer: coarse)').matches);var gerr=document.getElementById('gerr'),busy=document.getElementById('gbusy'),retry=document.getElementById('gretry'),waiting=false,done=false;
function show(m){waiting=false;busy.hidden=true;tap.hidden=false;gerr.hidden=false;gerr.className='err';gerr.textContent=m;retry.hidden=false;}
function press(){waiting=true;gerr.hidden=true;retry.hidden=true;tap.hidden=true;busy.hidden=false;}
retry.onclick=function(){gerr.hidden=true;retry.hidden=true;waiting=false;busy.hidden=true;tap.hidden=false;};
function back(){if(waiting&&!done)show('The Google window was closed. Try again.');}
window.addEventListener('focus',function(){if(waiting)setTimeout(back,1200);});
document.addEventListener('visibilitychange',function(){if(!document.hidden&&waiting)setTimeout(back,1200);});
var q=new URLSearchParams(location.search).get('gerr');if(q){gerr.hidden=false;gerr.textContent=q;retry.hidden=false;}
var cfg={client_id:${JSON.stringify(id)},callback:function(r){done=true;fetch('/auth/google',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential:r.credential,next:${JSON.stringify(next)}})}).then(function(x){return x.json().then(function(j){if(x.ok)location.href=j.next||'/';else{done=false;if(j.waitlist){waiting=false;busy.hidden=true;tap.hidden=false;gerr.hidden=false;gerr.className='ok';gerr.textContent=j.error;}else show(j.error||('HTTP '+x.status));}});}).catch(function(){done=false;show('Could not reach Studio. Try again.');});}};
if(phone){cfg.ux_mode='redirect';cfg.login_uri=location.origin+'/auth/google';document.cookie='hs_next='+encodeURIComponent(${JSON.stringify(next)})+'; path=/auth/google; max-age=600; SameSite=None'+(location.protocol==='https:'?'; Secure':'');}
google.accounts.id.initialize(cfg);
google.accounts.id.renderButton(el,{theme:dark?'filled_black':'outline',size:'large',text:'continue_with',shape:'pill',locale:'en',width:Math.min(400,Math.max(200,Math.round((w||320)/1.1))),click_listener:press});tap.addEventListener('pointerdown',press);}</script>
<details style="margin-top:10px"><summary><small>Sign in with a password instead</small></summary>`;
}

/** Email and password on this Studio: off on the cloud lanes once Google sign-in is set up (J, 2026-10-29: "I don't
 *  want to sign in with u/p"); STUDIO_PASSWORD_LOGIN=1 turns them back on. J's scripts use the owner key, not this. */
export const passwordsAllowed = () => !(cloudMode() && googleClientId()) || process.env.STUDIO_PASSWORD_LOGIN === '1';

function signinPage(next: string, error?: string, email = '', notice?: string) {
  const g = googleBlock(next);
  if (g && !passwordsAllowed()) {
    return page('Sign in', `<h1>Sign in</h1><p>Hawkes Studio, Gen and the beta sites.</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}${notice ? `<div class="ok">${esc(notice)}</div>` : ''}${g.replace(/<details[\s\S]*$/, '')}`);
  }
  return page('Sign in', `<h1>Sign in</h1><p>Hawkes Studio, Gen and the beta sites.</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}${notice ? `<div class="ok">${esc(notice)}</div>` : ''}${g}
<form method="post" action="/auth/signin" onsubmit="var b=this.querySelector('button[type=submit]');if(b){b.disabled=true;b.textContent='Signing in…'}">
<input type="hidden" name="next" value="${esc(next)}">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required value="${esc(email)}"${email ? '' : ' autofocus'}>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required${email ? ' autofocus' : ''}>
<label class="row"><input type="checkbox" name="remember" value="1" checked> Remember this device for 30 days</label>
<button type="submit">Sign in</button></form>
<p style="margin:16px 0 0"><small>Forgot your password? Ask an admin to send you a reset link.</small></p>${g ? '</details>' : ''}`);
}

function setPasswordPage(u: A.User, next: string, error?: string) {
  const first = u.default_password;
  return page('Set your password', `<h1>${first ? 'Set up your account' : 'Change your password'}</h1>
<p>${first ? 'You signed in with the default password. Choose your own before going on; "admin" stops working after this.' : `Signed in as ${esc(u.email)}.`}</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="post" action="/auth/set-password">
<input type="hidden" name="next" value="${esc(next)}">
${first ? `<label for="email">Your email (you'll sign in with it)</label><input id="email" name="email" type="email" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" value="${esc(u.email)}" required>` : `<input type="hidden" name="email" value="${esc(u.email)}" autocomplete="username">`}
${first ? '' : '<label for="current">Current password</label><input id="current" name="current" type="password" autocomplete="current-password" required>'}
<label for="password">New password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="${A.MIN_PASSWORD}" required autofocus>
<label for="confirm">New password again</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="${A.MIN_PASSWORD}" required>
<p style="margin:10px 0 0"><small>At least ${A.MIN_PASSWORD} characters. A few random words are easy to type on a phone and hard to guess.</small></p>
<button type="submit">Save password</button></form>`);
}

function invitePage(i: { kind: string; email: string; role: string }, t: string, error?: string) {
  const invite = i.kind === 'invite';
  return page(invite ? 'Join Hawkes Studio' : 'Reset your password', `<h1>${invite ? 'Join Hawkes Studio' : 'Choose a new password'}</h1>
<p>${invite ? `You're invited as ${i.role === 'admin' ? 'an admin' : 'a member'}.` : 'This signs you out on your other devices.'}</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="post" action="/auth/invite">
<input type="hidden" name="token" value="${esc(t)}">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" value="${esc(i.email)}" readonly>
${invite ? '<label for="name">Your name</label><input id="name" name="name" type="text" autocomplete="name" maxlength="80">' : ''}
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="${A.MIN_PASSWORD}" required autofocus>
<label for="confirm">Password again</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="${A.MIN_PASSWORD}" required>
<p style="margin:10px 0 0"><small>At least ${A.MIN_PASSWORD} characters.</small></p>
<button type="submit">${invite ? 'Create my account' : 'Save password'}</button></form>`);
}

function signedInCookie(req: http.IncomingMessage, user: A.User, remember: boolean, via: A.SessionVia = 'password') {
  const s = A.startSession(user, { remember, via, ...meta(req) });
  return A.sessionCookie(req, s.token, A.cookieAge(remember));
}

/** /auth/*: the forward_auth check, signing in and out, setting a password, invites and resets. true when handled. */
export async function handleAuthRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const route = url.pathname;
  const method = req.method ?? 'GET';
  if (!route.startsWith('/auth/') && route !== '/auth') return false;
  // The front door's sign-up pages for customers (cells.ts), on J's Studio when it is the control plane.
  if (route.startsWith('/auth/start')) {
    const C = await import('./cells.ts');
    if (C.cellsOn() && (await C.handleStart(req, res, url))) return true;
  }
  if (route === '/auth/check') {
    const r = A.check(req);
    res.writeHead(r.status, { 'Cache-Control': 'no-store', ...(r.body ? { 'Content-Type': 'application/json' } : {}), ...r.headers });
    res.end(r.body ? JSON.stringify(r.body) : '');
    return true;
  }
  // The beta sites (server/beta-sites, sitekeys.ts): the lane's public key for the Worker, and a pass for a signed-in user.
  if (route === '/auth/sites-key' && method === 'GET') {
    const k = siteKeys();
    if (!k) json(res, 404, { error: 'no beta-site key here (STUDIO_SITES_SEED or STUDIO_OWNER_KEY)' });
    else json(res, 200, { lane: laneOf(), alg: 'Ed25519', key: k.publicKey }, { 'Cache-Control': 'public, max-age=3600' });
    return true;
  }
  // A customer's Studio: its sites live at https://sites.<domain>/o/<org>/ (previews.ts). The pass is handed to the sites
  // Worker in a form it posts (POST /o/<org>/.hawkes-pass), which keeps it on that host under this org's path alone.
  const org = siteOrg();
  if (route === '/auth/pass' && method === 'GET' && org) {
    const domain = process.env.STUDIO_DOMAIN || 'hawkesgen.ai';
    const site = `https://sites.${domain}${orgPrefix(org)}/`;
    const next = String(url.searchParams.get('next') ?? '');
    let back: string | null = null;
    try { const n = new URL(next); if (n.origin === new URL(site).origin && n.pathname.startsWith(new URL(site).pathname)) back = n.toString(); } catch { /* not a URL */ }
    if (!back) { json(res, 400, { error: 'next must be a page of this Studio\'s beta sites' }); return true; }
    const u = A.sessionUser(A.cookieToken(req));
    // Not signed in: sign in, then back to the beta page, which comes here again.
    if (!u || u.must_change) { redirect(res, `/auth/signin?next=${encodeURIComponent(back)}`); return true; }
    let pass: string;
    try { pass = makePass(u.id); } catch (e: any) { json(res, 503, { error: String(e.message ?? e) }); return true; }
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
    html(res, 200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Opening the beta site…</title>
<body style="font:16px system-ui;margin:60px auto;max-width:480px;padding:0 16px"><form method="post" action="${esc(`${site}.hawkes-pass`)}">
<input type="hidden" name="pass" value="${esc(pass)}"><input type="hidden" name="next" value="${esc(back)}">
<p>Opening the beta site…</p><button>Continue</button></form><script>document.forms[0].submit()</script></body>`);
    return true;
  }
  if (route === '/auth/pass' && method === 'GET') {
    const domain = process.env.STUDIO_COOKIE_DOMAIN ?? 'hawkesgen.ai';
    const back = passReturn(url.searchParams.get('next'), domain);
    if (!back) { json(res, 400, { error: 'next must be a beta site of this Studio' }); return true; }
    const u = A.sessionUser(A.cookieToken(req));
    // Not signed in (or a new password first): sign in, then back to the beta page, which comes here again.
    if (!u || u.must_change) {
      const page = new URL(back);
      page.searchParams.delete('__hawkes_pass');
      redirect(res, `/auth/signin?next=${encodeURIComponent(page.toString())}`);
      return true;
    }
    try {
      redirect(res, back, { 'Set-Cookie': passSetCookie(makePass(u.id), domain), 'Cache-Control': 'no-store' });
    } catch (e: any) {
      json(res, 503, { error: String(e.message ?? e) });
    }
    return true;
  }
  // Studio's own beta, for Studio's playtests (playtest-signin.ts): Google's button can't run on the beta address, so the
  // playtest posts a signed token and gets a throwaway member's session. Only the beta lane, never live. With
  // STUDIO_TEST_SIGNIN_SECRET set the token is checked with it; with none (the norm, nothing to copy) the beta asks the
  // allowlisted Studio that signed it (POST /api/signin/verify there), and that Studio spends the one-time nonce.
  if (route === '/auth/test-session' && method === 'POST') {
    if (laneOf() !== 'beta') { json(res, 404, { error: 'No test sign-in here.' }); return true; }
    try {
      const P = await import('./playtest-signin.ts');
      const body = await form(req);
      const secret = process.env.STUDIO_TEST_SIGNIN_SECRET?.trim();
      if (secret) P.checkSigninToken(body, secret, P.isStudioProject(body?.project) ? body.project : process.env.STUDIO_TEST_SIGNIN_PROJECT?.trim() || 'hawkesstudio');
      else await P.verifyViaIssuer(body);
      const u = A.testUser();
      json(res, 200, { ok: true }, { 'Set-Cookie': signedInCookie(req, u, false, 'test') });
    } catch (e: any) {
      json(res, e.status === 403 ? 403 : 401, { error: e.message ?? String(e) });
    }
    return true;
  }
  // GIS redirect mode posts from accounts.google.com; its own g_csrf_token cookie check below protects that route.
  const fromGoogle = route === '/auth/google' && String(req.headers.origin ?? '') === 'https://accounts.google.com';
  if (method === 'POST' && !fromGoogle && !sameSite(req)) {
    json(res, 403, { error: 'That form came from another site.' });
    return true;
  }
  const next = A.safeNext(url.searchParams.get('next'));
  if (route === '/auth/signin' && method === 'GET') {
    const u = A.sessionUser(A.cookieToken(req));
    if (u && !u.must_change) { redirect(res, next); return true; }
    html(res, 200, signinPage(next, undefined, '', url.searchParams.get('out') ? 'You\'re signed out.' : undefined));
    return true;
  }
  if (route === '/auth/signin' && method === 'POST') {
    const f = await form(req);
    const to = A.safeNext(f.next);
    if (!passwordsAllowed()) { html(res, 410, signinPage(to, 'Sign in with Google.')); return true; }
    try {
      const u = A.signIn(f.email, f.password, meta(req));
      const remember = f.remember === '1' || f.remember === 'on';
      const cookie = signedInCookie(req, u, remember);
      redirect(res, u.must_change ? `/auth/set-password?next=${encodeURIComponent(to)}` : to, { 'Set-Cookie': cookie });
    } catch (e: any) {
      html(res, e.status === 429 ? 429 : 401, signinPage(to, e.message, String(f.email ?? '')));
    }
    return true;
  }
  if (route === '/auth/google' && method === 'POST') {
    const f = await form(req);
    // GIS redirect mode (phones): Google posts the credential as a form with its csrf token in a cookie too.
    if (f.g_csrf_token) {
      const ck = /(?:^|;\s*)g_csrf_token=([^;]+)/.exec(String(req.headers.cookie ?? ''))?.[1];
      // login_uri carries no query (Google matches it exactly against the registered redirect URIs), so the page left where to go next in a cookie.
      const nextCk = /(?:^|;\s*)hs_next=([^;]+)/.exec(String(req.headers.cookie ?? ''))?.[1];
      let nextRaw: string | null = url.searchParams.get('next');
      if (!nextRaw && nextCk) { try { nextRaw = decodeURIComponent(nextCk); } catch { nextRaw = null; } }
      const to = A.safeNext(nextRaw);
      try {
        if (!ck || ck !== f.g_csrf_token) throw new StudioError('Sign-in could not be checked. Try again.');
        const u = A.googleUser(await verifyGoogleProfile(String(f.credential ?? '')), meta(req));
        redirect(res, to, { 'Set-Cookie': signedInCookie(req, u, true, 'google') });
      } catch (e: any) {
        redirect(res, `/auth/signin?next=${encodeURIComponent(to)}&gerr=${encodeURIComponent(e.message ?? 'Sign-in failed. Try again.')}`);
      }
      return true;
    }
    let profile: Awaited<ReturnType<typeof verifyGoogleProfile>> | null = null;
    try {
      profile = await verifyGoogleProfile(String(f.credential ?? ''));
      const u = A.googleUser(profile, meta(req));
      json(res, 200, { ok: true, next: A.safeNext(f.next) }, { 'Set-Cookie': signedInCookie(req, u, true, 'google') });
    } catch (e: any) {
      // studio.hawkesgen.ai's front door (cells.ts): someone with no account in J's Studio goes to their own Studio, or
      // signs up for one. Never a session here.
      const C = await import('./cells.ts');
      if (profile && C.cellsOn() && (e instanceof A.Waitlisted || /has no account here/.test(String(e.message)))) {
        const d = C.frontDoor(profile, Date.now(), A.safeNext(f.next, ''));
        json(res, 200, { ok: true, next: d.next }, { 'Set-Cookie': d.cookie });
        return true;
      }
      if (!(e instanceof StudioError)) A.logSignin(null, A.clientIp(req), false, `Google: ${e.message ?? e}`, String(req.headers['user-agent'] ?? ''));
      json(res, e.status === 403 || e.status === 409 ? e.status : 401, { error: e.message ?? String(e), ...(e instanceof A.Waitlisted ? { waitlist: true } : {}) });
    }
    return true;
  }
  // An org cell (platform.ts): hawkesgen.ai's "Open Studio" sends the person here with a platform token (a form POST, or
  // ?token= on a link); it becomes this cell's own session, then on to `next`.
  if (route === '/auth/platform' && (method === 'POST' || method === 'GET')) {
    const P = await import('./platform.ts');
    const f = method === 'POST' ? await form(req) : Object.fromEntries(url.searchParams);
    const t = String(f.token ?? '');
    try {
      if (!P.cellOrg()) throw new Error('This Studio is not an org cell.');
      await P.primeToken(t);
      const u = A.platformUser(P.verifyPlatformToken(t), { ...meta(req), log: true });
      redirect(res, A.safeNext(f.next), { 'Set-Cookie': signedInCookie(req, u, true, 'platform') });
    } catch (e: any) {
      A.logSignin(null, A.clientIp(req), false, `hawkesgen.ai: ${e.message ?? e}`, String(req.headers['user-agent'] ?? ''));
      json(res, e.status === 403 ? 403 : 401, { error: `Couldn't sign you in from hawkesgen.ai: ${e.message ?? e}` });
    }
    return true;
  }
  if (route === '/auth/signout') {
    A.endSession(A.cookieToken(req));
    redirect(res, '/auth/signin?out=1', { 'Set-Cookie': A.sessionCookie(req, '', 0) });
    return true;
  }
  if (route === '/auth/set-password') {
    const t = A.cookieToken(req);
    const u = A.sessionUser(t);
    if (!u) { redirect(res, `/auth/signin?next=${encodeURIComponent(next)}`); return true; }
    if (method === 'GET') { html(res, 200, setPasswordPage(u, next)); return true; }
    const f = await form(req);
    const to = A.safeNext(f.next);
    try {
      if (f.password !== f.confirm) throw new StudioError('The two passwords don\'t match.');
      A.setPassword(u.id, f.password, { email: f.email, current: u.default_password ? undefined : String(f.current ?? '') });
      A.endSessionsFor(u.id, t);
      A.logSignin(A.getUser(u.id)!.email, A.clientIp(req), true, u.default_password ? 'set up the account (default password retired)' : 'changed password', String(req.headers['user-agent'] ?? ''));
      redirect(res, to);
    } catch (e: any) {
      html(res, 400, setPasswordPage(u, to, e.message));
    }
    return true;
  }
  if (route === '/auth/invite') {
    if (method === 'GET') {
      const t = url.searchParams.get('token') ?? '';
      const i = A.openInvite(t);
      html(res, i ? 200 : 410, i ? invitePage(i, t) : page('Link expired', '<h1>This link has expired</h1><p>It was already used, revoked, or is too old. Ask an admin for a new one.</p><p><a href="/auth/signin">Sign in</a></p>'));
      return true;
    }
    const f = await form(req);
    const i = A.openInvite(f.token);
    if (!i) { html(res, 410, page('Link expired', '<h1>This link has expired</h1><p>Ask an admin for a new one.</p>')); return true; }
    try {
      if (f.password !== f.confirm) throw new StudioError('The two passwords don\'t match.');
      const u = A.acceptInvite(f.token, f.password, f.name);
      A.logSignin(u.email, A.clientIp(req), true, i.kind === 'invite' ? 'joined from an invite' : 'reset password from a link', String(req.headers['user-agent'] ?? ''));
      redirect(res, '/', { 'Set-Cookie': signedInCookie(req, u, false, 'invite') });
    } catch (e: any) {
      html(res, 400, invitePage(i, f.token, e.message));
    }
    return true;
  }
  json(res, 404, { error: `No route ${method} ${route}` });
  return true;
}

/** The admin behind a request (a signed-in admin, or J's script login), or a StudioError. Never the agent sandbox. */
function adminOf(req: http.IncomingMessage) {
  if (requestUser(req) === 'agent') throw new StudioError('Users are managed by an admin on the dashboard, not by Talk or an agent.', 403);
  const u = A.requester(req);
  if (!u) throw new StudioError('Sign in as an admin.', 401);
  if (u.role !== 'admin') throw new StudioError('Only an admin manages users.', 403);
  return u;
}

const linkFor = (kind: 'invite' | 'reset', t: string) => `${A.signinBase()}/auth/invite?token=${encodeURIComponent(t)}`;

async function deliver(inv: { id: string; kind: 'invite' | 'reset'; email: string; token: string }, by: A.User) {
  const link = linkFor(inv.kind, inv.token);
  try {
    const { sendMail, linkMail } = await import('./mail.ts');
    await sendMail(linkMail(inv.kind, inv.email, link, by.name ?? by.email));
    A.markSent(inv.id, `emailed ${new Date().toISOString()}`);
    return { link, emailed: true, emailError: null as string | null };
  } catch (e: any) {
    A.markSent(inv.id, `not emailed: ${e.message ?? e}`);
    return { link, emailed: false, emailError: String(e.message ?? e) };
  }
}

/** /api/me, /api/users, /api/invites: the Users tab. true when handled. */
export async function handleUsersApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const route = url.pathname;
  const method = req.method ?? 'GET';
  if (route === '/api/me') {
    const u = A.requester(req);
    const L = await import('./lockdown.ts');
    const T = await import('./tenancy.ts');
    const products = (await import('./config.ts')).loadProducts();
    // What this viewer sees: the platform admin's tabs and boxes are hidden from everyone else; a customer's Studio
    // with no game yet opens onboarding for its admins.
    json(res, 200, {
      user: u ? { email: u.email, name: u.name, role: u.role } : null, ...L.hiddenFor(req),
      customer: T.customerStudio(), signup: T.signupMode(),
      onboarding: T.customerStudio() && u?.role === 'admin' && !products.length,
      claude: T.customerStudio() ? (await import('./claude.ts')).customerClaude() : null,
      // The customer's own AI (ailink.ts: onboarding's "Connect your AI") and their plan (entitlements.ts: Upgrade buttons).
      ai: await (await import('./ailink.ts')).aiLinks(),
      entitlements: await (await import('./entitlements.ts')).entitlements(),
    });
    return true;
  }
  if (route === '/api/signups' || route.startsWith('/api/signups/')) {
    // The waitlist (tenancy.ts STUDIO_SIGNUP=waitlist): the platform admin's (lockdown.ts), so only J reaches here.
    const admin = adminOf(req);
    const m = /^\/api\/signups\/([\w.-]{1,255})\/(invite|decline)$/.exec(route);
    if (route === '/api/signups' && method === 'GET') json(res, 200, { signups: A.listSignups(url.searchParams.get('status') ?? 'waiting') });
    else if (m && method === 'POST') {
      const r = A.decideSignup(decodeURIComponent(m[1]), m[2] as 'invite' | 'decline', admin);
      json(res, 200, r.invite ? { ...r, invite: { id: r.invite.id, email: r.invite.email }, ...(await deliver(r.invite, admin)) } : r);
    } else json(res, 404, { error: `No route ${method} ${route}` });
    return true;
  }
  if (!route.startsWith('/api/users') && !route.startsWith('/api/invites')) return false;
  const admin = adminOf(req);
  if (route === '/api/users' && method === 'GET') {
    json(res, 200, { users: A.listUsers(), invites: A.listInvites(), log: A.signinLog(60), me: admin.email });
    return true;
  }
  if (route === '/api/users/invite' && method === 'POST') {
    const b = await form(req);
    const inv = A.createInvite({ email: b.email, role: b.role, kind: 'invite', by: admin });
    json(res, 200, { invite: { id: inv.id, email: inv.email, role: inv.role, expires: inv.expires }, ...(await deliver(inv, admin)) });
    return true;
  }
  let m = /^\/api\/users\/(u_[0-9a-f]+)\/reset$/.exec(route);
  if (m && method === 'POST') {
    const u = A.getUser(m[1]);
    if (!u) throw new StudioError(`No user ${m[1]}`, 404);
    const inv = A.createInvite({ email: u.email, kind: 'reset', by: admin });
    json(res, 200, { reset: { id: inv.id, email: inv.email, expires: inv.expires }, ...(await deliver(inv, admin)) });
    return true;
  }
  m = /^\/api\/users\/(u_[0-9a-f]+)$/.exec(route);
  if (m && method === 'POST') {
    const b = await form(req);
    json(res, 200, { user: A.updateUser(m[1], { role: b.role, disabled: b.disabled === undefined ? undefined : String(b.disabled) === 'true' || b.disabled === '1', name: b.name }, admin) });
    return true;
  }
  if (m && method === 'DELETE') {
    json(res, 200, A.removeUser(m[1], admin));
    return true;
  }
  m = /^\/api\/invites\/((?:inv|rst)_[0-9a-f]+)\/(revoke|resend)$/.exec(route);
  if (m && method === 'POST') {
    if (m[2] === 'revoke') { json(res, 200, A.revokeInvite(m[1])); return true; }
    const old = A.listInvites().find((i) => i.id === m![1]);
    if (!old) throw new StudioError(`No invite ${m[1]}`, 404);
    const inv = A.createInvite({ email: old.email, role: old.role, kind: old.kind, by: admin });
    json(res, 200, { invite: { id: inv.id, email: inv.email, role: inv.role, expires: inv.expires }, ...(await deliver(inv, admin)) });
    return true;
  }
  json(res, 404, { error: `No route ${method} ${route}` });
  return true;
}
