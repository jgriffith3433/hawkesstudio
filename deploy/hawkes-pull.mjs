#!/usr/bin/env node
// On the control server: deploys Hawkes Gen and Hawkes Studio from GitHub main, as root; installed by
// deploy/deploy.mjs. No polling: each repo's CI ends with a "Tell the server" job (on main, after the tests pass) that
// calls Studio (POST /api/hooks/self-deploy, GitHub's OIDC token), Studio touches .data/pull-now, and the
// hawkes-pull.path watcher starts this. Nothing reaches in from GitHub but that signal: the server pulls itself.
//
// For each repo (Gen first), when origin/main has a new commit:
//   - it deploys only a commit whose CI passed (GitHub check runs, with the server's token in /run/hawkes/github.env);
//     a failing commit is logged once and never deployed; a pending one is looked at again a minute later
//   - it waits (looking again every 5 minutes) while Studio is busy (a run, an agent fix, a Talk answer) or Gen is running a job (a Unity build, a GPU
//     job, a playtest), up to HAWKES_PULL_MAX_WAIT_MIN (default 720), then deploys anyway
//   - git merge --ff-only (refuses if the server's checkout has edits to tracked files, or main was rewritten)
//   - npm ci only when package.json or package-lock.json changed (Gen: also Playwright's Chromium)
//   - restarts the service and checks its health; if it doesn't come up, it goes back to the previous commit and
//     doesn't try that commit again
// Every deploy (and refusal) is a line in the journal (journalctl -u hawkes-pull) and in
// hawkesstudio/.data/self-deploys.jsonl, which Studio shows (GET /api/self-deploys).
//
//   node deploy/hawkes-pull.mjs            one pass (what the timer runs)
//   node deploy/hawkes-pull.mjs --dry-run  says what it would do
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.env.HAWKES_ROOT ?? '/srv/hawkes';
const OWNER = process.env.HAWKES_GITHUB_OWNER ?? 'jgriffith3433';
// How long a deploy waits for a run, agent fix or Gen job before restarting anyway. Agents and runs have their own time
// limits, so this is long: a restart stops agents mid-change (J may have a dozen queued).
const MAX_WAIT_MIN = Number(process.env.HAWKES_PULL_MAX_WAIT_MIN ?? 720);
const STATE = process.env.HAWKES_PULL_STATE ?? '/var/lib/hawkes/pull.json';
const LOG = path.join(ROOT, 'hawkesstudio', '.data', 'self-deploys.jsonl');
const DRY = process.argv.includes('--dry-run');
const REPOS = [
  { repo: 'hawkesgen', service: 'hawkes-gen', health: 'http://127.0.0.1:8790/v1/health', after: ['npx playwright install chromium'] },
  { repo: 'hawkesstudio', service: 'hawkes-studio', health: 'http://127.0.0.1:8791/api/health', after: [] },
];

const say = (...a) => console.log(...a);
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const saveState = (s) => { if (DRY) return; fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); };

/** One line per deploy or refusal, for Studio (the file belongs to the hawkes user). */
function record(entry) {
  const line = { at: new Date().toISOString(), ...entry };
  say(`[${line.repo}] ${line.outcome}: ${line.detail ?? ''} ${line.from ? line.from.slice(0, 7) : ''}${line.to ? ` -> ${line.to.slice(0, 7)}` : ''}`.trim());
  if (DRY) return;
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify(line) + '\n');
    const { uid, gid } = fs.statSync(path.dirname(LOG));
    fs.chownSync(LOG, uid, gid);
  } catch (e) {
    say(`could not write ${LOG}: ${e.message}`);
  }
}

/** Runs as the hawkes user (its git credential helper and its files); not through sudo, which logs every call. */
const HAWKES = (() => { try { const { uid, gid } = fs.statSync('/home/hawkes'); return { uid, gid }; } catch { return null; } })();
function asHawkes(cwd, cmd, args, { quiet = false } = {}) {
  const user = HAWKES ? { ...HAWKES, env: { ...process.env, HOME: '/home/hawkes', USER: 'hawkes', LOGNAME: 'hawkes' } } : {};
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', quiet ? 'pipe' : 'inherit'], timeout: 15 * 60_000, ...user }).trim();
}
const git = (dir, ...args) => asHawkes(dir, 'git', args, { quiet: true });
const shell = (dir, line) => asHawkes(dir, 'bash', ['-lc', line]);

function githubToken() {
  try {
    const m = /^GITHUB_TOKEN=(.+)$/m.exec(fs.readFileSync('/run/hawkes/github.env', 'utf8'));
    return m?.[1].trim();
  } catch {
    return undefined;
  }
}

/** success | failure | pending | none (no CI ran) | error (GitHub didn't answer). */
async function ciState(repo, sha, token) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'hawkes-pull', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  try {
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${repo}/commits/${sha}/check-runs?per_page=100`, { headers, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return { state: 'error', detail: `GitHub check runs: HTTP ${r.status}` };
    // "Tell the server" is CI's last job: it is what started this run, so it is still running; it doesn't count.
    const runs = ((await r.json()).check_runs ?? []).filter((c) => c.name !== 'Tell the server');
    if (!runs.length) return { state: 'none', detail: 'no CI check runs for this commit (yet)' };
    if (runs.some((c) => c.status !== 'completed')) return { state: 'pending', detail: `${runs.filter((c) => c.status !== 'completed').length} check(s) still running` };
    const bad = runs.filter((c) => !['success', 'skipped', 'neutral'].includes(c.conclusion));
    if (bad.length) return { state: 'failure', detail: bad.map((c) => `${c.name}: ${c.conclusion}`).join(', ') };
    return { state: 'success', detail: runs.map((c) => c.name).join(', ') };
  } catch (e) {
    return { state: 'error', detail: e.message };
  }
}

/**
 * Runs this script again later (systemd-run, one pending retry at a time). Deploys are triggered by CI ("Tell the
 * server" -> Studio -> the hawkes-pull.path watcher), so this is the only timer: while a deploy has to wait.
 */
function retryLater(seconds, why) {
  if (DRY) return;
  try {
    execFileSync('systemd-run', ['--on-active', String(seconds), '--unit', 'hawkes-pull-retry', '--collect', '--quiet', 'systemctl', 'start', 'hawkes-pull.service'], { stdio: 'ignore' });
    say(`will look again in ${seconds} s (${why})`);
  } catch {
    // A retry is already scheduled.
  }
}

async function getJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Why a restart now would interrupt something, or null. */
async function busy() {
  const why = [];
  const studio = await getJson('http://127.0.0.1:8791/api/self-deploys?limit=0');
  if (studio?.busy) {
    const b = studio.busy;
    if (b.run) why.push(`Studio run ${b.run}`);
    if (b.agents) why.push(`${b.agents} agent fix(es)`);
    if (b.talk) why.push(`${b.talk} Talk answer(s)`);
  } else {
    // An older Studio (before /api/self-deploys): its health says whether a run is going.
    const h = await getJson('http://127.0.0.1:8791/api/health');
    if (h?.run) why.push(`Studio run ${h.run}`);
  }
  const gen = await getJson('http://127.0.0.1:8790/v1/health');
  if (gen?.queue?.running) why.push(`${gen.queue.running} Gen job(s) running`);
  return why.length ? why.join(', ') : null;
}

async function healthy(url) {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3_000));
    if ((await getJson(url))?.ok) return true;
  }
  return false;
}

const changed = (dir, from, to) => git(dir, 'diff', '--name-only', from, to).split('\n').filter(Boolean);
const needsInstall = (files) => files.some((f) => f === 'package.json' || f === 'package-lock.json');

function install(r, dir) {
  shell(dir, 'npm ci --no-audit --no-fund --loglevel=error');
  for (const line of r.after) shell(dir, line);
}

const state = loadState();
const token = githubToken();
if (!token) say('no GITHUB_TOKEN in /run/hawkes/github.env: fetching anonymously will fail for private repos');

// 1. What's new and passed CI.
const todo = [];
for (const r of REPOS) {
  const dir = path.join(ROOT, r.repo);
  const s = (state[r.repo] ??= {});
  if (!fs.existsSync(path.join(dir, '.git'))) { say(`[${r.repo}] not a git checkout yet (run deploy/deploy.mjs once)`); continue; }
  try {
    git(dir, 'fetch', '--quiet', 'origin', 'main');
  } catch (e) {
    say(`[${r.repo}] fetch failed: ${e.message.split('\n')[0]}`);
    continue;
  }
  const head = git(dir, 'rev-parse', 'HEAD');
  const tip = git(dir, 'rev-parse', 'origin/main');
  if (head === tip) { delete s.waitingSince; continue; }
  const once = (key, entry) => { if (s[key] !== tip) { record({ repo: r.repo, from: head, to: tip, ...entry }); s[key] = tip; } };
  if (s.badCommit === tip) continue; // it was deployed once and didn't come up; wait for a new commit
  try {
    git(dir, 'merge-base', '--is-ancestor', head, tip);
  } catch {
    once('refused', { outcome: 'refused', detail: 'main does not contain the deployed commit (history rewritten?); fix by hand' });
    continue;
  }
  if (git(dir, 'status', '--porcelain', '--untracked-files=no')) {
    once('refused', { outcome: 'refused', detail: 'the server checkout has edits to tracked files (git status); commit them on GitHub or discard them' });
    continue;
  }
  const ci = await ciState(r.repo, tip, token);
  if (ci.state === 'failure') { once('refused', { outcome: 'refused', detail: `CI failed: ${ci.detail}` }); continue; }
  if (ci.state !== 'success') { say(`[${r.repo}] ${tip.slice(0, 7)} waits for CI: ${ci.detail}`); retryLater(60, 'waiting for CI'); continue; }
  todo.push({ ...r, dir, head, tip, subject: git(dir, 'log', '-1', '--format=%s', tip) });
}

// 2. Wait while something would be interrupted (up to the limit).
if (todo.length) {
  const why = await busy();
  const since = Math.min(...todo.map((t) => Date.parse(state[t.repo].waitingSince ?? new Date().toISOString())));
  const waited = (Date.now() - since) / 60_000;
  if (why && waited < MAX_WAIT_MIN) {
    for (const t of todo) {
      const s = state[t.repo];
      if (!s.waitingSince) { s.waitingSince = new Date().toISOString(); record({ repo: t.repo, from: t.head, to: t.tip, outcome: 'waiting', detail: why }); }
    }
    say(`waiting (${Math.round(waited)} of ${MAX_WAIT_MIN} min): ${why}`);
    retryLater(5 * 60, 'waiting for a run to finish');
    todo.length = 0;
  } else if (why) {
    say(`still busy after ${MAX_WAIT_MIN} minutes (${why}); deploying anyway`);
  }
}

// 3. Deploy, Gen first.
for (const t of todo) {
  const s = state[t.repo];
  const files = changed(t.dir, t.head, t.tip);
  const pkgs = needsInstall(files);
  if (DRY) { say(`[${t.repo}] would deploy ${t.head.slice(0, 7)} -> ${t.tip.slice(0, 7)} (${files.length} files${pkgs ? ', npm ci' : ''}): ${t.subject}`); continue; }
  const started = Date.now();
  try {
    git(t.dir, 'merge', '--ff-only', '--quiet', t.tip);
    if (pkgs) install(t, t.dir);
    execFileSync('systemctl', ['restart', t.service]);
    if (!(await healthy(t.health))) throw new Error(`${t.service} did not answer ${t.health} within 90 seconds`);
    record({ repo: t.repo, from: t.head, to: t.tip, outcome: 'deployed', detail: t.subject, files: files.length, npm: pkgs, seconds: Math.round((Date.now() - started) / 1000) });
    delete s.waitingSince;
  } catch (e) {
    // Back to what ran before, and don't try this commit again.
    let back = 'rolled back';
    try {
      git(t.dir, 'reset', '--hard', '--quiet', t.head);
      if (pkgs) install(t, t.dir);
      execFileSync('systemctl', ['restart', t.service]);
      if (!(await healthy(t.health))) back = 'rolled back, but the service is still not healthy: look at journalctl -u ' + t.service;
    } catch (e2) {
      back = `rollback failed too (${e2.message.split('\n')[0]}): look at the server`;
    }
    s.badCommit = t.tip;
    delete s.waitingSince;
    record({ repo: t.repo, from: t.head, to: t.tip, outcome: 'failed', detail: `${e.message.split('\n')[0]}; ${back}` });
  }
}
saveState(state);

// 4. The map of every project (hawkesstudio/docs/projects/AGENTS.md, edited in git) is the folder's AGENTS.md, with a
// CLAUDE.md that loads it, so every Claude on the server (Talk, the agents, devtools) reads it. Cheap; every run.
if (!DRY) {
  try {
    const src = path.join(ROOT, 'hawkesstudio', 'docs', 'projects', 'AGENTS.md');
    const dst = path.join(ROOT, 'AGENTS.md');
    const claude = path.join(ROOT, 'CLAUDE.md');
    const want = fs.readFileSync(src, 'utf8');
    const own = (f) => { if (HAWKES) fs.chownSync(f, HAWKES.uid, HAWKES.gid); };
    if (!fs.existsSync(dst) || fs.readFileSync(dst, 'utf8') !== want) { fs.writeFileSync(dst, want); own(dst); say('installed the projects map as AGENTS.md'); }
    if (!fs.existsSync(claude)) { fs.writeFileSync(claude, '@AGENTS.md\n'); own(claude); }
  } catch (e) {
    say(`could not install the projects map: ${e.message}`);
  }
}
