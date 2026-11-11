# The agent platform: roles, skills, Talk at full power, the guards

Everything here runs on the cloud control server (`/srv/hawkes`); J's laptop and phone are windows into it. The shared
memory every one of these agents reads and writes is in `docs/memory.md`.

## Roles (in git)

Every Claude Code that Studio runs is one of the roles in `.claude/agents/<role>.md`: its model, its tools and its
standing instructions (the file's body). They are ordinary Claude Code agent files, so a session on J's laptop can use
them too.

| Role | Runs | Model | Tools |
|---|---|---|---|
| `talk` | Talk conversations (J's partner and PM) | Sonnet (Studio's own result turns on Haiku; Opus or Fable when J asks) | MCP (Studio, Gen), read, skills, subagents; in the sandbox also shell, editor, web |
| `pm` | the day's "Studio PM" conversation (PM turns) | Sonnet | MCP, read, skills, subagents |
| `fixer` | an agent change for backlog findings | routed (below) | read, edit, git, npm/node (in the sandbox: any shell) |
| `builder` | J's requests, roadmap tasks, Studio and Gen changes | routed | the same |
| `content` | requests about story and content (`roleOf` in agents.ts) | routed (Sonnet or above) | the same; its diff gets the canon check |
| `scout` | `studio_scout` (read-only investigation), Talk's research subagent | Haiku | read, git log/show |
| `reviewer` | a subagent for a second opinion on a change | Sonnet | read, git diff |
| `planner` | a subagent for a deep plan, only when J asks for Fable | Fable | read |
| `architect` | a subagent for one design decision or a re-scope, only when J asks for Opus | Opus | read |

**Harness** (Settings, `src/brains.ts`): Claude Code, Cursor or GitHub Copilot (`docs/copilot.md`), and the model. Copilot runs `bin/copilot-agent.mjs` the same way, and is also the last stand-in in the fallback chain (`STUDIO_HARNESS_ORDER`, default `claude,cursor,copilot`). Cursor runs `bin/cursor-agent.mjs`, which launches Cursor's `agent` on the Cursor plan (`CURSOR_API_KEY` from the hawkes/cursor secret) and speaks the same stream-json, so the roles, tools and MCP servers stay. On the control server, a Studio that has never stored a harness uses Cursor on Auto when that key is present (Claude usage ran out, J 2026-10-19) and tells Gen, whose writing and review calls follow (`settings.brain`). Auto is Cursor's router (including the free pool when premium usage is out). Claude Code still uses the model each role names, unless Settings picks one.

`src/roles.ts` turns a role into flags: `--model`, `--append-system-prompt` (the role's instructions, then Studio's
context for that run), `--allowedTools` / `--disallowedTools`, `--max-turns`, and `--plugin-dir hawkesstudio/.claude`.
`STUDIO_MODEL_<ROLE>` overrides a role's model (`TALK_MODEL` and `SCOUT_MODEL` still work); `STUDIO_MODEL_OPUS`,
`_SONNET`, `_HAIKU` map the aliases. `GET /api/agents/roles` lists roles and skills. Change a role by editing its file
(it deploys like any Studio change); keep the instructions short and general: the task goes in the brief.

A role file can say what changes in the agent sandbox: `sandbox-tools`, `sandbox-allowed-tools`,
`sandbox-disallowed-tools`, and parts of its body between `<!-- sandbox -->` and `<!-- /sandbox -->` (only there) or
`<!-- no-sandbox -->` and `<!-- /no-sandbox -->` (only without it). `<projects>` becomes the projects folder.

## Skills (in git)

`.claude/` is also a Claude Code plugin ("hawkes", `.claude/.claude-plugin/plugin.json`). With `--plugin-dir` every run
gets its skills, procedures loaded only when needed, and the roles as subagents (`hawkes:scout`, `hawkes:reviewer`):

| Skill | For |
|---|---|
| `unity-build-debugging` | failed or wrong Unity WebGL builds (Git LFS, CRLF, loaders, the build server) |
| `playtest-scenario` | adding a scenario so acceptance criteria show in a playtest |
| `go-live-checklist` | DEPLOY / ROLLBACK, what to show J, what happens after |
| `gen-assets` | generation through Hawkes Gen: tools, presets, manifests, costs |
| `gen-3d-characters` | rigged characters via Gen (`character3d`: image → clips → FBX/GLB → Unity prefab) |
| `github-pages` | static hosting, pages.yml, the Pages source switch, beta vs live |
| `windows-shell-quirks` | CRLF working trees, heredoc and Python escaping, paths, git on the server |
| `shared-memory` | reading and writing the memory |
| `studio-gen-changes` | changing Studio or Gen safely |
| `sickofit-howto`, `doseofdestruction-howto`, `phorigins-howto`, `unity-web-games-howto`, `static-sites-howto` | each product |

Add a skill: `.claude/skills/<name>/SKILL.md` with `name` and `description` frontmatter (the description is what makes
Claude load it: say when). On J's PC: `claude --plugin-dir C:/Projects/hawkesstudio/.claude`.

## Speed

- **A model per job (routing, `src/routing.ts`; J, 2026-10-23: "only use the highest tier models upon request"):**
  every agent change is classified by its words, role and size into a category with a default tier: lookups, small
  edits and tests from a spec on Haiku; scoped features, bugs with a repro, refactors and content on Sonnet; systems work
  (netcode, render or build pipelines, migrations), far-from-symptom bugs and long runs on Opus, within a daily budget
  of automatic Opus passes (`deepPerDay`, default 6) and never for `conserveHours` (6) after the plan hit a usage limit.
  Each failed attempt climbs one tier (at most 2, never past Opus), with the earlier attempts' summaries and stuck
  reports in its brief ("context carries up"); an agent stuck after two approaches stops and writes `.hawkes/stuck.md`
  instead of iterating. Past its climbs the brief tells it to re-scope. **Fable only on J's request**: Talk passes
  `model: "fable"` (or `"opus"`) to `studio_task` / `studio_routing premium` only when J asked in his own words, and
  Studio checks his newest message (or his quoted words, `jSaid`). Talk's turns: Studio's own result turns on Haiku,
  J's turns on Sonnet, or the model his message asks for. Talk, the PM and the reviewer run on Sonnet, scouts on
  Haiku; Studio's small calls through Gen: Haiku for triage and dedupe, Sonnet for reviews and canon checks (`jobModel`).
  Settings → Model routing shows each tier's share of the last 7 days' usage against its target (Haiku 10-15%,
  Sonnet 50-60%, Opus 20-30%, Fable 5-10%), today's Opus passes, conserve mode and J's premium asks
  (`GET /api/routing`, `studio_routing`); the pass ledger records each pass's category and premium.
- **Prompt caching:** the stable parts come first and stay the same between runs: the role's instructions, then
  Studio's context, then the shared memory's decisions and preferences (they change only when the memory does). What
  changes per task is in the brief or the turn's message (Talk's per-turn memory matches are appended to J's message).
- **Warm starts:** a new agent worktree gets `node_modules` copied from a checkout with the same lockfile (the beta
  working copy, the server's checkout, a recent worktree: `warm.ts`), so it doesn't `npm ci`; installs that still
  happen share one npm cache (`STUDIO_NPM_CACHE`).

## Talk at full power

Without the sandbox, Talk is what it was: read-only, plus the Studio and Gen tools, changes through agents. In the agent
sandbox (below) it is full Claude Code:

- **Shell, editor, web, subagents.** Its working directory is still the projects folder (so conversations resume), and
  everything there is readable; it can write only its workspace and the shared work folder.
- **Its workspace:** `/srv/hawkes/.talk/<repo>`, a worktree of each product repo on beta (`studio_workspace`, `POST
  /api/workspace/<product>`: makes it, or moves a clean one to beta's tip).
- **The fast lane** (`src/fastlane.ts`, `studio_fastlane`, `POST /api/fastlane/<product> { message }`): Talk commits a
  small change in its workspace; Studio, which holds the GitHub token, commits what's uncommitted, checks it (at most
  `STUDIO_FAST_FILES` files, default 8, and `STUDIO_FAST_LINES` lines, default 200; no binaries; no secrets, keys,
  workflows, generated output or deleted `.meta` files; the product's checks, run as the sandbox user; the canon check for
  content), and pushes it to beta as a fast-forward (never forced, never main). Beta's run follows and reports back to
  the conversation. Studio and Gen have no fast lane. Every push is in the run history (kind `fastlane`).
- **Agents for real work:** features, several files, Unity code (it can't compile on Linux), anything that should be
  playtested before beta.
- **Looking at pages:** WebFetch (live sites), the beta builds on disk, and a real browser through a playtest
  (`studio_playtest`, or Gen's `playtest.run` with mode `generic` or `site`: screenshots, video, console).
- **Attachments** J adds are copied into the shared work folder (`.work/.agent/attachments`), since Talk can't read
  Gen's data.
- If a conversation's Claude Code session can't be found (a new home, a cleared cache), the turn starts a new session
  with the conversation so far, once.

## Agents at Talk's power

Since 2026-11-02 (J: "Why don't they just get the full MCP setup like Talk") an agent change gets what Talk gets:

- **Studio's whole tool server** (agents.ts agentMcp): backlog, reports, playtests, previews, roadmap, the other
  projects, deploy plans. The guards below apply to both (the agents' key). Its list swaps `studio_talk` for
  `studio_tell`. Scouts keep their narrow list.
- **The shell and the web on Cloud Run** (roles.ts): a run there is a job on its own machine, so the agent roles get
  their sandbox tool lists, as on the server. Talk gets its `cloud-*` lists too, with its `<!-- cloud -->` instructions:
  it reads code and makes small changes through `studio_github_api` (a branch of its own, then a pull request into
  beta), since nothing is checked out in its job.
- **`studio_tell`** (access.ts agentSays): progress, a result or a question goes to the Talk conversation that started
  the work, and Talk passes it on to the owner. With no conversation, a question goes to the Inbox. An agent that
  pauses on `.hawkes/question.md` is passed to that conversation too (agentPaused).
- **Starting work**: `studio_task` / `studio_fix` start up to 3 tasks per change (access.ts agentStarts). Those tasks
  can't start more. They report where their parent reports (followup.ts originOf).
- **`studio_gen_import`** (agents and Talk): puts a Gen file into the repo, resized or converted by image.transform.
  Files come from the Studio's own Gen library, or its owners' own hawkesgen.ai libraries (the owner's widening). In a
  customer's cell they go through the control plane (cells.ts `/api/cells/self/gen-asset`). Gen's owner key stays
  there. It hands out a file only from that org's Gen org, or from the account of an owner who signed in with Google at
  the control plane, never from the people a cell reports about itself. A copy goes into the Studio's own library.
  Every import is logged (`GET /api/agents/access`, and the change's log).
- **GitHub** (agent-github.ts, `studio_github_api`, agents and Talk): REST calls to any of the Studio's own repos with
  Studio's token, so the agent holds none. It can read everything except secrets, keys and webhooks. It can write
  issues, pull requests (opened from its own branch), reviews that comment, Actions dispatches and re-runs, and its own
  claude/* or agent/* branches with their files. Merging, approving, pushes to main, beta or dev, releases, settings and
  deletes stay with Studio's gates. Writes are logged.
- **Read-only copies of the other repos** (cloudjob.ts / cloudjob-run.ts): shallow clones of the Studio's other
  projects' repositories at `../<worktree>.repos/<name>`. Their tokens are read-only and scoped to one repo, and the
  copies are never sent back. A change there is that project's own task.

Both widenings are on by default. Settings `agents.access: { gen, repos }` turns either off Studio-wide, and a
project's `access` overrides that. Isolation between customers is the Studio's own: each cell's keys reach only its
own org's Gen projects and repos.

## What else is in flight (every pass)

Every agent pass (a first pass, a resumed session, an answer, a conflict pass, a nudge; products and Studio/Gen) starts
with a short section at the end of its prompt (`passPrompt` in `src/agents.ts`, `src/inflight.ts`): the product's other
agent changes (status, branch, pull request, the files each touched so far), its roadmap tasks being worked or reviewed,
and the builds and beta or daily runs going for it, with what started them. It is read from Studio's own tables as the
pass starts: no git, no other service. The files come from `change_files`, recorded after each pass (`recordTouched`);
the overlap rule (`shapeOf`, parallel.ts) uses them too, so an earlier change whose worktree is gone still counts.
The section's rules: don't redo another change's work; keep an edit in a file another change is editing small and say
so; never start a build or trigger one (Studio builds at a milestone's end); and when another change already does the
whole task, commit nothing and write "Already done by <change id>", which `alreadyDone` treats like any already-done
change (a fix's bugs are fixed; a task's claim is checked by the PM, `doneProof`). Bounded: 12 changes, 15 files each.

## The guards

The guards are in the infrastructure, not in the prompt.

1. **The agent sandbox** (`src/sandbox.ts`, set up by `deploy/agent-sandbox.mjs`): Talk, agents, scouts, and the checks
   and installs Studio runs in agent worktrees (agent-written code: tests, package scripts) run as the Linux user
   `hawkes-agent`, through `sudo -n -u hawkes-agent /usr/local/bin/hawkes-agent-run` (sudoers allows Studio's user only
   that). Their environment has nothing secret but the Claude login (Claude Code can't run without it; checks don't get
   it): no GitHub token, no AWS role marker, no service keys. They can't read `/etc/hawkes/keys.env`, `/run/hawkes/*.env`,
   Studio's or Gen's `.data` (750 now; they were 777) or Studio's home. An iptables owner rule
   (`hawkes-agent-firewall.service`) blocks them from the instance metadata service, so the server's IAM role is out of
   reach. They reach Gen only through its API with their own key (`TALK_GEN_KEY`, role `user`: jobs, no fleet, no keys;
   Gen refuses keyless local calls, `localOpen` is off on the server). In the shared repos they can write objects, refs
   and worktree state, never a repo's `config` or `hooks`, so nothing they write runs as Studio. Studio turns all this on
   when its unit has `HAWKES_AGENT_USER` (the drop-in the script writes); `HAWKES_SANDBOX=off` turns it off.
2. **Studio's API knows who is calling** (`requestUser`: the owner of the loopback connection, from `/proc/net/tcp`). A
   request from the sandbox user is never J's, whatever its headers say (`memory-api.ts callerOf`), and
   (`src/guards.ts`):
   - going live (`POST /api/deploy/<product>`) needs J's own latest message in that conversation to say `DEPLOY <product>`;
   - a rollback needs `ROLLBACK <product>`; approving a Studio or Gen change (a merge into main, which deploys) needs
     `MERGE <id>`;
   - agent settings, notifications and the memory seed are J's dashboard only; PM settings only from a conversation.
   Studio checks the words in J's message, not Claude's account of them. Beta stays open on purpose: the PM's delegated
   merges and Talk's fast lane.
3. **GitHub rulesets on main** (`deploy/github-rulesets.mjs`, every product repo, website repo, hawkesstudio and
   hawkesgen): "main is never rewritten" (no deletion, no force push, no bypass) and "who may push main" (only repository
   admins bypass: J, and Studio's go-live, which uses J's token). The sandbox holds no GitHub token at all.
4. **Ask J first** (in the roles' instructions, and where it costs money also in Gen's roles): money (GPU servers, big
   batches, raising limits), deleting anything, anything live, and Studio's own deploy, secrets and CI files (the
   `GUARDED` list in agents.ts).

Agent-written code never runs as Studio: the agent's own checks, Studio's checks and `npm ci` for Studio/Gen changes
(`agents.ts sh`), the verification dev server (`local.ts serveDir`), preview and beta builds (`previews.ts`) and the
fast lane's checks all run as the sandbox user. Before Studio runs git in a worktree the sandbox could write, it checks
the worktree still links into that repo (`assertWorktree`).

**Agents commit in their worktrees** (`sandbox.ts shareRepo`, `shareWorktree`, `shareAll`). Studio (user `hawkes`)
makes each worktree, so its git folder (`<repo>/.git/worktrees/<id>`: index, index.lock, HEAD, logs, ORIG_HEAD,
MERGE_*) would be `hawkes`' and unwritable to `hawkes-agent` (`index.lock: Permission denied`, 2026-10-16/17). So:
- every repo has `core.sharedRepository=group` (files git creates in `.git` are group-writable whatever the umask), and
  `.git` and `.git/worktrees` are the agent group's (`hawkes-work`) and setgid, so the `.git/worktrees` git deletes after
  the last prune comes back right;
- git (2.43) still makes `.git/worktrees/<id>` itself 755, and a Studio commit or merge there leaves files like
  COMMIT_EDITMSG 644: `shareWorktree` (chgrp, g+rwX, setgid) runs on every pass of a change (agents.ts prepare, product
  and infra), and on Talk's workspace (fastlane.ts);
- at start Studio sweeps every repo in the projects folder and every worktree in `.work` (`shareAll`), so repos and
  worktrees made before this are covered. None of it needs `deploy/agent-sandbox.mjs`.

The safety net stays: an agent that finished but says its commit was refused (`COMMIT_DENIED` in agents.ts) and left
changes gets them committed by Studio (hooks off), logged as "Studio committed its work and publishes it".
`test/sandbox.test.ts` checks a fresh worktree's git folder is the agent group's and group-writable under umask 022.

Known limits: the sandbox holds the Claude login (Claude Code needs it; it is only good for Claude); it can move local
refs in the shared repos (the worst it reaches is beta, and Studio fetches before it builds); a process an agent leaves
running in the background keeps its access until the next restart.

### Turning it on (J's OK first: it changes the production server and GitHub)

```bash
node deploy/agent-sandbox.mjs --dry-run   # the script it runs on the server
node deploy/agent-sandbox.mjs             # set up, restart Studio, run the checks (keys, data, metadata, git hooks...)
node deploy/agent-sandbox.mjs --check     # the checks again
node deploy/github-rulesets.mjs           # what the rulesets would change on each repo (nothing yet)
node deploy/github-rulesets.mjs --apply
```

`node deploy/agent-sandbox.mjs --off` and `node deploy/github-rulesets.mjs --remove` undo them.
