// More than one agent per product (parallel.ts, agents.ts pickQueued and noRoomFor, settings agents.perProduct and
// productLimits): a second change starts only beside ones it won't collide with; never two on the same task.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-parallel-'));
const { overlapWith, areasOf, filesIn } = await import('../src/parallel.ts');
const { pickQueued, perProductLimit, agentSettings, noRoomFor, behindDetail } = await import('../src/agents.ts');
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

test('a queued change\'s "behind c_..." stays current', () => {
  assert.equal(behindDetail('queued by the PM (a roadmap task) behind c_old', ['c_new'], 1), 'queued by the PM (a roadmap task) behind c_new');
  assert.equal(behindDetail('queued (J asked) behind c_old', [], 1), 'queued (J asked)', 'nothing ahead: no "behind"');
  assert.equal(behindDetail('queued behind c_a', ['c_b'], 2), 'queued', 'a slot left: not behind anything');
  assert.equal(behindDetail('queued behind c_a', ['c_a'], 1), 'queued behind c_a');
  assert.equal(behindDetail('queued for another pass', ['c_a'], 1), 'queued for another pass', 'other details untouched');
});

test('the PM\'s capacity counts running changes, not queued ones waiting for a slot', async () => {
  const pm = await import('../src/pm.ts');
  const before = pm.capacity().active;
  const now = Date.now();
  const ins = db.prepare(`INSERT INTO changes (id, product, findings, status, title, created) VALUES (?, ?, '[]', ?, 'x', ?)`);
  ins.run('c_00000000cap1', 'hawkesstudio', 'queued', now);
  ins.run('c_00000000cap2', 'hawkesstudio', 'queued', now);
  ins.run('c_00000000cap3', 'hawkesstudio', 'working', now);
  try {
    assert.equal(pm.capacity().active, before + 1);
  } finally {
    db.prepare(`DELETE FROM changes WHERE id IN ('c_00000000cap1', 'c_00000000cap2', 'c_00000000cap3')`).run();
  }
});

// Up to 3 agents per product, Unity especially (J, 2026-10-19): one-at-a-time Unity files, binaries, the brief, conflicts.
test('Unity: scenes, ProjectSettings, the package manifest and Addressables groups run one change at a time', async () => {
  const { serialOf } = await import('../src/parallel.ts');
  const scene = { task: 't_a', text: 'Boss intro', files: ['Assets/Scenes/Level.unity'] };
  // Different scenes, different files: still one at a time.
  assert.match(overlapWith({ task: 't_b', text: 'Menu music', files: ['Assets/Scenes/MainMenu.unity'] }, [scene])!, /a Unity scene.*one change at a time/);
  assert.match(overlapWith({ task: 't_b', text: 'x', files: ['ProjectSettings/QualitySettings.asset'] }, [{ text: 'y', files: ['ProjectSettings/TagManager.asset'] }])!, /ProjectSettings/);
  assert.match(overlapWith({ text: 'x', files: ['YoobaLand/Packages/manifest.json'] }, [{ text: 'y', files: ['YoobaLand/Packages/packages-lock.json'] }])!, /manifest/);
  assert.match(overlapWith({ text: 'x', files: ['Assets/AddressableAssetsData/AssetGroups/Enemies.asset'] }, [{ text: 'y', files: ['Assets/AddressableAssetsData/AssetGroups/Music.asset'] }])!, /Addressables/);
  // In a Unity product, a title that names one counts; elsewhere (a web "scene") it doesn't.
  assert.match(overlapWith({ task: 't_c', text: 'Rework the shop scene lighting', files: ['Assets/Prefabs/Shop.prefab'] }, [scene], { unity: true })!, /Unity scene/);
  assert.equal(overlapWith({ task: 't_c', text: 'Rework the shop scene lighting', files: ['src/shop.ts'] }, [{ text: 'Boss intro', files: ['src/boss.ts'] }]), null);
  assert.deepEqual([...serialOf({ text: 'Add the Addressables group and a package' }, true)], ['Packages/manifest.json', 'an Addressables group']);
  // Prefabs and data beside each other run in parallel; the same binary never does.
  assert.equal(overlapWith({ text: 'Imp prefab', files: ['Assets/Prefabs/Imp.prefab'] }, [{ text: 'Gloob prefab', files: ['Assets/Prefabs/Gloob.prefab'] }], { unity: true }), null);
  assert.match(overlapWith({ text: 'a', files: ['Assets/Art/imp.png'] }, [{ text: 'b', files: ['Assets/Art/imp.png'] }])!, /binary/);
});

test('conflicted files sorted into binary, Unity YAML, code and data (LFS is binary)', async () => {
  const { sortConflicts, kindOf } = await import('../src/parallel.ts');
  const k = sortConflicts(['Assets/Art/imp.png', 'Assets/Scenes/Level.unity', 'Assets/Prefabs/Imp.prefab.meta', 'Assets/Scripts/Imp.cs', 'Assets/GameConfig/enemies.json', 'Assets/Prefabs/Gloob.prefab'], new Set(['Assets/Prefabs/Gloob.prefab']));
  assert.deepEqual(k.binary, ['Assets/Art/imp.png', 'Assets/Prefabs/Gloob.prefab']);
  assert.deepEqual(k.unity, ['Assets/Scenes/Level.unity', 'Assets/Prefabs/Imp.prefab.meta']);
  assert.deepEqual(k.code, ['Assets/Scripts/Imp.cs']);
  assert.deepEqual(k.data, ['Assets/GameConfig/enemies.json']);
  assert.equal(kindOf('Models/boss.glb'), 'binary');
});

test('the brief\'s "Other agents" section: who else works on the product, and on which files', async () => {
  const { othersSection } = await import('../src/parallel.ts');
  assert.equal(othersSection('PH Origins', [], 1), '', 'one agent per product: nothing to say');
  const alone = othersSection('Sick Of It', [], 3);
  assert.match(alone, /Up to 3 agents/);
  assert.match(alone, /may merge into beta\s+while you work, so keep your change narrow/);
  assert.match(alone, /None is running beside you/);
  const s = othersSection('Sick Of It', [
    { id: 'c_1', status: 'working', title: 'Circle IX levels', request: 'Make the Circle IX levels, one per floor', files: ['Assets/GameConfig/levels/level9.json'] },
    { id: 'c_2', status: 'ready', title: 'Imp portraits', request: null, files: [] },
  ], 3);
  assert.match(s, /c_1 \(working\): Circle IX levels\. Asked: "Make the Circle IX levels, one per floor"/);
  assert.match(s, /Files touched so far: `Assets\/GameConfig\/levels\/level9\.json`/);
  assert.match(s, /c_2 \(ready\): Imp portraits\n  Files touched so far: none yet/);
});

test('the conflict pass: Unity-aware brief, and what it left unresolved goes back with the files', async () => {
  const { conflictPrompt, unresolvedConflicts, UNRESOLVED } = await import('../src/agents.ts');
  const files = ['Assets/Art/imp.png', 'Assets/Scenes/Level.unity', 'Assets/Scripts/Imp.cs'];
  const p = conflictPrompt({ base: 'beta' }, files, { unity: true });
  assert.match(p, /\*\*Binary\*\* \(never hand-merged, never regenerated\): `Assets\/Art\/imp\.png`/);
  assert.match(p, /git checkout --theirs/);
  assert.match(p, /\*\*Unity YAML\*\*: `Assets\/Scenes\/Level\.unity`.*GUID and fileID/s);
  assert.match(p, /\*\*Code\*\*: `Assets\/Scripts\/Imp\.cs`/);
  assert.match(p, /Prefabs first/);
  assert.match(p, /\.hawkes\/unresolved\.md/);
  assert.match(p, /say which files conflicted and how you resolved each one/);
  const web = conflictPrompt({ base: 'beta' }, ['src/shop.ts']);
  assert.doesNotMatch(web, /Binary|Prefabs first/, 'web products: as before');
  assert.doesNotMatch(conflictPrompt({ base: 'main', infra: true }, ['src/a.ts']), /unresolved/);

  // A scratch repo: a clean merge commit is fine; markers left in, or the agent's own list, are not.
  const { execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-unresolved-'));
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'Level.unity'), '--- !u!1 &100\nGameObject:\n  m_Name: A\n');
  g('add', '.'); g('commit', '-qm', 'one');
  assert.equal(unresolvedConflicts(dir, ['Level.unity']), null);
  fs.writeFileSync(path.join(dir, 'Level.unity'), '--- !u!1 &100\n<<<<<<< HEAD\n  m_Name: A\n=======\n  m_Name: B\n>>>>>>> origin/beta\n');
  g('commit', '-qam', 'broken');
  assert.match(unresolvedConflicts(dir, ['Level.unity'])!, /conflict markers in Level\.unity/);
  fs.mkdirSync(path.join(dir, '.hawkes'));
  fs.writeFileSync(path.join(dir, UNRESOLVED), 'Assets/Art/imp.png: both sides repainted it\n');
  assert.match(unresolvedConflicts(dir, ['Assets/Art/imp.png'], false)!, /couldn't resolve them safely: Assets\/Art\/imp\.png: both sides repainted it/);
  assert.equal(fs.existsSync(path.join(dir, UNRESOLVED)), false, 'read once');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('noRoomFor: a Unity product\'s second change waits when both would touch a scene', () => {
  const now = Date.now();
  db.prepare(`INSERT INTO changes (id, product, findings, status, title, request, created) VALUES ('c_00000000uni1', 'sickofit', '[]', 'working', 'Main menu polish', 'Tidy Assets/Scenes/MainMenu.unity', ?)`).run(now);
  try {
    assert.match(noRoomFor('sickofit', { task: 't_shop', text: 'Shop scene lighting' })!, /Unity scene/);
    assert.equal(noRoomFor('sickofit', { task: 't_imp', text: 'Imp prefab', files: ['Assets/Prefabs/Imp.prefab'] }), null, 'a prefab beside it runs');
  } finally {
    db.prepare(`DELETE FROM changes WHERE id = 'c_00000000uni1'`).run();
  }
});
