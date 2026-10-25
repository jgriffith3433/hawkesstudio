// External targets (external.ts): a fake portal answers /v1/health and /v1/health/details; relay nodes come from a
// fake list. Incidents open once, close once, and the settings carry the thresholds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-external-'));
const x = await import('../src/external.ts');
const r = await import('../src/resources.ts');
const costs = await import('../src/costs.ts');

let healthy = true;
let details: any = { eventLoop: { p99ms: 50 }, sockets: { game: 10, cap: 100 }, lastBackup: Date.now() - 600_000 };
const seen: string[] = [];
const server = http.createServer((q, s) => {
  seen.push(`${q.url} ${q.headers.authorization ?? ''}`);
  if (q.url === '/v1/health') { s.statusCode = healthy ? 200 : 503; return s.end('{}'); }
  if (q.url === '/v1/health/details') { if (q.headers.authorization !== 'Bearer key1') { s.statusCode = 401; return s.end(); } return s.end(JSON.stringify(details)); }
  if (q.url === '/n1/health') return s.end('ok');
  if (q.url === '/n2/health') { s.statusCode = 500; return s.end(); }
  s.statusCode = 404; s.end();
});
await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => server.close());
const S = { ...r.RESOURCE_DEFAULTS };
const nodes = async () => [{ id: 'n1', path: '/n1', players: 3, capacity: 600, status: 'up' }, { id: 'n2', path: '/n2', status: 'up' }, { id: 'n3', path: '/n3', status: 'draining' }];

test('without a key the details are skipped quietly, and a missing node list is skipped quietly', async () => {
  x.resetExternal();
  const e = await x.probeExternal({ portalUrl: base, adminKey: '', nodes: async () => { throw new Error('Gen 404 not found'); } });
  assert.equal(e.portal.last!.ok, true);
  assert.equal(e.details.state, 'skipped');
  assert.equal(e.nodes.state, 'skipped');
  assert.deepEqual(x.externalIncidents(S, e), []);
  assert.ok(!seen.some((l) => l.startsWith('/v1/health/details')));
});

test('a node down opens one incident; recovery closes it once', async () => {
  x.resetExternal();
  const e = await x.probeExternal({ portalUrl: base, adminKey: 'key1', nodes });
  assert.equal(e.details.state, 'ok');
  assert.deepEqual(e.nodes.list.map((n) => [n.id, n.last.ok]), [['n1', true], ['n2', false]]);
  const inc = x.externalIncidents(S, e);
  assert.deepEqual(inc.map((i) => i.key), ['node:n2']);
  assert.equal(x.reconcile(inc).opened.length, 1);
  assert.equal(x.reconcile(x.externalIncidents(S, e)).opened.length, 0); // same incident: no second note
  const gone = x.reconcile([]);
  assert.deepEqual(gone.closed.map((c) => c.key), ['node:n2']);
  assert.equal(x.reconcile([]).closed.length, 0);
});

test('portal failing 2 minutes in a row alerts; one failed minute does not', async () => {
  x.resetExternal();
  healthy = false;
  const t = Date.now();
  await x.probeExternal({ portalUrl: base, nodes: async () => [] }, t);
  assert.deepEqual(x.externalIncidents(S, x.externalState(), [], t + 60_000), []);
  assert.deepEqual(x.externalIncidents(S, x.externalState(), [], t + 120_000).map((i) => i.key), ['portal']);
  healthy = true;
  await x.probeExternal({ portalUrl: base, nodes: async () => [] });
  assert.equal(x.externalState().portal.failingSince, null);
  assert.deepEqual(x.externalIncidents(S), []);
});

test('details: websockets over 80%, backup older than 2 hours, event loop p99 over 200 ms for 5 minutes', async () => {
  x.resetExternal();
  details = { eventLoop: { p99ms: 300 }, sockets: { game: 90, cap: 100 }, lastBackup: new Date(Date.now() - 3 * 3600_000).toISOString() };
  const now = Date.now();
  const e = await x.probeExternal({ portalUrl: base, adminKey: 'key1', nodes: async () => [] }, now);
  const slow = Array.from({ length: 11 }, (_, i) => ({ at: now - (10 - i) * 30_000, v: 300 }));
  assert.deepEqual(x.externalIncidents(S, e, slow, now).map((i) => i.key).sort(), ['portal-backup', 'portal-loop', 'portal-ws']);
  assert.ok(!x.externalIncidents(S, e, slow.slice(-4), now).some((i) => i.key === 'portal-loop')); // only 90 s so far
  assert.ok(!x.externalIncidents(S, e, [{ at: now - 300_000, v: 100 }, ...slow.slice(1)], now).some((i) => i.key === 'portal-loop'));
  assert.deepEqual(x.readDetails({ eventLoop: { p99: 12 } }), { p99ms: 12, sockets: null, cap: null, lastBackup: null });
});

test('the sampler tick sends no phone note off the server, settings accept the new thresholds', async () => {
  x.resetExternal();
  healthy = true;
  const res = await r.externalTick({ portalUrl: base, nodes }, Date.now());
  assert.equal(res.opened.length, 1);
  assert.equal(res.sent, 0);
  assert.equal(r.saveResourceSettings({ wsPct: 70, backupHours: 3 }).wsPct, 70);
  assert.throws(() => r.saveResourceSettings({ wsPct: 5 }));
  const md = r.resourcesMarkdown(await r.resources());
  assert.match(md, /## Outside/);
});

test('relay GB and player-minutes per product from Gen usage', () => {
  const rows = [
    { grp: 'p', provider: 'hawkesnet', unit: 'gb:relay', amount: 1.5, cost: 0.1, jobs: 0 },
    { grp: 'p', provider: 'hawkesnet', unit: 'gb:p2p', amount: 0.5, cost: 0, jobs: 0 },
    { grp: 'p', provider: 'hawkesnet', unit: 'player-minute:relay', amount: 120, cost: 0, jobs: 0 },
    { grp: 'p', provider: 'anthropic', unit: 'tokens', amount: 9, cost: 1, jobs: 1 },
  ];
  const g: any = { ok: true, total: 1.1, byProvider: [], byProject: rows };
  const out = costs.perProduct(g, new Map(), { perProduct: {}, billed: 0 } as any);
  assert.equal(out[0].relayGb, 2);
  assert.equal(out[0].relayPlayerMinutes, 120);
});
