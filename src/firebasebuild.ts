// Firebase builds in Studio's own cloud (J, 2026-11-09: Hawkes Games must stop depending on GitHub Actions). A build with
// tool "firebase" runs `firebase deploy` in Studio's Cloud Run build job, the same job npm builds use (builds.ts
// viaStudio), instead of starting the repo's .github/workflows/firebase.yml. It does what that workflow did:
//
//   1. the functions' check: `npm ci` and, where there is a tsconfig.json, `npx tsc -p .` in each functions source
//      (firebase.json "functions"), before anything is signed in;
//   2. `firebase deploy --only <what firebase.json has> --project <p> --non-interactive --force`, where p is the
//      staging project for beta and the prod project for main (.firebaserc's "staging" and "prod" aliases);
//   3. the health check on the deployed site (the project's versionPath, e.g. /v1/health);
//   4. the small build record (studio-build/build.json, index.html) that Studio publishes as the build's version.
//
// Signing in is keyless. Studio itself (never the job) asks Google's IAM Credentials API for a one-hour access token of
// the Firebase project's deployer service account (deployer@<project>.iam.gserviceaccount.com), which needs Studio's own
// service account to hold roles/iam.serviceAccountTokenCreator on that deployer. When it doesn't, Studio tries to add the
// binding itself (it works where Studio may manage that account), and otherwise the build fails saying exactly which role
// on which account, for whom. The token goes to that one execution only, and the job hands it to firebase-tools through
// a metadata server stand-in on 127.0.0.1 (Google's client libraries read GCE_METADATA_HOST), so there is no key file,
// no token in the repo, the log or the command line; the shell forgets it before the repo's own code runs, and whatever
// the build prints is scrubbed of it.
//
// A build that used to be "actions" with workflow firebase.yml is read as a firebase build (asFirebase), so a project
// set up before this needs no change, and firebase.yml stays in its repo, untouched and never started by Studio. Such a
// project uses no GitHub Actions any more, so it never gets the Actions permission preflight or card, and a card filed
// before is closed (retireActionsCards).

import type { BuildSpec, FirebaseConf, Product } from './config.ts';

/** The workflows that are a Firebase deploy (the portal's firebase.yml). */
export const FIREBASE_WORKFLOW = /^firebase\.ya?ml$/i;
/** firebase-tools' major version, the one firebase.yml ran. */
export const FIREBASE_TOOLS = 'firebase-tools@15';
/** Where the metadata stand-in listens inside the job. */
export const SHIM_PORT = 8723;
/** How long the deployer's token lives (IAM Credentials' default maximum). */
export const TOKEN_SECONDS = 3600;
export const TOKEN_CREATOR = 'roles/iam.serviceAccountTokenCreator';

// ------------------------------------------------------------------ what a build is

/**
 * A build as Studio runs it: an Actions build of a Firebase workflow is a firebase build now (it runs on beta pushes,
 * like the workflow did; going live deploys main). Anything else stays as it is.
 */
export function asFirebase(b: BuildSpec): BuildSpec {
  if (b.tool !== 'actions' || !b.workflow || !FIREBASE_WORKFLOW.test(b.workflow)) return b;
  const { workflow: _w, artifact: _a, on, ...rest } = b;
  return { ...rest, tool: 'firebase', on: on?.length ? on : ['beta'] };
}

/** Whether a project still has a build that runs in its own GitHub Actions (only those need Actions: write). */
export function usesActions(builds: BuildSpec[]): boolean {
  return builds.some((b) => b.tool === 'actions');
}

/** A project's Firebase build, if it has one. */
export function firebaseBuildOf(builds: BuildSpec[]): BuildSpec | null {
  return builds.find((b) => b.tool === 'firebase') ?? null;
}

// ------------------------------------------------------------------ what it deploys

type FirebaseJson = { hosting?: unknown; functions?: unknown; firestore?: unknown; storage?: unknown; database?: unknown; remoteconfig?: unknown };

/** The functions sources (folders) and their codebases, from firebase.json. */
export function functionsOf(json: FirebaseJson): { source: string; codebase: string | null }[] {
  const f = json.functions;
  const list = Array.isArray(f) ? f : f && typeof f === 'object' ? [f] : [];
  return list
    .map((x: any) => ({ source: String(x?.source ?? 'functions').replace(/\\/g, '/').replace(/^\.\/+|\/+$/g, ''), codebase: x?.codebase ? String(x.codebase) : null }))
    .filter((x) => /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[\w .@+/-]{1,200}$/.test(x.source));
}

/** What `firebase deploy --only` takes for everything firebase.json sets up (the portal: hosting,functions:portal,firestore). */
export function deployOnly(json: FirebaseJson): string {
  const parts: string[] = [];
  if (json.hosting) parts.push('hosting');
  const fns = functionsOf(json);
  if (fns.length) parts.push(...(fns.every((x) => x.codebase) ? fns.map((x) => `functions:${x.codebase}`) : ['functions']));
  for (const k of ['firestore', 'storage', 'database', 'remoteconfig'] as const) if (json[k]) parts.push(k);
  return parts.join(',');
}

/**
 * The Firebase project a ref deploys to: main → live (conf.live, else .firebaserc's prod/live/production alias); any
 * other ref → beta (conf.beta, else staging/beta, else default). Null when neither says.
 */
export function projectFor(ref: string, conf: FirebaseConf | undefined, rc: { projects?: Record<string, string> } | null): string | null {
  const a = rc?.projects ?? {};
  const pick = (...names: string[]) => names.map((n) => a[n]).find((v) => typeof v === 'string' && v) ?? null;
  return ref === 'main' ? conf?.live ?? pick('prod', 'live', 'production') : conf?.beta ?? pick('staging', 'beta', 'default');
}

/** The service account a deploy to `project` acts as. */
export function deployerOf(project: string, conf?: FirebaseConf): string {
  return (conf?.serviceAccount ?? 'deployer@{project}.iam.gserviceaccount.com').replace('{project}', project);
}

// ------------------------------------------------------------------ signing in (keyless)

/** The exact grant Studio needs, in words a person can act on (and the gcloud line that does it). */
export function grantNeeded(deployer: string, me: string | null): string {
  const project = deployer.split('@')[1]?.replace(/\.iam\.gserviceaccount\.com$/, '') ?? '';
  const who = me ?? "Studio's service account";
  return `Studio can't sign in to Firebase as ${deployer}: ${who} needs the role ${TOKEN_CREATOR} on the service account ${deployer} (project ${project}). ` +
    `Grant it once: gcloud iam service-accounts add-iam-policy-binding ${deployer} --project ${project} --member=serviceAccount:${me ?? '<studio-service-account>'} --role=${TOKEN_CREATOR}`;
}

/** Replaced by the tests: Google's APIs and Studio's own identity. */
export const google = {
  call: async (url: string, init: { method?: string; body?: unknown } = {}) => (await import('./gcp.ts')).gapi(url, { ...init, timeoutMs: 30_000 }),
  me: async (): Promise<string | null> => (await (await import('./gcp.ts')).signer())?.email ?? null,
  wait: (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()),
};

const denied = (e: any) => e?.status === 403 || /\b403\b|PERMISSION_DENIED|permission .*denied/i.test(String(e?.message ?? e));

/** Adds Studio's account as a token creator on the deployer (Studio's own ops path). True when the binding is there now. */
export async function grantTokenCreator(deployer: string, me: string): Promise<boolean> {
  const project = deployer.split('@')[1]?.replace(/\.iam\.gserviceaccount\.com$/, '') ?? '-';
  const base = `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts/${encodeURIComponent(deployer)}`;
  try {
    const policy = (await google.call(`${base}:getIamPolicy`, { method: 'POST', body: {} })) ?? {};
    const member = `serviceAccount:${me}`;
    const bindings: { role: string; members: string[] }[] = Array.isArray(policy.bindings) ? policy.bindings : [];
    const has = bindings.find((b) => b.role === TOKEN_CREATOR);
    if (has?.members?.includes(member)) return true;
    if (has) has.members = [...(has.members ?? []), member];
    else bindings.push({ role: TOKEN_CREATOR, members: [member] });
    await google.call(`${base}:setIamPolicy`, { method: 'POST', body: { policy: { ...policy, bindings } } });
    console.log(`[builds] granted ${me} ${TOKEN_CREATOR} on ${deployer}`);
    return true;
  } catch (e: any) {
    console.warn(`[builds] couldn't grant ${TOKEN_CREATOR} on ${deployer}: ${String(e?.message ?? e).slice(0, 200)}`);
    return false;
  }
}

/**
 * A one-hour access token of the deployer, minted by Studio with its own identity. A refusal makes Studio grant itself the
 * role once (where it may) and try again after IAM has had a moment; otherwise it throws grantNeeded's words. The token is
 * returned, never printed.
 */
export async function deployerToken(deployer: string): Promise<{ token: string; expires: number }> {
  const mint = async () => {
    const j = await google.call(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(deployer)}:generateAccessToken`, {
      method: 'POST', body: { scope: ['https://www.googleapis.com/auth/cloud-platform'], lifetime: `${TOKEN_SECONDS}s` },
    });
    const token = String(j?.accessToken ?? '');
    if (!token) throw new Error(`Google gave no token for ${deployer}`);
    const expires = Date.parse(String(j?.expireTime ?? '')) || Date.now() + TOKEN_SECONDS * 1000;
    return { token, expires };
  };
  try {
    return await mint();
  } catch (e: any) {
    if (!denied(e)) throw new Error(`Google's IAM Credentials API didn't answer for ${deployer}: ${String(e?.message ?? e).slice(0, 200)}`);
    const me = await google.me().catch(() => null);
    if (me && (await grantTokenCreator(deployer, me))) {
      // A new IAM binding takes up to a minute or two to apply: two more tries, a minute apart (a backoff, not a poll).
      for (const ms of [60_000, 60_000]) {
        await google.wait(ms);
        try { return await mint(); } catch (again: any) { if (!denied(again)) throw again; }
      }
    }
    throw new Error(grantNeeded(deployer, me));
  }
}

/** Takes a secret out of anything that will be shown or kept (a build log, an error). */
export function scrub(text: string, ...secrets: (string | null | undefined)[]): string {
  let out = String(text ?? '');
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join('[redacted]');
  return out;
}

// ------------------------------------------------------------------ the job's script

/**
 * The metadata server stand-in (run with `node -e`): answers Google's client libraries' token, email and project
 * questions with the deployer's, from the environment it started with. It prints nothing but "ready".
 */
export const METADATA_SHIM = `const http=require("http"),fs=require("fs");
const tok=process.env.HAWKES_DEPLOY_TOKEN||"",who=process.env.HAWKES_DEPLOY_AS||"",proj=process.env.HAWKES_DEPLOY_PROJECT||"",exp=Number(process.env.HAWKES_DEPLOY_EXPIRES)||0;
http.createServer((q,s)=>{const u=String(q.url||"").split("?")[0].replace(/\\/+$/,"");
const send=(c,b,t)=>{s.writeHead(c,{"Metadata-Flavor":"Google","Content-Type":t||"text/plain"});s.end(b);};
if(u.endsWith("/instance/service-accounts/default/token"))return send(200,JSON.stringify({access_token:tok,expires_in:Math.max(60,Math.floor((exp-Date.now())/1000)),token_type:"Bearer"}),"application/json");
if(u.endsWith("/instance/service-accounts/default/email"))return send(200,who);
if(u.endsWith("/project/project-id"))return send(200,proj);
if(u===""||u==="/computeMetadata/v1"||u==="/computeMetadata/v1/instance")return send(200,"");
send(404,"");}).listen(Number(process.env.HAWKES_DEPLOY_PORT)||${SHIM_PORT},"127.0.0.1",()=>fs.writeFileSync(process.env.HAWKES_DEPLOY_READY,"1"));`;

/** The health check and the build record (run with `node -e` after the deploy): exits 1 when the site doesn't answer. */
export const AFTER_DEPLOY = `const fs=require("fs");const R=JSON.parse(process.env.HAWKES_RECORD);
(async()=>{let ok=!R.health;let last="";
for(let i=0;R.health&&i<12&&!ok;i++){if(i)await new Promise((r)=>setTimeout(r,10000));
try{const r=await fetch(R.health,{signal:AbortSignal.timeout(15000)});const t=await r.text();last=r.status+" "+t.slice(0,120);let j=null;try{j=JSON.parse(t);}catch{}ok=r.ok&&!(j&&j.ok===false);}catch(e){last=String(e&&e.message||e);}}
if(!ok){console.error("health check failed at "+R.health+": "+last);process.exit(1);}
if(R.health)console.log("[job] health ok at "+R.health);
fs.mkdirSync("studio-build",{recursive:true});
fs.writeFileSync("studio-build/build.json",JSON.stringify({project:R.project,ref:R.ref,commit:R.commit,url:R.url,by:"studio"})+"\\n");
const e=(s)=>String(s).replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"})[c]);
fs.writeFileSync("studio-build/index.html","<!doctype html><meta charset=\\"utf-8\\"><title>"+e(R.name)+"</title><meta http-equiv=\\"refresh\\" content=\\"0;url="+e(R.url)+"\\"><a href=\\""+e(R.url)+"\\">"+e(R.name)+" ("+e(R.ref)+")</a>\\n");})();`;

const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

export type DeployPlan = { project: string; deployer: string; only: string; sources: string[]; health: string | null; url: string; ref: string; sha: string; name: string };

/**
 * The job's shell script. The token is in the environment only as HAWKES_DEPLOY_TOKEN, which the stand-in takes when it
 * starts and the shell then unsets: the check, `npm ci`, firebase.json's predeploy and firebase-tools never see it.
 */
export function deployScript(d: DeployPlan): string {
  const record = JSON.stringify({ project: d.project, ref: d.ref, commit: d.sha, url: d.url, name: d.name, health: d.health });
  const checks = d.sources.map((s) => `echo "[job] checking ${s.replace(/["$`\\]/g, '')}"; (cd ${q(s)} && npm ci --no-audit --no-fund --loglevel=error && if [ -f tsconfig.json ]; then npx --yes tsc -p .; fi)`);
  return [
    'set -e',
    'export CI=1 npm_config_update_notifier=false',
    ...checks,
    `export HAWKES_DEPLOY_READY="$(mktemp -u)"`,
    `node -e 'eval(Buffer.from("${b64(METADATA_SHIM)}","base64").toString())' &`,
    'SHIM=$!',
    `trap 'kill $SHIM 2>/dev/null || true' EXIT`,
    'unset HAWKES_DEPLOY_TOKEN',
    'for i in $(seq 1 100); do [ -f "$HAWKES_DEPLOY_READY" ] && break; sleep 0.1; done',
    '[ -f "$HAWKES_DEPLOY_READY" ] || { echo "the sign-in stand-in did not start"; exit 1; }',
    `echo "[job] deploying ${d.only} to ${d.project} as ${d.deployer}"`,
    `GCE_METADATA_HOST=127.0.0.1:${SHIM_PORT} METADATA_SERVER_DETECTION=assume-present GOOGLE_CLOUD_PROJECT=${q(d.project)} npx --yes ${FIREBASE_TOOLS} deploy --only ${q(d.only)} --project ${q(d.project)} --non-interactive --force`,
    'kill $SHIM 2>/dev/null || true',
    `HAWKES_RECORD=${q(record)} node -e 'eval(Buffer.from("${b64(AFTER_DEPLOY)}","base64").toString())'`,
  ].join('\n');
}

/** Where a deploy shows (the record's url) and where its health is read. */
export function addressesOf(p: Pick<Product, 'live' | 'versionPath' | 'local'> & { beta?: string }, ref: string, project: string, conf?: FirebaseConf): { url: string; health: string | null } {
  const trim = (u: string) => u.replace(/\/+$/, '');
  const live = ref === 'main';
  const url = trim(live ? p.live || `https://${project}.web.app` : p.beta || p.local?.url || `https://${project}.web.app`);
  // Health on the project's own Firebase address for beta (a custom domain may sit behind something else), like firebase.yml.
  const path = conf?.health ?? p.versionPath ?? null;
  const base = trim(live ? p.live || `https://${project}.web.app` : `https://${project}.web.app`);
  return { url, health: path ? `${base}${path.startsWith('/') ? path : `/${path}`}` : null };
}

// ------------------------------------------------------------------ the Actions card it leaves behind

/**
 * Closes the open "Actions: write" (or install) access cards of projects that no longer build in GitHub Actions (their
 * firebase.yml build is a firebase build now): nothing waits on that permission any more. Called when Studio starts and
 * when such a project builds. Returns the projects whose card closed.
 */
export async function retireActionsCards(o: { product?: string } = {}): Promise<string[]> {
  const A = await import('./buildaccess.ts');
  const { loadProducts } = await import('./config.ts');
  const { buildsOf } = await import('./builds.ts');
  const out: string[] = [];
  for (const card of A.openAccess(o.product)) {
    const p = loadProducts().find((x) => x.id === card.product);
    if (!p) continue;
    // Only a card about GitHub Actions (starting a workflow); one about Contents or the install still matters.
    if (card.key !== 'actions' && !card.workflow) continue;
    if (usesActions(buildsOf(p))) continue;
    await A.resolveAccess(p.id, 'Studio (it builds in Studio now, not GitHub Actions)', { rebuild: false });
    out.push(p.id);
  }
  return out;
}
