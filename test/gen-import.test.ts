// studio_gen_import (gen-import.ts, mcp-tools.ts): an asset outside the owner's account is refused, the path stays inside
// the worktree, resize and square crop give the asked size. A stand-in Gen; images made with ffmpeg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-gen-import-'));
delete process.env.HAWKESGEN_PROJECT_PREFIX;
const { importAsset, writeInside, imageSize, ownedProject } = await import('../src/gen-import.ts');
const { studioMcp } = await import('../src/mcp-tools.ts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-import-t-'));
const ff = spawnSync('ffmpeg', ['-version']);
const hasFfmpeg = ff.status === 0;
const make = (name: string, args: string[]) => {
  const f = path.join(tmp, name);
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=400x300:rate=1', '-frames:v', '1', ...args, f]);
  assert.equal(r.status, 0, String(r.stderr));
  return new Uint8Array(fs.readFileSync(f));
};
const png = hasFfmpeg ? make('a.png', []) : new Uint8Array();

const assets: Record<string, { project: string; kind: string; bytes: Uint8Array }> = {
  a_mine: { project: 'u_5b0cfc84486e', kind: 'image', bytes: png },
  a_other: { project: 'org_abc123.game', kind: 'image', bytes: png },
  a_nobody: { project: '', kind: 'image', bytes: png },
  a_voice: { project: 'u_5b0cfc84486e', kind: 'audio', bytes: new Uint8Array([1, 2, 3]) },
};
const gen = {
  asset: async (id: string) => { if (!assets[id]) throw new Error('404'); return { id, project: assets[id].project, kind: assets[id].kind }; },
  bytes: async (id: string) => assets[id].bytes,
};

test('ownership: the owner\'s account only', async () => {
  assert.equal(ownedProject('u_5b0cfc84486e', ''), true);
  assert.equal(ownedProject('org_abc.x', ''), false);
  assert.equal(ownedProject('org_abc.x', 'org_abc.'), true);
  assert.equal(ownedProject('hawkesbiomedical', 'org_abc.'), false);
  await assert.rejects(importAsset({ asset: 'a_other' }, gen), (e: any) => e.status === 403 && /not in the owner/.test(e.message));
  await assert.rejects(importAsset({ asset: 'a_nobody' }, gen), (e: any) => e.status === 403);
  await assert.rejects(importAsset({ asset: 'a_missing' }, gen), (e: any) => e.status === 404);
  await assert.rejects(importAsset({ asset: 'a_voice' }, gen), (e: any) => e.status === 415);
});

test('path stays inside the worktree', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-import-wt-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-import-out-'));
  fs.symlinkSync(outside, path.join(wt, 'link'));
  const b = new Uint8Array([1, 2, 3]);
  for (const bad of ['../x.png', 'a/../../x.png', '/etc/x.png', 'C:\\x.png', '', '.', '.git/x.png', 'link/x.png'])
    assert.throws(() => writeInside(wt, bad, b), /path/, bad);
  assert.equal(fs.readdirSync(outside).length, 0);
  assert.equal(writeInside(wt, 'public/img/a.png', b), 'public/img/a.png');
  assert.deepEqual([...fs.readFileSync(path.join(wt, 'public/img/a.png'))], [1, 2, 3]);
});

test('resize, square crop and formats give the asked size', { skip: !hasFfmpeg && 'ffmpeg missing' }, async () => {
  assert.deepEqual(imageSize(png), { width: 400, height: 300, format: 'png' });
  const same = await importAsset({ asset: 'a_mine' }, gen);
  assert.equal(same.bytes.length, png.length);
  const w = await importAsset({ asset: 'asset:a_mine', width: 200, format: 'jpeg', quality: 80 }, gen);
  assert.deepEqual([w.width, w.height, w.format, w.ext], [200, 150, 'jpeg', 'jpg']);
  assert.equal(imageSize(w.bytes)?.format, 'jpeg');
  const s = await importAsset({ asset: 'a_mine', square: 128, format: 'png' }, gen);
  assert.deepEqual([s.width, s.height], [128, 128]);
  assert.deepEqual(imageSize(s.bytes), { width: 128, height: 128, format: 'png' });
  const p = await importAsset({ asset: 'a_mine', square: 64, format: 'webp', quality: 70 }, gen);
  assert.deepEqual([p.width, p.height, p.format], [64, 64, 'webp']);
  await assert.rejects(importAsset({ asset: 'a_mine', width: 10, square: 10 }, gen), /not both/);
  await assert.rejects(importAsset({ asset: 'a_mine', width: 0 }, gen), /whole number/);
  await assert.rejects(importAsset({ asset: 'a_mine', format: 'gif' }, gen), /jpeg, png or webp/);
});

test('the tool writes what Studio sends, inside the worktree, and says nothing of links', { skip: !hasFfmpeg && 'ffmpeg missing' }, async () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-import-tool-'));
  fs.mkdirSync(path.join(wt, '.git'));
  process.env.STUDIO_WORKTREE = wt;
  // The one studio_gen_import (access.ts): listed in an agent's or Talk's own server; Studio's /api/agents/gen-import
  // fetches and converts, the tool writes the bytes.
  process.env.STUDIO_AGENT = 'c_0123456789ab';
  const calls: any[] = [];
  const studio: any = async (url: string, o: any) => {
    calls.push({ url, body: o.body });
    const r = await importAsset({ asset: o.body.asset, format: o.body.format, square: o.body.width === o.body.height ? o.body.width : undefined }, gen);
    return { ok: true, bytes: Buffer.from(r.bytes).toString('base64'), mime: r.mime, size: r.bytes.length, source: { asset: r.asset, via: 'own' } };
  };
  const server: any = studioMcp({ studio, waitRun: (async () => ({})) as any });
  delete process.env.STUDIO_AGENT;
  const tool = server.tools.find((t: any) => t.name === 'studio_gen_import');
  assert.ok(tool, 'tool is registered');
  const r = await tool.run({ asset: 'a_mine', path: 'img/hero.webp', format: 'webp', square: 96 });
  assert.equal(r.wrote, 'img/hero.webp');
  assert.deepEqual(imageSize(new Uint8Array(fs.readFileSync(path.join(wt, 'img/hero.webp')))), { width: 96, height: 96, format: 'webp' });
  await assert.rejects(tool.run({ asset: 'a_mine', path: '../escape.png' }), /inside the repo/);
  assert.ok(!JSON.stringify(r).includes('http'));
  assert.equal(calls[0].url, '/api/agents/gen-import');
  assert.equal(calls[0].body.width, 96);
});
