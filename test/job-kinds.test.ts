// Separate briefs for fix, feature, content and polish work (agents.ts jobKind, JOB_BRIEFS; the owner's gaps list,
// 2026-11-08). A fix finds the root cause and never loosens a check; a feature is built to the full bar; content is
// dense and canon-true; a polish pass makes each item disappear for a player.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-jobkinds-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [] }));

const { jobKind, JOB_BRIEFS } = await import('../src/agents.ts');
const { POLISH_BY } = await import('../src/polish.ts');

test('jobKind: polish pass, fix, content and feature', () => {
  assert.equal(jobKind({ request: null, started_by: POLISH_BY }, [{ severity: 'bug' }]), 'polish');
  assert.equal(jobKind({ request: null }, [{ severity: 'polish' }, { severity: 'polish' }]), 'polish');
  assert.equal(jobKind({ request: null }, [{ severity: 'polish' }, { severity: 'bug' }]), 'fix');
  assert.equal(jobKind({ request: null }, []), 'fix');
  assert.equal(jobKind({ request: 'Write the blacksmith\'s dialogue for chapter 2' }), 'content');
  assert.equal(jobKind({ request: 'Add a pause menu with audio settings' }), 'feature');
});

test('each kind has its own rules', () => {
  assert.match(JOB_BRIEFS.fix.rules, /root cause/);
  assert.match(JOB_BRIEFS.fix.rules, /Never make a check pass/);
  assert.match(JOB_BRIEFS.feature.rules, /no placeholder art/);
  assert.match(JOB_BRIEFS.content.rules, /world bible/);
  assert.match(JOB_BRIEFS.polish.rules, /disappear for a player/);
  assert.deepEqual(Object.values(JOB_BRIEFS).map((j) => j.prefix), ['Fix', 'Add', 'Content', 'Polish', 'New game']);
  assert.match(JOB_BRIEFS.polish.intro('Harbour', 'a fishing game'), /polish pass/);
});

test('new-game kind, and every game kind loads its design skills', async () => {
  const { skillsBrief } = await import('../src/agents.ts');
  assert.equal(jobKind({ request: 'Make the first playable version of "Harbour" from what the person described' }), 'new-game');
  assert.deepEqual(JOB_BRIEFS.content.skills, ['story-through-play', 'level-design', 'game-feel']);
  assert.deepEqual(JOB_BRIEFS['new-game'].skills, ['story-through-play', 'level-design', 'game-feel', 'ui-kit']);
  assert.ok(JOB_BRIEFS.feature.skills.includes('ui-kit') && JOB_BRIEFS.polish.skills.includes('ui-kit'), 'feature and polish briefs load the ui-kit skill');
  // The ui-kit skill's source is docs/ui-kit-skill.md (the sandbox can't write .claude/); the customer plugin has it already.
  for (const f of ['docs/ui-kit-skill.md', 'customer-plugin/skills/ui-kit/SKILL.md']) assert.ok(fs.existsSync(path.join(import.meta.dirname, '..', f)), f);
  const b = skillsBrief('content', 'hawkes');
  for (const k of ['story-through-play', 'level-design', 'game-feel']) assert.match(b, new RegExp(`hawkes:${k}`));
  assert.match(skillsBrief('new-game', 'studio'), /studio:game-quality/);
  for (const root of ['.claude', 'customer-plugin']) for (const k of ['story-through-play', 'level-design', 'game-feel']) assert.ok(fs.existsSync(path.join(import.meta.dirname, '..', root, 'skills', k, 'SKILL.md')), `${root}/${k}`);
});
