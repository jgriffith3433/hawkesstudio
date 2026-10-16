---
name: github-pages
description: How Hawkes websites are hosted on GitHub Pages and what that rules out - static files only, pages.yml builds, switching the Pages source to Actions, CNAMEs, Unity .unityweb loading, beta sites vs live. Use when a change touches hosting, headers, a build workflow or anything server-side.
---
# GitHub Pages

Every product website is static on GitHub Pages: no server code, no custom headers, no backend. Each repo has a
`CNAME` for its domain. Docker, nginx, Flask or EC2 files in a site repo are leftovers (Sick Of It's old paywall).
Anything a feature needs from a server (accounts, payments, saves, analytics) must be client-side or a third-party
service: say so to J rather than building a backend.

## How each site is published

| Site | Published from |
|---|---|
| Dose Of Destruction, PH Origins | their own `.github/workflows/pages.yml` on main (TypeScript/Vite: Pages can't serve the source) |
| Corporate site, I Can Be, Imagine Live TV | main as committed |
| Sick Of It, Yooba Land, The Place Department | the website repo's main, with the Unity build in `Game/v<n>/` (Studio commits it on go live) |

- **The Pages source switch:** the first time a `pages.yml` reaches main, Studio sets the repo's Pages source to
  GitHub Actions (`PUT /repos/<slug>/pages { build_type: "workflow" }`, `golive.ts`) and dispatches the workflow. The
  push-triggered run is cancelled by the pages concurrency group: expected. If the token can't, J switches it in
  Settings > Pages; meanwhile the branch keeps being served.
- **No Content-Encoding:** Unity builds use `.unityweb` with the decompression fallback; the page's loader names the
  current `Game/v<n>/` files.
- **Beta is not Pages:** `https://<sub>.hawkesgen.com/` is the beta site, served by Caddy on the control server from
  beta's build (`/srv/hawkes/previews/<product>/beta`); `/c/<change>/` is one agent change. Only main reaches Pages.
- Every product repo's `.github/workflows/hawkes-studio.yml` tells Studio about pushes to beta and main (GitHub OIDC,
  no secrets). Don't edit workflows in an agent change.
