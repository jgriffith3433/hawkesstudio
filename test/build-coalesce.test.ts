// Builds don't pile up in Hawkes Gen's queue (2026-11-10: four Yooba Land builds and two of Sick of It waited hours for
// Gen's two builders): a newer commit of the same branch cancels older builds that haven't started building, a change's
// newest build replaces its older ones, and a build waiting for a builder says it's queued and where it is in line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-coalesce-'));
const { db } = await import('../src/db.ts');
const { supersedeOlder, genStepWords } = await import('../src/builds.ts');
const { runCancelled } = await import('../src/cancel.ts');

function row(id: string, run: string, o: { sha: string; ref?: string; change?: string | null; job?: string | null; started?: number }) {
  db.prepare(`INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, 'build', 'running', 'x', '[]', '{}', ?)`).run(run, Date.now());
  db.prepare(`INSERT INTO builds (id, product, build, version, status, sha, ref, runner, target, run, change, started, gen_job) VALUES (?, 'yb', 'web', ?, 'building', ?, ?, 'gen', 'web', ?, ?, ?, ?)`)
    .run(id, -Math.floor(Math.random() * 1e9), o.sha, o.ref ?? 'beta', run, o.change ?? null, o.started ?? Date.now(), o.job ?? null);
}

test('a newer commit cancels older queued builds of the same branch; one already building in Gen is left to finish', async () => {
  row('b_old_q', 'r_old_q', { sha: 'aaa1111', job: 'j_q', started: 1 });
  row('b_old_b', 'r_old_b', { sha: 'bbb2222', job: 'j_b', started: 2 });
  row('b_other', 'r_other', { sha: 'ccc3333', ref: 'main', started: 3 });
  row('b_none', 'r_none', { sha: 'ddd4444', started: 4 }); // not submitted to Gen yet
  genStepWords({ status: 'queued', detail: 'waiting: 2 builder-cloud jobs already running' }, 'b_old_q');
  genStepWords({ status: 'running', progress: { step: 'importing' } }, 'b_old_b');
  row('b_new', 'r_new', { sha: 'eee5555', started: 5 });
  const cancelled = await supersedeOlder({ product: 'yb', build: 'web', row: 'b_new', run: 'r_new', sha: 'eee5555', ref: 'beta', change: null });
  assert.deepEqual(cancelled.sort(), ['r_none', 'r_old_q']);
  assert.ok(runCancelled('r_old_q'));
  assert.ok(!runCancelled('r_old_b'));
  assert.ok(!runCancelled('r_other'));
});

test("a change's newer build replaces its older ones, started or not", async () => {
  row('b_c1', 'r_c1', { sha: 'aaa', change: 'c_x', job: 'j_c1' });
  genStepWords({ status: 'running', progress: { step: 'building' } }, 'b_c1');
  row('b_c2', 'r_c2', { sha: 'aaa', change: 'c_x' });
  assert.deepEqual(await supersedeOlder({ product: 'yb', build: 'web', row: 'b_c2', run: 'r_c2', sha: 'aaa', ref: 'task/x', change: 'c_x' }), ['r_c1']);
});

test('a build waiting for a Gen builder says it is queued and its place in line', () => {
  row('b_q1', 'r_q1', { sha: 'q1', ref: 'dev', started: 100 });
  row('b_q2', 'r_q2', { sha: 'q2', ref: 'dev2', started: 200 });
  genStepWords({ status: 'queued', detail: 'waiting: 2 builder-cloud jobs already running' }, 'b_q1');
  const w = genStepWords({ status: 'queued', detail: 'waiting: 2 builder-cloud jobs already running' }, 'b_q2')!;
  assert.match(w, /^queued in Hawkes Gen: \d+(st|nd|rd|th) of \d+ waiting \(waiting: 2 builder-cloud jobs already running\)$/);
  assert.match(genStepWords({ status: 'running', progress: { step: 'importing assets' } }, 'b_q1')!, /^Hawkes Gen: importing assets$/);
  assert.equal(genStepWords({ status: 'running', detail: 'compiling' }), 'Hawkes Gen: compiling');
});
