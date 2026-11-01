// Settings → Playtests (playtest-capacity.ts): playtests at once and the GPU provider order live in Hawkes Gen
// (GET/PUT /v1/playtest/capacity); Studio keeps J's value, shows what Gen applied, keeps it while Gen lacks the API
// (404) and sends it the next time the tab opens. A customer's Studio neither sees nor changes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-playtests-'));
const P = await import('../src/playtest-capacity.ts');
const { allSettings, saveSettings, costRaising } = await import('../src/settings.ts');
const { db } = await import('../src/db.ts');

type Call = { path: string; method: string; body?: any };
/** A fake Gen: `api` false answers 404 (a Gen from before the API); limits clamp browsers like provider accounts do. */
function fakeGen(state: { api: boolean; offline?: boolean; refuse?: string }) {
  const calls: Call[] = [];
  const gen = { browsers: 2, perWorker: 4, providers: [
    { id: 'runpod', kind: 'gpu', enabled: true, maxBrowsers: 8, ok: false, reason: 'out of credit' },
    { id: 'modal', kind: 'gpu', enabled: true, maxBrowsers: 12, ok: true, reason: null },
    { id: 'aws', kind: 'gpu', enabled: false, maxBrowsers: 4, ok: true, reason: null },
  ] };
  P.capacityApi.request = async (p: string, o: any = {}) => {
    const method = o.method ?? 'GET';
    calls.push({ path: p, method, body: o.body });
    assert.equal(p, '/playtest/capacity');
    assert.ok(o.signal, 'every ask has a timeout');
    if (state.offline) throw Object.assign(new Error("Can't reach Hawkes Gen"), { status: 0, kind: 'offline' });
    if (!state.api) throw Object.assign(new Error('Not found'), { status: 404 });
    if (method === 'PUT') {
      if (state.refuse) throw Object.assign(new Error(state.refuse), { status: 400 });
      if (o.body.providers) {
        const byId = new Map(gen.providers.map((x) => [x.id, x]));
        gen.providers = [...o.body.providers.map((id: string) => ({ ...byId.get(id)!, enabled: true })), ...gen.providers.filter((x) => !o.body.providers.includes(x.id)).map((x) => ({ ...x, enabled: false }))];
      }
      if (o.body.browsers !== undefined) gen.browsers = Math.min(o.body.browsers, 12);
      return { browsers: gen.browsers, providers: gen.providers.filter((x) => x.enabled).map((x) => x.id) };
    }
    return structuredClone(gen);
  };
  return calls;
}
const reset = () => db.prepare("DELETE FROM settings WHERE key = 'playtests'").run();

test('the tab shows what Gen runs, per worker, and each provider with its limit and reason', async () => {
  reset();
  const calls = fakeGen({ api: true });
  const s = (await allSettings()).playtests!;
  assert.equal(s.browsers, 2);
  assert.equal(s.gen.state, 'ok');
  assert.equal(s.gen.perWorker, 4);
  assert.deepEqual(s.providers, ['runpod', 'modal']);
  assert.deepEqual(s.gen.providers.map((x) => [x.id, x.maxBrowsers, x.ok, x.reason]), [['runpod', 8, false, 'out of credit'], ['modal', 12, true, null], ['aws', 4, true, null]]);
  assert.deepEqual(calls.map((c) => c.method), ['GET'], 'asked once, on open');
});

test('saving sends it to Gen and shows what Gen applied, clamped to what the providers allow', async () => {
  reset();
  const calls = fakeGen({ api: true });
  const s = await saveSettings('playtests', { browsers: 20 }, { conversation: null });
  assert.deepEqual(calls.map((c) => [c.method, c.body]), [['PUT', { browsers: 20 }], ['GET', undefined]]);
  assert.equal(s.browsers, 12);
  assert.equal(s.wanted!.browsers, 20);
  assert.equal(s.wanted!.pending, undefined);
  assert.match(s.gen.note!, /You asked for 20; Gen runs 12/);
  const o = await saveSettings('playtests', { providers: ['modal', 'runpod'] }, { conversation: null });
  assert.deepEqual(calls.at(-2)!.body, { providers: ['modal', 'runpod'] });
  assert.deepEqual(o.providers, ['modal', 'runpod']);
  assert.deepEqual(o.gen.providers.map((x) => [x.id, x.enabled]), [['modal', true], ['runpod', true], ['aws', false]]);
  assert.deepEqual(o.wanted, { browsers: 20, providers: ['modal', 'runpod'] });
});

test('validation: a whole number 1-64, at least one provider, each once, nothing else', async () => {
  fakeGen({ api: true });
  for (const [patch, re] of [[{ browsers: 0 }, /1 to 64/], [{ browsers: 2.5 }, /1 to 64/], [{ browsers: 65 }, /1 to 64/], [{ providers: [] }, /at least one/],
    [{ providers: ['modal', 'modal'] }, /each provider once/], [{ providers: ['a b'] }, /provider ids/], [{ colour: 1 }, /not a setting/], [{}, /browsers and\/or providers/]] as const) {
    await assert.rejects(saveSettings('playtests', patch as any, { conversation: null }), re, JSON.stringify(patch));
  }
});

test("Gen without the API (404): the value is kept, the tab says it needs Gen's next release; sent when the tab next opens", async () => {
  reset();
  const state = { api: false };
  let calls = fakeGen(state);
  const s = await saveSettings('playtests', { browsers: 6 }, { conversation: null });
  assert.equal(s.gen.state, 'missing');
  assert.equal(s.gen.note, P.NEEDS_GEN);
  assert.equal(s.browsers, 6, 'shows the kept value');
  assert.equal(s.wanted!.pending, true);
  assert.deepEqual(calls.map((c) => c.method), ['PUT'], 'no retry loop');
  // Opening the tab while Gen still lacks it: one ask, still kept.
  calls = fakeGen(state);
  assert.equal((await allSettings()).playtests!.gen.state, 'missing');
  assert.deepEqual(calls.map((c) => c.method), ['PUT']);
  // Gen's next release: opening the tab sends the kept value, once.
  state.api = true;
  calls = fakeGen(state);
  const after = (await allSettings()).playtests!;
  assert.deepEqual(calls.map((c) => [c.method, c.body]), [['PUT', { browsers: 6 }], ['GET', undefined]]);
  assert.equal(after.browsers, 6);
  assert.equal(after.wanted!.pending, undefined);
  calls = fakeGen(state);
  await allSettings();
  assert.deepEqual(calls.map((c) => c.method), ['GET'], 'sent once');
});

test('Gen not answering: kept for the next open; Gen refusing a value: an error, nothing kept', async () => {
  reset();
  fakeGen({ api: true, offline: true });
  const s = await saveSettings('playtests', { browsers: 3 }, { conversation: null });
  assert.equal(s.gen.state, 'offline');
  assert.equal(s.wanted!.pending, true);
  reset();
  fakeGen({ api: true, refuse: 'unknown provider: lambda' });
  await assert.rejects(saveSettings('playtests', { providers: ['lambda'] }, { conversation: null }), /unknown provider: lambda/);
  assert.equal(P.playtestSettingsLocal().wanted, null);
});

test('from Talk: more at once or another provider order raises costs; fewer does not', () => {
  assert.deepEqual(costRaising('playtests', { browsers: 8 }, { browsers: 4 }), ['browsers 4 → 8']);
  assert.deepEqual(costRaising('playtests', { browsers: 2 }, { browsers: 4 }), []);
  assert.equal(costRaising('playtests', { providers: ['modal', 'runpod'] }, { providers: ['runpod', 'modal'] }).length, 1);
});

test("a customer's Studio: not shown, and changing it is refused", async () => {
  const calls = fakeGen({ api: true });
  process.env.STUDIO_CUSTOMER = '1';
  try {
    assert.equal((await allSettings()).playtests, null);
    await assert.rejects(saveSettings('playtests', { browsers: 4 }, { conversation: null }), /platform's/);
    assert.equal(calls.length, 0, 'Gen never asked');
  } finally { delete process.env.STUDIO_CUSTOMER; }
});
