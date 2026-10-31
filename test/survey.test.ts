// The survey (survey.ts): what a repository is and what would make it fit Studio, from its file list and a few files.
// The rules are tested on repos shaped like real customers' (a Unity game with local packages, its website serving the
// build from Game/, a Vite app, a plain static site, Godot) without GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const S = await import('../src/survey.ts');
const STUDIO = 'https://studio.hawkesgen.ai/o/acme-1a2b';
const hookFor = (url: string) => `on:\n  push:\n    branches: [beta, main]\njobs:\n  notify:\n    steps:\n      - run: |\n          token=$(curl "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=${url}")\n          curl -X POST ${url}/api/hooks/github\n`;

test('a Unity game: its folder and version, packages from someone\'s computer block a cloud build, a build that fits', () => {
  const paths = ['Game/ProjectSettings/ProjectVersion.txt', 'Game/Packages/manifest.json', 'Game/Assets/Main.unity', 'Packages/com.acme.tools/package.json', '.github/workflows/hawkes-studio.yml'];
  const files = {
    'Game/ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 6000.3.7f1\nm_EditorVersionWithRevision: 6000.3.7f1 (abc)',
    'Game/Packages/manifest.json': JSON.stringify({ dependencies: { 'com.unity.ugui': '2.0.0', 'com.hawkes.playtest': 'file:C:/Projects/hawkesstudio/clients/unity/com.hawkes.playtest', 'com.acme.tools': 'file:../../Packages/com.acme.tools', 'com.gone': 'file:../../Missing/com.gone' } }),
    '.github/workflows/hawkes-studio.yml': hookFor('https://studio.hawkesgen.ai/o/other-9z9z'),
  };
  const s = S.analyze('acme/game', 'beta', paths, files, { studioUrl: STUDIO, unityVersions: ['6000.3.7f1'] });
  assert.deepEqual(s.parts, [{ kind: 'unity', path: 'Game', unity: '6000.3.7f1', packages: 4 }]);
  const block = s.notes.find((n) => n.level === 'blocker')!;
  assert.match(block.what, /2 Unity packages/);
  assert.match(block.what, /com\.hawkes\.playtest/);
  assert.match(block.what, /com\.gone/);
  assert.doesNotMatch(block.what, /com\.acme\.tools/, 'a package inside the repo resolves');
  assert.equal(s.notes[0], block, 'blockers first');
  assert.equal(s.studio.hook, 'elsewhere', "another Studio's hook");
  assert.ok(s.notes.some((n) => /different Hawkes Studio/.test(n.what)));
  assert.equal(s.studio.contract, true, 'the playtest package counts, even from a local folder');
  assert.deepEqual(s.suggest.builds, [{ id: 'web', tool: 'unity', path: 'Game', target: 'web', on: ['tag'] }]);
  assert.equal(s.suggest.engine, 'unity');
});

test("an editor version the cloud doesn't have is a blocker with both ways out", () => {
  const s = S.analyze('acme/old', 'main', ['ProjectSettings/ProjectVersion.txt'], { 'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 2021.3.45f2' }, { unityVersions: ['6000.3.7f1'] });
  const b = s.notes.find((n) => n.level === 'blocker')!;
  assert.match(b.what, /2021\.3\.45f2/);
  assert.match(b.fix, /6000\.3\.7f1/);
  assert.match(b.fix, /GameCI/);
});

test('a website serving a Unity build: root paths, its domain, Pages from a branch, where the build goes', () => {
  const paths = ['index.html', 'CNAME', 'css/site.css', 'Game/index.html', 'Game/v12/Build/game.loader.js', 'Game/v12/Build/game.data.unityweb'];
  const files = {
    'index.html': '<link href="/css/site.css"><script src="/js/app.js"></script><a href="/Game/">Play</a><a href="/">Home</a>',
    'Game/index.html': '<script src="v12/Build/game.loader.js"></script>',
    CNAME: 'yoobalandgame.com\n',
  };
  const s = S.analyze('acme/site', 'beta', paths, files, { studioUrl: STUDIO });
  assert.deepEqual(s.parts, [{ kind: 'static', path: '.' }]);
  assert.equal(s.hosting.domain, 'yoobalandgame.com');
  assert.equal(s.hosting.pages, 'branch');
  assert.equal(s.hosting.unityBuildIn, 'Game', 'the versioned folder is the build, Game/ is where builds go');
  assert.equal(s.suggest.live, 'https://yoobalandgame.com/');
  const rel = s.notes.find((n) => /from the site root/.test(n.what))!;
  assert.equal(rel.level, 'info', 'at its own domain (CNAME) root paths are fine: only a note');
  assert.match(rel.what, /\/css\/site\.css/);
  assert.equal(rel.by, 'agent');
  assert.ok(s.notes.some((n) => /publish \{ project: <this project's id>, path: "Game\/" \}/.test(n.fix)));
  assert.equal(s.studio.hook, 'missing');
  assert.ok(s.notes.some((n) => /doesn't hear about this repo's pushes/.test(n.what)));
  assert.deepEqual(s.suggest.builds, [{ id: 'site', tool: 'static', on: ['beta'] }]);
});

test('a Vite app: framework, build, base "/" breaks it under a path, no CI checks, its CI deploys Pages', () => {
  const paths = ['package.json', 'vite.config.ts', 'index.html', 'src/main.ts', '.github/workflows/pages.yml', '.github/workflows/hawkes-studio.yml'];
  const files = {
    'package.json': JSON.stringify({ scripts: { build: 'vite build', dev: 'vite' }, devDependencies: { vite: '^5' }, dependencies: { phaser: '^3' } }),
    'vite.config.ts': "export default { server: { port: 5173 } }",
    'index.html': '<script type="module" src="/src/main.ts"></script>',
    '.github/workflows/pages.yml': 'on:\n  push:\n    branches: [main]\njobs:\n  b:\n    steps:\n      - run: npm ci && npm run build\n      - uses: actions/deploy-pages@v4\n',
    '.github/workflows/hawkes-studio.yml': hookFor(STUDIO),
  };
  const s = S.analyze('acme/vite', 'beta', paths, files, { studioUrl: STUDIO });
  assert.deepEqual(s.parts, [{ kind: 'web', path: '.', framework: 'vite', build: 'npm run build', out: 'dist' }]);
  assert.equal(s.studio.hook, 'here');
  assert.equal(s.hosting.pages, 'workflow');
  assert.ok(s.ci.find((c) => c.file.endsWith('pages.yml'))!.does.includes('deploys GitHub Pages'));
  assert.ok(s.notes.some((n) => /base "\/"/.test(n.what) && /base: '\.\/'/.test(n.fix)));
  assert.ok(s.notes.some((n) => /No CI runs its checks/.test(n.what)));
  assert.deepEqual(s.suggest.builds, [{ id: 'site', tool: 'npm', command: 'npm install && npm run build', out: 'dist', on: ['beta'] }], 'no lockfile: npm install');
  const relative = S.analyze('acme/vite', 'beta', paths, { ...files, 'vite.config.ts': "export default { base: './' }" }, { studioUrl: STUDIO });
  assert.ok(!relative.notes.some((n) => /base "\/"/.test(n.what)), "base './' is fine");
});

test("Godot, an empty repo, and the file picks stay small", () => {
  const g = S.analyze('acme/g', 'main', ['project.godot', 'main.gd'], {}, {});
  assert.equal(g.suggest.engine, 'godot');
  assert.ok(g.notes.some((n) => /godot-web/.test(n.fix)));
  const e = S.analyze('acme/e', 'main', ['README.md'], {}, {});
  assert.equal(e.suggest.engine, null);
  assert.ok(e.notes.some((n) => /couldn't tell/.test(n.what)));
  const many = Array.from({ length: 300 }, (_, i) => `pkg${i}/package.json`).concat(Array.from({ length: 50 }, (_, i) => `.github/workflows/w${i}.yml`), ['node_modules/x/package.json', 'dist/index.html', 'index.html']);
  const w = S.wanted(many);
  assert.ok(w.length <= 20, `bounded (${w.length})`);
  assert.ok(!w.some((p) => p.includes('node_modules') || p.startsWith('dist/')));
  assert.ok(w.includes('index.html'));
});

test('a static site with dev tools but no build, and a page that starts a Unity build stored elsewhere', () => {
  const paths = ['package.json', 'index.html', 'Game/index.html', 'Game/build.json', 'CNAME'];
  const files = {
    'package.json': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } }),
    'index.html': '<a href="Game/">Play</a>',
    'Game/index.html': '<script src="https://cdn.example/builds/v3/Build/game.loader.js"></script><script>createUnityInstance(canvas, config)</script>',
    CNAME: 'game.example',
  };
  const s = S.analyze('acme/site', 'beta', paths, files, {});
  assert.deepEqual(s.parts, [{ kind: 'static', path: '.' }], "nothing to build: it ships as it is");
  assert.deepEqual(s.suggest.builds, [{ id: 'site', tool: 'static', on: ['beta'] }]);
  assert.equal(s.hosting.unityBuildIn, 'Game');
  assert.ok(!s.notes.some((n) => /base "\//.test(n.what)), 'no Vite advice for a site Vite never builds');
});

// The shapes customers bring (2026-10-31 review): each is read as what it is, with the build that fits or none.
const pkg = (o: Record<string, unknown>) => JSON.stringify(o);

test('Next.js: a static export builds to out/; a server app is a web app with no static build', () => {
  const exp = S.analyze('a/n', 'beta', ['package.json', 'next.config.mjs', 'package-lock.json'], { 'package.json': pkg({ scripts: { build: 'next build' }, dependencies: { next: '15' } }), 'next.config.mjs': "export default { output: 'export' }" }, {});
  assert.deepEqual(exp.parts, [{ kind: 'web', path: '.', framework: 'next', build: 'npm run build', out: 'out' }]);
  assert.equal((exp.suggest.builds[0] as any).command, 'npm ci && npm run build', 'a lockfile: npm ci');
  const srv = S.analyze('a/n', 'beta', ['package.json', 'next.config.mjs'], { 'package.json': pkg({ scripts: { build: 'next build' }, dependencies: { next: '15' } }), 'next.config.mjs': 'export default {}' }, {});
  assert.deepEqual(srv.parts, [{ kind: 'app', path: '.', stack: 'Next.js' }]);
  assert.equal(srv.suggest.kind, 'app');
  assert.deepEqual(srv.suggest.builds, [], 'no static build for a server app');
});

test('SvelteKit, Astro, Nuxt, Gatsby, Docusaurus, Eleventy: each its own output folder, or a server app', () => {
  const kit = S.analyze('a/k', 'beta', ['package.json', 'svelte.config.js'], { 'package.json': pkg({ scripts: { build: 'vite build' }, devDependencies: { '@sveltejs/kit': '2', '@sveltejs/adapter-static': '3', vite: '5' } }), 'svelte.config.js': "import a from '@sveltejs/adapter-static'; export default { kit: { adapter: a() } }" }, {});
  assert.equal((kit.parts[0] as any).out, 'build');
  assert.ok(!kit.notes.some((n) => /base "\//.test(n.what)), 'no Vite base advice for SvelteKit');
  const kitSrv = S.analyze('a/k', 'beta', ['package.json', 'svelte.config.js'], { 'package.json': pkg({ scripts: { build: 'vite build' }, devDependencies: { '@sveltejs/kit': '2', '@sveltejs/adapter-node': '5' } }), 'svelte.config.js': "import a from '@sveltejs/adapter-node'" }, {});
  assert.equal(kitSrv.parts[0].kind, 'app');
  const astro = S.analyze('a/a', 'beta', ['package.json', 'astro.config.mjs'], { 'package.json': pkg({ scripts: { build: 'astro build' }, dependencies: { astro: '4' } }), 'astro.config.mjs': 'export default {}' }, {});
  assert.equal((astro.parts[0] as any).out, 'dist');
  const nuxt = S.analyze('a/x', 'beta', ['package.json'], { 'package.json': pkg({ scripts: { build: 'nuxt generate' }, dependencies: { nuxt: '3' } }) }, {});
  assert.equal((nuxt.parts[0] as any).out, '.output/public');
  for (const [dep, out] of [['gatsby', 'public'], ['@docusaurus/core', 'build'], ['@11ty/eleventy', '_site']] as const) {
    const s = S.analyze('a/x', 'beta', ['package.json'], { 'package.json': pkg({ scripts: { build: 'x' }, dependencies: { [dep]: '1' } }) }, {});
    assert.equal((s.parts[0] as any).out, out, dep);
  }
});

test('pnpm and yarn lockfiles choose the install; a monorepo gives one build per package and skips the workspace root', () => {
  const paths = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/web/package.json', 'apps/docs/package.json', 'apps/api/package.json'];
  const files = {
    'package.json': pkg({ private: true, scripts: { build: 'turbo build' }, devDependencies: { turbo: '2' } }),
    'apps/web/package.json': pkg({ scripts: { build: 'vite build' }, devDependencies: { vite: '5' } }),
    'apps/docs/package.json': pkg({ scripts: { build: 'astro build' }, dependencies: { astro: '4' } }),
    'apps/api/package.json': pkg({ scripts: { build: 'tsc', start: 'node dist/server.js' }, dependencies: { express: '4' } }),
  };
  const s = S.analyze('a/mono', 'beta', paths, files, {});
  assert.deepEqual(s.suggest.builds.map((b: any) => b.id).sort(), ['site-docs', 'site-web'], 'unique ids, the root and the API left out');
  assert.ok(s.suggest.builds.every((b: any) => String(b.command).startsWith('npx --yes pnpm@9 install --frozen-lockfile')));
  assert.ok(s.parts.some((x) => x.kind === 'app' && x.path === 'apps/api'), 'the Express API is a server app');
  const y = S.analyze('a/y', 'beta', ['package.json', 'yarn.lock'], { 'package.json': pkg({ scripts: { build: 'vite build' }, devDependencies: { vite: '5' } }) }, {});
  assert.match(String((y.suggest.builds[0] as any).command), /yarn@1 install --frozen-lockfile && npx --yes yarn@1 run build/);
});

test('Electron is a desktop app, backends in other languages are web apps, and other hosts are named', () => {
  const el = S.analyze('a/e', 'beta', ['package.json'], { 'package.json': pkg({ scripts: { build: 'electron-builder' }, devDependencies: { electron: '30', 'electron-builder': '24' } }) }, {});
  assert.deepEqual(el.parts, [{ kind: 'desktop', path: '.', stack: 'electron' }]);
  assert.equal(el.suggest.engine, 'desktop');
  assert.deepEqual(el.suggest.builds, [], 'never published as a website');
  const py = S.analyze('a/p', 'beta', ['requirements.txt', 'app.py', 'templates/index.html', 'Dockerfile', 'fly.toml'], { 'templates/index.html': '<html></html>', Dockerfile: 'FROM python', 'fly.toml': 'app="x"' }, {});
  assert.deepEqual(py.parts, [{ kind: 'app', path: '.', stack: 'Python' }], "Flask's templates aren't a static site");
  assert.equal(py.hosting.provider, 'Fly.io');
  assert.ok(py.notes.some((n) => /hosted on Fly\.io/.test(n.what)));
  const net = S.analyze('a/s', 'beta', ['index.html', 'netlify.toml'], { 'index.html': '<a href="about.html">x</a>', 'netlify.toml': '[build]' }, {});
  assert.equal(net.hosting.provider, 'Netlify');
});

test("Unity WebGL templates and Godot exports aren't sites; Godot 3 and 4 are told apart", () => {
  const u = S.analyze('a/u', 'beta', ['Game/ProjectSettings/ProjectVersion.txt', 'Game/Packages/manifest.json', 'Game/Assets/WebGLTemplates/Mine/index.html'], {
    'Game/ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 6000.3.7f1', 'Game/Packages/manifest.json': '{"dependencies":{}}', 'Game/Assets/WebGLTemplates/Mine/index.html': '<script>createUnityInstance()</script>',
  }, { unityVersions: ['6000.3.7f1'] });
  assert.deepEqual(u.parts.map((x) => x.kind), ['unity'], 'the template is not a static site');
  assert.equal(u.hosting.unityBuildIn, null, "nor a website serving a build");
  const g3 = S.analyze('a/g', 'beta', ['project.godot', 'export/web/index.html'], { 'project.godot': 'config_version=4\n', 'export/web/index.html': '<html>' }, {});
  assert.deepEqual(g3.parts, [{ kind: 'godot', path: '.', godot: '3' }], 'the committed export is not a second site');
  assert.ok(g3.notes.some((n) => /Godot 3/.test(n.fix)));
  const g4 = S.analyze('a/g', 'beta', ['project.godot'], { 'project.godot': 'config_version=5\n' }, {});
  assert.equal((g4.parts[0] as any).godot, '4');
});

test("a Vite app's own source page isn't flagged for root paths (its build rewrites them), and CI that runs tests counts", () => {
  const s = S.analyze('a/v', 'beta', ['package.json', 'index.html', '.github/workflows/ci.yml'], {
    'package.json': pkg({ scripts: { build: 'vite build' }, devDependencies: { vite: '5' } }),
    'index.html': '<script type="module" src="/src/main.ts"></script><link rel="icon" href="/vite.svg">',
    '.github/workflows/ci.yml': 'on: [push]\njobs:\n  t:\n    steps:\n      - run: pnpm test\n',
  }, {});
  assert.ok(!s.notes.some((n) => /links its files from the site root/.test(n.what)));
  assert.ok(!s.notes.some((n) => /No CI runs its checks/.test(n.what)), 'pnpm test counts as tests');
});

test('a mobile Unity game is asked about its platforms instead of getting a WebGL build', () => {
  const s = S.analyze('a/m', 'beta', ['ProjectSettings/ProjectVersion.txt', 'Packages/manifest.json', 'Assets/Plugins/Android/libgame.so'], { 'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 6000.3.7f1', 'Packages/manifest.json': '{"dependencies":{"com.unity.ads":"4.4.2"}}' }, { unityVersions: ['6000.3.7f1'] });
  assert.deepEqual(s.suggest.builds, []);
  assert.ok(s.notes.some((n) => /looks like a mobile game/.test(n.what)));
});
