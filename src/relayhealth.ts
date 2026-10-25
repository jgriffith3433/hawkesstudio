// Relay health (Yooba Land NET-08): once a day, check the relays the game's signal route depends on and open a finding
// (product yoobaland) when one refuses or the signal route fails.
//
//   1. A probe per relay: connect, ask for one event, expect an answer (a refusal, a closed socket or silence = fails).
//   2. The game's own soak, `node test/twopages.mjs soak <seconds>` from the YoobaLand repo (two node processes, no
//      browser), for the signal route; its refusals, "GAVE UP" lines and exit code are read from its output.
//
// Cheap and read-only: nothing is written to the game's repo (apart from the one-time `npm ci` its test needs), the soak
// has a time budget and is killed past it. The schedule, the soak length, the budget and the relay list are settings
// (the `relays` section; an empty list means the one the game ships, read from its net/src/util.js).

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { db, J, parse, newId } from './db.ts';
import { PROJECTS } from './config.ts';

db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL, by TEXT)`);
try { db.exec('ALTER TABLE findings ADD COLUMN source TEXT'); } catch { /* already there (roadmap.ts adds it) */ }

export const PRODUCT = 'yoobaland';
/** The game's net folder in its repo, relative to the projects folder. */
export const NET_DIR = 'YoobaLand/YoobaLand/Tools/Web/net';

export type RelaySettings = {
  enabled: boolean;
  /** The UTC hour from which the day's check may run. */
  hour: number;
  /** `soak <seconds>`. */
  soakSeconds: number;
  /** The whole check (probes and soak) is stopped past this. */
  budgetMinutes: number;
  /** wss:// urls; empty: the list the game ships. */
  relays: string[];
};
export const RELAY_DEFAULTS: RelaySettings = { enabled: true, hour: 5, soakSeconds: 120, budgetMinutes: 6, relays: [] };

export function relaySettings(): RelaySettings {
  const r = db.prepare(`SELECT value FROM settings WHERE key = 'relays'`).get() as { value: string } | undefined;
  return { ...RELAY_DEFAULTS, ...((r ? parse(r.value) : null) ?? {}) };
}

export function saveRelaySettings(patch: Record<string, any>, by = 'J'): RelaySettings {
  const next = relaySettings();
  const range = { hour: [0, 23], soakSeconds: [30, 300], budgetMinutes: [2, 15] } as const;
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (k === 'enabled') { next.enabled = v === true; continue; }
    if (k === 'relays') {
      const list = (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean);
      for (const u of list) if (!/^wss?:\/\/[^\s/]+(\/\S*)?$/i.test(u)) throw new Error(`relays: "${u}" is not a ws:// or wss:// address`);
      next.relays = [...new Set(list)].slice(0, 40);
      continue;
    }
    if (!(k in range)) throw new Error(`relays.${k}: not a setting (${Object.keys(RELAY_DEFAULTS).join(', ')})`);
    const [lo, hi] = range[k as keyof typeof range];
    const n = Number(v);
    if (!(Number.isFinite(n) && n >= lo && n <= hi)) throw new Error(`relays.${k}: ${lo} to ${hi}`);
    (next as any)[k] = Math.round(n);
  }
  db.prepare('INSERT INTO settings (key, value, updated, by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, by = excluded.by')
    .run('relays', J(next), Date.now(), by);
  return next;
}

// ------------------------------------------------------------- what is checked

/** The relays the game ships: the NOSTR_RELAYS array in net/src/util.js. */
export function shippedRelays(netDir = path.join(PROJECTS, NET_DIR)): string[] {
  try {
    const src = fs.readFileSync(path.join(netDir, 'src', 'util.js'), 'utf8');
    const block = /NOSTR_RELAYS\s*=\s*\[([^\]]*)\]/.exec(src)?.[1] ?? '';
    return [...block.matchAll(/["'](wss?:\/\/[^"']+)["']/g)].map((m) => m[1]);
  } catch {
    return [];
  }
}

export const relayList = (s = relaySettings(), netDir?: string) => (s.relays.length ? s.relays : shippedRelays(netDir));
const hostOf = (url: string) => url.replace(/^wss?:\/\//, '').replace(/\/.*$/, '');

export type Failure = { key: string; title: string; detail: string };

/** Connects, asks for one event and expects an answer. A refusal, a closed socket or silence fails. */
export function probeRelay(url: string, timeoutMs = 8000): Promise<{ ok: boolean; why: string }> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    let done = false;
    const end = (ok: boolean, why: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* closed */ }
      resolve({ ok, why });
    };
    const timer = setTimeout(() => end(false, `no answer in ${timeoutMs / 1000} s`), timeoutMs);
    try { ws = new WebSocket(url); } catch (e: any) { return end(false, e?.message ?? 'bad address'); }
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'hawkes-health', { kinds: [1], limit: 1 }]));
    ws.onerror = () => end(false, 'could not connect');
    ws.onclose = (e) => end(false, `closed by the relay (${e.code}${e.reason ? ' ' + e.reason : ''})`);
    ws.onmessage = (m) => {
      let msg: any;
      try { msg = JSON.parse(String(m.data)); } catch { return; }
      if (msg[0] === 'EOSE' || msg[0] === 'EVENT') end(true, 'answered');
      else if (msg[0] === 'CLOSED') end(false, `refused: ${msg[2] ?? 'closed'}`);
      else if (msg[0] === 'NOTICE' && /block|restrict|rate|limit|deny|denied|forbid|auth|pay/i.test(String(msg[1]))) end(false, `refused: ${msg[1]}`);
    };
  });
}

/** What the soak's output says: relays that refused or were given up on, and whether the run itself failed. */
export function readSoak(out: string, code: number | null, timedOut: boolean, relays: string[]): { relays: Failure[]; route: Failure | null; ran: boolean } {
  const found = new Map<string, string>();
  const hostKey = (h: string) => relays.find((u) => hostOf(u) === h || u.includes(h)) ?? `wss://${h}`;
  // "... refusals: nos.lol x3 (rate-limited: slow down); relay.x x1" in the last REPORT line.
  const reports = out.split('\n').filter((l) => / REPORT /.test(l));
  const refusals = /refusals: (.*?)(?:, gave up:|$)/.exec(reports[reports.length - 1] ?? '')?.[1] ?? '';
  if (refusals && refusals !== 'none') {
    for (const part of refusals.split('; ')) {
      const m = /^(\S+) x(\d+)(?: \((.*)\))?$/.exec(part.trim());
      if (m) found.set(hostKey(m[1]), `refused ${m[2]} time(s)${m[3] ? ': ' + m[3] : ''} during the soak`);
    }
  }
  for (const l of out.split('\n')) {
    const g = /GAVE UP (wss?:\/\/\S+) (-?\d+) s into the soak: (.*)$/.exec(l);
    if (g) found.set(g[1], `swapped out ${g[2]} s into the soak: ${g[3]}`);
  }
  const failures: Failure[] = [...found].map(([url, why]) => relayFailure(url, why));
  const ran = /SEES|SOAK|TIMEOUT/.test(out);
  const failed = timedOut || (code !== 0 && code !== null) || (ran && /TIMEOUT/.test(out));
  const route: Failure | null = !ran ? null : failed
    ? { key: 'signal-route', title: "Yooba Land's signal route failed the daily soak", detail: `\`node test/twopages.mjs soak\` ${timedOut ? 'ran past its time budget' : 'failed'}.\n\n${out.split('\n').filter((l) => /TIMEOUT|SOAKED|FAILED|GAVE UP|REPORT/.test(l)).slice(-8).join('\n')}` }
    : null;
  return { relays: failures, route, ran };
}

const relayFailure = (url: string, why: string): Failure => ({
  key: `relay:${hostOf(url)}`,
  title: `Yooba Land relay ${hostOf(url)} ${/refus|swapped|closed/.test(why) ? 'refuses' : 'is failing'}`,
  detail: `${url}: ${why}.`,
});

// ------------------------------------------------------------- findings

/**
 * Failures as findings (source "relays", product yoobaland, bugs), deduped by key: one seen again is updated, a fixed
 * one reopens, a won't-fix stays. Returns which were new and which reopened.
 */
export function fileRelayFindings(failures: Failure[], now = Date.now(), product = PRODUCT) {
  const added: string[] = [];
  const updated: string[] = [];
  const reopened: string[] = [];
  const day = new Date(now).toISOString().slice(0, 10);
  for (const f of failures) {
    const fix = f.key === 'signal-route'
      ? 'Read the soak output above; if a relay is the cause, swap it in the game\'s relay list (Tools/Web/net/src/util.js, NOSTR_RELAYS) and rebuild hawkes-net.js.'
      : 'Swap this relay for another in the game\'s relay list (Tools/Web/net/src/util.js, NOSTR_RELAYS) and rebuild hawkes-net.js, or leave it if it comes back.';
    const old = db.prepare(`SELECT id, status FROM findings WHERE product = ? AND key = ? AND source = 'relays' ORDER BY last_seen DESC LIMIT 1`).get(product, f.key) as any;
    if (old) {
      db.prepare(`UPDATE findings SET seen = seen + (CASE WHEN last_seen >= ? THEN 0 ELSE 1 END), last_seen = ?, detail = ?, title = ? WHERE id = ?`).run(now - 20 * 3600_000, now, f.detail, f.title, old.id);
      if (old.status === 'fixed' || old.status === 'expired') {
        db.prepare(`UPDATE findings SET status = 'open', note = ?, updated = ? WHERE id = ?`).run(`Came back ${day}: the daily relay check fails again.`, now, old.id);
        reopened.push(old.id);
      } else updated.push(old.id);
      continue;
    }
    const id = newId('f');
    db.prepare(`INSERT INTO findings (id, product, key, title, severity, area, detail, fix, status, scenario, shots, first_seen, last_seen, seen, last_run, note, source)
      VALUES (?, ?, ?, ?, 'bug', 'network', ?, ?, 'open', 'relays', '[]', ?, ?, 1, NULL, ?, 'relays')`)
      .run(id, product, f.key, f.title, f.detail, fix, now, now, `Found by the daily relay check ${day} (NET-08).`);
    added.push(id);
  }
  return { added, updated, reopened };
}

// ------------------------------------------------------------- the run

type Soak = (netDir: string, seconds: number, budgetMs: number) => Promise<{ out: string; code: number | null; timedOut: boolean }>;

/** `node test/twopages.mjs soak <seconds>` in the game's net folder, killed past the budget. */
export const runSoak: Soak = (netDir, seconds, budgetMs) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['test/twopages.mjs', 'soak', String(seconds)], { cwd: netDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let timedOut = false;
  const add = (d: Buffer) => { out += d; if (out.length > 400_000) out = out.slice(-200_000); };
  child.stdout.on('data', add);
  child.stderr.on('data', add);
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, budgetMs);
  child.on('error', (e) => { clearTimeout(timer); resolve({ out: out + String(e.message), code: null, timedOut }); });
  child.on('close', (code) => { clearTimeout(timer); resolve({ out, code, timedOut }); });
});

export type RelayRun = { at: number; probed: number; failures: string[]; filed: string[]; note: string };
type Deps = { probe?: typeof probeRelay; soak?: Soak | null; netDir?: string; now?: number };

let running: Promise<RelayRun> | null = null;

/** One check: probe every relay, run the soak, file findings. `soak: null` skips the soak (the game's test is missing). */
export function checkRelays(deps: Deps = {}): Promise<RelayRun> {
  return (running ??= doCheck(deps).finally(() => { running = null; }));
}

async function doCheck(deps: Deps): Promise<RelayRun> {
  const s = relaySettings();
  const netDir = deps.netDir ?? path.join(PROJECTS, NET_DIR);
  const now = deps.now ?? Date.now();
  const started = Date.now();
  const budget = s.budgetMinutes * 60_000;
  const relays = relayList(s, netDir);
  const failures: Failure[] = [];
  let note = '';
  const probe = deps.probe ?? probeRelay;
  const probed = await Promise.all(relays.map(async (u) => ({ u, r: await probe(u) })));
  for (const { u, r } of probed) if (!r.ok) failures.push(relayFailure(u, r.why));

  const soak = deps.soak === undefined ? runSoak : deps.soak;
  if (!soak) note = 'soak skipped';
  else if (!fs.existsSync(path.join(netDir, 'test', 'twopages.mjs'))) note = "the game's test/twopages.mjs is not on this server";
  else {
    if (!fs.existsSync(path.join(netDir, 'node_modules')) && deps.soak === undefined) {
      const { ensureInstalled } = await import('./warm.ts');
      const i = await ensureInstalled(netDir, { why: 'relay health check' });
      if (!i.ok) note = `the soak's packages did not install: ${i.error ?? ''}`.trim();
    }
    if (!note) {
      const left = Math.max(30_000, budget - (Date.now() - started));
      const res = await soak(netDir, s.soakSeconds, left);
      const read = readSoak(res.out, res.code, res.timedOut, relays);
      if (!read.ran) note = `the soak did not start: ${res.out.trim().split('\n').slice(-2).join(' ').slice(0, 200)}`;
      for (const f of read.relays) if (!failures.some((x) => x.key === f.key)) failures.push(f);
      if (read.route) failures.push(read.route);
    }
  }
  const filed = failures.length ? fileRelayFindings(failures, now) : { added: [], updated: [], reopened: [] };
  const run: RelayRun = { at: now, probed: relays.length, failures: failures.map((f) => f.key), filed: [...filed.added, ...filed.reopened], note };
  db.prepare('INSERT INTO settings (key, value, updated, by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, by = excluded.by')
    .run('relays-state', J(run), Date.now(), 'relayhealth');
  return run;
}

export function lastRelayRun(): RelayRun | null {
  const r = db.prepare(`SELECT value FROM settings WHERE key = 'relays-state'`).get() as { value: string } | undefined;
  return r ? parse(r.value) as RelayRun : null;
}

/** Due: on, past the hour (UTC), and not yet run today. */
export function relayDue(now = Date.now(), s = relaySettings(), last = lastRelayRun()) {
  if (!s.enabled) return false;
  const d = new Date(now);
  if (d.getUTCHours() < s.hour) return false;
  return !last || new Date(last.at).toISOString().slice(0, 10) !== d.toISOString().slice(0, 10);
}

// The same test as repos.ts isServer, kept here so this module (loaded by Settings) pulls in nothing but the database.
const onServer = () => process.platform !== 'win32' && process.env.STUDIO_SERVER === '1';
let timer: ReturnType<typeof setInterval> | null = null;
/** Looks every 10 minutes whether today's check is due (server only; STUDIO_RELAY_WATCH=on forces it elsewhere). */
export function startRelayHealth() {
  if (timer || process.env.STUDIO_SMOKE || !(onServer() || process.env.STUDIO_RELAY_WATCH === 'on')) return;
  // Inside a promise, so a throw (the database busy, say) is logged instead of ending Studio.
  const tick = () => void Promise.resolve().then(async () => {
    if (!relayDue()) return;
    const r = await checkRelays();
    console.log(`[relays] checked ${r.probed}: ${r.failures.length ? r.failures.join(', ') : 'all fine'}${r.note ? ` (${r.note})` : ''}`);
  }).catch((e) => console.warn(`[relays] check failed: ${e.message ?? e}`));
  setTimeout(tick, 5 * 60_000).unref();
  timer = setInterval(tick, 10 * 60_000);
  timer.unref();
}
