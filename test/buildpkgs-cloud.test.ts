import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildsOnWindowsBox } from '../src/buildpkgs.ts';

const gen = (answer: any) => async () => answer;

test('the Windows box is synced only for builds Gen runs there', async () => {
  const cloud = { backend: 'cloudrun', projects: { breakingthrough: 'vm', 'YoobaLand/YoobaLand': 'builder' } };
  assert.equal(await buildsOnWindowsBox({ project: 'sickofitgame-unity' }, () => {}, gen(cloud)), false);
  assert.equal(await buildsOnWindowsBox({ project: 'breakingthrough' }, () => {}, gen(cloud)), false);
  assert.equal(await buildsOnWindowsBox({ project: 'YoobaLand\\YoobaLand' }, () => {}, gen(cloud)), true);
  assert.equal(await buildsOnWindowsBox({ project: 'x', backend: 'builder' }, () => {}, gen(cloud)), true);
  assert.equal(await buildsOnWindowsBox({ project: 'x' }, () => {}, gen({ backend: 'builder', projects: {} })), true);
  // An older Gen without the route, or Gen down: keep syncing as before.
  assert.equal(await buildsOnWindowsBox({ project: 'x' }, () => {}, async () => { throw new Error('404'); }), true);
});
