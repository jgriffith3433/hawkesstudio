#!/usr/bin/env node
// The lanes, for every repo under C:\Projects (J, 2026-10-29): local work on `dev`, `beta` for testing, `main` is live.
// Each repo has the same small .bat files, which run this from the repo's folder:
//
//   dev.bat                 switch to dev, bring it up to date, start the local dev server, print the links
//   deploy-beta.bat [bump]  dev -> beta, tagged vX.Y.Z-beta.N (Unity source repos also push a build-* tag)
//   deploy-prod.bat [bump]  beta -> main (live), tagged vX.Y.Z; asks you to type DEPLOY
//   status.bat              what's waiting for beta and for live, the last tags, the last deploys on GitHub
//   links.bat [local|beta|prod]   the addresses (with a lane: open them in the browser)
//   sync.bat                bring beta's newer commits (agents' fixes) into dev
//
// bump is patch, minor (default) or major. Every repo's addresses and commands are in repos.json; docs/lanes.md says
// how it all fits. Git talks to GitHub with the stored token (credential.helper=store), as every tool here does.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOS = JSON.parse(fs.readFileSync(path.join(HERE, 'repos.json'), 'utf8'));
const OWNER = 'jgriffith3433';
const AUTH = ['-c', 'credential.helper=', '-c', 'credential.helper=store'];
const [cmd = 'help', ...args] = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const bump = args.find((a) => ['patch', 'minor', 'major'].includes(a));

const c = { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };
const die = (m) => { console.error(c.r(`\n${m}`)); process.exit(1); };

function git(cwd, a, { ok = false, net = false, show = false } = {}) {
  const r = spawnSync('git', [...(net ? AUTH : []), ...a], { cwd, encoding: 'utf8', stdio: show ? 'inherit' : 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.status !== 0 && !ok) die(`git ${a.join(' ')} failed:\n${(r.stderr || r.stdout || '').trim()}`);
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
}
const exists = (cwd, ref) => git(cwd, ['rev-parse', '--verify', '--quiet', ref], { ok: true }) !== null;
const count = (cwd, range) => Number(git(cwd, ['rev-list', '--count', range], { ok: true }) ?? 0);
const isAncestor = (cwd, a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd }).status === 0;

/** The repo this was run in: its top folder, its name (repos.json key) and its entry. */
function repoHere() {
  const top = git(process.cwd(), ['rev-parse', '--show-toplevel'], { ok: true });
  if (!top) die('Not inside a git repo.');
  const name = path.basename(top);
  const conf = REPOS[name];
  if (!conf) die(`${name} isn't in hawkesstudio/tools/lanes/repos.json: add it there first.`);
  return { dir: top, name, conf };
}
const ghRepo = (r) => {
  const url = git(r.dir, ['remote', 'get-url', 'origin'], { ok: true }) ?? '';
  return /github\.com[/:]([^/]+\/[^/.]+)/.exec(url)?.[1] ?? `${OWNER}/${r.name}`;
};
const actions = (r) => `https://github.com/${ghRepo(r)}/actions`;

// ---- versions: prod tags vX.Y.Z, beta tags vX.Y.Z-beta.N ----
const TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const fmt = (v) => `v${v[0]}.${v[1]}.${v[2]}`;
function tagsOf(dir) {
  const out = { prod: [], beta: [] };
  for (const t of (git(dir, ['tag', '-l', 'v*'], { ok: true }) ?? '').split('\n')) {
    const m = TAG.exec(t.trim());
    if (!m) continue;
    const v = [+m[1], +m[2], +m[3]];
    if (m[4]) out.beta.push({ tag: t.trim(), v, n: +m[4] }); else out.prod.push({ tag: t.trim(), v });
  }
  out.prod.sort((a, b) => cmp(b.v, a.v));
  out.beta.sort((a, b) => cmp(b.v, a.v) || b.n - a.n);
  return out;
}
const bumped = (v, kind = 'minor') => (kind === 'major' ? [v[0] + 1, 0, 0] : kind === 'patch' ? [v[0], v[1], v[2] + 1] : [v[0], v[1] + 1, 0]);
/** The version beta is heading to: the open beta train (a beta base above the last live version), else the next bump. */
function nextBase(dir, kind) {
  const t = tagsOf(dir);
  const live = t.prod[0]?.v ?? null;
  if (!live) return kind ? bumped([1, 0, 0], kind) : [1, 0, 0];
  if (kind) return bumped(live, kind);
  const open = t.beta.find((b) => cmp(b.v, live) > 0);
  return open ? open.v : bumped(live, 'minor');
}
function nextBetaTag(dir, kind) {
  const base = nextBase(dir, kind);
  const n = Math.max(0, ...tagsOf(dir).beta.filter((b) => cmp(b.v, base) === 0).map((b) => b.n)) + 1;
  return `${fmt(base)}-beta.${n}`;
}
/** The live version for beta's commit: its own beta tag's version when it has one. */
function nextProdTag(dir, sha, kind) {
  const t = tagsOf(dir);
  const live = t.prod[0]?.v ?? null;
  if (!kind) {
    const mine = t.beta.filter((b) => git(dir, ['rev-list', '-n', '1', b.tag], { ok: true }) === sha).map((b) => b.v).sort(cmp).pop();
    if (mine && (!live || cmp(mine, live) > 0)) return fmt(mine);
  }
  return fmt(nextBase(dir, kind));
}

// ---- pieces ----
function fetchAll(r) {
  process.stdout.write(c.d('Fetching from GitHub... '));
  git(r.dir, ['fetch', '--prune', '--tags', '--force', 'origin'], { net: true });
  console.log(c.d('done'));
}
const clean = (r) => (git(r.dir, ['status', '--porcelain', '--untracked-files=no']) ?? '') === '';
const branch = (r) => git(r.dir, ['branch', '--show-current'], { ok: true }) ?? '';
/** dev exists on GitHub (made from beta, else main, the first time) and is checked out here, up to date. */
function onDev(r) {
  if (!exists(r.dir, 'origin/dev')) {
    const from = exists(r.dir, 'origin/beta') ? 'origin/beta' : 'origin/main';
    console.log(c.y(`No dev branch yet: making it from ${from}.`));
    git(r.dir, ['push', 'origin', `${from}:refs/heads/dev`], { net: true });
    git(r.dir, ['fetch', 'origin', 'dev'], { net: true });
  }
  if (branch(r) !== 'dev') {
    if (!clean(r)) die(`You're on ${branch(r) || 'a detached commit'} with uncommitted changes. Commit them (or stash them), then run this again.`);
    if (exists(r.dir, 'refs/heads/dev')) git(r.dir, ['checkout', '-q', 'dev']);
    else git(r.dir, ['checkout', '-q', '-b', 'dev', '--track', 'origin/dev']);
    console.log(`Switched to ${c.b('dev')}.`);
  }
  git(r.dir, ['branch', '-q', '--set-upstream-to=origin/dev', 'dev'], { ok: true });
  if (count(r.dir, 'dev..origin/dev') > 0) {
    if (git(r.dir, ['merge', '--ff-only', '-q', 'origin/dev'], { ok: true }) === null) {
      die('Your dev and GitHub\'s dev have both moved. Run: git pull --rebase   (then this again)');
    }
    console.log('Brought dev up to date from GitHub.');
  }
}
function printLinks(r, which = ['local', 'beta', 'prod']) {
  const label = { local: 'Local', beta: 'Beta ', prod: 'Live ' };
  for (const w of which) for (const u of r.conf[w] ?? []) console.log(`  ${label[w]}  ${u}`);
  console.log(`  CI     ${actions(r)}`);
}
function openUrls(urls) {
  for (const u of urls) spawn('cmd', ['/c', 'start', '', u], { detached: true, stdio: 'ignore' }).unref();
}
async function confirm(question, word) {
  if (flags.has('--yes')) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(question)).trim();
  rl.close();
  return a === word;
}
function runCheck(r) {
  if (!r.conf.check || flags.has('--no-check')) return;
  console.log(c.d(`\nChecking: ${r.conf.check}`));
  const res = spawnSync(r.conf.check, { cwd: r.dir, shell: true, stdio: 'inherit' });
  if (res.status !== 0) die(`The check failed (${r.conf.check}). Fix it, or run with --no-check to skip it.`);
}

const BATS = {
  dev: 'switch to dev, bring it up to date, start the local dev server, print the links',
  'deploy-beta': 'send dev to beta, tagged vX.Y.Z-beta.N (optional: patch, minor, major)',
  'deploy-prod': 'send beta to main (live), tagged vX.Y.Z; asks you to type DEPLOY',
  status: "what's waiting for beta and for live, the last tags, the links",
  links: 'the local, beta and live addresses (links beta / links prod opens them)',
  sync: "bring beta's newer commits (agents' fixes) into dev",
};

// ---- commands ----
const commands = {
  dev() {
    const r = repoHere();
    fetchAll(r);
    onDev(r);
    const waiting = exists(r.dir, 'origin/beta') ? count(r.dir, 'dev..origin/beta') : 0;
    if (waiting) console.log(c.y(`beta has ${waiting} commit(s) dev doesn't (agents' fixes): run sync.bat to bring them in.`));
    const d = r.conf.dev;
    if (d === 'unity') {
      const unity = 'C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.7f1\\Editor\\Unity.exe';
      const proj = path.join(r.dir, r.conf.unityProject ?? '.');
      if (fs.existsSync(unity)) { spawn(unity, ['-projectPath', proj], { detached: true, stdio: 'ignore' }).unref(); console.log(`Opening Unity on ${proj}.`); }
      else console.log(c.y(`Unity 6000.3.7f1 isn't at ${unity}: open ${proj} from Unity Hub.`));
      if (r.conf.site) console.log(c.d(`The website (${r.conf.site}) has its own dev.bat for a local server.`));
    } else if (d && !flags.has('--no-server')) {
      spawn('cmd', ['/c', 'start', `${r.conf.title} (dev)`, 'cmd', '/k', d], { cwd: r.dir, detached: true, stdio: 'ignore' }).unref();
      console.log(`Started the dev server in its own window: ${c.b(d)}`);
    }
    console.log(`\n${c.b(r.conf.title)} on ${c.b('dev')}. Commit here; deploy-beta.bat sends it to beta.`);
    printLinks(r);
  },

  async 'deploy-beta'() {
    const r = repoHere();
    fetchAll(r);
    onDev(r);
    if (!clean(r)) die('dev has uncommitted changes: commit them first (deploy-beta sends commits, not files).');
    if (exists(r.dir, 'origin/beta') && count(r.dir, 'dev..origin/beta') > 0) {
      console.log(`Bringing beta's ${count(r.dir, 'dev..origin/beta')} newer commit(s) into dev first...`);
      if (git(r.dir, ['merge', '--no-edit', '-q', 'origin/beta'], { ok: true }) === null) {
        git(r.dir, ['merge', '--abort'], { ok: true });
        die('beta and dev changed the same lines. Run sync.bat, fix the conflicts, commit, then deploy-beta.bat again.');
      }
    }
    const news = exists(r.dir, 'origin/beta') ? count(r.dir, 'origin/beta..dev') : count(r.dir, 'dev');
    if (!news) { console.log(c.g('Nothing new: beta already has everything on dev.')); printLinks(r, ['beta']); return; }
    runCheck(r);
    const tag = nextBetaTag(r.dir, bump);
    console.log(`\n${c.b(`${r.conf.title}: ${news} commit(s) to beta as ${tag}`)}`);
    console.log(git(r.dir, ['log', '--oneline', '--no-decorate', '-15', exists(r.dir, 'origin/beta') ? 'origin/beta..dev' : 'dev']));
    git(r.dir, ['push', '-q', 'origin', 'dev'], { net: true });
    git(r.dir, ['push', '-q', 'origin', 'dev:beta'], { net: true });
    git(r.dir, ['tag', '-a', tag, '-m', `${r.conf.title} ${tag} (beta)`, 'dev']);
    const tags = [tag];
    // A Unity source repo builds on Google Cloud from a build-* tag (hawkesgen docs/unity-cloudrun.md, "GitHub mode").
    if (r.conf.kind === 'unity') { git(r.dir, ['tag', `build-${tag}`, 'dev']); tags.push(`build-${tag}`); }
    git(r.dir, ['push', '-q', 'origin', ...tags], { net: true });
    console.log(c.g(`\nOn beta: ${tags.join(', ')}.`));
    console.log(c.d(r.conf.deploys));
    printLinks(r, ['beta']);
  },

  async 'deploy-prod'() {
    const r = repoHere();
    fetchAll(r);
    if (!exists(r.dir, 'origin/beta')) die('There is no beta branch: run deploy-beta.bat first.');
    if (exists(r.dir, 'origin/main') && !isAncestor(r.dir, 'origin/main', 'origin/beta')) {
      die(`main has ${count(r.dir, 'origin/beta..origin/main')} commit(s) beta doesn't (someone pushed main directly).\nBring them in first: on dev, run  git merge origin/main  then deploy-beta.bat, then deploy-prod.bat.`);
    }
    const news = exists(r.dir, 'origin/main') ? count(r.dir, 'origin/main..origin/beta') : count(r.dir, 'origin/beta');
    if (!news) { console.log(c.g('Nothing new: live already has everything on beta.')); printLinks(r, ['prod']); return; }
    const sha = git(r.dir, ['rev-parse', 'origin/beta']);
    const tag = nextProdTag(r.dir, sha, bump);
    console.log(`\n${c.b(`${r.conf.title}: ${news} commit(s) from beta go live as ${tag}`)}`);
    console.log(git(r.dir, ['log', '--oneline', '--no-decorate', '-25', exists(r.dir, 'origin/main') ? 'origin/main..origin/beta' : 'origin/beta']));
    console.log(c.d(`\n${r.conf.deploys}`));
    if (!(await confirm(`\nType ${c.b('DEPLOY')} to take this live: `, 'DEPLOY'))) die('Not deployed.');
    git(r.dir, ['push', '-q', 'origin', `${sha}:refs/heads/main`], { net: true });
    git(r.dir, ['tag', '-a', tag, '-m', `${r.conf.title} ${tag}`, sha]);
    git(r.dir, ['push', '-q', 'origin', tag], { net: true });
    console.log(c.g(`\nLive: ${tag}. Watch the deploy at ${actions(r)}`));
    printLinks(r, ['prod']);
  },

  sync() {
    const r = repoHere();
    fetchAll(r);
    onDev(r);
    if (!clean(r)) die('dev has uncommitted changes: commit them first.');
    const n = exists(r.dir, 'origin/beta') ? count(r.dir, 'dev..origin/beta') : 0;
    if (!n) { console.log(c.g('dev already has everything on beta.')); return; }
    if (git(r.dir, ['merge', '--no-edit', 'origin/beta'], { ok: true, show: true }) === null) {
      die('Conflicts (listed above). Fix the files, then: git add <files> && git commit, and push with sync.bat or deploy-beta.bat.');
    }
    git(r.dir, ['push', '-q', 'origin', 'dev'], { net: true });
    console.log(c.g(`Brought ${n} commit(s) from beta into dev and pushed dev.`));
  },

  status() {
    const r = repoHere();
    fetchAll(r);
    statusLine(r, true);
  },

  links() {
    const r = repoHere();
    const lane = args.find((a) => ['local', 'beta', 'prod'].includes(a));
    console.log(c.b(r.conf.title));
    printLinks(r);
    if (lane) openUrls(r.conf[lane] ?? []);
  },

  /** Every repo in repos.json that's on this PC: one line each. */
  all() {
    const root = path.resolve(HERE, '..', '..', '..');
    for (const name of Object.keys(REPOS).filter((k) => !k.startsWith('_'))) {
      const dir = path.join(root, name);
      if (!fs.existsSync(path.join(dir, '.git'))) { console.log(`${name.padEnd(28)} ${c.d('not on this PC')}`); continue; }
      const r = { dir, name, conf: REPOS[name] };
      git(dir, ['fetch', '-q', '--tags', '--force', 'origin'], { net: true, ok: true });
      statusLine(r, false);
    }
  },

  /** Writes LANES.md into this repo (or every repo with --all), from repos.json. */
  docs() {
    const root = path.resolve(HERE, '..', '..', '..');
    const names = flags.has('--all') ? Object.keys(REPOS).filter((k) => !k.startsWith('_')) : [repoHere().name];
    for (const name of names) {
      const dir = path.join(root, name);
      if (!fs.existsSync(dir)) continue;
      fs.writeFileSync(path.join(dir, 'LANES.md'), lanesDoc(name, REPOS[name]));
      console.log(`wrote ${path.join(dir, 'LANES.md')}`);
    }
  },

  /** Writes the .bat files, LANES.md and a pointer line in AGENTS.md into a repo folder (--dir <folder>, default here). */
  install() {
    const at = args.find((a, i) => args[i - 1] === '--dir');
    const dir = at ? path.resolve(at) : repoHere().dir;
    const name = args.find((a, i) => args[i - 1] === '--name') ?? path.basename(dir);
    const conf = REPOS[name];
    if (!conf) die(`${name} isn't in repos.json.`);
    for (const [bat, what] of Object.entries(BATS)) {
      fs.writeFileSync(path.join(dir, `${bat}.bat`), [
        '@echo off',
        `rem ${bat}: ${what}`,
        'rem The lanes (dev -> beta -> main), links and commands of this repo: LANES.md. Tool: hawkesstudio\\tools\\lanes\\lanes.mjs.',
        'set "LANES_CMDLINE=%cmdcmdline%"',
        'cd /d "%~dp0"',
        `node "%~dp0..\\hawkesstudio\\tools\\lanes\\lanes.mjs" ${bat} %*`,
        '',
      ].join('\r\n'));
    }
    fs.writeFileSync(path.join(dir, 'LANES.md'), lanesDoc(name, conf));
    const agents = path.join(dir, 'AGENTS.md');
    const line = '**Lanes, local dev and deploys:** `LANES.md` (branches dev -> beta -> main; `dev.bat`, `deploy-beta.bat`, `deploy-prod.bat`, `status.bat`, `links.bat`, `sync.bat`; beta and live links).';
    if (fs.existsSync(agents)) {
      const text = fs.readFileSync(agents, 'utf8');
      if (!text.includes('LANES.md')) {
        const eol = text.includes('\r\n') ? '\r\n' : '\n';
        const lines = text.split(/\r?\n/);
        const at2 = lines.findIndex((l, i) => i > 0 && l.trim() === '') + 1 || 1;
        lines.splice(at2, 0, line, '');
        fs.writeFileSync(agents, lines.join(eol));
      }
    }
    console.log(`installed the lanes in ${dir}`);
  },

  help() {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  },
};

function statusLine(r, full) {
  const has = (b) => exists(r.dir, `origin/${b}`);
  const toBeta = has('dev') && has('beta') ? count(r.dir, 'origin/beta..origin/dev') : null;
  const toProd = has('beta') && has('main') ? count(r.dir, 'origin/main..origin/beta') : null;
  const t = tagsOf(r.dir);
  const live = t.prod[0]?.tag ?? '-';
  const beta = t.beta[0]?.tag ?? '-';
  const here = `${branch(r) || 'detached'}${clean(r) ? '' : '*'}`;
  if (!full) {
    console.log(`${r.name.padEnd(28)} ${here.padEnd(12)} live ${live.padEnd(10)} beta ${beta.padEnd(16)} ${toBeta === null ? c.y('no dev') : toBeta ? c.y(`${toBeta} for beta`) : c.d('dev=beta')}  ${toProd ? c.y(`${toProd} for live`) : c.d('beta=live')}`);
    return;
  }
  console.log(`\n${c.b(r.conf.title)}  (${r.name}, you're on ${here}${clean(r) ? '' : ': uncommitted changes'})`);
  console.log(`  live ${live}   beta ${beta}`);
  console.log(`  dev -> beta : ${toBeta === null ? 'no dev branch yet (dev.bat makes it)' : toBeta ? c.y(`${toBeta} commit(s) waiting (deploy-beta.bat)`) : 'nothing waiting'}`);
  console.log(`  beta -> live: ${toProd === null ? '-' : toProd ? c.y(`${toProd} commit(s) waiting (deploy-prod.bat)`) : 'nothing waiting'}`);
  if (has('beta') && has('dev')) { const back = count(r.dir, 'origin/dev..origin/beta'); if (back) console.log(c.y(`  beta has ${back} commit(s) dev doesn't: sync.bat`)); }
  printLinks(r);
}

function lanesDoc(name, conf) {
  const list = (k) => (conf[k] ?? []).map((u) => `[${u}](${u})`).join(', ') || '-';
  return `# ${conf.title}: lanes, local dev and deploys

Generated from \`hawkesstudio/tools/lanes/repos.json\` (\`node ../hawkesstudio/tools/lanes/lanes.mjs docs\`); the whole
picture for every repo is \`hawkesstudio/docs/lanes.md\`.

**Branches: \`dev\` -> \`beta\` -> \`main\`.** Work on \`dev\` (local). \`beta\` is for testing. \`main\` is live.
Agents' fixes land on \`beta\` (pull requests Studio merges); \`sync.bat\` brings them into \`dev\`.

| | Address |
|---|---|
| Local | ${list('local')} |
| Beta | ${list('beta')} |
| Live | ${list('prod')} |
| Deploys (GitHub Actions) | [github.com/${OWNER}/${conf.github ?? name}/actions](https://github.com/${OWNER}/${conf.github ?? name}/actions) |

**How it deploys:** ${conf.deploys}

| Command (double-click, or run in a terminal here) | What it does |
|---|---|
| \`dev.bat\` | Switch to \`dev\`, bring it up to date, ${conf.dev === 'unity' ? 'open the project in Unity' : `start the dev server (\`${conf.dev}\`)`}, print the links |
| \`deploy-beta.bat [patch\\|minor\\|major]\` | Send \`dev\` to \`beta\`${conf.check ? ` after \`${conf.check}\`` : ''}, tagged \`vX.Y.Z-beta.N\`${conf.kind === 'unity' ? ', plus a `build-*` tag that builds the game on Google Cloud' : ''} |
| \`deploy-prod.bat [patch\\|minor\\|major]\` | Send \`beta\` to \`main\` (live), tagged \`vX.Y.Z\`; asks you to type DEPLOY |
| \`status.bat\` | What's waiting for beta and for live, the last tags |
| \`links.bat [local\\|beta\\|prod]\` | The addresses; with a lane, open them |
| \`sync.bat\` | Bring \`beta\`'s newer commits (agents' fixes) into \`dev\` |

Versions: live tags are \`vX.Y.Z\`; each beta deploy on the way is \`vX.Y.Z-beta.N\`. The default step is minor; pass
\`patch\` or \`major\` to choose. \`deploy-prod\` gives beta's commit the version its beta tag was heading to.
`;
}

/** A double-clicked .bat (Explorer runs cmd /c ""x.bat" ") keeps its window open to be read; a terminal doesn't wait. */
async function holdIfDoubleClicked() {
  if (!/" "\s*$/.test(process.env.LANES_CMDLINE ?? '')) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(c.d('\nPress Enter to close.'));
  rl.close();
}

const fn = commands[cmd];
let code = 0;
if (!fn) { console.error(`Unknown command ${cmd}.`); commands.help(); code = 1; }
else {
  try { await fn(); } catch (e) {
    if (!(e instanceof Stop)) throw e;
    console.error(c.r(`\n${e.message}`));
    code = 1;
  }
}
await holdIfDoubleClicked();
process.exit(code);
