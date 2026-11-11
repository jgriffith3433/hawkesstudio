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
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: ['vwgame', 'vwdead', 'vwlib', 'vwhook'].map((id, i) => ({
  id, name: `Verdict ${id}`, framing: 'test', engine: 'static', repo: 'site', site: 'site', live: id === 'vwlib' ? 'https://github.com/acme/vwlib' : 'https://gone.example/', github: `acme/${id}`,
  local: { serve: 'static', dir: 'site', port: 8790 + i, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
})) }));

const { db, J, parse } = await import('../src/db.ts');
const { getProduct } = await import('../src/config.ts');
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
  playWhen: () => 'merge',
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

test('no open finding behind it: one re-check starts, no card; the same commit never starts a second', async () => {
  db.prepare("DELETE FROM findings").run();
  finding('vwgame', 'Already fixed', { status: 'fixed' });
  betas.length = 0;
  const run = review('vwgame', 'broken', { sha: 'aaa1111' });
  const r = await V.actOnVerdict('vwgame', 'test', deps());
  assert.equal(r.action, 'started');
  assert.deepEqual(betas, [{ product: 'vwgame', reverify: true, playtest: true }]);
  assert.equal(listQuestions().filter((q) => q.subject === 'verdict:vwgame').length, 0, 'no card');
  // Asked again on the same review/commit while nothing new came: nothing more starts.
  await V.actOnVerdict('vwgame', 'test', deps());
  assert.equal(betas.length, 1);
  // The re-check's own review (a reverify run) still reads bad with nothing open: stale, label cleared, decision logged.
  const rr = review('vwgame', 'fix-first', { sha: 'aaa1111' });
  db.prepare("UPDATE runs SET kind = 'beta', options = ? WHERE id = ?").run(J({ reverify: true }), rr);
  const s2 = await V.actOnVerdict('vwgame', 'test', deps());
  assert.equal(s2.action, 'none');
  assert.equal(betas.length, 1, 'no second re-check');
  assert.equal(V.verdictLabel('vwgame', SETTINGS), null, 'the red label is cleared');
  assert.equal(V.latestVerdict('vwgame')!.verdict, 'stale');
  assert.equal(listQuestions().filter((q) => q.subject === 'verdict:vwgame').length, 0);
  assert.ok(db.prepare("SELECT 1 FROM pm_log WHERE action = 'verdict-stale'").get());
  void run;
});

test('a second bad verdict on the same commit files nothing and starts nothing', async () => {
  betas.length = 0;
  review('vwgame', 'broken', { sha: 'aaa1111' });
  const first = await V.actOnVerdict('vwgame', 'test', deps());
  assert.equal(first.action, 'none', 'already re-checked on this commit');
  assert.equal(betas.length, 0);
  assert.equal(listQuestions().filter((q) => q.subject === 'verdict:vwgame').length, 0);
});

test('the label says why it is re-checking, and an open card is closed when nothing is open behind the verdict', async () => {
  db.prepare("DELETE FROM findings").run();
  db.prepare("DELETE FROM pm_log").run();
  await askJ('stale card', { subject: 'verdict:vwgame', product: 'vwgame', from: 'verdicts', topic: 'verdict' });
  assert.equal(listQuestions().filter((q) => q.subject === 'verdict:vwgame').length, 1);
  betas.length = 0;
  review('vwgame', 'fix-first', { sha: 'bbb2222' });
  await V.actOnVerdict('vwgame', 'test', deps({ startBeta: (product, o) => { betas.push({ product, reverify: o.reverify, playtest: o.playtest }); db.prepare("INSERT INTO runs (id, kind, status, products, options, started) VALUES ('r_re2', 'beta', 'running', ?, ?, ?)").run(J([product]), J({ reverify: true }), Date.now()); return { id: 'r_re2', done: new Promise(() => {}) }; } }));
  assert.equal(listQuestions().filter((q) => q.subject === 'verdict:vwgame').length, 0, 'card closed');
  const label = V.verdictLabel('vwgame', SETTINGS)!;
  assert.equal(label.state, 'rechecking');
  assert.match(label.reason!, /every finding behind it is fixed/);
  db.prepare("UPDATE runs SET status = 'done' WHERE id = 'r_re2'").run();
});

test('an answered verdict card is not filed again for the same review', async () => {
  db.prepare("DELETE FROM findings").run();
  finding('vwgame', 'Quiet polish', { severity: 'polish' });
  review('vwgame', 'fix-first', { sha: 'ccc3333' });
  const before = listQuestions().length;
  assert.equal((await V.actOnVerdict('vwgame', 'test', deps())).action, 'card');
  const q = listQuestions().find((x) => x.subject === 'verdict:vwgame')!;
  const { setQuestion } = await import('../src/roadmap.ts');
  setQuestion(q.id, { status: 'answered', answer: 'Run a full playtest again', answered_by: 'J' });
  assert.equal((await V.actOnVerdict('vwgame', 'test', deps())).action, 'none');
  assert.equal(listQuestions().length, before, 'not asked again');
  // A new review with a new bad verdict may ask.
  review('vwgame', 'fix-first', { sha: 'ddd4444' });
  assert.equal((await V.actOnVerdict('vwgame', 'test', deps())).action, 'card');
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
  // Asked (with walk-away on, the PM may settle it with its recommendation at once: it needn't stay open).
  assert.match(asked.at(-1)!.text, /agent budget is used/);
  assert.equal(asked.at(-1)!.subject, 'verdict:vwgame');
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

test('a library (its live address is its GitHub page, no beta) reads nothing to playtest: grey, no fixer, no card, no re-check', async () => {
  started.length = 0;
  betas.length = 0;
  finding('vwlib', 'The module export is missing');
  review('vwlib', 'fix-first', { summary: 'Works, but has problems to fix first' });
  const r = await V.actOnVerdict('vwlib', 'test', deps());
  assert.equal(r.action, 'none');
  assert.equal(started.length, 0, 'no fixer');
  assert.equal(betas.length, 0, 'no re-check');
  assert.equal(listQuestions().filter((q) => q.subject === 'verdict:vwlib').length, 0, 'no Inbox card');
  assert.equal(V.latestVerdict('vwlib')!.verdict, V.NEUTRAL);
  assert.equal(V.verdictLabel('vwlib', SETTINGS), null, 'no red label');
  // The Projects page reads the same review as neutral too (readReview), and the stored review is left as it was.
  const row = db.prepare("SELECT * FROM steps WHERE product = 'vwlib' AND kind = 'review' ORDER BY started DESC LIMIT 1").get() as any;
  const read = V.readReview('vwlib', { ...row, data: parse(row.data) });
  assert.equal(read!.data.verdict, V.NEUTRAL);
  assert.equal(read!.data.verdictWas, 'fix-first');
  assert.equal(V.libraryProject(getProduct('vwlib')), true);
  assert.equal(V.libraryProject(getProduct('vwgame')), false, 'a game with a playable page is not a library');
});

test('a page that never exposed the playtest hook: red with an open finding behind it, nothing to playtest once none is open', async () => {
  started.length = 0;
  const f = finding('vwhook', 'The title screen never appears');
  const run = review('vwhook', 'fix-first', { sha: 'eee5555' });
  playtest(run, 'vwhook', 'failed', 'The page never exposed window.hawkesPlaytest (waited 90 s)');
  assert.equal(V.hookMissing('The page never exposed window.hawkesPlaytest (waited 90 s)'), true);
  assert.equal(V.hookMissing('the bot got stuck on level 2'), false);
  // A game with an open finding stays red: the fix-first verdict stands and a fixer starts on the finding.
  assert.equal(V.nothingToPlay('vwhook'), false);
  assert.equal(V.latestVerdict('vwhook')!.verdict, 'fix-first');
  assert.equal((await V.actOnVerdict('vwhook', 'test', deps())).action, 'started');
  assert.equal(started[0].findings[0], f);
  assert.equal(V.verdictLabel('vwhook', SETTINGS)!.state, 'fixing');
  // Its finding fixed, and the playtest skipped as nothing to play (what the playtest step records): neutral, not red.
  db.prepare("UPDATE findings SET status = 'fixed' WHERE id = ?").run(f);
  db.prepare("INSERT INTO steps (id, run, product, kind, name, status, detail, data, started, finished) VALUES (?, ?, 'vwhook', 'playtest', 'smoke@live', 'skipped', 'nothing to playtest', ?, ?, ?)")
    .run(`s_${++n}sk`, run, J({ unplayable: true }), Date.now() + 1000, Date.now() + 1000);
  assert.equal(V.nothingToPlay('vwhook'), true);
  assert.equal(V.latestVerdict('vwhook')!.verdict, V.NEUTRAL);
  const betasBefore = betas.length;
  assert.equal((await V.actOnVerdict('vwhook', 'test', deps())).action, 'none', 'no re-check, no card for nothing to playtest');
  assert.equal(betas.length, betasBefore);
  assert.equal(listQuestions().filter((q) => q.subject === 'verdict:vwhook').length, 0);
});

test('the dashboard names the neutral verdict and reads it grey, not red', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'app.js'), 'utf8');
  assert.match(src, /'nothing-to-playtest': 'Nothing to playtest'/);
  assert.match(src, /r\?\.verdict === 'nothing-to-playtest'/);
});


test('beta plays once before going live (the default): a fix merge starts no re-check play', async () => {
  const W = await import('../src/verdictwork.ts');
  assert.equal(await W.noteMerge('anygame', 'c_x', deps({ playWhen: () => 'go-live' })), false);
});
