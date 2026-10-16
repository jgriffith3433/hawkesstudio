// Guide and drive: Talk shows J around the dashboard (switch tabs, open a report, run, change, finding or playtest,
// point at something with an outline and a label) and, when J asks it to, works the page for him (clicks, typing).
//
// Talk calls studio_guide (mcp-tools.ts) with a short list of actions. They wait here as a batch for the conversation;
// the dashboard showing that conversation picks it up on its next poll (GET /api/talk/<id> lists it, talk.js), claims
// it (one page only, a visible one), runs it (dashboard/guide.js) and reports each action's result, which goes back to
// Talk as the tool's answer and into the chat as a short line, so J sees what happened.
//
// The rules live in the page (guide.js: what may never be pressed, re-finding elements, stopping when J touches
// anything); this side adds what the page can't know: driving (click, type) only in a turn J's own message started,
// nothing at all in a turn Studio started, and never the typed confirmations (MERGE, DEPLOY, ROLLBACK).

import { newId } from './db.ts';
import { getConversation, saveConversation, turnBy } from './talk.ts';
import { lastJMessage } from './guards.ts';

export const GUIDE_ACTIONS = ['tab', 'open', 'highlight', 'clear', 'scroll', 'look', 'click', 'type'] as const;
export type GuideDo = (typeof GUIDE_ACTIONS)[number];
/** The actions that work the page for J (only when he asked). */
export const DRIVE: readonly string[] = ['click', 'type'];
export const OPEN_KINDS = ['report', 'run', 'change', 'finding', 'playtest'];
export const TABS = ['inbox', 'talk', 'today', 'ready', 'roadmap', 'report', 'playtests', 'backlog', 'changes', 'runs', 'costs', 'memory', 'settings'];
/** The typed confirmations stay J's: never typed for him. */
export const CONFIRM_WORDS = /\b(MERGE|DEPLOY|ROLLBACK)\b/;
const MAX_ACTIONS = 8;

export type GuideTarget = { selector?: string; text?: string };
export type GuideAction = { do: GuideDo; tab?: string; kind?: string; id?: string; target?: GuideTarget; label?: string; text?: string; submit?: boolean };
export type GuideResult = { do: string; ok: boolean; line: string; error?: string; data?: unknown };
type Batch = {
  id: string; conv: string; actions: GuideAction[]; drive: boolean; created: number;
  /** When J's newest message was sent: the page refuses driving from a turn older than J's last "stop". */
  turnAt: number;
  claimed: { page: string; at: number } | null;
  done: (r: GuideResult[] | { error: string }) => void;
};

const str = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, n) : undefined);

/** Talk's actions, checked and cleaned (untrusted input). Throws with what is wrong. */
export function checkActions(raw: unknown): GuideAction[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error('actions: a list of 1 to 8 actions');
  if (raw.length > MAX_ACTIONS) throw new Error(`At most ${MAX_ACTIONS} actions at a time`);
  return raw.map((a: any, i: number) => {
    const at = `action ${i + 1}`;
    if (!a || typeof a !== 'object' || !GUIDE_ACTIONS.includes(a.do)) throw new Error(`${at}: do must be one of ${GUIDE_ACTIONS.join(', ')}`);
    const out: GuideAction = { do: a.do };
    if (a.do === 'tab') {
      out.tab = str(a.tab, 20)?.toLowerCase();
      if (!out.tab || !TABS.includes(out.tab)) throw new Error(`${at}: tab must be one of ${TABS.join(', ')}`);
    }
    if (a.do === 'open') {
      out.kind = str(a.kind, 20)?.toLowerCase();
      out.id = str(a.id, 80);
      if (!out.kind || !OPEN_KINDS.includes(out.kind)) throw new Error(`${at}: kind must be one of ${OPEN_KINDS.join(', ')}`);
      if (!out.id || !/^[\w-]+$/.test(out.id)) throw new Error(`${at}: id (the ${out.kind}'s id) is needed`);
    }
    if (['highlight', 'scroll', 'click', 'type'].includes(a.do)) {
      const t = a.target && typeof a.target === 'object' ? a.target : typeof a.target === 'string' ? { selector: a.target } : {};
      const target: GuideTarget = { selector: str(t.selector, 200), text: str(t.text, 80) };
      if (!target.selector && !target.text) throw new Error(`${at}: target { selector, text } is needed`);
      if (target.selector && /[{}<>]/.test(target.selector)) throw new Error(`${at}: that selector isn't allowed`);
      out.target = target;
    }
    if (a.do === 'highlight') out.label = str(a.label, 80);
    if (a.do === 'type') {
      if (typeof a.text !== 'string') throw new Error(`${at}: text to type is needed`);
      const text = a.text.slice(0, 500);
      out.text = text;
      if (CONFIRM_WORDS.test(text)) throw new Error(`${at}: the typed confirmations (MERGE, DEPLOY, ROLLBACK) are J's to type, never Talk's`);
      out.submit = a.submit === true;
    }
    return out;
  });
}

const batches = new Map<string, Batch>();

/** Batches waiting for a page of this conversation to run them (GET /api/talk/<id> lists them for talk.js). */
export function pendingGuide(conv: string) {
  return [...batches.values()].filter((b) => b.conv === conv && !b.claimed).map((b) => ({ id: b.id, actions: b.actions, drive: b.drive, turnAt: b.turnAt, created: b.created }));
}

/** A page takes a batch (false: another page has it, or it is gone). */
export function claimGuide(conv: string, id: string, page: string) {
  const b = batches.get(id);
  if (!b || b.conv !== conv || (b.claimed && b.claimed.page !== page)) return false;
  b.claimed = { page: String(page).slice(0, 40), at: Date.now() };
  return true;
}

/** The page's results: into the chat as short lines, and back to Talk. */
export function reportGuide(conv: string, id: string, page: string, raw: unknown) {
  const b = batches.get(id);
  if (!b || b.conv !== conv || b.claimed?.page !== page) return false;
  const list = Array.isArray(raw) ? raw : [];
  const results: GuideResult[] = b.actions.map((a, i) => {
    const r = list[i] && typeof list[i] === 'object' ? list[i] : {};
    const ok = r.ok === true;
    return {
      do: a.do, ok,
      line: str(r.line, 160) || (ok ? a.do : `${a.do}: not done`),
      ...(r.error ? { error: str(r.error, 300) } : {}),
      ...(r.data !== undefined && a.do === 'look' ? { data: r.data } : {}),
    };
  });
  b.done(results);
  return true;
}

/** Short lines in the conversation: what Talk did on J's screen. */
function note(conv: string, lines: string[]) {
  const c = getConversation(conv);
  if (!c || !lines.length) return;
  for (const text of lines) c.messages.push({ role: 'tool', tool: 'guide', text, at: Date.now() });
  saveConversation(c);
}

const icon = (a: string) => (a === 'click' ? '🖱' : a === 'type' ? '⌨' : a === 'look' ? '👀' : '🧭');

/**
 * Talk asks to guide (or drive): resolves with each action's result once the page has run them, or with why not.
 * timeoutMs: how long a page has to pick it up; it then has a few seconds per action to finish. cancel: the request
 * went away (Talk was stopped).
 */
export function requestGuide(conv: string | null, raw: unknown, { pickupMs = 8000, perActionMs = 5000, cancel }: { pickupMs?: number; perActionMs?: number; cancel?: AbortSignal } = {}): Promise<{ ok: boolean; results?: GuideResult[]; error?: string }> {
  if (!conv || !getConversation(conv)) return Promise.resolve({ ok: false, error: 'studio_guide works only in a Talk conversation (it steers the dashboard J has open).' });
  let actions: GuideAction[];
  try {
    actions = checkActions(raw);
  } catch (e: any) {
    return Promise.resolve({ ok: false, error: e.message });
  }
  const who = turnBy(conv);
  const drive = actions.some((a) => DRIVE.includes(a.do));
  const refuse = (error: string) => {
    note(conv, [`⛔ ${error}`]);
    return Promise.resolve({ ok: false, error });
  };
  if (who === 'Studio') return refuse("Talk didn't steer the page: Studio started this turn, not J.");
  if (drive && who !== 'J') return refuse('Talk may click or type on the page only in an answer to J, when he asked for it.');
  return new Promise((resolve) => {
    const id = newId('g');
    let timer: NodeJS.Timeout;
    const finish = (r: GuideResult[] | { error: string }) => {
      if (!batches.has(id)) return;
      batches.delete(id);
      clearTimeout(timer);
      if (Array.isArray(r)) {
        note(conv, r.map((x) => `${x.ok ? icon(x.do) : '⚠'} ${x.line}${!x.ok && x.error && !x.line.includes(x.error) ? `: ${x.error}` : ''}`));
        resolve({ ok: r.every((x) => x.ok), results: r });
      } else resolve({ ok: false, error: r.error });
    };
    const b: Batch = { id, conv, actions, drive, created: Date.now(), turnAt: lastJMessage(conv)?.at ?? 0, claimed: null, done: finish };
    batches.set(id, b);
    timer = setTimeout(() => finish({ error: "No Studio page took it: J doesn't have the dashboard open on this conversation, or it's in the background. Tell him in words instead." }), pickupMs);
    // Once a page has it, it gets time for the actions (moving the pointer, typing) before giving up on it.
    const watch = setInterval(() => {
      if (!batches.has(id)) return clearInterval(watch);
      if (b.claimed) {
        clearInterval(watch);
        clearTimeout(timer);
        timer = setTimeout(() => finish({ error: 'The page took it but did not report back (J may have closed it).' }), Math.max(0, b.claimed.at + 3000 + perActionMs * actions.length - Date.now()));
      }
    }, 100);
    watch.unref?.();
    cancel?.addEventListener('abort', () => finish({ error: 'cancelled' }));
  });
}
