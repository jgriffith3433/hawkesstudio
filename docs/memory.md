# The shared memory

What every Claude working on Hawkes knows across runs and conversations: Talk, the PM, agents, scouts, reviewers, and
a session in the Claude app on J's laptop or phone (over Studio's remote MCP). It lives in Studio on the cloud server
(`src/memory.ts`, SQLite with full-text search in `.data/studio.db`), so every one of them sees the same thing.

## What's in it

| Kind | What | Who writes it |
|---|---|---|
| `decision` | J's word ("we never…", "go with X") | J (Memory tab), or Talk/PM quoting J's own message in that conversation (`quote`: Studio checks the words are in one of J's messages; Claude's text and Studio's notices don't count) |
| `preference` | How J likes things | J, Talk, the PM |
| `convention` | How a codebase really works | anyone (agents: as candidates) |
| `lesson` | What broke, and the fix | anyone (agents: as candidates) |
| `canon` | Story and IP facts: characters, places, rules ("slimes are villagers, never enemies") | the seed, J, Talk with a source doc; agents as candidates |
| `state` | Work in progress | anyone; fades after a week without an update |

**Scope:** studio-wide, a product (`hawkesstudio` and `hawkesgen` count), or a roadmap item (`i_...`).
**Provenance:** who wrote it, when, from which run or conversation (`source`), where else it was seen (`sources`: a
near-duplicate confirms the entry instead of adding one), when it was last confirmed, how often it was used.
**Status:** `active`; `candidate` (an agent's or scout's note, waiting for the PM); `disputed` (it contradicts something:
J decides); `faded` (no longer used or true: still searchable, never injected).

## Read path

Studio puts the few most relevant entries into every prompt it writes (`memoryBlock`):
- agent briefs (`agents.ts` writeBrief / writeInfraBrief: "What the studio already knows"), scouts (`scout.ts`);
- reviews: the product's canon goes with the story (`review.ts` withCanon), so a review files a contradiction as a bug;
- Talk: the studio-wide decisions and preferences are in its system prompt (stable, so the prompt caches; it only
  changes when memory does), and each turn's message gets the entries that match it, appended after J's words.

Order: decisions and preferences of the scope first (by id, stable), the product's canon for content work and reviews,
then full-text matches on the task (lessons and conventions included while unconfirmed, marked so). About 3,500
characters. Using an entry counts it as used.

Tools (Studio MCP, also over https://studio.hawkesgen.ai/mcp): `memory_search` (entries and past agent runs),
`memory_get`, `memory_write`, `memory_curate` (list, confirm, edit, merge, fade, dispute, delete, publish). Agents and
scouts get their own Studio MCP server with only search, get and write (and `studio_analytics`, read-only: `STUDIO_MCP_TOOLS`), which writes as them
(`X-Studio-Agent`): their entries are candidates.

## Write path

- **Agents** end every pass with `.hawkes/learned.md` ("what should the next agent know": `- lesson: <title> — <what>`,
  `- convention: ...`). Studio turns each line into a candidate scoped to the product (and roadmap item), with the pull
  request as its source (`remember` in `agents.ts`). They can also `memory_write` while they work.
- **Talk** records J's decisions (with his words) and preferences as he says them, and durable things it learns.
- **The PM** curates in its turns (the prompt says how many candidates wait): confirm, merge duplicates, fade what no
  longer holds, delete what's wrong; a candidate that contradicts a decision or canon is disputed and J is asked.
- **Housekeeping** (daily, no model): `state` entries fade after 7 days without an update, candidates after 21 days
  unconfirmed and unused, other entries after 60 days unused. Decisions, canon and anything J edited never fade.

## Run history

Every agent change, scout and Studio/Gen change is a row in `agent_runs` (kind, product, title, outcome, summary,
lessons, cost), updated when it's merged or closed. `memory_search` returns matching runs too: "how did we fix the black
screen last time?". Dashboard: Memory tab, "Agent runs".

## Canon check

Content and story changes (`roleOf` in `agents.ts`: requests about dialogue, lore, levels, characters, enemies...) get a
canon check of their diff once the agent is done (`canon.ts`: Sonnet through Gen's `llm.json`, about a cent).
The check gets the task's request and criteria and J's decisions: what the task asked for is never a conflict. Each
finding quotes the canon entry and the exact added diff line, with a confidence; only a high-confidence contradiction
whose quote and line check out blocks (`verify.canon.conflicts`, `ok: false`), and fails the merge gate
(`acceptance.ts`): J or the PM decides. Everything else is a note on the change (`verify.canon.notes`, in its log and
ready line), never a block: low or medium confidence, ambiguous wording, requested by the task, placeholder or tinted
stand-in art, off the story path (retired or arcade levels), an empty value, a line the change didn't add
(`sortConflicts`, J 2026-10-18 after five misreads in a day). Reviews judge the footage against the canon too.

## Human-readable

- **Memory tab** (dashboard): filter, search, edit, confirm, fade, delete; candidates and likely duplicates; agent runs.
  J's edits mark an entry edited (the seed never overwrites it).
- **Markdown export** (`exportMarkdown`): `learned/<product>.md` per product (and `studio.md`), `canon.md` (the story
  bible). `GET /api/memory/export?file=canon.md`. On the server it is committed daily to the orphan branch `memory` of
  hawkesstudio (https://github.com/jgriffith3433/hawkesstudio/tree/memory). Its commits say `[skip ci]` and it holds no
  code, so nothing runs or deploys from it.
- **The seed** (`memory/seed/*.json`, in git): canon from the story docs (PH Origins `Lore.txt`, Sick Of It
  `Docs/Story.md`, Dose Of Destruction `fighters.json` and `campaign.json`, the other products), and the studio's
  decisions, preferences, conventions and lessons. Imported at startup, keyed: editing a seed file updates its entries
  (unless J edited them in the tab) and never duplicates. Regenerate `canon-doseofdestruction.json` when the roster
  changes.

## Moving memory between Studios

A customer's Studio has its own memory and none of J's (`purgePlatformSeed`; `test/customer-voice.test.ts`). A project's
knowledge moves only when an admin moves it (`src/memory-transfer.ts`). It works the same both ways: any Studio exports
and any Studio imports. J moving Yooba Land into his customer Studio is the first case. A customer can bring their own
docs too.

- **Export:** `GET /api/memory/export?product=<id>[&kinds=canon,decision,convention,lesson,preference][&format=md]`
  returns a bundle `{format: 'hawkes-memory/1', from: <this Studio's address>, name, product, exported, entries: [{kind,
  title, body, tags, source, quote, product, created, by}]}`. It holds active entries only: no candidates, no `state`, no
  run history, ids, usage counts or roadmap items, and anything that looks like a key, token or password is
  `[redacted]` (`redact`). `format=md` returns the same bundle as Markdown for people. Use `product=studio` for the
  studio-wide entries.
- **One-time link:** `POST /api/memory/export/link {product, kinds, minutes}` returns a signed, expiring URL
  (`…/api/memory/export/<token>`; 60 minutes by default, a day at most). The importing Studio fetches it once with no
  keys. The token is an HMAC with `.data/memory-links.key`; `memory_links` records each link, and it works once
  (afterwards it answers 410), until it expires (410), and never when forged (404). The route comes before the sign-in
  gate (`server.ts`, `cloudauth.ts openRoute`), so a customer's cell serves it at `/o/<org>/api/memory/export/<token>`.
- **Import:** `POST /api/memory/import {bundle | url | markdown, product?, mode?}`. `product` is the project id here (it
  renames the bundle's; an unknown id is refused). `mode` is `candidates` by default, so the daily curation
  (`memory-curate.ts`) and the PM review them. Use `active` for an admin who says so; Talk and the PM need the owner's
  quoted words for it (`jSaid`). Near-duplicates fold into what is already here (`findDuplicate`): the entry is confirmed,
  `sources` records "imported from …", and a candidate becomes active in active mode. Importing the same bundle again
  changes nothing (entries are keyed `import:<hash of from, project, kind, title>`). Imported entries keep their
  `quote`, `source` and original `created`. Their `by` is "imported from <Studio name> (<address>)", and their `note`
  says who wrote them there. `url` must be another Studio's export link; nothing else is fetched.
- **Markdown docs:** `markdown` + `name` (and optionally `kind`) imports a story doc or a repo's AGENTS.md as one entry
  per section (`sectionsOf`: headings `#` to `####`, a sub-section titled "Parent: Child", code fences kept whole). A doc
  named like AGENTS/README/CLAUDE imports as `convention`, anything else as `canon`, and never as a decision.
- **Who:** admins, and Talk or the PM acting for one (`transferRefusal`). Members, agents and scouts get 403.
- **Talk:** `memory_transfer` (export, link, import), e.g. "bring Yooba Land's canon over" with the link J pastes.
  **Dashboard:** Memory tab, Export… (download the bundle, read it as Markdown, make a one-time link) and Import… (paste
  or upload a bundle or a .md file, or give a link, then pick the project and the mode).

Moving a project from J's Studio to a customer Studio:
1. In J's Studio, open Memory, click Export…, pick the product (e.g. Yooba Land), then click One-time link (it is copied).
   Or ask Talk there: "memory_transfer link for yooba".
2. In the customer Studio, add the game as a project first, so it has an id.
3. In the customer Studio, open Memory, click Import…, paste the link, pick that project, choose "As candidates" and
   click Import. Or ask its Talk: "bring Yooba Land's memory over from <link>".
4. Review the candidates there: confirm, edit or delete them. The daily curation folds duplicates, and decisions wait
   for the owner. Or import with "Active now" to skip the review.

## API

`GET /api/memory?product&kind&status&q&item&limit`, `POST /api/memory` (write), `GET|PATCH|DELETE /api/memory/<id>`,
`POST /api/memory/<id>/merge { from }`, `GET /api/memory/search?q&product&kind`, `GET /api/memory/block?product&role&text`
(what a prompt would get), `GET /api/memory/curation`, `GET /api/memory/runs[?q]`, `GET /api/memory/runs/<ar_id>`,
`GET /api/memory/export[?file]`, `GET /api/memory/export?product&kinds&format` (bundle), `POST /api/memory/export/link`,
`GET /api/memory/export/<token>`, `POST /api/memory/import`, `POST /api/memory/publish`, `POST /api/memory/seed`, `POST /api/memory/fade`.

Who is calling (`callerOf` in `memory-api.ts`): `X-Studio-Agent` (an agent or scout), `X-Talk-Conversation` (Talk, or
the PM in its conversation), else J (the dashboard; the remote MCP). A request from the agent sandbox's Linux user is
never J's, whatever its headers say (`sandbox.ts`, docs/agents.md).
