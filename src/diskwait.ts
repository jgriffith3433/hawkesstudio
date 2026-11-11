// Changes waiting for disk room (agents.ts waitForDisk) wake when room may have freed, never on a polling timer (J,
// 2026-11-10: "Please stop implementing polling", and the agents should catch themselves). Room frees when a pass ends
// (its process and memory go; on Cloud Run without a disk the files are memory too), a change's worktree is removed
// (agents.ts cleanup), or a sweep clears files (disksweep.ts diskFreed). Until one of those happens, a waiting change
// isn't tried again: trying it would sweep and fail the same way. Before, each waiting change got its own 5 minute
// timer: on 2026-11-10 at 23:03, 104 changes waited for disk room and every 5 minutes each was tried again whether
// anything had freed or not.
//
// The wait also carries its own deadline (J, 2026-11-11: "they need to catch it themselves (no watch dog or
// supervisor)"). Memory and disk can free without any event Studio sees: a Talk or harness process outside the queue
// ends, the kernel drops cache, a file another part wrote goes. That is the one thing only time can tell, so the wait
// that starts with the first hold arms ONE deadline (DISK_WAIT_DEADLINE_MS after it), and it is cleared the moment the
// wait ends by an event. If it comes first, the wait ends by itself exactly as if room had freed: every waiting change
// may look once more, and the queue is woken once (never one timer per change, never a repeating one).

/** How long a disk wait lasts at most before the waiting changes look again by themselves (STUDIO_DISK_WAIT_DEADLINE_MS; 15 min). */
export const DISK_WAIT_DEADLINE_MS = () => Number(process.env.STUDIO_DISK_WAIT_DEADLINE_MS) > 0 ? Number(process.env.STUDIO_DISK_WAIT_DEADLINE_MS) : 15 * 60_000;

export type DiskWaits = {
  /** The change waits for disk room until room may have freed, or the wait's deadline. */
  hold(id: string): void;
  /** Whether it still waits. */
  holds(id: string): boolean;
  /** Room may have freed: every waiting change is free to try again, and the queue is woken once. */
  freed(why?: string): boolean;
  /**
   * A change's pass ended. If it ended by going back to wait for disk room (it never got any), nothing freed: the
   * others stay held and nothing wakes. Otherwise its worktree and process went, so room may have freed (freed).
   */
  passEnded(id: string, why?: string): boolean;
  /** Drop every hold. */
  clear(): void;
  size(): number;
  /** When the current wait ends by itself if no event ends it first (ms), or null with nothing waiting. */
  deadline(): number | null;
};

export function diskWaits(wake: (why: string) => void, o: { deadlineMs?: () => number } = {}): DiskWaits {
  const deadlineMs = o.deadlineMs ?? DISK_WAIT_DEADLINE_MS;
  let epoch = 0;
  const held = new Map<string, number>();
  // The current wait's one deadline: armed by its first hold, cleared when the wait ends.
  let due: { at: number; t: ReturnType<typeof setTimeout> } | null = null;
  const disarm = () => { if (due) clearTimeout(due.t); due = null; };
  const freed = (why = 'disk room may have freed') => {
    disarm();
    if (!held.size) return false;
    epoch++;
    held.clear();
    wake(why);
    return true;
  };
  const arm = () => {
    if (due) return;
    const at = Date.now() + deadlineMs();
    const t = setTimeout(() => { due = null; freed(`the disk wait reached its deadline (${Math.round(deadlineMs() / 60_000)} min): the waiting changes look again`); }, Math.max(0, at - Date.now()));
    t.unref?.();
    due = { at, t };
  };
  const holds = (id: string) => held.has(id) && held.get(id) === epoch && (due == null || due.at > Date.now());
  return {
    hold: (id) => { held.set(id, epoch); arm(); },
    holds,
    freed,
    passEnded: (id, why) => (holds(id) ? false : freed(why ?? `${id}'s pass ended`)),
    clear: () => { disarm(); held.clear(); },
    size: () => held.size,
    deadline: () => (held.size && due ? due.at : null),
  };
}
