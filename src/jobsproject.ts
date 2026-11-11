// Where Studio's agent jobs run: apart from Studio's server, in another region (and, if named, another project).
//
// 2026-11-10/11: agent jobs and Unity builds shared hawkes-staging's us-east4 Cloud Run CPU quota with Studio's own
// server; they took all of it, Studio's new revision never got an instance, and studio.hawkesgen.ai went down. Cloud
// Run's CPU quota is per project and region, so jobs elsewhere can never take the server's CPU again. A project of their
// own was the first plan; Google refused its billing link (the billing account's project limit), so by default the jobs
// go to another region of the same project (jobsRegion), which needs nothing from the owner.
//
// STUDIO_JOBS_REGION / STUDIO_JOBS_PROJECT (or the STUDIO_CELLS_ ones on the control service, handed to every cell on
// its next roll: cellrun.ts setImage) name the place. The jobs are copied there by Studio the first time it needs them
// (copyJob: the same image, account, env and secrets, the secrets by their full path), and a start whose job can't be
// made or run there runs beside the server as before, so work never stops on the move.

export const serverProject = (env: NodeJS.ProcessEnv = process.env) => env.STUDIO_GCP_PROJECT || '';
export const jobsProject = (env: NodeJS.ProcessEnv = process.env) => env.STUDIO_JOBS_PROJECT || env.STUDIO_CELLS_JOBS_PROJECT || serverProject(env);
export const serverRegion = (env: NodeJS.ProcessEnv = process.env) => env.STUDIO_GCP_REGION || env.STUDIO_CELLS_REGION || 'us-east4';
/**
 * The jobs' region. Plan B (2026-11-11): Google refused a new project's billing link (the billing account's project
 * limit), and J said "Just yes fix it". Cloud Run's CPU quota is per project and per region too, so jobs in another
 * region of the same project can't take the server's CPU either, and need no new project, billing or grants.
 * STUDIO_JOBS_REGION names it ("same": beside the server); by default a region where no server of Studio or Gen runs
 * (us-west1; us-east4 for a server that is itself in us-west1). It must be a region the project already uses: Google
 * caps how many regions a project's Cloud Run may use, and on 2026-11-11 us-east1 would have been a fourth and was
 * refused (MaxRegionsPerProject). us-west1 holds only Unity build jobs, which run once a milestone is complete.
 */
export const AWAY_REGION = 'us-west1';
export function jobsRegion(env: NodeJS.ProcessEnv = process.env) {
  const named = env.STUDIO_JOBS_REGION || env.STUDIO_CELLS_JOBS_REGION || '';
  const server = serverRegion(env);
  if (named === 'same') return server;
  if (named) return named;
  return server === AWAY_REGION ? 'us-east4' : AWAY_REGION;
}
export type Place = { project: string; region: string };
export const serverPlace = (env: NodeJS.ProcessEnv = process.env): Place => ({ project: serverProject(env), region: serverRegion(env) });
export const jobsPlace = (env: NodeJS.ProcessEnv = process.env): Place => ({ project: jobsProject(env), region: jobsRegion(env) });
const samePlace = (a: Place, b: Place) => a.project === b.project && a.region === b.region;
/** The jobs run apart from the server (another project or region): they can't take its CPU. */
export const jobsApart = (env: NodeJS.ProcessEnv = process.env) => Boolean(serverProject(env) && !samePlace(jobsPlace(env), serverPlace(env)));

export const JOB_OUTPUT_ONLY = new Set(['name', 'uid', 'generation', 'createTime', 'updateTime', 'deleteTime', 'expireTime', 'creator', 'lastModifier', 'observedGeneration', 'terminalCondition', 'conditions', 'executionCount', 'latestCreatedExecution', 'reconciling', 'satisfiesPzs', 'etag']);

const fullSecret = (s: string, from: string) => (!s || s.startsWith('projects/') ? s : `projects/${from}/secrets/${s}`);

/**
 * A job as it is in `from`, ready to be made in another project (pure: tested). Output-only fields go; a secret named
 * the short way (same project) gets its full path in `from`, since Cloud Run reads the short name in the job's own
 * project. Image, account, env, limits and timeout stay as they are.
 */
export function jobCopy(j: any, from: string) {
  const out: any = Object.fromEntries(Object.entries(j ?? {}).filter(([k]) => !JOB_OUTPUT_ONLY.has(k)));
  const t = j?.template?.template ?? {};
  const containers = (t.containers ?? []).map((c: any) => ({
    ...c,
    env: (c.env ?? []).map((v: any) => (v?.valueSource?.secretKeyRef?.secret
      ? { ...v, valueSource: { ...v.valueSource, secretKeyRef: { ...v.valueSource.secretKeyRef, secret: fullSecret(v.valueSource.secretKeyRef.secret, from) } } }
      : v)),
  }));
  const volumes = (t.volumes ?? []).map((v: any) => (v?.secret?.secret ? { ...v, secret: { ...v.secret, secret: fullSecret(v.secret.secret, from) } } : v));
  out.template = { ...(j?.template ?? {}), template: { ...t, containers, ...(t.volumes ? { volumes } : {}) } };
  return out;
}

export const jobsHooks: { gapi?: (url: string, o?: any) => Promise<any> } = {};
const api = async () => jobsHooks.gapi ?? (await import('./gcp.ts')).gapi;
const runBase = (project: string, region: string) => `https://run.googleapis.com/v2/projects/${project}/locations/${region}`;

/**
 * Makes `job` in `to` as it is in `from` (jobCopy), with the same people allowed to run it (its IAM policy: the cells'
 * own accounts). Nothing when it is already there. `fromNumber` (the server project's number) names the secrets when
 * known; the project id does too.
 */
export async function copyJob(t: { from: Place; to: Place; job: string; fromNumber?: string }): Promise<'made' | 'there'> {
  const gapi = await api();
  const there = await gapi(`${runBase(t.to.project, t.to.region)}/jobs/${t.job}`, { missingOk: true });
  if (there) return 'there';
  const src = await gapi(`${runBase(t.from.project, t.from.region)}/jobs/${t.job}`);
  try {
    await gapi(`${runBase(t.to.project, t.to.region)}/jobs?jobId=${encodeURIComponent(t.job)}`, { body: jobCopy(src, t.fromNumber || t.from.project) });
  } catch (e: any) {
    if (!/answered 409/.test(String(e?.message))) throw e;
    return 'there';
  }
  const policy = await gapi(`${runBase(t.from.project, t.from.region)}/jobs/${t.job}:getIamPolicy`).catch(() => null);
  if (policy?.bindings?.length) {
    // A job made moments ago can take a few seconds to take a policy; the grants are copied again on the next roll.
    await gapi(`${runBase(t.to.project, t.to.region)}/jobs/${t.job}:setIamPolicy`, { body: { policy: { bindings: policy.bindings } } })
      .catch((e: any) => console.warn(`[jobs] ${t.job}: grants not copied to ${t.to.project}/${t.to.region} yet: ${e?.message ?? e}`));
  }
  console.log(`[jobs] made ${t.job} in ${t.to.project}/${t.to.region} (copied from ${t.from.project}/${t.from.region})`);
  return 'made';
}

const missing = (e: any) => /answered (404|403)|NOT_FOUND|PERMISSION_DENIED|not found/i.test(String(e?.message ?? e));
let warned = '';

/**
 * Runs `start` where the jobs go (jobsPlace); when the job isn't there, makes it (copyJob) and runs it there; when it
 * can't be made or run there (no access, a network that region hasn't), runs it beside the server as before and says
 * so once.
 */
export async function startInJobsPlace<T>(job: string, start: (p: Place) => Promise<T>): Promise<T> {
  const server = serverPlace();
  if (!jobsApart()) return start(server);
  const to = jobsPlace();
  try {
    return await start(to);
  } catch (e: any) {
    if (!missing(e)) throw e;
  }
  try {
    await copyJob({ from: server, to, job, fromNumber: process.env.STUDIO_CELLS_PROJECT_NUMBER || process.env.STUDIO_GCP_PROJECT_NUMBER });
    return await start(to);
  } catch (e: any) {
    const why = `${job}@${to.project}/${to.region}`;
    if (warned !== why) { warned = why; console.warn(`[jobs] ${job} can't run in ${to.project}/${to.region} yet (${String(e?.message ?? e).slice(0, 300)}); running it in ${server.project}/${server.region}`); }
    return start(server);
  }
}

/** Tests. */
export function resetJobsProject() { warned = ''; delete jobsHooks.gapi; }
