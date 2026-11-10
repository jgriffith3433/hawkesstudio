// What each person has seen in the Activity panel (J, 2026-11-10: "How do we make that go away after 'seeing' it").
//
// The header's "N failed" counts failures (a go live, rollback or merge that failed; a scout that failed) the person
// hasn't seen yet: opening the panel marks everything in it seen (seen_at), so the red count goes away. "Clear" hides
// what has finished from the panel (cleared_at): the items stay in the database, under "Show cleared".
// Kept per person on the server (so the phone and the desktop agree), and pushed: a change sends the stream's
// "activity-seen" event and each page fetches its own person's state (no timer, J 2026-11-02).

import { db } from './db.ts';

db.exec(`CREATE TABLE IF NOT EXISTS activity_seen (user TEXT PRIMARY KEY, seen_at INTEGER NOT NULL DEFAULT 0, cleared_at INTEGER NOT NULL DEFAULT 0)`);

export type Seen = { seenAt: number; clearedAt: number };
/** A failure the panel lists: its key (op:<id>, scout:<id>) and when it ended. */
export type Failure = { key: string; at: number };

/** Who is looking: the signed-in person's id or email; the owner's key and Studio's own processes are "owner". */
export const viewerKey = (u: { id?: string | null; email?: string | null } | null | undefined) => String(u?.id ?? u?.email ?? 'owner').slice(0, 200);

export function seenOf(user: string): Seen {
  const r = db.prepare('SELECT seen_at, cleared_at FROM activity_seen WHERE user = ?').get(user) as any;
  return { seenAt: r?.seen_at ?? 0, clearedAt: r?.cleared_at ?? 0 };
}

/** The person opened the panel (or it was open when something new came in): everything up to `at` is seen. */
export function markSeen(user: string, at = Date.now()): Seen {
  db.prepare('INSERT INTO activity_seen (user, seen_at) VALUES (?, ?) ON CONFLICT(user) DO UPDATE SET seen_at = MAX(seen_at, excluded.seen_at)').run(user, at);
  return seenOf(user);
}

/** "Clear": what finished up to `at` leaves the panel (and is seen). `at` 0 brings everything back. */
export function clearActivity(user: string, at = Date.now()): Seen {
  db.prepare('INSERT INTO activity_seen (user, seen_at, cleared_at) VALUES (?, ?, ?) ON CONFLICT(user) DO UPDATE SET cleared_at = excluded.cleared_at, seen_at = MAX(seen_at, excluded.seen_at)').run(user, at, at);
  return seenOf(user);
}

/** The failures this person hasn't seen (the header's red count). The page runs the same rule (dashboard/activity.js). */
export const unseen = (failures: Failure[] | null | undefined, s: Seen) => (failures ?? []).filter((f) => f.at > Math.max(s.seenAt, s.clearedAt));
