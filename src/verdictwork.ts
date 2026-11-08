// Bad verdicts work themselves (J, 2026-11-05: "Make this easier to use somehow with studio. It should 'just work'. Like
// studio should be working on it if it's failed or fix first etc.").
//
// The Projects tab's label is the newest finished review of the project (server.ts overview `lastReview`, dashboard
// health()): "fix first" or "broken". Until now only the daily run's autoFix looked at new findings, so a verdict from an
// older run, a finding autoFix had skipped, or a fix that merged left the label saying "fix first" with nobody on it.
//
//   actOnVerdict(product)     a review or playtest ended: if the newest verdict is fix-first or broken, look at the open
//                             findings behind it. An agent already on the project: nothing. Else start ONE fixer through
//                             startFix (auto: wontfix, per-product limits, the day's budget, autoFixBlock's retry cap).
//                             Can't (no finding, all blocked, a cap): ONE Inbox card that says why, merged on repeat.
//                             Misconfiguration (the live address is dead, e.g. a lost domain): the label says so, an Inbox
//                             card is filed, no code fixer is started. Called at the end of every run (pipeline.ts) and
//                             when a fixer's change fails or closes (agents.ts) — events, never a timer.
//                             No open finding at all behind it (all fixed, won't fix, ideas): never a card. Studio starts ONE
//                             full-review beta playtest to recompute the verdict (the label says "re-checking: every finding behind
//                             it is fixed"); a re-check that still reads bad with nothing open marks the verdict stale (the review's
//                             verdict becomes "stale", the red label clears, logged). One re-check per project per reviewed commit
//                             (pm_log `verdict-recheck`). A card the owner answered is never filed again for the same review.
//   noteMerge(product, change) a change merged into beta: if it fixed a bad verdict, ONE beta playtest + review follows
//                             the burst of merges (a quiet window; a merge during the check queues one more after it).
//   verdictLabel(product)     what the Projects card shows: the verdict, the review's age and commit, and what Studio is
//                             doing about it ("fixing (agent running)", "re-checking", "needs you: <reason>").
//
// Switches are Settings → Agents (`autoWorkVerdicts`, `autoReverify`, both default on), not env vars.

import { db, parse } from './db.ts';
import { getProduct, isInfra, managedElsewhere, type Product } from './config.ts';

export const BAD = ['fix-first', 'broken'];
/**
 * A project with nothing to playtest reads this: grey "nothing to playtest", never fix-first or broken, no Inbox card, no
 * re-check, not counted red anywhere (J, 2026-11-08: Hawkes Net, Hawkes Net for Unity and for Babylon are libraries).
 */
export const NEUTRAL = 'nothing-to-playtest';
/** Gen's playtest says this when a contract game's page never exposed its hook (tools/playtest.ts). */
const HOOK_MISSING = /never exposed window\.hawkesPlaytest/i;
/** A playtest failure that is the page never exposing the playtest hook. */
export const hookMissing = (text: unknown) => HOOK_MISSING.test(String(text ?? ''));
/** Statuses of a change whose agent is on the project (or about to be). */
const ACTIVE = ['queued', 'working', 'verifying', 'revising', 'needs answer', 'waiting on Gen', 'asked'];
/** The window of quiet after the last merge before the one re-check starts (a burst of merges costs one playtest). */
export const REVERIFY_QUIET_MS = 45_000;

const subject = (product: string) => `verdict:${product}`;

export type Verdict = { verdict: string; at: number; commit: string | null; summary: string | null; run: string | null };

/** The project's newest finished review: its verdict, when, and the commit that was played. */
export function latestVerdict(product: string): Verdict | null {
  const r = db.prepare(`SELECT run, finished, started, data FROM steps WHERE product = ? AND kind = 'review' AND status = 'done' ORDER BY started DESC LIMIT 1`).get(product) as any;
  if (!r) return null;
  const d = parse(r.data) as any;
  if (!d?.verdict) return null;
  return nothingToPlayOf(product, { verdict: String(d.verdict), at: r.finished ?? r.started, commit: d.sha ? String(d.sha).slice(0, 7) : null, summary: d.summary ?? null, run: r.run });
}

/** How many findings are open (or being fixed) behind the project: a page that never exposed the hook counts only with none. */
export function openFindingCount(product: string): number {
  try { return Number((db.prepare(`SELECT COUNT(*) AS n FROM findings WHERE product = ? AND status IN ('open', 'fixing')`).get(product) as any)?.n ?? 0); } catch { return 0; }
}

/**
 * A library or SDK: its live address is its repository page (GitHub or GitLab), and it has no beta, build or builds of its
 * own to play instead. A library with a beta demo plays that demo; it is judged by its playtests like any page.
 */
export function libraryProject(p: Pick<Product, 'live' | 'beta' | 'build' | 'builds'> | null | undefined): boolean {
  if (!p) return false;
  return /^https:\/\/(www\.)?(github|gitlab)\.com\//i.test(p.live ?? '') && !p.beta && !p.build && !(p.builds?.length);
}

/** When the product's newest playtest that found nothing to play was (skipped, data.unplayable), else null. */
function unplayableAt(product: string): number | null {
  try {
    const r = db.prepare(`SELECT started, finished FROM steps WHERE product = ? AND kind = 'playtest' AND status = 'skipped' AND data LIKE '%"unplayable":true%' ORDER BY started DESC LIMIT 1`).get(product) as any;
    return r ? Number(r.finished ?? r.started) : null;
  } catch { return null; }
}

/**
 * Whether a bad verdict has nothing to playtest behind it: a library (always), or a page that never exposed its hook while
 * no finding is open (its playtest came after the review). Real games with open findings keep their verdict.
 */
export function nothingToPlay(product: string, v: { at?: number | null } | null = null): boolean {
  let p: Product | null = null;
  try { p = getProduct(product); } catch { p = null; }
  if (libraryProject(p)) return true;
  if (openFindingCount(product) > 0) return false;
  const at = unplayableAt(product);
  return at !== null && (!v?.at || at >= v.at);
}

/** A review's verdict as the product reads it now: a bad one with nothing to playtest behind it is NEUTRAL. */
function nothingToPlayOf(product: string, v: Verdict): Verdict {
  return BAD.includes(v.verdict) && nothingToPlay(product, v) ? { ...v, verdict: NEUTRAL } : v;
}

/** A review step row as the Projects page reads it (server.ts overview): its data with the neutral verdict where it applies. */
export function readReview<T extends { data?: any; finished?: number | null; started?: number | null; run?: string | null }>(product: string, row: T | null): T | null {
  const verdict = row?.data?.verdict;
  if (!row || !BAD.includes(String(verdict))) return row;
  const v = nothingToPlayOf(product, { verdict: String(verdict), at: row.finished ?? row.started ?? 0, commit: null, summary: null, run: row.run ?? null });
  return v.verdict === NEUTRAL ? { ...row, data: { ...row.data, verdict: NEUTRAL, verdictWas: verdict } } : row;
}

/**
 * Whether the verdict is "broken" because the live address does not answer (a lost domain, DNS gone, a refused
 * connection) rather than because of anything in the code: no fixer can help, the owner must (Sick Of It's lost domain).
 */
const DEAD = /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_(REFUSED|TIMED_OUT|RESET|CLOSED)|ERR_ADDRESS_UNREACHABLE|ERR_CERT_|ERR_SSL_|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|getaddrinfo|could not resolve|couldn'?t reach|can'?t reach|unreachable|domain (has )?(expired|is for sale|is parked)|site can'?t be reached|dns[_ ]probe/i;
export function deadAddress(product: string, v: Verdict | null = latestVerdict(product)): string | null {
  if (!v || v.verdict !== 'broken') return null;
  const rows = db.prepare(`SELECT name, status, detail FROM steps WHERE run = ? AND product = ? AND kind = 'playtest' ORDER BY started`).all(v.run, product) as any[];
  const failedLive = rows.filter((x) => x.status === 'failed' && /@live|live/i.test(x.name ?? '') && DEAD.test(x.detail ?? ''));
  if (failedLive.length) return String(failedLive[0].detail).slice(0, 200);
  // A review that says the page never loaded for that reason, with no playtest of its own failing.
  if (rows.length && rows.every((x) => x.status === 'failed') && DEAD.test(v.summary ?? '')) return String(v.summary).slice(0, 200);
  return null;
}

/** The verdict was recomputed and found stale (nothing open behind it): the review step reads "stale", not fix-first. */
export const STALE = 'stale';

type Recheck = { commit: string | null; run: string | null };
/** The re-check Studio already started for this project's reviewed commit (one per commit, so it can't loop). */
function recheckFor(product: string, v: Verdict): Recheck | null {
  try {
    const rows = db.prepare(`SELECT detail FROM pm_log WHERE action = 'verdict-recheck' AND subject = ? AND undone IS NULL ORDER BY at DESC LIMIT 20`).all(subject(product)) as any[];
    for (const r of rows) {
      const m = parse(String(r.detail).split('\n')[1] ?? '') as Recheck | null;
      if (m && (m.run === v.run || (v.commit && m.commit === v.commit))) return m;
    }
  } catch { /* no log yet */ }
  return null;
}
/** Whether the verdict's run was itself a re-check (a beta run started to recompute a verdict). */
function wasRecheck(run: string | null): boolean {
  if (!run) return false;
  try { return parse((db.prepare('SELECT options FROM runs WHERE id = ?').get(run) as any)?.options)?.reverify === true; } catch { return false; }
}
/** An answered verdict card for this very review: not asked again until a new review reads bad. */
function answeredFor(product: string, v: Verdict): boolean {
  try {
    return !!db.prepare(`SELECT 1 FROM questions WHERE subject = ? AND status NOT IN ('open', 'asked J') AND context LIKE ? LIMIT 1`).get(subject(product), `%[review ${v.run}]%`);
  } catch { return false; }
}

type Change = { id: string; status: string; title?: string | null };
const changesOf = (product: string): Change[] => {
  try { return db.prepare(`SELECT id, status, title FROM changes WHERE product = ? ORDER BY created DESC LIMIT 40`).all(product) as Change[]; } catch { return []; }
};
const openCard = (product: string) => {
  try { return db.prepare(`SELECT * FROM questions WHERE subject = ? AND status IN ('open', 'asked J') ORDER BY at DESC LIMIT 1`).get(subject(product)) as any; } catch { return null; }
};

// ------------------------------------------------------------------ re-check (merge events)

type Pending = { timer: NodeJS.Timeout | null; running: boolean; again: boolean; changes: string[] };
const pending = new Map<string, Pending>();

/** Whether a beta re-check of the project is waiting for the merges to settle or playing now. */
export function rechecking(product: string): boolean {
  const p = pending.get(product);
  if (p && (p.timer || p.running || p.again)) return true;
  try {
    const rows = db.prepare(`SELECT options FROM runs WHERE kind = 'beta' AND status = 'running' AND products LIKE ?`).all(`%"${product}"%`) as any[];
    return rows.some((r) => parse(r.options)?.reverify === true);
  } catch { return false; }
}

export type Settings = { autoWorkVerdicts: boolean; autoReverify: boolean; autoFix: boolean; enabled: boolean; severities: string[] };

export type Deps = {
  settings: () => Settings;
  startFix: (product: string, findings: string[], o: { auto: boolean; by: string }) => string;
  autoFixBlock: (finding: string) => string | null;
  ask: (text: string, o: { subject: string; product: string; context: string; options: string[]; recommend: string; topic: string }) => unknown;
  startBeta: (product: string, o: { focus: string; playtest: boolean; reverify: boolean }) => unknown;
  quietMs: number;
};

async function liveDeps(): Promise<Deps> {
  const agents = await import('./agents.ts');
  const { askJ } = await import('./pm.ts');
  const { startBeta } = await import('./pipeline.ts');
  return {
    settings: () => agents.agentSettings(),
    startFix: (product, findings, o) => agents.startFix(product, findings, o),
    autoFixBlock: (id) => agents.autoFixBlock(id),
    ask: (text, o) => askJ(text, { ...o, from: 'verdicts', blocks: `${getProduct(o.product).name}'s label stays red` }),
    startBeta: (product, o) => startBeta(product, o),
    quietMs: REVERIFY_QUIET_MS,
  };
}

/** Closes the project's open verdict card (the thing it asked is no longer true). */
async function closeCard(product: string, why: string) {
  const q = openCard(product);
  if (!q) return;
  const { setQuestion } = await import('./roadmap.ts');
  setQuestion(q.id, { status: 'answered', answer: why, answered_by: 'Studio' });
}

export type Outcome =
  | { action: 'off' | 'none' | 'busy'; why: string }
  | { action: 'started'; why: string; change: string; finding: string }
  | { action: 'card'; why: string };

/**
 * A review or playtest of the project ended (or its fixer did): act on a bad verdict. Never throws; says what it did.
 * `d` is for tests.
 */
export async function actOnVerdict(product: string, trigger = 'a run ended', d?: Deps): Promise<Outcome> {
  try {
    d ??= await liveDeps();
    const s = d.settings();
    if (!s.autoWorkVerdicts) return { action: 'off', why: 'working on bad verdicts is switched off (Settings → Agents)' };
    const p = getProduct(product);
    if (managedElsewhere(p)) return { action: 'none', why: 'another Studio manages it' };
    if (isInfra(product)) return { action: 'none', why: 'Studio and Gen are changed by tasks, not by playtest verdicts' };
    const v = latestVerdict(product);
    if (!v || !BAD.includes(v.verdict)) {
      await closeCard(product, `its newest review says ${v?.verdict ?? 'nothing'}`);
      return { action: 'none', why: v ? `its verdict is ${v.verdict}` : 'no review yet' };
    }
    const card = async (reason: string, options: string[], recommend: string, topic: string): Promise<Outcome> => {
      // Answered already for this review: say nothing again (a new review with a new bad verdict may ask).
      if (answeredFor(product, v)) return { action: 'none', why: 'its card for this review was already answered' };
      const text = `${p.name} reads "${v.verdict === 'broken' ? 'broken' : 'fix first'}" and Studio can't work on it by itself: ${reason}`;
      await d!.ask(text, { subject: subject(product), product, context: `${reason.slice(0, 440)} [review ${v.run}]`, options, recommend, topic });
      return { action: 'card', why: reason };
    };
    // Misconfiguration, not code: say so and let the owner decide (no code fixer for a dead domain).
    const dead = deadAddress(product, v);
    if (dead) {
      return card(`its live address ${p.live} doesn't answer (${dead}). That is the address or its hosting, not the code, so no fix agent was started.`,
        ['Point it at the right address', 'Take the live check off for now'], 'Point it at the right address (the project\'s settings), then run a playtest', 'verdict');
    }
    // An agent is already on it (or its fix is waiting to merge): the label says so; nothing to start.
    const mine = changesOf(product).filter((c) => ACTIVE.includes(c.status) || c.status === 'ready');
    if (mine.length) return { action: 'busy', why: `change ${mine[0].id} is on it (${mine[0].status})` };
    if (!s.enabled || !s.autoFix) return { action: 'off', why: 'agents or auto-fix are switched off (Settings → Agents)' };

    const open = db.prepare(`SELECT id, title, severity FROM findings WHERE product = ? AND status = 'open' ORDER BY CASE severity WHEN 'blocker' THEN 0 WHEN 'bug' THEN 1 ELSE 2 END, seen DESC`).all(product) as any[];
    const worth = open.filter((f) => s.severities.includes(f.severity));
    if (!open.length) return staleOrRecheck(product, p.name, v, trigger, s, d);
    if (!worth.length) {
      return card(`${open.length} open finding${open.length === 1 ? ' is' : 's are'} not in the severities agents fix (${s.severities.join(', ')}). Say which to fix, or play it yourself.`,
        ['Tell me what is wrong', 'Run a full playtest again'], 'Run a full playtest again and see whether it still reads this way', 'verdict');
    }
    const blocks: string[] = [];
    for (const f of worth) {
      const why = d.autoFixBlock(f.id);
      if (why) { blocks.push(`"${f.title}": ${why}`); continue; }
      try {
        const change = d.startFix(product, [f.id], { auto: true, by: 'a bad verdict' });
        await closeCard(product, `a fix agent started (change ${change})`);
        const { logDecision } = await import('./roadmap.ts');
        logDecision('verdict-fix', null, product, `${p.name} reads ${v.verdict} (${trigger}): started change ${change} on "${f.title}"`);
        return { action: 'started', why: `started a fix for "${f.title}"`, change, finding: f.id };
      } catch (e: any) {
        return card(`starting a fix failed: ${String(e.message ?? e).slice(0, 300)}`, ['Raise the day\'s limit in Settings → Agents', 'Wait until tomorrow'], 'Wait until tomorrow unless it is urgent', 'verdict');
      }
    }
    return card(`every bug behind it is held back: ${blocks.slice(0, 3).join('; ')}`, ['Try the fix again', 'Mark it won\'t fix', 'Tell me what is wrong'], 'Look at the held-back bugs in the Backlog, then say which to try again', 'verdict');
  } catch (e: any) {
    console.warn(`[studio] verdict work for ${product}: ${e?.message ?? e}`);
    return { action: 'none', why: `couldn't look: ${String(e?.message ?? e).slice(0, 160)}` };
  }
}

/**
 * A bad verdict with no open finding behind it (everything is fixed, won't fix or an idea): the owner is never asked.
 * First time for this reviewed commit: ONE full-review beta playtest recomputes it. If a re-check (or a later review of a
 * re-check run) still reads bad with nothing open, the verdict is stale: its review step is marked and the label clears.
 */
async function staleOrRecheck(product: string, name: string, v: Verdict, trigger: string, s: Settings, d: Deps): Promise<Outcome> {
  const { logDecision } = await import('./roadmap.ts');
  const prior = recheckFor(product, v);
  if (wasRecheck(v.run) || (prior && prior.run !== v.run)) {
    // The re-check's own review still reads bad, and every finding is closed: the label is stale.
    const row = db.prepare(`SELECT id, data FROM steps WHERE run = ? AND product = ? AND kind = 'review' AND status = 'done' ORDER BY started DESC LIMIT 1`).get(v.run, product) as any;
    if (row) {
      const data = parse(row.data) as any;
      db.prepare('UPDATE steps SET data = ? WHERE id = ?').run(JSON.stringify({ ...data, verdict: STALE, verdictWas: data.verdict }), row.id);
    }
    await closeCard(product, 'the re-check still reads this way but every finding behind it is fixed: the label is stale and cleared');
    logDecision('verdict-stale', subject(product), product, `${name} read ${v.verdict} (${trigger}) with no open finding, even after a re-check on ${v.commit ?? 'beta'}: cleared the red label as stale`);
    return { action: 'none', why: 'stale verdict cleared: every finding behind it is fixed' };
  }
  await closeCard(product, 'every finding behind it is fixed: Studio is re-checking by itself');
  if (rechecking(product)) return { action: 'busy', why: 're-check is playing' };
  if (prior) return { action: 'none', why: 'its re-check ended without a new review; not started again for this commit' };
  if (!s.autoReverify) return { action: 'off', why: 're-checking is switched off (Settings → Agents)' };
  logDecision('verdict-recheck', subject(product), product, `${name} reads ${v.verdict} (${trigger}) but every finding behind it is fixed: started ONE full playtest of beta to recompute it\n${JSON.stringify({ commit: v.commit, run: v.run })}`);
  const run = d.startBeta(product, { focus: `The label reads ${v.verdict} but every finding behind it is fixed. Play beta in full and review it again so the verdict is current.`, playtest: true, reverify: true }) as any;
  void run?.done;
  return { action: 'started', why: 'started a full playtest of beta: every finding behind the verdict is fixed', change: '', finding: '' } as Outcome;
}

/** The runs of a finished run's products: look at each one's verdict (pipeline.ts, after autoFix). */
export async function actOnRun(run: string) {
  const row = db.prepare('SELECT products FROM runs WHERE id = ?').get(run) as any;
  const ids: string[] = parse(row?.products) ?? [];
  const out: Record<string, Outcome> = {};
  for (const id of ids) out[id] = await actOnVerdict(id, `run ${run} ended`);
  return out;
}

/**
 * A change merged into beta (agents.ts approve). If the project reads fix-first or broken, ONE beta playtest and review
 * follows the burst of merges: the timer restarts on every merge, and a merge while the check plays queues one more
 * after it (not several). Returns whether a re-check is now scheduled. `d` is for tests.
 */
export async function noteMerge(product: string, change: string, d?: Deps): Promise<boolean> {
  try {
    d ??= await liveDeps();
    if (!d.settings().autoReverify) return false;
    const v = latestVerdict(product);
    if (!v || !BAD.includes(v.verdict)) return false;
    if (managedElsewhere(getProduct(product)) || isInfra(product)) return false;
    const dd = d;
    const p = pending.get(product) ?? { timer: null, running: false, again: false, changes: [] };
    pending.set(product, p);
    p.changes.push(change);
    if (p.running) { p.again = true; return true; }
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => void fire(product, dd), dd.quietMs);
    p.timer.unref?.();
    return true;
  } catch (e: any) {
    console.warn(`[studio] re-check after ${change}: ${e?.message ?? e}`);
    return false;
  }
}

async function fire(product: string, d: Deps) {
  const p = pending.get(product);
  if (!p) return;
  p.timer = null;
  const changes = p.changes.splice(0);
  p.running = true;
  p.again = false;
  try {
    const run = d.startBeta(product, { focus: `Fixes just merged into beta (${changes.join(', ')}). Check the problems the last review found are gone and nothing regressed.`, playtest: true, reverify: true }) as any;
    await run?.done;
  } catch (e: any) {
    console.warn(`[studio] re-check of ${product}: ${e?.message ?? e}`);
  } finally {
    p.running = false;
    // Merges that came while it played: one more, after it (the label must reflect the newest commit).
    if (p.again && p.changes.length) { p.again = false; p.timer = setTimeout(() => void fire(product, d), d.quietMs); p.timer.unref?.(); } else pending.delete(product);
  }
  // The re-check's review is the project's newest now: act on what it found (a new bad verdict starts the next fix).
  void actOnVerdict(product, 're-check on beta', d);
}

/** Forgets scheduled re-checks (tests). */
export function resetRechecks() {
  for (const p of pending.values()) if (p.timer) clearTimeout(p.timer);
  pending.clear();
}

// ------------------------------------------------------------------ the label

export type VerdictLabel = {
  verdict: string; at: number | null; commit: string | null;
  /** fixing: an agent is on it; rechecking: a beta playtest follows a merge; needs-you: a card says why; waiting: nobody on it (a switch is off). */
  state: 'fixing' | 'rechecking' | 'needs-you' | 'waiting';
  change: string | null; reason: string | null;
};

/** What the Projects card says about a bad verdict, and what Studio is doing about it. Null: the verdict isn't bad. */
export function verdictLabel(product: string, s?: Settings): VerdictLabel | null {
  const v = latestVerdict(product);
  if (!v || !BAD.includes(v.verdict)) return null;
  const base = { verdict: v.verdict, at: v.at, commit: v.commit, change: null as string | null, reason: null as string | null };
  if (rechecking(product)) return { ...base, state: 'rechecking', reason: recheckFor(product, v) && !wasRecheck(v.run) ? 'every finding behind it is fixed' : null };
  const mine = changesOf(product).filter((c) => ACTIVE.includes(c.status) || c.status === 'ready');
  if (mine.length) return { ...base, state: 'fixing', change: mine[0].id };
  const q = openCard(product);
  if (q) return { ...base, state: 'needs-you', reason: q.context ?? q.text };
  const dead = deadAddress(product, v);
  if (dead) return { ...base, state: 'needs-you', reason: `the live address doesn't answer (${dead})` };
  if (s && (!s.autoWorkVerdicts || !s.autoFix || !s.enabled)) return { ...base, state: 'waiting', reason: 'auto-work is switched off in Settings' };
  return { ...base, state: 'waiting', reason: null };
}
