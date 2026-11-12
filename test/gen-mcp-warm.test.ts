// Gen MCP cold start: Claude Code's default CONNECT_TIMEOUT was 30 s; Gen on Cloud Run often answers after ~45 s.
// warmGenMcp waits past that, MCP_TIMEOUT is raised, and a no-commit pass that says Gen unreachable is requeued
// without counting a try (outcome "Gen unreachable", never "already done").
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-genmcp-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_GEN_MCP_TIMEOUT_MS = '90000';
for (const k of ['STUDIO_SERVER', 'STUDIO_BETA_LANE', 'NTFY_TOPIC']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({
  repos: { game: 'x/game' },
  products: [{ id: 'game', name: 'Game', framing: 'test', engine: 'web', repo: 'game', live: 'http://127.0.0.1:9/', local: { serve: 'static', dir: 'game', port: 8798, path: '/' }, playtests: [], story: [], about: 'fixture' }],
  infra: [],
}));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { warmGenMcp, GEN_MCP_TIMEOUT_MS } = await import('../src/gen.ts');
const { genUnreachableSaid, GEN_UNREACHABLE, noCommitOutcome, NO_COMMIT_OUTCOMES } = await import('../src/outcomes.ts');
const { alreadyDone, parkForGenUnreachable, GEN_MISS_CAP, ALREADY, getChange, patchChange } = await import('../src/agents.ts');
const { cloudMcp } = await import('../src/cloudjob.ts');
const { isInfraText } = await import('../src/infra-failure.ts');
const { db } = await import('../src/db.ts');

const listen = async (server: http.Server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as net.AddressInfo).port;
};

test('MCP connect budget is past a 45 s Gen cold start', () => {
  assert.ok(GEN_MCP_TIMEOUT_MS() >= 45_000);
  assert.equal(GEN_MCP_TIMEOUT_MS(), 90_000);
});

test('Gen MCP that answers only after 45 s: warm succeeds and the agent MCP config still has hawkesgen tools', { timeout: 120_000 }, async () => {
  const readyAt = Date.now() + 45_000;
  const server = http.createServer((req, res) => {
    if (req.url !== '/mcp') { res.writeHead(404); return void res.end(); }
    if (Date.now() < readyAt) {
      // Hang until ready (cold start): a 30 s connect timeout would fail; 90 s warm succeeds.
      const wait = readyAt - Date.now();
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: 1,
          result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'hawkesgen', version: '1' } },
        }));
      }, wait);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'hawkesgen', version: '1' } },
    }));
  });
  const port = await listen(server);
  try {
    process.env.HAWKESGEN_URL = `http://127.0.0.1:${port}`;
    const warm = await warmGenMcp({ url: `http://127.0.0.1:${port}`, key: 'hg_test', budgetMs: 90_000 });
    assert.equal(warm.ok, true, `warm failed: ${warm.error}`);
    // Past the old 30 s CONNECT_TIMEOUT; allow a few ms of timer skew under the nominal 45 s.
    assert.ok(warm.ms >= 44_000, `expected ~45 s (past the old 30 s timeout), got ${warm.ms} ms`);
    assert.ok(warm.status && warm.status >= 200);

    const mcp = cloudMcp({ STUDIO_AGENT: 'c_testgenmcp01' }, 'hg_test') as any;
    assert.ok(mcp.hawkesgen, 'hawkesgen MCP server is in the agent session config');
    assert.equal(mcp.hawkesgen.type, 'http');
    assert.match(mcp.hawkesgen.url, /\/mcp$/);
    assert.equal(mcp.hawkesgen.alwaysLoad, true);
    assert.ok(GEN_MCP_TIMEOUT_MS() > 45_000, 'Claude Code MCP_TIMEOUT covers a 45 s answer');
  } finally {
    server.close();
  }
});

test('genUnreachableSaid catches CONNECT_TIMEOUT; alreadyDone does not', () => {
  const stuck = 'Stuck: Hawkes Gen is unreachable\n\nExact error: MCP server hawkesgen connection timed out after 30000ms (CONNECT_TIMEOUT).';
  assert.equal(genUnreachableSaid(stuck), true);
  assert.equal(genUnreachableSaid('MCP server hawkesgen connection timed out after 30000ms'), true);
  assert.equal(alreadyDone(stuck), false, 'Gen unreachable never reads as already done');
  assert.equal(alreadyDone('The work is already done on beta.'), true);
  assert.equal(noCommitOutcome({
    ranInJob: true, worktreeProbeOk: false, saidUnreadable: false,
    saidAlreadyDone: true, saidGenUnreachable: true,
  }), 'gen-unreachable', 'Gen unreachable wins over already-done');
  assert.ok(NO_COMMIT_OUTCOMES.includes('gen-unreachable'));
  assert.ok(isInfraText('Gen unreachable (3×; not counted as a try)'));
  assert.ok(!isInfraText('the agent made no commit'));
});

test('a session that ends Gen unreachable with no commit is requeued; tries stay the same; outcome is Gen unreachable', async () => {
  const wt = fs.mkdtempSync(path.join(tmp, 'wt-'));
  fs.mkdirSync(path.join(wt, '.hawkes'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.hawkes', 'stuck.md'), 'Service: Hawkes Gen. MCP server hawkesgen connection timed out after 30000ms (CONNECT_TIMEOUT).');
  const { addItem, addTask, getTask, setTask } = await import('../src/roadmap.ts');
  const item = addItem({ product: 'game', title: 'Gen art', goal: 'Art lands', criteria: ['Art is in'], status: 'in progress' });
  const task = addTask({ item: item.id, product: 'game', title: 'Gen art', request: 'Make art', criteria: ['Art is in'], status: 'planned' });
  setTask(task.id, { status: 'working', tries: 2, change: 'c_genunreach001' });
  assert.equal(getTask(task.id)!.tries, 2);

  const id = 'c_genunreach001';
  const now = Date.now();
  db.prepare(`INSERT INTO changes (id, product, findings, status, detail, title, repo, branch, base, worktree, request, criteria, notes, log, commits, cost, created, updated, task)
    VALUES (?, 'game', '[]', 'working', 'working', 'Art', 'game', 'task/x', 'beta', ?, 'Make art', '[]', '[]', '[]', '[]', 0, ?, ?, ?)`).run(id, wt, now, now, task.id);

  const ph: any = { step: 'publish', result: 'MCP server hawkesgen connection timed out after 30000ms', genMisses: 0 };
  const save = (patch: any, extra: any = {}) => {
    Object.assign(ph, patch);
    patchChange(id, { ...extra, phase: ph });
  };
  const summary = 'Not done. The Hawkes Gen MCP server failed to connect (CONNECT_TIMEOUT). No commits.';
  assert.equal(parkForGenUnreachable(id, ph, save, summary, []), true);

  const row = getChange(id)!;
  assert.equal(row.status, 'queued');
  assert.equal(row.detail, GEN_UNREACHABLE);
  assert.ok(!String(row.detail).includes(ALREADY));
  assert.ok(!/already done/i.test(String(row.detail)));
  assert.equal(JSON.parse(String((db.prepare('SELECT phase FROM changes WHERE id = ?').get(id) as any).phase)).genMisses, 1);
  assert.equal(getTask(task.id)!.tries, 2, 'tries unchanged on Gen-unreachable requeue');

  // Cap: after GEN_MISS_CAP it fails as Gen unreachable (infra, not a try), still never "already done".
  ph.genMisses = GEN_MISS_CAP - 1;
  assert.equal(parkForGenUnreachable(id, ph, save, summary, []), true);
  const done = getChange(id)!;
  assert.equal(done.status, 'failed');
  assert.match(String(done.detail), /^Gen unreachable/);
  assert.ok(!/already done/i.test(String(done.detail)));
  assert.ok(isInfraText(String(done.detail)));
  assert.equal(getTask(task.id)!.tries, 2, 'tries still unchanged when it gives up as infra');
});
