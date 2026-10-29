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

## 2. Where customers' games and data live

Studio was built for one owner: one SQLite database, one products file, one GitHub token, J's Claude. Two ways to give
each customer their own:

| | **Cells: one Studio per customer** (platform-plan 4.3) | **Shared: one Studio for everyone** |
|---|---|---|
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
- **Open routes:** `/api/billing/webhook` must be added to `openRoute` (cloudauth.ts), like GitHub's hooks. Stripe's
  signature (`Stripe-Signature`, checked with this endpoint's secret) is its only check.

**The plans** are the portal's (hawkesgenwebsite `platform.ts PLANS`, offered when `PORTAL_PLATFORM_PLANS=on`). One
Stripe Product and Price per plan in the shared account, so a customer is one Stripe customer across all three
products:

| Plan | Price | Studio entitlements | Credits a month |
|---|---|---|---|
| Free | $0 | 1 game, weekly web smoke + review | starter |
| Indie | $29 | 3 games, nightly, 120 desktop minutes | 1,500 |
| Team | $99 | 10 games, Windows, AI player, agents, Talk and the PM | 5,000 |
| Studio | $299 | 30 games, cloud builds, priority | 15,000 |

**How Studio uses it:**
- **The subscription:**
  - Checkout, plan changes and the billing portal start at hawkesgen.ai (`plans.ts`).
  - Studio's webhook listens for the subscription and invoice events on the shared account.
  - It acts only on those for Studio: `metadata.product` includes `studio`, or the price is a platform plan's.
  - It updates what this Studio may do: games, schedule, agents, Talk. Until it is built, the entitlements reach Studio
    in the platform token (`entitlements.studio`), and today only `studio.on` is checked (platform.ts).
  - The webhook is how a Studio running without a fresh token (the nightly run, agents) learns a plan changed or
    lapsed, and when to pause work (`past_due`, `canceled`).
- **Credits** pay for metered work:
  - Playtests, reviews, builds and generation are Gen jobs, billed to the org's credits through the Studio's Gen key at
    cost × 3. 1 credit = $0.01.
  - Credit packs are bought at the portal on the same account.
- **Claude for Talk and agents is the customer's own** (their subscription or API key, billed by Anthropic to them).
  It costs us nothing and needs no metering. Later we could offer "our API key, metered into credits".

**To build:** `src/billing.ts`, modelled on the portal's `billing.ts` and `plans.ts`:
- the webhook with its signature check, and an idempotency key per Stripe event id
- a `subscriptions` table (Stripe customer, subscription, plan, status, period end)
- the plan's limits enforced, in onboarding first (games), then schedule and agents
- the Stripe secret and webhook secret read from the lane's secrets (never logged)
- a test with Stripe's signed test payloads

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

**Phase B: the first customer Studios** (each step S or M).
1. **Pick cells or shared** (section 7). With cells, the next steps are:
2. **Provisioning:** a script (then the portal) makes a cell: a Cloud Run service from Studio's image with
   `STUDIO_ORG=<org>`, its own bucket prefix, service account and secrets (owner, agent and MCP keys; its Gen key, an
   org project). J's org keeps today's Studio until its own cell passes the same daily run.
3. **The router:** a Worker that sends `studio.hawkesgen.ai/o/<org>/…` to the org's cell; the portal's "Open Studio"
   links there.
4. **Billing:** Studio's webhook per lane on the shared Stripe account (section 3: test keys and the studio-beta
   endpoint first), and entitlements enforced in the cell: games (onboarding refuses past the plan's count),
   schedule, agents, Talk.
5. **Nightly per cell:** a Cloud Scheduler job per cell (or one control-plane cron), at the org's hour.
6. **Builds and the pipeline for customers' games:**
   - playtests of `live` URLs work today
   - builds from GitHub need the GitHub App and Gen's build intake (platform-plan 5)
7. **"J" becomes "the owner"** in prompts and the dashboard (the owner's name from the org).
8. **Share links on a separate domain** for customer content (never `hawkesgen.ai`, where our cookies live).

**Phase C: design partners.** 5–10 teams, free for two months (platform-plan 8, Phase 1).

---

## 7. Decisions J needs to make

1. **Cells or shared.** Recommended: cells. One Studio per customer org, from the same image.
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
