// More than one agent per product (parallel.ts, agents.ts pickQueued and noRoomFor, settings agents.perProduct and
// productLimits): a second change starts only beside ones it won't collide with; never two on the same task.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-parallel-'));
const { overlapWith, areasOf, filesIn } = await import('../src/parallel.ts');
const { pickQueued, perProductLimit, agentSettings, noRoomFor } = await import('../src/agents.ts');
const { saveSettings, costRaising } = await import('../src/settings.ts');
const { db } = await import('../src/db.ts');

test('areas and files from a title or paths', () => {
  assert.deepEqual([...areasOf('Portraits for the Circle 2 enemies')], ['art']);
  assert.deepEqual([...areasOf('Levels 7-10')], ['levels']);
  assert.ok(areasOf('', ['Assets/GameConfig/levels/level3.json']).has('levels'));
  assert.deepEqual(filesIn('Change Assets/GameConfig/levels/level3.json and ./src/shop.ts, not the menu.'), ['Assets/GameConfig/levels/level3.json', 'src/shop.ts']);
  assert.equal(areasOf('Make it better').size, 0);
});

test('two changes run side by side only when they won\'t collide', () => {
  const art = { task: 't_art', text: 'Portraits for Gloob and the imps' };
  const levels = { task: 't_lv', text: 'Levels 7-10' };
  assert.equal(overlapWith(art, [levels]), null, 'art beside levels');
  assert.match(overlapWith({ task: 't_lv2', text: 'Levels 3-6' }, [levels])!, /both work on levels/);
  assert.match(overlapWith({ task: 't_art', text: 'Portraits again' }, [art])!, /same task/, 'never two on the same task');
  assert.match(overlapWith({ task: 't_x', depends: ['t_lv'], text: 'Portraits for level 7' }, [levels])!, /depends on t_lv/);
  assert.match(overlapWith({ task: 't_y', text: 'Make it better' }, [levels])!, /can't tell/, 'unknown waits');
  // Files: a shared one collides whatever the words say; known files with nothing in common don't.
  assert.match(overlapWith({ text: 'Portraits', files: ['Assets/GameConfig/levels/level7.json'] }, [{ text: 'Levels 7-10', files: ['Assets/GameConfig/levels/level7.json'] }])!, /both touch/);
  assert.equal(overlapWith({ text: 'Levels 3-6', files: ['Assets/GameConfig/levels/level3.json'] }, [{ text: 'Levels 7-10', files: ['Assets/GameConfig/levels/level7.json'] }]), null);
});

test('pickQueued: per-product limits, and a product\'s second change only when it fits', () => {
  const q = [{ id: 'c_1', product: 'a' }, { id: 'c_2', product: 'a' }, { id: 'c_3', product: 'b' }, { id: 'c_4', product: 'a' }];
  // Limit 1 (the default): as before.
  assert.deepEqual(pickQueued(q, [], 5), ['c_1', 'c_3']);
  // Limit 2 for a, and everything fits: two of a.
  const two = { limit: (p: string) => (p === 'a' ? 2 : 1), fit: () => true };
  assert.deepEqual(pickQueued(q, [], 5, two), ['c_1', 'c_2', 'c_3']);
  assert.deepEqual(pickQueued(q, ['a'], 5, two), ['c_1', 'c_3']);
  assert.deepEqual(pickQueued(q, ['a', 'a'], 5, two), ['c_3']);
  // c_2 collides with what runs; c_4 doesn't: c_4 goes, c_2 waits. `fit` sees the ids picked earlier in the pass.
  const seen: string[][] = [];
  const picky = { limit: () => 2, fit: (id: string, picked: string[]) => { seen.push(picked); return id !== 'c_2'; } };
  assert.deepEqual(pickQueued(q, [], 5, picky), ['c_1', 'c_3', 'c_4']);
  assert.deepEqual(seen[0], ['c_1']);
  assert.deepEqual(pickQueued(q, [], 1, two), ['c_1'], 'within the free slots');
});

test('settings: perProduct defaults to 1, Sick Of It to 2, Studio and Gen always 1; validated; raising needs J', async () => {
  const s = agentSettings();
  assert.equal(s.perProduct, 1);
  assert.equal(perProductLimit('sickofit'), 2);
  assert.equal(perProductLimit('phorigins'), 1);
  assert.equal(perProductLimit('hawkesstudio', { ...s, perProduct: 3, productLimits: { hawkesstudio: 3 } }), 1);
  const saved = await saveSettings('agents', { productLimits: { phorigins: 2, sickofit: null } }, { conversation: null });
  assert.deepEqual(saved.productLimits, { phorigins: 2 });
  assert.equal(perProductLimit('sickofit'), 1);
  await assert.rejects(saveSettings('agents', { productLimits: { nope: 2 } }, { conversation: null }), /not a product/);
  await assert.rejects(saveSettings('agents', { productLimits: { phorigins: 9 } }, { conversation: null }), /1 to 4/);
  await assert.rejects(saveSettings('agents', { perProduct: 0 }, { conversation: null }), /1 to 4/);
  assert.deepEqual(costRaising('agents', { productLimits: { sickofit: 2 } }, { perProduct: 1, productLimits: {} }), ['productLimits.sickofit 1 → 2']);
  assert.deepEqual(costRaising('agents', { perProduct: 2 }, { perProduct: 1 }), ['perProduct 1 → 2']);
  await saveSettings('agents', { productLimits: { phorigins: null, sickofit: 2 } }, { conversation: null });
});

test('noRoomFor: a product\'s slots and what runs in them', () => {
  const now = Date.now();
  db.prepare(`INSERT INTO changes (id, product, findings, status, title, task, created) VALUES ('c_00000000par1', 'sickofit', '[]', 'working', 'Levels 7-10', NULL, ?)`).run(now);
  try {
    assert.equal(noRoomFor('sickofit', { task: 't_art', text: 'Portraits for the imps' }), null, 'a second slot for art beside levels');
    assert.match(noRoomFor('sickofit', { task: 't_lv', text: 'Levels 3-6' })!, /levels/);
    assert.match(noRoomFor('phorigins', { text: 'Portraits' }) ?? 'free', /free/);
    db.prepare(`INSERT INTO changes (id, product, findings, status, title, created) VALUES ('c_00000000par2', 'sickofit', '[]', 'queued', 'Portraits', ?)`).run(now);
    assert.match(noRoomFor('sickofit', { task: 't_sfx', text: 'Sound effects' })!, /2 changes are running/);
  } finally {
    db.prepare(`DELETE FROM changes WHERE id IN ('c_00000000par1', 'c_00000000par2')`).run();
  }
});
