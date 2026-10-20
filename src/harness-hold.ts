// The harness hold (J, 2026-10-20: "every time I hit usage limits the agents all get canceled out and I lose work and
// they never start again ... It should just recover itself"). When the harness (Claude Code or Cursor) refuses to run
// (a usage cap, billing, no login, an outage: brains.ts harnessStopOf), Studio holds every new start of that harness
// studio-wide until it answers again, instead of burning tasks' tries one start a minute:
//   - the hold is a row of harness_holds (survives restarts): which harness and account, why, until when. Until = the
//     reset time the message names; else a backoff of 10, 20, 40, then 60 minutes (billing and no login: every 30);
//   - while it's on, agents.ts pump starts nothing (changes stopped by it are parked "queued" with their worktree and
//     session, never failed), the PM loop starts no agents, scouts or rescues, auto-fix starts nothing;
//   - once `until` passes, a cheap probe (one tiny `-p`; Claude with saved accounts: claude-accounts checkAccount). It
//     answers: the hold lifts and the parked changes resume their own sessions. It doesn't: the hold is extended. Another
//     saved Claude account that checks ok is switched to by itself (logged), and the hold lifts;
//   - J's phone hears only when the hold needs him (billing, no login), once per hold, with the exact error. A usage
//     reset or an outage is a Talk line when work pauses and one when it resumes.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { db, J, parse } from './db.ts';
import { PROJECTS } from './config.ts';
import { brainId, harnessStopOf, type Harness, type HarnessKind, type HarnessStop } from './brains.ts';

db.exec(`CREATE TABLE IF NOT EXISTS harness_holds (
  harness TEXT PRIMARY KEY, kind TEXT NOT NULL, why TEXT NOT NULL, line TEXT, account TEXT, since INTEGER NOT NULL,
  until INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, reset INTEGER, notified INTEGER, switched INTEGER,
  lifted INTEGER, log TEXT
)`);

export type Hold = {
  harness: Harness; kind: HarnessKind; why: string; line: string | null; account: string | null; since: number;
  /** When the next probe may run (the parsed reset time, or the backoff). */
  until: number; attempts: number;
  /** Whether `until` is the reset time the harness named (not a backoff). */
  reset: boolean;
  notified: number | null; switched: number | null; lifted: number | null; log: string[];
};
const toHold = (r: any): Hold | null => (r ? { ...r, reset: Boolean(r.reset), log: parse(r.log) ?? [] } : null);
export const getHold = (harness: Harness = brainId()) => toHold(db.prepare('SELECT * FROM harness_holds WHERE harness = ?').get(harness));
/** The hold on this harness now (null: none, or lifted). */
export const activeHold = (harness: Harness = brainId()) => {
  const h = getHold(harness);
  return h && !h.lifted ? h : null;
};
/** Whether the harness in use is held: nothing new starts on it. */
export const harnessHeld = (harness: Harness = brainId()) => Boolean(activeHold(harness));

const LABEL: Record<Harness, string> = { claude: 'Claude', cursor: 'Cursor' };
/** A minute, in ms (STUDIO_HARNESS_MINUTE_MS: tests run the backoff in milliseconds). */
const minute = () => Number(process.env.STUDIO_HARNESS_MINUTE_MS) > 0 ? Number(process.env.STUDIO_HARNESS_MINUTE_MS) : 60_000;
const BACKOFF = [10, 20, 40, 60];
const SEVERITY: Record<HarnessKind, number> = { transient: 0, usage: 1, auth: 2, billing: 3 };
/** J has to act (pay, sign in): his phone hears, once per hold. */
export const needsJ = (kind: HarnessKind) => kind === 'billing' || kind === 'auth';

/** The next probe: the reset time named (a minute after it), else the backoff by how many probes failed. */
export function untilFor(stop: Pick<HarnessStop, 'kind' | 'resetsAt'>, attempts: number, now = Date.now()) {
  if (stop.resetsAt && stop.resetsAt > now) return stop.resetsAt + minute();
  if (needsJ(stop.kind)) return now + 30 * minute();
  return now + BACKOFF[Math.min(attempts, BACKOFF.length - 1)] * minute();
}

/** "13:00 UTC", or "Oct 23, 13:00 UTC" when it isn't today. */
export function whenUtc(at: number, now = Date.now()) {
  const d = new Date(at);
  const hm = d.toISOString().slice(11, 16);
  return d.toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? `${hm} UTC` : `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()}, ${hm} UTC`;
}
const whyOf = (harness: Harness, stop: HarnessStop) => ({
  usage: `${LABEL[harness]} usage ran out`,
  billing: `${LABEL[harness]} billing needs you`,
  auth: `${LABEL[harness]} is not signed in`,
  transient: `${LABEL[harness]} is failing (overloaded or an error)`,
} as const)[stop.kind];
/** What a parked change says: "waiting for Claude usage: resets 08:40 UTC". */
export function holdDetail(h: Pick<Hold, 'harness' | 'kind' | 'until' | 'reset'>) {
  const what = { usage: 'usage', billing: 'billing', auth: 'a login', transient: 'to answer again' }[h.kind];
  return `waiting for ${LABEL[h.harness]} ${what}: ${h.reset ? 'resets' : 'tries again at'} ${whenUtc(h.until)}`;
}

function save(h: Hold) {
  db.prepare(`INSERT INTO harness_holds (harness, kind, why, line, account, since, until, attempts, reset, notified, switched, lifted, log)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(harness) DO UPDATE SET kind = excluded.kind, why = excluded.why,
    line = excluded.line, account = excluded.account, since = excluded.since, until = excluded.until, attempts = excluded.attempts,
    reset = excluded.reset, notified = excluded.notified, switched = excluded.switched, lifted = excluded.lifted, log = excluded.log`)
    .run(h.harness, h.kind, h.why, h.line, h.account, h.since, h.until, h.attempts, h.reset ? 1 : 0, h.notified, h.switched, h.lifted, J(h.log.slice(-40)));
}
const stamp = (line: string) => `${new Date().toISOString().slice(0, 16).replace('T', ' ')} ${line}`;

/** How Studio says things and probes (tests replace them). */
export const holdDeps = {
  /** One tiny run of the harness in use: does it answer? */
  probe: (harness: Harness): Promise<{ ok: boolean; note: string }> => defaultProbe(harness),
  /** Saved Claude accounts other than the one in use, and checking / switching to one. */
  otherAccounts: async (): Promise<{ id: string; label: string }[]> => {
    const { listAccounts } = await import('./claude-accounts.ts');
    const l = listAccounts();
    return l.accounts.filter((a) => !a.active).map((a) => ({ id: a.id, label: a.label }));
  },
  activeAccount: async (): Promise<string | null> => {
    try {
      const { listAccounts } = await import('./claude-accounts.ts');
      const l = listAccounts();
      return l.accounts.find((a) => a.active)?.label ?? null;
    } catch {
      return null;
    }
  },
  checkAccount: async (id: string) => (await import('./claude-accounts.ts')).checkAccount(id),
  useAccount: async (id: string) => void (await import('./claude-accounts.ts')).useAccount(id),
  talk: async (title: string, text: string) => {
    const talk: any = await import('./talk.ts');
    if (typeof talk.postNotice === 'function') talk.postNotice(title, text);
  },
  phone: async (title: string, text: string) => {
    const { notify, PUBLIC_URL } = await import('./notify.ts');
    await notify(title, text, { url: `${PUBLIC_URL}/#settings`, priority: 4, tags: ['warning'] });
  },
};
/** Called when a hold lifts (agents.ts: the queue starts, parked changes resume). */
const lifted: (() => void)[] = [];
export const onHoldLifted = (f: () => void) => void lifted.push(f);

/**
 * The harness stopped something (an agent, a scout, a probe): hold it. A hold already on keeps its start and backoff;
 * a later reset time or a more serious kind (billing, no login) updates it. `source`: what was stopped (for the log).
 * Returns the hold and whether it is new (work just paused).
 */
export function holdHarness(stop: HarnessStop, { source, harness = brainId(), now = Date.now() }: { source: string; harness?: Harness; now?: number }) {
  const cur = getHold(harness);
  if (cur && !cur.lifted) {
    const worse = SEVERITY[stop.kind] > SEVERITY[cur.kind];
    const later = stop.resetsAt && stop.resetsAt + minute() > cur.until;
    if (worse || later) {
      const next: Hold = { ...cur, ...(worse ? { kind: stop.kind, why: whyOf(harness, stop), line: stop.line, notified: null } : {}), ...(later ? { until: stop.resetsAt! + minute(), reset: true } : {}) };
      next.log = [...cur.log, stamp(`${source}: ${stop.line}`)];
      save(next);
      announce(next);
    }
    return { hold: getHold(harness)!, fresh: false };
  }
  // Stopped again soon after a lift (the probe answered, real work didn't): the backoff carries on from where it was.
  const attempts = cur?.lifted && now - cur.lifted < 2 * 3600_000 ? cur.attempts + 1 : 0;
  const h: Hold = {
    harness, kind: stop.kind, why: whyOf(harness, stop), line: stop.line, account: null, since: now,
    until: untilFor(stop, attempts, now), attempts, reset: Boolean(stop.resetsAt && stop.resetsAt > now),
    notified: null, switched: null, lifted: null, log: [stamp(`held: ${source}: ${stop.line}`)],
  };
  save(h);
  void holdDeps.activeAccount().then((a) => {
    const x = getHold(harness);
    if (a && x && !x.lifted && x.since === h.since) save({ ...x, account: a });
  }).catch(() => {});
  announce(h, true);
  return { hold: getHold(harness)!, fresh: true };
}

/** A paused line in Talk (always), and J's phone once per hold when it needs him. */
function announce(h: Hold, fresh = false) {
  if (needsJ(h.kind) && !h.notified) {
    save({ ...h, notified: Date.now() });
    const what = h.kind === 'billing' ? 'pay what the error asks for' : `sign ${LABEL[h.harness]} in again (Settings)`;
    void holdDeps.phone(`Agents paused: ${h.why}`, `${h.line ?? h.why}. Studio holds every agent until it answers: ${what}. It checks again every 30 minutes and resumes by itself.`.slice(0, 400)).catch(() => {});
  }
  if (fresh) {
    void holdDeps.talk(`Agents paused: ${h.why}`, `${h.why} (${h.line ?? '?'}). Every agent change it stopped is parked with its work, not failed; nothing new starts on ${LABEL[h.harness]} until then. ${holdDetail(h).replace(/^waiting for/, 'Waiting for')}. It resumes by itself.`).catch(() => {});
  }
}

/** Lifts the hold (a probe answered, an account switched, or J's own word) and resumes the queue. */
export function liftHold(why: string, harness: Harness = brainId()) {
  const h = activeHold(harness);
  if (!h) return null;
  const next = { ...h, lifted: Date.now(), log: [...h.log, stamp(`lifted: ${why}`)] };
  save(next);
  let parked = 0;
  try { parked = (db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE status = 'queued' AND COALESCE(phase, '') LIKE '%"harness":%'`).get() as any)?.n ?? 0; } catch { /* no changes table here */ }
  void holdDeps.talk(`Agents resumed: ${LABEL[harness]} answers again`, `${LABEL[harness]} answers again (${why}). ${parked ? `${parked} parked change(s) continue their own sessions; ` : ''}the queue and the PM start work again.`).catch(() => {});
  for (const f of lifted) try { f(); } catch { /* the queue's own */ }
  return next;
}

let reviewing = false;
/**
 * Looks at the hold of the harness in use: once its time is up, probe; answered, lift; not, extend with the backoff
 * (or the reset time the probe names). Claude: the first look (and each probe after that fails) also checks the other
 * saved accounts and switches to one that answers. Never blocks: one look at a time, the rest return at once.
 */
export async function reviewHold(now = Date.now()) {
  const h = activeHold();
  if (!h || reviewing) return h;
  const trySwitch = h.harness === 'claude' && !h.switched;
  if (now < h.until && !trySwitch) return h;
  reviewing = true;
  try {
    if (now >= h.until) {
      const p = await holdDeps.probe(h.harness).catch((e: any) => ({ ok: false, note: String(e?.message ?? e) }));
      if (p.ok) return liftHold(`a probe answered: ${p.note}`.slice(0, 200), h.harness);
      const cur = activeHold(h.harness);
      if (!cur) return null;
      const stop = harnessStopOf(p.note) ?? { kind: cur.kind, line: cur.line ?? p.note, resetsAt: null };
      const attempts = cur.attempts + 1;
      const until = untilFor(stop, attempts, Date.now());
      save({ ...cur, attempts, until, reset: Boolean(stop.resetsAt && stop.resetsAt > Date.now()), switched: null, log: [...cur.log, stamp(`probe: still stopped (${p.note.slice(0, 160)}); next at ${whenUtc(until)}`)] });
    }
    if (h.harness === 'claude') {
      const cur = activeHold('claude');
      if (!cur || cur.switched) return cur;
      save({ ...cur, switched: Date.now() });
      for (const a of await holdDeps.otherAccounts().catch(() => [])) {
        const c = await holdDeps.checkAccount(a.id).catch((e: any) => ({ ok: false, note: String(e?.message ?? e) }));
        if (!c.ok) continue;
        await holdDeps.useAccount(a.id);
        const x = activeHold('claude');
        if (x) save({ ...x, log: [...x.log, stamp(`switched to the Claude account "${a.label}" (it answers)`)] });
        void holdDeps.talk('Claude account switched', `${cur.why} on the account in use, so Studio switched to your saved Claude account "${a.label}", which answers.`).catch(() => {});
        return liftHold(`switched to the Claude account "${a.label}"`, 'claude');
      }
    }
    return activeHold(h.harness);
  } finally {
    reviewing = false;
  }
}

/** What studio_pm status and the Roadmap tab show: the hold, and what waits on it. */
export function holdStatus() {
  const h = activeHold();
  if (!h) return null;
  let parked: { id: string; title: string | null; product: string }[] = [];
  let queued = 0;
  try {
    parked = db.prepare(`SELECT id, title, product FROM changes WHERE status = 'queued' AND COALESCE(phase, '') LIKE '%"harness":%' ORDER BY created`).all() as any[];
    queued = (db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE status = 'queued'`).get() as any).n - parked.length;
  } catch { /* no changes table here */ }
  return { harness: h.harness, label: LABEL[h.harness], kind: h.kind, why: h.why, line: h.line, account: h.account, since: h.since, until: h.until, resets: h.reset, next: holdDetail(h), needsJ: needsJ(h.kind), parked, queued, log: h.log.slice(-8) };
}

/** One tiny `-p` on the harness in use (Claude with a saved account in use: checkAccount, which also records it in Settings). */
async function defaultProbe(harness: Harness): Promise<{ ok: boolean; note: string }> {
  if (harness === 'claude' && !process.env.TALK_CLAUDE_ARGS) {
    try {
      const { listAccounts, checkAccount } = await import('./claude-accounts.ts');
      const a = listAccounts().accounts.find((x) => x.active);
      if (a) return await checkAccount(a.id);
    } catch { /* no accounts: the plain probe */ }
  }
  const { spawnClaude } = await import('./sandbox.ts');
  const { claudeEnv } = await import('./claude.ts');
  const cwd = path.join(PROJECTS, '.work');
  try { fs.mkdirSync(cwd, { recursive: true }); } catch { /* use it as it is */ }
  return new Promise((resolve) => {
    const child = spawnClaude(['-p', 'Reply with just: ok', '--output-format', 'stream-json', '--verbose', '--max-turns', '1', '--strict-mcp-config', '--no-session-persistence'], { cwd: fs.existsSync(cwd) ? cwd : os.tmpdir(), env: claudeEnv() });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), 90_000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, note: `couldn't start it: ${e.message}` }); });
    child.on('close', () => {
      clearTimeout(timer);
      let result: any = null;
      for (const l of out.split('\n')) { try { const m = JSON.parse(l); if (m.type === 'result') result = m; } catch { /* not JSON */ } }
      // A clean result answers (a warning on stderr doesn't make it a stop); else what the output says.
      if (result && !result.is_error && !harnessStopOf(String(result.result ?? ''))) return resolve({ ok: true, note: 'answering' });
      const stop = harnessStopOf(`${result?.result ?? ''}\n${out}`);
      resolve({ ok: false, note: (stop?.line ?? String(result?.result ?? out.trim().split('\n').pop() ?? 'no answer')).slice(0, 300) });
    });
  });
}

const pollMs = () => Number(process.env.STUDIO_HARNESS_POLL_MS) > 0 ? Number(process.env.STUDIO_HARNESS_POLL_MS) : 60_000;
setInterval(() => void reviewHold().catch((e) => console.warn(`[studio] harness hold: ${e?.message ?? e}`)), pollMs()).unref();
