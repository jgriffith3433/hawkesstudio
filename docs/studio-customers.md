# Hawkes Studio for customers

*Draft for J, 2026-10-29. Studio as a product of its own: how customers sign up, where their games live, how they pay,
what they can and can't use, and how it gets to production. It builds on `docs/platform-plan.md` (sections 1, 2,
4.3–4.4) and the portal's plans (hawkesgenwebsite `cloud/functions/src/platform.ts`, `plans.ts`). What is built is
marked **built**; everything else waits on J's decisions in section 7.*

---

## 1. Signing up

**One Google account, three products.** hawkesgen.ai (the portal), Hawkes Gen and Hawkes Studio each keep their own
account, and Continue with Google opens all three. In Studio the account is keyed by **Google's permanent id (the ID
token's `sub`)**, not the email. An email can change or be recycled; the `sub` never does.

**Built:**
- `users.google_sub` (unique) and `users.signup` (how the account was made). `googleUser` (src/auth.ts) finds the
  account by `sub` first, then by email.
- The first Google sign-in links the `sub` to an existing account.
- When the Google account's email changes, the Studio account follows it.
- An email already linked to a different Google account is refused.
- `sessions.via` records how a session was made (`google`, `password`, `platform`, `invite`).

What Continue with Google does for someone with no account is one switch, `STUDIO_SIGNUP` (src/tenancy.ts):

| Mode | For | A stranger signing in with Google |
|---|---|---|
| `invite` (default) | J's Studio today | Refused: "ask an admin for an invite" (as before) |
| `waitlist` | J's Studio while customers can't have their own yet | Recorded in `signups` (sub, email, name, tries) and told "you're on the list". No account, nothing to see. J lets them in (`POST /api/signups/<sub>/invite` makes an invite their next Google sign-in uses) or declines |
| `owner` | A customer's own Studio | The first verified Google account **claims** the Studio and is its admin. Everyone after needs that admin's invite |

All three are **built** and tested (`test/lockdown.test.ts`, `test/customer.test.ts`).

**The sign-up most customers should see** is at hawkesgen.ai, not in Studio:
1. Continue with Google on the portal.
2. Pick a plan that includes Studio.
3. "Open Studio" takes them to their Studio with a platform token. In an org cell that token is exchanged for a session
   (`/auth/platform`, already built).

Studio's own sign-up (`owner`) covers a Studio made for one person before the portal provisions cells, and self-hosting.

---

## 2. Where customers' games and data live: cells

**J, 2026-10-29: cells, one Studio per customer.** studio.hawkesgen.ai is where you sign in to your own Studio; with
none, it lets you sign up and subscribe. He also approved every cost-saving point below. (The shared alternative, one
Studio for everyone with `org_id` on every table and Postgres, was ~$50+/month before the first customer and a rewrite
of the core.)

A customer's Studio is `customerStudio()` (src/tenancy.ts): an org cell (`STUDIO_ORG`), a claimed Studio
(`STUDIO_SIGNUP=owner`) or `STUDIO_CUSTOMER=1`. In one (**built**):
- its games are its own products file in its data folder, empty at first, written by onboarding
- it never takes a game from J's GitHub (`jgriffith3433` in the repository is refused)
- Claude is only ever the customer's own (section 4)
- the platform features are closed to everyone in it (section 5)

### How it fits together (**built**; nothing deployed or created yet)

```
browser ── studio.hawkesgen.ai ── Worker (server/studio-edge) ─┬─ /o/<org>/…  → that org's cell: Cloud Run studio-o-<org>
                                                               │                (hibernated? "Waking your studio", then it)
                                                               └─ everything else → J's Studio = the control plane (cells.ts)
                                                                    front door, sign-up, org records, the one Stripe webhook,
                                                                    hibernation, the central cron, the cells' plans
```

**The front door.** One "Continue with Google" on studio.hawkesgen.ai (auth-pages.ts `/auth/google`):
- A platform admin (J), or anyone with an account in J's Studio, signs in to J's Studio as now.
- Anyone else gets a **control-plane session** (cookie `hs_cp`, HMAC-signed, 30 days; never a session in J's Studio)
  and goes to their Studio at `/o/<org>/`, or, with none, to a short sign-up at `/auth/start`: name the studio, then
  add the first game (or pick a plan first). Google only, no passwords.
- Inside the cell they press Continue with Google once more (the cell's own sign-in). Only the Google account the
  control plane names (`STUDIO_OWNER_SUB`) can claim the cell; the next people need its admin's invite.

**The control plane** is J's Studio with `STUDIO_CELLS=on` (src/cells.ts; never in a cell). Its records are three
tables in J's Studio's own SQLite database: `cp_orgs` (id, name, owner, state, service, image, activity), `cp_members`,
`cp_config`. **Why SQLite and not Firestore:** it is already streamed to Cloud Storage by Litestream, needs no new
service, credentials or client library, and the control plane is one process (max-instances 1), the only writer.

**Cells are made lazily.** Signing up writes only the org record (`state: new`). The Cloud Run service is made by
`ensureCell` when the customer adds their first game (the game is left in the cell's state as `onboarding.json`; the
cell adds it on start through onboarding's own checks: config.ts `applyOnboardingSeed`) or subscribes (billing.ts tells
cells.ts on `checkout.session.completed`). Never at sign-up.

**A cell** (src/cellrun.ts) is a Cloud Run service `studio-o-<org>` (`studio-beta-o-<org>` on beta) made through the
Cloud Run Admin API v2 from the image J's Studio runs, scale 0 to 1. Its environment (`cellEnv`): `STUDIO_ORG`,
`STUDIO_SIGNUP=owner`, `STUDIO_OWNER_SUB`, the shared bucket with its own prefix (`STUDIO_STATE_PREFIX=o/<org>/`: its
database, state files and agents' jobs all live under it; cloudhost.ts, cloudjob.ts, Litestream), its own host-only
cookie (`hs_o_<org>`), `STUDIO_PUBLIC_URL=…/o/<org>`, `STUDIO_CONTROL_URL` and its derived keys. Labels
`hawkes-studio-cell=1`, `hawkes-org=<org>`. Every call has a **dry run** (`STUDIO_CELLS_DRY_RUN=1`, or `{ dry: true }`):
nothing is sent, and `planned` lists the requests it would have made.

**Hibernation** (cells.ts `sweep`, from the central cron):
- An awake cell with no sign-in and no run for `idleDays` (default 14) loses its Cloud Run service; its data stays in
  the bucket. The next visit wakes it: the Worker sees Cloud Run's own 404 (no `X-Studio-Cell` header, which every cell
  sets), asks the control plane to make the service again (`POST /api/cells/edge/<org>/wake`) and shows "Waking your
  studio" until the cell's `/api/health` answers. It wakes on J's Studio's current image.
- An org with no sign-in for `deleteDays` (90) and no plan gets an email; `warnDays` (14) later its service and every
  object under `o/<org>/` are deleted (the record stays, `state: deleted`). Signing in clears the warning; a plan keeps
  an org however long nobody signs in.
- The three numbers are settings (`POST /api/cells/config`, the platform admin's).

**No per-customer Google resources that cost money or hit quotas:**
- **One shared service account** for every cell (`STUDIO_CELLS_SA`), never one per customer (projects cap at ~100).
  It has nothing on Cloud Run project-wide (a service's env holds its keys, and `run.services.get` would show every
  cell's to every other): only the cells' bucket and running the shared agents' job.
- **No secret per customer.** Every key a cell needs is derived from **one master secret** (`STUDIO_CELLS_MASTER`,
  only in the control plane) by HMAC-SHA256 of its purpose and the org id (src/cellkeys.ts): its owner key (the
  platform's own calls into it), agents' key, MCP key, beta-site pass seed, the key that seals its customer's secrets at
  rest, and its cell key (calling the control plane back). They are plain env of its service; a cell never sees the
  master, so one cell's keys open nothing of another's. The router's edge key is derived the same way.
- **No Cloud Scheduler job per customer.** One central cron (`POST /api/cells/cron`, Scheduler's OIDC token or the
  owner key) runs the sweep, then the nightly run of every paying org whose plan has nightly runs: it wakes the cell and
  calls its `/api/cloud/daily` with that cell's owner key.
- One shared bucket (`STUDIO_CELLS_BUCKET`) and one shared agents' job (`STUDIO_CELLS_AGENT_JOB`, `studio-cell-agent`).

**The router** (server/studio-edge, a Worker on the zone route, as before):
- `studio.hawkesgen.ai/o/<org>/…` goes to `studio-o-<org>-<project number>.<region>.run.app` (Cloud Run's deterministic
  address: no lookup per request) with the prefix taken off and `X-Forwarded-Prefix` set. Everything else goes to J's
  Studio.
- The dashboard asks for absolute paths (`/api/…`, ~200 of them), so a request whose same-site Referer is a cell's page
  goes to that cell, and a page navigation from a cell to a path outside it is sent back under `/o/<org>`. The Worker
  sets `Referrer-Policy: same-origin` on cells' answers (Studio's own pages say no-referrer). `/auth/start` always
  stays with the control plane.
- Cookies never cross: a cell gets only its own `hs_o_<org>` (and Google's `g_state`), never J's session, the control
  plane's `hs_cp` or another cell's; J's Studio never gets a cell's. A cell's redirects come back under its prefix.
- Once every 10 minutes per org it tells the control plane the cell was used (`/api/cells/edge/<org>/seen`).

**Upgrade prompts** (src/entitlements.ts; J: "Upgrade prompts appear when a free user reaches a pro feature"):

| Plan | Games | Pro features |
|---|---|---|
| Free (no plan) | 1 | none: the daily web playtest and review, the backlog, the report |
| Indie | 3 | nightly runs, desktop builds |
| Team | 10 | + agent fixes, Talk, the PM |
| Studio | 30 | + cloud builds |

- **Gated in the API**, after the platform admin's check: `POST /api/changes` and finding fixes (agents), `/api/talk`
  sends (Talk), `/api/pm/*` and scouts (the PM), `/api/cloud/daily` (nightly runs), a game past the plan's count, a
  desktop game or Windows/Linux build target. Each answers **402** with `{ upgrade: { feature, plan, planName } }`, the
  cheapest plan that has it. Reading is never gated.
- **The page:** `dashboard/app.js` turns any 402 into an "Upgrade to <plan>" dialog whose button opens the Stripe
  Checkout (billing.ts). Settings → Plan and credits lists what the plan has (✓) and what it lacks (🔒).
- **Where the plan comes from:** J's Studio has everything. A cell asks the control plane (`GET /api/cells/self`, its
  cell key), at start and every 5 minutes, and keeps the last answer if the control plane is away. The control plane
  bills the orgs: the one Stripe webhook arrives there and the Stripe key stays there, so a cell's Settings → Plan
  (`/api/billing`, checkout, cancel, resume, portal) is relayed to `/api/cells/self/billing/*`. billing.ts keeps every
  subscription, customer and credit under a `studio_id` (J's Studio's own, or an org's).

**Linking the customer's AI** (src/ailink.ts, onboarding's "Connect your AI" card and Settings):
- A provider list, Claude the only entry for now: "Sign in with your Claude subscription" (Claude Code's
  `claude setup-token`, the same sign-in as J's, per cell) or their Anthropic API key.
- Stored **sealed** (AES-256-GCM under the cell's own derived `STUDIO_SECRETS_KEY`; cellkeys.ts `seal`): the key file
  and the cell's Claude sign-ins are ciphertext on disk and in the bucket. Never shown again: only "set" and the last 4.
  No plain `active.env` copy in a customer's Studio.
- Never J's key or plan (claude.ts `claudeEnv` strips the server's credentials in a customer's Studio). Talk, agents
  and the PM there refuse with 409 `connectAi` until one is linked, and the dashboard says where to link it.

**Rolling upgrades** (cellrun.ts `rollImage`; `node tools/studio-cloudrun/roll-cells.mjs --image <image> [--beta]
[--apply]`, or `POST /api/cells/roll`, the platform admin's):
- J's Studio first. It is the control plane, and its image is what new and woken cells get, so hibernated cells wake
  on the new image without being touched.
- Then every awake cell (found by its label), one at a time, each checked healthy before the next.
- The first cell that fails stops the roll, so a bad image reaches at most one customer. Prints the plan without
  `--apply`.

**The platform admin's view:** `GET /api/cells` (orgs and states, settings, missing setup, dry run),
`POST /api/cells/<org>/wake|hibernate`, `/api/cells/config`, `/api/cells/sweep {dry}`, `/api/cells/roll`; all in
lockdown.ts's list.

**Tests:**
- `test/cells.test.ts`: keys, sealing, the front door, lazy creation, hibernation and waking, the 90-day email and
  deletion, billing for orgs, the nightly cron, the roll and dry runs, against a Google stand-in.
- `test/cell-side.test.ts`: the owner-only claim, the cookie, the prefix, entitlements and 402s, the customer's AI
  sealed and used, the onboarding seed.
- `test/studio-edge.test.ts`: the Worker's routing, cookies, redirects and waking.

### One-time setup (J; `node tools/studio-cloudrun/cells-setup.mjs [--beta]` prints it all, `--apply` does it)

1. **The shared service account** `studio-cells@<project>`: `roles/logging.logWriter` on the project; on the cells'
   bucket `roles/storage.objectAdmin`; on the cells' agents' job `roles/run.jobsExecutorWithOverrides` and
   `roles/run.viewer`. Nothing else.
2. **The cells' bucket** `<project>-studio-cells` (`…-studio-beta-cells`), objectAdmin for J's Studio's account too.
3. **The cells' agents' job** `studio-cell-agent` (`studio-beta-cell-agent`), running as the shared account.
4. **The master secret** `studio-cells-master` (`studio-beta-cells-master`) in Secret Manager: 48 random bytes, made
   once and never printed, readable by J's Studio's account, mounted as `STUDIO_CELLS_MASTER`. Rotating it changes
   every cell's keys on its next deploy.
5. **J's Studio as the control plane:** `roles/run.admin` and `iam.serviceAccountUser` on the cells' account for
   `studio-control@`; env `STUDIO_CELLS=on`, `STUDIO_CELLS_PROJECT`, `_PROJECT_NUMBER`, `_REGION`, `_SA`, `_BUCKET`,
   `_AGENT_JOB`.
6. **The central cron:** one Cloud Scheduler job `studio-cells-cron`, daily 04:00 Los Angeles, `POST
   https://studio.hawkesgen.ai/api/cells/cron` with the scheduler account's OIDC token.
7. **The Worker's edge key:** `npx wrangler secret put EDGE_KEY` in server/studio-edge (the script prints the
   one-liner that derives it from the master), then `npx wrangler deploy` (`--env beta` for beta).

### Not done yet (open)

- **A cell's agents can reach other cells' data.** The agents' job runs as the shared account, which can read the
  whole cells bucket, and a customer's agent runs their prompts with a shell. Before real customers, give each job
  execution a downscoped token (Credential Access Boundary) limited to `o/<org>/`, not the account itself. The cell's
  own service is the same image as J's and runs no customer code outside the agent pass.
- **Gen for cells:** a cell has `HAWKESGEN_URL` but no Gen key yet. Playtests and reviews need one per org (Gen's
  tenancy: a derived key Gen accepts, or a key the control plane asks Gen for), and Studio's credits paying for it.
- **Members beyond the owner:** the control plane knows only an org's owner. Someone the owner invites reaches the cell
  by the invite's link, but the front door alone sends them to the sign-up. Cells could report their members back.
- **The portal's "Open Studio"** should link to `studio.hawkesgen.ai/o/<org>/` for orgs that have a cell.
- **One click less:** a signed hand-off from the control plane to the cell would skip the cell's own Continue with
  Google.

---|---|---|
| What it is | The same image run once per customer org (Cloud Run service, scale to zero), its own database, bucket prefix, service account and secrets. **Started:** `STUDIO_ORG` (src/platform.ts) | One service; every table and query gets `org_id`; Postgres instead of SQLite; no in-process singletons (ops queue, PM loop, active run) |
| Isolation | Physical: another customer's data isn't in the database at all | Logical: one missed `WHERE org_id` leaks |
| Work to get there | Provisioning (a cell per org), a router Worker (`studio.hawkesgen.ai/o/<org>/…`), per-cell secrets, a nightly wake-up per cell | Rewrite the core: ~40 tables, ~25 modules, 363 mentions of "J" |
| Idle cost | Cents per idle customer (storage) | One always-on service plus Cloud SQL (~$50+/month before the first customer) |
| Cold start | A few seconds on the first request (Litestream restore) | None |
| Upgrades | Roll the image across cells (canary on J's org first) | One deploy |
| Limits | ~1,000 Cloud Run services per region per project, years away | The database |

**Recommendation: cells.** The single-tenant Studio we have is exactly what a cell is. Everything built for this doc
works the same in either model, so the choice doesn't block anything below.

**A customer's Studio** is `customerStudio()` (src/tenancy.ts): an org cell (`STUDIO_ORG`), a claimed Studio
(`STUDIO_SIGNUP=owner`) or `STUDIO_CUSTOMER=1`. In one (**built**):
- its games are its own products file in its data folder, empty at first, written by onboarding
- it never takes a game from J's GitHub (`jgriffith3433` in the repository is refused)
- Claude is only ever the customer's own (section 4)
- the platform features are closed to everyone in it (section 5)

---

## 3. Billing

**One Stripe account for the portal, Gen and Studio** (J, 2026-10-29: "Gen portal and studio should all use the same
stripe account. Beta should use the test keys."):
- **One set of keys per lane:** test keys on beta (studio-beta, gen-beta, beta.hawkesgen.ai), live keys on live.
- **One webhook endpoint per product per lane.** Each endpoint has its own signing secret, so Studio gets its own:

| Lane | Endpoint | Stripe mode | Secrets (Secret Manager, project `hawkes-staging`) |
|---|---|---|---|
| beta | `https://studio-beta.hawkesgen.ai/api/billing/webhook` | test | `studio-beta-stripe-secret-key` (the test key the portal's beta and gen-beta use), `studio-beta-stripe-webhook-secret` (this endpoint's) |
| live | `https://studio.hawkesgen.ai/api/billing/webhook` | live | `studio-stripe-secret-key`, `studio-stripe-webhook-secret` |

  The secret names follow Studio's `studio-*` / `studio-beta-*` pattern (docs/studio-cloudrun.md). The portal's beta
  keeps `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (project `hawkes-staging`). gen-beta's endpoint is
  `https://gen-beta.hawkesgen.ai/v1/billing/webhook`.
- **Where Studio reads its keys** (**built**, src/billing.ts `stripeKeys`, read on every call, so no restart):
  1. `stripe.json` in Studio's data folder: `{ "secretKey": "sk_test_…", "webhookSecret": "whsec_…",
     "publishableKey": "pk_test_…" }`. On Cloud Run the data folder's small files are synced with the lane's state
     bucket, so the file is `gs://<project>-studio-beta-state/state/stripe.json` on beta (`…-studio-state` live).
  2. Else the environment: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY` (the secrets above,
     mounted by `tools/studio-cloudrun/deploy.mjs` once they're added to its `--set-secrets`).
- **The webhook is open** (`openRoute`, cloudauth.ts), handled before every other check. Stripe's signature
  (`Stripe-Signature`, this endpoint's secret, 5 minutes' tolerance) is its only check. Events to subscribe the
  endpoint to: `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`,
  `customer.subscription.deleted`.

**The plans** are the portal's (hawkesgenwebsite `platform.ts PLANS`, offered when `PORTAL_PLATFORM_PLANS=on`). One
Stripe Product and Price per plan in the shared account, so a customer is one Stripe customer across all three
products:

| Plan | Price | Studio entitlements | Credits a month |
|---|---|---|---|
| Free | $0 | 1 game, weekly web smoke + review | starter |
| Indie | $29 | 3 games, nightly, 120 desktop minutes | 1,500 |
| Team | $99 | 10 games, Windows, AI player, agents, Talk and the PM | 5,000 |
| Studio | $299 | 30 games, cloud builds, priority | 15,000 |

**How Studio uses it** (**built**, src/billing.ts, the same shape as Gen's `src/subscriptions.ts`):
- **Plans:** monthly plans that grant credits each paid month and set how many games the Studio may have. Provisional
  until J sets them: Indie $29 (1,500 credits, 3 games), Team $99 (5,000, 10), Studio $299 (15,000, 30). The
  platform admin changes them with `POST /api/billing/plans` (`{ id, name, priceCents, creditsPerMonth, maxGames,
  stripePriceId, active }`). Without a Stripe price id, checkout sends the price inline.
- **The subscription belongs to the Studio** (an org cell's org id, else an id made once, `st_…`). An admin subscribes
  from Settings → Plan and credits (`POST /api/billing/checkout {plan}`). That is a Stripe Checkout in subscription
  mode, tagged `metadata[product]=studio` and `metadata[studio_id]` on both the session and `subscription_data`.
- **The webhook** acts only on this Studio's events:
  - those tagged `studio` with its own id, or about a subscription or customer it already knows
  - everything else (the portal's, Gen's, another Studio cell's) gets 200 untouched
  - `checkout.session.completed` records the plan
  - `invoice.paid` grants the month's credits once per invoice (ledger key `invoice:<id>`)
  - `invoice.payment_failed` marks it past due, and it still counts as the current plan
  - `customer.subscription.updated` and `.deleted` keep the status, period and cancel-at-period-end
- **Management:** cancel and resume at the period's end (`POST /api/billing/cancel|resume`), and the Stripe billing
  portal (`POST /api/billing/portal`). All are an admin's; members see the plan (`GET /api/billing`).
- **Limits:** with a plan, onboarding refuses a game past the plan's count (402).
- **Credits:** Studio keeps its own ledger (`billing_credits`). Spending them is not wired yet: today Studio's Gen work
  bills its Gen key. Connecting the two (Studio's credits paying for its Gen jobs, or the portal's ledger as the one
  balance) is the next billing step.
- **Claude for Talk and agents is the customer's own** (their subscription or API key, billed by Anthropic to them).
  It costs us nothing and needs no metering. Later we could offer "our API key, metered into credits".
- **Tests:** `test/billing.test.ts`, with a local Stripe stand-in (`STRIPE_API_BASE`) and webhooks signed as Stripe
  signs them.

A customer's Studio has no Costs tab of its own: their bill and credits are on the portal.

---

## 4. What customers can and can't use

**They get**, in their own Studio:
- the daily loop on their games: build, playtest, review, backlog, the report
- the roadmap, the PM, Talk and agents on their repos (by plan)
- going live and rollback of **their** games, with their own typed words or Approve cards
- their own users (invites, roles), settings, memory and analytics

**Their Claude** (**built**, src/claude.ts):
- In a customer's Studio, `claudeEnv()` strips every Claude credential this server's environment holds:
  `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, Bedrock and Vertex switches.
- It uses only theirs:
  - a Claude subscription their admin signs in under Settings → Your Claude (the same `claude setup-token` sign-in)
  - else their Anthropic API key (`POST /api/claude/key`, kept 0600 in the data folder, never shown again)
- The environment's token is never adopted as an account there.
- Gen's own Claude calls for customers already go to the API, never the Max plan (hawkesgen AGENTS.md "Customers
  (tenancy)").

**They never get** J's machinery (section 5).

---

## 5. What only J can do: the platform admin

Studio's `admin` role is not enough, because customers are admins of their own Studio.

The **platform admin** is one of:
- a session made by **Continue with Google** for an account linked to a Google `sub`, whose email is on
  `STUDIO_PLATFORM_ADMINS` (default `piercehawkes3@gmail.com`). A password sign-in never counts.
- J's owner key (`STUDIO_OWNER_KEY`) or his old script login

**Built:** `src/lockdown.ts` (`platformRefusal`, `infraRefusal`), wired into server.ts after the member check. It
answers 403 with "only the platform admin can do that".

| Feature | Routes | J's Studio | A customer's Studio |
|---|---|---|---|
| On Air / broadcast | `/api/broadcast*` | platform admin | platform admin |
| Social (YouTube, TikTok) | `/api/social*` | platform admin | platform admin |
| Costs and resources across the studio | `/api/costs*`, `/api/ledger`, `/api/resources`, `/api/brief/cost` | platform admin | platform admin |
| Self-deploys and restarts | `/api/self-deploys`, `/api/services*` | platform admin | platform admin |
| Antigravity login | `/api/antigravity/*` | platform admin | platform admin |
| Seeding memory from J's canon | `POST /api/memory/seed` | platform admin | platform admin |
| Gen's machinery through the library relay | `/api/gen/v1/{fleet,machines,builder,playtester,settings,storage,clients,workflows,usage,keys,users}` | platform admin | platform admin |
| Infra agents: changing Studio or Gen | `POST /api/changes` for hawkesstudio/hawkesgen; approve, revise, close, merge one (`/api/changes/<id>/…`, `/api/pm/merge\|revise/<id>`); its Approve card | platform admin | platform admin |
| Going live and rollback of J's products, merges, approvals, settings that cost money, products | every `adminOnlyRoute` (auth.ts) | platform admin | the customer's admins (their own games) |
| Claude accounts | `/api/claude/*` | platform admin | the customer's admins (their own Claude) |
| Users, invites, the waitlist | `/api/users*`, `/api/invites*`, `/api/signups*` | platform admin | the customer's admins (their own users) |
| Anything touching `jgriffith3433` repos | onboarding (`saveProduct`) | n/a | refused for everyone |

Who has no account (Studio's own calls, Talk and the agents with the agents' key):
- In J's Studio, guards.ts decides, as before (J's typed words, never the sandbox).
- In a customer's Studio, nothing without a platform admin reaches a platform route, not even their Talk or MCP.

J's PC (not on Cloud Run, not a customer's Studio) has no lockdown: everyone there is J.

**In J's Studio this means** an invited admin, or J signed in with a password, is a member in all but name. J signs in
with Google, as he does on Cloud Run today.

**The dashboard hides them** (**built**). `/api/me` returns `platformAdmin` and `hide` (costs, resources, social,
onair, services, antigravity; in J's Studio also users and claude). `dashboard/users.js` hides those tabs and the On
Air button. The Settings boxes for Claude, Antigravity and restarts already disappear when their API answers 403.

**Tests** (`test/lockdown.test.ts`, `test/customer.test.ts`):
- an invited admin of J's Studio gets 403 on each of 35 J-only routes, and on starting an infra agent
- J with Google and J's owner key pass; J with a password session doesn't
- a customer's admin gets 403 on each platform route, and so do their unattributed calls
- the customer's admin keeps their own deploys, settings, users, Claude and games

**Not covered yet:**
- **The MCP.** In an org cell, a customer admin's MCP tools call the API from loopback with no user. Platform routes
  are closed to that in a customer's Studio. Their own routes are open, which is right for an admin; the MCP already
  refuses org members.
- **The GitHub hooks** still accept only `jgriffith3433` pushes (server.ts). In a cell they start nothing, because the
  cell has none of J's products. The GitHub App replaces them (platform-plan 4.4).

---

## 6. How it reaches production

**Phase A: J's Studio locked down** (built; to beta, then live with J's OK).
1. Merge this branch to `dev`, push `beta`. On studio-beta check that J (Google) sees everything, and that an invited
   test admin sees no Costs, Resources, Social, On Air or Users and gets 403s.
2. J's `DEPLOY` (live). Nothing changes for J if he signs in with Google. His CLI uses the owner key, which still works.
3. Optional: `STUDIO_SIGNUP=waitlist` on live, to start collecting sign-ups.

**Phase B: the first customer Studios** (cells; J decided, 2026-10-29). Built, on `dev` (section 2):
1. ~~Pick cells or shared~~: cells.
2. **Provisioning:** built (cellrun.ts, cells.ts): made lazily, from J's Studio's image, the shared account, derived
   keys. J's org keeps today's Studio.
3. **The router:** built (server/studio-edge). The portal's "Open Studio" still needs to link to `/o/<org>/`.
4. **Billing:** built (section 3), and the control plane bills the orgs. Left: studio-beta's test-mode endpoint and
   keys (then live's), Studio's credits paying for its Gen work.
5. **Nightly per cell:** built, as one central cron, not a job per cell.
6. **Hibernation and rolling upgrades:** built.
7. **Upgrade prompts and the customer's own AI:** built.

To try it on beta, in this order:
1. Push `beta`.
2. Run `node tools/studio-cloudrun/cells-setup.mjs --beta` (read it), then add `--apply`.
3. Set the Worker's edge key: `wrangler secret put EDGE_KEY --env beta`, then `wrangler deploy --env beta`.
4. Sign up on studio-beta.hawkesgen.ai with a Google account that isn't J's.
5. Add a game and watch `GET /api/cells`.

Before real customers:
- the downscoped token for agent jobs
- Gen keys for cells
- members at the front door
- **"J" becomes "the owner"** in prompts and the dashboard (the owner's name from the org)
- **share links on a separate domain** for customer content (never `hawkesgen.ai`, where our cookies live)
- builds from GitHub for customers' games: the GitHub App and Gen's build intake (platform-plan 5). Playtests of `live`
  URLs work today.

**Phase C: design partners.** 5–10 teams, free for two months (platform-plan 8, Phase 1).

---

## 7. Decisions J needs to make

1. ~~**Cells or shared.**~~ Cells (J, 2026-10-29), with lazy creation, hibernation, no per-customer Google resources,
   one central cron and upgrade prompts (section 2).
2. **Prices** (the Stripe account is settled: one shared account, test keys on beta). The portal's draft: Free /
   Indie $29 / Team $99 / Studio $299 with the entitlements above. Also:
   - Are Talk and agents Team-and-up, or on every paid plan with the customer's own Claude?
   - Do we also sell "Claude on our key", metered into credits?
3. **Where people sign up.** At hawkesgen.ai only (recommended, with Studio's `owner` mode for one-offs)? And do we
   turn on `waitlist` in J's live Studio now?
4. **Operator access.** A platform admin can't get into a customer's Studio without that customer's invite (built that
   way: no silent access). Keep it, or add a break-glass path that is logged and shown to the customer?
5. **Invited admins in J's Studio** lose J-only features (they become members in all but name). Is anyone besides J an
   admin there today who needs them?
