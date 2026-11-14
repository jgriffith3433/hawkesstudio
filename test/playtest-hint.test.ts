// 2026-11-01: Hawkes Games loads its playtest bot only for navigator.webdriver or `?playtest=`, and Gen's playtester
// doesn't show as automated, so contract plays never found window.hawkesPlaytest. Studio adds an empty `?playtest=`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-playtesthint-'));
const { withPlaytestHint } = await import('../src/pipeline.ts');

test('an empty ?playtest= is added to a page address', () => {
  assert.equal(withPlaytestHint('https://beta.hawkesgames.com/'), 'https://beta.hawkesgames.com/?playtest=');
  assert.equal(withPlaytestHint('https://sites.hawkesgen.ai/o/x/dod/?room=a'), 'https://sites.hawkesgen.ai/o/x/dod/?room=a&playtest=');
  assert.equal(withPlaytestHint('http://localhost:5173/play/#top'), 'http://localhost:5173/play/?playtest=#top');
});

test("one already there is kept, and what isn't a web page is left alone", () => {
  assert.equal(withPlaytestHint('https://a.com/?playtest=smoke'), 'https://a.com/?playtest=smoke');
  assert.equal(withPlaytestHint('not a url'), 'not a url');
  assert.equal(withPlaytestHint('ws://127.0.0.1:9000'), 'ws://127.0.0.1:9000');
});

test('pipeline playScenario adds ?playtest= for all local (beta) playtests, both web and Unity WebGL', () => {
  const src = fs.readFileSync(new URL('../src/pipeline.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /p\.engine === 'web'[^\n]*withPlaytestHint/, 'not restricted to web-only projects: Unity WebGL beta playtests get ?playtest= too');
  assert.match(src, /!firstFive && \(t\.where === 'local' \|\| \(p\.contract && \(params\.mode === 'contract' \|\| params\.mode === 'auto'\)\)\)[^\n]*withPlaytestHint/);
});
