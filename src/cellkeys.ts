// Customers' Studios (cells) without a secret per customer (docs/studio-customers.md, section 2): every key a cell needs
// is derived from ONE master secret (STUDIO_CELLS_MASTER, only in the control plane: J's Studio) by HMAC-SHA256 of its
// purpose and the org's id. The control plane gives each cell its own derived values as plain environment variables of
// its Cloud Run service (no Secret Manager secret per customer, no quota); a cell never sees the master, so one cell's
// keys open nothing of another's. Rotating the master changes every cell's keys on its next deploy (cells.ts roll).
//
// Also here: sealing a customer's secrets at rest (their Anthropic key, their Claude sign-ins) with AES-256-GCM under the
// cell's own STUDIO_SECRETS_KEY, so the files synced to the state bucket are ciphertext.

import crypto from 'node:crypto';
import { StudioError } from './config.ts';

/** What a cell's keys are for (the env name each becomes). */
export const CELL_KEYS = {
  owner: 'STUDIO_OWNER_KEY', // the platform's own calls into the cell (the nightly cron, the roll's health check)
  agent: 'STUDIO_AGENT_KEY', // its agents' and Talk's Claude Code in their jobs
  mcp: 'STUDIO_MCP_KEY', // its /mcp over HTTPS
  pass: 'STUDIO_SITES_SEED', // signing its beta-site passes (sitekeys.ts)
  secrets: 'STUDIO_SECRETS_KEY', // sealing its customer's secrets at rest
  cell: 'STUDIO_CELL_KEY', // the cell calling the control plane back (its plan, its billing)
  broker: 'STUDIO_BROKER_KEY', // signing its agents' run tokens for the job broker (jobbroker.ts)
} as const;
export type CellKeyPurpose = keyof typeof CELL_KEYS;

const ORG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const validOrg = (org: string) => ORG.test(String(org ?? ''));

export function master(): string {
  const m = process.env.STUDIO_CELLS_MASTER?.trim();
  if (!m || m.length < 32) throw new StudioError('Customers\' Studios are not set up here (STUDIO_CELLS_MASTER, at least 32 characters, is missing).', 503);
  return m;
}

/** One derived key: base64url of HMAC-SHA256(master, "<purpose>:<org>"). */
export function deriveKey(purpose: string, org: string, m = master()) {
  if (!validOrg(org) && org !== '*') throw new StudioError(`Not an org id: ${org}`);
  return crypto.createHmac('sha256', m).update(`hawkes-studio-cell:${purpose}:${org}`).digest('base64url');
}

/** Every key a cell gets, as its environment. */
export function cellKeyEnv(org: string, m = master()): Record<string, string> {
  return Object.fromEntries(Object.entries(CELL_KEYS).map(([purpose, env]) => [env, deriveKey(purpose, org, m)]));
}

/** The Worker's key for the control plane's edge routes (one for all orgs). */
export const edgeKey = (m = master()) => deriveKey('edge', '*', m);

const sameText = (a: string, b: string) => {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
};

/** Whether `key` is this org's cell key (the control plane checking a cell's call). */
export function isCellKey(org: string, key: string | null | undefined) {
  if (!key || !validOrg(org)) return false;
  try { return sameText(key, deriveKey('cell', org)); } catch { return false; }
}

/**
 * Hawkes Gen's key for charging customers' Studios (POST /api/cells/gen/charge|refund; hawkesgen src/orgcredits.ts):
 * one for all orgs, set on each Gen lane as HAWKESGEN_ORG_CREDITS_KEY. Only the platform admin reads it
 * (GET /api/cells/gen-key). Rotating the master changes it: set it on Gen again.
 */
export const genChargesKey = (m = master()) => deriveKey('gen-charges', '*', m);

export const isGenChargesKey = (key: string | null | undefined) => {
  if (!key) return false;
  try { return sameText(key, genChargesKey()); } catch { return false; }
};

export const isEdgeKey = (key: string | null | undefined) => {
  if (!key) return false;
  try { return sameText(key, edgeKey()); } catch { return false; }
};

// ------------------------------------------------------------------ sealing secrets at rest

const SEALED = 'sealed:v1:';
const sealKey = () => {
  const k = process.env.STUDIO_SECRETS_KEY?.trim();
  return k ? crypto.createHash('sha256').update(k).digest() : null;
};

/** Whether this Studio seals secrets (a cell: always; elsewhere when STUDIO_SECRETS_KEY is set). */
export const sealing = () => Boolean(sealKey());

/** Ciphertext for a secret (AES-256-GCM, random IV), or the text itself where there's no sealing key. */
export function seal(plain: string): string {
  const key = sealKey();
  if (!key) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return SEALED + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}

const keyOf = (k: string) => crypto.createHash('sha256').update(k).digest();

/** Seals with a given key (the control plane's own records: a cell's Gen key, under a key derived from the master). */
export function sealWith(plain: string, key: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyOf(key), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return SEALED + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}

export function unsealWith(text: string, key: string): string {
  if (!String(text ?? '').startsWith(SEALED)) return text;
  const raw = Buffer.from(text.slice(SEALED.length), 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', keyOf(key), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

/** The secret back. Plain text (written before sealing) passes through, so turning sealing on needs no migration. */
export function unseal(text: string): string {
  if (!String(text ?? '').startsWith(SEALED)) return text;
  const key = sealKey();
  if (!key) throw new StudioError('A sealed secret, and no STUDIO_SECRETS_KEY to open it.', 500);
  const raw = Buffer.from(text.slice(SEALED.length), 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

export const isSealed = (text: string) => String(text ?? '').startsWith(SEALED);
