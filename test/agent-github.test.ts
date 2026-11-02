// GitHub for agents and Talk (agent-github.ts): any of this Studio's own repos, with Studio's token; reads and everyday
// writes go, merges, approvals, settings and pushes to main/beta/dev don't, and no other Studio's repo is reachable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-agent-gh-'));
const { githubRefusal, agentGithub, repoOfPath } = await import('../src/agent-github.ts');

test('the rules: everyday work goes, the gates stay', () => {
  const ok = (m: string, rest: string, body?: any) => assert.equal(githubRefusal(m, rest, body), null, `${m} ${rest}`);
  const no = (m: string, rest: string, body?: any) => assert.ok(githubRefusal(m, rest, body), `${m} ${rest} is refused`);
  ok('GET', '/pulls/3/files');
  ok('GET', '/actions/runs/9/logs');
  ok('POST', '/issues', { title: 'x' });
  ok('PATCH', '/issues/4', { state: 'closed' });
  ok('POST', '/issues/4/comments', { body: 'x' });
  ok('POST', '/pulls', { head: 'claude/fix-x', base: 'beta' });
  ok('POST', '/pulls/5/reviews', { event: 'COMMENT', body: 'x' });
  ok('POST', '/actions/workflows/ci.yml/dispatches', { ref: 'beta' });
  ok('POST', '/actions/runs/7/rerun-failed-jobs');
  ok('POST', '/git/refs', { ref: 'refs/heads/agent/x', sha: 'a' });
  ok('DELETE', '/git/refs/heads/claude/old');
  ok('PUT', '/contents/assets/a.png', { branch: 'claude/x', content: 'eA==', message: 'm' });
  no('PUT', '/pulls/5/merge');
  no('POST', '/merges', { base: 'main', head: 'beta' });
  no('POST', '/pulls/5/reviews', { event: 'APPROVE' });
  no('POST', '/pulls', { head: 'beta', base: 'main' });
  no('PATCH', '/git/refs/heads/main', { sha: 'a' });
  no('POST', '/git/refs', { ref: 'refs/heads/beta', sha: 'a' });
  no('PUT', '/contents/index.html', { branch: 'main', content: 'eA==' });
  no('PUT', '/contents/index.html', { content: 'eA==' });
  no('POST', '/releases', { tag_name: 'v1' });
  no('PATCH', '', { private: false });
  no('DELETE', '');
  no('PUT', '/collaborators/someone');
  no('POST', '/hooks', {});
  no('GET', '/actions/secrets');
  no('PUT', '/branches/main/protection', {});
  no('DELETE', '/issues/4');
  no('GET', '/contents/../../x');
  assert.equal(repoOfPath('/repos/o/n/issues')?.slug, 'o/n');
  assert.equal(repoOfPath('/repos/../n'), null);
});

test("only this Studio's repos, with its token for that repo", async () => {
  const seen: { url: string; auth: string | null; method: string }[] = [];
  const fetcher = (async (url: any, init: any) => {
    seen.push({ url: String(url), auth: new Headers(init.headers).get('authorization'), method: init.method });
    return new Response(JSON.stringify({ number: 12 }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const deps = { repos: async () => new Set(['me/site', 'me/game']), token: async (s: string) => `tok-${s}`, fetcher };
  const r = await agentGithub({ method: 'POST', path: '/repos/me/site/issues', body: { title: 'Broken link' } }, deps);
  assert.equal(r.status, 201);
  assert.deepEqual((r.data as any).number, 12);
  assert.equal(seen[0].url, 'https://api.github.com/repos/me/site/issues');
  assert.equal(seen[0].auth, 'Bearer tok-me/site');
  await assert.rejects(agentGithub({ path: '/repos/someone-else/repo/issues' }, deps), (e: any) => e.status === 403, "another Studio's repo");
  await assert.rejects(agentGithub({ path: '/user/repos' }, deps), (e: any) => e.status === 400, 'nothing outside /repos and search');
  await assert.rejects(agentGithub({ method: 'PUT', path: '/repos/me/site/pulls/3/merge' }, deps), /Merging is Studio/);
  // Search stays inside the Studio's repos.
  await agentGithub({ path: '/search/issues', query: { q: 'is:open label:bug' } }, deps);
  assert.match(new URL(seen.at(-1)!.url).searchParams.get('q')!, /repo:me\/site repo:me\/game/);
  await assert.rejects(agentGithub({ path: '/search/code', query: { q: 'x repo:other/repo' } }, deps), (e: any) => e.status === 403);
  await assert.rejects(agentGithub({ path: '/search/code', query: { q: 'x org:me' } }, deps), (e: any) => e.status === 400);
  // No token for the repo: said plainly.
  await assert.rejects(agentGithub({ path: '/repos/me/site/issues' }, { ...deps, token: async () => null }), (e: any) => e.status === 409);
});
