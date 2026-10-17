# Learned: Yooba Land

Generated from Hawkes Studio's shared memory (2026-10-17 02:19 UTC). Edit entries in Studio's Memory tab, not here.

## J's decisions

- **Yooba's eat animation is made by an agent from his existing clips, not generated**: Nothing in Gen or the ComfyUI templates makes 3D rig animation. The agent builds a new Generic .anim on Yooba's Bone001-018 rig, using the Idle/Walk/Jump clips (and SOI's YoobaTest_Fire) as reference.  
  <sub>m_2ffe130faacd · Talk · 2026-10-16 · item i_14ad6f81d93e · t_fdd9abded079</sub>

## How the code works

- **Level 1's overlay canvases have no CanvasScaler in the scene; `LevelUI.Awake` adds one at runtime. The camera widens FOV on portrait in `YoobaThirdPersonCamera`.**  
  <sub>m_b26b4a2f8447 · agent c_8ffdfde12b5f · 2026-10-17 · https://github.com/jgriffith3433/YoobaLand/pull/5</sub>
- **The PlayMode test assembly (YoobaLand.PlaytestTests) can't reference Assembly-CSharp; reach game types by reflection (Type.GetType("Name, Assembly-CSharp")).**  
  <sub>m_fb108bcdf1e8 · agent c_e1e677784537 · 2026-10-16 · item i_14ad6f81d93e · https://github.com/jgriffith3433/YoobaLand/pull/4</sub>
- **Yooba food counts by exact GameObject name**: YoobaMainLevel.EatFood only counts objects named exactly `Apple`, `Watermelon`, `Pumpkin`; copies must be renamed (Instantiate adds "(Clone)").  
  <sub>m_38d262cf5389 · agent c_7981a49314de · 2026-10-16 · https://github.com/jgriffith3433/YoobaLand/pull/3</sub>
- **Yooba's rig**: Generic, no blend shapes, no jaw bone, mouth modelled open. Bone001 is root + lower jaw (legs Bone015-018 hang off it), Bone002 the hinge, Bone003 the upper jaw, Bone004-009 eye stalks/eyes, Bone014 the uvula. In the FBX he faces +X, Y up, left-right is Z; tipping Bone002/003 back opens the mouth.  
  <sub>m_5ee4d436fc5e · agent c_e1e677784537 · 2026-10-16 · item i_14ad6f81d93e · https://github.com/jgriffith3433/YoobaLand/pull/4</sub>

## Lessons (what broke, and the fix)

- **Check the scene's prefab overrides, not just the prefab**: the empty Animator is an m_AddedComponents entry on the YoobaCharacter instance in Level 1.unity, invisible in YoobaCharacter.prefab.  
  <sub>m_e86e10e5ed82 · agent c_e1e677784537 · 2026-10-16 · item i_14ad6f81d93e · https://github.com/jgriffith3433/YoobaLand/pull/4</sub>
- **No Unity or Python on the Linux control server**: binary FBX files can still be read with a small Node reader (Tools/yooba-eat/fbx.js: curves, hierarchy, skin clusters), and Generic clips can be written as YAML .anim; Unity rotation = FBX (Pre * Lcl) with X mirrored, q -> (x, -y, -z, w). YoobaEatClipTest checks that on the real rig.  
  <sub>m_7825086877ed · agent c_e1e677784537 · 2026-10-16 · item i_14ad6f81d93e · https://github.com/jgriffith3433/YoobaLand/pull/4</sub>
- **The playtest bot's virtual keyboard must send one Push per frame**: a press and release queued in the same frame never shows as wasPressedThisFrame.  
  <sub>m_872e8e4b79b4 · agent c_e1e677784537 · 2026-10-16 · item i_14ad6f81d93e · https://github.com/jgriffith3433/YoobaLand/pull/4</sub>
- **This Linux worktree can't run Python or Unity**: script runs need approval and Unity isn't installed; read scene YAML with Grep, and say plainly that a fix is unverified.  
  <sub>m_510613938196 · agent c_7981a49314de · 2026-10-16 · https://github.com/jgriffith3433/YoobaLand/pull/3</sub>
- **Website not in this repo**: "What's new" page requests need the website repo (yoobalandgame.com); this repo is Unity only.  
  <sub>m_ef7c9e340d74 · agent c_8ffdfde12b5f · 2026-10-17 · https://github.com/jgriffith3433/YoobaLand/pull/5</sub>
- **Yooba Land Level 1 has no NavMesh**: `m_NavMeshData: 0`, so NavMesh.SamplePosition can't find walkable ground; YoobaFoodGuard flood-fills it with physics raycasts from Yooba's spawn instead.  
  <sub>m_6e428ab3839c · agent c_7981a49314de · 2026-10-16 · https://github.com/jgriffith3433/YoobaLand/pull/3</sub>
- **Yooba interact reach scales with size**: YoobaInteractor reaches 1.75 × size to the collider surface; the playtest bot must stop well inside that (now 1.1 × size) or a big Yooba presses E from 17 m away.  
  <sub>m_8f22a1d10238 · agent c_7981a49314de · 2026-10-16 · https://github.com/jgriffith3433/YoobaLand/pull/3</sub>
- **Yooba's Animator lookup**: Level 1 adds an empty Animator (no controller) to the YoobaCharacter root, so GetComponentInChildren<Animator> returns it and every trigger is lost (Eat never played, Jump never animated). Use YoobaAnimators.Find (first child Animator with a controller).  
  <sub>m_3e59f12a1a33 · agent c_e1e677784537 · 2026-10-16 · item i_14ad6f81d93e · https://github.com/jgriffith3433/YoobaLand/pull/4</sub>
- **sickofitgame-unity/Assets/Models/YoobaTest_Fire.FBX is only a Git LFS pointer on the control server; the real file is on J's PC / the build server.**  
  <sub>m_bb164abe9c55 · agent c_e1e677784537 · 2026-10-16 · item i_14ad6f81d93e · https://github.com/jgriffith3433/YoobaLand/pull/4</sub>
