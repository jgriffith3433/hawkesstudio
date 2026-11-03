// The daily start limit defaults to 1000, automatic resends don't count toward it, and a limit that holds the roadmap
// back is told (banner data, PM log, once a day per cause) (J, 2026-11-03). Scratch database, no agents, GitHub or Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-limits-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_PM_TALK = 'off';
process.env.TALK_CLAUDE = 'no-such-claude-here';
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE', 'NTFY_TOPIC']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'notify.json'), JSON.stringify({ enabled: false, topic: 'test' }));
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'agents.json'), JSON.stringify({ maxConcurrent: 0 }));
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: { lstart: 'x/lstart' },
  products: [{ id: 'lstart', name: 'Lstart', framing: 'test', engine: 'static', repo: 'lstart', site: 'lstart', live: 'http://127.0.0.1:9/', local: { serve: 'static', dir: 'lstart', port: 8797, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.' }],
  infra: [{ id: 'hawkesstudio', name: 'Hawkes Studio', repo: 'hawkesstudio', slug: 'x/hawkesstudio' }],
}));

const rm = await import('../src/roadmap.ts');
const pm = await import('../src/pm.ts');
const ag = await import('../src/agents.ts');

test('the daily limits default to 1000', () => {
  assert.equal(pm.pmSettings().maxStartsPerDay, 1000);
  assert.equal(ag.agentSettings().maxPerDay, 1000);
});

test('automatic resends are not starts of the day', () => {
  rm.logDecision('start', 't_x', 'lstart', 'started c_1 for "A" (try 1)');
  assert.equal(pm.startsToday(), 1);
  rm.logDecision('start', 't_x', 'lstart', 'carried on with c_1 for "A" in its own worktree, which still had its work (try 2)');
  rm.logDecision('start', 't_x', 'lstart', 'started c_2 for "A" (not counted as a try, 1 used; a GPU server is up)');
  assert.equal(pm.startsToday(), 1, 'a carry-on and a not-a-try resend are the same work');
});

test('a limit holding the roadmap back is told: banner data, once a day per cause', async () => {
  assert.deepEqual(await pm.limitNotices(), [], 'nothing waits, nothing to tell');
  const it = rm.addItem({ product: 'lstart', title: 'Menu', status: 'planned' });
  rm.addTask({ item: it.id, request: 'The menu' });
  assert.deepEqual(await pm.limitNotices(), [], 'work waits but no limit is reached');
  pm.savePmSettings({ maxStartsPerDay: 1 });
  const [n, ...rest] = await pm.limitNotices();
  assert.equal(rest.length, 0);
  assert.equal(n.cause, 'starts-per-day');
  assert.equal(n.used, 1);
  assert.equal(n.limit, 1);
  assert.match(n.text, /Daily start limit: 1 of 1 used, so 1 roadmap task waits\. It resets at \d\d:\d\d UTC\. Raise it: Settings/);
  assert.equal((await pm.pmStatus()).limits[0].cause, 'starts-per-day');
  assert.equal((await pm.notifyLimits()).length, 1);
  assert.equal((await pm.notifyLimits()).length, 0, 'once per day per cause');
  assert.equal(rm.listDecisions({ action: 'limit' }).length, 1);
  pm.savePmSettings({ maxStartsPerDay: 1000 });
  assert.deepEqual(await pm.limitNotices(), []);
});
