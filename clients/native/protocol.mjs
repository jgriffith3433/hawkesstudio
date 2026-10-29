// The runner's side of the native playtest transport: message parsing, request/reply matching, and what the game
// pushed (state timeline, events, logs, the report). Transport-agnostic: give it a send(text) and feed it text.
// Spec: hawkesstudio/docs/playtest.md ("The native transport").

import { EventEmitter } from 'node:events';

export const VERSION = 2;
export const SUPPORTED = [2];
export const CLOSE = { normal: 1000, version: 4000, noHello: 4001, protocol: 4002 };
const BAD_MESSAGES_BEFORE_CLOSE = 10;
const TIMELINE_MAX = 5000;
const LOGS_MAX = 2000;
const EVENTS_MAX = 2000;

/** Parses one text frame: { ok: true, msg } or { ok: false, error }. */
export function parseMessage(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not JSON' };
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { ok: false, error: 'not a JSON object' };
  if (typeof msg.type !== 'string' || !msg.type) return { ok: false, error: 'no type' };
  return { ok: true, msg };
}

/** Checks a hello: null when fine, else why not. */
export function helloProblem(msg) {
  if (typeof msg.version !== 'number') return 'hello has no version';
  if (!SUPPORTED.includes(msg.version)) return `unsupported contract version ${msg.version} (runner speaks ${SUPPORTED.join(', ')})`;
  if (typeof msg.product !== 'string' || !msg.product) return 'hello has no product';
  if (!Array.isArray(msg.scenarios)) return 'hello has no scenarios';
  return null;
}

/**
 * One connection to one game. Events:
 * - 'hello' (msg), 'state' (state), 'event' (event), 'log' (msg), 'report' (report, pushed)
 * - 'fatal' ({ code, reason }): the runner should close with that code
 */
export class RunnerSession extends EventEmitter {
  constructor(send, { now = () => Date.now() } = {}) {
    super();
    this.sendText = send;
    this.now = now;
    this.t0 = now();
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer, type }
    this.hello = null;
    this.state = null;
    this.timeline = []; // { t, state }
    this.events = [];
    this.logs = [];
    this.report = null; // the newest pushed or requested report
    this.badMessages = 0;
    this.closed = false;
  }

  get scenarios() {
    return this.hello?.scenarios ?? [];
  }

  /** Feed one received text frame. */
  handle(text) {
    const parsed = parseMessage(text);
    if (!parsed.ok) return this.#bad(parsed.error);
    const m = parsed.msg;
    if (m.type === 'hello') {
      const problem = helloProblem(m);
      if (problem) {
        this.emit('fatal', { code: problem.startsWith('unsupported') ? CLOSE.version : CLOSE.protocol, reason: problem });
        return;
      }
      this.hello = m;
      this.#send({ type: 'welcome', version: VERSION });
      if (typeof m.ready === 'boolean' && !this.state) this.#setState({ ready: m.ready, status: 'idle' });
      this.emit('hello', m);
      return;
    }
    if (!this.hello) return this.#bad(`"${m.type}" before hello`);
    if (typeof m.re === 'number') this.#reply(m);
    switch (m.type) {
      case 'state':
        if (m.state && typeof m.state === 'object') this.#setState(m.state);
        break;
      case 'report':
        if (m.report && typeof m.report === 'object') {
          this.report = m.report;
          if (m.re === undefined) this.emit('report', m.report);
        }
        break;
      case 'event':
        if (m.event && typeof m.event.type === 'string') {
          this.events.push(m.event);
          if (this.events.length > EVENTS_MAX) this.events.splice(0, this.events.length - EVENTS_MAX);
          this.emit('event', m.event);
        }
        break;
      case 'log':
        if (typeof m.line === 'string') {
          const entry = { t: this.#t(), level: ['info', 'warning', 'error'].includes(m.level) ? m.level : 'info', line: m.line };
          this.logs.push(entry);
          if (this.logs.length > LOGS_MAX) this.logs.shift();
          this.emit('log', entry);
        }
        break;
      default:
        break; // unknown types are ignored (the protocol grows this way)
    }
  }

  /** Sends a request with an id; resolves with the reply ({ type, re, ... }); rejects on timeout or close. */
  request(type, fields = {}, timeoutMs = 10000) {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no reply to ${type} #${id} within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, type });
      this.#send({ type, id, ...fields });
    });
  }

  /** Sends a message that wants no reply. */
  notify(type, fields = {}) {
    this.#send({ type, ...fields });
  }

  async start(scenario, options = {}) {
    const r = await this.request('start', { scenario, options });
    return { ok: !!r.ok, error: r.error };
  }
  async stop() { return this.request('stop'); }
  input(action, down) { this.notify('input', { action, down: !!down }); }
  async getState() { return (await this.request('state?')).state ?? null; }
  async getReport() {
    const r = await this.request('report?');
    if (r.report) this.report = r.report;
    return r.report ?? null;
  }
  async quit(timeoutMs = 3000) { return this.request('quit', {}, timeoutMs); }

  /** Resolves when test() is true after any message, rejects after timeoutMs or on close. */
  waitFor(test, timeoutMs, what = 'condition') {
    return new Promise((resolve, reject) => {
      const check = () => {
        let ok = false;
        try { ok = test(); } catch {}
        if (ok) { done(); resolve(); return true; }
        return false;
      };
      const onClose = () => { done(); reject(new Error(`connection closed while waiting for ${what}`)); };
      const timer = setTimeout(() => { done(); reject(new Error(`timed out waiting for ${what}`)); }, timeoutMs);
      const events = ['hello', 'state', 'event', 'report', 'log'];
      const done = () => {
        clearTimeout(timer);
        for (const e of events) this.off(e, check);
        this.off('closed', onClose);
      };
      if (check()) return;
      if (this.closed) return onClose();
      for (const e of events) this.on(e, check);
      this.on('closed', onClose);
    });
  }

  /** The connection is gone: fail every request still waiting. */
  closedBy(info = {}) {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('connection closed'));
    }
    this.pending.clear();
    this.emit('closed', info);
  }

  #reply(m) {
    const p = this.pending.get(m.re);
    if (!p) return;
    this.pending.delete(m.re);
    clearTimeout(p.timer);
    p.resolve(m);
  }

  #setState(state) {
    const prev = this.state;
    this.state = state;
    this.timeline.push({ t: this.#t(), state });
    if (this.timeline.length > TIMELINE_MAX) this.timeline.shift();
    this.emit('state', state, prev);
  }

  #bad(error) {
    this.badMessages++;
    this.emit('bad', error);
    if (this.badMessages >= BAD_MESSAGES_BEFORE_CLOSE) this.emit('fatal', { code: CLOSE.protocol, reason: `too many bad messages (last: ${error})` });
  }

  #send(obj) {
    if (!this.closed) this.sendText(JSON.stringify(obj));
  }

  #t() {
    return Math.round((this.now() - this.t0) / 100) / 10;
  }
}

/** Where the address goes when launching a game: the environment, the argument, or both. */
export function launchWith(url, via = 'env', env = process.env, args = []) {
  const e = { ...env };
  const a = [...args];
  if (via === 'env' || via === 'both') e.HAWKES_PLAYTEST = url;
  else delete e.HAWKES_PLAYTEST;
  if (via === 'arg' || via === 'both') a.push(`--hawkes-playtest=${url}`);
  return { env: e, args: a };
}

/** Reads the address the way every SDK does: the argument wins over the variable. Null when absent. */
export function addressFrom(argv = process.argv, env = process.env) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--hawkes-playtest=')) return a.slice('--hawkes-playtest='.length) || null;
    if (a === '--hawkes-playtest' && i + 1 < argv.length) return argv[i + 1] || null;
  }
  return env.HAWKES_PLAYTEST || null;
}
