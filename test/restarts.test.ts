// Restarting Studio or Gen from Settings (restarts.ts): a request file and the pull-now signal for the server's deploy
// runner; one at a time; stale ones dropped; the status reads the restarts and deploys from self-deploys.jsonl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-restarts-'));
process.env.STUDIO_DATA = DATA;
const r = await import('../src/restarts.ts');

test('a restart request wakes the deploy runner; one at a time; unknown services refused', () => {
  assert.throws(() => r.requestRestart('caddy', 'J'), /studio or gen/);
  const req = r.requestRestart('gen', 'J');
  assert.equal(req.service, 'gen');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(DATA, 'restart-request.json'), 'utf8')).service, 'gen');
  assert.match(fs.readFileSync(path.join(DATA, 'pull-now'), 'utf8'), /restart gen/);
  assert.throws(() => r.requestRestart('studio', 'J'), /Hawkes Gen is already restarting/);
  assert.equal(r.restartStatus().pending?.service, 'gen');
  // The runner takes it (removes the file); an old one is stale.
  fs.writeFileSync(path.join(DATA, 'restart-request.json'), JSON.stringify({ service: 'studio', by: 'J', at: new Date(Date.now() - 20 * 60_000).toISOString() }));
  assert.equal(r.pendingRestart(), null);
  assert.ok(!fs.existsSync(path.join(DATA, 'restart-request.json')));
});

test("the status shows each service's last restart and deploy", () => {
  const line = (o: object) => JSON.stringify(o) + '\n';
  fs.writeFileSync(path.join(DATA, 'self-deploys.jsonl'),
    line({ at: '2026-10-22T10:00:00Z', repo: 'hawkesgen', outcome: 'deployed', to: 'abc1234def' })
    + line({ at: '2026-10-22T11:00:00Z', repo: 'hawkesstudio', outcome: 'restart failed', detail: 'no answer' })
    + line({ at: '2026-10-22T12:00:00Z', repo: 'hawkesgen', outcome: 'restarted', detail: 'by J from Settings' }));
  const s = r.restartStatus();
  const gen = s.services.find((x) => x.id === 'gen')!;
  const studio = s.services.find((x) => x.id === 'studio')!;
  assert.equal(gen.restart?.outcome, 'restarted');
  assert.equal(gen.deploy?.to, 'abc1234def');
  assert.equal(studio.restart?.outcome, 'restart failed');
  assert.equal(studio.deploy, null);
});
