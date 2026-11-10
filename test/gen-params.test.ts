import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
const G = await import('../src/gen-params.ts');

const REFUSAL = 'Bad params for playtest.run: playtest.run has no param "skipProviders" (it takes: url, build, scenario, mode, seed, mobile, gpu)';

beforeEach(() => G.resetKnownParams());

test('reads Gen\'s refusal: which params it does not take and what it takes', () => {
  assert.deepEqual(G.parseUnknownParams(REFUSAL), { tool: 'playtest.run', unknown: ['skipProviders'], takes: ['url', 'build', 'scenario', 'mode', 'seed', 'mobile', 'gpu'] });
  assert.equal(G.parseUnknownParams('Bad params for playtest.run: url is required'), null);
  assert.equal(G.parseUnknownParams('fetch failed'), null);
});

test('an unknown param is left out and the job submitted again, once', async () => {
  const sent: any[] = [];
  const submit = async (tool: string, body: any) => {
    sent.push(body.params);
    if ('skipProviders' in body.params) throw Object.assign(new Error(REFUSAL), { status: 400 });
    return { id: 'j1', status: 'queued' };
  };
  const job = await G.submitKnown(submit, 'playtest.run', { project: 'p', params: { url: 'u', seed: 1, skipProviders: ['modal'] }, priority: 2 });
  assert.equal(job.id, 'j1');
  assert.deepEqual(job.droppedParams, ['skipProviders']);
  assert.deepEqual(sent, [{ url: 'u', seed: 1, skipProviders: ['modal'] }, { url: 'u', seed: 1 }]);
  // Learned: the next submit leaves it out before sending.
  sent.length = 0;
  await G.submitKnown(submit, 'playtest.run', { project: 'p', params: { url: 'u', skipProviders: ['x'] } });
  assert.deepEqual(sent, [{ url: 'u' }]);
});

test('any other refusal is thrown as before', async () => {
  const submit = async () => { throw new Error('Bad params for playtest.run: url is required'); };
  await assert.rejects(G.submitKnown(submit, 'playtest.run', { project: 'p', params: {} }), /url is required/);
  const offline = async () => { throw Object.assign(new Error('fetch failed'), { kind: 'offline' }); };
  await assert.rejects(G.submitKnown(offline, 'playtest.run', { project: 'p', params: { url: 'u' } }), /fetch failed/);
});

test('a param Gen names that Studio did not send is not this problem', async () => {
  const submit = async () => { throw new Error('Bad params for playtest.run: playtest.run has no param "foo" (it takes: url)'); };
  await assert.rejects(G.submitKnown(submit, 'playtest.run', { project: 'p', params: { url: 'u' } }), /no param "foo"/);
});

test('other tools are untouched by what one tool takes', async () => {
  const sent: any[] = [];
  const submit = async (tool: string, body: any) => {
    sent.push([tool, body.params]);
    if (tool === 'playtest.run' && 'skipProviders' in body.params) throw new Error(REFUSAL);
    return { id: 'j' };
  };
  await G.submitKnown(submit, 'playtest.run', { project: 'p', params: { url: 'u', skipProviders: [] } });
  sent.length = 0;
  await G.submitKnown(submit, 'review.run', { project: 'p', params: { anything: 1 } });
  assert.deepEqual(sent, [['review.run', { anything: 1 }]]);
});
