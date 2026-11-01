// Release notes at each go live (release.ts, deploy.ts): the version bump, the notes fallback, the release commit on beta
// that doesn't count as beta moving, and going live when writing the release fails. Throwaway git repos (a temp
// "Projects" folder with a bare origin); no model is asked (STUDIO_RELEASE_NOTES=off).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-release-'));
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_RELEASE_NOTES = 'off';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
// These tests are about J's tap: walk-away's own approvals (walkAwayCards) are tested in walkaway-cards.test.ts.
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'pm.json'), JSON.stringify({ walkAwayCards: false }));
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'reltest', name: 'Release test', framing: 'test', engine: 'static', repo: 'relsite', site: 'relsite', live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: 'relsite', port: 8797, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
}] }));

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const origin = path.join(tmp, 'origin.git');
const dir = path.join(process.env.STUDIO_PROJECTS, 'relsite');
git(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '--quiet', origin, dir);
const commit = (file: string, text: string, msg: string) => {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', msg);
};
const first = { product: 'reltest', name: 'Release test', current: '1.0.0', releases: [{ version: '1.0.0', date: '2026-10-16', build: '', title: 'Hello', notes: ['It begins.'] }] };
commit('index.html', 'v1', 'First');
commit('releases.json', JSON.stringify(first, null, 2), 'What\'s new page');
git(dir, 'push', '--quiet', 'origin', 'HEAD:main');
git(dir, 'push', '--quiet', 'origin', 'HEAD:beta');
git(dir, 'checkout', '--quiet', '-b', 'beta', 'origin/beta');
const remote = (ref: string) => git(origin, 'rev-parse', ref);
const releasesOn = (ref: string) => JSON.parse(git(origin, 'show', `${ref}:releases.json`));

const rel = await import('../src/release.ts');
const { deployPlan, deploy } = await import('../src/deploy.ts');
const { db, newId, J } = await import('../src/db.ts');
const played = (sha: string) => db.prepare('INSERT INTO steps (id, run, product, kind, name, status, detail, data, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run(newId('s'), newId('r'), 'reltest', 'playtest', 'smoke@local', 'done', 'won', J({ outcome: 'won', played: { branch: 'beta', sha } }), Date.now(), Date.now());

test('the version: minor for a feature, patch for fixes only, never one used before', () => {
  assert.equal(rel.bumpVersion(['1.0.0'], ['Fix: the title (#3)', 'Add an about page']), '1.1.0');
  assert.equal(rel.bumpVersion(['1.0.0'], ['Fix: the title (#3)', 'fixed the jump']), '1.0.1');
  assert.equal(rel.bumpVersion(['1.0.0'], ['devtools: content/modes.json', 'Hawkes Gen JS client v7 (waits ride out dropped connections)']), '1.0.1', 'noise only: a patch');
  assert.equal(rel.bumpVersion(['1.0.0', '1.3.2', '1.1.0'], ['Fix: x']), '1.3.3', 'above every version in the file');
  assert.equal(rel.bumpVersion([], ['Anything']), '1.0.0');
});

test('the notes fallback is the neutral line, never the commit text', async () => {
  const titles = ['Hawkes Gen SDK v6 (synced by hawkesgen/bin/hawkesgen-sdk.mjs)', 'devtools: content/modes.json', 'Fix: Audio doesn\'t work on mobile? (#6)', 'Tap-to-play sound unlock and Settings menu (#7)'];
  assert.deepEqual(rel.fallbackNotes(titles), { title: 'Improvements and fixes', notes: ['Improvements and fixes.'] });
  const p = { id: 'reltest', name: 'Release test', about: 'A fixture.' } as any;
  const n = await rel.writeNotes(p, ['Add a boss'], undefined);
  assert.equal(n.source, 'fallback');
  assert.deepEqual(n.notes, ['Improvements and fixes.']);
  assert.ok(rel.isNoise('Release: Release test 1.1.0: New'));
});

test('the writer: Claude errors or says nothing usable -> the fallback; notes quoting a commit, an id or a forbidden word are dropped', async () => {
  delete process.env.STUDIO_RELEASE_NOTES;
  try {
    const p = { id: 'reltest', name: 'Release test', about: 'A fixture.' } as any;
    const titles = ['Fix: What\'s new v1.1.1 note names the dev changelog and the "pharma framing" out loud (#10)', 'Products: the formulation line shows each product\'s lot (its latest build) with the version and date'];
    let asked = '';
    const fails = await rel.writeNotes(p, titles, undefined, { ask: async (prompt) => { asked = prompt; throw new Error('Gen is down'); } });
    assert.deepEqual({ ...fails }, { title: 'Improvements and fixes', notes: ['Improvements and fixes.'], source: 'fallback' });
    assert.match(asked, /never quote them/, 'the commits are for the writer only');
    assert.equal((await rel.writeNotes(p, titles, undefined, { ask: async () => null })).source, 'fallback');
    assert.equal((await rel.writeNotes(p, titles, undefined, { ask: () => new Promise(() => {}), timeoutMs: 10 })).source, 'fallback', 'a writer that never answers');

    // Every way a commit leaks: quoted whole, 6 of its words in a row, an id, dev words.
    const leaky = await rel.writeNotes(p, titles, undefined, { ask: async () => ({ title: 'Fixes (#10)', notes: [
      'Products: the formulation line shows each product\'s lot (its latest build) with the version and date',
      'The formulation line shows each product\'s lot now.',
      'Resolved in 718690a.',
      'The changelog from the last pull request is tidier.',
    ] }) });
    assert.equal(leaky.source, 'fallback', 'nothing usable left');
    assert.deepEqual(leaky.notes, ['Improvements and fixes.']);

    // The corporate voice: its own forbidden words (products.json releaseVoice.never) go too; good notes stay.
    const corp = { id: 'hawkesbiomedical', name: 'Hawkes Biomedical', about: 'x', releaseVoice: { voice: 'Company notices.', never: ['B3', 'vat', 'creature', 'pharma', 'framing', 'fiction', 'game', 'fix'] } } as any;
    let corpPrompt = '';
    const c = await rel.writeNotes(corp, titles, undefined, { ask: async (prompt) => { corpPrompt = prompt; return { title: 'Every lot, on the record', notes: [
      'Notices keep the pharma framing intact.',
      'We fixed the notices page.',
      'Every formulation now lists its lot and revision date.',
      'New samples from the vat on B3.',
    ] }; } });
    assert.deepEqual({ ...c }, { title: 'Every lot, on the record', notes: ['Every formulation now lists its lot and revision date.'], source: 'gen' });
    assert.match(corpPrompt, /Company notices\./);
    assert.doesNotMatch(corpPrompt, /About it:/, 'the corporate voice, not the "fictional pharma" about line');
    for (const n of [...c.notes, c.title]) for (const t of titles) assert.ok(!n.includes(t.replace(/\s*\(#\d+\)$/, '')));
  } finally {
    process.env.STUDIO_RELEASE_NOTES = 'off';
  }
});

test('going live adds a release on beta on top of the tested commit, and it doesn\'t count as beta moving', async () => {
  commit('index.html', 'v2', 'Fix: the title (#1)');
  commit('about.html', 'about', 'Add an about page (#2)');
  git(dir, 'push', '--quiet', 'origin', 'beta');
  const tested = remote('beta');
  played(tested);
  let plan = await deployPlan('reltest');
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.release?.version, '1.1.0');
  assert.match(plan.what, /Releases 1\.1\.0 "Improvements and fixes": "Improvements and fixes\."/, 'the plan shows the exact notes');
  assert.deepEqual(plan.release?.notes, ['Improvements and fixes.']);

  const r: any = await deploy('reltest', { confirm: 'DEPLOY reltest', by: 'test', beta: tested });
  assert.equal(r.release.version, '1.1.0');
  assert.equal(remote('main'), remote('beta'), 'main is the release commit');
  assert.equal(git(origin, 'rev-parse', 'main^'), tested, 'on top of the tested commit');
  assert.deepEqual(git(origin, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'main'), 'releases.json');
  const file = releasesOn('main');
  assert.equal(file.current, '1.1.0');
  assert.equal(file.releases.length, 2);
  assert.deepEqual(Object.keys(file), ['product', 'name', 'current', 'releases'], 'the file keeps its shape');
  assert.deepEqual(file.releases[0], { version: '1.1.0', date: rel.today(), build: tested.slice(0, 7), title: 'Improvements and fixes', notes: ['Improvements and fixes.'] });
  const shipped = JSON.stringify(file.releases[0]);
  for (const t of ['Fix: the title', 'the title', 'Add an about page', 'about page', '#1', '#2']) assert.ok(!shipped.includes(t), `no commit subject in the notes: ${t}`);
  assert.match((await deployPlan('reltest')).blockers.join(' '), /Nothing to go live/);
  assert.equal(db.prepare(`SELECT beta FROM deploys WHERE product = 'reltest' ORDER BY at DESC LIMIT 1`).get()!.beta, tested, 'the deploy records the tested commit');
});

test('a go live cut short after the release commit: the plan still counts the tested commit, and no second entry', async () => {
  git(dir, 'pull', '--quiet', 'origin', 'beta');
  commit('boss.html', 'boss', 'Fix: the boss door (#3)');
  git(dir, 'push', '--quiet', 'origin', 'beta');
  const tested = remote('beta');
  played(tested);
  // As if Studio pushed the release commit to beta and restarted before main moved.
  const f = JSON.parse(fs.readFileSync(path.join(dir, 'releases.json'), 'utf8'));
  f.releases.unshift({ version: '1.1.1', date: rel.today(), build: tested.slice(0, 7), title: 'Improvements and fixes', notes: ['Improvements and fixes.'] });
  f.current = '1.1.1';
  commit('releases.json', JSON.stringify(f, null, 2), 'Release: Release test 1.1.1: Improvements and fixes');
  git(dir, 'push', '--quiet', 'origin', 'beta');
  const plan = await deployPlan('reltest');
  assert.deepEqual(plan.blockers, [], 'a release-only commit on top is not "untested"');
  assert.equal(plan.played!.sha, tested);
  assert.equal(plan.tested.playtests.length, 1);
  // The approval card binds to the tested commit, so it isn't stale either.
  const { requestApproval } = await import('../src/approvals.ts');
  const card = await requestApproval('deploy', 'reltest');
  assert.equal(JSON.parse((db.prepare('SELECT bind FROM approvals WHERE id = ?').get(card.id) as any).bind)[0], tested);
  await deploy('reltest', { confirm: 'DEPLOY reltest', by: 'test', beta: tested });
  assert.equal(remote('main'), remote('beta'));
  assert.equal(releasesOn('main').releases.length, 3, 'no second entry for the same build');

  // A release commit that also touches another file isn't one.
  assert.equal(rel.isReleaseCommit(dir, { sha: tested, short: '', title: 'Release: x', author: '', date: '' }), false);
});

test('notes already on beta are kept: an agent rewrote old notes, or wrote the new entry itself', async () => {
  git(dir, 'pull', '--quiet', 'origin', 'beta');
  // An agent rewrites the live entry's notes on beta (only releases.json changes): no new entry, beta's notes ship.
  const f = JSON.parse(fs.readFileSync(path.join(dir, 'releases.json'), 'utf8'));
  f.releases[0].notes = ['The boss door opens again.'];
  commit('releases.json', JSON.stringify(f, null, 2), 'Fix: What\'s new v1.1.1 note is raw dev text (#9)');
  git(dir, 'push', '--quiet', 'origin', 'beta');
  let tested = remote('beta');
  played(tested);
  let plan = await deployPlan('reltest');
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.release?.existing, true);
  assert.match(plan.what, /keeps the entry already on beta, 1\.1\.1 "Improvements and fixes": "The boss door opens again\."/);
  await deploy('reltest', { confirm: 'DEPLOY reltest', by: 'test', beta: tested });
  assert.equal(remote('main'), tested, 'no release commit on top');
  assert.deepEqual(releasesOn('main'), f, 'beta\'s notes, untouched');
  assert.ok(!JSON.stringify(releasesOn('main')).includes('raw dev text'));

  // An agent writes the next entry on beta along with a feature: it ships as written (not live yet), nothing rewritten.
  git(dir, 'pull', '--quiet', 'origin', 'beta');
  fs.writeFileSync(path.join(dir, 'map.html'), 'map');
  f.releases.unshift({ version: '1.2.0', date: '2026-10-18', build: '', title: 'A map', notes: ['There is a map now.'] });
  f.current = '1.2.0';
  commit('releases.json', JSON.stringify(f, null, 2), 'Add the map page (#11)');
  git(dir, 'push', '--quiet', 'origin', 'beta');
  tested = remote('beta');
  played(tested);
  plan = await deployPlan('reltest');
  assert.equal(plan.release?.existing, true);
  assert.equal(plan.release?.version, '1.2.0');
  assert.deepEqual(plan.release?.notes, ['There is a map now.']);
  await deploy('reltest', { confirm: 'DEPLOY reltest', by: 'test', beta: tested });
  assert.equal(remote('main'), tested);
  assert.deepEqual(releasesOn('main').releases[0], f.releases[0]);
});

test('writing the release fails: going live still works, without the entry', async () => {
  git(dir, 'pull', '--quiet', 'origin', 'beta');
  commit('shop.html', 'shop', 'Add a shop (#4)');
  git(dir, 'push', '--quiet', 'origin', 'beta');
  const tested = remote('beta');
  played(tested);
  // Beta refuses Studio's push (as if someone pushed beta first); main still takes the tested commit.
  const hook = path.join(origin, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do [ "$ref" = refs/heads/beta ] && exit 1; done\nexit 0\n', { mode: 0o755 });
  try {
    const r: any = await deploy('reltest', { confirm: 'DEPLOY reltest', by: 'test', beta: tested });
    assert.equal(remote('main'), tested);
    assert.match(r.log.join('\n'), /no release entry this time/);
  } finally {
    fs.rmSync(hook);
  }
});

test('notes cover everything since the newest release entry, not just the last go live (the backfill)', () => {
  const p = { id: 'reltest', name: 'Release test', about: 'A fixture.' } as any;
  const firstSha = git(origin, 'rev-list', '--max-parents=0', 'main');
  const data = { ...first, releases: [{ ...first.releases[0], build: firstSha.slice(0, 7) }] };
  const b = rel.releaseBasics(p, { data, source: dir, target: remote('main'), build: 'new', fallbackCommits: [] });
  assert.equal(b.since, firstSha);
  assert.ok(b.commits.some((c) => c.title === 'Add an about page (#2)') && b.commits.some((c) => c.title === 'Add a shop (#4)'), 'every go live since');
  // An unknown build: the plan's commits.
  const u = rel.releaseBasics(p, { data: first, source: dir, target: remote('main'), build: 'new', fallbackCommits: [] });
  assert.equal(u.since, null);
  assert.equal(u.commits.length, 0);
});

test('Unity: the release goes into the website folder; an old entry stamped with the new build is not this release', async () => {
  const p = { id: 'reltest', name: 'Release test', about: 'A fixture.' } as any;
  const folder = path.join(tmp, 'unity-site');
  fs.mkdirSync(folder);
  // A deploy method stamped the old entry's empty build with this build's number (Yooba Land's InstallReleaseNotes).
  fs.writeFileSync(path.join(folder, 'releases.json'), JSON.stringify({ ...first, releases: [{ ...first.releases[0], build: '15' }] }));
  const d = await rel.addReleaseTo(p, folder, { source: dir, target: remote('main'), build: '15', fallbackCommits: [{ sha: 'x', short: 'x', author: '', date: '', title: 'Add a boss' }] });
  assert.equal(d?.version, '1.1.0');
  const file = JSON.parse(fs.readFileSync(path.join(folder, 'releases.json'), 'utf8'));
  assert.equal(file.current, '1.1.0');
  assert.equal(file.releases[0].build, '15');
  // Again (a go live resumed after a restart): the same release, nothing added.
  const again = await rel.addReleaseTo(p, folder, { source: dir, target: remote('main'), build: '15', fallbackCommits: [] });
  assert.equal(again?.source, 'existing');
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'releases.json'), 'utf8')).releases.length, 2);
  // No releases.json: nothing is added.
  assert.equal(await rel.addReleaseTo(p, path.join(tmp, 'nowhere'), { source: dir, target: remote('main'), build: '1', fallbackCommits: [] }), null);
});

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
