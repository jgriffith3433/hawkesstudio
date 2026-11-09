---
name: onboarding
description: Bring someone's existing project into Studio - survey the repository first (what it is, how it's built and hosted today, how its pieces connect), then fit Studio around it with the smallest changes that do the most (hook, builds, relative paths, the playtest bot, checks), one step at a time.
---
# Bringing a project into Studio

People arrive with projects that already exist and already work their way: a Unity game and a separate website that
serves its build, a Vite app deployed by its own workflow, a static site on a custom domain, a Godot game with no CI at
all. Your job is to understand what's there and make Studio fit it, not to make them redo their project Studio's way.
Find things out from the repository before asking; ask only what a repository can't tell you (what it's called,
where it's played if there's no domain, what "done" means to them).

## 1. Survey first

`studio_project survey { repo: "owner/name" }` before adding it (or `{ product }` once it's added; it covers the
project's other repos too). Survey every repo they mention, together. It reads the repo through GitHub (nothing is
changed) and returns:
- `parts`: each Unity project (its folder and editor version), web app (framework, build command, output folder),
  static site, Godot project. One repo can hold several; several repos can make one product.
- `hosting`: its domain (CNAME), how GitHub Pages publishes it (a workflow or a branch), and `unityBuildIn`: the folder
  where a website serves a Unity WebGL build (e.g. `Game`).
- `ci`: each workflow, what starts it and what it does (builds Unity with GameCI, deploys Pages, runs tests...).
- `studio`: whether Studio's push hook is there and points here, and whether it speaks the playtest contract.
- `suggest`: the engine, builds and live address that fit what was found.
- `notes`: blockers first, then improvements, then facts, each with why and who acts (`talk`: you, now; `agent`: a change
  in the repo, as a task; `person`: only they can).

If Studio can't reach the repo yet, the error says so: give them the install link (studio_project check or studio_github
status) and survey again after.

If the checklist (studio_project check) has a `permissions` item that isn't done, GitHub is holding back a permission
the app asks for until the account owner accepts it: an app that gained a permission after it was installed waits for
that, and nobody guesses it. Walk them through the item's steps one at a time, with its link (the installation's page:
**Review request**, then **Accept new permissions**). They don't need to tell you when it's done: Studio sees it by itself
(GitHub's installation event, or their coming back to Studio) and carries on. Studio's own builds never need
Actions: write; only a build that runs in their own GitHub Actions and is started from the Build button does
(docs/github-permissions.md).

## 2. Say what you found, plainly

A short picture in their terms, not a dump: "Your game is a Unity 6 project in `Game/`; your website serves its
WebGL build from `Play/` and GitHub Pages publishes it at yourgame.com. There's no CI yet." Then how it maps
onto Studio:
- **Connect the pieces.** A website that serves a Unity build (`unityBuildIn`) and a Unity project are two projects whose
  builds connect: the game's build gets `publish: { project: <website id>, path: "<unityBuildIn>/" }`, so every build lands
  in the site and the site's beta plays the newest. Ask before assuming two repos are one product.
- **Fit around their CI.** If a workflow already builds or deploys, keep it: going live is a push to main, which their
  Pages workflow already publishes. If a workflow already builds Unity with GameCI, a build `{ tool: "actions" }` uses
  it (the builds skill) instead of building twice.
- **Their live address** from the domain or Pages; confirm it with them.

## 3. Blockers before anything else

Fix what stops Studio from building or playing it, with their OK, as agent tasks (studio_task, a pull request into
beta):
- Unity packages pointing at a folder outside the repo (`file:C:/...`, `file:../../elsewhere`): a cloud build can't see
  them. Swap each for its git URL with a version tag, or embed it in `Packages/`. For Studio's own packages (the
  playtest bot, Hawkes Net, Hawkes Gen, Analytics) studio_plugins install does it with the right git URL.
- An editor version the cloud doesn't have: they upgrade (a branch first), or build in their own Actions with GameCI.

## 4. Small changes that go a long way

Offer these as a short list, each in a sentence with what it gives them; do the ones they say yes to:
- **The push hook** (studio_project setup, an Approve card): every push to beta rebuilds and playtests it.
- **Relative paths** (root `/css/...` links, Vite's base "/"): the site works at any address, including GitHub Pages
  project sites and change previews. An agent task.
- **The playtest bot** (studio_plugins install, then studio_project contract): playtests actually play it.
- **Checks** (what an agent's change must pass, e.g. `npm ci && npm run build`): set them on the project; offer a CI
  workflow if they want it on every push too.
- **The 🐞 button** (studio_project report) on their beta pages: bug reports with a screenshot land in the backlog.
- Plugins that fit (studio_plugins status): outdated ones, and ones that match what the game does.

## 5. Add, set up, build, play

studio_project add with what the survey suggested (engine, builds, live, repo) and what they told you, then
studio_project check and go down its list with them (talk items yourself, an Approve card for approve items, the link
for person items). Build it (studio_project build), and when the build is in, playtest it and share the video.
Record what you learned about how the project works as memory (kind convention, scoped to the project), so agents
start from it.

Keep the conversation moving: one question at a time, never a wall of options, and always the link with a step.
