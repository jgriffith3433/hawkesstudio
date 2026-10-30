// Going live with a Unity game on Cloud Run (deploy-cloud.ts): both repos read and both mains moved through GitHub's API,
// fast-forward only, with no checkout. A fake GitHub (a map of refs and commit histories); nothing real is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-deploy-cloud-'));
const { compareOnGitHub, cloudGoLiveNow, isAncestorOnGitHub } = await import('../src/deploy-cloud.ts');
const { getProduct } = await import('../src/config.ts');

const sha = (c: string) => c.repeat(40).slice(0, 40);
/** A fake GitHub: each repo has refs and a linear history per branch (oldest first). PATCHes are recorded and applied. */
function fakeGitHub(repos: Record<string, { refs: Record<string, string>; history: Record<string, string[]> }>) {
  const patched: string[] = [];
  const commit = (s: string) => ({ sha: s, commit: { message: `commit ${s.slice(0, 1)}\nbody`, author: { name: 'J' }, committer: { date: '2026-10-30T00:00:00Z' } } });
  const chain = (repo: string, s: string) => Object.values(repos[repo].history).find((h) => h.includes(s))!.slice(0, Object.values(repos[repo].history).find((h) => h.includes(s))!.indexOf(s) + 1);
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const m = /^\/repos\/([^/]+\/[^/]+)\/(.*)$/.exec(u.pathname)!;
    const [slug, rest] = [m[1], m[2]];
    const r = repos[slug];
    const ref = (x: string) => r.refs[x] ?? x;
    let mm;
    if ((mm = /^commits\/(.+)$/.exec(rest))) return new Response(JSON.stringify(commit(ref(mm[1]))));
    if ((mm = /^compare\/(.+)\.\.\.(.+)$/.exec(rest))) {
      const a = chain(slug, ref(mm[1])), b = chain(slug, ref(mm[2]));
      const ahead = b.filter((x) => !a.includes(x)), behind = a.filter((x) => !b.includes(x));
      const status = !ahead.length && !behind.length ? 'identical' : !behind.length ? 'ahead' : !ahead.length ? 'behind' : 'diverged';
      return new Response(JSON.stringify({ status, ahead_by: ahead.length, behind_by: behind.length, commits: ahead.map(commit) }));
    }
    if ((mm = /^git\/refs\/heads\/(.+)$/.exec(rest)) && init.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      const cur = r.refs[mm[1]];
      if (body.force !== false || !chain(slug, body.sha).includes(cur)) return new Response(JSON.stringify({ message: 'Update is not a fast forward' }), { status: 422 });
      r.refs[mm[1]] = body.sha;
      patched.push(`${slug} ${mm[1]} ${body.sha.slice(0, 1)}`);
      return new Response(JSON.stringify({ ref: `refs/heads/${mm[1]}` }));
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, patched };
}

test('compareOnGitHub: the commits beta has that main lacks, newest first, and none the other way', async () => {
  const { f } = fakeGitHub({ 'o/src': { refs: { main: sha('a'), beta: sha('c') }, history: { beta: [sha('a'), sha('b'), sha('c')] } } });
  const c = await compareOnGitHub('o/src', f, 't');
  assert.equal(c.main?.sha, sha('a'));
  assert.equal(c.beta?.short, 'ccccccc');
  assert.deepEqual(c.ahead.map((x) => x.short), ['ccccccc', 'bbbbbbb']);
  assert.equal(c.ahead[0].title, 'commit c');
  assert.deepEqual(c.behind, []);
});

test('compareOnGitHub: main with commits beta lacks shows them as behind', async () => {
  const { f } = fakeGitHub({ 'o/src': { refs: { main: sha('d'), beta: sha('c') }, history: { main: [sha('a'), sha('d')], beta: [sha('a'), sha('c')] } } });
  const c = await compareOnGitHub('o/src', f, 't');
  assert.deepEqual(c.behind.map((x) => x.short), ['ddddddd']);
  assert.ok(await isAncestorOnGitHub('o/src', sha('a'), sha('c'), f, 't'));
  assert.ok(!(await isAncestorOnGitHub('o/src', sha('d'), sha('c'), f, 't')));
});

test("going live moves the website's main to its beta and the source's main to the played beta, fast-forward only", async () => {
  const p = getProduct('sickofit');
  const { f, patched } = fakeGitHub({
    'jgriffith3433/sickofitgame-unity': { refs: { main: sha('a'), beta: sha('b') }, history: { beta: [sha('a'), sha('b')] } },
    'jgriffith3433/sickofitgamewebsite': { refs: { main: sha('e'), beta: sha('f') }, history: { beta: [sha('e'), sha('f')] } },
  });
  const r = await cloudGoLiveNow(p, { beta: { sha: sha('b'), short: 'bbbbbbb' }, site: { beta: sha('f') } }, f, 't');
  assert.deepEqual(patched, ['jgriffith3433/sickofitgamewebsite main f', 'jgriffith3433/sickofitgame-unity main b']);
  assert.equal(r.before, sha('e'));
  assert.equal(r.after, sha('f'));
  assert.equal(r.sourceAfter, sha('b'));
});

test('going live refuses when beta moved since the plan, and moves nothing', async () => {
  const p = getProduct('sickofit');
  const { f, patched } = fakeGitHub({
    'jgriffith3433/sickofitgame-unity': { refs: { main: sha('a'), beta: sha('c') }, history: { beta: [sha('a'), sha('b'), sha('c')] } },
    'jgriffith3433/sickofitgamewebsite': { refs: { main: sha('e'), beta: sha('f') }, history: { beta: [sha('e'), sha('f')] } },
  });
  await assert.rejects(cloudGoLiveNow(p, { beta: { sha: sha('b'), short: 'bbbbbbb' }, site: { beta: sha('f') } }, f, 't'), /moved since the plan/);
  assert.deepEqual(patched, []);
});
