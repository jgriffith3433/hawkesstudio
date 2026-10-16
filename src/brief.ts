// The morning brief: after a daily run, a Talk conversation "Morning brief: <date>" where Claude summarizes the
// report in five bullets, and a phone notification linking to it. One Claude call a day (free on J's Max
// subscription token, a few cents on the API otherwise). On Mondays it adds a line with the month's AWS cost.

import crypto from 'node:crypto';
import { db } from './db.ts';
import { buildReport } from './report.ts';
import { startConversation, say, getConversation } from './talk.ts';
import { listChanges } from './agents.ts';
import { gen } from './gen.ts';
import { isServer } from './repos.ts';
import { notify, PUBLIC_URL } from './notify.ts';

/** Fixed monthly AWS costs (docs/cloud.md, "Costs"): control server, disks, Route 53, Secrets Manager, S3. */
const FIXED_MONTHLY = 93;

export const conversationUrl = (id: string) => `${PUBLIC_URL}/?conversation=${id}#talk`;

export async function morningBrief(runId: string, { force = false } = {}) {
  const run = db.prepare('SELECT id, kind, status FROM runs WHERE id = ?').get(runId) as any;
  if (!run || run.kind !== 'daily' || run.status !== 'done') return null;
  // On J's PC a daily run doesn't brief (the cloud does), unless asked to.
  if (!force && !isServer() && process.env.STUDIO_BRIEF !== 'on') return null;
  const R = buildReport(runId);
  const title = `Morning brief: ${R.date}`;
  const ready = listChanges({ status: 'ready' });
  const working = listChanges({ status: 'queued,working,verifying,revising' });
  const weekly = new Date().getDay() === 1 || process.env.STUDIO_BRIEF_COST === 'always';
  const cost = weekly ? await awsCostLine().catch((e: any) => `AWS cost: unavailable (${e.message})`) : null;

  const changes = ready.length
    ? ready.map((c) => `- ${c.id} · ${c.product} · ${c.title}${c.verify?.verdict ? ` · verification: ${c.verify.verdict}` : ''}${c.verify?.preview ? ` · preview ${c.verify.preview}` : ''}`).join('\n')
    : '- none';
  const prompt = `Morning brief for ${R.date} (daily run ${runId}). Headline: ${R.headline}.

Read the report with studio_report (run ${runId}); look at studio_changes if you need more on the changes below.
Agent changes ready for J to approve:
${changes}
Agents still working: ${working.length ? working.map((c) => `${c.product} (${c.title})`).join('; ') : 'none'}.

J reads this on his phone. Reply with exactly five short bullets, under 130 words in all:
1. What broke (the worst problem, with the product).
2. What else broke or got worse, or "nothing else".
3. What got better.
4. What's waiting for J: each ready agent change in a few words with its preview link, or "nothing to approve".
5. One recommendation: the single most useful thing J could do today.
${cost ? `Then add this line exactly as written: ${cost}\n` : ''}No headings, no intro, no sign-off. Don't approve, merge, deploy or start anything.`;

  const c = startConversation(title);
  say(c.id, prompt);
  // Wait for the answer (up to 10 minutes) so the conversation is ready when J taps the notification.
  const end = Date.now() + 10 * 60_000;
  while (Date.now() < end && getConversation(c.id)?.status === 'thinking') await new Promise((r) => setTimeout(r, 5000));
  const answer = getConversation(c.id)?.messages.filter((m) => m.role === 'assistant').at(-1)?.text ?? '';
  const first = /^\s*(?:[-*]|1\.)\s+(.+)$/m.exec(answer)?.[1]?.replace(/\*\*/g, '') ?? '';
  await notify(title, [R.headline, first, ready.length ? `${ready.length} change${ready.length > 1 ? 's' : ''} to approve.` : ''].filter(Boolean).join('\n'), {
    url: conversationUrl(c.id), tags: ['sunrise'], priority: ready.length || R.per.some((x) => x.verdict === 'broken') ? 4 : 3,
  });
  return c.id;
}

// ------------------------------------------------------------- AWS cost

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** One line for the brief: the month's AWS cost from Cost Explorer if the role allows it, else an estimate. */
export async function awsCostLine() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  try {
    const actual = await costExplorerMonth(start, now);
    return `AWS cost this month so far (Cost Explorer, actual): $${actual.toFixed(2)}.`;
  } catch (e: any) {
    const est = await estimateMonth(start, now);
    const why = /AccessDenied|not authorized/i.test(String(e.message)) ? 'no ce:GetCostAndUsage permission' : `Cost Explorer: ${String(e.message).slice(0, 80)}`;
    return `AWS cost this month so far (estimate, ${why}): about $${est.total.toFixed(2)} ($${est.fixed.toFixed(2)} fixed, $${est.usage.toFixed(2)} pay-per-use).`;
  }
}

/** Fixed costs prorated to today, plus the pay-per-use Hawkes Gen recorded and Studio's own Claude runs. */
async function estimateMonth(start: Date, now: Date) {
  const days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const fixed = (FIXED_MONTHLY * (now.getUTCDate() - 1 + now.getUTCHours() / 24)) / days;
  const genUsage = Number((await gen.usage({ since: String(start.getTime()) }).catch(() => ({ total: 0 }))).total) || 0;
  const studio = (db.prepare('SELECT (SELECT COALESCE(SUM(cost), 0) FROM changes WHERE created >= ?) + (SELECT COALESCE(SUM(cost), 0) FROM conversations WHERE created >= ?) AS c').get(start.getTime(), start.getTime()) as any).c as number;
  const usage = genUsage + studio;
  return { fixed, usage, total: fixed + usage };
}

/** Cost Explorer GetCostAndUsage (unblended, this month), signed with the server role's credentials (no SDK). */
async function costExplorerMonth(start: Date, now: Date) {
  const creds = await awsCredentials();
  const end = new Date(now.getTime() + 86_400_000); // End is exclusive and must be after Start.
  const body = JSON.stringify({ TimePeriod: { Start: ymd(start), End: ymd(end) }, Granularity: 'MONTHLY', Metrics: ['UnblendedCost'] });
  const host = 'ce.us-east-1.amazonaws.com';
  const headers: Record<string, string> = {
    'content-type': 'application/x-amz-json-1.1',
    host,
    'x-amz-target': 'AWSInsightsIndexService.GetCostAndUsage',
    ...(creds.token ? { 'x-amz-security-token': creds.token } : {}),
  };
  const r = await fetch(`https://${host}/`, { method: 'POST', headers: sign(headers, body, creds, 'us-east-1', 'ce'), body, signal: AbortSignal.timeout(15_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 200)}`);
  const d = JSON.parse(text);
  return (d.ResultsByTime ?? []).reduce((n: number, x: any) => n + (Number(x.Total?.UnblendedCost?.Amount) || 0), 0) as number;
}

type Creds = { key: string; secret: string; token?: string };

/** Environment keys if set, else the instance role through IMDSv2. */
async function awsCredentials(): Promise<Creds> {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) return { key: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY, token: process.env.AWS_SESSION_TOKEN };
  const md = 'http://169.254.169.254/latest';
  const t = await (await fetch(`${md}/api/token`, { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '300' }, signal: AbortSignal.timeout(2000) })).text();
  const h = { 'X-aws-ec2-metadata-token': t };
  const role = (await (await fetch(`${md}/meta-data/iam/security-credentials/`, { headers: h, signal: AbortSignal.timeout(2000) })).text()).trim().split('\n')[0];
  if (!role) throw new Error('no instance role');
  const c = await (await fetch(`${md}/meta-data/iam/security-credentials/${role}`, { headers: h, signal: AbortSignal.timeout(2000) })).json();
  return { key: c.AccessKeyId, secret: c.SecretAccessKey, token: c.Token };
}

/** AWS Signature Version 4 for a POST to "/" with no query. */
function sign(headers: Record<string, string>, body: string, c: Creds, region: string, service: string) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const h: Record<string, string> = { ...headers, 'x-amz-date': amzDate };
  const names = Object.keys(h).map((k) => k.toLowerCase()).sort();
  const signed = names.join(';');
  const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
  const hmac = (k: crypto.BinaryLike, s: string) => crypto.createHmac('sha256', k).update(s).digest();
  const canonical = ['POST', '/', '', names.map((n) => `${n}:${String(h[n]).trim()}\n`).join(''), signed, sha(body)].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${c.secret}`, date), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${c.key}/${scope}, SignedHeaders=${signed}, Signature=${signature}` };
}
