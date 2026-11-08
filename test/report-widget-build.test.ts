// The widget's "New build: reload" pill (dashboard/report-widget.js): a page whose injected sha/version match what
// GET /dev/__studio/build answers never shows it; only a really newer served build does. The decision block
// (<newer-build>) is run on its own; the one-time check, 8 s auto-dismiss and sessionStorage memory are asserted on the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'report-widget.js'), 'utf8');
const block = /\/\/ <newer-build>[\s\S]*?\/\/ <\/newer-build>/.exec(src)![0];
const same = `const same = (a, b) => { a = String(a || '').toLowerCase(); b = String(b || '').toLowerCase(); return Boolean(a && b) && (a.startsWith(b) || b.startsWith(a)); };`;
const isNewer: (b: any, c: any) => boolean = vm.runInNewContext(`${same}\n${block}\nisNewer`);

test('a page that matches the build reply never shows the pill', () => {
  const built = Date.now();
  assert.equal(isNewer({ sha: 'abc1234', version: null, at: built + 5000 }, { sha: 'abc1234', built }), false, 'same commit');
  assert.equal(isNewer({ sha: 'abc1234def', at: built }, { sha: 'abc1234', built }), false, 'full vs short sha');
  assert.equal(isNewer({ sha: 'abc1234', version: 42 }, { sha: 'abc1234', version: '42' }), false, 'number vs string');
  assert.equal(isNewer({ sha: 'abc1234', version: '42' }, { sha: 'abc1234', version: 'v42+20261107' }), false, 'a +stamp suffix');
  assert.equal(isNewer({ sha: 'abc1234', version: 'web 7' }, { sha: 'abc1234', version: '7' }), false, 'build id prefix');
  assert.equal(isNewer({ sha: 'zzz9999', version: '42' }, { sha: 'abc1234', version: '42' }), false, 'same version, different sha: versions decide');
});

test('a stale or same-publish build.json (other sha, not published after the page) is not newer', () => {
  const built = Date.now();
  assert.equal(isNewer({ sha: 'old0000', at: built - 3600_000 }, { sha: 'abc1234', built }), false, 'older');
  assert.equal(isNewer({ sha: 'zzz9999', at: built + 20_000 }, { sha: 'abc1234', built }), false, 'written just after the pages');
});

test('a really newer served build shows it', () => {
  const built = Date.now();
  assert.equal(isNewer({ sha: 'new0000', version: '43' }, { sha: 'abc1234', version: '42' }), true, 'higher version');
  assert.equal(isNewer({ sha: 'new0000', version: '9' }, { sha: 'abc1234', version: '10' }), false, 'lower version is not newer');
  assert.equal(isNewer({ sha: 'new0000', at: built + 600_000 }, { sha: 'abc1234', built }), true, 'other commit published later');
  assert.equal(isNewer({ sha: 'new0000' }, { sha: 'abc1234' }), true, 'no times: a different commit');
});

test('one on-load check, auto-dismiss after 8 s, dismissal kept in sessionStorage', () => {
  assert.match(src, /hideTimer = setTimeout\(dismiss, 8000\)/);
  assert.match(src, /sessionStorage\.setItem\('hawkesReport\.freshDismissed'/);
  assert.match(src, /setTimeout\(checkBuild, 3000\)/);
  assert.doesNotMatch(src, /setInterval\(checkBuild/);
});
