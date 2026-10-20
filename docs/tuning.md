# Agent tuning (Settings → Agent tuning)

Controls cost, speed and quality for every agent, scout, the PM and Talk. Code: `src/tuning.ts`; the Settings tab and
Talk (`studio_settings`, section `tuning`) edit it.

- **Tiers**: `fast`, `standard`, `deep`. Each harness maps a tier to a model (Settings → Models). Claude Code:
  Haiku, Sonnet, Opus. Copilot: the same families under Copilot's dotted ids. Cursor: its own default until set.
- **Roles**: each role has a tier, a reasoning effort (`low`…`max`) and a turn cap (0 = the role file's own).
- **Presets**: `economy`, `balanced` (default), `quality`. A preset sets every field; editing one makes it `custom`.
  Balanced runs the mid model nearly everywhere and the deep one only for the PM's and reviewer's judgement.
- **Retry on a deeper model**: the second try of a task uses the next tier up (never Talk), so cheap runs go first.
- **Pass limits**: minutes one agent pass may run (stopped and resumed, not failed).
- **Small jobs**: the tier for triage, dedupe, summaries, canon checks and reviews that Studio runs through Gen.
- **Copilot**: `maxCredits` becomes the CLI's `--max-ai-credits` (minimum 30, 0 = none) and `contextTier` its
  `--context`. Copilot bills a premium request per prompt times the model's multiplier and tool calls inside a run
  are free, so the model tier and the number of resumed passes cost; the turn cap is a runaway guard (the adapter
  enforces `--max-turns` itself and ends such a run as `error_max_turns`).

Env `STUDIO_MODEL_<ROLE>` still overrides a role's model. Changes that spend more need J's quoted yes from Talk.
