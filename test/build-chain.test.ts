// The failure chain (buildfix.ts): a fix that merges into beta rebuilds the same build id even when that build only runs
// on a tag, the rebuild is the verification (a pass closes the chain, other errors continue it, the same errors stop it),
// and the red card says "fix merged, rebuilding" instead of "someone has to fix the code first". Stand-ins only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-chain-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'tagonly', name: 'Tag Only', framing: 'test', engine: 'unity', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/', github: 'acme/tagonly',
  local: { serve: 'static', dir: 'site', port: 8797, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
  builds: [{ id: 'web', tool: 'unity', target: 'web', on: ['tag'] }],
}] }));

const { db } = await import('../src/db.ts');
await import('../src/agents.ts');
const X = await import('../src/buildfix.ts');
const F = await import('../src/buildfail.ts');

const E1 = "Assets/Scripts/YoobaThirdPersonCamera.cs(120,31): error CS0103: The name 'dt' does not exist in the current context";
const E2 = "Assets/Scripts/YoobaTunnel.cs(40,12): error CS0102: The type 'YoobaTunnel' already contains a definition for 'Find'";
let n = 0;
const row = (err: string, o: Record<string, unknown> = {}) => {
  const r = { id: `b_${(++n).toString(16).padStart(12, '0')}`, product: 'tagonly', build: 'web', version: 26 + n, status: 'failed', sha: `${n}`.padStart(40, 'a'), ref: 'beta', runner: 'gen', target: 'web',
    started: Date.now() - 60_000 + n, finished: Date.now() - 30_000 + n, detail: `the Unity build failed: ${err}`, fail_class: 'compile', fail_kind: 'code', fail_plain: F.classify(`the Unity build failed: ${err}`).plain, fail_log: `${err}\nBuild failed`, ...o };
  db.prepare(`INSERT INTO builds (${Object.keys(r).join(', ')}) VALUES (${Object.keys(r).map(() => '?').join(', ')})`).run(...Object.values(r) as any[]);
  return r.id as string;
};
let cn = 0;
const started: string[] = [];
const deps = () => ({
  allowed: () => true,
  culprits: async () => [],
  start: (product: string, request: string, o: { title: string }) => {
    const id = `c_chain${++cn}`;
    started.push(request);
    db.prepare("INSERT INTO changes (id, product, findings, status, repo, slug, branch, base, worktree, request, notes, log, created, title) VALUES (?, ?, '[]', 'queued', 'r', 'acme/tagonly', ?, 'beta', '/tmp/none', ?, '[]', '[]', ?, ?)").run(id, product, `task/${id}`, request, Date.now(), o.title);
    return id;
  },
});
const setStatus = (id: string, s: string) => db.prepare('UPDATE changes SET status = ? WHERE id = ?').run(s, id);

test('a merged fix rebuilds the same build id, tag-only builds included, and the card says so', async () => {
  const failed = row(E1);
  const r = await X.autoFixBuild(failed, deps());
  assert.ok(r.started, r.why);
  // While the fixer works: the red card names it, never "someone has to fix the code first".
  let red = F.failingBuilds('tagonly')[0];
  assert.equal(red.fix?.state, 'working');
  assert.doesNotMatch(red.plain, /someone has to fix the code first/);
  assert.match(red.plain, /Studio rebuilds by itself/);

  const asked: [string, string][] = [];
  setStatus(r.started!, 'merged');
  const ok = await X.fixMerged(r.started!, { rebuild: async (product, build) => { asked.push([product, build]); return { id: 'r_rebuild1' }; } });
  assert.equal(ok, true);
  assert.deepEqual(asked, [['tagonly', 'web']], 'the same build id on the project, with no trigger (a tag-only build still runs)');
  const again = await X.fixMerged(r.started!, { rebuild: async () => { throw new Error('must not rebuild twice'); } });
  assert.equal(again, true, 'a second call of the merge asks nothing more');
  assert.equal(asked.length, 1);

  red = F.failingBuilds('tagonly')[0];
  assert.equal(red.fix?.state, 'merged');
  assert.match(red.plain, /Fix merged into beta .*rebuilding/);
  assert.doesNotMatch(red.plain, /someone has to fix the code first/);
  assert.equal(X.openChain('tagonly', 'web')!.attempts[0].rebuild?.run, 'r_rebuild1');
});

test('the rebuild passing closes the chain: the fix is verified by the build, not by the fixer', async () => {
  assert.equal(X.openChain('tagonly', 'web')?.attempts.length, 1);
  X.buildPassed('tagonly', 'web');
  assert.equal(X.openChain('tagonly', 'web'), null);
  const c = X.latestChain('tagonly', 'web')!;
  assert.equal(c.status, 'passed');
  assert.match(c.reason ?? '', /rebuild passed after 1 fix attempt/);
});

test('a rebuild that fails with another error continues the chain; the same error escalates, and the Inbox card links the changes', async () => {
  const f1 = row(E1);
  const a = await X.autoFixBuild(f1, deps());
  assert.ok(a.started, a.why);
  setStatus(a.started!, 'merged');
  await X.fixMerged(a.started!, { rebuild: async () => ({ id: 'r_2' }) });
  const f2 = row(E2); // the rebuild failed, with a different error
  const b = await X.autoFixBuild(f2, deps());
  assert.ok(b.started, b.why);
  assert.match(started.at(-1)!, /dt' does not exist/, 'the next fixer is told what the first one was given');
  setStatus(b.started!, 'merged');
  await X.fixMerged(b.started!, { rebuild: async () => ({ id: 'r_3' }) });
  const f3 = row(E2); // fails with the SAME error after the second fix merged
  const c = await X.autoFixBuild(f3, deps());
  assert.equal(c.started, null);
  assert.equal(c.escalated, true);
  const chain = X.latestChain('tagonly', 'web')!;
  assert.equal(chain.status, 'escalated');
  assert.equal(chain.attempts.length, 2);

  // The Inbox card (inbox.ts) for the newest failed build lists what was tried and links each change.
  const { inbox } = await import('../src/inbox.ts');
  const items = (await inbox()).filter((i) => i.kind === 'build' && i.product === 'tagonly');
  assert.equal(items.length, 1, 'one card, for the newest failure');
  assert.match(items[0].text ?? '', /it needs you/);
  assert.match(items[0].text ?? '', /What was tried:[\s\S]*Attempt 1[\s\S]*Attempt 2/);
  assert.deepEqual(items[0].links.filter((l) => l.label.startsWith('Attempt')).map((l) => l.url), [`#changes/${a.started}`, `#changes/${b.started}`]);
  assert.match(items[0].text ?? '', /same error/);
});

test('a rebuild that cannot start escalates instead of leaving a stale "rebuilding"', async () => {
  const f = row("Assets/Scripts/Other.cs(1,1): error CS0246: nope", { build: 'web' });
  // the previous chain is escalated, so this is a new chain
  const a = await X.autoFixBuild(f, deps());
  assert.ok(a.started, a.why);
  setStatus(a.started!, 'merged');
  await X.fixMerged(a.started!, { rebuild: async () => { throw new Error('Gen is down'); } });
  const chain = X.latestChain('tagonly', 'web')!;
  assert.equal(chain.status, 'escalated');
  assert.match(chain.reason ?? '', /rebuild could not start: Gen is down/);
});

test('a change that is not a build fixer\'s does nothing on merge', async () => {
  assert.equal(await X.fixMerged('c_not_a_fixer'), false);
});
