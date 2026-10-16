# Learned: Yooba Land

Generated from Hawkes Studio's shared memory (2026-10-16 20:58 UTC). Edit entries in Studio's Memory tab, not here.

## How the code works

- **Yooba food counts by exact GameObject name**: YoobaMainLevel.EatFood only counts objects named exactly `Apple`, `Watermelon`, `Pumpkin`; copies must be renamed (Instantiate adds "(Clone)").  
  <sub>m_38d262cf5389 · agent c_7981a49314de · 2026-10-16 · https://github.com/jgriffith3433/YoobaLand/pull/3</sub>

## Lessons (what broke, and the fix)

- **This Linux worktree can't run Python or Unity**: script runs need approval and Unity isn't installed; read scene YAML with Grep, and say plainly that a fix is unverified.  
  <sub>m_510613938196 · agent c_7981a49314de · 2026-10-16 · https://github.com/jgriffith3433/YoobaLand/pull/3</sub>
- **Yooba Land Level 1 has no NavMesh**: `m_NavMeshData: 0`, so NavMesh.SamplePosition can't find walkable ground; YoobaFoodGuard flood-fills it with physics raycasts from Yooba's spawn instead.  
  <sub>m_6e428ab3839c · agent c_7981a49314de · 2026-10-16 · https://github.com/jgriffith3433/YoobaLand/pull/3</sub>
- **Yooba interact reach scales with size**: YoobaInteractor reaches 1.75 × size to the collider surface; the playtest bot must stop well inside that (now 1.1 × size) or a big Yooba presses E from 17 m away.  
  <sub>m_8f22a1d10238 · agent c_7981a49314de · 2026-10-16 · https://github.com/jgriffith3433/YoobaLand/pull/3</sub>

## In progress

- **Yooba Land food reachability is parked (J's Inbox answer): don't auto-fix f_d6d8bc398834**: J answered q_b92a558f2c83 'Park it: close the change, keep the finding open' (2026-10-16) after c_7981a49314de failed 3 tries (food still unreachable at ~8.5 m, size stuck at 8, boss gate never opened). The finding stays open as a record but isn't to be retried by agents until J restarts it. Branch with the FoodGuard attempt: fix/7981a49314de-food-repeatedly-can-t-be-reached-level-1 (PR #3, closed). Note: PR #2's first try (interact-focus change, 0703695) is on beta.  
  <sub>m_391bb6c748c4 · Talk (PM) · 2026-10-16 · q_b92a558f2c83 (J's Inbox answer, 2026-10-16)</sub>
