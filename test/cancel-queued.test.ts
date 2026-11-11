// 2026-11-11: Cloud Run cancels only a running execution ("cannot be cancelled because it is not running"). Executions
// Studio had given up on while still queued stayed queued, and took the region's CPU the moment any freed. A queued one
// is now deleted; a running one is cancelled; a finished one is left alone (src/gcp.ts cancelExecution).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cancelExecution, setGcpFetch } from '../src/gcp.ts';

function fake(ex: Record<string, any>) {
  const calls: string[] = [];
  setGcpFetch((async (input: any, init: any = {}) => {
    const url = String(input), method = init.method ?? 'GET';
    calls.push(`${method} ${url.split('/executions/')[1]}`);
    const name = url.split('/executions/')[1].replace(':cancel', '');
    const j = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    if (url.endsWith(':cancel')) return ex[name].running ? j(200, {}) : j(400, { error: { code: 400, status: 'FAILED_PRECONDITION', message: `Execution '${name}' cannot be cancelled because it is not running.` } });
    if (method === 'GET') return j(200, ex[name].body);
    if (method === 'DELETE') { ex[name].deleted = true; return j(200, {}); }
    return j(404, {});
  }) as any, 'test-token');
  return calls;
}

test('a queued execution is deleted, a running one cancelled, a finished one left alone', async () => {
  const ex: Record<string, any> = {
    q: { running: false, body: { name: 'q' } },
    r: { running: true, body: { name: 'r', startTime: 't' } },
    d: { running: false, body: { name: 'd', startTime: 't', completionTime: 't2' } },
  };
  const calls = fake(ex);
  try {
    for (const n of ['q', 'r', 'd']) await cancelExecution(`projects/p/locations/us-east4/jobs/j/executions/${n}`);
    assert.equal(ex.q.deleted, true);
    assert.equal(ex.r.deleted, undefined);
    assert.equal(ex.d.deleted, undefined);
    assert.ok(!calls.includes('DELETE r') && !calls.includes('DELETE d'));
  } finally { setGcpFetch(null); }
});
