// The harness hold (J, 2026-10-20: "every time I hit usage limits the agents all get canceled out and I lose work and
// they never start again ... It should just recover itself"): which harness wordings stop work and when they reset, a
// pass the harness ended is parked (not a try), the hold blocks starts and lifts after a probe that answers, the other
// harness stands in, and the sweep plans again the tasks whose tries were harness stops. Scratch database, stand-ins
// for the probes; the agent flow itself (a parked change resumes its session) is test/harness-park.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-hold-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_TASK_BAR = 'off'; // these tests start tasks written in a line (the task bar has its own: taskbar.test.ts)
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_PM_TALK = 'off';
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9';
// A minute is a millisecond here: backoffs and reset times pass at once.
process.env.STUDIO_HARNESS_MINUTE_MS = '1';
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE', 'NTFY_TOPIC', 'HAWKES_BRAIN', 'TALK_CLAUDE', 'TALK_CLAUDE_ARGS', 'STUDIO_HARNESS_FAILOVER']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'notify.json'), JSON.stringify({ enabled: false, topic: 'test' }));
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: { hh: 'x/hh' },
  products: [{
    id: 'hh', name: 'hh', framing: 'test', engine: 'static', repo: 'hh', site: 'hh', live: 'http://127.0.0.1:9/',
    local: { serve: 'static', dir: 'hh', port: 8797, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
  }],
  infra: [],
}));

const brains = await import('../src/brains.ts');
const hold = await import('../src/harness-hold.ts');
const agents = await import('../src/agents.ts');
const pm = await import('../src/pm.ts');
const rm = await import('../src/roadmap.ts');
const { aiHarnessOf, aiStop, startStep, waitForAi } = await import('../src/pipeline.ts');
const { db, J } = await import('../src/db.ts');

// Nothing reaches Talk, the phone or Gen; what was said is kept.
const said: { talk: string[]; phone: string[] } = { talk: [], phone: [] };
let probes: Record<string, { ok: boolean; note: string }> = {};
const probed: string[] = [];
Object.assign(hold.holdDeps, {
  probe: async (h: string) => (probed.push(h), probes[h] ?? { ok: false, note: 'no answer' }),
  configured: () => true,
  otherAccounts: async () => [],
  activeAccount: async () => null,
  syncGen: async () => {},
  talk: async (title: string) => void said.talk.push(title),
  phone: async (title: string) => void said.phone.push(title),
});
const clear = () => {
  db.prepare('DELETE FROM harness_holds').run();
  brains.setFailover(null);
  probes = {};
  probed.length = 0;
  said.talk.length = 0;
  said.phone.length = 0;
};
const tick = () => new Promise((r) => setTimeout(r, 5));

const NOW = Date.UTC(2026, 9, 20, 7, 0);

test('every wording seen on 2026-10-19/20 is a harness stop of the right kind, with its reset time', () => {
  const k = (s: string) => brains.harnessStopOf(s, { now: NOW });
  assert.equal(k("You've hit your limit · resets 8:40am (UTC)")?.kind, 'usage');
  assert.equal(k("You've hit your limit · resets 8:40am (UTC)")?.resetsAt, Date.UTC(2026, 9, 20, 8, 40));
  assert.equal(k("You've hit your session limit · resets 1:40pm (UTC)")?.resetsAt, Date.UTC(2026, 9, 20, 13, 40));
  const weekly = k("You've hit your weekly limit · resets Oct 23, 1pm (UTC)")!;
  assert.equal(weekly.kind, 'usage');
  assert.equal(weekly.resetsAt, Date.UTC(2026, 9, 23, 13, 0));
  // Already past today: the next day.
  assert.equal(k("You've hit your limit · resets 6:00am (UTC)")?.resetsAt, Date.UTC(2026, 9, 21, 6, 0));
  assert.equal(k('ActionRequiredError: You have an unpaid invoice Pay your unpaid invoice at [cursor.com/dashboard/billing](https://cursor.com/dashboard/billing) to resume requests.')?.kind, 'billing');
  assert.equal(k("You're out of usage. Switch to Auto, or ask your admin to raise your limit")?.kind, 'usage');
  assert.equal(k("ActionRequiredError: You've hit your usage limit You've saved $1229 on API model usage this month with Pro+. Switch to a different model")?.kind, 'billing', 'ActionRequiredError is Cursor asking J to act');
  assert.equal(k('Limit to continue with Auto. Your usage limits will reset when your monthly cycle ends')?.kind, 'usage');
  assert.equal(k('Credit balance is too low to access the Anthropic API')?.kind, 'billing');
  assert.equal(k("Error: Authentication required. Please run 'agent login' or set CURSOR_API_KEY")?.kind, 'auth');
  assert.equal(k('Invalid API key · Please run /login')?.kind, 'auth');
  assert.equal(k('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')?.kind, 'transient');
  assert.equal(k('API Error: 429 rate_limit_error')?.kind, 'transient');
  // An agent's own words about a game are not one.
  assert.equal(brains.harnessBlocked('The bridge cutscene is already on beta and the boss scenario covers it.'), false);
  assert.equal(k('Added a login screen and a rate limit on the score endpoint.'), null);
});

test('a pass the harness ended is told apart from an agent that finished', () => {
  // Cursor: no result, the invoice only on stderr.
  assert.equal(agents.passStop({ ok: false, sawResult: false, result: '', stderr: 'ActionRequiredError: You have an unpaid invoice Pay your unpaid invoice at cursor.com/dashboard/billing to resume requests.\n' })?.kind, 'billing');
  // Claude: the limit as the (error) result.
  assert.equal(agents.passStop({ ok: false, sawResult: true, result: "You've hit your session limit · resets 1:40pm (UTC)" })?.kind, 'usage');
  // Claude's limit as a short "successful" result is still the harness.
  assert.equal(agents.passStop({ ok: true, sawResult: true, result: "You've hit your limit · resets 8:40am (UTC)" })?.kind, 'usage');
  // A finished agent whose summary talks about errors in the game is not.
  const long = 'Fixed the shop. '.repeat(30) + 'The fetch failed on the old endpoint, and an Internal server error showed on 500s.';
  assert.equal(agents.passStop({ ok: true, sawResult: true, result: long, stderr: 'warning: something on stderr\n' }), null);
  assert.equal(agents.passStop({ ok: true, sawResult: true, result: 'done' }, 'Already done: the bridge cutscene is on beta.'), null);
  const analysis = `Nothing was committed.\n${'The scout looked at the failing runs and found the tasks all stopped early. '.repeat(8)}\n- The scout's diagnosis ("weekly limit reached") is a usage cap, not a game problem. Nothing to fix in the project for it.`;
  assert.equal(agents.passStop({ ok: false, sawResult: true, result: '' }, analysis), null);
  assert.equal(agents.passStop({ ok: false, sawResult: true, result: '' }, "You've hit your limit · resets 8:40am (UTC)")?.kind, 'usage');
  // A review that failed on Cursor's invoice waits for the AI (pipeline.ts), one that failed on the playtest doesn't.
  assert.equal(aiStop('not JSON (Claude Code fallback, Gen: Cursor: ActionRequiredError: You have an unpaid invoice Pay your unpaid invoice at [cursor.com/dashboard/billing](h')?.kind, 'billing');
  assert.equal(aiStop('the playtest job is gone'), null);
});

test('a hold blocks starts, is extended while the probe fails, and lifts when it answers', async () => {
  clear();
  brains.saveBrain('claude');
  let resumed = 0;
  hold.onHoldLifted(() => resumed++);
  const stop = brains.harnessStopOf("You've hit your session limit · resets 1:40pm (UTC)")!;
  const { hold: h, fresh } = hold.holdHarness({ ...stop, resetsAt: null }, { source: 'agent change c_1' });
  assert.equal(fresh, true);
  assert.equal(h.harness, 'claude');
  assert.equal(hold.harnessHeld(), true);
  assert.match(hold.holdDetail(h), /^waiting for Claude usage: tries again at \d\d:\d\d UTC/);
  // The same stop again keeps the one hold.
  assert.equal(hold.holdHarness({ ...stop, resetsAt: null }, { source: 'agent change c_2' }).fresh, false);
  // The PM starts nothing while it is on (startWork's first check, before any query).
  process.env.GITHUB_TOKEN = 'test';
  assert.deepEqual(await pm.startWork(), []);
  // A usage stop is a Talk line, never the phone.
  await tick();
  assert.deepEqual(said.phone, []);
  assert.ok(said.talk.some((t) => /Agents paused: Claude usage ran out/.test(t)));
  await new Promise((r) => setTimeout(r, 30));
  probes = { claude: { ok: false, note: "You've hit your session limit" }, cursor: { ok: false, note: 'ActionRequiredError: You have an unpaid invoice' } };
  await hold.reviewHolds();
  const extended = hold.activeHold('claude')!;
  assert.ok(extended, 'still held');
  assert.ok(extended.attempts >= 1, 'each failed probe counts (a look started by a hold may have probed too)');
  assert.equal(brains.brainId(), 'claude', 'no stand-in: Cursor answered with its invoice');
  assert.ok(hold.activeHold('cursor'), 'the stand-in that failed is held too');
  assert.deepEqual(said.phone, [], 'quietly: Cursor is not the harness in use nor the one J chose');
  probes.claude = { ok: true, note: 'answering' };
  await new Promise((r) => setTimeout(r, Math.max(0, hold.activeHold('claude')!.until - Date.now()) + 10));
  await hold.reviewHolds();
  assert.equal(hold.harnessHeld('claude'), false, 'lifted');
  assert.ok(resumed >= 1, 'the queue was told');
  assert.ok(said.talk.some((t) => /Agents resumed: Claude answers again/.test(t)));
  delete process.env.GITHUB_TOKEN;
});

test('billing on the harness J chose: his phone hears once, and the other harness stands in until it answers', async () => {
  clear();
  brains.saveBrain({ harness: 'cursor', model: 'auto' });
  probes = { claude: { ok: true, note: 'answering' } };
  const stop = brains.harnessStopOf('ActionRequiredError: You have an unpaid invoice Pay your unpaid invoice at cursor.com/dashboard/billing to resume requests.')!;
  hold.holdHarness(stop, { source: 'agent change c_3' });
  hold.holdHarness(stop, { source: 'agent change c_4' });
  await hold.reviewHolds();
  assert.equal(said.phone.length, 1, 'J pays the invoice: once per hold');
  const s = brains.brainSettings();
  assert.equal(s.harness, 'claude', 'Claude Code stands in');
  assert.equal(s.chosen, 'cursor', "J's choice stays saved");
  assert.equal(s.model, '', "the stand-in runs each role's own model, not Cursor's");
  assert.equal(hold.harnessHeld(), false, 'the harness in use is not held: work goes on');
  assert.ok(hold.harnessHeld('cursor'));
  assert.equal(hold.holdStatus()?.standIn?.harness, 'claude');
  // Cursor answers again: back to J's choice.
  await new Promise((r) => setTimeout(r, 40));
  hold.activeHold('cursor') && db.prepare('UPDATE harness_holds SET until = ? WHERE harness = ?').run(Date.now() - 1, 'cursor');
  probes.cursor = { ok: true, note: 'answering' };
  await hold.reviewHolds();
  assert.equal(hold.harnessHeld('cursor'), false);
  assert.equal(brains.brainId(), 'cursor', 'back on Cursor');
  assert.equal(brains.failover(), null);
  // A harness J picks on purpose ends any stand-in.
  brains.setFailover({ harness: 'claude', from: 'cursor', since: Date.now(), why: 'test' });
  brains.saveBrain('cursor');
  assert.equal(brains.failover(), null);
  brains.saveBrain('claude');
});

test('the sweep plans again a task whose tries were harness stops, closes its question, and leaves real failures alone', async () => {
  clear();
  const it = rm.addItem({ product: 'hh', title: 'World polish', status: 'planned' });
  const stopped = rm.addTask({ item: it.id, request: 'Lighting and sky' });
  const real = rm.addTask({ item: it.id, request: 'The castle' });
  const add = (id: string, task: string, detail: string, log: string[]) => db.prepare(`INSERT INTO changes (id, product, findings, status, detail, repo, slug, branch, base, worktree, title, notes, log, created, updated, task)
    VALUES (?, 'hh', '[]', 'failed', ?, 'hh', 'x/hh', 'task/x', 'beta', ?, 't', '[]', ?, ?, ?, ?)`).run(id, detail, path.join(tmp, 'none'), J(log), Date.now(), Date.now(), task);
  const invoice = ['15:27:10 agent started', '15:27:14 stderr: ActionRequiredError: You have an unpaid invoice Pay your unpaid invoice at cursor.com/dashboard/billing to resume requests.\n'];
  add('c_aa0000000001', stopped.id, 'the agent made no commit', invoice);
  add('c_aa0000000002', stopped.id, 'the agent made no commit', ['08:59:43 agent: You\'ve hit your session limit · resets 1:40pm (UTC)']);
  add('c_aa0000000003', stopped.id, 'the agent made no commit', invoice);
  rm.setTask(stopped.id, { status: 'failed', tries: 3, changes: ['c_aa0000000001', 'c_aa0000000002', 'c_aa0000000003'], change: 'c_aa0000000003' });
  const q = rm.addQuestion({ kind: 'decision', subject: stopped.id, product: 'hh', text: '"Lighting and sky" failed 3 times. Try again?', options: ['try again', 'drop it'] });
  rm.setQuestion(q.id, { status: 'asked J' });
  add('c_aa0000000004', real.id, 'the agent made no commit', ['10:00:00 agent: I could not find the castle prefab, so I stopped.']);
  rm.setTask(real.id, { status: 'failed', tries: 3, changes: ['c_aa0000000004'], change: 'c_aa0000000004' });

  assert.equal(pm.harnessFailed(agents.getChange('c_aa0000000001')!), true, 'old rows count by their log text');
  assert.equal(pm.harnessFailed(agents.getChange('c_aa0000000004')!), false);
  const done = await pm.repairHarnessFailures();
  assert.deepEqual(done, [stopped.id]);
  const t = rm.getTask(stopped.id)!;
  assert.equal(t.status, 'planned');
  assert.equal(t.tries, 0);
  assert.equal(rm.getQuestion(q.id)!.status, 'answered', 'its "failed 3 times" card leaves the Inbox');
  assert.equal(rm.getTask(real.id)!.status, 'failed', 'a real failure stays for the PM and J');
  assert.equal(rm.listDecisions({ action: 'harness-repair' }).some((d) => d.subject === stopped.id), true);
  assert.deepEqual(await pm.repairHarnessFailures(), [], 'once');
});

test('waitForAi holds the harness named in the review error instead of the active brainId', () => {
  clear();
  brains.saveBrain('antigravity');
  assert.equal(brains.brainId(), 'antigravity');
  assert.equal(aiHarnessOf("Claude Code: You've hit your session limit · resets 1:40pm (UTC)"), 'claude');
  assert.equal(aiHarnessOf("Claude (Max plan): You've hit your session limit · resets 1:40pm (UTC)"), 'claude');
  assert.equal(aiHarnessOf('not JSON (Claude Code fallback, Gen: Cursor: ActionRequiredError: You have an unpaid invoice)'), 'cursor');
  assert.equal(aiHarnessOf('Copilot: You have no premium requests remaining'), 'copilot');
  assert.equal(aiHarnessOf('AGY_ERROR: authentication failed or timed out'), 'antigravity');
  assert.equal(aiHarnessOf('Antigravity: authentication failed or timed out'), 'antigravity');
  assert.equal(aiHarnessOf('Gemini: RESOURCE_EXHAUSTED: You have exhausted your capacity'), 'gemini');
  assert.equal(aiHarnessOf("You've hit your limit · resets 8:40am (UTC)"), 'antigravity', 'falls back to brainId() when no harness is named');

  const rs = startStep('r_test', 'hh', 'review', 'smoke', 'Claude is watching');
  const pending: any = { job: 'j_1', params: {}, criteria: null, mode: 'full', reviewKey: 'k', sha: null, barMet: false, barWhy: null, at: Date.now(), tries: 0 };
  const rev = { id: 'j_rev', status: 'failed', error: "Claude Code: You've hit your session limit · resets 1:40pm (UTC) (Claude Code fallback, Gen: credit balance is too low)" };
  assert.equal(waitForAi(rs, rev, pending, 'hh smoke'), true);
  assert.equal(hold.harnessHeld('antigravity'), false, 'active antigravity brain is not falsely held');
  assert.equal(hold.harnessHeld('claude'), true, 'claude is held instead');
  brains.saveBrain('claude');
});

test('an agent message about a third-party (ElevenLabs) billing error is not a harness stop', async () => {
  const brains = await import('../src/brains.ts');
  const msg = 'Stopped: ElevenLabs returned 401 payment_issue (billing) for audio.voice, so the 46 lines have no recording.';
  assert.equal(brains.harnessStopOf(msg, { kinds: ['usage', 'billing', 'auth'] }), null);
  assert.equal(brains.harnessStopOf('Error: 402 payment required from the Gen tool'), null);
  assert.equal(brains.harnessStopOf('Hello\nCredit balance is too low')?.kind, 'billing');
});

test('a change parked by the harness waits out the gap and stops at the cap', async () => {
  const { resumeGate, RESUME_GAP, RESUME_CAP } = await import('../src/agents.ts');
  const now = 10_000_000;
  assert.deepEqual(resumeGate(undefined, now), { go: true });
  const soon = resumeGate({ at: now - 15_000 }, now);
  assert.equal(soon.go, false);
  assert.ok(!soon.go && soon.waitMs > 0 && soon.waitMs <= RESUME_GAP && !soon.capped);
  assert.deepEqual(resumeGate({ at: now - RESUME_GAP - 1 }, now), { go: true });
  const parks = Array.from({ length: RESUME_CAP }, (_, i) => now - RESUME_GAP * (i + 2));
  const capped = resumeGate({ at: parks[0], parks }, now);
  assert.ok(!capped.go && capped.capped);
  // parks older than an hour don't count
  assert.deepEqual(resumeGate({ at: now - RESUME_GAP - 1, parks: [now - 2 * 3600_000, now - 3 * 3600_000, now - RESUME_GAP - 1] }, now), { go: true });
});

test("Google Cloud's CPU quota on an agent job is never the AI provider's usage limit", async () => {
  // 2026-11-10: a job that couldn't start for us-east4's CPU quota held Claude for ~19 hours ("Claude usage ran out").
  const jobLine = '[studio] the Cloud Run job failed: the Cloud Run job didn\'t start: Google Cloud answered 429 for https://run.googleapis.com/v2/projects/hawkes-staging/locations/us-east4/jobs/studio-cell-agent:run: Quota exceeded for total allowable CPU per project per region. (exit code none); it printed nothing';
  assert.equal(brains.harnessStopOf(jobLine), null);
  assert.equal(brains.harnessStopOf('RESOURCE_EXHAUSTED: project exceeded its quota limit for run.googleapis.com/cpu_allocation'), null);
  assert.equal(agents.passStop({ ok: false, sawResult: false, result: '', stderr: `${jobLine}\n` }), null);
  assert.ok(agents.machineryFailure(`${jobLine}\n`), "it is Studio's machinery failing instead");
  // The provider's own limit inside the job's output still holds it.
  assert.equal(agents.passStop({ ok: false, sawResult: false, result: '', stderr: `${jobLine}\nClaude AI usage limit reached|1794330000\n` })?.kind, 'usage');
  // Gemini's own quota wording is still its usage.
  assert.equal(brains.harnessStopOf('RESOURCE_EXHAUSTED: You have exhausted your capacity on this model. Your quota will reset after 2h3m')?.kind, 'usage');
});

test('a hold made from a line that turns out not to be the provider lifts at the next look, and the stand-in ends', async () => {
  clear();
  brains.saveBrain('claude');
  // A hold saved by an older Studio from Google Cloud's quota line, with Cursor standing in.
  const line = '[studio] the Cloud Run job failed: the Cloud Run job didn\'t start: Google Cloud answered 429: Quota exceeded for total allowable CPU per project per region.';
  db.prepare(`INSERT INTO harness_holds (harness, kind, why, line, since, until, attempts, reset, log) VALUES ('claude', 'usage', 'Claude usage ran out', ?, ?, ?, 6, 0, '[]')`)
    .run(line, Date.now() - 19 * 3600_000, Date.now() + 3600_000);
  brains.setFailover({ harness: 'cursor', from: 'claude', since: Date.now() - 19 * 3600_000, why: 'Claude usage ran out' });
  assert.equal(brains.brainId(), 'cursor');
  await hold.reviewHolds();
  assert.equal(hold.harnessHeld('claude'), false, 'lifted without waiting for its time');
  assert.equal(brains.brainId(), 'claude', 'back on Claude');
  assert.deepEqual(probed, [], 'no probe needed');
  assert.match(hold.getHold('claude')!.log.at(-1)!, /lifted: it wasn't Claude/);
});

test('a usage stop with no reset time is looked at again within minutes', () => {
  const now = Date.now();
  const first = hold.untilFor({ kind: 'usage', resetsAt: null }, 0, now) - now;
  const later = hold.untilFor({ kind: 'usage', resetsAt: null }, 9, now) - now;
  assert.equal(first, 5 * Number(process.env.STUDIO_HARNESS_MINUTE_MS));
  assert.equal(later, 30 * Number(process.env.STUDIO_HARNESS_MINUTE_MS));
});

test('a usage hold that names a reset days away is still probed every 30 minutes, and lifts when the account answers', async () => {
  clear();
  brains.saveBrain('claude');
  const stop = brains.harnessStopOf("You've hit your weekly limit · resets Nov 13, 1pm (UTC)", { now: Date.UTC(2026, 10, 10, 1, 15) })!;
  assert.equal(stop.kind, 'usage');
  hold.holdHarness({ ...stop, resetsAt: Date.now() + 3 * 86_400_000 }, { source: 'agent change c_8d0f27ed053a' });
  const h = hold.activeHold('claude')!;
  assert.equal(h.reset, true);
  // Not yet 30 (test) minutes: no probe.
  probed.length = 0;
  await hold.reviewHolds(h.since + 1);
  assert.ok(!probed.includes('claude'), 'too soon');
  // The account still at its limit: probed, still held, the reset kept.
  probes = { claude: { ok: false, note: "You've hit your weekly limit · resets Nov 13, 1pm (UTC)" } };
  await new Promise((r) => setTimeout(r, 35));
  await hold.reviewHolds();
  assert.ok(probed.includes('claude'));
  assert.ok(hold.activeHold('claude'), 'a real limit stays held');
  assert.equal(hold.activeHold('claude')!.reset, true);
  // It answers (the limit was per-model, wrong, or lifted): back now, not on Nov 13.
  probes = { claude: { ok: true, note: 'answering' } };
  await new Promise((r) => setTimeout(r, 35));
  await hold.reviewHolds();
  assert.equal(hold.harnessHeld('claude'), false);
});
