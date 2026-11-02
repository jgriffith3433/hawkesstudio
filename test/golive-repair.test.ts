// Going live never ends in a dead end (2026-11-02, Jaycee: Studio's beta "isn't answering" and "main has 5 commit(s)
// beta lacks" with nothing to tap "would turn a customer away"): each of those states has a plain line and a button.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-golive-repair-'));
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'products.json'), JSON.stringify({ products: [{ id: 'moon', name: 'Moon Rover', engine: 'web', repo: 'moon', site: 'acme/moon', live: 'https://moon.example', playtests: [], story: [] }] }));
process.env.STUDIO_PRODUCTS = path.join(process.env.STUDIO_DATA, 'products.json');
const D = await import('../src/deploy.ts');
const R = await import('../src/redeploy.ts');
const L = await import('../src/local.ts');

test('main ahead of beta (the GitHub plan\'s wording) gets the "Merge live into beta" button', () => {
  const b = 'main has 5 commit(s) beta lacks ("x", "y"), so main can\'t be fast-forwarded. Studio merges main into beta (studio_deploy action merge-main), then beta is built and playtested and can go live.';
  assert.equal(D.blockerFix(b), 'merge-main');
  assert.equal(D.planFix([b]), 'merge-main');
});

test('a beta that did not answer is told in plain words, old and new wording', () => {
  const line = L.remoteDownLine('Hawkes Studio', 'https://studio-beta.example/');
  assert.match(line, /didn't answer within \d+ s/);
  assert.match(line, /redeploy beta or retry the playtest/);
  assert.ok(R.betaDownLine(line));
  assert.ok(R.betaDownLine("Hawkes Studio's beta (https://studio-beta.example/) isn't answering: see its GitHub Actions deploy"));
  assert.ok(!R.betaDownLine('Playtest ended "lost"'));
  assert.ok(L.REMOTE_WAKE_MS >= 60_000, 'long enough for a Cloud Run beta to wake');
});

test('the run to redeploy: beta\'s deploy on its head, not a PR run or another branch', () => {
  const runs = [
    { id: 1, head_branch: 'main', name: 'Deploy', head_sha: 'aaa' },
    { id: 2, head_branch: 'beta', name: 'Hawkes Studio', head_sha: 'bbb' },
    { id: 3, head_branch: 'beta', name: 'Deploy', head_sha: 'bbb' },
    { id: 4, head_branch: 'beta', name: 'Deploy', head_sha: 'old' },
  ];
  assert.equal(R.pickRun(runs, 'bbb').id, 3);
  assert.equal(R.pickRun(runs, 'zzz').id, 3, 'newest deploy on beta when its head has none');
  assert.equal(R.pickRun([{ id: 9, head_branch: 'beta', name: 'Build', head_sha: 'q' }], 'q').id, 9);
  assert.equal(R.pickRun([], 'q'), null);
});

const fake = (rerun: number, conclusion = 'failure', status = 'completed') => {
  const calls: string[] = [];
  const f = (async (url: string, init: any = {}) => {
    calls.push(`${init.method ?? 'GET'} ${url.replace('https://api.github.com/repos/acme/moon/', '')}`);
    const j = (x: unknown, s = 200) => new Response(JSON.stringify(x), { status: s });
    if (url.endsWith('branches/beta')) return j({ commit: { sha: 'bbb' } });
    if (url.includes('actions/runs?')) return j({ workflow_runs: [{ id: 7, head_branch: 'beta', name: 'Deploy', head_sha: 'bbb', status, conclusion, html_url: 'https://github.com/acme/moon/actions/runs/7' }] });
    if (url.includes('/rerun')) return new Response(null, { status: rerun });
    return j({}, 404);
  }) as typeof fetch;
  return { f, calls };
};

test('Redeploy beta reruns beta\'s failed deploy, and says what to do when it may not', async () => {
  const ok = fake(201);
  const r = await R.redeployBeta('moon', { fetchImpl: ok.f, token: 't' });
  assert.equal(r.ok, true);
  assert.ok(ok.calls.includes('POST actions/runs/7/rerun-failed-jobs'), ok.calls.join(' | '));
  assert.match(r.note, /Nothing goes live/);

  const no = fake(403, 'success');
  const r2 = await R.redeployBeta('moon', { fetchImpl: no.f, token: 't' });
  assert.equal(r2.ok, false);
  assert.ok(no.calls.includes('POST actions/runs/7/rerun'));
  assert.match(r2.note, /press Re-run/);
  assert.equal(r2.link, 'https://github.com/acme/moon/actions/runs/7');

  const busy = fake(201, 'failure', 'in_progress');
  const r3 = await R.redeployBeta('moon', { fetchImpl: busy.f, token: 't' });
  assert.equal(r3.ok, true);
  assert.ok(!busy.calls.some((c) => c.includes('rerun')), 'a running deploy is not started twice');

  const none = await R.redeployBeta('moon', { fetchImpl: ok.f, token: null });
  assert.equal(none.ok, false);
  assert.match(none.note, /no GitHub access/);
});

test('after a push to main outside a go live, main is merged back into beta (and can be turned off)', async () => {
  const G = await import('../src/golive.ts');
  process.env.STUDIO_FOLLOW_MAIN = '0';
  assert.equal(G.followMainIntoBeta({ id: 'moon' } as any, 'abc1234'), false);
  delete process.env.STUDIO_FOLLOW_MAIN;
  assert.equal(G.followMainIntoBeta({ id: 'moon', build: { project: 'x' } } as any, 'abc1234'), false, 'Unity games publish on main pushes instead');
});
