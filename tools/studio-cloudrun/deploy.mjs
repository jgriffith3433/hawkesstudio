#!/usr/bin/env node
// Deploys Hawkes Studio on Cloud Run (docs/studio-cloudrun.md): the service `studio`, the job `studio-agent` (agents',
// scouts' and Talk's Claude Code, one execution per pass) and the daily run's Cloud Scheduler job. Prints every step;
// changes things only with --apply. J runs it through deploy.ps1 (IAM and secret writes are his). Every step is safe to
// run again.
//
//   node tools/studio-cloudrun/deploy.mjs [--lane live|beta] [--project hawkes-staging] [--region us-east4] [--gen https://hawkesgen.ai] [--apply]
//
// 1. APIs; the state bucket (studio.db through Litestream, state files, the jobs' folders, cleared after 7 days).
// 2. Three accounts: studio-control@ (the service: the bucket, starting and following the job), studio-agent@ (the job:
//    only the bucket's jobs/ folder) and studio-scheduler@ (the daily run's caller: nothing but its identity).
// 3. Secrets (values never printed): Studio's owner key, the agents' key and the MCP key (new random ones, made once),
//    Studio's own Gen keys (made with the Gen owner key in ~/.hawkes/client.json: an admin key for Studio, a user key
//    for agents and Talk), the GitHub token (git's stored credential for github.com on this PC), Resend's key if set.
// 4. The service: the image build.mjs made, one instance at most per revision (no service-wide cap), none while idle,
//    CPU while an instance lives, a startup probe that allows 10 minutes.
// 5. The job, the scheduler (05:00 America/Los_Angeles), the service's own URL into its environment, a health check
//    with the owner key, and this PC's ~/.hawkes/client.json pointed at Studio (studioUrl, studioKey).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { flag, gcloud, gcloudQuery, die, done, ROOT, APPLY } from './common.mjs';

const project = flag('project', 'hawkes-staging');
const region = flag('region', 'us-east4');
// The lane (J, 2026-10-28: dev -> beta -> main): live is `studio` (studio.hawkesgen.ai, from main, on live Gen); beta is
// `studio-beta` (studio-beta.hawkesgen.ai, from beta) on gen-beta, with its own database, keys and agents' job, and no
// daily run of its own (it never spends by itself). Same image, same accounts.
const lane = flag('lane', 'live');
if (!['live', 'beta'].includes(lane)) die(`--lane is live or beta, not ${lane}`);
const beta = lane === 'beta';
const service = flag('service', beta ? 'studio-beta' : 'studio');
const jobName = flag('job', beta ? 'studio-agent-beta' : 'studio-agent');
const genUrl = flag('gen', beta ? 'https://beta.hawkesgen.ai' : 'https://hawkesgen.ai').replace(/\/+$/, '');
// Studio talks to Gen at Gen's own Cloud Run address, never through the gen-edge Cloudflare Worker in front of the public
// name (2026-11-02: the account's Workers allowance was mostly Studio's own server calls). The public name stays for
// what a browser opens (GEN_PUBLIC_URL: screenshots, videos, links). The addresses are hawkesgen's server/gen-edge
// wrangler.jsonc GEN_ORIGIN (live and env.beta). --gen-direct overrides; --gen-direct= (empty) goes back to the public name.
// Both lanes by default (live: https://gen-f6ruen5wfa-uk.a.run.app). src/gendirect.ts does the same at start-up for
// either lane, so the image CI deploys moves a service that still has the public name in HAWKESGEN_URL.
const genDirect = flag('gen-direct', beta ? 'https://gen-beta-388576319982.us-central1.run.app' : 'https://gen-f6ruen5wfa-uk.a.run.app').replace(/\/+$/, '') || genUrl;
const publicUrl = flag('public-url', beta ? 'https://studio-beta.hawkesgen.ai' : 'https://studio.hawkesgen.ai').replace(/\/+$/, '');
const emails = flag('google-emails', 'piercehawkes3@gmail.com');
const P = `--project=${project}`;
// The service's startup probe (see the deploy below): a TCP check of the port every 10 s, 60 tries, so up to 10 minutes
// from start to listening. Cells use the same numbers (src/cellrun.ts CELL_STARTUP_PROBE; test/cells.test.ts checks).
const STARTUP_PROBE = 'tcpSocket.port=8080,initialDelaySeconds=0,periodSeconds=10,timeoutSeconds=5,failureThreshold=60';
const sa = `studio-control@${project}.iam.gserviceaccount.com`;
const agentSa = `studio-agent@${project}.iam.gserviceaccount.com`;
const schedSa = `studio-scheduler@${project}.iam.gserviceaccount.com`;
const bucket = flag('state-bucket', `${project}-${beta ? 'studio-beta' : 'studio'}-state`);
/** Secret names per lane: studio-owner-key on live, studio-beta-owner-key on beta. */
const sec = (name) => (beta ? name.replace(/^studio-/, 'studio-beta-') : name);

// The image: --image, else the one the service runs now (CI deploys code; this script changes settings, secrets and
// permissions without rolling the code back), else the last one build.mjs made on this PC.
const imageFile = path.join(ROOT, '.data', 'cloudrun', 'studio-image.json');
const running = gcloudQuery(['run', 'services', 'describe', service, `--region=${region}`, P, '--format=value(spec.template.spec.containers[0].image)']);
const image = flag('image', running || (fs.existsSync(imageFile) ? JSON.parse(fs.readFileSync(imageFile, 'utf8')).tag : null));
if (!image) die('No image yet: node tools/studio-cloudrun/build.mjs --apply');
console.log(`Studio on Cloud Run: ${service} + job ${jobName} in ${project} / ${region}\nImage ${image}\nGen ${genDirect} (browsers: ${genUrl})\n`);

console.log('# APIs');
gcloud(['services', 'enable', 'run.googleapis.com', 'secretmanager.googleapis.com', 'artifactregistry.googleapis.com', 'cloudbuild.googleapis.com', 'storage.googleapis.com', 'cloudscheduler.googleapis.com', 'iam.googleapis.com', P, '--format=none']);

console.log('\n# The state bucket');
if (gcloudQuery(['storage', 'buckets', 'describe', `gs://${bucket}`, P, '--format=value(name)']) === null) {
  gcloud(['storage', 'buckets', 'create', `gs://${bucket}`, P, `--location=${region}`, '--uniform-bucket-level-access', '--public-access-prevention', '--format=none']);
}
// Old versions of the state are kept a while (a bad write can be undone); the jobs' folders go after 7 days.
const lifecycle = path.join(os.tmpdir(), 'studio-state-lifecycle.json');
fs.writeFileSync(lifecycle, JSON.stringify({ rule: [
  { action: { type: 'Delete' }, condition: { age: 7, matchesPrefix: ['jobs/'] } },
  { action: { type: 'Delete' }, condition: { daysSinceNoncurrentTime: 30 } },
] }));
gcloud(['storage', 'buckets', 'update', `gs://${bucket}`, P, '--versioning', `--lifecycle-file=${lifecycle}`, '--format=none']);

console.log('\n# Accounts and what they may do');
const account = (email, id, title) => {
  if (gcloudQuery(['iam', 'service-accounts', 'describe', email, P, '--format=value(email)']) === null) {
    gcloud(['iam', 'service-accounts', 'create', id, P, `--display-name=${title}`, '--format=none']);
  }
};
account(sa, 'studio-control', 'Hawkes Studio (the service)');
account(agentSa, 'studio-agent', 'Hawkes Studio agents (Claude Code jobs: only the jobs/ folder)');
account(schedSa, 'studio-scheduler', 'Hawkes Studio daily run (Cloud Scheduler)');
gcloud(['storage', 'buckets', 'add-iam-policy-binding', `gs://${bucket}`, P, `--member=serviceAccount:${sa}`, '--role=roles/storage.objectAdmin', '--condition=None', '--format=none'], { retries: 9 });
// The job reads and writes only jobs/ (never state/: Claude accounts, settings); listing needs the bucket reader role.
gcloud(['storage', 'buckets', 'add-iam-policy-binding', `gs://${bucket}`, P, `--member=serviceAccount:${agentSa}`, '--role=roles/storage.objectAdmin',
  `--condition=expression=resource.name.startsWith("projects/_/buckets/${bucket}/objects/jobs/"),title=jobs-only`, '--format=none'], { retries: 9 });
gcloud(['storage', 'buckets', 'add-iam-policy-binding', `gs://${bucket}`, P, `--member=serviceAccount:${agentSa}`, '--role=roles/storage.legacyBucketReader', '--condition=None', '--format=none'], { retries: 9 });
// run.developer: start the agent job with per-pass overrides and follow its executions; acting as the job's account.
for (const role of ['roles/run.developer', 'roles/logging.logWriter']) {
  gcloud(['projects', 'add-iam-policy-binding', project, `--member=serviceAccount:${sa}`, `--role=${role}`, '--condition=None', '--format=none'], { retries: 9 });
}
gcloud(['iam', 'service-accounts', 'add-iam-policy-binding', agentSa, P, `--member=serviceAccount:${sa}`, '--role=roles/iam.serviceAccountUser', '--format=none'], { retries: 9 });

console.log('\n# Secrets (values never printed)');
const mounted = [];
function putSecret(name, value) {
  if (gcloudQuery(['secrets', 'describe', name, P, '--format=value(name)']) === null) {
    gcloud(['secrets', 'create', name, P, '--replication-policy=automatic', '--format=none']);
  }
  if (APPLY) {
    const tmp = path.join(os.tmpdir(), `studio-secret-${crypto.randomBytes(6).toString('hex')}`);
    fs.writeFileSync(tmp, value, { mode: 0o600 });
    try { gcloud(['secrets', 'versions', 'add', name, `--data-file=${tmp}`, P, '--format=none'], { show: `secrets versions add ${name} --data-file=<a temporary file with the value> ${P}` }); } finally { fs.rmSync(tmp, { force: true }); }
  } else console.log(`  (dry run) gcloud secrets versions add ${name} --data-file=<a temporary file with the value>`);
}
const readSecret = (name) => gcloudQuery(['secrets', 'versions', 'access', 'latest', `--secret=${name}`, P]);
/** A secret made once (a random key, or what `make` returns), then mounted as `env`. */
async function secret(env, laneless, make) {
  const name = sec(laneless);
  let v = readSecret(name);
  if (!v) {
    v = await make();
    if (!v) { console.log(`  ${name}: nothing to store, skipped`); return null; }
    putSecret(name, v);
  } else console.log(`  ${name}: kept`);
  gcloud(['secrets', 'add-iam-policy-binding', name, P, `--member=serviceAccount:${sa}`, '--role=roles/secretmanager.secretAccessor', '--format=none'], { retries: 9 });
  mounted.push(`${env}=${name}:latest`);
  return v;
}
const random = (prefix) => () => `${prefix}${crypto.randomBytes(24).toString('base64url')}`;
const ownerKey = await secret('STUDIO_OWNER_KEY', 'studio-owner-key', random('hs_'));
await secret('STUDIO_AGENT_KEY', 'studio-agent-key', random('hsa_'));
await secret('STUDIO_MCP_KEY', 'studio-mcp-key', random('hsm_'));

// Studio's Gen keys, made with the lane's Gen owner key on this PC (~/.hawkes/client.json genKey, or genBetaKey for
// gen-beta: Gen's deploy.ps1 -Lane beta saves it).
const cj = path.join(os.homedir(), '.hawkes', 'client.json');
const client = fs.existsSync(cj) ? JSON.parse(fs.readFileSync(cj, 'utf8')) : {};
const genOwner = beta ? client.genBetaKey : client.genKey;
async function genKey(name, role) {
  if (!APPLY) { console.log(`  (dry run) POST ${genUrl}/v1/clients {"name":"${name}","role":"${role}"} with the Gen owner key`); return 'dry-run'; }
  if (!genOwner) die(`No Gen owner key in ${cj} (${beta ? 'genBetaKey: run hawkesgen\\tools\\gen-cloudrun\\deploy.ps1 -Lane beta first' : 'genKey'}): Studio's Gen key can't be made.`);
  const r = await fetch(`${genUrl}/v1/clients`, { method: 'POST', headers: { Authorization: `Bearer ${genOwner}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, role }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.key) die(`Gen refused to make the key "${name}" (${r.status} ${j.error ?? ''}).`);
  console.log(`  made Gen key "${name}" (${role}, ${j.client?.id})`);
  return j.key;
}
const named = (n) => (beta ? `${n} (beta)` : n);
await secret('HAWKESGEN_KEY', 'studio-gen-key', () => genKey(named('Hawkes Studio (Cloud Run)'), 'admin'));
const userGenKey = await secret('TALK_GEN_KEY', 'studio-agents-gen-key', () => genKey(named('Hawkes Studio agents and Talk (Cloud Run)'), 'user'));
if (userGenKey) mounted.push(`AGENT_GEN_KEY=${sec('studio-agents-gen-key')}:latest`);

// The beta sites' R2 keys (src/r2.ts): with all three, publishes write R2's S3 API straight from Studio instead of one
// Worker request per file through sites.hawkesgen.ai. Nothing is made here: J makes an R2 API token (Object Read & Write
// on hawkes-beta-sites) in Cloudflare's dashboard once, then per lane (beta: studio-beta-r2-...):
//   gcloud secrets create studio-r2-account-id --data-file=-   (and studio-r2-access-key-id, studio-r2-secret-access-key)
// Missing ones are skipped and Studio keeps publishing through the Worker.
await secret('STUDIO_R2_ACCOUNT_ID', 'studio-r2-account-id', () => null);
await secret('STUDIO_R2_ACCESS_KEY_ID', 'studio-r2-access-key-id', () => null);
await secret('STUDIO_R2_SECRET_ACCESS_KEY', 'studio-r2-secret-access-key', () => null);

// The GitHub token: git's stored credential for github.com on this PC (the stored-token form J's pushes use).
await secret('GITHUB_TOKEN', 'studio-github-token', () => {
  const r = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return /^password=(.+)$/m.exec(r.stdout ?? '')?.[1]?.trim() ?? null;
});
// Resend (invites by email), when this PC has its key in the environment; otherwise invites show their link.
await secret('RESEND_API_KEY', 'studio-resend-api-key', () => process.env.RESEND_API_KEY?.trim() || null);

// Continue with Google: the portal's OAuth client (project "Hawkes Gen"); its id is public.
let googleClient = flag('google-client', '');
const portalEnv = path.join(ROOT, '..', 'hawkesgenwebsite', 'cloud', 'functions', '.env.hawkes-prod');
if (!googleClient && fs.existsSync(portalEnv)) googleClient = /^GOOGLE_CLIENT_ID=(.+)$/m.exec(fs.readFileSync(portalEnv, 'utf8'))?.[1]?.trim() ?? '';
if (!googleClient) console.log('  No Google client id (--google-client, or the portal\'s .env.hawkes-prod): Continue with Google stays off; the owner key works.');

console.log('\n# The service');
const envVars = [
  `STUDIO_LANE=${lane}`, `STUDIO_STATE_BUCKET=${bucket}`, `STUDIO_GCP_PROJECT=${project}`, `STUDIO_GCP_REGION=${region}`, `STUDIO_AGENT_JOB=${jobName}`,
  `HAWKESGEN_URL=${genDirect}`, `GEN_PUBLIC_URL=${genUrl}`, `STUDIO_PUBLIC_URL=${publicUrl}`,
  `STUDIO_GOOGLE_EMAILS=${emails}`, `STUDIO_SCHEDULER_SA=${schedSa}`,
  ...(googleClient ? [`STUDIO_GOOGLE_CLIENT_ID=${googleClient}`] : []),
];
// "^|^" separates the list: the emails may hold commas (and every value holds an @).
// Instances: at most one per revision (--max-instances, the revision template) and no service-wide cap (--max=default
// clears one set by hand): during a rollout the old revision's instance and the new one's run side by side for a moment,
// and src/cloudlease.ts hands the database from one to the other. A service-wide max of 1 would leave the new revision
// no instance until the old one drained. Scale to zero stays (min 0).
// Startup: the entrypoint claims the lease (up to ~30 s waiting for the old instance to hand over), restores studio.db
// (at most an hour of WAL since litestream.yml's hourly snapshots), pulls the state files, then server.ts listens.
// Cloud Run's default TCP probe allows 4 minutes in one attempt; this one checks the port every 10 s for up to 10 minutes.
gcloud(['run', 'deploy', service, `--image=${image}`, `--region=${region}`, P,
  `--service-account=${sa}`, '--allow-unauthenticated',
  '--min-instances=0', '--max-instances=1', '--max=default', `--startup-probe=${STARTUP_PROBE}`,
  '--no-cpu-throttling', '--cpu=2', '--memory=4Gi',
  '--concurrency=80', '--timeout=3600', '--execution-environment=gen2',
  `--set-env-vars=^|^${envVars.join('|')}`, `--set-secrets=${mounted.join(',')}`, '--format=none']);

console.log('\n# The agents\' job');
// No secrets: each pass gets what it needs in its own spec (cloudjob.ts), which the runner deletes once read.
gcloud(['run', 'jobs', 'deploy', jobName, `--image=${image}`, `--region=${region}`, P,
  `--service-account=${agentSa}`, '--cpu=2', '--memory=4Gi', '--tasks=1', '--max-retries=0', '--task-timeout=4h',
  '--execution-environment=gen2', `--set-env-vars=STUDIO_STATE_BUCKET=${bucket}`, '--format=none']);
if (!APPLY) { done(); process.exit(0); }

const url = gcloudQuery(['run', 'services', 'describe', service, `--region=${region}`, P, '--format=value(status.url)']);
if (!url) die('The service has no URL yet: run this again in a minute.');
console.log(`\nService URL: ${url}`);
gcloud(['run', 'services', 'update', service, `--region=${region}`, P, `--update-env-vars=STUDIO_SERVICE_URL=${url}`, '--format=none']);

console.log(beta ? '\n# The daily run: none on beta (it never spends by itself)' : '\n# The daily run (05:00 Los Angeles)');
const sched =['--location', region, '--schedule=0 5 * * *', '--time-zone=America/Los_Angeles', `--uri=${url}/api/cloud/daily`, '--http-method=POST',
  `--oidc-service-account-email=${schedSa}`, `--oidc-token-audience=${url}`, '--attempt-deadline=60s', P, '--format=none'];
if (!beta) {
  const exists = gcloudQuery(['scheduler', 'jobs', 'describe', 'studio-daily', '--location', region, P, '--format=value(name)']);
  gcloud(['scheduler', 'jobs', exists ? 'update' : 'create', 'http', 'studio-daily', ...sched]);
}

console.log('\n# Waiting for it to answer');
let ok = false;
for (let i = 0; i < 30 && !ok; i++) {
  ok = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(20_000) }).then((r) => r.ok).catch(() => false);
  if (!ok) await new Promise((r) => setTimeout(r, 5000));
}
if (!ok) die(`${url}/api/health doesn't answer yet: look at the logs (gcloud run services logs read ${service} --region ${region} ${P})`);
const who = await fetch(`${url}/api/me`, { headers: { Authorization: `Bearer ${ownerKey}` } }).then((r) => r.status);
if (who !== 200) die(`The owner key was refused (${who}).`);
console.log('  health ok, owner key accepted');

// This PC's CLI and MCP server (src/client.ts) use ~/.hawkes/client.json: point Studio's part at the new address.
if (beta && fs.existsSync(cj)) {
  // Beta never replaces live in this PC's clients: kept beside it.
  fs.writeFileSync(cj, JSON.stringify({ ...client, studioBetaUrl: url, studioBetaKey: ownerKey }, null, 2));
  console.log(`  ${cj}: studioBetaUrl and studioBetaKey saved (live's studioUrl unchanged)`);
} else if (fs.existsSync(cj)) {
  const backup = path.join(path.dirname(cj), 'client.studio-aws.json');
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify(client, null, 2));
  fs.writeFileSync(cj, JSON.stringify({ ...client, studioUrl: url, studioKey: ownerKey }, null, 2));
  console.log(`  ${cj} now points at ${url} (the old one: ${backup}); once studio.hawkesgen.ai is the Worker, studioUrl can be that.`);
}
done();
