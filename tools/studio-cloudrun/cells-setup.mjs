// The one-time setup for customers' Studios (cells; docs/studio-customers.md "One-time setup"). Prints every step in the
// order to run it and changes nothing without --apply. J runs it once per lane, signed in to gcloud as himself:
//   node tools/studio-cloudrun/cells-setup.mjs [--beta] [--apply]
// Before it: the lane's Studio runs this code (push beta; live with J's DEPLOY), so the control plane's routes exist.
// It makes only shared things, nothing per customer:
//   1. two service accounts: the cells' (every cell's service) and the runner's (every customer's agent run: no access)
//   2. the cells' bucket (every cell under o/<org>/)
//   3. the cells' agents' job, running as the runner's account
//   4. two secrets: the master (every cell's keys are derived from it) and J's Gen owner key (cells' Gen keys are made
//      with it); both readable by J's Studio alone, never printed
//   5. J's Studio as the control plane: Cloud Run admin, signing its own URLs (the job broker), its env and secrets
//   6. the Worker's edge key and deploy (studio.hawkesgen.ai/o/<org>/ routing)
//   7. last, the central cron (one Scheduler job: hibernation, then paying cells' nightly runs)
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APPLY, flag, gcloud, gcloudQuery, done } from './common.mjs';

const beta = process.argv.includes('--beta');
const project = flag('project', 'hawkes-staging');
const region = flag('region', beta ? 'us-central1' : 'us-east4');
const P = `--project=${project}`;
const studio = beta ? 'studio-beta' : 'studio';
const cellSa = `studio-cells@${project}.iam.gserviceaccount.com`;
const runnerSa = `studio-cell-runner@${project}.iam.gserviceaccount.com`;
const studioSa = flag('studio-sa', `studio-control@${project}.iam.gserviceaccount.com`);
const schedSa = flag('scheduler-sa', `studio-scheduler@${project}.iam.gserviceaccount.com`);
const bucket = `${project}-${studio}-cells`;
const job = beta ? 'studio-beta-cell-agent' : 'studio-cell-agent';
const master = `${studio}-cells-master`;
const genOwnerSecret = `${studio}-cells-gen-owner-key`;
const publicUrl = beta ? 'https://studio-beta.hawkesgen.ai' : 'https://studio.hawkesgen.ai';
const genUrl = beta ? 'https://gen-beta.hawkesgen.ai' : 'https://gen.hawkesgen.ai';

/** A secret's first version from a value that never reaches a command line or the screen (a 0600 file, gone after). */
function secretOnce(name, value, what) {
  gcloud(['secrets', 'create', name, P, '--replication-policy=automatic'], { okToFail: true });
  if (gcloudQuery(['secrets', 'versions', 'list', name, P, '--limit=1', '--format=value(name)'])) {
    console.log(`  ${name} already has a version: kept.`);
  } else {
    const tmp = path.join(os.tmpdir(), `cells-secret-${crypto.randomBytes(6).toString('hex')}`);
    if (APPLY) fs.writeFileSync(tmp, value(), { mode: 0o600 });
    try { gcloud(['secrets', 'versions', 'add', name, P, `--data-file=${tmp}`, '--format=none'], { show: `secrets versions add ${name} ${P} --data-file=<${what}>` }); } finally { fs.rmSync(tmp, { force: true }); }
  }
  gcloud(['secrets', 'add-iam-policy-binding', name, P, `--member=serviceAccount:${studioSa}`, '--role=roles/secretmanager.secretAccessor', '--format=none']);
}

console.log(`# Customers' Studios on ${studio} (${project}, ${region})${APPLY ? '' : ' — dry run: add --apply to do it'}`);
console.log(`# Before this: ${studio} runs the cells code (push beta${beta ? '' : ', then J\'s DEPLOY'}).\n`);

console.log('# 1. Two service accounts, shared by every customer (never one per customer: projects cap at ~100)');
// The cells' services: their own objects in the cells' bucket and starting runs of the shared job. Nothing on Cloud Run
// project-wide (a service's env holds its keys; run.services.get would show every cell's to every other).
gcloud(['iam', 'service-accounts', 'create', 'studio-cells', P, '--display-name=Hawkes Studio cells (every customer)'], { okToFail: true });
gcloud(['projects', 'add-iam-policy-binding', project, `--member=serviceAccount:${cellSa}`, '--role=roles/logging.logWriter', '--condition=None', '--format=none'], { retries: 3 });
// The agent runs: no role at all besides writing logs. They reach their own run's files through the job broker only.
gcloud(['iam', 'service-accounts', 'create', 'studio-cell-runner', P, '--display-name=Hawkes Studio customer agent runs (no data access)'], { okToFail: true });
gcloud(['projects', 'add-iam-policy-binding', project, `--member=serviceAccount:${runnerSa}`, '--role=roles/logging.logWriter', '--condition=None', '--format=none'], { retries: 3 });

console.log('\n# 2. One bucket for every cell (each under o/<org>/): the cells\' account and J\'s Studio; never the runner');
gcloud(['storage', 'buckets', 'create', `gs://${bucket}`, P, `--location=${region}`, '--uniform-bucket-level-access'], { okToFail: true });
gcloud(['storage', 'buckets', 'add-iam-policy-binding', `gs://${bucket}`, `--member=serviceAccount:${cellSa}`, '--role=roles/storage.objectAdmin', '--format=none']);
gcloud(['storage', 'buckets', 'add-iam-policy-binding', `gs://${bucket}`, `--member=serviceAccount:${studioSa}`, '--role=roles/storage.objectAdmin', '--format=none']);

console.log("\n# 3. One agents' job for every cell, running as the runner (no bucket access, no bucket in its env)");
const image = gcloudQuery(['run', 'services', 'describe', studio, `--region=${region}`, P, '--format=value(spec.template.spec.containers[0].image)']) || '<J\'s Studio image>';
gcloud(['run', 'jobs', 'deploy', job, `--image=${image}`, `--region=${region}`, P, `--service-account=${runnerSa}`, '--cpu=2', '--memory=4Gi', '--tasks=1', '--max-retries=0', '--task-timeout=4h', '--execution-environment=gen2', '--format=none']);
gcloud(['run', 'jobs', 'add-iam-policy-binding', job, `--region=${region}`, P, `--member=serviceAccount:${cellSa}`, '--role=roles/run.jobsExecutorWithOverrides', '--format=none']);
gcloud(['run', 'jobs', 'add-iam-policy-binding', job, `--region=${region}`, P, `--member=serviceAccount:${cellSa}`, '--role=roles/run.viewer', '--format=none']);

console.log('\n# 4. Two secrets, made once, never printed, readable by J\'s Studio alone');
secretOnce(master, () => crypto.randomBytes(48).toString('base64url'), 'a new random 48-byte master');
// J's Gen owner key for this lane (~/.hawkes/client.json genKey, or genBetaKey for gen-beta): the control plane makes
// each cell's own user key with it. It never reaches a cell.
const cj = path.join(os.homedir(), '.hawkes', 'client.json');
const ownerKey = () => {
  const k = fs.existsSync(cj) ? JSON.parse(fs.readFileSync(cj, 'utf8'))[beta ? 'genBetaKey' : 'genKey'] : null;
  if (!k) { console.error(`No ${beta ? 'genBetaKey' : 'genKey'} in ${cj}: cells would get no Gen key.`); process.exit(1); }
  return k;
};
secretOnce(genOwnerSecret, ownerKey, `J's Gen owner key for ${genUrl}, from ${cj}`);

console.log("\n# 5. J's Studio becomes the control plane");
const number = gcloudQuery(['projects', 'describe', project, '--format=value(projectNumber)']) || '<project number>';
// It makes, rolls and deletes the cells' services, as the cells' account.
gcloud(['projects', 'add-iam-policy-binding', project, `--member=serviceAccount:${studioSa}`, '--role=roles/run.admin', '--condition=None', '--format=none']);
// Cloud Run checks that whoever deploys a service can read its image: the control plane makes every cell from J's
// Studio's image, so it reads the image repository (the first customer's first game failed without this, 2026-10-29).
const repo = /^([a-z0-9-]+)-docker\.pkg\.dev\/[^/]+\/([^/]+)\//.exec(image);
if (repo) gcloud(['artifacts', 'repositories', 'add-iam-policy-binding', repo[2], `--location=${repo[1]}`, P, `--member=serviceAccount:${studioSa}`, '--role=roles/artifactregistry.reader', '--format=none']);
else console.log(`  (the image ${image} is not in Artifact Registry: grant ${studioSa} read on it by hand)`);
gcloud(['iam', 'service-accounts', 'add-iam-policy-binding', cellSa, P, `--member=serviceAccount:${studioSa}`, '--role=roles/iam.serviceAccountUser', '--format=none']);
// The job broker signs V4 URLs as Studio's own account (IAM signBlob on itself).
gcloud(['iam', 'service-accounts', 'add-iam-policy-binding', studioSa, P, `--member=serviceAccount:${studioSa}`, '--role=roles/iam.serviceAccountTokenCreator', '--format=none']);
gcloud(['run', 'services', 'update', studio, `--region=${region}`, P,
  `--update-env-vars=STUDIO_CELLS=on,STUDIO_CELLS_PROJECT=${project},STUDIO_CELLS_PROJECT_NUMBER=${number},STUDIO_CELLS_REGION=${region},STUDIO_CELLS_SA=${cellSa},STUDIO_CELLS_BUCKET=${bucket},STUDIO_CELLS_AGENT_JOB=${job}`,
  `--update-secrets=STUDIO_CELLS_MASTER=${master}:latest,STUDIO_GEN_OWNER_KEY=${genOwnerSecret}:latest`, '--format=none']);

console.log(`\n# 6. The Worker (in server/studio-edge): its edge key, derived from the master, then deploy. Run in PowerShell there:`);
console.log(`#   $m = gcloud secrets versions access latest --secret=${master} ${P}`);
console.log(`#   node -e "process.stdout.write(require('crypto').createHmac('sha256',process.argv[1]).update('hawkes-studio-cell:edge:*').digest('base64url'))" $m | npx wrangler secret put EDGE_KEY${beta ? ' --env beta' : ''}`);
console.log(`#   Remove-Variable m; npx wrangler deploy${beta ? ' --env beta' : ''}`);

console.log('\n# 7. Last, the central cron: one Scheduler job for every cell (hibernation, then paying cells\' nightly runs)');
gcloud(['scheduler', 'jobs', 'create', 'http', `${studio}-cells-cron`, '--location', region, P, '--schedule=0 4 * * *', '--time-zone=America/Los_Angeles',
  `--uri=${publicUrl}/api/cells/cron`, '--http-method=POST', `--oidc-service-account-email=${schedSa}`, `--oidc-token-audience=${publicUrl}`, '--attempt-deadline=1800s'], { okToFail: true });
// Beta never spends by itself (as its daily run): the job is made paused; resume it by hand to try it.
if (beta) gcloud(['scheduler', 'jobs', 'pause', `${studio}-cells-cron`, '--location', region, P]);

console.log(`\n# Check: GET ${publicUrl}/api/cells (J signed in) lists "missing": [] and "on": true.`);

console.log(`\n# 8. Isolation: every cell its own service account, reaching only its own folder o/<org>/ (docs/studio-customers.md "Isolation")`);
console.log('#    Quota: 100 service accounts per project by default; beta and live cells share this project. A raise is a free request to Google.');
// The control plane makes and deletes the cells' accounts, deploys them as those accounts, and keeps each one's managed
// folder and its policy in the cells' bucket.
gcloud(['projects', 'add-iam-policy-binding', project, `--member=serviceAccount:${studioSa}`, '--role=roles/iam.serviceAccountAdmin', '--condition=None', '--format=none']);
gcloud(['projects', 'add-iam-policy-binding', project, `--member=serviceAccount:${studioSa}`, '--role=roles/iam.serviceAccountUser', '--condition=None', '--format=none']);
gcloud(['storage', 'buckets', 'add-iam-policy-binding', `gs://${bucket}`, `--member=serviceAccount:${studioSa}`, '--role=roles/storage.admin', '--format=none']);
gcloud(['run', 'services', 'update', studio, `--region=${region}`, P, '--update-env-vars=STUDIO_CELLS_ISOLATE=1', '--format=none']);
console.log(`#    Then move the existing cells (asks ${publicUrl} with your owner key; dry run first):`);
console.log(`#      node tools/studio-cloudrun/isolate-cells.mjs${beta ? ' --beta' : ''}`);
console.log(`#      node tools/studio-cloudrun/isolate-cells.mjs${beta ? ' --beta' : ''} --apply`);
console.log('#    Last, once every cell moved, take the shared account\'s bucket-wide grant away:');
console.log(`#      gcloud storage buckets remove-iam-policy-binding gs://${bucket} --member=serviceAccount:${cellSa} --role=roles/storage.objectAdmin`);
done();
