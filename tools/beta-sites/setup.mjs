// The beta sites on Cloudflare (docs/studio-cloudrun.md, "Beta sites"), J's one-time setup. Prints what it would do;
// --apply does it. Needs `npx wrangler login` once (the same Cloudflare account as hawkesgen.ai) and a Studio deployed
// with this code (it answers GET /auth/sites-key).
//
//   node tools/beta-sites/setup.mjs                 the plan and a check of what's there
//   node tools/beta-sites/setup.mjs --apply         the R2 bucket, then the Worker and its custom domains
//   node tools/beta-sites/setup.mjs --publish       asks Studio to publish every beta site now (~/.hawkes/client.json's
//                                                   owner key; --lane beta: studio-beta with studioBetaUrl/studioBetaKey)
//
// No secrets anywhere: Studio signs with a key derived from its owner key, the Worker reads the public half from Studio.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKER = path.join(ROOT, 'server', 'beta-sites');
const APPLY = process.argv.includes('--apply');
const PUBLISH = process.argv.includes('--publish');
const LANE = process.argv.includes('--lane') && process.argv[process.argv.indexOf('--lane') + 1] === 'beta' ? 'beta' : 'live';
const BUCKET = 'hawkes-beta-sites';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function wrangler(args, { capture = false } = {}) {
  console.log(`  (in server/beta-sites) npx wrangler ${args.join(' ')}`);
  if (!APPLY && !capture) return { ok: true, out: '' };
  const r = spawnSync(npx, ['--yes', 'wrangler@4', ...args], { cwd: WORKER, encoding: 'utf8', shell: process.platform === 'win32', stdio: capture ? 'pipe' : 'inherit' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const hosts = () => [...fs.readFileSync(path.join(WORKER, 'wrangler.jsonc'), 'utf8').matchAll(/"pattern":\s*"([^"]+)"/g)].map((m) => m[1]);

async function check() {
  console.log('\n# What is there now');
  for (const [lane, url] of [['live', 'https://studio.hawkesgen.ai'], ['beta', 'https://studio-beta.hawkesgen.ai']]) {
    const r = await fetch(`${url}/auth/sites-key`, { signal: AbortSignal.timeout(60_000) }).catch((e) => ({ ok: false, status: e.message }));
    const j = r.ok ? await r.json().catch(() => null) : null;
    console.log(`  ${lane} Studio's key: ${j?.key ? `ok (${j.lane})` : `not yet (${r.status}): deploy Studio with the beta-sites code first`}`);
  }
  const w = await fetch('https://sites.hawkesgen.ai/.hawkes-sites/o/x', { signal: AbortSignal.timeout(20_000) }).catch((e) => ({ status: e.message }));
  console.log(`  the Worker at sites.hawkesgen.ai: ${w.status === 400 || w.status === 401 ? 'up' : `not yet (${w.status})`}`);
  const d = await fetch('https://dod.hawkesgen.ai/', { redirect: 'manual', signal: AbortSignal.timeout(20_000) }).catch((e) => ({ status: e.message, headers: new Headers() }));
  console.log(`  dod.hawkesgen.ai without a pass: ${d.status}${d.headers.get?.('location') ? ` -> ${d.headers.get('location')}` : ''} (302 to Studio's /auth/pass is right)`);
}

async function publish() {
  const cj = path.join(os.homedir(), '.hawkes', 'client.json');
  const c = JSON.parse(fs.readFileSync(cj, 'utf8'));
  const url = LANE === 'beta' ? c.studioBetaUrl : c.studioUrl;
  const key = LANE === 'beta' ? c.studioBetaKey : c.studioKey;
  if (!url || !key) throw new Error(`${cj} has no ${LANE === 'beta' ? 'studioBetaUrl/studioBetaKey' : 'studioUrl/studioKey'}`);
  const products = JSON.parse(fs.readFileSync(path.join(ROOT, 'products.json'), 'utf8'));
  const skip = new Set(['hawkesnet', 'hawkesgenwebsite']);
  for (const id of Object.values(products.previews ?? {}).filter((x) => !skip.has(x))) {
    const r = await fetch(`${url.replace(/\/+$/, '')}/api/previews/${id}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: '{}' });
    console.log(`  ${id}: ${r.status} ${(await r.text()).slice(0, 160)}`);
  }
  console.log(`\nWatch them in Studio (Go live tab, or GET ${url}/api/previews). The first publish of a Unity site sends its whole website (Sick Of It: 1.4 GB, ~$0.17 of Google egress, some minutes); later ones only what changed.`);
}

if (PUBLISH) {
  await publish();
  process.exit(0);
}
console.log(`# The R2 bucket ${BUCKET}`);
const list = wrangler(['r2', 'bucket', 'list'], { capture: true });
if (list.ok && list.out.includes(BUCKET)) console.log('  already there');
else if (!wrangler(['r2', 'bucket', 'create', BUCKET]).ok) process.exit(1);
console.log(`\n# The Worker hawkes-beta-sites and its custom domains (each makes its DNS record):\n  ${hosts().join('\n  ')}`);
console.log('  A host that already has a DNS record (an old A/CNAME from AWS) must lose it first: Cloudflare dashboard > hawkesgen.ai > DNS.');
if (!wrangler(['deploy']).ok) process.exit(1);
await check();
if (!APPLY) console.log('\nNothing changed. Run again with --apply.');
else console.log('\nNext: node tools/beta-sites/setup.mjs --publish (and --publish --lane beta for studio-beta).');
