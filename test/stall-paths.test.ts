// docs/stall-paths.md, src/waitpoints.ts and the source agree (J, 2026-11-11: "Let's solve this problem once and for all"):
// a gate that exists in the code with no entry fails here; so does an entry with no section in the docs, no deadline,
// no fallback, no test, or one that ends on the owner for a reason other than money, a permission or going live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WAIT_POINTS, deadlineOf } from '../src/waitpoints.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const docs = read('docs/stall-paths.md');
const srcFiles = fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.ts') && !['waits.ts', 'waitpoints.ts'].includes(f));
const src = new Map(srcFiles.map((f) => [`src/${f}`, read(`src/${f}`)]));
const HOUR = 3600_000;

test('every wait point has a deadline, a fallback, a place, a test and a section in docs/stall-paths.md', () => {
  const seen = new Set<string>();
  for (const p of WAIT_POINTS) {
    assert.ok(!seen.has(p.id), `${p.id} is listed twice`);
    seen.add(p.id);
    assert.ok(p.what && p.event && p.deadline && p.fallback, `${p.id}: what, event, deadline and fallback are all said`);
    assert.ok(Number.isFinite(p.maxMs) && p.maxMs > 0, `${p.id}: a finite deadline`);
    // A wait the table records is bounded at 12 h; the ones that keep their own deadline say theirs (a provider's reset can be days).
    assert.ok(p.maxMs <= (p.via === 'waits' ? 12 * HOUR : 7 * 24 * HOUR), `${p.id}: ${p.maxMs / HOUR} h is longer than its kind allows`);
    assert.ok(fs.existsSync(path.join(root, p.test)), `${p.id}: its test ${p.test} exists`);
    assert.ok(src.has(p.file), `${p.id}: ${p.file} exists`);
    for (const s of p.symbols) assert.ok(new RegExp(`\\b${s}\\b`).test(src.get(p.file)!), `${p.id}: ${s} is in ${p.file}`);
    // A point whose test is the shared file has its own test there, named by its id.
    if (p.test === 'test/wait-points.test.ts') assert.ok(read(p.test).includes(`test('[${p.id}]`), `${p.id}: test/wait-points.test.ts has no test('[${p.id}] ...')`);
    assert.ok(docs.includes(`### \`${p.id}\``), `${p.id}: has a section in docs/stall-paths.md (run the generator in the PR: node tools/stall-docs.mjs)`);
    const section = docs.slice(docs.indexOf(`### \`${p.id}\``)).split('\n### ')[0];
    assert.ok(section.includes(p.deadline) && section.includes(p.fallback), `${p.id}: the docs' deadline and fallback are the list's`);
  }
});

test('only money, a permission or going live end on the owner: every other wait ends in a lesser way', () => {
  for (const p of WAIT_POINTS) {
    if (p.fallbackKind === 'owner') assert.ok(['money', 'permission', 'go-live'].includes(p.ownerReason ?? ''), `${p.id} ends on the owner without money, a permission or going live`);
    else assert.equal(p.ownerReason, undefined, `${p.id} names an owner reason but its fallback doesn't end on the owner`);
    assert.doesNotMatch(p.fallback, /\bask(s|ed)? (J|the owner)\b|\bwaits? for (J|the owner)\b/i, `${p.id}'s fallback asks the owner`);
  }
});

test('the deadlines read from the environment are clamped to the point\'s maximum', () => {
  for (const p of WAIT_POINTS) {
    const saved = process.env[p.env];
    process.env[p.env] = String(p.maxMs * 10);
    assert.ok(deadlineOf(p.id) <= p.maxMs, `${p.id} can be set past its maximum`);
    process.env[p.env] = '1234';
    assert.equal(deadlineOf(p.id), Math.min(1234, p.maxMs));
    if (saved === undefined) delete process.env[p.env]; else process.env[p.env] = saved;
  }
});

// Gates this file's audit looked at and found are not waits of their own, each with why. A new function named like a gate
// (Gate, Hold, Turn, Slot, Wait, Waits) must be in an entry's symbols or here: the next agent decides which, in the PR.
const NOT_A_WAIT: Record<string, string> = {
  walkAwayHold: 'a merge held for a protected file or money past the caps: the owner\'s by design (a permission), not a wait that ran out',
  gpuWaits: 'tasks waiting for the owner\'s GPU budget: money, the owner\'s',
  planWait: 'a flag in the Inbox card text (a plan without cloud builds): money, the owner\'s',
  taskWaits: 'reads what a task waits on for display; it waits for nothing',
  waitingTurn: 'a map of staging-site builds queued behind the product\'s earlier build (previews.ts): each build\'s own steps are bounded (heavy-slot 40 min, git 10 min); no queue of its own to time out',
  qualityGate: 'a pure check of a playtest\'s measurements: answers at once',
  compileGate: 'a check that answers at once whether the compile check runs',
  duplicateHold: 'answers at once; the model\'s judgement runs apart and any failure releases the change (verdict false)',
  queueHold: 'see queue-park',
  firstWait: 'the first retry gap of a Gen submit (builds.ts), inside the 15 min the submit retries',
  maxHold: 'see heavy-slot',
  filedSlot: 'a broadcast schedule slot (On Air), not a gate',
  currentSlot: 'a broadcast schedule slot (On Air), not a gate',
  startTurn: 'see build-line', seenTurn: 'a Talk turn marker', studioTurn: 'a Talk turn marker', runTurn: 'a Talk chat turn: ends with the answer, nothing else waits on it', jTurn: 'a Talk turn marker',
  followTurn: 'a Talk turn marker', finishTurn: 'a Talk turn marker', lastTurn: 'a Talk turn marker', endTurn: 'a Talk chat turn ending', autoTurn: 'a Talk turn marker', runPmTurn: 'a PM chat turn in Talk: ends with the answer',
  betaTurn: 'see beta-queue', submitTurn: 'see gen-pace', jobStartTurn: 'see gen-pace', nudgeUnitySlot: 'see unity-slot',
  criticGate: 'the go-live critic comparison (beta vs live): answers at once from recorded scores',
  retryWaits: 'two short gaps (1 s, 4 s) between tries of a Google read: fixed, finite',
  diskWait: 'see disk-wait (agents.ts\'s one instance of diskWaits)',
  rerunGpuWaits: 'starts the Gen waits of tasks again when GPU budget is approved: an event handler, not a wait',
};

test('every function named like a gate is on a wait point or audited as not one', () => {
  const known = new Set<string>([...WAIT_POINTS.flatMap((p) => p.symbols), ...Object.keys(NOT_A_WAIT)]);
  const found = new Map<string, string>();
  for (const [file, text] of src) {
    for (const m of text.matchAll(/^\s*(?:export )?(?:async )?(?:function|const|let) ([A-Za-z0-9_]*(?:Gate|Hold|Turn|Slot|Waits?))\b/gm)) found.set(m[1], file);
  }
  const unlisted = [...found].filter(([name]) => !known.has(name)).map(([name, file]) => `${name} (${file})`);
  assert.deepEqual(unlisted, [], `a gate with no entry: add it to src/waitpoints.ts (and docs/stall-paths.md), or to NOT_A_WAIT here with why`);
  // And an audited name that no longer exists isn't kept around.
  const gone = [...Object.keys(NOT_A_WAIT)].filter((n) => !found.has(n));
  assert.deepEqual(gone, [], 'NOT_A_WAIT names that are not in the source any more');
});

test('every wait the table records is begun in its gate, has a fallback, and every begun id is a listed point', () => {
  const begun = new Map<string, string[]>();
  for (const [file, text] of src) {
    for (const m of text.matchAll(/\b(?:beginWait|raceDeadline)\(\s*'([a-z-]+)'/g)) begun.set(m[1], [...(begun.get(m[1]) ?? []), file]);
  }
  const ids = new Set(WAIT_POINTS.map((p) => p.id));
  for (const id of begun.keys()) assert.ok(ids.has(id), `beginWait('${id}') has no entry in src/waitpoints.ts`);
  for (const p of WAIT_POINTS.filter((x) => x.via === 'waits')) {
    assert.ok(begun.has(p.id), `${p.id} says it is recorded in the waits table but no gate begins it`);
    if (!p.inProcess) assert.ok([...src.values()].some((t) => new RegExp(`onDeadline\\(\\s*'${p.id}'`).test(t)) || [...src.values()].some((t) => /for \(const point of \[[^\]]*\]\) onDeadline\(point/.test(t) && t.includes(`'${p.id}'`)), `${p.id} has no fallback registered (onDeadline)`);
  }
});

test('the docs name the outcome sets and the durable start-up', () => {
  for (const w of ['buildOutcome', 'playOutcome', 'passState', 'rearmWaits', 'unread', 'milestone-critic', 'investigation-recheck']) assert.ok(docs.includes(w), `docs/stall-paths.md doesn't mention ${w}`);
});
