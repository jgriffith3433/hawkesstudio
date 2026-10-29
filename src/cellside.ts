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
  return post('members', { people }).catch((e) => { console.warn(`[cell] reporting members: ${e.message}`); return null; });
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
