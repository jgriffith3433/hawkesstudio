// A fresh clone token for a Cloud Run job that waited (2026-11-02: four agents' jobs waited about an hour for a machine,
// then cloned with the token minted when Studio started them, which GitHub had expired: "could not read Username for
// 'https://github.com'"). Studio puts a job key in the job's spec beside the token; the runner (cloudjob-run.ts
// prepare) asks POST /api/cloudjobs/<unit>/git-token for a new token with it, once, right before cloning when the one in
// the spec is old, or when GitHub refuses it.
//
// The key is an HMAC of the unit and its one repo under a secret only Studio holds (DATA/job-git.secret, a state file,
// so a Studio restarted while the job waited still knows it). It opens a token for that job's own repo and nothing else,
// minted the same way as at the start (ghtoken.ts jobRepoToken: the app's, scoped to that repo, read-only). The pass the
// job runs never sees the key: the runner reads it from the spec (which it deletes) before the pass starts. The route
// never logs or returns anything but the token.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA, StudioError } from './config.ts';

const SECRET = () => path.join(DATA, 'job-git.secret');
const SLUG = /^[\w.-]+\/[\w.-]+$/;
const UNIT = /^[A-Za-z0-9_.-]{1,200}$/;

function secret() {
  try {
    const s = fs.readFileSync(SECRET(), 'utf8').trim();
    if (s.length >= 32) return s;
  } catch { /* made below */ }
  const s = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(SECRET(), s, { mode: 0o600 });
  return s;
}

/** The job key for one job's one repo (null when either can't be named). */
export function jobGitKey(unit: string, slug: string | null | undefined): string | null {
  if (!slug || !SLUG.test(slug) || !UNIT.test(unit)) return null;
  return crypto.createHmac('sha256', secret()).update(`hawkes-job-git:${unit}:${slug.toLowerCase()}`).digest('base64url');
}

const same = (a: string, b: string) => {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
};

/**
 * A fresh token for the job's repo, or a refusal: 403 for a key that isn't this unit's for that repo, 404 when GitHub
 * gives none. `mint` is the same minting as at the job's start (ghtoken.ts jobRepoToken).
 */
export async function jobGitToken(unit: string, repo: unknown, key: unknown, mint?: (slug: string) => Promise<string | null>): Promise<string> {
  const slug = String(repo ?? '');
  const want = jobGitKey(unit, slug);
  if (!want || typeof key !== 'string' || !key || !same(key, want)) throw new StudioError("That job key doesn't open this repo's token", 403);
  const m = mint ?? (async (s: string) => (await import('./ghtoken.ts')).jobRepoToken(s));
  const token = await m(slug).catch(() => null);
  if (!token) throw new StudioError('GitHub gave no token for this repo now', 404);
  return token;
}

/** What the spec's git carries so the runner can ask (null when Studio has no address the job can reach). */
export function jobGitRefresh(unit: string, slug: string | null | undefined, env: NodeJS.ProcessEnv = process.env): { url: string; key: string } | null {
  const url = String(env.STUDIO_SERVICE_URL || env.STUDIO_URL || '').replace(/\/+$/, '');
  const key = jobGitKey(unit, slug);
  if (!/^https?:\/\//.test(url) || !key) return null;
  return { url, key };
}
