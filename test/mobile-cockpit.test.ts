// The phone rules for the dashboard (J approves from a phone): 44px tap targets and no sideways page scroll at 390px.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(import.meta.dirname, '..', 'dashboard');
const css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');

function block(query: string): string {
  const i = css.lastIndexOf(`@media ${query} {`);
  assert.ok(i >= 0, `style.css has a ${query} block`);
  let depth = 0;
  for (let j = css.indexOf('{', i); j < css.length; j++) {
    if (css[j] === '{') depth++;
    if (css[j] === '}' && --depth === 0) return css.slice(i, j + 1);
  }
  throw new Error('unbalanced');
}

test('the page scales to the phone', () => {
  assert.match(html, /name="viewport"[^>]*width=device-width/);
});

test('on a phone or touch screen every button, link-button, field and summary is at least 44px tall', () => {
  const b = block('(pointer: coarse), (max-width: 760px)');
  assert.match(b, /button, a\.button, select, input[^{]*summary\s*\{\s*min-height: 44px/);
  assert.match(b, /button, a\.button \{ min-width: 44px/);
  for (const sel of ['button.small', 'nav button', '.ib-card .ib-actions button']) assert.ok(b.includes(sel), sel);
  assert.match(css, /\.approval \.ap-actions button \{ min-height: 44px/);
});

test('no page scrolls sideways at 390px: wide content wraps or scrolls inside its own box', () => {
  const b = block('(max-width: 760px)');
  assert.match(b, /html, body \{ max-width: 100%; overflow-x: clip/);
  assert.match(b, /\.tab table \{ display: block; max-width: 100%; overflow-x: auto/);
  assert.match(b, /overflow-wrap: anywhere/);
});

test('Talk\'s input stays above the on-screen keyboard', () => {
  const talk = fs.readFileSync(path.join(dir, 'talk.js'), 'utf8');
  assert.match(talk, /visualViewport/);
  assert.match(talk, /--kb/);
  assert.match(css, /\.talk-dock \{ bottom: var\(--kb, 0px\)/);
  assert.match(css, /body\.kb-open #talk\.on \{ height: calc\(var\(--vvh/);
});
