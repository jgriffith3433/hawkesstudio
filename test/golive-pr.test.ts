// Going live with no bypass list (golive-pr.ts; J, 2026-11-01: "I don't want the customer to have to do any manual
// action"): the owner's Go live tap is the whole approval. Where the repo's rules stop the app from moving main, Studio
// opens a pull request from the exact commit, waits for main's required checks and merges it itself; rules an app
// can't merge through are named, and the one-time setup step rewrites them into a shape it can. GitHub is a stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeGitHub, sha, type FakeRepo } from './fake-github.ts';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-golive-pr-'));
process.env.STUDIO_MAIL = 'off';
delete process.env.GITHUB_API_BASE;

const G = await import('../src/golive-pr.ts');
const { fastForward } = await import('../src/deploy-cloud.ts');
const { syncBetaWithLive, isGoLiveMerge } = await import('../src/deploy-github.ts');

// The rules every one of J's site repos has today (read 2026-11-01): never rewritten, and only admins may push main.
const HAWKES_RULESETS = () => ({
  '1': { name: 'Hawkes: main is never rewritten', rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }] },
  '2': { name: 'Hawkes: who may push main', rules: [{ type: 'update', parameters: { update_allows_fetch_and_merge: false } }] },
});
const PR_RULESETS = (checks: string[] = ['ci']) => ({
  '1': { name: 'Hawkes: main is never rewritten', rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }] },
  '3': { name: 'main through pull requests', rules: [{ type: 'pull_request', parameters: { ...G.NO_REVIEW_PR } }, ...(checks.length ? [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: checks.map((context) => ({ context })) } }] : [])] },
});

const site = (extra: Partial<FakeRepo> = {}): FakeRepo => ({
  refs: { main: sha('1'), beta: sha('3') },
  commits: { [sha('1')]: { parents: [], tree: 't1' }, [sha('2')]: { parents: [sha('1')], tree: 't2', title: 'Faster jumps' }, [sha('3')]: { parents: [sha('2')], tree: 't3', title: 'A new level' } },
  ...extra,
});

function setup(repo: FakeRepo, slug = 'acme/site') {
  const gh = fakeGitHub({ [slug]: repo });
  const api = G.apiOf(gh.f, 'ghs_site');
  const go = (o: Partial<Parameters<typeof G.moveLive>[3]> = {}) => G.moveLive(slug, 'main', sha('3'), {
    api, direct: () => fastForward(slug, 'main', sha('3'), gh.f, 'ghs_site'), kind: 'live', title: `${G.STUDIO_GOLIVE} beta 3333333 of Site`,
    pollMs: 1, waitMs: 2_000, sleep: async () => {}, ...o,
  });
  return { gh, api, go, r: repo };
}

test('the rule shapes: which ones go live with no manual step', () => {
  // J's nine site repos: a restrict-updates rule. Nothing but its bypass list may move main, not even a pull request.
  const today = G.rulesShape(Object.values(HAWKES_RULESETS()).flatMap((x) => x.rules));
  assert.equal(today.viaPr, false);
  assert.equal(today.direct, false);
  assert.match(today.blockers.join(' '), /restricts updates/);
  // Pull requests with no reviewer and a required check: Studio merges them itself once the check passes.
  const ok = G.rulesShape(Object.values(PR_RULESETS(['ci', 'lint'])).flatMap((x) => x.rules));
  assert.equal(ok.viaPr, true);
  assert.deepEqual(ok.checks, ['ci', 'lint']);
  // No rules at all: a direct fast-forward, exactly as before.
  assert.deepEqual(G.rulesShape([]), { direct: true, viaPr: true, checks: [], blockers: [] });
  // What an app can't get past by itself.
  assert.match(G.rulesShape([{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }]).blockers.join(), /1 approving review/);
  assert.match(G.rulesShape([{ type: 'pull_request', parameters: { require_code_owner_review: true } }]).blockers.join(), /code owner/);
  assert.match(G.rulesShape([{ type: 'required_linear_history' }]).blockers.join(), /linear history/);
  assert.match(G.rulesShape([{ type: 'merge_queue' }]).blockers.join(), /merge queue/);
  assert.match(G.rulesShape([{ type: 'pull_request', parameters: { allowed_merge_methods: ['squash'] } }]).blockers.join(), /squash/);
  assert.equal(G.rulesShape([{ type: 'required_signatures' }, { type: 'deletion' }]).viaPr, true, 'GitHub signs the merges it makes');
});

test('main with no rules moves directly to the played commit, no pull request', async () => {
  const { go, r } = setup(site());
  const m = await go();
  assert.equal(m.how, 'direct');
  assert.equal(r.refs.main, sha('3'));
  assert.equal((r.pulls ?? []).length, 0);
});

test('main that needs pull requests and a check: Studio opens one, waits for the check, and merges it as the app', async () => {
  const checks: Record<string, { name: string; status: string; conclusion?: string | null }[]> = { [sha('3')]: [{ name: 'ci', status: 'in_progress', conclusion: null }] };
  const { go, r } = setup(site({ rulesets: PR_RULESETS(), checks }));
  let polls = 0;
  const m = await go({ sleep: async () => { if (++polls === 2) checks[sha('3')] = [{ name: 'ci', status: 'completed', conclusion: 'success' }]; } });
  assert.equal(m.how, 'pr');
  assert.ok(polls >= 2, 'waited for the check');
  const pr = r.pulls![0];
  assert.equal(pr.merged, true);
  assert.equal(pr.merge_method, 'merge', 'a merge commit: the playtested commits go live as they are');
  assert.equal(pr.base.ref, 'main');
  assert.equal(r.refs.main, m.sha);
  const merge = r.commits[m.sha];
  assert.deepEqual(merge.parents, [sha('1'), sha('3')]);
  assert.equal(merge.tree, 't3', 'main has exactly the files that were playtested');
  assert.ok(isGoLiveMerge(merge.title!), merge.title);
  assert.equal(r.refs['studio/go-live-3333333'], undefined, "Studio's branch is cleaned up");
});

test('a required check that fails stops the go live; main stays where it was', async () => {
  const { go, r } = setup(site({ rulesets: PR_RULESETS(), checks: { [sha('3')]: [{ name: 'ci', status: 'completed', conclusion: 'failure' }] } }));
  await assert.rejects(go(), /failed its required check \(ci\).*wasn't moved/);
  assert.equal(r.refs.main, sha('1'));
});

test("today's rules (restrict updates): nothing moves, no pull request, and the message names the one card", async () => {
  const { go, r } = setup(site({ rulesets: HAWKES_RULESETS() }));
  await assert.rejects(go(), /restricts updates.*Approve "Let Studio go live".*Nothing moved/);
  assert.equal(r.refs.main, sha('1'));
  assert.equal((r.pulls ?? []).length, 0);
});

test('a rollback through a pull request is one squashed commit with the rollback title', async () => {
  const { gh, api, r } = setup(site({ rulesets: PR_RULESETS([]) }));
  r.refs.main = sha('3');
  r.commits[sha('9')] = { parents: [sha('3')], tree: 't1', title: 'Studio rollback: back to 1111111' };
  const m = await G.moveLive('acme/site', 'main', sha('9'), { api, direct: () => fastForward('acme/site', 'main', sha('9'), gh.f, 'ghs_site'), kind: 'rollback', title: 'Studio rollback: back to 1111111', sleep: async () => {} });
  assert.equal(m.how, 'pr');
  assert.equal(r.pulls![0].merge_method, 'squash');
  assert.deepEqual(r.commits[m.sha].parents, [sha('3')]);
  assert.equal(r.commits[m.sha].tree, 't1');
  assert.match(r.commits[m.sha].title!, /^Studio rollback:/);
});

test('the one-time setup step: restrict updates becomes pull requests with no reviewer; everything else stays', async () => {
  assert.deepEqual(G.fixRules([{ type: 'deletion' }, { type: 'non_fast_forward' }]), null, 'nothing to change');
  const fixed = G.fixRules([{ type: 'update', parameters: { update_allows_fetch_and_merge: false } }])!;
  assert.deepEqual(fixed.map((x) => x.type), ['pull_request']);
  assert.equal(fixed[0].parameters!.required_approving_review_count, 0);
  const reviewed = G.fixRules([{ type: 'pull_request', parameters: { required_approving_review_count: 2, require_code_owner_review: true, allowed_merge_methods: ['squash'] } }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } }])!;
  assert.equal(reviewed[0].parameters!.required_approving_review_count, 0);
  assert.equal(reviewed[0].parameters!.require_code_owner_review, false);
  assert.ok(reviewed[0].parameters!.allowed_merge_methods.includes('merge'));
  assert.equal(reviewed[1].type, 'required_status_checks', 'checks still required');

  const { api, go, r } = setup(site({ rulesets: HAWKES_RULESETS() }));
  const fix = await G.rulesFix(api, 'acme/site', 'main');
  assert.deepEqual(fix.rulesets.map((x) => x.name), ['Hawkes: who may push main'], 'the never-rewritten ruleset is left alone');
  assert.match(G.describeRulesFix(fix).join(' '), /no reviewer.*Go live tap/);
  const done = await G.applyRulesFix(api, fix);
  assert.match(done, /goes live from Studio on its own/);
  assert.deepEqual(r.puts!.map((p) => p.id), ['2']);
  assert.deepEqual(r.puts![0].body, { rules: [{ type: 'pull_request', parameters: G.NO_REVIEW_PR }] }, 'only the rules change: no bypass list in the request');
  assert.equal(G.rulesShape(Object.values(r.rulesets!).flatMap((x) => x.rules)).viaPr, true);
  // And the next go live is the owner's tap alone.
  const m = await go();
  assert.equal(m.how, 'pr');
  assert.equal(r.commits[r.refs.main].tree, 't3');
});

test("a ruleset that isn't the repository's own is named, not touched", async () => {
  const { api } = setup(site({ rulesets: { '7': { name: 'Org policy', source_type: 'Organization', source: 'acme', rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }] } } }));
  const fix = await G.rulesFix(api, 'acme/site', 'main');
  assert.equal(fix.rulesets.length, 0);
  assert.match(fix.cannot.join(), /organization acme/);
  await assert.rejects(G.applyRulesFix(api, fix), /organization acme/);
});

test("main's earlier go live merges never send main into beta", async () => {
  const repo = site();
  repo.commits[sha('4')] = { parents: [sha('1'), sha('3')], tree: 't3', title: `${G.STUDIO_GOLIVE} beta 3333333 of Site` };
  repo.refs.main = sha('4');
  const gh = fakeGitHub({ 'acme/site': repo });
  const s = await syncBetaWithLive('acme/site', { fetch: gh.f, token: 'ghs_site' });
  assert.equal(s.how, 'none');
  assert.equal(repo.refs.beta, sha('3'), 'beta untouched');
});
