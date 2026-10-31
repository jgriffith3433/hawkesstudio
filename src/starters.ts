// Starters for a brand-new game (J, 2026-10-30: Talk "MAKE games for the user and it would start a repo and everything";
// the starter: "It should be asking the user what type of game"). Talk asks what kind of game it is, picks the closest
// starter here, and Studio fills a new repo with it (repokit.ts newGamePlan): a small game that already plays, the
// playtest contract wired to a bot that plays it with real input, Hawkes Studio's push hook, GitHub Pages and the
// dev -> beta -> main lanes. Then the game itself is made from what the person described. Every starter is plain files
// generated here, so a test can read them and nothing is fetched from elsewhere.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.ts';

export type Starter = { id: string; title: string; fits: string; engine: 'web' };
export type GameSeed = { id: string; name: string; pitch: string; owner: string; repo: string; studioUrl: string };

export const STARTERS: Starter[] = [
  { id: 'web-3d', title: '3D in the browser (Babylon.js)', engine: 'web', fits: 'third-person or first-person 3D: exploring, platforming, racing, shooters, collect-a-thons, sandboxes' },
  { id: 'web-2d', title: '2D in the browser (Phaser)', engine: 'web', fits: '2D: platformers, top-down action, shoot-em-ups, puzzles, arcade, card and board games' },
];

export const starterFor = (id: string) => STARTERS.find((s) => s.id === id) ?? null;

const pagesUrl = (s: GameSeed) => {
  const [owner, name] = s.repo.split('/');
  return name.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${name.toLowerCase()}/` : `https://${owner.toLowerCase()}.github.io/${name}/`;
};
export const liveUrlFor = pagesUrl;

/** Every file of a new game's first commit, path -> text. */
export function starterFiles(starterId: string, seed: GameSeed): Record<string, string> {
  const s = starterFor(starterId);
  if (!s) throw new Error(`No starter "${starterId}" (${STARTERS.map((x) => x.id).join(', ')})`);
  const helper = (f: string) => fs.readFileSync(path.join(ROOT, 'clients', 'web', f), 'utf8');
  const files: Record<string, string> = {
    'README.md': readme(s, seed),
    'AGENTS.md': agents(s, seed),
    'CLAUDE.md': '@AGENTS.md\n',
    '.gitignore': 'node_modules/\ndist/\n.env\n.DS_Store\n',
    'vite.config.js': `import { defineConfig } from 'vite';\n\n// base './': the same build works on GitHub Pages (/${seed.repo.split('/')[1]}/) and on Studio's beta site.\nexport default defineConfig({ base: './', build: { outDir: 'dist' } });\n`,
    'src/playtest/hawkes-playtest.js': helper('hawkes-playtest.js'),
    'src/playtest/hawkes-perf.js': helper('hawkes-perf.js'),
    '.github/workflows/hawkes-studio.yml': hookYml(seed.studioUrl),
    '.github/workflows/pages.yml': pagesYml(),
    ...(s.id === 'web-3d' ? web3d(seed) : web2d(seed)),
  };
  return files;
}

const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function readme(s: Starter, seed: GameSeed) {
  return `# ${seed.name}

${seed.pitch}

Made with Hawkes Studio from the ${s.title} starter.

- Play: ${pagesUrl(seed)}
- Run it here: \`npm install\`, then \`npm run dev\`
- Lanes: work on \`dev\`, Studio's beta is \`beta\`, \`main\` is the live game (GitHub Pages publishes it).
`;
}

function agents(s: Starter, seed: GameSeed) {
  return `# ${seed.name}: agent guide

${seed.pitch}

- Engine: ${s.title}. Vite (\`npm run dev\`, \`npm run build\` to \`dist/\`). Plain JavaScript modules in \`src/\`.
- **Lanes:** \`dev\` -> \`beta\` -> \`main\`. Never push \`main\`: going live is the owner's, through Hawkes Studio.
- **Playtests:** \`src/playtest.js\` implements Hawkes Studio's playtest contract (\`window.hawkesPlaytest\`). Its bot
  plays through real input (key events), never by moving things directly. Keep the \`smoke\` scenario working when you
  change the game, and add a scenario for each new thing worth checking. \`src/playtest/\` are Studio's copies: don't edit them.
- **Studio's hook:** \`.github/workflows/hawkes-studio.yml\` tells Studio about pushes to beta and main. Keep it.
- **Live:** \`.github/workflows/pages.yml\` builds and publishes \`main\` to GitHub Pages.
- Generated art, sound and music come from Hawkes Gen (hawkesgen.ai), never from keys kept in this repo.
`;
}

function hookYml(studioUrl: string) {
  const host = studioUrl.replace(/\/+$/, '');
  return `name: Hawkes Studio

# Tells Hawkes Studio about every push to beta or main, and build-* tags, so it takes it from there (the project's builds,
# the beta site, playtests, going live). No secrets: the workflow proves which repo and branch it is with GitHub's
# signed OIDC token.

on:
  push:
    branches: [beta, main]
    tags: ['build-*']
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

concurrency:
  group: hawkes-studio-\${{ github.ref }}
  cancel-in-progress: false

jobs:
  notify:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Tell Hawkes Studio
        run: |
          token=$(curl -sSf -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=${host}" | jq -r .value)
          curl -sS --fail-with-body --retry 3 --retry-delay 10 --retry-all-errors \\
            -X POST -H "Authorization: Bearer $token" ${host}/api/hooks/github
`;
}

function pagesYml() {
  return `# Builds the game and publishes it to GitHub Pages: going live is pushing main.
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm install --no-audit --no-fund
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
`;
}

const page = (seed: GameSeed, style: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${esc(seed.name)}</title>
  <style>
    html, body { margin: 0; height: 100%; background: #0d0f14; color: #e8eaf0; font: 15px system-ui, sans-serif; overflow: hidden; }
    #hud { position: fixed; top: 12px; left: 12px; pointer-events: none; text-shadow: 0 1px 2px #000; }
    #hud b { font-size: 18px; }
    ${style}
  </style>
</head>
<body>
  <div id="hud"><b>${esc(seed.name)}</b><div id="score">Score 0</div><div id="hint">Arrow keys or WASD to move, Space to jump</div></div>
  <script type="module" src="./src/main.js"></script>
</body>
</html>
`;

/** The bot both starters share: real key events into the page, a smoke run that moves and scores. */
const playtestJs = (seed: GameSeed) => `// Hawkes Studio's playtest contract for this game (docs: hawkesstudio docs/playtest.md). The bot plays through real
// input: it presses keys like a player. Add a scenario for each new thing worth checking.
import { installPlaytest } from './playtest/hawkes-playtest.js';

// keyCode too: Phaser looks keys up by it, and a made-up KeyboardEvent has 0 there (the bot pressed keys nobody heard).
const KEY_CODES = { ' ': 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, Escape: 27, Shift: 16 };
const keyEvent = (type, key, code) => {
  const e = new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true });
  const n = KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  Object.defineProperty(e, 'keyCode', { get: () => n });
  Object.defineProperty(e, 'which', { get: () => n });
  return e;
};
const press = (key, ms) => new Promise((done) => {
  const code = key === ' ' ? 'Space' : key.length === 1 ? \`Key\${key.toUpperCase()}\` : key;
  window.dispatchEvent(keyEvent('keydown', key, code));
  setTimeout(() => { window.dispatchEvent(keyEvent('keyup', key, code)); done(); }, ms);
});

export function setupPlaytest(game) {
  installPlaytest({
    product: ${JSON.stringify(seed.id)},
    scenarios: [{ id: 'smoke', title: 'Boot, move around, score a point', seconds: 45, tags: ['smoke'] }],
    isReady: () => game.ready,
    async start(id, options, t) {
      t.scene('Playing');
      const keys = ['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown'];
      const t0 = performance.now();
      for (let i = 0; performance.now() - t0 < 30_000; i++) {
        await press(keys[i % keys.length], 700);
        if (i % 3 === 0) await press(' ', 120);
        t.metric('score', game.score);
        t.progress(Math.min(1, (performance.now() - t0) / 30_000));
        if (game.score > 0) { t.event('scored', game.score); break; }
      }
      t.finish(game.score > 0 ? 'done' : 'stuck');
    },
    stop() {},
  });
}
`;

function web3d(seed: GameSeed): Record<string, string> {
  return {
    'package.json': json({ name: seed.id, private: true, type: 'module', scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' }, dependencies: { '@babylonjs/core': '^7.54.0' }, devDependencies: { vite: '^5.4.0' } }),
    'index.html': page(seed, 'canvas { width: 100vw; height: 100vh; display: block; touch-action: none; }'),
    'src/playtest.js': playtestJs(seed),
    'src/main.js': `// ${seed.name}: a 3D starter. Walk the ball around with the arrow keys or WASD, jump with Space, collect the orbs.
// This is the place the game grows from: replace the orbs and the arena with the real thing.
import { Engine, Scene, ArcRotateCamera, HemisphericLight, Vector3, MeshBuilder, StandardMaterial, Color3 } from '@babylonjs/core';
import { setupPlaytest } from './playtest.js';

const canvas = document.createElement('canvas');
document.body.prepend(canvas);
const engine = new Engine(canvas, true);
const scene = new Scene(engine);
scene.clearColor.set(0.05, 0.06, 0.08, 1);
const camera = new ArcRotateCamera('cam', -Math.PI / 2, 1.0, 14, Vector3.Zero(), scene);
new HemisphericLight('sky', new Vector3(0.3, 1, 0.2), scene);
const ground = MeshBuilder.CreateGround('ground', { width: 30, height: 30 }, scene);
const gmat = new StandardMaterial('g', scene); gmat.diffuseColor = new Color3(0.2, 0.25, 0.3); ground.material = gmat;
const player = MeshBuilder.CreateSphere('player', { diameter: 1 }, scene);
player.position.y = 0.5;
const pmat = new StandardMaterial('p', scene); pmat.diffuseColor = new Color3(0.95, 0.6, 0.2); player.material = pmat;

const game = { ready: false, score: 0 };
const orbs = [];
const omat = new StandardMaterial('o', scene); omat.emissiveColor = new Color3(0.3, 0.9, 1);
function spawnOrb(x = (Math.random() - 0.5) * 8, z = (Math.random() - 0.5) * 8) {
  const o = MeshBuilder.CreateSphere('orb', { diameter: 0.6 }, scene);
  o.material = omat;
  o.position.set(x, 0.5, z);
  orbs.push(o);
}
// The first orb is just to the right of the start, so a first move scores (the playtest's smoke run checks it).
spawnOrb(3, 0);
for (let i = 0; i < 5; i++) spawnOrb();

const held = new Set();
addEventListener('keydown', (e) => held.add(e.code));
addEventListener('keyup', (e) => held.delete(e.code));
let vy = 0;
const score = document.getElementById('score');

scene.onBeforeRenderObservable.add(() => {
  const dt = engine.getDeltaTime() / 1000;
  const speed = 6 * dt;
  if (held.has('ArrowUp') || held.has('KeyW')) player.position.z += speed;
  if (held.has('ArrowDown') || held.has('KeyS')) player.position.z -= speed;
  if (held.has('ArrowLeft') || held.has('KeyA')) player.position.x -= speed;
  if (held.has('ArrowRight') || held.has('KeyD')) player.position.x += speed;
  if (held.has('Space') && player.position.y <= 0.51) vy = 6;
  vy -= 18 * dt;
  player.position.y = Math.max(0.5, player.position.y + vy * dt);
  player.position.x = Math.max(-14, Math.min(14, player.position.x));
  player.position.z = Math.max(-14, Math.min(14, player.position.z));
  camera.target = player.position;
  for (const o of [...orbs]) {
    if (Vector3.Distance(o.position, player.position) < 0.9) {
      o.dispose(); orbs.splice(orbs.indexOf(o), 1); game.score++; score.textContent = \`Score \${game.score}\`; spawnOrb();
    }
  }
});

engine.runRenderLoop(() => scene.render());
addEventListener('resize', () => engine.resize());
scene.executeWhenReady(() => { game.ready = true; });
setupPlaytest(game);
`,
  };
}

function web2d(seed: GameSeed): Record<string, string> {
  return {
    'package.json': json({ name: seed.id, private: true, type: 'module', scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' }, dependencies: { phaser: '^3.88.0' }, devDependencies: { vite: '^5.4.0' } }),
    'index.html': page(seed, 'canvas { display: block; margin: 0 auto; }'),
    'src/playtest.js': playtestJs(seed),
    'src/main.js': `// ${seed.name}: a 2D starter. Run and jump with the arrow keys or WASD and Space, collect the stars.
// This is the place the game grows from: replace the shapes and the level with the real thing.
import Phaser from 'phaser';
import { setupPlaytest } from './playtest.js';

const game = { ready: false, score: 0 };

class Play extends Phaser.Scene {
  create() {
    const { width, height } = this.scale;
    this.physics.world.setBounds(0, 0, width, height);
    const ground = this.add.rectangle(width / 2, height - 20, width, 40, 0x2e3a48);
    this.physics.add.existing(ground, true);
    const ledge = this.add.rectangle(width * 0.65, height - 160, 220, 20, 0x2e3a48);
    this.physics.add.existing(ledge, true);
    this.player = this.add.rectangle(120, height - 80, 28, 40, 0xf29a33);
    this.physics.add.existing(this.player);
    this.player.body.setCollideWorldBounds(true);
    this.physics.add.collider(this.player, [ground, ledge]);
    this.stars = this.physics.add.group({ allowGravity: false });
    // The first star sits on the ground ahead of the start, so a first run right scores (the smoke playtest checks it).
    this.stars.add(this.add.circle(220, height - 60, 10, 0x4fe0ff));
    for (let i = 1; i < 6; i++) this.stars.add(this.add.circle(160 + i * 110, height - 120 - (i % 2) * 90, 10, 0x4fe0ff));
    this.physics.add.overlap(this.player, this.stars, (_p, star) => {
      star.destroy(); game.score++; document.getElementById('score').textContent = \`Score \${game.score}\`;
    });
    this.keys = this.input.keyboard.addKeys('LEFT,RIGHT,UP,A,D,W,SPACE');
    game.ready = true;
  }
  update() {
    const k = this.keys;
    const body = this.player.body;
    const left = k.LEFT.isDown || k.A.isDown;
    const right = k.RIGHT.isDown || k.D.isDown;
    body.setVelocityX(left ? -220 : right ? 220 : 0);
    if ((k.SPACE.isDown || k.UP.isDown || k.W.isDown) && body.blocked.down) body.setVelocityY(-430);
  }
}

new Phaser.Game({
  type: Phaser.AUTO, width: 960, height: 540, backgroundColor: '#0d0f14',
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  physics: { default: 'arcade', arcade: { gravity: { y: 900 } } },
  scene: Play,
});
setupPlaytest(game);
`,
  };
}
