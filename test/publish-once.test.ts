// One site publish per push (J, 2026-11-11: "One site publish per push: deduplicate by commit"). That morning each beta
// push started two or three site runs: the push itself, beta catching up after a build, a play republishing the beta
// site. builds.ts startBuild now claims the commit before it makes a run: an automatic start of a commit already
// published, being built, or being started starts nothing. A person's build, a retry, a tag and a release still build.
// A scratch database and a fixture project; no GitHub or Gen (every outside call is refused).
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-publishonce-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_TASK_BAR = 'off';
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE', 'K_SERVICE', 'GITHUB_TOKEN']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
const base = { framing: 'test', live: 'http://127.0.0.1:9/', playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.' };
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: { web: 'x/web' },
  products: [{ ...base, id: 'webby', name: 'Webby', engine: 'web', repo: 'web', site: 'web', github: 'x/web', local: { serve: 'static', dir: 'web', port: 8797, path: '/' }, builds: [{ id: 'site', tool: 'npm' }] }],
  infra: [],
}));
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response('refused in the test', { status: 500 })) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const { db, newId } = await import('../src/db.ts');
const B = await import('../src/builds.ts');
const L = await import('../src/buildline.ts');
const sha = (c: string) => c.repeat(40);
const row = (s: string, status: string) => db.prepare("INSERT INTO builds (id, product, build, version, status, sha, ref, runner, target, run, change, started) VALUES (?, 'webby', 'site', ?, ?, ?, 'beta', 'studio', 'web', 'r_x', NULL, ?)").run(newId('b'), Math.floor(Math.random() * 1e6), status, s, Date.now());
const runs = () => (db.prepare("SELECT COUNT(*) AS n FROM runs WHERE kind = 'build'").get() as any).n as number;
beforeEach(() => { B.resetCommitClaims(); L.resetLines(); db.prepare("DELETE FROM builds WHERE product = 'webby'").run(); });

test('which starts are deduplicated by their commit: automatic ones only', () => {
  assert.equal(B.dedupesByCommit({ trigger: 'beta' }, 'auto'), true);
  assert.equal(B.dedupesByCommit({ trigger: 'beta' }, 'person'), false, "a person's build always builds");
  assert.equal(B.dedupesByCommit({ trigger: 'beta', retry: 3 }, 'auto'), false, 'a retry builds');
  assert.equal(B.dedupesByCommit({ trigger: 'tag' }, 'tag'), false);
  assert.equal(B.dedupesByCommit({}, 'release'), false);
  assert.equal(B.dedupesByCommit({ trigger: 'beta', change: 'c_1' }, 'auto'), false, "an agent change's preview is its own");
  assert.equal(B.dedupesByCommit({}, 'person'), false);
});

test('a commit published or building is taken; a failed one may be built again; a start in flight holds it', () => {
  row(sha('a'), 'ready');
  row(sha('b'), 'building');
  row(sha('c'), 'failed');
  assert.equal(B.claimCommit('webby', 'site', sha('a')), true);
  assert.equal(B.claimCommit('webby', 'site', sha('b')), true);
  assert.equal(B.claimCommit('webby', 'site', sha('c')), false, 'a failed build is retried, not a second publish');
  assert.equal(B.claimCommit('webby', 'site', sha('c')), true, 'but only once at a time');
  B.releaseCommit('webby', 'site', sha('c'));
  assert.equal(B.claimCommit('webby', 'site', sha('c')), false);
  assert.equal(B.claimCommit('webby', 'site', sha('d')), false);
  assert.equal(B.claimCommit('webby', 'other', sha('d')), false, "another build of the project is another publish");
});

test('through startBuild: a push, beta catching up and a republish of one commit at once make one run', async () => {
  const before = runs();
  const all = await Promise.all([
    B.startBuild('webby', { trigger: 'beta', sha: sha('e') }),
    B.startBuild('webby', { trigger: 'beta', sha: sha('e'), ref: 'beta' }),
    B.startBuild('webby', { trigger: 'beta', sha: sha('e') }),
  ]);
  assert.equal(all.filter(Boolean).length, 1);
  assert.equal(runs() - before, 1);
  await all.find(Boolean)!.done;
  // That build failed here (no GitHub): a later automatic start may try the commit again, once.
  const again = await B.startBuild('webby', { trigger: 'beta', sha: sha('e') });
  assert.ok(again);
  await again!.done;
  // Published: no automatic start builds it again, but a person still can.
  row(sha('f'), 'ready');
  assert.equal(await B.startBuild('webby', { trigger: 'beta', sha: sha('f') }), null);
  const person = await B.startBuild('webby', { trigger: 'beta', sha: sha('f'), cause: 'person' });
  assert.ok(person);
  await person!.done;
});

test('random steps: pushes, catch-ups, republishes and builds ending: never two automatic starts of one commit at once, and none of a published commit', () => {
  let seed = 3;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const commits: string[] = [];
  const holders = new Map<string, number>();
  const published = new Set<string>();
  let n = 0;
  for (let step = 0; step < 2000; step++) {
    const what = rnd(4);
    if (what === 0 || !commits.length) { commits.push((n++).toString(16).padStart(40, '0')); continue; }
    const c = commits[commits.length - 1 - rnd(Math.min(3, commits.length))];
    if (what === 1 || what === 2) {
      // An automatic start (the push, beta catching up, a play republishing the site).
      const taken = B.claimCommit('webby', 'site', c);
      if (!taken) {
        assert.equal(holders.get(c) ?? 0, 0, 'never two starts of one commit at once');
        assert.ok(!published.has(c), 'never a second publish of a commit');
        holders.set(c, 1);
        row(c, 'building');
      }
    } else {
      // A build ends: published, or failed (then it may be tried again).
      const going = [...holders.keys()];
      if (!going.length) continue;
      const g = going[rnd(going.length)];
      const ok = rnd(3) > 0;
      db.prepare("UPDATE builds SET status = ? WHERE product = 'webby' AND sha = ? AND status = 'building'").run(ok ? 'ready' : 'failed', g);
      if (ok) published.add(g);
      holders.delete(g);
      B.releaseCommit('webby', 'site', g);
    }
  }
  const twice = db.prepare("SELECT sha, COUNT(*) AS n FROM builds WHERE product = 'webby' AND status = 'ready' GROUP BY sha HAVING n > 1").all();
  assert.deepEqual(twice, [], 'one publish per commit');
});

test('startBuild claims the commit before it makes a run, and the run gives it back when it ends', () => {
  const src = fs.readFileSync(new URL('../src/builds.ts', import.meta.url), 'utf8');
  const start = src.slice(src.indexOf('export async function startBuild('));
  assert.ok(start.indexOf('claimCommit(') > 0 && start.indexOf('claimCommit(') < start.indexOf("INSERT INTO runs"), 'claimed before the run row');
  assert.match(start, /finally \{\s*for \(const \[b, sha\] of claimed\) releaseCommit/);
});
