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

Tools (Studio MCP, also over https://studio.hawkesgen.com/mcp): `memory_search` (entries and past agent runs),
`memory_get`, `memory_write`, `memory_curate` (list, confirm, edit, merge, fade, dispute, delete, publish). Agents and
scouts get their own Studio MCP server with only search, get and write (`STUDIO_MCP_TOOLS`), which writes as them
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
canon check of their diff after the verification playtest (`canon.ts`: Sonnet through Gen's `llm.json`, about a cent).
A contradiction is in the change's verification (`verify.canon`) and fails the PM's merge gate (`acceptance.ts`): J
or the PM decides. Reviews judge the footage against the canon too.

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

## API

`GET /api/memory?product&kind&status&q&item&limit`, `POST /api/memory` (write), `GET|PATCH|DELETE /api/memory/<id>`,
`POST /api/memory/<id>/merge { from }`, `GET /api/memory/search?q&product&kind`, `GET /api/memory/block?product&role&text`
(what a prompt would get), `GET /api/memory/curation`, `GET /api/memory/runs[?q]`, `GET /api/memory/runs/<ar_id>`,
`GET /api/memory/export[?file]`, `POST /api/memory/publish`, `POST /api/memory/seed`, `POST /api/memory/fade`.

Who is calling (`callerOf` in `memory-api.ts`): `X-Studio-Agent` (an agent or scout), `X-Talk-Conversation` (Talk, or
the PM in its conversation), else J (the dashboard; the remote MCP). A request from the agent sandbox's Linux user is
never J's, whatever its headers say (`sandbox.ts`, docs/agents.md).
