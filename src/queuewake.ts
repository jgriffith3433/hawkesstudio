// Gates wake the queue themselves (architecture §11, step 4). A gate that holds queued work (a pending deploy, a
// customer's plan or AI link) says so here the moment it opens, and the queue (agents.ts) looks again then, instead of
// a timer finding out later. Kept apart from agents.ts so a gate can tell it without importing the queue.

const wakers: ((why: string) => void)[] = [];
/** The queue listens (agents.ts registers its pump). */
export function onQueueWake(fn: (why: string) => void) { wakers.push(fn); }
/** A gate opened: the queue looks again now. */
export function queueWake(why: string) { for (const w of wakers) { try { w(why); } catch { /* a listener's own problem */ } } }
