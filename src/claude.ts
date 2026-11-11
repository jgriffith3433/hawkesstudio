// Running Claude Code on the server (Talk and the agent workers). With a subscription token (CLAUDE_CODE_OAUTH_TOKEN,
// from "claude setup-token") it uses that Claude account's plan; without it, the API key (ANTHROPIC_API_KEY) is billed
// per token. The token is the account chosen in Settings (claude-accounts.ts), else the environment's (the AWS secret
// hawkes/claude). Claude Code prefers the API key when both are set, so the key is removed from the environment
// whenever there is a subscription token.

import fs from 'node:fs';
import path from 'node:path';
import { activeToken } from './claude-accounts.ts';
import { copilotEnv } from './tuning.ts';
import { DATA, StudioError } from './config.ts';
import { customerStudio } from './tenancy.ts';
import { seal, unseal } from './cellkeys.ts';
import { queueWake } from './queuewake.ts';

export const usingSubscription = () => Boolean(activeToken());

export function claudeEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...copilotEnv(), ...process.env, ...extra };
  // A customer's Studio: their own Claude only (their subscription in Claude accounts, else their API key), never a
  // credential from this server's environment, which is ours (hawkesgen AGENTS.md "Customers (tenancy)").
  if (customerStudio()) {
    for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) delete env[k];
    const own = extra.CLAUDE_CODE_OAUTH_TOKEN ?? activeToken();
    if (own) env.CLAUDE_CODE_OAUTH_TOKEN = own;
    else if (customerKey()) env.ANTHROPIC_API_KEY = customerKey();
    return env as NodeJS.ProcessEnv;
  }
  const token = extra.CLAUDE_CODE_OAUTH_TOKEN ?? activeToken();
  if (token) {
    env.CLAUDE_CODE_OAUTH_TOKEN = token;
    delete env.ANTHROPIC_API_KEY;
  }
  return env as NodeJS.ProcessEnv;
}

export const billing = () => (customerStudio() ? (usingSubscription() ? 'your Claude subscription' : customerKey() ? 'your Anthropic API key' : 'no AI linked yet') : usingSubscription() ? 'Claude Max subscription' : 'API (per token)');

// ------------------------------------------------------------ a customer's own Claude
// Their Anthropic API key, kept like the Claude accounts (.data/claude, 0600, sealed with the cell's STUDIO_SECRETS_KEY,
// never in the API: the dashboard sees the last 4 characters). Set by their admin in Settings (POST /api/claude/key). Their subscription is a Claude account
// instead (claude-accounts.ts, the same sign-in as J's).
const KEY_FILE = () => path.join(DATA, 'claude', 'customer-key.json');

export function customerKey(): string | undefined {
  try { return unseal(JSON.parse(fs.readFileSync(KEY_FILE(), 'utf8')).key) || undefined; } catch { return undefined; }
}

export function setCustomerKey(key: string | null) {
  if (!customerStudio()) throw new StudioError("This is J's Studio: its Claude is Settings → Claude accounts.", 409);
  if (key === null || key === '') {
    fs.rmSync(KEY_FILE(), { force: true });
    queueWake('the Claude key was removed');
    return customerClaude();
  }
  const k = String(key).trim();
  if (!/^sk-ant-api\d\d-[A-Za-z0-9_-]{20,}$/.test(k)) throw new StudioError('That is not an Anthropic API key (sk-ant-api…).');
  fs.mkdirSync(path.dirname(KEY_FILE()), { recursive: true, mode: 0o700 });
  // Sealed with the cell's own key (cellkeys.ts) where it has one: the state bucket holds only ciphertext.
  fs.writeFileSync(KEY_FILE(), JSON.stringify({ key: seal(k), at: Date.now() }), { mode: 0o600 });
  // Work held for "connect your AI first" starts now (agents.ts customerAgentGate).
  queueWake('a Claude key was linked');
  return customerClaude();
}

/** What a customer's Studio runs Claude on: their subscription, their key, or nothing yet (Talk and agents wait). */
export function customerClaude() {
  const sub = Boolean(activeToken());
  const key = customerKey();
  return { ready: sub || Boolean(key), via: sub ? 'subscription' : key ? 'api-key' : null, keyTail: key ? key.slice(-4) : null };
}
