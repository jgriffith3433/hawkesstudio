// Out of credits is its own outcome (creditwait.ts; J, 2026-11-07: the same roadmap task ran again and again). A run refused
// for credits is "waiting for credits", never a failed beta build, never blamed on a change; nothing paid starts meanwhile
// (one Inbox card); when credits are added the waiting beta run plays once. No Gen, no GitHub: stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-creditwait-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.TALK_CLAUDE = 'no-such-claude-here';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'cwgame', name: 'Credit Wait Game', framing: 'test', engine: 'web', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: 'site', port: 8799, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
}] }));

const { db, newId } = await import('../src/db.ts');
const { CreditsNeeded, outOfCredits, grantCredits } = await import('../src/billing.ts');
const W = await import('../src/creditwait.ts');
const pm = await import('../src/pm.ts');
const Cr = await import('../src/credits.ts');
const ib = await import('../src/inbox.ts');

const run = (kind = 'beta', status = 'running', options: Record<string, unknown> = {}) => {
  const id = newId('r');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, kind, status, 'x', JSON.stringify(['cwgame']), JSON.stringify(options), Date.now());
  return id;
};
const refusal = () => new CreditsNeeded(outOfCredits(9, 1, 'playtest.run'), 9, 1);

test('a refusal for credits, quota or billing is recognised; a game bug is not', () => {
  const a = W.creditRefusal(refusal());
  assert.deepEqual([a?.need, a?.have], [9, 1]);
  assert.match(a!.message, /playtest\.run needs 9 and 1 is left/);
  // Gen's own 402, and the plain words (as they reach a step from a job error).
  assert.ok(W.creditRefusal(Cr.genRefusal(Object.assign(new Error('need 20, have 3'), { status: 402, kind: 'credits' }))));
  assert.ok(W.creditRefusal(Object.assign(new Error('Payment Required'), { status: 402 })));
  assert.ok(W.creditRefusal(new Error('You exceeded your current quota, please check your plan and billing details')));
  assert.equal(W.creditRefusal(new Error('the game crashed: TypeError at boot')), null);
  assert.equal(W.creditRefusal(Object.assign(new Error('Gen HTTP 500'), { status: 500 })), null);
  assert.equal(W.creditRefusal(null), null);
});

test('a held run is not a failed beta build, and the PM sends nothing back for it', () => {
  const r = run('beta', 'cancelled');
  // The step the pipeline leaves: cancelled with data.credits (not failed), the run cancelled.
  db.prepare("INSERT INTO steps (id, run, product, kind, name, status, detail, data, started) VALUES (?, ?, 'cwgame', 'playtest', 'smoke', 'cancelled', 'waiting for credits', ?, ?)").run(newId('s'), r, JSON.stringify({ credits: true }), Date.now());
  W.holdRun(r, 'cwgame', W.creditRefusal(refusal())!);
  assert.equal(W.heldRun(r), true);
  // Without the hold, a run with no failed step and no done status reads as a failed build (the bug of Nov 6).
  const blamed = pm.buildOf('cwgame', { id: r, status: 'failed', detail: 'This studio is out of credits' });
  assert.equal(blamed.ok, false, 'a thrown run reads as a failed build');
  // brokenCheck says why nothing was judged (waiting, not a miss).
  assert.match(String(pm.brokenCheck(r, 'cwgame')), /cancelled/);
  assert.equal(W.heldRun(run()), false);
});

test('while waiting: one state, paid work does not start, the PM leaves tasks alone', async () => {
  db.exec('DELETE FROM credit_waits');
  assert.equal(W.creditsWaiting(), null);
  assert.equal(W.creditsWaitReason(), null);
  const r1 = run();
  const r2 = run();
  W.holdRun(r1, 'cwgame', W.creditRefusal(refusal())!);
  W.holdRun(r2, 'cwgame', W.creditRefusal(refusal())!);
  W.holdRun(r2, 'cwgame', W.creditRefusal(refusal())!); // once per run
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM credit_waits').get() as any).n, 2);
  const w = W.creditsWaiting()!;
  assert.equal(w.runs.length, 2);
  assert.match(String(W.creditsWaitReason()), /waiting for credits.*by itself when credits are added/);
  // The task's start waits with that exact sentence (UI and stall reasons say the same thing).
  assert.match(String(pm.startWaitReason({ id: 't_x', product: 'cwgame' })), /waiting for credits/);
  // ONE Inbox card, however many runs were held.
  const cards = (await ib.inbox()).filter((x) => x.kind === 'credits');
  assert.equal(cards.length, 1);
  assert.match(cards[0].text!, /Nothing failed and no agent was sent back/);
});

test('credits back: the waiting milestone run plays once (and a daily or one-off run is not replayed)', async () => {
  db.exec('DELETE FROM credit_waits');
  const beta = run('beta', 'cancelled', { play: 'milestone', cause: 'milestone', playtest: true });
  const beta2 = run('beta', 'cancelled', { play: 'milestone', cause: 'milestone', playtest: true });
  const daily = run('daily', 'cancelled');
  for (const r of [beta, beta2, daily]) W.holdRun(r, 'cwgame', W.creditRefusal(refusal())!);
  const started: string[] = [];
  const startBeta = (product: string, o: any) => { assert.equal(product, 'cwgame'); assert.equal(o.playtest, true); assert.equal(o.play, 'milestone'); assert.equal(o.cause, 'milestone'); const id = `r_new${started.length}`; started.push(id); return { id }; };
  const ids = W.resumeWaiting(startBeta, Date.now());
  assert.equal(ids.length, 1, 'two held beta runs of one product play once');
  assert.equal(W.creditsWaiting(), null, 'the wait is over');
  assert.deepEqual(W.resumeWaiting(startBeta, Date.now()), [], 'a second event starts nothing');
  assert.equal(started.length, 1);
});

test('the credit-change event (a grant on the ledger) resumes; a charge does not; no timer', async () => {
  db.exec('DELETE FROM credit_waits');
  const r = run('beta', 'cancelled');
  W.holdRun(r, 'cwgame', W.creditRefusal(refusal())!);
  const started: string[] = [];
  const stop = W.watchCredits((product) => { started.push(product); return { id: 'r_resumed' }; });
  grantCredits(-5, 'usage', 'a charge', null); // credits going out are no reason to resume
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(started, []);
  grantCredits(500, 'pack', 'bought', null);
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(started, ['cwgame']);
  assert.equal(W.creditsWaiting(), null);
  stop();
});

test('a hold lapses after an hour (a cell hears no event), and a new refusal holds it again', () => {
  db.exec('DELETE FROM credit_waits');
  W.holdRun(run(), 'cwgame', W.creditRefusal(refusal())!, Date.now() - W.HOLD_MS - 1000);
  assert.equal(W.creditsWaiting(), null);
});

test('credits back for a beta run no milestone started: it builds again, no play (play-policy.ts)', async () => {
  db.exec('DELETE FROM credit_waits');
  const beta = run('beta', 'cancelled');
  W.holdRun(beta, 'cwgame2', W.creditRefusal(refusal())!);
  const seen: any[] = [];
  const ids = W.resumeWaiting((product: string, o: any) => { seen.push(o); return { id: 'r_build0' }; }, Date.now());
  assert.equal(ids.length, 1);
  assert.equal(seen[0].playtest, false);
  assert.equal(seen[0].play, undefined);
});
