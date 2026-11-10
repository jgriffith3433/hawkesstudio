// The roadmap overview (dashboard/roadmap.js; J, 2026-11-09: "For the Plan tab, I'd like a more birds eye view of work
// being done (but in progress format for all projects and so I don't have to scroll)"): one compact row per project
// with a stacked bar of its tasks by where they stand, how much is on beta or live, a mini bar per milestone and the
// counts (working, on beta, live, needs you). It is the Plan tab's default view, a row opens that project's board, it
// is built from the same /api/roadmap answer, and it is redrawn by the push stream (no timer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-roadmap-overview-'));

const dash = path.join(import.meta.dirname, '..', 'dashboard');
const src = fs.readFileSync(path.join(dash, 'roadmap.js'), 'utf8');
const html = fs.readFileSync(path.join(dash, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(dash, 'style.css'), 'utf8');

/** The overview's pure helpers, pulled out of the page script (a classic script that touches the DOM at load). */
function helpers() {
  const grab = (re: RegExp) => { const m = re.exec(src); assert.ok(m, `roadmap.js has ${re}`); return m![0]; };
  const code = [
    grab(/const OV_BUCKETS = \[[\s\S]*?\n\];\n/),
    grab(/function taskBucket\(t\) \{[\s\S]*?\n\}\n/),
    grab(/function overviewData\(r\) \{[\s\S]*?\n\}\n/),
    grab(/const ovPct = .*\n/),
    grab(/function ovBar\(x\) \{[\s\S]*?\n\}\n/),
    grab(/function ovCounts\(x\) \{[\s\S]*?\n\}\n/),
    grab(/function ovMilestones\(x\) \{[\s\S]*?\n\}\n/),
    grab(/function overviewHtml\(d, filtered = false\) \{[\s\S]*?\n\}\n/),
  ].join('\n');
  const ctx: any = {};
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  vm.runInNewContext(`const esc = ${esc.toString()};\n${code}\nthis.h = { taskBucket, overviewData, overviewHtml };`, ctx);
  // Plain objects of this realm (the vm's arrays are not deepEqual to ours).
  const plain = (x: any) => JSON.parse(JSON.stringify(x));
  return { taskBucket: ctx.h.taskBucket, overviewHtml: ctx.h.overviewHtml, overviewData: (r: any) => plain(ctx.h.overviewData(r)) } as { taskBucket: (t: any) => string; overviewData: (r: any) => any; overviewHtml: (d: any, filtered?: boolean) => string };
}

const task = (status: string, waits: string | null = null) => ({ id: `k_${Math.random().toString(16).slice(2, 8)}`, title: status, status, waits, build: null });
const item = (id: string, product: string, state: string, tasks: any[]) => ({ id, product, status: 'planned', progress: { state, tasks } });

test('each task lands in one bucket: needs you, live, on beta, working, waiting for GPU or planned', () => {
  const { taskBucket } = helpers();
  assert.equal(taskBucket(task('failed', 'you: it failed after its tries')), 'you');
  assert.equal(taskBucket(task('planned', 'your GPU budget')), 'you');
  assert.equal(taskBucket(task('working', 'you: a question in your Inbox')), 'you');
  assert.equal(taskBucket(task('live')), 'live');
  assert.equal(taskBucket(task('verified')), 'beta');
  assert.equal(taskBucket(task('done')), 'beta');
  assert.equal(taskBucket(task('merged')), 'beta', 'merged and built by beta: nothing to wait on');
  assert.equal(taskBucket(task('merged', "beta's build")), 'working', 'merged but beta has not built it yet');
  assert.equal(taskBucket(task('waiting for GPU', 'a GPU server: ...')), 'gpu');
  assert.equal(taskBucket(task('working', 'GPU jobs (1 of 3 done; its agent resumes when they finish)')), 'gpu');
  assert.equal(taskBucket(task('planned', 'a free agent (it starts by itself)')), 'planned');
  assert.equal(taskBucket(task('working', 'its agent (working on it)')), 'working');
  assert.equal(taskBucket(task('review', 'its merge into beta')), 'working');
  assert.equal(taskBucket(task('failed', 'Studio planning it again (automatic re-plan 1 of 2, ...)')), 'working', 'Studio re-plans it by itself');
});

const fixture = () => ({
  products: [{ id: 'dod', name: 'Dose of Destruction' }, { id: 'yooba', name: 'Yooba Land' }, { id: 'quiet', name: 'Quiet One' }],
  items: [
    item('i_1', 'dod', 'working', [task('live'), task('merged'), task('working', 'its agent (working on it)'), task('planned', 'a free agent')]),
    item('i_2', 'dod', 'on beta', [task('verified'), task('merged')]),
    item('i_3', 'yooba', 'needs you', [task('failed', 'you: it failed after its tries'), task('waiting for GPU', 'a GPU server')]),
    item('i_4', 'yooba', 'idea', [task('idea')]),
  ],
  milestones: [
    { id: 'n_1', product: 'dod', title: 'Phone ready', status: 'open', items: [{ id: 'i_1', product: 'dod', state: 'working' }, { id: 'i_2', product: 'dod', state: 'on beta' }] },
    { id: 'n_2', product: null, title: 'Everything polished', status: 'reached', items: [{ id: 'i_2', product: 'dod', state: 'on beta' }, { id: 'i_3', product: 'yooba', state: 'needs you' }] },
    { id: 'n_3', product: 'dod', title: 'Launch', status: 'live', items: [{ id: 'i_9', product: 'dod', state: 'live' }] },
  ],
});

test('per project: tasks per bucket, items done, a bar per open milestone (split by product), live ones counted apart', () => {
  const { overviewData } = helpers();
  const d = overviewData(fixture());
  assert.deepEqual(d.rows.map((x: any) => x.id), ['dod', 'yooba'], 'roadmap order, only projects with work');
  assert.deepEqual(d.idle.map((x: any) => x.name), ['Quiet One']);
  const [dod, yooba] = d.rows;
  assert.deepEqual(dod.n, { live: 1, beta: 3, working: 1, gpu: 0, planned: 1, you: 0 });
  assert.equal(dod.tasks, 6);
  assert.equal(dod.items, 2);
  assert.equal(dod.itemsDone, 1);
  assert.deepEqual(dod.ms.map((m: any) => [m.title, m.done, m.total, m.status]), [['Phone ready', 1, 2, 'open'], ['Everything polished', 1, 1, 'reached']]);
  assert.equal(dod.shipped, 1, 'the live milestone is a count, not a bar');
  assert.deepEqual(yooba.n, { live: 0, beta: 0, working: 0, gpu: 1, planned: 0, you: 1 });
  assert.equal(yooba.items, 1, 'an idea is not work yet');
  assert.deepEqual(yooba.ms.map((m: any) => [m.title, m.done, m.total]), [['Everything polished', 0, 1]]);
  assert.equal(d.total.tasks, 8);
  assert.equal(d.milestones, 2, 'open and reached milestones');
});

test('the overview draws one tappable row per project, with %, counts, milestone bars and the legend', () => {
  const { overviewData, overviewHtml } = helpers();
  const out = overviewHtml(overviewData(fixture()));
  assert.equal((out.match(/data-ov="/g) ?? []).length, 2, 'a row per project with work');
  assert.match(out, /data-ov="dod"[^>]*role|role="button"[^>]*data-ov="dod"/);
  assert.match(out, /2 projects · 2 milestones · 8 tasks/);
  assert.match(out, /67%/, "Dose of Destruction: 4 of 6 tasks on beta or live");
  assert.match(out, /50% on beta or live/, 'every project: 4 of 8');
  assert.match(out, /title="1 task needs you"/);
  assert.match(out, /title="3 tasks on beta"/);
  assert.match(out, /🏁 Phone ready: 1 of 2 items done/);
  assert.match(out, /Everything polished: 1 of 1 item done \(reached/);
  assert.match(out, /✓1/);
  assert.match(out, /Nothing planned yet: Quiet One/);
  for (const label of ['live', 'on beta', 'working', 'waiting for GPU', 'planned', 'needs you']) assert.ok(out.includes(`${label} <b>`), `legend has ${label}`);
  assert.match(overviewHtml(overviewData(fixture()), true), /Nothing in this filter: Quiet One/);
  assert.match(overviewHtml(overviewData({ products: [{ id: 'a', name: 'A' }], items: [], milestones: [] })), /No roadmap work yet/);
});

test('names are escaped', () => {
  const { overviewData, overviewHtml } = helpers();
  const out = overviewHtml(overviewData({ products: [{ id: 'x', name: '<b>X</b>' }], items: [item('i_1', 'x', 'working', [task('working')])], milestones: [] }));
  assert.ok(!out.includes('<b>X</b>'));
});

test("19 projects with 5 milestones each stay one row each, so the overview fits a laptop screen", () => {
  const { overviewData, overviewHtml } = helpers();
  const products = Array.from({ length: 19 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}` }));
  const items = products.flatMap((p) => Array.from({ length: 5 }, (_, j) => item(`i_${p.id}_${j}`, p.id, 'working', [task('working'), task('merged'), task('planned'), task('live')])));
  const milestones = products.flatMap((p) => Array.from({ length: 5 }, (_, j) => ({ id: `n_${p.id}_${j}`, product: p.id, title: `M${j}`, status: 'open', items: [{ id: `i_${p.id}_${j}`, product: p.id, state: 'working' }] })));
  const d = overviewData({ products, items, milestones });
  const out = overviewHtml(d);
  assert.equal(d.rows.length, 19);
  assert.equal(d.milestones, 95);
  assert.equal((out.match(/class="rm-ov-row"/g) ?? []).length, 19, 'no nested rows: one line each');
  assert.equal((out.match(/class="rm-ov-m"/g) ?? []).length, 95);
  // A desktop row is one line (min-height under 30px plus 6px padding): 19 rows, the totals and the legend come to
  // about 700px, inside a laptop screen.
  const h = /\.rm-ov-row \{[^}]*min-height: (\d+)px/.exec(css);
  assert.ok(h && Number(h[1]) <= 30, 'desktop rows are one short line');
  assert.match(css, /\.rm-ov-name \{[^}]*white-space: nowrap/, 'a long name never wraps into a second line');
});

test("it is the Plan tab's default view, a row opens the project's board, and the push stream redraws it", () => {
  const sel = /<select id="rmView"[^>]*>([\s\S]*?)<\/select>/.exec(html)![1];
  assert.match(sel, /^<option value="overview">/, 'the first option is the overview, so the tab opens on it');
  assert.match(html, /<div id="rmOverview"><\/div>/);
  assert.match(src, /function openOverviewRow\(id\) \{\s*\$\('#rmProduct'\)\.value = id;\s*\$\('#rmView'\)\.value = 'board';/);
  assert.match(src, /data-ov-back/);
  assert.match(src, /studioStream\.on\(\['changes', 'inbox', 'roadmap'\]/);
  assert.doesNotMatch(src, /setInterval/);
});

test('a phone gets two short lines per project, tappable, with no sideways page scroll', () => {
  const m = /@media \(max-width: 640px\) \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(m, 'a phone block for the overview');
  assert.match(m![1], /grid-template-areas: "name n n" "bar pct ms"/);
  assert.match(m![1], /min-height: 44px/);
});

test('the overview fits the real roadmap answer: items, tasks and milestones from roadmap.ts', async () => {
  const rm = await import('../src/roadmap.ts');
  const a = rm.addItem({ product: 'hawkesstudio', title: 'Overview item', status: 'planned' });
  rm.addTask({ item: a.id, request: 'Do the first part' });
  const k2 = rm.addTask({ item: a.id, request: 'Do the second part' });
  rm.setTask(k2.id, { status: 'working' });
  rm.addMilestone({ product: 'hawkesstudio', title: 'Overview milestone', items: [a.id] });
  const r = { milestones: rm.listMilestones(), items: rm.listItems(), products: rm.roadmapProducts() };
  const { overviewData } = helpers();
  const d = overviewData(r);
  const row = d.rows.find((x: any) => x.id === 'hawkesstudio');
  assert.ok(row, 'Hawkes Studio has a row');
  assert.equal(row.tasks, 2);
  assert.equal(row.n.working, 1);
  assert.equal(row.n.planned, 1);
  assert.deepEqual(row.ms.map((m: any) => [m.title, m.done, m.total]), [['Overview milestone', 0, 1]]);
});
