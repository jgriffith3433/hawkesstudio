// Going live on the owner's word (golive-policy.ts): plain words count, "hold off" doesn't, and the policy is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-golive-'));
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'products.json'), JSON.stringify({ products: [{ id: 'moon', name: 'Moon Rover', engine: 'web', live: 'https://moon.example', playtests: [], story: [] }] }));
process.env.STUDIO_PRODUCTS = path.join(process.env.STUDIO_DATA, 'products.json');
const P = await import('../src/golive-policy.ts');
const G = await import('../src/guards.ts');

test('plain words ask to go live; hold-offs and questions about it don\'t', () => {
  for (const t of ['go live', 'Looks good, take it live', 'ship it', 'yes go ahead and push it live', 'DEPLOY moon', 'deploy the new build', "let's release it"]) assert.ok(P.asksToGoLive(t, 'moon'), t);
  for (const t of ['hold off on going live', "don't ship it yet", 'not yet, wait for the music', 'is it live?', 'what changed since live', 'stop going live']) assert.ok(!P.asksToGoLive(t, 'moon'), t);
  assert.ok(P.asksToRollBack('roll back moon please', 'moon'));
  assert.ok(P.asksToRollBack('revert the release'));
  assert.ok(!P.asksToRollBack("don't roll back"));
});

test('the policy: ask by default, kept with who set it and their words; auto lets Talk go live without new words', () => {
  assert.equal(P.policyOf('moon').policy, 'ask');
  assert.match(String(G.guardRoute('/api/deploy/moon', 'POST', null)), /waits for the owner's word/);
  P.setPolicy('moon', 'auto', 'Talk', 'keep going live whenever it passes');
  const pol = P.policyOf('moon');
  assert.deepEqual([pol.policy, pol.by, pol.words], ['auto', 'Talk', 'keep going live whenever it passes']);
  assert.equal(G.guardRoute('/api/deploy/moon', 'POST', null), null, 'auto: no new words needed');
  P.setPolicy('moon', 'hold', 'Talk', 'hold off for now');
  assert.ok(G.guardRoute('/api/deploy/moon', 'POST', null));
  assert.throws(() => P.setPolicy('moon', 'sometimes' as any, 'x'), /auto \| hold \| ask/);
});

test("autoGoLive waits unless the owner said to keep going live", async () => {
  P.setPolicy('moon', 'hold', 'Talk');
  assert.match(String((await P.autoGoLive('moon', 'test')).waits), /policy is hold/);
  P.setPolicy('moon', 'ask', 'Talk');
  assert.match(String((await P.autoGoLive('moon', 'test')).waits), /policy is ask/);
});
