// Linking a customer's own AI (docs/studio-customers.md, section 4; J, 2026-10-29 and 2026-10-30: "let's start adding
// the other AI log ins in the on boarding"). Onboarding's "Connect your AI" card and Settings show this list. Talk and
// the agents in a customer's Studio run only on what is linked here, never on J's keys, logins or plans: a cell's
// environment has none of them (cellrun.ts cellEnv), and claude.ts claudeEnv strips the server's Claude ones.
//
// The providers are the harnesses Studio already runs (brains.ts):
//   - Claude: their Claude subscription (`claude setup-token`, claude-accounts.ts) or their Anthropic API key (claude.ts)
//   - Cursor: their Cursor API key (CURSOR_API_KEY for the cursor harness)
//   - GitHub Copilot: their GitHub token with Copilot access (COPILOT_GITHUB_TOKEN)
//   - Gemini: their Gemini API key (GEMINI_API_KEY)
//   - Antigravity: their Google sign-in (agy, antigravity-login.ts, the same flow as J's, in their own Studio)
// Keys are sealed at rest with the cell's own key (cellkeys.ts) in .data/ai/keys.json and never shown again (only
// "set" and the last 4); at start they become the harness's environment variable in this process, the only place the
// harnesses read them. The one they pick (POST /api/ai/use) is the Studio's harness (Settings brain).

import fs from 'node:fs';
import path from 'node:path';
import { DATA, StudioError } from './config.ts';
import { customerStudio } from './tenancy.ts';
import { seal, unseal } from './cellkeys.ts';

export type LinkMethod = { id: 'api-key' | 'subscription' | 'token' | 'signin'; label: string; help: string; routes: Record<string, string> };
export type Provider = { id: 'claude' | 'cursor' | 'copilot' | 'gemini' | 'antigravity'; name: string; by: string; methods: LinkMethod[] };

const KEY_ENV: Record<string, string> = { cursor: 'CURSOR_API_KEY', copilot: 'COPILOT_GITHUB_TOKEN', gemini: 'GEMINI_API_KEY' };
const KEY_FORMAT: Record<string, { re: RegExp; what: string }> = {
  cursor: { re: /^\S{20,200}$/, what: 'a Cursor API key (Cursor → Settings → API keys)' },
  copilot: { re: /^(github_pat_|gho_|ghu_|ghp_)[A-Za-z0-9_]{20,}$/, what: 'a GitHub token with Copilot access (github_pat_…, gho_…)' },
  gemini: { re: /^AIza[0-9A-Za-z_-]{30,}$/, what: 'a Gemini API key (AIza…, from Google AI Studio)' },
};

export const PROVIDERS: Provider[] = [
  {
    id: 'claude', name: 'Claude', by: 'Anthropic',
    methods: [
      { id: 'subscription', label: 'Sign in with your Claude subscription', help: 'Pro or Max: Talk and the agents use your plan\'s usage.', routes: { start: 'POST /api/claude/signin', code: 'POST /api/claude/signin/code', cancel: 'POST /api/claude/signin/cancel' } },
      { id: 'api-key', label: 'Your Anthropic API key', help: 'Billed by Anthropic to you, per token (console.anthropic.com).', routes: { set: 'POST /api/claude/key', remove: 'POST /api/claude/key {"key":null}' } },
    ],
  },
  { id: 'cursor', name: 'Cursor', by: 'Anysphere', methods: [{ id: 'api-key', label: 'Your Cursor API key', help: 'Runs on your Cursor plan.', routes: { set: 'POST /api/ai/cursor/key' } }] },
  { id: 'copilot', name: 'GitHub Copilot', by: 'GitHub', methods: [{ id: 'token', label: 'Your GitHub token with Copilot access', help: 'Runs on your Copilot plan\'s requests.', routes: { set: 'POST /api/ai/copilot/key' } }] },
  { id: 'gemini', name: 'Gemini', by: 'Google', methods: [{ id: 'api-key', label: 'Your Gemini API key', help: 'Billed by Google to you, per token (aistudio.google.com).', routes: { set: 'POST /api/ai/gemini/key' } }] },
  { id: 'antigravity', name: 'Antigravity', by: 'Google', methods: [{ id: 'signin', label: 'Sign in with Google', help: 'Runs on your Google AI plan.', routes: { start: 'POST /api/antigravity/signin', code: 'POST /api/antigravity/signin/code', cancel: 'POST /api/antigravity/signin/cancel' } }] },
];

// ------------------------------------------------------------------ the sealed store

const FILE = () => path.join(DATA, 'ai', 'keys.json');
type Store = Record<string, { value: string; at: number }>;
function read(): Store {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')) ?? {}; } catch { return {}; }
}
function write(store: Store) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE(), JSON.stringify(store), { mode: 0o600 });
}
const stored = (id: string) => { const v = read()[id]?.value; try { return v ? unseal(v) : null; } catch { return null; } };

/** Sets (or, with null, removes) a customer's key for Cursor, Copilot or Gemini, and puts it in its harness's env. */
export function setProviderKey(id: string, key: string | null) {
  if (!customerStudio()) throw new StudioError("This is J's Studio: its AI is set up on the server.", 409);
  const env = KEY_ENV[id];
  if (!env) throw new StudioError(`No key to set for "${id}".`, 404);
  const store = read();
  if (key === null || key === '') {
    delete store[id];
    delete process.env[env];
  } else {
    const k = String(key).trim();
    if (!KEY_FORMAT[id].re.test(k)) throw new StudioError(`That is not ${KEY_FORMAT[id].what}.`);
    store[id] = { value: seal(k), at: Date.now() };
    process.env[env] = k;
  }
  write(store);
  return linkState(id);
}

/** After an Antigravity sign-in in a customer's Studio: its login kept sealed, so a new instance has it again. */
export async function keepAntigravityLogin() {
  if (!customerStudio()) return;
  const raw = (await import('./antigravity-login.ts')).readAgyLogin();
  if (!raw) return;
  const store = read();
  store.antigravity = { value: seal(raw), at: Date.now() };
  write(store);
}

/** At start (server.ts): the customer's keys into their harnesses' env, their Antigravity login back in its file. */
export async function applyCustomerKeys() {
  if (!customerStudio()) return 0;
  let n = 0;
  for (const [id, env] of Object.entries(KEY_ENV)) {
    const k = stored(id);
    if (k) { process.env[env] = k; n++; } else delete process.env[env];
  }
  const agy = stored('antigravity');
  if (agy && (await import('./antigravity-login.ts')).restoreAgyLogin(agy)) n++;
  return n;
}

function linkState(id: string) {
  const k = KEY_ENV[id] ? stored(id) : null;
  return { linked: Boolean(k), keyTail: k ? k.slice(-4) : null };
}

/** Whether a provider can run Talk and the agents now. */
async function linked(id: Provider['id']): Promise<{ linked: boolean; via: string | null; keyTail: string | null }> {
  if (id === 'claude') {
    const c = (await import('./claude.ts')).customerClaude();
    return { linked: c.ready, via: c.via, keyTail: c.keyTail };
  }
  if (id === 'antigravity') {
    const { harnessConfigured } = await import('./brains.ts');
    return { linked: harnessConfigured('antigravity'), via: 'signin', keyTail: null };
  }
  const s = linkState(id);
  return { ...s, via: s.linked ? 'api-key' : null };
}

/** Whether any of the customer's own AI is linked (Talk, the PM and agents wait until one is: entitlements.ts). */
export async function aiReady() {
  for (const p of PROVIDERS) if ((await linked(p.id)).linked) return true;
  return false;
}

/** The one they picked becomes this Studio's harness (Settings brain), once it is linked. */
export async function useProvider(id: string, by: string) {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new StudioError(`No AI provider "${id}"`, 404);
  if (!(await linked(p.id)).linked) throw new StudioError(`Connect ${p.name} first.`, 409);
  const { saveSettings } = await import('./settings.ts');
  await saveSettings('brain', { harness: p.id }, { by, conversation: null });
  return aiLinks();
}

/** Each provider with whether it is linked and how (never a key: only that one is set and its last 4), and the one in use. */
export async function aiLinks() {
  if (!customerStudio()) return null;
  const { brainId } = await import('./brains.ts');
  const inUse = brainId();
  const providers: (Provider & { linked: boolean; via: string | null; keyTail: string | null; inUse: boolean })[] = [];
  for (const p of PROVIDERS) providers.push({ ...p, ...(await linked(p.id)), inUse: inUse === p.id });
  return { ready: providers.some((p) => p.linked), inUse, providers };
}
