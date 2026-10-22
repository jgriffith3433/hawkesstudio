// The edit (video-edit.ts): the agent's cut as video.compose's timeline with Gen assets; shots on the timeline; the
// plain edits Studio makes itself (cut a range out, speed it up, punch or push in) and what they do to the voice lines
// and captions after them; the compose job it renders with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEdit, shotsOf, shotsIn, beatsIn, applyEdit, composeParams, lengthOf, editFromCut } from '../src/video-edit.ts';

const A = 'a_1111111111111111', B = 'a_2222222222222222', C = 'a_3333333333333333', VO = 'a_4444444444444444', MUSIC = 'a_5555555555555555';
const edit = () => readEdit({
  width: 1080, height: 1920, fps: 24,
  clips: [{ asset: A, in: 1, out: 4, beat: 'hook' }, { asset: B, out: 2, beat: 'hi' }, { asset: C, in: 0.5, out: 5.5, beat: 'bye' }],
  audio: [{ asset: VO, start: 3.2, seconds: 1.5, dialogue: true, label: 'TT: Hi.' }, { asset: VO, start: 6, in: 2, seconds: 2, dialogue: true, label: 'SLICE: Bye.' }, { asset: MUSIC, start: 0, seconds: 10, volume: 0.3, duck: true }],
  captions: [{ text: 'Hi.', start: 3.2, end: 4.7 }, { text: 'Bye.', start: 6, end: 8 }],
})!;

test('readEdit keeps only Gen assets and absolute placements', () => {
  assert.equal(readEdit({ clips: [] }), null);
  assert.equal(readEdit({ clips: [{ asset: 'clip.mp4' }] }), null);
  assert.equal(readEdit({ clips: [{ asset: A }], audio: [{ asset: VO, clip: 0 }] }), null, 'a track placed by clip');
  const e = edit();
  assert.deepEqual([e.width, e.height, e.fps, e.clips.length, e.audio.length, e.captions.length], [1080, 1920, 24, 3, 3, 2]);
});

test('shots on the timeline; a range covers the shots and beats it touches', () => {
  const shots = shotsOf(edit());
  assert.deepEqual(shots.map((s) => [s.start, s.end, s.beat]), [[0, 3, 'hook'], [3, 5, 'hi'], [5, 10, 'bye']]);
  assert.equal(lengthOf(edit()), 10);
  assert.deepEqual(shotsIn(shots, 4, 6).map((s) => s.i), [1, 2]);
  assert.deepEqual(shotsIn(shots, 3, 5).map((s) => s.i), [1]);
  assert.deepEqual(beatsIn([{ t: 0, seconds: 3 }, { t: 3, seconds: 2 }], 2.5, 2.6).map((b) => b.i), [0]);
  // A crossfade overlaps a clip into the next.
  const x = readEdit({ clips: [{ asset: A, out: 3, transition: 'crossfade', seconds: 1 }, { asset: B, out: 2 }] })!;
  assert.deepEqual(shotsOf(x).map((s) => [s.start, s.end]), [[0, 3], [2, 4]]);
});

test('cutting a range out splits the shots at its ends, closes the gap, and moves the lines and captions after it', () => {
  // Cut 0.5-2.5 s (inside the hook, before any line).
  const { edit: e, said } = applyEdit(edit(), { op: 'remove', from: 0.5, to: 2.5 });
  assert.match(said, /cut 0:00\.5-0:02\.5 out \(2\.0 s shorter\)/);
  assert.deepEqual(e.clips.map((c) => [c.asset, c.in ?? 0, c.out]), [[A, 1, 1.5], [A, 3.5, 4], [B, 0, 2], [C, 0.5, 5.5]]);
  assert.equal(lengthOf(e), 8);
  assert.deepEqual(e.audio.map((t) => t.start), [1.2, 4, 0], 'lines move up; the music under everything stays');
  assert.deepEqual(e.captions.map((c) => [c.start, c.end]), [[1.2, 2.7], [4, 6]]);
  // Half a voice line would be left playing: refused.
  assert.throws(() => applyEdit(edit(), { op: 'remove', from: 4, to: 5 }), /voice line \("TT: Hi\."\) runs across/);
  assert.throws(() => applyEdit(edit(), { op: 'remove', from: 0, to: 10 }), /whole video/);
  // An edge a hair from a cut snaps to it (no two-frame sliver of the next shot).
  assert.deepEqual(applyEdit(edit(), { op: 'remove', from: 0.5, to: 3.08 }).edit.clips.map((c) => [c.asset, c.in ?? 0, c.out]), [[A, 1, 1.5], [B, 0, 2], [C, 0.5, 5.5]]);
});

test("speeding a range up shortens it; under a voice line it is the agent's job", () => {
  const { edit: e, said } = applyEdit(edit(), { op: 'speed', from: 0, to: 3, factor: 1.5 });
  assert.match(said, /plays 1\.5x \(1\.0 s shorter\)/);
  assert.equal(e.clips[0].speed, 1.5);
  assert.equal(lengthOf(e), 9);
  assert.deepEqual(e.audio.map((t) => t.start), [2.2, 5, 0]);
  assert.throws(() => applyEdit(edit(), { op: 'speed', from: 3, to: 5, factor: 2 }), /voice line plays there/);
});

test('a punch-in or push-in on part of the cut, aimed at a point', () => {
  const { edit: e } = applyEdit(edit(), { op: 'zoom', from: 5, to: 7, zoom: 1.6, x: 0.5, y: 0.25, push: true });
  assert.deepEqual(e.clips.map((c) => [c.asset, c.in ?? 0, c.out, c.zoom?.from, c.zoom?.to]), [[A, 1, 4, undefined, undefined], [B, 0, 2, undefined, undefined], [C, 0.5, 2.5, 1, 1.6], [C, 2.5, 5.5, undefined, undefined]]);
  assert.deepEqual(e.clips[2].zoom, { from: 1, to: 1.6, x: 0.5, y: 0.25 });
  assert.equal(lengthOf(e), 10);
});

test('the compose job: each asset once, indexes into the inputs, burned captions', () => {
  const { inputs, params } = composeParams(applyEdit(edit(), { op: 'remove', from: 0.5, to: 2.5 }).edit);
  assert.deepEqual(inputs, { clips: [`asset:${A}`, `asset:${B}`, `asset:${C}`], audio: [`asset:${VO}`, `asset:${MUSIC}`] });
  assert.deepEqual(params.timeline.clips.map((c: any) => c.clip), [0, 0, 1, 2]);
  assert.deepEqual(params.timeline.audio.map((t: any) => t.audio), [0, 0, 1]);
  assert.equal(params.captions, 'both');
  assert.deepEqual([params.width, params.height, params.fit], [1080, 1920, 'crop']);
});

test('a cut handed over without an edit becomes one, split where its beats start; plain edits work on it', () => {
  const e = editFromCut(A, [{ t: 0, seconds: 2, shot: 'WS', key: 'hook', action: 'skates in' }, { t: 2, seconds: 3, shot: 'CU', key: 'hi', line: 'Hi.' }, { t: 5, seconds: 9, key: 'late' }, { t: 30 }], 8, { width: 1920, height: 1080, fps: 24 })!;
  assert.equal(e.derived, true);
  assert.deepEqual(e.clips.map((c) => [c.in, c.out, c.beat]), [[0, 2, 'hook'], [2, 5, 'hi'], [5, 8, 'late']]);
  assert.equal(e.clips[1].label, 'CU Hi.');
  assert.equal(lengthOf(e), 8);
  assert.deepEqual(applyEdit(e, { op: 'remove', from: 2, to: 5 }).edit.clips.map((c) => [c.in, c.out]), [[0, 2], [5, 8]]);
  assert.equal(composeParams(e).params.captions, 'vtt', 'the captions are already in the picture');
  assert.equal(editFromCut('nope', [], 8, { width: 1, height: 1, fps: 24 }), null);
  assert.equal(editFromCut(A, null, 6, { width: 1080, height: 1920, fps: 24 })!.clips.length, 1);
});
