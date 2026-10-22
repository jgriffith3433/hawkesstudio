// Videos (videos.ts): a script becomes a planned roadmap task of kind video; versions come from the agent's
// .hawkes/video.json (a repeated asset isn't a new one); a video's change is never the PM's to merge; notes while
// nothing waits for J are kept, not lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-videos-'));
const v = await import('../src/videos.ts');
const rm = await import('../src/roadmap.ts');
const { reviewable } = await import('../src/pm.ts');

test('a script becomes a planned video task with the script in its request and thread', () => {
  const t = v.createVideo({ product: 'doseofdestruction', title: 'Exit Punk is late', script: 'EXIT PUNK: Nobody booked me. I booked me.\nSUSAN: You are on in thirty seconds.', format: 'short' });
  assert.equal(t.kind, 'video');
  assert.equal(t.status, 'planned');
  assert.match(t.request, /Nobody booked me/);
  assert.match(t.request, /video skill/);
  assert.equal(rm.getItem(t.item)!.title, 'Video: Exit Punk is late'); // consumed (done) once it has its task, which still runs
  assert.ok(rm.commentsOn(t.id).some((m: any) => m.kind === 'script'));
  assert.ok(v.isVideoTask(t.id));
  assert.throws(() => v.createVideo({ product: 'doseofdestruction', title: 'x', script: ' ' }), /script/);
  assert.throws(() => v.createVideo({ product: 'doseofdestruction', title: 'x', script: 'a', format: 'square' }), /format/);
  assert.throws(() => rm.addTask({ item: t.item, request: 'x', kind: 'podcast' }), /kind/);
});

test('versions come from .hawkes/video.json; the same asset twice is one version', () => {
  const t = v.createVideo({ product: 'sickofit', title: 'Yooba sells a shovel', script: 'YOOBA: It is a good shovel.' });
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  assert.equal(v.readVideoFile(wt), null, 'none left');
  fs.mkdirSync(path.join(wt, '.hawkes'));
  fs.writeFileSync(path.join(wt, '.hawkes', 'video.json'), JSON.stringify({ asset: 'not-an-asset' }));
  assert.equal(v.readVideoFile(wt), null, 'not a Gen asset');
  fs.writeFileSync(path.join(wt, '.hawkes', 'video.json'), JSON.stringify({ asset: 'a_0123456789abcdef', poster: 'nope', seconds: '31.5', summary: 'first cut' }));
  const f = v.readVideoFile(wt)!;
  assert.deepEqual([f.asset, f.poster, f.seconds], ['a_0123456789abcdef', undefined, 31.5]);
  assert.equal(v.recordVersion(t.id, 'c_000000000001', f as any)!.n, 1);
  assert.equal(v.recordVersion(t.id, 'c_000000000001', f as any), null, 'the same cut again');
  assert.equal(v.recordVersion(t.id, 'c_000000000001', { ...f, asset: 'a_fedcba9876543210' })!.n, 2);
  assert.deepEqual(v.versionsOf(t.id).map((x) => x.n), [1, 2]);
});

test("a video's ready change is J's to screen, never the PM's to merge", () => {
  const t = v.createVideo({ product: 'doseofdestruction', title: 'Rivals', script: 'SLICE: Again?' });
  const base = { status: 'ready', infra: false, auto_merge: null, created: Date.now() + 60_000, findings: [], request: 'x', pm_escalated: null };
  assert.equal(reviewable({ ...base, task: t.id }), false);
  assert.equal(v.isVideoChange({ task: t.id }), true);
  assert.equal(v.isVideoChange({ task: null }), false);
});

test('a note with nothing waiting for J is kept for the next pass, stamped with where he was', async () => {
  const t = v.createVideo({ product: 'doseofdestruction', title: 'Notes', script: 'TT: Hi.' });
  const r = await v.noteVideo(t.id, 'The voice is too slow', { at: 72.4, version: 2 });
  assert.equal(r.sent, false);
  assert.equal(r.queued, true);
  assert.ok(rm.commentsOn(t.id).some((m: any) => m.kind === 'note' && m.text === '[v2 at 1:12] The voice is too slow'));
  await assert.rejects(v.noteVideo(t.id, '  '), /Say what/);
  await assert.rejects(v.approveVideo(t.id), /no version waiting/);
});

test('never on Studio or Gen themselves (their merges deploy)', () => {
  assert.throws(() => v.createVideo({ product: 'hawkesgen', title: 'x', script: 'a' }), /belong to a product/);
});

test('every video gets a priced GPU budget (no "No GPU" lock)', () => {
  const g = v.createVideo({ product: 'phorigins', title: 'The Train', script: 'PIERCE: There he is.' });
  assert.ok(g.gpu?.items?.some((i: any) => i.tool === 'blender.render'));
  assert.match(g.request, /beat sheet/);
});

test("Studio's review: the craft bar and the beat sheet go to Claude; silences are read from ffmpeg", () => {
  const t = v.createVideo({ product: 'doseofdestruction', title: 'Review me', script: 'TT: Hi.' });
  const base = { id: 'vv_x', task: t.id, n: 1, change: null, asset: 'a_0123456789abcdef', poster: null, seconds: 20, summary: 'first cut', caption: null, at: 0, review: null };
  const none = v.reviewPrompt(t, { ...base, beats: null }, { seconds: 20, frames: 20, perSheet: 8, silences: [], jNotes: [] });
  assert.match(none, /no beat sheet, which is itself a failure/);
  assert.match(none, /reaction/i);
  const withBeats = v.reviewPrompt(t, { ...base, beats: [{ t: 0, seconds: 1, shot: 'CU' }] }, { seconds: 20, frames: 20, perSheet: 8, silences: [{ start: 3, seconds: 1.2 }], jNotes: ['[v1 at 0:03] too slow'] });
  assert.match(withBeats, /"shot":"CU"/);
  assert.match(withBeats, /3\.0 s for 1\.2 s/);
  assert.match(withBeats, /too slow/);
  assert.deepEqual(v.silenceOf('[silencedetect] silence_start: 3.5\n[silencedetect] silence_end: 4.9 | silence_duration: 1.4\n'), [{ start: 3.5, seconds: 1.4 }]);
});

test("the agent's cut can be a file in its worktree (Studio puts it into Gen); never outside it", () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  fs.mkdirSync(path.join(wt, '.hawkes'));
  fs.mkdirSync(path.join(wt, 'videos', 'x', 'out'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'videos', 'x', 'out', 'cut.mp4'), 'video bytes');
  fs.writeFileSync(path.join(wt, 'videos', 'x', 'out', 'poster.png'), 'png bytes');
  const write = (o: any) => fs.writeFileSync(path.join(wt, '.hawkes', 'video.json'), JSON.stringify(o));
  write({ file: 'videos/x/out/cut.mp4', poster: 'videos/x/out/poster.png', seconds: 21.6 });
  const f = v.readVideoFile(wt)!;
  assert.deepEqual([f.asset, f.file, f.posterFile], [undefined, 'videos/x/out/cut.mp4', 'videos/x/out/poster.png']);
  write({ asset: 'videos/x/out/cut.mp4' });
  assert.equal(v.readVideoFile(wt)!.file, 'videos/x/out/cut.mp4', 'a path in "asset" works too');
  for (const bad of ['../outside.mp4', '/etc/passwd.mp4', 'videos/x/out/missing.mp4', 'videos/x/out/poster.png']) {
    write({ file: bad });
    assert.equal(v.readVideoFile(wt), null, bad);
  }
});
