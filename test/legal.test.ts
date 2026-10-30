// The terms, privacy and refunds page (dashboard/legal.html): public at /legal in J's Studio and in every customer's
// cell, before any sign-in, while the rest of the Studio still asks for one. /terms, /privacy and /refunds open its
// sections. A real Studio (src/server.ts) on a scratch data folder in Cloud Run mode, asked as from outside (through a
// proxy: X-Forwarded-For), so the gate applies.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-legal-'));
const port = await new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
const env: NodeJS.ProcessEnv = { ...process.env, STUDIO_DATA: tmp, STUDIO_PORT: String(port), STUDIO_CLOUD: '1', STUDIO_SMOKE: '1', STUDIO_MAIL: 'off', STUDIO_SIGNUP: 'owner', STUDIO_PM: 'off' };
for (const k of ['STUDIO_SERVER', 'K_SERVICE', 'PORT', 'STUDIO_ORG', 'HAWKESGEN_KEY']) delete env[k];
let studio: ChildProcess | null = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.ts'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
after(() => { studio?.kill(); studio = null; });
const outside = { 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Host': 'studio.hawkesgen.ai' };
const end = Date.now() + 30_000;
while (!(await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok).catch(() => false))) {
  if (Date.now() > end) throw new Error('Studio did not start');
  await new Promise((r) => setTimeout(r, 200));
}

test('/legal answers 200 to anyone, with no sign-in; the rest of the Studio still asks for one', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/legal`, { headers: outside });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /text\/html/);
  const html = await r.text();
  for (const words of ['Terms of service', 'Privacy policy', 'Refunds', 'support@hawkesgen.ai', '14 days', '90 days', 'RunPod', 'Stripe', 'encrypted', 'draft']) assert.ok(html.includes(words), words);
  const gated = await fetch(`http://127.0.0.1:${port}/api/overview`, { headers: outside });
  assert.equal(gated.status, 401, 'the gate still guards everything else');
});

test('/terms, /privacy and /refunds open their section of the one page', async () => {
  for (const [route, anchor] of [['/terms', 'terms'], ['/privacy', 'privacy'], ['/refunds', 'refunds']]) {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { headers: outside, redirect: 'manual' });
    assert.equal(r.status, 302, route);
    assert.equal(r.headers.get('location'), `/legal#${anchor}`);
  }
});
