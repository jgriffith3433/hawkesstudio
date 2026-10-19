// Memory curation's contradiction cards (memory-curate.ts) on a scratch database: one question per contradicting pair
// whichever side curation sees first, both sides named by who wrote them ("J's decision" only when it is his), options
// that name the entries, and the card settled when a side is deleted, faded or settled, or its twin was answered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-contradiction-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.TALK_CLAUDE = 'no-such-claude-here';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'notify.json'), JSON.stringify({ enabled: false, topic: 'test-off' }));
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'mctest', name: 'Contradiction test', framing: 'test', engine: 'static', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: 'site', port: 8795, path: '/' }, playtests: [], story: [], about: 'A fixture.',
}] }));

const { db } = await import('../src/db.ts');
await import('../src/talk.ts');
const rm = await import('../src/roadmap.ts');
const mem = await import('../src/memory.ts');
const mc = await import('../src/memory-curate.ts');
const ib = await import('../src/inbox.ts');
const pm = await import('../src/pm.ts');
db.exec("CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, session TEXT, status TEXT NOT NULL DEFAULT 'idle', messages TEXT NOT NULL DEFAULT '[]', cost REAL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER, kind TEXT)");

const STUDIO = { who: 'studio', name: 'Studio (curation)' } as const;
const canon = (title: string, change: string, pr: number) => {
  const m = mem.writeMemory({ kind: 'canon', title, product: 'mctest', source: `https://github.com/x/y/pull/${pr}` }, { who: 'agent', id: change }).memory;
  return mem.updateMemory(m.id, { status: 'disputed' }, STUDIO);
};
const open = () => rm.listQuestions().filter((q) => q.topic?.startsWith('memory-contradiction:'));

test('authors: J only when it is his; agents by change and pull request', () => {
  assert.equal(mc.authorOf({ by: 'J', kind: 'decision', source: null }), "J's decision");
  assert.equal(mc.authorOf({ by: 'agent c_0123456789ab', kind: 'canon', source: 'https://github.com/x/y/pull/42' }), 'agent c_0123456789ab (PR #42)');
  assert.equal(mc.authorOf({ by: 'agent c_0123456789ab', kind: 'canon', source: 'c_0123456789ab' }), 'agent c_0123456789ab');
  assert.equal(mc.authorOf({ by: 'seed', kind: 'canon', source: 'story.md' }), 'the seed (story.md)');
});

test('one question per pair, whichever side comes first; options name the entries; no "Yours" for an agent', async () => {
  const a = canon('Whistle Brook and Bramble Brook', 'c_aaaaaaaaaaaa', 11);
  const b = canon('Mistbrook and Bramble Brook', 'c_bbbbbbbbbbbb', 12);
  const q = await mc.askContradiction(a, b);
  assert.ok(q, 'asked');
  assert.equal(await mc.askContradiction(b, a), null, 'the swapped pair is the same question');
  assert.equal(await mc.askContradiction(a, b), null, 'asked again: still one');
  assert.equal(open().length, 1);
  assert.deepEqual(q.options, ['Keep: Mistbrook and Bramble Brook', 'Keep: Whistle Brook and Bramble Brook']);
  assert.match(q.text, /agent c_bbbbbbbbbbbb \(PR #12\) \(m_/);
  assert.match(q.text, /agent c_aaaaaaaaaaaa \(PR #11\) \(m_/);
  assert.doesNotMatch(q.text, /Yours|your decisions/);
  assert.equal(q.topic, mc.pairTopic(b.id, a.id));
});

test('a J decision is named as his', async () => {
  const d = mem.writeMemory({ kind: 'decision', title: 'Reviews stay on Sonnet' }, { who: 'J' }).memory;
  const n = canon('Reviews run on Opus', 'c_cccccccccccc', 13);
  const q = await mc.askContradiction(n, d);
  assert.match(q.text, /one of your decisions/);
  assert.match(q.text, /J's decision \(m_/);
  rm.setQuestion(q.id, { status: 'answered', answer: 'Keep: Reviews stay on Sonnet', answered_by: 'J' });
});

test('a card settles when a side is deleted, faded or settled, or its twin was answered', async () => {
  let n = 0;
  const hills = ['Lantern', 'Copper', 'Willow', 'Thistle'];
  const pair = () => { const h = hills[n++]; return [canon(`${h} Hill is north of the river`, 'c_dddddddddddd', 14), canon(`${h} Hill is south of the river`, 'c_eeeeeeeeeeee', 15)]; };
  const tidy = () => ib.inbox();

  let [a, b] = pair();
  let q = await mc.askContradiction(a, b);
  mem.deleteMemory(a.id, { who: 'J' });
  await tidy();
  assert.equal(rm.getQuestion(q.id)!.status, 'resolved');
  assert.match(rm.getQuestion(q.id)!.answer!, /was deleted/);

  [a, b] = pair();
  q = await mc.askContradiction(a, b);
  mem.updateMemory(b.id, { status: 'faded' }, STUDIO);
  await tidy();
  assert.match(rm.getQuestion(q.id)!.answer!, /faded/);

  [a, b] = pair();
  q = await mc.askContradiction(a, b);
  mem.updateMemory(a.id, { status: 'active' }, { who: 'J' });
  mem.updateMemory(b.id, { status: 'candidate' }, { who: 'J' });
  await tidy();
  assert.match(rm.getQuestion(q.id)!.answer!, /neither entry is disputed/);

  // Twins filed before the pair dedupe (no topic, ids in the text, the two swapped): answering one settles the other.
  [a, b] = pair();
  const legacy = (x: typeof a, y: typeof a) => pm.askJ(`An agent's note in the shared memory contradicts the canon.\n\nYours (${x.id}): ${x.title}\nThe note (${y.id}, ${y.by}): ${y.title}\n\nWhich holds?`,
    { subject: y.id, product: 'mctest', options: ['mine holds (drop the note)', 'the note is right (update mine)'], from: 'memory curation' });
  const one = legacy(a, b);
  const two = legacy(b, a);
  assert.notEqual(one.id, two.id);
  assert.equal(await mc.askContradiction(a, b), null, 'an old card on the pair counts');
  await pm.answerQuestion(one.id, 'the note is right (update mine)', 'J');
  await tidy();
  assert.equal(rm.getQuestion(two.id)!.status, 'resolved');
  assert.match(rm.getQuestion(two.id)!.answer!, new RegExp(`answered in ${one.id}`));
});
