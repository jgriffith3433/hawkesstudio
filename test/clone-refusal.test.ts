// On Cloud Run a project too big to clone isn't cloned (repos.ts cloneRefusal): a Unity project (a customer cell's has
// its builds in `builds`, which the old guards missed: the cell restarted about once a minute for hours, 2026-11-01),
// or any of its repos over STUDIO_CLONE_MAX_MB by GitHub's size. Off Cloud Run nothing changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-clone-refusal-'));
const { cloneRefusal, productSlugs, forgetRepoSizes, TOO_BIG } = await import('../src/repos.ts');

/** GitHub's repo answer by slug (size in KB), counting the calls. */
function github(kb: Record<string, number>) {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    const slug = String(url).replace(/^.*\/repos\//, '');
    calls.push(slug);
    return slug in kb ? new Response(JSON.stringify({ size: kb[slug] }), { status: 200 }) : new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const web = { id: 'tiny', engine: 'web' as const, repo: 'tiny', site: 'tiny', github: 'cust/tiny' };
const unityBuilds = { id: 'yooba', engine: 'web' as const, repo: 'yooba', site: 'yooba', github: 'cust/yooba', builds: [{ id: 'webgl', tool: 'unity' }] as any };
const bigRepo = { id: 'huge', engine: 'web' as const, repo: 'huge', site: 'huge', github: 'cust/huge', repos: [{ repo: 'cust/huge-assets' }] };

async function onCloudRun<T>(fn: () => Promise<T>) {
  process.env.K_SERVICE = 'studio-test';
  try { return await fn(); } finally { delete process.env.K_SERVICE; }
}

test('off Cloud Run nothing is refused and GitHub is never asked', async () => {
  forgetRepoSizes();
  const g = github({ 'cust/huge': 5_000_000 });
  assert.equal(await cloneRefusal(unityBuilds, g.fetcher), null);
  assert.equal(await cloneRefusal(bigRepo, g.fetcher), null);
  assert.deepEqual(g.calls, []);
});

test("a customer's Unity project (tool unity in builds) is refused without asking GitHub", async () => {
  forgetRepoSizes();
  const g = github({});
  const why = await onCloudRun(() => cloneRefusal(unityBuilds, g.fetcher));
  assert.ok(why?.startsWith(TOO_BIG), why ?? 'no refusal');
  assert.match(why!, /yooba is a Unity project/);
  assert.deepEqual(g.calls, []);
  // J's products.json kind: a legacy Unity `build`.
  assert.ok(await onCloudRun(() => cloneRefusal({ ...web, id: 'old', build: { project: 'X' } as any }, g.fetcher)));
});

test('a repo over the size limit is refused, any of the repos it would clone', async () => {
  forgetRepoSizes();
  const g = github({ 'cust/huge': 100, 'cust/huge-assets': 3_000_000 });
  const why = await onCloudRun(() => cloneRefusal(bigRepo, g.fetcher));
  assert.match(why!, /cust\/huge-assets is about 2930 MB, more than Studio can clone/);
  assert.deepEqual(g.calls, ['cust/huge', 'cust/huge-assets']);
  // The size is remembered: asking again doesn't call GitHub.
  await onCloudRun(() => cloneRefusal(bigRepo, g.fetcher));
  assert.equal(g.calls.length, 2);
});

test('a small web repo clones; the limit is STUDIO_CLONE_MAX_MB', async () => {
  forgetRepoSizes();
  const g = github({ 'cust/tiny': 200 * 1024 });
  assert.equal(await onCloudRun(() => cloneRefusal(web, g.fetcher)), null);
  process.env.STUDIO_CLONE_MAX_MB = '100';
  try { assert.match((await onCloudRun(() => cloneRefusal(web, g.fetcher)))!, /cust\/tiny is about 200 MB/); }
  finally { delete process.env.STUDIO_CLONE_MAX_MB; }
  // GitHub not answering (no token, down) clones as before, and isn't remembered.
  forgetRepoSizes();
  const none = github({});
  assert.equal(await onCloudRun(() => cloneRefusal(web, none.fetcher)), null);
  await onCloudRun(() => cloneRefusal(web, none.fetcher));
  assert.equal(none.calls.length, 2);
});

test('the repos a product would clone: its repo, its site and its other repos, by folder or slug', () => {
  const map = { dod: 'jg/dod', dodsite: 'jg/dod-site', extra: 'jg/extra' };
  assert.deepEqual(productSlugs({ id: 'd', engine: 'web', repo: 'dod/src', site: 'dodsite', repos: [{ repo: 'jg/extra', folder: 'extra' }, { repo: 'jg/more' }] }, map), ['jg/dod', 'jg/dod-site', 'jg/extra', 'jg/more']);
});
