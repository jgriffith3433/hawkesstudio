// The beta sites' R2 bucket written straight through R2's S3 API (https://<account>.r2.cloudflarestorage.com), not through
// the beta-sites Worker: a publish is hundreds to thousands of reads, writes and copies, and each one through the Worker
// was a Worker request and a log line (2026-11-02, the account's Workers allowance). Same keys as the Worker writes
// (<lane>/<key>), so the Worker serves them unchanged. AWS Signature V4 by hand (node:crypto), no SDK.
//
// Only J's own Studio uses it: R2's keys open a whole bucket, so a customer's Studio (siteOrg) keeps signing its writes to
// the Worker, which keeps it under o/<org>/. Set up: STUDIO_R2_ACCOUNT_ID, STUDIO_R2_ACCESS_KEY_ID,
// STUDIO_R2_SECRET_ACCESS_KEY (an R2 API token with Object Read & Write on the bucket), STUDIO_R2_BUCKET (default
// hawkes-beta-sites). Without them: the Worker, as before.

import crypto from 'node:crypto';
import type { SiteStore } from './sitestore.ts';

export type R2Config = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region?: string };

export function r2Config(env = process.env): R2Config | null {
  const account = env.STUDIO_R2_ACCOUNT_ID?.trim();
  const accessKeyId = env.STUDIO_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.STUDIO_R2_SECRET_ACCESS_KEY?.trim();
  if (!account || !accessKeyId || !secretAccessKey) return null;
  return { endpoint: (env.STUDIO_R2_ENDPOINT || `https://${account}.r2.cloudflarestorage.com`).replace(/\/+$/, ''), bucket: env.STUDIO_R2_BUCKET || 'hawkes-beta-sites', accessKeyId, secretAccessKey, region: 'auto' };
}

const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => crypto.createHmac('sha256', k).update(s).digest();
/** S3's URI encoding: everything but A-Z a-z 0-9 - _ . ~ (and the slashes of a path). */
export const s3Encode = (s: string, keepSlash = false) => {
  const e = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? e.replace(/%2F/g, '/') : e;
};

/** Signature V4 headers for one request (host, x-amz-date, x-amz-content-sha256, authorization) plus `headers`. */
export function signV4(o: { method: string; url: URL; headers?: Record<string, string>; payloadHash: string; accessKeyId: string; secretAccessKey: string; region: string; service?: string; now?: Date }): Record<string, string> {
  const service = o.service ?? 's3';
  const amzDate = (o.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const h: Record<string, string> = { host: o.url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': o.payloadHash };
  for (const [k, v] of Object.entries(o.headers ?? {})) h[k.toLowerCase()] = String(v).trim();
  const names = Object.keys(h).sort();
  const query = [...o.url.searchParams.entries()].map(([k, v]) => [s3Encode(k), s3Encode(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [o.method, o.url.pathname, query, names.map((n) => `${n}:${h[n]}\n`).join(''), names.join(';'), o.payloadHash].join('\n');
  const scope = `${day}/${o.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${o.secretAccessKey}`, day), o.region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

/** The SiteStore (sitestore.ts) on R2's S3 API, inside `lane`'s prefix like the Worker's. */
export function r2Store(c: R2Config, lane: string, fetcher: typeof fetch = fetch): SiteStore {
  const objectPath = (key: string) => `/${s3Encode(c.bucket)}/${s3Encode(`${lane}/${key}`, true)}`;
  const call = async (method: string, pathAndQuery: string, body: Buffer | null, headers: Record<string, string> = {}, ok404 = false) => {
    for (let attempt = 1; ; attempt++) {
      const url = new URL(c.endpoint + pathAndQuery);
      const signed = signV4({ method, url, headers, payloadHash: sha256(body ?? ''), accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: c.region ?? 'auto' });
      const { host: _host, ...send } = signed;
      const res = await fetcher(url, { method, headers: send, body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(5 * 60_000) })
        .catch((e: any) => ({ ok: false, status: 0, text: async () => String(e?.message ?? e), arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response);
      if (res.ok || (ok404 && res.status === 404)) return res;
      if (attempt >= 3 || (res.status >= 400 && res.status < 500 && res.status !== 429)) throw new Error(`R2 ${method} ${pathAndQuery.slice(0, 120)}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  };
  return {
    get: async (key) => {
      const res = await call('GET', objectPath(key), null, {}, true);
      return res.status === 404 ? null : Buffer.from(await res.arrayBuffer());
    },
    put: async (key, data, type) => { await call('PUT', objectPath(key), data, { 'content-type': type }); },
    // CopyObject keeps the source's content type (metadata directive COPY), as the Worker's copy does.
    copy: async (from, to) => { await call('PUT', objectPath(to), null, { 'x-amz-copy-source': objectPath(from) }); },
    remove: async (keys) => {
      for (let i = 0; i < keys.length; i += 1000) {
        const xml = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${keys.slice(i, i + 1000).map((k) => `<Object><Key>${xmlEscape(`${lane}/${k}`)}</Key></Object>`).join('')}</Delete>`);
        await call('POST', `/${s3Encode(c.bucket)}?delete=`, xml, { 'content-type': 'application/xml', 'content-md5': crypto.createHash('md5').update(xml).digest('base64') });
      }
    },
  };
}
