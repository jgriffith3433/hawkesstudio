// Phone notifications through ntfy.sh (free, no account). J installs the ntfy app and subscribes to Studio's topic.
// The topic is a long random name, which is the only thing keeping it private: it lives in .data/notify.json (made on
// first use), never in code, and the dashboard shows it (Talk tab, "Phone notifications") so J can subscribe.
//
// Sent for: the morning brief, an agent change ready to approve, a live site failing its check, the day's agent
// budget reached. A failed send is logged and never breaks the caller.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA } from './config.ts';

const FILE = path.join(DATA, 'notify.json');
export type NotifySettings = { enabled: boolean; server: string; topic: string };

/** Where links in notifications point (the dashboard J opens on his phone). */
export const PUBLIC_URL = (process.env.STUDIO_PUBLIC_URL || 'https://studio.hawkesgen.com').replace(/\/$/, '');

const newTopic = () => `hawkes-${crypto.randomBytes(18).toString('base64url')}`;

export function notifySettings(): NotifySettings {
  let s: Partial<NotifySettings> = {};
  try {
    s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    // First use: made below.
  }
  if (!s.topic) {
    s = { enabled: true, server: 'https://ntfy.sh', ...s, topic: newTopic() };
    fs.writeFileSync(FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  }
  return { enabled: s.enabled !== false, server: (s.server || 'https://ntfy.sh').replace(/\/$/, ''), topic: s.topic! };
}

/** Changes settings; `rotate: true` makes a new topic (J must subscribe again). */
export function saveNotifySettings(patch: { enabled?: boolean; server?: string; rotate?: boolean }) {
  const cur = notifySettings();
  const next: NotifySettings = {
    enabled: patch.enabled ?? cur.enabled,
    server: patch.server?.trim() || cur.server,
    topic: patch.rotate ? newTopic() : cur.topic,
  };
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return notifyInfo();
}

/** What the dashboard shows: the topic, the link to subscribe, and whether it's on. */
export function notifyInfo() {
  const s = notifySettings();
  return { ...s, subscribe: `${s.server}/${s.topic}` };
}

export type NotifyOptions = { url?: string; priority?: 1 | 2 | 3 | 4 | 5; tags?: string[] };

/** Sends a notification to J's phone. Never throws; resolves false when it wasn't sent. */
export async function notify(title: string, message: string, { url, priority, tags }: NotifyOptions = {}) {
  const s = notifySettings();
  if (!s.enabled) return false;
  try {
    // JSON publishing (POST to the server root) keeps non-ASCII titles intact.
    const r = await fetch(s.server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: s.topic, title: title.slice(0, 200), message: message.slice(0, 3500) || title, ...(url ? { click: url } : {}), ...(priority ? { priority } : {}), ...(tags?.length ? { tags } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    return true;
  } catch (e: any) {
    console.warn(`[studio] notification not sent (${title}): ${e.message ?? e}`);
    return false;
  }
}

const sent = new Map<string, number>();
/** notify, at most once per key within `windowMs` (e.g. a site that stays down isn't announced every run). */
export function notifyOnce(key: string, windowMs: number, title: string, message: string, opts?: NotifyOptions) {
  const last = sent.get(key) ?? 0;
  if (Date.now() - last < windowMs) return Promise.resolve(false);
  sent.set(key, Date.now());
  return notify(title, message, opts);
}
