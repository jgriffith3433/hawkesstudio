// One build of each kind per project at a time, and at most one waiting behind it (J, 2026-11-11: "if we are building
// let's not have so many builds of the same product in a queue"). On Nov 10-11 about 20 Unity builds of a few projects
// were queued at once (a change's verify, every push to beta, every beta run after a merge), each its own 8 vCPU job,
// and they used up the region's CPU quota so Studio's own server couldn't start.
//
// A line is one kind of build of one project on one lane: `<project>|<build>|<lane>` (lane: the branch or tag it builds,
// or `c/<change>` for a change's own preview). Every build start goes through it (builds.ts buildOne), and:
// - nothing in the line: the start builds now;
// - the same commit already building, or already waiting: the start joins it and ends with it (no second build);
// - another commit building: the start waits behind it. A newer start replaces the one waiting (that one ends at once,
//   "superseded by the build of <sha>"), so a burst of merges makes one build that is running and one of the newest
//   commit after it, never one per merge;
// - the one building is told of the newer commit (onNewer): a build that hasn't really started yet (queued in Hawkes Gen)
//   gives way to it there and then.
// The next build starts when the one before it ends (its own end hands over the turn): no timer, no polling, no watcher.
// In memory: after a restart the resumed builds take their turns again (builds.ts resumeRun), and the database's own
// "already building" check stands for anything older.

export type Outcome = { superseded?: string };
export type Turn = {
  /** The commit a newer start asked for while this one builds, or null. */
  newer: () => string | null;
  /** Told when a newer commit queues behind this build (once per newer commit). */
  onNewer: (fn: (sha: string) => void) => void;
  /** This build is over (done, failed or cancelled): those that joined it end, and the one waiting starts. Idempotent. */
  end: () => void;
};
export type Entry =
  | { how: 'go'; turn: Turn }
  | { how: 'joined'; sha: string; building: boolean; done: Promise<Outcome> }
  | { how: 'queued'; behind: string; turn: Promise<Turn | { superseded: string }> };

type Running = { sha: string; done: Promise<Outcome>; finish: (o: Outcome) => void; newer: string | null; listeners: ((sha: string) => void)[]; ended: boolean };
type Waiting = { sha: string; done: Promise<Outcome>; finish: (o: Outcome) => void; go: (t: Turn | { superseded: string }) => void };
type Line = { running: Running | null; waiting: Waiting | null };

const lines = new Map<string, Line>();

/** The line a build start belongs to. */
export const lineKey = (project: string, build: string, lane: string) => `${project}|${build}|${lane}`;

function settle<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function startTurn(key: string, line: Line, sha: string, done = settle<Outcome>()): Turn {
  const run: Running = { sha, done: done.promise, finish: done.resolve, newer: null, listeners: [], ended: false };
  line.running = run;
  return {
    newer: () => run.newer,
    onNewer: (fn) => { run.listeners.push(fn); if (run.newer) fn(run.newer); },
    end: () => {
      if (run.ended) return;
      run.ended = true;
      run.finish({});
      if (line.running === run) line.running = null;
      const next = line.waiting;
      line.waiting = null;
      if (next) next.go(startTurn(key, line, next.sha, { promise: next.done, resolve: next.finish }));
      else if (!line.running) lines.delete(key);
    },
  };
}

/**
 * A build of `sha` asks for its turn in its line. retry: Studio building a failed build again by itself (it waits like any
 * start, but never replaces one already waiting). now: it is already building (a restart carrying on its Gen job), so it
 * takes the line without waiting; anything already in the line is left as it is.
 */
export function enterLine(key: string, sha: string, o: { now?: boolean; retry?: boolean } = {}): Entry {
  let line = lines.get(key);
  if (!line) lines.set(key, (line = { running: null, waiting: null }));
  // Carrying on after a restart: its Gen job is already there, so it never waits or joins (it would leave that job unwatched).
  if (o.now) return { how: 'go', turn: line.running ? { newer: () => null, onNewer: () => {}, end: () => {} } : startTurn(key, line, sha) };
  if (line.running && line.running.sha === sha) return { how: 'joined', sha, building: true, done: line.running.done };
  if (line.waiting && line.waiting.sha === sha) return { how: 'joined', sha, building: false, done: line.waiting.done };
  if (!line.running) return { how: 'go', turn: startTurn(key, line, sha) };
  // A retry of an older commit never pushes out a start that is already waiting: that one was asked for later (beta's
  // newer head), and building it covers the retry's commit too.
  if (o.retry && line.waiting) return { how: 'queued', behind: line.running.sha, turn: Promise.resolve({ superseded: line.waiting.sha }) };
  // A newer commit: the one waiting (if any) is pointless now, and ends at once.
  const old = line.waiting;
  if (old) { old.finish({ superseded: sha }); old.go({ superseded: sha }); }
  const done = settle<Outcome>();
  const turn = settle<Turn | { superseded: string }>();
  line.waiting = { sha, done: done.promise, finish: done.resolve, go: turn.resolve };
  const running = line.running;
  if (running.newer !== sha) {
    running.newer = sha;
    for (const fn of running.listeners) { try { fn(sha); } catch (e: any) { console.warn(`[buildline] ${key}: ${e?.message ?? e}`); } }
  }
  return { how: 'queued', behind: running.sha, turn: turn.promise };
}

/** What a line holds now: the commit building and the one waiting (for the dashboard, logs and tests). */
export function lineState(key: string): { building: string | null; waiting: string | null } {
  const l = lines.get(key);
  return { building: l?.running?.sha ?? null, waiting: l?.waiting?.sha ?? null };
}

/** Every line that holds something now. */
export const linesNow = () => [...lines.keys()].map((key) => ({ key, ...lineState(key) }));

/** Tests: forget every line. */
export const resetLines = () => lines.clear();
