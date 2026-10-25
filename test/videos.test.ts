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
  assert.ok(rm.commentsOn(t.id).some((m: any) => m.kind === 'note' && m.text === '[v2 · at 1:12.4] The voice is too slow'));
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
  const base = { id: 'vv_x', task: t.id, n: 1, change: null, asset: 'a_0123456789abcdef', poster: null, seconds: 20, summary: 'first cut', caption: null, at: 0, review: null, stage: 'final' as const, story: null, edit: null, made_by: null };
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

test('videos take no product slot: several run beside each other and beside other work', async () => {
  const { noRoomFor, pickQueued } = await import('../src/agents.ts');
  const t = v.createVideo({ product: 'doseofdestruction', title: 'Lane', script: 'TT: Hi.' });
  assert.equal(noRoomFor('doseofdestruction', { task: t.id, text: t.title }, 'queued,working,verifying,revising,ready'), null);
  // Lanes as pump() gives them: each video is its own; the product's own limit still holds for the rest.
  const picks = pickQueued([{ id: 'c_v1', product: 'video:c_v1' }, { id: 'c_v2', product: 'video:c_v2' }, { id: 'c_code', product: 'doseofdestruction' }], ['doseofdestruction'], 5, { limit: () => 1 });
  assert.deepEqual(picks, ['c_v1', 'c_v2']);
});

test('an animatic first unless J turns it off; it keeps its stage and story, and its review judges story and staging, not polish', () => {
  assert.match(v.createVideo({ product: 'doseofdestruction', title: 'Straight', script: 'TT: Hi.', animatic: false }).request, /the final itself \(J turned the animatic off/);
  const t = v.createVideo({ product: 'doseofdestruction', title: 'Animatic', script: 'TT: Hi.' });
  assert.match(t.request, /then an animatic \(a rough draft/);
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  fs.mkdirSync(path.join(wt, '.hawkes'));
  fs.writeFileSync(path.join(wt, '.hawkes', 'video.json'), JSON.stringify({ asset: 'a_1111111111111111', stage: 'animatic', story: 'Logline: TT wants the last fry.' }));
  const f = v.readVideoFile(wt)!;
  assert.deepEqual([f.stage, f.story], ['animatic', 'Logline: TT wants the last fry.']);
  const rec = v.recordVersion(t.id, 'c_000000000009', f as any)!;
  assert.equal(v.versionsOf(t.id)[0].stage, 'animatic');
  const anim = v.reviewPrompt(t, rec, { seconds: 20, frames: 20, perSheet: 8, silences: [], jNotes: [] });
  assert.match(anim, /THIS IS THE ANIMATIC/);
  assert.match(anim, /TT wants the last fry/);
  assert.match(anim, /stitched together/);
  const noStory = v.reviewPrompt(t, { ...rec, stage: 'final', story: null }, { seconds: 20, frames: 20, perSheet: 8, silences: [], jNotes: [] });
  assert.doesNotMatch(noStory, /THIS IS THE ANIMATIC/);
  assert.match(noStory, /wrote no story, which is itself a failure/);
});

test("J's controls reach the agent's request, and the form's leftovers are left to the director", () => {
  const spec = v.readSpec({ seconds: '40', style: ' Pixar-like 3D ', engine: 'seedance', quality: 'high', captions: false, voices: '', engine2: 'x' });
  assert.deepEqual(spec, { seconds: 40, style: 'Pixar-like 3D', engine: 'seedance', quality: 'high', captions: false });
  const t = v.createVideo({ product: 'doseofdestruction', title: 'Controls', script: 'TT: Hi.', spec });
  assert.match(t.request, /## J's controls \(follow them\)/);
  assert.match(t.request, /Length: about 40 s/);
  assert.match(t.request, /Seedance 2\.5/);
  assert.match(t.request, /No burned-in captions/);
  assert.deepEqual(v.specOf(t.id), spec);
  assert.doesNotMatch(v.createVideo({ product: 'doseofdestruction', title: 'Plain', script: 'TT: Hi.' }).request, /J's controls/);
});

test('a note on a range names the shots and beats it covers; drafts wait and go to the agent together', async () => {
  const t = v.createVideo({ product: 'doseofdestruction', title: 'Timeline', script: 'TT: Hi.\nSLICE: Bye.' });
  const edit = { width: 1080, height: 1920, fps: 24, clips: [{ asset: 'a_1111111111111111', out: 3, beat: 'hook' }, { asset: 'a_2222222222222222', out: 2, beat: 'tt_hi' }, { asset: 'a_3333333333333333', out: 4, beat: 'slice_bye' }], audio: [], captions: [] };
  const beats = [{ t: 0, seconds: 3, shot: 'WS', key: 'hook', who: ['TT'] }, { t: 3, seconds: 2, shot: 'CU', key: 'tt_hi', who: ['TT'], line: 'Hi.' }, { t: 5, seconds: 4, shot: 'MCU', key: 'slice_bye', who: ['Slice'], line: 'Bye.' }];
  v.recordVersion(t.id, 'c_000000000077', { asset: 'a_9999999999999999', beats, edit } as any);
  const line = v.noteForAgent(t.id, { version: 1, from_s: 3.2, to_s: 6, action: 'lipsync', text: 'her mouth is late' });
  assert.match(line, /^\[v1 · 0:03\.2-0:06\.0 · edit clips 1, 2 · beats 1 "tt_hi" \(CU TT "Hi\."\); 2 "slice_bye" \(MCU Slice "Bye\."\)\] Fix the lip sync here/);
  assert.match(line, /J: "her mouth is late"$/);
  const d1 = await v.noteVideo(t.id, 'tighter', { from: 0, to: 3, action: 'shorter', hold: true });
  await v.noteVideo(t.id, '', { from: 5, action: 'reaction', hold: true });
  assert.ok(d1.draft);
  assert.equal(v.timelineNotes(t.id, 'draft').length, 2);
  assert.ok(!rm.commentsOn(t.id).some((m: any) => m.kind === 'note'), 'drafts are not sent');
  v.dropDraft(t.id, d1.draft!);
  const r = await v.sendDrafts(t.id, { text: 'and make it funnier' });
  assert.equal(r.notes, 2);
  assert.equal(v.timelineNotes(t.id, 'draft').length, 0);
  assert.equal(v.timelineNotes(t.id, 'sent').length, 1);
  const sent = rm.commentsOn(t.id).filter((m: any) => m.kind === 'note').map((m: any) => m.text);
  assert.match(sent[0], /^\[v1 · at 0:05\.0 · edit clip 2 · beat 2 "slice_bye".*Add a reaction here/);
  assert.equal(sent[1], 'and make it funnier');
  await assert.rejects(v.sendDrafts(t.id), /No notes/);
});

test('quick edits are for a version waiting for J that has an edit', async () => {
  const t = v.createVideo({ product: 'doseofdestruction', title: 'Quick', script: 'TT: Hi.' });
  await assert.rejects(v.quickEdit(t.id, { op: 'remove', from: 0, to: 1 }), /waiting for you/);
});

test('a redo follows a shot back to the generation that made it, through its finishing steps', async () => {
  const assets: Record<string, any> = { a_0000000000000a01: { job: 'j_up' }, a_0000000000000a02: { job: 'j_scene' }, a_0000000000000a03: { job: 'j_cut' } };
  const jobs: Record<string, any> = {
    j_up: { id: 'j_up', tool: 'video.upscale', inputs: { video: '/srv/hawkes/hawkesgen/.data/library/2026-10/a_0000000000000a02.mp4' } },
    j_scene: { id: 'j_scene', tool: 'video.scene', inputs: {} },
    j_cut: { id: 'j_cut', tool: 'video.compose', inputs: {} },
  };
  const plan = await v.retakePlan('a_0000000000000a01', async (id) => assets[id], async (id) => jobs[id]);
  assert.deepEqual(plan.steps.map((s) => s.tool), ['video.scene', 'video.upscale'], 'the generation first, then the upscale of the new take');
  await assert.rejects(v.retakePlan('a_0000000000000a03', async (id) => assets[id], async (id) => jobs[id]), /outside a Gen generation \(video\.compose\).*note/);
  await assert.rejects(v.retakePlan('a_0000000000000a09', async () => ({ tool: 'file.import' }), async () => null), /file\.import/);
  assert.equal(v.assetOfPath('/x/library/2026-10/a_0123456789abcdef.mp4'), 'a_0123456789abcdef');
  const t = v.createVideo({ product: 'doseofdestruction', title: 'Redo', script: 'TT: Hi.' });
  await assert.rejects(v.redoShots(t.id, { from: 1 }), /waiting for you/);
});

test('deleting a video drops its task and hides it from the list; dropped ones are hidden by default', async () => {
  const t = v.createVideo({ product: 'doseofdestruction', title: 'Delete me', script: 'TT: Bye.' });
  const keep = v.createVideo({ product: 'doseofdestruction', title: 'Keep me', script: 'TT: Hi.' });
  const ids = async (o?: { dropped?: boolean }) => (await v.listVideos(60, o)).map((x) => x.id);
  assert.ok((await ids()).includes(t.id));
  const r = await v.deleteVideo(t.id, { by: 'J' });
  assert.equal(r.deleted, t.id);
  assert.equal(rm.getTask(t.id)!.status, 'dropped');
  assert.ok(rm.commentsOn(t.id).some((m: any) => m.text === 'Deleted from the Videos tab.'));
  assert.ok(!(await ids()).includes(t.id), 'gone from the default list');
  assert.ok((await ids()).includes(keep.id), 'the others stay');
  const all = await v.listVideos(60, { dropped: true });
  assert.equal(all.find((x) => x.id === t.id)?.state, 'dropped', 'still there when asked for');
  assert.equal((await v.deleteVideo(t.id)).deleted, t.id, 'deleting twice is fine');
  assert.equal(rm.commentsOn(t.id).filter((m: any) => m.text === 'Deleted from the Videos tab.').length, 1);
  await assert.rejects(v.deleteVideo('k_000000000000'), /No video/);
  const plain = rm.addTask({ item: keep.item, request: 'not a video' });
  await assert.rejects(v.deleteVideo(plain.id), /No video/, 'only videos');
});

test('a video already dropped by hand is hidden by default too', async () => {
  const t = v.createVideo({ product: 'sickofit', title: 'Dropped by hand', script: 'YOOBA: No.' });
  rm.updateTask(t.id, { status: 'dropped' });
  assert.ok(!(await v.listVideos()).some((x) => x.id === t.id));
});

test("the critic's review (Gen video.review) becomes Studio's: scores kept, asks the timeline knows, its notes on the timeline", async () => {
  const t = v.createVideo({ product: 'doseofdestruction', title: 'Critic', script: 'TT: Hi.\nSLICE: Bye.' });
  const beats = [{ t: 0, seconds: 3, shot: 'WS', key: 'hook' }, { t: 3, seconds: 4, shot: 'CU', key: 'tt_hi', line: 'Hi.' }];
  const ver = v.recordVersion(t.id, 'c_000000000088', { asset: 'a_8888888888888888', beats, story: 'Logline: TT says hi.' } as any)!;
  assert.throws(() => v.fromCritic({ summary: 'no verdict' }), /no verdict/);
  const r = v.fromCritic({ pass: false, score: 4, summary: 'Stills with voices.', scores: { lipsync: 1, movement: 2.5, story: 7.5 }, experience: 'It drifts.', notes: [{ at: 3, to: 6.5, ask: 'lipsync', note: 'mouths are still' }, { at: 1, to: null, ask: 'made-up', note: 'odd' }, { at: 2, ask: 'cut', note: '' }] }, 'gemini-3.8-flash');
  assert.equal(r.critic, 'gemini');
  assert.equal(r.model, 'gemini-3.8-flash');
  assert.deepEqual(r.notes.map((n) => [n.at, n.to, n.ask]), [[3, 6.5, 'lipsync'], [1, null, null]]);
  assert.equal(v.scoresLine(r.scores!), 'lipsync 1, movement 2.5, story 7.5');
  const line = v.reviewNoteForAgent(t.id, ver.n, r.notes[0]);
  assert.match(line, /^\[v1 · 0:03\.0-0:06\.5 · beat 1 "tt_hi".*\] Fix the lip sync here.*Studio's review: "mouths are still"$/);
  v.markReview(t.id, ver.n, r, 'review');
  const marks = v.timelineNotes(t.id, 'review');
  assert.deepEqual(marks.map((m) => [m.from_s, m.to_s, m.action, m.by]), [[3, 6.5, 'lipsync', 'Studio (review)'], [1, null, null, 'Studio (review)']]);
  v.keepReviewNote(t.id, marks[0].id);
  assert.equal(v.timelineNotes(t.id, 'draft')[0].by, 'J', 'kept as his own draft');
  assert.throws(() => v.keepReviewNote(t.id, marks[0].id), /No such review note/);
  v.markReview(t.id, ver.n, { ...r, error: 'down' }, 'review');
  assert.equal(v.timelineNotes(t.id, 'review').length, 1, 'an unreviewed version leaves no marks');
  const brief = v.reviewBrief(t, { ...ver, stage: 'animatic' }, ['[v1 at 0:03] too slow']);
  assert.match(brief, /THIS IS THE ANIMATIC/);
  assert.match(brief, /TT says hi/);
  assert.match(brief, /too slow/);
  assert.match(brief, /"key":"tt_hi"/);
});

test("J's performance video drives a capture: the method, the kind, the budget and the request follow it", () => {
  const spec = v.readSpec({ performance: 'a_5555555555555555', engine: 'auto' });
  assert.deepEqual(spec, { performance: 'a_5555555555555555', engine: 'capture', kind: 'capture' });
  assert.deepEqual(v.readSpec({ performance: '../x.mp4', kind: 'opera' }), {}, 'not an asset, not a kind');
  assert.equal(v.readSpec({ performance: 'a_5555555555555555', engine: 'scene', kind: 'dialogue' }).engine, 'scene', 'his method wins');
  const t = v.createVideo({ product: 'doseofdestruction', title: 'Capture', script: 'EXIT PUNK: Watch this.', spec });
  assert.match(t.request, /a_5555555555555555/);
  assert.match(t.request, /video\.replace/);
  assert.match(t.request, /audio\.voice-change/);
  assert.match(t.request, /table read/);
  assert.ok(t.gpu?.items?.some((i: any) => i.tool === 'video.replace'));
  assert.ok(v.videoGpu({ engine: 'perform' }).some((i) => i.tool === 'video.perform'));
  assert.ok(v.NOTE_ACTIONS.script, "the critic's script ask is one J can use too");
});
