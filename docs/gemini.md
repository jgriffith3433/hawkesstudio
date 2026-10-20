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

### Logging in (once)

On Linux `agy` stores its login in `~/.gemini/antigravity-cli/antigravity-oauth-token` (it holds a refresh token).

1. `ssh ubuntu@<server>` then `sudo -iu hawkes agy`, sign in with Google, paste the code, `/quit`. If it asks to trust
   `/home/hawkes`, say yes.
2. Copy that file off, then `node deploy/antigravity-key.mjs <file>`; it stores `hawkes/antigravity`. The server writes
   `AGY_CREDS`, and each sandboxed agent user gets the file in its own home on first use. The Studio service itself uses the
   `hawkes` login.
3. `node deploy/deploy.mjs` installs `agy` to `/usr/local/bin` and wires the secret. Then choose Google Antigravity in
   Settings, Harness.

If the refresh token is ever revoked, repeat steps 1 and 2.

## Gemini API key

`node deploy/gemini-key.mjs` stores `GEMINI_API_KEY` (an AI Studio key). Vertex: set `GOOGLE_GENAI_USE_VERTEXAI` and its
project variables. Tiers map to `flash`, Auto and `pro`.

## What is not proven

- The Ultra quota (a window that refreshes about every five hours, plus a weekly cap, no published numbers). Run a scout
  and watch the ledger. Quota wording from `agy` is not known yet, so the hold regexes may need one more pattern.
- `.agents/mcp_config.json` was verified in a plain folder and in the adapter's own run; agents run in git worktrees.
