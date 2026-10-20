import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-onair-'));
const { patchQuality, qualityFrom, encodeOf, encodeKey, readEncoder, readLive, updateLive, onAirNow, QUALITY_DEFAULT } = await import('../src/onair.ts');

test('quality: presets, single fields, and bad values refused', () => {
  const smooth = patchQuality(QUALITY_DEFAULT, { preset: 'smooth' });
  assert.equal(smooth.resolution, '720p60');
  const custom = patchQuality(smooth, { videoKbps: 3000, audioKbps: 160, rehearsal: true });
  assert.deepEqual([custom.videoKbps, custom.audioKbps, custom.rehearsal, custom.resolution], [3000, 160, true, '720p60']);
  assert.throws(() => patchQuality(QUALITY_DEFAULT, { videoKbps: 20000 }), /500 to 8000/);
  assert.throws(() => patchQuality(QUALITY_DEFAULT, { resolution: '4k' }), /resolution/);
  assert.throws(() => patchQuality(QUALITY_DEFAULT, { x264: 'placebo' }), /x264/);
  assert.throws(() => patchQuality(QUALITY_DEFAULT, { preset: 'nope' }), /preset/);
  // A stored quality with one bad field keeps the rest.
  const q = qualityFrom({ resolution: '480p30', videoKbps: 'lots' });
  assert.equal(q.resolution, '480p30');
  assert.equal(q.videoKbps, QUALITY_DEFAULT.videoKbps);
});

test('encode settings: keyframes in frames, the size from the resolution', () => {
  const e = encodeOf(patchQuality(QUALITY_DEFAULT, { resolution: '720p60', keyframeSec: 2 }));
  assert.deepEqual([e.width, e.height, e.fps, e.gop], [1280, 720, 60, 120]);
  assert.equal(encodeKey(e), '1280x720@60 4500k veryfast g120 a128k');
  assert.match(encodeKey({ ...e, rehearsal: true }), / rehearsal$/);
});

test('the switch: on and off are remembered with who and when; quality survives', () => {
  assert.equal(readLive().on, false);
  const on = updateLive({ on: true, quality: { preset: 'light' } }, 'j@example.com');
  assert.equal(on.on, true);
  assert.equal(on.by, 'j@example.com');
  assert.ok(on.since > 0);
  const off = updateLive({ on: false });
  assert.equal(off.on, false);
  assert.equal(readLive().quality.resolution, '720p30');
  assert.throws(() => updateLive({ quality: { audioKbps: 64 } }), /audioKbps/);
});

test('the encoder: no file or a stale one is down; a fresh one is read, the ingest never shown', () => {
  const file = path.join(process.env.STUDIO_DATA!, 'enc.json');
  assert.equal(readEncoder(Date.now(), file).state, 'down');
  fs.writeFileSync(file, JSON.stringify({ state: 'live', at: 1_000, since: 500, fps: 30, kbps: 4400, dropped: 2, speed: 1, note: 'went to rtmp://live.twitch.tv/app/live_123' }));
  assert.equal(readEncoder(1_000 + 60_000, file).state, 'down');
  const e = readEncoder(2_000, file);
  assert.equal(e.state, 'live');
  assert.equal(e.fps, 30);
  assert.doesNotMatch(e.note, /live_123|rtmp/);
});

test('onAirNow: a quality change on a live stream shows as pending', () => {
  updateLive({ on: true, quality: { preset: 'standard' } });
  const air = onAirNow();
  assert.equal(air.on, true);
  assert.equal(air.encoder.state, 'down');
  assert.equal(air.pending, false);
  assert.ok(air.presets.standard);
  updateLive({ on: false });
});
