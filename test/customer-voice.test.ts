// A customer's Studio speaks as its owner's own (docs/studio-customers.md section 4): Talk's and the PM's prompts, every
// role, every skill, the MCP tools Talk sees and the memory it starts with carry none of J's world: no Hawkes
// Biomedical, no Pierce, no "J" or "J's", none of J's products. test/j-voice.test.ts checks J's Studio still has them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-voice-'));
process.env.STUDIO_MAIL = 'off';
process.env.STUDIO_SIGNUP = 'owner';
delete process.env.STUDIO_PRODUCTS;
delete process.env.STUDIO_AGENTS_DIR;
delete process.env.STUDIO_PLUGIN_DIR;
fs.writeFileSync(path.join(process.env.STUDIO_DATA, 'products.json'), JSON.stringify({ products: [{ id: 'moon', name: 'Moon Rover', engine: 'web', live: 'https://moon.example', about: 'A lunar driving game.', quality: 'Drives smoothly at 60 fps.', playtests: [{ scenario: 'smoke', where: 'live' }], story: [] }] }));

/** J's world: any of these in a customer's Studio is a leak. */
export const MARKERS: [string, RegExp][] = [
  ['Hawkes Biomedical', /Hawkes Biomedical/i], ['Pierce', /\bPierce\b/], ["J's", /\bJ['’]s\b/], ['J', /(^|[^\w.@/<-])J\b(?![.\w-])/],
  ['Sick Of It', /Sick Of It/i], ['Dose Of Destruction', /Dose Of Destruction|\bDoD\b/], ['PH Origins', /PH Origins|phorigins/i],
  ['Yooba', /Yooba/i], ['The Place Department', /Place Department|breakingthrough/i], ['Imagine Live TV', /Imagine Live|Final Spark/i],
  ['I Can Be', /I Can Be|icanbe/i], ['jgriffith3433', /jgriffith/i], ['the B3 vat', /\bB3\b/],
];
const leaks = (text: string) => MARKERS.filter(([, re]) => re.test(text)).map(([m]) => m);

const A = await import('../src/auth.ts');
A.googleUser({ email: 'ada@moon.example', sub: '9100001', name: 'Ada Lovelace' });
const T = await import('../src/talk.ts');
const R = await import('../src/roles.ts');

test('Talk and the PM: their prompt names the owner and their game, none of J\'s world', () => {
  for (const kind of ['talk', 'pm'] as const) {
    const p = T.talkPromptText(kind);
    assert.deepEqual(leaks(p), [], `${kind}: ${leaks(p).join(', ')}`);
  }
  const talk = T.talkPromptText('talk');
  assert.match(talk, /Ada's Hawkes Studio/);
  assert.match(talk, /Moon Rover \(moon\), played at https:\/\/moon\.example: A lunar driving game\. \(done means: Drives smoothly at 60 fps\.\)/);
  const call = T.talkPromptText('talk', 'phone');
  assert.deepEqual(leaks(call), [], `call: ${leaks(call).join(', ')}`);
});

test("every role and skill is the customer plugin's, with none of J's world", () => {
  assert.equal(path.basename(R.PLUGIN_DIR()), 'customer-plugin');
  for (const name of R.ROLES) {
    const role = R.loadRole(name);
    assert.deepEqual(leaks(`${role.description}\n${role.body}`), [], `${name}: ${leaks(role.body).join(', ')}`);
  }
  const skills = R.listSkills().map((s) => s.name).sort();
  assert.deepEqual(skills, ['builds', 'game-quality', 'gen-assets', 'onboarding', 'playtest-scenario', 'shared-memory']);
  for (const s of skills) {
    const text = fs.readFileSync(path.join(R.PLUGIN_DIR(), 'skills', s, 'SKILL.md'), 'utf8');
    assert.deepEqual(leaks(text), [], `${s}: ${leaks(text).join(', ')}`);
  }
  const plugin = fs.readFileSync(path.join(R.PLUGIN_DIR(), '.claude-plugin', 'plugin.json'), 'utf8');
  assert.equal(JSON.parse(plugin).name, 'studio');
  assert.ok(R.roleArgs('talk').args.includes(R.PLUGIN_DIR()), 'the runs get this plugin');
});

test("Talk's tools: no platform tools, descriptions without J", async () => {
  const { studioMcp, PLATFORM_TOOLS } = await import('../src/mcp-tools.ts');
  const s = studioMcp({ studio: async () => ({}), waitRun: async () => ({}) } as any);
  const names = s.tools.map((t) => t.name);
  for (const p of PLATFORM_TOOLS) assert.ok(!names.includes(p), `${p} is listed`);
  for (const t of s.tools) assert.deepEqual(leaks(`${t.description}`), [], `${t.name}: ${leaks(t.description).join(', ')}`);
  assert.deepEqual(leaks(s.instructions ?? ''), []);
});

test("the memory starts with generic conventions only; J's seed already in a Studio is removed", async () => {
  const M = await import('../src/memory.ts');
  // A Studio made before this imported J's seed: it is there now.
  M.importSeed(path.join(process.cwd(), 'memory', 'seed'));
  const { db } = await import('../src/db.ts');
  const count = () => (db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as { n: number }).n;
  assert.ok(count() > 20, "J's seed imported (its studio-wide entries: canon of J's products fails without them)");
  M.startMemory();
  const all = db.prepare(`SELECT kind, title, body, key FROM memories`).all() as { kind: string; title: string; body: string; key: string }[];
  assert.ok(all.length >= 5 && all.every((m) => m.key?.startsWith('seed:conventions:')), all.map((m) => m.key).join(', '));
  assert.ok(all.every((m) => m.kind === 'convention'), 'no decisions, preferences, canon or lessons');
  for (const m of all) assert.deepEqual(leaks(`${m.title} ${m.body}`), [], m.title);
});

test('anything else that still says J reaches Claude in the owner\'s name', async () => {
  const { forOwner } = await import('../src/owner.ts');
  assert.equal(forOwner("J asked for this; J's decision stands. Ready for J to test."), "Ada asked for this; Ada's decision stands. Ready for Ada to test.");
  assert.equal(forOwner('Keep J.json, j@x.io and ID-J intact'), 'Keep J.json, j@x.io and ID-J intact');
});

test("the tool list a customer's Talk and agents get: their Studio's, with none of J's world", async () => {
  const { cloudMcp } = await import('../src/cloudjob.ts');
  assert.equal((cloudMcp({ TALK_CONVERSATION: 't' }, '') as any).hawkesstudio.env.STUDIO_CUSTOMER, '1', 'the tool server in the shared job knows it is a customer Studio');
  const { studioMcp, PLATFORM_TOOLS } = await import('../src/mcp-tools.ts');
  const s: any = studioMcp();
  const names = s.tools.map((t: any) => t.name);
  for (const n of PLATFORM_TOOLS) assert.ok(!names.includes(n), `${n} is J's`);
  const text = [s.instructions, ...s.tools.map((t: any) => `${t.name}: ${t.description} ${JSON.stringify(t.inputSchema)}`)].join('\n');
  for (const bad of [/\bJ\b/, /\bJ's\b/, /AWS/, /\$0\.77/, /sickofit|yoobaland|theplacedepartment|doseofdestruction|phorigins/i, /Hawkes Biomedical/, /every Hawkes product/i, /"memory" branch/]) {
    const m = bad.exec(text);
    assert.ok(!m, `customer sees ${bad}: …${m ? text.slice(Math.max(0, m.index - 80), m.index + 60).replace(/\n/g, ' ') : ''}…`);
  }
});
