// Phone playtests are standard: every desktop playtest gets a touch phone twin, so daily runs show both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-phone-'));
const { withPhonePlaytests, saveProduct } = await import('../src/config.ts');
const { nameOf } = await import('../src/pipeline.ts');
const { playtestExtras } = await import('../src/playtests.ts');

test('each desktop playtest gets a phone twin; existing phone entries and peers runs are left alone', () => {
  const out = withPhonePlaytests([
    { scenario: 'smoke', where: 'local' as const },
    { scenario: 'smoke', where: 'local' as const, device: 'phone' as const },
    { scenario: 'layout', where: 'live' as const },
    { scenario: 'duel', where: 'local' as const, peers: 2 },
    { mode: 'site' as const, where: 'live' as const },
  ]);
  assert.deepEqual(out.map(nameOf), ['smoke@local', 'smoke@local:phone', 'layout@live', 'layout@live:phone', 'duel@local', 'site@live', 'site@live:phone']);
  assert.deepEqual(withPhonePlaytests(out).map(nameOf), out.map(nameOf), 'idempotent');
});

test('a new project gets a desktop and a phone smoke by default, and the phone one plays by touch (Gen mobile)', () => {
  const p = saveProduct({ id: 'phone-default', name: 'Phone Default', engine: 'web', live: 'https://example.com/game/' } as any);
  assert.deepEqual(p.playtests.map(nameOf), ['smoke@live', 'smoke@live:phone']);
  const phone = p.playtests[1];
  assert.equal(playtestExtras(p.id, nameOf(phone), phone).mobile, true);
});
