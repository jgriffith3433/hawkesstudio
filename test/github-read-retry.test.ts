// A read GitHub doesn't answer the first time is tried again, and a plan that still can't read GitHub says GitHub didn't
// answer, never "connect GitHub" (2026-11-10 21:26: one slow compare failed Studio's own go live and nothing retried it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gh, ghRetry, compareOnGitHub } from '../src/deploy-cloud.ts';

ghRetry.waits = [0, 0];
const ok = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

test('a GET that times out once is tried again and answers', async () => {
  let n = 0;
  const f = (async () => { if (n++ === 0) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); return ok({ sha: 'a' }); }) as typeof fetch;
  const r = await gh(f, 't', 'GET', '/repos/me/x/commits/main');
  assert.equal(r.ok, true); assert.equal(n, 2);
});

test('a GET that gets a 502 then 200 is tried again', async () => {
  let n = 0;
  const f = (async () => (n++ === 0 ? ok({ message: 'bad gateway' }, 502) : ok({ sha: 'a' }))) as typeof fetch;
  const r = await gh(f, 't', 'GET', '/repos/me/x/commits/main');
  assert.equal(r.status, 200); assert.equal(n, 2);
});

test('a write is never repeated', async () => {
  let n = 0;
  const f = (async () => { n++; return ok({ message: 'bad gateway' }, 502); }) as typeof fetch;
  const r = await gh(f, 't', 'PATCH', '/repos/me/x/git/refs/heads/main', { sha: 'a' });
  assert.equal(r.status, 502); assert.equal(n, 1);
});

test('a read GitHub never answers fails with what happened, after three tries', async () => {
  let n = 0;
  const f = (async () => { n++; throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }) as typeof fetch;
  await assert.rejects(compareOnGitHub('me/x', f, 't'), /GitHub didn't answer GET \/repos\/me\/x\/commits\/(main|beta): The operation was aborted due to timeout/);
  assert.ok(n >= 3, `tried ${n} times`); // three tries of the read that failed first
});
