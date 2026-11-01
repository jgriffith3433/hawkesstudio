// A Cloud Run job (an agent's pass, a beta site's build) clones its repo with a token kept in its spec. It gets the
// GitHub App's token for that one repo, read-only (contents: read): the job only clones and fetches, and Studio pushes
// the branch and opens the pull request itself. Before, J's Studio handed it J's own GITHUB_TOKEN (every repo, write),
// and other Studios the installation's token for every repo it reaches (2026-11-01).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-agent-job-scoped-'));
process.env.STUDIO_DATA = path.join(TMP, 'data');
process.env.STUDIO_PROJECTS = path.join(TMP, 'projects');
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_JOB_POLL_MS = '50';
delete process.env.STUDIO_CUSTOMER;
process.env.GITHUB_TOKEN = 'ghp_js_own_token';
delete process.env.STUDIO_JOB_GITHUB_TOKEN;
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'products.json'), JSON.stringify({ products: [], repos: {} }));

// The stand-in GitHub: the App on J's account (all repos) and on acme's, whose installation won't narrow permissions.
const posts: { path: string; body: any }[] = [];
const gh = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const p = new URL(req.url!, 'http://x').pathname;
  const out = (s: number, o: unknown) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (p === '/app/installations') return out(200, [
    { id: 9, account: { login: 'jgriffith3433', type: 'User' }, repository_selection: 'all' },
    { id: 12, account: { login: 'acme', type: 'Organization' }, repository_selection: 'selected' },
  ]);
  const m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p);
  if (m && req.method === 'POST') {
    const body = raw ? JSON.parse(raw) : {};
    posts.push({ path: p, body });
    const expires_at = new Date(Date.now() + 3600_000).toISOString();
    if (!body.repositories) return out(201, { token: `ghs_whole_${m[1]}`, expires_at });
    if (m[1] === '12' && body.permissions) return out(422, { message: 'The permissions requested are not granted to this installation.' });
    if (body.repositories[0] === 'missing') return out(422, { message: 'There is at least one repository that does not exist or is not accessible to the parent installation.' });
    return out(201, { token: `ghs_${body.repositories[0]}_${body.permissions ? 'read' : 'inst'}`, expires_at });
  }
  out(404, { message: `no ${req.method} ${p}` });
});
await new Promise<void>((r) => gh.listen(0, '127.0.0.1', () => r()));
process.env.GITHUB_API_BASE = `http://127.0.0.1:${(gh.address() as any).port}`;
test.after(() => gh.close());
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'github-app.json'), JSON.stringify({ id: 1, slug: 'hawkes-studio-test', clientId: 'Iv1.x', clientSecret: 's', pem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(), htmlUrl: 'x', owner: 'jgriffith3433' }));

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();

test('repoJobToken: one repo, read-only; the installation\'s permissions when it won\'t narrow them; null when unreachable', async () => {
  const { repoJobToken } = await import('../src/github-app.ts');
  assert.equal(await repoJobToken('jgriffith3433/hawkesgen'), 'ghs_hawkesgen_read');
  assert.deepEqual(posts.at(-1), { path: '/app/installations/9/access_tokens', body: { repositories: ['hawkesgen'], permissions: { contents: 'read' } } });
  const n = posts.length;
  assert.equal(await repoJobToken('jgriffith3433/hawkesgen'), 'ghs_hawkesgen_read', 'kept while most of its hour is left');
  assert.equal(posts.length, n);
  assert.equal(await repoJobToken('acme/game'), 'ghs_game_inst');
  assert.deepEqual(posts.slice(-2).map((x) => x.body), [{ repositories: ['game'], permissions: { contents: 'read' } }, { repositories: ['game'] }]);
  assert.equal(await repoJobToken('jgriffith3433/missing'), null, 'a repo the installation doesn\'t reach');
  assert.equal(await repoJobToken('nobody/thing'), null, 'no installation on the owner');
  assert.ok(posts.every((x) => x.body.repositories), 'never a token for every repo');
});

test("J's Studio: an agent's job gets the App's read-only token for its repo, not J's GITHUB_TOKEN", async () => {
  const { setJobRunner } = await import('../src/cloudjob.ts');
  const { startDetached, DetachedChild } = await import('../src/detach.ts');
  const cwd = path.join(process.env.STUDIO_PROJECTS!, '.work', 'c_scoped1');
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, 'init', '-q', '-b', 'task/c1');
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'x\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'base');
  git(cwd, 'remote', 'add', 'origin', 'https://github.com/jgriffith3433/private-gen.git');

  const bucket = new Map<string, Buffer>();
  let spec: any = null;
  const started = new Promise<void>((resolve) => {
    setJobRunner(() => ({
      put: async (k, d) => { bucket.set(k, Buffer.isBuffer(d) ? d : Buffer.from(d)); },
      get: async (k) => bucket.get(k) ?? null,
      list: async (p) => [...bucket.keys()].filter((k) => k.startsWith(p)),
      remove: async (k) => { bucket.delete(k); },
      start: async (unit) => { spec = JSON.parse(bucket.get(`jobs/${unit}/spec.json`)!.toString('utf8')); resolve(); return 'projects/p/locations/r/jobs/studio-agent/executions/e1'; },
      state: async () => ({ done: true, message: '' }),
      cancel: async () => {},
    }));
  });
  const rec = startDetached('agent-c_scoped1', { file: process.execPath, args: ['-e', '0'], cwd, env: { ...process.env } }, 'cloudrun');
  const child = new DetachedChild(rec);
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  await started;
  await new Promise((resolve) => child.on('close', resolve));
  setJobRunner(null);

  assert.equal(spec.git.token, 'ghs_private-gen_read');
  assert.equal(spec.env.GITHUB_TOKEN, undefined, "never in the pass's environment");
  assert.ok(!JSON.stringify(spec).includes('ghp_js_own_token'), "J's own token never reaches the job");
});

test("a beta site's build job gets the same read-only token for its repo", async () => {
  const { setJobRunner, runCloudBuild } = await import('../src/cloudjob.ts');
  const bucket = new Map<string, Buffer>();
  let spec: any = null;
  setJobRunner(() => ({
    put: async (k, d) => { bucket.set(k, Buffer.isBuffer(d) ? d : Buffer.from(d)); },
    get: async (k) => bucket.get(k) ?? null,
    list: async (p) => [...bucket.keys()].filter((k) => k.startsWith(p)),
    remove: async (k) => { bucket.delete(k); },
    start: async (unit) => { spec = JSON.parse(bucket.get(`jobs/${unit}/spec.json`)!.toString('utf8')); bucket.set(`jobs/${unit}/out/exit.json`, Buffer.from(JSON.stringify({ code: 0 }))); return 'projects/p/locations/r/jobs/studio-agent/executions/e2'; },
    state: async () => ({ done: true, message: '' }),
    cancel: async () => {},
  }));
  await runCloudBuild('build-scoped1', { remote: 'https://github.com/jgriffith3433/site.git', head: 'abc', cwd: '/w/site', command: 'true', outputs: [], gitToken: 'ghp_js_own_token', timeoutMs: 2000 }).catch(() => null);
  setJobRunner(null);
  assert.equal(spec?.git?.token, 'ghs_site_read');
});
