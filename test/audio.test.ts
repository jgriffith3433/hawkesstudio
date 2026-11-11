import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-audio-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });

const {
  parseEbur128, audioMetricsFromEvents, audioEventsOf, audioFindings, audioTimelineSummary, enrichAudio, measureLoudness,
} = await import('../src/audio.ts');
const { qualityGate, baseRules } = await import('../src/quality.ts');

const ff = spawnSync('ffmpeg', ['-version']).status === 0;

test('parseEbur128 reads integrated LUFS and true peak', () => {
  const log = `
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -18.4 LUFS
    Threshold: -28.4 LUFS

  Loudness range:
    LRA:         5.2 LU
  True peak:
    Peak:       -1.2 dBFS
`;
  const r = parseEbur128(log);
  assert.equal(r.lufsIntegrated, -18.4);
  assert.equal(r.truePeakDb, -1.2);
});

test('silent action within 150 ms is counted with its time; a sound after clears it', () => {
  const silent = audioMetricsFromEvents([
    { type: 'input', t: 1.0, action: 'jump' },
    { type: 'sound-start', t: 1.2, sample: 'land', bus: 'sfx' }, // 200 ms later: too late
  ]);
  assert.equal(silent.metrics['audio.silentActions'], 1);
  assert.equal(silent.silentList[0].action, 'jump');
  assert.equal(silent.silentList[0].t, 1);

  const ok = audioMetricsFromEvents([
    { type: 'input', t: 1.0, action: 'jump' },
    { type: 'sound-start', t: 1.05, sample: 'jump', bus: 'sfx' },
  ]);
  assert.equal(ok.metrics['audio.silentActions'], 0);
});

test('identical sample+rate within 60 s is counted; different rate is not', () => {
  const same = audioMetricsFromEvents([
    { type: 'sound-start', t: 1, sample: 'foot', bus: 'sfx', rate: 1 },
    { type: 'sound-start', t: 2, sample: 'foot', bus: 'sfx', rate: 1 },
  ]);
  assert.equal(same.metrics['audio.identicalRepeats60s'], 1);

  const pitched = audioMetricsFromEvents([
    { type: 'sound-start', t: 1, sample: 'foot', bus: 'sfx', rate: 1 },
    { type: 'sound-start', t: 2, sample: 'foot', bus: 'sfx', rate: 1.05 },
  ]);
  assert.equal(pitched.metrics['audio.identicalRepeats60s'], 0);
});

test('voiceDuckDb is omitted without voice, and measured when music ducks under voice', () => {
  const quiet = audioMetricsFromEvents([
    { type: 'sound-start', t: 1, sample: 'bgm', bus: 'music', gain: 1 },
  ]);
  assert.equal(quiet.metrics['audio.voiceDuckDb'], undefined);

  const ducked = audioMetricsFromEvents([
    { type: 'sound-start', t: 1, sample: 'bgm', bus: 'music', gain: 0.25 },
    { type: 'sound-start', t: 1.1, sample: 'line', bus: 'voice', gain: 1 },
  ]);
  assert.ok(ducked.metrics['audio.voiceDuckDb']! >= 6);
});

test('audioFindings names the silent action and identical repeat with their times', () => {
  const r = enrichAudio({
    seconds: 5,
    events: [
      { type: 'input', t: 1, detail: JSON.stringify({ type: 'input', t: 1, action: 'jump' }) },
      { type: 'sound-start', t: 2, detail: JSON.stringify({ type: 'sound-start', t: 2, sample: 'foot', bus: 'sfx', rate: 1 }) },
      { type: 'sound-start', t: 3, detail: JSON.stringify({ type: 'sound-start', t: 3, sample: 'foot', bus: 'sfx', rate: 1 }) },
    ],
  });
  const findings = audioFindings(r, { scenario: 'smoke' });
  assert.ok(findings.some((f) => /Silent action: jump at 1/.test(f.title)), JSON.stringify(findings.map((f) => f.title)));
  assert.ok(findings.some((f) => /Identical repeat: foot at 3/.test(f.title)), JSON.stringify(findings.map((f) => f.title)));
});

test('enrichAudio lists the four report keys when the probe ran', () => {
  const r = enrichAudio({
    events: [
      { type: 'audio-sensor', detail: '{"adapter":"webaudio"}' },
      { type: 'input', t: 0.5, detail: JSON.stringify({ type: 'input', t: 0.5, action: 'tap' }) },
      { type: 'audiocontext-resume', t: 0.5, detail: JSON.stringify({ type: 'audiocontext-resume', t: 0.5, how: 'first-tap' }) },
      { type: 'sound-start', t: 0.55, detail: JSON.stringify({ type: 'sound-start', t: 0.55, sample: 'click', bus: 'ui' }) },
    ],
  });
  for (const k of ['audio.lufsIntegrated', 'audio.truePeakDb', 'audio.longestSilenceS', 'audio.silentActions']) {
    assert.ok(k in r.metrics, k);
  }
  assert.equal(r.metrics['audio.silentActions'], 0);
  assert.equal(r._audioResumes.length, 1);
  assert.equal(r._audioResumes[0].how, 'first-tap');
});

test('audioTimelineSummary is plain text a review can quote', () => {
  const s = audioTimelineSummary({
    metrics: { 'audio.lufsIntegrated': -18, 'audio.truePeakDb': -1.5, 'audio.longestSilenceS': 2, 'audio.silentActions': 0 },
    audio: [
      { type: 'input', t: 1, action: 'jump' },
      { type: 'sound-start', t: 1.05, sample: 'jump', bus: 'sfx', rate: 1 },
    ],
  });
  assert.match(s, /audio\.lufsIntegrated=-18/);
  assert.match(s, /1s input jump/);
  assert.match(s, /1\.05s sound jump/);
});

test('sound-design rule is in the rubric and qualityGate fails silent actions', () => {
  assert.ok(baseRules().some((r) => r.id === 'sound-design'));
  const game = { id: 'demo', engine: 'web' as const, kind: 'game' as const };
  const g = qualityGate(game, {
    metrics: {
      'audio.silentActions': 1,
      'audio.identicalRepeats60s': 0,
      'audio.longestSilenceS': 2,
    },
  });
  assert.ok(g.fails.some((f) => f.check === 'silent-actions'), JSON.stringify(g.fails));
});

test('measureLoudness runs ebur128 on a short tone', { skip: !ff && 'ffmpeg missing' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ebur-'));
  const file = path.join(dir, 'tone.wav');
  try {
    // ~ -18 LUFS-ish sine, short.
    const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-af', 'volume=-18dB', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const loud = measureLoudness(file);
    assert.ok(loud.lufsIntegrated != null && Number.isFinite(loud.lufsIntegrated), String(loud.lufsIntegrated));
    assert.ok(loud.truePeakDb != null && Number.isFinite(loud.truePeakDb), String(loud.truePeakDb));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audioEventsOf dedupes report events and the audio array', () => {
  const ev = audioEventsOf({
    events: [{ type: 'sound-start', t: 1, detail: JSON.stringify({ type: 'sound-start', t: 1, sample: 'a', id: 'aud-1' }) }],
    audio: [{ type: 'sound-start', t: 1, sample: 'a', id: 'aud-1' }],
  });
  assert.equal(ev.length, 1);
});
