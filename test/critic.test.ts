import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickScenario, referencesOf, cleanReferences, DIMENSIONS, critic } from '../src/critic.ts';
import { criticLines } from '../src/critic-view.ts';

test('two weekly runs review different scenarios, every one within a few weeks', () => {
  const all = ['chapter-1', 'chapter-2', 'chapter-3'];
  const history: { scenario: string | null }[] = [];
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    const { scenario } = pickScenario(all, history);
    seen.push(scenario!);
    history.unshift({ scenario });
  }
  assert.deepEqual([...seen].sort(), all);
  assert.notEqual(seen[0], seen[1]);
});

test('references: the product\'s own, 2-3 games', () => {
  assert.equal(cleanReferences([{ game: 'Hades', best: 'death moves the story' }, { game: '' }, { game: 'A' }, { game: 'B' }, { game: 'C' }]).length, 3);
  assert.equal(referencesOf({ id: 'zz-none', references: [{ game: 'Vampire Survivors', best: 'first weapon fires at once' }] })[0].game, 'Vampire Survivors');
});

test('unjudged: no frames means no scores, never a pass', () => {
  const lines = criticLines({ verdict: 'unjudged', scores: [], summary: 'the critic had no frames' });
  assert.match(lines[0], /Unjudged/);
  assert.equal(lines.some((l) => /\/10/.test(l)), false);
});

test('a judged review lists ten scores each with a reference and a clip time', () => {
  const scores = DIMENSIONS.map((dimension) => ({ dimension, score: 6, reference: 'Hades', frame: null, at: 't=12s', why: 'w', fix: 'f' }));
  const lines = criticLines({ verdict: 'judged', scores, scenario: 'chapter-2', next: ['chapter-3'], summary: 's' });
  assert.equal(lines.filter((l) => l.startsWith('- ')).length, 10);
  assert.ok(lines.filter((l) => l.startsWith('- ')).every((l) => /vs Hades/.test(l) && /t=12s/.test(l)));
  assert.equal(lines.some((l) => /\|/.test(l)), false, 'no table: it must read at 390 px');
});

test('a critic run that gets no frames is unjudged, and the model is never asked to score', async () => {
  const { getProduct } = await import('../src/config.ts');
  const { critic } = await import('../src/critic.ts');
  let asked = 0;
  const p: any = { ...getProduct('doseofdestruction'), references: [{ game: 'Hades', best: 'x' }] };
  const c = await critic(p, { run: 'r_none' }, { ask: (async () => { asked++; return { status: 'done', result: { value: {} } }; }) as any });
  if (c) { assert.equal(c.verdict, 'unjudged'); assert.equal(c.scores.length, 0); assert.equal(asked, 0); }
});
