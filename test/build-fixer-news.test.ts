// The owner hears what the build fixer is doing (buildfix.ts fixerNow, fixedWording): a fix agent working or merged replaces
// "someone has to fix the code first" on the Inbox card and the push, the card's link goes to the change, and a red beta
// build tells the agents running on that product (tellRunningAgents: a file in their worktree, a line in their log, a
// lesson candidate). Stand-ins only: no GitHub, no agent process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-fixer-news-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'newsgame', name: 'News Game', framing: 'test', engine: 'unity', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/', github: 'acme/newsgame',
  local: { serve: 'static', dir: 'site', port: 8798, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
  builds: [{ id: 'web', tool: 'unity', target: 'web' }],
}] }));

const { db } = await import('../src/db.ts');
await import('../src/agents.ts'); // makes the changes table
const X = await import('../src/buildfix.ts');
const F = await import('../src/buildfail.ts');

const CS = "Assets/Scripts/Tunnel.cs(40,12): error CS0102: The type 'Tunnel' already contains a definition for 'Find'";
let n = 0;
const failedRow = (o: Record<string, unknown> = {}) => {
  const r = { id: `b_${(++n).toString(16).padStart(12, '0')}`, product: 'newsgame', build: 'web', version: n, status: 'failed', sha: 'a1b2c3d4e5f60000000000000000000000000000', ref: 'beta', runner: 'gen', target: 'web',
    started: Date.now() - 60_000 + n, detail: `the Unity build failed: ${CS}`, fail_class: 'compile', fail_kind: 'code', fail_plain: F.classify(`the Unity build failed: ${CS}`).plain,
    fail_log: `--- Unity log ---\n${CS}\nBuild failed`, ...o };
  db.prepare(`INSERT INTO builds (${Object.keys(r).join(', ')}) VALUES (${Object.keys(r).map(() => '?').join(', ')})`).run(...Object.values(r) as any[]);
  return r;
};
let cn = 0;
const addChange = (status: string, o: { request?: string; worktree?: string; title?: string; product?: string } = {}) => {
  const id = `c_news${(++cn).toString(16).padStart(6, '0')}`;
  db.prepare("INSERT INTO changes (id, product, findings, status, repo, slug, branch, base, worktree, request, notes, log, created, title) VALUES (?, ?, '[]', ?, 'r', 'acme/newsgame', ?, 'beta', ?, ?, '[]', '[]', ?, ?)")
    .run(id, o.product ?? 'newsgame', status, `task/${id}`, o.worktree ?? path.join(tmp, id), o.request ?? 'a feature', Date.now(), o.title ?? `Change ${id}`);
  return id;
};
const deps = (): Parameters<typeof X.autoFixBuild>[1] => ({
  allowed: () => true,
  culprits: async () => [],
  start: (product: string, request: string, o: { title: string }) => {
    const id = addChange('queued', { request, title: o.title, product });
    return id;
  },
});

test('a fixer working on a code failure is what the card and the push say; the link goes to its change', async () => {
  const row = failedRow();
  const r = await X.autoFixBuild(row.id, deps());
  assert.ok(r.started, r.why);
  const now = X.fixerNow(F.failSignature(row as any));
  assert.equal(now.state, 'working');
  assert.equal(now.change, r.started);
  assert.equal(now.url, `#changes/${r.started}`);
  const said = X.fixedWording(F.classify(`the Unity build failed: ${CS}`).plain, now);
  assert.doesNotMatch(said, /someone has to fix the code first/, 'a fixer replaces the needs-a-person sentence');
  assert.match(said, /A fix agent is working on it \(change c_news/);
  assert.match(said, /error CS0102|project's code doesn't build/, 'the reason stays');
});

test('a merged fix says so; with no fixer the needs-a-person wording stays (infrastructure and exhausted too)', () => {
  const sig = 'merged-sig-test|compile|x';
  // Build a marker for this signature the way buildfix does, then read the state back.
  const marker = X.fixMarker(sig);
  db.prepare("INSERT INTO changes (id, product, findings, status, repo, slug, branch, base, worktree, request, notes, log, created, title) VALUES (?, 'newsgame', '[]', 'merged', 'r', 'acme/newsgame', 'b', 'beta', '/tmp/none', ?, '[]', '[]', ?, 'Fix build: Find')")
    .run('c_mergedfix1', `Fix build\n<!-- ${marker} -->`, Date.now());
  const merged = X.fixerNow(sig);
  assert.equal(merged.state, 'merged');
  assert.equal(merged.change, 'c_mergedfix1');
  assert.match(X.fixSentence(merged), /merged into beta/);

  const plain = "The project's code doesn't build (error CS0102). Studio can't fix this by building again: someone has to fix the code first.";
  assert.doesNotMatch(X.fixedWording(plain, merged), /someone has to fix/);
  const none = X.fixerNow('no-fixer-at-all|compile|y');
  assert.equal(none.state, 'none');
  assert.equal(X.fixedWording(plain, none), plain, 'no fixer keeps the wording');
  assert.equal(X.fixedWording('It is infrastructure.', none), 'It is infrastructure.');
  assert.match(X.fixedWording(plain, { state: 'exhausted', change: null, title: null, url: null }), /someone has to fix/, 'attempts used up keeps the wording');
});

test('a red beta build tells the running agents of that product why, by a file in their worktree', async () => {
  const wt = path.join(tmp, 'wt-running');
  fs.mkdirSync(wt, { recursive: true });
  const running = addChange('working', { worktree: wt, request: 'add a tunnel' });
  const elsewhere = addChange('working', { product: 'othergame', worktree: path.join(tmp, 'wt-other') });
  const merged = addChange('merged', { worktree: path.join(tmp, 'wt-merged') });
  const row = failedRow({ version: 99 }) as any;
  const told = await X.tellRunningAgents(row);
  assert.equal(told, 1, 'only the running agent of this product');
  const text = fs.readFileSync(path.join(wt, X.BETA_RED_FILE), 'utf8');
  assert.match(text, /Beta's build is red/);
  assert.match(text, /error CS0102: The type 'Tunnel' already contains a definition for 'Find'/, 'the error text is in it');
  assert.match(text, /a1b2c3d/, 'the commit');
  assert.equal(fs.existsSync(path.join(tmp, 'wt-other', X.BETA_RED_FILE)), false);
  assert.equal(fs.existsSync(path.join(tmp, 'wt-merged', X.BETA_RED_FILE)), false);
  const lesson = db.prepare("SELECT kind, status, product FROM memories WHERE product = 'newsgame' AND kind = 'lesson' AND title LIKE ?").get("%Beta's newsgame build failed%") as any;
  assert.ok(lesson, 'a lesson candidate is filed for a code failure');
  assert.equal(lesson.status, 'candidate', 'an agent-side lesson waits for the PM to review it');
  assert.ok(running && elsewhere && merged);
});

test('the brief tells a Unity agent to read the red-beta file before its pull request', () => {
  const brief = X.buildCheckBrief({ engine: 'unity' });
  assert.match(brief, new RegExp(X.BETA_RED_FILE.replace(/[.]/g, '\\.')));
  assert.equal(X.buildCheckBrief({ engine: 'web' }), '', 'no build, no line');
});
