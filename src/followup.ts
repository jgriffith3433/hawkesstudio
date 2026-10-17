// Results come back to the Talk conversation that started the work. Talk's Studio MCP server sends the conversation id
// (X-Talk-Conversation) on its calls; the API records it as the origin of what the call starts: agent changes
// (studio_fix, studio_task, a revision), the beta run after an approval, playtests, builds, beta runs, and the live
// check after a go live or rollback. When one finishes (a change ready or failed, a run done or failed), a short notice
// goes into that conversation and Claude explains it there by itself (talk.ts studioSays: batched per minute, one turn
// at a time). Work that no conversation started (the daily run, J's dashboard buttons) only notifies J's phone.

import type http from 'node:http';
import { db, parse } from './db.ts';
import { GEN_PUBLIC_URL, getProduct, getInfra, isInfra } from './config.ts';
import { PUBLIC_URL } from './notify.ts';

try { db.exec('ALTER TABLE runs ADD COLUMN origin TEXT'); } catch { /* already there */ }
try { db.exec('ALTER TABLE runs ADD COLUMN told TEXT'); } catch { /* already there */ }
// Changes of a roadmap task (changes.task) report through the PM, and PM conversations (conversations.kind 'pm') get no
// result turns from here: the PM loop handles both.
try { db.exec('ALTER TABLE changes ADD COLUMN task TEXT'); } catch { /* already there */ }
try { db.exec('ALTER TABLE conversations ADD COLUMN kind TEXT'); } catch { /* already there */ }
const notPm = `origin NOT IN (SELECT id FROM conversations WHERE kind = 'pm')`;

/** The Talk conversation a request came from (Talk's MCP server sends it), if it still exists. */
export function originOf(req: http.IncomingMessage) {
  const id = String(req.headers['x-talk-conversation'] ?? '');
  if (!/^t_[0-9a-f]{6,32}$/.test(id)) return null;
  return db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id) ? id : null;
}

/** A change reports to `origin` (a revision moves it to the conversation that asked for it). */
export function tagChange(id: string, origin: string | null, by?: string | null) {
  if (origin) db.prepare('UPDATE changes SET origin = ?, told = NULL WHERE id = ?').run(origin, id);
  if (by) db.prepare('UPDATE changes SET started_by = COALESCE(started_by, ?) WHERE id = ?').run(by, id);
}
export function tagRun(id: string, origin: string | null | undefined) {
  if (origin) db.prepare('UPDATE runs SET origin = ? WHERE id = ?').run(origin, id);
}

const name = (product: string) => {
  try {
    return isInfra(product) ? getInfra(product).name : getProduct(product).name;
  } catch {
    return product;
  }
};
const media = (asset: string) => `${GEN_PUBLIC_URL}/v1/files/${asset}`;
const cut = (s: unknown, n: number) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** The notice for a finished agent change. */
export function changeNotice(c: any) {
  const v = parse(c.verify) ?? {};
  const head = `Agent change ${c.id} for ${name(c.product)} ${c.status === 'ready' ? 'is ready for J' : 'failed'}: "${c.title}".`;
  const lines = [head];
  if (c.status === 'failed') lines.push(`Why: ${cut(c.detail, 400)}`);
  if (c.status === 'ready' && v.kind === 'infra') lines.push(`Checks: ${v.outcome} (${cut(v.summary, 400)})`);
  else if (c.status === 'ready') {
    // Playtests of a change run only on request (agents.ts playtestChange): without one, it's ready on the agent's checks.
    const played = Boolean(v.playtest || (v.outcome && v.outcome !== 'not played'));
    lines.push(played
      ? `Playtest: ${v.outcome}${v.verdict ? `, review verdict ${v.verdict}` : ''}${v.error ? ` (${cut(v.error, 200)})` : ''}.`
      : `Not playtested (a playtest runs only when asked for: studio_change { action: "playtest" })${v.error ? `; the last one asked for couldn't run: ${cut(v.error, 200)}` : ''}. Its criteria are judged by beta's playtest after the merge.`);
    if (v.summary) lines.push(`Review: ${cut(v.summary, 600)}`);
    if (v.build) lines.push(`Build: ${v.build.ok ? `Game/v${v.build.version ?? '?'} in ${v.build.minutes ?? '?'} min` : `failed: ${cut(v.build.error, 200)}`}`);
    if (v.findings?.length) lines.push(`Review findings: ${v.findings.slice(0, 4).map((f: any) => `[${f.severity}] ${f.title}`).join('; ')}`);
  }
  if (c.summary) lines.push(`The agent's summary: ${cut(c.summary, 900)}`);
  if (c.pr_url) lines.push(`Pull request: ${c.pr_url}`);
  if (v.preview) lines.push(`Preview: ${v.preview}`);
  if (v.video) lines.push(`Video of the playtest: ${media(v.video)}`);
  lines.push(`In Studio (playtest, review, log): ${PUBLIC_URL}/#changes/${c.id}`);
  if (c.status === 'ready') lines.push(`Approving needs J's yes (confirm "MERGE ${c.id}"); he can also ask for changes (revise).`);
  return lines.join('\n');
}

const STEP_KINDS = new Set(['build', 'playtest', 'review', 'beta', 'deploy', 'check', 'error', 'asset', 'gpu']);

/** The notice for a finished run: its build, playtests and their review verdicts. */
export function runNotice(r: any) {
  const products = (parse(r.products) ?? []) as string[];
  const opts = parse(r.options) ?? {};
  const steps = (db.prepare('SELECT * FROM steps WHERE run = ? ORDER BY started').all(r.id) as any[]).map((s) => ({ ...s, data: parse(s.data) }));
  const what = r.kind === 'beta' ? 'Beta run' : r.kind === 'live' ? 'Go-live publish' : r.kind === 'playtest' ? (opts.where === 'live' ? 'Live playtest' : 'Playtest') : r.kind === 'build' ? 'Build' : `${r.kind} run`;
  const lines = [`${what} ${r.id} (${products.map(name).join(', ')}) ${r.status === 'done' ? 'finished' : r.status}: ${cut(r.detail, 200)}${r.cost ? ` · $${Number(r.cost).toFixed(2)}` : ''}.`];
  if (opts.focus) lines.push(`Why it ran: ${cut(opts.focus, 300)}`);
  for (const s of steps) {
    if (!STEP_KINDS.has(s.kind) && s.status !== 'failed') continue;
    lines.push(`- ${s.kind} ${s.name}: ${s.status}: ${cut(s.detail, 240)}`);
    if (s.kind === 'review' && s.data?.summary) lines.push(`  Review: ${cut(s.data.summary, 500)}`);
    if (s.kind === 'review' && s.data?.findings?.length) lines.push(`  Findings: ${s.data.findings.slice(0, 4).map((f: any) => `[${f.severity}] ${f.title}`).join('; ')}`);
    if (s.kind === 'playtest' && s.data?.video) lines.push(`  Video: ${media(s.data.video)} · playtest: ${PUBLIC_URL}/#playtests/${s.id}`);
    if (s.kind === 'playtest' && s.data?.played?.sha) lines.push(`  Played ${s.data.played.branch ?? ''} ${String(s.data.played.sha).slice(0, 7)}`);
  }
  if (r.kind !== 'beta' && r.kind !== 'build' && r.kind !== 'live') lines.push(`Report: studio_report { run: "${r.id}" }`);
  return lines.join('\n');
}

/** One look: finished work with an origin that hasn't been told yet. */
export async function checkFollowups() {
  const { studioSays } = await import('./talk.ts');
  // A change that went back to work (a revision) reports again when it's done.
  db.prepare(`UPDATE changes SET told = NULL WHERE told IS NOT NULL AND status IN ('queued', 'working', 'verifying', 'revising')`).run();
  const day = Date.now() - 86_400_000;
  for (const c of db.prepare(`SELECT * FROM changes WHERE origin IS NOT NULL AND task IS NULL AND ${notPm} AND status IN ('ready', 'failed') AND told IS NULL AND COALESCE(updated, created) > ?`).all(day) as any[]) {
    db.prepare('UPDATE changes SET told = ? WHERE id = ?').run(c.status, c.id);
    studioSays(c.origin, changeNotice(c));
  }
  for (const r of db.prepare(`SELECT * FROM runs WHERE origin IS NOT NULL AND ${notPm} AND status != 'running' AND told IS NULL AND started > ?`).all(day) as any[]) {
    db.prepare('UPDATE runs SET told = ? WHERE id = ?').run(r.status, r.id);
    studioSays(r.origin, runNotice(r));
  }
}

/** Looks every 10 seconds (a few rows in SQLite; nothing external). */
export function startFollowups() {
  const tick = () => void checkFollowups().catch((e) => console.warn(`[followup] ${e.message ?? e}`));
  setTimeout(tick, 5000).unref();
  setInterval(tick, 10_000).unref();
}
