# GitHub permissions

Why this exists (J, 2026-11-08): Hawkes Games' builds waited three hours because Studio's GitHub app didn't have
**Actions: write** on the website repo. Fixing it took two steps on GitHub that nobody would guess: add the permission
under the app's Permissions, then accept it separately on the installation's page. Customers must never have to work
that out. So:

1. Studio asks for **everything it uses when the app is installed**, nothing more (`src/ghperms.ts` `APP_PERMISSIONS`,
   used by the manifest that makes the app, the check on an app a customer brings, the chooser page and these docs).
2. What can be avoided is: **Actions: write is not asked for.** Studio's builds run in its own cloud (Hawkes Gen for
   Unity, Studio for npm and static sites), so they cost a customer no GitHub Actions minutes and need no permission
   to start a workflow. It is only for a project that chose to build in its own GitHub Actions (`{ tool: "actions" }`)
   and wants Studio's Build button to start that workflow; that workflow still runs on its own triggers without it.
3. When an installation is missing something (an app that gained a permission after it was installed), Studio says so
   **at setup** (the "Get it ready" checklist's `permissions` item, and Settings' GitHub line) and **at the moment it's
   needed** (one Inbox card per fix, however many projects or builds wait on it), each with the steps and the direct
   link to the installation's page. Then it **looks again by itself**: GitHub's signed `installation`
   `new_permissions_accepted` event, GitHub's return to the setup URL, or the customer coming back to Studio's tab.
   Never a timer.

## What the app asks for

| Permission | Why Studio needs it |
|---|---|
| Metadata: read | see the repositories you chose (GitHub requires it for every app) |
| Contents: write | read your code and push its agents' branches, beta and the builds it makes |
| Pull requests: write | open pull requests for its changes and merge them into beta (and main when you go live) |
| Workflows: write | add its push hook (`.github/workflows/hawkes-studio.yml`) and commit changes that touch your workflows |
| Pages: write | publish a site with GitHub Pages when you choose that for going live |
| Administration: write | adjust main's rules once (the setup card's rules step), so going live needs no extra step |
| Actions: read | read your own GitHub Actions builds' results, if a project builds there |
| Checks: read | see whether your checks passed before merging |

Optional, never asked for at install: **Actions: write**, only to start a project's own GitHub Actions build from Studio's
Build button. The pages.yml re-run after switching an old Pages site to "GitHub Actions" (golive.ts) also uses it when
it's there, and otherwise says to run it once from the Actions tab.

## When GitHub is waiting for the owner to accept

GitHub doesn't give an installed app a permission it added later until an owner of the account accepts it. What the
customer sees (`acceptSteps` in ghperms.ts; the same words on the checklist and the card):

1. Open **Installation page on GitHub** (the link; `github.com/settings/installations/<id>`, or
   `github.com/organizations/<org>/settings/installations/<id>`) as an owner of that account. Near the top, GitHub
   says the app is asking for updated permissions: press **Review request**.
2. Press **Accept new permissions**. Nothing else on that page needs changing.
3. Come back to Studio: it notices by itself and carries on (builds that were waiting start again).

Only when the app doesn't ask for it yet (an app the customer made, missing one) does a first step come before these:
open **The app's Permissions on GitHub**, set it, and press **Save changes**. Customers on Hawkes Studio's shared app
never do that step: Studio's team owns that app.

## How Studio notices

- **The app's webhook** (`POST /api/github/webhook`, `src/github-webhook.ts`): on by default for apps made from now on.
  Only installation events, which GitHub sends every app without a subscription (`installation` created,
  new_permissions_accepted, unsuspend, deleted, suspend; `installation_repositories` added, removed). Checked with
  GitHub's signature (the app's webhook secret from the manifest flow). Each one forgets the cached installation tokens
  and the app's permission list and looks at the open access cards once; an installation linked to a customer's Studio
  tells that Studio instead (`cells.ts tellCellGithubChanged`, its owner key, only if it is awake).
- **GitHub's return** to the setup URL (`/api/github/installed`, with `setup_on_update`): looks again.
- **The customer coming back** to Studio's tab with an access card open (`dashboard/inbox.js`, `POST /api/github/recheck`):
  looks once, at most once a minute per card, and not at all when no card is open.
- **"Check again"** on the card looks right away.

A customer's Studio holds no app key, so it asks the control plane what the shared app may do on its repo
(`/api/cells/self/github-probe`, only through an installation linked to that org).

## For an app made before 2026-11-09

Apps made earlier have their webhook switched off (the manifest said so then). Everything above still works without it
(GitHub's return, coming back to Studio, Check again). Turning the event on for such an app is a step on GitHub for the
app's owner (General → Webhook → Active), and only helps when Studio has the app's webhook secret saved; it's a nicety,
not something any customer has to do.

## Not done yet

- Pushes still reach Studio through each repo's own `hawkes-studio.yml` workflow, which uses a little of the customer's
  Actions minutes per push. The app's webhook could carry `push` events instead (no workflow, no minutes, no
  Workflows: write for the hook); that changes how every repo is wired, so it's its own change.
