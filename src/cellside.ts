// A customer's cell telling the control plane what it needs to know (cells.ts), with its own cell key:
//   - its people (users and open invites), so someone invited signs in at studio.hawkesgen.ai and lands here instead of
//     at the sign-up: at start, every 5 minutes, and after every change in Users
//   - its customer's AI (Connect your AI: their Anthropic key or Claude subscription), mirrored into Hawkes Gen for its
//     org, so Gen's reviews and tools run on it too (hawkesgen orgsecrets.ts): after every change in Your AI
// Nothing outside a cell made by the control plane (STUDIO_CONTROL_URL, STUDIO_ORG, STUDIO_CELL_KEY).

const cfg = () => {
  const url = (process.env.STUDIO_CONTROL_URL ?? '').replace(/\/+$/, '');
  const org = process.env.STUDIO_ORG ?? '';
  const key = process.env.STUDIO_CELL_KEY ?? '';
  return url && org && key ? { url, org, key } : null;
};

export const inCell = () => Boolean(cfg());

async function post(path: string, body: unknown) {
  const c = cfg();
  if (!c) return null;
  const r = await fetch(`${c.url}/api/cells/self/${path}`, {
    method: 'POST', signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${c.key}`, 'X-Studio-Cell': c.org, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`the control plane answered ${r.status} for ${path}`);
  return r.json();
}

/** Who may enter this Studio: its users (with Google's id once linked) and its open invites. */
export async function reportMembers() {
  if (!inCell()) return null;
  const A = await import('./auth.ts');
  const { db } = await import('./db.ts');
  const users = db.prepare('SELECT email, google_sub, role FROM users WHERE disabled = 0').all() as { email: string; google_sub: string | null; role: string }[];
  const people = [
    ...users.map((u) => ({ email: u.email, sub: u.google_sub, role: u.role, kind: 'member' })),
    ...A.listInvites().filter((i) => i.status === 'open' && i.kind === 'invite').map((i) => ({ email: i.email, role: i.role, kind: 'invite' })),
  ];
  const projects = await import('./config.ts').then((c) => c.loadProducts().length).catch(() => undefined);
  return post('members', { people, projects }).catch((e) => { console.warn(`[cell] reporting members: ${e.message}`); return null; });
}

let lastAi = '';
/** The customer's AI into Gen for its org: their API key and their subscription's token, each set or removed. */
export async function syncAiToGen() {
  if (!inCell()) return null;
  const { customerKey } = await import('./claude.ts');
  const { activeToken } = await import('./claude-accounts.ts');
  const want = { anthropic: customerKey() ?? null, 'claude-subscription': activeToken() ?? null };
  const sig = JSON.stringify(want);
  if (sig === lastAi) return null;
  try {
    for (const [kind, key] of Object.entries(want)) await post('ai', { kind, key });
    lastAi = sig;
  } catch (e: any) {
    console.warn(`[cell] Connect your AI → Hawkes Gen: ${e.message}`);
  }
  return want.anthropic || want['claude-subscription'] ? 'set' : 'none';
}

/** At start and every 5 minutes (server.ts). */
export function startCellReports(every = 5 * 60_000) {
  if (!inCell()) return;
  const tick = () => { void reportMembers(); void syncAiToGen(); };
  tick();
  setInterval(tick, every).unref();
}

// GitHub through J's GitHub App (github-app.ts; J, 2026-10-30: GitHub for customers): a cell has no app of its own. It
// asks the control plane for its install link (the org signed into it) and the installations linked to its org, and for
// a token scoped to one repo of one of them when it needs one (an agent's clone and pull request, a setup step).

/** The app, the install link for this org, and its linked installations; null outside a cell. */
export async function cellGithub(back?: string | null, user?: string | null): Promise<{ app: { slug: string } | null; install: string | null; installations: { id: number; account: string; type: string; repos: string }[]; user: { login: string } | null; connect: string | null; linked: string[] } | null> {
  if (!inCell()) return null;
  return post('github', { back: back ?? null, user: user ?? null });
}

/** Disconnects a person's GitHub (the control plane forgets and revokes it); installations: the org stops using its installs too. */
export async function cellGithubDisconnect(user: string, installations = false) {
  if (!inCell()) return null;
  cellTokens.clear();
  return post('github-disconnect', { user, installations });
}

/** A person's GitHub sign-in (kept by the control plane for this org): their login and a fresh token, or null. */
export async function cellGithubUser(user: string): Promise<{ login: string; token: string } | null> {
  if (!inCell()) return null;
  const r = await post('github-user', { user });
  return r?.token ? { login: String(r.login), token: String(r.token) } : null;
}

const cellTokens = new Map<string, { token: string; until: number }>();
/**
 * A token for one of this org's repos (scoped to it alone), or null when no installation of the org reaches it.
 * read: contents read-only (an agent's read-only copy of another project's repo: access.ts), or null when it can't be.
 */
export async function cellGithubToken(repo: string, { read = false }: { read?: boolean } = {}): Promise<string | null> {
  if (!inCell()) return null;
  const key = `${read ? 'r:' : ''}${repo.toLowerCase()}`;
  const hit = cellTokens.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  const r = await post('github-token', read ? { repo, read: true } : { repo });
  if (!r?.token) return null;
  cellTokens.set(key, { token: r.token, until: Math.min(Number(r.expires) || 0, Date.now() + 50 * 60_000) - 5 * 60_000 });
  return r.token;
}

/**
 * One Hawkes Gen file through the control plane (cells.ts /api/cells/self/gen-asset): from this org's own Gen library,
 * or, with `owners`, an owner's own hawkesgen.ai library. The control plane decides; refusals come back as they are.
 */
export async function cellGenAsset(asset: string, owners: boolean) {
  const c = cfg();
  if (!c) throw Object.assign(new Error('not a customer cell'), { status: 409 });
  // The control plane not answering (a restart) is a 503 the import tool retries, not "no such file".
  const r = await fetch(`${c.url}/api/cells/self/gen-asset`, {
    method: 'POST', signal: AbortSignal.timeout(180_000),
    headers: { Authorization: `Bearer ${c.key}`, 'X-Studio-Cell': c.org, 'Content-Type': 'application/json' }, body: JSON.stringify({ asset, owners }),
  }).catch(() => { throw Object.assign(new Error("Hawkes Gen didn't answer, retrying"), { status: 503 }); });
  if (!r.ok) {
    const j: any = await r.json().catch(() => ({}));
    throw Object.assign(new Error(j.error ?? `the control plane answered ${r.status} for ${asset}`), { status: r.status === 401 ? 502 : [502, 504].includes(r.status) ? 503 : r.status });
  }
  const via = r.headers.get('x-gen-via') === 'owner' ? 'owner' as const : 'own' as const;
  return {
    bytes: Buffer.from(await r.arrayBuffer()), mime: String(r.headers.get('content-type') ?? 'application/octet-stream'), via,
    project: String(r.headers.get('x-gen-project') ?? ''), ext: String(r.headers.get('x-gen-ext') ?? '') || '.png',
    title: decodeURIComponent(String(r.headers.get('x-gen-title') ?? '')) || null,
  };
}
