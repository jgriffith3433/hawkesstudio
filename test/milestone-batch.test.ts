// J, 2026-11-11: "playtests don't need to be so frequent either", "Do it during milestones"; 2026-11-10: fewer, higher
// quality roadmap items. That day 88 of 125 milestones held one item, so each product played every 20 to 60 minutes.
// 1. the rule: complete milestones of a product wait for more of its work until they hold BATCH_ITEMS items, unless
//    nothing more is coming or the wait passed BATCH_WAIT_MS; a milestone spanning products goes alone;
// 2. the waste, reproduced: three one-item milestones of one product complete while a fourth is being worked on: no play;
//    the fourth lands: ONE beta run plays all four, and each milestone's check is that run;
// 3. planning: a new milestone of a product with an open one that has room is refused, pointing at that one;
// 4. random steps: milestones completing at random over a day never play a batch under BATCH_ITEMS while more is coming
//    and never wait past BATCH_WAIT_MS.
// A scratch database and a fixture project; nothing outside is called (every fetch is refused).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-msbatch-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE', 'K_SERVICE']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
const base = { framing: 'test', live: 'http://127.0.0.1:9/', playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.' };
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: { web: 'x/web', two: 'x/two' },
  products: [
    { ...base, id: 'webby', name: 'Webby', engine: 'web', repo: 'web', site: 'web', github: 'x/web', local: { serve: 'static', dir: 'web', port: 8797, path: '/' }, builds: [{ id: 'site', tool: 'npm' }] },
    { ...base, id: 'other', name: 'Other', engine: 'web', repo: 'two', site: 'two', github: 'x/two', local: { serve: 'static', dir: 'two', port: 8798, path: '/' }, builds: [{ id: 'site', tool: 'npm' }] },
  ],
  infra: [],
}));

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response('refused in the test', { status: 500 })) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const { db } = await import('../src/db.ts');
await import('../src/agents.ts');
const MB = await import('../src/milestone-batch.ts');
const rm = await import('../src/roadmap.ts');
const pm = await import('../src/pm.ts');

const H = 3600_000;
const T0 = Date.UTC(2026, 10, 11, 12);

test('1. the rule', () => {
  const r = (id: string, items: number, since = T0, product: string | null = 'webby') => ({ id, product, items, since });
  const coming = (p: string) => (p === 'webby' ? ['"Menus"'] : []);
  // One item complete, more on the way: waits, and says why and until when.
  let v = MB.batchVerdict([r('n_a', 1)], coming, T0 + H);
  assert.deepEqual(v.go, []);
  assert.match(v.wait[0].why, /1 item complete, under the 4 a milestone's play covers, and 1 more milestone on the way \("Menus"\); played together then, or by 18:00 UTC at the latest/);
  // Four items between them: one play for all of them.
  v = MB.batchVerdict([r('n_a', 1), r('n_b', 2), r('n_c', 1)], coming, T0 + H);
  assert.deepEqual(v.go, [['n_a', 'n_b', 'n_c']]);
  // Nothing else coming for the product: it plays now, however small.
  assert.deepEqual(MB.batchVerdict([r('n_x', 1, T0, 'other')], coming, T0).go, [['n_x']]);
  // Waited its longest: plays.
  assert.deepEqual(MB.batchVerdict([r('n_a', 1)], coming, T0 + MB.BATCH_WAIT_MS).go, [['n_a']]);
  assert.equal(MB.batchVerdict([r('n_a', 1)], coming, T0 + MB.BATCH_WAIT_MS - 1).go.length, 0);
  // Products don't wait for each other; a milestone spanning products goes alone.
  v = MB.batchVerdict([r('n_a', 1), r('n_x', 1, T0, 'other'), r('n_s', 1, T0, null)], coming, T0);
  assert.deepEqual(v.go, [['n_x'], ['n_s']]);
  assert.deepEqual(v.wait.map((w) => w.id), ['n_a']);
});

const clear = () => {
  for (const t of ['tasks', 'items', 'milestones', 'pm_log']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM runs WHERE kind = 'beta'").run();
};
const betaRuns = () => db.prepare(`SELECT id, options FROM runs WHERE kind = 'beta' AND products LIKE '%"webby"%'`).all() as any[];
/** Merged into beta and built by beta (what beta's build after the merge records). */
const merged = () => ({ merged_at: Date.now() - 1000, build: { ok: true } as any });
/** A one-item milestone of webby, its one task merged (complete) or working (on the way). */
function oneItem(title: string, status: 'merged' | 'working') {
  const it = rm.addItem({ product: 'webby', title, status: 'planned' });
  const ms = rm.addMilestone({ product: 'webby', title, items: [it.id] });
  const t = rm.addTask({ item: it.id, request: title, criteria: [`${title} shows`] } as any);
  rm.setTask(t.id, { status, ...(status === 'merged' ? merged() : {}) });
  return { ms, t };
}

test('2. three one-item milestones wait for the fourth, then ONE run plays all four', async () => {
  clear();
  const done = ['Jump', 'Dash', 'Crouch'].map((x) => oneItem(x, 'merged'));
  const fourth = oneItem('Menus', 'working');
  const ready = rm.milestonesToReach().map((m) => m.id);
  assert.equal(ready.length, 3, 'three complete, the fourth being worked on');
  await pm.reachMilestones();
  await pm.reachMilestones(); // a second pass: still nothing, and said once
  assert.equal(betaRuns().length, 0, 'no play while the fourth is being worked on');
  const said = rm.listDecisions({ action: 'milestone-batch', limit: 100 });
  assert.equal(said.length, ready.length, 'one line per waiting milestone, not one per pass');
  assert.match(String(said[0].detail), /on the way \("Menus"\)/);
  // The fourth lands.
  rm.setTask(fourth.t.id, { status: 'merged', ...merged() });
  await pm.reachMilestones();
  const runs = betaRuns();
  assert.equal(runs.length, 1, 'one beta run for all four milestones');
  assert.equal(JSON.parse(runs[0].options).play, 'milestone');
  for (const id of [...done.map((d) => d.ms.id), fourth.ms.id]) {
    assert.deepEqual(JSON.parse(String(rm.getMilestone(id)!.checks)), [runs[0].id], 'each milestone is checked by that one run');
  }
  assert.match(String(rm.listDecisions({ action: 'milestone-check', limit: 10 })[0].detail), /checked together with/);
});

test('3. planning: a product with an open milestone that has room gets its items there', () => {
  clear();
  assert.equal(MB.milestoneWithRoom('webby'), null, 'none open');
  const { ms } = oneItem('Jump', 'working');
  assert.deepEqual(MB.milestoneWithRoom('webby'), { id: ms.id, title: 'Jump', total: 1 });
  assert.equal(MB.milestoneWithRoom('other'), null, 'another product: its own');
  assert.equal(MB.milestoneWithRoom(null), null, 'a milestone spanning products: no rule');
  // Full: a new one is fine.
  for (let i = 0; i < MB.MILESTONE_MAX_ITEMS - 1; i++) rm.updateItem(rm.addItem({ product: 'webby', title: `x${i}`, status: 'planned' }).id, { milestone: ms.id });
  assert.equal(MB.milestoneWithRoom('webby'), null, 'full at the most a milestone holds');
  // The route and the planners' words say the same.
  const server = fs.readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(server, /milestoneWithRoom\(rm\.productId\(b\.product\)\)/);
  assert.match(fs.readFileSync(new URL('../src/mcp-tools.ts', import.meta.url), 'utf8'), /a milestone is a BATCH of 3 to 6 items/);
  assert.match(fs.readFileSync(new URL('../src/talk.ts', import.meta.url), 'utf8'), /milestone is a batch of 3 to 6 items/);
});

test('4. random steps over a day: no small play while more is coming, no wait past the longest', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let round = 0; round < 50; round++) {
    let now = T0;
    let left = 4 + Math.floor(rand() * 20); // milestones the product still has to finish today
    const waiting: { id: string; product: string; items: number; since: number }[] = [];
    let plays = 0;
    let n = 0;
    while (left > 0 || waiting.length) {
      now += Math.floor(rand() * 90) * 60_000 + 60_000; // the PM's pass after some minutes
      if (left > 0 && rand() < 0.5) { waiting.push({ id: `n_${n++}`, product: 'webby', items: 1 + Math.floor(rand() * 2), since: now }); left--; }
      const coming = () => (left > 0 ? ['"next"'] : []);
      const v = MB.batchVerdict(waiting, coming, now);
      for (const g of v.go) {
        const batch = waiting.filter((w) => g.includes(w.id));
        const items = batch.reduce((s, w) => s + w.items, 0);
        const oldest = Math.min(...batch.map((w) => w.since));
        assert.ok(items >= MB.BATCH_ITEMS || left === 0 || now - oldest >= MB.BATCH_WAIT_MS, `round ${round}: a play of ${items} item(s) while more was coming`);
        plays++;
        for (const id of g) waiting.splice(waiting.findIndex((w) => w.id === id), 1);
      }
      for (const w of waiting) assert.ok(now - w.since < MB.BATCH_WAIT_MS, `round ${round}: ${w.id} waited past the longest`);
    }
    assert.ok(plays <= n, 'never more plays than milestones');
  }
});
