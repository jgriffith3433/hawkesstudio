// Content health (src/content.ts): the standard integration's pieces in a checkout, the SDK copies and their versions,
// and which slots a kind's recipe could make that an entity has no pick for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-content-'));
// wire() writes into C:\Projects\<repo>: a temp folder here (the products are Studio's own products.json).
const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-projects-'));
process.env.STUDIO_PROJECTS = projects;
const { contract, sdkCopies, unmade, makeable, wire } = await import('../src/content.ts');

const repo = () => fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
const put = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

test('the contract: a mapping, the MCP server, an AGENTS.md section', () => {
  const a = repo();
  assert.deepEqual(contract(a), { mapping: null, mcp: false, agents: false });
  put(a, 'hawkes.library.json', '{}');
  put(a, '.mcp.json', JSON.stringify({ mcpServers: { hawkesgen: { command: 'node' } } }));
  put(a, 'AGENTS.md', '# Game\n\n## Generative AI (Hawkes Gen)\n\nUse it.\n');
  assert.deepEqual(contract(a), { mapping: 'hawkes.library.json', mcp: true, agents: true });
  put(a, 'hawkes.content.json', '{}');
  assert.equal(contract(a).mapping, 'hawkes.content.json');

  // A Unity project inside its product folder: the MCP server and the docs are one level up; README.md counts.
  const outer = repo();
  const inner = path.join(outer, 'Game');
  put(inner, 'hawkes.library.json', '{}');
  put(outer, '.mcp.json', JSON.stringify({ mcpServers: { hawkesgen: {} } }));
  put(outer, 'README.md', '## Generative AI: Hawkes Gen\n');
  assert.deepEqual(contract(inner), { mapping: 'hawkes.library.json', mcp: false, agents: false });
  assert.deepEqual(contract(inner, [outer]), { mapping: 'hawkes.library.json', mcp: true, agents: true });
});

test('SDK copies are found with their versions, outside node_modules', () => {
  const a = repo();
  put(a, 'tools/hawkesgen.mjs', 'export const CLIENT_VERSION = 5;\n');
  put(a, 'src/editor/hawkesgen/hawkesgen-ui.mjs', 'export const UI_VERSION = 1;\n');
  put(a, 'tools/hawkesgen-folders.mjs', '// bridge\n');
  put(a, 'node_modules/x/hawkesgen.mjs', 'export const CLIENT_VERSION = 1;\n');
  assert.deepEqual(sdkCopies(a), [
    { file: 'src/editor/hawkesgen/hawkesgen-ui.mjs', name: 'hawkesgen-ui.mjs', version: 1 },
    { file: 'tools/hawkesgen-folders.mjs', name: 'hawkesgen-folders.mjs', version: null },
    { file: 'tools/hawkesgen.mjs', name: 'hawkesgen.mjs', version: 5 },
  ]);
});

test('unmade: slots the recipe can make that have no pick (wildcards are per entity, so left out)', () => {
  const kinds = { prop: { slots: { reference: { make: { tool: 'image.generate' } }, model: { make: { tool: 'mesh.textured' } }, notes: {} } }, enemy: { slots: { 'pose/*': { make: {} } } } };
  assert.deepEqual(makeable(kinds, 'prop'), ['reference', 'model']);
  assert.deepEqual(makeable(kinds, 'enemy'), []);
  const entities = [
    { id: 'p/desk', name: 'desk', kind: 'prop', slots: { model: { current: { n: 1 } } } },
    { id: 'p/chair', name: 'chair', kind: 'prop', slots: { reference: { current: { n: 2 } }, model: { current: { n: 1 } } } },
    { id: 'p/bird', name: 'bird', kind: 'enemy', slots: {} },
  ];
  assert.deepEqual(unmade(entities, kinds), [{ entity: 'p/desk', name: 'desk', kind: 'prop', slots: ['reference'] }]);
});

test('wire writes only what is missing, and is a no-op the second time', () => {
  const dir = path.join(projects, 'icanbeaiwebsite');
  put(dir, 'README.md', '# I Can Be\n');
  put(dir, '.mcp.json', JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  fs.mkdirSync(path.join(projects, 'hawkesgen', 'presets'), { recursive: true });
  const dry = wire('icanbe', { kind: 'character', root: 'art', dry: true });
  assert.ok(dry.wrote.every((w: any) => w.action.startsWith('would-')));
  assert.ok(!fs.existsSync(path.join(dir, 'AGENTS.md')));

  const r = wire('icanbe', { kind: 'character', root: 'art' });
  assert.deepEqual(r.wrote.map((w: any) => [w.file, w.action]), [
    ['icanbeaiwebsite/.mcp.json', 'added'],
    ['icanbeaiwebsite/AGENTS.md', 'created'],
    ['icanbeaiwebsite/hawkes.library.json', 'created'],
    ['hawkesgen/presets/icanbe.json', 'created'],
  ]);
  const mcp = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(mcp).sort(), ['hawkesgen', 'hawkesstudio', 'other']);
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /## Generative AI: Hawkes Gen[\s\S]*project `icanbe`[\s\S]*hawkes.library.json/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(projects, 'hawkesgen', 'presets', 'icanbe.json'), 'utf8')).style, '');
  assert.deepEqual(contract(dir), { mapping: 'hawkes.library.json', mcp: true, agents: true });
  assert.equal(wire('icanbe', { kind: 'character', root: 'art' }).nothing, true);
});
