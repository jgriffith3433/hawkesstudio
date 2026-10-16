// The guards in Studio's API for the agent sandbox (docs/agents.md, "The guards"). Talk and the agents run as their own
// Linux user with a shell; whatever they send to Studio's API, a request from that user (sandbox.ts requestUser) can
// only do something live, or change who can do what, when J's own latest message in that Talk conversation says so in
// his exact words. Talk asks; J types; Studio checks the words, not Claude's account of them.
//
//   POST /api/deploy/<product>           J's latest message contains "DEPLOY <product>"
//   POST /api/rollback/<product>         J's latest message contains "ROLLBACK <product>"
//   POST /api/changes/<id>/approve       a Studio or Gen change (it merges into main, which deploys): "MERGE <id>"
//   POST /api/agents/settings, /api/notify, /api/memory/seed: never from the sandbox (J's dashboard)
//   POST /api/pm/settings                only from a Talk conversation (attributable), on J's word (Talk's rules)
//
// Beta stays open on purpose: agents' merges into beta (J delegated them to the PM) and Talk's fast lane. Main is
// also protected on GitHub (rulesets) and the sandbox holds no GitHub token.

import type http from 'node:http';
import { db, parse } from './db.ts';
import { requestUser } from './sandbox.ts';

/** J's newest message in a conversation (not Studio's notices, not Claude's text), or null. */
export function lastJMessage(conversation: string | null | undefined) {
  if (!conversation) return null;
  let r: any;
  try {
    r = db.prepare('SELECT messages FROM conversations WHERE id = ?').get(conversation);
  } catch {
    return null;
  }
  const msgs = (parse(r?.messages) ?? []) as { role: string; text: string; notice?: boolean; at: number }[];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user' && !msgs[i].notice) return msgs[i];
  return null;
}

/** Whether J's newest message has these exact words (as a phrase, not inside a longer word). */
export function jTyped(conversation: string | null | undefined, words: string) {
  const m = lastJMessage(conversation);
  if (!m) return false;
  const esc = words.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^\\w-])${esc}($|[^\\w-])`).test(m.text);
}

/** null when the request may go on; otherwise why it is refused (403). Only requests from the sandbox are checked. */
export function guardRequest(req: http.IncomingMessage, route: string, method: string): string | null {
  if (method === 'GET' || requestUser(req) !== 'agent') return null;
  return guardRoute(route, method, String(req.headers['x-talk-conversation'] ?? '') || null);
}

/** The rule for one sandboxed request (route, method, the Talk conversation it says it comes from). */
export function guardRoute(route: string, method: string, conv: string | null): string | null {
  if (method === 'GET') return null;
  const need = (words: string, what: string) => (jTyped(conv, words)
    ? null
    : `${what} is J's call: Studio goes ahead only when J's own latest message here says "${words}". Ask him to type it.`);
  let m = /^\/api\/deploy\/([\w-]+)$/.exec(route);
  if (m) return need(`DEPLOY ${m[1]}`, `Going live with ${m[1]}`);
  m = /^\/api\/rollback\/([\w-]+)$/.exec(route);
  if (m) return need(`ROLLBACK ${m[1]}`, `Rolling back ${m[1]}`);
  m = /^\/api\/changes\/(c_[0-9a-f]+)\/approve$/.exec(route);
  if (m) {
    const c = db.prepare('SELECT product FROM changes WHERE id = ?').get(m[1]) as { product: string } | undefined;
    const infra = c && ['hawkesstudio', 'hawkesgen'].includes(c.product);
    return infra ? need(`MERGE ${m[1]}`, `Merging ${m[1]} into main (it deploys ${c!.product})`) : null;
  }
  if (route === '/api/agents/settings' || route === '/api/notify' || route === '/api/memory/seed') return `${route} is changed from Studio's dashboard by J, not from a sandboxed agent.`;
  if (route === '/api/pm/settings' && !conv) return 'PM settings change only from a Talk conversation, on J\'s word.';
  return null;
}
