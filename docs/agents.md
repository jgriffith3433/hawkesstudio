# The agent platform: roles, skills, Talk at full power, the guards

Everything here runs on the cloud control server (`/srv/hawkes`); J's laptop and phone are windows into it. The shared
memory every one of these agents reads and writes is in `docs/memory.md`.

## Roles (in git)

Every Claude Code that Studio runs is one of the roles in `.claude/agents/<role>.md`: its model, its tools and its
standing instructions (the file's body). They are ordinary Claude Code agent files, so a session on J's laptop can use
them too.

| Role | Runs | Model | Tools |
|---|---|---|---|
| `talk` | Talk conversations (J's partner and PM) | Opus | MCP (Studio, Gen), read, skills, subagents; in the sandbox also shell, editor, web |
| `pm` | the day's "Studio PM" conversation (PM turns) | Opus | MCP, read, skills, subagents |
| `fixer` | an agent change for backlog findings | Sonnet | read, edit, git, npm/node (in the sandbox: any shell) |
| `builder` | J's requests, roadmap tasks, Studio and Gen changes | Opus | the same |
| `content` | requests about story and content (`roleOf` in agents.ts) | Opus | the same; its diff gets the canon check |
| `scout` | `studio_scout` (read-only investigation) | Opus | read, git log/show |
| `reviewer` | a subagent for a second opinion on a change | Sonnet | read, git diff |

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
| `github-pages` | static hosting, pages.yml, the Pages source switch, beta vs live |
| `windows-shell-quirks` | CRLF working trees, heredoc and Python escaping, paths, git on the server |
| `shared-memory` | reading and writing the memory |
| `studio-gen-changes` | changing Studio or Gen safely |
| `sickofit-howto`, `doseofdestruction-howto`, `phorigins-howto`, `unity-web-games-howto`, `static-sites-howto` | each product |

Add a skill: `.claude/skills/<name>/SKILL.md` with `name` and `description` frontmatter (the description is what makes
Claude load it: say when). On J's PC: `claude --plugin-dir C:/Projects/hawkesstudio/.claude`.

## Speed

- **A model per job:** Opus for planning and hard work (Talk, the PM, builds, content, scouts), Sonnet for routine
  fixes, reviews and canon checks, Haiku for triage and dedupe (`jobModel` in roles.ts: the memory's first curation
  pass, `memory-curate.ts`).
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
