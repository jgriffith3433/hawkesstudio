// Moves every customer cell onto its own service account (docs/studio-customers.md "Isolation", cells-setup.mjs step 8).
// Asks the lane's control plane (J's Studio) to do it, with J's owner key from ~/.hawkes/client.json (studioKey, or
// studioBetaKey with --beta). Without --apply it is a dry run: the control plane lists what it would make and move.
//   node tools/studio-cloudrun/isolate-cells.mjs [--beta] [--apply]
// Before it: step 8's grants and STUDIO_CELLS_ISOLATE=1 on the lane's studio service. After it: remove studio-cells@'s
// bucket-wide grant (the last line it prints).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APPLY, flag } from './common.mjs';

const beta = process.argv.includes('--beta');
const cj = path.join(os.homedir(), '.hawkes', 'client.json');
const client = fs.existsSync(cj) ? JSON.parse(fs.readFileSync(cj, 'utf8')) : {};
const url = (flag('url', '') || (beta ? client.studioBetaUrl ?? 'https://studio-beta.hawkesgen.ai' : client.studioUrl ?? 'https://studio.hawkesgen.ai')).replace(/\/+$/, '');
const key = beta ? client.studioBetaKey : client.studioKey;
if (!key) {
  console.error(`No ${beta ? 'studioBetaKey' : 'studioKey'} in ${cj}: the control plane needs J's owner key.`);
  process.exit(1);
}
console.log(`${APPLY ? 'Isolating' : 'Dry run: isolating'} the cells of ${url}…`);
const r = await fetch(`${url}/api/cells/isolate`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ dry: !APPLY }) });
const j = await r.json().catch(() => ({}));
if (!r.ok) {
  console.error(`The control plane answered ${r.status}: ${j.error ?? ''}`);
  process.exit(1);
}
for (const m of j.moved ?? []) console.log(`  moved   ${m}`);
for (const p of j.prepared ?? []) console.log(`  ready   ${p} (hibernated: it wakes as its own account)`);
for (const e of j.errors ?? []) console.log(`  FAILED  ${e}`);
if (!APPLY) console.log('\nNothing was changed. Run again with --apply to do it.');
else if (!(j.errors ?? []).length) {
  const project = flag('project', 'hawkes-staging');
  const bucket = `${project}-${beta ? 'studio-beta' : 'studio'}-cells`;
  console.log(`\nEvery cell runs as its own account now. Last, take the shared account's bucket-wide grant away:\n  gcloud storage buckets remove-iam-policy-binding gs://${bucket} --member=serviceAccount:studio-cells@${project}.iam.gserviceaccount.com --role=roles/storage.objectAdmin`);
}
if ((j.errors ?? []).length) process.exit(1);
