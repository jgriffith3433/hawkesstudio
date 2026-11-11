// The Home tab's data (GET /api/home): per game, what needs the owner, what's running, what's ready to ship.
// Read straight from tables and the Inbox, nothing slow (no git, no GitHub): the page refetches it only when the push
// stream (/api/stream: inbox, changes, runs, builds, ops, activity) says something moved, never on a timer.
//   needs you: Inbox items of that game (questions, budgets, merges, approvals, milestones)
//   running:   agent changes in flight, runs with a running step, scouts, build runs
//   ready:     roadmap tasks verified on beta and not live yet (what a go live would ship)

import { db } from './db.ts';
import { loadProducts } from './config.ts';
import { inbox } from './inbox.ts';

export type HomeGame = {
  id: string; name: string;
  needs: number; running: number; ready: number;
  /** Visible changes (scenes, art, UI, shaders, content) merged into beta that no milestone play has captured yet (target 0). */
  uncaptured: number;
  /** A few plain lines per column, newest first, for the card's details. */
  needsList: { title: string; blocks: string }[];
  runningList: string[];
  readyList: string[];
  uncapturedList: string[];
};

/** Merged visible changes with no capture yet, per product. Docs, test and server-only changes were never marked visible. */
export function uncapturedChanges(): { product: string; title: string | null }[] {
  return db.prepare(`SELECT product, title FROM changes WHERE status = 'merged' AND json_extract(verify, '$.visible') = 1 AND json_extract(verify, '$.capture') IS NULL ORDER BY merged_at DESC`).all() as any[];
}

const cap = <T>(a: T[], n = 5) => a.slice(0, n);

export async function home() {
  const items = await inbox().catch(() => []);
  const changes = db.prepare(`SELECT product, title, status FROM changes WHERE status IN ('queued', 'working', 'verifying', 'revising') ORDER BY created`).all() as any[];
  const runs = db.prepare(`SELECT s.product AS product, s.kind AS kind, s.name AS name, r.id AS run FROM steps s JOIN runs r ON r.id = s.run WHERE r.status = 'running' AND s.status = 'running'`).all() as any[];
  let scouts: any[] = [];
  try { scouts = db.prepare(`SELECT product, question FROM scouts WHERE status = 'running'`).all() as any[]; } catch { /* the table is made when the first scout starts */ }
  const verified = db.prepare(`SELECT product, title FROM tasks WHERE status = 'verified' ORDER BY verified_at DESC`).all() as any[];

  const unseen = uncapturedChanges();
  const games: HomeGame[] = loadProducts().map((p) => {
    const needsList = items.filter((i) => i.product === p.id).map((i) => ({ title: i.title, blocks: i.blocks }));
    const runningList = [
      ...changes.filter((c) => c.product === p.id).map((c) => `${c.title ?? 'A change'} (${c.status})`),
      ...runs.filter((r) => r.product === p.id).map((r) => `${r.kind} ${r.name}`.trim()),
      ...scouts.filter((s) => s.product === p.id).map((s) => `Scout: ${String(s.question).slice(0, 80)}`),
    ];
    const readyList = verified.filter((t) => t.product === p.id).map((t) => t.title as string);
    const uncapturedList = unseen.filter((u) => u.product === p.id).map((u) => u.title ?? 'A change');
    return {
      id: p.id, name: p.name,
      needs: needsList.length, running: runningList.length, ready: readyList.length, uncaptured: uncapturedList.length, uncapturedList: cap(uncapturedList),
      needsList: cap(needsList), runningList: cap(runningList), readyList: cap(readyList),
    };
  });
  // Anything not tied to a game (Studio's own questions) gets its own "Studio" card, so the total always has a list.
  const looseItems = items.filter((i) => !i.product || !games.some((g) => g.id === i.product));
  if (looseItems.length) {
    const needsList = looseItems.map((i) => ({ title: i.title, blocks: i.blocks }));
    games.push({ id: 'studio', name: 'Studio', needs: needsList.length, running: 0, ready: 0, uncaptured: 0, needsList: cap(needsList), runningList: [], readyList: [], uncapturedList: [] });
  }
  const sum = (k: 'needs' | 'running' | 'ready' | 'uncaptured') => games.reduce((n, g) => n + g[k], 0);
  const loose = looseItems.length;
  return { at: Date.now(), games, totals: { needs: sum('needs'), running: sum('running'), ready: sum('ready'), uncaptured: sum('uncaptured') }, loose };
}
