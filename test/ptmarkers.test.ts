// dashboard/ptmarkers.js: where findings and events sit on the playtest viewer's scrubber.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ctx: any = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'ptmarkers.js'), 'utf8') + '\nthis.api = { ptFindingTime, ptEventTone, ptMarkers, ptShotIndexAt, ptNearest };', ctx);
const { ptFindingTime, ptEventTone, ptMarkers, ptShotIndexAt, ptNearest } = ctx.api;

const shots = [{ t: 2, asset: 'a_1' }, { t: 10, asset: 'a_2' }, { t: 30, asset: 'a_3' }];

test('a finding uses its own time, else its screenshot\'s time', () => {
  assert.equal(ptFindingTime({ t: 7.5, shots: ['a_3'] }, shots), 7.5);
  assert.equal(ptFindingTime({ shots: ['a_3', 'a_2'] }, shots), 10);
  assert.equal(ptFindingTime({ evidence: [2] }, shots), 30);
  assert.equal(ptFindingTime({ shots: ['a_missing'] }, shots), null);
});

test('events read as pass or fail; starts and scenes are not marked', () => {
  assert.equal(ptEventTone({ type: 'pass:home' }), 'pass');
  assert.equal(ptEventTone({ type: 'tab-failed', detail: 'x' }), 'fail');
  assert.equal(ptEventTone({ type: 'end', detail: 'done' }), null);
  assert.equal(ptEventTone({ type: 'end', detail: 'lost' }), 'fail');
  assert.equal(ptEventTone({ type: 'start' }), null);
  assert.equal(ptEventTone({ type: 'scene', detail: 'won' }), null);
});

test('markers are sorted by time and untimed findings are kept apart', () => {
  const r = ptMarkers({
    findings: [{ title: 'b', severity: 'bug', shots: ['a_3'] }, { title: 'c', severity: 'polish' }, { title: 'a', severity: 'blocker', t: 1 }],
    events: [{ t: 5, type: 'pass:x' }, { t: 6, type: 'start' }],
    shots,
  });
  assert.equal(JSON.stringify(r.markers.map((m: any) => [m.kind, m.t])), JSON.stringify([['finding', 1], ['event', 5], ['finding', 30]]));
  assert.equal(JSON.stringify(r.untimed.map((m: any) => m.label)), '["c"]');
});

test('the strip follows the time; the nearest marker is found within reach', () => {
  assert.equal(ptShotIndexAt(shots, 0), 0);
  assert.equal(ptShotIndexAt(shots, 12), 1);
  assert.equal(ptShotIndexAt(shots, 99), 2);
  assert.equal(ptShotIndexAt([], 4), -1);
  const ms = [{ t: 3 }, { t: 5 }];
  assert.equal(ptNearest(ms, 4.4, 1).t, 5);
  assert.equal(ptNearest(ms, 20, 1), null);
});

test('report embeds use the viewer, keep no signed link, and markers are 44px touch targets', () => {
  const dash = (f: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', f), 'utf8');
  const app = dash('app.js'), pts = dash('playtests.js'), css = dash('style.css');
  assert.match(app, /class="pt-embed" data-step=/);
  assert.match(app, /ptHydrateEmbeds/);
  assert.match(app, /\/api\/playtests\/\$\{s\.id\}\/video/); // Studio's relay, never a signed Gen link
  assert.doesNotMatch(pts, /sig=|signFileLinks/);
  assert.match(css, /\.pt-mark \{[^}]*width: 44px; height: 44px/);
  assert.doesNotThrow(() => new vm.Script(pts));
});
