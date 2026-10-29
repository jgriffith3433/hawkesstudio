#!/usr/bin/env node
// Moves our Workers from Workers custom domains to ordinary zone routes on proxied DNS records (2026-10-29).
//
// Why: every hawkesgen.ai host shares Cloudflare's IP and the *.hawkesgen.ai certificate, so Chrome reuses one HTTP/2
// connection for several of them. Cloudflare refuses a request on a custom domain whose Host isn't the connection's own
// name with an empty 403 (it never reaches the Worker), so a beta site or studio-beta "worked, then stopped" depending on
// which connection was open. Ordinary proxied records of one zone share connections fine (checked: hawkesnet <-> net).
//
//   node tools/edge/to-routes.mjs            print the plan (changes nothing)
//   node tools/edge/to-routes.mjs --apply    for each custom domain: add the route, remove the custom domain (Cloudflare
//                                            deletes its DNS record), add a proxied AAAA 100:: record. About a second
//                                            without the host each.
//
// Needs wrangler's login (npx wrangler login) for routes and custom domains, and the cf CLI's login for DNS. The
// wrangler.jsonc files already say routes, so the next `npx wrangler deploy` keeps it this way.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const ACCOUNT = 'f56b430f66b4e90148c6ae88cbb5a77c';
const ZONE = '9a5c5a6d1745730bae668aa01767d67e';
const ZONE_NAME = 'hawkesgen.ai';
const APPLY = process.argv.includes('--apply');
const CF = [path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'cf', 'bin', 'cf'), '/usr/local/lib/node_modules/cf/bin/cf', '/usr/lib/node_modules/cf/bin/cf'].find((p) => fs.existsSync(p));
if (!CF) { console.error('The cf CLI is not installed (npm i -g cf).'); process.exit(1); }

function wranglerToken() {
  const dirs = [path.join(process.env.APPDATA ?? '', 'xdg.config', '.wrangler', 'config'), path.join(os.homedir(), '.wrangler', 'config'), path.join(os.homedir(), '.config', '.wrangler', 'config')];
  for (const d of dirs) {
    try {
      const m = /^oauth_token\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(d, 'default.toml'), 'utf8'));
      if (m) return m[1];
    } catch {}
  }
  console.error('No wrangler login found: run  npx wrangler login  first.');
  process.exit(1);
}
// wrangler's OAuth token lasts an hour; any wrangler command refreshes it.
spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['wrangler', 'whoami'], { stdio: 'ignore', shell: process.platform === 'win32' });
const token = wranglerToken();

async function api(method, p, body) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  // A custom domain's DELETE answers 200 with an empty body (no "success" field).
  const j = await r.json().catch(() => ({ success: r.ok }));
  if (j.success === undefined ? !r.ok : !j.success) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(j.errors ?? j).slice(0, 300)}`);
  return j.result;
}

const domains = (await api('GET', `/accounts/${ACCOUNT}/workers/domains`)).filter((d) => d.zone_id === ZONE || d.hostname.endsWith(`.${ZONE_NAME}`));
const routes = await api('GET', `/zones/${ZONE}/workers/routes`);
// A host moved by an earlier run that stopped half way: a route but no DNS record (the host is down until it has one).
const records = new Set(JSON.parse(cf(['dns', 'records', 'list', '--zone', ZONE]).stdout.replace(/^[^[]*/, '') || '[]').map((r) => r.name));
const orphans = routes.filter((r) => /^[a-z0-9.-]+\/\*$/.test(r.pattern)).map((r) => ({ hostname: r.pattern.slice(0, -2), service: r.script })).filter((o) => !records.has(o.hostname) && !domains.some((d) => d.hostname === o.hostname));
for (const o of orphans) {
  console.log(`  ${o.hostname}: has a route but no DNS record${APPLY ? ': making it' : ''}`);
  if (APPLY) makeRecord(o);
}
if (!domains.length) { console.log('No Workers custom domains left on hawkesgen.ai: nothing more to do.'); process.exit(0); }

console.log(`${domains.length} custom domain(s) to move to routes:`);
for (const d of domains) console.log(`  ${d.hostname.padEnd(34)} -> ${d.service}${routes.some((r) => r.pattern === `${d.hostname}/*`) ? '  (route exists)' : ''}`);
if (!APPLY) { console.log('\nDry run. Add --apply to move them.'); process.exit(0); }

for (const d of domains) {
  const pattern = `${d.hostname}/*`;
  if (!routes.some((r) => r.pattern === pattern)) await api('POST', `/zones/${ZONE}/workers/routes`, { pattern, script: d.service });
  await api('DELETE', `/accounts/${ACCOUNT}/workers/domains/${d.id}`);
  if (makeRecord(d)) console.log(`  ${d.hostname}: route ${pattern} -> ${d.service}, proxied record made`);
}

// The cf CLI's own script under node (no shell: Windows' cmd would mangle the JSON).
function cf(args) {
  return spawnSync(process.execPath, [CF, ...args], { encoding: 'utf8' });
}
function makeRecord(d) {
  const r = cf(['dns', 'records', 'create', '--zone', ZONE, '--body', JSON.stringify({ type: 'AAAA', name: d.hostname, content: '100::', proxied: true, comment: `Worker ${d.service} (route)` })]);
  if (r.status === 0) return true;
  console.error(`  ${d.hostname}: the DNS record failed. Make it by hand (AAAA ${d.hostname} 100::, proxied):\n${(r.stderr || r.stdout).slice(0, 400)}`);
  return false;
}
console.log('\nDone. Check: every pair of hosts now answers on a shared connection (the script in docs: curl -H "Host: b" https://a/).');
