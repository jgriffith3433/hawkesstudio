// An agent's Cloud Run job clones its repo from GitHub, so a private repo needs a token in the job's spec. Agents work
// in worktrees (PROJECTS/.work/<change>), which aren't a repo folder of their own, so the folder named no repo and the
// job got no token: every agent job on the private Hawkes Gen repo failed with "could not read Username"
// (2026-11-01, J: "Studio should very much be able to open private repos"). The worktree's origin names the repo, and
// the GitHub App's installation token for it goes to the job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-agent-job-token-'));
process.env.STUDIO_DATA = path.join(TMP, 'data');
process.env.STUDIO_PROJECTS = path.join(TMP, 'projects');
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_CUSTOMER = '1';
process.env.STUDIO_JOB_POLL_MS = '50';
delete process.env.GITHUB_TOKEN;
delete process.env.STUDIO_JOB_GITHUB_TOKEN;
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'products.json'), JSON.stringify({ products: [], repos: {} }));

// The stand-in GitHub: the App installed on the owner's account, all repos.
const asked: string[] = [];
const gh = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  const p = new URL(req.url!, 'http://x').pathname;
  asked.push(`${req.method} ${p}`);
  const out = (s: number, o: unknown) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (p === '/app/installations') return out(200, [{ id: 9, account: { login: 'jgriffith3433', type: 'User' }, repository_selection: 'all' }]);
  if (p === '/app/installations/9/access_tokens') return out(201, { token: 'ghs_private_repo', expires_at: new Date(Date.now() + 3600_000).toISOString() });
  out(404, { message: `no ${req.method} ${p}` });
});
await new Promise<void>((r) => gh.listen(0, '127.0.0.1', () => r()));
process.env.GITHUB_API_BASE = `http://127.0.0.1:${(gh.address() as any).port}`;
test.after(() => gh.close());
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'github-app.json'), JSON.stringify({ id: 1, slug: 'hawkes-studio-test', clientId: 'Iv1.x', clientSecret: 's', pem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(), htmlUrl: 'x', owner: 'jgriffith3433' }));

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();

test('slugOfRemote reads owner/name from GitHub clone addresses', async () => {
  const { slugOfRemote } = await import('../src/ghtoken.ts');
  assert.equal(slugOfRemote('https://github.com/jgriffith3433/hawkesgen.git'), 'jgriffith3433/hawkesgen');
  assert.equal(slugOfRemote('https://github.com/jgriffith3433/hawkesgen'), 'jgriffith3433/hawkesgen');
  assert.equal(slugOfRemote('https://x-access-token:abc@github.com/acme/game.git'), 'acme/game');
  assert.equal(slugOfRemote('git@github.com:acme/game.git'), 'acme/game');
  assert.equal(slugOfRemote('/tmp/origin.git'), null);
  assert.equal(slugOfRemote('https://gitlab.com/acme/game.git'), null);
  assert.equal(slugOfRemote(''), null);
});

test("an agent's job in a worktree of a private repo gets that repo's App token to clone with", async () => {
  const { setJobRunner } = await import('../src/cloudjob.ts');
  const { startDetached, DetachedChild } = await import('../src/detach.ts');
  // The change's worktree: a commit, origin on GitHub (a private repo nobody primed a token for).
  const cwd = path.join(process.env.STUDIO_PROJECTS!, '.work', 'c_private1');
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, 'init', '-q', '-b', 'task/c1');
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'x\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'base');
  git(cwd, 'remote', 'add', 'origin', 'https://github.com/jgriffith3433/private-game.git');

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
  const rec = startDetached('agent-c_private1', { file: process.execPath, args: ['-e', '0'], cwd, env: { ...process.env } }, 'cloudrun');
  const child = new DetachedChild(rec);
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  await started;
  await new Promise((resolve) => child.on('close', resolve));
  setJobRunner(null);

  assert.equal(spec.git.remote, 'https://github.com/jgriffith3433/private-game.git');
  assert.equal(spec.git.token, 'ghs_private_repo', 'the App installation token for the worktree\'s repo');
  assert.equal(spec.env.GITHUB_TOKEN, undefined, 'never in the pass\'s environment');
  assert.ok(asked.includes('POST /app/installations/9/access_tokens'));
});
