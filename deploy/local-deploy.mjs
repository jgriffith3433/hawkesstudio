// Deploys Hawkes Gen or Hawkes Studio from J's PC, for when GitHub Actions can't run (J, 2026-10-22: a billing problem).
// It does what CI does, then what CI's "Tell the server" job does:
//   1. checks the commit to deploy: this repo's main, with everything on GitHub's main in it (else: pull first)
//   2. runs npm run typecheck and npm test on a clean copy of exactly that commit (a git worktree in the temp folder,
//      sharing this repo's node_modules), like CI: uncommitted edits don't count; the Blender tests are skipped as on CI
//   3. pushes it to GitHub main
//   4. over SSH (deploy/.keys/control_ed25519), writes /var/lib/hawkes/verified-<repo>.json (that sha) and starts
//      hawkes-pull, which takes a locally verified commit as passed (deploy/hawkes-pull.mjs ciState)
//   5. waits for the deploy and says how it went (Studio's /api/self-deploys)
//
//   node deploy/local-deploy.mjs hawkesgen|hawkesstudio [--skip-tests]      (auto-deploy.bat in each repo runs this)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STUDIO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = process.argv[2];
if (!['hawkesgen', 'hawkesstudio'].includes(repo)) {
  console.error('usage: node deploy/local-deploy.mjs hawkesgen|hawkesstudio [--skip-tests]');
  process.exit(2);
}
const skipTests = process.argv.includes('--skip-tests');
const dir = path.join(path.dirname(STUDIO), repo);
const KEY = path.join(STUDIO, 'deploy', '.keys', 'control_ed25519');
const HOST = process.env.HAWKES_SERVER ?? 'ubuntu@studio.hawkesgen.com';
const step = (s) => console.log(`\n== ${s}`);
const fail = (s) => { console.error(`\nNot deployed: ${s}`); process.exit(1); };
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

// 1. What to deploy.
step(`${repo}: what to deploy`);
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') fail(`${repo} is on "${branch}", not main. Switch to main first.`);
git('fetch', '--quiet', 'origin', 'main');
const sha = git('rev-parse', 'HEAD');
const remote = git('rev-parse', 'origin/main');
if (spawnSync('git', ['merge-base', '--is-ancestor', remote, sha], { cwd: dir }).status !== 0) {
  fail(`GitHub's main has commits this PC doesn't (${remote.slice(0, 7)}). Run "git pull" in ${repo} first.`);
}
const dirty = git('status', '--porcelain', '--untracked-files=no');
console.log(`${sha.slice(0, 7)} ${git('log', '-1', '--format=%s', sha)}`);
if (sha !== remote) console.log(`${git('rev-list', '--count', `${remote}..${sha}`)} commit(s) not on GitHub yet.`);
if (dirty) console.log(`(Uncommitted edits in ${repo} are not deployed or tested:\n${dirty})`);

// 2. The checks, on a clean copy of exactly this commit.
let checks = 'typecheck and tests';
if (skipTests) {
  checks = 'typecheck only (--skip-tests)';
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `deploy-${repo}-`));
const wt = path.join(tmp, repo);
try {
  step(`${repo}: typecheck${skipTests ? '' : ' and tests'} on a clean copy of ${sha.slice(0, 7)}`);
  git('worktree', 'add', '--detach', wt, sha);
  fs.symlinkSync(path.join(dir, 'node_modules'), path.join(wt, 'node_modules'), 'junction');
  // Gen's Python tools (.venv) and its offline template cache make the same tests run as on this PC.
  for (const extra of ['.venv', path.join('.data', 'comfy-cache')]) {
    if (fs.existsSync(path.join(dir, extra))) {
      fs.mkdirSync(path.dirname(path.join(wt, extra)), { recursive: true });
      fs.symlinkSync(path.join(dir, extra), path.join(wt, extra), 'junction');
    }
  }
  const env = { ...process.env, HAWKES_NO_BLENDER: '1', CI: '1' };
  const npm = (script) => spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], { cwd: wt, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (npm('typecheck').status !== 0) fail('the typecheck failed (above).');
  if (!skipTests) {
    const t = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], { cwd: wt, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 256 * 1024 * 1024 });
    const out = `${t.stdout}\n${t.stderr}`;
    const summary = out.split('\n').filter((l) => /^ℹ (tests|pass|fail|skipped)/.test(l)).join('  ');
    if (t.status !== 0) {
      console.log(out.split('\n').filter((l) => /^✖|AssertionError|Error:/.test(l)).slice(0, 40).join('\n'));
      fail(`the tests failed (${summary}).`);
    }
    console.log(summary);
  }
} finally {
  spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: dir });
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 3. GitHub main.
if (sha !== remote) {
  step(`${repo}: push to GitHub main`);
  const p = spawnSync('git', ['push', 'origin', `${sha}:refs/heads/main`], { cwd: dir, stdio: 'inherit' });
  if (p.status !== 0) fail('git push failed (above).');
}

// 4. Tell the server this commit passed, and start its deploy.
step(`${repo}: tell the server`);
const verified = JSON.stringify({ sha, at: new Date().toISOString(), by: `${os.hostname()} (local-deploy.mjs)`, checks });
const ssh = spawnSync('ssh', ['-i', KEY, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', HOST,
  `sudo mkdir -p /var/lib/hawkes && sudo tee /var/lib/hawkes/verified-${repo}.json > /dev/null && echo "live $(sudo git -C /srv/hawkes/${repo} rev-parse HEAD)" && sudo systemctl start --no-block hawkes-pull.service && echo started`],
{ input: verified, encoding: 'utf8' });
if (ssh.status !== 0 || !/started/.test(ssh.stdout)) fail(`SSH to the server failed: ${(ssh.stderr || ssh.stdout).trim()}`);
// Already what the server runs: nothing to wait for.
if (ssh.stdout.includes(`live ${sha}`)) { console.log(`
The server already runs ${repo} ${sha.slice(0, 7)}. Nothing to deploy.`); process.exit(0); }
console.log('The server is deploying it.');

// 5. Wait for the deploy.
step(`${repo}: waiting for the deploy (a few minutes; Studio waits for its short critical sections)`);
const { studio } = await import(pathToFileURL(path.join(STUDIO, 'src', 'client.ts')).href);
const deadline = Date.now() + 20 * 60_000;
let last = '';
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 10_000));
  // Studio restarts when it deploys itself: no answer for a little while is expected.
  const d = await studio('/api/self-deploys?limit=15').catch(() => null);
  const mine = (d?.deploys ?? []).find((x) => x.repo === repo && String(x.to ?? '') === sha);
  if (!mine) continue;
  const line = `${mine.outcome}${mine.detail ? `: ${mine.detail}` : ''}`;
  if (line !== last) console.log(line);
  last = line;
  if (mine.outcome === 'deployed') { console.log(`\nDeployed ${repo} ${sha.slice(0, 7)}.`); process.exit(0); }
  if (mine.outcome === 'failed' || mine.outcome === 'refused') fail(`the server says ${line}`);
}
console.log('\nStill not deployed after 20 minutes. Look in Studio (Settings, Restart services shows the last deploy) or on the server: journalctl -u hawkes-pull');
process.exit(1);
