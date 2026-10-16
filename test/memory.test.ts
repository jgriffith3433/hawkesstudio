// The shared memory on a scratch database: who may write what (decisions are J's), duplicates confirm instead of
// piling up, the prompt block (stable part first, scope, canon for content work), learned.md from agents, fading,
// run history, the export and the seed. No Claude, GitHub or Gen involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-memory-'));
process.env.STUDIO_DATA = path.join(tmp, 'data');
process.env.STUDIO_PROJECTS = path.join(tmp, 'Projects');
process.env.STUDIO_PRODUCTS = path.join(tmp, 'products.json');
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
const prod = (id: string, name: string) => ({ id, name, framing: 'test', engine: 'static', repo: id, site: id, live: 'http://127.0.0.1:9/', local: { serve: 'static', dir: id, port: 8797, path: '/' }, playtests: [], story: [], about: 'A fixture.' });
fs.writeFileSync(process.env.STUDIO_PRODUCTS, JSON.stringify({ products: [prod('sickofit', 'Sick Of It'), prod('dod', 'Dose Of Destruction')], infra: [{ id: 'hawkesstudio', name: 'Hawkes Studio', repo: 'hawkesstudio', slug: 'x/y', about: 'Studio', checks: [], smoke: {} }] }));

const rm = await import('../src/roadmap.ts');
const mem = await import('../src/memory.ts');
const { db } = await import('../src/db.ts');
const { callerOf } = await import('../src/memory-api.ts');
db.exec("CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, session TEXT, status TEXT NOT NULL DEFAULT 'idle', messages TEXT NOT NULL DEFAULT '[]', cost REAL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER, kind TEXT)");

const J = { who: 'J' } as const;
const agent = { who: 'agent', id: 'c_000000000001' } as const;

function conversation(messages: { role: string; text: string; notice?: boolean }[]) {
  const id = `t_${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;
  db.prepare('INSERT INTO conversations (id, title, status, messages, created) VALUES (?, ?, ?, ?, ?)').run(id, 'x', 'idle', JSON.stringify(messages.map((m) => ({ ...m, at: Date.now() }))), Date.now());
  return id;
}

test('decisions are J\'s: Talk must quote his own message, agents never', () => {
  const d = mem.writeMemory({ kind: 'decision', title: 'Sick Of It stays free to play', product: 'sickofit' }, J);
  assert.equal(d.memory.status, 'active');
  assert.equal(d.memory.by, 'J');
  assert.throws(() => mem.writeMemory({ kind: 'decision', title: 'Ship everything on Fridays' }, agent), /Decisions are J's/);
  const conv = conversation([{ role: 'user', text: 'Let us keep reviews on Sonnet, they are cheap enough.' }, { role: 'assistant', text: 'We should use Opus for reviews.' }, { role: 'assistant', text: 'Studio says: use Haiku', notice: true }]);
  const talk = { who: 'talk', id: conv } as const;
  assert.throws(() => mem.writeMemory({ kind: 'decision', title: 'Reviews use Opus', quote: 'We should use Opus for reviews' }, talk), /quote his own message/, "Claude's own words are not J's");
  assert.throws(() => mem.writeMemory({ kind: 'decision', title: 'Reviews use Haiku', quote: 'Studio says: use Haiku' }, talk), /quote/, "Studio's notices are not J's");
  const ok = mem.writeMemory({ kind: 'decision', title: 'Reviews stay on Sonnet', quote: 'keep reviews on Sonnet' }, talk);
  assert.equal(ok.memory.status, 'active');
  assert.equal(ok.memory.quote, 'keep reviews on Sonnet');
  // Nobody but J changes a decision's status.
  assert.throws(() => mem.updateMemory(ok.memory.id, { status: 'faded' }, { who: 'pm', id: conv }), /J's to change/);
  assert.equal(mem.updateMemory(ok.memory.id, { status: 'disputed', note: 'contradicts m_x' }, { who: 'pm', id: conv }).status, 'disputed');
});

test('agents write candidates; duplicates confirm the entry instead of adding one', () => {
  const a = mem.writeMemory({ kind: 'lesson', title: 'Git LFS must be pulled on the build server', body: 'Unity import fails with missing textures unless git lfs pull runs after checkout.', product: 'sickofit' }, agent);
  assert.equal(a.memory.status, 'candidate');
  assert.equal(a.memory.by, 'agent c_000000000001');
  assert.equal(a.memory.source, 'c_000000000001');
  const b = mem.writeMemory({ kind: 'lesson', title: 'Git LFS must be pulled on the build server', body: 'missing textures in Unity: run git lfs pull after checkout', product: 'sickofit' }, { who: 'agent', id: 'c_000000000002' });
  assert.equal(b.merged, true);
  assert.equal(b.memory.id, a.memory.id);
  assert.equal(b.memory.sources.length, 1);
  // Talk seeing it again makes it active.
  const c = mem.writeMemory({ kind: 'lesson', title: 'Git LFS must be pulled on the build server', body: 'git lfs pull after checkout, else missing textures', product: 'sickofit' }, { who: 'talk', id: null });
  assert.equal(c.memory.id, a.memory.id);
  assert.equal(c.memory.status, 'active');
  // Another product's lesson is separate.
  const d = mem.writeMemory({ kind: 'lesson', title: 'Git LFS must be pulled on the build server', product: 'dod' }, agent);
  assert.notEqual(d.memory.id, a.memory.id);
  // Agents can't curate.
  assert.throws(() => mem.writeMemory({ kind: 'nonsense', title: 'x y z w' }, J), /kind must be/);
  assert.throws(() => mem.deleteMemory(a.memory.id, agent), /Only J/);
});

test('the prompt block: decisions first, scope, canon for content, matches on the task, stable order', () => {
  mem.writeMemory({ kind: 'canon', title: 'Slimes are villagers, never enemies', body: 'In Sick Of It, slimes live in Hell\'s villages; the player never fights them.', product: 'sickofit', source: 'sickofitgame-unity/Docs/Story.md' }, { who: 'seed' });
  mem.writeMemory({ kind: 'convention', title: 'The whole game is JSON in Assets/GameConfig', body: 'Edit GameConfig JSON, not prefabs; validators log to Logs/GameConfig.log.', product: 'sickofit' }, J);
  mem.writeMemory({ kind: 'convention', title: 'DoD fighters live in content/fighters.json', product: 'dod' }, J);
  mem.writeMemory({ kind: 'preference', title: 'J reads plain words, not code', body: 'Explain what changed and how it was verified.' }, J);
  const fixer = mem.memoryBlock({ product: 'sickofit', role: 'fixer', text: 'enemy wave config json floor 12 spawns slimes' });
  assert.match(fixer.text, /free to play/, 'the product\'s decisions');
  assert.match(fixer.text, /plain words/, 'studio-wide preferences');
  assert.match(fixer.text, /GameConfig/, 'a matching convention');
  assert.doesNotMatch(fixer.text, /fighters\.json/, 'not another product\'s');
  assert.ok(fixer.text.indexOf('[decision]') < fixer.text.indexOf('[convention]'), 'decisions first');
  const content = mem.memoryBlock({ product: 'sickofit', role: 'content', text: 'new floor dialogue' });
  assert.match(content.text, /Slimes are villagers/, 'content work gets the canon');
  const stable1 = mem.memoryBlock({ product: 'sickofit', role: 'talk', stableOnly: true }).text;
  const stable2 = mem.memoryBlock({ product: 'sickofit', role: 'talk', stableOnly: true, text: 'anything else' }).text;
  assert.equal(stable1, stable2, 'the stable part does not depend on the task');
  assert.ok(stable1.length > 0);
  const used = mem.getMemory(fixer.ids[0])!;
  assert.ok(used.uses >= 1, 'injected entries count as used');
  assert.match(mem.briefSection({ product: 'sickofit', role: 'fixer', text: 'GameConfig' }).text, /What the studio already knows/);
});

test('learned.md from an agent becomes candidates; runs are searchable', () => {
  const ids = mem.learnFrom(`Notes
- lesson: Python heredocs eat backslashes — use a quoted 'EOF' delimiter so \\n stays literal
- convention: Pages source switches to GitHub Actions on the first pages.yml push
- decision: we should ship on Fridays
just text`, agent, { product: 'dod', source: 'c_000000000001' });
  assert.equal(ids.length, 2, 'the decision line is refused');
  const l = mem.getMemory(ids[0])!;
  assert.equal(l.kind, 'lesson');
  assert.equal(l.title, 'Python heredocs eat backslashes');
  assert.match(l.body, /quoted 'EOF'/);
  assert.equal(l.status, 'candidate');
  const run = mem.recordRun({ kind: 'fix', subject: 'c_000000000001', product: 'dod', title: 'Fix: black screen after the stage music starts', outcome: 'merged', summary: 'The music loader awaited a promise that never resolved on Safari; now it times out.', lessons: 'audio unlock needs a user gesture', by: 'agent' });
  const hits = mem.search('black screen music', { product: 'dod' });
  assert.equal(hits.runs[0].id, run);
  assert.ok(mem.search('heredoc backslash').memories.some((m) => m.id === ids[0]));
  const cur = mem.curation();
  assert.ok(cur.candidates.some((c) => c.id === ids[0]));
  assert.match(mem.curationLine(), /candidate/);
});

test('fading: unused entries fade, decisions and canon never', () => {
  const old = Date.now() - 100 * 86_400_000;
  const s = mem.writeMemory({ kind: 'state', title: 'Agent working on the shop page', product: 'dod' }, J).memory;
  const l = mem.writeMemory({ kind: 'lesson', title: 'An old lesson nobody reads anymore', product: 'dod' }, J).memory;
  db.prepare('UPDATE memories SET created = ?, updated = ?, confirmed = ?, last_used = NULL WHERE id IN (?, ?)').run(old, old, old, s.id, l.id);
  db.prepare("UPDATE memories SET created = ?, updated = ?, confirmed = ? WHERE kind IN ('decision', 'canon')").run(old, old, old);
  const faded = mem.fadeUnused();
  assert.ok(faded.includes(s.id) && faded.includes(l.id));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM memories WHERE kind IN ('decision','canon') AND status = 'faded'").get() as any).n, 0);
  // Faded entries stay searchable but aren't injected.
  assert.ok(mem.search('old lesson nobody').memories.some((m) => m.id === l.id));
  assert.doesNotMatch(mem.memoryBlock({ product: 'dod', text: 'old lesson nobody reads' }).text, /old lesson/);
});

test('items, merge, J edits, export and seed', () => {
  const it = rm.addItem({ product: 'dod', title: 'Controls', status: 'planned' });
  const e = mem.writeMemory({ kind: 'state', title: 'Controls: gamepad mapping half done', item: it.id }, { who: 'pm', id: null }).memory;
  assert.equal(e.scope, 'item');
  assert.equal(e.product, 'dod');
  assert.match(mem.memoryBlock({ product: 'dod', item: it.id, text: 'gamepad mapping' }).text, /half done/);
  const a = mem.writeMemory({ kind: 'convention', title: 'Maps are folders in AllTheMaps', product: 'dod' }, J).memory;
  const b = mem.writeMemory({ kind: 'convention', title: 'Stage ids come from AllTheMaps folder names', product: 'dod' }, agent).memory;
  const m = mem.mergeMemories(a.id, b.id, { who: 'pm', id: null });
  assert.equal(m.sources.length, 1);
  assert.equal(mem.getMemory(b.id), null);
  const edited = mem.updateMemory(a.id, { body: 'Folder name = stage id (docs/maps.md).' }, J);
  assert.equal(edited.edited, 1);
  const files = mem.exportMarkdown();
  assert.ok(files['canon.md'].includes('Slimes are villagers'));
  assert.ok(files['learned/dod.md'].includes('Folder name = stage id'));
  assert.ok(files['learned/studio.md'].includes('plain words'));
  assert.ok(!files['learned/dod.md'].includes('Python heredocs'), 'candidates are not exported');
  const dir = path.join(tmp, 'seed');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'canon-x.json'), JSON.stringify({ kind: 'canon', product: 'dod', entries: [{ title: 'Exit Punk opens the show', body: 'A walk-on with one skateboard.' }] }));
  assert.equal(mem.importSeed(dir).entries, 1);
  assert.equal(mem.importSeed(dir).entries, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM memories WHERE title = 'Exit Punk opens the show'").get() as any).n, 1, 'importing again never duplicates');
});

test('who is calling', () => {
  const conv = conversation([]);
  db.prepare("UPDATE conversations SET kind = 'pm' WHERE id = ?").run(conv);
  const req = (h: Record<string, string>) => ({ headers: h, socket: {} }) as any;
  assert.deepEqual(callerOf(req({})), { who: 'J' });
  assert.deepEqual(callerOf(req({ 'x-studio-agent': 'c_0123456789ab' })), { who: 'agent', id: 'c_0123456789ab' });
  assert.deepEqual(callerOf(req({ 'x-studio-agent': 'x_0123456789ab' })), { who: 'scout', id: 'x_0123456789ab' });
  assert.deepEqual(callerOf(req({ 'x-talk-conversation': conv })), { who: 'pm', id: conv });
});
