// The newcomer persona (persona.ts): the timeline from Gen's events, the weekly cap, a finding per lost stretch with its clip, the cost on the run line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-persona-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
const P = await import('../src/persona.ts');
const { db } = await import('../src/db.ts');

const result = {
  video: 'a_vid', personaCost: 0.4321,
  events: [
    { t: 2, type: 'persona-step', detail: JSON.stringify({ intent: 'find a play button' }) },
    { t: 30, type: 'lost', detail: JSON.stringify({ from: 12, to: 30, reason: 'idle', intent: 'find a play button', shot: 'a_s1' }) },
    { t: 50, type: 'lost', detail: JSON.stringify({ from: 40, to: 50, reason: 'failed-inputs', intent: 'close the dialog' }) },
    { t: 55, type: 'lost', detail: JSON.stringify({ from: 48, to: 70, reason: 'idle' }) },
  ],
};

test('the timeline lists each lost stretch with start, length and clip; overlaps merge; cost is read', () => {
  const p = P.personaOf(result, 'phone');
  assert.equal(p.reported, true);
  assert.equal(p.lost.length, 2);
  assert.deepEqual([p.lost[0].from, p.lost[0].seconds], [12, 18]);
  assert.deepEqual([p.lost[1].from, p.lost[1].seconds], [40, 30]);
  assert.equal(p.lostSeconds, 48);
  assert.equal(p.cost, 0.432);
  const lines = P.personaLines(p).join('\n');
  assert.match(lines, /Phone 390x844 touch newcomer persona.*\$0\.43/);
  assert.match(lines, /lost at 12 s for 18 s/);
  assert.match(lines, /v1\/files\/a_vid#t=12,30/);
  assert.match(P.personaLine(p), /persona \$0\.43 · 2 lost stretches \(48 s\)/);
});

test('a play with no persona events says it was not reported, never "never lost"', () => {
  const p = P.personaOf({ events: [] }, 'desktop');
  assert.equal(p.reported, false);
  assert.match(P.personaLines(p).join(''), /didn't report/);
});

test('one persona run per game, device and week: the second claim starts nothing', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  assert.equal(P.claimPersona('g', 'desktop', now), true);
  assert.equal(P.claimPersona('g', 'desktop', now + 3 * 86400_000), false);
  assert.equal(P.claimPersona('g', 'phone', now), true);
  assert.equal(P.claimPersona('g', 'phone', now), false);
  assert.equal(P.claimPersona('other', 'desktop', now), true);
  assert.equal(P.claimPersona('g', 'desktop', now + 7 * 86400_000), true); // next Monday on
  assert.equal(P.weekOf(Date.parse('2026-11-15T23:00:00Z')), '2026-11-09');
});

test('each lost stretch is one finding with its clip, filed once', () => {
  const p = P.personaOf(result, 'desktop');
  const now = Date.parse('2026-11-11T12:00:00Z');
  const a = P.filePersonaFindings('g', p, 'r1', 'first-five@local', now);
  const b = P.filePersonaFindings('g', p, 'r1', 'first-five@local', now);
  assert.equal(a.length, 2);
  assert.deepEqual(a, b);
  const rows = db.prepare(`SELECT * FROM findings WHERE product = 'g' AND source = 'persona' ORDER BY title`).all() as any[];
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => /Clip: .*a_vid#t=/.test(r.detail) && r.area === 'clarity'));
  assert.ok(rows.some((r) => r.severity === 'bug') && rows.some((r) => r.severity === 'polish'));
  assert.match(rows[0].shots, /a_vid/);
});
