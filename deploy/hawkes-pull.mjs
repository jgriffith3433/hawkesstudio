#!/usr/bin/env node
// On the control server: deploys Hawkes Gen and Hawkes Studio from GitHub main, as root; installed by
// deploy/deploy.mjs. No polling: each repo's CI ends with a "Tell the server" job (on main, after the tests pass) that
// calls Studio (POST /api/hooks/self-deploy, GitHub's OIDC token), Studio touches .data/pull-now, and the
// hawkes-pull.path watcher starts this. Nothing reaches in from GitHub but that signal: the server pulls itself.
//
// For each repo (Gen first), when origin/main has a new commit:
//   - it deploys only a commit whose CI passed (GitHub check runs, with the server's token in /run/hawkes/github.env);
//     a failing commit is logged once and never deployed; a pending one is looked at again a minute later
//   - Studio: runs, agent changes and Talk answers carry on after a restart (they run outside its process and resume),
//     so it waits only for short critical sections (a merge, a push, a worktree add: src/drain.ts), looking again every
//     20 s, up to HAWKES_PULL_CRITICAL_MAX_MIN (default 5); and, on a Studio that can't detach its agents (no systemd
//     user manager), for agents and Talk answers running inside it, up to HAWKES_PULL_MAX_WAIT_MIN (default 720)
//   - Gen: it waits while a Unity build runs on the build server, up to HAWKES_PULL_MAX_WAIT_MIN
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
// Studio's critical sections are seconds long; one still going after this is stuck, and the deploy goes ahead.
const CRITICAL_MAX_MIN = Number(process.env.HAWKES_PULL_CRITICAL_MAX_MIN ?? 5);
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
// Through setpriv --init-groups, not Node's uid/gid options: those drop the supplementary groups, so hawkes lost
// hawkes-work and couldn't write into git object folders the agent sandbox (hawkes-agent) had created. Fetches then
// failed ("fetch failed: git fetch --quiet origin main") and deploys stalled until someone fetched by hand.
function asHawkes(cwd, cmd, args, { quiet = false } = {}) {
  const env = { ...process.env, HOME: '/home/hawkes', USER: 'hawkes', LOGNAME: 'hawkes' };
  const [file, argv] = HAWKES && process.getuid?.() === 0 ? ['setpriv', ['--reuid=hawkes', '--regid=hawkes', '--init-groups', '--', cmd, ...args]] : [cmd, args];
  return execFileSync(file, argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', quiet ? 'pipe' : 'inherit'], timeout: 15 * 60_000, env }).trim();
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
  // A retry already waiting to fire is enough. Only the timer counts: the service half of the retry that started this
  // very check may still be up, and its name being taken must not swallow the next retry (that ended the chain once).
  const waiting = (u) => { try { return execFileSync('systemctl', ['is-active', u], { encoding: 'utf8' }).trim() === 'active'; } catch { return false; } };
  if (waiting('hawkes-pull-retry.timer')) return;
  // --no-block: the retry's service only starts the pull and exits, so it never holds the name while the pull runs.
  const run = (unit) => execFileSync('systemd-run', ['--on-active', String(seconds), '--unit', unit, '--collect', '--quiet', 'systemctl', 'start', '--no-block', 'hawkes-pull.service'], { stdio: 'ignore' });
  try {
    run('hawkes-pull-retry');
  } catch {
    try { run(`hawkes-pull-retry-${Date.now()}`); } catch (e) { say(`could not schedule a retry: ${e.message}`); return; }
  }
  say(`will look again in ${seconds} s (${why})`);
}

async function getJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/**
 * Why restarting this repo's service now would interrupt something ({ why, maxMin, retry }), or null. Each service
 * waits only for its own work: Gen for Unity builds on the build server (its other jobs resume after a restart; an
 * older Gen without the count waits for any running job); Studio only for its critical sections (seconds: a merge, a
 * push), since its runs, agents and Talk answers carry on after a restart, plus agents and answers running inside its
 * own process where it can't detach them. carrying: what goes on through the restart (for the log).
 */
async function busyFor(repo) {
  if (repo === 'hawkesgen') {
    const gen = await getJson('http://127.0.0.1:8790/v1/health');
    if (!gen) return null;
    const n = typeof gen.building === 'number' ? gen.building : (gen.queue?.running ?? 0);
    return n ? { why: `${n} ${typeof gen.building === 'number' ? 'Unity build(s) on the build server' : 'Gen job(s) running'}`, maxMin: MAX_WAIT_MIN, retry: 2 * 60 } : null;
  }
  const hard = [];
  const critical = [];
  let carrying = '';
  const studio = await getJson('http://127.0.0.1:8791/api/self-deploys?limit=0');
  if (studio?.busy) {
    const b = studio.busy;
    if (b.run) hard.push(`Studio run ${b.run}`);
    if (b.agents) hard.push(`${b.agents} agent(s) running inside Studio`);
    if (b.talk) hard.push(`${b.talk} Talk answer(s) running inside Studio`);
    for (const c of b.critical ?? []) critical.push(`${c.what} (${Math.round((Date.now() - c.since) / 1000)} s)`);
    const k = b.carrying ?? {};
    carrying = [k.run ? `run ${k.run}` : '', k.agents ? `${k.agents} agent change(s)` : '', k.talk ? `${k.talk} Talk answer(s)` : ''].filter(Boolean).join(', ');
  } else {
    // An older Studio (before /api/self-deploys): its health says whether a run is going.
    const h = await getJson('http://127.0.0.1:8791/api/health');
    if (h?.run) hard.push(`Studio run ${h.run}`);
  }
  const carry = carrying ? { carrying } : {};
  if (hard.length) return { why: [...hard, ...critical].join(', '), maxMin: MAX_WAIT_MIN, retry: 2 * 60, ...carry };
  if (critical.length) return { why: critical.join(', '), maxMin: CRITICAL_MAX_MIN, retry: 20, ...carry };
  return carrying ? { why: null, ...carry } : null;
}

/**
 * Agents and Talk answers run as units of the hawkes user's own systemd manager (Studio's src/detach.ts), which only
 * runs without a login session when the user lingers. Cheap to check; done on every pass.
 */
function ensureLinger() {
  if (DRY || !HAWKES || fs.existsSync('/var/lib/systemd/linger/hawkes')) return;
  try {
    execFileSync('loginctl', ['enable-linger', 'hawkes'], { stdio: 'ignore' });
    say('enabled lingering for hawkes: Studio runs agents and Talk answers as its own systemd units, which survive a Studio restart');
  } catch (e) {
    say(`could not enable lingering for hawkes (${e.message.split('\n')[0]}): Studio keeps agents inside its own process, and deploys wait for them`);
  }
}

/**
 * The drain flag: while a repo's deploy waits, <repo>/.data/deploy-pending tells its service to start nothing new
 * (Studio: no new agents; Gen: no new Unity builds), so the work in progress finishes and the deploy gets its moment.
 */
const flagFile = (dir) => path.join(dir, '.data', 'deploy-pending');
function setFlag(dir, why) {
  if (DRY) return;
  try {
    fs.mkdirSync(path.dirname(flagFile(dir)), { recursive: true });
    fs.writeFileSync(flagFile(dir), `${new Date().toISOString()} ${why}
`);
    if (HAWKES) fs.chownSync(flagFile(dir), HAWKES.uid, HAWKES.gid);
  } catch (e) {
    say(`could not write the drain flag: ${e.message}`);
  }
}
const clearFlag = (dir) => { if (!DRY) fs.rmSync(flagFile(dir), { force: true }); };

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

ensureLinger();
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
    say(`[${r.repo}] fetch failed: ${String(e.stderr || e.message).trim().split('\n').slice(-2).join(' / ')}`);
    continue;
  }
  const head = git(dir, 'rev-parse', 'HEAD');
  const tip = git(dir, 'rev-parse', 'origin/main');
  if (head === tip) { delete s.waitingSince; clearFlag(dir); continue; }
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

// 2. Per repo: wait while restarting its service would interrupt its own work (up to the limit), draining meanwhile.
for (const t of [...todo]) {
  const busy = await busyFor(t.repo);
  const why = busy?.why;
  t.carrying = busy?.carrying;
  const s = state[t.repo];
  const waited = s.waitingSince ? (Date.now() - Date.parse(s.waitingSince)) / 60_000 : 0;
  if (why && waited < busy.maxMin) {
    if (!s.waitingSince) { s.waitingSince = new Date().toISOString(); record({ repo: t.repo, from: t.head, to: t.tip, outcome: 'waiting', detail: why }); }
    setFlag(t.dir, why);
    say(`[${t.repo}] waiting (${Math.round(waited)} of ${busy.maxMin} min), draining: ${why}`);
    retryLater(busy.retry, 'waiting for work in progress to finish');
    todo.splice(todo.indexOf(t), 1);
  } else if (why) {
    say(`[${t.repo}] still busy after ${busy.maxMin} minutes (${why}); deploying anyway`);
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
    record({ repo: t.repo, from: t.head, to: t.tip, outcome: 'deployed', detail: t.subject, files: files.length, npm: pkgs, seconds: Math.round((Date.now() - started) / 1000), ...(t.carrying ? { carried: t.carrying } : {}) });
    delete s.waitingSince;
    clearFlag(t.dir);
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
    clearFlag(t.dir);
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
