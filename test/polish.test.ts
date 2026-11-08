// The polish list (polish.ts; the owner's gaps list, 2026-11-08): polish never expires, it is ordered by player pain,
// and a game whose last polish pass is a week old gets one change on its worst items after the daily run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-polish-'));
const { db } = await import('../src/db.ts');
const { absorb, expireIdeas, getFinding } = await import('../src/backlog.ts');
const P = await import('../src/polish.ts');
// The changes table (agents.ts makes it; a minimal copy here keeps the test off the agent machinery).
db.exec(`CREATE TABLE IF NOT EXISTS changes (id TEXT PRIMARY KEY, product TEXT NOT NULL, findings TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, started_by TEXT)`);

const pol = (title: string, detail = 'd') => ({ severity: 'polish', title, detail, fix: 'x' });
const DAY = 86_400_000;

test('pain: camera and controls over visuals over text; seen more and seen lately count', () => {
  const now = Date.now();
  const base = { severity: 'polish', seen: 1, area: null, detail: '', last_seen: now };
  const cam = P.painScore({ ...base, title: 'Camera snaps behind the player at the bridge' }, now);
  const vis = P.painScore({ ...base, title: 'Fountain texture is stretched' }, now);
  const txt = P.painScore({ ...base, title: 'Menu label is cramped' }, now);
  assert.ok(cam > vis && vis > txt, `${cam} ${vis} ${txt}`);
  assert.ok(P.painScore({ ...base, title: 'Menu label is cramped', seen: 10 }, now) > txt);
  assert.ok(P.painScore({ ...base, title: 'Menu label is cramped', last_seen: now - 30 * DAY }, now) < txt);
});

test('polish never expires and the list is worst first; old expired polish comes back once', () => {
  absorb('g1', 'r_1', 'smoke@local', [pol('Menu label is cramped'), pol('Camera jitters on the stairs'), pol('Fountain texture is stretched'), { severity: 'idea', title: 'Add a photo mode', detail: 'd', fix: 'x' }]);
  db.prepare(`UPDATE findings SET last_seen = ? WHERE product = 'g1'`).run(Date.now() - 20 * DAY);
  assert.equal(expireIdeas(), 1, 'only the idea expires');
  const list = P.polishList('g1');
  assert.deepEqual(list.map((f) => f.title), ['Camera jitters on the stairs', 'Fountain texture is stretched', 'Menu label is cramped']);
  // Polish that expired under the old rule.
  db.prepare(`UPDATE findings SET status = 'expired' WHERE id = ?`).run(list[2].id);
  assert.equal(P.restoreExpiredPolish(), 1);
  assert.equal(getFinding(list[2].id)!.status, 'idea');
  assert.equal(P.restoreExpiredPolish(), 0, 'once');
});

test('the weekly pass: due games get one change on their worst items, then wait a week', () => {
  const now = Date.now();
  absorb('g2', 'r_2', 'smoke@local', ['Crate floats above the dock', 'Barrel sinks into the pier', 'Lamp post flickers at night', 'Shop sign is cramped', 'Boat hull texture stretched', 'Gull animation pops', 'Harbour wall seam shows'].map((t) => pol(t)));
  const calls: any[] = [];
  const start = (product: string, findings: string[], o: any) => {
    calls.push({ product, findings, o });
    const id = `c_${calls.length}`;
    db.prepare('INSERT INTO changes (id, product, findings, status, created, started_by) VALUES (?, ?, ?, ?, ?, ?)').run(id, product, JSON.stringify(findings), 'queued', now, o.by);
    return id;
  };
  const r = P.weeklyPolish([{ id: 'g1' }, { id: 'g2' }, { id: 'empty' }], start, now);
  assert.deepEqual(r.started.map((x) => x.product), ['g1', 'g2']);
  assert.equal(calls[1].findings.length, P.POLISH_BATCH);
  assert.equal(calls[0].o.by, P.POLISH_BY);
  assert.equal(P.weeklyPolish([{ id: 'g1' }, { id: 'g2' }], start, now + 3 * DAY).started.length, 0, 'not again within the week');
  assert.equal(P.weeklyPolish([{ id: 'g1' }], start, now + 8 * DAY).started.length, 1, 'due again after a week');
  const failing = P.weeklyPolish([{ id: 'g2' }], () => { throw new Error("Today's agent budget is used"); }, now + 8 * DAY);
  assert.deepEqual(failing.skipped, [{ product: 'g2', why: "Today's agent budget is used" }]);
});
