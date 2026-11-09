# AI providers: subscription sign-ins, several at once, failover

J, 2026-11-09: "Be able to sign into all AI coding agent providers with subscription usage like what we have with claude
and have studio constantly working and able to easily switch between providers or even use multiple providers at once."
And: "make sure that it is able to properly fallback to other providers ... the studio should be able to use the
multiple providers almost seamlessly."

## Who signs in how

| Provider | Harness | CLI | Pays with | Sign-in (Settings → 🔌 AI providers) |
|---|---|---|---|---|
| Claude Code | `claude` | `claude` | the Claude plan | Claude accounts box (`claude setup-token`) |
| OpenAI Codex | `codex` | `codex` (`@openai/codex`) | a ChatGPT plan | **Sign in**: `codex login --device-auth`, a link and a code |
| Cursor | `cursor` | `agent` | the Cursor plan | **Sign in**: `agent login`, a link (or `CURSOR_API_KEY`) |
| GitHub Copilot | `copilot` | `copilot` (`@github/copilot`) | the Copilot plan | **Sign in**: `copilot login --device-code`, a link and a code (or `COPILOT_GITHUB_TOKEN`) |
| Google Antigravity | `antigravity` | `agy` | Google AI Pro/Ultra | Antigravity box: Google's link, paste the code back |
| Gemini API | `gemini` | `gemini` | a paid API key | **No subscription sign-in**: Google stopped the Gemini CLI accepting personal sign-ins (June 2026, `UNSUPPORTED_CLIENT`). The Google plan runs through Antigravity; `GEMINI_API_KEY` still works. |

`src/cli-signin.ts` runs the CLI's own device sign-in on the server (in `script` for a terminal, with a scratch home),
shows its link and code in Settings and answers its questions (Copilot asks to keep the token in a plain file: a server
has no keychain). J signs in on the provider's own page; the box updates through the push stream (`ai-logins`). When the
CLI exits signed in, Studio keeps only its login files (`~/.codex/auth.json`, `~/.config/cursor`, `~/.copilot/config.json`)
in `DATA/ai/logins/<provider>.json`, sealed (`src/ai-logins.ts`), which the state sync carries across Cloud Run
instances. Settings never sees a token, only whether it's signed in, as which account and since when.

Passes get a login as `<X>_CREDS` (base64 JSON of the files), set at start-up from the kept login (`shareCliLogins`).
`bin/ai-login-seed.mjs` writes it into the pass's home once; a token the CLI refreshes there is not overwritten, and what
it rewrote comes back (a cloud job sends `out/logins.json`; a probe reads its scratch home) and is kept, because OpenAI's
refresh tokens work once.

## Several at once (`src/providers.ts`)

Settings key `providers`: `mode` (`spread`, the default: every signed-in provider takes agent passes and scouts at once,
each new pass on the least busy one; `one`: everything on the harness chosen above, the order standing in), `order`
(the failover chain and the tie-break), `off` (never used), `roles` (a provider per role while it answers).
A provider is ready when it is signed in, its CLI is installed, it is on, and no hold is on it. A resumed pass stays on
the provider holding its session while it answers; otherwise it starts a fresh session on the next one with the brief
(sessions can't move between providers). Talk and Gen's calls stay on the chosen harness and its stand-in.

Routing (`settings.routing`) and the presets (`settings.tuning`) apply to every provider: the route picks a tier, and the
tier is that provider's model in Tuning → Models (`fast/standard/deep/max` per harness; Codex uses `:low`…`:xhigh` efforts,
or `model:effort`). A Claude Code model id in a run started on another provider becomes that provider's model for the
same tier (`sandbox.ts forHarness`). Conserve mode counts a usage limit only on the provider it hit.

## Self-healing

A usage limit, a lost sign-in, billing or an outage holds that provider (`src/harness-hold.ts`): its parked passes move
to the next ready provider at once, and it is probed on its schedule (reset time, or backoff) and takes work again when
it answers. Codex's own wordings are recognised ("hit your usage limit ... try again in 3 hours", "refresh token was
already used ... sign in again").

J hears only when he is needed (`providerTrouble`): a provider he uses is signed out or needs billing, or nothing at all
can run. Then the Inbox has ONE card, `ai:providers`, with the real reason, a link to Settings → AI providers and
buttons: **Check again** (probes now), **Stop using X**, **Use every signed-in provider** (in `one` mode). It is rebuilt
from the holds each time, so it disappears by itself once healed. His phone hears once per sign-in or billing hold.

## API

`GET /api/ai/providers` (status, logins, trouble); J's click only: `POST /api/ai/providers` (mode, order, off, use, roles),
`/api/ai/signin`, `/api/ai/signin/cancel`, `/api/ai/signout` (`{provider}`: cursor, codex, copilot), `/api/ai/recheck`.

Tests: `test/provider-failover.test.ts` (a real Studio: Claude limited, the change moves to Codex and finishes, the Inbox
card heals), `test/providers.test.ts`, `test/cli-signin.test.ts`, `test/codex-agent.test.ts`, `test/ai-login-seed.test.ts`.
