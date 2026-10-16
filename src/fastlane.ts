// Talk's workspace and fast lane (docs/agents.md). In the agent sandbox Talk has a shell and an editor; its writable
// copies of the product repos are worktrees in <projects>/.talk/<repo>, on beta (workspace()). A small change it makes
// there goes to beta through the fast lane (fastlane()): Studio, which holds the GitHub token, checks it and pushes it.
//
//   small:    at most FAST_FILES files and FAST_LINES changed lines, no binaries
//   allowed:  no secrets or keys, no CI workflows, no generated output (play/, dist/, Game/v*, Library/...), no deleted
//             .meta files; product repos only (Studio and Gen change through their own lane, studio_task)
//   checked:  the product's checks (products.json "checks", run as the sandbox user), a canon check for content
//   pushed:   a fast-forward of beta (never main, never forced), then a beta run whose result goes back to Talk
//
// Everything else is an agent's job (studio_task, studio_fix): a pull request, a verification playtest, a preview.

import fs from 'node:fs';
import { critical } from './drain.ts';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECTS, getProduct, isInfra, StudioError, type Product } from './config.ts';
import { BETA, ensureBeta, git, gitAsync } from './beta.ts';
import { spawnShell, assertWorktree } from './sandbox.ts';
import { recordRun } from './memory.ts';
import { warmDeps } from './warm.ts';

export const FAST_FILES = () => Number(process.env.STUDIO_FAST_FILES ?? 8);
export const FAST_LINES = () => Number(process.env.STUDIO_FAST_LINES ?? 200);

const top = (p: Product) => p.repo.split('/')[0];
export const workspaceDir = (p: Product) => path.join(PROJECTS, '.talk', top(p));
const branchOf = (p: Product) => `talk/${top(p)}`;

/** Never through the fast lane. */
const PROTECTED = [
  /(^|\/)\.env(\.|$)/, /\.pem$/, /(^|\/)keys\.env$/, /(^|\/)\.data\//, /^\.github\//,
  /(^|\/)(play|dist|Library|Temp|obj|Logs)\//, /(^|\/)Game\/v[^/]*\//, /(^|\/)node_modules\//,
];
export function protectedFiles(files: { file: string; status: string }[]) {
  const out: string[] = [];
  for (const f of files) {
    if (PROTECTED.some((r) => r.test(f.file))) out.push(f.file);
    else if (f.status.startsWith('D') && f.file.endsWith('.meta')) out.push(`${f.file} (a deleted .meta)`);
  }
  return out;
}

/** Makes or refreshes Talk's worktree of a product repo on beta. A clean one is moved to beta's tip; work in it stays. */
export async function workspace(productId: string) {
  if (isInfra(productId)) throw new StudioError('Studio and Gen have no fast lane: ask for the change with studio_task (a pull request into main, checked and approved by J).');
  const p = getProduct(productId);
  const repo = path.join(PROJECTS, top(p));
  const dir = workspaceDir(p);
  await gitAsync(repo, ['fetch', '--quiet', 'origin']);
  await ensureBeta(repo);
  const base = git(repo, ['rev-parse', `origin/${BETA}`]).out;
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(repo, ['worktree', 'prune']);
    const w = await gitAsync(repo, ['worktree', 'add', '--force', '-B', branchOf(p), dir, `origin/${BETA}`]);
    if (!w.ok) throw new StudioError(`Couldn't make the workspace: ${w.err}`);
    warmDeps(dir, top(p));
  }
  assertWorktree(dir, repo);
  const dirty = git(dir, ['status', '--porcelain']).out;
  const ahead = git(dir, ['rev-list', '--count', `origin/${BETA}..HEAD`]).out;
  const behind = git(dir, ['rev-list', '--count', `HEAD..origin/${BETA}`]).out;
  let refreshed = false;
  if (!dirty && ahead === '0' && behind !== '0') {
    await gitAsync(dir, ['checkout', '--quiet', '-B', branchOf(p), `origin/${BETA}`]);
    refreshed = true;
  }
  return {
    product: p.id, dir, branch: branchOf(p), beta: base.slice(0, 7), subdir: p.repo.split('/').slice(1).join('/') || null,
    uncommitted: dirty ? dirty.split('\n').length : 0, ahead: Number(ahead), behind: refreshed ? 0 : Number(behind), refreshed,
    checks: (p.checks ?? []).map((k) => ({ dir: k.dir, cmd: k.cmd })),
    note: Number(behind) && !refreshed ? `beta moved ${behind} commit(s) ahead: git merge origin/${BETA} in the workspace before the fast lane` : undefined,
  };
}

function run(cwd: string, cmd: string, timeoutMs: number): Promise<{ ok: boolean; out: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const env = { ...process.env, CI: '1', npm_config_cache: process.env.STUDIO_NPM_CACHE ?? path.join(PROJECTS, '.work', '.npm-cache') };
    const child = spawnShell(cmd, { cwd, env });
    let out = '';
    const keep = (d: any) => { out = (out + d).slice(-12_000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => { out += `\n(timed out after ${Math.round(timeoutMs / 60_000)} min)`; child.kill('SIGTERM'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out, ms: Date.now() - t0 }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out: e.message, ms: Date.now() - t0 }); });
  });
}

/** node_modules for a check dir, when it has a lockfile and none yet (the shared npm cache keeps this fast). */
async function deps(dir: string) {
  const lock = path.join(dir, 'package-lock.json');
  if (!fs.existsSync(lock)) return null;
  const hash = crypto.createHash('sha1').update(fs.readFileSync(lock)).digest('hex');
  const stamp = path.join(dir, 'node_modules', '.hawkes-lock');
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === hash) return null;
  const r = await run(dir, 'npm ci --no-audit --no-fund --prefer-offline', 15 * 60_000);
  if (r.ok) try { fs.writeFileSync(stamp, hash); } catch { /* the sandbox owns it */ }
  return r;
}

export type FastResult = { ok: boolean; product: string; pushed?: string; commits: string[]; files: string[]; lines: number; checks: { cmd: string; ok: boolean; seconds: number; out?: string }[]; canon?: any; run?: string | null; why?: string };

/** Talk's small change: checked, then pushed to beta. Refusals say why and what to do instead. */
/** The fast lane's commit and push to beta is a critical section (drain.ts). */
export const fastlane = (...a: Parameters<typeof fastlaneNow>) => critical(`fast lane to ${a[0]}'s beta`, () => fastlaneNow(...a));
async function fastlaneNow(productId: string, message: string, { origin = null, by = 'Talk' }: { origin?: string | null; by?: string } = {}): Promise<FastResult> {
  if (isInfra(productId)) throw new StudioError('Studio and Gen have no fast lane: use studio_task.');
  const p = getProduct(productId);
  const dir = workspaceDir(p);
  if (!fs.existsSync(path.join(dir, '.git'))) throw new StudioError(`No workspace for ${p.name} yet: studio_workspace { product: "${p.id}" } makes it.`);
  const repo = path.join(PROJECTS, top(p));
  // Talk can write its workspace: Studio's git runs there only while it still links to this repo (sandbox.ts).
  assertWorktree(dir, repo);
  await gitAsync(repo, ['fetch', '--quiet', 'origin']);
  const out: FastResult = { ok: false, product: p.id, commits: [], files: [], lines: 0, checks: [] };
  const refuse = (why: string) => ({ ...out, why });
  // Uncommitted edits are committed with the message (the sandbox can commit too; this saves Talk a step).
  if (git(dir, ['status', '--porcelain']).out) {
    if (!message.trim()) return refuse('there are uncommitted edits: give a message (it becomes the commit message)');
    git(dir, ['add', '-A']);
    const c = git(dir, ['-c', 'user.name=Talk (Hawkes Studio, for J)', '-c', 'user.email=jgriffith3433@users.noreply.github.com', 'commit', '--quiet', '-m', message.trim().slice(0, 300)]);
    if (!c.ok) return refuse(`commit failed: ${c.err.slice(0, 300)}`);
  }
  const base = `origin/${BETA}`;
  out.commits = git(dir, ['log', '--format=%h %s', `${base}..HEAD`]).out.split('\n').filter(Boolean);
  if (!out.commits.length) return refuse('nothing to push: no commits on top of beta');
  if (git(dir, ['merge-base', '--is-ancestor', base, 'HEAD']).ok === false) return refuse(`beta moved since the workspace was made: run "git merge origin/${BETA}" in ${dir} (resolve any conflict), then try again`);
  const status = git(dir, ['diff', '--name-status', `${base}...HEAD`]).out.split('\n').filter(Boolean).map((l) => { const [s, ...f] = l.split('\t'); return { status: s, file: f.at(-1)! }; });
  out.files = status.map((s) => s.file);
  const numstat = git(dir, ['diff', '--numstat', `${base}...HEAD`]).out.split('\n').filter(Boolean);
  const binary = numstat.filter((l) => l.startsWith('-\t-\t')).map((l) => l.split('\t')[2]);
  out.lines = numstat.reduce((n, l) => n + (Number(l.split('\t')[0]) || 0) + (Number(l.split('\t')[1]) || 0), 0);
  if (binary.length) return refuse(`binary files aren't for the fast lane (${binary.slice(0, 5).join(', ')}): ask an agent (studio_task)`);
  if (out.files.length > FAST_FILES() || out.lines > FAST_LINES()) return refuse(`too big for the fast lane (${out.files.length} files, ${out.lines} lines; at most ${FAST_FILES()} and ${FAST_LINES()}): ask an agent (studio_task)`);
  const bad = protectedFiles(status);
  if (bad.length) return refuse(`it touches files the fast lane never changes: ${bad.join(', ')}`);
  // The product's checks, as the sandbox user.
  for (const k of p.checks ?? []) {
    const cdir = path.join(dir, path.relative(top(p), k.dir));
    const d = await deps(cdir);
    if (d && !d.ok) { out.checks.push({ cmd: 'npm ci', ok: false, seconds: Math.round(d.ms / 1000), out: d.out.slice(-1500) }); return refuse('npm ci failed in the workspace'); }
    const r = await run(cdir, k.cmd, 10 * 60_000);
    out.checks.push({ cmd: k.cmd, ok: r.ok, seconds: Math.round(r.ms / 1000), out: r.ok ? undefined : r.out.slice(-2500) });
    if (!r.ok) return refuse(`the check "${k.cmd}" failed (see checks)`);
  }
  // Content gets the canon check (canon.ts); a contradiction stops it.
  const { roleOf } = await import('./agents.ts');
  if (roleOf({ request: `${message} ${out.commits.join(' ')}` }) === 'content') {
    const { canonCheck, CONTENTISH } = await import('./canon.ts');
    const files = out.files.filter((f) => CONTENTISH.test(f));
    out.canon = await canonCheck(p.id, files.length ? git(dir, ['diff', `${base}...HEAD`, '--', ...files]).out : '', message).catch((e: any) => ({ ok: true, summary: `couldn't check: ${e.message}`, conflicts: [] }));
    if (out.canon.ok === false) return refuse(`it contradicts the canon: ${out.canon.conflicts.map((c: any) => `${c.entry} (${c.why})`).join('; ')}`);
  }
  // A fast-forward of beta, never forced, never main.
  const sha = git(dir, ['rev-parse', 'HEAD']).out;
  const push = await gitAsync(dir, ['push', '--quiet', 'origin', `HEAD:refs/heads/${BETA}`]);
  if (!push.ok) return refuse(`push to beta failed: ${push.err.split('\n').pop()}`);
  out.ok = true;
  out.pushed = sha.slice(0, 7);
  await gitAsync(repo, ['fetch', '--quiet', 'origin']);
  // Beta's run (the beta site, a Unity build, a playtest of beta) reports back to the conversation.
  const { startBeta } = await import('./pipeline.ts');
  if (process.env.STUDIO_FASTLANE_BETA !== 'off') out.run = (() => { try { return startBeta(p.id, { origin, focus: `Just pushed to beta by Talk's fast lane: ${message}. Check it works and nothing regressed.` }).id; } catch { return null; } })();
  recordRun({ kind: 'fastlane', subject: out.pushed, product: p.id, title: `Fast lane: ${message || out.commits[0]}`.slice(0, 200), outcome: 'pushed to beta', summary: `${out.commits.join('\n')}\n\nFiles: ${out.files.join(', ')} (${out.lines} lines). Checks: ${out.checks.map((c) => `${c.cmd} ${c.ok ? 'ok' : 'failed'}`).join(', ') || 'none listed'}.`, by });
  return out;
}
