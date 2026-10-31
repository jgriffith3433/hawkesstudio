# Projects: games, web apps and sites

J, 2026-10-30: games are "projects" now, and a project may be a web app with a server of its own, its own beta and live
lanes and more than one repository (Hawkes Gen's app is the first). A customer points Talk at the repositories and
Studio takes in its bug reports, works on features and fixes, playtests it signed in, and takes it live.

## What a project has (config.ts `ProductInput`, `saveProduct`)

| Field | What it is |
|---|---|
| `kind` | `game` (default), `app` (a web app with a server), `site` |
| `live`, `beta` | Where it plays. An app's beta is deployed by its own CI: Studio plays it there (local serve `remote`) |
| `repo`, `repos` | The main repository, and more: `[{ repo: "owner/name", role: "what it is" }]`. All are cloned; a task names one with `studio_task` `target` (owner/name, name or role: `agents.ts repoForTarget`) |
| `versionPath` | A path on its site that answers JSON with the commit it runs (`commit`, `sha` or `gitSha`; Gen: `/v1/health`). Studio reads beta's to record what a playtest played and live's to know a go-live deployed (`deployed.ts`, `deploy.ts verifyLive`, `pipeline.ts`) |
| `checks` | What an agent's change must pass in the main repo (e.g. `npm ci && npm run typecheck && npm test`); else its build. The agents' image has Node, git, Python 3 and ffmpeg |
| `testSignIn` | `{ url }` on its beta: playtests start signed in (below) |
| `reportOrigins` | Sites besides its beta whose pages may send bug reports (live only when listed) |

The dashboard's project dialog has these under "For web apps and bigger projects"; Talk's `studio_project` (and its old
name `studio_game`) takes them. `/api/projects/...` is `/api/games/...`.

## Bug reports from its pages (`reportkey.ts`)

Each project has a report key. Its pages add one line (`studio_project report`, or the project dialog):

```html
<script src="https://studio.hawkesgen.ai/o/<org>/r/<project>.js?k=rk_..." defer></script>
```

It loads Studio's widget (`dashboard/report-widget.js`: the button, the screenshot, the console) with the project's
endpoints. A page can add what it knows with `window.hawkesReportContext = () => ({ ... })` (Gen's app: the account,
the scene in front, the open tabs, the timeline's selection, jobs waiting); it is kept with the report. Reports post to
`/r/<project>/report?k=` and uncaught errors to `/r/<project>/error?k=`: no Studio sign-in, but only from the project's
origins (its beta and `reportOrigins`), with its key, at most 10 reports and 30 errors a minute from one address. They
become source-J findings like the beta sites' button (top priority for the PM loop).

## Playtests signed in (`playtest-signin.ts`)

Before a beta playtest of a project with `testSignIn`, Studio posts its beta a token signed with the project's secret
(`studio_project signin` shows it; admins only):

```
POST <testSignIn.url>  { "project": "<id>", "exp": <unix s, 5 min ahead>, "nonce": "<hex>", "sig": "<base64url HMAC-SHA256(secret, `${project}.${exp}.${nonce}`)>" }
```

The app checks the signature, the expiry and that the nonce is new, signs in a test account of its own (never a real
person's; beta only) and answers with its session's `Set-Cookie`. Studio gives those cookies to the playtest's browser.
Gen's side is `hawkesgen/src/testsignin.ts` (`POST /v1/users/test-session`, the secret set at `PUT /v1/admin/test-signin`).

## Hawkes Gen's app as a project

- kind `app`, beta `https://beta.hawkesgen.ai/`, live `https://hawkesgen.ai/`, repo the Gen repository, versionPath
  `/v1/health` (CI sets `HAWKESGEN_COMMIT` on every deploy), checks `npm ci && npm run typecheck && npm test`,
  testSignIn `https://beta.hawkesgen.ai/v1/users/test-session`.
- Agents on it work like any project's (a branch from `beta`, a pull request into `beta`, never main), and keep Gen's guard
  rails: a change to `src/auth.ts`, `bin/fetch-secrets.mjs`, CI, data or keys isn't pushed unless J names the file
  (`agents.ts`, the same `guardFiles` as Gen's infra agents).
- Its playtest bot is `dashboard/gen/playtest.js` (`smoke`, `media`, `signedout`; no GPU spent).
- Its 🐞 button: the project's report line set at `PUT /v1/admin/report-script` (Gen's beta then loads it); without
  one, Gen's beta passes the widget through to J's Studio (`hawkesgen/src/studioreport.ts`).
