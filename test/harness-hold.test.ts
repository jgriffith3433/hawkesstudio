// The harness hold (J, 2026-10-20): the classifier reads every wording seen, a stop holds the harness studio-wide, a
// passing probe lifts it, and the agents' pump and the PM start nothing meanwhile. No wall-clock limits: the probe and
// the clock are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-hold-'));
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9';
process.env.HAWKES_BRAIN = 'claude';

const { harnessStopOf, harnessBlocked, resetTime } = await import('../src/brains.ts');
const hold = await import('../src/harness-hold.ts');

const NOW = Date.UTC(2026, 9, 20, 7, 0);

test('the classifier knows every wording, with the reset time when there is one', () => {
  const cases: [string, string][] = [
    ["You've hit your limit · resets 8:40am (UTC)", 'usage'],
    ["You've hit your weekly limit · resets Oct 23, 1pm (UTC)", 'usage'],
    ["You're out of usage. Switch to Auto, or ask your admin to raise it", 'usage'],
    ['usage limit reached with Pro+', 'usage'],
    ['Limit to continue with Auto. Your usage limits will reset when your monthly cycle ends', 'usage'],
    ['ActionRequiredError: You have an unpaid invoice Pay your unpaid invoice at cursor.com/dashboard/billing to resume requests.', 'billing'],
    ['Credit balance is too low', 'billing'],
    ['Error: Authentication required. Please run agent login', 'auth'],
    ['Not logged in · Please run /login', 'auth'],
    ['API Error: 429 {"type":"rate_limit_error"}', 'transient'],
    ['API Error: 529 overloaded_error', 'transient'],
    ['API Error: 503 Service Unavailable', 'transient'],
  ];
  for (const [text, kind] of cases) assert.equal(harnessStopOf(text, { now: NOW })?.kind, kind, text);
  assert.equal(harnessStopOf('The bridge cutscene is already on beta.'), null);
  assert.equal(harnessBlocked('API Error: 503 Service Unavailable'), false, 'harnessBlocked stays the caps and logins');
  assert.equal(harnessStopOf("You've hit your limit · resets 8:40am (UTC)", { now: NOW })?.resetsAt, Date.UTC(2026, 9, 20, 8, 40));
  assert.equal(resetTime('resets Oct 23, 1pm (UTC)', NOW), Date.UTC(2026, 9, 23, 13, 0));
  assert.equal(resetTime('resets 6:00am (UTC)', NOW), Date.UTC(2026, 9, 21, 6, 0), 'the next such moment');
});

test('a stop holds the harness; a failing probe extends it; a passing one lifts it and runs the callbacks', async () => {
  let probes = 0;
  let answers = false;
  const said: string[] = [];
  const phone: string[] = [];
  hold.holdDeps.probe = async () => { probes++; return answers ? { ok: true, note: 'answering' } : { ok: false, note: "You've hit your limit" }; };
  hold.holdDeps.talk = async (t) => void said.push(t);
  hold.holdDeps.phone = async (t) => void phone.push(t);
  hold.holdDeps.otherAccounts = async () => [];
  let resumed = 0;
  hold.onHoldLifted(() => resumed++);

  const stop = harnessStopOf("You've hit your limit", { now: NOW })!;
  const { hold: h, fresh } = hold.holdHarness(stop, { source: 'test', now: NOW });
  assert.equal(fresh, true);
  assert.equal(h.until, NOW + 10 * 60_000, 'no reset time: the backoff starts at 10 minutes');
  assert.equal(hold.harnessHeld(), true);
  assert.equal(phone.length, 0, 'a usage reset never reaches the phone');
  assert.equal(hold.holdStatus()?.harness, 'claude');

  assert.ok(await hold.reviewHold(NOW + 1), 'before its time: no probe');
  assert.equal(probes, 0);
  await hold.reviewHold(NOW + 11 * 60_000);
  assert.equal(probes, 1);
  assert.equal(hold.activeHold()!.until > NOW + 11 * 60_000, true, 'extended');
  assert.equal(hold.activeHold()!.attempts, 1);

  answers = true;
  await hold.reviewHold(Date.now() + 3 * 3600_000);
  assert.equal(hold.harnessHeld(), false);
  assert.equal(resumed, 1);
  assert.ok(said.some((t) => t.startsWith('Agents resumed')));
});

test('billing and no login are held every 30 minutes and tell the phone once', async () => {
  const phone: string[] = [];
  hold.holdDeps.phone = async (t) => void phone.push(t);
  hold.holdDeps.talk = async () => {};
  const stop = harnessStopOf('ActionRequiredError: You have an unpaid invoice', { now: NOW })!;
  const { hold: h } = hold.holdHarness(stop, { source: 'test', now: NOW });
  assert.equal(h.until, NOW + 30 * 60_000);
  hold.holdHarness(stop, { source: 'again', now: NOW + 1000 });
  assert.equal(phone.length, 1, 'once per hold');
  hold.liftHold('test over');
});
