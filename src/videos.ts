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

const agents = () => import('./agents.ts');
export const FORMATS: Record<string, string> = {
  short: 'vertical 1080x1920, 15-60 s, for TikTok, YouTube Shorts and Reels',
  wide: 'horizontal 1920x1080, 30-120 s, for YouTube and the product sites',
};
const ASSET = /^a_[0-9a-f]{8,32}$/;
/**
 * The GPU budget: 'gpu' (the default) lets the director use everything Hawkes Gen has (Blender guide renders, the video
 * models, lip-sync, LoRAs), priced from these items and approved like any content task (under costs.gpuAutoApprove by
 * itself, else J's card); 'none' keeps it to the library, voices and compositing (no server starts for it).
 */
export const BUDGETS: Record<string, { label: string; gpu: any[] | null }> = {
  gpu: { label: 'GPU allowed: Blender, the video models, lip-sync (priced)', gpu: [
    { tool: 'film.gate', count: 4, label: 'staging checks' },
    { tool: 'blender.render', count: 6, label: 'guide and shot renders' },
    { tool: 'image.edit', count: 6, label: 'keyframes on-model' },
    { tool: 'video.control', count: 4, label: 'repaints' },
    { tool: 'video.motion', count: 2, label: 'motion transfers' },
    { tool: 'video.talk', count: 2, label: 'lip-synced lines' },
  ] },
  none: { label: 'No GPU: the library, voices and compositing only', gpu: null },
};

export type Version = { id: string; task: string; n: number; change: string | null; asset: string; poster: string | null; seconds: number | null; summary: string | null; caption: string | null; at: number };
const toVersion = (r: any): Version => r;

export const isVideoTask = (taskId: string | null | undefined) => Boolean(taskId) && getTask(taskId!)?.kind === 'video';
export const isVideoChange = (c: { task?: string | null } | null | undefined) => isVideoTask(c?.task);

export function versionsOf(task: string): Version[] {
  return (db.prepare('SELECT * FROM video_versions WHERE task = ? ORDER BY n').all(task) as any[]).map(toVersion);
}

/** What the agent says it made this pass (.hawkes/video.json), checked. null when it left none or it isn't usable. */
export function readVideoFile(worktree: string): { asset: string; poster?: string; seconds?: number; summary?: string; caption?: string } | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(worktree, '.hawkes', 'video.json'), 'utf8'));
    if (!ASSET.test(String(v.asset ?? ''))) return null;
    return {
      asset: v.asset, poster: ASSET.test(String(v.poster ?? '')) ? v.poster : undefined,
      seconds: Number.isFinite(Number(v.seconds)) ? Number(v.seconds) : undefined,
      summary: v.summary ? String(v.summary).slice(0, 2000) : undefined, caption: v.caption ? String(v.caption).slice(0, 2200) : undefined,
    };
  } catch {
    return null;
  }
}

/** A new version from a pass of the video's change (the same asset as the last one isn't a new version). */
export function recordVersion(task: string, change: string, v: NonNullable<ReturnType<typeof readVideoFile>>): Version | null {
  const all = versionsOf(task);
  if (all.at(-1)?.asset === v.asset) return null;
  const id = newId('vv');
  db.prepare('INSERT INTO video_versions (id, task, n, change, asset, poster, seconds, summary, caption, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, task, all.length + 1, change, v.asset, v.poster ?? null, v.seconds ?? null, v.summary ?? null, v.caption ?? null, Date.now());
  return toVersion(db.prepare('SELECT * FROM video_versions WHERE id = ?').get(id));
}

/** Called when a video's change is ready (agents.ts finish): keep its version; notes J left while it worked go back at once. */
export async function videoReady(c: { id: string; task: string; worktree: string }): Promise<{ version: Version | null; resent: boolean }> {
  const v = readVideoFile(c.worktree);
  const version = v ? recordVersion(c.task, c.id, v) : null;
  const t = getTask(c.task)!;
  logDecision('video', t.id, t.product, version ? `"${t.title}" v${version.n} is ready to screen` : `"${t.title}": the pass left no video (.hawkes/video.json)`);
  if (version) await tellTalk(t, version).catch((e: any) => console.warn(`[videos] telling Talk about ${t.id}: ${e.message ?? e}`));
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
  const text = `"${title}" v${v.n} is ready to screen (video ${t.id}${v.seconds ? `, ${Math.round(v.seconds)} s` : ''}).${v.summary ? ` ${v.summary.slice(0, 400)}` : ''}
Watch it: ${PUBLIC_URL}/#videos/${t.id}
Tell me what to change and I'll send it back, or say it's good and I'll approve it.`;
  const row = db.prepare('SELECT conversation FROM video_state WHERE task = ?').get(t.id) as { conversation: string | null } | undefined;
  const origin = row?.conversation ?? getItem(t.item)?.origin ?? null;
  if (origin && talk.studioSays(origin, text)) return;
  const id = talk.postNotice(`Video: ${title}`, text);
  db.prepare('INSERT INTO video_state (task, conversation) VALUES (?, ?) ON CONFLICT(task) DO UPDATE SET conversation = excluded.conversation').run(t.id, id);
}

/** What J sees per video: where it is, in his words. */
function stateOf(t: Task, c: any, versions: Version[]): string {
  if (t.status === 'verified' || t.status === 'live') return 'approved';
  if (t.status === 'dropped') return 'dropped';
  if (!c) return t.status === 'planned' ? 'queued' : t.status;
  if (c.status === 'ready') return versions.length ? 'ready to screen' : 'no video yet';
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
  const versions = versionsOf(task);
  return {
    task: t, item: getItem(t.item), state: stateOf(t, c, versions), versions,
    notes: commentsOn(task).map((m: any) => ({ by: m.by, kind: m.kind, text: m.text, at: m.at })),
    change: c ? { id: c.id, status: c.status, detail: c.detail, log: (c.log ?? []).slice(-12) } : null,
  };
}

/** The agent's request for a new video: J's script and what the format means. */
export function videoRequest(a: { title: string; script: string; format?: string; budget?: string; direction?: string }) {
  const format = FORMATS[a.format ?? 'short'] ? a.format ?? 'short' : 'short';
  const budget = BUDGETS[a.budget ?? 'gpu'] ? a.budget ?? 'gpu' : 'gpu';
  return `Make the video "${a.title}" (${format}: ${FORMATS[format]}). ${BUDGETS[budget].label}. Load the video skill
first; it is how videos are made here.

## J's script
${a.script.trim()}
${a.direction?.trim() ? `\n## Direction\n${a.direction.trim()}\n` : ''}
Keep J's lines as written (fix only obvious typos). Cast each character with their own voice. Leave the finished cut's
Gen asset in .hawkes/video.json; J screens it in Studio and his notes come back to you as revisions.`;
}

/** A new video: a roadmap item and its video task, planned, so the PM starts it. */
export function createVideo(a: { product: string; title: string; script: string; format?: string; budget?: string; direction?: string; gpu?: unknown; priority?: string; by?: string; origin?: string | null }) {
  if (!String(a.title ?? '').trim()) throw new StudioError('A video needs a title');
  if (!String(a.script ?? '').trim()) throw new StudioError('A video needs a script (the lines, who says them, what happens)');
  if (a.format && !FORMATS[a.format]) throw new StudioError(`format is ${Object.keys(FORMATS).join(' or ')}`);
  if (a.budget && !BUDGETS[a.budget]) throw new StudioError(`budget is ${Object.keys(BUDGETS).join(' or ')}`);
  const budget = a.budget ?? 'gpu';
  // A video's files go to a product's repo (and beta); Studio's and Gen's own repos deploy on merge, so never there.
  if (isInfra(a.product)) throw new StudioError(`Videos belong to a product (its characters and repo), not ${a.product}`);
  const title = String(a.title).trim().slice(0, 140);
  const item = addItem({ product: a.product, title: `Video: ${title}`, goal: `A ${a.format ?? 'short'} video J approves in the Screening tab.`, status: 'planned', priority: a.priority, by: a.by ?? 'J', origin: a.origin ?? null });
  const task = addTask({ item: item.id, title: `Video: ${title}`, request: videoRequest({ title, script: a.script, format: a.format, budget, direction: a.direction }), criteria: ['J approves it in the Screening tab'], kind: 'video', gpu: a.gpu ?? BUDGETS[budget].gpu ?? undefined, priority: a.priority });
  addComment(task.id, `Script (${a.format ?? 'short'}):\n${a.script.trim()}`, a.by ?? 'J', 'script');
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
  revise(c.id, `J's notes on ${v ? `v${v.n}` : 'the last pass'} (make a new version that answers every one; change only what they're about):\n${notes.map((n) => `- ${n}`).join('\n')}`, by);
  db.prepare('INSERT INTO video_state (task, notes_sent_at) VALUES (?, ?) ON CONFLICT(task) DO UPDATE SET notes_sent_at = excluded.notes_sent_at').run(task, Date.now());
  setTask(task, { status: 'working' });
  logDecision('video', task, t.product, `notes sent to the agent on "${t.title}": ${notes.join(' | ').slice(0, 300)}`);
  return true;
}

/**
 * J's note on a video (at: seconds into the version he was watching). Sent to the agent now when it's waiting for him;
 * while it works, kept and sent when its pass ends (videoReady).
 */
export async function noteVideo(task: string, text: string, { at, version, by = 'J' }: { at?: number | null; version?: number | null; by?: string } = {}) {
  const t = getTask(task);
  if (!t || t.kind !== 'video') throw new StudioError(`No video ${task}`, 404);
  const note = String(text ?? '').trim();
  if (!note) throw new StudioError('Say what to change');
  const stamp = [version ? `v${version}` : null, at != null && Number.isFinite(Number(at)) ? `at ${Math.floor(Number(at) / 60)}:${String(Math.floor(Number(at) % 60)).padStart(2, '0')}` : null].filter(Boolean).join(' ');
  const full = stamp ? `[${stamp}] ${note}` : note;
  addComment(task, full.slice(0, 4000), by, 'note');
  const sent = await sendNotes(task, [full], by);
  return { sent, queued: !sent, video: await videoDetail(task) };
}

/** J approves a version: the change merges into beta (its scripts and edit list), the task is done, optionally drafts go out. */
export async function approveVideo(task: string, { by = 'J', post = false, platforms }: { by?: string; post?: boolean; platforms?: string[] } = {}) {
  const t = getTask(task);
  if (!t || t.kind !== 'video') throw new StudioError(`No video ${task}`, 404);
  const { getChange, approve } = await agents();
  const c = t.change ? getChange(t.change) : null;
  if (!c || c.status !== 'ready') throw new StudioError(`"${t.title}" has no version waiting for you (${c ? c.status : 'not started'})`);
  const v = versionsOf(task).at(-1);
  if (!v) throw new StudioError(`"${t.title}" has no video yet`);
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
    if (route === '/api/videos' && method === 'GET') return send(res, 200, { videos: await listVideos(Number(url.searchParams.get('limit')) || 60), formats: FORMATS, budgets: Object.fromEntries(Object.entries(BUDGETS).map(([k, l]) => [k, l.label])) });
    if (route === '/api/videos' && method === 'POST') {
      const b = await readJson(req);
      // Started from Talk: the version notices go back into that conversation (tellTalk).
      const origin = String(req.headers['x-talk-conversation'] ?? '').trim() || null;
      const t = createVideo({ ...b, by, origin });
      if (t.gpu) await (await import('./roadmap.ts')).estimateTask(t.id).catch((e: any) => console.warn(`[videos] pricing ${t.id}: ${e.message ?? e}`));
      const { kick } = await import('./pm.ts');
      kick();
      return send(res, 200, await videoDetail(t.id));
    }
    if ((m = /^\/api\/videos\/(k_[0-9a-f]+)$/.exec(route)) && method === 'GET') return send(res, 200, await videoDetail(m[1]));
    if ((m = /^\/api\/videos\/(k_[0-9a-f]+)\/notes$/.exec(route)) && method === 'POST') {
      const b = await readJson(req);
      return send(res, 200, await noteVideo(m[1], b.text, { at: b.at, version: b.version, by }));
    }
    if ((m = /^\/api\/videos\/(k_[0-9a-f]+)\/approve$/.exec(route)) && method === 'POST') {
      const b = await readJson(req);
      return send(res, 200, await approveVideo(m[1], { by, post: Boolean(b.post), platforms: b.platforms }));
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e: any) {
    return send(res, e.status ?? 400, { error: e.message });
  }
}
