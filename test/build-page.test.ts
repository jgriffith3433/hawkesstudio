// The build page (buildview.ts; J, 2026-11-04: "see the logs of the build in studio if I click its link in activity"):
// a running Unity build's log is asked of Gen when the route is called, a stuck log is told from a moving one, a finished
// build shows the log Studio kept and the failure in plain words. Gen is a stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-buildpage-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'bpgame', name: 'Build Page Game', framing: 'test', engine: 'web', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/', github: 'acme/bpgame',
  local: { serve: 'static', dir: 'site', port: 8799, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
  builds: [{ id: 'web', tool: 'unity', target: 'web' }],
}] }));

const { db } = await import('../src/db.ts');
await import('../src/builds.ts');
const V = await import('../src/buildview.ts');

const run = (id: string, status = 'running') => db.prepare("INSERT INTO runs (id, kind, status, products, options, started) VALUES (?, 'build', ?, ?, ?, ?)").run(id, status, '["bpgame"]', '{"builds":["web"]}', Date.now() - 600_000);
let ver = 0;
const row = (o: Record<string, unknown>) => { const r = { product: 'bpgame', build: 'web', version: ++ver, sha: 'a1b2c3d4e5f6a7b8', ref: 'beta', runner: 'gen', target: 'web', started: Date.now() - 600_000, ...o }; db.prepare(`INSERT INTO builds (${Object.keys(r).join(', ')}) VALUES (${Object.keys(r).map(() => '?').join(', ')})`).run(...Object.values(r) as any[]); };

test('a running build: the log comes from Gen when asked, with the last line and whether it moves', async () => {
  run('r_aaaaaaaaaaaa');
  row({ id: 'b_aaaaaaaaaaaa', run: 'r_aaaaaaaaaaaa', status: 'building', gen_job: 'j_run1' });
  let log = ['checkout done', 'Importing assets 10%'];
  const api = { job: async () => ({ id: 'j_run1', status: 'running', detail: 'Unity is importing', log, outputs: [] }), bytes: async () => new Uint8Array() };
  const t0 = Date.now();
  const a = await V.buildPage('r_aaaaaaaaaaaa', { api, now: t0 });
  assert.equal(a!.builds[0].state, 'building');
  assert.equal(a!.builds[0].genJob, 'j_run1');
  assert.equal(a!.builds[0].genDetail, 'Unity is importing');
  assert.match(a!.builds[0].log!.text, /Importing assets 10%/);
  assert.equal(a!.builds[0].progress!.lastLine, 'Importing assets 10%');
  assert.equal(a!.builds[0].progress!.verdict, 'unknown', 'the first look cannot say how long it was the same');
  const b = await V.buildPage('r_aaaaaaaaaaaa', { api, now: t0 + V.STUCK_AFTER_S * 1000 + 5000 });
  assert.equal(b!.builds[0].progress!.verdict, 'maybe stuck');
  log = [...log, 'Importing assets 40%'];
  const c = await V.buildPage('r_aaaaaaaaaaaa', { api, now: t0 + V.STUCK_AFTER_S * 1000 + 9000 });
  assert.equal(c!.builds[0].progress!.verdict, 'building');
  assert.equal(c!.builds[0].progress!.lastLine, 'Importing assets 40%');
});

test('the Unity log output is read when Gen has it', async () => {
  run('r_bbbbbbbbbbbb');
  row({ id: 'b_bbbbbbbbbbbb', run: 'r_bbbbbbbbbbbb', status: 'building', gen_job: 'j_run2' });
  const api = { job: async () => ({ status: 'running', log: ['x'], outputs: [{ title: 'Unity log (proj)', asset: 'a_1' }] }), bytes: async () => Buffer.from('line one\nline two\n') };
  const p = await V.buildPage('r_bbbbbbbbbbbb', { api });
  assert.match(p!.builds[0].log!.source, /Unity log/);
  assert.match(p!.builds[0].log!.text, /line two/);
});

test('a failed build shows the kept log and the failure; Gen is not needed', async () => {
  run('r_cccccccccccc', 'failed');
  row({ id: 'b_cccccccccccc', run: 'r_cccccccccccc', status: 'failed', finished: Date.now(), detail: 'the Unity build failed', fail_class: 'compile', fail_kind: 'code', fail_plain: 'The project\'s code doesn\'t build.', fail_log: 'a\nerror CS1002: ; expected', gen_job: 'j_old' });
  const api = { job: async () => { throw new Error('should not be asked'); }, bytes: async () => new Uint8Array() };
  const p = await V.buildPage('r_cccccccccccc', { api });
  assert.match(p!.builds[0].failure!.plain, /code doesn't build/);
  assert.match(p!.builds[0].log!.text, /CS1002/);
  assert.equal(p!.builds[0].progress, null);
});

test('Gen not knowing the job is said, not thrown; a run that is not a build is null', async () => {
  run('r_dddddddddddd');
  row({ id: 'b_dddddddddddd', run: 'r_dddddddddddd', status: 'building', gen_job: 'j_gone' });
  const api = { job: async () => { throw Object.assign(new Error('nope'), { status: 404 }); }, bytes: async () => new Uint8Array() };
  const p = await V.buildPage('r_dddddddddddd', { api });
  assert.match(p!.builds[0].logError!, /doesn't know job j_gone/);
  db.prepare("INSERT INTO runs (id, kind, status, products, options, started) VALUES ('r_eeeeeeeeeeee', 'daily', 'done', '[]', '{}', 1)").run();
  assert.equal(await V.buildPage('r_eeeeeeeeeeee', { api }), null);
});

test('the route exists and the dashboard links to it', () => {
  assert.match(fs.readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'), /runs\\\/\(r_\[0-9a-f\]\+\)\\\/build\$/);
  assert.match(fs.readFileSync(new URL('../dashboard/activity.js', import.meta.url), 'utf8'), /data-build-open/);
  assert.match(fs.readFileSync(new URL('../dashboard/buildfail.js', import.meta.url), 'utf8'), /\/api\/runs\/\$\{encodeURIComponent\(run\)\}\/build/);
});

test('a failed or stopped build has a Restart build button: the same request as Build, and the new run is linked', () => {
  const src = fs.readFileSync(new URL('../dashboard/buildfail.js', import.meta.url), 'utf8');
  // Shown for failed and cancelled builds on the build page (Activity's "build page · logs" and the Runs tab open it).
  assert.match(src, /b\.state === 'failed' \|\| b\.state === 'cancelled'[\s\S]{0,300}data-bf-restart/);
  // The click posts to the route Build and Retry use (builds.ts handleBuildRoutes → startBuild at beta's current commit).
  assert.match(src, /\[data-bf-restart\][\s\S]{0,900}\/api\/projects\/\$\{encodeURIComponent\(p\)\}\/builds`, \{ method: 'POST', body: \{ build \} \}/);
  // It confirms what it started and links to the new run; the note survives the page's redraws.
  assert.match(src, /Started a new \$\{esc\(restarted\.build\)\} build[\s\S]{0,200}data-build-open="\$\{esc\(restarted\.run\)\}"/);
  assert.match(src, /let restarted = null/);
});
