// The Inbox's gate, one card per cause, and the root-cause log (causes.ts; J, 2026-11-08: "how come the system doesn't
// resolve the issues on its own and have you been fixing the root cause"): transient causes are held and retried by
// Studio (only the last failure of the limit is filed, saying what was tried), J-only calls are filed, a recommendation is
// the PM's to give in walk-away mode, same-cause cards fold into one with a count, and a cause seen a second time within
// 7 days opens ONE Studio fix task shown as "Fixing the cause".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-causes-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.TALK_CLAUDE = 'no-such-claude-here';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  products: [{
    id: 'cgame', name: 'Cause game', framing: 'test', engine: 'static', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/',
    local: { serve: 'static', dir: 'site', port: 8797, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
  }],
  infra: [{ id: 'hawkesstudio', name: 'Hawkes Studio', repo: 'hawkesstudio', slug: 'jgriffith3433/hawkesstudio', about: 'Studio', checks: [] }],
}));

const { db } = await import('../src/db.ts');
await import('../src/agents.ts');
const rm = await import('../src/roadmap.ts');
const pm = await import('../src/pm.ts');
const ib = await import('../src/inbox.ts');
const C = await import('../src/causes.ts');
const T = await import('../src/transient.ts');

// Walk-away on (J's default), and nothing really resumes: the PM's answer is recorded instead.
fs.mkdirSync(process.env.STUDIO_DATA!, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'pm.json'), JSON.stringify({ walkAway: true }));
const answered: { q: string; a: string; by: string }[] = [];
C.hooks.answer = async (q, a, by) => {
  answered.push({ q, a, by });
  db.prepare(`UPDATE questions SET status = 'answered', answer = ?, answered_by = ?, answered_at = ? WHERE id = ?`).run(a, by, Date.now(), q);
};
const tick = () => new Promise((r) => setImmediate(r));
const reset = () => { db.exec('DELETE FROM cause_log; DELETE FROM cause_fixes; DELETE FROM held_retries'); db.exec(`UPDATE questions SET status = 'resolved'`); answered.length = 0; };

test('causes: every transient failure J saw on Nov 8 has its key; a permission is J-only; secrets never reach the log', () => {
  assert.equal(C.causeOf('stopped: Studio restarted 3 times in a row')?.key, 'studio-restart');
  assert.equal(C.causeOf('git fetch: remote: Bad credentials (401)')?.key, 'token-expired');
  assert.equal(C.causeOf('the agent was killed (SIGKILL), exit code 137')?.key, 'killed-run');
  assert.equal(C.causeOf('GitHub answered 503 Service Unavailable')?.key, 'server-error');
  assert.equal(C.causeOf('fetch failed: ECONNRESET')?.key, 'network');
  assert.equal(C.causeOf('HTTP 429 Too Many Requests')?.key, 'rate-limit');
  assert.equal(C.causeOf('RESOURCE_EXHAUSTED: quota exceeded for cpus')?.key, 'cloud-quota');
  assert.equal(C.causeOf("can't merge into beta: it still conflicts with beta")?.key, 'conflict');
  assert.equal(C.causeOf('Resource not accessible by integration', { permission: 'Actions: write', repo: 'o/r' })?.key, 'access:actions:write@o/r');
  assert.equal(C.causeOf('The palette is ugly'), null);
  for (const k of ['studio-restart', 'token-expired', 'killed-run', 'network', 'server-error', 'rate-limit', 'cloud-quota', 'conflict']) assert.equal(C.causeFromKey(k).cls, 'transient', k);
  assert.ok(C.jOnly({ text: 'Accept the Actions: write permission on the installation page?' }));
  assert.ok(C.jOnly({ text: 'Go live with Yooba Land?' }));
  assert.ok(C.jOnly({ text: 'Spend more?', options: ['Approve $40', 'Not now'], recommendation: 'Approve $40' }));
  assert.equal(C.jOnly({ text: 'It failed 3 times. Try again?', options: ['try again', 'drop it'] }), null);
  const red = C.redact('push failed: https://x-access-token:ghs_abcdefghijklmnop1234@github.com/o/r token=ghp_ABCDEFGHIJKLMNOP1234');
  assert.doesNotMatch(red, /ghs_|ghp_|abcdefghijklmnop/);
});

test('the gate: a transient cause is held and retried by Studio, never shown; the last failure of the limit is filed with what was tried', async () => {
  reset();
  const it = rm.addItem({ product: 'cgame', title: 'Shop', status: 'planned' });
  const t = rm.addTask({ item: it.id, request: 'Make the shop' });
  const ask = () => pm.askJ(`"Shop" (Cause game) failed 3 times. The last: stopped: Studio restarted 3 times in a row. Try another way, change the task, or drop it?`,
    { subject: t.id, product: 'cgame', options: ['try again', 'change it', 'drop it'], from: 'the default after 3 tries' });
  const shown = async () => (await ib.inbox()).filter((x) => x.subject === t.id);

  const ids: string[] = [];
  for (let n = 1; n <= C.RETRY_LIMIT; n++) {
    const q = ask();
    ids.push(q.id);
    assert.equal(q.status, 'held', `try ${n}: held, not asked`);
    const h = T.heldRetriesOf(q.id)[0];
    assert.ok(h && h.state === 'waiting' && h.attempt === n, `try ${n}: a retry waits (a row, so a restart carries it on)`);
    assert.ok(Math.abs(h.due - Date.now() - C.RETRY_WAITS_MS[n - 1]) < 5000, 'the backoff grows');
    assert.equal((await shown()).length, 0, 'no card');
    // The wait ends: Studio answers its own "try again".
    assert.equal(await T.fireHeld(h.id), true);
    assert.deepEqual(answered.at(-1), { q: q.id, a: 'try again', by: `${C.SELF_BY}, retry ${n}` });
  }
  assert.equal(C.causeLog('studio-restart').filter((r) => r.kind === 'retried').length, C.RETRY_LIMIT);

  // The limit's last failure: filed, saying what was already tried.
  const last = ask();
  assert.equal(last.status, 'asked J');
  const card = (await shown())[0];
  assert.equal(card.id, last.id);
  assert.equal(card.cause, 'studio-restart');
  assert.match(card.context ?? '', /Already tried: Studio answered "try again" by itself 3 times/);
});

test('the gate: J-only calls are filed even with a transient cause; a recommendation that spends nothing is the PM\'s', async () => {
  reset();
  const perm = pm.askJ('The build fails with 503 until Studio\'s app has the Actions: write permission. Accept it on the installation page, then try again?', { product: 'cgame', options: ['try again'], recommend: 'try again', from: 'builds' });
  assert.equal(perm.status, 'asked J', 'a permission grant is J\'s');
  const money = pm.askJ('Raise the GPU budget so the art can render again?', { product: 'cgame', options: ['Approve $12', 'Not now'], recommend: 'Approve $12', from: 'gpu reruns' });
  assert.equal(money.status, 'asked J', 'money is J\'s');

  const rec = pm.askJ('"Intro" was stopped by the AI harness 3 times in an hour. Resume it, or leave it?', { subject: 'c_aaaaaaaaaaab', product: 'cgame', options: ['resume it', 'leave it'], recommend: 'leave it', from: 'harness-resume cap' });
  assert.equal(rec.status, 'held');
  await tick();
  assert.deepEqual(answered.at(-1), { q: rec.id, a: 'leave it', by: C.SELF_BY });
  assert.ok(rm.listDecisions({ action: 'self-answer', limit: 5 }).some((d) => d.detail?.includes(rec.id)), 'logged in the PM log');

  // Talk's own question (or J's) is never answered for him.
  const talk = pm.askJ('Coins or gems for the shop?', { product: 'cgame', options: ['Coins', 'Gems'], recommend: 'Coins', from: 'Talk (PM)' });
  assert.equal(talk.status, 'asked J');

  // Walk-away off: the recommendation waits for J.
  fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'pm.json'), JSON.stringify({ walkAway: false }));
  const off = pm.askJ('"Outro" was stopped by the AI harness 3 times in an hour. Resume it, or leave it?', { subject: 'c_aaaaaaaaaaac', product: 'cgame', options: ['resume it', 'leave it'], recommend: 'leave it', from: 'harness-resume cap' });
  assert.equal(off.status, 'asked J');
  fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'pm.json'), JSON.stringify({ walkAway: true }));
});

test('one card per cause: same-cause questions fold into one card with a count, and its answer reaches each', async () => {
  reset();
  // Retries used up for both subjects, so they are filed (and fold).
  const subjects = ['c_bbbbbbbbbbb1', 'c_bbbbbbbbbbb2', 'c_bbbbbbbbbbb3'];
  for (const s of subjects) for (let i = 0; i < C.RETRY_LIMIT; i++) C.logCause(C.causeFromKey('conflict'), { product: 'cgame', kind: 'retried', subject: s, ref: `${s}-${i}`, dedup: `t:${s}:${i}` });
  const qs = subjects.map((s, i) => pm.askJ(`"Change ${i}" can't merge into beta: its agent tried 3 times and it still conflicts with beta. Try again, or close it?`, { subject: s, product: 'cgame', options: ['try again', 'close it'], recommend: 'try again', from: 'conflict passes used up' }));
  for (const q of qs) assert.equal(q.status, 'asked J');
  const cards = (await ib.inbox()).filter((x) => x.cause === 'conflict');
  assert.equal(cards.length, 1, 'one card for the cause');
  assert.equal(cards[0].count, 3);
  assert.equal(cards[0].merged!.length, 2);
  assert.match(cards[0].title, /and 2 more with the same cause/);

  const r: any = await ib.answerInbox(cards[0].id, 'close it', 'J');
  assert.equal(r.alsoAnswered.length, 2);
  for (const q of qs) assert.equal(rm.getQuestion(q.id)!.status, 'answered', `${q.id} answered`);
  assert.equal((await ib.inbox()).filter((x) => x.cause === 'conflict').length, 0);
});

test('the root-cause log: a cause\'s second occurrence in 7 days opens ONE Studio fix task with the evidence, linked from its cards', async () => {
  reset();
  const opened: string[] = [];
  const real = C.hooks.openFix;
  C.hooks.openFix = (cause, rows) => { opened.push(cause.key); return real(cause, rows); };
  try {
    const tok = C.causeFromKey('token-expired');
    C.logCause(tok, { product: 'cgame', kind: 'rebuilt', ref: 'b_0001', subject: 'cgame/web', detail: 'git fetch: Bad credentials token=ghs_abcdefghijklmnopqrst', dedup: 'x1' });
    assert.equal(C.openFix('token-expired'), null, 'once is not a pattern');
    C.logCause(tok, { product: 'cgame', kind: 'rebuilt', ref: 'b_0001', subject: 'cgame/web', detail: 'again', dedup: 'x2' });
    assert.equal(C.openFix('token-expired'), null, 'the same subject again is its retries, not a second occurrence');
    C.logCause(tok, { product: 'cgame', kind: 'card', ref: 'q_0002', subject: 'k_other', detail: 'Bad credentials while pushing', dedup: 'x3' });
    const fix = C.openFix('token-expired');
    assert.ok(fix, 'the second cause opens a fix task');
    const task = rm.getTask(fix!.task)!;
    assert.equal(task.product, 'hawkesstudio');
    assert.match(task.request, /token-expired/);
    assert.match(task.request, /b_0001/);
    assert.match(task.request, /q_0002/);
    assert.doesNotMatch(task.request, /ghs_/, 'no secret in the evidence');
    assert.equal(rm.getItem(task.item)!.product, 'hawkesstudio');

    C.logCause(tok, { product: 'cgame', kind: 'card', ref: 'q_0003', subject: 'k_third', detail: 'once more', dedup: 'x4' });
    assert.deepEqual(opened, ['token-expired'], 'one fix task while it is open');

    // Its cards say so, and the Inbox page shows it under "Fixing the cause".
    const it = rm.addItem({ product: 'cgame', title: 'Push', status: 'planned' });
    const t = rm.addTask({ item: it.id, request: 'Push it' });
    for (let i = 0; i < C.RETRY_LIMIT; i++) C.logCause(tok, { product: 'cgame', kind: 'retried', subject: t.id, ref: `r${i}`, dedup: `tr:${i}` });
    pm.askJ('"Push" failed 3 times. The last: Bad credentials from GitHub. Try again, or drop it?', { subject: t.id, product: 'cgame', options: ['try again', 'drop it'], from: 'the default after 3 tries' });
    const card = (await ib.inbox()).find((x) => x.subject === t.id)!;
    assert.equal(card.cause, 'token-expired');
    assert.equal(card.fixing?.task, fix!.task);
    const h = ib.selfHealing();
    assert.equal(h.fixing[0].cause, 'token-expired');
    assert.ok(h.fixing[0].seen >= 4);
    assert.ok((h.settled.rebuilt ?? 0) >= 2 && (h.settled.retried ?? 0) >= 3);

    // Once dropped, it isn't open any more; access causes (J's grants) never open one.
    rm.updateTask(fix!.task, { status: 'dropped' });
    assert.equal(C.openFix('token-expired'), null);
    const acc = C.causeFromKey('access:actions:write@o/r', 'j-only');
    C.logCause(acc, { product: 'cgame', kind: 'card', ref: 'a1', subject: 'x', dedup: 'a1' });
    C.logCause(acc, { product: 'cgame', kind: 'card', ref: 'a2', subject: 'y', dedup: 'a2' });
    assert.equal(C.openFix('access:actions:write@o/r'), null);
  } finally {
    C.hooks.openFix = real;
  }
});

test('a card whose cause has cleared closes by itself, with a line saying how; one that is still failing stays', async () => {
  reset();
  const real = C.probes.cleared;
  const ids = (n: string) => pm.askJ(`"${n}" failed 3 times. The last: fetch failed: ECONNRESET. Try again, or drop it?`, { subject: n, product: 'cgame', options: ['try again', 'drop it'], from: 'someone' });
  try {
    // Filed directly (as after the retry limit): asked J, with a cause.
    const q = ids('c_cccccccccccc');
    db.prepare(`UPDATE questions SET status = 'asked J', cause = 'network', at = ? WHERE id = ?`).run(Date.now() - 3_600_000, q.id);
    C.probes.cleared = async () => null;
    assert.equal((await ib.inbox()).filter((x) => x.id === q.id).length, 1, 'still failing: the card stays');
    C.probes.cleared = async () => 'Hawkes Gen answers again';
    const before = answered.length;
    const cards = await ib.inbox();
    assert.equal(cards.filter((x) => x.id === q.id).length, 0, 'cleared: gone');
    assert.deepEqual(answered.at(before), { q: q.id, a: 'try again', by: `${C.SELF_BY}, cause cleared` });
    assert.ok(C.causeLog('network').some((r) => r.ref === q.id && /closed, Hawkes Gen answers again/.test(r.detail ?? '')));
    // A J-only card never closes by itself.
    const perm = pm.askJ('Accept the Actions: write permission on the installation page after a 503?', { product: 'cgame', options: ['try again'], from: 'builds' });
    await ib.inbox();
    assert.equal(rm.getQuestion(perm.id)!.status, 'asked J');
  } finally {
    C.probes.cleared = real;
  }
});

// ------------------------------------------------------------------ a blocked agent is diagnosed before J is asked

const okIO = (over: Partial<import('../src/diagnose.ts').IO> = {}): import('../src/diagnose.ts').IO => ({
  signed: async (a) => `https://gen.test/v1/files/${a}?exp=9&sig=fresh`,
  status: async () => 200,
  asset: async () => ({ project: 'cgame' }),
  lockedJob: async () => null,
  project: async () => 200,
  full: (p) => `org_ab12.${p}`,
  key: async () => 200,
  health: async () => true,
  ...over,
});

/** An agent question nobody answered, as the PM's defaults pass finds it; returns its row and the Inbox card, if any. */
async function blockedAgent(text: string, io: import('../src/diagnose.ts').IO) {
  reset();
  pm.diagnoseIO.get = async () => io;
  const q = rm.addQuestion({ kind: 'agent', subject: 'c_dddddddddddd', product: 'cgame', text });
  answered.length = 0;
  await pm.defaultsForTest(['c_dddddddddddd']);
  const cards = (await ib.inbox()).filter((x) => x.subject === 'c_dddddddddddd' || x.id === q.id || x.subject?.startsWith('k_') || x.product === 'cgame');
  const card = cards.find((x) => /Studio checked first/.test(x.context ?? '')) ?? cards[0];
  return { q, row: rm.getQuestion(q.id)!, card };
}

test('blocked agent: an expired Gen link gets fresh links, checked; the agent resumes with them and no card is filed', async () => {
  const text = 'I cannot load https://hawkesgen.ai/v1/files/a_0123456789ab?exp=1&sig=old: it answers 403 (the link expired). Which link should I use?';
  const ok = await blockedAgent(text, okIO());
  assert.equal(ok.row.status, 'answered');
  assert.equal(ok.row.answered_by, C.SELF_BY);
  assert.match(ok.row.answer ?? '', /fresh signed links/);
  assert.match(ok.row.answer ?? '', /a_0123456789ab\?exp=9&sig=fresh/);
  assert.equal(ok.card, undefined, 'no card');
  assert.ok(C.causeLog('gen-link').some((r) => r.ref === ok.q.id && r.kind === 'answered'));

  // The fresh link still doesn't open: a card, saying what was tried.
  const bad = await blockedAgent(text, okIO({ status: async () => 403 }));
  assert.equal(bad.row.status, 'asked J');
  assert.match(bad.card?.context ?? '', /Studio checked first: made fresh signed links.*still don't open.*did not clear it/);
});

test('blocked agent: "No Gen file" runs asset sync; found again resumes the agent, still missing files the card', async () => {
  const text = 'studio_gen_import failed: No Gen file a_00ff00ff00ff this studio may use. What now?';
  const synced = await blockedAgent(text, okIO({
    asset: async (id) => (id === 'a_00ff00ff00ff' ? null : { project: 'cgame' }),
    lockedJob: async () => ({ product: 'cgame', asset: 'hero', job: 'j_1', outputs: ['a_11aa11aa11aa'] }),
  }));
  assert.equal(synced.row.status, 'answered');
  assert.match(synced.row.answer ?? '', /after asset sync/);
  assert.match(synced.row.answer ?? '', /ran asset sync for a_00ff00ff00ff: the lock of cgame says job j_1/);

  const gone = await blockedAgent(text, okIO({ asset: async () => null }));
  assert.equal(gone.row.status, 'asked J');
  assert.match(gone.card?.context ?? '', /ran asset sync.*no product lock lists it.*Gen has no file for a_00ff00ff00ff/);
});

test('blocked agent: "No access to project" checks the full org project id; accepted resumes, refused files the card', async () => {
  const text = 'Gen answered 403: No access to project yooba. Should I use another project?';
  const seen: string[] = [];
  const ok = await blockedAgent(text, okIO({ project: async (full) => { seen.push(full); return 200; } }));
  assert.deepEqual(seen, ['org_ab12.yooba'], 'asked under the full org id');
  assert.equal(ok.row.status, 'answered');
  assert.match(ok.row.answer ?? '', /full id \(org_ab12\.yooba\)/);

  const no = await blockedAgent(text, okIO({ project: async () => 403 }));
  assert.equal(no.row.status, 'asked J');
  assert.match(no.card?.context ?? '', /full org id "org_ab12\.yooba".*answered 403 for org_ab12\.yooba/);
});

test('blocked agent: a Gen 401 checks Studio\'s key and Gen; key accepted resumes, key refused or Gen down files the card', async () => {
  const text = 'Hawkes Gen returned 401 Unauthorized for my asset call. Can you check the key?';
  const ok = await blockedAgent(text, okIO());
  assert.equal(ok.row.status, 'answered');
  assert.match(ok.row.answer ?? '', /accepts Studio's key/);

  const refused = await blockedAgent(text, okIO({ key: async () => 401 }));
  assert.equal(refused.row.status, 'asked J');
  assert.match(refused.card?.context ?? '', /Gen answered 401 to Studio's key/);

  const down = await blockedAgent(text, okIO({ health: async () => false }));
  assert.equal(down.row.status, 'asked J');
  assert.match(down.card?.context ?? '', /Hawkes Gen doesn't answer/);
});

test('blocked agent: a question that is not a Gen problem goes to J untouched', async () => {
  const r = await blockedAgent('Should the shop sell coins or gems?', okIO());
  assert.equal(r.row.status, 'asked J');
  assert.doesNotMatch(r.card?.context ?? '', /Studio checked first/);
});
