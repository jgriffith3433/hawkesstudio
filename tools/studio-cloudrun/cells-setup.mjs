// The one-time setup for customers' Studios (cells; docs/studio-customers.md "One-time setup"). Prints every step and
// changes nothing without --apply. J runs it once per lane, signed in to gcloud as himself:
//   node tools/studio-cloudrun/cells-setup.mjs [--beta] [--apply]
// It makes only shared things (nothing per customer):
//   1. the cells' service account (one for every cell) and its roles
//   2. the cells' bucket (every cell under o/<org>/)
//   3. the cells' agents' job (one for every cell)
//   4. the master secret in Secret Manager, mounted into J's Studio as STUDIO_CELLS_MASTER
//   5. J's Studio's switches: STUDIO_CELLS=on, the cells' names, its own right to make Cloud Run services as that account
//   6. the central cron: one Cloud Scheduler job calling POST /api/cells/cron daily
// Then the Worker's edge key: printed for `npx wrangler secret put EDGE_KEY` (never written anywhere by this script).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APPLY, flag, gcloud, gcloudQuery } from './common.mjs';

const beta = process.argv.includes('--beta');
const project = flag('project', 'hawkes-staging');
const region = flag('region', beta ? 'us-central1' : 'us-east4');
const P = `--project=${project}`;
const studio = beta ? 'studio-beta' : 'studio';
const cellSa = `studio-cells@${project}.iam.gserviceaccount.com`;
const studioSa = flag('studio-sa', `studio-control@${project}.iam.gserviceaccount.com`);
const schedSa = flag('scheduler-sa', `studio-scheduler@${project}.iam.gserviceaccount.com`);
const bucket = `${project}-${studio}-cells`;
const job = beta ? 'studio-beta-cell-agent' : 'studio-cell-agent';
const secret = `${studio}-cells-master`;
const publicUrl = beta ? 'https://studio-beta.hawkesgen.ai' : 'https://studio.hawkesgen.ai';

console.log(`# Customers' Studios on ${studio} (${project}, ${region})${APPLY ? '' : ' — dry run: add --apply to do it'}\n`);

console.log('# 1. One service account for every cell (never one per customer: projects cap at ~100)');
gcloud(['iam', 'service-accounts', 'create', 'studio-cells', P, '--display-name=Hawkes Studio cells (every customer)'], { okToFail: true });
// Nothing on Cloud Run project-wide: a cell's service holds its derived keys as env, which run.services.get would show
// to every other cell. Only the cells' bucket (2) and running its agents' job (3), granted on those resources.
gcloud(['projects', 'add-iam-policy-binding', project, `--member=serviceAccount:${cellSa}`, '--role=roles/logging.logWriter', '--condition=None', '--format=none']);

console.log('\n# 2. One bucket for every cell (each under o/<org>/)');
gcloud(['storage', 'buckets', 'create', `gs://${bucket}`, P, `--location=${region}`, '--uniform-bucket-level-access'], { okToFail: true });
gcloud(['storage', 'buckets', 'add-iam-policy-binding', `gs://${bucket}`, `--member=serviceAccount:${cellSa}`, '--role=roles/storage.objectAdmin', '--format=none']);
gcloud(['storage', 'buckets', 'add-iam-policy-binding', `gs://${bucket}`, `--member=serviceAccount:${studioSa}`, '--role=roles/storage.objectAdmin', '--format=none']);

console.log("\n# 3. One agents' job for every cell (each execution reads its spec from its own prefix)");
const image = gcloudQuery(['run', 'services', 'describe', studio, `--region=${region}`, P, '--format=value(spec.template.spec.containers[0].image)']) || '<J\'s Studio image>';
gcloud(['run', 'jobs', 'deploy', job, `--image=${image}`, `--region=${region}`, P, `--service-account=${cellSa}`, '--cpu=2', '--memory=4Gi', '--tasks=1', '--max-retries=0', '--task-timeout=4h', '--execution-environment=gen2', `--set-env-vars=STUDIO_STATE_BUCKET=${bucket}`, '--format=none']);
gcloud(['run', 'jobs', 'add-iam-policy-binding', job, `--region=${region}`, P, `--member=serviceAccount:${cellSa}`, '--role=roles/run.jobsExecutorWithOverrides', '--format=none']);
gcloud(['run', 'jobs', 'add-iam-policy-binding', job, `--region=${region}`, P, `--member=serviceAccount:${cellSa}`, '--role=roles/run.viewer', '--format=none']);

console.log('\n# 4. The master secret (every cell\'s keys are derived from it: cellkeys.ts). Made once; never printed.');
gcloud(['secrets', 'create', secret, P, '--replication-policy=automatic'], { okToFail: true });
if (!gcloudQuery(['secrets', 'versions', 'list', secret, P, '--limit=1', '--format=value(name)'])) {
  // A file only this user can read, gone right after: the master never reaches a command line or the screen.
  const tmp = path.join(os.tmpdir(), `cells-master-${crypto.randomBytes(6).toString('hex')}`);
  if (APPLY) fs.writeFileSync(tmp, crypto.randomBytes(48).toString('base64url'), { mode: 0o600 });
  try { gcloud(['secrets', 'versions', 'add', secret, P, `--data-file=${tmp}`, '--format=none'], { show: `secrets versions add ${secret} --data-file=<a new random 48-byte master>` }); } finally { fs.rmSync(tmp, { force: true }); }
} else console.log(`  ${secret} already has a master: kept (a new one would change every cell's keys).`);
gcloud(['secrets', 'add-iam-policy-binding', secret, P, `--member=serviceAccount:${studioSa}`, '--role=roles/secretmanager.secretAccessor', '--format=none']);

console.log("\n# 5. J's Studio becomes the control plane");
const number = gcloudQuery(['projects', 'describe', project, '--format=value(projectNumber)']) || '<project number>';
// It makes and deletes the cells' services, as the cells' account.
gcloud(['projects', 'add-iam-policy-binding', project, `--member=serviceAccount:${studioSa}`, '--role=roles/run.admin', '--condition=None', '--format=none']);
gcloud(['iam', 'service-accounts', 'add-iam-policy-binding', cellSa, P, `--member=serviceAccount:${studioSa}`, '--role=roles/iam.serviceAccountUser', '--format=none']);
gcloud(['run', 'services', 'update', studio, `--region=${region}`, P,
  `--update-env-vars=STUDIO_CELLS=on,STUDIO_CELLS_PROJECT=${project},STUDIO_CELLS_PROJECT_NUMBER=${number},STUDIO_CELLS_REGION=${region},STUDIO_CELLS_SA=${cellSa},STUDIO_CELLS_BUCKET=${bucket},STUDIO_CELLS_AGENT_JOB=${job}`,
  `--update-secrets=STUDIO_CELLS_MASTER=${secret}:latest`, '--format=none']);

console.log('\n# 6. The central cron: one job for every cell (the sweep, then paying cells\' nightly runs)');
gcloud(['scheduler', 'jobs', 'create', 'http', `${studio}-cells-cron`, '--location', region, P, '--schedule=0 4 * * *', '--time-zone=America/Los_Angeles',
  `--uri=${publicUrl}/api/cells/cron`, '--http-method=POST', `--oidc-service-account-email=${schedSa}`, `--oidc-token-audience=${publicUrl}`, '--attempt-deadline=1800s'], { okToFail: true });

console.log(`\n# Then the Worker's edge key (once per lane). On J's PC, with the master from Secret Manager:
#   node -e "const c=require('crypto');console.log(c.createHmac('sha256',process.argv[1]).update('hawkes-studio-cell:edge:*').digest('base64url'))" "$(gcloud secrets versions access latest --secret=${secret} ${P})" | npx wrangler secret put EDGE_KEY${beta ? ' --env beta' : ''}
# (in server/studio-edge), then npx wrangler deploy${beta ? ' --env beta' : ''}.`);
