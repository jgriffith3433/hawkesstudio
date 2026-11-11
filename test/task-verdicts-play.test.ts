// The one play that still runs, a milestone's play of its build (play-policy.ts), judges merged tasks' criteria in the
// same review (acceptance.ts sweepFor). The daily run and a beta run no milestone started play nothing. Driven through
// pipeline.ts's real play and review with Hawkes Gen standing in: no new play or review is asked of Gen for them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const listen = async (h: http.RequestListener) => {
  const s = http.createServer(h);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  after(() => s.close());
  return (s.address() as any).port as number;
};
const body = async (req: http.IncomingMessage) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; };
const json = (res: http.ServerResponse, code: number, o: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

// Hawkes Gen, standing in: every job done at once. Reviews and the separate judge say every criterion asked is met.
type Job = { id: string; tool: string; params: any; status: string; result: any; outputs: any[]; cost: number };
const jobs: Job[] = [];
const asked = (prompt: string) => [...String(prompt).split('PLAYTEST:')[0].matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]);
const resultOf = (tool: string, params: any) => ({
  'playtest.run': { outcome: 'passed', seconds: 30, problems: [], fps: { average: 60 } },
  'playtest.review': { verdict: 'ship', summary: 'Works.', findings: [], known: [], scores: {}, ...(params.criteria ? { criteria: params.criteria.map((k: string) => ({ criterion: k, met: 'yes', evidence: 'seen' })) } : {}) },
  'llm.json': { value: { criteria: asked(params.prompt).map((k) => ({ criterion: k, met: 'yes', evidence: 'seen' })) } },
} as Record<string, any>)[tool] ?? {};
const genPort = await listen(async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  const b = await body(req);
  if (url.pathname === '/v1/health') return json(res, 200, { ok: true });
  if (url.pathname.startsWith('/v1/tools/')) return json(res, 200, { id: url.pathname.slice(10), version: 1 });
  if (url.pathname === '/v1/jobs' && req.method === 'POST') {
    const j: Job = { id: `j_${jobs.length + 1}`, tool: b.tool, params: b.params, status: 'done', result: resultOf(b.tool, b.params), outputs: [], cost: 0 };
    jobs.push(j);
    return json(res, 200, { jobs: [j] });
  }
  if (url.pathname === '/v1/jobs') return json(res, 200, { jobs: [] });
  const j = jobs.find((x) => url.pathname === `/v1/jobs/${x.id}`);
  if (j) return json(res, 200, j);
  json(res, 404, { error: `no ${url.pathname}` });
});
// The product's beta, standing in (served by itself: "remote").
const sitePort = await listen((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><body>game</body></html>'); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-verdicts-play-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.HAWKESGEN_URL = `http://127.0.0.1:${genPort}`;
process.env.GEN_PUBLIC_URL = `http://127.0.0.1:${genPort}`;
process.env.STUDIO_LLM_VIA = 'gen';
process.env.STUDIO_PM_TALK = 'off';
for (const k of ['STUDIO_SERVER', 'HAWKESGEN_KEY', 'NTFY_TOPIC']) delete process.env[k];
process.env.STUDIO_BETA_LANE = '1'; // beta runs play (as on the server)
fs.mkdirSync(path.join(process.env.STUDIO_PROJECTS, 'tvplay'), { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'tvplay', name: 'Verdict play', framing: 'test', engine: 'static', repo: 'tvplay', site: 'tvplay', live: `http://127.0.0.1:${sitePort}/`,
  local: { serve: 'remote', dir: 'tvplay', port: sitePort, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }, { scenario: 'smoke', where: 'local', device: 'phone' }, { scenario: 'smoke', where: 'live' }], story: [], about: 'A fixture.',
}], repos: {} }));

const rm = await import('../src/roadmap.ts');
const P = await import('../src/pipeline.ts');
const { getProduct } = await import('../src/config.ts');
const { db, J, newId } = await import('../src/db.ts');

const crit = ['The shop opens', 'On a phone the shop fits at 390x844'];
const it = rm.addItem({ product: 'tvplay', title: 'Shop', status: 'planned' });
const task = rm.addTask({ item: it.id, request: 'Add the shop', criteria: crit });
rm.setTask(task.id, { status: 'merged', merged_at: Date.now() - 600_000, build: { ok: true, run: 'r_b', at: Date.now() - 500_000, detail: 'built OK' } });

const reviewsOf = (run: string) => (db.prepare(`SELECT name, data FROM steps WHERE run = ? AND kind = 'review' ORDER BY started`).all(run) as any[]).map((r) => ({ name: r.name, data: JSON.parse(r.data) }));
const run = (kind: string) => {
  const id = newId('r');
  db.prepare('INSERT INTO runs (id, kind, status, detail, products, options, started) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, kind, 'running', kind, J(['tvplay']), '{}', Date.now());
  return id;
};

test("the daily run plays nothing now (play-policy.ts, J 2026-11-11): no GPU play, no review", async () => {
  const r = run('daily');
  const before = jobs.filter((j) => j.tool === 'playtest.run').length;
  await P.runProduct(r, getProduct('tvplay'), { noChecks: true } as any);
  assert.equal(jobs.filter((j) => j.tool === 'playtest.run').length - before, 0, 'no play outside a milestone');
  assert.equal(reviewsOf(r).length, 0);
});

test('a beta run nobody started for a milestone plays nothing, even asked to (play-policy.ts)', async () => {
  const before = jobs.filter((j) => j.tool === 'playtest.run').length;
  const r = P.startBeta('tvplay', { focus: 'Checking after a merge', playtest: true, reverify: true });
  await r.done;
  assert.equal(jobs.filter((j) => j.tool === 'playtest.run').length - before, 0);
  const steps = db.prepare(`SELECT kind, status, detail FROM steps WHERE run = ? AND kind = 'playtest'`).all(r.id) as any[];
  assert.equal(steps.length, 1);
  assert.equal(steps[0].status, 'skipped');
  assert.match(steps[0].detail, /once on each milestone's build/);
});

test("the milestone's play judges merged tasks' criteria; a task check of its own does not sweep", async () => {
  const before = jobs.filter((j) => j.tool === 'playtest.review').length;
  const r = P.startBeta('tvplay', { focus: 'Milestone "Shop": play its build once', playtest: true, play: 'milestone', cause: 'milestone', reverify: true });
  await r.done;
  const reviews = reviewsOf(r.id);
  assert.equal(reviews.length, 1, 'its one play');
  assert.deepEqual(reviews[0].data.criteria.map((c: any) => c.criterion), crit, 'no phone play in a beta run: both on its play');
  assert.deepEqual(reviews[0].data.sweep, [task.id]);
  assert.equal(jobs.filter((j) => j.tool === 'playtest.review').length - before, 1);
  // A milestone run checking a task's own criteria judges only those.
  const own = P.startBeta('tvplay', { focus: 'Checking a task', criteria: ['Its own criterion'], playtest: true, play: 'milestone' });
  await own.done;
  const [rev] = reviewsOf(own.id);
  assert.deepEqual(rev.data.criteria.map((c: any) => c.criterion), ['Its own criterion']);
  assert.equal(rev.data.sweep, null);
});
