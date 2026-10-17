// The Go live cards' fix button: which beta-only step clears a go-live plan's blockers (deploy.ts blockerFix, planFix),
// and the beta run rebuilding a Unity product when the website's main moved under its build (beta.ts betaBuildCurrent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-golive-fix-'));
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [] }));

const { blockerFix, planFix } = await import('../src/deploy.ts');
const { betaBuildCurrent } = await import('../src/beta.ts');

// The blockers as deployPlan words them (deploy.ts).
const B = {
  noBeta: 'site has no beta branch yet. It\'s made from main when the first agent change starts (or "studio deploy x --merge-main" makes it now).',
  behind: 'main has 2 commit(s) beta lacks ("Rollback: v3", "Fix"), so main can\'t be fast-forwarded. Merge main into beta first (studio deploy x --merge-main), then playtest beta.',
  untested: 'beta hasn\'t been playtested at abc1234 (the last local playtest played beta def5678). Playtest beta first (the daily run, or "studio beta x").',
  neverTested: 'beta hasn\'t been playtested yet (the daily run on the server plays it, or "studio beta x").',
  prebuild: 'beta\'s newest commit isn\'t its pre-deploy build (npm run build). Run "studio beta x" (it builds, commits to beta and playtests it).',
  noBuild: 'beta has no build yet (the daily run on the server builds it, or "studio build x").',
  buildFailed: 'The last build of beta failed: compile error',
  buildOf: 'The beta build is of 1111111, but beta is 2222222: build beta again ("studio beta x").',
  siteMoved: 'sickofitwebsite\'s main moved since the beta build (aaaaaaa -> bbbbbbb): build beta again so it sits on what\'s live.',
  gitError: 'git: fetching site failed',
  nothing: 'Nothing to go live: main already is beta (abc1234).',
  nothingUnity: 'Nothing to go live: the beta build matches what\'s live and beta has no new commits.',
};

test('each blocker maps to the beta step that clears it', () => {
  assert.equal(blockerFix(B.noBeta), 'merge-main');
  assert.equal(blockerFix(B.behind), 'merge-main');
  for (const b of [B.untested, B.neverTested, B.prebuild, B.noBuild, B.buildFailed, B.buildOf]) assert.equal(blockerFix(b), 'beta', b);
  assert.equal(blockerFix(B.siteMoved), 'rebuild');
  for (const b of [B.gitError, B.nothing, B.nothingUnity, 'Something new nobody mapped']) assert.equal(blockerFix(b), null, b);
});

test('a card gets one button: merging live first, then playing beta, then rebuilding', () => {
  assert.equal(planFix([]), null);
  assert.equal(planFix([B.behind, B.untested]), 'merge-main');
  assert.equal(planFix([B.untested, B.siteMoved]), 'beta');
  assert.equal(planFix([B.buildOf, B.siteMoved]), 'beta');
  assert.equal(planFix([B.siteMoved]), 'rebuild');
  assert.equal(planFix([B.gitError]), null);
  // Nothing to go live: no button, whatever else the plan says.
  assert.equal(planFix([B.untested, B.nothing]), null);
  assert.equal(planFix([B.siteMoved, B.nothingUnity]), null);
});

test('the beta build is rebuilt when the website main moved under it', () => {
  const b = { sha: 'h1', base: 'm1', ok: true, at: 0 };
  assert.equal(betaBuildCurrent(b, 'h1', 'm1', true), true);
  assert.equal(betaBuildCurrent(b, 'h1', 'm2', true), false, 'live moved: build again');
  assert.equal(betaBuildCurrent(b, 'h2', 'm1', true), false, 'beta moved');
  assert.equal(betaBuildCurrent(b, 'h1', 'm1', false), false, 'the website copy is gone');
  assert.equal(betaBuildCurrent({ ...b, ok: false }, 'h1', 'm1', true), false);
  assert.equal(betaBuildCurrent(null, 'h1', 'm1', true), false);
  assert.equal(betaBuildCurrent(b, 'h1', null, true), true, 'the website main unknown: the source decides');
});
