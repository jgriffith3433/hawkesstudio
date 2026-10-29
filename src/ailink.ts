// Linking a customer's own AI (docs/studio-customers.md, section 4; J, 2026-10-29). Onboarding's "Connect your AI"
// step and Settings show this list. Talk and the agents in a customer's Studio run only on what is linked here, never on
// J's key or plan (claude.ts claudeEnv). Each provider says how it links; Claude is the only one for now, and another
// slots in as one more entry with its own link routes.
//
// Claude links two ways, both the customer's own:
//   - an Anthropic API key (POST /api/claude/key), sealed at rest with the cell's key and never shown again (the last 4)
//   - their Claude subscription: Claude Code's `claude setup-token` sign-in (claude-accounts.ts, the same flow as J's,
//     per cell: POST /api/claude/signin, then /api/claude/signin/code with the code Claude shows them)

import { customerStudio } from './tenancy.ts';

export type LinkMethod = { id: 'api-key' | 'subscription'; label: string; help: string; routes: Record<string, string> };
export type Provider = { id: string; name: string; by: string; methods: LinkMethod[] };

export const PROVIDERS: Provider[] = [
  {
    id: 'claude', name: 'Claude', by: 'Anthropic',
    methods: [
      { id: 'subscription', label: 'Sign in with your Claude subscription', help: 'Pro or Max: Talk and the agents use your plan\'s usage.', routes: { start: 'POST /api/claude/signin', code: 'POST /api/claude/signin/code', cancel: 'POST /api/claude/signin/cancel' } },
      { id: 'api-key', label: 'Your Anthropic API key', help: 'Billed by Anthropic to you, per token (console.anthropic.com).', routes: { set: 'POST /api/claude/key', remove: 'POST /api/claude/key {"key":null}' } },
    ],
  },
];

/** Each provider with whether it is linked and how (never a key: only that one is set and its last 4). */
export async function aiLinks() {
  if (!customerStudio()) return null;
  const { customerClaude } = await import('./claude.ts');
  const c = customerClaude();
  return {
    ready: c.ready,
    providers: PROVIDERS.map((p) => ({ ...p, linked: p.id === 'claude' ? c.ready : false, via: p.id === 'claude' ? c.via : null, keyTail: p.id === 'claude' ? c.keyTail : null })),
  };
}
