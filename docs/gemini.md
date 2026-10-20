# Google harnesses

Studio has two, both through the same adapter pattern (`bin/*-agent.mjs` turns the CLI's events into Claude Code's
stream-json), both in the same fallback chain and holds. The chain is claude, cursor, copilot, antigravity, gemini.

| Harness | CLI | Pays with | Adapter |
|---|---|---|---|
| `antigravity` | `agy` | your Google AI Pro/Ultra plan (a sign-in) | `bin/antigravity-agent.mjs` |
| `gemini` | `gemini` (`@google/gemini-cli`) | a paid `GEMINI_API_KEY` (or Vertex) | `bin/gemini-agent.mjs` |

Google stopped the Gemini CLI from accepting personal Google sign-ins (`UNSUPPORTED_CLIENT`, June 2026), so a Pro/Ultra
plan only works through Antigravity. The Gemini harness is for an API key billed per token.

## Antigravity

The adapter runs `agy -p ... --output-format stream-json --dangerously-skip-permissions`, one call per turn, and reuses the
conversation id from the first turn (`--conversation`). Each tool is one step with `tool_info`; MCP calls arrive as
`call_mcp_tool` and are renamed `mcp__<server>__<tool>`. MCP servers go in `<cwd>/.agents/mcp_config.json` (remote ones as
`serverUrl`), which is kept out of git and removed when the run ends. `--max-turns` is counted by the adapter.

Models are `agy models` slugs with a level: `gemini-3.8-flash-medium` (fast), `gemini-4-argon-medium` (standard),
`gemini-4-argon-high` (deep); Claude Code's own ids are dropped. Change them in Settings, Tuning.

### Logging in

Settings → **🔑 Antigravity login** → **Sign in with Google** (`src/antigravity-login.ts`). Studio runs `agy` on the
server in a pseudo-terminal, picks Google OAuth and shows Google's link; you sign in with the Ultra account and paste the
code Google shows back into Settings. That is all: there is no terminal step and no secret to store.

- On Linux `agy` stores its login in `~/.gemini/antigravity-cli/antigravity-oauth-token` (it holds a refresh token).
  Studio keeps it in its own user's home and shares it with every `agy` it starts as `AGY_CREDS` (passed into the agent
  sandbox, `sandbox.ts`); `bin/antigravity-agent.mjs` writes it into the sandboxed user's home. A file with the same
  refresh token is left alone (agy refreshes it itself); a new sign-in replaces it. It is shared at start-up and every
  10 minutes, so a sign-in made in a terminal (`sudo -iu hawkes agy`) is picked up too.
- Signing in again (a revoked login, another Google account) is the same button. It lifts a hold on Antigravity at once.
- When `agy` loses its login, the turn is a harness stop (auth): Antigravity is held, another harness stands in, and Talk
  says to sign in from Settings instead of showing agy's one-time link (dead by then).
- The AWS secret `hawkes/antigravity` (`deploy/antigravity-key.mjs <file | ->`) still works: with no login in Studio's
  home, it seeds that home. `node deploy/deploy.mjs` installs `agy` to `/usr/local/bin`.

## Gemini API key

`node deploy/gemini-key.mjs` stores `GEMINI_API_KEY` (an AI Studio key). Vertex: set `GOOGLE_GENAI_USE_VERTEXAI` and its
project variables. Tiers map to `flash`, Auto and `pro`.

## What is not proven

- The Ultra quota (a window that refreshes about every five hours, plus a weekly cap, no published numbers). Run a scout
  and watch the ledger. Quota wording from `agy` is not known yet, so the hold regexes may need one more pattern.
- `.agents/mcp_config.json` was verified in a plain folder and in the adapter's own run; agents run in git worktrees.
