// GitHub App permissions (ghperms.ts, github-webhook.ts; J, 2026-11-08): everything asked for once at install, Actions:
// write not needed, pending ones found at setup and on the access card with the steps, one card per fix, and Studio
// looking again by itself on GitHub's signed installation event (never a timer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ghperms-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
const P = await import('../src/ghperms.ts');
const G = await import('../src/github-app.ts');
const A = await import('../src/buildaccess.ts');
const W = await import('../src/github-webhook.ts');
const { db } = await import('../src/db.ts');
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL, by TEXT)');

test('the app asks for everything it uses at install, Actions: write not among them, and its webhook is on', () => {
  const m = G.manifest('https://studio.example.test');
  assert.deepEqual(m.default_permissions, P.APP_PERMISSIONS);
  assert.equal(m.default_permissions.actions, 'read', "Studio's builds run in its cloud: no Actions: write");
  assert.equal(m.hook_attributes.active, true);
  assert.equal(m.hook_attributes.url, 'https://studio.example.test/api/github/webhook');
  assert.equal(G.manifest('http://127.0.0.1:8791').hook_attributes.active, false, 'GitHub refuses a webhook on this computer');
  for (const k of Object.keys(P.APP_PERMISSIONS)) assert.ok(P.WHY[k], `a reason for ${k}`);
  assert.equal(P.OPTIONAL.actions.level, 'write');
  assert.match(G.chooserPage('https://studio.example.test'), /Pull requests: write \(to open pull requests/);
});

test('missing and pending: what the installation lacks of what Studio needs, and of what the app asks', () => {
  const have = { metadata: 'read', contents: 'write', pull_requests: 'read', workflows: 'write', pages: 'write', administration: 'write', actions: 'read', checks: 'read' };
  assert.deepEqual(P.missingRequired(have), ['pull_requests']);
  assert.deepEqual(P.missingRequired({ ...have, pull_requests: 'admin' }), []);
  assert.deepEqual(P.pending({ ...P.APP_PERMISSIONS, actions: 'write' }, { ...have, pull_requests: 'write' }), ['actions']);
  assert.deepEqual(P.pending(null, have), []);
  assert.equal(P.labels(['pull_requests', 'actions'], { pull_requests: 'write', actions: 'write' }), 'Pull requests: write, Actions: write');
});

test('the steps: accept on the installation page; add it to the app first only when the app lacks it', () => {
  const accept = P.acceptSteps({ what: 'Actions: write', account: 'acme', appHas: true });
  assert.equal(accept.length, 3);
  assert.match(accept[0], /Installation page on GitHub.*acme/);
  assert.match(accept[1], /Accept new permissions/);
  assert.match(accept[2], /by itself/);
  const add = P.acceptSteps({ what: 'Actions: write', account: 'acme', appHas: false });
  assert.equal(add.length, 4);
  assert.match(add[0], /Permissions on GitHub.*Actions to "Read and write".*Save changes/);
  const shared = P.acceptSteps({ what: 'Actions: write', appHas: false, ownsApp: false });
  assert.match(shared[0], /Studio's team adds it/);
  assert.match(P.stepsText(accept), /^1\. .*\n2\. .*\n3\. /s);
});

test('the access card walks through the steps, and projects on one account share one card', async () => {
  const cause = A.accessCause(`GitHub wouldn't start firebase.yml in acme/site: 403 {"message":"Resource not accessible by integration"}`)!;
  const fix = A.accessFix(cause, 'acme/site', { appHas: true, account: 'acme' });
  assert.match(fix, /"Actions: write" on acme\/site/);
  assert.match(fix, /Studio's own builds don't need it/);
  assert.match(fix, /1\. Open "Installation page on GitHub"/);
  assert.doesNotMatch(fix, /Permissions on GitHub/);
  assert.match(A.accessFix(cause, 'acme/site', { appHas: false, account: 'acme' }), /1\. Open "The app's Permissions on GitHub"/);

  A.probeHook.run = async () => ({ ok: true, known: true, permissions: { actions: 'read' }, installId: 9, account: 'acme', type: 'Organization', manage: 'https://github.test/organizations/acme/settings/installations/9', appPermissions: { actions: 'write' }, ownsApp: true });
  const told: string[] = [];
  A.hooks.notify = async (title) => { told.push(title); };
  const one = await A.fileAccessCard('site', 'web', 'acme/site', cause, 'firebase.yml');
  const two = await A.fileAccessCard('game', 'web', 'acme/game', cause, 'firebase.yml');
  assert.notEqual(one, two);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(told.length, 1, 'told once for one fix');
  const groups = A.accessGroups(A.openAccess());
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
  const row = A.openAccess()[0];
  assert.match(row.detail ?? '', /Installation page on GitHub/);
  const links = await A.accessLinks(row);
  assert.deepEqual(links.map((l) => l.url), ['https://github.test/organizations/acme/settings/installations/9']);
});

test("GitHub's signed installation event looks again at once; unsigned or other events do nothing", async () => {
  // The app, with its webhook secret, as the manifest flow saves it (sealed at rest).
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'github-app.json'), JSON.stringify({ id: 1, slug: 's', clientId: '', clientSecret: '', pem, webhookSecret: 'whsec', htmlUrl: '', owner: 'acme' }));
  assert.equal(G.appConfig()?.webhookSecret, 'whsec');
  const calls: string[] = [];
  W.webhookHooks.recheck = async (o) => { calls.push(`recheck:${o.force}`); return { open: 0, back: true }; };
  W.webhookHooks.tellCell = async (org) => { calls.push(`cell:${org}`); return true; };
  const body = Buffer.from(JSON.stringify({ action: 'new_permissions_accepted', installation: { id: 42, account: { login: 'acme' } } }));
  const sig = (b: Buffer, k = 'whsec') => `sha256=${crypto.createHmac('sha256', k).update(b).digest('hex')}`;

  assert.equal((await W.handleGithubWebhook(body, { 'x-github-event': 'installation' })).status, 401);
  assert.equal((await W.handleGithubWebhook(body, { 'x-github-event': 'installation', 'x-hub-signature-256': sig(body, 'nope') })).status, 401);
  const ok = await W.handleGithubWebhook(body, { 'x-github-event': 'installation', 'x-hub-signature-256': sig(body) });
  assert.equal(ok.status, 202);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, ['recheck:true']);

  const push = Buffer.from(JSON.stringify({ action: 'opened' }));
  assert.equal((await W.handleGithubWebhook(push, { 'x-github-event': 'pull_request', 'x-hub-signature-256': sig(push) })).body.ignored, 'pull_request.opened');
  const ping = Buffer.from('{}');
  assert.equal((await W.handleGithubWebhook(ping, { 'x-github-event': 'ping', 'x-hub-signature-256': sig(ping) })).body.pong, true);

  // An installation linked to a customer's Studio: that Studio is told, not this one.
  fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'github-installs.json'), JSON.stringify({ 42: { org: 'o-acme', account: 'acme', at: 1 } }));
  calls.length = 0;
  await W.handleGithubWebhook(body, { 'x-github-event': 'installation', 'x-hub-signature-256': sig(body) });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, ['cell:o-acme']);
});

test('setup: the checklist says what the installation still has to accept, with the steps and the link', async () => {
  const { permissionsItem } = await import('../src/repokit.ts');
  A.probeHook.run = async () => ({ ok: true, known: true, permissions: { ...P.APP_PERMISSIONS, pull_requests: 'read' }, installId: 9, account: 'acme', type: 'User', manage: 'https://github.test/settings/installations/9', appPermissions: { ...P.APP_PERMISSIONS }, ownsApp: true });
  const blocked = (await permissionsItem('acme/site'))!;
  assert.equal(blocked.ok, false);
  assert.equal(blocked.by, 'person');
  assert.equal(blocked.link, 'https://github.test/settings/installations/9');
  assert.match(blocked.what, /Pull requests: write on acme/);
  assert.match(blocked.fix ?? '', /1\. Open "Installation page on GitHub"/);
  A.probeHook.run = async () => ({ ok: true, known: true, permissions: { ...P.APP_PERMISSIONS }, installId: 9, account: 'acme', type: 'User', manage: 'x', appPermissions: { ...P.APP_PERMISSIONS, actions: 'write' }, ownsApp: true });
  const optional = (await permissionsItem('acme/site'))!;
  assert.equal(optional.ok, true, 'an optional one blocks nothing');
  assert.match(optional.what, /Actions: write.*Build button/);
  A.probeHook.run = async () => ({ ok: true, known: false, permissions: null, installId: null, account: null, type: null });
  assert.equal(await permissionsItem('acme/site'), null);
});
