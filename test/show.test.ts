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
