# Hawkes in the cloud (hawkesgen.com)

Since 2026-10-16, Hawkes Gen and Hawkes Studio run on one always-on AWS server. J's laptop is optional: its tools
talk to the cloud, and `auto-start.bat` opens the cloud dashboards. (`auto-start.bat local` still runs a copy here.)

| | |
|---|---|
| **Studio** (dashboard, reports, backlog, changes) | https://studio.hawkesgen.com |
| **Hawkes Gen** (dashboard, and the API for programs) | https://gen.hawkesgen.com |
| **The public landing page** (no sign-in; what Gen and Studio do, for people and the product sites' "Powered by HAWKES GEN" badge) | https://hawkesgen.com (https://www.hawkesgen.com redirects to it). Plain HTML/CSS in this repo's `site/`, served by Caddy's `file_server` straight from `/srv/hawkes/hawkesstudio/site` with security headers (HSTS, a strict CSP, no framing); nothing runs behind it. Editing `site/` and pushing to main updates it (the server pulls main). The Caddy block and the apex and `www` DNS records come from `deploy/deploy.mjs` (`ensureDns`, `installCaddy`): after changing them, run `node deploy/deploy.mjs --caddy-only` (the first time too, to create them; `--caddy-rollback` undoes it) |
| **Sign in** | Your own account at https://studio.hawkesgen.com/auth/signin (one session covers Studio, Gen and the beta sites). First run: `admin@hawkesgen.com` / `admin`, then set a password (after that "admin" never works). Invite people, reset passwords and see the sign-in log in Studio's **Users** tab (admins). Members use Studio, Talk and the beta sites; going live, merging into main, money and users are admins'. `src/auth.ts`, `src/auth-pages.ts`; Caddy asks `/auth/check` (forward_auth) |
| **Script login** | user `j`, password in `hawkesstudio/deploy/.keys/web-password.txt`: J's scripts (`src/client.ts`) still send it; Studio checks its SHA-256 (`WEB_LOGIN_SHA256` in keys.env) and counts it as J |
| **Email** | invites and resets go through Amazon SES from `noreply@hawkesgen.com` (`src/mail.ts`; set up with `node deploy/deploy.mjs --caddy-only --email`). In the SES sandbox only verified addresses get mail; the Users tab always shows the link too |
| **Undo the web server config** | `node deploy/deploy.mjs --caddy-rollback` puts the previous Caddyfile back |
| **Programs** (Unity, scripts, CLIs, MCP) | `~/.hawkes/client.json` holds the Gen URL and API key, and Studio's URL and login. Every client reads it |

## What runs where

```
                 hawkesgen.com (Route 53)
                        |
        control server (EC2 t3.large, us-east-1, Elastic IP 52.0.19.230)
          Caddy (HTTPS, Let's Encrypt, login) -> Studio :8791, Gen :8790
          hawkes-secrets (API keys and the GitHub token from Secrets Manager into /run, in memory)
          hawkes-daily.timer (5 AM Pacific: the daily trial)
          /srv/hawkes/<repos>  (the same layout as C:\Projects, cloned from GitHub)
                        |
        ┌───────────────┬──────────────┼──────────────────┐
   GPU fleet (ComfyUI)   Playtester (T4)   Unity build server   GitHub (repos, pull requests, Pages deploys)
   started on demand     daily run only    Windows, us-east-1
```

- **AWS access** is the server's IAM role (`hawkes/hawkes-control`). There are no AWS keys on it.
- **API keys** (Anthropic, ElevenLabs) are in Secrets Manager as `hawkes/gen`; the GitHub token is `hawkes/github`.
- **Gen API keys** for Studio, the web login and J's laptop are in `/etc/hawkes/keys.env` on the server. The
  laptop's copy is in `~/.hawkes/client.json`.
- **Playtester** (`hawkesgen playtester status|start|stop`, `hawkesgen/src/providers/playtester/`): a g4dn.xlarge
  that only runs the Playwright browser server for game playtests (SSH tunnel, no other ports). It installs itself
  from `hawkesgen/server/playtester/bootstrap.sh` at launch.
- **Firewalls:** the GPU fleet, the playtester and the build server let in the control server and `HAWKES_ALLOW_IPS` (J's laptop).
  Gen refreshes this when it starts.

## Operating it

```bash
git push origin main                           # in hawkesgen/ or hawkesstudio/: the server deploys it (below)
node hawkesstudio/deploy/deploy.mjs            # server setup: units, Caddy, DNS, keys, packages (code comes from GitHub)
node hawkesstudio/deploy/sync-gen.mjs          # copy Gen jobs and files made on this PC to the cloud
node hawkesstudio/deploy/secrets.mjs           # update the API keys from hawkesgen/.env
node hawkesstudio/deploy/github-token.mjs      # store a new GitHub token (hidden input)
studio.cmd repos sync                          # the server pulls every product repo
ssh -i hawkesstudio/deploy/.keys/control_ed25519 ubuntu@52.0.19.230
  journalctl -u hawkes-gen -f                  # logs (also hawkes-studio, hawkes-daily, hawkes-pull, caddy)
  sudo systemctl restart hawkes-secrets hawkes-gen hawkes-studio   # after changing a secret
```

- `deploy/provision.mjs` created the server, its role, firewall and address, and is safe to run again.
- `deploy/aws-policy.json` is the policy J attached to the `claw` user for this.

## How code gets to the server

Hawkes Gen and Hawkes Studio are private GitHub repos (`jgriffith3433/hawkesgen`, `jgriffith3433/hawkesstudio`), and
**pushing to `main` deploys them**. There's no beta lane for these two: main is what runs at hawkesgen.com.

1. **CI** (`.github/workflows/ci.yml` in each repo) runs on every push and pull request: Node 24, `npm ci`,
   `npm run typecheck`, `npm test`. Tests that need something CI doesn't have skip themselves (Gen: the ComfyUI
   template cache and `.venv`; Studio: a running Hawkes Gen).
2. **CI tells the server; the server pulls.** No polling: CI's last job, "Tell the server" (on main, after the tests
   pass), calls `POST studio.hawkesgen.com/api/hooks/self-deploy` with GitHub's OIDC token (this repo, main). Studio
   touches `.data/pull-now`, and the `hawkes-pull.path` watcher runs `hawkesstudio/deploy/hawkes-pull.mjs` (as root;
   also once at boot). The only timer is a retry it schedules for itself while a deploy waits (1 minute for CI, 5
   minutes for a run).
   For each repo, Gen first, when `origin/main` has a new commit:
   - It asks GitHub for the commit's check runs (with the server's token, `/run/hawkes/github.env`). It deploys only
     when every check passed. A pending commit waits; a failing one is logged once and never deployed. Only the newest
     commit on main counts: fix forward, and the fix deploys when its CI passes.
   - It waits only while a restart would cut something off halfway (see "Restarts end nothing" below). Studio: its
     critical sections (a merge, a push, a worktree add, a go live being recorded), looking again every 20 s, at most
     `HAWKES_PULL_CRITICAL_MAX_MIN` (5); a deploy usually goes through within seconds while agents, runs and Talk
     answers carry on. Gen: a Unity build running on the build server, at most `HAWKES_PULL_MAX_WAIT_MIN` (720).
   - `git merge --ff-only`; `npm ci` only if `package.json` or `package-lock.json` changed (Gen: also Playwright's
     Chromium); then it restarts that service and checks its health for 90 seconds. If it doesn't come up, it goes
     back to the previous commit, restarts again, and doesn't retry that commit.
   - It refuses (and logs why) when the server's checkout has edits to tracked files, or main no longer contains the
     deployed commit (history rewritten).
3. **Restarts end nothing** (since 2026-10-16). Studio's work carries on through a restart, so a deploy doesn't stall it:
   - **Agents and Talk answers** run outside Studio: each Claude Code is a transient unit of the `hawkes` user's own
     systemd manager (`systemd-run --user`, `src/detach.ts`; the user lingers: `loginctl enable-linger hawkes`, which
     `deploy.mjs` and `hawkes-pull.mjs` make sure of). The unit runs `bin/detached-run.mjs`, which starts the same
     command as before (the sandbox user and environment unchanged) with its output going to
     `hawkesstudio/.data/detached/<unit>.log`. Restarting `hawkes-studio` doesn't touch those units (they aren't in its
     cgroup). The restarted Studio reads the output on from where it got to: the agent's log and result, Talk's answer
     streaming into its conversation. A unit gone with no result (a reboot) runs its pass again. Calls (voice) drop.
     `systemctl --user list-units 'hawkes-*'` (as hawkes, with `XDG_RUNTIME_DIR=/run/user/$(id -u hawkes)`) lists them.
   - **Agent changes** record their step (`changes.phase`: prepare, agent, publish, finish; verify with its Gen jobs
     for a playtest J asked for) and carry on from it, waiting on the same Gen jobs (a build isn't built twice). A playtest that was
     playing a page Studio served is played again (its page server stopped with Studio).
   - **Runs** carry on: finished steps stay, a running step waits for its Gen job again (no second build, playtest or
     review; no findings filed twice), the rest proceed. Asset runs and go lives too.
   - **Critical sections** (`src/drain.ts`): the short steps that must not be cut halfway. `GET /api/self-deploys` lists
     them (`busy.critical`). While a deploy waits for them, new ones (and new agents) wait for the deploy.
   - Without the user's systemd manager (J's PC, or before lingering is on), agents and Talk answers run inside Studio
     as before, `busy.agents` / `busy.talk` count them, and a deploy waits for them (up to 12 hours).
4. **Logs:** `journalctl -u hawkes-pull` and one JSON line per deploy, wait, refusal or failure in
   `hawkesstudio/.data/self-deploys.jsonl`. Studio shows them at `GET /api/self-deploys` (newest first, with what's
   keeping a deploy waiting right now).

Nothing reaches in from GitHub, and GitHub holds no AWS or SSH keys. `node deploy/hawkes-pull.mjs --dry-run` on the
server says what the next pass would do.

What isn't deployed by a push: systemd units, the Caddyfile, DNS, the keys in `/etc/hawkes/keys.env`, the Python
`.venv`, and the story docs outside the repos. Change those in `deploy/deploy.mjs` and run it. It never copies this
PC's folders: its code step clones `main` (or fast-forwards an existing checkout) on the server, so only committed,
pushed work reaches it. Where the folders were copied by the old tar deploys, it turns them into checkouts in place,
keeping `.data/`, `reports/` and keys (ignored by git).

**Rollback:** revert the bad commit and push; the server deploys the revert like any commit.

```bash
git revert <sha>          # or a range: git revert <old>..<new>
git push origin main
```

Don't force-push main or reset it: the server refuses a main that no longer contains what it runs.

**Working on them:** commit and push only when the work is done and checked (`npm run typecheck`, `npm test`). Other
sessions' unfinished files stay on this PC: only commits leave it. A pull request runs CI too, and merging it deploys.

## Claude anywhere: the Hawkes tools over HTTPS (MCP)

On this PC, every project's `.mcp.json` starts the stdio servers (`hawkesstudio/bin/studio-mcp.mjs`,
`hawkesgen/bin/hawkesgen-mcp.mjs`); they reach the cloud through `~/.hawkes/client.json`. Anywhere else, use the same
tools over HTTPS (MCP Streamable HTTP; the tool tables are shared, in `src/mcp-tools.ts` of each project):

| | URL | Key |
|---|---|---|
| Studio | `https://studio.hawkesgen.com/mcp` | the Studio MCP key (`hs_...`): `deploy/.keys/studio-mcp-key.txt` (deploy.mjs makes it, as `STUDIO_MCP_KEY` in `/etc/hawkes/keys.env`) |
| Hawkes Gen | `https://gen.hawkesgen.com/mcp` | any Hawkes Gen API key (`hg_...`); its role and projects apply |

The key goes in an `Authorization: Bearer` header; Caddy lets those requests skip the website login, and each
service checks the key itself (no key or a wrong one: 401). For clients that can't send headers, the key can go in
the URL instead: `https://studio.hawkesgen.com/mcp/hs_...` and `https://gen.hawkesgen.com/mcp/hg_...`. Then the URL
**is** the password: don't paste it anywhere shared. To revoke a Gen key, disable it (Gen dashboard → Keys); for the
Studio key, delete the `STUDIO_MCP_KEY` line on the server, run `deploy.mjs` again (it makes a new one) and update clients.

Give each place its own Gen key (`hawkesgen.cmd key claude-ai --role owner`), so one can be turned off alone.
Over HTTP, Gen outputs come back as `https://gen.hawkesgen.com/v1/files/<asset>` links (they need the key or the login),
and inputs must be `asset:<id>` or `blob:<sha>` (`save_to` and `workflow_file` only work with the local server).

**Claude Code on any machine** (user scope, so every folder has them):

```bash
claude mcp add --scope user --transport http hawkesstudio https://studio.hawkesgen.com/mcp --header "Authorization: Bearer hs_..."
claude mcp add --scope user --transport http hawkesgen https://gen.hawkesgen.com/mcp --header "Authorization: Bearer hg_..."
```

**claude.ai/code (cloud sessions):** they read the repo's `.mcp.json`. The project files point at the stdio servers on
this PC, so add the HTTP ones with the keys from environment variables (Claude Code expands `${VAR}` in `.mcp.json`):

```json
{ "mcpServers": {
  "hawkesstudio": { "type": "http", "url": "https://studio.hawkesgen.com/mcp", "headers": { "Authorization": "Bearer ${HAWKES_STUDIO_KEY}" } },
  "hawkesgen": { "type": "http", "url": "https://gen.hawkesgen.com/mcp", "headers": { "Authorization": "Bearer ${HAWKESGEN_KEY}" } }
} }
```

Set `HAWKES_STUDIO_KEY` and `HAWKESGEN_KEY` in the cloud environment's settings (environment variables), and give it
network access to `studio.hawkesgen.com` and `gen.hawkesgen.com` (the default "trusted" network list may not include
them: use custom access with those two domains). Untested from a cloud session yet.

**claude.ai, the Claude desktop app (Chat) and the phone app:** Settings → Connectors → Add custom connector, one per
service, with the **key-in-URL** address (`https://studio.hawkesgen.com/mcp/hs_...`, `https://gen.hawkesgen.com/mcp/hg_...`).
Custom connectors only do OAuth or no auth (no custom headers), which is why the key goes in the URL. Connectors added
on claude.ai also show in the desktop and phone apps. Alternatively, the desktop app's Chat can run the stdio servers on
this PC: in `claude_desktop_config.json`, `"mcpServers": { "hawkesstudio": { "command": "node", "args":
["C:/Projects/hawkesstudio/bin/studio-mcp.mjs"] }, "hawkesgen": { "command": "node", "args":
["C:/Projects/hawkesgen/bin/hawkesgen-mcp.mjs"] } }`. The desktop app's Code tab uses Claude Code's own settings.

Limits: no OAuth (a future step if connectors ever need it); the endpoints are stateless (no server-sent
notifications); a long tool call (a playtest with `wait`) streams keep-alives so proxies don't drop it, but a
client may still time out: prefer `wait: false` and the status tools.

## Talk

Talk (Studio's first tab) is Claude Code on the server with both MCP servers. The answer streams in as Claude writes
it; Stop ends it (the text so far stays, and the conversation can go on); conversations can be renamed and deleted.
📎 (or paste, or drop) attaches images and files: they're uploaded into Hawkes Gen as blobs, and Claude gets each file's
path (to read it, images too) and blob id (for Gen inputs). Under each answer, **✓ Max plan** means it ran on J's
subscription (no extra cost), **💳 $0.042 API** means it was billed to the API key (when `CLAUDE_CODE_OAUTH_TOKEN`
is missing). `TALK_MODEL` picks the model; `TALK_CLAUDE` the Claude Code executable.

**Roles, memory, full power.** Each turn runs as the `talk` role (`.claude/agents/talk.md`; the PM's conversation as
`pm`) with the skills plugin (`--plugin-dir .claude`), the shared memory's studio-wide decisions in its system prompt
and the entries matching J's message under it (docs/memory.md). In the agent sandbox (`deploy/agent-sandbox.mjs`, J's OK
first) Talk runs as `hawkes-agent` with a shell, an editor and the web, its own workspace (`/srv/hawkes/.talk`) and a
fast lane to beta; going live and Studio/Gen merges need J's own typed words, which Studio checks (docs/agents.md).

**Results come back to the conversation** (`src/followup.ts`). Each conversation's Studio MCP server gets
`TALK_CONVERSATION` (its `.data/talk-mcp/<id>.json`) and sends it as `X-Talk-Conversation` on its calls; the API records
it as the origin of what the call starts: agent changes (`studio_fix`, `studio_task`, revisions), the beta run after an
approval, `studio_playtest` / `studio_build` / `studio_unity_test` / `studio_run`, beta runs, and the live playtest after a
go live or rollback. Every 10 s Studio looks for finished ones (a change ready or failed, a run done or failed) and posts a
notice into that conversation (labelled **Studio**), then starts a Talk turn by itself so Claude explains it ("Studio
asked for this answer"). Results within a minute share one turn (`TALK_FOLLOWUP_BATCH_MS`); a conversation never runs two
turns at once (results wait for the running turn, and J's own message answers them too). Work no conversation started
(the daily run, dashboard buttons) only goes to J's phone. Infra merges into main aren't reported (watch `/api/self-deploys`).

**Activity** (`dashboard/activity.js`, `GET /api/activity`, `src/activity.ts`): the header's Activity button (its badge
counts what is running) opens a drawer of everything in the background: agent changes (status, what they're doing now,
time so far, who started them, log, PR, preview), Studio runs with their current steps, Hawkes Gen jobs, Talk answers in
progress, and what finished in the last 15 minutes. It refreshes every 3 s; on a wide screen it sits beside the page.
The Changes tab refreshes itself every 5 s and keeps opened summaries and logs open.

## The agent loop

1. The daily run finds bugs.
2. Agents (Claude Code on the server, headless) fix the worst new ones, within the day's budget
   (`/api/agents/settings`: by default 4 fixes and $20 a day, blockers and bugs only).
3. Each fix is a branch cut from `beta`, a pull request into `beta` (ready on the agent's checks; a playtest of it only on request), and a preview at
   `https://<sub>.hawkesgen.com/c/<id>/`.
4. J approves in Studio's **Changes** tab, which merges the pull request into beta (nothing goes live). Beta's
   pre-deploy build, Unity build, beta site (`https://<sub>.hawkesgen.com/`) and a playtest of beta follow.
   J can also ask for changes, or close the fix.
5. **Going live** is separate (pushing main; see "Pushes drive it" below): the Today card's "Go live…" (or `studio_deploy_plan` in Talk) shows the commits on beta
   that aren't live and how that exact beta commit played. J types `DEPLOY <product>`, Studio fast-forwards main to it,
   GitHub Pages publishes, and Studio playtests live. "Rollback…" undoes the last go live with a new commit
   (`ROLLBACK <product>`). Details: `docs/daily.md`, "Beta and going live".

**With the PM loop** (`src/pm.ts`, started by Studio on the server; docs/daily.md, "Running the studio with Talk"),
steps 2 and 4 are Talk's: it starts roadmap tasks and the worst bugs within its caps (`.data/pm.json`: 2 agents at
once, 8 starts a day, 3 tries), runs its turns in the day's "Studio PM" Talk conversation, and merges into beta the
changes that pass their acceptance gate (delegated merges, on by default; never Studio or Gen, never live). Every
decision is logged with undo (Roadmap tab). Pause it from the Roadmap tab or `POST /api/pm/settings { "enabled": false }`.
It starts no agent while a Studio deploy is waiting for Studio's critical sections (seconds; `.data/deploy-pending`), so
deploys get through; agents already working carry on through the restart. Logs: its
warnings are `[pm]` lines in Studio's journal.

### Changing Studio and Gen through agents

J can ask Talk to fix or add something in Hawkes Studio or Hawkes Gen themselves (`studio_task`, product
`hawkesstudio` or `hawkesgen`; `products.json` `infra`). There's no beta lane for these, so:

1. The agent works in `/srv/hawkes/.work/<change>`, a worktree of `/srv/hawkes/<repo>` on `task/<id>` cut from
   `origin/main` (only refs move in the server's checkout; its files change only through `hawkes-pull.mjs`). Studio
   runs `npm ci` there; the agent runs `npm run typecheck` and `npm test` (Studio's tests use the running Gen) and commits.
2. **Guard rails** before anything is pushed: a change that touches `.data/`, `.env` files, keys or `*.pem` fails; so
   does one touching the deploy and server-setup scripts (`deploy/hawkes-pull.mjs`, `deploy/deploy.mjs` and its Caddy
   config, provisioning), secrets handling, CI workflows (`.github/workflows/`) or the GitHub hooks' token check
   (`src/github-oidc.ts`), unless J's request (or his note on the change) names that file. The list is `GUARDED` in
   `src/agents.ts`. The agent and its checks run without the GitHub token, AWS variables or service keys.
3. Studio pushes the branch and opens a pull request into **main**, then checks it: CI on the pull request (GitHub check
   runs; it waits up to 30 minutes), the checks again, and a **smoke check**: the changed service started from the
   worktree on a spare port with a scratch data folder (health `ok`, the dashboard page loads, `node --check` on every
   `dashboard/*.js`). The change shows **Checks: passed/failed** in the Changes tab and in `studio_change`.
4. **Approve** (`MERGE <id>`, only after J says yes in Talk; refused unless CI on the pull request is green) squash-merges
   into main. CI runs on main and tells the server, which deploys it as above: it waits for Studio's critical sections
   (seconds), restarts the service, and rolls back if it isn't healthy. Agents, runs and Talk answers carry on through
   the restart; a voice call drops.

The first agent change to Studio through this lane was a test of the lane itself (the lane's first test, 2026-10-16).

### Pushes drive it (GitHub Actions)

Every product source repo has `.github/workflows/hawkes-studio.yml`: on each push to `beta` or `main` it calls
`POST https://studio.hawkesgen.com/api/hooks/github` with GitHub's OIDC token (`id-token: write`; no secrets).
`src/github-oidc.ts` checks GitHub's signature, the owner (`jgriffith3433`) and the event; Caddy lets only that path
past the login. Studio answers:

| Push to | Web product | Unity game |
|---|---|---|
| `beta` | pull, rebuild the beta site (`src/betawatch.ts`) | a minute later, a beta run: build on the build server into the beta website copy, beta site, playtest |
| `main` | GitHub Pages publishes (DoD and PH Origins build in `pages.yml`); Studio records the deploy, waits for Pages (API), playtests live (`src/golive.ts`) | Studio publishes the build to the website repo's main (the beta build if it's of that commit, else it builds it), records it, and playtests live |

- The first time a repo's `pages.yml` reaches main, Studio switches its Pages source to GitHub Actions and runs it.
- A commit that already went live through Studio's "Go live" isn't published twice.
- `GET /api/hooks/pushes` lists the last pushes Studio handled and what it did. A go live also shows as a `live` run.
- The workflow can be re-run by hand (Actions tab, "Run workflow") to send the same push again.
- The corporate site, I Can Be and Imagine Live TV have no build on GitHub: Pages serves main as committed, and their
  beta sites serve beta's files as committed too. I Can Be's version stamp (`deploy.prebuild`) is committed to beta by
  `studio beta icanbe`, so it ships with the push.

The server keeps each product's source repo on `beta` (`studio repos sync`, and before every daily run); website repos
of Unity games stay on main, and their beta builds land in `/srv/hawkes/.work/beta/<product>-site`. The beta sites are
`/srv/hawkes/previews/<product>/beta` (Caddy serves `/` from there; `deploy/deploy.mjs` sets it up).

## Developing on beta (/dev/)

`https://<sub>.hawkesgen.com/dev/` runs each web product's devtools on this server, in beta's working copy, and
commits saves to beta. How J uses it: `docs/daily.md`, "Developing on beta". The operations side:

- **Processes:** Studio starts each dev server (`npm run dev -- --port <dev.port> --strictPort --host 127.0.0.1`) as
  its own child. Each one runs in `/srv/hawkes/.work/beta-<product>` (a worktree of `/srv/hawkes/<repo>` on the local
  branch `dev-beta`). At most 2 run at once; each stops after 30 idle minutes. Restarting `hawkes-studio` stops them;
  opening `/dev/` again starts them. Logs: `hawkesstudio/.data/logs/dev-<product>.log`. State:
  `hawkesstudio/.data/dev.json`.
- **Memory:** a Vite dev server with a Babylon game is roughly 300-600 MB, so two fit next to Gen, Studio and Caddy
  on the 4 GB server. Settings: `STUDIO_DEV_MAX`, `STUDIO_DEV_IDLE_MIN`, `STUDIO_DEV_QUIET_MS` (in the
  `hawkes-studio` unit).
- **Ports** (127.0.0.1 only; `products.json` `dev`):

  | Product | Front door | Dev server |
  |---|---|---|
  | DoD | 8701 | 8711 |
  | PH Origins | 8702 | 8712 |
  | I Can Be | 8703 | 8713 |
  | Imagine Live TV | 8704 | 8714 |
  | corporate | 8705 | 8715 |
  | Unity products | 8706-8708 | (the build-server page only) |

  Caddy sends each beta host's `/dev/*`, and websockets with `Sec-WebSocket-Protocol: vite-hmr`, to the front door.
  Everything else on the host is still the built beta site.
- **Keys:** `deploy.mjs` adds `DEV_GEN_KEY` (Gen client `beta-devtools`, role `user`) to `/etc/hawkes/keys.env` once,
  and a key per product, `DEV_GEN_KEY_<ID>` (client `beta-<id>`, role `user`, only that product's project). Studio passes
  the product's own key (else the shared one) to its dev server as `HAWKESGEN_KEY`, with `HAWKESGEN_URL=http://127.0.0.1:8790`. Every variable that
  looks like a secret (`*KEY*`, `*TOKEN*`, `AWS_*`, `ANTHROPIC*`, `GITHUB*`…) is removed from a dev server's
  environment. Its `HOME` is `hawkesstudio/.data/dev-home`, so it can't read the service user's
  `~/.hawkes/client.json`.

  Not covered: the instance metadata endpoint (the server's IAM role) is reachable from any process here, dev servers
  included. Product devtools no longer carry AWS code (DoD's was removed).
- **Git:** saves are pushed to `beta` only (`HEAD:refs/heads/beta`; `dev.ts` refuses to load if beta were main). A
  conflict leaves the work as commits in the working copy; "keep beta's version" pushes them to a
  `devtools-conflict-<time>` branch first.
- **Shipping it:**
  - Code: push to main (above). `node hawkesstudio/deploy/deploy.mjs` makes the key and rewrites the Caddyfile with
    the `/dev/` routes.
  - `--dev-hosts` also adds the `dev-<sub>` DNS names and their Caddy blocks (the no-service-worker fallback). It is
    remembered for later deploys.
  - DoD's devtools read fighter art from `/srv/hawkes/AllTheCharacters` and maps from `/srv/hawkes/AllTheMaps`
    (`dev.env`). They aren't repos, so they aren't on the server unless copied there. Without them, the Fighters and
    Maps tabs show no source art; content editing still works.

## Costs (kept low: J's budget is tight)

**Where to see them:** Studio's **Costs** tab (`src/costs.ts`, `GET /api/costs?period=month|week|today|lastmonth|<n>d`),
Talk (`studio_costs`: "what did this week cost?"), and a line at the end of every morning brief. It shows:
- **AWS:** this month so far, the forecast, last month, per day, and by part (control server, build server, playtester,
  GPU servers, disks, snapshots, IPs, S3, DNS…, from Cost Explorer's usage types) and by service. Without Cost Explorer
  access it shows an estimate (the fixed table below prorated, plus the GPU and build-server time Hawkes Gen recorded).
- **Idle money** (EC2 Describe* in `HAWKES_REGIONS`, free): stopped servers' disks, unattached disks, Elastic IPs
  attached to nothing, snapshots, and servers running longer than they should. Studio only reads AWS; deleting is J's call.
- **Generation:** Hawkes Gen's usage per provider (GPU hours, build-server hours, ElevenLabs characters, Claude API).
  GPU and build-server time are part of the AWS bill; Claude API and ElevenLabs are separate money.
- **Claude:** Talk, agents and scouts run on J's Max plan: what Claude Code reports is usage at API prices, **not
  billed**. Claude through the API (Gen's reviews and llm tools, or Claude Code without the subscription token) is money.
- **Per product:** Gen's usage by project, playtester time from playtest jobs ($0.53/h while a game plays), agents'
  Claude usage. The rest (control server, disks, S3, DNS, servers booting and idling) is shared.
- **Subscriptions** Studio can't see (Claude Max, ElevenLabs): J enters them under "Budget and alerts…" and they show
  beside the totals.

**Budget and alerts** (`.data/costs.json`, the tab's "Budget and alerts…", or `studio_costs settings` on J's word): a
monthly budget for AWS plus pay-per-use APIs (default $150). An hourly check on the server sends a phone notification
only when something looks wrong, once each: the month's forecast passes the budget (again at 125%), a GPU server runs
over 3 h, the build server over 2 h, the playtester over 3 h (each settable), or AWS charges appear outside the US
regions.

**Cost Explorer access:** the control server's role needs `ce:GetCostAndUsage` and `ce:GetCostForecast` (in
`deploy/provision.mjs`'s role policy since 2026-10-16). J applies it from his PC with
`node deploy/provision.mjs --role` (it re-applies the role's inline policy). Each request costs $0.01; Studio caches
results for about a day (three requests per refresh, a forced Refresh reuses anything under an hour old), so about $1 a
month. The tab shows how many requests ran this month.


Fixed, per month (since 2026-10-16):

| Item | Cost |
|---|---|
| Control server (t3.medium) | about $30 |
| Its disk (150 GB) and address | about $16 |
| Build server disk (300 GB, server stopped) | about $24 |
| One GPU server disk (250 GB, server stopped; it keeps the models) | about $20 |
| Playtester disk (75 GB, server stopped) | about $6 |
| Route 53, Secrets Manager, S3 | about $3 |
| **Total** | **about $99** |

Pay-per-use:
- **GPU server:** about $1.86/hr, only while a job or playtest runs; it stops after 20 idle minutes.
- **Build server:** about $0.77/hr while building; it stops after 15 idle minutes.
- **Playtester** (g4dn.xlarge, NVIDIA T4): about $0.53/hr, only while games are being played. Any game playtest starts
  it when it's off (the daily run, beta runs, agent checks, manual playtests; site crawls don't), and it powers itself
  off after 20 minutes with no playtest. The daily run starts it early (it boots while Unity builds) and stops it at
  the end. Roughly 30-90 minutes a day: $8-25 a month.
- **Reviews:** Sonnet, and skipped when nothing changed (a few cents a day).
- **Agents:** capped at $5 and 3 fixes a day; nothing extra on J's Max subscription token.
- **Playtest videos** (`s3://hawkes-playtests-028793236279`): a few MB per playtest, so roughly 5-10 GB a month at
  about $0.023/GB, halved once objects move to Infrequent Access after 30 days. Nothing expires them yet.

Kept low on purpose:
- Disks use the free performance baseline (3000 IOPS, 125 MB/s).
- Game playtests use the small playtester, not the $1.86/hr GPU server (STUDIO_GPU_PLAYTESTS=playtester; `fleet`
  uses the big one, `off` plays in software). A game played in software (the playtester failed to start) is marked
  inconclusive and not reviewed.
- The servers are in us-east-1; GPU servers may also run in us-east-2 and us-west-2 (at most 4, `HAWKES_REGIONS`).
- Removed on 2026-10-16: 6 GPU servers in other regions, and the old sickofitgame load balancer and its IPs.
