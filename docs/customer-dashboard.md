# A customer's dashboard

*J, 2026-10-30: "there's way too many tabs", "should be able to edit games, delete them, change their settings",
"make settings page easier".* What a customer's Studio shows; J's own Studio keeps its tabs as they are.

## Tabs (dashboard/groups.js)

The nav has one button per group; inside, a small bar switches between the group's pages. They are the same tabs as
before, so links, Talk's guide and `#hash` addresses keep working.

| Group | Pages |
|---|---|
| Talk | Talk · Inbox (the Inbox's count shows on Talk) |
| Games | Games (each game's card: Play live, Play beta, Edit; + Add a game) · Go live · Analytics |
| Plan | Roadmap · Bugs (the backlog) · Agents' changes |
| Playtests | Playing now · History (every past playtest) · Reports · Runs |
| Library | |
| More | Memory, Users, Settings |

The customer starts on Games. Not in a customer's Studio:
- Ready to test: Go live covers it.
- Screening: the platform admin's; the API refuses it too (lockdown.ts).

Analytics is theirs (J, 2026-11-01: "Turn on the analytics tab for customers again"): every game of their Studio, from
Hawkes Analytics. Their Studio's Gen key answers only for their own org's games, which Gen knows as `org_<hex>.<game>`
(src/analytics.ts adds and strips the prefix); a game Gen has nothing on shows "no players on record". The players list
and "that was me" marks span J's own games and stay the platform admin's. A customer's game sends data only once it is
in Gen's analytics registry (hawkesgen `analytics/products.json`) under its `org_<hex>.<game>` id.
- On Air, Social, Costs and Resources.

What their plan lacks is greyed out with an Upgrade; members don't see admin controls (app.js `gateUi`).

## Games

- **Edit a game** (Games → Edit, or Go live → Edit), `studioEditGame` in app.js: name, what it's made with, where it
  plays (live), its test version (beta), repository, what it is, its story and what "done" means. It saves through
  onboarding's checks (`PUT /api/products/<id>`); Delete removes it, and its history stays. "+ Add a game" opens the
  same form.
- **Beta and live:** a game's `beta` address is where its playtests "on beta" play (config.ts `asCustomerGame`: its
  "local" lane is the beta address, else live). Play live and Play beta are on the game's card and on Go live, so the
  owner plays beta before shipping and live after.
- **Go live** for a game Studio doesn't ship (no repository, or GitHub not connected for customers yet): its Beta and
  Live links, Play beta, Play live, Edit, and a line saying it goes live where they deploy it.

## Settings

Plan and credits, Your AI and Notifications first. "Agents and the PM" and "Advanced: models, tuning and the call
voice" are folded away.
