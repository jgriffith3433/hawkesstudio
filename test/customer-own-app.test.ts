// A customer's Studio connects GitHub without Hawkes Studio's admin (J, 2026-10-31: "Customers should be able to do this
// without the admin"): with no shared app from the control plane, the customer makes their own GitHub App (named after
// their org: GitHub app names are unique), its secrets sealed at rest; installed on their repos, it is what lets them add
// a repository, even one on J's account when that account installed it (config.ts checkRepoOwnership). GitHub and the
// control plane are small stand-in servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-own-app-'));
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_ORG = 'j-studio-4f12';
process.env.STUDIO_SIGNUP = 'owner';
process.env.STUDIO_CELL_KEY = 'cell-key';
process.env.STUDIO_SECRETS_KEY = 'own-app-secrets-key';
process.env.STUDIO_PUBLIC_URL = 'https://studio.hawkesgen.ai/o/j-studio-4f12';
process.env.GITHUB_TOKEN = 'ghp_j_must_never_reach_a_customer';
delete process.env.STUDIO_PRODUCTS;

// The control plane: Hawkes Studio has no shared app (and never a token for this cell).
const cp = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url === '/api/cells/self/github') return res.end(JSON.stringify({ app: null, install: null, installations: [], user: null, connect: null, linked: [] }));
  if (req.url === '/api/cells/self/github-token') return res.end(JSON.stringify({ token: null }));
  res.end('{}');
});
await new Promise<void>((r) => cp.listen(0, '127.0.0.1', () => r()));
process.env.STUDIO_CONTROL_URL = `http://127.0.0.1:${(cp.address() as any).port}`;

// GitHub: the manifest conversion, then the customer's own app installed on jgriffith3433 with hawkesgen chosen.
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
let appPerms: Record<string, string> = { metadata: 'read', contents: 'read' };
const gh = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  const p = new URL(req.url!, 'http://x').pathname;
  const out = (status: number, o: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (p === '/app-manifests/abc/conversions') return out(201, { id: 91, slug: 'hawkes-studio-j-studio-4f12', client_id: 'Iv1.own', client_secret: 'own-client-secret', pem, webhook_secret: 'own-webhook', html_url: 'https://github.test/apps/hawkes-studio-j-studio-4f12', owner: { login: 'jgriffith3433' } });
  if (p === '/app') return out(200, { slug: 'their-existing-app', client_id: 'Iv1.existing', html_url: 'https://github.test/apps/their-existing-app', owner: { login: 'acme-org' }, permissions: appPerms });
  if (p === '/app/installations') return out(200, [{ id: 9, account: { login: 'jgriffith3433', type: 'User' }, repository_selection: 'selected' }]);
  if (p === '/app/installations/9/access_tokens') return out(201, { token: 'ghs_own_install', expires_at: new Date(Date.now() + 3600_000).toISOString() });
  if (p === '/installation/repositories') return out(200, { repositories: [{ full_name: 'jgriffith3433/hawkesgen', private: true, html_url: 'https://github.test/jgriffith3433/hawkesgen' }] });
  out(404, { message: `stand-in has no ${req.method} ${p}` });
});
await new Promise<void>((r) => gh.listen(0, '127.0.0.1', () => r()));
process.env.GITHUB_API_BASE = process.env.GITHUB_WEB_BASE = `http://127.0.0.1:${(gh.address() as any).port}`;
test.after(() => { cp.close(); gh.close(); });

const G = await import('../src/github-app.ts');
const C = await import('../src/config.ts');

test("with no shared app, a customer's Studio offers to make its own, named after its org and private", async () => {
  const s = await G.githubStatus('https://studio.hawkesgen.ai/o/j-studio-4f12');
  assert.equal(s.app, null);
  assert.equal(s.setup, 'https://studio.hawkesgen.ai/o/j-studio-4f12/api/github/app/setup', 'its own setup link, under its own address');
  assert.equal(s.error, null);
  const m = G.manifest('https://studio.hawkesgen.ai/o/j-studio-4f12');
  assert.equal(m.name, 'Hawkes Studio j-studio-4f12');
  assert.equal(m.public, false);
  assert.equal(m.redirect_url, 'https://studio.hawkesgen.ai/o/j-studio-4f12/api/github/app/created', 'GitHub comes back to this Studio');
});

test("before GitHub: whose account owns the app (theirs or an organization), or an app they already have", () => {
  const page = G.chooserPage('https://studio.hawkesgen.ai/o/j-studio-4f12');
  assert.match(page, /\/o\/j-studio-4f12\/api\/github\/app\/setup\?owner=me/);
  assert.match(page, /name="org"/);
  assert.match(page, /I already have a GitHub App/);
  assert.match(page, /\/o\/j-studio-4f12\/api\/github\/app\/existing/);
  assert.match(G.setupPage('https://studio.hawkesgen.ai/o/j-studio-4f12', 'acme-org'), /\/organizations\/acme-org\/settings\/apps\/new/);
  assert.equal(G.githubLogin('acme-org'), 'acme-org');
  for (const bad of ['-acme', 'acme/../x', 'a b', '']) assert.equal(G.githubLogin(bad), null, bad);
});

test("an app they already have: checked with GitHub (the key, the permissions Studio needs) before it is kept", async () => {
  const base = 'https://studio.hawkesgen.ai/o/j-studio-4f12';
  await assert.rejects(G.useExistingApp(base, { appId: 'abc', pem }), /App ID/);
  await assert.rejects(G.useExistingApp(base, { appId: 55, pem: 'not a key' }), /Private key/);
  await assert.rejects(G.useExistingApp(base, { appId: 55, pem }), /needs more permissions: Contents: write/);
  assert.equal(G.appConfig(), null, 'nothing kept');
  appPerms = { metadata: 'read', contents: 'write', pull_requests: 'write', workflows: 'write', pages: 'write', administration: 'write', actions: 'read', checks: 'write' };
  const r = await G.useExistingApp(base, { appId: '55', pem, clientSecret: 'existing-secret' });
  assert.equal(r.app.slug, 'their-existing-app');
  assert.equal(r.app.owner, 'acme-org');
  assert.equal(r.signIn, true);
  assert.equal(G.appConfig()?.clientId, 'Iv1.existing');
  assert.ok(!fs.readFileSync(path.join(process.env.STUDIO_DATA!, 'github-app.json'), 'utf8').includes('existing-secret'), 'sealed');
  await assert.rejects(G.useExistingApp(base, { appId: 55, pem }), /already has its GitHub App/);
  fs.rmSync(path.join(process.env.STUDIO_DATA!, 'github-app.json'));
});

test("its app's secrets are sealed at rest, and it adds a repo its app is installed on (J's account too); never with J's token", async () => {
  const state = G.signState({ k: 'app' });
  const made = await G.appCreated('abc', state);
  assert.equal(made.app.slug, 'hawkes-studio-j-studio-4f12');
  const disk = fs.readFileSync(path.join(process.env.STUDIO_DATA!, 'github-app.json'), 'utf8');
  for (const secret of ['own-client-secret', 'own-webhook', 'BEGIN RSA PRIVATE KEY']) assert.ok(!disk.includes(secret), `${secret} sealed`);
  assert.equal(G.appConfig()?.clientSecret, 'own-client-secret');
  assert.equal(G.appConfig()?.pem, pem);
  await C.checkRepoOwnership({ repo: 'jgriffith3433/hawkesgen' });
  await assert.rejects(C.checkRepoOwnership({ repo: 'jgriffith3433/sickofitgame-unity' }), /isn't installed on that repository/);
  assert.equal((await G.accessFor('jgriffith3433/hawkesgen'))?.token, 'ghs_own_install');
  assert.equal(await G.accessFor('jgriffith3433/sickofitgame-unity'), null, "not J's GITHUB_TOKEN");
});
