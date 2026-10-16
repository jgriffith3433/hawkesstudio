// Running Claude Code on the server (Talk and the agent workers). With J's subscription token
// (CLAUDE_CODE_OAUTH_TOKEN, from "claude setup-token", secret hawkes/claude) it uses his Claude Max plan; without it,
// the API key (ANTHROPIC_API_KEY) is billed per token. Claude Code prefers the API key when both are set, so the
// key is removed from the environment whenever the subscription token is there.

export const usingSubscription = () => Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);

export function claudeEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) delete env.ANTHROPIC_API_KEY;
  return env as NodeJS.ProcessEnv;
}

export const billing = () => (usingSubscription() ? 'Claude Max subscription' : 'API (per token)');
