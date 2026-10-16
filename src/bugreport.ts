// J's bug reports from the beta sites: the "report a bug" button Studio puts into every page of
// https://<sub>.hawkesgen.com/ (previews.ts injects it into each HTML file it publishes; never into a product repo or a
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

import fs from 'node:fs';
import path from 'node:path';
import { db, newId, J, parse } from './db.ts';
import { DATA, getProduct, today, StudioError } from './config.ts';
import { keyOf } from './backlog.ts';
import { gen, genWait, fileUrl } from './gen.ts';
import { PUBLIC_URL } from './notify.ts';
import './roadmap.ts'; // milestones, items, and the findings columns source, milestone, report


const DIR = path.join(DATA, 'bugreports');
const STATE = path.join(DATA, 'bugreports.json');
const MAX_SHOT = 6 * 1024 * 1024;

/** What the page sends (dashboard-free: the injected script, report-widget below). */
export type ReportIn = {
  text?: string; blocker?: boolean; url?: string; title?: string; shot?: string | null;
  viewport?: { w?: number; h?: number; dpr?: number }; device?: { ua?: string; touch?: boolean; platform?: string; lang?: string };
  console?: { level?: string; text?: string; at?: number }[]; state?: unknown; report?: unknown;
  build?: { product?: string; sha?: string; ref?: string; change?: string; built?: number };
};

/** Kept with the finding (findings.report). */
export type Report = {
  text: string; url: string | null; page: string | null; device: string; viewport: string; build: ReportIn['build'] | null;
  console: { level: string; text: string }[]; state: string | null; game: string | null; shot: string | null; asset: string | null;
  conversation: string | null; milestone: string | null; told: string | null; at: number;
};

const cut = (s: unknown, n: number) => { const t = typeof s === 'string' ? s : s == null ? '' : JSON.stringify(s); return t.length > n ? `${t.slice(0, n)}…` : t; };
const name = (product: string) => { try { return getProduct(product).name; } catch { return product; } };
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
export type PageInfo = { product: string; sha?: string | null; ref?: string; change?: string; built?: number };

// Errors from before the widget loads: a tiny hook at the top of <head> (the widget reads window.__hawkesLog).
const HOOK = `<script data-hawkes-report>window.__hawkesLog=window.__hawkesLog||[];(function(l){function p(v,a){try{l.push({level:v,at:Date.now(),text:[].map.call(a,function(x){return x instanceof Error?(x.stack||x.message):typeof x=='string'?x:JSON.stringify(x)}).join(' ').slice(0,400)});if(l.length>60)l.splice(0,l.length-60)}catch(e){}}['error','warn'].forEach(function(v){var o=console[v];console[v]=function(){p(v,arguments);return o.apply(this,arguments)}});addEventListener('error',function(e){p('error',[e.message||'error',e.filename?e.filename+':'+e.lineno:''])});addEventListener('unhandledrejection',function(e){p('error',['unhandled rejection:',e.reason])});window.__hawkesLogHooked=1})(window.__hawkesLog)</script>`;

/** A beta page with the button in it: the console hook first in <head>, the widget before </body>. */
export function injectReport(html: string, info: PageInfo) {
  // Whole documents only (a fragment a page fetches and inserts stays as it is).
  if (html.includes('data-hawkes-report') || !/<(html|head|body)[\s>]/i.test(html)) return html;
  const attr = JSON.stringify(info).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
  const widget = `<script src="/dev/__studio/report.js" data-hawkes='${attr}' defer></script>`;
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
  const p = getProduct(productId);
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
    shot, asset: null, conversation: null, milestone: t?.milestone ?? null, told: null, at: now,
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
    talk.studioSays(conversation, [
      `J reported a ${b.blocker ? 'blocker' : 'bug'} from ${p.name}'s beta site${t ? ` while testing **${t.title}**` : ''}: "${cut(text, 600) || '(no words, see the screenshot)'}"`,
      `Finding ${id} (source J: top priority; the PM loop starts an agent on it before anything else).${r.build?.ref ? ` Build: ${r.build.ref}${r.build.sha ? ` ${r.build.sha}` : ''}.` : ''} Page: ${r.url ?? '-'} · ${r.viewport} · ${r.device.split(' · ').slice(0, 2).join(', ')}`,
      r.console.filter((c) => c.level === 'error').length ? `Console errors: ${r.console.filter((c) => c.level === 'error').slice(-3).map((c) => c.text).join(' | ')}` : '',
      shot ? `![screenshot](${shotUrl(r, id)})${r.shot ? `\nScreenshot file (Read it): ${r.shot}` : ''}` : '',
    ].filter(Boolean).join('\n\n'));
  }
  const pm = await import('./pm.ts');
  pm.pmEvent('report', `J reported [${b.blocker ? 'blocker' : 'bug'}] "${title}" on ${p.name}'s beta (${id})${t ? `, testing milestone "${t.title}" (${t.milestone})` : ''}. It is top priority: start it first.`, id, p.id);
  pm.kick(1000);
  return { ok: true, id, title, milestone: t ? { id: t.milestone, title: t.title } : null, message: `Got it: becomes a task for ${where}.`, conversation };
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
    r.shot ? `Screenshot: ${r.shot}` : '',
  ].filter(Boolean).join('\n');
}

async function importShot(id: string, product: string, file: string, title: string) {
  const job = await gen.submit('file.import', { project: product, params: { title: `J's report: ${title}`.slice(0, 200), meta: { report: id, source: 'J' } }, inputs: { file } });
  const done: any = await genWait(job.id, undefined, 60_000);
  const asset = done?.outputs?.[0]?.asset;
  if (done?.status !== 'done' && !asset) throw new Error(done?.error ?? done?.status ?? 'no output');
  db.prepare('UPDATE findings SET shots = ? WHERE id = ?').run(J([asset]), id);
  setReport(id, { asset });
}

export function getReport(id: string): Report | null {
  const r = db.prepare(`SELECT report FROM findings WHERE id = ? AND source = 'J'`).get(id) as any;
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
