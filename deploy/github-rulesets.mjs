// GitHub rulesets on main for every Hawkes repo (products.json "repos", plus hawkesstudio and hawkesgen), so main
// only moves the way J allows (docs/agents.md, "The guards"). It changes production settings: run it after J says yes.
//
//   node deploy/github-rulesets.mjs            what it would do (every repo, its current rulesets): changes nothing
//   node deploy/github-rulesets.mjs --apply    create or update the two rulesets on every repo
//   node deploy/github-rulesets.mjs --remove   delete them again
//
// The rulesets (on the default branch, main):
//   1. "Hawkes: main is never rewritten": no deletion, no force push. Nobody bypasses it (Studio's rollback is a new
//      commit; deploy/hawkes-pull.mjs refuses a rewritten main anyway).
//   2. "Hawkes: who may push main": only repository admins bypass "restrict updates". J is the admin, and Studio's
//      go-live (deploy.ts, golive.ts, approving a Studio or Gen change) pushes with J's token, so today's flows keep
//      working; any other identity (a GitHub App or machine user for everyday work, GitHub Actions' token, a
//      collaborator) can't move main. The agent sandbox holds no GitHub token at all.
//
// The token: GITHUB_TOKEN from the environment, else the server's (/run/hawkes/github.env over SSH, never printed).
// It needs Administration write on each repo. Rulesets on private repos need GitHub Pro: those repos say so.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HERE, KEYS, state } from './aws.mjs';

const args = process.argv.slice(2);
const flag = (k) => args.includes(`--${k}`);
const OWNER = 'jgriffith3433';
const ADMIN_ROLE = 5; // GitHub's built-in repository role id for "admin"

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const st = state();
  const r = spawnSync('ssh', ['-i', st.key, '-o', `UserKnownHostsFile=${path.join(KEYS, 'known_hosts')}`, '-o', 'BatchMode=yes', `ubuntu@${st.ip}`, 'sudo sed -n "s/^GITHUB_TOKEN=//p" /run/hawkes/github.env'], { encoding: 'utf8' });
  const t = r.stdout.trim();
  if (!t) throw new Error('No GitHub token (set GITHUB_TOKEN, or check /run/hawkes/github.env on the server)');
  return t;
}
const TOKEN = token();

async function gh(route, { method = 'GET', body } = {}) {
  const r = await fetch(`https://api.github.com${route}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'hawkes-studio', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${data.message ?? ''}`.trim());
  return data;
}

const RULESETS = [
  {
    name: 'Hawkes: main is never rewritten',
    target: 'branch', enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
    bypass_actors: [],
  },
  {
    name: 'Hawkes: who may push main',
    target: 'branch', enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [{ type: 'update' }],
    bypass_actors: [{ actor_id: ADMIN_ROLE, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
  },
];

const products = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'products.json'), 'utf8'));
const slugs = [...new Set([...Object.values(products.repos ?? {}), ...(products.infra ?? []).map((t) => t.slug)])].filter((s) => s.startsWith(`${OWNER}/`)).sort();

let failed = 0;
for (const slug of slugs) {
  try {
    const repo = await gh(`/repos/${slug}`);
    const have = await gh(`/repos/${slug}/rulesets`).catch((e) => { throw new Error(`can't read rulesets: ${e.message}${repo.private ? ' (private repo: rulesets need GitHub Pro)' : ''}`); });
    const mine = have.filter((r) => r.name.startsWith('Hawkes: '));
    const line = `${slug} (${repo.private ? 'private' : 'public'}, default ${repo.default_branch}, you: ${repo.permissions?.admin ? 'admin' : 'not admin'})`;
    if (flag('remove')) {
      for (const r of mine) await gh(`/repos/${slug}/rulesets/${r.id}`, { method: 'DELETE' });
      console.log(`${line}: removed ${mine.length}`);
      continue;
    }
    if (!flag('apply')) {
      console.log(`${line}: has ${have.length ? have.map((r) => `"${r.name}"`).join(', ') : 'no rulesets'}; would ${mine.length ? 'update' : 'add'} ${RULESETS.map((r) => `"${r.name}"`).join(' and ')}`);
      continue;
    }
    for (const rs of RULESETS) {
      const cur = mine.find((r) => r.name === rs.name);
      if (cur) await gh(`/repos/${slug}/rulesets/${cur.id}`, { method: 'PUT', body: rs });
      else await gh(`/repos/${slug}/rulesets`, { method: 'POST', body: rs });
    }
    console.log(`${line}: rulesets in place`);
  } catch (e) {
    failed++;
    console.log(`${slug}: FAILED: ${e.message}`);
  }
}
if (!flag('apply') && !flag('remove')) console.log('\nNothing changed. --apply creates them (after J says yes).');
process.exitCode = failed ? 1 : 0;
