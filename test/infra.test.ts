// Studio and Gen as agent targets: the guard rails on what a change may touch, and the smoke check (this Studio,
// started on a spare port with a scratch data folder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A scratch database: agents.ts requeues interrupted changes when it loads.
process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-infra-'));
const { guardFiles, smokeCheck, infraEnv, infraChecks } = await import('../src/agents.ts');
const { getInfra, isInfra } = await import('../src/config.ts');

test('infra targets are Studio and Gen, not products', () => {
  assert.ok(isInfra('hawkesstudio') && isInfra('hawkesgen'));
  assert.ok(!isInfra('doseofdestruction'));
  assert.equal(getInfra('hawkesgen').smoke.health, '/v1/health');
});

test('guard rails: forbidden files always, guarded ones only when J names them', () => {
  const files = ['src/talk.ts', 'docs/cloud.md', 'deploy/hawkes-pull.mjs', '.github/workflows/ci.yml', '.data/studio.db', 'deploy/.keys/web-password.txt', '.env'];
  const bad = guardFiles('hawkesstudio', files, 'Make Talk friendlier');
  assert.deepEqual(bad.map((b) => `${b.file}:${b.why}`), [
    'deploy/hawkes-pull.mjs:guarded', '.github/workflows/ci.yml:guarded', '.data/studio.db:forbidden', 'deploy/.keys/web-password.txt:forbidden', '.env:forbidden',
  ]);
  // Naming the file (path or name) allows a guarded one, never a forbidden one.
  const named = guardFiles('hawkesstudio', files, 'Change hawkes-pull.mjs to wait 10 minutes, and .github/workflows/ci.yml too. Also .env');
  assert.deepEqual(named.map((b) => b.file), ['.data/studio.db', 'deploy/.keys/web-password.txt', '.env']);
  assert.deepEqual(guardFiles('hawkesgen', ['src/auth.ts', 'src/jobs.ts'], 'faster queue').map((b) => b.file), ['src/auth.ts']);
});

test('infra agents keep the Cursor login and drop other secrets', () => {
  const prevCursor = process.env.CURSOR_API_KEY;
  const prevAws = process.env.AWS_SECRET_ACCESS_KEY;
  process.env.CURSOR_API_KEY = 'cursor-test-key';
  process.env.AWS_SECRET_ACCESS_KEY = 'aws-test';
  try {
    const agent = infraEnv({ agent: true });
    const check = infraEnv();
    assert.equal(agent.CURSOR_API_KEY, 'cursor-test-key');
    assert.equal(check.CURSOR_API_KEY, undefined);
    assert.equal(agent.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(check.AWS_SECRET_ACCESS_KEY, undefined);
  } finally {
    if (prevCursor === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = prevCursor;
    if (prevAws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = prevAws;
  }
});

test('smoke check: the service starts on a spare port, health ok, dashboard loads, scripts parse', { timeout: 90_000 }, async () => {
  const r: any = await smokeCheck(root, getInfra('hawkesstudio'));
  assert.ok(r.ok, `${r.detail}\n${r.log ?? ''}`);
  assert.ok(r.port !== 8791);
  assert.ok(r.scripts.some((s: any) => s.file === 'dashboard/app.js'));
});

test('a change\'s checks run at the same time, and each result is kept in order: failing both says both', async () => {
  // A stand-in for the shell: each command finishes only once every one has started (sequential checks would hang here).
  const started: string[] = [];
  let go!: () => void;
  const all = new Promise<void>((r) => { go = r; });
  const results: Record<string, { ok: boolean; out: string; ms: number }> = {
    'npm run typecheck': { ok: false, out: 'src/a.ts(1,1): error TS2304', ms: 14_000 },
    'npm test': { ok: false, out: '# fail 3', ms: 100_000 },
  };
  const finished: string[] = [];
  const env: NodeJS.ProcessEnv[] = [];
  const run = async (_cwd: string, cmd: string, e: NodeJS.ProcessEnv) => {
    started.push(cmd);
    env.push(e);
    if (started.length === 2) go();
    await all;
    // The tests end first: the results still come back in the listed order.
    if (cmd === 'npm run typecheck') await new Promise((r) => setTimeout(r, 20));
    return results[cmd];
  };
  const checks = await infraChecks('/nowhere', ['npm run typecheck', 'npm test'], (k) => finished.push(k.cmd), run);
  assert.deepEqual(started, ['npm run typecheck', 'npm test']);
  assert.deepEqual(finished, ['npm test', 'npm run typecheck'], 'each is logged as it finishes');
  assert.deepEqual(checks.map((k) => [k.cmd, k.ok, k.seconds]), [['npm run typecheck', false, 14], ['npm test', false, 100]]);
  assert.match(checks[0].out!, /TS2304/);
  assert.match(checks[1].out!, /fail 3/);
  // The checks' environment has no service keys, as before.
  assert.ok(env.every((e) => !Object.keys(e).some((k) => /AWS_SECRET|GITHUB_TOKEN/.test(k))));
  // One passing, one failing; a command that couldn't start is a failed check, not a thrown verify.
  const mixed = await infraChecks('/nowhere', ['ok', 'broken'], undefined, async (_c, cmd) => {
    if (cmd === 'broken') throw new Error('spawn failed');
    return { ok: true, out: 'fine', ms: 1000 };
  });
  assert.deepEqual(mixed.map((k) => [k.cmd, k.ok, k.out ?? null]), [['ok', true, null], ['broken', false, 'spawn failed']]);
});

test('the real checks run side by side in the worktree', { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-infra-checks-'));
  // Each waits until both have started (a file each), so only side-by-side checks get through.
  const wait = (me: string, other: string) => `node -e "const fs=require('fs');fs.writeFileSync('${me}','');const t=Date.now();(function w(){if(fs.existsSync('${other}'))process.exit(${me === 'b' ? 3 : 0});if(Date.now()-t>10000)process.exit(9);setTimeout(w,20)})()"`;
  const checks = await infraChecks(dir, [wait('a', 'b'), wait('b', 'a')]);
  assert.deepEqual(checks.map((k) => k.ok), [true, false], checks.map((k) => k.out ?? '').join('\n'));
  fs.rmSync(dir, { recursive: true, force: true });
});
