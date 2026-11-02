// studio_gen_import end to end (J, 2026-11-02: every live call failed with Gen's upload error while the unit tests
// passed): the real Studio server as a child process, a stand-in Hawkes Gen over HTTP, and the real MCP tool talking to
// the real /api/agents/gen-import route. Covers copying an owner's file into the Studio's library (an upload with raw
// bytes, which a project prefix used to turn into JSON), resizing, the owner-only check and the inside-the-worktree check.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

const free = () => new Promise<number>((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
const ff = spawnSync('ffmpeg', ['-version']).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-genimport-http-'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

type Asset = { project: string; kind: string; bytes: Buffer };
function fakeGen(assets: Record<string, Asset>) {
  const uploads: { type: string; len: number; project: string | null; json: boolean }[] = [];
  const jobs: any[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const u = new URL(req.url!, 'http://x');
    const json = (code: number, o: any) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    let m: RegExpExecArray | null;
    if (u.pathname === '/v1/admin/accounts') return json(200, { items: u.searchParams.get('q') === 'admin@hawkesgen.ai' ? [{ email: 'admin@hawkesgen.ai', project: 'u_5b0cfc84486e' }] : [] });
    if (u.pathname === '/v1/health') return json(200, { ok: true });
    if ((m = /^\/v1\/assets\/(a_\w+)$/.exec(u.pathname)) && req.method === 'GET') { const a = assets[m[1]]; return a ? json(200, { id: m[1], project: a.project, kind: a.kind, title: 'Lab', path: 'lab.png' }) : json(404, { error: 'no' }); }
    if ((m = /^\/v1\/files\/(a_\w+)$/.exec(u.pathname))) { const a = assets[m[1]]; if (!a) return json(404, { error: 'no' }); res.writeHead(200, { 'Content-Type': 'image/png' }); return void res.end(a.bytes); }
    if (u.pathname === '/v1/assets' && req.method === 'POST') {
      const isJson = String(req.headers['content-type']).includes('application/json');
      uploads.push({ type: String(req.headers['content-type']), len: body.length, project: u.searchParams.get('project'), json: isJson });
      // Gen's own upload route, as it answers a JSON body with no { data }.
      if (isJson) return json(400, { error: 'Send { data } (base64 or data URL) or raw file bytes' });
      const id = `a_up${uploads.length}`;
      assets[id] = { project: u.searchParams.get('project') ?? '', kind: 'image', bytes: body };
      return json(200, { asset: { id } });
    }
    if (u.pathname === '/v1/jobs' && req.method === 'POST') {
      const spec = JSON.parse(body.toString());
      jobs.push(spec);
      const id = `j_${jobs.length}`;
      const w = spec.params.ops?.[0]?.width;
      assets[`a_made${jobs.length}`] = { project: spec.project, kind: 'image', bytes: Buffer.from(`resized-${w}`) };
      return json(200, { jobs: [{ id, status: 'queued' }] });
    }
    if ((m = /^\/v1\/jobs\/j_(\d+)$/.exec(u.pathname))) return json(200, { id: `j_${m[1]}`, status: 'done', outputs: [{ asset: `a_made${m[1]}` }] });
    json(404, { error: 'not found' });
  });
  return new Promise<{ url: string; uploads: typeof uploads; jobs: typeof jobs; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, uploads, jobs, close: () => server.close() })));
}

const procs: ChildProcess[] = [];
const closers: (() => void)[] = [];
after(() => { for (const p of procs) p.kill(); for (const c of closers) c(); });

async function boot(prefix: string) {
  const assets: Record<string, Asset> = {
    a_ownerlab1: { project: 'u_5b0cfc84486e', kind: 'image', bytes: PNG },
    a_stranger1: { project: 'u_000000000000', kind: 'image', bytes: PNG },
  };
  const g = await fakeGen(assets);
  closers.push(g.close);
  const port = await free();
  const dir = fs.mkdtempSync(path.join(tmp, 'run-'));
  fs.mkdirSync(path.join(dir, 'Projects'));
  fs.writeFileSync(path.join(dir, 'products.json'), JSON.stringify({ previews: {}, products: [{
    id: 'shop', name: 'Shop', framing: 'test', engine: 'static', repo: 'site', site: 'site', live: 'http://127.0.0.1:9/',
    local: { serve: 'static', dir: 'site', port: 8797, path: '/' }, playtests: [{ scenario: 'smoke', where: 'local' }], story: [], about: 'A fixture.',
  }], infra: [] }));
  // An admin whose personal Gen account is u_5b0cfc84486e: Gen's owner search answers for it.
  const env = { ...process.env, STUDIO_DATA: path.join(dir, 'data'), STUDIO_PROJECTS: path.join(dir, 'Projects'), STUDIO_PRODUCTS: path.join(dir, 'products.json'), STUDIO_PORT: String(port), STUDIO_SMOKE: '1', HAWKESGEN_URL: g.url, HAWKESGEN_PROJECT_PREFIX: prefix, STUDIO_SERVER: '1' };
  const child = spawn(process.execPath, [path.resolve('src/server.ts')], { env, stdio: 'ignore' });
  procs.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).status < 500) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 200)); }
  return { g, assets, base };
}

async function toolFor(base: string, wt: string) {
  const { studioAt } = await import('../src/client.ts');
  const { studioMcp } = await import('../src/mcp-tools.ts');
  fs.mkdirSync(path.join(wt, '.git'), { recursive: true });
  process.env.STUDIO_WORKTREE = wt;
  process.env.TALK_CONVERSATION = 'conv_test'; // Talk's own server: the tool is listed and names its product
  const server: any = studioMcp({ studio: studioAt(base), waitRun: (async () => ({})) as any });
  delete process.env.TALK_CONVERSATION;
  return server.tools.find((t: any) => t.name === 'studio_gen_import');
}

for (const prefix of ['', 'org_aa11.']) {
  test(`the real route and the MCP tool import and resize an owner's asset (project prefix "${prefix}")`, { skip: !ff && 'ffmpeg missing' }, async () => {
    const { g, base } = await boot(prefix);
    const wt = fs.mkdtempSync(path.join(tmp, 'wt-'));
    const tool = await toolFor(base, wt);
    assert.ok(tool);
    // The owner's file (the Studio's admin's own Gen account) is copied into the Studio's library and resized there.
    const r = await tool.run({ asset: 'a_ownerlab1', path: 'x/a.jpg', product: 'shop', width: 1600 });
    assert.equal(r.ok, true);
    assert.equal(r.wrote, 'x/a.jpg');
    assert.equal(fs.readFileSync(path.join(wt, 'x/a.jpg')).toString(), 'resized-1600');
    assert.equal(g.uploads.length, 1, 'one copy into the Studio library');
    assert.equal(g.uploads[0].json, false, 'sent as raw bytes, not JSON');
    assert.equal(g.uploads[0].len, PNG.length);
    assert.equal(g.uploads[0].project, prefix ? 'org_aa11.shop' : 'shop');
    // Another person's account is refused, and nothing is written.
    await assert.rejects(tool.run({ asset: 'a_stranger1', path: 'x/b.png', product: 'shop' }), /No Gen file/);
    assert.ok(!fs.existsSync(path.join(wt, 'x/b.png')));
    await assert.rejects(tool.run({ asset: 'a_ownerlab1', path: '../escape.png', product: 'shop' }), /file path/);
    assert.equal(g.uploads.filter((u) => u.json).length, 0, 'no upload was sent as JSON');
  });
}
