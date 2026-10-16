# Hawkes Studio

The cockpit for every Hawkes Biomedical product. Every day it builds, playtests and reviews all of them, keeps the
backlog, and writes the morning report J reads with Claude. One person, eight products, real QA.

```
auto-start.bat      →  http://127.0.0.1:8791
```

| Tab | What |
|---|---|
| **Today** | A card per product: git state, last build, each playtest scenario (local and live), Claude's verdict and scores, screenshots, open findings, and buttons to smoke-test, run a full trial, build, or go live (the plan: beta vs main and how beta played, then a typed `DEPLOY <product>`; rollback from there too) |
| **Report** | Any run: every step, the playtest videos, each review's summary and findings with screenshots |
| **Backlog** | Findings across all days, merged. Mark them fixing, fixed or won't fix |
| **Runs** | History, with every step live while a run is going |

## How it works

- **[docs/playtest.md](docs/playtest.md):** the playtest contract. Every game exposes `window.hawkesPlaytest`, and its
  own bot plays scenarios through real input.
- **[docs/daily.md](docs/daily.md):** the daily loop, and how J and Claude work it.
- **[AGENTS.md](AGENTS.md):** the commands, the layout and the rules.
- **Hawkes Gen** (`C:\Projects\hawkesgen`) does the heavy lifting as jobs:
  - Unity WebGL builds on an AWS build server that keeps each project's Library, so builds are incremental
  - Unity tests
  - browser playtests (Playwright, real GPU)
  - Claude reviews
  - generated assets

## Commands

```bash
studio.cmd status
studio.cmd daily --wait
studio.cmd playtest sickofit smoke --wait
studio.cmd build yoobaland --wait
studio.cmd test sickofit EditMode --wait
studio.cmd report latest
studio.cmd backlog
studio.cmd assets phorigins make
studio.cmd deploy doseofdestruction        # the go-live plan (beta vs main); --confirm "DEPLOY doseofdestruction" goes live
studio.cmd rollback doseofdestruction      # the rollback plan; --confirm "ROLLBACK doseofdestruction"
```

To run the daily trial at 5 AM every day: `powershell -File bin\schedule.ps1 -At 05:00` (J's call: it's a standing
setting on this PC).
