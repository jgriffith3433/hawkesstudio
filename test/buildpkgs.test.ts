// Before a Unity build, the Gen and Studio package checkouts are fetched and the commits the build will use are
// reported (a stale checkout once sent an old compile error into every Unity build). Throwaway repos, a bare origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-buildpkgs-'));
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [], repos: {} }));

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const origin = path.join(tmp, 'origin.git');
const other = path.join(tmp, 'other');
const dir = path.join(process.env.STUDIO_PROJECTS, 'pkgrepo');
git(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '--quiet', origin, other);
const push = (text: string) => {
  fs.writeFileSync(path.join(other, 'f.txt'), text);
  git(other, 'add', '-A');
  git(other, 'commit', '--quiet', '-m', text);
  git(other, 'push', '--quiet', 'origin', 'HEAD:main');
  return git(other, 'rev-parse', 'HEAD');
};
const first = push('v1');
git(tmp, 'clone', '--quiet', origin, dir);

const { syncBuildPackages } = await import('../src/buildpkgs.ts');

test('a current checkout is reported as current', async () => {
  const logs: string[] = [];
  const r = await syncBuildPackages((s) => logs.push(s), { repos: ['pkgrepo', 'missing'], waitMs: 0 });
  assert.deepEqual(Object.keys(r), ['pkgrepo']);
  assert.equal(r.pkgrepo.sha, first.slice(0, 12));
  assert.equal(r.pkgrepo.behind, 0);
  assert.match(logs.join('\n'), /current/);
});

test('a checkout behind origin/main is fetched and reported as behind (not silently stale)', async () => {
  const second = push('v2');
  const logs: string[] = [];
  const r = await syncBuildPackages((s) => logs.push(s), { repos: ['pkgrepo'], waitMs: 0 });
  assert.equal(r.pkgrepo.sha, first.slice(0, 12));
  assert.equal(r.pkgrepo.behind, 1);
  assert.equal(r.pkgrepo.latest, second.slice(0, 12));
  assert.match(logs.join('\n'), /NOT in this build/);
});

const sha40 = 'a'.repeat(40);
const { buildServerSyncScript, syncBuildServerCheckouts, buildErrorLines, unityBuild, BuildServerSyncError } = await import('../src/buildpkgs.ts');

test('the build server sync fetches and hard-resets each checkout and reports its commit', async () => {
  const ran: string[] = [];
  const r = await syncBuildServerCheckouts(async (cmd) => { ran.push(cmd); return `noise\n${sha40}\n`; }, () => {}, { repos: ['hawkesgen', 'hawkesstudio'] });
  assert.deepEqual(r, { hawkesgen: { sha: 'a'.repeat(12) }, hawkesstudio: { sha: 'a'.repeat(12) } });
  assert.match(ran[0], /C:\\Projects\\hawkesgen/);
  assert.match(ran[1], /C:\\Projects\\hawkesstudio/);
  assert.match(ran[0], /fetch -q origin main/);
  assert.match(ran[0], /Git\\cmd\\git.exe/);
  assert.match(ran[0], /reset -q --hard origin\/main/);
});

test('the sync script carries the token only as a git header', () => {
  assert.doesNotMatch(buildServerSyncScript('hawkesgen'), /extraHeader/);
  const s = buildServerSyncScript('hawkesgen', 'tok123');
  assert.match(s, /http\.extraHeader=Authorization: Basic /);
  assert.ok(!s.includes('tok123'));
});

test('a failed build server sync fails loudly with the commits seen and no token', async () => {
  await assert.rejects(
    syncBuildServerCheckouts(async (cmd) => { if (cmd.includes('hawkesstudio')) throw new Error('git fetch origin main failed tok123'); return sha40; }, () => {}, { token: 'tok123' }),
    (e: any) => e instanceof BuildServerSyncError && /hawkesstudio: git fetch origin main failed \*\*\*/.test(e.message) && /hawkesgen aaaaaaaaaaaa/.test(e.message) && (e.states.hawkesgen as any).sha === 'a'.repeat(12) && !e.message.includes('tok123'),
  );
});

test('unityBuild returns a failed job, without building, when the build server cannot sync', async () => {
  const job = await unityBuild('nope', {}, undefined, { log: () => {}, serverShell: async () => { throw new Error('ssh failed: no route'); } });
  assert.equal(job.status, 'failed');
  assert.match(job.error, /couldn't be brought to origin\/main/);
  assert.equal(job.result.ok, false);
  assert.ok((job.result.buildServer as any).hawkesgen.error);
});

test('compiler lines from the log tail are picked out for the failed detail', () => {
  const tail = ['Reimporting', 'Assets/A.cs(3,5): error CS0246: type not found', 'Assembly has duplicate references: Packages/com.hawkes.gen/Editor/Tests/X.asmdef', 'Assets/A.cs(3,5): error CS0246: type not found', 'Scripts have compiler errors.', 'other'].join('\n');
  assert.deepEqual(buildErrorLines(tail), ['Assets/A.cs(3,5): error CS0246: type not found', 'Assembly has duplicate references: Packages/com.hawkes.gen/Editor/Tests/X.asmdef', 'Scripts have compiler errors.']);
  assert.deepEqual(buildErrorLines(undefined), []);
});
