// Running Claude Code on the server (Talk and the agent workers). With a subscription token (CLAUDE_CODE_OAUTH_TOKEN,
// from "claude setup-token") it uses that Claude account's plan; without it, the API key (ANTHROPIC_API_KEY) is billed
// per token. The token is the account chosen in Settings (claude-accounts.ts), else the environment's (the AWS secret
// hawkes/claude). Claude Code prefers the API key when both are set, so the key is removed from the environment
// whenever there is a subscription token.

import { activeToken } from './claude-accounts.ts';

export const usingSubscription = () => Boolean(activeToken());

export function claudeEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  const token = extra.CLAUDE_CODE_OAUTH_TOKEN ?? activeToken();
  if (token) {
    env.CLAUDE_CODE_OAUTH_TOKEN = token;
    delete env.ANTHROPIC_API_KEY;
  }
  return env as NodeJS.ProcessEnv;
}

export const billing = () => (usingSubscription() ? 'Claude Max subscription' : 'API (per token)');
