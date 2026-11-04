// A build that fails because of the code is fixed by an agent, not only reported (J, 2026-11-04: Yooba Land web 26 failed
// with "error CS0102: The type 'YoobaTunnel' already contains a definition for 'Find'"; Studio classified it as the code's
// fault (buildfail.ts), filed an Inbox card and stopped: "someone has to fix the code first").
//
//   autoFixBuild(): called once per final failure (buildfail.ts announce). Only kind "code" (compiler errors, a project's
//     own build command); infrastructure, quota, config and unknown failures keep their behaviour. It starts ONE agent
//     change (agents.ts startTask: a branch from beta, a pull request into beta, queued behind the product's other
//     agents by perProduct) whose request has the compiler errors, the failing commit and, when it can be told, the
//     merged change that brought it. The same failure (failSignature) starts one fixer at a time and at most MAX_FIXES
//     in all; after that the Inbox card is the owner's.
//   The fix merges into beta by itself (autoMergeBeta) and that starts beta's build (agents.ts approve → startBeta);
//     builds.ts startBuild closes the failed build's Inbox card (inbox.ts resolveBuildCards) when it starts, and the card
//     comes back only if the rebuild fails differently.
//   buildCheckBrief(): what every agent on a project with a build is told to run before opening a PR (agents.ts brief).

import crypto from 'node:crypto';
import { db } from './db.ts';
import { getProduct, managedElsewhere } from './config.ts';
import { failSignature } from './buildfail.ts';
import { buildErrors, pickCulprit } from './buildblame.ts';

/** Fixers one failure (failSignature) may start in all, so a fix that doesn't fix can't loop. */
export const MAX_FIXES = 2;
/** A change merged into beta this long before the failed build started can be the one that broke it. */
const BLAME_WINDOW_MS = 48 * 3600_000;
/** Statuses of a change that is still on its way (its fix may yet merge): another fixer for the same failure waits. */
const OPEN = ['queued', 'working', 'verifying', 'revising', 'ready', 'needs answer', 'asked'];

/** The marker line a fixer's request carries; the count and the dedupe read it back from `changes.request`. */
export const fixMarker = (sig: string) => `build-fix:${crypto.createHash('sha1').update(sig).digest('hex').slice(0, 12)}`;

export type FixState = { open: string[]; total: number };
/** The fixers already started for a failure signature: the ones still open, and all that were started (cancelled ones don't count). */
export function fixersOf(sig: string): FixState {
  let rows: { id: string; status: string }[] = [];
  try { rows = db.prepare("SELECT id, status FROM changes WHERE request LIKE ? AND status != 'cancelled' ORDER BY created").all(`%${fixMarker(sig)}%`) as typeof rows; } catch { /* agents.ts makes the table; none yet means none started */ }
  return { open: rows.filter((r) => OPEN.includes(r.status)).map((r) => r.id), total: rows.length };
}

export type FixDeps = {
  /** Starts the agent change (agents.ts startTask); returns its id. */
  start: (product: string, request: string, o: { title: string }) => string;
  /** The merged changes of the product that could have brought the failing commit, with the files each touched. */
  culprits: (product: string, before: number, errorFiles: string[]) => Promise<{ id: string; title: string; task: string | null; pr_url: string | null; at: number; files: string[] }[]>;
  /** Whether agents may start fixes at all (settings.agents enabled and autoFix). */
  allowed: () => boolean;
};

const realDeps = (): FixDeps => ({
  start: (product, request, o) => {
    // Imported on use: agents.ts is heavy and imports builds.ts, which imports buildfail.ts.
    const A = requireAgents();
    const id = A.startTask(product, request, { title: o.title });
    db.prepare('UPDATE changes SET started_by = ? WHERE id = ?').run('Studio (build fix)', id);
    return id;
  },
  culprits: async (product, before, errorFiles) => {
    const A = requireAgents();
    const rows = db.prepare("SELECT id FROM changes WHERE product = ? AND status = 'merged' AND merged_at IS NOT NULL AND merged_at <= ? AND merged_at >= ? ORDER BY merged_at DESC LIMIT 12").all(product, before, before - BLAME_WINDOW_MS) as { id: string }[];
    const out: Awaited<ReturnType<FixDeps["culprits"]>> = [];
    for (const r of rows) {
      const c = A.getChange(r.id);
      if (!c) continue;
      let files: string[] = [];
      if (errorFiles.length && c.pr && c.slug) {
        const list: any = await A.github(`/repos/${c.slug}/pulls/${c.pr}/files?per_page=100`).catch(() => []);
        files = Array.isArray(list) ? list.map((f: any) => String(f.filename)) : [];
      }
      out.push({ id: c.id, title: c.title ?? c.id, task: c.task, pr_url: c.pr_url, at: (c as any).merged_at ?? c.created, files });
    }
    return out;
  },
  allowed: () => { const s = requireAgents().agentSettings(); return s.enabled && s.autoFix; },
});
let agentsMod: any = null;
function requireAgents() {
  if (!agentsMod) throw new Error('agents.ts is not loaded yet');
  return agentsMod as typeof import('./agents.ts');
}

export type FixResult = { started: string | null; why: string };

/** Starts a fixer for a failed build row when the failure is the code's, new, and under the cap. Never throws. */
export async function autoFixBuild(rowId: string, deps?: Partial<FixDeps>): Promise<FixResult> {
  try {
    const r = db.prepare('SELECT * FROM builds WHERE id = ?').get(rowId) as any;
    if (!r || r.status !== 'failed') return { started: null, why: 'not a failed build' };
    if (r.change) return { started: null, why: "an agent change's preview, not the project's own build" };
    if (r.fail_kind !== 'code') return { started: null, why: `a ${r.fail_kind ?? 'unclear'} failure: not fixed by an agent` };
    let p;
    try { p = getProduct(r.product); } catch { return { started: null, why: 'unknown project' }; }
    if (managedElsewhere(p)) return { started: null, why: 'handled by another Studio' };
    if (!deps?.start) agentsMod ??= await import('./agents.ts');
    const d: FixDeps = { ...realDeps(), ...deps };
    if (!d.allowed()) return { started: null, why: 'agents are off or auto-fix is off' };
    const sig = failSignature(r);
    const have = fixersOf(sig);
    if (have.open.length) return { started: null, why: `${have.open[0]} is already fixing this failure` };
    if (have.total >= MAX_FIXES) return { started: null, why: `${have.total} fixers already tried this failure; it is the owner's now (Inbox)` };
    const { request, title } = await fixRequest(r, sig, have.total, d);
    const id = d.start(r.product, request, { title });
    return { started: id, why: `started ${id} (attempt ${have.total + 1} of ${MAX_FIXES})` };
  } catch (e: any) {
    console.warn(`[buildfix] ${rowId}: ${e?.message ?? e}`);
    return { started: null, why: `couldn't start a fixer: ${e?.message ?? e}` };
  }
}

/** The fixer's request: the error text, the failing commit, and where the commit came from. Exported for the tests. */
export async function fixRequest(r: any, sig: string, earlier: number, d: Pick<FixDeps, 'culprits'>): Promise<{ request: string; title: string }> {
  const log = String(r.fail_log ?? '');
  const errors = buildErrors(`${log}\n${r.detail ?? ''}`);
  const sha = r.sha ? String(r.sha).slice(0, 7) : 'unknown';
  let blame = '';
  try {
    const cands = await d.culprits(r.product, r.started ?? Date.now(), errors.files);
    if (cands.length) {
      const { culprit, matched } = pickCulprit(cands, errors.files);
      blame = `\n\nThe failing commit came from a change an agent merged into beta: **${culprit.title}** (${culprit.id}${culprit.task ? `, roadmap task ${culprit.task}` : ''}${culprit.pr_url ? `, ${culprit.pr_url}` : ''})${matched.length ? `, whose diff touches ${matched.join(', ')}, named in the errors` : ' (the latest merged before the build; the errors name no file it touched, so check beta\'s recent commits too)'}. Keep what that change set out to do; fix only what stops the build.`;
    }
  } catch { /* the blame is a help, never a reason not to fix */ }
  const lines = errors.lines.length ? errors.lines.join('\n') : String(r.detail ?? '').slice(0, 1500);
  const tail = log && !errors.lines.length ? `\n\nThe end of the build log:\n\n\`\`\`\n${log.split('\n').slice(-40).join('\n').slice(0, 3000)}\n\`\`\`` : '';
  const retry = earlier ? `\n\nA fixer already tried this failure (${earlier} time${earlier === 1 ? '' : 's'}) and the build still fails the same way: read what it changed (git log on beta) and find what it missed.` : '';
  const request = `Beta's build ${r.build} ${r.version} of ${r.product} failed because of the code (commit ${sha} on beta). Studio built it, the compiler/build command reported:

\`\`\`
${lines.slice(0, 4000)}
\`\`\`${tail}${blame}${retry}

Make beta build again: fix these errors at their cause (for Unity C#, a CS0102 or CS0111 means two definitions of one member or type: find both, keep one, and check the other files of that class, partial classes included). Do not change the build setup or Studio's files. Branch from beta (this branch does) and open a pull request into beta; when it merges, Studio rebuilds beta by itself.

<!-- ${fixMarker(sig)} -->`;
  const first = errors.lines[0] ?? String(r.detail ?? '');
  return { request, title: `Fix build: ${first.replace(/^.*?error /, '').slice(0, 90)}` };
}

/**
 * What agents are told to run before opening a pull request, from the project's build (agents.ts brief, step 4): its
 * listed checks are the agent's own; a Unity project also has a compile that only the build server can do, so the agent
 * looks for what the compiler would report, and says in the PR description which it could run and which not.
 */
export function buildCheckBrief(p: { engine?: string; build?: unknown; builds?: { tool?: string; id?: string; command?: string }[] | null; checks?: { cmd: string }[] | null }): string {
  const unity = p.engine === 'unity' || Boolean(p.build) || Boolean(p.builds?.some((b) => b.tool === 'unity'));
  const others = (p.builds ?? []).filter((b) => b.tool !== 'unity' && b.command);
  if (!unity && !others.length) return '';
  const out = ['   Before the pull request, also run the project\'s build or compile check where you can, and say in the PR description which you ran and which you could not (and why).'];
  if (unity) {
    out.push(
      '   Unity: the compiler runs on the build server, not here. Before you open the PR, read the C# you changed for what it would reject:',
      '   a member or type defined twice (error CS0102/CS0111: the same name in one class, partial classes in other files included; `grep -rn "<Name>" Assets` for every type or method you added or renamed),',
      '   a missing `using`, a call whose signature you changed but not its callers, and any `error CS` text in the brief. If a Unity editor (`unity-editor`/`Unity -batchmode -quit`) is on this machine, compile with it; if not, say "Unity compile not run here" in the PR description.',
    );
  }
  for (const b of others) out.push(`   Build \`${b.id}\`: run \`${b.command}\` if it can run here.`);
  return out.join('\n');
}
