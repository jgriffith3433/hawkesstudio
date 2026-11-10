// Going live when beta moved after its last playtest (J, 2026-11-10: six "Going live with ..." failed with "beta hasn't
// been playtested at <sha>" after new merges, and one with "Nothing to go live: main already is beta"):
// - the go live plays beta's newest commit once and WAITS for it (ops.ts status "waiting", not a failure), then goes live
//   by itself when that play passes, without anyone asking again;
// - a play that fails is the one thing that fails it, with the play's reason;
// - beta moving on during the play is played again, a bounded number of times;
// - "Nothing to go live: main already is beta" is a no-op that succeeds;
// - a restart, or a run that ends however it ends, never leaves it parked.
// GitHub is a stand-in (fake-github.ts); starting beta's play is a stand-in too (deploy.ts goLiveHooks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fakeGitHub, sha } from './fake-github.ts';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-golive-wait-'));
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_CUSTOMER = '1';
process.env.STUDIO_PUBLIC_URL = 'https://studio.hawkesgen.ai/o/acme';
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9';
delete process.env.STUDIO_PRODUCTS;
delete process.env.K_SERVICE;

const cp = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const b = JSON.parse(body || '{}');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url === '/api/cells/self/github-token') return res.end(JSON.stringify({ token: `ghs_${String(b.repo).split('/')[1]}`, expires: Date.now() + 3600_000 }));
  res.end('{}');
});
await new Promise<void>((r) => cp.listen(0, '127.0.0.1', () => r()));
test.after(() => cp.close());
process.env.STUDIO_CONTROL_URL = `http://127.0.0.1:${(cp.address() as any).port}`;
process.env.STUDIO_ORG = 'org_acme';
process.env.STUDIO_CELL_KEY = 'cell-key';
fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'agents.json'), JSON.stringify({ enabled: true }));

const game = (id: string) => ({ id, name: id[0].toUpperCase() + id.slice(1), engine: 'web', repo: `acme/${id}`, about: '', contract: true, playtests: [], story: [] });
fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'products.json'), JSON.stringify({ products: ['moved', 'broke', 'same', 'busy', 'parked'].map(game) }));

const chain = (titles: string[]) => {
  const commits: Record<string, any> = {};
  titles.forEach((t, i) => { commits[sha(String(i + 1))] = { parents: i ? [sha(String(i))] : [], tree: `t${i + 1}`, title: t }; });
  return commits;
};
const gh = fakeGitHub({
  'acme/moved': { refs: { main: sha('1'), beta: sha('3') }, commits: chain(['start', 'Faster jumps', 'A new level']) },
  'acme/broke': { refs: { main: sha('1'), beta: sha('2') }, commits: chain(['start', 'Risky']) },
  'acme/same': { refs: { main: sha('2'), beta: sha('2') }, commits: chain(['start', 'Already out']) },
  'acme/busy': { refs: { main: sha('1'), beta: sha('2') }, commits: chain(['start', 'One', 'Two', 'Three', 'Four', 'Five']) },
  'acme/parked': { refs: { main: sha('1'), beta: sha('2') }, commits: chain(['start', 'Parked']) },
});
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => (new URL(String(input instanceof Request ? input.url : input)).host === 'api.github.com' ? gh.f(input, init) : realFetch(input, init))) as typeof fetch;
test.after(() => { globalThis.fetch = realFetch; });

const D = await import('../src/deploy.ts');
const ops = await import('../src/ops.ts');
const { db } = await import('../src/db.ts');
await import('../src/builds.ts');

// Starting beta's play: a run row, as pipeline.ts startBeta makes one; the test plays it (played) and ends it (end).
let runs = 0;
const started: { product: string; short: string; run: string }[] = [];
D.goLiveHooks.play = async (product, short) => {
  const playing = db.prepare(`SELECT id FROM runs WHERE kind = 'beta' AND status = 'running' AND products LIKE ?`).get(`%"${product}"%`) as any;
  if (playing) return { playing: playing.id };
  const run = `r_wait${String(++runs).padStart(8, '0')}`;
  db.prepare('INSERT INTO runs (id, kind, status, products, options, started) VALUES (?, ?, ?, ?, ?, ?)').run(run, 'beta', 'running', JSON.stringify([product]), JSON.stringify({ focus: `Before go-live: playing beta ${short} once` }), Date.now());
  started.push({ product, short, run });
  return { started: run };
};
function played(product: string, run: string, short: string, ok = true) {
  const at = Date.now();
  db.prepare('INSERT INTO steps (id, run, product, kind, name, status, detail, data, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`s_${run}_p`, run, product, 'playtest', 'smoke@local', ok ? 'done' : 'failed', ok ? 'won' : 'the game froze on load', JSON.stringify({ played: { branch: 'beta', sha: short }, outcome: ok ? 'won' : null }), at, at);
  db.prepare('INSERT INTO steps (id, run, product, kind, name, status, detail, data, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`s_${run}_r`, run, product, 'review', 'smoke@local', 'done', ok ? 'ship' : 'broken', JSON.stringify({ verdict: ok ? 'ship' : 'broken', summary: ok ? 'fine' : 'frozen', findings: [] }), at, at);
}
const end = (product: string, run: string) => {
  db.prepare(`UPDATE runs SET status = 'done', finished = ? WHERE id = ?`).run(Date.now(), run);
  D.wakeGoLives(product, run); // pipeline.ts startBeta does this when any beta run ends
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 10_000) {
  const stop = Date.now() + ms;
  while (!f()) {
    if (Date.now() > stop) throw new Error('timed out');
    await sleep(20);
  }
}
const op = (id: string) => ops.getOp(id)!;

test('beta moved after its last play: the go live plays beta once, waits (not failed), then goes live by itself when the play passes', async () => {
  const { op: o } = D.queueLive('golive', { product: 'moved', confirm: 'DEPLOY moved', by: 'J (via Claude)' });
  await until(() => op(o.id).status === 'waiting');
  const w = op(o.id);
  assert.equal(w.error, null, 'no failure recorded');
  assert.match(w.step!, /waiting for beta's playtest at 3333333/);
  assert.equal(w.wait?.on, started.at(-1)!.run);
  assert.equal(gh.repos['acme/moved'].refs.main, sha('1'), 'nothing went live yet');
  // Asking again while it waits is the same ask, and starts no second play.
  assert.equal(D.queueLive('golive', { product: 'moved', confirm: 'DEPLOY moved', by: 'J (via Claude)' }).op.id, o.id);
  assert.equal(started.filter((s) => s.product === 'moved').length, 1);
  // The Activity panel lists it as in progress, never as a failure.
  const { activity } = await import('../src/activity.ts');
  const a: any = await activity();
  assert.ok(a.ops.some((x: any) => x.id === o.id && x.status === 'waiting'));
  assert.ok(!a.failures.some((f: any) => f.key === `op:${o.id}`));
  // The play passes and its run ends: nobody asks again, and it goes live.
  played('moved', started.at(-1)!.run, sha('3').slice(0, 7));
  end('moved', started.at(-1)!.run);
  await until(() => op(o.id).status === 'done');
  assert.equal(gh.repos['acme/moved'].refs.main, sha('3'));
  assert.equal(op(o.id).result.main, '3333333');
});

test('a play that fails is what fails the go live, with its reason; nothing moves', async () => {
  const { op: o } = D.queueLive('golive', { product: 'broke', confirm: 'DEPLOY broke', by: 'J' });
  await until(() => op(o.id).status === 'waiting');
  const run = started.at(-1)!.run;
  played('broke', run, sha('2').slice(0, 7), false);
  end('broke', run);
  await until(() => op(o.id).status === 'failed');
  assert.match(op(o.id).error!, /playtest before going live didn't pass/);
  assert.equal(gh.repos['acme/broke'].refs.main, sha('1'));
});

test('"Nothing to go live: main already is beta" is a no-op that succeeds, not a failure', async () => {
  const { op: o } = D.queueLive('golive', { product: 'same', confirm: 'DEPLOY same', by: 'J' });
  await until(() => ['done', 'failed'].includes(op(o.id).status));
  assert.equal(op(o.id).status, 'done', op(o.id).error ?? '');
  assert.equal(op(o.id).result.nothing, true);
  assert.match(op(o.id).result.note, /Already live/);
});

test('beta moving on during each play is played again, at most MAX_PLAY_ROUNDS times, then it says so', async () => {
  const r = gh.repos['acme/busy'];
  const { op: o } = D.queueLive('golive', { product: 'busy', confirm: 'DEPLOY busy', by: 'J' });
  for (let i = 0; i < D.MAX_PLAY_ROUNDS; i++) {
    await until(() => op(o.id).status === 'waiting' && op(o.id).wait?.rounds === i + 1);
    const run = started.at(-1)!.run;
    played('busy', run, r.refs.beta.slice(0, 7));
    r.refs.beta = sha(String(i + 3)); // a merge landed while it played
    end('busy', run);
  }
  await until(() => op(o.id).status === 'failed');
  assert.match(op(o.id).error!, /beta kept moving/);
  assert.equal(r.refs.main, sha('1'));
});

test('a waiting go live is never left parked: a restart wakes it when its run is over, and only its own run wakes it', async () => {
  const { op: o } = D.queueLive('golive', { product: 'parked', confirm: 'DEPLOY parked', by: 'J' });
  await until(() => op(o.id).status === 'waiting');
  const run = op(o.id).wait!.on!;
  // Another run of the project ending doesn't wake one waiting on a specific run.
  assert.equal(ops.wakeOps({ kind: 'golive', product: 'parked', run: 'r_other0000001' }), 0);
  // Its run ended while Studio was down: resumeOps puts it back in the queue.
  played('parked', run, sha('2').slice(0, 7));
  db.prepare(`UPDATE runs SET status = 'done', finished = ? WHERE id = ?`).run(Date.now(), run);
  ops.resumeOps();
  await until(() => op(o.id).status === 'done', 15_000);
  assert.equal(gh.repos['acme/parked'].refs.main, sha('2'));
});
