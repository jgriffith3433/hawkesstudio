// The Caddyfile (deploy/caddyfile.mjs: installed by deploy.mjs, applied by hawkes-pull.mjs after a pull): the only
// public doors on gen.<domain> are Hawkes Analytics' collect and SDK routes and the hg_ key paths; everything else is
// behind the sign-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// @ts-ignore: a plain .mjs module without types
const { caddyfile: build } = await import('../deploy/caddyfile.mjs');
const products = JSON.parse(fs.readFileSync(path.join(root, 'products.json'), 'utf8'));
const caddyfile: string = build({ domain: 'hawkesgen.com', email: 'test@example.com', products });

/** The site block for a host: from its opening line to the closing brace at column 0. */
function site(host: string): string {
  const start = caddyfile.indexOf(`\n${host} {\n`);
  assert.ok(start >= 0, `a block for ${host}`);
  return caddyfile.slice(start + 1, caddyfile.indexOf('\n}\n', start) + 2);
}

/** The handle blocks of a site, in order: their matcher (or '' for the catch-all) and body. */
function handles(block: string): { matcher: string; body: string }[] {
  const out: { matcher: string; body: string }[] = [];
  const re = /^\thandle(?:_path)?(?: (\S+))? \{\n([\s\S]*?)^\t\}\n/gm;
  for (let h; (h = re.exec(block)); ) out.push({ matcher: h[1] ?? '', body: h[2] });
  return out;
}

const gen = site('gen.hawkesgen.com');

test('gen: analytics collect is public, POST (and the CORS preflight) only, 64 KB, with the visitor address', () => {
  assert.match(gen, /@collect \{\n\t\tmethod POST OPTIONS\n\t\tpath \/v1\/analytics\/collect\n\t\}/);
  const h = handles(gen).find((x) => x.matcher === '@collect');
  assert.ok(h, 'a handle for @collect');
  assert.doesNotMatch(h.body, /import login/);
  assert.match(h.body, /max_size 64KB/);
  assert.match(h.body, /header_up X-Forwarded-For \{remote_host\}/);
  assert.match(h.body, /reverse_proxy 127\.0\.0\.1:8790/);
  assert.doesNotMatch(h.body, /WEB_GEN_KEY/, 'the public door never carries the web key');
  assert.match(h.body, /header_up -Authorization/);
});

test('gen: the SDK script is public, GET only, cacheable', () => {
  assert.match(gen, /@sdk \{\n\t\tmethod GET HEAD\n\t\tpath \/sdk\/\*\n\t\}/);
  const h = handles(gen).find((x) => x.matcher === '@sdk');
  assert.ok(h, 'a handle for @sdk');
  assert.doesNotMatch(h.body, /import login/);
  assert.doesNotMatch(h.body, /WEB_GEN_KEY/);
  assert.match(h.body, /Cache-Control "public, max-age=\d+"/);
});

test('gen: everything else still needs the sign-in or a key Gen checks', () => {
  const hs = handles(gen);
  const last = hs[hs.length - 1];
  assert.equal(last.matcher, '', 'the catch-all comes last');
  assert.match(last.body, /import login/);
  assert.match(last.body, /WEB_GEN_KEY/);
  // The only handles without the login: the key paths (Gen checks the key) and the two analytics routes.
  const open = hs.filter((x) => !/import login/.test(x.body)).map((x) => x.matcher).sort();
  assert.deepEqual(open, ['@apikey', '@collect', '@mcpurl', '@sdk']);
  // No other path in gen's block is opened: the analytics matchers name exactly those paths.
  const paths = [...gen.matchAll(/^\t\tpath (.+)$/gm)].map((x) => x[1]);
  assert.deepEqual(paths, ['/v1/analytics/collect', '/sdk/*']);
});

test('studio: the analytics routes are not added there', () => {
  assert.doesNotMatch(site('studio.hawkesgen.com'), /analytics|@sdk/);
});

test('apex: locked down, except one frame for the Twitch player', () => {
  const apex = site('hawkesgen.com');
  const csp = /Content-Security-Policy "([^"]+)"/.exec(apex);
  assert.ok(csp, 'a CSP on the apex');
  const policy = csp[1];
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /style-src 'self'/);
  assert.match(policy, /img-src 'self' data:/);
  assert.match(policy, /frame-src https:\/\/player\.twitch\.tv(?![\w./])/);
  assert.match(policy, /base-uri 'none'/);
  assert.match(policy, /form-action 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.doesNotMatch(policy, /script-src|connect-src|media-src|object-src|worker-src/);
  assert.match(apex, /X-Frame-Options "DENY"/);
  assert.doesNotMatch(site('gen.hawkesgen.com'), /player\.twitch\.tv/);
  assert.doesNotMatch(site('studio.hawkesgen.com'), /player\.twitch\.tv/);
  const page = fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8');
  assert.match(page, /src="https:\/\/player\.twitch\.tv\/\?channel=jgriffith3433&amp;parent=hawkesgen\.com"/);
  assert.doesNotMatch(page, /stream.?key|client_secret|oauth/i);
});

test('the Caddyfile is valid (when caddy is installed)', (t) => {
  if (spawnSync('caddy', ['version']).status !== 0) return t.skip('caddy not installed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-caddy-'));
  const file = path.join(dir, 'Caddyfile');
  fs.writeFileSync(file, caddyfile.replace('/var/log/caddy/access.log', path.join(dir, 'access.log')));
  const r = spawnSync('caddy', ['validate', '--config', file, '--adapter', 'caddyfile'], { encoding: 'utf8', env: { ...process.env, WEB_GEN_KEY: 'hg_test', XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir, HOME: dir } });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, (r.stderr || r.stdout).split('\n').slice(-5).join('\n'));
});
