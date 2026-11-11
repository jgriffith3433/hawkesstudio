// Playtests run once on each milestone's build, at the milestone's end (play-policy.ts, J 2026-11-11: "Builds and
// playtests stay on GPUs. Just don't be wasteful", "playtests don't need to be so frequent either", "Do it during
// milestones"). The rule's parts, then a random-step test: merges, milestone ends, rechecks, daily runs, Studio's and a
// person's go lives and one-off asks in a random order, driven through pipeline.ts's real play with Hawkes Gen standing in.
// After every step: no play outside a milestone (or a person's go live), and never two plays of one scenario on a build.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

const listen = async (h: http.RequestListener) => {
  const s = http.createServer(h);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  after(() => s.close());
  return (s.address() as any).port as number;
};
const body = async (req: http.IncomingMessage) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; };
const json = (res: http.ServerResponse, code: number, o: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

// Hawkes Gen, standing in: every job done at once; every GPU play it was asked for is counted.
type Job = { id: string; tool: string; params: any; status: string; result: any; outputs: any[]; cost: number };
const jobs: Job[] = [];
const resultOf = (tool: string) => ({
  'playtest.run': { outcome: 'passed', seconds: 30, problems: [], fps: { average: 60 } },
  'playtest.review': { verdict: 'ship', summary: 'Works.', findings: [], known: [], scores: {} },
  'llm.json': { value: { criteria: [] } },
} as Record<string, any>)[tool] ?? {};
const genPort = await listen(async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  const b = await body(req);
  if (url.pathname === '/v1/health') return json(res, 200, { ok: true });
  if (url.pathname.startsWith('/v1/tools/')) return json(res, 200, { id: url.pathname.slice(10), version: 1 });
  if (url.pathname === '/v1/jobs' && req.method === 'POST') {
    const j: Job = { id: `j_${jobs.length + 1}`, tool: b.tool, params: b.params, status: 'done', result: resultOf(b.tool), outputs: [], cost: 0 };
    jobs.push(j);
    return json(res, 200, { jobs: [j] });
  }
  if (url.pathname === '/v1/jobs') return json(res, 200, { jobs: [] });
  const j = jobs.find((x) => url.pathname === `/v1/jobs/${x.id}`);
  if (j) return json(res, 200, j);
  json(res, 404, { error: `no ${url.pathname}` });
});
const sitePort = await listen((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><body>game</body></html>'); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-play-policy-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.HAWKESGEN_URL = `http://127.0.0.1:${genPort}`;
process.env.GEN_PUBLIC_URL = `http://127.0.0.1:${genPort}`;
process.env.STUDIO_LLM_VIA = 'gen';
process.env.STUDIO_PM_TALK = 'off';
for (const k of ['STUDIO_SERVER', 'HAWKESGEN_KEY', 'NTFY_TOPIC']) delete process.env[k];
process.env.STUDIO_BETA_LANE = '1';
const repo = path.join(process.env.STUDIO_PROJECTS, 'ppgame');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
const git = (...args: string[]) => spawnSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });
git('init', '-q', '-b', 'beta');
let n = 0;
const merge = () => { fs.writeFileSync(path.join(repo, 'f.txt'), String(++n)); git('add', '.'); git('commit', '-q', '-m', `change ${n}`); return git('rev-parse', 'HEAD').stdout.trim(); };
merge();
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'ppgame', name: 'Play policy', framing: 'test', engine: 'static', repo: 'ppgame', site: 'ppgame', live: `http://127.0.0.1:${sitePort}/`,
  local: { serve: 'remote', dir: 'ppgame', port: sitePort, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }, { scenario: 'smoke', where: 'live' }], story: [], about: 'A fixture.',
}], repos: {} }));

const pol = await import('../src/play-policy.ts');
const P = await import('../src/pipeline.ts');
const G = await import('../src/golive-policy.ts');
const { getProduct } = await import('../src/config.ts');
const { db, J, newId } = await import('../src/db.ts');

const plays = () => jobs.filter((j) => j.tool === 'playtest.run').length;
const step = (run: string, o: { name?: string; status?: string; job?: string | null; sha?: string; build?: string } = {}) =>
  db.prepare('INSERT INTO steps (id, run, product, kind, name, status, detail, data, job, started) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(newId('s'), run, 'ppgame', 'playtest', o.name ?? 'smoke@local', o.status ?? 'done', 'x', J({ played: { branch: 'beta', sha: o.sha ?? 'aaaa', ...(o.build ? { build: o.build } : {}) } }), o.job === undefined ? 'j_x' : o.job, Date.now());

test('the rule, pure: only a milestone or a person going live plays; where a scenario played is not another play', () => {
  assert.equal(pol.playsFor('milestone'), true);
  assert.equal(pol.playsFor('golive'), true);
  for (const c of [undefined, null, 'merge', 'daily', 'person'] as any[]) assert.equal(pol.playsFor(c), false, String(c));
  assert.equal(pol.scenarioKey('smoke@local:phone'), 'smoke:phone');
  assert.equal(pol.scenarioKey('smoke@live'), 'smoke');
  assert.equal(pol.scenarioKey('campaign'), 'campaign');
});

test('playedBefore: a play that reached an end on this build counts; a failed, unstarted or other build or scenario does not', () => {
  db.exec(`DELETE FROM steps WHERE product = 'ppgame'`);
  assert.equal(pol.playedBefore('ppgame', 'aaaa', 'smoke@local'), null);
  step('r_1', { status: 'failed', sha: 'aaaa' });
  step('r_1', { job: null, sha: 'aaaa' });
  step('r_1', { name: 'feel@local', sha: 'aaaa' });
  step('r_1', { sha: 'bbbb' });
  assert.equal(pol.playedBefore('ppgame', 'aaaa', 'smoke@local'), null, 'a failed play judged nothing, and nothing played without a Gen job');
  step('r_2', { sha: 'aaaa' });
  assert.equal(pol.playedBefore('ppgame', 'aaaa', 'smoke@local')?.run, 'r_2');
  assert.equal(pol.playedBefore('ppgame', 'aaaa', 'smoke@live')?.run, 'r_2', 'the same scenario elsewhere is the same play of the build');
  assert.equal(pol.playedBefore('ppgame', 'aaaa', 'smoke@local:phone'), null, 'a phone play is its own');
  step('r_3', { sha: 'cccc', build: '42' });
  assert.equal(pol.playedBefore('ppgame', '42', 'smoke@local')?.run, 'r_3', 'a Unity build is matched by its build id');
  assert.equal(pol.playedBefore('ppgame', null, 'smoke@local'), null);
  db.exec(`DELETE FROM steps WHERE product = 'ppgame'`);
});

test('claimPlay: the first play of a build\'s scenario claims it; another waits it out; a play that ended unplayed gives it up', () => {
  db.exec(`DELETE FROM steps WHERE product = 'ppgame'; DELETE FROM play_claims WHERE product = 'ppgame'`);
  const runOf = (status: string) => { const id = newId('r'); db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'beta', status, 'x', J(['ppgame']), '{}', Date.now()); return id; };
  const mine = (run: string) => { const id = newId('s'); db.prepare('INSERT INTO steps (id, run, product, kind, name, status, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, run, 'ppgame', 'playtest', 'smoke@local', 'running', Date.now()); return id; };
  const r1 = runOf('running'); const s1 = mine(r1);
  const r2 = runOf('running'); const s2 = mine(r2);
  assert.equal(pol.claimPlay('ppgame', 'dddd', 'smoke@local', s1, r1), null, 'the first plays');
  assert.equal(pol.claimPlay('ppgame', 'dddd', 'smoke@local', s2, r2)?.status, 'running', 'the second does not, while the first plays');
  assert.equal(pol.claimPlay('ppgame', 'dddd', 'smoke@local', s1, r1), null, 'the claimer asking again still plays');
  assert.equal(pol.claimPlay('ppgame', 'eeee', 'smoke@local', s2, r2), null, 'another build is another play');
  db.prepare(`UPDATE steps SET status = 'failed' WHERE id = ?`).run(s1);
  assert.equal(pol.claimPlay('ppgame', 'dddd', 'smoke@local', s2, r2), null, 'a play that failed played nothing: the build is played again');
  db.exec(`DELETE FROM steps WHERE product = 'ppgame'; DELETE FROM play_claims WHERE product = 'ppgame'`);
});

test('a one-off playtest is refused where it is asked for: no run, no GPU', () => {
  const before = (db.prepare('SELECT COUNT(*) AS n FROM runs').get() as any).n;
  assert.throws(() => P.startPartial('playtest', 'ppgame', {}), (e: any) => e.status === 409 && /milestone/.test(e.message));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM runs').get() as any).n, before);
});

for (const first of [20261111, 7, 4242]) test(`random steps (seed ${first}): no play outside a milestone or a person's go live, and one play per scenario per build`, async () => {
  db.exec(`DELETE FROM steps WHERE product = 'ppgame'`);
  jobs.length = 0;
  // A seeded generator: the same order every time, so a failure can be replayed.
  let seed = first;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const allowed = new Set<string>(); // runs started for a milestone or a person's go live
  const start = (product: string, o: any) => { const r = P.startBeta(product, o); pending.push(r.done); if (pol.playsFor(o.play)) allowed.add(r.id); return { id: r.id }; };
  let pending: Promise<unknown>[] = [];
  const actions: Record<string, () => Promise<void>> = {
    merge: async () => { merge(); },
    milestone: async () => { start('ppgame', { focus: 'Milestone: play its build once', playtest: true, play: 'milestone', cause: 'milestone', quiet: 0 }); },
    recheck: async () => { start('ppgame', { focus: 'Checking beta after merges', playtest: true, reverify: true }); },
    agentCheck: async () => { start('ppgame', { focus: 'Checking a task', criteria: ['It works'], playtest: true }); },
    daily: async () => { const id = newId('r'); db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'daily', 'running', 'daily', J(['ppgame']), '{}', Date.now()); await P.runProduct(id, getProduct('ppgame'), { noChecks: true } as any); },
    studioGoLive: async () => { const r = await G.playBeforeGoLive('ppgame', git('rev-parse', '--short', 'HEAD').stdout.trim(), 'Studio', start); assert.ok(r.held, 'Studio going live starts no play'); },
    personGoLive: async () => { await G.playBeforeGoLive('ppgame', git('rev-parse', '--short', 'HEAD').stdout.trim(), 'J asked', start, 'person'); },
    oneOff: async () => { assert.throws(() => P.startPartial('playtest', 'ppgame', {})); },
  };
  const names = Object.keys(actions);
  const seen: string[] = [];
  for (let i = 0; i < 60; i++) {
    const a = names[Math.floor(rand() * names.length)];
    seen.push(a);
    await actions[a]();
    // Half the time the runs finish before the next step; otherwise steps overlap them.
    if (rand() < 0.5 || i === 59) { await Promise.all(pending); pending = []; }
    const played = db.prepare(`SELECT run, name, job, data FROM steps WHERE product = 'ppgame' AND kind = 'playtest' AND job IS NOT NULL AND job != ''`).all() as any[];
    for (const s of played) assert.ok(allowed.has(s.run), `step ${i} (${a}): run ${s.run} played without a milestone or a person's go live (${seen.join(', ')})`);
    const per = new Map<string, number>();
    for (const s of played) {
      const k = `${JSON.parse(s.data)?.played?.sha}|${pol.scenarioKey(s.name)}`;
      per.set(k, (per.get(k) ?? 0) + 1);
    }
    for (const [k, c] of per) assert.equal(c, 1, `step ${i} (${a}): ${k} played ${c} times (${seen.join(', ')})`);
    assert.equal(plays(), played.length, `step ${i} (${a}): every GPU play is a recorded milestone or go live play`);
  }
  assert.ok(seen.includes('milestone') && seen.includes('merge') && seen.includes('recheck'), 'the walk covered the main triggers');
  assert.ok(plays() > 0, 'milestones did play');
});
