// J's Studio keeps speaking as J's (the other side of test/customer-voice.test.ts): Talk's prompt still knows Hawkes
// Biomedical, J and his products; the roles and skills are .claude's; his seed and every tool are there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-jvoice-'));
process.env.STUDIO_MAIL = 'off';
for (const k of ['STUDIO_SIGNUP', 'STUDIO_ORG', 'STUDIO_CUSTOMER', 'STUDIO_PRODUCTS', 'STUDIO_AGENTS_DIR', 'STUDIO_PLUGIN_DIR']) delete process.env[k];

const T = await import('../src/talk.ts');
const R = await import('../src/roles.ts');

test("J's Studio: Talk is J's partner in Hawkes Biomedical, with his products, roles and skills", async () => {
  const p = T.talkPromptText('talk');
  assert.match(p, /Hawkes Biomedical/);
  assert.match(p, /\bJ's studio partner\b/);
  assert.match(p, /Sick Of It/);
  assert.equal(path.basename(R.PLUGIN_DIR()), '.claude');
  assert.match(R.loadRole('talk').body, /J's decisions/);
  assert.ok(R.listSkills().some((s) => s.name === 'sickofit-howto'));
  const { forOwner } = await import('../src/owner.ts');
  assert.equal(forOwner("J's call"), "J's call");
  const { studioMcp } = await import('../src/mcp-tools.ts');
  assert.ok(studioMcp({ studio: async () => ({}), waitRun: async () => ({}) } as any).tools.some((t) => t.name === 'studio_costs'));
  const { seedDir } = await import('../src/memory.ts');
  assert.equal(path.basename(seedDir()), 'seed');
});
