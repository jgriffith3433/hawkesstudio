// Moving a project's knowledge between Studios (src/memory-transfer.ts, docs/memory.md "Moving memory between Studios"):
// two scratch Studios (this process, and test/fixture/memory-studio.ts in its own process with its own data), a bundle
// exported from one and imported into the other under another project id, duplicates merging, decisions keeping their
// quotes, the one-time link (once, until it expires, never forged), the admin gate, and Markdown docs. No Claude or Gen.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-transfer-'));
const products = (file: string, ids: [string, string][]) => {
  const prod = ([id, name]: [string, string]) => ({ id, name, framing: 'test', engine: 'static', repo: id, site: id, live: 'http://127.0.0.1:9/', local: { serve: 'static', dir: id, port: 8797, path: '/' }, playtests: [], story: [], about: 'A fixture.' });
  fs.writeFileSync(file, JSON.stringify({ products: ids.map(prod), infra: [] }));
  return file;
};

// Studio A: the exporting one, its own process.
const aEnv = { ...process.env, STUDIO_DATA: path.join(tmp, 'a'), STUDIO_PROJECTS: path.join(tmp, 'a-projects'), STUDIO_PRODUCTS: products(path.join(tmp, 'a-products.json'), [['yooba', 'Yooba Land'], ['other', 'Other']]) };
fs.mkdirSync(aEnv.STUDIO_PROJECTS, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(import.meta.dirname, 'fixture', 'memory-studio.ts')], { env: aEnv, stdio: ['ignore', 'pipe', 'inherit'] });
after(() => child.kill());
const aPort: number = await new Promise((resolve, reject) => {
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; const m = /\{"port":(\d+)/.exec(buf); if (m) resolve(Number(m[1])); });
  child.on('exit', (code) => reject(new Error(`Studio A exited ${code}`)));
});
const A = `http://127.0.0.1:${aPort}`;

// Studio B: the importing one (a customer's, say), this process. Its project for the same game has another id.
process.env.STUDIO_DATA = path.join(tmp, 'b');
process.env.STUDIO_PROJECTS = path.join(tmp, 'b-projects');
process.env.STUDIO_PRODUCTS = products(path.join(tmp, 'b-products.json'), [['yland', 'Yooba Land'], ['moon', 'Moon Rover']]);
fs.mkdirSync(process.env.STUDIO_PROJECTS, { recursive: true });
const mem = await import('../src/memory.ts');
const T = await import('../src/memory-transfer.ts');
const api = await import('../src/memory-api.ts');
const auth = await import('../src/auth.ts');
const { db } = await import('../src/db.ts');
const { openRoute } = await import('../src/cloudauth.ts');
db.exec("CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, session TEXT, status TEXT NOT NULL DEFAULT 'idle', messages TEXT NOT NULL DEFAULT '[]', cost REAL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER, kind TEXT)");

const send = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readJson = async (req: http.IncomingMessage) => { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return c.length ? JSON.parse(Buffer.concat(c).toString('utf8')) : {}; };
const bServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    const link = /^\/api\/memory\/export\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (link && req.method === 'GET') return await api.handleExportLink(req, res, link[1], send);
    await api.handleMemory(req, res, url, send, readJson);
  } catch (e: any) { send(res, e?.status ?? 400, { error: e?.message ?? String(e) }); }
});
await new Promise<void>((r) => bServer.listen(0, '127.0.0.1', () => r()));
after(() => bServer.close());
const B = `http://127.0.0.1:${(bServer.address() as any).port}`;

const call = async (base: string, p: string, { method = 'GET', body, headers = {} }: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
  const r = await fetch(`${base}${p}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* Markdown */ }
  return { status: r.status, json, text };
};

// People of Studio B: an admin and a member, signed in.
const person = (email: string, role: string) => {
  const inv = auth.createInvite({ email, role, by: null });
  const u = auth.acceptInvite(inv.token, 'a long and decent passphrase 42', email.split('@')[0]);
  return { Cookie: `${auth.COOKIE}=${encodeURIComponent(auth.startSession(u).token)}` };
};
const admin = person('ada@moon.example', 'admin');
const member = person('max@moon.example', 'member');

let bundle: any;

test("a project's export: its active knowledge only, decisions with their quotes, no secrets, as JSON and Markdown", async () => {
  const r = await call(A, '/api/memory/export?product=yooba');
  assert.equal(r.status, 200, r.text);
  bundle = r.json;
  assert.equal(bundle.format, 'hawkes-memory/1');
  assert.equal(bundle.from, A);
  assert.equal(bundle.product, 'yooba');
  const titles = bundle.entries.map((e: any) => e.title);
  assert.equal(bundle.entries.length, 6, titles.join(' | '));
  assert.ok(!titles.some((t: string) => /lobby rewrite|unconfirmed note|Another game/.test(t)), 'no work in progress, candidates or other projects');
  assert.deepEqual([...new Set(bundle.entries.map((e: any) => e.kind))].sort(), ['canon', 'convention', 'decision', 'lesson', 'preference']);
  const d = bundle.entries.find((e: any) => e.kind === 'decision');
  assert.equal(d.quote, 'no more XR. web now');
  assert.equal(d.source, 't_0000000000aa');
  for (const e of bundle.entries) assert.deepEqual(Object.keys(e).sort(), ['body', 'by', 'created', 'kind', 'product', 'quote', 'source', 'tags', 'title']);
  const conv = bundle.entries.find((e: any) => e.kind === 'convention');
  assert.doesNotMatch(conv.body, /sk-ant/);
  assert.match(conv.body, /\[redacted\]/);
  const canonOnly = await call(A, '/api/memory/export?product=yooba&kinds=canon');
  assert.equal(canonOnly.json.entries.length, 2);
  const md = await call(A, '/api/memory/export?product=yooba&format=md');
  assert.match(md.text, /^# Memory of yooba/);
  assert.match(md.text, /## Canon \(story and world\)[\s\S]*Slimes are villagers/);
  assert.match(md.text, /“no more XR\. web now”/);
  assert.equal((await call(A, '/api/memory/export?product=yooba&kinds=state')).status, 400, 'work in progress never moves');
});

test('import into another Studio under its own project id: candidates, quotes and where they came from', async () => {
  // Studio B already knows one of these, in other words: it merges instead of doubling.
  const known = mem.writeMemory({ kind: 'canon', title: 'Slimes are villagers and never enemies', body: 'A slime is never an enemy.', product: 'yland' }, { who: 'J' });
  const r = await call(B, '/api/memory/import', { method: 'POST', body: { bundle, product: 'yland' }, headers: admin });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.product, 'yland');
  assert.equal(r.json.mode, 'candidates');
  assert.equal(r.json.added, 5);
  assert.equal(r.json.merged, 1);
  const slimes = mem.getMemory(known.memory.id)!;
  assert.equal(slimes.status, 'active');
  assert.ok(slimes.sources.some((s) => /^imported from J's Studio \(http:\/\/127\.0\.0\.1:\d+\)$/.test(s.by)), JSON.stringify(slimes.sources));
  const mine = mem.listMemories({ product: 'yland', status: 'all', limit: 50 });
  const d = mine.find((m) => m.kind === 'decision')!;
  assert.equal(d.status, 'candidate');
  assert.equal(d.quote, 'no more XR. web now');
  assert.equal(d.source, 't_0000000000aa');
  assert.match(d.by, /^imported from J's Studio \(http:\/\/127\.0\.0\.1:\d+\)$/);
  assert.match(d.note ?? '', /written there by J/);
  assert.ok(mine.every((m) => m.product === 'yland' && m.scope === 'product'));
  assert.equal(mem.listMemories({ product: 'moon', status: 'all' }).length, 0, 'other projects untouched');

  // The same bundle again changes nothing; with mode active the candidates become active.
  const again = await call(B, '/api/memory/import', { method: 'POST', body: { bundle: JSON.stringify(bundle), product: 'yland' }, headers: admin });
  assert.equal(again.json.added, 0);
  assert.equal(again.json.merged, 6);
  assert.equal(mem.listMemories({ product: 'yland', status: 'all', limit: 50 }).length, mine.length);
  const active = await call(B, '/api/memory/import', { method: 'POST', body: { bundle, product: 'yland', mode: 'active' }, headers: admin });
  assert.equal(active.json.added, 0);
  assert.equal(mem.getMemory(d.id)!.status, 'active');
  // An unknown project here is refused before anything is written.
  assert.equal((await call(B, '/api/memory/import', { method: 'POST', body: { bundle, product: 'nope' }, headers: admin })).status, 400);
});

test('a one-time export link: fetched once without keys, then refused; expired and forged ones never work', async () => {
  const link = await call(A, '/api/memory/export/link', { method: 'POST', body: { product: 'yooba', kinds: 'canon,decision', minutes: 5 } });
  assert.equal(link.status, 200, link.text);
  assert.match(link.json.url, new RegExp(`^${A}/api/memory/export/[\\w-]+\\.[\\w-]+$`));
  const r = await call(B, '/api/memory/import', { method: 'POST', body: { url: link.json.url, product: 'moon' }, headers: admin });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.added, 3);
  assert.deepEqual(mem.listMemories({ product: 'moon', status: 'all' }).map((m) => m.kind).sort(), ['canon', 'canon', 'decision']);
  const twice = await call(B, '/api/memory/import', { method: 'POST', body: { url: link.json.url, product: 'moon' }, headers: admin });
  assert.equal(twice.status, 410);
  assert.match(twice.json.error, /already used/);

  // Expiry and forgery, on this Studio's own links.
  const mine = T.createLink({ product: 'yland', base: B, minutes: 1 });
  db.prepare('UPDATE memory_links SET expires = ?').run(Date.now() - 1);
  assert.throws(() => T.redeemLink(mine.token), (e: any) => e.status === 410 && /expired/.test(e.message));
  const fresh = T.createLink({ product: 'yland', base: B });
  const [payload] = fresh.token.split('.');
  assert.throws(() => T.redeemLink(`${payload}.${'A'.repeat(43)}`), (e: any) => e.status === 404);
  const forged = Buffer.from(JSON.stringify({ n: 'x', e: Date.now() + 1e9 })).toString('base64url');
  assert.throws(() => T.redeemLink(`${forged}.${fresh.token.split('.')[1]}`), (e: any) => e.status === 404);
  const ok = await call(B, `/api/memory/export/${fresh.token}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.product, 'yland');
  // Only real export links are fetched (no arbitrary addresses), and the link needs no sign-in on Cloud Run.
  await assert.rejects(T.fetchBundle('https://example.com/whatever.json'), /not a Studio export link/);
  await assert.rejects(T.fetchBundle('http://10.0.0.1/api/memory/export/a.b'), /https/);
  assert.equal(openRoute(`/api/memory/export/${fresh.token}`, 'GET'), true);
  assert.equal(openRoute('/api/memory/export', 'GET'), false);
  assert.equal(openRoute('/api/memory/import', 'POST'), false);
});

test('admins only: members, agents and scouts are refused; Talk imports candidates, active only with the owner\'s words', async () => {
  for (const [p, opts] of [
    ['/api/memory/export?product=yland', {}],
    ['/api/memory/export/link', { method: 'POST', body: { product: 'yland' } }],
    ['/api/memory/import', { method: 'POST', body: { bundle } }],
  ] as [string, any][]) {
    const m = await call(B, p, { ...opts, headers: member });
    assert.equal(m.status, 403, `${p}: ${m.text}`);
    assert.match(m.json.error, /Only an admin/);
    const ag = await call(B, p, { ...opts, headers: { 'X-Studio-Agent': 'c_00000000000a' } });
    assert.equal(ag.status, 403, `${p} agent`);
    const sc = await call(B, p, { ...opts, headers: { 'X-Studio-Agent': 'x_00000000000a' } });
    assert.equal(sc.status, 403, `${p} scout`);
  }
  assert.equal((await call(B, '/api/memory/export?product=yland', { headers: admin })).status, 200);
  // Members still read the memory and its old Markdown export.
  assert.equal((await call(B, '/api/memory?product=yland', { headers: member })).status, 200);
  assert.equal((await call(B, '/api/memory/export', { headers: member })).status, 200);

  const conv = `t_${'ab'.repeat(6)}`;
  db.prepare('INSERT INTO conversations (id, title, status, messages, created, kind) VALUES (?, ?, ?, ?, ?, ?)').run(conv, 'x', 'idle', JSON.stringify([{ role: 'user', text: 'Bring the canon over and make it all active please', at: Date.now() }]), Date.now(), 'talk');
  const talk = { 'X-Talk-Conversation': conv };
  const doc = '# Moon Rover\n\n## The rover\n\nThe rover has six wheels and a cracked windshield.\n';
  const refused = await call(B, '/api/memory/import', { method: 'POST', body: { markdown: doc, name: 'Story.md', product: 'moon', mode: 'active' }, headers: talk });
  assert.equal(refused.status, 403);
  assert.match(refused.json.error, /owner's yes/);
  const asked = await call(B, '/api/memory/import', { method: 'POST', body: { markdown: doc, name: 'Story.md', product: 'moon', mode: 'active', quote: 'make it all active' }, headers: talk });
  assert.equal(asked.status, 200, asked.text);
  assert.equal(asked.json.entries[0].status, 'active');
  const cand = await call(B, '/api/memory/import', { method: 'POST', body: { markdown: '## Wheels\n\nSix wheels, each one with its own motor and suspension.', name: 'Story.md', product: 'moon' }, headers: talk });
  assert.equal(cand.json.entries[0].status, 'candidate');
});

test('Markdown docs: one canon candidate per section of a story doc, conventions from an AGENTS.md', () => {
  const story = `# Moon Rover story\n\nA driving game on the far side of the moon, told over one long night shift.\n\n## Characters\n\n### Ada\n\nThe driver. Never speaks on the radio; she taps Morse instead.\n\n### Rex\n\nThe rover's AI, dry and helpful, afraid of craters.\n\n## Places\n\n\`\`\`\n# not a heading\n\`\`\`\nThe base is Tycho Station, under the crater rim.\n\n## Empty\n\n`;
  const secs = T.sectionsOf(story, 'Story.md');
  assert.deepEqual(secs.map((s) => s.title), ['Moon Rover story', 'Characters: Ada', 'Characters: Rex', 'Places']);
  assert.match(secs[3].body, /# not a heading/);
  const r = T.importMarkdown({ markdown: story, name: 'Story.md', product: 'moon' });
  assert.equal(r.kind, 'canon');
  assert.equal(r.added, 4);
  const ada = mem.listMemories({ product: 'moon', kind: 'canon', status: 'candidate', q: 'Morse' })[0];
  assert.equal(ada.title, 'Characters: Ada');
  assert.equal(ada.source, 'Story.md');
  assert.match(ada.by, /imported from Story\.md/);
  const agents = T.importMarkdown({ markdown: '# Repo\n\n## Build\n\nnpm run build writes dist/, which the beta site serves.\n', name: 'AGENTS.md', product: 'moon' });
  assert.equal(agents.kind, 'convention');
  assert.throws(() => T.importMarkdown({ markdown: '## X\n\nSomething long enough to count here.', kind: 'decision' }), /owner's own words/);
  // The same doc again merges.
  assert.equal(T.importMarkdown({ markdown: story, name: 'Story.md', product: 'moon' }).added, 0);
});

test('secrets never travel', () => {
  assert.equal(T.redact('key sk-ant-api03-abcdefghijklmnopqrstuv and ghp_abcdefghijklmnopqrstuvwxyz0123 ok'), 'key [redacted] and [redacted] ok');
  assert.equal(T.redact('password: hunter2hunter2'), 'password: [redacted]');
  assert.equal(T.redact('AKIAABCDEFGHIJKLMNOP'), '[redacted]');
  assert.equal(T.redact('Plain canon stays as it is.'), 'Plain canon stays as it is.');
});
