// Findings name library entities by whole words (src/finding-entities.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-fe-'));
const { namedIn, phrase } = await import('../src/finding-entities.ts');

const ent = (id: string, name: string) => ({ id, name, kind: 'x', words: [phrase(name), phrase(id.split('/')[1])].filter(Boolean) });

test('a finding names an entity by its name or slug, as whole words', () => {
  const ents = [ent('doseofdestruction/spider-bot', 'Spider Bot'), ent('doseofdestruction/break', 'Break'), ent('theplacedepartment/hen', 'Hen')];
  assert.deepEqual(namedIn({ title: "Spider Bot's side view is a person" }, ents).map((e: any) => e.id), ['doseofdestruction/spider-bot']);
  assert.deepEqual(namedIn({ title: 'Clip stutters', detail: 'the spiderbot walk loop pops' }, ents).map((e: any) => e.id), ['doseofdestruction/spider-bot']);
  assert.deepEqual(namedIn({ title: 'Breakdown of the menu' }, ents), [], 'Break inside Breakdown is not a match');
  assert.deepEqual(namedIn({ title: 'Then the game hangs' }, ents), [], 'Hen inside Then is not a match');
});
