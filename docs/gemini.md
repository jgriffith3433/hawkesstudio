# Gemini harness

Studio can run Talk, the PM, agents, scouts and reviews on the Gemini CLI (`@google/gemini-cli`), through
`bin/gemini-agent.mjs`. It is the fourth harness, after Claude Code, Cursor and Copilot, and takes part in the same
fallback chain and holds.

## How it works

The adapter takes Claude Code's arguments, runs `gemini -p ... -o stream-json --approval-mode yolo`, and rewrites the
events (`init`, `message`, `tool_use`, `tool_result`, `error`, `result`) into Claude's stream-json. It keeps a session id
per conversation (`--session-id` the first turn, `--resume` after), writes the MCP servers Studio asks for into a system
settings file (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`), puts the role's instructions in front of the first turn, and ends a
run at `--max-turns` itself. Claude model ids are dropped; `pro`, `flash`, `flash-lite` and `gemini-*` pass.

Tiers map to `flash` (fast), Gemini's own Auto (standard) and `pro` (deep). Change them in Settings, Tuning.

## Logging in

Pick one.

- **Google AI Ultra / Pro account (no per-token bill).** On a machine with a browser run `gemini` and choose "Sign in with
  Google". That makes `~/.gemini/oauth_creds.json`. Then `node deploy/gemini-key.mjs --login` stores it as
  `hawkes/gemini` (base64 in `GEMINI_OAUTH_CREDS`); the server writes it to `~/.gemini` on first use.
- **API key.** `node deploy/gemini-key.mjs` stores `GEMINI_API_KEY` (an AI Studio key). That is billed on the key, not on
  the Ultra plan.
- Vertex AI: set `GOOGLE_GENAI_USE_VERTEXAI` and its project variables.

Restart with `sudo systemctl restart hawkes-secrets hawkes-gen hawkes-studio`, or deploy. Then choose Google Gemini in
Settings, Harness.

## Limits and what is not proven

- Google documents Ultra as 2,000 requests per user per day for the CLI and a quota that refreshes every five hours in
  Antigravity; the two pages disagree and publish no token numbers. Run a scout through it and watch the ledger.
- Quota errors (`RESOURCE_EXHAUSTED`, "exhausted your capacity", "quota will reset after 3h45m") are read as a usage
  hold, and the reset time is parsed, so Studio falls back to another harness and comes back by itself.
- The event translation is built from the CLI's documented schema and tested with fixtures. It has not been recorded
  against a real signed-in account yet; the first real run may need small fixes in `translate`.
