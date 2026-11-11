// One Unity build per product at a time, in Hawkes Gen (J, 2026-11-11: "THERE SHOULD NEVER BE THAT MANY QUEUED BUILDS").
// That day 77 Unity builds (8 vCPU Cloud Run job executions, hawkes-unity-build-customer and hawkes-unity-build, us-west1)
// sat queued though the milestone rule (unitybuild-policy.ts) and the build line (buildline.ts) were live: every compile
// check went to Gen outside both, a wait that timed out left its Gen job running with nobody waiting for it, and a restart
// forgot a compile check's job and submitted another.
//
// Every Unity build Studio makes, of any kind (a player build, a package build, a compile check, a retry, a restart's),
// is a Gen `unity.build` job made by gen.ts genRun, and genRun sends each one through here. Per product:
// - at most ONE unity.build job outstanding (submitted, not ended), whoever asked;
// - a request of the same identity (commit, compile check or player build, project path) joins it: no second job, the
//   same result;
// - any other request waits for the slot, and at most one waits. A newer request replaces the one waiting, which ends at
//   once as superseded (status cancelled, halted: every caller already treats that as "not built", never a failure);
// - a build a person asked for (or the go-live release, a build-* tag) waits like any other, but no automatic request
//   ever replaces it: the automatic one ends superseded instead;
// - Studio never leaves a job behind: when the wait on a job ends for any reason but the job ending (its timeout, a halt,
//   an error), the job is cancelled;
// - Gen is the ground truth across restarts: before a submit, Gen's queued and running unity.build jobs of the product
//   that nothing in this process follows are adopted (the same identity: a restart carrying on) or cancelled.
// The slot passes on when its job's wait settles (an event), never on a timer: no polling, no watchdog. In memory: after a
// restart, the submit-time look at Gen stands for what came before.

export type UnityPriority = 'person' | 'auto';

export type UnitySlotRequest = {
  /** Studio's product id (the project genRun passes Gen). */
  product: string;
  params: Record<string, unknown>;
  /** person: asked for by a person, the go-live release, a build-* tag. Never replaced by an automatic request. */
  priority?: UnityPriority;
  /** A Gen job this request submitted before (a Studio restart): followed instead of submitting again. */
  reuse?: string;
  /** Studio's own reason to stop (a cancelled run, a newer commit): looked at before submitting and while waiting. */
  halt?: () => string | null;
  /** The new job's id, as soon as Gen gives it (or the id of the job adopted for it). */
  onSubmit?: (id: string) => void;
  /** The params again, made fresh (a new GitHub token) for a request that waited for its turn. */
  paramsNow?: () => Promise<Record<string, unknown>>;
};

export type UnitySlotDeps = {
  /** Submits a unity.build with these params; Gen's job. */
  submit(params: Record<string, unknown>): Promise<any>;
  /** Waits for a job (gen.ts genWait): never throws for a failed job; timedOut / halted when the wait stopped first. */
  wait(id: string, onUpdate: (job: any) => void): Promise<any>;
  /** One job's state now. */
  job(id: string): Promise<any>;
  /** Gen's queued and running unity.build jobs of this product (each with params where Gen gives them). */
  outstanding(): Promise<any[]>;
  cancel(id: string, why: string): Promise<unknown>;
};

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

type Holder = { key: string; priority: UnityPriority; job: string | null; done: Deferred<any>; updates: Set<(j: any) => void> };
type Waiter = { key: string; priority: UnityPriority; done: Deferred<any>; turn: Deferred<'go' | { superseded: string } | { halted: string }>; halt?: () => string | null; updates: Set<(j: any) => void> };
type Slot = { holder: Holder | null; waiter: Waiter | null };

const slots = new Map<string, Slot>();
let anon = 0;
const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const ended = (j: any) => TERMINAL.has(String(j?.status));

/**
 * What makes two Unity build requests the same build: the commit, a compile check or a player build, and the project path.
 * null: one that can't be matched (no commit: a build of a local folder; a GitHub-mode build that pushes to a site repo).
 */
export function unityIdentity(params: any): string | null {
  const gh = params?.github;
  const sha = typeof gh?.commit === 'string' ? gh.commit.toLowerCase() : '';
  if (!sha || gh.siteRepo || gh.branch) return null;
  return `${params.check ? 'check' : 'build'}|${sha}|${String(params.path ?? params.project ?? '')}`;
}

const short = (key: string) => key.startsWith('once:') ? 'a Unity build' : `${key.split('|')[0] === 'check' ? 'the compile check' : 'the Unity build'} of ${key.split('|')[1].slice(0, 7)}`;

/** The result a request ends with when it never ran: replaced while it waited, or halted before its turn. */
export const supersededJob = (why: string) => ({ id: null, status: 'cancelled', error: why, halted: true, superseded: true }) as any;

const haltedJob = (why: string) => ({ id: null, status: 'cancelled', error: why, halted: true }) as any;

const fanout = (updates: Set<(j: any) => void>) => (j: any) => { for (const f of updates) { try { f(j); } catch (e: any) { console.warn(`[unityslot] update: ${e?.message ?? e}`); } } };

/** Runs one unity.build request through its product's slot. */
export async function unitySlot(req: UnitySlotRequest, deps: UnitySlotDeps, onUpdate?: (job: any) => void): Promise<any> {
  const { product } = req;
  const priority: UnityPriority = req.priority ?? 'auto';
  const key = unityIdentity(req.params) ?? `once:${++anon}`;
  let slot = slots.get(product);
  if (!slot) slots.set(product, (slot = { holder: null, waiter: null }));

  // The same build already in Gen (or being submitted): joined, never made twice.
  const h = slot.holder;
  if (h && (h.key === key || (req.reuse && h.job === req.reuse))) {
    if (req.reuse && h.job && h.job !== req.reuse) await deps.cancel(req.reuse, `Studio already follows ${h.job}, the same build of ${product}`).catch(() => {});
    console.log(`[unityslot] ${product}: ${short(key)} joins the one in Hawkes Gen (${h.job ?? 'being submitted'})`);
    if (onUpdate) h.updates.add(onUpdate);
    return { ...(await h.done.promise) };
  }
  const w0 = slot.waiter;
  if (w0 && w0.key === key) {
    if (priority === 'person') w0.priority = 'person';
    console.log(`[unityslot] ${product}: ${short(key)} joins the one already waiting`);
    if (onUpdate) w0.updates.add(onUpdate);
    return { ...(await w0.done.promise) };
  }

  if (slot.holder && req.reuse) {
    // A job of this request from before a restart, while another holds the slot: one already ended is its answer; one
    // still outstanding is cancelled now (two would be outstanding) and the build is submitted again at its turn.
    const j = await deps.job(req.reuse).catch(() => null);
    if (j && ended(j)) return j;
    await deps.cancel(req.reuse, `another Unity build of ${product} holds Studio's one slot: this one is submitted again at its turn`).catch((e) => console.warn(`[unityslot] ${product}: cancelling ${req.reuse}: ${e?.message ?? e}`));
    // The slot may have moved on during those calls: asked again from the top, as a fresh request.
    return unitySlot({ ...req, reuse: undefined }, deps, onUpdate);
  }
  if (slot.holder) {
    const old = slot.waiter;
    if (old && old.priority === 'person' && priority !== 'person') {
      const why = `superseded: a Unity build of ${product} a person asked for is already waiting, and Studio builds one at a time`;
      console.log(`[unityslot] ${product}: ${short(key)} ends at once: ${why}`);
      return supersededJob(why);
    }
    const w: Waiter = { key, priority, done: deferred(), turn: deferred(), halt: req.halt, updates: new Set(onUpdate ? [onUpdate] : []) };
    if (old) {
      const why = `superseded by ${short(key)}: one Unity build of ${product} at a time, and the newest waiting request replaces the older`;
      console.log(`[unityslot] ${product}: ${short(old.key)} ${why}`);
      old.turn.resolve({ superseded: why });
    }
    slot.waiter = w;
    console.log(`[unityslot] ${product}: ${short(key)} waits for ${short(slot.holder.key)} (${slot.holder.job ?? 'being submitted'})`);
    const t = await w.turn.promise;
    if (t !== 'go') { const r = 'halted' in t ? haltedJob(t.halted) : supersededJob(t.superseded); w.done.resolve(r); return { ...r }; }
    // Its turn: release made it the holder.
    return held(slot, slot.holder!, req, deps, true);
  }
  const me: Holder = { key, priority, job: null, done: deferred(), updates: new Set(onUpdate ? [onUpdate] : []) };
  slot.holder = me;
  return held(slot, me, req, deps, false);
}

/** The holder's work: the look at Gen, the submit (or adoption), the wait; the slot passes on when it settles. */
async function held(slot: Slot, me: Holder, req: UnitySlotRequest, deps: UnitySlotDeps, waited: boolean): Promise<any> {
  try {
    const r = await holdJob(me, req, deps, waited);
    me.done.resolve(r);
    return { ...r };
  } catch (e) {
    me.done.reject(e);
    throw e;
  } finally {
    release(req.product, slot, me);
  }
}

async function holdJob(me: Holder, req: UnitySlotRequest, deps: UnitySlotDeps, waited: boolean): Promise<any> {
  const { product } = req;
  const halted = req.halt?.();
  if (halted) {
    // Halted at its turn: nothing is submitted, and a job from before a restart is not left behind either.
    if (req.reuse) await deps.cancel(req.reuse, halted).catch(() => {});
    return haltedJob(halted);
  }
  // Gen's own word on what is outstanding for this product: anything nobody here follows is left from before (a restart,
  // an older Studio, a wait that gave up). The same build is carried on; anything else is cancelled before the submit.
  let adopt: string | null = null;
  let listed: any[] = [];
  try { listed = (await deps.outstanding()) ?? []; } catch (e: any) { console.warn(`[unityslot] ${product}: asking Hawkes Gen for its Unity builds: ${e?.message ?? e}`); }
  for (const j of listed) {
    const id = j?.id ? String(j.id) : '';
    if (!id || ended(j) || id === req.reuse) continue;
    if (!req.reuse && !adopt && !me.key.startsWith('once:') && unityIdentity(j.params) === me.key) { adopt = id; continue; }
    const why = `left in Hawkes Gen with nobody waiting for it: Studio keeps one Unity build of ${product} at a time (${short(me.key)} is next)`;
    console.log(`[unityslot] ${product}: cancelling ${id}: ${why}`);
    await deps.cancel(id, why).catch((e) => console.warn(`[unityslot] ${product}: cancelling ${id}: ${e?.message ?? e}`));
  }
  let id = req.reuse ?? adopt;
  if (adopt) console.log(`[unityslot] ${product}: carrying on ${adopt}, already ${short(me.key)} in Hawkes Gen`);
  if (!id) {
    const params = waited && req.paramsNow ? await req.paramsNow().catch(() => req.params) : req.params;
    const stop = req.halt?.();
    if (stop) return haltedJob(stop);
    const job = await deps.submit(params);
    id = String(job.id);
  }
  me.job = id;
  if (!req.reuse) req.onSubmit?.(id);
  let r: any;
  try {
    r = await deps.wait(id, fanout(me.updates));
  } catch (e: any) {
    await deps.cancel(id, `Studio stopped waiting for it (${String(e?.message ?? e).slice(0, 120)})`).catch(() => {});
    throw e;
  }
  // The wait stopped before the job ended (its timeout; a halt cancelled it already): Studio never leaves it behind.
  if (!r?.halted && !r?.lost && (r?.timedOut || !ended(r))) {
    console.log(`[unityslot] ${product}: cancelling ${id}: Studio stopped waiting for it (${r?.error ?? r?.status})`);
    await deps.cancel(id, `Studio stopped waiting for it: ${r?.error ?? r?.status ?? 'no answer'}`).catch((e) => console.warn(`[unityslot] ${product}: cancelling ${id}: ${e?.message ?? e}`));
  }
  return r;
}

function release(product: string, slot: Slot, me: Holder) {
  if (slot.holder !== me) return;
  slot.holder = null;
  const next = slot.waiter;
  slot.waiter = null;
  if (next) {
    slot.holder = { key: next.key, priority: next.priority, job: null, done: next.done, updates: next.updates };
    next.turn.resolve('go');
  } else slots.delete(product);
}

/**
 * Something that can halt a waiting request happened (a run cancelled, a newer commit in the build line): the one waiting
 * looks at its halt now and, if halted, leaves at once instead of at its turn. An event, never a timer.
 */
export function nudgeUnitySlot(product?: string) {
  for (const [p, slot] of slots) {
    if (product && p !== product) continue;
    const w = slot.waiter;
    const why = w?.halt?.();
    if (!w || !why) continue;
    slot.waiter = null;
    console.log(`[unityslot] ${p}: ${short(w.key)} leaves the wait: ${why}`);
    w.turn.resolve({ halted: why });
  }
}

/** What a product's slot holds now (logs, the dashboard, tests). */
export function unitySlotState(product: string) {
  const s = slots.get(product);
  return { holder: s?.holder ? { key: s.holder.key, job: s.holder.job, priority: s.holder.priority } : null, waiter: s?.waiter ? { key: s.waiter.key, priority: s.waiter.priority } : null };
}

/** Tests: forget every slot. */
export const resetUnitySlots = () => slots.clear();
