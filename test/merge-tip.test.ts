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
const { approve, getChange } = await import('../src/agents.ts');

const VERIFIED = 'a'.repeat(40);
let pr: any;
const calls: { method: string; url: string; body: any }[] = [];
globalThis.fetch = (async (url: string, init: any = {}) => {
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ method, url, body });
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (method === 'GET' && url.endsWith('/pulls/7')) return json(200, pr);
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
