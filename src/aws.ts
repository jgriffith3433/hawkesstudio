// Read-only AWS calls from Studio without the SDK: Cost Explorer (JSON) and EC2's Describe* (XML), signed with the
// server role's credentials (hawkes/hawkes-control, through IMDSv2) or AWS_* environment keys on J's PC.
// Studio never changes anything in AWS through this file.

import crypto from 'node:crypto';

export type Creds = { key: string; secret: string; token?: string };

let cached: { creds: Creds; until: number } | null = null;

/** Environment keys if set, else the instance role through IMDSv2 (cached for 10 minutes). */
export async function awsCredentials(): Promise<Creds> {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) return { key: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY, token: process.env.AWS_SESSION_TOKEN };
  if (cached && cached.until > Date.now()) return cached.creds;
  if (missing && missing.until > Date.now()) throw missing.error;
  lookup ??= (async () => {
    const md = 'http://169.254.169.254/latest';
    try {
      const t = await (await fetch(`${md}/api/token`, { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '300' }, signal: AbortSignal.timeout(2000) })).text();
      const h = { 'X-aws-ec2-metadata-token': t };
      const role = (await (await fetch(`${md}/meta-data/iam/security-credentials/`, { headers: h, signal: AbortSignal.timeout(2000) })).text()).trim().split('\n')[0];
      if (!role) throw new Error('no instance role');
      const c = await (await fetch(`${md}/meta-data/iam/security-credentials/${role}`, { headers: h, signal: AbortSignal.timeout(2000) })).json();
      const creds = { key: c.AccessKeyId, secret: c.SecretAccessKey, token: c.Token };
      cached = { creds, until: Date.now() + 10 * 60_000 };
      return creds;
    } catch (e: any) {
      // Not on an EC2 server (J's PC): say so once a minute instead of timing out on every call.
      missing = { error: new Error(`no AWS credentials here (no instance role: ${e.message}; no AWS_* keys)`), until: Date.now() + 60_000 };
      throw missing.error;
    }
  })().finally(() => (lookup = null));
  return lookup;
}
let missing: { error: Error; until: number } | null = null;
let lookup: Promise<Creds> | null = null;

/** AWS Signature Version 4 for a POST to "/" with no query. */
export function sign(headers: Record<string, string>, body: string, c: Creds, region: string, service: string) {
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

async function post(host: string, region: string, service: string, contentType: string, body: string, extra: Record<string, string> = {}) {
  const creds = await awsCredentials();
  const headers: Record<string, string> = { 'content-type': contentType, host, ...extra, ...(creds.token ? { 'x-amz-security-token': creds.token } : {}) };
  const r = await fetch(`https://${host}/`, { method: 'POST', headers: sign(headers, body, creds, region, service), body, signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  if (!r.ok) {
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? /"__type"\s*:\s*"(?:[^"#]*#)?([^"]+)"/.exec(text)?.[1] ?? '';
    const err: any = new Error(`${r.status} ${code} ${(/<Message>([^<]+)<\/Message>/.exec(text)?.[1] ?? /"[Mm]essage"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? text).slice(0, 200)}`.trim());
    err.code = code;
    err.denied = r.status === 403 || /AccessDenied|UnauthorizedOperation|not authorized/i.test(text);
    throw err;
  }
  return text;
}

/** One Cost Explorer call (each costs $0.01; callers cache). Cost Explorer lives in us-east-1. */
export async function costExplorer(action: 'GetCostAndUsage' | 'GetCostForecast', request: unknown) {
  const text = await post('ce.us-east-1.amazonaws.com', 'us-east-1', 'ce', 'application/x-amz-json-1.1', JSON.stringify(request), { 'x-amz-target': `AWSInsightsIndexService.${action}` });
  return JSON.parse(text);
}

/** One EC2 Query API call (free; Describe* only), parsed from XML. */
export async function ec2(region: string, action: string, params: Record<string, string> = {}) {
  if (!/^Describe/.test(action)) throw new Error('Studio only reads from EC2');
  const body = new URLSearchParams({ Action: action, Version: '2016-11-15', ...params }).toString();
  return parseXml(await post(`ec2.${region}.amazonaws.com`, region, 'ec2', 'application/x-www-form-urlencoded; charset=utf-8', body));
}

// ------------------------------------------------------------ XML

export type XmlNode = { name: string; text: string; kids: XmlNode[] };

/** Just enough XML for EC2's responses: elements and text (no attributes, CDATA or entities beyond the basic five). */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#root', text: '', kids: [] };
  const stack = [root];
  const re = /<(\/?)([\w:.-]+)[^>]*?(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->|([^<]+)/g;
  const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  for (let m: RegExpExecArray | null; (m = re.exec(xml)); ) {
    const top = stack[stack.length - 1];
    if (m[4] !== undefined) { top.text += unescape(m[4]); continue; }
    if (!m[2]) continue;
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    const node: XmlNode = { name: m[2].replace(/^\w+:/, ''), text: '', kids: [] };
    top.kids.push(node);
    if (!m[3]) stack.push(node);
  }
  return root;
}

/** The first descendant along a path ("instanceState/name"). */
export function xget(n: XmlNode | undefined, p: string): XmlNode | undefined {
  let cur = n;
  for (const part of p.split('/')) cur = cur?.kids.find((k) => k.name === part);
  return cur;
}
export const xtext = (n: XmlNode | undefined, p: string) => xget(n, p)?.text.trim() ?? '';
/** The <item>s of a set ("reservationSet"). */
export const xitems = (n: XmlNode | undefined, set: string) => (xget(n, set)?.kids ?? []).filter((k) => k.name === 'item');
/** Tags of an EC2 resource as a plain object. */
export const xtags = (n: XmlNode | undefined) => Object.fromEntries(xitems(n, 'tagSet').map((t) => [xtext(t, 'key'), xtext(t, 'value')]));
/** Every node with this name anywhere below. */
export function xall(n: XmlNode, name: string, out: XmlNode[] = []) {
  for (const k of n.kids) {
    if (k.name === name) out.push(k);
    xall(k, name, out);
  }
  return out;
}
