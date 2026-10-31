// Talk running Studio's games (J, 2026-10-30): games added in J's Studio live in its data (games.json, beside
// products.json); the GitHub App made by the manifest flow, its installation tokens and the person's GitHub sign-in
// (github-app.ts); a game's readiness and the plan behind its Approve card (repokit.ts); a brand-new game made from a
// starter (starters.ts). GitHub is a small stand-in server (GITHUB_API_BASE / GITHUB_WEB_BASE): every call is recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-github-games-'));
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_PUBLIC_URL = 'https://studio.test';
delete process.env.STUDIO_ORG;
delete process.env.STUDIO_CUSTOMER;
delete process.env.STUDIO_SIGNUP;
delete process.env.GITHUB_TOKEN;
// No agent ever starts here: the new game's first-version task is refused (and says so) instead of running Claude Code.
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'agents.json'), JSON.stringify({ enabled: false }));

// ------------------------------------------------------------------ the stand-in GitHub
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const calls: string[] = [];
const repos = new Map<string, { branches: Map<string, string>; files: Map<string, string>; pages: any; perBranch?: boolean; byBranch?: Map<string, Map<string, string>>; pending?: any; pagesFlipped?: boolean }>();
let commitN = 0;
const repo = (slug: string) => {
  if (!repos.has(slug)) repos.set(slug, { branches: new Map([['main', 'c0']]), files: new Map(), pages: null });
  return repos.get(slug)!;
};
const gh = http.createServer(async (req, res) => {
  const u = new URL(req.url!, 'http://x');
  let body = '';
  for await (const c of req) body += c;
  const b = body ? (() => { try { return JSON.parse(body); } catch { return body; } })() : null;
  calls.push(`${req.method} ${u.pathname}`);
  const out = (status: number, o: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const auth = String(req.headers.authorization ?? '');
  const p = u.pathname;
  if (p === '/app-manifests/abc/conversions') return out(201, { id: 77, slug: 'hawkes-studio-test', client_id: 'Iv1.client', client_secret: 'csecret', pem, webhook_secret: 'w', html_url: 'https://github.test/apps/hawkes-studio-test', owner: { login: 'jgriffith3433' } });
  if (p.startsWith('/app/')) {
    const jwt = auth.replace(/^Bearer /, '').split('.');
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${jwt[0]}.${jwt[1]}`), publicKey, Buffer.from(jwt[2] ?? '', 'base64url'));
    if (!ok) return out(401, { message: 'bad jwt' });
    if (p === '/app/installations') return out(200, [{ id: 5, account: { login: 'acme', type: 'Organization' }, repository_selection: 'selected' }]);
    if (p === '/app/installations/5/access_tokens') return out(201, { token: 'ghs_install', expires_at: new Date(Date.now() + 3600_000).toISOString() });
  }
  if (p === '/installation/repositories') return out(200, { repositories: [{ full_name: 'acme/space-game', private: false, html_url: 'https://github.test/acme/space-game' }, { full_name: 'acme/old-site', private: false, html_url: 'https://github.test/acme/old-site' }] });
  if (p === '/login/oauth/access_token') return out(200, { access_token: 'ghu_user', refresh_token: 'ghr_user', expires_in: 28800, refresh_token_expires_in: 15811200 });
  if (p === '/user') return out(200, { login: 'jgriffith3433' });
  if (p === '/user/installations') return out(200, { installations: [{ id: 5, account: { login: 'acme' }, repository_selection: 'selected' }, { id: 8, account: { login: 'jgriffith3433' }, repository_selection: 'all' }] });
  if (p === '/user/repos' && req.method === 'POST') { repo(`jgriffith3433/${b.name}`); return out(201, { full_name: `jgriffith3433/${b.name}`, html_url: `https://github.test/jgriffith3433/${b.name}`, default_branch: 'main' }); }
  const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(p);
  if (m) {
    const r = repo(m[1]);
    const rest = m[2] ?? '';
    if (!rest) return out(200, { id: 42, owner: { id: 7 }, full_name: m[1], default_branch: 'main', permissions: { push: true } });
    let x: RegExpExecArray | null;
    if ((x = /^\/branches\/(.+)$/.exec(rest))) return r.branches.has(x[1]) ? out(200, { name: x[1] }) : out(404, { message: 'Branch not found' });
    // A repo marked perBranch keeps each branch's files apart (a commit lands on the branch whose ref it moves).
    if ((x = /^\/contents\/(.+)$/.exec(rest)) && r.perBranch) { const f = r.byBranch?.get(u.searchParams.get('ref') ?? 'main')?.get(x[1]); return f !== undefined ? out(200, { path: x[1], encoding: 'base64', content: Buffer.from(String(f)).toString('base64') }) : out(404, { message: 'Not Found' }); }
    if ((x = /^\/contents\/(.+)$/.exec(rest))) return r.files.has(x[1]) ? out(200, { path: x[1], encoding: 'base64', content: Buffer.from(String(r.files.get(x[1]))).toString('base64') }) : out(404, { message: 'Not Found' });
    if ((x = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) return r.branches.has(x[1]) ? out(200, { object: { sha: r.branches.get(x[1]) } }) : out(404, { message: 'no ref' });
    if (/^\/git\/commits\/.+$/.test(rest) && req.method === 'GET') return out(200, { tree: { sha: 't0' } });
    if (rest === '/git/trees') { for (const f of b.tree) r.files.set(f.path, f.content); r.pending = b.tree; return out(201, { sha: `t${++commitN}` }); }
    if (rest === '/git/commits') return out(201, { sha: `c${++commitN}` });
    if ((x = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && req.method === 'PATCH') { r.branches.set(x[1], b.sha); if (r.perBranch && r.pending) { r.byBranch ??= new Map(); if (!r.byBranch.has(x[1])) r.byBranch.set(x[1], new Map()); for (const f of r.pending) r.byBranch.get(x[1])!.set(f.path, f.content); r.pending = null; } return out(200, {}); }
    if (rest === '/pages' && req.method === 'PUT') { r.pagesFlipped = true; r.pages = { ...r.pages, build_type: b.build_type }; return out(204, {}); }
    if (rest === '/git/refs' && req.method === 'POST') { r.branches.set(b.ref.replace('refs/heads/', ''), b.sha); return out(201, {}); }
    if (rest === '/pages' && req.method === 'GET') return r.pages ? out(200, r.pages) : out(404, { message: 'Not Found' });
    if (rest === '/pages' && req.method === 'POST') { r.pages = { build_type: b.build_type, html_url: `https://${m[1].split('/')[0]}.github.io/${m[1].split('/')[1]}/` }; return out(201, r.pages); }
  }
  out(404, { message: `stand-in has no ${req.method} ${p}` });
});
await new Promise<void>((r) => gh.listen(0, '127.0.0.1', () => r()));
const ghBase = `http://127.0.0.1:${(gh.address() as any).port}`;
process.env.GITHUB_API_BASE = ghBase;
process.env.GITHUB_WEB_BASE = ghBase;
test.after(() => gh.close());

const C = await import('../src/config.ts');
const A = await import('../src/auth.ts');
const G = await import('../src/github-app.ts');
const R = await import('../src/repokit.ts');
const S = await import('../src/starters.ts');

const j = A.googleUser({ email: 'piercehawkes3@gmail.com', sub: '3000001', name: 'J' });

test("J's Studio keeps added games in its data, beside products.json, and never over one of its ids", () => {
  const before = C.loadProducts().length;
  const g = C.saveProduct({ id: 'space-game', name: 'Space Game', engine: 'web', live: 'https://acme.github.io/space-game/', repo: 'acme/space-game' });
  assert.equal(g.local.serve, 'remote', 'played where it is deployed');
  assert.equal(C.loadProducts().length, before + 1);
  // As a product, a web game's beta is Studio's own beta site, built from its beta branch: never "its CI deploys it"
  // (2026-10-31: Star Skipper's beta was never built and its beta playtest played the live starter).
  const p = C.getProduct('space-game');
  assert.notEqual(p.local.serve, 'remote');
  assert.equal(p.local.dir, `${p.repo}/dist`);
  assert.ok(fs.existsSync(path.join(process.env.STUDIO_DATA!, 'games.json')));
  assert.throws(() => C.saveProduct({ id: 'doseofdestruction', name: 'x', engine: 'web', live: 'https://x.test/' }), /products\.json's/);
  assert.throws(() => C.removeProduct('doseofdestruction'), /products\.json's/);
});

test('the GitHub App: the manifest page, the conversion, installation tokens from a signed JWT', async () => {
  const page = G.setupPage('https://studio.test');
  assert.match(page, /settings\/apps\/new\?state=/);
  const manifest = JSON.parse(/name="manifest" value="([^"]+)"/.exec(page)![1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  assert.equal(manifest.redirect_url, 'https://studio.test/api/github/app/created');
  assert.equal(manifest.default_permissions.contents, 'write');
  await assert.rejects(G.appCreated('abc', 'forged.state'), /expired or was not made here/);
  const state = decodeURIComponent(/state=([^"&]+)/.exec(page)![1]);
  const r = await G.appCreated('abc', state);
  assert.equal(r.install, `${ghBase}/apps/hawkes-studio-test/installations/new`);
  assert.equal(fs.statSync(path.join(process.env.STUDIO_DATA!, 'github-app.json')).size > 100, true);
  const access = await G.accessFor('acme/space-game');
  assert.deepEqual(access, { token: 'ghs_install', via: 'app' });
  assert.equal(await G.accessFor('acme/not-chosen'), null, 'the installation reaches only the chosen repos');
});

test('signing in with GitHub keeps the person\'s token; Talk uses the admin who linked it', async () => {
  const url = new URL(G.connectUrl('https://studio.test', j.id));
  const r = await G.userCallback('https://studio.test', 'code1', url.searchParams.get('state')!);
  assert.equal(r.login, 'jgriffith3433');
  assert.equal((await G.userToken(j.id))!.token, 'ghu_user');
  assert.equal(G.linkedAdmin(), j.id);
  const s = await G.githubStatus('https://studio.test', j.id);
  assert.equal(s.user!.login, 'jgriffith3433');
  assert.equal(s.connect, null);
  assert.deepEqual(s.installations.map((i) => i.account), ['acme']);
});

test("Talk and Studio's own keys use the admin's GitHub; a signed-in person who hasn't linked theirs sees their own connect", async () => {
  const { githubUserFor } = await import('../src/github-routes.ts');
  const bare: any = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(await githubUserFor(bare), j.id, 'no person: the admin who signed in with GitHub');
  assert.equal(G.isLinked(j.id), true);
  assert.equal(G.isLinked('u_nobody'), false);
});

test('readiness walks a game through what it lacks; the setup plan adds the hook, the branches and Pages', async () => {
  const r = await R.readiness('space-game', j.id);
  assert.equal(r.ready, false);
  const ids = Object.fromEntries(r.items.map((i) => [i.id, i.ok]));
  assert.equal(ids.repo, true);
  assert.equal(ids.access, true);
  assert.equal(ids.hook, false);
  assert.equal(ids.branches, false);
  assert.deepEqual(r.approve, { kind: 'setup', product: 'space-game', repo: 'acme/space-game', steps: ['hook', 'branches'] });
  // Links straight to the pages: the app's install page with this repo chosen, a prefilled token form as the fallback.
  assert.equal(r.links.install, `${ghBase}/apps/hawkes-studio-test/installations/new`);
  assert.match(r.links.token, /personal-access-tokens\/new\?.*target_name=acme.*contents=write/);
  assert.equal(r.items.find((i) => i.id === 'branches')!.link, 'https://github.com/acme/space-game/branches');
  const d = await R.describePlan(r.approve as any);
  assert.deepEqual(d.blockers, []);
  const done = await R.applyPlan(r.approve as any);
  assert.equal(done.length, 2);
  assert.match(repos.get('acme/space-game')!.files.get('.github/workflows/hawkes-studio.yml')!, /https:\/\/studio\.test\/api\/hooks\/github/);
  const again = await R.readiness('space-game', j.id);
  assert.equal(again.items.find((i) => i.id === 'hook')!.ok, true);
  assert.equal(again.items.find((i) => i.id === 'branches')!.ok, true);
  assert.equal(again.approve, null);
});

test("a repo whose hook points at another Studio: readiness says so and offers to point it here; the rewrite keeps the rest", async () => {
  const file = '.github/workflows/hawkes-studio.yml';
  const r0 = repos.get('acme/space-game')!;
  const mine = r0.files.get(file)!;
  // The hook as another Studio wrote it (a customer's Studio at its own address).
  r0.files.set(file, mine.split('https://studio.test').join('https://studio.hawkesgen.ai/o/acme-1a2b'));
  const r = await R.readiness('space-game', j.id);
  const hook = r.items.find((i) => i.id === 'hook')!;
  assert.equal(hook.ok, false);
  assert.match(hook.what, /points at another Studio \(https:\/\/studio\.hawkesgen\.ai\/o\/acme-1a2b\)/);
  assert.equal(hook.step, 'repoint');
  assert.deepEqual(r.approve, { kind: 'setup', product: 'space-game', repo: 'acme/space-game', steps: ['repoint'] });
  const d = await R.describePlan(r.approve as any);
  assert.match(d.lines.join('\n'), /point this repo's hook at this Studio/);
  const done = await R.applyPlan(r.approve as any);
  assert.match(done[0], /Pointed acme\/space-game's hook at https:\/\/studio\.test \(main\)/);
  const now = r0.files.get(file)!;
  assert.equal(now, mine, 'the same workflow, with this Studio as its audience and address');
  assert.equal((await R.readiness('space-game', j.id)).items.find((i) => i.id === 'hook')!.ok, true);
});

test('handover: where a hook points, and the rewrite for any pair of Studios', async () => {
  const H = await import('../src/handover.ts');
  const yml = (base: string) => `jobs:\n  notify:\n    steps:\n      - run: |\n          token=$(curl -sSf "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=${base}" | jq -r .value)\n          curl -X POST -H "Authorization: Bearer $token" ${base}/api/hooks/github\n`;
  assert.deepEqual(H.hookTargets(yml('https://studio.hawkesgen.ai')), ['https://studio.hawkesgen.ai']);
  assert.equal(H.hookPointsAt(yml('https://studio.hawkesgen.ai'), 'https://studio.hawkesgen.ai/').ok, true);
  const there = H.hookPointsAt(yml('https://studio.hawkesgen.ai'), 'https://studio.hawkesgen.ai/o/acme');
  assert.equal(there.ok, false);
  assert.deepEqual(there.elsewhere, ['https://studio.hawkesgen.ai']);
  // J's Studio -> a customer's, and back: the address is a prefix of the other either way.
  assert.equal(H.repointHook(yml('https://studio.hawkesgen.ai'), 'https://studio.hawkesgen.ai/o/acme'), yml('https://studio.hawkesgen.ai/o/acme'));
  assert.equal(H.repointHook(yml('https://studio.hawkesgen.ai/o/acme'), 'https://studio.hawkesgen.ai'), yml('https://studio.hawkesgen.ai'));
  assert.equal(H.repointHook('name: build\non: push\n', 'https://x.test'), null, 'no Studio address in it: write the hook instead');
  assert.equal(H.hookPointsAt('name: build\n').ok, false);
});

test('a new game: asked what kind first (the plan wants a pitch and a starter), then a repo that already plays', async () => {
  await assert.rejects(R.newGamePlan({ name: 'Orbit Run' }, j.id), /pitch/);
  await assert.rejects(R.newGamePlan({ name: 'Orbit Run', pitch: 'A tiny 3D game about collecting orbs.', starter: 'nope' }, j.id), /starter/);
  const plan = await R.newGamePlan({ name: 'Orbit Run', pitch: 'A tiny 3D game about collecting orbs on a moon.', starter: 'web-3d' }, j.id);
  assert.equal(plan.kind, 'new');
  const d = await R.describePlan(plan);
  assert.deepEqual(d.blockers, []);
  assert.match(d.lines.join('\n'), /jgriffith3433\/orbit-run/);
  const done = await R.applyPlan(plan);
  const r = repos.get('jgriffith3433/orbit-run')!;
  for (const f of ['package.json', 'index.html', 'src/main.js', 'src/playtest.js', 'src/playtest/hawkes-playtest.js', '.github/workflows/hawkes-studio.yml', '.github/workflows/pages.yml', 'AGENTS.md']) assert.ok(r.files.has(f), f);
  assert.equal(JSON.parse(r.files.get('package.json')!).name, 'orbit-run');
  assert.match(r.files.get('src/main.js')!, /setupPlaytest\(game\)/);
  assert.ok(r.branches.has('beta') && r.branches.has('dev'));
  assert.equal(r.pages.build_type, 'workflow');
  const p = C.getProduct('orbit-run');
  assert.equal(p.live, 'https://jgriffith3433.github.io/orbit-run/');
  assert.equal(p.contract, true);
  // Agents can work on it like any product: cloned into its own folder, its build as the check.
  assert.equal(p.github, 'jgriffith3433/orbit-run');
  assert.equal(p.repo, 'orbit-run');
  assert.equal(p.local.dir, 'orbit-run/dist', 'its built site');
  assert.deepEqual(p.checks, [{ dir: 'orbit-run', cmd: 'test ! -f package.json || (npm install --no-audit --no-fund && npm run build --if-present)' }]);
  const { repoMap } = await import('../src/repos.ts');
  assert.equal(repoMap()['orbit-run'], 'jgriffith3433/orbit-run');
  assert.equal(repoMap()['doseofdestructionwebsite'], 'jgriffith3433/doseofdestructionwebsite', "products.json's stay");
  assert.ok(done.some((l) => /Added "Orbit Run" to Studio/.test(l)));
  assert.ok(done.some((l) => /first version wasn't started \(Agent workers are turned off/.test(l)), 'the first version is asked for by itself');
  // Everything about it in one answer, with its links.
  const st = await R.gameStatus('orbit-run', 'https://studio.test', j.id);
  assert.equal(st.game.repo, 'jgriffith3433/orbit-run');
  assert.equal(st.links.live, 'https://jgriffith3433.github.io/orbit-run/');
  assert.equal(st.links.repo, 'https://github.com/jgriffith3433/orbit-run');
  assert.equal(st.links.studio, 'https://studio.test/#today');
  assert.deepEqual(st.playtests, []);
  assert.equal((st.findings as any).open, 0);
  assert.equal(R.contractBrief(p).criteria.length, 3);
  // The same game can't be made twice.
  assert.match((await R.describePlan(plan)).blockers.join(' '), /already has a game/);
});

test('every starter is complete: the playtest bot, the hook and Pages, valid package.json', () => {
  for (const s of S.STARTERS) {
    const files = S.starterFiles(s.id, { id: 'x-game', name: 'X <Game>', pitch: 'p', owner: 'o', repo: 'o/x-game', studioUrl: 'https://studio.test' });
    assert.ok(JSON.parse(files['package.json']).scripts.build, s.id);
    assert.match(files['index.html'], /X &lt;Game&gt;/, 'the name is escaped');
    assert.match(files['src/playtest.js'], /installPlaytest/);
    assert.match(files['.github/workflows/pages.yml'], /deploy-pages/);
  }
  assert.equal(S.liveUrlFor({ repo: 'Acme/acme.github.io' } as any), 'https://acme.github.io/');
});

test("each repo gets its own token: J's keep his, others the app's, as a one-command git header", async () => {
  const T = await import('../src/ghtoken.ts');
  T.forgetRepoTokens();
  process.env.GITHUB_TOKEN = 'ghp_j_own';
  try {
    assert.equal(await T.repoToken('jgriffith3433/orbit-run'), 'ghp_j_own');
    assert.equal(await T.repoToken('acme/space-game'), 'ghs_install', "the app's installation on acme");
    assert.equal(T.slugOfRoute('/repos/acme/space-game/pulls?state=open'), 'acme/space-game');
    assert.deepEqual(T.gitAuthEnv('jgriffith3433/orbit-run'), {}, "J's repos go through the credential helper as before");
    const env = T.gitAuthEnv('acme/space-game');
    assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
    assert.equal(Buffer.from(env.GIT_CONFIG_VALUE_0.replace('Authorization: Basic ', ''), 'base64').toString(), 'x-access-token:ghs_install');
  } finally {
    delete process.env.GITHUB_TOKEN;
    T.forgetRepoTokens();
  }
});

test("customers' Studios share the app: an install is linked to its org only after the person's sign-in shows it's theirs", async () => {
  const link = new URL(G.installLinkFor('org_a', 'https://studio.test/o/org_a/')!);
  assert.equal(link.pathname, '/apps/hawkes-studio-test/installations/new');
  const state = link.searchParams.get('state')!;
  await assert.rejects(G.userCallback('https://studio.test', 'code2', state, '999'), /isn't one your GitHub account can reach/);
  const r = await G.userCallback('https://studio.test', 'code2', state, '5');
  assert.equal(r.org, 'org_a');
  assert.equal(r.account, 'acme');
  assert.equal(r.back, 'https://studio.test/o/org_a/');
  assert.deepEqual((await G.orgInstallations('org_a')).map((i) => i.id), [5]);
  assert.deepEqual(await G.orgInstallations('org_b'), []);
  assert.throws(() => G.linkInstallation(5, 'org_b', 'acme'), /another Studio/, "another org can't take it over");
  // A token for one repo of the org's installation; nothing for another org or another owner.
  assert.equal((await G.orgRepoToken('org_a', 'acme/space-game'))!.token, 'ghs_install');
  assert.equal(await G.orgRepoToken('org_b', 'acme/space-game'), null);
  assert.equal(await G.orgRepoToken('org_a', 'someone/else'), null);
});

test("a sign-in right after installing from the app's own page uses Studio's session; customers' people sign in by org", async () => {
  // GitHub comes back from an install with no state of Studio's (J's first install, 2026-10-30): the session says who.
  // No state and no session (a customer's install: GitHub starts that sign-in itself): linked by GitHub account, and
  // this account signed in from no customer Studio yet, so nothing is linked.
  assert.equal((await G.userCallback('https://studio.test', 'c3', '', '5', null) as any).unlinked, true);
  await assert.rejects(G.userCallback('https://studio.test', 'c3', '', '', null), /expired or was not made here/);
  const r = await G.userCallback('https://studio.test', 'c3', '', '5', j.id);
  assert.equal(r.user, j.id);
  assert.equal(r.login, 'jgriffith3433');
  // A customer's person, through the control plane: kept under their org, given back to their Studio, never this one's.
  const url = new URL(G.connectUrl('https://studio.test', 'u_cust', { org: 'org_a', back: 'https://studio.test/o/org_a/' }));
  const c = await G.userCallback('https://studio.test', 'c4', url.searchParams.get('state')!);
  assert.equal(c.org, 'org_a');
  assert.equal(c.back, 'https://studio.test/o/org_a/');
  assert.equal((await G.userToken('u_cust', 'org_a'))!.login, 'jgriffith3433');
  assert.equal(await G.userToken('u_cust'), null, "not a sign-in of this Studio's");
  assert.deepEqual(G.orgGithubUsers('org_a'), ['u_cust']);
  assert.equal(G.linkedAdmin(), j.id);
});

test('the hook lands on every lane branch, and a site already on GitHub Pages is left exactly as it is', async () => {
  const r = repo('acme/old-site');
  r.perBranch = true;
  r.branches.set('beta', 'c0');
  r.branches.set('dev', 'c0');
  r.pages = { build_type: 'legacy', html_url: 'https://old-site.example/', source: { branch: 'main' } };
  const done = await R.applyPlan({ kind: 'setup', product: 'x', repo: 'acme/old-site', steps: ['hook', 'pages'] } as any);
  for (const b of ['main', 'beta', 'dev']) assert.match(String(r.byBranch?.get(b)?.get('.github/workflows/hawkes-studio.yml') ?? ''), /api\/hooks\/github/, `the hook on ${b}`);
  assert.match(done.join(' '), /main, beta, dev/);
  assert.equal(r.pages.build_type, 'legacy', 'still published from its branch');
  assert.ok(!r.pagesFlipped, 'never switched to Actions');
  assert.match(done.join(' '), /left as it is/);
});
