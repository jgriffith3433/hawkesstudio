// J's bug reports from the beta sites: the "report a bug" button Studio puts into every page of
// https://<sub>.hawkesgen.ai/ (previews.ts injects it into each HTML file it publishes; never into a product repo or a
// live site). It talks to the product's /dev/ front door (dev-front.ts: /dev/__studio/report.js and POST
// /dev/__studio/report), which Caddy already sends behind the login on every beta host, Unity products included.
//
// A report becomes a finding with source "J": severity bug (or blocker when J says it blocks him), straight into the
// backlog (no review cap, no matching into an older finding), linked to the milestone J is testing (the product's most
// recently reached milestone, else none: the product's roadmap). Its screenshot is kept here (.data/bugreports/) and
// put into Gen's library (file.import), and everything the page knew (URL, device, viewport, the beta commit and build,
// recent console errors, the game's hawkesPlaytest state() and report()) goes into its detail, so the agent's brief has
// it. The PM loop starts J's reports before anything else (pm.ts startWork), Talk hears about it in the milestone's
// conversation (else the day's playtest conversation) and again when an agent takes it, when it's fixed on beta, or
// when it's dropped (reportFollowups).
//
// The page's own uncaught errors are reported too, without J pressing anything: fileAutoError below (source "auto").

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { db, newId, J, parse } from './db.ts';
import { DATA, getProduct, getInfra, isInfra, today, StudioError, BETA_NET } from './config.ts';

/** A product or one of Studio's own services (Hawkes Gen's app reports bugs too: its beta page, src/dev-front.ts). */
const target = (id: string): { id: string; name: string } => (isInfra(id) ? getInfra(id) : getProduct(id));
export { BETA_NET };
import { keyOf, takenBy } from './backlog.ts';
import { gen, genWait, fileUrl, signFileLinks } from './gen.ts';
import { PUBLIC_URL } from './notify.ts';
import './roadmap.ts'; // milestones, items, and the findings columns source, milestone, report


const DIR = path.join(DATA, 'bugreports');
const STATE = path.join(DATA, 'bugreports.json');
const MAX_SHOT = 6 * 1024 * 1024;

/** What the page sends (dashboard-free: the injected script, report-widget below). */
export type ReportIn = {
  text?: string; blocker?: boolean; url?: string; title?: string; shot?: string | null; shotNote?: string | null;
  viewport?: { w?: number; h?: number; dpr?: number }; device?: { ua?: string; touch?: boolean; platform?: string; lang?: string };
  console?: { level?: string; text?: string; at?: number }[]; state?: unknown; report?: unknown; perf?: unknown;
  build?: { product?: string; sha?: string; ref?: string; change?: string; built?: number };
};

/** Kept with the finding (findings.report). */
export type Report = {
  text: string; url: string | null; page: string | null; device: string; viewport: string; build: ReportIn['build'] | null;
  console: { level: string; text: string }[]; state: string | null; game: string | null; perf?: string | null; shot: string | null; asset: string | null;
  /** What the widget says about its screenshot (e.g. the game's frame couldn't be read, so it's the page alone). */
  shotNote?: string | null;
  conversation: string | null; milestone: string | null; told: string | null; at: number;
};

const cut = (s: unknown, n: number) => { const t = typeof s === 'string' ? s : s == null ? '' : JSON.stringify(s); return t.length > n ? `${t.slice(0, n)}…` : t; };
const name = (product: string) => { try { return target(product).name; } catch { return product; } };
const readState = (): { conversations?: Record<string, string> } => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };

/**
 * What J is testing on this product: the milestone most recently reached (ready to test) that has items in it, else an
 * open one with items already on beta; item when exactly one of its items is this product's.
 */
export function testing(product: string) {
  const ms = db.prepare(`SELECT * FROM milestones WHERE status IN ('reached', 'open') AND (product = ? OR product IS NULL OR EXISTS (SELECT 1 FROM items WHERE items.milestone = milestones.id AND items.product = ?))
    ORDER BY CASE status WHEN 'reached' THEN 0 ELSE 1 END, COALESCE(reached_at, 0) DESC, ord`).all(product, product) as any[];
  for (const m of ms) {
    const items = db.prepare(`SELECT id, status FROM items WHERE milestone = ? AND product = ? AND status != 'dropped' ORDER BY ord, created`).all(m.id, product) as any[];
    if (!items.length) continue;
    if (m.status === 'open' && !items.some((i) => ['on beta', 'live', 'done'].includes(i.status))) continue;
    return { milestone: m.id as string, title: m.title as string, origin: (m.origin as string) ?? null, item: items.length === 1 ? (items[0].id as string) : null };
  }
  return null;
}

/** The Talk conversation a report goes to: the milestone's own, else one per product and day ("Playtest: …"). */
async function conversationFor(product: string, t: ReturnType<typeof testing>) {
  const talk = await import('./talk.ts');
  if (t?.origin && talk.getConversation(t.origin)) return t.origin;
  const key = `${product}/${t?.milestone ?? 'roadmap'}/${today()}`;
  const st = readState();
  const id = st.conversations?.[key];
  if (id && talk.getConversation(id)) return id;
  const c = talk.startConversation(`Playtest: ${t ? t.title : name(product)} (${today()})`);
  st.conversations = Object.fromEntries([...Object.entries(st.conversations ?? {}).filter(([k]) => k.endsWith(today())), [key, c.id]]);
  fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
  return c.id;
}

// ------------------------------------------------------------ the page side

/** The widget's source (dashboard/report-widget.js), served by the front doors as /dev/__studio/report.js. */
export const WIDGET = path.join(import.meta.dirname, '..', 'dashboard', 'report-widget.js');

/** What a beta page knows about itself: the product, the commit and what was built (Game/v<n> for Unity), the change. */
// root: where the site starts on its host, for a game added through Talk (its beta site is the path /b/<game> of the
// shared sites. host); the widget and its endpoints live under it. Empty for a product with a host of its own.
// src, endpoint, errors: a page that loads the widget from elsewhere and posts with a project's key (a customer's Studio's
// sites: previews-cloud.ts); the widget reads endpoint and errors from its data-hawkes.
export type PageInfo = { product: string; sha?: string | null; ref?: string; change?: string; built?: number; version?: string; root?: string; src?: string; endpoint?: string; errors?: string };

// Errors from before the widget loads: a tiny hook at the top of <head> (the widget reads window.__hawkesLog, and the
// uncaught errors it queues in window.__hawkesErrs until the widget's window.__hawkesOnError takes them). It also
// makes every WebGL context keep its drawing buffer (preserveDrawingBuffer, forced on even when the game's loader asks
// for false, as Unity's does), so the widget's screenshot can read the game's frame: on iOS Safari the buffer is gone
// by the time anything outside the game's own draw reads it, and the picture came out black. It runs before any game
// script creates its context (beta pages only); window.__hawkesGl marks it.
const GL = `(function(P){if(!P||window.__hawkesGl)return;var g=P.getContext;P.getContext=function(t,a){if(/^(webgl2?|experimental-webgl)$/.test(t)){try{a=Object.assign({},a,{preserveDrawingBuffer:true})}catch(e){}}return g.call(this,t,a)};window.__hawkesGl=1})(window.HTMLCanvasElement&&HTMLCanvasElement.prototype);`;
const NET = `window.HAWKES_NET_ENDPOINT=window.HAWKES_NET_ENDPOINT||${JSON.stringify(BETA_NET)};`;
const HOOK = `<script data-hawkes-report>${NET}${GL}window.__hawkesLog=window.__hawkesLog||[];window.__hawkesErrs=window.__hawkesErrs||[];(function(l,q){function T(x,m){try{return x instanceof Error?(m?x.message:x.stack||x.message):typeof x=='string'?x:JSON.stringify(x)}catch(e){return String(x)}}function p(v,a){try{l.push({level:v,at:Date.now(),text:[].map.call(a,function(x){return T(x)}).join(' ').slice(0,400)});if(l.length>60)l.splice(0,l.length-60)}catch(e){}}function E(k,m,s,f){try{var x={kind:k,message:String(m||'').slice(0,1000),stack:String(s||'').slice(0,3000),source:String(f||''),at:Date.now()};if(window.__hawkesOnError)window.__hawkesOnError(x);else{q.push(x);if(q.length>20)q.shift()}}catch(e){}}['error','warn'].forEach(function(v){var o=console[v];console[v]=function(){p(v,arguments);if(v=='error'){var a=arguments,s='';for(var i=0;i<a.length;i++)if(a[i]instanceof Error){s=a[i].stack||'';break}E('console',[].map.call(a,function(x){return T(x,1)}).join(' '),s)}return o.apply(this,arguments)}});addEventListener('error',function(e){p('error',[e.message||'error',e.filename?e.filename+':'+e.lineno:'']);var r=e.error;E('error',e.message||(r&&r.message),(r&&r.stack)||(e.filename?'at '+e.filename+':'+e.lineno+':'+e.colno:''),e.filename)});addEventListener('unhandledrejection',function(e){p('error',['unhandled rejection:',e.reason]);var r=e.reason;E('rejection',T(r,1),r&&r.stack)});window.__hawkesLogHooked=1})(window.__hawkesLog,window.__hawkesErrs)</script>`;

/** A beta page with the button in it: the console hook first in <head>, the widget before </body>. */
export function injectReport(html: string, info: PageInfo) {
  // Whole documents only (a fragment a page fetches and inserts stays as it is).
  if (html.includes('data-hawkes-report') || !/<(html|head|body)[\s>]/i.test(html)) return html;
  const attr = JSON.stringify(info).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
  const src = (info.src ?? `${info.root ?? ''}/dev/__studio/report.js`).replace(/"/g, '&quot;');
  const widget = `<script src="${src}" data-hawkes='${attr}' defer></script>`;
  // After <meta charset> when it's there (it has to stay in the first 1024 bytes), else right after <head>.
  const head = /<meta[^>]+charset[^>]*>/i.exec(html.slice(0, 2048)) ?? /<head(\s[^>]*)?>/i.exec(html);
  let out = head ? html.slice(0, head.index + head[0].length) + HOOK + html.slice(head.index + head[0].length)
    : /<!doctype[^>]*>/i.test(html) ? html.replace(/<!doctype[^>]*>/i, (d) => d + HOOK) : HOOK + html;
  const end = out.toLowerCase().lastIndexOf('</body>');
  out = end >= 0 ? out.slice(0, end) + widget + out.slice(end) : out + widget;
  return out;
}

const shotUrl =(r: { asset: string | null }, id: string) => (r.asset ? fileUrl(r.asset) : `${PUBLIC_URL}/api/bugreports/${id}/shot`);

/** Stores J's report as a finding, tells Talk and the PM loop. Returns what the panel says back. */
export async function fileReport(productId: string, b: ReportIn) {
  const p = target(productId);
  const text = String(b.text ?? '').trim().slice(0, 4000);
  if (!text && !b.shot) throw new StudioError('Say what is wrong (or send a screenshot)');
  const id = newId('f');
  const now = Date.now();
  // The screenshot, kept here (served at /api/bugreports/<id>/shot), then into Gen's library.
  let shot: string | null = null;
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.shot ?? ''));
  if (m) {
    const data = Buffer.from(m[2], 'base64');
    if (data.length > MAX_SHOT) throw new StudioError('The screenshot is too big');
    fs.mkdirSync(DIR, { recursive: true });
    shot = path.join(DIR, `${id}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
    fs.writeFileSync(shot, data);
  }
  const t = testing(p.id);
  const first = (text.split(/(?<=[.!?])\s|\n/)[0] || 'Reported from the beta site (no words, see the screenshot)').trim();
  const title = (first.length > 90 ? `${first.slice(0, 87).replace(/\s+\S*$/, '')}…` : first);
  const vp = b.viewport ?? {};
  const dev = b.device ?? {};
  const build = b.build ? { product: cut(b.build.product, 40), sha: cut(b.build.sha, 40), ref: cut(b.build.ref, 120), change: b.build.change ? cut(b.build.change, 40) : undefined, built: Number(b.build.built) || undefined } : null;
  const consoleLines = (Array.isArray(b.console) ? b.console : []).slice(-25).map((c) => ({ level: cut(c?.level, 10) || 'log', text: cut(c?.text, 400) }));
  const report: Report = {
    text, url: b.url ? cut(b.url, 500) : null, page: b.title ? cut(b.title, 200) : null,
    device: `${dev.touch ? 'touch' : 'mouse'} · ${cut(dev.platform, 40) || '?'} · ${cut(dev.ua, 300)}`,
    viewport: `${Number(vp.w) || '?'}x${Number(vp.h) || '?'}${vp.dpr ? ` @${Number(vp.dpr)}x` : ''}`,
    build, console: consoleLines, state: b.state == null ? null : cut(b.state, 4000), game: b.report == null ? null : cut(b.report, 4000),
    perf: b.perf == null ? null : cut(b.perf, 8000),
    shot, shotNote: b.shotNote ? cut(b.shotNote, 300) : null, asset: null, conversation: null, milestone: t?.milestone ?? null, told: null, at: now,
  };
  const detail = detailOf(report, t);
  db.prepare(`INSERT INTO findings (id, product, key, title, severity, area, detail, fix, status, scenario, shots, first_seen, last_seen, seen, last_run, note, source, milestone, item, report)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 'J', '[]', ?, ?, 1, NULL, ?, 'J', ?, ?, ?)`)
    .run(id, p.id, keyOf(title), title, b.blocker ? 'blocker' : 'bug', 'J\'s playtest', detail, 'Find the cause from J\'s words, the screenshot, the console and the game state; fix it so what J describes no longer happens.',
      now, now, `J reported it from the beta site ${today()}${t ? ` while testing "${t.title}"` : ''}.`, t?.milestone ?? null, t?.item ?? null, J(report));
  const conversation = await conversationFor(p.id, t).catch(() => null);
  setReport(id, { conversation });
  // Gen's library (best effort; the local copy is what the dashboard falls back to).
  if (shot) await importShot(id, p.id, shot, title).catch((e) => console.warn(`[bugreport] Gen import for ${id}: ${e.message ?? e}`));
  const r = getReport(id)!;
  const where = t ? `the milestone "${t.title}"` : `${p.name}'s roadmap`;
  if (conversation) {
    const talk = await import('./talk.ts');
    talk.studioSays(conversation, await signFileLinks([
      `J reported a ${b.blocker ? 'blocker' : 'bug'} from ${p.name}'s beta site${t ? ` while testing **${t.title}**` : ''}: "${cut(text, 600) || '(no words, see the screenshot)'}"`,
      `Finding ${id} (source J: top priority; the PM loop starts an agent on it before anything else).${r.build?.ref ? ` Build: ${r.build.ref}${r.build.sha ? ` ${r.build.sha}` : ''}.` : ''} Page: ${r.url ?? '-'} · ${r.viewport} · ${r.device.split(' · ').slice(0, 2).join(', ')}`,
      r.console.filter((c) => c.level === 'error').length ? `Console errors: ${r.console.filter((c) => c.level === 'error').slice(-3).map((c) => c.text).join(' | ')}` : '',
      shot ? `![screenshot](${shotUrl(r, id)})${r.shot ? `\nScreenshot file (Read it): ${r.shot}` : ''}${r.shotNote ? `\n(${r.shotNote})` : ''}` : '',
    ].filter(Boolean).join('\n\n')));
  }
  const pm = await import('./pm.ts');
  pm.pmEvent('report', `J reported [${b.blocker ? 'blocker' : 'bug'}] "${title}" on ${p.name}'s beta (${id})${t ? `, testing milestone "${t.title}" (${t.milestone})` : ''}. It is top priority: start it first.`, id, p.id);
  pm.kick(1000);
  return { ok: true, id, title, milestone: t ? { id: t.milestone, title: t.title } : null, message: `Got it: becomes a task for ${where}.`, conversation };
}

function formatPerf(raw: string | null | undefined): string {
  if (!raw) return '';
  let p: any = null;
  try { p = JSON.parse(raw); } catch { return `Performance & scene diagnostics: ${raw}`; }
  if (!p || typeof p !== 'object') return `Performance & scene diagnostics: ${raw}`;
  const lines = ['Performance & scene diagnostics:'];
  if (p.fps && typeof p.fps === 'object') {
    lines.push(`  FPS: ${p.fps.current ?? '?'} current · ${p.fps.avg ?? '?'} avg · ${p.fps.worst ?? '?'} worst · ${p.fps.jankFrames ?? 0} jank frames (>33.3ms)`);
  }
  if (p.timing && typeof p.timing === 'object') {
    lines.push(`  Frame timings: frame ${p.timing.frameMs ?? 0}ms · activeMeshesEval ${p.timing.activeMeshesEvalMs ?? 0}ms · renderTargets ${p.timing.renderTargetsMs ?? 0}ms · mainRender ${p.timing.mainRenderMs ?? 0}ms · animations ${p.timing.animationsMs ?? 0}ms · particles ${p.timing.particlesMs ?? 0}ms · gpu ${p.timing.gpuFrameMs ?? 0}ms · shaderCompiles ${p.timing.shaderCompiles ?? 0}`);
  }
  if (p.drawCalls !== undefined || p.activeTris !== undefined || p.totalMeshes !== undefined) {
    lines.push(`  Scene & draws: ${p.drawCalls ?? 0} draw calls · ${p.activeMeshes ?? 0}/${p.totalMeshes ?? 0} meshes · ${p.activeTris ?? 0}/${p.totalTris ?? 0} tris (${p.shadowTris ?? 0} shadow tris) · ${p.skinnedMeshes ?? 0} skinned (${p.activeBones ?? 0} bones) · ${p.thinInstanceMeshes ?? 0} thin-instanced (${p.thinInstancesTotal ?? 0} instances)`);
  }
  if (p.unfrozenMeshes !== undefined || p.enabledLights !== undefined || p.materialDirtyPerSec !== undefined) {
    lines.push(`  Batching & audit: ${p.unfrozenMeshes ?? 0} unfrozen meshes · ${p.unfrozenMaterials ?? 0} unfrozen materials · ${p.enabledLights ?? 0} enabled lights (${p.zeroIntensityEnabledLights ?? 0} zero-intensity) · ${p.materialDirtyPerSec ?? 0} material dirty/sec`);
  }
  if (Array.isArray(p.renderPasses) && p.renderPasses.length) {
    lines.push(`  Render passes: ${p.renderPasses.map((rp: any) => `${rp.kind || 'Pass'} "${rp.name}" (${rp.resolution || '?'}, ${rp.renderListCount ?? '?'} meshes${rp.fullScene ? ', FULL SCENE' : ''})`).join('; ')}`);
  }
  if (Array.isArray(p.topHeavyMeshes) && p.topHeavyMeshes.length) {
    lines.push(`  Top heavy meshes: ${p.topHeavyMeshes.map((m: any) => `${m.name} (${m.tris ?? 0} tris, ${m.verts ?? '?'} verts${m.skinned ? `, skinned ${m.bones ?? 0}b` : ''}${m.thin ? `, thin x${m.thin}` : ''}${m.castsShadow ? ', shadow' : ''})`).join('; ')}`);
  }
  const delta = p.resources?.delta;
  const cur = p.resources?.current;
  if (delta && typeof delta === 'object') {
    const parts = Object.entries(delta)
      .filter(([, v]) => Number(v) !== 0)
      .map(([k, v]) => `${k} ${Number(v) > 0 ? `+${v}` : v}`);
    const vram = cur?.estimatedTextureMB !== undefined ? ` (VRAM est ${cur.estimatedTextureMB} MB)` : '';
    lines.push(`  Leak deltas${vram}: ${parts.length ? parts.join(', ') : 'none'}`);
  }
  if (Array.isArray(p.suspects) && p.suspects.length) {
    lines.push(`  Root-cause suspects:\n${p.suspects.map((s: any) => `    - ${s}`).join('\n')}`);
  }
  return lines.length > 1 ? lines.join('\n') : `Performance & scene diagnostics: ${raw}`;
}

function detailOf(r: Report, t: ReturnType<typeof testing>) {
  return [
    `J's words: ${r.text || '(none: see the screenshot)'}`,
    `Where: ${r.url ?? '-'}${r.page ? ` ("${r.page}")` : ''} · viewport ${r.viewport} · ${r.device}`,
    r.build ? `Build: ${r.build.ref ?? ''} ${r.build.sha ?? ''}${r.build.change ? ` (agent change ${r.build.change})` : ''}`.trim() : '',
    t ? `Testing: milestone "${t.title}" (${t.milestone})` : '',
    r.console.length ? `Console (latest last):\n${r.console.map((c) => `  [${c.level}] ${c.text}`).join('\n')}` : 'Console: no errors or warnings',
    r.state ? `Game state (hawkesPlaytest.state()): ${r.state}` : '',
    r.game ? `Game report (hawkesPlaytest.report()): ${r.game}` : '',
    r.perf ? formatPerf(r.perf) : '',
    r.shot ? `Screenshot: ${r.shot}` : '',
    r.shotNote ? `Screenshot note: ${r.shotNote}` : '',
  ].filter(Boolean).join('\n');
}

async function importShot(id: string, product: string, file: string, title: string, source: 'J' | 'auto' = 'J') {
  const job = await gen.submit('file.import', { project: product, params: { title: `${source === 'J' ? "J's report" : 'Beta error'}: ${title}`.slice(0, 200), meta: { report: id, source } }, inputs: { file } });
  const done: any = await genWait(job.id, undefined, 60_000);
  const asset = done?.outputs?.[0]?.asset;
  if (done?.status !== 'done' && !asset) throw new Error(done?.error ?? done?.status ?? 'no output');
  db.prepare('UPDATE findings SET shots = ? WHERE id = ?').run(J([asset]), id);
  setReport(id, { asset });
}

// ------------------------------------------------------------ automatic error reports
//
// The widget also reports the page's uncaught errors by itself (window error events, unhandled rejections,
// console.error) to POST /dev/__studio/error: once per signature per page session, at most 5 a session. Here each one
// becomes a finding with source "auto" (scenario "auto-error", severity bug, area "beta errors"): not J's top-priority
// lane, the PM loop takes them like the reviews' bugs (pm.ts startWork, fixBugs). Its key is the error's signature
// (the message and top stack frame, numbers and ids stripped), so the same error again (another page load, another
// device) only counts as seen again and keeps the latest sample. Noise (browser extensions, ResizeObserver loops,
// cross-origin "Script error." with nothing in it, known benign warnings) is dropped, and the endpoint is rate-limited
// per IP.

/** What the page sends for an error it caught: the report's fields (no text), plus the error. */
export type ErrorIn = Omit<ReportIn, 'text' | 'blocker'> & { error?: { kind?: string; message?: string; stack?: string; source?: string } };

// Errors nobody needs to fix: extension code, browser chatter, and opaque cross-origin errors.
const EXT = /(chrome|moz|safari|safari-web|ms-browser)-extension:\/\/|webkit-masked-url:|extensions::|@user-script|__firefox__/i;
const BENIGN = [
  /ResizeObserver loop/i,
  /^(uncaught )?script error\.?$/i,
  /The play\(\) request was interrupted/i,
  /play\(\) failed because the user didn't interact/i,
  /The (AudioContext|request) (was not allowed to start|is not allowed by the user agent)/i,
  /Non-Error promise rejection captured/i,
  /^(Uncaught )?AbortError\b.*\babort/i,
  /\[Violation\]/i,
  /Download the (React|Vue|Babylon\.js) DevTools/i,
];

/** True when an error isn't worth a finding (see above). */
export function isNoise(message: string, stack = '', source = '') {
  const m = String(message ?? '').trim();
  if (!m) return true;
  if (EXT.test(stack) || EXT.test(source) || EXT.test(m)) return true;
  // "Script error." is all a cross-origin script's error says: nothing to go on.
  if (/^(uncaught )?script error\.?$/i.test(m) && !/\bat |@/.test(stack)) return true;
  return BENIGN.some((r) => r.test(m));
}

/** The first stack frame that's the page's own (not the widget or its hook), as file and function. */
function topFrame(stack: string) {
  for (const line of String(stack ?? '').split('\n')) {
    const l = line.trim();
    // Chrome "at fn (url:1:2)" / "at url:1:2"; Firefox and Safari "fn@url:1:2".
    if (!/^at\s|@/.test(l) || /__studio\/report\.js|data-hawkes-report/.test(l)) continue;
    return l.replace(/^at\s+/, '')
      .replace(/\?[^\s:)]*/g, '') // query strings (cache busters)
      .replace(/https?:\/\/[^/\s)]+/g, '') // the host (beta, a change's /c/<id>/)
      .replace(/\/c\/c_[0-9a-f]+\//g, '/');
  }
  return '';
}

const strip = (s: string) => s
  .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '#') // uuids
  .replace(/\b[0-9a-z_-]{6,}\b/gi, (w) => (/[a-z]/i.test(w) && (w.match(/\d/g)?.length ?? 0) >= 2 ? '#' : w)) // ids and bundle hashes
  .replace(/\d+(\.\d+)?/g, '#')
  .replace(/\s+/g, ' ').trim();

/** An error's signature: its message and top stack frame, numbers and ids stripped (same error, same signature). */
export function errorSignature(message: string, stack = '') {
  const m = strip(String(message ?? '').replace(/^Uncaught\s+(?:\(in promise\)\s*)?/i, '').replace(/^unhandled rejection:\s*/i, '').split('\n')[0].slice(0, 300));
  const f = strip(topFrame(stack));
  return f ? `${m} | ${f}` : m;
}

// Per IP: at most 20 error reports in 10 minutes (a page sends at most 5 a session).
const RATE = { n: 20, ms: 10 * 60_000 };
const hits = new Map<string, number[]>();
/** Counts a report from this IP; false when it's over the limit. */
export function rateOk(ip: string, now = Date.now()) {
  const list = (hits.get(ip) ?? []).filter((t) => t > now - RATE.ms);
  if (list.length >= RATE.n) { hits.set(ip, list); return false; }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 2000) for (const [k, v] of hits) if (!v.some((t) => t > now - RATE.ms)) hits.delete(k);
  return true;
}

/** Stores an error the page caught by itself: a new source-"auto" finding, or the open one with its signature seen again. */
export async function fileAutoError(productId: string, b: ErrorIn, ip = '') {
  const p = target(productId);
  if (!rateOk(ip || '?')) throw Object.assign(new StudioError('Too many error reports from here; try again later'), { status: 429 });
  const e = b.error ?? {};
  const message = cut(e.message, 1000).trim();
  const stack = cut(e.stack, 3000);
  if (isNoise(message, stack, cut(e.source, 500))) return { ok: true, ignored: true };
  // (a change's own preview, /c/<id>/, is its build, not beta's)
  const gone = b.build?.change ? null : stalePage(`${message}\n${stack}\n${cut(e.source, 500)}`, await betaVersion(p.id));
  if (gone) return fileStalePage(p.id, b, message, stack, gone);
  const sig = errorSignature(message, stack);
  const key = `auto:${createHash('sha1').update(`${p.id}\n${sig}`).digest('hex').slice(0, 16)}`;
  const now = Date.now();
  const sample = sampleOf(b, message, stack, now);
  const day = today();
  // The same error (open, being fixed, won't-fix, or fixed by a change not merged yet): seen again, latest sample kept.
  const old = db.prepare(`SELECT id, status, report, shots FROM findings WHERE product = ? AND key = ? AND source = 'auto' ORDER BY last_seen DESC LIMIT 1`).get(p.id, key) as any;
  if (old && (old.status !== 'fixed' || takenBy(old.id))) {
    const prev = (parse(old.report) ?? {}) as Report;
    const r: Report = { ...sample, shot: prev.shot ?? null, asset: prev.asset ?? null, shotNote: prev.shotNote ?? null };
    db.prepare(`UPDATE findings SET seen = seen + 1, last_seen = ?, detail = ?, report = ? WHERE id = ?`).run(now, autoDetail(r, kindOf(e), sig), J(r), old.id);
    return { ok: true, id: old.id, seen: true };
  }
  const id = old?.id ?? newId('f');
  const shot = saveShot(id, b.shot);
  const r: Report = { ...sample, shot };
  const title = `Error on beta: ${cut(message.split('\n')[0], 80)}`;
  const fix = 'Find the cause from the error, its stack, the console and the game state; fix it so the error no longer happens on beta (not by hiding it).';
  if (old) {
    // It was fixed and came back.
    db.prepare(`UPDATE findings SET status = 'open', seen = seen + 1, last_seen = ?, detail = ?, report = ?, note = ?, updated = ? WHERE id = ?`)
      .run(now, autoDetail(r, kindOf(e), sig), J(r), `Came back ${day}: it was fixed, and the beta site caught it again.`, now, id);
  } else {
    db.prepare(`INSERT INTO findings (id, product, key, title, severity, area, detail, fix, status, scenario, shots, first_seen, last_seen, seen, last_run, note, source, milestone, item, report)
      VALUES (?, ?, ?, ?, 'bug', 'beta errors', ?, ?, 'open', 'auto-error', '[]', ?, ?, 1, NULL, ?, 'auto', NULL, NULL, ?)`)
      .run(id, p.id, key, title, autoDetail(r, kindOf(e), sig), fix, now, now, `Caught by itself on the beta site ${day}.`, J(r));
  }
  if (shot) void importShot(id, p.id, shot, title, 'auto').catch((err) => console.warn(`[bugreport] Gen import for ${id}: ${err.message ?? err}`));
  return { ok: true, id, seen: Boolean(old) };
}

// ------------------------------------------------------------ stale pages
//
// A page left open on an older Unity beta build (J's iPhone on Game/v54 after beta moved to v55) fails to load that
// build's files once they're gone. That's not a game bug: it's filed as one "stale page" finding per product (seen
// counts up), won't-fix, so no agent ever starts on it. previews.ts keeps the previous build published to make it rare,
// and the page's report button offers "New build: reload".

const LOAD_FAILED = /\b404\b|not found|unable to load|failed to (load|fetch|download)|could not (load|download)|RemoteProviderException|network ?error/i;

/** The build beta's site serves now (its Game/v<n>), or null (not a Unity product, nothing published). */
async function betaVersion(product: string) {
  const b = (await import('./previews.ts')).betaPreview(product);
  return Number(b?.version ?? /Game\/v(\d+)/.exec(b?.ref ?? '')?.[1]) || null;
}

/** The older Game/v<n> an error failed to load, when beta serves a newer build (`current`); else null. */
export function stalePage(text: string, current: number | null) {
  if (!current || !LOAD_FAILED.test(text)) return null;
  const versions = [...String(text).matchAll(/\/Game\/v([1-9]\d*)\//g)].map((m) => Number(m[1]));
  return versions.length && versions.every((v) => v < current) ? { version: Math.max(...versions), current } : null;
}

/** An open automatic report whose latest sample is a stale page (for the ones filed before this check). */
export async function staleReport(f: { product: string; source?: string | null; report?: string | null }) {
  if (f.source !== 'auto') return null;
  const r = parse(f.report ?? null) as Report | null;
  return r?.text && !r.build?.change ? stalePage(r.text, await betaVersion(f.product)) : null;
}

export const staleNote = (s: { version: number; current: number }) =>
  `Stale page, not a game bug: a page still open on beta's older build Game/v${s.version} couldn't load its files after beta moved to Game/v${s.current}. Reloading fixes it (the page offers "New build: reload"); no agent starts on it.`;

function fileStalePage(product: string, b: ErrorIn, message: string, stack: string, s: { version: number; current: number }) {
  const now = Date.now();
  const key = `stale:${product}`;
  const r = sampleOf(b, message, stack, now);
  const detail = [staleNote(s), `Error: ${r.text}`, detailOf({ ...r, text: '' }, null).split('\n').slice(1).join('\n')].filter(Boolean).join('\n');
  const old = db.prepare(`SELECT id FROM findings WHERE product = ? AND key = ? LIMIT 1`).get(product, key) as any;
  if (old) {
    db.prepare(`UPDATE findings SET seen = seen + 1, last_seen = ?, detail = ?, report = ?, note = ?, status = 'wontfix' WHERE id = ?`).run(now, detail, J(r), staleNote(s), old.id);
    return { ok: true, id: old.id, seen: true, stale: true };
  }
  const id = newId('f');
  db.prepare(`INSERT INTO findings (id, product, key, title, severity, area, detail, fix, status, scenario, shots, first_seen, last_seen, seen, last_run, note, source, milestone, item, report)
    VALUES (?, ?, ?, ?, 'polish', 'stale page', ?, ?, 'wontfix', 'stale-page', '[]', ?, ?, 1, NULL, ?, 'auto', NULL, NULL, ?)`)
    .run(id, product, key, 'Stale page: an open page of an older beta build failed to load its files', detail, 'Nothing to fix in the game: reload the page.', now, now, staleNote(s), J(r));
  return { ok: true, id, stale: true };
}

/** A short and a full sha of the same commit match. */
const sameSha = (a: string, b: string) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x.startsWith(y) || y.startsWith(x); };

/**
 * Why an automatic error report waits instead of starting an agent, or null to start one (J, 2026-10-19: three agents
 * in a row found f_7f4ff7149602 came from a build before the fix). It waits when its latest sample was caught on a
 * beta build older than the one beta serves now (`beta`: previews.ts betaPreview) and a change merged in between, so
 * the fix may already be on beta: an agent starts only once the current build catches the same signature again
 * (fileAutoError keeps the latest sample). A change's own preview (/c/<id>/) or a sample without a build never waits.
 */
export function waitsForCurrentBuild(f: { product: string; source?: string | null; report?: string | null }, beta: { sha?: string | null; at: number; status?: string } | null): string | null {
  if (f.source !== 'auto' || !beta?.sha || beta.status !== 'ready') return null;
  const r = parse(f.report ?? null) as Report | null;
  const b = r?.build;
  if (!b?.sha || b.change || sameSha(b.sha, beta.sha)) return null;
  const built = Number(b.built) || r!.at || 0;
  if (!built || built >= beta.at) return null;
  let merged: { id: string } | undefined;
  try {
    merged = db.prepare(`SELECT id FROM changes WHERE product = ? AND status = 'merged' AND merged_at > ? AND merged_at <= ? ORDER BY merged_at DESC LIMIT 1`).get(f.product, built, beta.at) as any;
  } catch {
    return null; // no changes table (agents.ts not loaded)
  }
  if (!merged) return null;
  return `waiting to see it on the current build: caught on ${b.ref || 'beta'} (${b.sha.slice(0, 7)}), older than beta's build ${beta.sha.slice(0, 7)}, and ${merged.id} merged since; an agent starts if the current build catches it again`;
}

const kindOf = (e: NonNullable<ErrorIn['error']>) => (['error', 'rejection', 'console'].includes(String(e.kind)) ? String(e.kind) : 'error');

function sampleOf(b: ErrorIn, message: string, stack: string, now: number): Report {
  const vp = b.viewport ?? {};
  const dev = b.device ?? {};
  return {
    text: stack ? `${message}\n${stack}` : message, url: b.url ? cut(b.url, 500) : null, page: b.title ? cut(b.title, 200) : null,
    device: `${dev.touch ? 'touch' : 'mouse'} · ${cut(dev.platform, 40) || '?'} · ${cut(dev.ua, 300)}`,
    viewport: `${Number(vp.w) || '?'}x${Number(vp.h) || '?'}${vp.dpr ? ` @${Number(vp.dpr)}x` : ''}`,
    build: b.build ? { product: cut(b.build.product, 40), sha: cut(b.build.sha, 40), ref: cut(b.build.ref, 120), change: b.build.change ? cut(b.build.change, 40) : undefined, built: Number(b.build.built) || undefined } : null,
    console: (Array.isArray(b.console) ? b.console : []).slice(-25).map((c) => ({ level: cut(c?.level, 10) || 'log', text: cut(c?.text, 400) })),
    state: b.state == null ? null : cut(b.state, 4000), game: b.report == null ? null : cut(b.report, 4000),
    perf: b.perf == null ? null : cut(b.perf, 8000),
    shot: null, shotNote: b.shotNote ? cut(b.shotNote, 300) : null, asset: null, conversation: null, milestone: null, told: null, at: now,
  };
}

function autoDetail(r: Report, kind: string, sig: string) {
  const what = kind === 'rejection' ? 'An unhandled promise rejection' : kind === 'console' ? 'console.error' : 'An uncaught error';
  return [
    `${what}, caught by the beta site itself (no player action; latest sample below).`,
    `Error: ${r.text}`,
    `Signature: ${sig}`,
    detailOf({ ...r, text: '' }, null).split('\n').slice(1).join('\n'),
  ].filter(Boolean).join('\n');
}

function saveShot(id: string, data: string | null | undefined) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(data ?? ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_SHOT) return null;
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${id}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
  fs.writeFileSync(file, buf);
  return file;
}

export function getReport(id: string): Report | null {
  const r = db.prepare(`SELECT report FROM findings WHERE id = ? AND source IN ('J', 'auto')`).get(id) as any;
  return r ? (parse(r.report) as Report) : null;
}
function setReport(id: string, patch: Partial<Report>) {
  const cur = getReport(id);
  if (cur) db.prepare('UPDATE findings SET report = ? WHERE id = ?').run(J({ ...cur, ...patch }), id);
}

/** The screenshot file of a report (for /api/bugreports/<id>/shot). */
export function reportShot(id: string) {
  const r = getReport(id);
  return r?.shot && fs.existsSync(r.shot) ? r.shot : null;
}

/** J's reports, newest first (Backlog, Talk, Ready to test). */
export function listReports(q: { product?: string; milestone?: string; limit?: number } = {}) {
  const where = [`source = 'J'`];
  const args: any[] = [];
  if (q.product) { where.push('product = ?'); args.push(q.product); }
  if (q.milestone) { where.push('milestone = ?'); args.push(q.milestone); }
  return (db.prepare(`SELECT id, product, title, severity, status, note, milestone, item, shots, first_seen, report FROM findings WHERE ${where.join(' AND ')} ORDER BY first_seen DESC LIMIT ?`).all(...args, q.limit ?? 100) as any[])
    .map((f) => {
      const r = (parse(f.report) ?? {}) as Report;
      return { id: f.id, product: f.product, title: f.title, severity: f.severity, status: f.status, note: f.note, milestone: f.milestone, item: f.item, at: f.first_seen,
        text: r.text, url: r.url, viewport: r.viewport, device: r.device, build: r.build, errors: (r.console ?? []).filter((c) => c.level === 'error').length,
        shot: r.asset ? fileUrl(r.asset) : r.shot ? `/api/bugreports/${f.id}/shot` : null, conversation: r.conversation };
    });
}

/**
 * Talk hears what happens to J's reports: an agent took it, it's fixed (on beta), or it was dropped. Studio runs it
 * every 30 seconds (a few rows in SQLite).
 */
export async function reportFollowups() {
  const rows = db.prepare(`SELECT id, product, title, status, note FROM findings WHERE source = 'J' AND status IN ('fixing', 'fixed', 'wontfix') AND first_seen > ?`).all(Date.now() - 30 * 86_400_000) as any[];
  if (!rows.length) return;
  let talk: typeof import('./talk.ts') | null = null;
  for (const f of rows) {
    const r = getReport(f.id);
    if (!r || r.told === f.status || !r.conversation) continue;
    setReport(f.id, { told: f.status });
    let change: any = null;
    try { change = db.prepare(`SELECT id, pr, status FROM changes WHERE findings LIKE ? ORDER BY created DESC LIMIT 1`).get(`%"${f.id}"%`) ?? null; } catch { /* no changes table (agents.ts not loaded) */ }
    const beta = (await import('./previews.ts')).previewUrl(f.product);
    const text = f.status === 'fixing'
      ? `An agent is on J's report ${f.id} ("${f.title}")${change ? `: change ${change.id}` : ''}.`
      : f.status === 'fixed' && change && change.status !== 'merged' && f.note === `agent change ${change.id}`
        ? `An agent took J's report ${f.id} ("${f.title}"): change ${change.id}. It counts as done; the change merges into beta when it's ready.`
      : f.status === 'fixed'
        ? `J's report ${f.id} ("${f.title}") is fixed${change ? ` (change ${change.id}${change.pr ? `, ${change.pr}` : ''})` : ''}${change?.status === 'merged' ? ' and merged into beta' : ''}.${beta ? ` Try it: ${beta}` : ''}`
        : `J's report ${f.id} ("${f.title}") was marked won't-fix: ${f.note ?? ''}. J can reopen it.`;
    talk ??= await import('./talk.ts');
    talk.studioSays(r.conversation, text);
  }
}

export function startReportFollowups() {
  const t = setInterval(() => void reportFollowups().catch((e) => console.warn(`[bugreport] ${e.message ?? e}`)), 30_000);
  t.unref?.();
}
