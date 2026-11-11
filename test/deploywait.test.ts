// A go-live play waits until beta has deployed the commit it tests, woken by the deploy's own announce (deploywait.ts,
// J 2026-11-11: "A go-live play waits until beta has actually deployed the build it is testing, keyed on the deployed
// commit. Use the deploy's completion event, not polling"). The wait's parts, then a random-step test of pushes,
// deploys (some failing back to the old revision), announces and plays: a play only ever plays the commit it was for
// (or beta's newer head), beta is read only when a play starts or an announce comes, and nothing is left waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { untilDeployed, onDeployAnnounced, waitingFor, goLiveTarget, undeployedFile, sameCodeIn } from '../src/deploywait.ts';
import type { Product } from '../src/config.ts';

const gen = { id: 'gen-t', name: 'Gen', versionPath: '/v1/health', repo: 'hawkesgen' } as unknown as Product;
const deployed = (commit: string | null) => ({ commit, version: null, at: Date.now() });
const tick = () => new Promise((r) => setImmediate(r));

test('a play whose commit beta already runs plays at once, after one read', async () => {
  let reads = 0;
  const r = await untilDeployed(gen, 'aaaaaaa1', { read: async () => { reads++; return deployed('aaaaaaa1ffff'); } });
  assert.deepEqual(r, { ok: true, commit: 'aaaaaaa1ffff' });
  assert.equal(reads, 1);
  assert.deepEqual(waitingFor(gen.id), []);
});

test('beta on an older commit: the play waits, reads nothing more, and plays when the deploy announces the commit', async () => {
  let live = 'old0000';
  let reads = 0;
  const read = async () => { reads++; return deployed(live); };
  let told = '';
  const p = untilDeployed(gen, 'new1111', { read, onWait: (d) => { told = d; } });
  await tick();
  assert.equal(told, 'old0000');
  assert.deepEqual(waitingFor(gen.id), ['new1111']);
  // Time passes: nothing looks again (no polling).
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(reads, 1);
  // The new revision starts but beta's traffic is still on the old one: not woken, not seen.
  const early = await onDeployAnnounced([gen], 'beta', 'new1111', { read });
  assert.equal(early.seen, false);
  assert.equal(early.products[0].woke, 0);
  assert.deepEqual(waitingFor(gen.id), ['new1111']);
  live = 'new1111abcdef';
  const ann = await onDeployAnnounced([gen], 'beta', 'new1111abcdef', { read });
  assert.equal(ann.seen, true);
  assert.equal(ann.products[0].woke, 1);
  assert.deepEqual(await p, { ok: true, commit: 'new1111abcdef' });
  assert.deepEqual(waitingFor(gen.id), []);
});

test('beta moved on while waiting: its newer deployed head is played', async () => {
  let live = 'old0000';
  const read = async () => deployed(live);
  const p = untilDeployed(gen, 'mid2222', { read });
  await tick();
  live = 'top3333';
  const ann = await onDeployAnnounced([gen], 'beta', 'top3333', { read, tip: async () => 'top3333' });
  assert.equal(ann.products[0].woke, 1);
  assert.deepEqual(await p, { ok: true, commit: 'top3333' });
});

test("beta's newer head already deployed: played at once", async () => {
  const r = await untilDeployed(gen, 'mid8888', { read: async () => deployed('top9999'), tip: async () => 'top9999' });
  assert.deepEqual(r, { ok: true, commit: 'top9999' });
});

test('an older deploy announcing never wakes a play for a newer commit', async () => {
  const read = async () => deployed('old0000');
  const p = untilDeployed(gen, 'new4444', { read, deadlineMs: 40 });
  await tick();
  const ann = await onDeployAnnounced([gen], 'beta', 'old0000', { read, tip: async () => 'new4444' });
  assert.equal(ann.products[0].woke, 0);
  const r = await p;
  assert.equal(r.ok, false);
});

test('a deploy that never comes ends the wait at the deadline as not played', async () => {
  const r = await untilDeployed(gen, 'never55', { read: async () => deployed('old0000'), deadlineMs: 30 });
  assert.equal(r.ok, false);
  assert.match((r as any).why, /didn't finish within/);
  assert.deepEqual(waitingFor(gen.id), []);
});

test("beta that doesn't say its commit: not played on a guess", async () => {
  const r = await untilDeployed(gen, 'abc1234', { read: async () => null });
  assert.equal(r.ok, false);
});

test('a docs-only commit is the deployed code: played without waiting for a deploy that never comes', async () => {
  const r = await untilDeployed(gen, 'docs666', { read: async () => deployed('code777'), sameCode: () => true });
  assert.deepEqual(r, { ok: true, commit: 'docs666', sameCode: true });
  assert.equal(undeployedFile('docs/a.md'), true);
  assert.equal(undeployedFile('README.md'), true);
  assert.equal(undeployedFile('src/api.ts'), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-'));
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.ts'), '1');
  git('add', '.'); git('commit', '-qm', 'a');
  const a = git('rev-parse', 'HEAD');
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'docs', 'x.md'), 'x');
  fs.writeFileSync(path.join(dir, 'NOTES.md'), 'x');
  git('add', '.'); git('commit', '-qm', 'docs');
  const b = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'a.ts'), '2');
  git('add', '.'); git('commit', '-qm', 'code');
  const c = git('rev-parse', 'HEAD');
  assert.equal(sameCodeIn(dir, a, b), true);
  assert.equal(sameCodeIn(dir, a, c), false);
  assert.equal(sameCodeIn(dir, a, 'deadbeef'), false);
  assert.equal(sameCodeIn(null, a, b), false);
});

test("a go live's run names the commit it plays", () => {
  assert.equal(goLiveTarget(JSON.stringify({ focus: 'Before go-live: playing beta 3fa9c21 once, covering every merge since its last playtest.' })), '3fa9c21');
  assert.equal(goLiveTarget(JSON.stringify({ focus: 'milestone check' })), null);
  assert.equal(goLiveTarget(null), null);
});

test('the wait is wired where plays start, before the build is claimed, and nothing in it polls', () => {
  const src = fs.readFileSync(new URL('../src/deploywait.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /setInterval/);
  assert.equal((src.match(/setTimeout\(/g) ?? []).length, 1, 'one deadline, nothing that looks again');
  const pipe = fs.readFileSync(new URL('../src/pipeline.ts', import.meta.url), 'utf8');
  const wait = pipe.indexOf('W.untilDeployed(p, target');
  const claim = pipe.indexOf('claimPlay(p.id, build, name, s, run)');
  assert.ok(wait > 0 && claim > wait, 'a play waits for its deploy before claiming the build');
  const server = fs.readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const route = server.slice(server.indexOf("route === '/api/hooks/deployed'"), server.indexOf("route === '/api/hooks/github' || route"));
  assert.match(route, /googleIdToken/);
  assert.match(route, /gserviceaccount\\?\.com/);
  assert.match(route, /onDeployAnnounced/);
});

test('random steps: plays only play their commit or beta\'s newer head, beta is read only on a start or an announce, and no wait is left behind', async () => {
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const hex = (i: number) => (0x1000000 + i).toString(16).slice(1).padStart(7, '0');
  for (let round = 0; round < 40; round++) {
    const P = { ...gen, id: `gen-r${round}` } as Product;
    let n = 0;
    const commits: string[] = [hex(n++)];
    let tip = commits[0];
    let live = commits[0];
    let reads = 0, starts = 0, announces = 0;
    const read = async () => { reads++; return deployed(live); };
    const plays: { target: string; p: Promise<any>; result?: any }[] = [];
    for (let step = 0; step < 30; step++) {
      const what = rnd(5);
      if (what === 0) { tip = hex(1000 * round + n++); commits.push(tip); }
      else if (what === 1) {
        // A deploy of beta's head: it works, or it fails and beta stays on the old revision.
        if (rnd(4)) live = tip;
        announces++;
        await onDeployAnnounced([P], 'beta', tip, { read, tip: async () => tip });
      } else if (what === 2) {
        const target = commits[rnd(commits.length)];
        starts++;
        const p = untilDeployed(P, target, { read, tip: async () => tip, deadlineMs: 5 });
        const play = { target, p };
        plays.push(play);
        p.then((r) => { (play as any).result = r; });
      } else await tick();
      assert.ok(reads <= starts + announces, 'beta is read only when a play starts or a deploy announces');
    }
    await Promise.all(plays.map((x) => x.p));
    for (const x of plays) {
      const r = (x as any).result;
      if (r.ok) assert.ok(r.commit === x.target || commits.includes(r.commit), 'played a real commit');
      if (r.ok) assert.ok(r.commit === x.target || commits.indexOf(r.commit) > commits.indexOf(x.target), 'never an older commit than the one it was for');
    }
    assert.deepEqual(waitingFor(P.id), []);
  }
});
