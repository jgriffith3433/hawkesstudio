---
name: shared-memory
description: How to read and write Hawkes Studio's shared memory (J's decisions and preferences, conventions, lessons, canon, work in progress, past agent runs) from Talk, an agent, a scout or a Claude session on J's laptop. Use before planning, when you learn something durable, or when J decides something.
---
# The shared memory

One memory for every Claude on Hawkes, in Studio on the cloud server (`hawkesstudio/docs/memory.md`). Tools:
`memory_search`, `memory_get`, `memory_write`, `memory_curate` (Studio MCP: in Talk and agents; on any machine over
`https://studio.hawkesgen.com/mcp`).

## Read

- Before planning or changing something: `memory_search { query: "<the words of the problem>", product }`. It returns
  entries and past agent runs ("how did we fix X last time?").
- Briefs and Talk turns already include the few most relevant entries: don't repeat the search for those.
- `memory_get { id }` shows provenance (who, when, which run or conversation, where else it was seen).

## Write

| Kind | When | Rule |
|---|---|---|
| decision | J decided | Only J's own words: `quote` must be in his message (Talk). Agents can't write decisions |
| preference | how J likes things | |
| convention | how a codebase really works | not what its AGENTS.md already says |
| lesson | what broke and the fix | the trap and the way past it, specific |
| canon | story and IP facts | `source`: the doc it comes from |
| state | work in progress | fades after a week without an update |

- One line of title, then specifics (files, commands, numbers, why). Scope it: `product`, or `item` for a roadmap item.
- Agents: your writes are candidates the PM reviews. At the end of a task, `.hawkes/learned.md` does the same
  (`- lesson: <title> — <what>`).
- A near-duplicate isn't added twice: the existing entry is confirmed instead. To replace an entry, write the new one
  with `supersedes` (the old one fades).

## Don't

- Don't store secrets, tokens, passwords or personal data.
- Don't record guesses as conventions, or Claude's ideas as J's decisions.
- Don't fight a decision or canon silently: say what contradicts it and ask J.
