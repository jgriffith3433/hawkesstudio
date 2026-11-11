// Where Studio's agent jobs run: their own Google project, apart from Studio's server.
//
// 2026-11-10/11: agent jobs and Unity builds shared hawkes-staging's us-east4 Cloud Run CPU quota with Studio's own
// server; they took all of it, Studio's new revision never got an instance, and studio.hawkesgen.ai went down. J said
// yes to moving the jobs into a project of their own (through the coordinator, 00:33Z: "Yes, set it up"). Quotas are per
// project, so jobs there can never take the server's CPU again.
//
// STUDIO_JOBS_PROJECT (or STUDIO_CELLS_JOBS_PROJECT on the control service, which hands it to every cell on its next
// roll: cellrun.ts setImage) names that project. Unset, or the same as STUDIO_GCP_PROJECT: everything stays where it
// was. The jobs themselves are copied there by Studio the first time it needs them (copyJob: the same image, account,
// env and secrets, the secrets named by their full path in the server's project), and a start whose job can't be found
// or made there runs in the server's project as before, so work never stops on the move.

export const serverProject = (env: NodeJS.ProcessEnv = process.env) => env.STUDIO_GCP_PROJECT || '';
export const jobsProject = (env: NodeJS.ProcessEnv = process.env) => env.STUDIO_JOBS_PROJECT || env.STUDIO_CELLS_JOBS_PROJECT || serverProject(env);
/** The jobs run in a project of their own (they can't take the server's CPU). */
export const jobsApart = (env: NodeJS.ProcessEnv = process.env) => Boolean(jobsProject(env) && jobsProject(env) !== serverProject(env));

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
export async function copyJob(t: { from: string; to: string; region: string; job: string; fromNumber?: string }): Promise<'made' | 'there'> {
  const gapi = await api();
  const there = await gapi(`${runBase(t.to, t.region)}/jobs/${t.job}`, { missingOk: true });
  if (there) return 'there';
  const src = await gapi(`${runBase(t.from, t.region)}/jobs/${t.job}`);
  try {
    await gapi(`${runBase(t.to, t.region)}/jobs?jobId=${encodeURIComponent(t.job)}`, { body: jobCopy(src, t.fromNumber || t.from) });
  } catch (e: any) {
    if (!/answered 409/.test(String(e?.message))) throw e;
    return 'there';
  }
  const policy = await gapi(`${runBase(t.from, t.region)}/jobs/${t.job}:getIamPolicy`).catch(() => null);
  if (policy?.bindings?.length) {
    // A job made moments ago can take a few seconds to take a policy; the grants are copied again on the next roll.
    await gapi(`${runBase(t.to, t.region)}/jobs/${t.job}:setIamPolicy`, { body: { policy: { bindings: policy.bindings } } })
      .catch((e: any) => console.warn(`[jobs] ${t.job}: grants not copied to ${t.to} yet: ${e?.message ?? e}`));
  }
  console.log(`[jobs] made ${t.job} in ${t.to} (copied from ${t.from})`);
  return 'made';
}

// Not there, or not ours to run yet (the grants follow the job: copyJob, the next roll): both fall back.
const missing = (e: any) => /answered (404|403)|NOT_FOUND|PERMISSION_DENIED|not found/i.test(String(e?.message ?? e));
let warned = '';

/**
 * Runs `start` in the jobs project; when the job isn't there, makes it (copyJob) and runs it there; when it can't be
 * made there (no access yet), runs it in the server's project as before and says so once.
 */
export async function startInJobsProject<T>(t: { region: string; job: string }, start: (project: string) => Promise<T>): Promise<T> {
  const server = serverProject();
  if (!jobsApart()) return start(server);
  const to = jobsProject();
  try {
    return await start(to);
  } catch (e: any) {
    if (!missing(e)) throw e;
  }
  try {
    await copyJob({ from: server, to, region: t.region, job: t.job, fromNumber: process.env.STUDIO_CELLS_PROJECT_NUMBER || process.env.STUDIO_GCP_PROJECT_NUMBER });
    return await start(to);
  } catch (e: any) {
    const why = `${t.job}@${to}`;
    if (warned !== why) { warned = why; console.warn(`[jobs] ${t.job} can't run in ${to} yet (${String(e?.message ?? e).slice(0, 300)}); running it in ${server}`); }
    return start(server);
  }
}

/** Tests. */
export function resetJobsProject() { warned = ''; delete jobsHooks.gapi; }
