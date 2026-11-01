// Walk-away mode in a customer's Studio (J, 2026-11-01: "Make Walk Away mode available for Team accounts"): off until
// the owner turns it on in their Settings, only on a plan with the PM (Team and up: 402 with the Upgrade below that),
// and it spends nothing of theirs unless they set their own GPU caps (both 0 at first). J's Studio keeps its own
// defaults (walkaway.test.ts). The plan is what the control plane said (entitlements.ts setCellPlan); no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-customer-walkaway-'));
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_CUSTOMER = '1';
process.env.TALK_CLAUDE = 'no-such-claude-here';
process.env.STUDIO_CONTROL_URL = 'http://127.0.0.1:9';
process.env.STUDIO_ORG = 'org_walk';
process.env.STUDIO_CELL_KEY = 'cell-key';
delete process.env.STUDIO_PRODUCTS;
fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'products.json'), JSON.stringify({ products: [] }));

const W = await import('../src/walkaway.ts');
const E = await import('../src/entitlements.ts');
const S = await import('../src/settings.ts');
const pm = await import('../src/pm.ts');
const pmFile = path.join(process.env.STUDIO_DATA!, 'pm.json');
const plan = (p: string) => { E.setCellPlan({ plan: p, status: 'active', maxGames: null, from: 'control' }); E.forgetPlanAsk(); };

test("off by default in a customer's Studio, with no GPU spending of its own", async () => {
  assert.equal(W.walkAwayOn(), false);
  assert.deepEqual(W.walkAwaySettings(), { walkAway: false, walkAwayGpuPerDay: 0, walkAwayGpuPerTask: 0 });
  assert.equal(pm.pmSettings().walkAway, false);
  assert.equal(await W.gpuAutoApproveLimit(), 0, "not the platform's costs.gpuAutoApprove");
});

test('saving another PM setting never saves walk-away as on (only what was set is written)', async () => {
  plan('free');
  await S.saveSettings('pm', { maxTries: 4 }, { conversation: null });
  const f = JSON.parse(fs.readFileSync(pmFile, 'utf8'));
  assert.equal(f.maxTries, 4);
  assert.equal('walkAway' in f, false);
  assert.equal(W.walkAwayOn(), false);
});

test('below Team: turning it on (or its caps) answers 402 with the Upgrade to Team', async () => {
  for (const p of ['free', 'studio_indie']) {
    plan(p);
    for (const patch of [{ walkAway: true }, { walkAwayGpuPerTask: 2 }, { walkAwayGpuPerDay: 10 }]) {
      await assert.rejects(S.saveSettings('pm', patch, { conversation: null }), (e: any) => e.status === 402 && e.upgrade?.plan === 'studio_team', `${p} ${JSON.stringify(patch)}`);
    }
  }
  assert.equal(W.walkAwayOn(), false);
  // Turning it off is never refused.
  await S.saveSettings('pm', { walkAway: false }, { conversation: null });
});

test('on Team the owner turns it on and sets their own caps; GPU auto-approval follows them, and only while it is on', async () => {
  plan('studio_team');
  const s = await S.saveSettings('pm', { walkAway: true }, { conversation: null });
  assert.equal(s.walkAway, true);
  assert.equal(W.walkAwayOn(), true);
  assert.equal(await W.gpuAutoApproveLimit(), 0, 'on, but no caps yet: every GPU budget still asks the owner');
  await S.saveSettings('pm', { walkAwayGpuPerTask: 3, walkAwayGpuPerDay: 10 }, { conversation: null });
  assert.equal(await W.gpuAutoApproveLimit(), 3);
  assert.equal(W.walkAwaySettings().walkAwayGpuPerDay, 10);
  await assert.rejects(S.saveSettings('pm', { walkAwayGpuPerTask: -1 }, { conversation: null }), /0 to/);
  await S.saveSettings('pm', { walkAway: false }, { conversation: null });
  assert.equal(await W.gpuAutoApproveLimit(), 0, 'off: nothing approved by itself, whatever the caps say');
  // The Studio plan (above Team) has it too.
  plan('studio_studio');
  await S.saveSettings('pm', { walkAway: true }, { conversation: null });
  assert.equal(W.walkAwayOn(), true);
});

test('from Talk, turning it on or raising its caps needs the owner\'s own yes', async () => {
  plan('studio_team');
  await S.saveSettings('pm', { walkAway: false, walkAwayGpuPerTask: 0 }, { conversation: null });
  await assert.rejects(S.saveSettings('pm', { walkAway: true }, { conversation: 'conv_nobody', quote: null }), (e: any) => e.status === 403);
  await assert.rejects(S.saveSettings('pm', { walkAwayGpuPerTask: 5 }, { conversation: 'conv_nobody', quote: null }), (e: any) => e.status === 403);
});

test("the PM's prompt in walk-away mode speaks of the customer's Studio, not J's", async () => {
  await S.saveSettings('pm', { walkAway: true }, { conversation: null });
  const p = pm.pmPrompt([], false);
  assert.match(p, /Walk-away mode: ON/);
  assert.match(p, /never live/);
  assert.doesNotMatch(p, /build build build/);
  assert.doesNotMatch(p, /Studio and Gen changes merge into main/);
});
