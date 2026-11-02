// Agents with Talk's powers (access.ts; J, 2026-11-02): Gen files from the Studio's own library or its owners' own
// hawkesgen.ai libraries, never another customer's; read-only copies of the other repos; a few tasks of their own; and a
// word to Talk (and so the owner) while they work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-access-'));
process.env.STUDIO_DATA = scratch;
process.env.TALK_FOLLOWUP_BATCH_MS = '60000';

const { db } = await import('../src/db.ts');
await import('../src/agents.ts');
const { startConversation, getConversation } = await import('../src/talk.ts');
const A = await import('../src/access.ts');
const { safeRepoPath, writeImport } = await import('../src/repo-write.ts');
const { originOf } = await import('../src/followup.ts');

const addChange = (id: string, o: { status?: string; origin?: string | null; startedBy?: string | null; product?: string } = {}) => {
  db.prepare('INSERT INTO changes (id, product, findings, status, worktree, notes, log, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, o.product ?? 'shop', '[]', o.status ?? 'working', path.join(scratch, id), '[]', '[]', Date.now(), Date.now());
  db.prepare('UPDATE changes SET origin = ?, started_by = ? WHERE id = ?').run(o.origin ?? null, o.startedBy ?? null, id);
};

test('access is on unless the Studio or the project turns it off; the project wins', () => {
  assert.deepEqual(A.accessFor(null, null), { gen: true, repos: true });
  assert.deepEqual(A.accessFor({ gen: false }, null), { gen: false, repos: true });
  assert.deepEqual(A.accessFor({ gen: false, repos: false }, { repos: true }), { gen: false, repos: true });
});

test("a cell's Gen files: its own org's, and its owners' own accounts only", () => {
  const owners = new Set(['u_5b0cfc84486e']);
  assert.equal(A.genSourceOk('org_aa11', { own: 'org_aa11', owners }), 'own');
  assert.equal(A.genSourceOk('org_aa11.shop', { own: 'org_aa11', owners }), 'own');
  assert.equal(A.genSourceOk('org_aa11x', { own: 'org_aa11', owners }), null, 'a lookalike org');
  assert.equal(A.genSourceOk('org_bb22.shop', { own: 'org_aa11', owners }), null, "another customer's");
  assert.equal(A.genSourceOk('u_5b0cfc84486e', { own: 'org_aa11', owners }), 'owner');
  assert.equal(A.genSourceOk('u_000000000000', { own: 'org_aa11', owners }), null, "someone else's account");
  // J's Studio: its own projects, never a customer's org or a stranger's account.
  assert.equal(A.genSourceOk('hawkes-biomedical', { own: null, owners: new Set() }), 'own');
  assert.equal(A.genSourceOk('org_aa11.shop', { own: null, owners: new Set() }), null);
  assert.equal(A.genSourceOk('u_5b0cfc84486e', { own: null, owners: new Set() }), null);
});

test('the control plane hands out a file only from the org or its verified owners', async () => {
  const assets: Record<string, any> = { a_11111111: { project: 'u_5b0cfc84486e', title: 'Lab', path: 'x.png' }, a_22222222: { project: 'org_bb22.game' }, a_33333333: { project: 'u_999999999999' } };
  const admin = async (p: string) => {
    if (p.startsWith('/assets/')) { const a = assets[p.slice(8)]; if (!a) throw new Error('404'); return a; }
    if (p.startsWith('/admin/accounts')) return { items: [{ email: 'Owner@Example.com', project: 'u_5b0cfc84486e' }, { email: 'owner@example.com.evil', project: 'u_999999999999' }] };
    throw new Error(p);
  };
  const bytes = async () => ({ bytes: Buffer.from('png'), mime: 'image/png' });
  const base = { genOrg: 'org_aa11', ownerEmails: ['owner@example.com'], admin, bytes };
  const ok = await A.controlGenAsset({ ...base, asset: 'a_11111111', wantOwners: true });
  assert.equal(ok.via, 'owner');
  assert.equal(ok.ext, '.png');
  await assert.rejects(A.controlGenAsset({ ...base, asset: 'a_11111111', wantOwners: false }), /personal Hawkes Gen library/);
  await assert.rejects(A.controlGenAsset({ ...base, asset: 'a_22222222', wantOwners: true }), (e: any) => e.status === 404 && !/org_bb22/.test(e.message), "another org's file, named nowhere");
  await assert.rejects(A.controlGenAsset({ ...base, asset: 'a_33333333', wantOwners: true }), (e: any) => e.status === 404, 'an email that only starts like the owner');
  await assert.rejects(A.controlGenAsset({ ...base, asset: '../x', wantOwners: true }), (e: any) => e.status === 400);
});

test('an import resizes in the Studio\'s own library and returns the bytes', async () => {
  const calls: string[] = [];
  const f = await A.importGenFile({ asset: 'a_11111111', product: 'shop', width: 900, height: 900, format: 'jpg', quality: 82 }, {
    access: async () => ({ gen: true, repos: true }), ownOrg: () => 'org_aa11', inCell: () => true,
    ownAsset: async () => null, ownBytes: async () => { throw new Error('not here'); },
    cellAsset: async (_a, owners) => { calls.push(`cell owners=${owners}`); return { bytes: Buffer.from('orig'), mime: 'image/png', project: 'u_5b0cfc84486e', title: 'Lab', ext: '.png', via: 'owner' }; },
    ownerProjects: async () => new Set(),
    copyIn: async (p) => { calls.push(`copy ${p}`); return 'a_copy0001'; },
    transform: async (_p, asset, step) => { calls.push(`transform ${asset} ${JSON.stringify(step)}`); return { asset: 'a_made0001', bytes: Buffer.from('jpg'), mime: 'image/jpeg' }; },
  });
  assert.equal(f.bytes.toString(), 'jpg');
  assert.equal(f.ext, '.jpg');
  assert.equal(f.made, 'a_made0001');
  assert.deepEqual(calls, ['cell owners=true', 'copy shop', 'transform a_copy0001 {"ops":[{"op":"resize","width":900,"height":900,"fit":"cover"}],"format":"jpg","quality":82}']);
  assert.equal(A.transformOf({}), null, 'no options: the file as it is');
  assert.throws(() => A.transformOf({ quality: 0 }), /quality/);
  assert.equal(A.formatOfPath('assets/a.JPEG'), 'jpg');
});

test('the file lands inside the repo, never outside it or in .git', () => {
  const root = fs.mkdtempSync(path.join(scratch, 'repo-'));
  for (const bad of ['/etc/x', '../x', 'a/../../x', '.git/config', 'C:/x', '']) assert.throws(() => safeRepoPath(bad), /path/, bad);
  const dest = writeImport(root, 'assets/medical/lab-hero.jpg', Buffer.from('x'));
  assert.equal(fs.readFileSync(dest, 'utf8'), 'x');
  assert.ok(dest.startsWith(root + path.sep));
});

test('an agent starts a few tasks, and those start none', () => {
  addChange('c_aaaaaaaaaaa1');
  assert.equal(A.agentStarts(''), null, 'not an agent');
  assert.equal(A.agentStarts('c_aaaaaaaaaaa1'), 'c_aaaaaaaaaaa1');
  for (let i = 0; i < A.AGENT_STARTS; i++) addChange(`c_bbbbbbbbbbb${i}`, { startedBy: 'agent c_aaaaaaaaaaa1' });
  assert.throws(() => A.agentStarts('c_aaaaaaaaaaa1'), (e: any) => e.status === 429);
  assert.throws(() => A.agentStarts('c_bbbbbbbbbbb0'), /started by another agent/);
  addChange('c_ccccccccccc1', { status: 'ready' });
  assert.throws(() => A.agentStarts('c_ccccccccccc1'), /running agent/);
});

test('an agent tells Talk; what it starts reports to the same conversation', async () => {
  const conv = startConversation('Fix the shop');
  addChange('c_ddddddddddd1', { origin: conv.id });
  const r: any = await A.agentSays('c_ddddddddddd1', { text: 'Which hero image?', kind: 'question', options: ['A', 'B'], recommend: 'A' });
  assert.equal(r.to, 'talk');
  const last = getConversation(conv.id)!.messages.at(-1)!;
  assert.match(last.text, /c_ddddddddddd1\) asks: Which hero image\?/);
  assert.match(last.text, /Options: A \/ B/);
  assert.equal(originOf({ headers: { 'x-studio-agent': 'c_ddddddddddd1' } } as any), conv.id);
  assert.equal(originOf({ headers: { 'x-studio-agent': 'c_zzzzzzzzzzzz' } } as any), null);
  addChange('c_eeeeeeeeeee1');
  const q: any = await A.agentSays('c_eeeeeeeeeee1', { text: 'Ship the blue one?', kind: 'question' });
  assert.equal(q.to, 'inbox', 'no conversation: the owner\'s Inbox');
  await assert.rejects(A.agentSays('', { text: 'hi' }), (e: any) => e.status === 403);
});

test("the brief says what the agent reaches", () => {
  const b = A.accessBrief({ gen: true, repos: true }, [{ slug: 'o/site', dir: '../c_x.repos/site' }]);
  assert.match(b, /studio_gen_import/);
  assert.match(b, /studio_tell/);
  assert.match(b, /`o\/site`: `\.\.\/c_x\.repos\/site`/);
  assert.doesNotMatch(A.accessBrief({ gen: false, repos: false }, []), /other repositories/);
});
