// Videos (J, 2026-10-22: "I want to get to a point where I can write the scripts between the characters and have videos
// that I can iterate on throughout the day ... built into the roadmap so agents can pick them up"). A video is a
// roadmap task of kind 'video': J (or Talk from what he says) writes the script, the PM starts it like any task, and a
// content agent (the director, the video skill) makes it with Hawkes Gen in the product's repo (videos/<slug>/).
//
//   task  planned -> working (the agent writes, casts, renders) -> review = ready to screen (a version J watches)
//         -> working again on each note (the same agent session resumes with its work; a note is never a try)
//         -> merged + verified when J approves (the scripts merge into beta; no beta playtest judges a video)
//
// Not the PM's: a video change never merges by itself (agents.ts autoMergeBeta, pm.ts reviewable) and never counts
// J's notes as failed tries. Each pass the agent leaves .hawkes/video.json ({ asset, poster?, seconds?, summary?,
// caption? }); Studio keeps every version (video_versions) so J can compare them. The Screening tab
// (dashboard/videos.js) and Talk's studio_video are the two ways in.
import fs from 'node:fs';
import path from 'node:path';
import { db, newId } from './db.ts';
import { StudioError, isInfra } from './config.ts';
import { addItem, addTask, getTask, getItem, setTask, addComment, commentsOn, logDecision, type Task } from './roadmap.ts';
import { readEdit, shotsOf, shotsIn, beatsIn, applyEdit, composeParams, type Edit, type EditOp } from './video-edit.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS video_versions (
    id TEXT PRIMARY KEY, task TEXT NOT NULL, n INTEGER NOT NULL, change TEXT, asset TEXT NOT NULL, poster TEXT,
    seconds REAL, summary TEXT, caption TEXT, at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS video_versions_task ON video_versions(task, n);
  CREATE TABLE IF NOT EXISTS video_state (task TEXT PRIMARY KEY, notes_sent_at INTEGER);
`);
// The Talk conversation a video reports into (its item's origin, else one of its own made on its first version).
try { db.exec('ALTER TABLE video_state ADD COLUMN conversation TEXT'); } catch { /* already there */ }
// Studio's review rounds since J's last note (reviewVersion): at most REVIEW_ROUNDS go back before J sees it anyway.
try { db.exec('ALTER TABLE video_state ADD COLUMN auto_rounds INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }
// Each version's beat sheet (the agent's plan) and Studio's review of it.
for (const col of ['beats', 'review', 'stage', 'story']) { try { db.exec(`ALTER TABLE video_versions ADD COLUMN ${col} TEXT`); } catch { /* already there */ } }
// The cut as an edit (video-edit.ts) and who made the version: the agent, or Studio's quick edit for J.
for (const col of ['edit', 'made_by']) { try { db.exec(`ALTER TABLE video_versions ADD COLUMN ${col} TEXT`); } catch { /* already there */ } }
// J's controls for the video (VideoSpec), as he set them when he started it.
try { db.exec('ALTER TABLE video_state ADD COLUMN spec TEXT'); } catch { /* already there */ }
/**
 * J's notes as he left them on the timeline (J, 2026-10-22: "click at points of time/highlight portions (like a video
 * editor timeline) and give the agent notes on what to do"): a range of a version, an action, his words. status: draft
 * (kept until he sends his notes together), sent, or quick (a quick edit Studio made, told to the agent with his next
 * notes so its own edit catches up).
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS video_notes (
    id TEXT PRIMARY KEY, task TEXT NOT NULL, version INTEGER, from_s REAL, to_s REAL, action TEXT, text TEXT NOT NULL,
    by TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, x REAL, y REAL
  );
  CREATE INDEX IF NOT EXISTS video_notes_task ON video_notes(task, status);
`);

const agents = () => import('./agents.ts');
export const FORMATS: Record<string, string> = {
  short: 'vertical 1080x1920, 15-60 s, for TikTok, YouTube Shorts and Reels',
  wide: 'horizontal 1920x1080, 30-120 s, for YouTube and the product sites',
};
const ASSET = /^a_[0-9a-f]{8,32}$/;
/**
 * Every video gets a GPU budget (J, 2026-10-22: a "No GPU" video can't render a background or clean a shot up, and
 * "we have an entire pipeline here and we are creating junk"). Priced from these items like any content task: under
 * costs.gpuAutoApprove it approves itself, else J's card. Cost judgement is the director's (the cheapest method that
 * looks as good), never a lock.
 */
export const VIDEO_GPU = [
  // Scenes from references are the default (J, 2026-10-22, after the bake-off): a few scenes and a retake or two.
  { tool: 'video.scene', count: 4, label: 'scenes and retakes' },
  { tool: 'video.upscale', count: 2, label: 'finished scenes upscaled' },
  { tool: 'image.edit', count: 6, label: 'kit references in the house style, sets' },
  { tool: 'image.generate', count: 2, label: 'sets' },
  // Shots a scene can't give (exact blocking, camera, an effect): Blender and ComfyUI.
  { tool: 'blender.render', count: 2, label: 'guide renders' },
  { tool: 'video.control', count: 2, label: 'repaints' },
];

export type Review = { pass: boolean; score: number; summary: string; notes: { at: number | null; note: string }[]; error?: string };
/**
 * A version's stage. A video starts with an animatic (a rough draft: the story, the beat sheet, the art and staging, the
 * real voices, timed) that J approves or steers before the final renders, unless he turns it off for that video (J,
 * 2026-10-22: "I like the workflow of a rough draft first and the go ahead ... This helps with also changing the voice,
 * checking the art etc.").
 */
export type Stage = 'animatic' | 'final';
export type Version = { id: string; task: string; n: number; change: string | null; asset: string; poster: string | null; seconds: number | null; summary: string | null; caption: string | null; at: number; beats: any[] | null; review: Review | null; stage: Stage; story: string | null; edit: Edit | null; made_by: string | null };
const toVersion = (r: any): Version => ({ ...r, beats: r.beats ? JSON.parse(r.beats) : null, review: r.review ? JSON.parse(r.review) : null, stage: r.stage === 'animatic' ? 'animatic' : 'final', story: r.story ?? null, edit: r.edit ? JSON.parse(r.edit) : null, made_by: r.made_by ?? null });
export const REVIEW_ROUNDS = 2;
/** How many frames Studio's review looks at, at most (10 contact sheets). */
const REVIEW_FRAMES = 80;
const REVIEW_TRIES = 4;
const REVIEW_RETRY_MS = Number(process.env.STUDIO_VIDEO_REVIEW_RETRY_MS) || 3 * 60_000;

export const isVideoTask = (taskId: string | null | undefined) => Boolean(taskId) && getTask(taskId!)?.kind === 'video';
export const isVideoChange = (c: { task?: string | null } | null | undefined) => isVideoTask(c?.task);

export function versionsOf(task: string): Version[] {
  return (db.prepare('SELECT * FROM video_versions WHERE task = ? ORDER BY n').all(task) as any[]).map(toVersion);
}

/** What the agent says it made this pass (.hawkes/video.json), checked. null when it left none or it isn't usable. */
export type VideoFile = { asset?: string; file?: string; poster?: string; posterFile?: string; seconds?: number; summary?: string; caption?: string; beats?: any[]; stage?: Stage; story?: string; edit?: Edit };
/**
 * A path the agent gave for its cut (or poster): inside its worktree, a video or image file that exists. Agents can't
 * put files into Gen themselves (the sandbox has no upload), so Studio does it for them (importVideoFile).
 */
export function worktreeFile(worktree: string, p: unknown, kinds: RegExp): string | undefined {
  const rel = String(p ?? '').trim();
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || !kinds.test(rel)) return undefined;
  const abs = path.join(worktree, rel);
  try {
    const st = fs.statSync(abs);
    return st.isFile() && st.size > 0 && st.size < 1024 * 1024 * 1024 ? rel : undefined;
  } catch {
    return undefined;
  }
}
const VIDEO_FILE = /\.(mp4|mov|webm|mkv)$/i;
const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;

export function readVideoFile(worktree: string): VideoFile | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(worktree, '.hawkes', 'video.json'), 'utf8'));
    const asset = ASSET.test(String(v.asset ?? '')) ? v.asset : undefined;
    const file = asset ? undefined : worktreeFile(worktree, v.file ?? v.asset, VIDEO_FILE);
    if (!asset && !file) return null;
    return {
      asset, file, poster: ASSET.test(String(v.poster ?? '')) ? v.poster : undefined,
      posterFile: ASSET.test(String(v.poster ?? '')) ? undefined : worktreeFile(worktree, v.posterFile ?? v.poster, IMAGE_FILE),
      seconds: Number.isFinite(Number(v.seconds)) ? Number(v.seconds) : undefined,
      summary: v.summary ? String(v.summary).slice(0, 2000) : undefined, caption: v.caption ? String(v.caption).slice(0, 2200) : undefined,
      beats: Array.isArray(v.beats) ? v.beats.slice(0, 120) : undefined,
      stage: v.stage === 'animatic' ? 'animatic' : 'final', story: v.story ? String(v.story).slice(0, 6000) : undefined,
      edit: readEdit(v.edit) ?? undefined,
    };
  } catch {
    return null;
  }
}

/** Puts the agent's cut (and poster) from its worktree into Gen's library, as the product's assets. */
export async function importVideoFile(worktree: string, v: VideoFile, product: string): Promise<VideoFile & { asset: string }> {
  if (v.asset) return v as VideoFile & { asset: string };
  const { gen } = await import('./gen.ts');
  const put = async (rel: string, type: string) => {
    const r: any = await gen.request(`/assets?project=${encodeURIComponent(product)}&title=${encodeURIComponent(path.basename(rel))}`, { method: 'POST', body: fs.readFileSync(path.join(worktree, rel)), headers: { 'Content-Type': type, 'X-Filename': path.basename(rel) } });
    if (!ASSET.test(String(r?.id ?? ''))) throw new Error(`Gen didn't take ${rel}: ${JSON.stringify(r).slice(0, 200)}`);
    return r.id as string;
  };
  const asset = await put(v.file!, /\.webm$/i.test(v.file!) ? 'video/webm' : /\.mov$/i.test(v.file!) ? 'video/quicktime' : 'video/mp4');
  const poster = v.poster ?? (v.posterFile ? await put(v.posterFile, /\.png$/i.test(v.posterFile) ? 'image/png' : /\.webp$/i.test(v.posterFile) ? 'image/webp' : 'image/jpeg').catch(() => undefined) : undefined);
  return { ...v, asset, poster };
}

/** A new version from a pass of the video's change (the same asset as the last one isn't a new version). */
export function recordVersion(task: string, change: string, v: VideoFile & { asset: string }, madeBy: string | null = null): Version | null {
  const all = versionsOf(task);
  if (all.at(-1)?.asset === v.asset) return null;
  const id = newId('vv');
  db.prepare('INSERT INTO video_versions (id, task, n, change, asset, poster, seconds, summary, caption, at, beats, stage, story, edit, made_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, task, all.length + 1, change, v.asset, v.poster ?? null, v.seconds ?? null, v.summary ?? null, v.caption ?? null, Date.now(), v.beats ? JSON.stringify(v.beats) : null, v.stage ?? 'final', v.story ?? null, v.edit ? JSON.stringify(v.edit) : null, madeBy);
  return toVersion(db.prepare('SELECT * FROM video_versions WHERE id = ?').get(id));
}

/** Called when a video's change is ready (agents.ts finish): keep its version; notes J left while it worked go back at once. */
export async function videoReady(c: { id: string; task: string; worktree: string }): Promise<{ version: Version | null; resent: boolean }> {
  const t = getTask(c.task)!;
  const found = readVideoFile(c.worktree);
  let v: (VideoFile & { asset: string }) | null = null;
  if (found) {
    try {
      v = await importVideoFile(c.worktree, found, t.product);
    } catch (e: any) {
      logDecision('video', t.id, t.product, `"${t.title}": couldn't put the cut into Gen: ${String(e.message ?? e).slice(0, 200)}`);
    }
  }
  const version = v ? recordVersion(c.task, c.id, v) : null;
  logDecision('video', t.id, t.product, version ? `"${t.title}" v${version.n} is ready to screen` : `"${t.title}": the pass left no video (.hawkes/video.json)`);
  // Studio's review first (the craft bar and the beat sheet): a version that falls short goes back by itself, up to
  // REVIEW_ROUNDS times since J's last note, before J is told.
  if (version) {
    // Gen (and Claude through it) can be briefly unreachable (a deploy, a restart): try a few times before J gets it
    // unreviewed (The Board v1, 2026-10-22, reached J as "passed" because Gen was down for the one try).
    let review: Review | null = null;
    let lastError = '';
    for (let i = 0; i < REVIEW_TRIES && !review; i++) {
      if (i) await new Promise((r) => setTimeout(r, REVIEW_RETRY_MS));
      review = await reviewVersion(t, version).catch((e: any) => { lastError = String(e.message ?? e); return null; });
    }
    review ??= { pass: true, score: 0, summary: `Not reviewed: Studio couldn't run its review (${lastError.slice(0, 200)}).`, notes: [], error: lastError };
    db.prepare('UPDATE video_versions SET review = ? WHERE id = ?').run(JSON.stringify(review), version.id);
    version.review = review;
    const rounds = (db.prepare('SELECT auto_rounds FROM video_state WHERE task = ?').get(t.id) as any)?.auto_rounds ?? 0;
    if (!review.pass && rounds < REVIEW_ROUNDS && review.notes.length) {
      db.prepare('INSERT INTO video_state (task, auto_rounds) VALUES (?, 1) ON CONFLICT(task) DO UPDATE SET auto_rounds = auto_rounds + 1').run(t.id);
      addComment(t.id, `Studio's review of v${version.n} (${review.score}/10): ${review.summary}\n${review.notes.map((n) => `- ${n.at != null ? `[${stampOf(n.at)}] ` : ''}${n.note}`).join('\n')}`, 'Studio (review)', 'review');
      await sendNotes(t.id, review.notes.map((n) => `${n.at != null ? `[v${version.n} at ${stampOf(n.at)}] ` : ''}${n.note}`), 'Studio (review)');
      logDecision('video', t.id, t.product, `Studio's review sent "${t.title}" v${version.n} back (${review.score}/10, round ${rounds + 1} of ${REVIEW_ROUNDS}): ${review.summary.slice(0, 200)}`);
      return { version, resent: true };
    }
    await tellTalk(t, version).catch((e: any) => console.warn(`[videos] telling Talk about ${t.id}: ${e.message ?? e}`));
  }
  // Notes that came while the agent was on this pass: it didn't see them, so they go to it now.
  const sent = (db.prepare('SELECT notes_sent_at FROM video_state WHERE task = ?').get(c.task) as any)?.notes_sent_at ?? 0;
  const waiting = commentsOn(c.task).filter((m: any) => m.kind === 'note' && m.at > sent);
  if (waiting.length && version) {
    const pass = (await agents()).getChange(c.id);
    const started = pass?.notes?.at(-1)?.at ?? pass?.created ?? 0;
    const unseen = waiting.filter((m: any) => m.at > started);
    if (unseen.length) {
      await sendNotes(c.task, unseen.map((m: any) => m.text), 'J');
      return { version, resent: true };
    }
  }
  return { version, resent: false };
}

/**
 * Tells J in Talk that a version is ready, in the conversation that asked for the video (Talk answers it there), else in
 * one conversation per video, so his notes on every version stay together and Talk passes them on (studio_video note).
 */
async function tellTalk(t: Task, v: Version) {
  const talk = await import('./talk.ts');
  const { PUBLIC_URL } = await import('./notify.ts');
  const title = t.title.replace(/^Video:\s*/, '');
  const what = v.stage === 'animatic' ? `The animatic of "${title}" (v${v.n})` : `"${title}" v${v.n}`;
  const next = v.stage === 'animatic' ? "Tell me what to change in the story, staging or timing, or say it's good and the final gets made from it." : "Tell me what to change and I'll send it back, or say it's good and I'll approve it.";
  const text = `${what} is ready to screen (video ${t.id}${v.seconds ? `, ${Math.round(v.seconds)} s` : ''}${v.review && !v.review.error ? `, Studio's review ${v.review.score}/10` : ''}).${v.summary ? ` ${v.summary.slice(0, 400)}` : ''}
Watch it: ${PUBLIC_URL}/#videos/${t.id}
${next}`;
  const row = db.prepare('SELECT conversation FROM video_state WHERE task = ?').get(t.id) as { conversation: string | null } | undefined;
  const origin = row?.conversation ?? getItem(t.item)?.origin ?? null;
  if (origin && talk.studioSays(origin, text)) return;
  const id = talk.postNotice(`Video: ${title}`, text);
  db.prepare('INSERT INTO video_state (task, conversation) VALUES (?, ?) ON CONFLICT(task) DO UPDATE SET conversation = excluded.conversation').run(t.id, id);
}

const stampOf = (at: number) => `${Math.floor(at / 60)}:${String(Math.floor(at % 60)).padStart(2, '0')}`;

export const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['pass', 'score', 'summary', 'notes'],
  properties: {
    pass: { type: 'boolean' }, score: { type: 'number', minimum: 1, maximum: 10 }, summary: { type: 'string' },
    notes: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['note'], properties: { at: { type: ['number', 'null'] }, note: { type: 'string' } } } },
  },
};

/** The review's prompt: the craft bar, J's script and notes, the agent's beat sheet, and what the frames and audio show. */
export function reviewPrompt(t: Task, v: Version, facts: { seconds: number; frames: number; perSheet: number; silences: { start: number; seconds: number }[]; jNotes: string[]; every?: number }) {
  const every = facts.every ?? 1;
  const script = (commentsOn(t.id).find((m: any) => m.kind === 'script') as any)?.text ?? t.request;
  const animatic = v.stage === 'animatic';
  return `You review a short video for J (Hawkes Studio) before he sees it. Be the strict director he wants: he called the
first video out of this pipeline "junk" (characters standing on a stage punching the air, one wide shot, no faces), and
of the next one: "the story it put together made no sense ... I couldn't follow along with the point of the story, why
they are doing what they are doing", "they felt kinda disconnected? Like it was just two characters from random other
movies stitched together". Pass it only if it meets the bar; otherwise give concrete fixes the agent can act on.
${animatic ? `
THIS IS THE ANIMATIC (v${v.n}): rough staging with the real voices, made so J can approve the story, staging and timing
before the expensive render. Judge the story, the staging, the coverage the beat sheet plans and the timing. Don't mark
it down for rough pictures (stills, grey-box, placeholders), only for what the final would inherit: an unclear story,
characters not sharing a space, missing reactions, a bad rhythm.
` : ''}
Story (most important):
- A viewer who has never seen the game can tell who these characters are, what each one wants, what happens, and why
  it matters. The scene has a clear turn and a payoff; every line and shot moves it forward. If you can't say the point
  of the story in one sentence after watching, it fails.

Together, not stitched:
- The characters share one space, one light and one geography: screen direction holds (the 180-degree line), eyelines
  meet, over-the-shoulders and two-shots show both, they react to each other's words and touch the same things. Two
  portraits on unrelated backgrounds intercut is a fail.
- Faces act: clear, specific expressions that change with the beat, not neutral talking heads.
- No style or quality jumps between shots or where clips join; lips match the voice the whole way through.

The craft bar:
- A hook in the first second (motion, a face or a line), no title-card opener.
- Coverage: a new shot every 1-3 s and at least 5 different setups (shot size and angle); no shot over 3 s without a reason.
- Variety: no ping-pong of the same two static close-ups; dialogue mixes over-the-shoulders, two-shots, angle changes
  and camera moves, and each setup is used for a reason.
- The same character looks the same in every shot: one model, one style, hair, colours and proportions as their
  reference. A character drawn differently from shot to shot (3D in the wides, flat 2D in the close-ups) fails.
- Faces: each spoken line shows the speaker in medium close-up or closer, lips moving, or plays over a deliberate reaction.
- Reactions: each punchline, insult, hit or reveal cuts to a face reacting.
- Physical action reads: a wide to show it, the impact close, a physical reaction, VFX on impacts and powers, SFX.
- Bespoke animation that fits each character (not stock idles or generic attack clips for the hero beats).
- At least one motivated camera move.
- On-model characters, no morphing or melting, nothing ugly. Captions readable, inside the middle band.
- Ends on a short end card ("Made with Hawkes Gen · hawkesgen.com"), about 1.5 s, without a long fade to black.

${t.title} (${t.product}). The agent's story (logline, what each character wants, the turn, the payoff):
${v.story ? v.story.slice(0, 3000) : '(none: the agent wrote no story, which is itself a failure)'}

J's script:
${String(script).slice(0, 3000)}
${facts.jNotes.length ? `\nJ's notes so far (the version must answer them):\n${facts.jNotes.map((n) => `- ${n}`).join('\n')}\n` : ''}
The agent's beat sheet for v${v.n}:
${v.beats?.length ? JSON.stringify(v.beats).slice(0, 8000) : '(none: the agent left no beat sheet, which is itself a failure)'}

The agent says: ${v.summary ?? '(nothing)'}

The images are contact sheets of the whole cut: one frame ${every === 1 ? 'per second' : `every ${every.toFixed(1)} s`}, ${facts.perSheet} per sheet, left to right, top to bottom,
starting at 0 s (${facts.frames} frames for ${facts.seconds.toFixed(1)} s).
Silences over 0.8 s: ${facts.silences.length ? facts.silences.map((s) => `${s.start.toFixed(1)} s for ${s.seconds.toFixed(1)} s`).join(', ') : 'none'}.

Answer: pass (meets the bar and looks good), score 1-10, a two-sentence summary, and up to 8 notes, each a concrete fix
with the second it's about (at) when it has one, worst first. Name the beat, the shot size, the angle or the tool when it
helps ("1-4 s is one static wide: cut to Exit Punk's CU on 'That's me' and Shutup Bot's ECU reaction").`;
}

/** Studio's review of a version: frames (one a second, as contact sheets) and dead air, judged by Claude against the bar. */
async function reviewVersion(t: Task, v: Version): Promise<Review> {
  const os = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const { gen } = await import('./gen.ts');
  const { askClaude } = await import('./llm.ts');
  const { jobModel } = await import('./roles.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-review-'));
  try {
    const file = path.join(dir, 'cut.mp4');
    await gen.download(v.asset, file);
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height', '-of', 'json', file], { encoding: 'utf8' }));
    const seconds = Number(info.format?.duration ?? v.seconds ?? 0);
    const vs = (info.streams ?? []).find((s: any) => s.width);
    const tall = vs ? vs.height > vs.width : true;
    const [cols, rows, w, h] = tall ? [4, 2, 270, 480] : [3, 3, 480, 270];
    // The whole cut, however long (The Board v2's review saw only its first 54 of 77 s): a frame a second up to
    // REVIEW_FRAMES, then spread evenly.
    const every = Math.max(1, seconds / REVIEW_FRAMES);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', `fps=1/${every.toFixed(3)},scale=${w}:${h},tile=${cols}x${rows}`, path.join(dir, 'sheet-%02d.png')]);
    const sheets = fs.readdirSync(dir).filter((f) => f.startsWith('sheet-')).sort().slice(0, Math.ceil(REVIEW_FRAMES / (cols * rows)));
    let log = '';
    try {
      execFileSync('ffmpeg', ['-v', 'info', '-i', file, '-af', 'silencedetect=n=-38dB:d=0.8', '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      log = String(e.stderr ?? '');
    }
    const images: string[] = [];
    for (const s of sheets) images.push(await gen.upload(fs.readFileSync(path.join(dir, s)), s));
    const jNotes = commentsOn(t.id).filter((m: any) => m.kind === 'note' && !String(m.by).startsWith('Studio')).map((m: any) => m.text).slice(-12);
    const prompt = reviewPrompt(t, v, { seconds, frames: Math.ceil(seconds / every), perSheet: cols * rows, silences: silenceOf(log), jNotes, every });
    const job = await askClaude({ prompt, schema: REVIEW_SCHEMA, images, model: jobModel('review'), maxTokens: 3000, timeoutMs: 8 * 60_000, purpose: 'video review', product: t.product });
    const r = job?.result?.value ?? job?.value;
    if (!r || typeof r.pass !== 'boolean') throw new Error(job?.error ?? 'no answer');
    return { pass: r.pass, score: Number(r.score) || 0, summary: String(r.summary ?? '').slice(0, 600), notes: (r.notes ?? []).slice(0, 8).map((n: any) => ({ at: n.at === null || n.at === undefined || !Number.isFinite(Number(n.at)) ? null : Number(n.at), note: String(n.note).slice(0, 500) })) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** ffmpeg silencedetect's log to silences (start, length). */
export function silenceOf(log: string) {
  const out: { start: number; seconds: number }[] = [];
  let start: number | null = null;
  for (const line of log.split('\n')) {
    const s = /silence_start: ([\d.]+)/.exec(line);
    if (s) start = Number(s[1]);
    const e = /silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/.exec(line);
    if (e) {
      out.push({ start: start ?? Number(e[1]) - Number(e[2]), seconds: Number(e[2]) });
      start = null;
    }
  }
  return out;
}

/** What J sees per video: where it is, in his words. */
function stateOf(t: Task, c: any, versions: Version[]): string {
  if (t.status === 'verified' || t.status === 'live') return 'approved';
  if (t.status === 'dropped') return 'dropped';
  if (!c) return t.status === 'planned' ? 'queued' : t.status;
  if (c.status === 'ready') return !versions.length ? 'no video yet' : versions.at(-1)!.stage === 'animatic' ? 'animatic ready' : 'ready to screen';
  if (c.status === 'failed') return 'failed';
  if (c.status === 'needs answer') return 'has a question';
  if (c.status === 'waiting on Gen') return 'rendering';
  return versions.length ? 'revising' : 'making';
}

export async function listVideos(limit = 60) {
  const { getChange } = await agents();
  const rows = db.prepare("SELECT id FROM tasks WHERE kind = 'video' ORDER BY created DESC LIMIT ?").all(limit) as { id: string }[];
  return rows.map(({ id }) => {
    const t = getTask(id)!;
    const c = t.change ? getChange(t.change) : null;
    const versions = versionsOf(id);
    const last = versions.at(-1) ?? null;
    return { id, product: t.product, title: t.title, item: t.item, state: stateOf(t, c, versions), versions: versions.length, latest: last, change: c ? { id: c.id, status: c.status, detail: c.detail } : null, created: t.created };
  });
}

export async function videoDetail(task: string) {
  const t = getTask(task);
  if (!t || t.kind !== 'video') throw new StudioError(`No video ${task}`, 404);
  const { getChange } = await agents();
  const c = t.change ? getChange(t.change) : null;
  const versions = versionsOf(task).map((v) => ({ ...v, shots: v.edit ? shotsOf(v.edit) : null }));
  return {
    task: t, item: getItem(t.item), state: stateOf(t, c, versions), versions, spec: specOf(task),
    notes: commentsOn(task).map((m: any) => ({ by: m.by, kind: m.kind, text: m.text, at: m.at })),
    marks: timelineNotes(task), actions: NOTE_ACTIONS,
    change: c ? { id: c.id, status: c.status, detail: c.detail, log: (c.log ?? []).slice(-12) } : null,
  };
}

/**
 * J's controls for a video (the New video form, studio_video new): what he can steer before anything renders. Every one
 * is optional; the director decides what he leaves open.
 */
export type VideoSpec = { seconds?: number; style?: string; voices?: string; engine?: string; quality?: string; music?: string; captions?: boolean; endCard?: boolean; animatic?: boolean };
export const ENGINES: Record<string, string> = {
  auto: "the director's choice: whole scenes from references (video.scene) by default, Blender and ComfyUI shots where a scene needs more",
  scene: 'whole scenes from references on our GPUs (video.scene, MiniMax H3): one look, one room, lips on the voice track',
  seedance: 'whole scenes through Seedance 2.5 (video.seedance, paid Comfy credits; up to 30 s a scene)',
  kling: 'whole scenes through Kling O3 (video.kling, paid; Kling voices the characters itself, so not with our cast voices)',
  shots: 'shot by shot: each shot staged in Blender and painted with ComfyUI (the most control, the slowest)',
};
export const QUALITY: Record<string, string> = {
  draft: 'fast and cheap: Lightning steps, about 0.3 MP, no upscale (to judge story and staging)',
  standard: 'about 0.5 MP, upscaled to the format',
  high: 'about 0.6 MP, two takes per scene with the better one kept, upscaled and interpolated',
};
export function specOf(task: string): VideoSpec {
  const row = db.prepare('SELECT spec FROM video_state WHERE task = ?').get(task) as { spec: string | null } | undefined;
  try { return row?.spec ? JSON.parse(row.spec) : {}; } catch { return {}; }
}
/** J's controls, checked: what's unknown or empty is left to the director. */
export function readSpec(a: any): VideoSpec {
  const out: VideoSpec = {};
  const sec = Number(a?.seconds);
  if (Number.isFinite(sec) && sec >= 5 && sec <= 300) out.seconds = Math.round(sec);
  for (const k of ['style', 'voices', 'music'] as const) if (String(a?.[k] ?? '').trim()) out[k] = String(a[k]).trim().slice(0, 1000);
  if (a?.engine && ENGINES[a.engine] && a.engine !== 'auto') out.engine = a.engine;
  if (a?.quality && QUALITY[a.quality]) out.quality = a.quality;
  for (const k of ['captions', 'endCard', 'animatic'] as const) if (typeof a?.[k] === 'boolean') out[k] = a[k];
  return out;
}

/** The agent's request for a new video: J's script, what the format means, and his controls. */
export function videoRequest(a: { title: string; script: string; format?: string; direction?: string; animatic?: boolean; spec?: VideoSpec }) {
  const format = FORMATS[a.format ?? 'short'] ? a.format ?? 'short' : 'short';
  const spec = a.spec ?? {};
  // An animatic (a rough draft) first unless J turns it off (J, 2026-10-22: "I think i like the workflow of a rough
  // draft first and the go ahead etc. This helps with also changing the voice, checking the art etc.").
  const animatic = a.animatic ?? spec.animatic ?? true;
  const passes = animatic
    ? 'the story and a beat sheet first, then an animatic (a rough draft: the real voices, the art and the staging, timed) that J approves or steers, then the final'
    : 'the story and a beat sheet first, then the final itself (J turned the animatic off for this one)';
  const controls = [
    spec.seconds ? `- Length: about ${spec.seconds} s.` : null,
    spec.style ? `- Look: ${spec.style}` : null,
    spec.voices ? `- Voices: ${spec.voices}` : null,
    spec.engine ? `- Method: ${ENGINES[spec.engine]}.` : null,
    spec.quality ? `- Quality: ${spec.quality} (${QUALITY[spec.quality]}).` : null,
    spec.music ? `- Music: ${spec.music}` : null,
    spec.captions === false ? '- No burned-in captions.' : null,
    spec.endCard === false ? '- No end card.' : null,
  ].filter(Boolean);
  return `Make the video "${a.title}" (${format}: ${FORMATS[format]}). The video skill (below) is how videos are made here:
${passes}: whole scenes generated from the characters' references and the voice track (video.scene) by default, Blender
and ComfyUI for shots that need more, within the GPU budget.

## J's script
${a.script.trim()}
${a.direction?.trim() ? `\n## Direction\n${a.direction.trim()}\n` : ''}${controls.length ? `\n## J's controls (follow them)\n${controls.join('\n')}\n` : ''}
Keep J's lines as written (fix only obvious typos). Cast each character with their own voice. Leave the finished cut's
Gen asset and its edit in .hawkes/video.json; J screens it in Studio and his notes come back to you as revisions.`;
}

/** A new video: a roadmap item and its video task, planned, so the PM starts it. */
export function createVideo(a: { product: string; title: string; script: string; format?: string; direction?: string; animatic?: boolean; spec?: VideoSpec; gpu?: unknown; priority?: string; by?: string; origin?: string | null }) {
  if (!String(a.title ?? '').trim()) throw new StudioError('A video needs a title');
  if (!String(a.script ?? '').trim()) throw new StudioError('A video needs a script (the lines, who says them, what happens)');
  if (a.format && !FORMATS[a.format]) throw new StudioError(`format is ${Object.keys(FORMATS).join(' or ')}`);
  // A video's files go to a product's repo (and beta); Studio's and Gen's own repos deploy on merge, so never there.
  if (isInfra(a.product)) throw new StudioError(`Videos belong to a product (its characters and repo), not ${a.product}`);
  const title = String(a.title).trim().slice(0, 140);
  const spec = readSpec({ ...(a.spec ?? {}), ...(typeof a.animatic === 'boolean' ? { animatic: a.animatic } : {}) });
  const item = addItem({ product: a.product, title: `Video: ${title}`, goal: `A ${a.format ?? 'short'} video J approves in the Screening tab.`, status: 'planned', priority: a.priority, by: a.by ?? 'J', origin: a.origin ?? null });
  const task = addTask({ item: item.id, title: `Video: ${title}`, request: videoRequest({ title, script: a.script, format: a.format, direction: a.direction, spec }), criteria: ['J approves it in the Screening tab'], kind: 'video', gpu: a.gpu ?? VIDEO_GPU, priority: a.priority });
  addComment(task.id, `Script (${a.format ?? 'short'}):\n${a.script.trim()}`, a.by ?? 'J', 'script');
  db.prepare('INSERT INTO video_state (task, spec) VALUES (?, ?) ON CONFLICT(task) DO UPDATE SET spec = excluded.spec').run(task.id, JSON.stringify(spec));
  logDecision('video', task.id, task.product, `new video "${title}" (${a.format ?? 'short'})`);
  return getTask(task.id)!;
}

/** Notes back to the agent: the same session resumes with its work (agents.ts revise). Never a try. */
async function sendNotes(task: string, notes: string[], by: string) {
  const t = getTask(task)!;
  const { getChange, revise } = await agents();
  const c = t.change ? getChange(t.change) : null;
  if (!c || !['ready', 'failed'].includes(c.status)) return false;
  const v = versionsOf(task).at(-1);
  const who = by.startsWith('Studio') ? "Studio's review" : "J's notes";
  revise(c.id, `${who} on ${v ? `v${v.n}` : 'the last pass'} (make a new version that answers every one; change only what they're about):\n${notes.map((n) => `- ${n}`).join('\n')}`, by);
  db.prepare('INSERT INTO video_state (task, notes_sent_at) VALUES (?, ?) ON CONFLICT(task) DO UPDATE SET notes_sent_at = excluded.notes_sent_at').run(task, Date.now());
  // J's own notes start the review's rounds again (Studio's review gets REVIEW_ROUNDS on each of his versions).
  if (!by.startsWith('Studio')) db.prepare('UPDATE video_state SET auto_rounds = 0 WHERE task = ?').run(task);
  setTask(task, { status: 'working' });
  logDecision('video', task, t.product, `notes sent to the agent on "${t.title}": ${notes.join(' | ').slice(0, 300)}`);
  return true;
}

/**
 * What J can ask for on a part of the timeline, and what each means to the agent. The agent does all of them; the
 * QUICK ones Studio can also do itself in seconds when the version has an edit (quickEdit).
 */
export const NOTE_ACTIONS: Record<string, string> = {
  shorter: 'Make this shorter: tighten it (trim pauses, cut a beat, faster cuts) without losing a line or the story point.',
  longer: 'Let this breathe: hold it longer (a reaction, a beat of silence before or after the line).',
  redo: 'Redo this: generate it again (a new take, a better keyframe or prompt), keeping its story, timing and voice.',
  lipsync: "Fix the lip sync here: the speaker's mouth must match the voice line exactly the whole way through.",
  closer: 'Closer here: a tighter shot (MCU, CU or ECU) on the face that matters.',
  wider: 'Wider here: show the space and both characters.',
  angle: 'A different angle here: a new setup (an over-the-shoulder, a low or high angle, a two-shot) instead of this one.',
  reaction: 'Add a reaction here: cut to a face reacting, held a beat.',
  camera: 'Move the camera here: a motivated move (push-in, whip-pan, orbit, handheld) instead of a static frame.',
  expression: 'More expression here: the faces should act the beat (eyes, brows, mouth), not sit neutral.',
  voice: 'Change the voice or the delivery here: a new take (emphasis, timing, emotion) or a different voice.',
  look: 'Fix the look here: on-model, the same style and light as the rest, nothing melting or morphing.',
  action: 'More physical action and VFX here: the impact, a physical reaction, sparks or a shake, and the SFX.',
  sound: 'Fix the sound here: the SFX, the music level, the mix.',
  caption: 'Fix the captions here.',
  cut: 'Cut this out.',
};

export type TimelineNote = { id: string; task: string; version: number | null; from_s: number | null; to_s: number | null; action: string | null; text: string; by: string; at: number; status: 'draft' | 'sent' | 'quick' | 'told'; x: number | null; y: number | null };
export function timelineNotes(task: string, status?: string): TimelineNote[] {
  return db.prepare(`SELECT * FROM video_notes WHERE task = ?${status ? ' AND status = ?' : ''} ORDER BY at`).all(...(status ? [task, status] : [task])) as TimelineNote[];
}

const stampRange = (from: number | null, to: number | null) => {
  const at = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
  return from == null ? '' : to != null && to - from > 0.05 ? `${at(from)}-${at(to)}` : `at ${at(from)}`;
};

/**
 * A note as the agent reads it: the version and range, the shots and beats it covers (from the version's edit and beat
 * sheet, so "this" is never a guess), what J asked for, and his words.
 */
export function noteForAgent(task: string, n: { version?: number | null; from_s?: number | null; to_s?: number | null; action?: string | null; text?: string; x?: number | null; y?: number | null }) {
  const v = n.version ? versionsOf(task).find((x) => x.n === n.version) : versionsOf(task).at(-1);
  const where: string[] = [];
  if (n.version ?? v?.n) where.push(`v${n.version ?? v!.n}`);
  if (n.from_s != null) where.push(stampRange(n.from_s, n.to_s ?? null));
  const to = n.to_s != null && n.to_s > (n.from_s ?? 0) ? n.to_s : (n.from_s ?? 0) + 0.05;
  if (v && n.from_s != null) {
    const shots = v.edit ? shotsIn(shotsOf(v.edit), n.from_s, to) : [];
    if (shots.length) where.push(`edit clip${shots.length > 1 ? 's' : ''} ${shots.map((s) => s.i).join(', ')}`);
    const beats = beatsIn(v.beats, n.from_s, to).slice(0, 6);
    if (beats.length) where.push(`beat${beats.length > 1 ? 's' : ''} ${beats.map((b: any) => `${b.i}${b.key ? ` "${b.key}"` : ''} (${[b.shot, b.who?.join?.(' + '), b.line ? `"${String(b.line).slice(0, 60)}"` : null].filter(Boolean).join(' ')})`).join('; ')}`);
  }
  if (n.x != null && n.y != null) where.push(`aimed at ${Math.round(n.x * 100)}% across, ${Math.round(n.y * 100)}% down the frame`);
  const ask = n.action && NOTE_ACTIONS[n.action] ? NOTE_ACTIONS[n.action] : '';
  const words = String(n.text ?? '').trim();
  return `${where.length ? `[${where.join(' · ')}] ` : ''}${[ask, words ? (ask ? `J: "${words}"` : words) : ''].filter(Boolean).join(' ')}`.trim();
}

/**
 * J's note on a video: a moment or a range of a version (from, to: seconds), an action (NOTE_ACTIONS), his words.
 * hold: keep it as a draft until he sends his notes together (sendDrafts), so the agent starts once with all of them.
 * Otherwise (and every note from Talk) it goes now: to the agent when it's waiting for him; while it works, kept and sent
 * when its pass ends (videoReady).
 */
export async function noteVideo(task: string, text: string, { at, from, to, action, version, x, y, hold = false, by = 'J' }: { at?: number | null; from?: number | null; to?: number | null; action?: string | null; version?: number | null; x?: number | null; y?: number | null; hold?: boolean; by?: string } = {}) {
  const t = getTask(task);
  if (!t || t.kind !== 'video') throw new StudioError(`No video ${task}`, 404);
  const words = String(text ?? '').trim();
  const act = action && NOTE_ACTIONS[action] ? action : null;
  if (!words && !act) throw new StudioError('Say what to change');
  const num = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const f = num(from) ?? num(at);
  const tt = num(to);
  const vn = num(version) ?? versionsOf(task).at(-1)?.n ?? null;
  const row: TimelineNote = { id: newId('vn'), task, version: vn, from_s: f, to_s: tt != null && f != null && tt > f ? tt : null, action: act, text: words.slice(0, 4000), by, at: Date.now(), status: hold ? 'draft' : 'sent', x: num(x), y: num(y) };
  db.prepare('INSERT INTO video_notes (id, task, version, from_s, to_s, action, text, by, at, status, x, y) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, task, row.version, row.from_s, row.to_s, row.action, row.text, by, row.at, row.status, row.x, row.y);
  if (hold) return { sent: false, queued: false, draft: row.id, video: await videoDetail(task) };
  const full = noteForAgent(task, row);
  addComment(task, full.slice(0, 4000), by, 'note');
  const sent = await sendNotes(task, [...pendingForAgent(task), full], by);
  return { sent, queued: !sent, video: await videoDetail(task) };
}

/** Drafts J kept and quick edits Studio made since the agent last heard from him, as lines for the agent (and marked sent). */
function pendingForAgent(task: string): string[] {
  const rows = [...timelineNotes(task, 'draft'), ...timelineNotes(task, 'quick')].sort((a, b) => a.at - b.at);
  const lines = rows.map((r) => (r.status === 'quick' ? r.text : noteForAgent(task, r)));
  for (const r of rows) db.prepare("UPDATE video_notes SET status = ? WHERE id = ?").run(r.status === 'quick' ? 'told' : 'sent', r.id);
  for (const [i, r] of rows.entries()) if (r.status === 'draft') addComment(task, lines[i].slice(0, 4000), r.by, 'note');
  return lines;
}

/** J sends the notes he kept (and, optionally, a last word on the whole thing): one revision with all of them. */
export async function sendDrafts(task: string, { text, by = 'J' }: { text?: string; by?: string } = {}) {
  const t = getTask(task);
  if (!t || t.kind !== 'video') throw new StudioError(`No video ${task}`, 404);
  const extra = String(text ?? '').trim();
  const lines = pendingForAgent(task);
  if (extra) { lines.push(extra); addComment(task, extra.slice(0, 4000), by, 'note'); }
  if (!lines.length) throw new StudioError('No notes to send');
  const sent = await sendNotes(task, lines, by);
  return { sent, queued: !sent, notes: lines.length, video: await videoDetail(task) };
}

/** A draft J changed his mind about. */
export function dropDraft(task: string, id: string) {
  const r = db.prepare("DELETE FROM video_notes WHERE id = ? AND task = ? AND status = 'draft'").run(id, task);
  if (!r.changes) throw new StudioError('No such draft', 404);
}

/**
 * A plain edit J makes himself, in seconds, without the agent (video-edit.ts): cut a range out, speed it up, punch or push
 * in on a point. Studio renders the new edit with Gen video.compose (free, no GPU) into a new version, and tells the
 * agent with J's next notes so its own edit catches up. Only on the latest version, while it waits for J.
 */
export async function quickEdit(task: string, op: EditOp, { by = 'J' }: { by?: string } = {}) {
  const t = getTask(task);
  if (!t || t.kind !== 'video') throw new StudioError(`No video ${task}`, 404);
  const { getChange } = await agents();
  const c = t.change ? getChange(t.change) : null;
  if (!c || c.status !== 'ready') throw new StudioError("Quick edits are for a version that's waiting for you (the agent is working on this one)");
  const base = versionsOf(task).at(-1);
  if (!base) throw new StudioError('No video yet');
  if (!base.edit) throw new StudioError(`v${base.n} has no edit Studio can change (the agent cut it without one): send it as a note and the agent does it`);
  let next: { edit: Edit; said: string };
  try { next = applyEdit(base.edit, op); } catch (e: any) { throw new StudioError(e.message); }
  const { gen, genWait } = await import('./gen.ts');
  const { inputs, params } = composeParams(next.edit);
  const job: any = await gen.submit('video.compose', { project: t.product, params, inputs, labels: { video: task, quickEdit: `v${base.n}` } } as any);
  const done: any = await genWait(job.id, undefined, 15 * 60_000);
  const outs = done.outputs ?? [];
  const cut = outs.find((o: any) => o.kind === 'video')?.asset;
  if (done.status !== 'done' || !cut) throw new StudioError(`The quick edit didn't render: ${done.error ?? done.detail ?? done.status}`);
  const poster = outs.find((o: any) => o.kind === 'image')?.asset ?? base.poster ?? undefined;
  const summary = `Quick edit of v${base.n} by ${by}: ${next.said}.`;
  const v = recordVersion(task, base.change ?? c.id, { asset: cut, poster, seconds: Number(done.result?.duration) || undefined, summary, caption: base.caption ?? undefined, beats: base.beats ?? undefined, stage: base.stage, story: base.story ?? undefined, edit: next.edit }, 'quick')!;
  const tell = `Studio made a quick edit for ${by}: v${v.n} is v${base.n} with ${next.said}. Make it your edit too (its edit is in Studio, version v${v.n}): ${JSON.stringify(next.edit).slice(0, 6000)}`;
  db.prepare('INSERT INTO video_notes (id, task, version, from_s, to_s, action, text, by, at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(newId('vn'), task, base.n, op.from, op.to, `quick:${op.op}`, tell, by, Date.now(), 'quick');
  addComment(task, summary, by, 'edit');
  logDecision('video', task, t.product, `${by}: ${summary}`);
  return { version: v, video: await videoDetail(task) };
}

/** J approves a version: the change merges into beta (its scripts and edit list), the task is done, optionally drafts go out. */
export async function approveVideo(task: string, { by = 'J', post = false, platforms, guidance }: { by?: string; post?: boolean; platforms?: string[]; guidance?: string } = {}) {
  const t = getTask(task);
  if (!t || t.kind !== 'video') throw new StudioError(`No video ${task}`, 404);
  const { getChange, approve } = await agents();
  const c = t.change ? getChange(t.change) : null;
  if (!c || c.status !== 'ready') throw new StudioError(`"${t.title}" has no version waiting for you (${c ? c.status : 'not started'})`);
  const v = versionsOf(task).at(-1);
  if (!v) throw new StudioError(`"${t.title}" has no video yet`);
  // An approved animatic: the agent goes on to the final from it (nothing merges yet).
  // J (2026-10-22): the animatic "could be a way to say 'yes go ahead but with this guidance'": his guidance and the
  // notes he kept on it go with the go-ahead.
  if (v.stage === 'animatic') {
    const words = String(guidance ?? '').trim();
    addComment(task, `Approved the animatic v${v.n}: make the final.${words ? ` Guidance: ${words}` : ''}`, by, 'note');
    const kept = pendingForAgent(task);
    await sendNotes(task, [
      `J approved the animatic v${v.n}. Make the final from it now: keep its story, beats, staging and timing (don't redesign them), and render every beat at full quality with the methods your beat sheet names. Mark it "stage": "final".`,
      ...(words ? [`J's guidance for the final: "${words}"`] : []),
      ...(kept.length ? ['Also do these, from his notes on the animatic:', ...kept] : []),
    ], by);
    logDecision('video', task, t.product, `${by} approved the animatic of "${t.title}" (v${v.n}): the final is being made`);
    return { video: await videoDetail(task), social: null, final: 'in progress' };
  }
  const merged = await approve(c.id, { confirm: `MERGE ${c.id}`, by });
  setTask(task, { status: 'verified', merged_at: merged?.merged_at ?? Date.now(), verified_at: Date.now(), pr: c.pr_url });
  addComment(task, `Approved v${v.n}.`, by, 'note');
  logDecision('video', task, t.product, `${by} approved "${t.title}" v${v.n} (${v.asset})`);
  let social: any = null;
  if (post) {
    const { createPost } = await import('./social.ts');
    social = createPost({ asset: v.asset, title: t.title.replace(/^Video:\s*/, ''), description: v.caption ?? '', product: t.product, platforms }, by);
  }
  return { video: await videoDetail(task), social };
}

// ------------------------------------------------------------------------------------------------ routes

type Send = (res: import('node:http').ServerResponse, status: number, body: unknown) => void;
export async function handleVideosApi(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL, send: Send, readJson: (r: any) => Promise<any>, by: string) {
  const route = url.pathname;
  const method = req.method ?? 'GET';
  let m: RegExpExecArray | null;
  try {
    if (route === '/api/videos' && method === 'GET') return send(res, 200, { videos: await listVideos(Number(url.searchParams.get('limit')) || 60), formats: FORMATS });
    if (route === '/api/videos' && method === 'POST') {
      const b = await readJson(req);
      // Started from Talk: the version notices go back into that conversation (tellTalk).
      const origin = String(req.headers['x-talk-conversation'] ?? '').trim() || null;
      const t = createVideo({ ...b, spec: readSpec({ ...b, ...(b.spec ?? {}) }), by, origin });
      if (t.gpu) await (await import('./roadmap.ts')).estimateTask(t.id).catch((e: any) => console.warn(`[videos] pricing ${t.id}: ${e.message ?? e}`));
      const { kick } = await import('./pm.ts');
      kick();
      return send(res, 200, await videoDetail(t.id));
    }
    if ((m = /^\/api\/videos\/(k_[0-9a-f]+)$/.exec(route)) && method === 'GET') return send(res, 200, await videoDetail(m[1]));
    if ((m = /^\/api\/videos\/(k_[0-9a-f]+)\/notes$/.exec(route)) && method === 'POST') {
      const b = await readJson(req);
      return send(res, 200, await noteVideo(m[1], b.text, { at: b.at, from: b.from, to: b.to, action: b.action, version: b.version, x: b.x, y: b.y, hold: Boolean(b.hold), by }));
    }
    if ((m = /^\/api\/videos\/(k_[0-9a-f]+)\/notes\/send$/.exec(route)) && method === 'POST') {
      const b = await readJson(req);
      return send(res, 200, await sendDrafts(m[1], { text: b.text, by }));
    }
    if ((m = /^\/api\/videos\/(k_[0-9a-f]+)\/notes\/(vn_[0-9a-f]+)$/.exec(route)) && method === 'DELETE') {
      dropDraft(m[1], m[2]);
      return send(res, 200, await videoDetail(m[1]));
    }
    if ((m = /^\/api\/videos\/(k_[0-9a-f]+)\/edit$/.exec(route)) && method === 'POST') {
      const b = await readJson(req);
      const num = (v: unknown) => Number(v);
      const op: EditOp = b.op === 'remove' ? { op: 'remove', from: num(b.from), to: num(b.to) }
        : b.op === 'speed' ? { op: 'speed', from: num(b.from), to: num(b.to), factor: num(b.factor) || 1.5 }
        : b.op === 'zoom' ? { op: 'zoom', from: num(b.from), to: num(b.to), zoom: num(b.zoom) || 1.4, x: b.x == null ? undefined : num(b.x), y: b.y == null ? undefined : num(b.y), push: Boolean(b.push) }
        : (() => { throw new StudioError('op is remove, speed or zoom'); })();
      return send(res, 200, await quickEdit(m[1], op, { by }));
    }
    if ((m = /^\/api\/videos\/(k_[0-9a-f]+)\/approve$/.exec(route)) && method === 'POST') {
      const b = await readJson(req);
      return send(res, 200, await approveVideo(m[1], { by, post: Boolean(b.post), platforms: b.platforms, guidance: b.guidance }));
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e: any) {
    return send(res, e.status ?? 400, { error: e.message });
  }
}
