// Approve / Deny cards don't expire by time (approvals.ts; J, 2026-11-09: the go-live card for Studio's restart fix
// lapsed after 15 minutes before he saw it). Instead the plan is rebuilt at tap time: a changed target refreshes the
// card in place (one card per thing) and runs nothing; and where the owner's go-live policy is auto and walk-away is
// on, a routine go-live makes no card at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-noexpiry-'));
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
process.env.STUDIO_RELEASE_NOTES = 'off';
process.env.TALK_CLAUDE = 'no-such-claude-here';
process.env.TALK_FOLLOWUP_BATCH_MS = '600000';
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [{
  id: 'noexp', name: 'No expiry', framing: 'test', engine: 'static', repo: 'nosite', site: 'nosite', live: 'http://127.0.0.1:9/',
  local: { serve: 'static', dir: 'nosite', port: 8797, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
}] }));
const PM_FILE = path.join(process.env.STUDIO_DATA, 'pm.json');
const pmFile = (j: Record<string, unknown>) => fs.writeFileSync(PM_FILE, JSON.stringify(j));

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const origin = path.join(tmp, 'origin.git');
const dir = path.join(process.env.STUDIO_PROJECTS, 'nosite');
git(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '--quiet', origin, dir);
const commit = (file: string, text: string, msg: string) => { fs.writeFileSync(path.join(dir, file), text); git(dir, 'add', '-A'); git(dir, 'commit', '--quiet', '-m', msg); };
commit('index.html', 'v1', 'First');
commit('releases.json', JSON.stringify({ product: 'noexp', name: 'No expiry', current: '1.0.0', releases: [{ version: '1.0.0', date: '2026-10-16', build: '', title: 'Hello', notes: ['It begins.'] }] }, null, 2), 'What\'s new page');
git(dir, 'push', '--quiet', 'origin', 'HEAD:main');
git(dir, 'push', '--quiet', 'origin', 'HEAD:beta');
git(dir, 'checkout', '--quiet', '-b', 'beta', 'origin/beta');
const remote = (ref: string) => git(origin, 'rev-parse', ref);

const { db, newId, J } = await import('../src/db.ts');
const ap = await import('../src/approvals.ts');
const P = await import('../src/golive-policy.ts');
const ops = await import('../src/ops.ts');
const { saveSettings, callSettings } = await import('../src/settings.ts');

const req = (headers: Record<string, string> = {}) => ({ headers, socket: {} }) as any;
const jPage = () => req({ 'sec-fetch-site': 'same-origin', 'x-studio-click': '1' });
const token = (id: string) => ap.getApproval(id, true)!.token!;
const played = (sha: string) => db.prepare('INSERT INTO steps (id, run, product, kind, name, status, detail, data, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run(newId('s'), newId('r'), 'noexp', 'playtest', 'smoke@local', 'done', 'won', J({ outcome: 'won', played: { branch: 'beta', sha } }), Date.now(), Date.now());

test('a card older than 15 minutes can still be approved', async () => {
  pmFile({ walkAwayCards: false });
  const a = await ap.requestApproval('settings', 'call', { patch: { rate: 1.1 } });
  assert.ok(a.expires > Date.now() + 365 * 86_400_000, 'no time limit');
  db.prepare('UPDATE approvals SET created = ? WHERE id = ?').run(Date.now() - 3 * 3600_000, a.id);
  assert.equal(ap.getApproval(a.id)!.status, 'pending', 'hours later it is still waiting');
  assert.ok(ap.listApprovals({ pending: true }).some((x) => x.id === a.id));
  const done = await ap.decideApproval(a.id, token(a.id), 'approve', jPage());
  assert.equal(done.status, 'approved');
  assert.equal(callSettings().rate, 1.1);
});

test('a stale target refreshes the card in place and runs nothing; asking again keeps one card', async () => {
  pmFile({ walkAwayCards: false });
  const a = await ap.requestApproval('settings', 'call', { patch: { rate: 1.3 } });
  const oldToken = token(a.id);
  await saveSettings('call', { rate: 0.8 }, { conversation: null, by: 'J' });
  await assert.rejects(ap.decideApproval(a.id, oldToken, 'approve', jPage()), (e: any) => e.status === 409 && /tap again/.test(e.message));
  const after = ap.getApproval(a.id, true)!;
  assert.equal(after.status, 'pending', 'not expired, not stale: the same card, asking again');
  assert.equal(callSettings().rate, 0.8, 'nothing ran');
  assert.ok(after.card.lines.some((l) => l.includes('0.8')), 'it shows the current value');
  assert.ok(after.card.warnings.some((w) => /changed since you last saw/.test(w)));
  assert.notEqual(after.token, oldToken);
  // The new tap runs what is now shown.
  assert.equal((await ap.decideApproval(a.id, after.token!, 'approve', jPage())).status, 'approved');
  assert.equal(callSettings().rate, 1.3);
  // Asking for the same thing with a different patch merges into the one waiting card.
  const b = await ap.requestApproval('settings', 'agents', { patch: { perProduct: 2 } });
  const c = await ap.requestApproval('settings', 'agents', { patch: { perProduct: 3 } });
  assert.equal(c.id, b.id, 'one card per thing');
  assert.equal(ap.listApprovals({ pending: true }).filter((x) => x.target === 'agents').length, 1);
});

test('auto policy + walk-away: a routine go-live makes no card, Studio takes it and logs it; anything else still gets a card', async () => {
  pmFile({});
  commit('index.html', 'v2', 'Fix: the title (#1)');
  git(dir, 'push', '--quiet', 'origin', 'beta');
  // Policy ask: a card (walk-away approves a clean one itself only through the card path).
  P.setPolicy('noexp', 'ask', 'test');
  const before = (db.prepare('SELECT COUNT(*) n FROM approvals').get() as any).n;
  // Not playtested: a card with its blocker, even on auto.
  P.setPolicy('noexp', 'auto', 'J', 'keep going live');
  const blocked = await ap.requestApproval('deploy', 'noexp');
  assert.ok(blocked.id && blocked.status === 'pending' && blocked.card.blockers.length, 'a blocker means a card');
  db.prepare(`UPDATE approvals SET status = 'denied' WHERE id = ?`).run(blocked.id);
  const rows = (db.prepare('SELECT COUNT(*) n FROM approvals').get() as any).n;
  assert.equal(rows, before + 1);
  // Playtested at the exact commit: no card.
  played(remote('beta'));
  const r = await ap.requestApproval('deploy', 'noexp');
  assert.equal(r.id, '', 'no card');
  assert.equal(r.status, 'approved');
  assert.equal(r.decided_by, 'Studio (walk-away)');
  assert.match(String(r.result), /Follow it in Activity/);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM approvals').get() as any).n, rows, 'nothing stored as a card');
  const op = ops.listOps().find((o: any) => o.kind === 'golive' && o.product === 'noexp');
  assert.ok(op, 'the go-live is queued, so Activity shows it');
  for (let i = 0; i < 100 && ops.getOp(op!.id)!.status !== 'done' && ops.getOp(op!.id)!.status !== 'failed'; i++) await new Promise((r) => setTimeout(r, 100));
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
