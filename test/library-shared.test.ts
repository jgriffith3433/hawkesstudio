// A product folder outside its repo is written by Studio only when hawkes-assets tracks it (mounts.json), so the pick
// can go to S3 and hawkes-assets' lock (src/library.ts publishShared).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-shared-'));
process.env.STUDIO_PROJECTS = projects;
process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-shared-data-'));
const { sharedArt } = await import('../src/library.ts');

test('only folders hawkes-assets mounts are shared art', () => {
  assert.equal(sharedArt(path.join(projects, 'AllTheCharacters')), false, 'no hawkes-assets here yet');
  fs.mkdirSync(path.join(projects, 'hawkes-assets'), { recursive: true });
  fs.writeFileSync(path.join(projects, 'hawkes-assets', 'mounts.json'), JSON.stringify({ 'art/dod-characters': '../AllTheCharacters' }));
  assert.equal(sharedArt(path.join(projects, 'AllTheCharacters')), true);
  assert.equal(sharedArt(path.join(projects, 'AllTheMaps')), false);
});
