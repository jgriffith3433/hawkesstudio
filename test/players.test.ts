// Player analytics as feedback (src/players.ts): studio_analytics' compact answer with sentences and sample sizes, the
// daily report's "Players" section from a run's players step, the PM's work from player data (minimum samples, bugs vs
// ideas) and its dedupe in the backlog, the brief's and the go-live plan's lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-players-'));
const P = await import('../src/players.ts');
const { db, newId, J } = await import('../src/db.ts');
await import('../src/roadmap.ts'); // the findings' source column
const { filePlayerWork, getFinding, updateFinding } = await import('../src/backlog.ts');
const { reportMarkdown } = await import('../src/report.ts');
const { studioMcp } = await import('../src/mcp-tools.ts');

const NOW = Date.parse('2026-10-19T12:00:00Z');
const DAY = 86_400_000;

/** A product with enough players for everything to be said. */
function rich(): any {
  return {
    product: 'sickofit', at: NOW, hasData: true,
    week: { sessions: 540, players: 312, medianActiveSeconds: 240 },
    prevWeek: { sessions: 450, players: 280, medianActiveSeconds: 200 },
    retention: { players: 400, d1: { eligible: 150, returned: 27, rate: 0.18 }, d7: { eligible: 90, returned: 6, rate: 0.067 } },
    dropoff: {
      sessions: 200, beforeReady: { sessions: 10, share: 0.05, ofLoads: 0.05, medianWaitSeconds: 12, p90WaitSeconds: 30 },
      byLevel: [{ value: '3', sessions: 68, share: 0.34, medianSecondsIn: 45 }, { value: '1', sessions: 20, share: 0.1 }],
      biggest: { where: 'level 3', sessions: 68, share: 0.34, medianSecondsIn: 45 },
    },
    levels: [
      { level: '1', attempts: 300, players: 250, completes: 240, completionRate: 0.8, quitRate: 0.05, quits: 5, abandoned: 10, deaths: 90, deathsPerAttempt: 0.3, medianRetriesBeforeFirstWin: 0, winners: 230, neverWon: 20 },
      { level: '3', attempts: 140, players: 90, completes: 39, completionRate: 0.28, quitRate: 0.4, quits: 30, abandoned: 26, deaths: 294, deathsPerAttempt: 2.1, medianRetriesBeforeFirstWin: 3, winners: 30, neverWon: 60 },
      { level: '9', attempts: 4, players: 2, completes: 0, completionRate: 0, quitRate: 1, quits: 4, abandoned: 0, deaths: 8, deathsPerAttempt: 2, winners: 0, neverWon: 2 },
    ],
    feedback: {
      count: 40, rating: { average: 2.6, ratings: 25, thumbsUp: 0, thumbsDown: 0, upShare: null },
      comments: [
        { at: NOW - 1000, rating: 1, text: 'the bridge imps are impossible', context: 'level 3', level: '3', build: '1.4.2' },
        { at: NOW - 2000, rating: 2, text: 'too hard, gave up', context: 'level 3', level: '3', build: '1.4.2' },
        { at: NOW - 3000, rating: 'down', text: 'level 3 again...', context: 'Level 3', level: '3', build: '1.4.1' },
        { at: NOW - 4000, rating: 5, text: 'love the music', context: 'the ending', level: null, build: '1.4.2' },
      ],
    },
    errors: {
      errors: 90, sessions: 540, sessionsWithErrors: 40, errorRate: 0.074,
      groups: [
        { signature: "TypeError: Cannot read properties of undefined (reading '…') | at boss.js:N:N", message: "TypeError: Cannot read properties of undefined (reading 'hp')", stack: 'at boss.js:10:4', count: 60, sessions: 30, players: 25, browsers: { Chrome: 40, Safari: 20 }, builds: { '1.4.2': 60 }, sources: { window: 60 }, first: NOW - 3 * DAY, last: NOW - DAY },
        { signature: 'old thing', message: 'Old error', count: 20, sessions: 8, players: 8, browsers: { Firefox: 20 }, builds: { '1.3': 20 }, sources: { window: 20 }, first: NOW - 25 * DAY, last: NOW - 2 * DAY },
        { signature: 'rare', message: 'Rare error', count: 3, sessions: 3, players: 3, browsers: { Chrome: 3 }, builds: { '1.4.2': 3 }, sources: { window: 3 }, first: NOW - DAY, last: NOW - DAY },
        { signature: 'ext', message: 'Script error from extension', stack: 'chrome-extension://abc/x.js:1:1', count: 40, sessions: 20, players: 20, browsers: { Chrome: 40 }, builds: {}, sources: {}, first: NOW - DAY, last: NOW },
      ],
    },
    builds: {
      count: 2,
      a: { build: '1.4.1', sessions: 300, kpis: { players: 200, medianActiveSeconds: 180, levelCompletionRate: 0.5, errorRate: 0.03, rating: 3.1 } },
      b: { build: '1.4.2', sessions: 240, kpis: { players: 150, medianActiveSeconds: 240, levelCompletionRate: 0.55, errorRate: 0.09, rating: 2.4 } },
    },
  };
}

/** A product with a handful of players: nothing should be called a change or become work. */
function thin(): any {
  return {
    product: 'phorigins', at: NOW, hasData: true,
    week: { sessions: 8, players: 5, medianActiveSeconds: 60 }, prevWeek: { sessions: 3, players: 2, medianActiveSeconds: 50 },
    retention: { players: 6, d1: { eligible: 4, returned: 3, rate: 0.75 } },
    dropoff: { sessions: 9, beforeReady: { sessions: 5, share: 0.55 }, byLevel: [{ value: '1', sessions: 4, share: 0.44 }], biggest: { where: 'before the game was ready', sessions: 5, share: 0.55, medianWaitSeconds: 20 } },
    levels: [{ level: '1', attempts: 6, players: 4, completes: 0, completionRate: 0, quitRate: 1, quits: 6, abandoned: 0, deaths: 2, winners: 0, neverWon: 4 }],
    feedback: { count: 3, rating: { average: 1, ratings: 3, thumbsUp: 0, thumbsDown: 2, upShare: 0 }, comments: [{ rating: 1, text: 'bad', context: 'x' }, { rating: 1, text: 'bad', context: 'x' }] },
    errors: { errors: 4, sessions: 8, sessionsWithErrors: 4, errorRate: 0.5, groups: [{ signature: 's', message: 'Boom', count: 4, sessions: 4, players: 3, browsers: { Chrome: 4 }, builds: {}, sources: {}, first: NOW - DAY, last: NOW }] },
    builds: { count: 2, a: { build: '0.9', sessions: 5, kpis: {} }, b: { build: '1.0', sessions: 3, kpis: {} } },
  };
}

test('the report lines say the numbers, and changes only over the minimum sample', () => {
  const L = P.playersSection(rich(), NOW).join('\n');
  assert.match(L, /312 players and 540 sessions this week, up 20% from 450 sessions \(280 players\) the week before/);
  assert.match(L, /D1 retention 18%: 27 of 150 new players/);
  assert.match(L, /biggest drop-off: 34% of 200 sessions ended in level 3 \(median 45 s into it\)/);
  assert.match(L, /hardest level: level 3: 28% of 140 attempts completed by 90 players/);
  // Level 9 (4 attempts) is never the hardest: under the minimum.
  assert.doesNotMatch(L, /level 9/);
  // New errors: first seen this week (the old one isn't new).
  assert.match(L, /New errors from real players this week: "TypeError: Cannot read properties of undefined \(reading 'hp'\)" in 30 of 540 sessions \(6%, 25 players; Chrome, Safari; builds 1\.4\.2\)/);
  assert.doesNotMatch(L, /Old error/);
  assert.match(L, /Rating: average 2\.6 stars from 25 ratings/);
  assert.match(L, /Latest feedback: "the bridge imps are impossible" \(1★\) on level 3, build 1\.4\.2/);
  assert.match(L, /Build 1\.4\.2 \(240 sessions\) against 1\.4\.1 \(300\): median session 4 min vs 3 min, level completion 55% vs 50%, sessions with an error 9% vs 3%/);

  const T = P.playersSection(thin(), NOW).join('\n');
  assert.match(T, /5 players and 8 sessions this week; the week before had 3 sessions \(under 30 sessions a week is too few to call a change\)/);
  assert.match(T, /D1 retention: too few new players yet \(4/);
  assert.match(T, /9 finished sessions, too few to say where players leave/);
  assert.match(T, /none has 20 attempts yet/);
  assert.match(T, /3 star ratings \(too few to average\)/);
  assert.match(T, /too few to compare/);
  assert.doesNotMatch(T, /up \d+%|down \d+%/);

  assert.match(P.playersSection(null)[0], /No player analytics/);
  assert.match(P.playersSection({ ...thin(), hasData: false })[0], /No real players/);
});

test('the daily report has a "Players" section from the run\'s players step', () => {
  const run = newId('r');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(run, 'daily', 'done', 'x', J(['sickofit', 'phorigins']), J({}), NOW, NOW + 60_000);
  const step = (product: string, status: string, detail: string, data: unknown) => db.prepare('INSERT INTO steps (id, run, product, kind, name, status, detail, data, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(newId('s'), run, product, 'players', 'live', status, detail, J(data), NOW, NOW);
  step('sickofit', 'done', '312 players', rich());
  step('phorigins', 'skipped', "Hawkes Gen didn't answer: offline", null);
  const md = reportMarkdown(run).markdown;
  const soi = md.slice(md.indexOf('## Sick Of It'), md.indexOf('## PH Origins'));
  assert.match(soi, /### Players \(live site\)/);
  assert.match(soi, /- 312 players and 540 sessions this week/);
  assert.match(soi, /- The hardest level: level 3/);
  // The step itself isn't listed with the build and playtests.
  assert.doesNotMatch(soi, /\*\*players\*\*/);
  assert.match(md.slice(md.indexOf('## PH Origins')), /### Players \(live site\)\n\n- Hawkes Gen didn't answer: offline/);
});

test('player data becomes work only over the minimum samples: errors are bugs, the rest ideas', () => {
  const noise = (m: string, s: string) => /extension:/.test(s);
  const w = P.playerWork(rich(), noise);
  const by = Object.fromEntries(w.map((x) => [x.key, x]));
  const bugs = w.filter((x) => x.kind === 'bug');
  // The boss error (30 sessions, 6%) and the old one (8 sessions, 1.5%: under 2% of sessions) — only the first; the rare
  // one (3 sessions) and the extension's never.
  assert.equal(bugs.length, 1);
  assert.match(bugs[0].title, /Players hit an error: TypeError/);
  assert.match(bugs[0].detail, /30 of 540 sessions \(6%\), 25 players, 60 times/);
  assert.match(bugs[0].detail, /Browsers: Chrome 40, Safari 20/);
  assert.match(bugs[0].detail, /Builds: 1\.4\.2 60/);
  assert.ok(by['players:dropoff:level:3'], 'the level 3 drop-off (34%)');
  assert.equal(by['players:dropoff:level:3'].kind, 'idea');
  assert.ok(!by['players:dropoff:before-ready'], '5% before ready is under 15%');
  assert.ok(by['players:level:3'] && !by['players:level:1'] && !by['players:level:9'], 'level 3 is a spike; 1 is fine, 9 has 4 attempts');
  assert.ok(by['players:rating'], 'average 2.6 from 25');
  // Three low-rated comments on level 3 (context case doesn't matter); the 5-star one isn't a complaint.
  assert.match(by['players:complaints:level 3'].detail, /3 low-rated comments about level 3/);
  assert.ok(w.every((x) => x.kind === 'bug' || !/error/i.test(x.area)));

  assert.deepEqual(P.playerWork(thin()), [], 'a handful of players makes no work');
  assert.deepEqual(P.playerWork(null), []);
});

test('player work is deduped across days, ideas stay ideas, and a fixed bug players still hit reopens', () => {
  const w = P.playerWork(rich(), (_m, s) => /extension:/.test(s));
  const first = filePlayerWork('sickofit', w, NOW);
  assert.equal(first.added.length, w.length);
  const bug = getFinding(first.added[w.findIndex((x) => x.kind === 'bug')])!;
  assert.equal(bug.status, 'open');
  assert.equal(bug.severity, 'bug');
  assert.equal((db.prepare('SELECT source FROM findings WHERE id = ?').get(bug.id) as any).source, 'players');
  const idea = getFinding(first.added[w.findIndex((x) => x.key === 'players:level:3')])!;
  assert.equal(idea.status, 'idea');

  // The next day: the same things, nothing new; seen counts go up once.
  const again = filePlayerWork('sickofit', w, NOW + DAY);
  assert.deepEqual(again.added, []);
  assert.equal(again.updated.length, w.length);
  assert.equal(getFinding(bug.id)!.seen, 2);
  // The same day again: not counted twice.
  filePlayerWork('sickofit', w, NOW + DAY + 3600_000);
  assert.equal(getFinding(bug.id)!.seen, 2);

  // An agent fixed the bug, but players still hit it: it comes back. A won't-fix idea stays won't-fix.
  updateFinding(bug.id, { status: 'fixed' });
  updateFinding(idea.id, { status: 'wontfix' });
  const third = filePlayerWork('sickofit', w, NOW + 2 * DAY);
  assert.ok(third.reopened.includes(bug.id));
  assert.equal(getFinding(bug.id)!.status, 'open');
  assert.equal(getFinding(idea.id)!.status, 'wontfix');
  // Another product's same error is its own finding.
  assert.equal(filePlayerWork('phorigins', [w[0]], NOW).added.length, 1);
});

test('the brief\'s players line and the go-live line', () => {
  assert.equal(P.briefLine(rich()), 'Players (live, last 30 days): biggest drop-off level 3 (34% of 200 sessions end there); hardest level 3 (28% of 140 attempts completed); rating 2.6★ from 25.');
  assert.equal(P.briefLine(thin()), '');
  assert.equal(P.briefLine(null), '');
  const live = P.liveBuildLine(rich().builds)!;
  assert.match(live, /^Live build 1\.4\.2 with real players \(last 30 days\): 240 sessions, 150 players, median session 4 min, level completion 55%, 9% of sessions hit an error, rating 2\.4★\. Build 1\.4\.2/);
  assert.doesNotMatch(P.liveBuildLine(thin().builds)!, /against/);
  assert.equal(P.liveBuildLine(null), null);
});

test('a snapshot asks Gen for live data only, and a product Gen doesn\'t know is null', async () => {
  const asked: string[] = [];
  const s = await P.snapshot('sickofit', async (p) => {
    asked.push(p);
    if (p.includes('/sessions?')) return { sessions: 40, players: 20, medianActiveSeconds: 90 };
    if (p.includes('/errors?')) return { errors: 1, sessions: 40, groups: [{ signature: 'x', message: 'y'.repeat(900), stack: 'z', count: 1, sessions: 1, players: 1 }] };
    if (p.includes('/levels?')) return [];
    throw Object.assign(new Error('nope'), { status: 500 });
  }, NOW);
  assert.ok(s?.hasData);
  assert.equal(asked.length, 10);
  assert.ok(asked.every((p) => p.startsWith('/analytics/sickofit/') && !/env=|bots=|internal=/.test(p)), 'Gen\'s defaults: live, no bots, no internal');
  assert.ok(asked.includes(`/analytics/sickofit/sessions?from=${NOW - 14 * DAY}&to=${NOW - 7 * DAY}`));
  assert.ok(s!.errors.groups[0].message.length <= 300, 'trimmed for the step');
  assert.equal(s!.feedback, null);
  assert.equal(await P.snapshot('nosuch', async () => { throw Object.assign(new Error('No analytics product'), { status: 404 }); }), null);
  await assert.rejects(P.snapshot('sickofit', async () => { throw Object.assign(new Error("Can't reach Hawkes Gen"), { status: 0 }); }), /reach/);
});

test('studio_analytics: the route per view, and compact JSON with sentences and sample sizes', async () => {
  assert.equal(P.viewRoute({}).path, '/api/analytics/overview');
  assert.equal(P.viewRoute({ product: 'sickofit' }).path, '/api/analytics/sickofit');
  assert.equal(P.viewRoute({ product: 'sickofit', view: 'levels', range: '7d', build: '1.4.2', a: 'x' }).path, '/api/analytics/sickofit/levels?range=7d&build=1.4.2');
  assert.equal(P.viewRoute({ product: 'sickofit', view: 'builds', a: '1.4.1', b: '1.4.2' }).path, '/api/analytics/sickofit/builds?a=1.4.1&b=1.4.2');
  assert.equal(P.viewRoute({ product: 'sickofit', view: 'session', session: 's_abcdefgh12' }).path, '/api/analytics/sickofit/sessions/s_abcdefgh12');
  assert.throws(() => P.viewRoute({ view: 'levels' }), /needs a product/);
  assert.throws(() => P.viewRoute({ product: 'x', view: 'session' }), /needs session/);
  assert.throws(() => P.viewRoute({ product: 'x', view: 'nope' }), /view:/);

  // Through the MCP tool, with a stand-in for Studio's API.
  const asked: string[] = [];
  const answers: Record<string, any> = {
    '/api/analytics/sickofit/levels?range=7d': rich().levels,
    '/api/analytics/sickofit/errors': rich().errors,
    '/api/analytics/overview': { products: [{ product: 'sickofit', name: 'Sick Of It', hasData: true, activeNow: 2, '7d': { sessions: 540, visitors: 312, previous: { sessions: 450, visitors: 280 } }, retention: { d1: { eligible: 150, returned: 27, rate: 0.18 } }, rating: { average: 4.1, ratings: 12 }, errorRate: 0.07 }, { product: 'icanbe', name: 'I Can Be', '7d': { sessions: 0, visitors: 0, previous: { sessions: 0 } } }] },
  };
  const server = studioMcp({ studio: (async (p: string) => { asked.push(p); return answers[p]; }) as any, waitRun: (async () => ({})) as any });
  const tool = server.tools.find((t) => t.name === 'studio_analytics')!;
  const lv: any = await tool.run({ product: 'sickofit', view: 'levels', range: '7d' });
  assert.equal(lv.view, 'levels');
  assert.match(lv.scope, /live, 7d; bots and J's own devices left out/);
  assert.match(lv.sentences[0], /The hardest level: level 3: 28% of 140 attempts/);
  assert.ok(lv.sentences.some((x: string) => /^Level 1: 80% of 300 attempts/.test(x)));
  assert.ok(lv.sentences.some((x: string) => /1 level\(s\) have under 20 attempts: their rates are noise/.test(x)));
  assert.equal(lv.data.length, 3);
  const er: any = await tool.run({ product: 'sickofit', view: 'errors' });
  assert.match(er.sentences[0], /7% of 540 sessions hit an error \(90 errors\)/);
  assert.match(er.sentences.find((x: string) => /Rare error/.test(x)), /under the minimum sample/);
  assert.ok(er.data.groups.every((g: any) => g.stack.length <= 800));
  const ov: any = await tool.run({});
  assert.equal(ov.sentences[0], 'Sick Of It: 540 sessions, 312 players in 7 days, up 20% from 450; D1 18% of 150; rating 4.1★ (12); 7% of sessions hit an error.');
  assert.equal(ov.sentences[1], 'I Can Be: no players in the last 14 days.');
  assert.deepEqual(asked, ['/api/analytics/sickofit/levels?range=7d', '/api/analytics/sickofit/errors', '/api/analytics/overview']);
  // Agents' own server lists it (agents.ts AGENT_STUDIO_TOOLS).
  const { AGENT_STUDIO_TOOLS } = await import('../src/agents.ts');
  assert.ok(AGENT_STUDIO_TOOLS.includes('studio_analytics'));
});

test('what gets in the way and where the time goes: report lines, work over the minimum sample, the views', async () => {
  const s = rich();
  s.frustration = {
    sessions: 540, sessionsWithFrustration: 120, frustrationRate: 0.22, leftAfterRate: 0.4,
    kinds: [
      { kind: 'out_of_credits', count: 90, sessions: 70, players: 60, shareOfSessions: 0.13, leftAfter: 40, leftAfterRate: 0.57, pages: { '/app/g/*': 50 } },
      { kind: 'server_error', count: 40, sessions: 30, players: 28, shareOfSessions: 0.056, leftAfter: 10, leftAfterRate: 0.33, pages: { '/app': 30 } },
      { kind: 'assistant_slow', count: 3, sessions: 3, players: 3, shareOfSessions: 0.006, leftAfter: 0, leftAfterRate: 0, pages: {} },
    ],
    rageClicks: [{ where: '/app span#planChip', count: 30, sessions: 12 }],
  };
  s.engagement = { players: 312, activeSeconds: 90000, activities: [{ name: 'build', seconds: 40000, players: 120, medianSecondsPerPlayer: 200 }, { name: 'drive', seconds: 9000, players: 80, medianSecondsPerPlayer: 60 }] };
  const lines = P.playersSection(s, NOW).join('\n');
  assert.match(lines, /What gets in the way: out_of_credits in 70 sessions \(13%; 57% left within 2 minutes\); server_error in 30 sessions/);
  assert.doesNotMatch(lines, /assistant_slow/, 'under the minimum sample');
  assert.match(lines, /Where their time goes: build 667 min in all \(120 players, a median 3 min each\)/);
  const work = P.playerWork(s);
  const w = (k: string) => work.find((x) => x.key === k);
  assert.equal(w('players:frustration:out_of_credits')?.kind, 'idea');
  assert.equal(w('players:frustration:server_error')?.kind, 'bug', 'the site failing them is a bug');
  assert.equal(w('players:frustration:assistant_slow'), undefined);
  assert.ok(work.some((x) => x.key.startsWith('players:rage:')));
  assert.equal(P.playerWork({ ...thin(), frustration: { sessions: 8, kinds: [{ kind: 'out_of_credits', sessions: 6, shareOfSessions: 0.75 }] } }).filter((x) => x.area === 'player frustration').length, 0, 'too few sessions');

  assert.equal(P.viewRoute({ product: 'hawkesgen', view: 'accounts', user: 'usr_0123456789abcdef' }).path, '/api/analytics/hawkesgen/accounts/usr_0123456789abcdef');
  assert.equal(P.viewRoute({ product: 'hawkesgen', view: 'frustration', user: 'usr_0123456789abcdef', range: '7d' }).path, '/api/analytics/hawkesgen/frustration?range=7d&user=usr_0123456789abcdef');
  const fr = P.compactView('frustration', s.frustration);
  assert.match(fr.sentences[0], /22% of 540 sessions hit something in their way; 40% of those left within 2 minutes/);
  assert.ok(fr.sentences.some((x: string) => /Rage clicks on \/app span#planChip: 30 in 12 sessions/.test(x)));
  const ac = P.compactView('accounts', { total: 1, identifiedSessions: 3, accounts: [{ user: 'usr_0123456789abcdef', sessions: 3, activeSeconds: 900, topActivities: [{ name: 'build', value: 600 }], frustrationKinds: [{ name: 'out_of_credits', value: 2 }], milestones: { signup: 1 } }] });
  assert.match(ac.sentences[1], /usr_0123456789abcdef: 3 sessions, 15 min active; time on build 10 min; got in the way: out_of_credits ×2; signup ×1\./);
});
