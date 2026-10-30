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
  cell's to every other): only the cells' bucket and running the shared agents' job. What that leaves open is under
  Isolation.
- **No secret per customer.** Every key a cell needs is derived from **one master secret** (`STUDIO_CELLS_MASTER`,
  only in the control plane) by HMAC-SHA256 of its purpose and the org id (src/cellkeys.ts): its owner key (the
  platform's own calls into it), agents' key, MCP key, beta-site pass seed, the key that seals its customer's secrets at
  rest, and its cell key (calling the control plane back). They are plain env of its service; a cell never sees the
  master, so one cell's keys open nothing of another's. The router's edge key is derived the same way.
- **No Cloud Scheduler job per customer.** One central cron (`POST /api/cells/cron`, Scheduler's OIDC token or the
  owner key) runs the sweep, then the nightly run of every paying org whose plan has nightly runs: it wakes the cell and
  calls its `/api/cloud/daily` with that cell's owner key.
- One shared bucket (`STUDIO_CELLS_BUCKET`) and one shared agents' job (`STUDIO_CELLS_AGENT_JOB`, `studio-cell-agent`),
  which runs as its own account with no data access (see Isolation).

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

### Isolation: what one customer can reach

**Agent runs reach only their own run's files (built: src/jobbroker.ts, test/jobbroker.test.ts).** A customer's agents
run the customer's prompts with a shell, so they are where another customer's data would leak. They run in the shared
job `studio-cell-agent` as **`studio-cell-runner@`, an account with no role at all** besides writing logs: no bucket,
no Secret Manager, no Cloud Run. The pattern is Gen's GPU broker (hawkesgen `src/providers/gpu/broker.ts`):
1. The cell signs a **run token** for that one run (its org, the run's unit, 6 hours) with its own derived
   `STUDIO_BROKER_KEY`. It starts the execution with the token and the broker's address in the env, never the bucket.
2. The job reaches `POST/GET <control plane>/api/cells/broker` with the token. The control plane checks the token
   against the key **it** derives for the org the token names. A cell therefore can't sign for another org.
3. The control plane allows only keys inside `o/<org>/jobs/<unit>/`: list, read, write, remove. Anything else is 403:
   another org's objects, another run's, the cell's own database and state, and paths with `..`.
4. Big objects go by **V4 signed URL** for that one object (15 minutes), signed by J's Studio as itself through IAM
   signBlob. Without a signer, the bytes go through the control plane.
5. The runner takes the token out of its environment before the pass starts, so the agent's command never sees it.

The tests show:
- org A's run can't list, read, write or remove org B's objects, another run's, or its Studio's database
- a token naming org B signed with A's key is refused, and so is a token whose body was edited

**The cells' own services: one service account each** (**built**, src/cellrun.ts, src/cells.ts; on with
`STUDIO_CELLS_ISOLATE=1`, cells-setup.mjs step 8). Each cell runs as its own account, `cell-<b|l>-<hash>@`. The id is
made from the org id (service account ids are 6-30 characters) and differs per lane. The account can reach:
- **its own data:** objectAdmin on a GCS **managed folder** `o/<org>/` in the cells' bucket. That grant is the folder's
  own IAM policy and holds that account alone.
- **its agents' runs:** the shared agents' job, through `run.jobsExecutorWithOverrides` and `run.viewer` on that job.
  The runs themselves still reach only their own run folder, through the broker.

There is no bucket-wide grant, so a bug or a compromise in one cell can't read another org's `o/<other>/`. The control
plane makes the account, folder and job grant before the cell's service, and deletes all three with the org's data.

Why this and not the other two options:
- **Not IAM conditions on the bucket:** one bucket policy would carry a conditional binding per cell, and that grows
  without end. A managed folder keeps each cell's grant in its own small policy.
- **Not routing the cells' data through the broker:** Litestream streams the database with Google's own credentials
  straight to Cloud Storage. Replacing it with signed URLs means rewriting how a cell's database is kept, with a real
  risk of losing data. The agent runs, which execute a customer's prompts with a shell, already go through the broker.

**Quota:** 100 service accounts per project by default. Beta and live cells share `hawkes-staging`, so near 100 cells
in all, ask Google for a raise (free) or move live cells to their own project.

**Moving existing cells over** (once per lane, in this order):
1. Run step 8 of `node tools/studio-cloudrun/cells-setup.mjs [--beta] --apply`. It grants `studio-control@`:
   - `iam.serviceAccountAdmin` and `iam.serviceAccountUser` on the project
   - `storage.admin` on the cells' bucket (managed folders and their policies)

   and sets `STUDIO_CELLS_ISOLATE=1` on the lane's studio service.
2. Run `node tools/studio-cloudrun/isolate-cells.mjs [--beta]` (a dry run), then again with `--apply`. It asks the
   control plane (`POST /api/cells/isolate`, J's owner key) to make each org's account and folder and to move each awake
   cell onto it as a new revision. Hibernated cells wake as their own account. It is safe to run again.
3. Once every cell has moved, remove `studio-cells@`'s objectAdmin on the bucket (the script prints the exact command).

Until step 3, the old shared grant still exists, but no cell runs as that account any more.

**Not proven against real Google yet:**
- Litestream's listing under a managed folder: object listing needs `storage.objects.list` on the folder with a prefix
  inside it, which Litestream uses.
- Run executions inheriting the job's IAM: a cell must be able to read its own executions.

Watch the first isolated cell's logs on beta.

**Tests:** `test/cell-isolation.test.ts` checks two cells against a stand-in for Google:
- each has its own account
- each folder's policy holds only its own account
- neither account is on the bucket or on the other's folder
- the migration moves an old cell and changes nothing the second time
- deleting an org's data removes its account, folder and job grant

Together with the broker's tokens (`test/jobbroker.test.ts`), one cell can never hold a credential for another's prefix.

### Hawkes Gen for a cell (built)

- At its first start, the control plane asks Gen for the org's own key. The call is `POST /v1/clients` with J's Gen
  owner key (`STUDIO_GEN_OWNER_KEY`, only in the control plane): role `user`, projects `org_<hex>` and `org_<hex>.*`.
  Its Gen org `org_<hex>` is made once per org.
- The key goes into the cell's env (`HAWKESGEN_KEY`, `AGENT_GEN_KEY`). It is kept sealed in `cp_orgs` under a key
  derived from the master, so a woken cell gets the same one.
- In the cell every project Studio names becomes `org_<hex>.<game>` on the way to Gen (gen.ts,
  `HAWKESGEN_PROJECT_PREFIX`). Gen treats `org_*` projects as a customer's.
- **Connect your AI goes to Gen too.** After any change in Your AI, the cell sends its Anthropic key and its Claude
  subscription's token, set or removed, to the control plane (`POST /api/cells/self/ai`, cellside.ts). The control
  plane puts them in Gen for that org (`PUT|DELETE /v1/org/keys/anthropic|claude-subscription?org=`, hawkesgen
  orgsecrets.ts). Gen's reviews and tools then run on the customer's own Claude.
- When the org's data is deleted, its Gen key is disabled and its Claude credentials are removed from Gen.

### Invited people at the front door (built)

Each cell reports who may enter it to the control plane (`POST /api/cells/self/members`, cellside.ts): its users, with
Google's id once linked, and its open invites by email. It reports at start, every 5 minutes, and after every change in
Users, replacing the list each time (`cp_access`).

Continue with Google on studio.hawkesgen.ai finds a person's orgs by Google's id or by their verified email:
- with one org, they land in it
- with several, they pick one at `/auth/start`
- they are never sent to the sign-up

An invite found by email is tied to their Google id from then on. Removed in the cell means no way in from the front
door. Only an org's owner can start it, add its first game or subscribe from the sign-up pages.

### One-time setup (J; `node tools/studio-cloudrun/cells-setup.mjs [--beta]` prints it in order, `--apply` does it)

Before it: the lane's Studio runs this code (push `beta`; live with J's `DEPLOY`).
1. **Two shared service accounts**, both with `roles/logging.logWriter` only:
   - `studio-cells@`: the cells' services
   - `studio-cell-runner@`: the customers' agent runs, with no data access at all
2. **The cells' bucket** `<project>-studio-cells` (`…-studio-beta-cells`): object admin for `studio-cells@` and J's
   Studio (`studio-control@`), never the runner.
3. **The agents' job** `studio-cell-agent` (`studio-beta-cell-agent`), running as the runner, with no bucket in its
   env. `studio-cells@` gets `run.jobsExecutorWithOverrides` and `run.viewer` on that job only.
4. **Two secrets**, made once, never printed, readable by `studio-control@` alone:
   - `studio-cells-master`: 48 random bytes
   - `studio-cells-gen-owner-key`: J's Gen owner key for the lane, taken from `~/.hawkes/client.json` `genKey` /
     `genBetaKey`
5. **J's Studio as the control plane** (`studio-control@`):
   - `roles/run.admin`, `iam.serviceAccountUser` on `studio-cells@`, `iam.serviceAccountTokenCreator` on itself (the
     broker's signed URLs)
   - env `STUDIO_CELLS=on` and `STUDIO_CELLS_*`
   - secrets `STUDIO_CELLS_MASTER`, `STUDIO_GEN_OWNER_KEY`
6. **The Worker:** derive the edge key from the master into `npx wrangler secret put EDGE_KEY` (the printout has the
   PowerShell lines), then `npx wrangler deploy` (`--env beta`).
7. **Last, the central cron** `studio-cells-cron` (daily 04:00 Los Angeles, Scheduler's OIDC token). On beta it is made
   paused: beta never spends by itself.

Check: `GET /api/cells` signed in as J shows `"on": true` and `"missing": []`.

### Not done yet (open)

- **Isolation on live:** step 8 and the migration (Isolation, above) on each lane before paying customers.
- **The portal's "Open Studio"** should link to `studio.hawkesgen.ai/o/<org>/`.
- **One click less:** a signed hand-off from the control plane to the cell would skip the cell's own Continue with
  Google.
- **Studio's credits paying for Gen work:** a cell's Gen usage is on its own Gen key; billing it against the plan's
  credits is the next billing step.

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
  `https://beta.hawkesgen.ai/v1/billing/webhook`.
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

**Their own voice** (**built**): in a customer's Studio nothing that talks to Claude speaks as J's world.
- **Roles and skills:** `customer-plugin/` (plugin "studio") instead of `.claude` (roles.ts `PLUGIN_DIR`). It has the
  same seven roles in the customer's terms and only the generic skills: playtest-scenario, gen-assets, shared-memory.
  It has none of J's product how-tos, the go-live checklist for his sites, or Studio and Gen changes.
- **Talk's and the PM's prompt:** `customerSystemPrompt()` (talk.ts): the owner by name (owner.ts `ownerName`, the
  first admin's first name), their games with their live address, story and quality bar, and the studio's mechanics.
  It has none of: Hawkes Biomedical, J's products, servers, costs, On Air, or changing Studio or Gen.
- **Anything shared that still says "J"** reaches Claude in the owner's name: `forOwner()` on Talk's turns and call
  prompt, agents' briefs, scouts and Studio's own Claude calls (canon checks, acceptance).
- **The memory:** a customer's Studio imports only `memory/seed-customer` (generic conventions). At start it deletes
  any entries of J's seed (`purgePlatformSeed`), which Studios made before this had imported.
- **Talk's tools:** the platform's (costs, the ledger, resources, Social, the Unity build server and devtools) aren't
  listed, and descriptions say "the owner".
- **Tests:**
  - `test/customer-voice.test.ts`: the prompts, roles, skills, tools and memory have none of J's markers: Hawkes
    Biomedical, Pierce, J, J's, the product names
  - `test/j-voice.test.ts`: J's Studio still has them

**Their AI, any of five** (**built**, src/ailink.ts; J, 2026-10-30): Claude (subscription sign-in or Anthropic key),
Cursor (API key), GitHub Copilot (token), Gemini (API key) and Antigravity (Google sign-in, antigravity-login.ts).
- Keys are sealed in `.data/ai/keys.json` and put where each harness reads them at start. Their Antigravity login is
  kept sealed too.
- "Use this" makes one the Studio's harness. Only a provider they linked can be picked (settings.ts refuses others).
- Onboarding's "Connect your AI" card and Settings → Your AI show the same list.

**Talk is on every plan** once they linked their own AI (J, 2026-10-30: "it's just an interface for talking with
LLMs anyways"). Agents and the PM stay on Team and up.

**What they see by plan and role** (dashboard/app.js `gateUi`; the API refuses the same):
- `data-pro="<feature>"`: a control their plan lacks is greyed out with a 🔒, and a click offers the Upgrade.
  Examples: an agent fix in Backlog, the PM switch.
- `data-admin`: hidden from members (going live, rollback, merges and closes, the PM switch, Settings).
- `data-platform`: J's machinery, hidden in every customer's Studio (Library's content health, the Unity and local-run
  options, the walk-away badge, Gen job links).

**Games with only an address** (no repository):
- Nothing to sync.
- Go Live explains that Studio plays and reviews the game where it is deployed, and offers "Add its repository". The
  repository is saved; agent fixes, a beta and going live from it come with GitHub for customers (`STUDIO_GITHUB_APP`).
- "Run a playtest" is on the game's card and on both playtest tabs.

**Playtest videos and every library file** go through Studio's relay to Gen (`/api/gen/v1/files/<asset>`, with the
Studio's own Gen key and range requests), never straight to hawkesgen.ai, which answers 401 to a browser. This
applies to J's Studio too.

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
- cells isolated on live (section 2, Isolation: setup step 8 and the migration)
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
