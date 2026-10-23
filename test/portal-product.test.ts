// The Hawkes Gen customer portal (hawkesgenwebsite) as a product: its products.json entry is consistent with the
// others, and a product that deploys to its own server (deploy.via "ec2") is described as that, never as GitHub
// Pages, in the go-live and rollback plans. Throwaway git repos; nothing real is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const real = JSON.parse(fs.readFileSync(new URL('../products.json', import.meta.url), 'utf8'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-portal-'));
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [
  { id: 'portal', name: 'Portal', framing: 'test', engine: 'web', repo: 'portalrepo', site: 'portalrepo', live: 'http://127.0.0.1:9/',
    local: { serve: 'npm', dir: 'portalrepo', port: 8795, path: '/' }, playtests: [{ mode: 'site', where: 'live' }], story: [], about: 'A fixture.',
    deploy: { via: 'ec2', box: 'the test box' } },
  { id: 'pages', name: 'Pages site', framing: 'test', engine: 'web', repo: 'pagesrepo', site: 'pagesrepo', live: 'http://127.0.0.1:9/',
    local: { serve: 'npm', dir: 'pagesrepo', port: 8794, path: '/' }, playtests: [], story: [], about: 'A fixture.' },
], repos: {} }));

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
function repo(name: string) {
  const origin = path.join(tmp, `${name}.git`);
  const dir = path.join(process.env.STUDIO_PROJECTS!, name);
  git(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '--quiet', origin, dir);
  fs.writeFileSync(path.join(dir, 'index.html'), 'v1');
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'First');
  git(dir, 'push', '--quiet', 'origin', 'HEAD:main');
  return dir;
}

const { db, newId, J } = await import('../src/db.ts');
const { getProduct } = await import('../src/config.ts');
const beta = await import('../src/beta.ts');
const { deployPlan, publisherOf, rollbackPlan } = await import('../src/deploy.ts');
const { recipeOf } = await import('../src/previews.ts');

test('the real products.json entry: repo, beta site, live site, playtests, dev front door', () => {
  const p = real.products.find((x: any) => x.id === 'hawkesgenwebsite');
  assert.ok(p, 'the product is listed');
  assert.equal(p.repo, 'hawkesgenwebsite');
  assert.equal(p.live, 'https://hawkesgen.com/');
  assert.equal(real.repos.hawkesgenwebsite, 'jgriffith3433/hawkesgenwebsite');
  assert.equal(real.previews.portal, 'hawkesgenwebsite');
  assert.deepEqual(p.deploy, { via: 'ec2', box: p.deploy.box });
  // No unattended signing up or paying: only read-only site crawls of the live pages, and no local run it can't make.
  assert.ok(p.playtests.length && p.playtests.every((t: any) => t.mode === 'site' && t.where === 'live'));
  assert.ok(p.quality && /Stripe/.test(p.quality));
  // Ports are unique across every product (local servers, dev servers, front doors).
  const ports = real.products.flatMap((x: any) => [x.local.port, x.dev?.front, x.dev?.port]).filter(Boolean);
  assert.equal(new Set(ports).size, ports.length, `duplicate port in ${ports.join(',')}`);
  // The subdomains and products they name exist.
  for (const id of Object.values(real.previews)) assert.ok(real.products.some((x: any) => x.id === id), `${id} is a product`);
  assert.deepEqual(recipeOf('hawkesgenwebsite'), { site: 'tracked' });
});

test('who publishes main: GitHub Pages by default, the product\'s own server for deploy.via ec2', () => {
  assert.equal(publisherOf(getProduct('pages')).box, false);
  assert.match(publisherOf(getProduct('pages')).says, /GitHub Pages/);
  const own = publisherOf(getProduct('portal'));
  assert.equal(own.box, true);
  assert.match(own.says, /the test box/);
  assert.doesNotMatch(own.says + own.done, /Pages/);
});

test('the go-live and rollback plans of a product on its own server say so, and DEPLOY stays J\'s typed words', async () => {
  const dir = repo('portalrepo');
  await beta.ensureBeta(dir);
  git(dir, 'checkout', '--quiet', '-b', 'beta', 'origin/beta');
  fs.writeFileSync(path.join(dir, 'index.html'), 'v2');
  git(dir, 'commit', '--quiet', '-am', 'New landing page');
  git(dir, 'push', '--quiet', 'origin', 'beta');
  await beta.fetchOrigin(dir);
  db.prepare('INSERT INTO steps (id, run, product, kind, name, status, detail, data, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(newId('s'), newId('r'), 'portal', 'playtest', 'site@local', 'done', 'won', J({ outcome: 'won', played: { branch: 'beta', sha: git(dir, 'rev-parse', 'origin/beta') } }), Date.now(), Date.now());
  const plan = await deployPlan('portal');
  assert.deepEqual(plan.commits.map((c) => c!.title), ['New landing page']);
  assert.equal(plan.confirm, 'DEPLOY portal');
  assert.match(plan.what, /the test box/);
  assert.doesNotMatch(plan.what, /GitHub Pages/);
  // A plain Pages product still says Pages.
  repo('pagesrepo');
  assert.match((await deployPlan('pages')).what, /GitHub Pages publishes/);
  // Rolling back doesn't undo a database.
  const rp = await rollbackPlan('portal');
  assert.ok(rp.warnings.some((w) => /database/.test(w)), rp.warnings.join(' | '));
});
