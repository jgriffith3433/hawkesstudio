// Phone load budget (src/phoneperf.ts; rubric phone-load): MB / seconds / fps p5 under 4x CPU + Slow 4G,
// findings that name the five largest pre-gameplay assets or the fps dip time, and the report lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-phoneperf-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.mkdirSync(path.join(process.env.STUDIO_PROJECTS, 'pgame'), { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'pgame', name: 'Phone Game', framing: 'test', engine: 'web', repo: 'pgame', site: 'pgame', live: 'https://pgame.example/',
  local: { serve: 'static', dir: 'pgame', port: 8799, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
}] }));

const P = await import('../src/phoneperf.ts');
const q = await import('../src/quality.ts');
const game = { id: 'pgame', engine: 'web', kind: undefined } as any;

const heavy = {
  device: 'phone', software: false, loadSeconds: 6, seconds: 90,
  fps: { average: 28, worst: 12, p5: 18 },
  phone: {
    throttling: { cpu: 4, network: 'slow-4g', dpr: 2 },
    mbBeforeGameplay: 34.5,
    secondsToGameplay: 28,
    fpsP5: 18,
    fpsDipAt: 41.2,
    assets: [
      { url: 'https://cdn.example/Game/build.wasm', bytes: 12_000_000, path: '/Game/build.wasm' },
      { url: 'https://cdn.example/Game/build.data', bytes: 9_500_000, path: '/Game/build.data' },
      { url: 'https://cdn.example/Game/tex/atlas.png', bytes: 4_200_000, path: '/Game/tex/atlas.png' },
      { url: 'https://cdn.example/Game/audio/bgm.mp3', bytes: 3_100_000, path: '/Game/audio/bgm.mp3' },
      { url: 'https://cdn.example/Game/build.js', bytes: 2_800_000, path: '/Game/build.js' },
      { url: 'https://cdn.example/Game/icon.png', bytes: 40_000, path: '/Game/icon.png' },
    ],
  },
  events: [{ t: 28, type: 'milestone', detail: 'gameplay' }],
};

test('phonePerfOf reads Gen\'s phone block: MB, seconds, fps p5, dip time and assets', () => {
  const f = P.phonePerfOf(heavy)!;
  assert.equal(f.device, 'phone');
  assert.equal(f.throttled, true);
  assert.deepEqual(f.throttling, { cpu: 4, network: 'slow-4g', dpr: 2 });
  assert.equal(f.mbBeforeGameplay, 34.5);
  assert.equal(f.secondsToGameplay, 28);
  assert.equal(f.fpsP5, 18);
  assert.equal(f.fpsDipAt, 41.2);
  assert.equal(f.assets[0].path, '/Game/build.wasm');
  assert.equal(f.assets.length, 6);
});

test('enrichPhonePerf puts phone.* metrics on a phone play and leaves desktop alone', () => {
  const r = P.enrichPhonePerf(heavy, 'phone');
  assert.ok(r.phone);
  assert.equal(r.metrics!['phone.mbBeforeGameplay'], 34.5);
  assert.equal(r.metrics!['phone.secondsToGameplay'], 28);
  assert.equal(r.metrics!['phone.fpsP5'], 18);
  const deskIn = { device: 'desktop', fps: { average: 60, p5: 55 }, loadSeconds: 2 };
  const desk = P.enrichPhonePerf(deskIn, 'desktop');
  assert.equal(desk.metrics?.['phone.mbBeforeGameplay'], undefined);
  assert.equal(desk.phone, undefined);
  assert.equal(desk, deskIn, 'desktop results are returned unchanged');
});

test('a phone play over the load or fps budget fails the phone-load rule', () => {
  const r = P.enrichPhonePerf(heavy, 'phone');
  const g = q.qualityGate(game, { metrics: r.metrics });
  const ids = g.fails.map((x) => x.check).sort();
  assert.deepEqual(ids, ['phone-fps-p5', 'phone-load-mb', 'phone-load-time']);
  assert.ok(g.fails.find((x) => x.check === 'phone-load-mb')!.evidence.includes('phone.mbBeforeGameplay = 34.5'));
});

test('phonePerfFindings names the five largest assets and the fps dip clip time', () => {
  const r = P.enrichPhonePerf(heavy, 'phone');
  const findings = P.phonePerfFindings(r, { scenario: 'smoke' });
  assert.equal(findings.length, 2);
  const load = findings.find((f) => /load budget/i.test(f.title))!;
  assert.match(load.detail, /build\.wasm/);
  assert.match(load.detail, /build\.data/);
  assert.match(load.detail, /atlas\.png/);
  assert.match(load.detail, /bgm\.mp3/);
  assert.match(load.detail, /build\.js/);
  assert.doesNotMatch(load.detail, /icon\.png/, 'only the five largest');
  const fps = findings.find((f) => /fps p5/i.test(f.title))!;
  assert.match(fps.detail, /41\.2 s/);
  assert.equal(fps.area, 'performance');
});

test('a clean phone play passes, and missing readings are optional (not unmeasured)', () => {
  const good = P.enrichPhonePerf({
    device: 'phone',
    phone: { throttling: { cpu: 4, network: 'slow-4g', dpr: 2 }, mbBeforeGameplay: 8.2, secondsToGameplay: 9, fpsP5: 42, fpsDipAt: null, assets: [] },
    fps: { average: 48, worst: 40, p5: 42 },
  }, 'phone');
  assert.equal(q.qualityGate(game, { metrics: good.metrics }).fails.length, 0);
  assert.equal(P.phonePerfFindings(good, { scenario: 'smoke' }).length, 0);
  const empty = q.qualityGate(game, { metrics: {} });
  assert.equal(empty.fails.filter((f) => f.check.startsWith('phone-')).length, 0);
  assert.deepEqual(empty.unmeasured.filter((u) => u.startsWith('phone-')), []);
});

test('software rendering drops fps p5; seconds still fall back to the gameplay milestone', () => {
  const soft = P.enrichPhonePerf({
    device: 'phone', software: true, loadSeconds: 12,
    fps: { average: 4, worst: 1, p5: 2 },
    events: [{ t: 7.5, type: 'milestone', detail: 'gameplay' }],
  }, 'phone');
  assert.equal(soft.phone!.fpsP5, null);
  assert.equal(soft.metrics!['phone.fpsP5'], undefined);
  assert.equal(soft.phone!.secondsToGameplay, 7.5);
  assert.equal(P.secondsToGameplayOf({ events: [{ t: 3, type: 'milestone', detail: 'gameplay' }] }), 3);
});

test('the report lines name MB, seconds, fps, throttle and the largest assets on a miss', () => {
  const lines = P.phonePerfLines(P.phonePerfOf(heavy)!, { name: 'smoke@local:phone' }).join('\n');
  assert.match(lines, /34\.5 MB before gameplay \(limit 20\)/);
  assert.match(lines, /28 s to gameplay \(limit 20 s\)/);
  assert.match(lines, /fps p5 18 \(limit 30\)/);
  assert.match(lines, /4x CPU/);
  assert.match(lines, /slow-4g/);
  assert.match(lines, /build\.wasm/);
});

test('the rubric has phone-load and a game can move a limit with tuning', () => {
  const rule = q.baseRules().find((x) => x.id === 'phone-load');
  assert.ok(rule);
  assert.ok(rule!.checks.some((c) => c.id === 'phone-load-mb' && c.max === 20));
  assert.ok(rule!.checks.some((c) => c.id === 'phone-fps-p5' && c.min === 30));
  const g = q.qualityGate({ ...game, tuning: { 'phone.mbBeforeGameplay': { max: 40 } } }, { metrics: { 'phone.mbBeforeGameplay': 34.5, 'phone.secondsToGameplay': 10, 'phone.fpsP5': 40 } });
  assert.equal(g.fails.length, 0);
});

test('Unity projects are judged on 20 MB and 60 s; web keeps 20 s', () => {
  const unity = { id: 'pgame', engine: 'unity', kind: undefined } as any;
  const run = (mb: number, s: number) => ({ device: 'phone', loadSeconds: s, phone: { throttling: { cpu: 4, network: 'slow-4g', dpr: 2 }, mbBeforeGameplay: mb, secondsToGameplay: s, fpsP5: 40, assets: [] }, metrics: { 'phone.mbBeforeGameplay': mb, 'phone.secondsToGameplay': s, 'ftue.secondsToGameplay': s } });
  const ok = run(19.7, 55);
  assert.deepEqual(P.phonePerfFindings(ok, { scenario: 'first-five', product: unity }), []);
  const g = q.qualityGate(unity, { metrics: ok.metrics });
  assert.deepEqual(g.fails.filter((f) => f.rule === 'phone-load' || f.check.startsWith('first-five-gameplay')), []);
  const bad = P.phonePerfFindings(run(19.7, 103), { scenario: 'first-five', product: unity });
  assert.equal(bad.length, 1);
  assert.match(bad[0].title, /\(limit 60 s\)/);
  const both = P.phonePerfFindings(run(25, 103), { scenario: 'first-five', product: unity });
  assert.match(both[0].title, /\(limit 20 MB\)/);
  const web = P.phonePerfFindings(run(10, 25), { scenario: 'first-five', product: game });
  assert.match(web[0].title, /\(limit 20 s\)/);
  const f = q.qualityFindings(unity, run(19.7, 103), 'first-five').find((x) => x.title.includes('first-five-gameplay'));
  assert.match(f!.detail, /at most 60/);
  assert.doesNotMatch(f!.detail, /at most 20\b/);
  assert.equal(P.phoneLimitsFor({ engine: 'unity', tuning: { 'phone.secondsToGameplay': { max: 45 } } }).secondsToGameplay, 45);
});
