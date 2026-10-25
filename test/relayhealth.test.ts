// Relay health (relayhealth.ts, NET-08): a relay swapped for a failing one in a fixture opens a finding, the signal
// route failing opens one, a clean check opens none, the settings are checked, and the schedule is once a day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-relays-'));
const r = await import('../src/relayhealth.ts');
const { db } = await import('../src/db.ts');
const { saveSettings, allSettings } = await import('../src/settings.ts');

// The game's net folder as a fixture: its shipped list, and a twopages.mjs that is only checked for existing.
const net = fs.mkdtempSync(path.join(os.tmpdir(), 'net-fixture-'));
fs.mkdirSync(path.join(net, 'src'));
fs.mkdirSync(path.join(net, 'test'));
fs.writeFileSync(path.join(net, 'test', 'twopages.mjs'), '');
fs.mkdirSync(path.join(net, 'node_modules'));
const list = (urls: string[]) => fs.writeFileSync(path.join(net, 'src', 'util.js'), `export const NOSTR_RELAYS = [\n${urls.map((u) => `  "${u}",`).join('\n')}\n];\n`);
const open = () => db.prepare(`SELECT * FROM findings WHERE product = 'yoobaland' AND source = 'relays' AND status = 'open'`).all() as any[];
const probe = (bad: string[]) => async (u: string) => (bad.includes(u) ? { ok: false, why: 'refused: rate-limited' } : { ok: true, why: 'answered' });
const cleanSoak = async () => ({ out: 'desktop SEES Phone via x\ndesktop SOAKED 9.8 poses/s\ndesktop GOT 1200 poses; status ok\n', code: 0, timedOut: false });

test('the shipped relay list is read from the game, and the setting overrides it', () => {
  list(['wss://a.example', 'wss://b.example']);
  assert.deepEqual(r.shippedRelays(net), ['wss://a.example', 'wss://b.example']);
  assert.deepEqual(r.relayList(r.relaySettings(), net), ['wss://a.example', 'wss://b.example']);
  assert.deepEqual(r.relayList({ ...r.relaySettings(), relays: ['wss://c.example'] }, net), ['wss://c.example']);
});

test('a clean check opens nothing', async () => {
  const run = await r.checkRelays({ probe: probe([]), soak: cleanSoak, netDir: net });
  assert.equal(run.probed, 2);
  assert.deepEqual(run.failures, []);
  assert.equal(open().length, 0);
});

test('a relay swapped in the fixture for one that refuses opens a finding, once', async () => {
  list(['wss://a.example', 'wss://swapped.example']);
  const run = await r.checkRelays({ probe: probe(['wss://swapped.example']), soak: cleanSoak, netDir: net });
  assert.deepEqual(run.failures, ['relay:swapped.example']);
  assert.equal(run.filed.length, 1);
  const f = open();
  assert.equal(f.length, 1);
  assert.match(f[0].title, /swapped\.example refuses/);
  const again = await r.checkRelays({ probe: probe(['wss://swapped.example']), soak: cleanSoak, netDir: net });
  assert.equal(again.filed.length, 0);
  assert.equal(open().length, 1);
  // Fixed, then failing again: it reopens.
  db.prepare(`UPDATE findings SET status = 'fixed', last_seen = 1 WHERE id = ?`).run(f[0].id);
  const back = await r.checkRelays({ probe: probe(['wss://swapped.example']), soak: cleanSoak, netDir: net });
  assert.equal(back.filed.length, 1);
  assert.equal(open().length, 1);
});

test('the soak: refusals and given-up relays are read, a failed run is the signal route', async () => {
  const out = [
    'desktop REPORT 15 s: 9.9 poses/s in, route nostr, batches 3 (0 by trackers), relays open 5, refusals: nos.lol x3 (rate-limited: slow down); relay.x.example x1',
    'desktop GAVE UP wss://relay.snort.social 40 s into the soak: rate limited',
    'desktop TIMEOUT soak failed: rate 0.4, swapped 1, lost 0',
  ].join('\n');
  const read = r.readSoak(out, 1, false, ['wss://nos.lol']);
  assert.deepEqual(read.relays.map((x) => x.key).sort(), ['relay:nos.lol', 'relay:relay.snort.social', 'relay:relay.x.example']);
  assert.equal(read.route?.key, 'signal-route');
  assert.equal(r.readSoak('desktop SEES x\ndesktop GOT 5 poses', 0, false, []).route, null);
  assert.equal(r.readSoak('Error: Cannot find module', 1, false, []).ran, false);
  assert.equal(r.readSoak('desktop SEES x', null, true, []).route?.key, 'signal-route');
});

test('a failing signal route opens a finding', async () => {
  list(['wss://a.example']);
  const soak = async () => ({ out: 'desktop SEES Phone via x\ndesktop TIMEOUT soak failed: rate 0.1\n', code: 1, timedOut: false });
  const run = await r.checkRelays({ probe: probe([]), soak, netDir: net });
  assert.deepEqual(run.failures, ['signal-route']);
  assert.ok(open().some((f) => f.key === 'signal-route'));
});

test('settings are checked, and the schedule is once a day', async () => {
  assert.deepEqual((await allSettings()).relays, r.relaySettings());
  const s = await saveSettings('relays', { hour: 7, soakSeconds: 90, relays: 'wss://x.example, wss://y.example' }, { conversation: null });
  assert.equal(s.hour, 7);
  assert.deepEqual(s.relays, ['wss://x.example', 'wss://y.example']);
  await assert.rejects(saveSettings('relays', { hour: 40 }, { conversation: null }), /0 to 23/);
  await assert.rejects(saveSettings('relays', { relays: ['http://nope'] }, { conversation: null }), /not a ws/);
  await assert.rejects(saveSettings('relays', { nope: 1 }, { conversation: null }), /not a setting/);
  const at = (h: number) => Date.UTC(2026, 9, 25, h);
  assert.equal(r.relayDue(at(6), r.relaySettings(), null), false);
  assert.equal(r.relayDue(at(8), r.relaySettings(), null), true);
  assert.equal(r.relayDue(at(9), r.relaySettings(), { at: at(8), probed: 1, failures: [], filed: [], note: '' }), false);
  assert.equal(r.relayDue(at(9) + 86_400_000, r.relaySettings(), { at: at(8), probed: 1, failures: [], filed: [], note: '' }), true);
  assert.equal(r.relayDue(at(9), { ...r.relaySettings(), enabled: false }, null), false);
});
