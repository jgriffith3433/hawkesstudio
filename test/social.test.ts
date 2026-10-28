// The Social tab (social.ts): sign-in addresses, single-use states, what the dashboard may see (never secrets or
// tokens), post checks, TikTok's chunk plan, and that the sandbox and members can't change the accounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-social-'));
const social = await import('../src/social.ts');
const { guardRoute } = await import('../src/guards.ts');

test('sign-in addresses ask for upload scopes, offline access, and a state that works once', () => {
  const yt = new URL(social.authUrl('youtube', 'cid', 'https://studio.example/api/social/callback/youtube', 'state-yt'));
  assert.equal(yt.host, 'accounts.google.com');
  assert.equal(yt.searchParams.get('access_type'), 'offline');
  assert.equal(yt.searchParams.get('prompt'), 'consent');
  assert.match(yt.searchParams.get('scope')!, /youtube\.upload/);
  const tt = new URL(social.authUrl('tiktok', 'ckey', 'https://studio.example/api/social/callback/tiktok', 'state-tt'));
  assert.equal(tt.searchParams.get('client_key'), 'ckey');
  assert.equal(tt.searchParams.get('scope'), 'user.info.basic,video.upload');
  assert.equal(social.takeState('state-tt', 'youtube'), false, 'a state is for its own platform');
  assert.equal(social.takeState('state-yt', 'youtube'), true);
  assert.equal(social.takeState('state-yt', 'youtube'), false, 'and only once');
});

test('the redirect is this site: https behind Caddy, http on this PC', () => {
  assert.equal(social.redirectUri({ headers: { host: 'studio.hawkesgen.ai' } } as any, 'tiktok'), 'https://studio.hawkesgen.ai/api/social/callback/tiktok');
  assert.equal(social.redirectUri({ headers: { host: '127.0.0.1:8791' } } as any, 'youtube'), 'http://127.0.0.1:8791/api/social/callback/youtube');
});

test('accounts show what is connected, never the secret or tokens', () => {
  fs.writeFileSync(path.join(process.env.STUDIO_DATA!, 'social.json'), JSON.stringify({ youtube: { clientId: 'id', clientSecret: 'shh', refreshToken: 'rt-secret', name: 'Pierce Hawkes' } }));
  const a = social.accounts();
  assert.equal(a.youtube.connected, true);
  assert.equal(a.youtube.name, 'Pierce Hawkes');
  assert.equal(a.tiktok.configured, false);
  assert.ok(!JSON.stringify(a).includes('shh') && !JSON.stringify(a).includes('rt-secret'));
});

test('posts need a Gen video, a title and a connected platform', () => {
  const on = { youtube: true, tiktok: false };
  assert.match(social.postProblem({ asset: 'x.mp4', title: 't' }, on)!, /asset/);
  assert.match(social.postProblem({ asset: 'a_0123456789abcdef', title: ' ' }, on)!, /title/);
  assert.match(social.postProblem({ asset: 'a_0123456789abcdef', title: 't', platforms: ['tiktok'] }, on)!, /tiktok isn't connected/);
  assert.equal(social.postProblem({ asset: 'a_0123456789abcdef', title: 't' }, on), null, 'defaults to the connected ones');
  assert.match(social.postProblem({ asset: 'a_0123456789abcdef', title: 't' }, { youtube: false, tiktok: false })!, /No accounts/);
});

test("TikTok's chunks: one up to 64 MB, else 10 MB chunks with the rest in the last", () => {
  const MB = 1024 * 1024;
  assert.deepEqual(social.tiktokChunks(30 * MB), { chunkSize: 30 * MB, count: 1 });
  assert.deepEqual(social.tiktokChunks(95 * MB), { chunkSize: 10 * MB, count: 9 });
});

test('the sandbox can post drafts but never change the accounts', () => {
  assert.match(guardRoute('/api/social/config', 'POST', null)!, /not from a sandboxed agent/);
  assert.match(guardRoute('/api/social/disconnect/youtube', 'POST', null)!, /not from a sandboxed agent/);
  assert.equal(guardRoute('/api/social/posts', 'POST', null), null);
});
