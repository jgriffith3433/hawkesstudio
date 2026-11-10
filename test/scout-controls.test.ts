// Scouts as first-class agents: cancel, re-run, follow-up, live progress (scout.ts, cancel.ts routes, activity.ts scoutRow).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-scout-ctl-'));
process.env.STUDIO_PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-scout-ctl-proj-'));
const sc = await import('../src/scout.ts');
const { db } = await import('../src/db.ts');
const { scoutRow } = await import('../src/activity.ts');
const { cancelRoute } = await import('../src/cancel.ts');

const add = (id: string, status: string, extra = '') => db.prepare(`INSERT INTO scouts (id, product, question, status, detail, created${extra ? ', report' : ''}) VALUES (?, 'p', 'what?', ?, 'reading', ?${extra ? ', ?' : ''})`).run(...[id, status, Date.now(), ...(extra ? [extra] : [])]);

test('the stream keeps the session and counts steps for live progress', () => {
  const st = sc.newScoutStream();
  const tools: string[] = [];
  sc.feedScoutLine(st, { type: 'assistant', session_id: 's-1', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }] } }, (d) => tools.push(d));
  sc.feedScoutLine(st, { type: 'assistant', message: { content: [{ type: 'text', text: 'found it, here is what is there' }] } });
  assert.equal(st.session, 's-1');
  assert.equal(st.steps, 2);
  assert.match(tools[0], /^Read /);
});

test('cancelling a running scout marks it cancelled and records who; a finished one is refused', async () => {
  add('x_run1', 'running');
  const r = sc.cancelScout('x_run1', 'J', 'stuck');
  assert.equal(r.status, 'cancelled');
  assert.equal(r.cancelled?.by, 'J');
  assert.match(r.detail!, /cancelled by J \(stuck\)/);
  assert.throws(() => sc.cancelScout('x_run1', 'J'), /not running/);
  assert.throws(() => sc.cancelScout('x_nope', 'J'), /No such scout/);
});

test('the cancel route reaches scouts', async () => {
  add('x_abc2', 'running');
  const r: any = await cancelRoute('/api/scouts/x_abc2/cancel', 'POST', 'Talk', { reason: 'too long' });
  assert.equal(r.ok, true);
  assert.equal(r.scout.status, 'cancelled');
});

test('re-run and follow-up refuse a scout that is still running; follow-up needs a message', () => {
  add('x_run3', 'running');
  assert.throws(() => sc.rerunScout('x_run3'), /still running/);
  assert.throws(() => sc.followUpScout('x_run3', 'and?'), /still running/);
  add('x_done1', 'done', 'a report');
  assert.throws(() => sc.followUpScout('x_done1', '  '), /Say what to ask/);
});

test('an Activity row carries progress, cost, model, and the cancel note', () => {
  add('x_run4', 'running');
  db.prepare("UPDATE scouts SET turns = 7, log = ?, cost = 0.3 WHERE id = 'x_run4'").run(JSON.stringify(['Read a', 'Grep b']));
  const row = scoutRow(db.prepare('SELECT * FROM scouts WHERE id = ?').get('x_run4'));
  assert.equal(row.turns, 7);
  assert.deepEqual(row.log, ['Read a', 'Grep b']);
  assert.equal(row.cost, 0.3);
  sc.cancelScout('x_run4', 'J');
  const after = scoutRow({ ...(db.prepare('SELECT * FROM scouts WHERE id = ?').get('x_run4') as any), report: 'partial' });
  assert.equal(after.status, 'cancelled');
  assert.equal(after.cancelled?.by, 'J');
});

test('a scout on a provider J names: refused with the reason when that provider is not ready, or not a provider', () => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
  assert.throws(() => sc.startScout('p', 'which provider?', null, { provider: 'gemini' }), /Gemini.* can't take a scout now: not signed in here/);
  assert.throws(() => sc.startScout('p', 'which provider?', null, { provider: 'grok' }), /provider: claude \| /);
});

test('the scout view names the provider it ran on', () => {
  add('x_prov1', 'done', 'a report');
  db.prepare("UPDATE scouts SET harness = 'cursor' WHERE id = 'x_prov1'").run();
  assert.equal((sc.getScoutView('x_prov1') as any).harness, 'cursor');
});
