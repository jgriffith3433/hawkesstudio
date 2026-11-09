// A ready change's playtest build of a Unity project built through its builds list (The Place Department, change c_ce95a565362b):
// 1. the Unity build comes from the builds list (tool unity, whatever its `on`), the way beta's builds do;
// 2. a change that can't be built for a playtest is "not played" (never "build failed"), so it goes on to beta's own build.
// Nothing is built: no Gen, no GitHub, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-changeplan-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
const base = { framing: 'test', repo: 'tpd', site: 'tpd', live: 'http://127.0.0.1:9/', local: { serve: 'static', dir: 'tpd', port: 8795, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.' };
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: { tpd: 'x/tpd' },
  products: [
    { ...base, id: 'tpd', name: 'The Place Department (Unity)', engine: 'unity', github: 'x/tpd', builds: [{ id: 'web', tool: 'unity', method: 'WebGlBuild.CloudBuild', on: ['tag'], publish: { project: 'the-place-department', path: 'Game/', page: 'site' } }] },
    { ...base, id: 'nobuild', name: 'No Build (Unity)', engine: 'unity' },
  ],
  infra: [],
}));

const { changeBuildPlan, verifyChange } = await import('../src/agents.ts');
const { getProduct } = await import('../src/config.ts');

test('the Unity build comes from the builds list, whatever its on triggers', () => {
  const p = getProduct('tpd');
  const plan = changeBuildPlan(p);
  assert.equal(plan.how, 'cloud');
  assert.equal((plan as any).spec.id, 'web');
  for (const on of [['tag'], ['beta'], ['beta', 'tag'], undefined]) {
    const q = changeBuildPlan({ ...p, builds: [{ id: 'web', tool: 'unity', ...(on ? { on } : {}) } as any] });
    assert.equal(q.how, 'cloud', `on: ${JSON.stringify(on)}`);
  }
  assert.equal(changeBuildPlan({ ...p, build: { project: 'a', site: 'b', method: 'M' } }).how, 'server', 'the old build field still wins');
  assert.equal(changeBuildPlan({ ...p, builds: [{ id: 'site', tool: 'npm' } as any], engine: 'web' }).how, 'web');
});

test('a Unity build that cannot be played is no build config, not a failed build', () => {
  const p = getProduct('tpd');
  assert.equal(changeBuildPlan({ ...p, builds: [] }).how, 'none');
  assert.equal(changeBuildPlan({ ...p, builds: [{ id: 'win', tool: 'unity', target: 'windows' } as any] }).how, 'none');
  assert.equal(changeBuildPlan({ ...p, github: undefined }).how, 'none');
});

test('a change with no usable build config is "not played": it never reads as a failed playtest build', async () => {
  const p = getProduct('nobuild');
  const c: any = { id: 'c_abc123', repo: 'tpd', worktree: path.join(tmp, 'wt'), branch: 'task/x', base: 'beta', request: '', criteria: [], findings: [] };
  const v: any = await verifyChange(c, p, []);
  assert.equal(v.outcome, 'not played');
  assert.notEqual(v.outcome, 'build failed');
  assert.match(v.error, /no build settings/);
  assert.equal(v.build, null);
  const { playtested } = await import('../src/agents.ts');
  assert.equal(playtested(v), false);
});
