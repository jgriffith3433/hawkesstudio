# Plugins

J, 2026-10-31: "Hawkes Net can turn into a 'plugin' (both Unity and Babylon, and we can support other frameworks later)
then we can start offering a suite of plugins and show when plugins are available or if installed and what version and
allow upgrading if out of date etc. Really make this powerful."

A plugin is a package a project depends on **by version**, with one install recipe per engine. Studio shows, for any
project in any repo and engine (J's Studio and customers'), which plugins it has, which version and where, the latest,
and what is out of date; installing or upgrading is a pull request into beta with exact edits.

Code: `src/plugins.ts`. Catalog: `plugins/catalog.json`. Dashboard: `dashboard/plugins.js` (More → 🧩 Plugins, and a
Plugins section in each project's dialog under its Builds). Talk: `studio_plugins`. Test: `test/plugins.test.ts`.

## The catalog (`plugins/catalog.json`)

Each plugin: `id`, `name`, `description`, `gives` (what it gives, a list), `homepage`, `docs`, `category`, `setup` (notes
shown before and with an install: what else it needs), `brief` (optional: what an agent does to wire it into the game;
plugins with one offer "Set it up with an agent"), and `engines`, one recipe per engine (`unity`, `web`, `babylon`,
`godot`).

| Kind | What it edits | Fields |
|---|---|---|
| `upm-git` | `Packages/manifest.json` (anywhere in the tree: Unity projects in a subfolder are found), the dependency `"<package>": "<git>#v<version>"` | `package`, `git` |
| `upm-embed` | Copies a folder Studio ships into `Packages/<package>/` (an embedded package; no package repo needed), and drops an old manifest line for it | `package`, `from` (a folder in this repo) |
| `npm-tarball` | `package.json`, `"<package>": "<tarball>"` with `{version}` in the URL | `package`, `tarball` |
| `npm` | `package.json`, `"<package>": "^<version>"` | `package` |
| `script-tag` | An `index.html`: the line goes before `</head>`; an upgrade changes only the script's `src` | `src`, `tag` (templates), `detect` (a regex; group 1 is the version when there is one) |
| `copy-file` | Files Studio ships, copied next to the web project (its `src/` or `js/` when it has one; an existing copy is updated where it is) | `files` [{ `from`, `name` }], `marker` (a regex for the version in the first file) |

`versions` says where versions come from: `github-tags` (`repo`: its `v<semver>` tags through GitHub's API; optional
`prefix`), `package-json` (`repo`, `path`, `ref`: the `version` of a package.json in a repo), `studio-file` (`path` in
this repo, `match` a regex, else its JSON `version`), `fixed` (`list`), `none` (installed or not, no versions).
Templates: `{version}`, `{major}`, `{project}`, `{genProject}` (the project's name in Hawkes Gen: a customer's is
prefixed), `{reportScript}` (the project's 🐞 script address, reportkey.ts).

`available: false` with `why` marks an engine "Coming soon": installed copies are still detected and shown, Install is
refused with the reason.

### What's in it, and where versions come from

| Plugin | Engine | Kind | Versions |
|---|---|---|---|
| Hawkes Net | Unity | upm-git `com.hawkes.net` from `hawkesnet-unity` (`?path=/Packages/com.hawkes.net#v…`) | tags of jgriffith3433/hawkesnet-unity |
| Hawkes Net | web | npm-tarball `@hawkesgen/net` | tags of jgriffith3433/hawkesnet-js (hawkesnet `tools/release-js.mjs`) |
| Hawkes Net | Babylon | npm-tarball `@hawkesgen/net-babylon` | tags of jgriffith3433/hawkesnet-babylon |
| Playtest bot | Unity | upm-embed `com.hawkes.playtest` from `clients/unity/com.hawkes.playtest` | its package.json here |
| Playtest bot | web | copy-file `hawkes-playtest.js` (+ `.d.ts`) | `CONTRACT_VERSION` in `clients/web/hawkes-playtest.js` |
| Hawkes Gen for Unity | Unity | upm-git `com.hawkes.gen`: coming soon (no public package repo yet) | package.json in jgriffith3433/hawkesgen |
| Hawkes Analytics | web | script-tag `https://hawkesgen.ai/sdk/analytics@<major>.js` | fixed: 1 (breaking changes ship as `@2`) |
| Hawkes Analytics | Unity | upm-git `com.hawkes.analytics`: coming soon | package.json in jgriffith3433/hawkesgen |
| Bug report button | web | script-tag, the project's own report line | none |

## Detecting

`detect(project)` reads every repository of the project through GitHub's API, at `beta` (else `main`, else its default
branch), with each repo's own token (ghtoken.ts `repoToken`/`githubFetch`; public repos work without one):
- the repos: a project added in a Studio has `github` (owner/name) and maybe `repos`; J's products.json products map
  their folder through `repos.ts repoMap()` (a subfolder such as `YoobaLand/YoobaLand` is kept), plus a Unity game's
  website repo (`site`), role `site`.
- the files: one recursive tree per repo; `Packages/manifest.json` anywhere, `package.json` files (never a Unity
  package's own, under `Packages/` or `Assets/`), `index.html` pages; build output, `node_modules`, `Library` and the like
  are skipped. Files are read by blob, only when a recipe needs them.
- per plugin and engine: `applies` (the project has what it needs: a manifest, a package.json (one that uses Babylon for
  `babylon`), a page), `installed`, `version` (`#v1.2.3`, `/v1.2.3.tar.gz`, `^1.2.3`; `local` for a `file:` path on
  someone's disk), `where` (repo, file, line), `latest`, `outdated` (numbers compared part by part; a local path is never
  outdated), `host` (where an install goes) and `action`: install, upgrade, current, unavailable or n/a.

Scans are kept a minute (`?fresh=1` reads again); latest versions ten minutes.

## Installing and upgrading

`plan(project, plugin, {version, engine})` is the exact edits, computed from the files at the base branch: JSON
dependency lines edited in place or inserted in sorted place with the file's own indentation, newline and spacing (the
result is parsed again to be sure), a script line before `</head>`, copies whose content is already the same skipped
(git blob ids). The engine is the one asked for, else the one installed, else the first the project has (Babylon, then
Unity, then web). A version newer than the newest tag is refused.

`apply` commits the plan on `plugin/<id>-<version>` (`plugin/<id>` for a plugin without versions) cut from the base
(beta) through the Git Data API with the repo's own token, opens a pull request into beta (an open one for that branch
is reused) and records it in `plugin_installs`. Merging it puts the plugin on beta; going live is the usual step.

**Not Studio's change flow:** an agent change (agents.ts) owns a worktree on Studio's disk and a session; registering an
outside branch as one would break its update-from-beta, conflict passes and cleanup. So a plugin is a plain pull
request, linked everywhere. **Wire** (`agent: true`, `studio_plugins wire`, "Set it up with an agent") is the agent route
for plugins that need code: Studio makes the branch (no pull request) and starts an agent change (`startTask`, the
project's repo as `target`) whose brief says to merge that branch first, then wire the plugin as the catalog's `brief`
says, with its setup notes; the change then works like any other (checks, auto-merge into beta).

## API

```
GET  /api/plugins                                   the catalog, each engine with latest and available
GET  /api/projects/<id>/plugins[?fresh=1]           { repos, plugins: [{ id, installed, outdated, applies, engines: [...] }], installs }
GET  /api/projects/<id>/plugins/<plugin>/plan?engine=&version=   the edits (big file contents as size and first lines)
POST /api/projects/<id>/plugins/<plugin>  { version?, engine?, agent? }   { branch, pr, url, change, plan, note }
```

Anyone signed in may install (it is a pull request into beta, like an agent's); merging and going live keep their rules.

## Adding a plugin

1. Release the package with version tags (`v1.2.3`) in a repo, or ship its files in this repo (`clients/...`).
2. Add an entry to `plugins/catalog.json`: the recipe per engine and where its versions come from, `setup` notes, and a
   `brief` when it needs code to be wired in.
3. `node --test test/plugins.test.ts` checks the catalog (kinds, fields, regexes, files that must exist here).

No code change: the dashboard, the API and Talk read the catalog.
