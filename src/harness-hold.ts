// The harness hold (J, 2026-10-20: "every time I hit usage limits the agents all get canceled out and I lose work and
// they never start again ... It should just recover itself"). When a harness (Claude Code or Cursor) refuses to run
// (a usage cap, billing, no login, an outage: brains.ts harnessStopOf), Studio holds every new start on it studio-wide
// until it answers again, instead of burning tasks' tries one start a minute:
//   - the hold is a row of harness_holds (survives restarts): which harness and account, why, until when. Until = the
//     reset time the message names; else a backoff of 10, 20, 40, then 60 minutes (billing and no login: every 30);
//   - while the harness in use is held, agents.ts pump starts nothing (changes it stopped are parked "queued" with
//     their worktree and session, never failed), the PM loop starts no agents, scouts or rescues;
//   - the other harness stands in when it answers (brains.ts failover: Cursor's invoice is unpaid, Claude Code runs the
//     agents; J's choice stays saved), and work resumes on it at once. Another saved Claude account that answers is
//     switched to by itself the same way;
//   - once `until` passes, a cheap probe (one tiny `-p`). It answers: the hold lifts, the stand-in ends (back to J's
//     choice), and the parked changes resume. It doesn't: the hold is extended;
//   - J's phone hears only when the hold needs him (billing, no login), once per hold, with the exact error. A usage
//     reset or an outage is a Talk line when work pauses and one when it resumes.

import os from 'node:os';
import { spawn } from 'node:child_process';
import { db, J, parse } from './db.ts';
import { brainId, brainSettings, ANTIGRAVITY_AGENT, COPILOT_AGENT, CURSOR_AGENT, GEMINI_AGENT, failover, fallbackChain, harnessConfigured, harnessStopOf, setFailover, syncBrain, type Harness, type HarnessKind, type HarnessStop } from './brains.ts';

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
  /** J's phone was told (billing, no login). `switched`: when a stand-in (the other harness, another account) was last looked for. */
  notified: number | null; switched: number | null; lifted: number | null; log: string[];
};
const toHold = (r: any): Hold | null => (r ? { ...r, reset: Boolean(r.reset), log: parse(r.log) ?? [] } : null);
export const getHold = (harness: Harness = brainId()) => toHold(db.prepare('SELECT * FROM harness_holds WHERE harness = ?').get(harness));
/** The hold on this harness now (null: none, or lifted). */
export const activeHold = (harness: Harness = brainId()) => {
  const h = getHold(harness);
  return h && !h.lifted ? h : null;
};
/** Every hold that is on. */
export const activeHolds = () => (db.prepare('SELECT * FROM harness_holds WHERE lifted IS NULL ORDER BY since').all() as any[]).map(toHold) as Hold[];
/** Whether the harness in use is held: nothing new starts on it. */
export const harnessHeld = (harness: Harness = brainId()) => Boolean(activeHold(harness));

export const LABEL: Record<Harness, string> = { claude: 'Claude', cursor: 'Cursor', copilot: 'Copilot', gemini: 'Gemini', antigravity: 'Antigravity' };
/** A minute, in ms (STUDIO_HARNESS_MINUTE_MS: tests run the backoff in milliseconds). */
const minute = () => (Number(process.env.STUDIO_HARNESS_MINUTE_MS) > 0 ? Number(process.env.STUDIO_HARNESS_MINUTE_MS) : 60_000);
const BACKOFF = [10, 20, 40, 60];
const SEVERITY: Record<HarnessKind, number> = { transient: 0, usage: 1, auth: 2, billing: 3 };
/** J has to act (pay, sign in): his phone hears, once per hold. */
export const needsJ = (kind: HarnessKind) => kind === 'billing' || kind === 'auth';
/** How often a stand-in is looked for again while one isn't found (each look is a probe). */
const SWITCH_EVERY = 15;

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
const whyOf = (harness: Harness, stop: Pick<HarnessStop, 'kind'>) => ({
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
const addLine = (harness: Harness, line: string) => {
  const h = getHold(harness);
  if (h) save({ ...h, log: [...h.log, stamp(line)] });
};

/** How Studio says things and probes (tests replace them). */
export const holdDeps = {
  /** One tiny run of a harness: does it answer? */
  probe: (harness: Harness): Promise<{ ok: boolean; note: string }> => defaultProbe(harness),
  /** Whether a harness can run here at all (Cursor needs its key, Copilot a token or login; Claude Code a login). */
  configured: (harness: Harness) => harnessConfigured(harness),
  /** Saved Claude accounts other than the one in use, and checking / switching to one. */
  otherAccounts: async (): Promise<{ id: string; label: string }[]> => {
    const { listAccounts } = await import('./claude-accounts.ts');
    return listAccounts().accounts.filter((a) => !a.active).map((a) => ({ id: a.id, label: a.label }));
  },
  activeAccount: async (): Promise<string | null> => {
    try {
      const { listAccounts } = await import('./claude-accounts.ts');
      return listAccounts().accounts.find((a) => a.active)?.label ?? null;
    } catch {
      return null;
    }
  },
  checkAccount: async (id: string) => (await import('./claude-accounts.ts')).checkAccount(id),
  useAccount: async (id: string) => void (await import('./claude-accounts.ts')).useAccount(id),
  /** Hawkes Gen runs reviews and JSON calls on the harness in use too. */
  syncGen: async () => void (await syncBrain(brainId())),
  talk: async (title: string, text: string) => {
    const { postNotice } = await import('./talk.ts');
    postNotice(title, text);
  },
  phone: async (title: string, text: string) => {
    const { notify, PUBLIC_URL } = await import('./notify.ts');
    await notify(title, text, { url: `${PUBLIC_URL}/#settings`, priority: 4, tags: ['warning'] });
  },
};
/** Called when work may start again (a hold lifted, a stand-in took over): agents.ts pump, pm.ts tick. */
const resumers: (() => void)[] = [];
export const onHoldLifted = (f: () => void) => void resumers.push(f);
const resume = () => { for (const f of resumers) try { f(); } catch { /* the queue's own */ } };

/** Changes parked by a hold (agents.ts parkForHarness): queued, phase.harness set. */
export function parkedChanges(): { id: string; title: string | null; product: string }[] {
  try {
    return db.prepare(`SELECT id, title, product FROM changes WHERE status = 'queued' AND COALESCE(phase, '') LIKE '%"harness":{%' ORDER BY created`).all() as any[];
  } catch {
    return []; // no changes table here
  }
}

/**
 * A harness stopped something (an agent, a scout, a probe): hold it. A hold already on keeps its start and backoff;
 * a later reset time or a more serious kind (billing, no login) updates it. `source`: what was stopped (for the log).
 * Returns the hold and whether it is new (work just paused); a new one also looks for a stand-in in the background.
 */
export function holdHarness(stop: HarnessStop, { source, harness = brainId(), now = Date.now() }: { source: string; harness?: Harness; now?: number }) {
  const cur = getHold(harness);
  if (cur && !cur.lifted) {
    const worse = SEVERITY[stop.kind] > SEVERITY[cur.kind];
    const later = Boolean(stop.resetsAt && stop.resetsAt + minute() > cur.until);
    const next: Hold = {
      ...cur,
      ...(worse ? { kind: stop.kind, why: whyOf(harness, stop), line: stop.line, notified: null } : {}),
      ...(later ? { until: stop.resetsAt! + minute(), reset: true } : {}),
      log: [...cur.log, stamp(`${source}: ${stop.line}`)],
    };
    save(next);
    if (worse) announce(next);
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
  if (harness === 'claude') {
    void holdDeps.activeAccount().then((a) => {
      const x = getHold(harness);
      if (a && x && !x.lifted && x.since === h.since) save({ ...x, account: a });
    }).catch(() => {});
  }
  announce(h, true);
  // A stand-in now, not at the next minute's look: the queue may resume on it straight away.
  if (!reviewing && (harness === brainId() || harness === brainSettings().chosen)) {
    setTimeout(() => void reviewHolds().catch((e) => console.warn(`[studio] harness hold: ${e?.message ?? e}`)), 0).unref?.();
  }
  return { hold: getHold(harness)!, fresh: true };
}

/**
 * A paused line in Talk, and J's phone once per hold when it needs him: only for the harness in use or the one J chose
 * (a stand-in that turned out not to answer is held quietly).
 */
function announce(h: Hold, fresh = false) {
  if (h.harness !== brainId() && h.harness !== brainSettings().chosen) return;
  if (needsJ(h.kind) && !h.notified) {
    save({ ...h, notified: Date.now() });
    const what = h.kind === 'billing' ? 'pay what the error asks for' : `sign ${LABEL[h.harness]} in again (Settings)`;
    void holdDeps.phone(`Agents paused: ${h.why}`, `${h.line ?? h.why}. Studio holds ${LABEL[h.harness]} until it answers (${what}); the other harness stands in when it can. It checks again every 30 minutes and resumes by itself.`.slice(0, 400)).catch(() => {});
  }
  if (fresh) {
    void holdDeps.talk(`Agents paused: ${h.why}`, `${h.why} (${h.line ?? '?'}). Every agent change it stopped is parked with its work, not failed, and nothing new starts on ${LABEL[h.harness]} until then. ${holdDetail(h).replace(/^waiting for/, 'Waiting for')}. It resumes by itself.`).catch(() => {});
  }
}

/** Lifts the hold (a probe answered, an account switched, or J's own word); ends a stand-in for it and resumes the queue. */
export function liftHold(why: string, harness: Harness = brainId()) {
  const h = activeHold(harness);
  if (!h) return null;
  const next = { ...h, lifted: Date.now(), log: [...h.log, stamp(`lifted: ${why}`)] };
  save(next);
  const f = failover();
  const back = f && f.from === harness;
  if (back) {
    setFailover(null);
    void holdDeps.syncGen().catch(() => {});
  }
  const parked = parkedChanges().length;
  void holdDeps.talk(`Agents resumed: ${LABEL[harness]} answers again`, `${LABEL[harness]} answers again (${why}).${back ? ` Studio is back on ${LABEL[harness]} (your choice); ${LABEL[f!.harness]} stood in since ${whenUtc(f!.since)}.` : ''} ${parked ? `${parked} parked change(s) continue their own work; ` : ''}the queue and the PM start work again.`).catch(() => {});
  resume();
  return next;
}

/**
 * The other harness stands in for a held one when it answers (brains.ts failover), or for Claude another saved account.
 * Returns what took over, or null.
 */
async function standIn(h: Hold): Promise<string | null> {
  const chosen = brainSettings().chosen;
  if (h.harness !== chosen && h.harness !== brainId()) return null;
  if (process.env.STUDIO_HARNESS_FAILOVER !== 'off' && brainId() === h.harness) {
    // The chosen harness's others, in order (brains.ts fallbackChain): the first that is set up, not held, and answers.
    for (const other of fallbackChain(chosen).filter((x) => x !== h.harness)) {
      if (!holdDeps.configured(other) || activeHold(other)) continue;
      const p = await holdDeps.probe(other).catch((e: any) => ({ ok: false, note: String(e?.message ?? e) }));
      if (p.ok && activeHold(h.harness) && !activeHold(other) && brainId() === h.harness) {
        setFailover({ harness: other, from: chosen, since: Date.now(), why: h.why });
        addLine(h.harness, `${LABEL[other]} answers: it stands in until ${LABEL[chosen]} does`);
        void holdDeps.syncGen().catch(() => {});
        void holdDeps.talk(`${LABEL[other]} stands in for ${LABEL[chosen]}`, `${h.why} (${h.line ?? '?'}), so Studio runs the agents, scouts and reviews on ${LABEL[other]} until ${LABEL[chosen]} answers again; your choice stays ${LABEL[chosen]} and comes back by itself. Parked changes continue on ${LABEL[other]} now.`).catch(() => {});
        resume();
        return LABEL[other];
      }
      if (!p.ok) {
        const stop = harnessStopOf(p.note);
        if (stop) holdHarness(stop, { source: `a probe of ${LABEL[other]}`, harness: other });
        addLine(h.harness, `${LABEL[other]} can't stand in: ${p.note.slice(0, 160)}`);
      }
    }
  }
  if (h.harness === 'claude' && brainId() === 'claude') {
    for (const a of await holdDeps.otherAccounts().catch(() => [])) {
      const c = await holdDeps.checkAccount(a.id).catch((e: any) => ({ ok: false, note: String(e?.message ?? e) }));
      if (!c.ok) continue;
      await holdDeps.useAccount(a.id);
      addLine('claude', `switched to the Claude account "${a.label}" (it answers)`);
      void holdDeps.talk('Claude account switched', `${h.why} on the account in use, so Studio switched to your saved Claude account "${a.label}", which answers.`).catch(() => {});
      liftHold(`switched to the Claude account "${a.label}"`, 'claude');
      return `the Claude account "${a.label}"`;
    }
  }
  return null;
}

let reviewing = false;
/**
 * Looks at every hold: once its time is up, probe; answered, lift; not, extend with the backoff (or the reset time the
 * probe names). The hold on the harness in use also looks for a stand-in (at once, then every 15 minutes). Never
 * blocks: one look at a time, the rest return at once.
 */
export async function reviewHolds(now = Date.now()) {
  if (reviewing) return activeHolds();
  reviewing = true;
  try {
    for (const h of activeHolds()) {
      if (now >= h.until) {
        const p = await holdDeps.probe(h.harness).catch((e: any) => ({ ok: false, note: String(e?.message ?? e) }));
        if (p.ok) {
          liftHold(`a probe answered: ${p.note}`.slice(0, 200), h.harness);
          continue;
        }
        const cur = activeHold(h.harness);
        if (!cur) continue;
        const stop = harnessStopOf(p.note) ?? { kind: cur.kind, line: cur.line ?? p.note, resetsAt: null };
        const attempts = cur.attempts + 1;
        const until = untilFor(stop, attempts, Date.now());
        save({ ...cur, attempts, until, reset: Boolean(stop.resetsAt && stop.resetsAt > Date.now()), log: [...cur.log, stamp(`probe: still stopped (${p.note.slice(0, 160)}); next at ${whenUtc(until)}`)] });
      }
      const cur = activeHold(h.harness);
      if (!cur || cur.harness !== brainId()) continue;
      if (cur.switched && Date.now() - cur.switched < SWITCH_EVERY * minute()) continue;
      save({ ...cur, switched: Date.now() });
      await standIn(cur);
    }
    return activeHolds();
  } finally {
    reviewing = false;
  }
}
/** The harness in use's hold, looked at (reviewHolds). */
export const reviewHold = async (now = Date.now()) => (await reviewHolds(now), activeHold());

/** What studio_pm status and the Roadmap tab show: the holds, the stand-in, and what waits on them. Null: all clear. */
export function holdStatus() {
  const holds = activeHolds();
  const s = brainSettings();
  if (!holds.length && !s.failover) return null;
  let queued = 0;
  const parked = parkedChanges();
  try { queued = (db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE status = 'queued'`).get() as any).n - parked.length; } catch { /* no changes table here */ }
  const h = activeHold();
  return {
    held: Boolean(h),
    inUse: s.harness, chosen: s.chosen,
    standIn: s.failover ? { harness: s.failover.harness, label: LABEL[s.failover.harness], for: LABEL[s.failover.from], since: s.failover.since, why: s.failover.why } : null,
    holds: holds.map((x) => ({ harness: x.harness, label: LABEL[x.harness], kind: x.kind, why: x.why, line: x.line, account: x.account, since: x.since, until: x.until, resets: x.reset, next: holdDetail(x), needsJ: needsJ(x.kind), log: x.log.slice(-8) })),
    line: h ? `${h.why}: ${holdDetail(h)}; nothing new starts until then` : s.failover ? `${LABEL[s.failover.harness]} stands in for ${LABEL[s.failover.from]} (${s.failover.why})` : null,
    parked, queued,
  };
}

/**
 * One tiny `-p` on a harness, as Studio's own user (no worktree, no tools): Claude Code with the account in use
 * (claudeEnv), or Cursor through bin/cursor-agent.mjs. TALK_CLAUDE / TALK_CLAUDE_ARGS: tests' stand-in, for both.
 */
async function defaultProbe(harness: Harness): Promise<{ ok: boolean; note: string }> {
  const { claudeEnv } = await import('./claude.ts');
  const args = ['-p', 'Reply with just: ok', '--output-format', 'stream-json', '--verbose', '--max-turns', '1', '--strict-mcp-config', '--no-session-persistence',
    ...(harness === 'claude' ? ['--model', 'claude-haiku-5-5', '--tools', '', '--setting-sources', ''] : [])];
  const pre: string[] = process.env.TALK_CLAUDE_ARGS ? JSON.parse(process.env.TALK_CLAUDE_ARGS) : [];
  const stand = Boolean(process.env.TALK_CLAUDE || pre.length);
  const adapter = harness === 'cursor' ? CURSOR_AGENT : harness === 'copilot' ? COPILOT_AGENT : harness === 'gemini' ? GEMINI_AGENT : harness === 'antigravity' ? ANTIGRAVITY_AGENT : '';
  const file = stand ? (process.env.TALK_CLAUDE || 'claude') : adapter ? process.execPath : 'claude';
  const argv = stand ? [...pre, ...args] : adapter ? [adapter, ...args] : args;
  const env = harness === 'claude' ? claudeEnv() : { ...process.env };
  if (stand) env.HAWKES_PROBE_HARNESS = harness;
  return new Promise((resolve) => {
    const child = spawn(file, argv, { cwd: os.tmpdir(), env, windowsHide: true });
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

const pollMs = () => (Number(process.env.STUDIO_HARNESS_POLL_MS) > 0 ? Number(process.env.STUDIO_HARNESS_POLL_MS) : 60_000);
setInterval(() => void reviewHolds().catch((e) => console.warn(`[studio] harness hold: ${e?.message ?? e}`)), pollMs()).unref();
