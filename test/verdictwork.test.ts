// Bad verdicts work themselves (src/verdictwork.ts; J, 2026-11-05: "studio should be working on it if it's failed or fix
// first"). A fix-first or broken review starts a fixer through startFix's rules, or files ONE Inbox card saying why; a
// dead live address is a card, never a code fixer; a burst of merges costs one re-check; the label says what is going on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-verdictwork-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: ['vwgame', 'vwdead'].map((id, i) => ({
  id, name: `Verdict ${id}`, framing: 'test', engine: 'static', repo: 'site', site: 'site', live: 'https://gone.example/', github: `acme/${id}`,
  local: { serve: 'static', dir: 'site', port: 8790 + i, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
})) }));

const { db, J } = await import('../src/db.ts');
await import('../src/agents.ts'); // the changes table and the agent settings
const { askJ } = await import('../src/pm.ts');
const { listQuestions } = await import('../src/roadmap.ts');
const V = await import('../src/verdictwork.ts');

let n = 0;
const review = (product: string, verdict: string, o: { summary?: string; sha?: string } = {}) => {
  const run = `r_${(++n).toString(16).padStart(12, '0')}`;
  db.prepare("INSERT INTO runs (id, kind, status, products, started) VALUES (?, 'daily', 'done', ?, ?)").run(run, J([product]), Date.now());
  db.prepare("INSERT INTO steps (id, run, product, kind, name, status, data, started, finished) VALUES (?, ?, ?, 'review', 'smoke@live', 'done', ?, ?, ?)")
    .run(`s_${n}rv`, run, product, J({ verdict, sha: o.sha ?? 'abc1234def', summary: o.summary ?? '' }), Date.now() + n, Date.now() + n);
  return run;
};
const playtest = (run: string, product: string, status: string, detail: string, name = 'smoke@live') =>
  db.prepare("INSERT INTO steps (id, run, product, kind, name, status, detail, started, finished) VALUES (?, ?, ?, 'playtest', ?, ?, ?, ?, ?)").run(`s_${++n}pt`, run, product, name, status, detail, Date.now(), Date.now());
const finding = (product: string, title: string, o: { severity?: string; status?: string } = {}) => {
  const id = `f_${(++n).toString(16).padStart(12, '0')}`;
  db.prepare("INSERT INTO findings (id, product, key, title, severity, status, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, product, id, title, o.severity ?? 'bug', o.status ?? 'open', Date.now(), Date.now());
  return id;
};
const change = (product: string, status: string) => {
  const id = `c_${(++n).toString(16).padStart(12, '0')}`;
  db.prepare("INSERT INTO changes (id, product, findings, status, repo, slug, branch, base, worktree, request, notes, log, created) VALUES (?, ?, '[]', ?, 'r', ?, ?, 'beta', ?, '', '[]', '[]', ?)").run(id, product, status, `acme/${product}`, `fix/${id}`, `/tmp/${id}`, Date.now());
  return id;
};

const SETTINGS = { autoWorkVerdicts: true, autoReverify: true, autoFix: true, enabled: true, severities: ['blocker', 'bug'] };
const started: { product: string; findings: string[]; by: string }[] = [];
const asked: { text: string; subject: string; topic: string }[] = [];
const betas: { product: string; reverify: boolean; playtest: boolean }[] = [];
const deps = (over: Partial<import('../src/verdictwork.ts').Deps> = {}): import('../src/verdictwork.ts').Deps => ({
  settings: () => SETTINGS,
  startFix: (product, findings, o) => { const id = change(product, 'queued'); started.push({ product, findings, by: o.by }); return id; },
  autoFixBlock: () => null,
  ask: (text, o) => { asked.push({ text, subject: o.subject, topic: o.topic }); return askJ(text, { ...o, from: 'verdicts' }); },
  startBeta: (product, o) => { betas.push({ product, reverify: o.reverify, playtest: o.playtest }); return { id: 'r_x', done: Promise.resolve() }; },
  quietMs: 20,
  ...over,
});

test('a fix-first verdict with an open bug starts a fixer, once', async () => {
  review('vwgame', 'fix-first');
  const f = finding('vwgame', 'The jump button does nothing');
  const r = await V.actOnVerdict('vwgame', 'test', deps());
  assert.equal(r.action, 'started');
  assert.deepEqual(started[0], { product: 'vwgame', findings: [f], by: 'a bad verdict' });
  // The agent is on it now: asking again starts nothing and says so; the label reads "fixing".
  const again = await V.actOnVerdict('vwgame', 'test', deps());
  assert.equal(again.action, 'busy');
  assert.equal(started.length, 1);
  const label = V.verdictLabel('vwgame', SETTINGS)!;
  assert.equal(label.state, 'fixing');
  assert.equal(label.commit, 'abc1234');
  assert.equal(listQuestions().filter((q) => q.subject === 'verdict:vwgame').length, 0);
});

test('a verdict that is not bad starts nothing and clears its card', async () => {
  db.prepare("DELETE FROM changes").run();
  review('vwgame', 'ship');
  assert.equal((await V.actOnVerdict('vwgame', 'test', deps())).action, 'none');
  assert.equal(V.verdictLabel('vwgame'), null);
});

test('no finding to fix: ONE Inbox card that says why, merged on repeat, closed when the verdict clears', async () => {
  db.prepare("DELETE FROM findings").run();
  review('vwgame', 'broken');
  const r = await V.actOnVerdict('vwgame', 'test', deps());
  assert.equal(r.action, 'card');
  await V.actOnVerdict('vwgame', 'test', deps());
  const cards = listQuestions().filter((q) => q.subject === 'verdict:vwgame');
  assert.equal(cards.length, 1, 'a repeat merges into the open card');
  assert.match(cards[0].text, /no open finding/);
  assert.equal(V.verdictLabel('vwgame', SETTINGS)!.state, 'needs-you');
  review('vwgame', 'ship');
  await V.actOnVerdict('vwgame', 'test', deps());
  assert.equal(listQuestions().filter((q) => q.subject === 'verdict:vwgame').length, 0);
});

test("won't fix and the retry cap are honoured: a card names why, no fixer starts", async () => {
  started.length = 0;
  db.prepare("DELETE FROM findings").run();
  finding('vwgame', 'A held-back bug');
  review('vwgame', 'fix-first');
  const r = await V.actOnVerdict('vwgame', 'test', deps({ autoFixBlock: () => 'it already failed 2 times today' }));
  assert.equal(r.action, 'card');
  assert.equal(started.length, 0);
  assert.match(listQuestions().find((q) => q.subject === 'verdict:vwgame')!.text, /already failed 2 times today/);
  // The real autoFixBlock refuses a wontfix finding too.
  const { autoFixBlock } = await import('../src/agents.ts');
  const w = finding('vwgame', 'Never mind', { status: 'wontfix' });
  assert.match(autoFixBlock(w)!, /won't fix/);
});

test("a cap reached (startFix refuses) files a card instead of throwing", async () => {
  started.length = 0;
  review('vwgame', 'broken');
  const r = await V.actOnVerdict('vwgame', 'test', deps({ startFix: () => { throw new Error("Today's agent budget is used (1000 fixes, $20.00)."); } }));
  assert.equal(r.action, 'card');
  assert.match(listQuestions().find((q) => q.subject === 'verdict:vwgame')!.text, /agent budget is used/);
});

test('the switch is a setting: off starts nothing and files nothing', async () => {
  started.length = 0;
  const before = listQuestions().length;
  const r = await V.actOnVerdict('vwgame', 'test', deps({ settings: () => ({ ...SETTINGS, autoWorkVerdicts: false }) }));
  assert.equal(r.action, 'off');
  assert.equal(started.length, 0);
  assert.equal(listQuestions().length, before);
  const { agentSettings } = await import('../src/agents.ts');
  assert.equal(agentSettings().autoWorkVerdicts, true, 'default on');
  assert.equal(agentSettings().autoReverify, true, 'default on');
});

test('a dead live address is a misconfiguration: the label says so, a card is filed, no code fixer starts', async () => {
  started.length = 0;
  finding('vwdead', 'Something visible');
  const run = review('vwdead', 'broken', { summary: 'The page never loaded.' });
  playtest(run, 'vwdead', 'failed', 'page.goto: net::ERR_NAME_NOT_RESOLVED at https://gone.example/');
  const r = await V.actOnVerdict('vwdead', 'test', deps());
  assert.equal(r.action, 'card');
  assert.equal(started.length, 0);
  const card = listQuestions().find((q) => q.subject === 'verdict:vwdead')!;
  assert.equal(card.topic, 'verdict');
  assert.match(card.text, /live address .* doesn't answer/);
  const label = V.verdictLabel('vwdead', SETTINGS)!;
  assert.equal(label.state, 'needs-you');
  assert.match(label.reason!, /doesn't answer|address/);
  // A broken verdict from a game that loads and fails is not a misconfiguration.
  const run2 = review('vwgame', 'broken');
  playtest(run2, 'vwgame', 'failed', 'the bot got stuck on level 2');
  assert.equal(V.deadAddress('vwgame'), null);
});

test('a burst of merges costs one re-check, after the quiet window; a merge during it queues one more', async () => {
  V.resetRechecks();
  betas.length = 0;
  review('vwgame', 'fix-first');
  const d = deps({ quietMs: 30 });
  assert.equal(await V.noteMerge('vwgame', 'c_a', d), true);
  assert.equal(await V.noteMerge('vwgame', 'c_b', d), true);
  assert.equal(await V.noteMerge('vwgame', 'c_c', d), true);
  assert.equal(V.rechecking('vwgame'), true);
  assert.equal(V.verdictLabel('vwgame', SETTINGS)!.state, 'rechecking');
  assert.equal(betas.length, 0, 'nothing plays while merges keep coming');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(betas.length, 1, 'one playtest for the burst');
  assert.deepEqual(betas[0], { product: 'vwgame', reverify: true, playtest: true });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(V.rechecking('vwgame'), false);
});

test('re-check follows only a bad verdict and only while its switch is on', async () => {
  V.resetRechecks();
  betas.length = 0;
  review('vwgame', 'ship');
  assert.equal(await V.noteMerge('vwgame', 'c_d', deps()), false);
  review('vwgame', 'fix-first');
  assert.equal(await V.noteMerge('vwgame', 'c_e', deps({ settings: () => ({ ...SETTINGS, autoReverify: false }) })), false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(betas.length, 0);
});

test('a running reverify beta run reads as re-checking in the label', () => {
  V.resetRechecks();
  db.prepare("INSERT INTO runs (id, kind, status, products, options, started) VALUES ('r_re1', 'beta', 'running', ?, ?, ?)").run(J(['vwgame']), J({ reverify: true }), Date.now());
  assert.equal(V.verdictLabel('vwgame', SETTINGS)!.state, 'rechecking');
  db.prepare("UPDATE runs SET status = 'done' WHERE id = 'r_re1'").run();
});

test('the dashboard label names the verdict, the review age and commit, and what Studio is doing', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'app.js'), 'utf8');
  assert.match(src, /fixing \(agent running/);
  assert.match(src, /re-checking on beta/);
  assert.match(src, /needs you: /);
  assert.match(src, /reviewed \$\{ago\(vw\.at\)\}\$\{vw\.commit/);
});
