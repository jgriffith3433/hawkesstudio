// The Caddyfile (deploy/caddyfile.mjs: installed by deploy.mjs, applied by hawkes-pull.mjs after a pull): the only
// public doors on gen.<domain> are Hawkes Analytics' collect and SDK routes and the hg_ key paths; everything else is
// behind the sign-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
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
  // The only handles without the login: the key paths (Gen checks the key), the two analytics routes and Hawkes Net's
  // public routes (players' pages: the socket needs a signed ticket, the ticket door checks the origin).
  const open = hs.filter((x) => !/import login/.test(x.body)).map((x) => x.matcher).sort();
  assert.deepEqual(open, ['@apikey', '@collect', '@mcpurl', '@net', '@sdk']);
  // No other path in gen's block is opened: the matchers name exactly these paths.
  const paths = [...gen.matchAll(/^\t\tpath (.+)$/gm)].map((x) => x[1]);
  assert.deepEqual(paths, ['/v1/analytics/collect', '/v1/net/ws /v1/net/ticket /v1/net/keys /v1/net/status /v1/net/nodes', '/sdk/*']);
});

test('studio: the analytics routes are not added there', () => {
  assert.doesNotMatch(site('studio.hawkesgen.com'), /analytics|@sdk/);
});

test("apex: hawkesgen.com and www are the portal's own box, not served here", () => {
  assert.ok(!caddyfile.includes('\nhawkesgen.com {\n'));
  assert.ok(!caddyfile.includes('\nwww.hawkesgen.com {\n'));
  assert.doesNotMatch(caddyfile, /X-Hawkes-Public-Saas/);
});

test('site/: the old landing page keeps its analytics (no longer served at the apex)', () => {
  assert.doesNotMatch(site('gen.hawkesgen.com'), /player\.twitch\.tv/);
  assert.doesNotMatch(site('studio.hawkesgen.com'), /player\.twitch\.tv/);
  const page = fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8');
  assert.match(page, /<script src="https:\/\/gen\.hawkesgen\.com\/sdk\/analytics@1\.js" data-product="hawkesgen" defer><\/script>/);
  assert.match(page, /<script src="\/analytics\.js"><\/script>/);
  assert.match(page, /We keep anonymous site statistics\. No cookies\. No personal data\./);
  assert.match(page, /src="https:\/\/player\.twitch\.tv\/\?channel=jgriffith3433&amp;parent=hawkesgen\.com"/);
  assert.doesNotMatch(page, /stream.?key|client_secret|oauth/i);
  const analyticsJs = fs.readFileSync(path.join(root, 'site', 'analytics.js'), 'utf8');
  assert.match(analyticsJs, /setAttribute\('data-debug', '1'\)/);
  assert.match(analyticsJs, /track\('progress'/);
  assert.match(analyticsJs, /youtu\.be/);
  assert.match(analyticsJs, /twitch\.tv/);
  assert.match(analyticsJs, /hawkesbiomedical\.com/);
  assert.match(analyticsJs, /gen\.hawkesgen\.com/);
});

test('site/analytics.js: enables debug on playtests, tracks read depth and tags key CTA/outbound clicks', () => {
  const code = fs.readFileSync(path.join(root, 'site', 'analytics.js'), 'utf8');
  const attrs: Record<string, string> = {};
  const sdkEl = { setAttribute: (k: string, v: string) => { attrs[k] = v; } };
  const tracked: { name: string; props: any }[] = [];
  const features: { name: string; props: any }[] = [];
  const contexts: any[] = [];
  const winListeners: Record<string, Function[]> = {};
  const heads = [
    { textContent: 'Make the game. Ship it on-model.', getBoundingClientRect: () => ({ top: 100 }) },
    { textContent: 'What Gen does.', getBoundingClientRect: () => ({ top: 400 }) },
  ];
  const win: any = {
    location: { search: '?hawkesPlaytest', href: 'https://hawkesgen.com/' },
    navigator: { webdriver: false },
    sessionStorage: { getItem: () => null },
    scrollY: 0,
    innerHeight: 500,
    requestAnimationFrame: (fn: Function) => fn(),
    addEventListener: (ev: string, fn: Function) => { (winListeners[ev] ??= []).push(fn); },
    hawkesAnalytics: {
      track: (name: string, props: any) => tracked.push({ name, props: { ...props } }),
      feature: (name: string, props: any) => features.push({ name, props: { ...props } }),
      setContext: (ctx: any) => contexts.push({ ...ctx }),
    },
  };
  const doc: any = {
    readyState: 'complete',
    documentElement: { scrollHeight: 2000 },
    body: { scrollHeight: 2000 },
    querySelector: (sel: string) => (sel.includes('analytics') ? sdkEl : null),
    querySelectorAll: (sel: string) => (sel === 'main h1, main h2' ? heads : []),
    addEventListener: () => {},
  };
  vm.runInNewContext(code, { window: win, document: doc, location: win.location, navigator: win.navigator, sessionStorage: win.sessionStorage, URL, URLSearchParams, requestAnimationFrame: win.requestAnimationFrame, setTimeout: (fn: Function) => fn() });

  assert.equal(attrs['data-debug'], '1', 'sets data-debug="1" when ?hawkesPlaytest is present');
  assert.equal(tracked.length, 1);
  assert.deepEqual(tracked[0], { name: 'progress', props: { step: 25, of: 100, label: 'read 25%', section: 'What Gen does.' } });

  win.scrollY = 1500;
  for (const fn of winListeners['scroll'] ?? []) fn();
  assert.deepEqual(tracked.map((t) => t.props.step), [25, 50, 75, 100]);

  const clickLink = (href: string, sectionSel: string) => {
    const link = { href, closest: (s: string) => (s === 'a[href]' ? link : s === sectionSel ? {} : null) };
    for (const fn of winListeners['click'] ?? []) fn({ target: link });
  };
  clickLink('https://youtu.be/gT3VqH2-cw0', '.hero');
  clickLink('https://www.twitch.tv/jgriffith3433', '#live');
  clickLink('https://hawkesbiomedical.com', '#soon');
  clickLink('https://gen.hawkesgen.com/', 'nav');

  assert.deepEqual(features, [
    { name: 'cta:product_video', props: { target: 'Product video (YouTube)', where: 'hero' } },
    { name: 'cta:twitch', props: { target: 'Twitch', where: 'live' } },
    { name: 'cta:hawkes_biomedical', props: { target: 'Hawkes Biomedical', where: 'cta' } },
    { name: 'cta:sign_in', props: { target: 'Sign in', where: 'nav' } },
  ]);
  assert.deepEqual(contexts[0], { cta: 'product_video', target: 'Product video (YouTube)', where: 'hero' });
});

test('the Caddyfile is valid (when caddy is installed)', (t) => {
  if (spawnSync('caddy', ['version']).status !== 0) return t.skip('caddy not installed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-caddy-'));
  try {
    for (const text of [caddyfile]) {
      const file = path.join(dir, 'Caddyfile');
      fs.writeFileSync(file, text.replace('/var/log/caddy/access.log', path.join(dir, 'access.log')));
      const r = spawnSync('caddy', ['validate', '--config', file, '--adapter', 'caddyfile'], { encoding: 'utf8', env: { ...process.env, WEB_GEN_KEY: 'hg_test', XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir, HOME: dir } });
      assert.equal(r.status, 0, (r.stderr || r.stdout).split('\n').slice(-5).join('\n'));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
