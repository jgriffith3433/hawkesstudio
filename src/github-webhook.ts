// The GitHub App's webhook: installation events only (ghperms.ts; J, 2026-11-08: customers shouldn't be left guessing
// after accepting a permission on GitHub). GitHub sends every app its installation events without a subscription:
//
//   installation               created, new_permissions_accepted, unsuspend (and deleted, suspend)
//   installation_repositories  added, removed
//
// Each one means what Studio may do has changed, so the installation tokens and the app's permission list are
// forgotten, and the open GitHub access cards (buildaccess.ts) are looked at once: access back means the builds that
// waited start again and the card resolves by itself. An installation linked to a customer's Studio tells that Studio
// (cells.ts tellCellGithubChanged). No polling anywhere: this, GitHub's return to the setup URL and the dashboard being
// shown again (POST /api/github/recheck) are the only times Studio looks.
//
// The check is GitHub's signature (X-Hub-Signature-256: HMAC-SHA256 of the raw body with the app's webhook secret,
// made with the app by the manifest flow). Unsigned or wrongly signed: 401, nothing done.

import crypto from 'node:crypto';
import type http from 'node:http';

export type HookAnswer = { status: number; body: Record<string, unknown> };

/** Whether GitHub signed this body with `secret`. Exported for the tests. */
export function signedBy(raw: Buffer, header: unknown, secret: string): boolean {
  const got = String(header ?? '');
  if (!secret || !got.startsWith('sha256=')) return false;
  const want = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/** The events that change what Studio may do on an installation. */
const CHANGES: Record<string, Set<string>> = {
  installation: new Set(['created', 'new_permissions_accepted', 'unsuspend', 'deleted', 'suspend']),
  installation_repositories: new Set(['added', 'removed']),
};

/** Replaced by the tests. */
export const webhookHooks = {
  recheck: (o: { force: boolean }) => recheckNow(o),
  tellCell: async (org: string) => (await import('./cells.ts')).tellCellGithubChanged(org),
};

export async function handleGithubWebhook(raw: Buffer, headers: http.IncomingHttpHeaders): Promise<HookAnswer> {
  const G = await import('./github-app.ts');
  const app = G.appConfig();
  if (!app) return { status: 404, body: { error: 'No GitHub App here.' } };
  if (!app.webhookSecret) return { status: 503, body: { error: "This Studio's GitHub App has no webhook secret saved." } };
  if (!signedBy(raw, headers['x-hub-signature-256'], app.webhookSecret)) return { status: 401, body: { error: 'Bad signature.' } };
  const event = String(headers['x-github-event'] ?? '');
  if (event === 'ping') return { status: 200, body: { ok: true, pong: true } };
  let payload: any;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return { status: 400, body: { error: 'Not JSON.' } }; }
  const action = String(payload?.action ?? '');
  if (!CHANGES[event]?.has(action)) return { status: 200, body: { ok: true, ignored: `${event}.${action}` } };
  const installation = Number(payload?.installation?.id) || null;
  G.forgetInstallState();
  console.log(`[github] ${event}.${action} on installation ${installation ?? '?'} (${payload?.installation?.account?.login ?? '?'}): looking at GitHub access again`);
  // Answered at once (GitHub waits 10 s at most); the looking happens after.
  void (async () => {
    const org = installation ? G.installationOrg(installation) : null;
    if (org) await webhookHooks.tellCell(org).catch((e: any) => console.warn(`[github] couldn't tell ${org}'s Studio: ${e?.message ?? e}`));
    else await webhookHooks.recheck({ force: true });
  })().catch((e: any) => console.warn(`[github] looking again after ${event}.${action}: ${e?.message ?? e}`));
  return { status: 202, body: { ok: true, event, action, installation } };
}

/**
 * Looks at the open access cards now (buildaccess.ts recheckAccess). `force`: even one looked at in the last minute (a
 * webhook, GitHub's return, the control plane telling a cell). Returns how many are still open and whether any came back.
 */
export async function recheckNow(o: { force: boolean }) {
  const B = await import('./buildaccess.ts');
  if (!B.openAccess().length) return { open: 0, back: false };
  if (o.force) {
    (await import('./github-app.ts')).forgetInstallState();
    (await import('./cellside.ts')).forgetCellTokens();
  }
  const r = await B.recheckAccess({ force: o.force });
  return { open: B.openAccess().length, back: r.some((x) => x.back) };
}
