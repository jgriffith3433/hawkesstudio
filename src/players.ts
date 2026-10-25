// Player analytics as feedback (docs/daily.md, "Player analytics"): Hawkes Gen's analytics of real players (hawkesgen
// docs/analytics.md; live only, bots and J's own devices left out, Gen's defaults) turned into plain sentences with their
// sample sizes. Used by Talk's, the PM's and agents' studio_analytics, the daily report's "Players" section, the PM's
// work from player data (bugs from errors, ideas from drop-offs, hard levels and feedback: backlog.ts filePlayerWork),
// an agent brief's "players" line and the go-live plan's line about the live build.
// Pure functions over Gen's answers, plus the fetches (Gen is imported lazily: the MCP process loads this file too).

type Ask = (path: string) => Promise<any>;
const genAsk: Ask = async (p) => (await import('./gen.ts')).gen.request(p);

/**
 * The minimum samples: under them nothing is said to change and no work is made, so a handful of players can't send
 * agents chasing noise. Gen's insights use the same sessions, attempts and error numbers.
 */
export const MIN = {
  /** Sessions in each period to state a change, and to call a drop-off. */
  sessions: 30,
  /** New players whose next day has come, to state D1 retention. */
  retention: 20,
  /** Attempts at a level, to call it hard. */
  attempts: 20,
  /** An error becomes a backlog bug at this many sessions... */
  errorSessions: 5,
  /** ...that are at least this share of all sessions. */
  errorShare: 0.02,
  /** Star ratings (or thumbs) to state an average. */
  ratings: 10,
  /** Low-rated comments about the same thing to call it a repeated complaint. */
  complaints: 3,
  /** Sessions on each of two builds to compare them. */
  buildSessions: 30,
};
/** What makes work: a level or "before ready" where this share of sessions end, a level this few complete, ratings this low. */
export const WORK = { dropShare: 0.25, loadShare: 0.15, completion: 0.35, quitRate: 0.4, rating: 3, upShare: 0.5 };

const DAY = 86_400_000;
const pct = (x: number | null | undefined) => (x == null ? '?' : `${Math.round(x * 100)}%`);
const secs = (x: number | null | undefined) => (x == null ? '?' : x >= 120 ? `${Math.round(x / 60)} min` : `${Math.round(x)} s`);
const num = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const cut = (s: unknown, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const change = (cur: number, prev: number) => (prev ? (cur - prev) / prev : null);

/** What the report, the PM and the briefs read: one product's real players (live), as Gen answered. */
export type Snapshot = {
  product: string; at: number;
  week: { sessions: number; players: number; medianActiveSeconds: number | null };
  prevWeek: { sessions: number; players: number; medianActiveSeconds: number | null };
  retention: any; dropoff: any; levels: any[]; feedback: any; errors: any; builds: any;
  /** What got in players' way (frustration events, rage clicks, errors) and where their time went (engage). */
  frustration?: any; engagement?: any;
  /** Gen has seen a player of it in the last 30 days. */
  hasData: boolean;
};

/**
 * One product's players from Gen: this week and the week before (sessions), and the last 30 days' retention, drop-off,
 * levels, feedback, errors and builds. null: Gen doesn't know the product (no analytics registered). Trimmed for
 * storing in a run's step.
 */
export async function snapshot(product: string, ask: Ask = genAsk, now = Date.now()): Promise<Snapshot | null> {
  const p = encodeURIComponent(product);
  const q = (section: string, params: Record<string, string>) => `/analytics/${p}/${section}?${new URLSearchParams(params)}`;
  const m30 = { range: '30d' };
  const asks = {
    week: q('sessions', { from: String(now - 7 * DAY), to: String(now) }),
    prevWeek: q('sessions', { from: String(now - 14 * DAY), to: String(now - 7 * DAY) }),
    retention: q('retention', m30), dropoff: q('dropoff', m30), levels: q('levels', m30),
    feedback: q('feedback', m30), errors: q('errors', m30), builds: q('builds', m30),
    frustration: q('frustration', m30), engagement: q('engagement', m30),
  };
  const keys = Object.keys(asks) as (keyof typeof asks)[];
  const got = await Promise.allSettled(keys.map((k) => ask(asks[k])));
  const unknown = got.find((r) => r.status === 'rejected' && Number((r.reason as any)?.status) === 404);
  if (unknown) return null;
  const all = got.every((r) => r.status === 'rejected');
  if (all) throw (got[0] as PromiseRejectedResult).reason;
  const v: Record<string, any> = Object.fromEntries(keys.map((k, i) => [k, got[i].status === 'fulfilled' ? (got[i] as PromiseFulfilledResult<any>).value : null]));
  const sess = (x: any) => ({ sessions: num(x?.sessions), players: num(x?.players), medianActiveSeconds: x?.medianActiveSeconds ?? null });
  const errors = v.errors && {
    errors: num(v.errors.errors), sessions: num(v.errors.sessions), sessionsWithErrors: num(v.errors.sessionsWithErrors), errorRate: v.errors.errorRate ?? null,
    groups: (v.errors.groups ?? []).slice(0, 12).map((g: any) => ({
      signature: cut(g.signature, 300), message: cut(g.message, 300), stack: String(g.stack ?? '').slice(0, 1200), count: num(g.count), sessions: num(g.sessions), players: num(g.players),
      browsers: g.browsers ?? {}, builds: g.builds ?? {}, sources: g.sources ?? {}, first: g.first ?? null, last: g.last ?? null,
    })),
  };
  const feedback = v.feedback && { count: num(v.feedback.count), rating: v.feedback.rating ?? null, comments: (v.feedback.comments ?? []).slice(0, 30).map((c: any) => ({ at: c.at, rating: c.rating ?? null, text: cut(c.text, 300), context: c.context ?? null, level: c.level ?? null, build: c.build ?? null })) };
  const side = (s: any) => s && { build: s.build, sessions: num(s.sessions), first: s.first ?? null, kpis: s.kpis ?? {} };
  const builds = v.builds && { a: side(v.builds.a), b: side(v.builds.b), count: (v.builds.builds ?? []).length };
  const dropoff = v.dropoff && { sessions: num(v.dropoff.sessions), beforeReady: v.dropoff.beforeReady ?? null, byLevel: (v.dropoff.byLevel ?? []).slice(0, 8), biggest: v.dropoff.biggest ?? null };
  const frustration = v.frustration && {
    sessions: num(v.frustration.sessions), sessionsWithFrustration: num(v.frustration.sessionsWithFrustration), frustrationRate: v.frustration.frustrationRate ?? null, leftAfterRate: v.frustration.leftAfterRate ?? null,
    kinds: (v.frustration.kinds ?? []).slice(0, 12).map((k: any) => ({ kind: k.kind, count: num(k.count), sessions: num(k.sessions), players: num(k.players), shareOfSessions: k.shareOfSessions ?? null, leftAfter: num(k.leftAfter), leftAfterRate: k.leftAfterRate ?? null, pages: k.pages ?? {} })),
    rageClicks: (v.frustration.rageClicks ?? []).slice(0, 8).map((k: any) => ({ where: k.where, count: num(k.count), sessions: num(k.sessions) })),
  };
  const engagement = v.engagement && { players: num(v.engagement.players), activeSeconds: num(v.engagement.activeSeconds), activities: (v.engagement.activities ?? []).slice(0, 12) };
  const out: Snapshot = {
    product, at: now, week: sess(v.week), prevWeek: sess(v.prevWeek), retention: v.retention?.total ?? null, dropoff,
    levels: Array.isArray(v.levels) ? v.levels.slice(0, 40) : [], feedback, errors, builds, frustration, engagement, hasData: false,
  };
  out.hasData = Boolean(out.week.sessions || out.prevWeek.sessions || dropoff?.sessions || errors?.sessions || feedback?.count);
  return out;
}

// ------------------------------------------------------------------ sentences

/** Players and sessions this week against the week before; a change only with MIN.sessions in both weeks. */
export function weekLine(s: Snapshot) {
  const { week: w, prevWeek: p } = s;
  const base = `${w.players} players and ${w.sessions} sessions this week`;
  if (w.sessions >= MIN.sessions && p.sessions >= MIN.sessions) {
    const c = change(w.sessions, p.sessions)!;
    const how = Math.abs(c) < 0.05 ? 'about the same as' : `${c > 0 ? 'up' : 'down'} ${pct(Math.abs(c))} from`;
    return `${base}, ${how} ${p.sessions} sessions (${p.players} players) the week before.`;
  }
  return `${base}; the week before had ${p.sessions} sessions${w.sessions || p.sessions ? ` (under ${MIN.sessions} sessions a week is too few to call a change)` : ''}.`;
}

export function retentionLine(r: any) {
  const d1 = r?.d1;
  if (!d1) return null;
  if (num(d1.eligible) < MIN.retention) return `D1 retention: too few new players yet (${num(d1.eligible)} whose next day has come; it takes ${MIN.retention}).`;
  return `D1 retention ${pct(d1.rate)}: ${num(d1.returned)} of ${num(d1.eligible)} new players came back a day or more later (last 30 days).`;
}

export function dropoffLine(d: any) {
  if (!d?.sessions) return null;
  if (d.sessions < MIN.sessions) return `Drop-off: ${d.sessions} finished sessions, too few to say where players leave (it takes ${MIN.sessions}).`;
  const b = d.biggest;
  if (!b) return `No clear drop-off point in ${d.sessions} sessions.`;
  const extra = b.medianWaitSeconds != null ? ` (median wait ${secs(b.medianWaitSeconds)})` : b.medianSecondsIn != null ? ` (median ${secs(b.medianSecondsIn)} into it)` : '';
  return `The biggest drop-off: ${pct(b.share)} of ${d.sessions} sessions ended ${b.where.startsWith('before') ? b.where : `in ${b.where}`}${extra} (${b.sessions} sessions).`;
}

/** The level with the lowest completion among those with MIN.attempts, or null. */
export function hardestLevel(levels: any[]) {
  const ok = (levels ?? []).filter((x) => num(x.attempts) >= MIN.attempts && x.completionRate != null);
  return ok.sort((a, b) => a.completionRate - b.completionRate || b.attempts - a.attempts)[0] ?? null;
}

export function levelLine(x: any) {
  return `level ${x.level}: ${pct(x.completionRate)} of ${x.attempts} attempts completed by ${x.players} players${x.deathsPerAttempt != null ? `, ${x.deathsPerAttempt} deaths per attempt` : ''}${x.quitRate != null ? `, ${pct(x.quitRate)} quit` : ''}${x.medianRetriesBeforeFirstWin != null ? `, ${x.medianRetriesBeforeFirstWin} retries before the first win (median)` : ''}`;
}

export function hardestLine(levels: any[]) {
  if (!levels?.length) return null;
  const h = hardestLevel(levels);
  if (!h) return `Levels: none has ${MIN.attempts} attempts yet (the most: ${Math.max(...levels.map((x) => num(x.attempts)))}).`;
  return `The hardest level: ${levelLine(h)}.`;
}

/** Errors first seen in the last 7 days (of the 30 asked), most sessions first. */
export function newErrors(e: any, now = Date.now()) {
  return (e?.groups ?? []).filter((g: any) => g.first != null && g.first >= now - 7 * DAY).sort((a: any, b: any) => b.sessions - a.sessions);
}
const top = (o: Record<string, number> | undefined, n = 3) => Object.keys(o ?? {}).slice(0, n).join(', ') || '?';
export const errorLine = (g: any, of: number) => `"${cut(g.message || g.signature, 120)}" in ${g.sessions} of ${of} sessions (${pct(of ? g.sessions / of : null)}, ${g.players} players; ${top(g.browsers)}; builds ${top(g.builds)})`;

export function ratingLine(f: any) {
  const r = f?.rating;
  if (!r) return null;
  const stars = num(r.ratings);
  const thumbs = num(r.thumbsUp) + num(r.thumbsDown);
  const parts: string[] = [];
  if (stars >= MIN.ratings) parts.push(`average ${r.average} stars from ${stars} ratings`);
  else if (stars) parts.push(`${stars} star rating${stars > 1 ? 's' : ''} (too few to average)`);
  if (thumbs >= MIN.ratings) parts.push(`${pct(r.upShare)} thumbs up of ${thumbs}`);
  else if (thumbs) parts.push(`${thumbs} thumbs (${num(r.thumbsUp)} up)`);
  return parts.length ? `Rating: ${parts.join('; ')} (last 30 days).` : null;
}

const quote = (c: any) => `"${cut(c.text, 160)}"${c.rating != null ? ` (${c.rating === 'up' || c.rating === 'down' ? `thumbs ${c.rating}` : `${c.rating}★`})` : ''}${c.context || c.level ? ` on ${c.context ?? `level ${c.level}`}` : ''}${c.build ? `, build ${c.build}` : ''}`;

/** KPIs of the newest build against the one before, when both have MIN.buildSessions; else how far it is. */
export function buildLine(b: any) {
  const B = b?.b;
  const A = b?.a;
  if (!B) return null;
  if (!A) return `Only one build in the last 30 days: ${B.build} (${B.sessions} sessions).`;
  if (B.sessions < MIN.buildSessions || A.sessions < MIN.buildSessions) return `Build ${B.build} has ${B.sessions} sessions and ${A.build} before it ${A.sessions}: too few to compare (it takes ${MIN.buildSessions} each).`;
  const k = B.kpis ?? {};
  const o = A.kpis ?? {};
  const cmp: string[] = [];
  const both = (key: string, label: string, f: (x: number) => string) => { if (k[key] != null && o[key] != null) cmp.push(`${label} ${f(k[key])} vs ${f(o[key])}`); };
  both('medianActiveSeconds', 'median session', secs);
  both('levelCompletionRate', 'level completion', pct);
  both('errorRate', 'sessions with an error', pct);
  both('readyRate', 'reached the game', pct);
  both('deathsPerSession', 'deaths per session', String);
  both('rating', 'rating', String);
  both('fpsMedian', 'fps', String);
  return `Build ${B.build} (${B.sessions} sessions) against ${A.build} (${A.sessions})${cmp.length ? `: ${cmp.join(', ')}` : ''}.`;
}

/** The daily report's "Players" lines for one product (Markdown bullets), from its snapshot. */
/** What gets in players' way: the worst kinds over the minimum sample, with how many left right after. */
export function frustrationLine(f: any) {
  if (!f || num(f.sessions) < MIN.sessions) return null;
  const worst = (f.kinds ?? []).filter((k: any) => k.sessions >= MIN.errorSessions).slice(0, 3);
  if (!worst.length) return `${pct(f.frustrationRate)} of ${f.sessions} sessions hit something in their way (none often enough to name).`;
  return `What gets in the way: ${worst.map((k: any) => `${k.kind} in ${k.sessions} sessions (${pct(k.shareOfSessions)}; ${pct(k.leftAfterRate)} left within 2 minutes)`).join('; ')}.`;
}

/** Where players' time goes: the activities they spend the most time on. */
export function engagementLine(e: any) {
  const list = (e?.activities ?? []).filter((x: any) => x.players >= 5).slice(0, 4);
  if (!list.length) return null;
  return `Where their time goes: ${list.map((x: any) => `${x.name} ${secs(x.seconds)} in all (${x.players} players, a median ${secs(x.medianSecondsPerPlayer)} each)`).join('; ')}.`;
}

export function playersSection(s: Snapshot | null, now = Date.now()): string[] {
  if (!s) return ['No player analytics for it in Hawkes Gen (the SDK isn\'t registered for it).'];
  if (!s.hasData) return ['No real players on the live site in the last 30 days (or Hawkes Analytics isn\'t on it yet).'];
  const L: string[] = [weekLine(s)];
  for (const x of [retentionLine(s.retention), dropoffLine(s.dropoff), hardestLine(s.levels), frustrationLine(s.frustration), engagementLine(s.engagement)]) if (x) L.push(x);
  const fresh = newErrors(s.errors, now);
  if (fresh.length) L.push(`New errors from real players this week: ${fresh.slice(0, 3).map((g: any) => errorLine(g, s.errors.sessions)).join('; ')}.`);
  else if (s.errors?.sessions) L.push(`No new errors this week (${pct(s.errors.errorRate)} of ${s.errors.sessions} sessions hit any error in 30 days).`);
  const r = ratingLine(s.feedback);
  if (r) L.push(r);
  const comments = (s.feedback?.comments ?? []).slice(0, 3);
  if (comments.length) L.push(`Latest feedback: ${comments.map(quote).join('; ')}.`);
  const b = buildLine(s.builds);
  if (b) L.push(b);
  return L.map((l) => `- ${l}`);
}

/** An agent brief's "players" line: top drop-off, hardest level, rating; '' when nothing has the sample. */
export function briefLine(s: Snapshot | null) {
  if (!s?.hasData) return '';
  const parts: string[] = [];
  const d = s.dropoff;
  if (d?.sessions >= MIN.sessions && d.biggest) parts.push(`biggest drop-off ${d.biggest.where} (${pct(d.biggest.share)} of ${d.sessions} sessions end there)`);
  const h = hardestLevel(s.levels);
  if (h) parts.push(`hardest level ${h.level} (${pct(h.completionRate)} of ${h.attempts} attempts completed)`);
  const r = s.feedback?.rating;
  if (r && num(r.ratings) >= MIN.ratings) parts.push(`rating ${r.average}★ from ${r.ratings}`);
  else if (r && num(r.thumbsUp) + num(r.thumbsDown) >= MIN.ratings) parts.push(`${pct(r.upShare)} thumbs up of ${num(r.thumbsUp) + num(r.thumbsDown)}`);
  if (!parts.length) return '';
  return `Players (live, last 30 days): ${parts.join('; ')}.`;
}

/** The go-live plan's line: how the build that's live now does with players, and against the one before it. */
export function liveBuildLine(b: any) {
  const B = b?.b;
  if (!B) return null;
  const k = B.kpis ?? {};
  const facts = [
    `${B.sessions} sessions, ${num(k.players)} players`,
    k.medianActiveSeconds != null ? `median session ${secs(k.medianActiveSeconds)}` : '',
    k.levelCompletionRate != null ? `level completion ${pct(k.levelCompletionRate)}` : '',
    k.errorRate != null ? `${pct(k.errorRate)} of sessions hit an error` : '',
    k.rating != null ? `rating ${k.rating}★` : '',
  ].filter(Boolean).join(', ');
  const vs = b.a ? buildLine(b) : null;
  return `Live build ${B.build} with real players (last 30 days): ${facts}.${vs && b.a && B.sessions >= MIN.buildSessions && b.a.sessions >= MIN.buildSessions ? ` ${vs}` : ''} Compare it with the new build's numbers after going live (Analytics tab).`;
}

// ------------------------------------------------------------------ work

/** Something the PM files from player data: bugs go to the backlog, ideas to the ideas list (never auto-fixed). */
export type PlayerWork = { kind: 'bug' | 'idea'; key: string; title: string; detail: string; fix: string; area: string };

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
};
const lowRating = (r: unknown) => r === 'down' || (Number.isFinite(Number(r)) && Number(r) >= 1 && Number(r) <= 2);

/**
 * The work in a snapshot, each over its minimum sample: errors in MIN.errorSessions sessions and MIN.errorShare of all
 * become bugs; a big drop-off, a hard level, low ratings and repeated complaints become ideas, with their numbers.
 * Keys are stable (players:<what>:<which>) so the same thing seen again is the same finding.
 */
export function playerWork(s: Snapshot | null, noise: (message: string, stack: string) => boolean = () => false): PlayerWork[] {
  if (!s?.hasData) return [];
  const out: PlayerWork[] = [];
  const e = s.errors;
  for (const g of e?.groups ?? []) {
    if (g.sessions < MIN.errorSessions || !e.sessions || g.sessions / e.sessions < MIN.errorShare) continue;
    if (noise(String(g.message ?? ''), String(g.stack ?? ''))) continue;
    out.push({
      kind: 'bug', key: `players:error:${hash(g.signature)}`, area: 'player errors',
      title: `Players hit an error: ${cut(g.message || g.signature, 90)}`,
      detail: [
        `Real players on the live site hit this error (Hawkes Analytics, last 30 days): ${g.sessions} of ${e.sessions} sessions (${pct(g.sessions / e.sessions)}), ${g.players} players, ${g.count} times.`,
        `Browsers: ${Object.entries(g.browsers ?? {}).slice(0, 5).map(([k, n]) => `${k} ${n}`).join(', ') || '?'}`,
        `Builds: ${Object.entries(g.builds ?? {}).slice(0, 5).map(([k, n]) => `${k} ${n}`).join(', ') || '?'}`,
        `Sources: ${top(g.sources, 5)}`,
        `First seen ${g.first ? new Date(g.first).toISOString().slice(0, 10) : '?'}, last ${g.last ? new Date(g.last).toISOString().slice(0, 10) : '?'}.`,
        `Signature: ${g.signature}`,
        `Error: ${g.message ?? ''}${g.stack ? `\n${g.stack}` : ''}`,
      ].join('\n'),
      fix: 'Find the cause from the error, its stack, the browsers and builds; fix it so real players no longer hit it (not by hiding it). studio_analytics { view: errors } shows whether it stops after the fix goes live.',
    });
  }
  const d = s.dropoff;
  if (d?.sessions >= MIN.sessions) {
    const br = d.beforeReady;
    if (br?.sessions && (br.share ?? 0) >= WORK.loadShare) out.push({
      kind: 'idea', key: 'players:dropoff:before-ready', area: 'player drop-off',
      title: 'Players leave before the game is ready',
      detail: `${pct(br.share)} of ${d.sessions} sessions (${br.sessions}) ended while the game was still loading (median wait ${secs(br.medianWaitSeconds)}, p90 ${secs(br.p90WaitSeconds)}; ${pct(br.ofLoads)} of loads). Hawkes Analytics, live, last 30 days.`,
      fix: 'Make the first load faster or show progress worth waiting for (smaller first download, a loading screen with something to do).',
    });
    const lv = (d.byLevel ?? [])[0];
    if (lv && (lv.share ?? 0) >= WORK.dropShare && lv.sessions >= 5) out.push({
      kind: 'idea', key: `players:dropoff:level:${lv.value}`, area: 'player drop-off',
      title: `Players drop off in level ${lv.value}`,
      detail: `${pct(lv.share)} of ${d.sessions} sessions (${lv.sessions}) ended in level ${lv.value}${lv.medianSecondsIn != null ? `, a median ${secs(lv.medianSecondsIn)} into it` : ''}. Hawkes Analytics, live, last 30 days.`,
      fix: `Look at what happens around that point in level ${lv.value} (studio_analytics { view: levels } and the deaths): a difficulty spike, a confusing step, or a natural stopping point that needs a reason to go on.`,
    });
  }
  for (const x of s.levels ?? []) {
    if (num(x.attempts) < MIN.attempts || x.completionRate == null) continue;
    const hard = x.completionRate <= WORK.completion;
    const quits = x.quitRate != null && x.quitRate >= WORK.quitRate;
    if (!hard && !quits) continue;
    out.push({
      kind: 'idea', key: `players:level:${x.level}`, area: 'player difficulty',
      title: `Level ${x.level} is a difficulty spike for players`,
      detail: `${levelLine(x)}; ${x.winners} players won it, ${x.neverWon} never did. Hawkes Analytics, live, last 30 days.`,
      fix: `Tune level ${x.level} (where players die, what kills them) so more players get through, or teach what it needs earlier.`,
    });
  }
  const r = s.feedback?.rating;
  if (r) {
    const thumbs = num(r.thumbsUp) + num(r.thumbsDown);
    const lowStars = num(r.ratings) >= MIN.ratings && r.average != null && r.average <= WORK.rating;
    const lowThumbs = thumbs >= MIN.ratings && r.upShare != null && r.upShare <= WORK.upShare;
    if (lowStars || lowThumbs) out.push({
      kind: 'idea', key: 'players:rating', area: 'player feedback',
      title: 'Players rate the game low',
      detail: `${[lowStars ? `Average ${r.average} stars from ${r.ratings} ratings` : '', lowThumbs ? `${pct(r.upShare)} thumbs up of ${thumbs}` : ''].filter(Boolean).join('; ')}. Hawkes Analytics, live, last 30 days. Recent comments: ${(s.feedback.comments ?? []).slice(0, 5).map(quote).join('; ') || 'none'}.`,
      fix: 'Read the comments and the context they rated (studio_analytics { view: feedback }); fix what they name first.',
    });
  }
  // What gets in players' way, often enough to matter: the site failing them is a bug, the rest ideas.
  const f = s.frustration;
  if (f && f.sessions >= MIN.sessions) {
    for (const k of f.kinds ?? []) {
      if (k.kind === 'error' || k.kind === 'rage_click' || k.sessions < MIN.errorSessions || (k.shareOfSessions ?? 0) < 0.05) continue; // errors are above, by signature
      const broken = ['server_error', 'request_failed', 'job_failed', 'generation_failed', 'assistant_failed', 'assistant_unreachable', 'edit_not_saved'].includes(k.kind);
      const where = Object.keys(k.pages ?? {}).slice(0, 3).join(', ');
      out.push({
        kind: broken ? 'bug' : 'idea', key: `players:frustration:${k.kind}`, area: 'player frustration',
        title: `Players run into ${k.kind.replace(/_/g, ' ')}`,
        detail: `${k.sessions} of ${f.sessions} sessions (${pct(k.shareOfSessions)}), ${k.players} players, ${k.count} times${where ? `, mostly on ${where}` : ''}; ${pct(k.leftAfterRate)} of those sessions ended within 2 minutes of it. Hawkes Analytics, live, last 30 days.`,
        fix: broken ? `Find why ${k.kind.replace(/_/g, ' ')} happens (studio_analytics { view: frustration } has where and the latest) and fix it.` : `Make ${k.kind.replace(/_/g, ' ')} less of a wall: say what to do next where it happens (studio_analytics { view: frustration }).`,
      });
    }
    const rage = (f.rageClicks ?? [])[0];
    if (rage && rage.sessions >= MIN.errorSessions) out.push({
      kind: 'idea', key: `players:rage:${hash(rage.where)}`, area: 'player frustration',
      title: `Players click again and again on ${cut(rage.where, 60)}`,
      detail: `Rage clicks (3 fast clicks in one spot) on ${rage.where}: ${rage.count} times in ${rage.sessions} sessions. It looks clickable and doesn't do what they expect, or it's slow to answer. Hawkes Analytics, live, last 30 days.`,
      fix: 'Make it answer at once (or not look clickable), and check it works on phones.',
    });
  }
  // Repeated complaints: low-rated comments about the same thing (their context, else the level).
  const groups = new Map<string, any[]>();
  for (const c of s.feedback?.comments ?? []) {
    if (!lowRating(c.rating) || !c.text) continue;
    const about = String(c.context ?? (c.level != null ? `level ${c.level}` : 'the game')).toLowerCase().trim().slice(0, 60);
    groups.set(about, [...(groups.get(about) ?? []), c]);
  }
  for (const [about, list] of groups) {
    if (list.length < MIN.complaints) continue;
    out.push({
      kind: 'idea', key: `players:complaints:${about}`, area: 'player feedback',
      title: `Players complain about ${about}`,
      detail: `${list.length} low-rated comments about ${about} (Hawkes Analytics, live, last 30 days): ${list.slice(0, 6).map(quote).join('; ')}.`,
      fix: `Address what these players say about ${about}.`,
    });
  }
  return out;
}

// ------------------------------------------------------------------ studio_analytics

export const VIEWS = ['overview', 'product', 'dropoff', 'levels', 'feedback', 'errors', 'frustration', 'engagement', 'accounts', 'builds', 'insights', 'session'] as const;
export type View = (typeof VIEWS)[number];

/** Studio's analytics route (src/analytics.ts, under /api/analytics) for a view, or an error message. */
export function viewRoute(a: { view?: string; product?: string; session?: string; user?: string; range?: string; env?: string; build?: string; device?: string; browser?: string; country?: string; from?: string; to?: string; a?: string; b?: string }) {
  const view = (a.view || (a.product ? 'product' : 'overview')) as View;
  if (!VIEWS.includes(view)) throw new Error(`view: ${VIEWS.join(' | ')}`);
  if (view !== 'overview' && !a.product) throw new Error(`view ${view} needs a product`);
  if (view === 'session' && !a.session) throw new Error('view session needs session (its id, s_...)');
  const params = new URLSearchParams();
  for (const k of ['range', 'env', 'build', 'device', 'browser', 'country', 'from', 'to', ...(view === 'builds' ? ['a', 'b'] : []), ...(view === 'accounts' ? [] : ['user'])] as const) {
    const v = (a as any)[k];
    if (v != null && v !== '') params.set(k, String(v));
  }
  const p = encodeURIComponent(String(a.product ?? ''));
  const path = view === 'overview' ? '/api/analytics/overview' : view === 'product' ? `/api/analytics/${p}` : view === 'session' ? `/api/analytics/${p}/sessions/${encodeURIComponent(String(a.session))}`
    : view === 'accounts' && a.user ? `/api/analytics/${p}/accounts/${encodeURIComponent(String(a.user))}` : `/api/analytics/${p}/${view}`;
  const qs = params.toString();
  return { view, path: `${path}${qs ? `?${qs}` : ''}` };
}

/**
 * studio_analytics' answer: compact JSON (what an agent needs, not every row) plus plain sentences with their sample
 * sizes. Gen's answer for the view goes in; the filters are said in `scope`.
 */
export function compactView(view: View, d: any, scope = 'live, last 30 days unless a range was given; bots and internal left out') {
  const say: string[] = [];
  let data: any;
  if (view === 'overview') {
    data = (d?.products ?? []).map((p: any) => ({
      product: p.product, name: p.name, hasData: p.hasData ?? null, activeNow: p.activeNow, '7d': p['7d'] && { sessions: p['7d'].sessions, visitors: p['7d'].visitors, previous: p['7d'].previous, trend: p['7d'].trend },
      d1: p.retention?.d1 ?? null, biggestDropoff: p.biggestDropoff ?? null, errorRate: p.errorRate ?? null, rating: p.rating ?? null, medianActiveSeconds: p.medianActiveSeconds ?? null,
    }));
    for (const p of data) {
      const w = p['7d'];
      if (!w?.sessions && !w?.previous?.sessions) { say.push(`${p.name}: no players in the last 14 days.`); continue; }
      const c = w.sessions >= MIN.sessions && w.previous?.sessions >= MIN.sessions ? `, ${w.sessions >= w.previous.sessions ? 'up' : 'down'} ${pct(Math.abs(change(w.sessions, w.previous.sessions)!))} from ${w.previous.sessions}` : ` (${w.previous?.sessions ?? 0} the 7 days before)`;
      const extra = [p.d1 && num(p.d1.eligible) >= MIN.retention ? `D1 ${pct(p.d1.rate)} of ${p.d1.eligible}` : '', p.rating?.ratings >= MIN.ratings ? `rating ${p.rating.average}★ (${p.rating.ratings})` : '', p.errorRate != null ? `${pct(p.errorRate)} of sessions hit an error` : ''].filter(Boolean);
      say.push(`${p.name}: ${w.sessions} sessions, ${w.visitors} players in 7 days${c}${extra.length ? `; ${extra.join('; ')}` : ''}.`);
    }
  } else if (view === 'product') {
    const s = d?.sessions ?? {};
    const hard = hardestLevel(d?.levels ?? []);
    data = {
      sessions: { sessions: s.sessions, players: s.players, medianActiveSeconds: s.medianActiveSeconds, p90ActiveSeconds: s.p90ActiveSeconds },
      retention: d?.retention?.total ?? null, dropoff: d?.dropoff && { sessions: d.dropoff.sessions, beforeReady: d.dropoff.beforeReady, biggest: d.dropoff.biggest, byLevel: (d.dropoff.byLevel ?? []).slice(0, 5) },
      hardestLevel: hard, rating: d?.feedback?.rating ?? null, errorRate: d?.errors?.errorRate ?? null, topErrors: (d?.errors?.groups ?? []).slice(0, 3).map((g: any) => ({ message: cut(g.message || g.signature, 160), sessions: g.sessions, players: g.players })),
      readyRate: d?.perf?.readyRate ?? null, readyMs: d?.perf?.readyMs ?? null, funnelLoss: d?.funnel?.biggestLoss ?? null,
    };
    say.push(`${num(s.sessions)} sessions from ${num(s.players)} players; median session ${secs(s.medianActiveSeconds)} of active play.`);
    for (const x of [retentionLine(data.retention), dropoffLine(d?.dropoff), hardestLine(d?.levels ?? []), ratingLine(d?.feedback)]) if (x) say.push(x);
    if (d?.errors?.sessions) say.push(`${pct(d.errors.errorRate)} of ${d.errors.sessions} sessions hit an error${data.topErrors[0] ? `; the most common: ${errorLine(d.errors.groups[0], d.errors.sessions)}` : ''}.`);
    if (data.funnelLoss && data.funnelLoss.of >= 20) say.push(`The funnel loses the most between ${data.funnelLoss.after} and ${data.funnelLoss.before}: ${data.funnelLoss.lost} of ${data.funnelLoss.of} (${pct(data.funnelLoss.rate)}).`);
  } else if (view === 'dropoff') {
    data = { sessions: d?.sessions, beforeReady: d?.beforeReady, biggest: d?.biggest, byLevel: (d?.byLevel ?? []).slice(0, 10), byScreen: (d?.byScreen ?? []).slice(0, 8), byEvent: (d?.byEvent ?? []).slice(0, 8) };
    const l = dropoffLine(d);
    if (l) say.push(l);
    if (num(d?.sessions) >= MIN.sessions) for (const x of data.byLevel.slice(0, 5)) say.push(`${pct(x.share)} of sessions (${x.sessions}) ended in level ${x.value}${x.medianSecondsIn != null ? `, median ${secs(x.medianSecondsIn)} into it` : ''}.`);
  } else if (view === 'levels') {
    data = (Array.isArray(d) ? d : []).slice(0, 40);
    if (!data.length) say.push('No level starts from real players.');
    const h = hardestLine(data);
    if (h) say.push(h);
    for (const x of data.filter((x: any) => num(x.attempts) >= MIN.attempts).slice(0, 12)) say.push(`${levelLine(x)}.`.replace(/^l/, 'L'));
    const few = data.filter((x: any) => num(x.attempts) < MIN.attempts).length;
    if (few) say.push(`${few} level(s) have under ${MIN.attempts} attempts: their rates are noise.`);
  } else if (view === 'feedback') {
    data = { count: d?.count, rating: d?.rating, stars: d?.stars, comments: (d?.comments ?? []).slice(0, 25).map((c: any) => ({ at: c.at, rating: c.rating, text: cut(c.text, 400), context: c.context, level: c.level, build: c.build })) };
    say.push(ratingLine(d) ?? `${num(d?.count)} feedback events, no ratings.`);
    for (const c of data.comments.slice(0, 8)) say.push(`${quote(c)}.`);
  } else if (view === 'errors') {
    data = { errors: d?.errors, sessions: d?.sessions, sessionsWithErrors: d?.sessionsWithErrors, errorRate: d?.errorRate, groups: (d?.groups ?? []).slice(0, 15).map((g: any) => ({ signature: g.signature, message: cut(g.message, 300), stack: String(g.stack ?? '').slice(0, 800), count: g.count, sessions: g.sessions, players: g.players, browsers: g.browsers, builds: g.builds, sources: g.sources, first: g.first, last: g.last })) };
    say.push(`${pct(d?.errorRate)} of ${num(d?.sessions)} sessions hit an error (${num(d?.errors)} errors).`);
    for (const g of data.groups.slice(0, 6)) say.push(`${errorLine(g, num(d?.sessions))}${g.sessions < MIN.errorSessions ? ' (under the minimum sample)' : ''}.`);
  } else if (view === 'frustration') {
    data = { sessions: d?.sessions, sessionsWithFrustration: d?.sessionsWithFrustration, frustrationRate: d?.frustrationRate, leftAfterRate: d?.leftAfterRate, kinds: (d?.kinds ?? []).slice(0, 15).map((k: any) => ({ kind: k.kind, count: k.count, sessions: k.sessions, players: k.players, accounts: k.accounts, shareOfSessions: k.shareOfSessions, leftAfterRate: k.leftAfterRate, pages: k.pages, last: k.last })), rageClicks: (d?.rageClicks ?? []).slice(0, 10), recent: (d?.recent ?? []).slice(0, 15) };
    say.push(`${pct(d?.frustrationRate)} of ${num(d?.sessions)} sessions hit something in their way; ${pct(d?.leftAfterRate)} of those left within 2 minutes of it.`);
    for (const k of data.kinds.slice(0, 8)) say.push(`${k.kind}: ${k.sessions} sessions (${pct(k.shareOfSessions)}), ${k.count} times, ${pct(k.leftAfterRate)} left right after${Object.keys(k.pages ?? {}).length ? `; on ${Object.keys(k.pages).slice(0, 3).join(', ')}` : ''}${k.sessions < MIN.errorSessions ? ' (under the minimum sample)' : ''}.`);
    for (const r of data.rageClicks.slice(0, 3)) say.push(`Rage clicks on ${r.where}: ${r.count} in ${r.sessions} sessions.`);
  } else if (view === 'engagement') {
    data = { players: d?.players, sessions: d?.sessions, activeSeconds: d?.activeSeconds, activities: (d?.activities ?? []).slice(0, 15) };
    say.push(engagementLine(d) ?? `No activity time from 5 or more players yet (${num(d?.players)} players in the range).`);
  } else if (view === 'accounts') {
    const list = (d?.accounts ?? []).slice(0, 40);
    data = { total: d?.total, identifiedSessions: d?.identifiedSessions, accounts: list, sessions: d?.sessions ? { total: d.sessions.total, items: (d.sessions.items ?? []).slice(0, 30) } : undefined };
    say.push(`${num(d?.total)} signed-in accounts with ${num(d?.identifiedSessions)} sessions in the range.`);
    for (const x of list.slice(0, 10)) say.push(`${x.user}: ${x.sessions} sessions, ${secs(x.activeSeconds)} active; time on ${(x.topActivities ?? []).map((t: any) => `${t.name} ${secs(t.value)}`).join(', ') || 'nothing tracked'}${(x.frustrationKinds ?? []).length ? `; got in the way: ${x.frustrationKinds.map((k: any) => `${k.name} ×${k.value}`).join(', ')}` : ''}${Object.keys(x.milestones ?? {}).length ? `; ${Object.entries(x.milestones).map(([k, n]) => `${k} ×${n}`).join(', ')}` : ''}.`);
  } else if (view === 'builds') {
    const side = (x: any) => x && { build: x.build, sessions: x.sessions, first: x.first, commit: x.commit_sha ?? null, kpis: x.kpis };
    data = { a: side(d?.a), b: side(d?.b), builds: (d?.builds ?? []).slice(0, 10).map((x: any) => ({ build: x.build, sessions: x.sessions, first: x.first })) };
    say.push(buildLine(d) ?? 'No builds reported by real players in the range.');
  } else if (view === 'insights') {
    data = { sessions: d?.sessions, minimumSample: d?.minimumSample, insights: d?.insights ?? [] };
    say.push(...(data.insights.length ? data.insights.map((x: any) => x.text) : [`Nothing stands out over the minimum samples (${num(d?.sessions)} sessions in the range).`]));
  } else {
    const s = d?.session ?? {};
    data = { session: { id: s.id, env: s.env, build: s.build, started: s.started, ended: s.ended, active_ms: s.active_ms, events: s.events, deaths: s.deaths, errors: s.errors, levels_done: s.levels_done, last_level: s.last_level, last_screen: s.last_screen, last_event: s.last_event, device: s.device, browser: s.browser, os: s.os, country: s.country, bot: s.bot, internal: s.internal },
      events: (d?.events ?? []).slice(0, 200).map((e: any) => ({ offsetMs: e.offsetMs, name: e.name, screen: e.screen, level: e.level, props: e.props })) };
    say.push(`Session ${s.id ?? '?'}: ${secs(num(s.active_ms) / 1000)} active, ${num(s.events)} events, ${num(s.deaths)} deaths, ${num(s.errors)} errors, ${num(s.levels_done)} levels done; ended on ${s.last_level != null ? `level ${s.last_level}` : s.last_screen ?? '?'} (${[s.browser, s.device, s.country].filter(Boolean).join(', ')}).`);
  }
  return { view, scope, sentences: say, data };
}
