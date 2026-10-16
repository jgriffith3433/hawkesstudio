# Learned: Yooba Land

Generated from Hawkes Studio's shared memory (2026-10-16 19:17 UTC). Edit entries in Studio's Memory tab, not here.

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
