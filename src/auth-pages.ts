// The sign-in pages (/auth/*) and the Users API (/api/users, /api/invites) for auth.ts. The pages are plain HTML forms
// (no script needed), sized for a phone, with the autocomplete hints the iPhone's Passwords app uses to save and fill.

import type http from 'node:http';
import { StudioError } from './config.ts';
import * as A from './auth.ts';
import { requestUser } from './sandbox.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string) {
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
</style></head><body><main><div class="brand"><span class="mark">H</span>Hawkes Studio</div>${body}</main></body></html>`;
}

function html(res: http.ServerResponse, status: number, body: string, headers: Record<string, string | string[]> = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', ...headers });
  res.end(body);
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function redirect(res: http.ServerResponse, to: string, headers: Record<string, string | string[]> = {}) {
  res.writeHead(303, { Location: to, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

async function form(req: http.IncomingMessage): Promise<Record<string, any>> {
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
    return h === 'hawkesgen.com' || h.endsWith('.hawkesgen.com') || h === '127.0.0.1' || h === 'localhost';
  } catch {
    return false;
  }
}

const meta = (req: http.IncomingMessage) => ({ ip: A.clientIp(req), ua: String(req.headers['user-agent'] ?? '') });

function signinPage(next: string, error?: string, email = '', notice?: string) {
  return page('Sign in', `<h1>Sign in</h1><p>Hawkes Studio, Gen and the beta sites.</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}${notice ? `<div class="ok">${esc(notice)}</div>` : ''}
<form method="post" action="/auth/signin">
<input type="hidden" name="next" value="${esc(next)}">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required value="${esc(email)}"${email ? '' : ' autofocus'}>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required${email ? ' autofocus' : ''}>
<label class="row"><input type="checkbox" name="remember" value="1" checked> Remember this device for 30 days</label>
<button type="submit">Sign in</button></form>
<p style="margin:16px 0 0"><small>Forgot your password? Ask an admin to send you a reset link.</small></p>`);
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

function signedInCookie(req: http.IncomingMessage, user: A.User, remember: boolean) {
  const s = A.startSession(user, { remember, ...meta(req) });
  return A.sessionCookie(req, s.token, A.cookieAge(remember));
}

/** /auth/*: the forward_auth check, signing in and out, setting a password, invites and resets. true when handled. */
export async function handleAuthRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const route = url.pathname;
  const method = req.method ?? 'GET';
  if (!route.startsWith('/auth/') && route !== '/auth') return false;
  if (route === '/auth/check') {
    const r = A.check(req);
    res.writeHead(r.status, { 'Cache-Control': 'no-store', ...(r.body ? { 'Content-Type': 'application/json' } : {}), ...r.headers });
    res.end(r.body ? JSON.stringify(r.body) : '');
    return true;
  }
  if (method === 'POST' && !sameSite(req)) {
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
      redirect(res, '/', { 'Set-Cookie': signedInCookie(req, u, false) });
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
    json(res, 200, { user: u ? { email: u.email, name: u.name, role: u.role } : null });
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
