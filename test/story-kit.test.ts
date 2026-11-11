import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// @ts-ignore: plain JS
import { createStoryKit, meets, pickBark, MIN_COOLDOWN_S } from '../clients/web/hawkes-story.js';
import { storyEventsOf, storyMetricsFromEvents, enrichStory, storyFindings } from '../src/story.ts';
import { graphFromJson, graphFromTree, analyzeStory, storyMapFindings, storyMap } from '../src/storymap.ts';

const BEATS = {
  version: 1, story: 'demo',
  barks: [
    { id: 'hurt-low', trigger: 'hurt', text: 'Ow.', voice: 'a.mp3', priority: 5, requires: [{ fact: 'hp', lt: 30 }] },
    { id: 'hurt-any', trigger: 'hurt', text: 'Ouch.', voice: 'b.mp3', priority: 1 },
    { id: 'later', trigger: 'hurt', text: 'Still hurts.', voice: 'c.mp3', priority: 9, requires: [{ seen: 'hurt-any' }] },
    { id: 'quiet-word', trigger: 'idle', text: 'Hm.', priority: 1 },
  ],
  cutscenes: [{ id: 'wake', lines: [{ text: 'Wake up.', voice: 'w.mp3', dur: 2 }, { text: 'Rat.', dur: 2 }], next: 'p1' }],
  pages: [{ id: 'p1', text: 'x', choices: [{ to: 'a' }, { to: 'b' }], timeout: { sec: 5, to: 'a' } }],
};

function kit(clock: { t: number }, pushed: any[]) {
  const spoken: string[] = [];
  const win: any = { __hawkesPlaytestPush: (m: any) => pushed.push(m) };
  const sound = { speak: async (n: string) => { spoken.push(n); return { sample: n, duckDb: 9 }; } };
  const k = createStoryKit({ win, doc: null, sound, now: () => clock.t, wait: async () => {} });
  k.load(BEATS);
  return { k, spoken };
}

test('requirements: facts, seen and any/not', () => {
  const mem = { count: (id: string) => (id === 'x' ? 1 : 0) };
  assert.ok(meets([{ fact: 'hp', lt: 30 }], { hp: 10 }, mem));
  assert.ok(!meets([{ fact: 'hp', lt: 30 }], { hp: 40 }, mem));
  assert.ok(meets({ seen: 'x' }, {}, mem) && !meets({ seen: 'y' }, {}, mem) && meets({ notSeen: 'y' }, {}, mem));
  assert.ok(meets({ any: [{ flag: 'a' }, { flag: 'b' }] }, { b: 1 }, mem) && !meets({ not: { flag: 'a' } }, { a: 1 }, mem));
});

test('barks: priority, cooldown and memory; the same bark never plays twice inside 5 minutes', async () => {
  const clock = { t: 100 }; const pushed: any[] = [];
  const { k, spoken } = kit(clock, pushed);
  k.setFact('hp', 80);
  assert.equal((await k.bark('hurt'))?.id, 'hurt-any');                 // hp not low: the low bark's requirement fails
  assert.equal((await k.bark('hurt'))?.id, 'later');                    // memory: 'later' needs hurt-any seen, priority 9
  k.setFact('hp', 10);
  assert.equal((await k.bark('hurt'))?.id, 'hurt-low');                 // now eligible, the others cool down
  assert.equal(await k.bark('hurt'), null, 'all three cooling down: nothing plays');
  clock.t += MIN_COOLDOWN_S - 1;
  assert.equal(await k.bark('hurt'), null);
  clock.t += 2;
  assert.ok(await k.bark('hurt'), 'back after the cooldown');
  assert.ok(spoken.length >= 4);
  const beats = pushed.filter((m) => m.type === 'story-beat');
  assert.ok(beats.every((b) => b.voiced && !b.textOnly));
  assert.ok(pushed.some((m) => m.type === 'story-kit'));
});

test('a bark with no voice and no scene is a text-only beat', async () => {
  const clock = { t: 0 }; const pushed: any[] = [];
  const { k } = kit(clock, pushed);
  await k.bark('idle');
  assert.equal(pushed.find((m) => m.id === 'quiet-word').textOnly, true);
});

test('cutscene: voiced lines, reported start and end', async () => {
  const clock = { t: 0 }; const pushed: any[] = [];
  const { k, spoken } = kit(clock, pushed);
  const r = await k.cutscene('wake');
  assert.equal(r.skipped, false);
  assert.equal(r.next, 'p1');
  assert.deepEqual(spoken, ['wake-1']);
  assert.ok(pushed.some((m) => m.type === 'story-cutscene' && m.state === 'start'));
  assert.ok(pushed.some((m) => m.type === 'story-beat' && m.kind === 'cutscene' && m.voiced && m.acted));
});

test('metrics: measured textOnlyBeats and maxQuietSeconds replace "unmeasured"; bark repeats and phone rects are findings', () => {
  const ev = (type: string, t: number, d: any = {}) => ({ type, t, detail: JSON.stringify({ type, t, ...d }) });
  const result = {
    seconds: 40,
    events: [
      ev('story-kit', 0),
      ev('story-beat', 5, { id: 'hurt-any', kind: 'bark', voiced: true, acted: false, textOnly: false }),
      ev('story-beat', 8, { id: 'quiet-word', kind: 'bark', voiced: false, acted: false, textOnly: true }),
      ev('story-beat', 20, { id: 'hurt-any', kind: 'bark', voiced: true, textOnly: false }),
      ev('story-cutscene', 22, { id: 'wake', state: 'start', viewport: { w: 390, h: 844 }, safe: { top: 47, right: 0, bottom: 34, left: 0 }, skipRect: { x: 300, y: 10, w: 48, h: 48 }, captionRect: { x: 12, y: 600, w: 366, h: 80 } }),
    ],
  };
  const out = enrichStory(result);
  assert.equal(out.metrics['quality.textOnlyBeats'], 1);
  assert.equal(out.metrics['quality.maxQuietSeconds'], 18); // 22 -> 40
  assert.equal(out.metrics['story.barkRepeats5m'], 1);
  assert.equal(out.metrics['story.skipTooSmall'], 0);
  assert.equal(out.metrics['story.outsideSafeArea'], 1, 'the skip button sits at y=10, above the notch inset of 47');
  const f = storyFindings(out, { scenario: 'story' });
  assert.ok(f.some((x) => /Text-only story beat: quiet-word/.test(x.title)));
  assert.ok(f.some((x) => /Bark repeated within 5 minutes: hurt-any/.test(x.title)));
  assert.ok(f.some((x) => /outside the safe area/.test(x.title)));
  assert.ok(f.some((x) => /Quiet stretch/.test(x.title)));
  assert.equal(storyMetricsFromEvents(storyEventsOf({ events: [{ type: 'sound-start', t: 1 }] })), null, 'no kit, nothing measured');
});

test('story map: endings, real-choice share, rejoining forks and timeout-to-death, each naming its page', () => {
  const g = graphFromJson({
    story: 'spark', start: 'wake',
    pages: [
      { id: 'wake', choices: [{ to: 'rat' }, { to: 'run' }], timeout: { sec: 8, to: 'drown' } },
      { id: 'rat', choices: [{ to: 'tunnel' }] },
      { id: 'run', choices: [{ to: 'tunnel' }] },
      { id: 'tunnel', choices: [{ to: 'light' }, { to: 'dark' }] },
      { id: 'light', ending: 'The Spark' }, { id: 'dark', ending: 'Lost' }, { id: 'drown', ending: 'death by drowning' },
    ],
  }, 'beats.json')!;
  const rep = analyzeStory(g);
  assert.equal(rep.endings, 3);
  assert.equal(rep.choicePages, 4);
  assert.equal(rep.realChoicePages, 2);
  assert.equal(rep.realChoiceShare, 0.5);
  assert.deepEqual(rep.rejoins.map((r) => [r.page, r.at]), [['wake', 'tunnel']]);
  assert.deepEqual(rep.timeoutDeaths, [{ page: 'wake', to: 'drown' }]);
  const f = storyMapFindings(rep);
  assert.ok(f.some((x) => /page "wake".*defaults to a death/.test(x.title)));
  assert.ok(f.some((x) => /fork "wake" rejoins/.test(x.title)));
});

test('story map reads an indented decision tree and links', () => {
  const g = graphFromTree(['Wake in the sewer', '  Follow the rat', '    Tunnel', '      ENDING: The Spark', '  Climb the ladder', '    Roof', '      -> Tunnel', '  [timeout] Drown', '    DEATH'].join('\n'), 'Decision tree.txt')!;
  const rep = analyzeStory(g);
  assert.ok(rep.endings >= 2);
  assert.equal(rep.timeoutDeaths.length, 1);
  assert.equal(rep.timeoutDeaths[0].page, 'Wake in the sewer');
  assert.ok(rep.realChoiceShare > 0);
});

test('storyMap reads beats.json and the tree from a repo folder, on any build', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storymap-'));
  try {
    fs.mkdirSync(path.join(dir, 'TheFinalSpark'));
    fs.writeFileSync(path.join(dir, 'beats.json'), JSON.stringify(BEATS));
    fs.writeFileSync(path.join(dir, 'TheFinalSpark', 'Decision tree.txt'), 'Start\n  A\n    END\n  B\n    END\n');
    const r = storyMap(dir);
    assert.equal(r.stories.length, 2);
    assert.equal(r.stories.find((s) => s.report.file.endsWith(".txt"))!.report.endings, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
