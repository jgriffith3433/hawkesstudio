// Going live and rolling back for any project with a GitHub repo, in a customer's Studio (deploy-github.ts; J,
// 2026-10-31): the plan from GitHub's compare API and the played beta commit's playtests, main fast-forwarded to exactly
// that commit, a build committed into another project's repo going live with it, a rollback as a new commit with the
// old tree, and projects handed over to another Studio left alone. GitHub and the control plane (the repo's own token)
// are stand-ins; nothing real is touched, and J's GITHUB_TOKEN never reaches a customer's repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fakeGitHub, sha } from './fake-github.ts';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-deploy-github-'));
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_CUSTOMER = '1';
process.env.STUDIO_PUBLIC_URL = 'https://studio.hawkesgen.ai/o/acme';
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9';
process.env.GITHUB_TOKEN = 'ghp_j_must_never_reach_a_customer';
delete process.env.STUDIO_PRODUCTS;
delete process.env.K_SERVICE;

// The control plane hands out each repo's own token (cellside.ts cellGithubToken).
const cp = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const b = JSON.parse(body || '{}');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url === '/api/cells/self/github-token') return res.end(JSON.stringify(String(b.repo).startsWith('acme/') ? { token: `ghs_${String(b.repo).split('/')[1]}`, expires: Date.now() + 3600_000 } : { token: null }));
  res.end('{}');
});
await new Promise<void>((r) => cp.listen(0, '127.0.0.1', () => r()));
test.after(() => cp.close());
process.env.STUDIO_CONTROL_URL = `http://127.0.0.1:${(cp.address() as any).port}`;
process.env.STUDIO_ORG = 'org_acme';
process.env.STUDIO_CELL_KEY = 'cell-key';
fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'agents.json'), JSON.stringify({ enabled: true }));

const game = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id[0].toUpperCase() + id.slice(1), engine: 'web', repo: `acme/${id}`, about: '', contract: true, playtests: [], story: [], ...extra });
fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'products.json'), JSON.stringify({ products: [
  game('webby'),
  game('starfall', { engine: 'unity', builds: [{ id: 'web', tool: 'unity', path: 'Game', publish: { project: 'starsite', path: 'Game/', commit: true } }] }),
  game('starsite'),
  game('handed', { managedBy: 'https://studio.hawkesgen.ai/o/other' }),
] }));

// ---- GitHub
const gh = fakeGitHub({
  'acme/webby': { refs: { main: sha('1'), beta: sha('3') }, commits: { [sha('1')]: { parents: [], tree: 't1' }, [sha('2')]: { parents: [sha('1')], tree: 't2', title: 'Faster jumps' }, [sha('3')]: { parents: [sha('2')], tree: 't3', title: 'A new level' } } },
  'acme/starfall': { refs: { main: sha('a'), beta: sha('b') }, commits: { [sha('a')]: { parents: [], tree: 'ta' }, [sha('b')]: { parents: [sha('a')], tree: 'tb', title: 'Boss fight' } } },
  'acme/starsite': { refs: { main: sha('c'), beta: sha('d') }, commits: { [sha('c')]: { parents: [], tree: 'tc' }, [sha('d')]: { parents: [sha('c')], tree: 'td', title: 'Build web 1 of Starfall (bbbbbbb)' } } },
});
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => (new URL(String(input instanceof Request ? input.url : input)).host === 'api.github.com' ? gh.f(input, init) : realFetch(input, init))) as typeof fetch;
test.after(() => { globalThis.fetch = realFetch; });

const C = await import('../src/config.ts');
const D = await import('../src/deploy.ts');
const { db } = await import('../src/db.ts');
await import('../src/builds.ts'); // the builds table

/** A finished local playtest of `product` that played `played` (the beta site's short commit), with its review. */
function played(product: string, played: string, run = `r_${product}_${played}`) {
  const at = Date.now();
  db.prepare('INSERT OR IGNORE INTO runs (id, kind, status, started) VALUES (?, ?, ?, ?)').run(run, 'beta', 'done', at);
  db.prepare('INSERT INTO steps (id, run, product, kind, name, status, detail, data, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`s_${run}_p`, run, product, 'playtest', 'smoke@local', 'done', 'won', JSON.stringify({ played: { branch: 'beta', sha: played }, outcome: 'won' }), at, at);
  db.prepare('INSERT INTO steps (id, run, product, kind, name, status, detail, data, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`s_${run}_r`, run, product, 'review', 'smoke@local', 'done', 'ship', JSON.stringify({ verdict: 'ship', summary: 'fine', findings: [] }), at, at);
}

test("a customer's web project: the plan comes from GitHub with the repo's own token, and needs beta played at that commit", async () => {
  const plan = await D.deployPlan('webby');
  assert.equal(plan.repo, 'acme/webby');
  assert.equal(plan.beta?.sha, sha('3'));
  assert.deepEqual(plan.commits.map((c) => c!.title), ['A new level', 'Faster jumps']);
  assert.match(plan.blockers.join('\n'), /hasn't been playtested yet/);
  assert.equal(plan.canDeploy, false);
  const auths = new Set(gh.calls.map((c) => c.auth));
  assert.deepEqual([...auths], ['Bearer ghs_webby'], "only the repo's own token, never J's");
  played('webby', sha('3').slice(0, 7));
  const ready = await D.deployPlan('webby');
  assert.deepEqual(ready.blockers, []);
  assert.equal(ready.tested.playtests[0].verdict, 'ship');
  assert.equal(ready.confirm, 'DEPLOY webby');
  assert.match(ready.what, /Fast-forwards acme\/webby's main to beta 3333333 \(2 commit\(s\)\)/);
});

test('going live needs the owner\'s typed words, then fast-forwards main to exactly the played beta commit and records it', async () => {
  await assert.rejects(D.deploy('webby', {}), /confirm: "DEPLOY webby"/);
  await assert.rejects(D.deploy('webby', { confirm: 'DEPLOY webby', beta: sha('2') }), /not 2222222 that J approved/);
  assert.equal(gh.repos['acme/webby'].refs.main, sha('1'), 'nothing moved');
  const r: any = await D.deploy('webby', { confirm: 'DEPLOY webby', by: 'owner', beta: sha('3') });
  assert.equal(r.ok, true);
  assert.equal(gh.repos['acme/webby'].refs.main, sha('3'));
  const patch = gh.calls.filter((c) => c.method === 'PATCH');
  assert.deepEqual(patch.map((c) => c.path), ['/repos/acme/webby/git/refs/heads/main']);
  const d: any = db.prepare(`SELECT * FROM deploys WHERE product = 'webby'`).get();
  assert.equal(d.before, sha('1'));
  assert.equal(d.after, sha('3'));
  assert.equal(d.repo, 'acme/webby');
  assert.equal(d.by, 'owner');
  assert.match((await D.deployPlan('webby')).blockers.join('\n'), /Nothing to go live/);
});

test('beta moving after the plan stops the go live, and moves nothing', async () => {
  const w = gh.repos['acme/webby'];
  w.commits[sha('4')] = { parents: [sha('3')], tree: 't4', title: 'More' };
  w.refs.beta = sha('4');
  played('webby', sha('4').slice(0, 7));
  const plan = await D.deployPlan('webby');
  assert.deepEqual(plan.blockers, []);
  w.commits[sha('5')] = { parents: [sha('4')], tree: 't5', title: 'Even more' };
  w.refs.beta = sha('5');
  // Unplayed, so the plan refuses it; and the go live itself reads beta again and refuses a stale plan.
  await assert.rejects(D.deploy('webby', { confirm: 'DEPLOY webby', beta: sha('4') }), /hasn't been playtested at 5555555/);
  const { goLiveOnGitHub } = await import('../src/deploy-github.ts');
  await assert.rejects(goLiveOnGitHub(C.getProduct('webby'), plan as any), /moved since the plan/);
  assert.equal(w.refs.main, sha('3'));
  w.refs.beta = sha('4');
});

test('rollback: a new commit on main with the tree live before, never a force push; recorded, and the go live marked', async () => {
  const plan = await D.rollbackPlan('webby');
  assert.equal(plan.to?.sha, sha('1'));
  assert.deepEqual(plan.undo.map((c) => c!.title), ['A new level', 'Faster jumps']);
  assert.deepEqual(plan.blockers, []);
  await assert.rejects(D.rollback('webby', {}), /confirm: "ROLLBACK webby"/);
  const r: any = await D.rollback('webby', { confirm: 'ROLLBACK webby', by: 'owner' });
  const w = gh.repos['acme/webby'];
  const head = w.refs.main;
  assert.equal(r.main, head.slice(0, 7));
  assert.deepEqual(w.commits[head].parents, [sha('3')], 'on top of what was live');
  assert.equal(w.commits[head].tree, 't1', 'with the files of the commit before the go live');
  assert.match(w.commits[head].title!, /to 1111111 \(undoes go live d_/);
  const rows: any[] = db.prepare(`SELECT * FROM deploys WHERE product = 'webby' ORDER BY at`).all();
  assert.equal(rows[0].rolled_back, rows[1].id);
  assert.equal(rows[1].kind, 'rollback');
  assert.match((await D.rollbackPlan('webby')).blockers.join('\n'), /No go live by Studio is recorded/);
});

test("a build committed into another project's repo goes live with its project: both mains fast-forward", async () => {
  // Beta is played where the build is mounted (the website's beta site, in the build's run: builds.ts playIt).
  const before = await D.deployPlan('starfall');
  assert.match(before.blockers.join('\n'), /Build web of beta bbbbbbb isn't in acme\/starsite's beta yet/);
  db.prepare('INSERT INTO runs (id, kind, status, started) VALUES (?, ?, ?, ?)').run('r_build_1', 'build', 'done', Date.now());
  db.prepare("INSERT INTO builds (id, product, build, version, status, sha, ref, runner, target, run, started, commit_repo, commit_sha) VALUES ('b_1', 'starfall', 'web', 1, 'ready', ?, 'beta', 'gen', 'web', 'r_build_1', ?, 'acme/starsite', ?)").run(sha('b'), Date.now(), sha('d'));
  played('starsite', sha('d').slice(0, 7), 'r_build_1');
  const plan: any = await D.deployPlan('starfall');
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.tested.playtests[0].name, 'smoke@local (starsite)');
  assert.deepEqual(plan.github.targets.map((t: any) => [t.slug, t.commit, t.move]), [['acme/starsite', sha('d'), true]]);
  assert.match(plan.what, /acme\/starsite's main to its beta commit holding build web 1/);
  await D.deploy('starfall', { confirm: 'DEPLOY starfall', beta: sha('b') });
  assert.equal(gh.repos['acme/starsite'].refs.main, sha('d'));
  assert.equal(gh.repos['acme/starfall'].refs.main, sha('b'));
  const site: any = db.prepare(`SELECT * FROM deploys WHERE product = 'starsite'`).get();
  assert.deepEqual([site.before, site.after, site.source, site.source_after, site.version], [sha('c'), sha('d'), 'acme/starfall', sha('b'), '1']);
  assert.ok(gh.calls.some((c) => c.path.startsWith('/repos/acme/starsite/') && c.auth === 'Bearer ghs_starsite'), "each repo with its own token");
});

test('a project handed over to another Studio: left out of beta runs, agents and hooks, and it never goes live from here', async () => {
  const p = C.getProduct('handed');
  assert.equal(C.managedElsewhere(p), 'https://studio.hawkesgen.ai/o/other');
  assert.equal(C.managedElsewhere({ managedBy: 'https://studio.hawkesgen.ai/o/acme/' }), null, "this Studio's own address isn't elsewhere");
  const { startBeta } = await import('../src/pipeline.ts');
  assert.throws(() => startBeta('handed'), /managed by another Studio \(https:\/\/studio\.hawkesgen\.ai\/o\/other\)/);
  const A = await import('../src/agents.ts');
  assert.throws(() => A.startTask('handed', 'add a level'), /managed by another Studio/);
  assert.throws(() => A.startFix('handed', ['f_x']), /managed by another Studio/);
  const B = await import('../src/builds.ts');
  const hook: any = await B.onRepoHook({ repository: 'acme/handed', ref: 'refs/heads/beta', sha: sha('9') }, {});
  assert.equal(hook.managedBy, 'https://studio.hawkesgen.ai/o/other');
  assert.deepEqual(hook.runs, {});
  const H = await import('../src/handover.ts');
  assert.equal(await H.managedForRepo('acme/handed'), 'https://studio.hawkesgen.ai/o/other');
  assert.equal(await H.managedForRepo('acme/webby'), null);
  const { idleProducts } = await import('../src/pm.ts');
  assert.ok(!idleProducts().includes('handed'));
  const plan = await D.deployPlan('handed');
  assert.match(plan.blockers[0], /managed by another Studio/);
  assert.throws(() => C.saveProduct({ id: 'x2', name: 'X', engine: 'web', repo: 'acme/x2', managedBy: 'ftp://nope' }), /managedBy/);
  const saved = C.saveProduct({ id: 'x2', name: 'X', engine: 'web', repo: 'acme/x2', managedBy: 'https://studio.hawkesgen.ai/o/other/' });
  assert.equal(saved.managedBy, 'https://studio.hawkesgen.ai/o/other');
  // Nothing is deleted: its history stays readable.
  assert.equal(C.getProduct('handed').id, 'handed');
});
