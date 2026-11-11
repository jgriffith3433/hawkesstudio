// Changes waiting for disk room (agents.ts waitForDisk) wake when room may have freed, never on a timer (J, 2026-11-10:
// "Please stop implementing polling", and the agents should catch themselves). Room frees when a pass ends (its process
// and memory go; on Cloud Run without a disk the files are memory too) or a sweep clears files (disksweep.ts
// diskFreed). Until one of those happens, a waiting change isn't tried again: trying it would sweep and fail the same
// way. Before, each waiting change got its own 5 minute timer: on 2026-11-10 at 23:03, 104 changes waited for disk room
// and every 5 minutes each was tried again whether anything had freed or not.

export type DiskWaits = {
  /** The change waits for disk room until room may have freed. */
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
  /** Drop every hold (the queue's own check). */
  clear(): void;
  size(): number;
};

export function diskWaits(wake: (why: string) => void): DiskWaits {
  let epoch = 0;
  const held = new Map<string, number>();
  const freed = (why = 'disk room may have freed') => {
    if (!held.size) return false;
    epoch++;
    held.clear();
    wake(why);
    return true;
  };
  return {
    hold: (id) => void held.set(id, epoch),
    holds: (id) => held.has(id) && held.get(id) === epoch,
    freed,
    passEnded: (id, why) => (held.has(id) && held.get(id) === epoch ? false : freed(why ?? `${id}'s pass ended`)),
    clear: () => held.clear(),
    size: () => held.size,
  };
}
