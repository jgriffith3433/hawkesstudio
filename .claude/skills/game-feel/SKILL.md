---
name: game-feel
description: Game-feel defaults for any game with movement or combat: coyote time and jump buffer of at least 80 ms, hit-stop of at least 40 ms, a short screen shake, immediate input response. Use for any player movement, jump, attack, hit, camera or controls task.
---
# Game feel defaults

Controls should forgive the player and hits should land. Studio's rubric floors (camera-and-controls):

| Default | Floor | Notes |
|---|---|---|
| Coyote time | at least 80 ms (100 is a good start) | the player can still jump this long after leaving a ledge |
| Jump buffer | at least 80 ms (100) | a jump pressed this long before landing fires on landing |
| Hit-stop | at least 40 ms on heavy hits (60 to 100 is typical) | freeze both attacker and target on impact; light hits may use less |
| Screen shake | short: 80 to 150 ms, decaying, a small amplitude | on heavy hits and landings; respect a reduced-motion setting; never a long rumble |
| Input latency | under 100 ms input to visible movement | sensor metric `feel.inputLatencyMs` |

Put the values in `docs/metrics.json` under `feel` (level-design skill) and read them from there (or the same data), so
they are tuned in one place. The playtest reports them as `feel.coyoteMs`, `feel.jumpBufferMs` and `feel.hitStopMs`
(hawkes-playtest.js `t.metric`, docs/playtest.md#feel); under the floor fails the check.

Also: variable jump height (release to cut the jump), a short acceleration and deceleration, landings and hits with a
sound and a small visual reaction in the same frame, attack wind-ups the player can read, and every action answered by
sound and motion. Don't implement hit-stop by pausing the whole game clock, so UI and audio carry on.
