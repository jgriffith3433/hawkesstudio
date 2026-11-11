// Agents on a customer's games (J, 2026-10-30: "Build it"): in a customer's Studio a game with a GitHub repo is a product
// agents work on like J's (cloned into its own folder, its build as the check), and every GitHub token for it comes from
// the control plane, scoped to that repo (cellside.ts cellGithubToken; never J's GITHUB_TOKEN). The control plane is a
// small stand-in server here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-customer-agents-'));
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_CUSTOMER = '1';
process.env.GITHUB_TOKEN = 'ghp_j_must_never_reach_a_customer';
delete process.env.STUDIO_PRODUCTS;
const asked: any[] = [];
const cp = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const b = JSON.parse(body || '{}');
  asked.push({ path: req.url, cell: req.headers['x-studio-cell'], key: req.headers.authorization, body: b });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url === '/api/cells/self/github-token') return res.end(JSON.stringify(['acme/space-game', 'jgriffith3433/hawkesgen'].includes(b.repo) ? { token: 'ghs_scoped', expires: Date.now() + 3600_000 } : { token: null }));
  if (req.url === '/api/cells/self/github') return res.end(JSON.stringify({ app: { slug: 'hawkes-studio' }, install: 'https://github.com/apps/hawkes-studio/installations/new?state=x', installations: [], user: null, connect: null, linked: [] }));
  res.end('{}');
});
await new Promise<void>((r) => cp.listen(0, '127.0.0.1', () => r()));
test.after(() => cp.close());
process.env.STUDIO_CONTROL_URL = `http://127.0.0.1:${(cp.address() as any).port}`;
process.env.STUDIO_ORG = 'org_acme';
process.env.STUDIO_CELL_KEY = 'cell-key';

fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'products.json'), JSON.stringify({ products: [
  { id: 'space-game', name: 'Space Game', engine: 'web', live: 'https://acme.github.io/space-game/', repo: 'acme/space-game', about: 'A space game.', contract: false, playtests: [{ scenario: 'smoke', where: 'live' }], story: [] },
  { id: 'old-site', name: 'Old Site', engine: 'web', live: 'https://old.example/', about: 'No repo.', contract: false, playtests: [], story: [] },
] }));

const C = await import('../src/config.ts');
const T = await import('../src/ghtoken.ts');
const { repoMap } = await import('../src/repos.ts');

test("a customer's game with a repo is a product agents can work on; one without stays played where it is", () => {
  const g = C.getProduct('space-game');
  assert.equal(g.github, 'acme/space-game');
  assert.equal(g.repo, 'space-game');
  assert.equal(g.local.dir, 'space-game/dist', 'its built site');
  assert.match(g.checks![0].cmd, /npm run build --if-present/);
  assert.deepEqual(repoMap(), { 'space-game': 'acme/space-game' }, "only the customer's own repos, nothing of J's");
  const o = C.getProduct('old-site');
  assert.equal(o.local.dir, '');
  assert.equal(o.github, undefined);
});

test("its GitHub token comes from the control plane, scoped to that repo, never J's", async () => {
  T.forgetRepoTokens();
  assert.equal(await T.repoToken('acme/space-game'), 'ghs_scoped');
  const ask = asked.find((a) => a.path === '/api/cells/self/github-token');
  assert.equal(ask.cell, 'org_acme');
  assert.equal(ask.key, 'Bearer cell-key');
  assert.equal(await T.repoToken('someone/else'), null, "a repo the org's installations don't reach: nothing (not J's token)");
  assert.equal(T.repoTokenNow('acme/space-game'), 'ghs_scoped');
  assert.equal(T.repoTokenNow('never/primed'), null);
  const env = T.gitAuthEnv('acme/space-game');
  assert.match(env[`GIT_CONFIG_VALUE_${Number(env.GIT_CONFIG_COUNT) - 1}`], /^Authorization: Basic /, "the header is the last entry (after the process's own)");
});

test("one of J's repos only when this org's own GitHub App installation covers it (ownership, not the name)", async () => {
  await C.checkRepoOwnership({ repo: 'jgriffith3433/hawkesgen' });
  await C.checkRepoOwnership({ repo: 'acme/app', repos: [{ repo: 'https://github.com/jgriffith3433/hawkesgen.git' }] });
  await assert.rejects(C.checkRepoOwnership({ repo: 'jgriffith3433/sickofitgame-unity' }), /isn't installed on that repository/);
  T.forgetRepoTokens();
  assert.equal(await T.repoToken('jgriffith3433/hawkesgen'), 'ghs_scoped', "the org's own token, never J's GITHUB_TOKEN");
  assert.equal(await T.repoToken('jgriffith3433/sickofitgame-unity'), null);
});
