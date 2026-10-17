// Approving merges exactly the branch tip that was verified: never a pull request merged or closed outside Studio,
// never a head that moved after verification, never while an agent is still on the branch. GitHub is faked (fetch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-merge-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.GITHUB_TOKEN = 'test-token';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ repos: { site: 'owner/site' }, products: [{
  id: 'mergetest', name: 'Merge test', framing: 'test', engine: 'static', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: 'site', port: 8796, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
}] }));

const { db, J } = await import('../src/db.ts');
const { approve, getChange, syncMergedOutside, playtestChange } = await import('../src/agents.ts');

const VERIFIED = 'a'.repeat(40);
let pr: any;
const calls: { method: string; url: string; body: any }[] = [];
globalThis.fetch = (async (url: string, init: any = {}) => {
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ method, url, body });
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (method === 'GET' && url.endsWith('/pulls/7')) return json(200, pr);
  if (method === 'GET' && url.endsWith('/pulls/8')) return json(200, { state: 'open', merged: false, head: { sha: VERIFIED } });
  if (method === 'PUT' && url.endsWith('/pulls/7/merge')) return json(405, { message: 'stopped by the test' });
  if (url.includes('/pulls/7/files')) return json(200, []);
  return json(404, { message: 'not faked' });
}) as typeof fetch;

function change(status: string, verify: any) {
  const id = `c_${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;
  db.prepare('INSERT INTO changes (id, product, findings, status, repo, slug, branch, base, worktree, pr, pr_url, title, verify, notes, log, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'mergetest', '[]', status, 'site', 'owner/site', 'fix/x', 'beta', path.join(tmp, 'nowhere'), 7, 'https://github.com/owner/site/pull/7', 'Fix: x', J(verify), '[]', '[]', Date.now());
  return id;
}

test('a pull request merged outside Studio is not "merged" again', async () => {
  pr = { state: 'closed', merged: true, merged_at: '2026-10-16T16:43:54Z', head: { sha: 'b'.repeat(40) } };
  const id = change('ready', { sha: VERIFIED, verdict: 'ship' });
  await assert.rejects(approve(id, { confirm: `MERGE ${id}` }), /already merged.*not on beta/s);
  assert.equal(getChange(id)!.status, 'ready');
});

test('a head that moved after verification is refused', async () => {
  pr = { state: 'open', merged: false, head: { sha: 'c'.repeat(40) } };
  const id = change('ready', { sha: VERIFIED, verdict: 'ship' });
  await assert.rejects(approve(id, { confirm: `MERGE ${id}` }), /moved after verification/);
  assert.ok(!calls.some((c) => c.method === 'PUT'), 'no merge was attempted');
});

test('a change an agent is still working on is refused', async () => {
  pr = { state: 'open', merged: false, head: { sha: VERIFIED } };
  const id = change('revising', { sha: VERIFIED, verdict: 'ship' });
  await assert.rejects(approve(id, { confirm: `MERGE ${id}` }), /still moving/);
});

test('the merge names the verified commit, so GitHub refuses if the head moves meanwhile', async () => {
  pr = { state: 'open', merged: false, head: { sha: VERIFIED } };
  const id = change('ready', { sha: VERIFIED, verdict: 'ship', video: 'a_123' });
  await assert.rejects(approve(id, { confirm: `MERGE ${id}` }), /stopped by the test/);
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put?.body.sha, VERIFIED);
  assert.equal(put?.body.merge_method, 'squash');
});

test('changes carry real links (video, the change in Studio)', () => {
  const id = change('ready', { sha: VERIFIED, video: 'a_123', preview: 'https://x.hawkesgen.com/c/1/' });
  const c = getChange(id)!;
  assert.match(c.links.video!, /^https?:\/\/.+\/v1\/files\/a_123$/);
  assert.match(c.links.change, new RegExp(`^https?://[^#]+/#changes/${id}$`));
  assert.equal(c.links.pr, 'https://github.com/owner/site/pull/7');
  assert.equal(c.links.preview, 'https://x.hawkesgen.com/c/1/');
});

test('a pull request J merged on GitHub marks its change merged; one merged before later commits stays', async () => {
  // Merged at the commit Studio has on record: merged, no Approve card left.
  pr = { state: 'closed', merged: true, merged_at: '2026-10-16T18:00:00Z', merged_by: { login: 'jgriffith3433' }, merge_commit_sha: 'd'.repeat(40), head: { sha: VERIFIED } };
  for (const c of db.prepare(`SELECT id FROM changes WHERE status = 'ready'`).all() as any[]) db.prepare(`UPDATE changes SET status = 'closed' WHERE id = ?`).run(c.id);
  const merged = change('ready', { sha: VERIFIED });
  const open = change('ready', { sha: VERIFIED });
  db.prepare('UPDATE changes SET pr = 8 WHERE id = ?').run(open);
  const marked = await syncMergedOutside();
  assert.deepEqual(marked, [merged]);
  assert.equal(getChange(merged)!.status, 'merged');
  assert.match(getChange(merged)!.detail!, /outside Studio \(jgriffith3433 on GitHub/);
  assert.equal(getChange(open)!.status, 'ready', 'an open pull request stays ready');
  // Merged at an older head (the agent pushed more after): left for revise, as approve() says.
  pr = { state: 'closed', merged: true, merged_at: '2026-10-16T18:00:00Z', head: { sha: 'b'.repeat(40) } };
  const older = change('ready', { sha: VERIFIED });
  assert.deepEqual(await syncMergedOutside(), []);
  assert.equal(getChange(older)!.status, 'ready');
});

test('a playtest is asked for, never automatic: only for a ready product change with its worktree', () => {
  const working = change('working', { sha: VERIFIED });
  assert.throws(() => playtestChange(working), /working: a playtest can be asked for once it's ready/);
  const gone = change('ready', { sha: VERIFIED });
  assert.throws(() => playtestChange(gone), /worktree is gone/);
});

test('a ready product change merges into beta by itself; one that can\'t stays ready and Talk says why', async () => {
  const { autoMergeBeta } = await import('../src/agents.ts');
  const before = (db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as any).n;
  // GitHub refuses the merge (the fake answers 405): still ready, the reason on the change, one notice in Talk.
  pr = { state: 'open', merged: false, head: { sha: VERIFIED } };
  calls.length = 0;
  const id = change('ready', { sha: VERIFIED });
  assert.equal(await autoMergeBeta(id), null);
  assert.ok(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/pulls/7/merge')), 'the merge was tried, with no approval');
  const c = getChange(id)!;
  assert.equal(c.status, 'ready');
  assert.match(c.auto_merge!, /^failed: .*stopped by the test/);
  assert.match(c.detail!, /couldn't merge into beta by itself/);
  const notices = db.prepare('SELECT messages FROM conversations ORDER BY created DESC LIMIT 1').get() as any;
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as any).n, before + 1);
  assert.match(String(notices.messages), /couldn't merge into beta by itself.*stays ready/);
  // A canon conflict never merges by itself: no merge is tried.
  calls.length = 0;
  const canon = change('ready', { sha: VERIFIED, canon: { ok: false, summary: 'Vel is not a pilot', conflicts: [] } });
  await autoMergeBeta(canon);
  assert.ok(!calls.some((x) => x.method === 'PUT'), 'nothing was merged');
  assert.match(getChange(canon)!.auto_merge!, /contradicts the canon/);
});
