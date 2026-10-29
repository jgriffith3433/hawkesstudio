#!/usr/bin/env node
// Deploys Hawkes Studio on Cloud Run (docs/studio-cloudrun.md): the service `studio`, the job `studio-agent` (agents',
// scouts' and Talk's Claude Code, one execution per pass) and the daily run's Cloud Scheduler job. Prints every step;
// changes things only with --apply. J runs it through deploy.ps1 (IAM and secret writes are his). Every step is safe to
// run again.
//
//   node tools/studio-cloudrun/deploy.mjs [--project hawkes-staging] [--region us-east4] [--gen https://gen.hawkesgen.ai] [--apply]
//
// 1. APIs; the state bucket (studio.db through Litestream, state files, the jobs' folders, cleared after 7 days).
// 2. Three accounts: studio-control@ (the service: the bucket, starting and following the job), studio-agent@ (the job:
//    only the bucket's jobs/ folder) and studio-scheduler@ (the daily run's caller: nothing but its identity).
// 3. Secrets (values never printed): Studio's owner key, the agents' key and the MCP key (new random ones, made once),
//    Studio's own Gen keys (made with the Gen owner key in ~/.hawkes/client.json: an admin key for Studio, a user key
//    for agents and Talk), the GitHub token (git's stored credential for github.com on this PC), Resend's key if set.
// 4. The service: the image build.mjs made, one instance at most, none while idle, CPU while an instance lives.
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
const service = flag('service', 'studio');
const jobName = flag('job', 'studio-agent');
const genUrl = flag('gen', 'https://gen.hawkesgen.ai').replace(/\/+$/, '');
const publicUrl = flag('public-url', 'https://studio.hawkesgen.ai').replace(/\/+$/, '');
const emails = flag('google-emails', 'piercehawkes3@gmail.com');
const P = `--project=${project}`;
const sa = `studio-control@${project}.iam.gserviceaccount.com`;
const agentSa = `studio-agent@${project}.iam.gserviceaccount.com`;
const schedSa = `studio-scheduler@${project}.iam.gserviceaccount.com`;
const bucket = flag('state-bucket', `${project}-studio-state`);

const imageFile = path.join(ROOT, '.data', 'cloudrun', 'studio-image.json');
const image = flag('image', fs.existsSync(imageFile) ? JSON.parse(fs.readFileSync(imageFile, 'utf8')).tag : null);
if (!image) die('No image yet: node tools/studio-cloudrun/build.mjs --apply');
console.log(`Studio on Cloud Run: ${service} + job ${jobName} in ${project} / ${region}\nImage ${image}\nGen ${genUrl}\n`);

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
gcloud(['storage', 'buckets', 'add-iam-policy-binding', `gs://${bucket}`, P, `--member=serviceAccount:${sa}`, '--role=roles/storage.objectAdmin', '--format=none'], { retries: 9 });
// The job reads and writes only jobs/ (never state/: Claude accounts, settings); listing needs the bucket reader role.
gcloud(['storage', 'buckets', 'add-iam-policy-binding', `gs://${bucket}`, P, `--member=serviceAccount:${agentSa}`, '--role=roles/storage.objectAdmin',
  `--condition=expression=resource.name.startsWith("projects/_/buckets/${bucket}/objects/jobs/"),title=jobs-only`, '--format=none'], { retries: 9 });
gcloud(['storage', 'buckets', 'add-iam-policy-binding', `gs://${bucket}`, P, `--member=serviceAccount:${agentSa}`, '--role=roles/storage.legacyBucketReader', '--format=none'], { retries: 9 });
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
async function secret(env, name, make) {
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

// Studio's Gen keys, made with the Gen owner key on this PC (~/.hawkes/client.json genKey).
const cj = path.join(os.homedir(), '.hawkes', 'client.json');
const client = fs.existsSync(cj) ? JSON.parse(fs.readFileSync(cj, 'utf8')) : {};
async function genKey(name, role) {
  if (!APPLY) { console.log(`  (dry run) POST ${genUrl}/v1/clients {"name":"${name}","role":"${role}"} with the Gen owner key`); return 'dry-run'; }
  if (!client.genKey) die(`No Gen owner key in ${cj} (genKey): Studio's Gen key can't be made.`);
  const r = await fetch(`${genUrl}/v1/clients`, { method: 'POST', headers: { Authorization: `Bearer ${client.genKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, role }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.key) die(`Gen refused to make the key "${name}" (${r.status} ${j.error ?? ''}).`);
  console.log(`  made Gen key "${name}" (${role}, ${j.client?.id})`);
  return j.key;
}
await secret('HAWKESGEN_KEY', 'studio-gen-key', () => genKey('Hawkes Studio (Cloud Run)', 'admin'));
const userGenKey = await secret('TALK_GEN_KEY', 'studio-agents-gen-key', () => genKey('Hawkes Studio agents and Talk (Cloud Run)', 'user'));
if (userGenKey) mounted.push('AGENT_GEN_KEY=studio-agents-gen-key:latest');

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
  `STUDIO_STATE_BUCKET=${bucket}`, `STUDIO_GCP_PROJECT=${project}`, `STUDIO_GCP_REGION=${region}`, `STUDIO_AGENT_JOB=${jobName}`,
  `HAWKESGEN_URL=${genUrl}`, `GEN_PUBLIC_URL=${genUrl}`, `STUDIO_PUBLIC_URL=${publicUrl}`,
  `STUDIO_GOOGLE_EMAILS=${emails}`, `STUDIO_SCHEDULER_SA=${schedSa}`,
  ...(googleClient ? [`STUDIO_GOOGLE_CLIENT_ID=${googleClient}`] : []),
];
// "^|^" separates the list: the emails may hold commas (and every value holds an @).
gcloud(['run', 'deploy', service, `--image=${image}`, `--region=${region}`, P,
  `--service-account=${sa}`, '--allow-unauthenticated',
  '--min-instances=0', '--max-instances=1', '--no-cpu-throttling', '--cpu=2', '--memory=4Gi',
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

console.log('\n# The daily run (05:00 Los Angeles)');
const sched = ['--location', region, '--schedule=0 5 * * *', '--time-zone=America/Los_Angeles', `--uri=${url}/api/cloud/daily`, '--http-method=POST',
  `--oidc-service-account-email=${schedSa}`, `--oidc-token-audience=${url}`, '--attempt-deadline=60s', P, '--format=none'];
const exists = gcloudQuery(['scheduler', 'jobs', 'describe', 'studio-daily', '--location', region, P, '--format=value(name)']);
gcloud(['scheduler', 'jobs', exists ? 'update' : 'create', 'http', 'studio-daily', ...sched]);

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
if (fs.existsSync(cj)) {
  const backup = path.join(path.dirname(cj), 'client.studio-aws.json');
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify(client, null, 2));
  fs.writeFileSync(cj, JSON.stringify({ ...client, studioUrl: url, studioKey: ownerKey }, null, 2));
  console.log(`  ${cj} now points at ${url} (the old one: ${backup}); once studio.hawkesgen.ai is the Worker, studioUrl can be that.`);
}
done();
