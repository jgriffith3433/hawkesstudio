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
  assert.deepEqual(Object.values(JOB_BRIEFS).map((j) => j.prefix), ['Fix', 'Add', 'Content', 'Polish']);
  assert.match(JOB_BRIEFS.polish.intro('Harbour', 'a fishing game'), /polish pass/);
});
