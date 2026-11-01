// Hawkes Gen's live events, from Studio (J, 2026-11-01: "Please stop implementing polling if at all possible it causes
// all the problems"). Gen pushes every change of every job this key may see on GET /v1/events (server-sent events:
// `event: job` with the job's public state, `library`, `production`, and a `: ping` every 20 s). Studio keeps one such
// stream per process, and its waits on Gen jobs (playtests.ts watchGenJob, gen.ts genWait, hawkesgen.mjs wait, the
// parked agent changes of agents.ts, the credit settler) wake on their job's event instead of asking Gen on a timer.
//
// The server allows it (server.ts, start()); it is open only while something wants it: a wait follows a job, a change is
// parked on Gen jobs (agents.ts hold), or the library's pick write-back runs (library.ts followPicks, J's server only,
// which held its own stream before). It closes a minute after the last of them lets go. Gen runs on Cloud Run with no
// minimum instances and a request limit per instance: a stream held while nothing waits would keep Gen awake and take
// one of its request slots for every Studio (each customer's cell too), for nothing. The minute's linger keeps one
// wait after another (a build, then its playtests) on one connection. The CLI and tests never call start(): every
// wait there asks Gen on its timer, as it always did.
//
// What nothing pushes still needs a clock: a wait's limits (run time, no progress, queue time, its timeout) are checked
// by one timer set to the next deadline, and the job is asked for once then before anything is cancelled. While the
// stream is down (Gen restarting, a deploy, an old Gen without /v1/events) waits ask Gen on their old interval.

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

/**
 * While the stream is open, a job nothing has been heard of for this long is asked for once anyway. It stays because a
 * stream can drop an event without closing (a proxy buffering, a half-open connection the ping watchdog hasn't caught
 * yet, an event Gen emitted between our reconnect's GET and its subscription): five minutes bounds how long a wait can
 * miss its job finishing, at one GET per waited job per five minutes, not one every two seconds.
 */
export const SAFETY_MS = () => Number(process.env.STUDIO_GEN_EVENTS_SAFETY_MS) > 0 ? Number(process.env.STUDIO_GEN_EVENTS_SAFETY_MS) : 5 * 60_000;

export type GenEventApi = { request(path: string, opts?: any): Promise<any>; job(id: string): Promise<any> };

/** One wait's view of its job's events. */
export interface JobFollow {
  /** The job's next event (its public state), or null once ms have passed or the stream came up or went down. */
  next(ms: number): Promise<any | null>;
  /** Whether Gen's events are arriving now: a wait may then sleep until its next deadline. */
  live(): boolean;
  /** Forgets an event that came in before a fresh GET (the GET is at least as new). */
  drop(): void;
  close(): void;
}
export interface JobFollower { follow(id: string): JobFollow }

const MAX_TIMER = 2 ** 31 - 1;
const sleep = (ms: number) => new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, Math.min(MAX_TIMER, ms))));

/** No stream (tests with a stand-in Gen, the CLI): every wait sleeps its interval and asks again, as before. */
export const noEvents: JobFollower = { follow: () => ({ next: sleep, live: () => false, drop() {}, close() {} }) };

/**
 * When a wait must look at its job again: with the stream live, at the next deadline or the safety check (SAFETY_MS
 * after it last heard of the job); without it, after pollMs, as before. localMs: a check that costs Gen nothing (a run
 * halted, a newer build waiting: Studio's own database) keeps its old cadence, without asking Gen.
 */
export function nextLook(live: boolean, { now = Date.now(), pollMs, heard, deadlines = [], localMs }: { now?: number; pollMs: number; heard: number; deadlines?: number[]; localMs?: number }) {
  const due = live ? Math.min(heard + SAFETY_MS(), ...deadlines.filter((d) => Number.isFinite(d))) : now + pollMs;
  const wake = localMs ? Math.min(due, now + localMs) : due;
  return { due, ms: Math.max(0, wake - now) };
}
export const terminal = (j: any) => TERMINAL.has(String(j?.status));

type Sub = { id: string; latest: any | null; poke: boolean; wake: ((j: any | null) => void) | null };
type Listener = (type: string, data: any) => void;

export type GenEventsOptions = {
  /** Waits between reconnects, in order (the last repeats). */
  backoffMs?: number[];
  /** No byte (not even Gen's 20 s ping) for this long: the connection is taken as dead and opened again. */
  stallMs?: number;
  /** An old Gen without /v1/events (404): tried again this much later; waits ask Gen on their timer meanwhile. */
  unsupportedRetryMs?: number;
  /** How long the stream stays open after the last wait (and hold) let go. */
  lingerMs?: number;
};

export class GenEvents implements JobFollower {
  private subs = new Map<string, Set<Sub>>();
  private holds = new Set<string>();
  private listeners = new Set<Listener>();
  private connectListeners = new Set<() => void>();
  private ctrl: AbortController | null = null;
  private retry: { timer: NodeJS.Timeout; done: () => void } | null = null;
  private linger: NodeJS.Timeout | null = null;
  private enabled = false;
  private isLive = false;
  private loop: Promise<void> | null = null;
  /** An old Gen said it has no /v1/events: not asked again before this (a later wait included). */
  private unsupportedUntil = 0;
  readonly stats = { connects: 0, events: 0, refetches: 0, lastError: '' as string, unsupported: false };
  private readonly api: () => GenEventApi;
  private readonly opts: GenEventsOptions;

  constructor(api: GenEventApi | (() => GenEventApi), opts: GenEventsOptions = {}) {
    this.api = typeof api === 'function' ? api : () => api;
    this.opts = opts;
  }

  /** Allows the stream: it opens whenever something wants it (a wait, a hold). The server calls it once; nothing else should. */
  start() {
    if (this.enabled) return;
    this.enabled = true;
    this.demand();
  }

  async stop() {
    this.enabled = false;
    this.close();
    await this.loop?.catch(() => {});
  }

  /** Keeps the stream open for something that isn't one job's wait (parked changes, the library's picks) until release(key). */
  hold(key: string) {
    if (this.holds.has(key)) return;
    this.holds.add(key);
    this.demand();
  }
  release(key: string) {
    if (this.holds.delete(key)) this.demand();
  }

  private get wanted() { return this.enabled && (this.subs.size > 0 || this.holds.size > 0); }

  /** Opens the stream when wanted; closes it lingerMs after nothing wants it. */
  private demand() {
    if (this.wanted) {
      if (this.linger) { clearTimeout(this.linger); this.linger = null; }
      if (!this.loop) {
        this.loop = this.run().finally(() => {
          this.loop = null;
          if (this.wanted) this.demand();
        });
      }
    } else if (this.loop && !this.linger) {
      this.linger = setTimeout(() => { this.linger = null; if (!this.wanted) this.close(); }, this.opts.lingerMs ?? 60_000);
      this.linger.unref?.();
    }
  }

  private close() {
    if (this.linger) { clearTimeout(this.linger); this.linger = null; }
    this.ctrl?.abort();
    if (this.retry) { clearTimeout(this.retry.timer); this.retry.done(); }
  }

  live() { return this.isLive; }
  /** Whether the server allowed the stream (start()). */
  get started() { return this.enabled; }

  follow(id: string): JobFollow {
    const sub: Sub = { id, latest: null, poke: false, wake: null };
    let set = this.subs.get(id);
    if (!set) this.subs.set(id, (set = new Set()));
    set.add(sub);
    this.demand();
    return {
      next: (ms: number) => {
        if (sub.latest) {
          const j = sub.latest;
          sub.latest = null;
          sub.poke = false;
          return Promise.resolve(j);
        }
        if (sub.poke) {
          sub.poke = false;
          return Promise.resolve(null);
        }
        return new Promise((resolve) => {
          const t = setTimeout(() => { sub.wake = null; resolve(null); }, Math.max(0, Math.min(MAX_TIMER, ms)));
          sub.wake = (j) => { clearTimeout(t); sub.wake = null; resolve(j); };
        });
      },
      live: () => this.isLive,
      drop: () => { sub.latest = null; },
      close: () => {
        sub.wake?.(null);
        const s = this.subs.get(id);
        if (!s?.delete(sub)) return;
        if (!s.size) this.subs.delete(id);
        this.demand();
      },
    };
  }

  /** Every event (job, library, production) while the stream is open. Returns stop(). */
  onEvent(cb: Listener) {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }
  /** Called each time the stream (re)opens, after the jobs waited on were asked for again: anything missed is caught up. */
  onConnect(cb: () => void) {
    this.connectListeners.add(cb);
    return () => void this.connectListeners.delete(cb);
  }

  /** Jobs some wait follows now. */
  watched() { return [...this.subs.keys()]; }

  /** Hands a job's state to its waits (an event, or a GET after a reconnect). */
  private deliver(job: any) {
    const set = job?.id ? this.subs.get(String(job.id)) : null;
    if (!set) return;
    for (const sub of set) {
      if (sub.wake) sub.wake(job);
      else sub.latest = job;
    }
  }

  private setLive(v: boolean) {
    if (this.isLive === v) return;
    this.isLive = v;
    // Every wait recomputes how long it sleeps: a long sleep with the stream down would miss its job.
    for (const set of this.subs.values()) for (const sub of set) {
      if (sub.wake) sub.wake(null);
      else sub.poke = true;
    }
  }

  /** On (re)connect: one GET per job waited on, so a change while the stream was down isn't lost. */
  private async refetch() {
    for (const id of this.watched()) {
      if (!this.isLive) return;
      try {
        const j = await this.api().job(id);
        this.stats.refetches++;
        if (j) this.deliver(j);
      } catch { /* the wait's own GET or the safety check catches it */ }
    }
    for (const cb of this.connectListeners) try { cb(); } catch (e: any) { console.warn(`[gen-events] on connect: ${e?.message ?? e}`); }
  }

  private emit(type: string, raw: string) {
    let data: any;
    try { data = JSON.parse(raw); } catch { return; }
    this.stats.events++;
    if (type === 'job') this.deliver(data);
    for (const cb of this.listeners) try { cb(type, data); } catch (e: any) { console.warn(`[gen-events] ${type} listener: ${e?.message ?? e}`); }
  }

  private async run() {
    const backoff = this.opts.backoffMs ?? [1000, 2000, 5000, 10_000, 30_000];
    const stallMs = this.opts.stallMs ?? 70_000;
    let attempt = 0;
    while (this.wanted) {
      if (Date.now() < this.unsupportedUntil) {
        await this.pause(this.unsupportedUntil - Date.now());
        continue;
      }
      const ctrl = (this.ctrl = new AbortController());
      let unsupported = false;
      let dog: NodeJS.Timeout | null = null;
      try {
        const r = await this.api().request('/events', { raw: true, signal: ctrl.signal });
        if (!r?.body) throw new Error('no event stream');
        if (attempt > 0 || !this.stats.connects) console.log(`[gen-events] ${this.stats.connects ? 'reconnected to' : 'following'} Hawkes Gen's job events`);
        attempt = 0;
        this.stats.connects++;
        this.stats.unsupported = false;
        let heard = Date.now();
        dog = setInterval(() => { if (Date.now() - heard > stallMs) ctrl.abort(); }, Math.max(50, Math.floor(stallMs / 4)));
        dog.unref?.();
        this.setLive(true);
        void this.refetch();
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          heard = Date.now();
          buf += dec.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let type = 'message';
            const data: string[] = [];
            for (const line of block.split('\n')) {
              if (!line || line.startsWith(':')) continue;
              const c = line.indexOf(':');
              const field = c < 0 ? line : line.slice(0, c);
              const val = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
              if (field === 'event') type = val;
              else if (field === 'data') data.push(val);
            }
            if (data.length) this.emit(type, data.join('\n'));
          }
        }
        this.stats.lastError = 'stream closed';
      } catch (e: any) {
        // An old Gen (no /v1/events): waits ask on their timer; it is tried again much later.
        unsupported = [404, 405, 501].includes(Number(e?.status));
        if (unsupported) this.unsupportedUntil = Date.now() + (this.opts.unsupportedRetryMs ?? 10 * 60_000);
        if (unsupported && !this.stats.unsupported) console.warn(`[gen-events] Hawkes Gen has no event stream (HTTP ${e.status}): waits ask it on their timer`);
        this.stats.unsupported = unsupported;
        if (this.wanted) {
          this.stats.lastError = String(e?.message ?? e).slice(0, 200);
          // Once per outage, not once per retry.
          if (!unsupported && attempt === 0) console.warn(`[gen-events] stream down (${this.stats.lastError}); waits ask Gen on their timer until it is back`);
        }
      } finally {
        if (dog) clearInterval(dog);
        this.setLive(false);
      }
      if (!this.wanted) break;
      // Unsupported: the top of the loop waits until it may ask again.
      if (!unsupported) await this.pause(backoff[Math.min(attempt++, backoff.length - 1)]);
    }
  }

  /** A wait between tries that close() ends at once. */
  private pause(ms: number) {
    return new Promise<void>((done) => {
      const timer = setTimeout(() => { this.retry = null; done(); }, Math.max(0, Math.min(MAX_TIMER, ms)));
      timer.unref?.();
      this.retry = { timer, done: () => { clearTimeout(timer); this.retry = null; done(); } };
    });
  }
}
