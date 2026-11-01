// The guards in Studio's API for the agent sandbox (docs/agents.md, "The guards"). Talk and the agents run as their own
// Linux user with a shell; whatever they send to Studio's API, a request from that user (sandbox.ts requestUser) can
// only do something live, or change who can do what, when J's own latest message in that Talk conversation says so in
// his exact words. Talk asks; J types; Studio checks the words, not Claude's account of them.
//
//   POST /api/deploy/<product>           J's latest message contains "DEPLOY <product>"
//   POST /api/rollback/<product>         J's latest message contains "ROLLBACK <product>"
//   POST /api/changes/<id>/approve       a Studio or Gen change (it merges into main, which deploys): "MERGE <id>"
//   POST /api/approvals/<id>/approve|deny|dismiss never from the sandbox: J's tap on an Approve / Deny card (approvals.ts, which
//                                        also refuses anything that isn't his dashboard page). The cards come first;
//                                        the typed words above are the fallback.
//   POST /api/agents/settings, /api/notify, /api/memory/seed, /api/broadcast/desk, /api/broadcast/live, /api/social/config|disconnect: never from the
//                                        sandbox (J's dashboard; live is going on air on Twitch)
//   /api/claude/... (Claude accounts)    never from the sandbox; server.ts also wants J's click (approvals.ts notJClick)
//   /api/antigravity/... (agy sign-in)   the same
//   POST /api/runs|jobs|changes/<id>/cancel|resume  only from a Talk conversation (attributable), never an agent alone
//   POST /api/pm/settings                only from a Talk conversation (attributable), on J's word (Talk's rules)
//   POST /api/settings                   only from a Talk conversation; raising costs needs J's quoted yes (settings.ts)
//
// Beta stays open on purpose: agents' merges into beta (J delegated them to the PM) and Talk's fast lane. Main is
// also protected on GitHub (rulesets) and the sandbox holds no GitHub token.

import type http from 'node:http';
import { db, parse } from './db.ts';
import { requestUser } from './sandbox.ts';
import * as GoLivePolicy from './golive-policy.ts';
const goLivePolicy = () => GoLivePolicy;

/**
 * J's newest message in a conversation (not Studio's notices, not Claude's text), or null. When the newest message came
 * through Studio's MCP (via: another Claude wrote it, studio_talk), that is null too: nothing counts as J's word until
 * he writes again himself.
 */
export function lastJMessage(conversation: string | null | undefined) {
  if (!conversation) return null;
  let r: any;
  try {
    r = db.prepare('SELECT messages FROM conversations WHERE id = ?').get(conversation);
  } catch {
    return null;
  }
  const msgs = (parse(r?.messages) ?? []) as { role: string; text: string; notice?: boolean; at: number; via?: string }[];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user' && !msgs[i].notice) return msgs[i].via ? null : msgs[i];
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
  // Going live and rolling back on the owner's word, in plain words (golive-policy.ts; J, 2026-10-31: "Stop building in
  // stop guards"): their latest message asks for it, or they told Studio to keep going live (policy auto). "Hold off"
  // (policy hold) keeps it from going unless their latest message asks again.
  let m = /^\/api\/deploy\/([\w-]+)$/.exec(route);
  if (m) {
    const P = goLivePolicy();
    if (P.asksToGoLive(lastJMessage(conv)?.text, m[1])) return null;
    if (P.policyOf(m[1]).policy === 'auto') return null;
    return `Going live with ${m[1]} waits for the owner's word: their latest message asks for it ("go live", "ship it"), or they've said to keep going live (studio_project golive auto).`;
  }
  m = /^\/api\/rollback\/([\w-]+)$/.exec(route);
  if (m) return goLivePolicy().asksToRollBack(lastJMessage(conv)?.text, m[1]) ? null : `Rolling back ${m[1]} waits for the owner's word: their latest message asks for it ("roll back").`;
  m = /^\/api\/changes\/(c_[0-9a-f]+)\/approve$/.exec(route);
  if (m) {
    const c = db.prepare('SELECT product FROM changes WHERE id = ?').get(m[1]) as { product: string } | undefined;
    const infra = c && ['hawkesstudio', 'hawkesgen'].includes(c.product);
    return infra ? need(`MERGE ${m[1]}`, `Merging ${m[1]} into main (it deploys ${c!.product})`) : null;
  }
  // Cancelling and resuming (cancel.ts): Talk and the PM (a conversation behind the call, recorded by name), never an agent on its own.
  if (/^\/api\/(runs|jobs|changes)\/[\w-]+\/(cancel|resume)$/.test(route) && !conv) return 'Cancelling or resuming work is J\'s (the Activity panel) or Talk\'s, never an agent\'s own.';
  // Approve / Deny cards (approvals.ts): the sandbox may ask for one, never decide one (J's tap on the dashboard).
  if (/^\/api\/approvals\/a_[0-9a-f]+\/(approve|deny|dismiss)$/.test(route)) return 'Approving, denying or closing a card is J\'s tap on the card in his dashboard, never Talk\'s, the PM\'s or an agent\'s.';
  if (route.startsWith('/api/claude/')) return 'Claude accounts (signing in, switching) are J\'s click in Settings, never Talk\'s, the PM\'s or an agent\'s.';
  if (route.startsWith('/api/antigravity/')) return 'Signing Antigravity in is J\'s click in Settings, never Talk\'s, the PM\'s or an agent\'s.';
  if (route === '/api/agents/settings' || route === '/api/notify'|| route === '/api/memory/seed' || route === '/api/broadcast/desk' || route === '/api/broadcast/live' || /^\/api\/social\/(config|disconnect)/.test(route)) return `${route} is changed from Studio's dashboard by J, not from a sandboxed agent.`;
  if (route === '/api/pm/settings' && !conv) return 'PM settings change only from a Talk conversation, on J\'s word.';
  if (route === '/api/settings' && !conv) return 'Settings change from a Talk conversation (J\'s quoted yes for anything that raises costs) or on the dashboard.';
  return null;
}
