// "Something finished: tell its origin now" (followup.ts). Change and run status writes call kickFollowups(), and the
// follow-up look runs at once instead of on its next timed look (it was every 10 s: J 2026-11-01, "stop implementing
// polling if at all possible"). Its own module so agents.ts, pipeline.ts and the rest can call it without importing
// followup.ts (which imports talk.ts).
import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
let pending: NodeJS.Timeout | null = null;

/** A change or run's status was written: the follow-up look runs shortly (writes in one burst share one look). */
export function kickFollowups() {
  if (pending || !bus.listenerCount('due')) return;
  pending = setTimeout(() => { pending = null; bus.emit('due'); }, 150);
  pending.unref?.();
}

export function onFollowupsDue(fn: () => void) {
  bus.on('due', fn);
  return () => bus.off('due', fn);
}
