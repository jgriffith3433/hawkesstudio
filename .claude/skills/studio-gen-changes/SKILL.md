---
name: studio-gen-changes
description: How to change Hawkes Studio or Hawkes Gen themselves safely - they deploy the cloud server on every push to main, Node 24 type stripping, typecheck and tests, the protected files, the smoke check, what a restart interrupts. Use for any change in hawkesstudio or hawkesgen.
---
# Changing Hawkes Studio or Hawkes Gen

Both run on the AWS control server (`/srv/hawkes/hawkesstudio`, `/srv/hawkes/hawkesgen`) and **deploy themselves**: a
push to main runs CI (typecheck, tests), and the server pulls a passing commit (`deploy/hawkes-pull.mjs`), restarts that
service and rolls back if it isn't healthy within 90 s. There's no beta lane. A mistake breaks the service J uses for
everything: keep changes small.

- **Code:** Node 24 runs `src/*.ts` directly (type stripping): erasable syntax only (no enums, no namespaces, no
  parameter properties), imports end in `.ts`. Studio's only dev dependency is TypeScript; state is `node:sqlite`.
- **Checks:** `npm run typecheck` and `npm test` (Studio's tests use a running Gen at `HAWKESGEN_URL` for free local tools;
  without it they skip). Add a test for new logic next to the others in `test/`.
- **Protected files** (an agent change touching them isn't pushed, unless J's request names the file): `.data/`, `.env`,
  keys, `*.pem` (never); `deploy/hawkes-pull.mjs`, `deploy/deploy.mjs` (Caddy, units), `deploy/provision.mjs`,
  `deploy/secrets.mjs`, `deploy/*-token.mjs`, `src/claude.ts`, `bin/git-credential-hawkes`, `src/github-oidc.ts`,
  `.github/workflows/`; Gen: `bin/fetch-secrets.mjs`, `src/auth.ts`.
- **Verification** of an agent change: CI on the pull request, the checks again, and a smoke check (the service from the
  worktree on a spare port with a scratch data folder and no keys: health ok, the dashboard loads, `node --check` on
  `dashboard/*.js`; Studio runs with `STUDIO_SMOKE=1`). A new dashboard script must be added to the typecheck script.
- **Restarts:** a Studio deploy restarts Studio within seconds (`hawkes-pull` waits only for critical sections). Agents
  and Talk answers run outside it (`src/detach.ts`) and are reattached; agent changes carry on from their recorded step
  (`changes.phase`) and runs from their steps, waiting on the same Gen jobs (docs/cloud.md, "Restarts end nothing").
  In-memory state is lost: keep long work resumable (record its step and Gen job ids in the database), wrap a short
  step that must not be cut halfway (a push followed by a database write, a merge) in `critical()` (`src/drain.ts`).
- **Server setup** that a push doesn't deploy (systemd units, Caddy, DNS, keys, the agent sandbox user) is
  `deploy/deploy.mjs`, run by J.
- Other sessions edit these repos too: commit only your own files; never stash, reset or switch branches in a shared
  checkout.
