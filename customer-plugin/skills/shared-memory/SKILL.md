---
name: shared-memory
description: How this studio's memory works - what to search before planning, what to write when something durable is learned (decisions only with the owner's own words), and how entries are scoped and curated.
---
# The studio's memory

Every agent, scout, reviewer and Talk conversation in this Studio reads the same memory. It holds:
- **decision**: what the owner decided, with their exact words (`quote`); never written without them
- **preference**: how they like things done
- **convention**: how a codebase does things
- **lesson**: what broke and the fix
- **canon**: story facts of their games
- **wip**: work in progress

Before planning or changing something: `memory_search` with the words of the task (also "how did we fix X last time?":
past agent runs are in the results). `memory_get` shows an entry with where it came from.

When something durable is learned: `memory_write` with a short title, one or two lines of body with the specifics, and
the game it's about (`product`). Agents' entries are candidates until the PM confirms them. Don't write what the code
or the docs already say, or what only mattered to this one task.
