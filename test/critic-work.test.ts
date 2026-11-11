import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIMENSIONS } from '../src/critic.ts';
import { workFromCritic, openCriticTask } from '../src/pm.ts';
import { checkTask, effectiveBar } from '../src/taskbar.ts';
import { getTask, tasksOf } from '../src/roadmap.ts';
import { cleanTargets, targetFor, releaseFloorOf } from '../src/config.ts';
import { db } from '../src/db.ts';
await import('../src/agents.ts'); // creates the changes table

const review = (scores: Record<string, number>) => ({
  verdict: 'judged', scenario: 'chapter-2', next: [], references: [], summary: 's',
  scores: DIMENSIONS.map((dimension) => ({ dimension, score: scores[dimension] ?? 9, reference: 'Hades', frame: 'a_1', at: 't=12s', why: `why ${dimension}`, fix: `fix ${dimension} at the start` })),
});

test('targets and release floor: defaults 7 and 6, checked on the way in', () => {
  assert.equal(targetFor({}, 'sound'), 7);
  assert.equal(targetFor({ targets: { sound: 8 } }, 'sound'), 8);
  assert.equal(releaseFloorOf({}), 6);
  assert.deepEqual(cleanTargets({ Sound: 8 }, 5), { targets: { sound: 8 }, releaseFloor: 5 });
  assert.throws(() => cleanTargets({ taste: 8 }, null));
  assert.throws(() => cleanTargets({ sound: 11 }, null));
  assert.throws(() => cleanTargets(null, 0));
});

test('a critic review plans one task per dimension under target, and a second low score reuses it', () => {
  const product = 'doseofdestruction';
  db.prepare(`DELETE FROM tasks WHERE product = ? AND request LIKE '%[critic:%'`).run(product);
  const first = workFromCritic(product, review({ sound: 4, phone: 6, fun: 7 }), 'r_1');
  assert.equal(first.length, 2);
  const sound = openCriticTask(product, 'sound')!;
  const phone = openCriticTask(product, 'phone')!;
  assert.ok(sound && phone);
  assert.match(sound.title, /^sound 4\/10/);
  assert.equal(sound.status, 'planned');
  assert.equal(sound.priority, 'high', 'under the release floor (6)');
  assert.equal(phone.priority, 'normal', '6 is under the target (7) but not under the floor (6)');
  assert.equal(openCriticTask(product, 'fun'), null, '7 meets the default target');
  // The request carries the critic's evidence, its reference and its fix, and meets the task bar without a rewrite.
  assert.match(sound.request, /why sound/);
  assert.match(sound.request, /Hades/);
  assert.match(sound.request, /fix sound at the start/);
  assert.equal(checkTask({ ...sound, bar: effectiveBar(sound) }, 'game').ok, true, JSON.stringify(checkTask({ ...sound, bar: effectiveBar(sound) }, 'game')));
  // A second low score on the same dimension adds nothing.
  const again = workFromCritic(product, review({ sound: 3 }), 'r_2');
  assert.equal(again.length, 1);
  assert.match(again[0], /reused/);
  const all = tasksOf(sound.item).filter((t) => /\[critic:sound\]/.test(t.request));
  assert.equal(all.length, 1);
  assert.match(getTask(sound.id)!.title, /^sound 3\/10/, 'a planned task takes the newer evidence');
});

test("a dimension the critic couldn't judge, or an unjudged review, files nothing", () => {
  const product = 'doseofdestruction';
  const r = review({});
  (r.scores[5] as any).score = 1;
  (r.scores[5] as any).why = 'no evidence';
  const before = db.prepare(`SELECT COUNT(*) n FROM tasks WHERE product = ?`).get(product) as any;
  assert.deepEqual(workFromCritic(product, r, 'r_3').filter((l) => /sound/.test(l)), []);
  assert.deepEqual(workFromCritic(product, { verdict: 'unjudged', scores: [] }, 'r_4'), []);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM tasks WHERE product = ?`).get(product) as any).n, before.n);
});
