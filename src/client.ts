// A small client for the Studio service (used by the CLI and the MCP server).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PORT } from './config.ts';

/** ~/.hawkes/client.json: where Studio is and the website login ({ studioUrl, studioUser, studioPassword }). */
const userConfig = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.hawkes', 'client.json'), 'utf8'));
  } catch {
    return {};
  }
})();
// On the server itself Studio is always local.
const onServer = process.env.STUDIO_SERVER === '1';
export const STUDIO_URL = process.env.STUDIO_URL || (onServer ? undefined : userConfig.studioUrl) || `http://127.0.0.1:${PORT}`;
const auth = !onServer && userConfig.studioUser && userConfig.studioPassword ? `Basic ${Buffer.from(`${userConfig.studioUser}:${userConfig.studioPassword}`).toString('base64')}` : null;

/** A client for the Studio service at base (studio() below is the one from ~/.hawkes/client.json). */
export const studioAt = (base: string, auth: string | null = null) => async function studio(pathname: string, { method = 'GET', body }: { method?: string; body?: unknown } = {}): Promise<any> {
  let r: Response;
  try {
    r = await fetch(`${base}${pathname}`, {
      method,
      // In Talk, the conversation this MCP server belongs to: what the call starts reports back there (followup.ts).
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { Authorization: auth } : {}), ...(process.env.TALK_CONVERSATION ? { 'X-Talk-Conversation': process.env.TALK_CONVERSATION } : {}),
        // An agent's or scout's own MCP server (memory tools only): who is writing to the shared memory.
        ...(process.env.STUDIO_AGENT ? { 'X-Studio-Agent': process.env.STUDIO_AGENT } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`Hawkes Studio isn't running at ${base}. Start it: C:\\Projects\\hawkesstudio\\auto-start.bat`);
  }
  const text = await r.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
  return data;
};
export const studio = studioAt(STUDIO_URL, auth);

/** Waits for a run to finish (polling), calling onStep with each step change. */
export async function waitRun(id: string, onStep: (s: any) => void = () => {}, timeoutMs = 8 * 3600_000, call = studio) {
  const seen = new Map<string, string>();
  const end = Date.now() + timeoutMs;
  let misses = 0;
  for (;;) {
    let r: any;
    try {
      r = await call(`/api/runs/${id}`);
      misses = 0;
    } catch (e) {
      // The service can be busy for a moment; give up only after a minute of silence.
      if (++misses > 20) throw e;
      await new Promise((res) => setTimeout(res, 3000));
      continue;
    }
    for (const s of r.steps) {
      const sig = `${s.status}|${s.detail}`;
      if (seen.get(s.id) !== sig) {
        seen.set(s.id, sig);
        onStep(s);
      }
    }
    if (r.status !== 'running') return r;
    if (Date.now() > end) throw new Error(`Run ${id} is still going after ${Math.round(timeoutMs / 60000)} min`);
    await new Promise((res) => setTimeout(res, 3000));
  }
}
