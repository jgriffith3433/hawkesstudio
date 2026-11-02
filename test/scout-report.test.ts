// A scout that ends without a result text (error_max_turns) says why and keeps its last words as a partial report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-scout-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
const { newScoutStream, feedScoutLine, scoutReport, scoutWhy } = await import('../src/scout.ts');

const long = 'The relevant code lives in src/roles.ts and src/tuning.ts, which cap turns per role. '.repeat(2);

test('max turns with no result text: why, and a partial report from the last assistant text', () => {
  const st = newScoutStream();
  const tools: string[] = [];
  feedScoutLine(st, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }] } }, (d) => tools.push(d));
  feedScoutLine(st, { type: 'assistant', message: { content: [{ type: 'text', text: long }] } });
  feedScoutLine(st, { type: 'result', subtype: 'error_max_turns', is_error: false, num_turns: 40, total_cost_usd: 0.23 });
  st.code = 1;
  st.err = 'warn\nsomething broke';
  assert.equal(tools.length, 1);
  assert.equal(st.cost, 0.23);
  const why = scoutWhy(st);
  assert.match(why, /error_max_turns after 40 turns/);
  assert.match(why, /exit 1/);
  assert.match(why, /something broke/);
  const r = scoutReport(st);
  assert.equal(r.partial, true);
  assert.match(r.text, /Partial report/);
  assert.match(r.text, /src\/roles\.ts/);
});

test('no result message and nothing said: no partial, and the reason names it', () => {
  const st = newScoutStream();
  st.code = 137;
  assert.equal(scoutReport(st).partial, false);
  assert.match(scoutWhy(st), /no result message, exit 137/);
});

test('a normal result is the report, not partial', () => {
  const st = newScoutStream();
  feedScoutLine(st, { type: 'assistant', message: { content: [{ type: 'text', text: long }] } });
  feedScoutLine(st, { type: 'result', subtype: 'success', is_error: false, num_turns: 9, result: `## What's there now\n${long}` });
  const r = scoutReport(st);
  assert.equal(r.partial, false);
  assert.match(r.text, /What's there now/);
});

test('a scout stopped by the wall-clock limit reports what it wrote and says why', async () => {
  const { newScoutStream, feedScoutLine, scoutReport, scoutWhy } = await import('../src/scout.ts');
  const st = newScoutStream();
  feedScoutLine(st, { type: 'assistant', message: { content: [{ type: 'text', text: 'Found the relevant code in src/a.ts and src/b.ts; it would take two tasks.' }] } });
  st.timedOut = true;
  assert.match(scoutWhy(st), /wall-clock/);
  const r = scoutReport(st);
  assert.ok(r.partial);
  assert.match(r.text, /two tasks/);
});
