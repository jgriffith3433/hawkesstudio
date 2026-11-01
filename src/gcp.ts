// A small Google Cloud client for Studio on Cloud Run (docs/studio-cloudrun.md): an access token, Cloud Storage objects
// and Cloud Run job executions, over the REST APIs with fetch (no Google SDK). A copy of hawkesgen's
// src/providers/builder/gcp.ts, cut to what Studio uses.
//
// Credentials, in this order:
//   1. GOOGLE_APPLICATION_CREDENTIALS: a service-account key file, or the authorized_user file
//      `gcloud auth application-default login` writes.
//   2. The well-known ADC file (~/.config/gcloud/application_default_credentials.json, %APPDATA%\gcloud\... on Windows).
//   3. The metadata server (on Cloud Run: the service's or the job's own service account).
// Nothing here prints a token or a key.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { StudioError } from './config.ts';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const fail = (message: string, status = 409) => new StudioError(message, status);

type Cached = { token: string; expires: number };
let cached: Cached | null = null;

/** Tests swap in a fake fetch (every Google call goes through it). */
let fetchImpl: typeof fetch = (input, init) => fetch(input, init);
export function setGcpFetch(f: typeof fetch | null, token: string | null = null) {
  fetchImpl = f ?? ((input, init) => fetch(input, init));
  cached = token ? { token, expires: Date.now() + 3600_000 } : null;
}

function adcFile(): string | null {
  const named = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (named) return named;
  const wellKnown = process.platform === 'win32'
    ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'gcloud', 'application_default_credentials.json')
    : path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
  return fs.existsSync(wellKnown) ? wellKnown : null;
}

function serviceAccountAssertion(key: { client_email: string; private_key: string; token_uri?: string }, now = Math.floor(Date.now() / 1000)) {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const body = b64({ iss: key.client_email, scope: SCOPE, aud: key.token_uri ?? 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(key.private_key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

async function tokenRequest(url: string, form: Record<string, string>) {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), signal: AbortSignal.timeout(30_000) });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok || !j.access_token) throw fail(`Google Cloud refused the credentials (${r.status} ${j.error ?? ''}).`, 401);
  return { token: String(j.access_token), expires: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
}

/** An access token for the cloud-platform scope (cached until a minute before it expires). */
export async function accessToken(): Promise<string> {
  if (cached && cached.expires - 60_000 > Date.now()) return cached.token;
  // On Cloud Run the metadata server comes first: a key file there would only be a mistake.
  if (!process.env.K_SERVICE && !process.env.CLOUD_RUN_JOB) {
    const file = adcFile();
    if (file) {
      const cred = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cred.type === 'service_account') cached = await tokenRequest(cred.token_uri ?? 'https://oauth2.googleapis.com/token', { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountAssertion(cred) });
      else if (cred.type === 'authorized_user') cached = await tokenRequest('https://oauth2.googleapis.com/token', { grant_type: 'refresh_token', client_id: cred.client_id, client_secret: cred.client_secret, refresh_token: cred.refresh_token });
      else throw fail(`The Google credentials in ${file} are of type "${cred.type}", which Studio doesn't read (a service-account key or gcloud's application-default login works).`, 401);
      return cached!.token;
    }
  }
  try {
    const r = await fetchImpl(`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token?scopes=${SCOPE}`, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(3_000) });
    const j = (await r.json()) as any;
    if (r.ok && j.access_token) {
      cached = { token: j.access_token, expires: Date.now() + (Number(j.expires_in) || 3000) * 1000 };
      return cached.token;
    }
  } catch { /* not on Google Cloud */ }
  throw fail('No Google Cloud credentials (on J\'s PC: gcloud auth application-default login).', 401);
}

/** A JSON call to a Google API. 404 resolves to null when `missingOk`. */
export async function gapi(url: string, init: { method?: string; body?: unknown; missingOk?: boolean; timeoutMs?: number } = {}): Promise<any> {
  const r = await fetchImpl(url, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
  });
  if (r.status === 404 && init.missingOk) return null;
  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text).error?.message ?? msg; } catch { /* not JSON */ }
    throw fail(`Google Cloud answered ${r.status} for ${url.replace(/\?.*$/, '')}: ${msg}`, r.status === 401 || r.status === 403 ? r.status : 409);
  }
  return text ? JSON.parse(text) : {};
}

// ------------------------------------------------------------ Cloud Storage

const enc = encodeURIComponent;
export type GcsObject = { name: string; size: number; updated: string };

export async function gcsList(bucket: string, prefix: string): Promise<GcsObject[]> {
  const out: GcsObject[] = [];
  let page = '';
  do {
    const j = await gapi(`https://storage.googleapis.com/storage/v1/b/${bucket}/o?prefix=${enc(prefix)}&maxResults=1000${page ? `&pageToken=${enc(page)}` : ''}`);
    for (const o of j.items ?? []) out.push({ name: o.name, size: Number(o.size) || 0, updated: o.updated });
    page = j.nextPageToken ?? '';
  } while (page);
  return out;
}

export async function gcsDelete(bucket: string, key: string) {
  await gapi(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${enc(key)}`, { method: 'DELETE', missingOk: true });
}

/** An object's bytes, or null when it isn't there. */
export async function gcsRead(bucket: string, key: string): Promise<Buffer | null> {
  const r = await fetchImpl(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${enc(key)}?alt=media`, { headers: { Authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(300_000) });
  if (r.status === 404) return null;
  if (!r.ok) throw fail(`Couldn't read gs://${bucket}/${key} (${r.status} ${(await r.text()).slice(0, 200)})`);
  return Buffer.from(await r.arrayBuffer());
}

/** Uploads bytes or a file (one request). */
export async function gcsWrite(bucket: string, key: string, data: Buffer | string, contentType = 'application/octet-stream') {
  const body = typeof data === 'string' ? fs.readFileSync(data) : data;
  const r = await fetchImpl(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${enc(key)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': contentType },
    body: new Uint8Array(body), signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!r.ok) throw fail(`Couldn't upload gs://${bucket}/${key} (${r.status} ${(await r.text()).slice(0, 200)})`);
  return body.length;
}

// ---------------------------------------------------------------- Cloud Run

export type CloudRunTarget = { project: string; region: string; job: string };
const runBase = (t: CloudRunTarget) => `https://run.googleapis.com/v2/projects/${t.project}/locations/${t.region}`;

/** Starts one execution of the job with these arguments, env and a task timeout; returns the execution's full name. */
export async function runJob(t: CloudRunTarget, o: { args?: string[]; env?: Record<string, string>; timeoutSeconds: number }): Promise<string> {
  const op = await gapi(`${runBase(t)}/jobs/${t.job}:run`, {
    body: { overrides: { containerOverrides: [{ ...(o.args ? { args: o.args } : {}), env: Object.entries(o.env ?? {}).map(([name, value]) => ({ name, value })) }], taskCount: 1, timeout: `${o.timeoutSeconds}s` } },
  });
  const name = executionNameOf(op);
  if (name) return name;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3_000));
    const n = executionNameOf(await gapi(`https://run.googleapis.com/v2/${op.name}`));
    if (n) return n;
  }
  throw fail(`Cloud Run started the job but didn't say which execution (operation ${op.name}).`);
}

/** The execution name in a jobs.run operation (metadata, or response once done). */
export function executionNameOf(op: any): string | null {
  for (const v of [op?.metadata?.name, op?.response?.name]) if (typeof v === 'string' && /\/executions\/[^/]+$/.test(v)) return v;
  return null;
}

export type ExecutionState = { done: boolean; succeeded: boolean; cancelled: boolean; running: boolean; message: string };

export function executionState(e: any): ExecutionState {
  const done = Boolean(e?.completionTime);
  const completed = (e?.conditions ?? []).find((c: any) => c.type === 'Completed');
  const failedTask = (e?.conditions ?? []).find((c: any) => c.state === 'CONDITION_FAILED');
  return {
    done, succeeded: done && Number(e?.succeededCount ?? 0) > 0, cancelled: Number(e?.cancelledCount ?? 0) > 0,
    running: Number(e?.runningCount ?? 0) > 0, message: String(failedTask?.message ?? completed?.message ?? ''),
  };
}

/** An execution's state, or null when Cloud Run no longer has it. */
export async function getExecution(name: string): Promise<ExecutionState | null> {
  const e = await gapi(`https://run.googleapis.com/v2/${name}`, { missingOk: true });
  return e ? executionState(e) : null;
}

export async function cancelExecution(name: string) {
  await gapi(`https://run.googleapis.com/v2/${name}:cancel`, { body: {} }).catch(() => {});
}

// ------------------------------------------------------------ Google sign-in

/**
 * A Google ID token checked with Google (the tokeninfo endpoint: signature and expiry), returning its claims. The caller
 * checks the audience and the email. Throws a sentence when Google doesn't accept it.
 */
export async function googleIdToken(token: string): Promise<{ aud: string; iss: string; email: string; email_verified: boolean; exp: number; azp?: string; sub?: string; name?: string }> {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(token ?? ''))) throw fail('That is not a Google sign-in.', 401);
  const r = await fetchImpl(`https://oauth2.googleapis.com/tokeninfo?id_token=${enc(token)}`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw fail('Google did not accept that token.', 401);
  const t = (await r.json()) as any;
  if (t.iss !== 'accounts.google.com' && t.iss !== 'https://accounts.google.com') throw fail('That token did not come from Google.', 401);
  if (Number(t.exp) * 1000 < Date.now()) throw fail('That token has expired.', 401);
  return { aud: String(t.aud ?? ''), iss: t.iss, email: String(t.email ?? '').toLowerCase(), email_verified: t.email_verified === true || t.email_verified === 'true', exp: Number(t.exp), azp: t.azp, sub: t.sub ? String(t.sub) : undefined, name: t.name ? String(t.name) : undefined };
}

// ------------------------------------------------------------ V4 signed URLs
// The job broker (jobbroker.ts) hands a customer's agent run a link that reads or writes ONE object for a few minutes,
// so bundles go straight between the job and Cloud Storage while the job's own account has no bucket access at all.
// Studio signs as its own service account with IAM's signBlob (no private key anywhere; the account needs
// roles/iam.serviceAccountTokenCreator on itself: cells-setup.mjs). A copy of hawkesgen src/providers/gpu/sign.ts.

export type Signer = { email: string; sign: (bytes: Buffer) => Promise<Buffer> };

const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** A V4 signed URL for one object (GET to read, PUT to write), valid `seconds`. */
export async function signedUrl(method: 'GET' | 'PUT', bucket: string, name: string, signer: Signer, seconds = 900, now = new Date()): Promise<string> {
  const host = 'storage.googleapis.com';
  const canonicalUri = `/${bucket}/${name.split('/').map(rfc3986).join('/')}`;
  const scope = `${ymd(now)}/auto/storage/goog4_request`;
  const q: Record<string, string> = {
    'X-Goog-Algorithm': 'GOOG4-RSA-SHA256',
    'X-Goog-Credential': `${signer.email}/${scope}`,
    'X-Goog-Date': stamp(now),
    'X-Goog-Expires': String(Math.max(1, Math.min(604_800, Math.round(seconds)))),
    'X-Goog-SignedHeaders': 'host',
  };
  const query = Object.keys(q).sort().map((k) => `${rfc3986(k)}=${rfc3986(q[k])}`).join('&');
  const canonical = [method, canonicalUri, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['GOOG4-RSA-SHA256', stamp(now), scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  const sig = await signer.sign(Buffer.from(toSign));
  return `https://${host}${canonicalUri}?${query}&X-Goog-Signature=${sig.toString('hex')}`;
}

let signerCache: Signer | null | undefined;
/** Tests swap in a fake (null: can't sign, the broker carries the bytes itself). */
export function setSigner(s: Signer | null | undefined) { signerCache = s; }

/** Studio's signer on Cloud Run (its own service account), or null where it can't sign. Remembered. */
export async function signer(): Promise<Signer | null> {
  if (signerCache !== undefined) return signerCache;
  let email = process.env.STUDIO_SIGN_AS?.trim() || null;
  if (!email && process.env.K_SERVICE) {
    email = await fetchImpl('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email', { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(3000) })
      .then((r) => (r.ok ? r.text() : null)).catch(() => null);
  }
  if (!email) return (signerCache = null);
  const who = email.trim();
  signerCache = {
    email: who,
    async sign(bytes) {
      const j = await gapi(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(who)}:signBlob`, { body: { payload: bytes.toString('base64') }, timeoutMs: 15_000 });
      return Buffer.from(String(j.signedBlob), 'base64');
    },
  };
  return signerCache;
}
