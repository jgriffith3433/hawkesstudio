// A first-five result is handled after the play's try block (pipeline.ts playScenario): `params` is block-scoped inside that
// try, so a reference to it afterwards is a ReferenceError that fails the whole run (beta run r_a90d4cf693f3, "params is not defined"),
// with or without a persona timeline. The persona is carried by `personaAsked`, which lives beside `job`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/pipeline.ts', import.meta.url), 'utf8');
const start = src.indexOf('async function playScenario(');
const rest = src.slice(start + 10);
const end = start + 10 + rest.search(/\n(?:export )?(?:async )?function /);
const body = src.slice(start, end);
const tryAt = body.indexOf('    const params: Record<string, unknown>');
const after = body.slice(body.indexOf('    free();\n  }\n', tryAt));

test('the first-five result handling never reads the try-scoped `params`', () => {
  assert.ok(tryAt > 0 && after.length > 100, 'found the play and its result handling');
  const uses = after.split('\n').filter((l) => /(^|[^.\w])params\b(?!\s*:)/.test(l.replace(/\/\/.*$/, '')));
  assert.deepEqual(uses, []);
});

test('the persona flag is declared outside the try and set where the persona params are added', () => {
  assert.match(body, /let personaAsked = false;[\s\S]*?\n  try \{/);
  assert.match(body, /Object\.assign\(params, personaParams\(\)\); personaAsked = true;/);
  assert.match(after, /isFirstFive\(t\.scenario\) && personaAsked/);
});
