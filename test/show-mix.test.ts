// On Air, J 2026-10-20: the shuffle (every rung gets its turn), quieter hosts, hosts taking turns, lore from the canon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-show-mix-'));
const show = await import('../src/show.ts');
const { decide, factsOf, cleanLines } = show;
const { HOSTS, hostById } = await import('../src/hosts.ts');

const take = (job: string, product = 'yoobaland') => ({ job, phase: 'playing', product, productName: 'Yooba Land', scenario: 'fly', step: 'taking off', note: '', outcome: '', build: 'beta', stream: `/x/${job}`, replay: null, problems: 0, by: 'studio run', checks: '', landed: [] });
const work = (id: string) => ({ id, product: 'sickofit', productName: 'Sick Of It', title: 'Smoother rewinds', status: 'working', why: 'rewind stutters', notes: ['Reading the rewind code.'], tools: ['Read'], criteria: [], minutes: 4, size: '', still: null });
const road = (product: string) => ({ product, productName: product, milestone: 'Controls done', done: 1, total: 3, items: [{ title: 'Touch controls', state: 'planned', pct: 0.08 }], still: null });
const song = (asset: string) => ({ asset, kind: 'song' as const, product: 'sickofit', productName: 'Sick Of It', title: 'song', what: 'boss music', src: `/f/${asset}`, seconds: 90, cover: null });
const lore = (id: string, product = 'yoobaland') => ({ id, product, productName: 'Yooba Land', title: 'The Yooba day', body: 'The whole world keeps one 24-minute clock.', related: ['Wandering Yoobas'], still: null });
const rungs = (o: Partial<Record<string, any[]>> = {}) => ({ playtest: [], work: [], roadmap: [], showcase: [], lore: [], ...o }) as any;
const fresh = () => ({ seg: null, cursor: { playtest: 0, work: 0, roadmap: 0, showcase: 0, lore: 0 }, skip: 0, history: [] }) as any;
const seg = (kind: string, subject: string, now: number, o: any = {}) => ({ id: 's', kind, subject, started: now, until: now + 30_000, lines: [], at: -1, lineStarted: now, by: 'template', card: null, host: 'yooba', ...o });

test('the shuffle reaches every rung that is on, not just the top one', () => {
  const r = rungs({ work: [work('c_1')], roadmap: [road('a')], showcase: [song('a_1')], lore: [lore('m_1')] });
  const seen = new Set<string>();
  const st = { history: [] as string[] };
  for (let i = 0; i < 400; i++) {
    const k = show.shuffleRung(st, r, show.LADDER, {}, Math.random);
    seen.add(k);
    st.history = [...st.history.slice(-5), `${k}:x`];
  }
  assert.deepEqual([...seen].sort(), ['lore', 'roadmap', 'showcase', 'work']);
  // Weight 0 never comes up; an empty rung never comes up.
  for (let i = 0; i < 50; i++) assert.notEqual(show.shuffleRung({ history: [] }, r, show.LADDER, { showcase: 0 }, Math.random), 'showcase');
  assert.equal(show.shuffleRung({ history: [] }, rungs({ roadmap: [road('a')] }), show.LADDER, {}, () => 0.99), 'roadmap');
  // The rung just shown counts a third: with equal weights and a roll in the middle, the other one wins.
  const two = rungs({ work: [work('c_1')], showcase: [song('a_1')] });
  assert.equal(show.shuffleRung({ history: ['work:c_1'] }, two, show.LADDER, { work: 5, showcase: 5 }, () => 0.5), 'showcase');
});

test('under the shuffle only a new playtest cuts in, and the shuffle picks again when time is up', () => {
  const now = 5_000_000;
  const st = fresh();
  st.seenTakes = [];
  st.seg = seg('showcase', 'a_1', now);
  const r2 = rungs({ playtest: [take('j_new')], showcase: [song('a_1')], roadmap: [road('a')] });
  const cut = decide(st, r2, now + 200, { mix: 'shuffle' })!;
  assert.equal(cut.reason, 'cut-in');
  assert.equal(cut.card.job, 'j_new');
  // Seen now: a later showcase segment isn't interrupted by the same take.
  st.seg = seg('showcase', 'a_1', now + 300);
  assert.equal(decide(st, r2, now + 400, { mix: 'shuffle' }), null);
  // Cut-in off: never.
  const st2 = fresh();
  st2.seenTakes = [];
  st2.seg = seg('roadmap', 'a', now);
  assert.equal(decide(st2, r2, now + 100, { mix: 'shuffle', cutIn: false }), null);
  // Time's up: the roll picks the rung (0.99 lands on the last rung with weight in the order).
  const st3 = fresh();
  st3.seenTakes = ['j_new'];
  st3.seg = seg('roadmap', 'a', now);
  const next = decide(st3, r2, now + 31_000, { mix: 'shuffle', rng: () => 0.99 })!;
  assert.equal(next.reason, 'next');
  assert.equal(next.kind, 'showcase');
  // Coming back to a rung from another one moves on to its next subject (it showed the same lore card every time).
  const st6 = fresh();
  const r6 = rungs({ showcase: [song('a_1')], lore: [lore('m_1'), lore('m_2'), lore('m_3')] });
  const shown: string[] = [];
  let t = now;
  st6.seg = seg('showcase', 'a_1', t);
  for (let n = 0; n < 4; n++) {
    t += 31_000;
    const l = decide(st6, r6, t, { mix: 'shuffle', weights: { showcase: 0 } })!;
    shown.push(l.card.id);
    st6.seg = seg('showcase', 'a_1', t); // a showcase segment in between
  }
  assert.deepEqual(shown, ['m_2', 'm_3', 'm_1', 'm_2']);
  // Playtests held with none running (left on after "Start playtest"): the shuffle still runs, not the ladder's top.
  const st5 = fresh();
  st5.seg = seg('showcase', 'a_1', now);
  const r5 = rungs({ showcase: [song('a_1')], lore: [lore('m_1')] });
  assert.equal(decide(st5, r5, now + 31_000, { mix: 'shuffle', hold: 'playtest', rng: () => 0.99 })!.kind, 'lore');
  // A held rung with something on it holds.
  assert.equal(decide(fresh(), rungs({ playtest: [take('j_1')], lore: [lore('m_1')] }), now, { mix: 'shuffle', hold: 'playtest', rng: () => 0.99 })!.kind, 'playtest');
  // The ladder (the old way) still holds the top rung.
  const st4 = fresh();
  st4.seg = seg('roadmap', 'a', now);
  assert.equal(decide(st4, rungs({ work: [work('c_1')], roadmap: [road('a')] }), now + 100)!.kind, 'work');
});

test('the host talks only at the moments that are on, after the gap, on a share of segments', () => {
  const t = { moments: { playtest: true, wrap: true, cutIn: true, work: false, roadmap: false, showcase: false, lore: true, handoff: true }, gapSec: 90, chance: 50, maxLines: 2 };
  const now = 10_000_000;
  assert.equal(show.talkNow(t, 'roadmap', 0, now, 0), false, 'moment off');
  assert.equal(show.talkNow(t, 'lore', 0, now, 0.2), true);
  assert.equal(show.talkNow(t, 'lore', 0, now, 0.8), false, 'over the chance');
  assert.equal(show.talkNow(t, 'lore', now - 30_000, now, 0), false, 'inside the gap');
  assert.equal(show.talkNow(t, 'lore', now - 120_000, now, 0), true);
  assert.equal(show.talkNow(t, 'handoff', now - 1000, now, 0.99), true, 'a new host always says hello');
  assert.equal(show.momentOf('playtest', { wrap: 'it passed' }), 'wrap');
  assert.equal(show.momentOf('work', { cutIn: true }), 'cutIn');
  assert.equal(show.momentOf('lore', {}), 'lore');
});

test('hosts take turns every rotateMin minutes; a pinned host holds; the newcomer says hello', () => {
  const st = fresh();
  const now = 20_000_000;
  const desk = { hosts: ['yooba', 'orchestrator'], host: '', rotateMin: 15 };
  assert.equal(show.nextHost(st, desk, now), 'yooba');
  assert.equal(st.handoffFrom, undefined, 'the first host just starts');
  assert.equal(show.nextHost(st, desk, now + 60_000), 'yooba');
  assert.equal(show.nextHost(st, desk, now + 16 * 60_000), 'orchestrator');
  assert.equal(st.handoffFrom, 'yooba');
  assert.equal(show.nextHost(st, { ...desk, host: 'shutup-bot' }, now + 17 * 60_000), 'shutup-bot');
  assert.equal(show.nextHost(st, { ...desk, rotateMin: 0 }, now + 99 * 60_000), 'yooba', 'a host off the roster hands back to its first');
  assert.equal(show.nextHost(st, { ...desk, rotateMin: 0 }, now + 199 * 60_000), 'yooba', 'rotation off');
});

test('every host has a voice, a portrait in the dashboard and a persona', () => {
  for (const h of HOSTS) {
    assert.match(h.voice, /^[A-Za-z0-9]{20}$/, h.id);
    assert.ok(fs.existsSync(path.join('dashboard', h.image)), `${h.id}: ${h.image}`);
    assert.ok(h.persona.length > 40, h.id);
  }
  assert.equal(hostById('nobody').id, 'yooba');
});

test('lore comes from the canon: cleaned for air, products taking turns, tied to the work going on', () => {
  const book = show.loreBook(() => [
    { id: 'm_1', product: 'yoobaland', title: 'The Yooba day', body: 'J (q_eed56570a771, 2026-10-19): the whole world keeps one clock (YoobaLand/Docs/World.md), a 24-minute day.' },
    { id: 'm_2', product: 'yoobaland', title: 'Background Yoobas', body: 'They wander, sit, eat and chat, and they are never enemies.' },
    { id: 'm_3', product: 'sickofit', title: 'Slimes are villagers', body: 'Slimes are villagers, never enemies. Fighter id slime is not a thing.' },
    { id: 'm_4', product: 'sickofit', title: 'x', body: 'short' },
  ]);
  assert.equal(book.length, 3, 'too short to say is dropped');
  const day = book.find((e) => e.id === 'm_1')!;
  assert.doesNotMatch(day.body, /q_|World\.md|J \(/);
  const cards = show.loreCards(book, [work('c_1')], [], new Map());
  assert.deepEqual(cards.map((c) => c.product), ['yoobaland', 'sickofit', 'yoobaland']);
  assert.deepEqual(cards[1].related, ['Smoother rewinds']);
  const facts = factsOf('lore', cards[1]);
  assert.match(facts, /Slimes are villagers/);
  assert.match(facts, /Smoother rewinds/);
  assert.deepEqual(show.loreHints(book, 'yoobaland', 'Yoobas wander the village', 1), ['Background Yoobas: They wander, sit, eat and chat, and they are never enemies.']);
  assert.match(factsOf('work', work('c_1'), { lore: ['Slimes are villagers'], said: ['Hi chat'] }), /Lore of this game[\s\S]*You said recently: "Hi chat"/);
  assert.match(factsOf('roadmap', road('a'), { handoff: 'Yooba' }), /taking over the show from Yooba/);
  show.resetShow();
});

test('the desk keeps the talk, mix and host settings; an older desk gains the lore rung once', async () => {
  const { deskFrom, patchDesk, TALK_DEFAULT } = await import('../src/broadcast.ts');
  const P = ['yoobaland', 'sickofit'];
  const d = deskFrom({}, P);
  assert.equal(d.mix, 'shuffle');
  assert.equal(d.talk.moments.roadmap, false, 'quieter by default');
  assert.equal(d.talk.gapSec, TALK_DEFAULT.gapSec);
  const n = patchDesk(d, { talk: { moments: { roadmap: true }, gapSec: 300, chance: 25, maxLines: 1 }, weights: { lore: 9, showcase: 0 }, hosts: ['orchestrator', 'nobody'], host: 'shutup-bot', rotateMin: 30, mix: 'ladder', cutIn: false }, P);
  assert.equal(n.talk.moments.roadmap, true);
  assert.equal(n.talk.moments.lore, true, 'the other moments stay');
  assert.deepEqual([n.talk.gapSec, n.talk.chance, n.talk.maxLines], [300, 25, 1]);
  assert.deepEqual([n.weights.lore, n.weights.showcase, n.weights.work], [9, 0, 2]);
  assert.deepEqual(n.hosts, ['orchestrator']);
  assert.deepEqual([n.host, n.rotateMin, n.mix, n.cutIn], ['shutup-bot', 30, 'ladder', false]);
  assert.deepEqual(deskFrom(JSON.parse(JSON.stringify(n)), P).talk, n.talk, 'stored and read back');
  assert.throws(() => patchDesk(d, { host: 'nobody' }, P), /host/);
  assert.throws(() => patchDesk(d, { mix: 'random' }, P), /mix/);
  // A desk stored before lore existed: lore turns on once at the end; one J turned off later stays off.
  assert.deepEqual(deskFrom({ ladder: ['roadmap', 'showcase'] }, P).ladder, ['roadmap', 'showcase', 'lore']);
  assert.deepEqual(deskFrom({ ladder: ['roadmap'], rungsSeen: ['playtest', 'work', 'roadmap', 'showcase', 'lore'] }, P).ladder, ['roadmap']);
});

test("the host prompt asks for talk, not a reading, in the host's own persona and line count", () => {
  const sys = show.hostSystem(hostById('shutup-bot'), 1);
  assert.match(sys, /Shutup Bot/);
  assert.match(sys, /never read the screen out/i);
  assert.match(sys, /one short spoken line/);
  assert.equal(cleanLines(['a line', 'two lines', 'three lines'], 1).length, 1);
});
