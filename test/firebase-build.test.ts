// Firebase builds in Studio's own cloud (firebasebuild.ts): Hawkes Games' firebase.yml build is read as a firebase build,
// what it deploys and where comes from the repo's own firebase.json and .firebaserc (the real ones are checked), the
// deployer's token is minted keylessly (with Studio granting itself the role, or saying exactly which grant is missing),
// no secret reaches a script or a log, the metadata stand-in and the build record work, and a project that no longer uses
// GitHub Actions never gets the Actions preflight or card (an open one closes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-firebase-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
const OLD_BUILD = { id: 'firebase', tool: 'actions', target: 'web', workflow: 'firebase.yml', on: [], playtest: false };
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [
  { id: 'hawkes-games', name: 'Hawkes Games', framing: 'test', engine: 'web', kind: 'app', repo: 'hgrepo', site: 'hgrepo', live: 'https://hawkesgames.com', beta: 'https://beta.hawkesgames.com',
    versionPath: '/v1/health', github: 'jgriffith3433/hawkesgenwebsite', local: { serve: 'remote', dir: 'hgrepo', port: 0, path: '/', url: 'https://beta.hawkesgames.com' },
    playtests: [], story: [], about: 'A fixture.', builds: [OLD_BUILD] },
  { id: 'godot-game', name: 'Godot game', framing: 'test', engine: 'web', repo: 'gdrepo', site: 'gdrepo', live: 'https://example.com', github: 'o/godot',
    local: { serve: 'static', dir: 'gdrepo', port: 8711, path: '/' }, playtests: [], story: [], about: 'A fixture.', builds: [{ id: 'linux', tool: 'actions', target: 'linux', workflow: 'build.yml' }] },
] }));

const F = await import('../src/firebasebuild.ts');
const A = await import('../src/buildaccess.ts');
const { buildsOf } = await import('../src/builds.ts');
const { getProduct, checkBuilds } = await import('../src/config.ts');
const { publisherOf } = await import('../src/deploy.ts');
const { db } = await import('../src/db.ts');
A.hooks.notify = async () => {}; // never a real phone notification from a test
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL, by TEXT)');

// The portal's real files (the read-only clone next to this worktree), else copies of what they say today.
const repo = path.resolve(import.meta.dirname, '..', '..', `${path.basename(path.resolve(import.meta.dirname, '..'))}.repos`, 'hawkesgenwebsite');
const realJson = (f: string, fallback: unknown) => (fs.existsSync(path.join(repo, f)) ? JSON.parse(fs.readFileSync(path.join(repo, f), 'utf8')) : fallback);
const firebaseJson = realJson('firebase.json', { hosting: { public: 'public' }, functions: [{ source: 'cloud/functions', codebase: 'portal' }], firestore: { rules: 'cloud/firestore.rules' } });
const firebaserc = realJson('.firebaserc', { projects: { default: 'hawkes-staging', staging: 'hawkes-staging', prod: 'hawkes-prod' } });

test('the firebase.yml build is a firebase build in Studio now: on beta pushes, no workflow, no Actions', () => {
  const [b] = buildsOf(getProduct('hawkes-games'));
  assert.equal(b.tool, 'firebase');
  assert.deepEqual(b.on, ['beta']);
  assert.equal(b.workflow, undefined);
  assert.equal(b.playtest, false);
  assert.equal(F.usesActions(buildsOf(getProduct('hawkes-games'))), false);
  // Other Actions builds stay Actions builds.
  assert.equal(buildsOf(getProduct('godot-game'))[0].tool, 'actions');
  assert.equal(F.asFirebase({ id: 'x', tool: 'actions', workflow: 'pages.yml' }).tool, 'actions');
  // Going live is Studio's deploy now, never "GitHub Actions deploys it".
  assert.match(publisherOf(getProduct('hawkes-games')).says, /Studio deploys it to Firebase/);
  assert.doesNotMatch(publisherOf(getProduct('hawkes-games')).done, /GitHub Actions/);
});

test('what it deploys and where: exactly what firebase.yml did, read from the repo', () => {
  assert.equal(F.deployOnly(firebaseJson), 'hosting,functions:portal,firestore');
  assert.deepEqual(F.functionsOf(firebaseJson).map((x) => x.source), ['cloud/functions']);
  assert.equal(F.projectFor('beta', undefined, firebaserc), 'hawkes-staging');
  assert.equal(F.projectFor('main', undefined, firebaserc), 'hawkes-prod');
  assert.equal(F.projectFor('main', { live: 'other-prod' }, firebaserc), 'other-prod');
  assert.equal(F.projectFor('main', undefined, { projects: { default: 'only-one' } }), null, 'never deploys main to a staging default');
  assert.equal(F.deployerOf('hawkes-staging'), 'deployer@hawkes-staging.iam.gserviceaccount.com');
  assert.equal(F.deployerOf('hawkes-prod'), 'deployer@hawkes-prod.iam.gserviceaccount.com');
  const p = getProduct('hawkes-games') as any;
  assert.deepEqual(F.addressesOf(p, 'beta', 'hawkes-staging'), { url: 'https://beta.hawkesgames.com', health: 'https://hawkes-staging.web.app/v1/health' });
  assert.deepEqual(F.addressesOf(p, 'main', 'hawkes-prod'), { url: 'https://hawkesgames.com', health: 'https://hawkesgames.com/v1/health' });
  // firebase.json functions as one object, and with no codebases.
  assert.equal(F.deployOnly({ hosting: {}, functions: { source: 'functions' } }), 'hosting,functions');
});

test('checkBuilds: tool firebase and its settings, checked', () => {
  const [b] = checkBuilds([{ id: 'firebase', tool: 'firebase', firebase: { beta: 'hawkes-staging', live: 'hawkes-prod', only: 'hosting,functions:portal', serviceAccount: 'deployer@{project}.iam.gserviceaccount.com', health: '/v1/health' } }]);
  assert.equal(b.tool, 'firebase');
  assert.equal(b.firebase?.live, 'hawkes-prod');
  assert.throws(() => checkBuilds([{ id: 'f', tool: 'firebase', firebase: { only: 'hosting; rm -rf /' } }]), /firebase\.only/);
  assert.throws(() => checkBuilds([{ id: 'f', tool: 'firebase', firebase: { serviceAccount: 'me@gmail.com' } }]), /serviceAccount/);
  assert.throws(() => checkBuilds([{ id: 'f', tool: 'npm', firebase: {} }]), /only firebase builds/);
});

const TOKEN = 'ya29.fake-deployer-token-0123456789';

test('the deployer token: minted keylessly by Studio; a refusal makes Studio grant itself the role, then try again', async () => {
  const calls: string[] = [];
  let granted = false;
  let policy: any = { etag: 'e1', bindings: [{ role: 'roles/iam.workloadIdentityUser', members: ['principalSet://x'] }] };
  F.google.me = async () => 'studio-cells@hawkes-staging.iam.gserviceaccount.com';
  F.google.wait = async () => {};
  F.google.call = async (url: string, init: any = {}) => {
    calls.push(url.replace(/^https:\/\/[^/]+/, ''));
    if (url.endsWith(':generateAccessToken')) {
      assert.deepEqual(init.body.scope, ['https://www.googleapis.com/auth/cloud-platform']);
      assert.equal(init.body.lifetime, '3600s');
      if (!granted) throw Object.assign(new Error("Google Cloud answered 403: Permission 'iam.serviceAccounts.getAccessToken' denied"), { status: 403 });
      return { accessToken: TOKEN, expireTime: new Date(Date.now() + 3600_000).toISOString() };
    }
    if (url.endsWith(':getIamPolicy')) return policy;
    if (url.endsWith(':setIamPolicy')) { policy = init.body.policy; granted = true; return policy; }
    throw new Error(`unexpected ${url}`);
  };
  const t = await F.deployerToken('deployer@hawkes-staging.iam.gserviceaccount.com');
  assert.equal(t.token, TOKEN);
  assert.ok(t.expires > Date.now());
  assert.ok(calls.some((c) => c.includes('projects/hawkes-staging/serviceAccounts/deployer%40hawkes-staging.iam.gserviceaccount.com:setIamPolicy')));
  const b = policy.bindings.find((x: any) => x.role === 'roles/iam.serviceAccountTokenCreator');
  assert.deepEqual(b.members, ['serviceAccount:studio-cells@hawkes-staging.iam.gserviceaccount.com']);
  assert.equal(policy.etag, 'e1', 'the policy is written back with its etag (no lost update)');
  assert.equal(policy.bindings.length, 2, 'the bindings already there stay');
});

test('the deployer token: when Studio may not grant it, the error says exactly which role, on which account, for whom', async () => {
  F.google.me = async () => 'studio-cells@hawkes-staging.iam.gserviceaccount.com';
  F.google.call = async (url: string) => {
    throw Object.assign(new Error(`Google Cloud answered 403 for ${url}: PERMISSION_DENIED`), { status: 403 });
  };
  await assert.rejects(F.deployerToken('deployer@hawkes-prod.iam.gserviceaccount.com'), (e: any) => {
    assert.match(e.message, /roles\/iam\.serviceAccountTokenCreator/);
    assert.match(e.message, /on the service account deployer@hawkes-prod\.iam\.gserviceaccount\.com \(project hawkes-prod\)/);
    assert.match(e.message, /studio-cells@hawkes-staging\.iam\.gserviceaccount\.com needs/);
    assert.match(e.message, /gcloud iam service-accounts add-iam-policy-binding deployer@hawkes-prod/);
    // Never an access card about GitHub: it isn't one.
    assert.equal(A.failType(e.message), 'other');
    return true;
  });
});

test('the job script: the check first, the token never in it, unset before the repo\'s code runs, firebase deploy as firebase.yml did', () => {
  const s = F.deployScript({ project: 'hawkes-staging', deployer: 'deployer@hawkes-staging.iam.gserviceaccount.com', only: 'hosting,functions:portal,firestore', sources: ['cloud/functions'], health: 'https://hawkes-staging.web.app/v1/health', url: 'https://beta.hawkesgames.com', ref: 'beta', sha: 'a'.repeat(40), name: 'Hawkes Games' });
  assert.ok(!s.includes(TOKEN));
  assert.ok(!/HAWKES_DEPLOY_TOKEN=(?!"\$DEPLOY_TOKEN")/.test(s), 'the token only ever comes from the execution\'s environment');
  const unset = s.indexOf('unset HAWKES_DEPLOY_TOKEN');
  const check = s.indexOf("cd 'cloud/functions' && npm ci");
  const shim = s.indexOf('HAWKES_DEPLOY_TOKEN="$DEPLOY_TOKEN" node -e');
  const forget = s.indexOf('unset DEPLOY_TOKEN');
  const deploy = s.indexOf('firebase-tools@15 deploy');
  assert.ok(unset >= 0 && check > unset && shim > check && forget > shim && deploy > forget, 'out of the environment first, then the check, then the stand-in takes it and the shell forgets it, then deploy');
  assert.match(s, /deploy --only 'hosting,functions:portal,firestore' --project 'hawkes-staging' --non-interactive --force/);
  assert.match(s, /GCE_METADATA_HOST=127\.0\.0\.1:8723 METADATA_SERVER_DETECTION=assume-present/);
  assert.ok(!/GOOGLE_APPLICATION_CREDENTIALS|key\.json|FIREBASE_TOKEN/.test(s), 'no key file, no firebase login token');
  assert.equal(spawnSync('sh', ['-n', '-c', s]).status, 0, 'valid shell');
  // Run for real with stand-ins for npm and npx: nothing the repo runs sees the token, firebase-tools signs in as the deployer.
  const dir = fs.mkdtempSync(path.join(tmp, 'dry-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.mkdirSync(path.join(dir, 'cloud', 'functions'), { recursive: true });
  const seen = `[ -n "$HAWKES_DEPLOY_TOKEN$DEPLOY_TOKEN" ] && echo "SAW THE TOKEN: $0" || true`;
  fs.writeFileSync(path.join(dir, 'bin', 'npm'), `#!/bin/sh\n${seen}\necho "npm $*"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'bin', 'npx'), `#!/bin/sh\n${seen}\n[ "$2" = tsc ] && exit 0\nexec "${process.execPath}" -e 'fetch("http://"+process.env.GCE_METADATA_HOST+"/computeMetadata/v1/instance/service-accounts/default/token",{headers:{"Metadata-Flavor":"Google"}}).then((r)=>r.json()).then((j)=>console.log(j.access_token==="${TOKEN}"?"deployer token ok":"wrong token"))'\n`, { mode: 0o755 });
  const dry = s.replace('firebase-tools@15', 'firebase-tools').replace(/HAWKES_RECORD=.*$/m, 'true');
  const r = spawnSync('sh', ['-c', dry], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HAWKES_DEPLOY_TOKEN: TOKEN, HAWKES_DEPLOY_AS: 'deployer@hawkes-staging.iam.gserviceaccount.com', HAWKES_DEPLOY_PROJECT: 'hawkes-staging', HAWKES_DEPLOY_EXPIRES: String(Date.now() + 3600_000) } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /SAW THE TOKEN/);
  assert.match(r.stdout, /npm ci --no-audit/);
  assert.match(r.stdout, /deployer token ok/);
  assert.ok(!(r.stdout + r.stderr).includes(TOKEN), 'the token is never printed');
  assert.equal(F.scrub(`Authorization: Bearer ${TOKEN} failed`, TOKEN), 'Authorization: Bearer [redacted] failed');
});

test('the metadata stand-in answers Google\'s client libraries with the deployer, and the record is written after a healthy deploy', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'job-'));
  const ready = path.join(dir, 'ready');
  const port = String(20000 + Math.floor(Math.random() * 20000));
  const shim = spawn(process.execPath, ['-e', F.METADATA_SHIM], { env: { ...process.env, HAWKES_DEPLOY_TOKEN: TOKEN, HAWKES_DEPLOY_AS: 'deployer@hawkes-staging.iam.gserviceaccount.com', HAWKES_DEPLOY_PROJECT: 'hawkes-staging', HAWKES_DEPLOY_EXPIRES: String(Date.now() + 3600_000), HAWKES_DEPLOY_PORT: port, HAWKES_DEPLOY_READY: ready }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  shim.stdout.on('data', (d) => (out += d));
  shim.stderr.on('data', (d) => (out += d));
  try {
    await new Promise<void>((resolve, reject) => { const w = fs.watch(dir, () => { if (fs.existsSync(ready)) { w.close(); resolve(); } }); shim.on('exit', () => reject(new Error(`the stand-in stopped: ${out}`))); if (fs.existsSync(ready)) { w.close(); resolve(); } });
    const get = (p: string) => fetch(`http://127.0.0.1:${port}/computeMetadata/v1${p}`, { headers: { 'Metadata-Flavor': 'Google' } });
    const tok = await get('/instance/service-accounts/default/token?scopes=https://www.googleapis.com/auth/cloud-platform');
    assert.equal(tok.headers.get('metadata-flavor'), 'Google');
    const j = await tok.json() as any;
    assert.equal(j.access_token, TOKEN);
    assert.ok(j.expires_in > 3000 && j.expires_in <= 3600);
    assert.equal(await (await get('/instance/service-accounts/default/email')).text(), 'deployer@hawkes-staging.iam.gserviceaccount.com');
    assert.equal(await (await get('/project/project-id')).text(), 'hawkes-staging');
    assert.equal((await get('/instance')).status, 200);
    assert.equal((await get('/universe/universe-domain')).status, 404);
    assert.equal(out, '', 'it prints nothing');
  } finally { shim.kill(); }

  // The health check and the build record.
  const health = http.createServer((_q, s) => { s.writeHead(200, { 'Content-Type': 'application/json' }); s.end('{"ok":true,"cloud":"gcp"}'); });
  await new Promise<void>((r) => health.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(health.address() as any).port}/v1/health`;
  const record = JSON.stringify({ project: 'hawkes-staging', ref: 'beta', commit: 'b'.repeat(40), url: 'https://beta.hawkesgames.com', name: 'Hawkes Games <&>', health: url });
  const r = await new Promise<{ code: number | null; out: string }>((resolve) => { const c = spawn(process.execPath, ['-e', F.AFTER_DEPLOY], { cwd: dir, env: { ...process.env, HAWKES_RECORD: record } }); let o = ''; c.stdout.on('data', (d) => (o += d)); c.stderr.on('data', (d) => (o += d)); c.on('close', (code) => resolve({ code, out: o })); });
  health.close();
  assert.equal(r.code, 0, r.out);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'studio-build', 'build.json'), 'utf8'));
  assert.deepEqual(rec, { project: 'hawkes-staging', ref: 'beta', commit: 'b'.repeat(40), url: 'https://beta.hawkesgames.com', by: 'studio' });
  const html = fs.readFileSync(path.join(dir, 'studio-build', 'index.html'), 'utf8');
  assert.match(html, /Hawkes Games &lt;&amp;&gt; \(beta\)/);
  assert.match(html, /url=https:\/\/beta\.hawkesgames\.com/);
});

test('no Actions preflight or card for a project that builds in Studio; the open card closes by itself', async () => {
  let probed = 0;
  A.probeHook.run = async () => { probed++; return { ok: true, permissions: { actions: 'read' }, installId: 7, account: 'jgriffith3433', type: 'User', known: true }; };
  // The card filed before this change (the app had no Actions: write when Studio started firebase.yml).
  const DISPATCH = `GitHub wouldn't start firebase.yml in jgriffith3433/hawkesgenwebsite: 403 {"message":"Resource not accessible by integration"}`;
  const card = await A.fileAccessCard('hawkes-games', 'firebase', 'jgriffith3433/hawkesgenwebsite', A.accessCause(DISPATCH)!, 'firebase.yml');
  assert.equal(A.openAccess('hawkes-games').length, 1);
  probed = 0; // filing a permission card reads the app's access once (buildaccess.ts fileAccessCard); count from here
  // Preflight: never probes or files anything for it.
  assert.deepEqual(await A.preflight('hawkes-games', 'firebase', 'jgriffith3433/hawkesgenwebsite', 'firebase.yml'), { ok: true });
  assert.equal(probed, 0);
  // A failure that reads like an Actions refusal never becomes an Actions card for it.
  const h = await A.handleFailure('b_fb1', { product: 'hawkes-games', build: 'firebase', slug: 'jgriffith3433/hawkesgenwebsite', error: DISPATCH });
  assert.equal(h.handled, false);
  assert.equal(h.type, 'other');
  // The open card closes (Studio's start-up and every firebase build call this), with no rebuild of the old workflow.
  const started: string[] = [];
  A.hooks.start = async (product) => { started.push(product); };
  assert.deepEqual(await F.retireActionsCards(), ['hawkes-games']);
  assert.equal(A.openAccess('hawkes-games').length, 0);
  assert.equal((db.prepare('SELECT status FROM build_access WHERE id = ?').get(card) as any).status, 'resolved');
  assert.deepEqual(started, []);
  // A project that still builds in Actions keeps its card and its preflight.
  await A.fileAccessCard('godot-game', 'linux', 'o/godot', A.accessCause(DISPATCH.replace('firebase.yml', 'build.yml'))!, 'build.yml');
  assert.deepEqual(await F.retireActionsCards(), []);
  assert.equal(A.openAccess('godot-game').length, 1);
  assert.equal((await A.preflight('godot-game', 'linux', 'o/godot', 'build.yml')).ok, false);
  assert.ok(probed > 0);
});
