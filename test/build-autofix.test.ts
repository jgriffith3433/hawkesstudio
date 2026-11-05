// A build that fails because of the code starts a fixer agent (buildfix.ts): only kind "code", one at a time per failure
// (failSignature), at most MAX_ATTEMPTS (3) per failure chain, the commit's origin named, and the agents' brief tells them to run the build
// check. Stand-ins for the agent start and GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-buildfix-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'bxgame', name: 'Build Fix Game', framing: 'test', engine: 'unity', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/', github: 'acme/bxgame',
  local: { serve: 'static', dir: 'site', port: 8799, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
  builds: [{ id: 'web', tool: 'unity', target: 'web' }],
}] }));

const { db } = await import('../src/db.ts');
await import('../src/agents.ts'); // makes the changes table
const X = await import('../src/buildfix.ts');
const F = await import('../src/buildfail.ts');

const CS = "Assets/Scripts/YoobaTunnel.cs(40,12): error CS0102: The type 'YoobaTunnel' already contains a definition for 'Find'";
let n = 0;
const row = (o: Record<string, unknown> = {}) => {
  const r = { id: `b_${(++n).toString(16).padStart(12, '0')}`, product: 'bxgame', build: 'web', version: n, status: 'failed', sha: 'e54503e0000000000000000000000000000000aa', ref: 'beta', runner: 'gen', target: 'web',
    started: Date.now() - 60_000 + n, detail: `the Unity build failed: ${CS}`, fail_class: 'compile', fail_kind: 'code', fail_log: `--- Unity log ---\n${CS}\nBuild failed`, ...o };
  db.prepare(`INSERT INTO builds (${Object.keys(r).join(', ')}) VALUES (${Object.keys(r).map(() => '?').join(', ')})`).run(...Object.values(r) as any[]);
  return r.id as string;
};
let cn = 0;
const started: { product: string; request: string; title: string }[] = [];
const deps = (over: Partial<Parameters<typeof X.autoFixBuild>[1]> = {}) => ({
  allowed: () => true,
  culprits: async () => [{ id: 'c_merged1', title: 'Add tunnel finder', task: 't_abc', pr_url: 'https://github.com/acme/bxgame/pull/7', at: Date.now() - 3600_000, files: ['Assets/Scripts/YoobaTunnel.cs'] }],
  start: (product: string, request: string, o: { title: string }) => {
    const id = `c_fix${++cn}`;
    started.push({ product, request, title: o.title });
    db.prepare("INSERT INTO changes (id, product, findings, status, repo, slug, branch, base, worktree, request, notes, log, created) VALUES (?, ?, '[]', 'queued', 'r', 'acme/bxgame', ?, 'beta', ?, ?, '[]', '[]', ?)").run(id, product, `task/${id}`, `/tmp/${id}`, request, Date.now());
    return id;
  },
  ...over,
});

test('a code failure starts a fixer with the errors, the commit and the change it came from', async () => {
  const r = await X.autoFixBuild(row(), deps());
  assert.ok(r.started, r.why);
  const q = started[0];
  assert.equal(q.product, 'bxgame');
  assert.match(q.request, /error CS0102: The type 'YoobaTunnel' already contains a definition for 'Find'/);
  assert.match(q.request, /e54503e/);
  assert.match(q.request, /Add tunnel finder\*\* \(c_merged1, roadmap task t_abc/);
  assert.match(q.request, /touches Assets\/Scripts\/YoobaTunnel\.cs/);
  assert.match(q.title, /^Fix build: /);
});

test('the same failure again starts no second fixer while one is open', async () => {
  const before = started.length;
  const r = await X.autoFixBuild(row(), deps()); // same build, class and error: the same signature
  assert.equal(r.started, null);
  assert.match(r.why, /already fixing/);
  assert.equal(started.length, before);
});

test('the same errors again after a merged fix stop the chain: the owner\'s now, with what was tried', async () => {
  // The first fixer merged and the rebuild failed the very same way: another fixer would only repeat it.
  db.prepare("UPDATE changes SET status = 'merged' WHERE id = 'c_fix1'").run();
  const second = await X.autoFixBuild(row(), deps());
  assert.equal(second.started, null);
  assert.equal(second.escalated, true);
  assert.match(second.why, /same errors after a merged fix/);
  const chain = X.latestChain('bxgame', 'web')!;
  assert.equal(chain.status, 'escalated');
  assert.match(chain.reason ?? '', /same error/);
  assert.equal(chain.attempts.length, 1);
  assert.match(X.attemptsText(chain, { full: false }), /Attempt 1: change c_fix1/);
  const exhausted = X.fixerNow(F.failSignature(db.prepare('SELECT * FROM builds WHERE id = ?').get(`b_${(n).toString(16).padStart(12, '0')}`) as any), 'bxgame');
  assert.equal(exhausted.state, 'exhausted', 'the card keeps the needs-a-person wording');
});

test('other errors after a merged fix continue the chain with every earlier attempt\'s full error text, up to the cap', async () => {
  const err = (k: number) => `Assets/Scripts/Step${k}.cs(${k},3): error CS010${k}: step ${k} is broken`;
  const mk = (k: number) => row({ detail: `the Unity build failed: ${err(k)}`, fail_log: `${err(k)}\nBuild failed`, build: 'chainweb' });
  const before = started.length;
  const one = await X.autoFixBuild(mk(1), deps());
  assert.ok(one.started, one.why);
  assert.doesNotMatch(started[before].request, /Already tried/, 'the first fixer has no history');
  db.prepare("UPDATE changes SET status = 'merged' WHERE id = ?").run(one.started);
  const two = await X.autoFixBuild(mk(2), deps()); // the rebuild failed with another error
  assert.ok(two.started, two.why);
  const req2 = started[before + 1].request;
  assert.match(req2, /Already tried \(1 fix attempt/);
  assert.match(req2, /step 1 is broken/, 'attempt 1\'s error text is in the next fixer\'s request');
  assert.match(req2, /step 2 is broken/);
  db.prepare("UPDATE changes SET status = 'merged' WHERE id = ?").run(two.started);
  const three = await X.autoFixBuild(mk(3), deps());
  assert.ok(three.started, three.why);
  const req3 = started[before + 2].request;
  assert.match(req3, /Already tried \(2 fix attempts/);
  assert.match(req3, /Attempt 1[\s\S]*step 1 is broken[\s\S]*Attempt 2[\s\S]*step 2 is broken/, 'every earlier attempt, in order'); assert.match(req3, /step 3 is broken/, 'and what fails now');
  assert.match(req3, /Do not say the build is fixed/, 'the fixer is told the rebuild is the verdict, not its word');
  db.prepare("UPDATE changes SET status = 'merged' WHERE id = ?").run(three.started);
  const four = await X.autoFixBuild(mk(4), deps());
  assert.equal(four.started, null);
  assert.equal(four.escalated, true);
  assert.match(four.why, /3 fixers already tried/);
  const chain = X.latestChain('bxgame', 'chainweb')!;
  assert.equal(chain.status, 'escalated');
  assert.equal(chain.attempts.length, X.MAX_ATTEMPTS);
});

test('a different error is a different failure with its own attempts', async () => {
  const r = await X.autoFixBuild(row({ detail: 'the Unity build failed: Assets/Foo.cs(3,1): error CS1002: ; expected', fail_log: 'Assets/Foo.cs(3,1): error CS1002: ; expected' }), deps());
  assert.ok(r.started, r.why);
});

test('other failure kinds, agent previews and off switches start nothing', async () => {
  const before = started.length;
  for (const o of [{ fail_kind: 'infrastructure', fail_class: 'token', detail: 'GitHub token gone' }, { fail_kind: 'unknown', fail_class: 'other', detail: 'what?' }, { change: 'c_preview' }]) {
    const r = await X.autoFixBuild(row(o as any), deps());
    assert.equal(r.started, null);
  }
  const off = await X.autoFixBuild(row({ detail: 'the Unity build failed: Assets/Bar.cs(1,1): error CS0103: x' }), deps({ allowed: () => false }));
  assert.equal(off.started, null);
  assert.equal(started.length, before);
});

test('a failing blame lookup does not stop the fixer', async () => {
  const r = await X.autoFixBuild(row({ build: 'blamew', detail: 'the Unity build failed: Assets/Baz.cs(1,1): error CS0246: nope', fail_log: 'Assets/Baz.cs(1,1): error CS0246: nope' }), deps({ culprits: async () => { throw new Error('GitHub down'); } }));
  assert.ok(r.started, r.why);
  assert.doesNotMatch(started[started.length - 1].request, /came from a change/);
});

test('agents on a Unity project, or one with a build command, are told to run the build check', () => {
  assert.match(X.buildCheckBrief({ engine: 'unity' }), /CS0102/);
  assert.match(X.buildCheckBrief({ engine: 'unity' }), /Unity compile not run here/);
  assert.match(X.buildCheckBrief({ engine: 'web', builds: [{ id: 'web', tool: 'npm', command: 'npm run build' }] }), /npm run build/);
  assert.equal(X.buildCheckBrief({ engine: 'web' }), '');
});
