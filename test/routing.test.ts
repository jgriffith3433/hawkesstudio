// Model routing: categories, the climb on failure, the Opus budget and conserve mode, premium models only on J's own
// request, Talk's turns, the settings, the usage shares, and what an agent change runs on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-routing-'));
process.env.HAWKESGEN_URL = 'http://127.0.0.1:9';
delete process.env.HAWKES_BRAIN;
for (const k of Object.keys(process.env)) if (k.startsWith('STUDIO_MODEL_')) delete process.env[k];

const R = await import('../src/routing.ts');
const T = await import('../src/tuning.ts');
const { roleArgs } = await import('../src/roles.ts');
const { saveBrain } = await import('../src/brains.ts');
const { recordPass } = await import('../src/ledger.ts');
const { saveSettings, costRaising } = await import('../src/settings.ts');
const { db, J } = await import('../src/db.ts');
await import('../src/talk.ts');
const { attemptOf, changeRoute, withStuck } = await import('../src/agents.ts');

const arg = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const free = { deepToday: 0, conserve: false };
saveBrain({ harness: 'claude' }, 'test');

test('work is classified by its words, role and size', () => {
  assert.equal(R.classify({ text: 'Fix the typo in the main menu title' }).tier, 'fast');
  assert.equal(R.classify({ text: 'Fix the typo in the main menu title' }).category, 'small_isolated_edit');
  assert.equal(R.classify({ text: 'Write unit tests for the score parser' }).category, 'tests_from_spec');
  assert.equal(R.classify({ text: 'The game crashes when you open the shop: TypeError: cannot read properties of undefined' }).category, 'bug_with_repro');
  assert.equal(R.classify({ text: 'Add a pause button to the HUD' }).category, 'scoped_feature');
  assert.equal(R.classify({ text: 'Add a pause button to the HUD' }).tier, 'standard');
  assert.equal(R.classify({ text: 'Refactor the enemy spawner across all the scripts' }).category, 'multi_file_refactor');
  const sys = R.classify({ text: 'Players desync in the rollback netcode after a minute' });
  assert.equal(sys.category, 'systems_work');
  assert.equal(sys.tier, 'deep');
  assert.equal(R.classify({ text: 'Intermittent black screen, only in the WebGL build' }).category, 'far_from_symptom_bug');
  // Everyday playtest words don't send a bug to Opus.
  assert.notEqual(R.classify({ text: 'Sometimes the jump feels floaty on phone' }).tier, 'deep');
  assert.notEqual(R.classify({ text: 'Add a race mode to Slow Rider' }).tier, 'deep');
});

test('content, Studio/Gen changes, big requests and blockers never start on the smallest model', () => {
  assert.equal(R.classify({ text: 'Change the wording of Gloob\'s line', role: 'content' }).tier, 'standard');
  assert.equal(R.classify({ text: 'Fix the typo in the dashboard', role: 'infra' }).tier, 'standard');
  assert.equal(R.classify({ text: 'Fix the typo in the title', criteria: 5 }).tier, 'standard');
  assert.equal(R.classify({ text: `Fix the typo in the title. ${'More detail. '.repeat(120)}` }).tier, 'standard');
  const blocker = R.classify({ text: 'Fix the typo that blocks the start button', severity: 'blocker' });
  assert.equal(blocker.tier, 'standard');
  assert.equal(blocker.effort, 'high');
});

test('a failed attempt climbs one tier, never past the ceiling, and never to Fable', () => {
  const small = { text: 'Fix the typo in the main menu title', ...free };
  assert.equal(R.routeFor({ ...small, attempt: 1 }).tier, 'fast');
  assert.equal(R.routeFor({ ...small, attempt: 2 }).tier, 'standard');
  const third = R.routeFor({ ...small, attempt: 3 });
  assert.equal(third.tier, 'deep');
  assert.equal(third.escalations, 2);
  assert.equal(third.exhausted, false);
  const fourth = R.routeFor({ ...small, attempt: 4 });
  assert.equal(fourth.tier, 'deep', 'capped at two escalations');
  assert.equal(fourth.exhausted, true, 'past its escalations: re-scope');
  // A systems task already on deep climbs in effort instead.
  const sys = R.routeFor({ text: 'Port the render pipeline to URP', attempt: 3, ...free });
  assert.equal(sys.tier, 'deep');
  assert.equal(sys.effort, 'xhigh');
  for (let a = 1; a <= 8; a++) assert.notEqual(R.routeFor({ text: 'Port the render pipeline to URP', attempt: a, ...free }).tier, 'max');
  const capped = R.routeFor({ ...small, attempt: 3 }, { ...R.ROUTING_DEFAULTS, ceiling: 'standard' });
  assert.equal(capped.tier, 'standard');
});

test('the day\'s Opus budget and conserve mode hold automatic work on Sonnet with more effort', () => {
  const sys = { text: 'Players desync in the rollback netcode', attempt: 1 };
  assert.equal(R.routeFor({ ...sys, deepToday: 0, conserve: false }).tier, 'deep');
  const spent = R.routeFor({ ...sys, deepToday: 6, conserve: false });
  assert.equal(spent.tier, 'standard');
  assert.equal(spent.effort, 'high');
  assert.match(spent.capped!, /deep passes/);
  const conserving = R.routeFor({ ...sys, deepToday: 0, conserve: true });
  assert.equal(conserving.tier, 'standard');
  assert.match(conserving.capped!, /conserving/);
  assert.equal(R.routeFor({ ...sys, deepToday: 0, conserve: false }, { ...R.ROUTING_DEFAULTS, deepPerDay: 0 }).tier, 'standard', '0: no automatic Opus at all');
});

test('the ledger counts automatic Opus passes, and a usage limit starts conserve mode', () => {
  assert.equal(R.deepPassesToday(), 0);
  const p = { change: 'c_aaaaaaaaaaaa', role: 'builder', harness: 'claude', model: 'claude-opus-5-5', tier: 'deep', effort: 'high', retry: 1, ms: 1000, cost: 1, outcome: 'done' as const };
  recordPass({ ...p, category: 'systems_work' });
  recordPass({ ...p, premium: 'deep' });
  assert.equal(R.deepPassesToday(), 1, 'J\'s premium passes are not counted against the budget');
  assert.equal(R.conserving(), false);
  db.exec(`CREATE TABLE IF NOT EXISTS harness_holds (harness TEXT PRIMARY KEY, kind TEXT NOT NULL, why TEXT NOT NULL, line TEXT, account TEXT, since INTEGER NOT NULL, until INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, reset INTEGER, notified INTEGER, switched INTEGER, lifted INTEGER, log TEXT)`);
  db.prepare(`INSERT OR REPLACE INTO harness_holds (harness, kind, why, since, until) VALUES ('claude', 'usage', 'limit', ?, ?)`).run(Date.now() - 3600_000, Date.now());
  assert.equal(R.conserving(), true);
  db.prepare(`UPDATE harness_holds SET since = ? WHERE harness = 'claude'`).run(Date.now() - 7 * 3600_000);
  assert.equal(R.conserving(), false, 'six hours later it is over');
  db.exec('DELETE FROM pass_ledger');
});

test('premium models: only J asks, in his own words; Fable never comes from a rule', async () => {
  assert.equal(R.premiumAsked('use Fable for this one'), 'max');
  assert.equal(R.premiumAsked('plan this with the highest tier model'), 'max');
  assert.equal(R.premiumAsked('put opus on it'), 'deep');
  assert.equal(R.premiumAsked('fix the jump'), null);
  assert.equal(R.premiumAsked('why did opus run on this?'), null, 'a question about a model is not an ask');
  assert.equal(R.premiumAsked('what is the best model for this?'), null);
  assert.equal(R.premiumAsked('/fable plan the next milestone'), 'max');
  assert.equal(R.premiumAsked('switch to Opus for this task'), 'deep');
  assert.equal(R.premiumAsked('Fable for this one, please'), 'max');
  assert.equal(R.premiumTierOf('fable'), 'max');
  assert.equal(R.premiumTierOf('claude-opus-5-5'), 'deep');
  assert.equal(R.premiumTierOf('sonnet'), null);
  assert.throws(() => R.grantPremium('c_bbbbbbbbbbbb', 'max', 'Talk'), /Only J/);
  R.grantPremium('k_cccccccccccc', 'max', 'J (via Talk)', 'use fable');
  assert.equal(R.premiumFor('c_none', 'k_cccccccccccc')?.tier, 'max');
  const r = R.routeFor({ text: 'Fix the typo', premium: 'max', deepToday: 99, conserve: true });
  assert.equal(r.tier, 'max', 'J\'s ask is not capped');
  assert.equal(r.capped, null);
  R.clearPremium('k_cccccccccccc');
  assert.equal(R.premiumFor('k_cccccccccccc'), null);

  // From Talk: his newest message (or his quoted words) must ask for it.
  const conv = 't_0123456789ab';
  const say = (texts: string[]) => db.prepare('INSERT OR REPLACE INTO conversations (id, status, messages, created) VALUES (?, ?, ?, ?)')
    .run(conv, 'idle', J(texts.map((text, i) => ({ role: 'user', text, at: i }))), Date.now());
  const req = { headers: { 'x-talk-conversation': conv } } as any;
  say(['add a pause button']);
  await assert.rejects(R.premiumRequest(req, { model: 'fable' }), /only on J's request/);
  say(['add a pause button, and use Fable for it']);
  assert.deepEqual((await R.premiumRequest(req, { model: 'fable' }))?.tier, 'max');
  say(['plan the boss fight with opus please', 'yes go ahead']);
  await assert.rejects(R.premiumRequest(req, { model: 'opus' }), /only on J's request/);
  const quoted = await R.premiumRequest(req, { model: 'fable', quote: 'plan the boss fight with opus' });
  assert.equal(quoted?.tier, 'deep', 'he asked for Opus: that is what he gets');
  assert.equal(await R.premiumRequest(req, {}), null);
  await assert.rejects(R.premiumRequest(req, { model: 'gpt' }), /opus or fable/);
});

test('Talk: Studio\'s explaining turns on the fast tier, J\'s turn on his premium ask, else the role\'s tier', () => {
  assert.equal(R.talkTier({ auto: true, pm: false })?.tier, 'fast');
  assert.equal(R.talkTier({ auto: true, pm: true }), null, 'PM turns keep their tier');
  assert.equal(R.talkTier({ auto: false, pm: false, text: 'what is ready?' }), null);
  assert.equal(R.talkTier({ auto: false, pm: false, text: 'think this through with Fable' })?.tier, 'max');
  assert.equal(R.talkTier({ auto: true, pm: false }, { ...R.ROUTING_DEFAULTS, autoTurnsFast: false }), null);
  assert.equal(arg(roleArgs('talk', { tier: 'fast' }).args, '--model'), 'claude-haiku-5-5');
  assert.equal(arg(roleArgs('talk', { tier: 'max' }).args, '--model'), 'claude-fable-5-1');
});

test('settings: validated, and loosening them from Talk needs J\'s yes', async () => {
  assert.throws(() => R.cleanRouting({ ceiling: 'max' }, R.ROUTING_DEFAULTS), /max is only on J/);
  assert.throws(() => R.cleanRouting({ maxEscalations: 9 }, R.ROUTING_DEFAULTS), /0 to 3/);
  assert.throws(() => R.cleanRouting({ nope: 1 }, R.ROUTING_DEFAULTS), /not a setting/);
  const cur = R.routingSettings();
  assert.deepEqual(costRaising('routing', { deepPerDay: 2 }, cur), []);
  assert.ok(costRaising('routing', { deepPerDay: 20 }, cur).length);
  assert.ok(costRaising('routing', { enabled: false }, cur).length);
  await assert.rejects(saveSettings('routing', { deepPerDay: 50 }, { conversation: 't_none', quote: 'sure' }), /raise costs/);
  const saved = await saveSettings('routing', { deepPerDay: 3 }, { conversation: 't_none' });
  assert.equal((saved as any).deepPerDay, 3);
  R.saveRouting({ deepPerDay: R.ROUTING_DEFAULTS.deepPerDay });
});

test('tuning: a route sets the tier; a retry or a preset never reaches Fable', () => {
  assert.equal(T.roleTune('fixer', { tier: 'fast' }).model, 'claude-haiku-5-5');
  assert.equal(T.roleTune('fixer', { tier: 'max' }).model, 'claude-fable-5-1');
  assert.equal(T.roleTune('fixer', { retry: 5 }).tier, 'deep');
  T.saveTuning({ preset: 'quality' });
  assert.equal(T.roleTune('builder', { retry: 3 }).tier, 'deep');
  T.saveTuning({ preset: 'balanced' });
  assert.equal(T.tierOfModel('claude-fable-5-1'), 'max');
  assert.equal(T.tierOfModel('claude-sonnet-5-5'), 'standard');
  assert.ok(costRaising('tuning', { roles: { talk: { tier: 'max' } } }, T.tuningSettings() as any).length);
});

test('usage shares per tier from agents\' passes and Talk\'s turns, against the targets', () => {
  const p = { change: 'c_dddddddddddd', role: 'fixer', harness: 'claude', effort: 'medium', retry: 1, ms: 1000, outcome: 'done' as const };
  recordPass({ ...p, model: 'claude-sonnet-5-5', tier: 'standard', cost: 6 });
  recordPass({ ...p, model: 'claude-haiku-5-5', tier: 'fast', cost: 1 });
  db.prepare('INSERT OR REPLACE INTO conversations (id, status, messages, created, updated) VALUES (?, ?, ?, ?, ?)')
    .run('t_usage000000', 'idle', J([{ role: 'assistant', text: 'ok', at: Date.now(), turn: { cost: 3, billing: 'subscription', model: 'claude-opus-5-5' } }]), Date.now(), Date.now());
  const u = R.routingUsage(7);
  const by = Object.fromEntries(u.tiers.map((t) => [t.tier, t]));
  assert.equal(u.total, 10);
  assert.equal(by.standard.share, 60);
  assert.equal(by.deep.share, 30);
  assert.equal(by.fast.share, 10);
  assert.equal(by.deep.turns, 1);
  assert.equal(by.standard.status, 'ok');
  const st = R.routingStatus();
  assert.ok(st.rules.length >= 10);
  db.exec('DELETE FROM pass_ledger');
});

test('an agent change: its attempt, its route kept per attempt, its stuck report carried up', () => {
  const base: any = { id: 'c_eeeeeeeeeeee', product: 'sickofit', findings: [], criteria: [], task: null, request: 'Fix the typo in the pause menu', title: null, revisions: 0, auto_fixes: 0, route: null, notes: [], infra: false };
  db.prepare("INSERT OR REPLACE INTO changes (id, product, findings, status, created, request) VALUES (?, 'sickofit', '[]', 'working', ?, ?)").run(base.id, Date.now(), base.request);
  assert.equal(attemptOf(base), 1);
  const first = changeRoute(base)!;
  assert.equal(first.tier, 'fast');
  const stored = (db.prepare('SELECT route FROM changes WHERE id = ?').get(base.id) as any).route;
  assert.equal(JSON.parse(stored).attempt, 1);
  const second = changeRoute({ ...base, revisions: 1, route: stored })!;
  assert.equal(second.attempt, 2);
  assert.equal(second.tier, 'standard', 'sent back once: one tier up');
  R.grantPremium(base.id, 'deep', 'J');
  assert.equal(changeRoute({ ...base, route: stored })!.tier, 'deep', 'J\'s ask replaces the stored route');
  R.clearPremium(base.id);
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-wt-'));
  fs.mkdirSync(path.join(wt, '.hawkes'));
  assert.equal(withStuck(wt, 'summary'), 'summary');
  fs.writeFileSync(path.join(wt, '.hawkes', 'stuck.md'), 'tried A and B; the cause is in the loader');
  assert.match(withStuck(wt, 'summary'), /Stuck after two approaches:\ntried A and B/);
});

test('the Opus budget counts each provider on its own, and usage shows each provider\'s share', () => {
  db.exec('DELETE FROM pass_ledger');
  const p = { change: 'c_ffffffffffff', role: 'builder', model: 'x', tier: 'deep', effort: 'high', retry: 1, ms: 1000, cost: 1, outcome: 'done' as const, category: 'systems_work' };
  for (let i = 0; i < 6; i++) recordPass({ ...p, harness: 'claude' });
  recordPass({ ...p, harness: 'copilot', tier: 'standard', cost: 0, outcome: 'failed' });
  assert.equal(R.deepPassesToday(Date.now(), 'claude'), 6);
  assert.equal(R.deepPassesToday(Date.now(), 'copilot'), 0);
  const sys = { text: 'Migrate the save format to v3', role: 'builder' as const, conserve: false };
  assert.equal(R.routeFor({ ...sys, harness: 'claude' }).tier, 'standard', "Claude's six are used");
  assert.equal(R.routeFor({ ...sys, harness: 'copilot' }).tier, 'deep', "Copilot's budget is its own");
  const u = R.routingUsage(7);
  const cl = u.providers.find((x) => x.harness === 'claude')!;
  const co = u.providers.find((x) => x.harness === 'copilot')!;
  assert.equal(cl.passes, 6);
  assert.equal(co.passes, 1);
  assert.equal(co.failed, 1);
  assert.equal(cl.share, 85.7, 'by passes, so a provider that reports no cost still shows');
  assert.ok(R.routingStatus().byProvider.some((x) => x.harness === 'copilot' && x.deepToday === 0));
  db.exec('DELETE FROM pass_ledger');
});

test('"one line" in a long brief is not a small edit; a lookup question is', () => {
  assert.notEqual(R.classify({ text: 'Write the bible. On-screen text is a last resort, one line at most.' }).category, 'small_isolated_edit');
  assert.equal(R.classify({ text: 'Make the one-line fix to the pause label' }).category, 'small_isolated_edit');
  assert.equal(R.classify({ text: 'Is there a save system in Sick Of It?' }).category, 'lookup_or_explain');
  assert.equal(R.classify({ text: 'Where are the playtest scenarios?' }).tier, 'fast');
});
