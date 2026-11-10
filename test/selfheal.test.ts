// The self-healing supervisor (selfheal.ts, selfheal-checks.ts). J, 2026-11-10: "every problem that comes up should be
// dealt with by itself somehow". Each invariant applies its remedy at once; one still broken past its grace files one
// Studio fix task (or, for what only J can do, one Inbox card); anything no invariant knows files its fix straight away;
// health is not ok while something stays broken with nothing done about it.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-selfheal-'));
const S = await import('../src/selfheal.ts');
const K = await import('../src/selfheal-checks.ts');
const A = await import('../src/agents.ts');
const C = await import('../src/causes.ts');
await S.loadEscalation();

const MIN = 60_000;
let fixes: { key: string; detail: string; evidence: string[] }[] = [];
let cards: { key: string; text: string }[] = [];
const realFix = S.escalation.fix;
beforeEach(() => {
  S.resetSelfHeal();
  fixes = [];
  cards = [];
  S.escalation.fix = (key, _label, detail, evidence) => (fixes.push({ key, detail, evidence }), `k_fix_${key}`);
  S.escalation.card = (key, q) => (cards.push({ key, text: q.text }), `q_${key}`);
});

test('a breach is remedied and logged; past its grace it files one fix task, once; when it holds again that is logged', async () => {
  let broken = true;
  S.register({ key: 'demo', label: 'Demo holds', escalate: 'fix', look: () => (broken ? { breach: '3 things stuck', did: 'nudged them' } : { breach: null }) });
  const t0 = 1_000 * MIN;
  await S.supervise(t0);
  assert.equal(fixes.length, 0, 'not before its grace');
  assert.deepEqual(S.recentLog('demo').map((l) => l.kind).sort(), ['breach', 'remedy']);
  await S.supervise(t0 + 16 * MIN);
  assert.equal(fixes.length, 1, 'escalated past its grace');
  assert.match(fixes[0].evidence.join('\n'), /first seen: 3 things stuck/);
  await S.supervise(t0 + 30 * MIN);
  assert.equal(fixes.length, 1, 'only once per breach');
  broken = false;
  await S.supervise(t0 + 35 * MIN);
  assert.equal(S.recentLog('demo')[0].kind, 'cleared');
  assert.equal(S.states()[0].since, null);
});

test('a check that throws is itself a breach, and is filed like any other', async () => {
  S.register({ key: 'boom', label: 'Boom', escalate: 'fix', graceMs: 0, look: () => { throw new Error('no such table'); } });
  const [r] = await S.supervise(5 * MIN);
  assert.match(String(r.breach), /the check itself failed: no such table/);
  assert.equal(fixes.length, 1);
});

test("only J's own matters become a card, with Studio's recommendation", async () => {
  S.register({ key: 'quota', label: 'Quota', escalate: 'card', graceMs: 0, look: () => ({ breach: 'quota full', did: 'ran fewer agents' }), card: (d) => ({ text: `raise it? ${d}`, options: ['raise', 'keep'], recommend: 'raise' }) });
  await S.supervise(MIN);
  assert.equal(cards.length, 1);
  assert.equal(fixes.length, 0);
  assert.match(cards[0].text, /quota full/);
});

test('a new stall shape (an anomaly) files its fix at once, with its evidence', () => {
  const ref = S.anomaly('loop-block', 'Studio froze', 'blocked 224 s in getHold', ['where: getHold (src/harness-hold.ts:40)']);
  assert.equal(ref, 'k_fix_anomaly:loop-block');
  assert.deepEqual(fixes[0].evidence, ['where: getHold (src/harness-hold.ts:40)']);
});

test('the real escalation files one Studio fix task per invariant while it is open (causes.ts openFix), high priority', async () => {
  S.escalation.fix = realFix;
  const made: string[] = [];
  const keep = C.hooks.openFix;
  const { db } = await import('../src/db.ts');
  C.hooks.openFix = (cause) => {
    made.push(cause.key);
    const id = `k_${made.length}`;
    db.prepare("INSERT INTO tasks (id, item, product, title, request, status, created) VALUES (?, 'i_1', 'hawkesstudio', ?, 'r', 'planned', ?)").run(id, `Fix the cause: ${cause.label}`, Date.now());
    return { task: id, item: 'i_1' };
  };
  try {
    const a = S.anomaly('crash', 'Studio crashed', 'TypeError', ['stack']);
    const b = S.anomaly('crash', 'Studio crashed', 'TypeError again', ['stack']);
    assert.equal(made.length, 1, 'one task while it is open');
    assert.deepEqual(made, ['selfheal:anomaly:crash']);
    assert.equal(a, 'k_1');
    assert.equal(b, 'k_1', 'the second time points at the open task');
    assert.equal((db.prepare('SELECT priority FROM tasks WHERE id = ?').get('k_1') as any).priority, 'high');
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = 'k_1'").run();
    assert.equal(S.anomaly('crash', 'Studio crashed', 'back again', ['stack']), 'k_2', 'a new task once the old one is done');
  } finally {
    C.hooks.openFix = keep;
  }
});

test('health: not ok while broken past the grace with no remedy and no escalation; fine while being fixed', () => {
  const now = 100 * MIN;
  const base = { key: 'x', label: 'X', lastBreach: now, detail: 'd', looks: 3, lastLook: now, escalatedAt: null };
  assert.equal(S.failing([{ ...base, since: now - 20 * MIN, did: null, didAt: null, escalated: null }], now).length, 1);
  assert.equal(S.failing([{ ...base, since: now - 20 * MIN, did: 'x', didAt: now - 5 * MIN, escalated: null }], now).length, 0, 'a recent remedy');
  assert.equal(S.failing([{ ...base, since: now - 20 * MIN, did: null, didAt: null, escalated: 'k_1' }], now).length, 0, 'a fix is filed');
  assert.equal(S.failing([{ ...base, since: now - 5 * MIN, did: null, didAt: null, escalated: null }], now).length, 0, 'still in its grace');
});

test('health says not ok when the supervisor stopped looking', async () => {
  S.register({ key: 'demo', label: 'Demo', escalate: 'fix', look: () => ({ breach: null }) });
  const t = 2_000 * MIN;
  await S.supervise(t);
  assert.equal(S.selfHealHealth(t + MIN).ok, true);
  assert.equal(S.selfHealHealth(t + 20 * MIN).stale, true);
  assert.equal(S.selfHealHealth(t + 20 * MIN).ok, false);
});

test('duplicates: the furthest-along change stays, queued extras for the same task go', () => {
  const row = (id: string, task: string | null, status: string, created: number) => ({ id, task, status, detail: null, product: 'p', created, updated: created });
  const d = K.duplicates([row('a', 'k1', 'queued', 1), row('b', 'k1', 'working', 2), row('c', 'k1', 'queued', 3), row('d', 'k2', 'queued', 1), row('e', null, 'queued', 1)]);
  assert.deepEqual(d, [{ keep: 'b', extra: ['a', 'c'], task: 'k1' }]);
  assert.deepEqual(K.duplicates([row('a', 'k1', 'working', 1), row('b', 'k1', 'verifying', 2)]), [], 'never closes one that started');
});

test('false gates: a change waiting for memory or disk while there is room is looked at again', () => {
  const rows = [{ id: 'm', status: 'queued', detail: 'queued: waits for memory to free up (x)' }, { id: 'd', status: 'queued', detail: 'queued: waits for disk room (the disk is full)' }, { id: 'o', status: 'queued', detail: 'queued' }];
  assert.deepEqual(K.falselyGated(rows, { memLow: false, diskFull: false }), ['m', 'd']);
  assert.deepEqual(K.falselyGated(rows, { memLow: true, diskFull: true }), []);
});

test('a run with nothing moving for hours is stuck; a slow one still moving is not', () => {
  const now = 100 * 60 * MIN;
  const runs = [{ id: 'r1', kind: 'daily', started: now - 10 * 60 * MIN, lastStep: now - 4 * 60 * MIN }, { id: 'r2', kind: 'daily', started: now - 10 * 60 * MIN, lastStep: now - 10 * MIN }];
  assert.deepEqual(K.stuckRuns(runs, now, 3 * 60 * MIN).map((r) => r.id), ['r1']);
});

test("Studio's own fix always gets a slot: a full queue, a cap or product work never starves it", () => {
  assert.deepEqual(A.slotsFree(6, 6, { ownRunning: false, ownQueued: true, cap: null }), { free: 1, ownOnly: true });
  assert.deepEqual(A.slotsFree(6, 6, { ownRunning: true, ownQueued: true, cap: null }), { free: 0, ownOnly: false });
  assert.deepEqual(A.slotsFree(6, 6, { ownRunning: false, ownQueued: false, cap: null }), { free: 0, ownOnly: false });
  assert.deepEqual(A.slotsFree(6, 2, { ownRunning: false, ownQueued: false, cap: 3 }), { free: 1, ownOnly: false }, 'the cap scales work down');
  assert.equal(A.studioOwn({ product: 'hawkesstudio' }), true);
  assert.equal(A.studioOwn({ product: 'yooba-land', infra: 'hawkesgen' }), true);
  assert.equal(A.studioOwn({ product: 'yooba-land' }), false);
});

test("the pump puts Studio's own changes first and lets them past the memory gate", () => {
  const src = fs.readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8');
  const pass = src.slice(src.indexOf('async function pumpPass()'), src.indexOf('/** Pushes a change'));
  assert.match(pass, /\.sort\(\(a, b\) => Number\(studioOwn\(b\)\) - Number\(studioOwn\(a\)\)\)/);
  assert.match(pass, /const own = picks\.filter\(\(id\) => studioOwn\(getChange\(id\)!\)\)/);
  assert.match(pass, /slotsFree\(/);
});

test('every invariant the supervisor keeps is registered, with a label and an escalation', () => {
  K.registerChecks();
  const keys = S.invariants().map((i) => i.key);
  for (const k of ['queue-idle', 'stuck-work', 'provider-probe', 'gen-reachable', 'deploy-paused', 'gates-false', 'duplicates', 'orphans', 'run-stuck', 'daily-run', 'cloud-quota', 'crashes', 'unknown-failures']) assert.ok(keys.includes(k), k);
  assert.equal(S.invariants().find((i) => i.key === 'cloud-quota')!.escalate, 'card', 'a Google Cloud quota is J\'s alone');
});
