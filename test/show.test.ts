import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-show-'));
const show = await import('../src/show.ts');
const { decide, advanceLines, topRung, templateLines, factsOf, cleanLines, interleave, landedFor, workNotes, firstSentence, dwellFor, scriptKey, speakMs } = show;

const take = (job: string, product = 'yoobaland') => ({ job, phase: 'playing', product, productName: 'Yooba Land', scenario: 'fly', step: 'taking off', note: '', outcome: '', build: 'beta', stream: `/x/${job}`, replay: null, problems: 0, by: 'studio run', checks: '', landed: [] });
const work = (id: string) => ({ id, product: 'sickofit', productName: 'Sick Of It', title: 'Smoother rewinds', status: 'working', why: 'rewind stutters', notes: ['Reading the rewind code.'], tools: ['Read'], criteria: [], minutes: 4, size: '', still: null });
const road = (product: string) => ({ product, productName: product, milestone: 'Controls done', done: 1, total: 3, items: [{ title: 'Touch controls', state: 'planned', pct: 0.08 }], still: null });
const song = (asset: string) => ({ asset, kind: 'song' as const, product: 'sickofit', productName: 'Sick Of It', title: 'song', what: 'boss music', src: `/f/${asset}`, seconds: 90, cover: null });
const rungs = (o: Partial<Record<string, any[]>> = {}) => ({ playtest: [], work: [], roadmap: [], showcase: [], ...o }) as any;
const fresh = () => ({ seg: null, cursor: { playtest: 0, work: 0, roadmap: 0, showcase: 0 }, skip: 0, history: [] }) as any;
const seg = (kind: string, subject: string, now: number, o: any = {}) => ({ id: 's', kind, subject, started: now, until: now + 30_000, lines: [], at: -1, lineStarted: now, by: 'template', card: null, ...o });

test('the ladder: playtests, then work, then the roadmap, then the showcase', () => {
  assert.equal(topRung(rungs({ playtest: [take('j_1')], work: [work('c_1')] })), 'playtest');
  assert.equal(topRung(rungs({ work: [work('c_1')], roadmap: [road('a')] })), 'work');
  assert.equal(topRung(rungs({ roadmap: [road('a')], showcase: [song('a_1')] })), 'roadmap');
  assert.equal(topRung(rungs({ showcase: [song('a_1')] })), 'showcase');
  assert.equal(topRung(rungs()), 'showcase');
  // The director can hold a rung that has something on it.
  assert.equal(topRung(rungs({ playtest: [take('j_1')], roadmap: [road('a')] }), 'roadmap'), 'roadmap');
});

test('it moves between live takes in turn when a segment is up', () => {
  const now = 1_000_000;
  const r = rungs({ playtest: [take('j_a'), take('j_b'), take('j_c')] });
  const st = fresh();
  assert.equal(decide(st, r, now)!.card.job, 'j_a');
  st.seg = seg('playtest', 'j_a', now);
  assert.equal(decide(st, r, now + 1000), null, 'holds while its time runs');
  assert.equal(decide(st, r, now + 31_000)!.card.job, 'j_b');
  st.seg = seg('playtest', 'j_c', now);
  assert.equal(decide(st, r, now + 31_000)!.card.job, 'j_a', 'wraps round');
});

test('a playtest starting cuts into the showcase, but not mid-sentence', () => {
  const now = 2_000_000;
  const st = fresh();
  st.seg = seg('showcase', 'a_1', now, { lines: [{ text: 'hi', voice: null, ms: 3000 }], at: 0, lineStarted: now });
  const r = rungs({ playtest: [take('j_new')], showcase: [song('a_1')] });
  assert.equal(decide(st, r, now + 1000), null, 'Yooba finishes his sentence');
  const next = decide(st, r, now + 3500)!;
  assert.equal(next.kind, 'playtest');
  assert.equal(next.reason, 'cut-in');
});

test('a gone subject moves on; the director skips', () => {
  const now = 3_000_000;
  const st = fresh();
  st.seg = seg('work', 'c_gone', now);
  const r = rungs({ work: [work('c_1')] });
  assert.equal(decide(st, r, now + 100)!.reason, 'gone');
  st.seg = seg('work', 'c_1', now);
  assert.equal(decide(st, r, now + 100), null);
  assert.equal(decide(st, r, now + 100, { skip: 1 })!.reason, 'skip');
});

test('lines play one after another by their length', () => {
  const s: any = seg('roadmap', 'a', 0, { lines: [{ text: 'one', voice: null, ms: 1000 }, { text: 'two', voice: null, ms: 1000 }] });
  assert.equal(advanceLines(s, 10), true);
  assert.equal(s.at, 0);
  assert.equal(advanceLines(s, 900), false);
  assert.equal(advanceLines(s, 1800), true);
  assert.equal(s.at, 1);
  assert.equal(advanceLines(s, 9000), false, 'stays on the last line');
});

test('songs hold for their length (capped), pictures briefly', () => {
  assert.equal(dwellFor('showcase', song('a_1')), 75_000);
  assert.equal(dwellFor('showcase', { ...song('a_2'), seconds: 40 }), 40_000);
  assert.equal(dwellFor('showcase', { kind: 'image', seconds: 14 }), 14_000);
  assert.equal(dwellFor('playtest', take('j')), 45_000);
});

test('templates talk about what is on, and wrap a finished take', () => {
  const t = { ...take('j_1'), landed: [{ title: 'Skyport landing gear', note: '', ago: '2 hours ago' }] };
  const lines = templateLines('playtest', t);
  assert.match(lines[0], /Yooba Land/);
  assert.match(lines.join(' '), /Skyport landing gear/);
  assert.match(templateLines('playtest', t, { cutIn: true })[0], /^Oh! Hold on/);
  assert.deepEqual(templateLines('playtest', t, { wrap: 'it passed, no problems logged' }), ["And that run's done: it passed, no problems logged."]);
  assert.match(templateLines('showcase', song('a_1'))[0], /song the studio made for Sick Of It/);
  assert.match(templateLines('work', work('c_1'))[0], /Smoother rewinds/);
});

test('facts for Claude carry no paths or keys', () => {
  const t = { ...take('j_1'), note: 'reading C:\\Projects\\secret.pem with sk-abc123456789', landed: [{ title: 'Fix /srv/hawkes/x', note: 'token=abc', ago: 'now' }] };
  const f = factsOf('playtest', t, { others: 2 });
  assert.match(f, /live playtest of Yooba Land/);
  assert.match(f, /2 other playtests are running/);
  assert.doesNotMatch(f, /secret\.pem|sk-abc|\/srv\/|token=/);
});

test("Claude's lines are scrubbed and capped", () => {
  assert.deepEqual(cleanLines(['/home/ubuntu/a', 'ok']), [], 'a path alone or a two-letter line is dropped');
  const out = cleanLines(['Yooba here! Look at https://x.y/z?k=1 this', 'Second line.', 'Third.', 'Fourth.']);
  assert.equal(out.length, 3);
  assert.equal(out[0], 'Look at this');
  assert.deepEqual(cleanLines('nope'), []);
});

test('the showcase takes turns: clips, art, songs, products mixed', () => {
  const items = [
    ...['a', 'b', 'c'].map((x) => ({ ...song(`a_s${x}`), product: x })),
    ...['a', 'a', 'b'].map((x, i) => ({ asset: `a_i${i}`, kind: 'image' as const, product: x, productName: x, title: '', what: 'art', src: '', seconds: 14, cover: null })),
    { asset: 'a_v1', kind: 'video' as const, product: '', productName: 'x', title: '', what: '', src: '', seconds: 12, cover: null },
  ];
  const out = interleave(items);
  assert.equal(out.length, items.length);
  assert.deepEqual(out.slice(0, 3).map((i) => i.kind), ['video', 'image', 'song']);
  const imgs = out.filter((i) => i.kind === 'image').map((i) => i.product);
  assert.deepEqual(imgs.slice(0, 2), ['a', 'b'], 'products alternate');
});

test('what landed in a product: merged in the last three days, newest first', () => {
  const now = 10 * 86_400_000;
  const changes = [
    { product: 'yoobaland', status: 'merged', title: 'Old', merged_at: now - 5 * 86_400_000, summary: '' },
    { product: 'yoobaland', status: 'merged', title: 'Plane lands', merged_at: now - 3600_000, summary: '# Title\n\nThe plane now lands on any flat ground. More text.' },
    { product: 'yoobaland', status: 'working', title: 'WIP', updated: now },
    { product: 'sickofit', status: 'merged', title: 'Other game', merged_at: now },
  ];
  const l = landedFor(changes, 'yoobaland', now);
  assert.deepEqual(l.map((x) => x.title), ['Plane lands']);
  assert.equal(l[0].note, 'The plane now lands on any flat ground.');
  assert.equal(l[0].ago, '1 hour ago');
});

test("an agent's notes and tools come from its log", () => {
  const { notes, tools } = workNotes([
    '01:00:00 agent started',
    '01:00:01 agent: Looking at the brief.',
    '01:00:02 tool: Read {"path":"/srv/hawkes/x"}',
    '01:00:03 agent: reattached to hawkes-agent-c after a Studio restart',
    '01:00:04 agent: Rewind now keeps 600 frames.',
    '01:00:05 tool: Edit {"path":"/srv/hawkes/y"}',
  ]);
  assert.deepEqual(notes, ['Looking at the brief.', 'Rewind now keeps 600 frames.']);
  assert.deepEqual(tools, ['Read', 'Edit']);
});

test('first sentence of a summary skips headings and code', () => {
  assert.equal(firstSentence('# Big title\n\n```js\nx\n```\nThe **rewind** now runs smoothly, even deep in. Then more.'), 'The rewind now runs smoothly, even deep in.');
});

test('script keys change when what Yooba would say changes', () => {
  const a = scriptKey('playtest', take('j_1'));
  assert.equal(a, scriptKey('playtest', take('j_1')));
  assert.notEqual(a, scriptKey('playtest', { ...take('j_1'), step: 'landing' }));
  assert.ok(speakMs('a'.repeat(140)) >= 10_000);
});

test("the director's ladder: its order, rungs left off, the showcase's kinds, segment lengths", () => {
  const r = rungs({ playtest: [take('j_1')], work: [work('c_1')], roadmap: [road('a')], showcase: [song('a_1'), { ...song('a_2'), kind: 'image' }] });
  // Roadmap first, playtests off: the take never goes on, the roadmap leads.
  const order = ['roadmap', 'work', 'showcase'] as any;
  const d = show.directed(r, { ladder: order, showcaseKinds: ['image'] });
  assert.equal(d.playtest.length, 0);
  assert.deepEqual(d.showcase.map((i: any) => i.asset), ['a_2']);
  assert.equal(topRung(d, null, order), 'roadmap');
  assert.equal(topRung(show.directed(r, { ladder: [] }), null, []), 'showcase');
  // A rung higher in the director's order cuts in on a lower one.
  const now = 5_000_000;
  const st = { ...fresh(), seg: seg('work', 'c_1', now - 1_000, { card: work('c_1') }) };
  const next = decide(st, d, now, { order });
  assert.equal(next?.kind, 'roadmap');
  assert.equal(next?.reason, 'cut-in');
  assert.equal(dwellFor('roadmap', road('a'), { roadmap: 90 }), 90_000);
  assert.equal(dwellFor('roadmap', road('a'), {}), 28_000);
  // A song still holds for its own length.
  assert.equal(dwellFor('showcase', song('a_1'), { showcase: 5 }), 75_000);
});

test('saved wordings take turns once there are enough, so a repeat costs no new line or voice', () => {
  const map = new Map();
  assert.equal(show.takeScript('roadmap:a', 2, map), null);
  show.keepScript('roadmap:a', ['One.'], 2, map);
  assert.equal(show.takeScript('roadmap:a', 2, map), null, 'one wording of two: write another');
  show.keepScript('roadmap:a', ['Two.'], 2, map);
  const said = [show.takeScript('roadmap:a', 2, map), show.takeScript('roadmap:a', 2, map), show.takeScript('roadmap:a', 2, map)];
  assert.deepEqual(said, [['One.'], ['Two.'], ['One.']]);
  // Variety 1: always the same line.
  assert.deepEqual(show.takeScript('roadmap:a', 1, map), ['One.']);
  // Past the cap the oldest goes.
  show.keepScript('roadmap:b', ['A.'], 2, map);
  show.keepScript('roadmap:b', ['B.'], 2, map);
  show.keepScript('roadmap:b', ['C.'], 2, map);
  assert.deepEqual(map.get('roadmap:b').variants, [['B.'], ['C.']]);
});

test('the roadmap card is the real board: the open milestone, its items first, real task counts, public states only', () => {
  const now = 10 * 24 * 3600_000;
  const task = (title: string, status: string, merged_at: number | null = null) => ({ title, status, merged_at });
  const items = [
    { id: 'i_other', product: 'sickofit', title: 'Leaderboard', status: 'planned', priority: 'high', ord: 1, why: 'Players asked for it. More text.', progress: { state: 'planned', merged: 0, total: 0 }, tasks: [] },
    { id: 'i_ms', product: 'sickofit', title: 'Touch controls', status: 'planned', priority: 'normal', ord: 2, progress: { state: 'working', merged: 1, total: 4 }, tasks: [task('Joystick', 'merged', now - 3600_000), task('Jump button', 'working'), task('A', 'planned'), task('B', 'planned')] },
    { id: 'i_gpu', product: 'sickofit', title: 'Boss art', status: 'planned', priority: 'normal', ord: 3, progress: { state: 'waiting for your GPU budget', merged: 0, total: 1 }, tasks: [task('Paint', 'planned')] },
    { id: 'i_idea', product: 'sickofit', title: 'Pets', status: 'idea', priority: 'normal', ord: 4, progress: { state: 'idea', merged: 0, total: 0 }, tasks: [] },
    { id: 'i_live', product: 'sickofit', title: 'Shipped thing', status: 'planned', priority: 'normal', ord: 0, progress: { state: 'live', merged: 2, total: 2 }, tasks: [] },
  ];
  const milestones = [
    { id: 'm_done', product: 'sickofit', title: 'Old one', status: 'reached', done: 3, total: 3, items: [] },
    { id: 'm_open', product: 'sickofit', title: 'Phone ready', goal: 'Play the whole game on a phone. Then more.', status: 'open', done: 0, total: 1, items: [{ id: 'i_ms' }] },
  ];
  const [card] = show.roadCards(items, milestones, new Map(), now);
  assert.equal(card.milestone, 'Phone ready');
  assert.equal(card.goal, 'Play the whole game on a phone.');
  assert.deepEqual(card.items.map((i: any) => i.title), ['Touch controls', 'Boss art', 'Leaderboard'], 'milestone first, live and ideas left off');
  const touch = card.items[0];
  assert.equal(touch.state, 'in progress');
  assert.equal(touch.tasks, '1 of 4 tasks done');
  assert.equal(touch.pct, 0.25);
  assert.equal(touch.now, 'Jump button');
  assert.equal(card.items[1].state, 'making the art', 'no "waiting for your GPU budget" on air');
  assert.equal(card.items[2].pct, 0, 'no placeholder progress');
  assert.equal(card.items[2].why, 'Players asked for it.');
  assert.deepEqual(card.recent.map((r: any) => r.title), ['Joystick']);
  const facts = factsOf('roadmap', card);
  assert.match(facts, /working on "Jump button" right now/);
  assert.match(facts, /Do not invent/);
  assert.match(templateLines('roadmap', card).join(' '), /Jump button/);
});
