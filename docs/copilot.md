# GitHub Copilot as a harness

Studio runs its agents, PM, scouts, Talk and Gen's writing/review calls on a **harness**: Claude Code, Cursor, or
GitHub Copilot. Pick one in Settings → Harness. Copilot is also an automatic stand-in: when the chosen harness is out
of usage, billing-blocked, logged out or overloaded, Studio holds it, probes it, and runs on the next configured
harness in the chain (default `claude,cursor,copilot`; override with `STUDIO_HARNESS_ORDER`) until the chosen one answers.

## How it works

- `bin/copilot-agent.mjs` takes Claude Code's argv (what `src/sandbox.ts` builds), runs
  `copilot -p … --output-format json --allow-all --no-ask-user --session-id <id>`, and re-emits Copilot's JSONL as
  Claude stream-json. Roles, sessions (resume), MCP servers (`--additional-mcp-config`) and harness-stop detection
  (`brains.ts` `STOPS`) work unchanged.
- Gen: `src/providers/copilot.ts` answers `ask()` when `settings.brain` is `copilot`. Studio syncs the harness to Gen.

## Server setup

1. Install the CLI (`deploy/deploy.mjs` does this): `npm i -g @github/copilot`.
2. Create a **fine-grained** personal access token with the **Copilot Requests** permission (classic `ghp_` tokens are
   rejected by Copilot), on an account with a Copilot plan.
3. `node deploy/copilot-key.mjs` stores it as the `hawkes/copilot` secret; redeploy or restart the services
   (`/run/hawkes/copilot.env` is loaded by both units). Alternatively run `copilot login` as the service user.
4. Settings → Harness → GitHub Copilot, optionally with a model (any id Copilot lists, for example `gpt-5.4` or
   `claude-sonnet-4.5`). Empty uses Copilot's default (`COPILOT_MODEL` env also works).

Env: `COPILOT_GITHUB_TOKEN`, `COPILOT_HOME`, `COPILOT_BIN`, `COPILOT_MODEL`, `COPILOT_EFFORT`. `GH_TOKEN` and
`GITHUB_TOKEN` (Studio's push token) never reach Copilot: the adapter (`copilotEnv`) removes them, since Copilot reads them
before its own login and refuses a classic `ghp_` one. A classic `COPILOT_GITHUB_TOKEN` is dropped too when a login is kept.

## Limits

- Copilot has no per-role tool allow/deny list, so the role restrictions Studio gives Claude are not enforced; the
  sandbox user and filtered environment are the guard.
- Claude model ids from roles are ignored; Copilot's default or the Settings model answers.
- Copilot's premium-request quota is the "usage" that runs out; that is classified as a harness stop and falls over.
- The JSONL event mapping follows the Copilot SDK's event schema; if a CLI release changes it, adjust `translate()` in
  the adapter (covered by `test/copilot-agent.test.ts`).
