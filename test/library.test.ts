// The Library tab's server side (src/library.ts): a product's mapping is read from either file, and only folders inside
// the repo are written by Studio (the rest belong to the product's own tools).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-lib-'));
const { mappingIn, mappingsIn, insideRepo } = await import('../src/library.ts');

const slots = [{ slot: 'model', current: 'model.glb' }];

test('a mapping comes from hawkes.library.json, or the library section of hawkes.content.json', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-a-'));
  assert.equal(mappingIn(a), null);
  fs.writeFileSync(path.join(a, 'hawkes.library.json'), JSON.stringify({ project: 'p', kind: 'prop', root: 'assets/props', slots }));
  const m = mappingIn(a);
  assert.equal(m.root, path.join(a, 'assets', 'props'));

  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-b-'));
  fs.writeFileSync(path.join(b, 'hawkes.content.json'), JSON.stringify({ library: { project: 'p', kind: 'fighter', root: '../AllTheCharacters', slots }, assets: [] }));
  const n = mappingIn(b);
  assert.equal(n.kind, 'fighter');
  assert.equal(n.root, path.resolve(b, '..', 'AllTheCharacters'));
});

test('one file can map several kinds; the kind of an entity picks its mapping', () => {
  const c = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-c-'));
  const flat = [{ slot: 'model', current: '{entity}.glb' }];
  fs.writeFileSync(path.join(c, 'hawkes.library.json'), JSON.stringify({ project: 'p', layout: 'files', root: 'assets/models', mappings: [{ kind: 'character', entities: ['ch*'], slots: flat }, { kind: 'prop', skip: ['ch*'], slots: flat }] }));
  assert.equal(mappingsIn(c).length, 2);
  assert.equal(mappingIn(c, 'prop').kind, 'prop');
  assert.equal(mappingIn(c, 'prop').root, path.join(c, 'assets', 'models'));
  assert.equal(mappingIn(c).kind, 'character');
});

test('Studio writes picks only into folders inside the repo', () => {
  const repo = path.join(os.tmpdir(), 'some-repo');
  assert.equal(insideRepo(repo, path.join(repo, 'assets', 'models')), true);
  assert.equal(insideRepo(repo, repo), true);
  assert.equal(insideRepo(repo, path.join(os.tmpdir(), 'AllTheCharacters')), false);
});
