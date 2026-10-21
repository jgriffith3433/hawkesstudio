// Standalone public commercial Hawkes Gen Cloud (hawkesgen.com) provisioning & deployment scripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-gen-public-test-'));
// @ts-ignore: plain .mjs module without types
const { genPublicCaddyfile } = await import('../deploy/caddyfile-gen-public.mjs');
const { guardFiles, protectedTouched } = await import('../src/agents.ts');

test('all deploy/*.mjs scripts pass node --check', () => {
  const deployDir = path.join(root, 'deploy');
  const pubScripts = fs.readdirSync(deployDir).filter((f) => /gen-public.*\.mjs$/.test(f)).sort();
  assert.deepEqual(pubScripts, [
    'caddyfile-gen-public.mjs',
    'deploy-gen-public.mjs',
    'gen-public-secrets.mjs',
    'provision-gen-public.mjs',
    'sync-gen-public.mjs',
  ]);
  const allScripts = fs.readdirSync(deployDir).filter((f) => f.endsWith('.mjs')).sort();
  for (const name of allScripts) {
    const abs = path.join(deployDir, name);
    const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
    assert.equal(r.status, 0, `deploy/${name} failed node --check: ${r.stderr || r.stdout}`);
  }
});

test('protectedTouched honors J naming guarded files while keeping unapproved guarded and forbidden files protected', () => {
  const files = ['deploy/caddyfile.mjs', 'deploy/hawkes-pull.mjs', 'src/server.ts'];
  assert.deepEqual(protectedTouched('hawkesstudio', files), ['deploy/caddyfile.mjs', 'deploy/hawkes-pull.mjs']);
  const jWords = 'You can edit deploy/caddyfile.mjs and deploy/hawkes-pull.mjs, and launch the hawkes-gen-public EC2 server. Merge everything yourself';
  assert.deepEqual(guardFiles('hawkesstudio', files, jWords), []);
  assert.deepEqual(protectedTouched('hawkesstudio', files, jWords), []);
  assert.deepEqual(protectedTouched('hawkesstudio', [...files, '.env'], jWords), ['.env']);
});

test('genPublicCaddyfile("hawkesgen.com") configures HTTPS, www redirect, 64MB uploads, /v1/events SSE, and security headers', () => {
  const caddy: string = genPublicCaddyfile('hawkesgen.com');

  assert.match(caddy, /https:\/\/hawkesgen\.com \{/);
  assert.match(caddy, /www\.hawkesgen\.com \{\s*redir https:\/\/hawkesgen\.com\{uri\} permanent\s*\}/);
  assert.match(caddy, /max_size 64MB/);
  assert.match(caddy, /Strict-Transport-Security/);
  assert.match(caddy, /X-Content-Type-Options "nosniff"/);
  assert.match(caddy, /Referrer-Policy "strict-origin-when-cross-origin"/);

  // Proxies /, /app/*, /v1/*, /mcp/*, /client/*, /sdk/* to 127.0.0.1:8790
  assert.match(caddy, /path \/ \/app\/\* \/v1\/\* \/mcp\/\* \/client\/\* \/sdk\/\*/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:8790/);

  // Streaming / SSE support for /v1/events
  assert.match(caddy, /path \/v1\/events/);
  assert.match(caddy, /flush_interval -1/);

  // Completely separate from internal Studio forward_auth
  assert.doesNotMatch(caddy, /import login/);
  assert.doesNotMatch(caddy, /WEB_GEN_KEY/);
});

test('genPublicCaddyfile is valid Caddyfile syntax (when caddy is installed)', (t) => {
  if (spawnSync('caddy', ['version']).status !== 0) return t.skip('caddy not installed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-public-caddy-'));
  const file = path.join(dir, 'Caddyfile');
  const caddy: string = genPublicCaddyfile('hawkesgen.com');
  fs.writeFileSync(file, caddy.replace('/var/log/caddy/access.log', path.join(dir, 'access.log')));
  const r = spawnSync('caddy', ['validate', '--config', file, '--adapter', 'caddyfile'], {
    encoding: 'utf8',
    env: { ...process.env, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir, HOME: dir },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, (r.stderr || r.stdout).split('\n').slice(-5).join('\n'));
});

test('provision-gen-public, deploy-gen-public, and gen-public-secrets configure isolated resources and secrets', () => {
  const provision = fs.readFileSync(path.join(root, 'deploy', 'provision-gen-public.mjs'), 'utf8');
  assert.match(provision, /from '\.\/aws\.mjs'/);
  assert.match(provision, /gen-public\.json/);
  assert.match(provision, /gen_public_ed25519/);
  assert.match(provision, /GEN_PUBLIC_TYPE \|\| 't3\.large'/);
  assert.match(provision, /Path:\s*'\/hawkes\/'/);
  assert.match(provision, /hawkes-gen-public/);
  assert.match(provision, /secret:hawkes\/gen-public\*/);
  assert.match(provision, /secret:hawkes\/github\*/);
  assert.match(provision, /arn:aws:s3:::hawkes-gen-public-\*/);
  assert.match(provision, /VolumeSize:\s*150/);

  const deploy = fs.readFileSync(path.join(root, 'deploy', 'deploy-gen-public.mjs'), 'utf8');
  assert.match(deploy, /from '\.\/aws\.mjs'/);
  assert.match(deploy, /from '\.\/caddyfile-gen-public\.mjs'/);
  assert.match(deploy, /gen-public\.json/);
  assert.match(deploy, /\/srv\/hawkes\/hawkesgen/);
  assert.match(deploy, /\/run\/hawkes\/gen-public\.env hawkes\/gen-public/);
  assert.match(deploy, /HAWKESGEN_PUBLIC_SAAS=1/);
  assert.match(deploy, /hawkes-gen-public-\$\{ACCOUNT\}/);
  assert.match(deploy, /auto:\s*true,\s*autoLaunch:\s*false/);

  const secrets = fs.readFileSync(path.join(root, 'deploy', 'gen-public-secrets.mjs'), 'utf8');
  assert.match(secrets, /from '\.\/aws\.mjs'/);
  assert.match(secrets, /hawkes\/gen-public/);
  assert.match(secrets, /STRIPE_SECRET_KEY/);
  assert.match(secrets, /STRIPE_WEBHOOK_SECRET/);
  assert.match(secrets, /ANTHROPIC_API_KEY/);
  assert.match(secrets, /ELEVENLABS_API_KEY/);
  assert.match(secrets, /stripe-key/);
  assert.match(secrets, /stripe-webhook/);
});
