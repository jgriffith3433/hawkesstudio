// Playtests at phone size on request: studio_playtest's device reaches the API, the run plays it like products.json's
// phone entries (390x844 touch: Gen's mobile) and names the step <scenario>@local:phone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-device-'));
const { studioMcp } = await import('../src/mcp-tools.ts');
const { playtestRequest, nameOf } = await import('../src/pipeline.ts');
const { playtestExtras } = await import('../src/playtests.ts');

test('studio_playtest offers device and sends it to the playtest API', async () => {
  const sent: any[] = [];
  const server = studioMcp({ studio: (async (route: string, o: any) => { sent.push({ route, body: o?.body }); return { run: 'r_1' }; }) as any, waitRun: (async () => ({})) as any });
  const tool = server.tools.find((t) => t.name === 'studio_playtest')!;
  assert.ok(tool.inputSchema.properties.device, 'device is in the schema (additionalProperties is false)');
  await tool.run({ product: 'sickofit', scenario: 'layout', device: 'phone' });
  assert.deepEqual(sent, [{ route: '/api/playtest', body: { product: 'sickofit', scenario: 'layout', device: 'phone' } }]);
});

test('a phone request plays at phone size as <scenario>@local:phone; unset stays desktop', () => {
  const phone = playtestRequest({ scenario: 'layout', device: 'phone' });
  assert.equal(phone.device, 'phone');
  const t = { scenario: phone.scenario, where: phone.where ?? 'local', device: phone.device } as const;
  assert.equal(nameOf(t), 'layout@local:phone');
  assert.equal(playtestExtras('sickofit', nameOf(t), t).mobile, true);

  const desk = playtestRequest({ scenario: 'layout' });
  assert.equal(desk.device, undefined);
  const d = { scenario: 'layout', where: 'local' } as const;
  assert.equal(nameOf(d), 'layout@local');
  assert.equal((playtestExtras('sickofit', nameOf(d), d) as any).mobile, undefined);
  assert.equal(playtestRequest({ scenario: 'layout', device: 'tablet' }).device, undefined);
});

test("Sick Of It has the layout playtest at phone size", () => {
  const products = JSON.parse(fs.readFileSync(new URL('../products.json', import.meta.url), 'utf8'));
  const soi = products.products.find((p: any) => p.id === 'sickofit');
  const t = soi.playtests.find((x: any) => x.scenario === 'layout' && x.device === 'phone');
  assert.ok(t);
  assert.equal(nameOf(t), 'layout@local:phone');
});
