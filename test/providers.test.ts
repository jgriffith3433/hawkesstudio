// Several AI providers at once (src/providers.ts): which provider a pass runs on (J's order, the least busy, a role's own,
// the session's own while it answers), what Settings switches do, and when the Inbox's ONE AI card shows: only when J
// is needed (a sign-in or billing on a provider he uses, or nothing at all can run). Usage limits elsewhere heal quietly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-providers-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_HARNESS_MINUTE_MS = '1';
for (const k of ['HAWKES_BRAIN', 'STUDIO_PROVIDERS_MODE', 'STUDIO_HARNESS_ORDER', 'STUDIO_HARNESS_FAILOVER', 'NTFY_TOPIC']) delete process.env[k];
fs.mkdirSync(process.env.STUDIO_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'notify.json'), JSON.stringify({ enabled: false, topic: 'test' }));

const P = await import('../src/providers.ts');
const hold = await import('../src/harness-hold.ts');
const brains = await import('../src/brains.ts');
const { db } = await import('../src/db.ts');

// Signed in here: Claude, Codex and Cursor (every CLI "installed"); Copilot, Antigravity and Gemini not.
const signedIn = new Set(['claude', 'codex', 'cursor']);
P.providerDeps.installed = () => true;
P.providerDeps.configured = (h) => signedIn.has(h);
const said: string[] = [];
Object.assign(hold.holdDeps, { talk: async (t: string) => void said.push(t), phone: async (t: string) => void said.push(`phone: ${t}`), probe: async () => ({ ok: false, note: 'no answer' }), syncGen: async () => {}, otherAccounts: async () => [], activeAccount: async () => null });
const reset = () => {
  db.prepare('DELETE FROM harness_holds').run();
  db.prepare("DELETE FROM settings WHERE key = 'providers'").run();
  brains.saveBrain('claude');
  brains.setFailover(null);
  said.length = 0;
};
const limit = (harness: any, kind: 'usage' | 'auth' | 'billing') => hold.holdHarness({ kind, line: `${kind} stop`, resetsAt: null }, { source: 'test', harness });

test('spread: every signed-in provider takes work, the least busy first, in J\'s order on a tie', () => {
  reset();
  assert.equal(P.providerSettings().mode, 'spread', 'several at once is the default');
  assert.deepEqual(P.readyHarnesses(), ['claude', 'codex', 'cursor']);
  assert.equal(P.pickHarness(), 'claude');
  const a = P.using('claude');
  assert.equal(P.pickHarness(), 'codex', 'Claude is busy: the next pass goes to Codex');
  const b = P.using('codex');
  assert.equal(P.pickHarness(), 'cursor');
  a(); b();
  // A resumed pass stays on the provider that holds its session while it answers; a role can have its own.
  assert.equal(P.pickHarness({ prefer: 'cursor' }), 'cursor');
  P.saveProviders({ roles: { scout: 'cursor' } });
  assert.equal(P.pickHarness({ role: 'scout' }), 'cursor');
  assert.equal(P.pickHarness({ role: 'fixer' }), 'claude');
  // J's order and switches.
  P.saveProviders({ order: ['codex', 'claude'], use: { cursor: false } });
  assert.deepEqual(P.readyHarnesses(), ['codex', 'claude']);
  assert.equal(P.pickHarness({ role: 'scout' }), 'codex', 'its provider is off: the spread picks');
  assert.deepEqual(brains.fallbackChain('codex').slice(0, 1), ['claude'], 'failover follows J\'s order without the ones he switched off');
  assert.ok(!brains.fallbackChain('codex').includes('cursor'));
  assert.throws(() => P.saveProviders({ off: ['claude', 'codex', 'cursor', 'copilot', 'antigravity', 'gemini'] }), /at least one/);
  assert.throws(() => P.saveProviders({ mode: 'all' }), /spread \| one/);
});

test('a usage limit moves the work and needs no card; a lost sign-in gets ONE card; nothing left means paused, with a way out', async () => {
  reset();
  limit('claude', 'usage');
  assert.equal(P.pickHarness({ prefer: 'claude' }), 'codex', "the held provider's session moves to the next one");
  assert.equal(P.noProviderFree(), false);
  assert.equal(P.providerTrouble(), null, 'Studio heals a usage limit by itself: no card');
  assert.ok(said.some((t) => /Claude is held: work moves to Codex, Cursor/.test(t)), said.join(' | '));
  assert.ok(!said.some((t) => /Agents paused/.test(t)));

  limit('codex', 'auth');
  let t = P.providerTrouble();
  assert.ok(t && !t.stuck, 'Cursor still runs');
  assert.deepEqual(t!.holds.map((h) => h.harness), ['codex'], 'only what needs J');
  const { inbox, answerInbox } = await import('../src/inbox.ts');
  let cards = (await inbox()).filter((x) => x.kind === 'ai');
  assert.equal(cards.length, 1);
  assert.match(cards[0].title, /^Codex needs you: Codex is not signed in/);
  assert.match(cards[0].text ?? '', /Sign Codex in again: Settings → AI providers → Sign in\./);
  assert.match(cards[0].text ?? '', /Nothing stopped: Cursor carries the work/);
  assert.ok(cards[0].options.includes('Stop using Codex'));

  limit('cursor', 'usage');
  t = P.providerTrouble();
  assert.equal(t?.stuck, true, 'nothing can run');
  assert.equal(P.noProviderFree(), true, 'the queue, PM and scouts wait');
  cards = (await inbox()).filter((x) => x.kind === 'ai');
  assert.equal(cards.length, 1, 'still ONE card');
  assert.match(cards[0].title, /^AI work is paused: no provider can take it \(Codex needs you\)/);
  assert.match(cards[0].text ?? '', /parked with their work and continue by themselves/);

  // J switches Codex off from the card: still one card, and Codex's sign-in no longer asks.
  await answerInbox('ai:providers', 'Stop using Codex', 'J');
  assert.ok(P.providerSettings().off.includes('codex'));
  t = P.providerTrouble();
  assert.ok(t?.stuck && !t.holds.some((h) => h.harness === 'codex'));
  // A member (not J) can't switch providers.
  await assert.rejects(answerInbox('ai:providers', 'Stop using Claude', 'agent c_1'), /J's call/);

  // Cursor answers again (its probe): it takes the work, and the card is gone.
  hold.liftHold('a probe answered', 'cursor');
  hold.liftHold('a probe answered', 'claude');
  assert.equal(P.providerTrouble(), null);
  assert.equal((await inbox()).filter((x) => x.kind === 'ai').length, 0, 'healed: the card withdrew by itself');
});

test('one at a time: the chosen harness runs everything, and the card offers every signed-in provider', async () => {
  reset();
  P.saveProviders({ mode: 'one' });
  brains.saveBrain('codex');
  assert.equal(P.pickHarness({ role: 'fixer' }), 'codex');
  limit('codex', 'billing');
  assert.ok(said.some((t) => /^phone: Agents paused/.test(t)), 'J hears once on his phone');
  const { inbox, answerInbox } = await import('../src/inbox.ts');
  const card = (await inbox()).find((x) => x.kind === 'ai');
  assert.ok(card?.options.includes('Use every signed-in provider'), card?.options.join(' | '));
  await answerInbox('ai:providers', 'Use every signed-in provider', 'J');
  assert.equal(P.providerSettings().mode, 'spread');
  assert.equal(P.noProviderFree(), false, 'Claude and Cursor take the work now');
  assert.ok(P.providerTrouble()?.holds.some((h) => h.harness === 'codex'), 'the bill is still J\'s to pay: the card stays for it');
});

test('code work fills the best provider up to its cap, then overflows; a provider that just throttled is tried last', () => {
  reset();
  P.saveProviders({ caps: { claude: 2 } });
  assert.equal(P.providerSettings().caps.claude, 2);
  assert.equal(P.providerSettings().caps.cursor, P.DEFAULT_CAPS.cursor, 'unset caps keep their default');
  const a = P.using('claude');
  assert.equal(P.pickHarness({ role: 'builder' }), 'claude', 'deep work stays on Claude while it has room');
  const b = P.using('claude');
  assert.equal(P.pickHarness({ role: 'builder' }), 'codex', 'Claude is at its cap: the next in J\'s order takes it');
  assert.equal(P.pickHarness({ role: 'scout' }), 'codex', 'scouts go to the least busy with room');
  a(); b();
  // Claude's hold just lifted: code goes to the others first for a while, Claude still takes overflow.
  const was = P.providerDeps.lifted;
  P.providerDeps.lifted = (h) => (h === 'claude' ? Date.now() - 60_000 : null);
  assert.equal(P.pickHarness({ role: 'fixer' }), 'codex');
  P.providerDeps.lifted = (h) => (h === 'claude' ? Date.now() - 3600_000 : null);
  assert.equal(P.pickHarness({ role: 'fixer' }), 'claude', 'cooled down: back first');
  P.providerDeps.lifted = was;
  // Every provider full: the least full for its cap, so nothing stalls.
  const all = [P.using('claude'), P.using('claude'), ...Array.from({ length: P.DEFAULT_CAPS.codex }, () => P.using('codex')), ...Array.from({ length: P.DEFAULT_CAPS.cursor }, () => P.using('cursor'))];
  assert.ok(['claude', 'codex', 'cursor'].includes(P.pickHarness({ role: 'builder' })));
  for (const r of all) r();
  assert.throws(() => P.saveProviders({ caps: { claude: 0 } }), /1 to 50/);
  assert.equal(P.providerStatus().providers.find((x) => x.id === 'claude')?.cap, 2);
});
