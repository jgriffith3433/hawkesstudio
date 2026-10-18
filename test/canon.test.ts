// The canon check (canon.ts) blocks only clear contradictions: the cases from Sick Of It on 2026-10-18, when five
// changes were held and only one (impSack dropping loop shards) was a real slip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-canon-'));
const { sortConflicts, canonPrompt, addedLines } = await import('../src/canon.ts');
const { gate } = await import('../src/acceptance.ts');

const CANON = [
  '- [canon] Loop shards (m_0000000000a1): Loop shards only ever come from the Loop Keeper; no ordinary enemy drops them.',
  '- [canon] Gloob (m_0000000000a2): Gloob is a slime shopkeeper, green, a villager and never an enemy.',
  "- [canon] Doctor Vell (m_0000000000a3): Doctor Vell never leaves the clinic; his brother runs the docks.",
].join('\n');

const diff = (file: string, ...lines: string[]) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,3 +1,4 @@\n ${'{'}\n${lines.map((l) => `+${l}`).join('\n')}\n ${'}'}\n`;
const hit = (o: Record<string, string>) => ({ entry: 'm_0000000000a1', quote: '', line: '', why: 'x', confidence: 'high', kind: 'contradiction', ...o });

test('the real slip blocks: impSack drops loop shards (a quoted entry, the exact added line, high confidence)', () => {
  const d = diff('Assets/GameConfig/enemies/impSack.json', '  "drops": ["loopShard", "coin"],');
  const r = sortConflicts([hit({ quote: 'Loop shards only ever come from the Loop Keeper', line: '"drops": ["loopShard", "coin"],', why: 'an ordinary enemy drops loop shards' })], d, CANON);
  assert.equal(r.blocking.length, 1);
  assert.equal(r.notes.length, 0);
  assert.equal(gate({ canon: { ok: false, conflicts: r.blocking } }, []).pass, false);
});

test('an empty drops list is no drop (Gloob\'s shop, c_0884e229a128)', () => {
  const d = diff('Assets/GameConfig/enemies/shopGuard.json', '  "drops": [],');
  const r = sortConflicts([hit({ quote: 'Loop shards only ever come from the Loop Keeper', line: '"drops": [],' })], d, CANON);
  assert.equal(r.blocking.length, 0);
  assert.match(r.notes[0].note!, /empty value/);
});

test('tinted placeholder art is a note, not a block (the portal audio and story path changes)', () => {
  const d = diff('Assets/Art/Placeholders/gloob_red.png.meta', '  tint: red');
  const r = sortConflicts([hit({ entry: 'm_0000000000a2', quote: 'Gloob is a slime shopkeeper, green', line: 'tint: red', why: 'Gloob is shown red' })], d, CANON);
  assert.equal(r.blocking.length, 0);
  assert.match(r.notes[0].note!, /placeholder/);
  // The model saying so itself is a note too.
  assert.equal(sortConflicts([hit({ kind: 'placeholder' })], d, CANON).notes.length, 1);
});

test('an ambiguous "his" is a note (Levels 3-6, c_b039ffc0d893), and so is anything below high confidence', () => {
  const d = diff('Assets/GameConfig/levels/level4.json', '  "line": "He left his post at the docks to see the clinic."');
  const ambiguous = hit({ entry: 'm_0000000000a3', quote: 'Doctor Vell never leaves the clinic', line: '"line": "He left his post at the docks to see the clinic."', kind: 'ambiguous', confidence: 'medium' });
  assert.equal(sortConflicts([ambiguous], d, CANON).blocking.length, 0);
  assert.equal(sortConflicts([{ ...ambiguous, kind: 'contradiction', confidence: 'medium' }], d, CANON).notes[0].note, 'medium confidence');
});

test('what the task asked for is never a conflict (Levels 7-10, c_b9fde74e7e25), and the prompt carries the request, criteria and J\'s decisions', () => {
  const d = diff('Assets/GameConfig/levels/level8.json', '  "boss": "Loop Keeper"');
  assert.equal(sortConflicts([hit({ kind: 'requested', line: '"boss": "Loop Keeper"' })], d, CANON).blocking.length, 0);
  const p = canonPrompt(CANON, d, 'Levels 7-10', { request: 'Add the Loop Keeper as level 8\'s boss', criteria: ['Level 8 ends with the Loop Keeper'] }, '- [decision] Arcade levels are retired (m_0000000000d1)');
  assert.match(p, /Add the Loop Keeper as level 8's boss/);
  assert.match(p, /Level 8 ends with the Loop Keeper/);
  assert.match(p, /J'S DECISIONS[\s\S]*Arcade levels are retired/);
  assert.match(p, /never a conflict/);
});

test('off the story path (retired or arcade levels) is a note', () => {
  const d = diff('Assets/GameConfig/levels/arcade/arcade3.json', '  "drops": ["loopShard"]');
  const r = sortConflicts([hit({ quote: 'Loop shards only ever come from the Loop Keeper', line: '"drops": ["loopShard"]' })], d, CANON);
  assert.equal(r.blocking.length, 0);
  assert.match(r.notes[0].note!, /off the story path/);
});

test('a finding must quote the canon and an added line that is really in the diff', () => {
  const d = diff('Assets/GameConfig/enemies/impSack.json', '  "drops": ["loopShard"]');
  // The line isn't in the change (a removed line, or made up).
  assert.match(sortConflicts([hit({ quote: 'Loop shards only ever come from the Loop Keeper', line: '"drops": ["bigLoopShard"]' })], d, CANON).notes[0].note!, /isn't one the change added/);
  // No quote, or one that isn't in the canon.
  assert.match(sortConflicts([hit({ line: '"drops": ["loopShard"]' })], d, CANON).notes[0].note!, /isn't quoted/);
  assert.match(sortConflicts([hit({ quote: 'Imps are friendly merchants who sing', line: '"drops": ["loopShard"]' })], d, CANON).notes[0].note!, /isn't quoted/);
  // No entry id.
  assert.match(sortConflicts([hit({ entry: 'Loop shards', quote: 'Loop shards only ever come from the Loop Keeper', line: '"drops": ["loopShard"]' })], d, CANON).notes[0].note!, /no canon entry/);
  // Junk from the model never throws.
  assert.deepEqual(sortConflicts(undefined as any, d, CANON), { blocking: [], notes: [] });
});

test('addedLines reads the files and the added lines of a unified diff', () => {
  const lines = addedLines(`${diff('a/x.json', 'one')}${diff('b/y.json', 'two', 'three')}`);
  assert.deepEqual(lines.map((l) => [l.file, l.text]), [['a/x.json', 'one'], ['b/y.json', 'two'], ['b/y.json', 'three']]);
});

test('notes never fail the merge gate', () => {
  assert.equal(gate({ canon: { ok: true, conflicts: [], notes: [{ entry: 'm_0000000000a2', why: 'tint', note: 'placeholder or stand-in art' }] } }, []).pass, true);
});
