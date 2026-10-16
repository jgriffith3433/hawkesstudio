# Learned: Sick Of It

Generated from Hawkes Studio's shared memory (2026-10-16 22:36 UTC). Edit entries in Studio's Memory tab, not here.

## How the code works

- **entity design notes**: content JSON has no note field and comments are lost on export, so an enemy's reason lives in Story.md's Roster row.  
  <sub>m_34c384bbd8a9 · agent c_7ae1f2fa113d · 2026-10-16 · https://github.com/jgriffith3433/sickofitgame-unity/pull/3</sub>
- **merging beta into a task branch**: agent sessions can't run `git merge` (it's denied), and J wants Studio to do the merge; finish the change on the branch as it is and say in the summary which beta fix it depends on.  
  <sub>m_a822e626f682 · agent c_7ae1f2fa113d · 2026-10-16 · https://github.com/jgriffith3433/sickofitgame-unity/pull/3</sub>

## Lessons (what broke, and the fix)

- **Enemies extending shooter inherit solid**: true and gravity 0 — a big solid body on the road walls off a Travel-camera stage (it pushes the hero off the left edge and the camera never advances). Ground enemies need a small body (about the art's size), solid: false, and a spawn y of groundY + radius.  
  <sub>m_41cbb5b0f433 · agent c_7ae1f2fa113d · 2026-10-16 · https://github.com/jgriffith3433/sickofitgame-unity/pull/3</sub>
- **JSON checks on the server**: `python3` calls need approval in agent sessions; `node -e "JSON.parse(...)"` works for checking that GameConfig files parse.  
  <sub>m_7ec82ad1cd84 · agent c_7ae1f2fa113d · 2026-10-16 · https://github.com/jgriffith3433/sickofitgame-unity/pull/3</sub>
- **LFS images in agent worktrees**: Assets/Images/*.png are Git LFS pointers on the server, so an art spec's `reference` can't be read and the image can't be viewed; check with `head -c 100` before relying on one.  
  <sub>m_14fcf957bdb7 · agent c_7ae1f2fa113d · 2026-10-16 · https://github.com/jgriffith3433/sickofitgame-unity/pull/3</sub>
- **Projectile hitboxes must match the drawn size**: body.radius is in world units no matter what visual.scale is; a 0.1-scale flame wants a radius of about 0.2.  
  <sub>m_a535817b4113 · agent c_7ae1f2fa113d · 2026-10-16 · https://github.com/jgriffith3433/sickofitgame-unity/pull/3</sub>
- **art.mjs on the Linux server**: DoD's .venv isn't there, art.mjs falls back to system python3 (no PIL) and stops at the first sheets.py call; it also makes a relative "C:\Projects\SickOfItGameEnemies" folder in the repo (delete it). Run the art step on J's PC.  
  <sub>m_08072b58c516 · agent c_7ae1f2fa113d · 2026-10-16 · https://github.com/jgriffith3433/sickofitgame-unity/pull/3</sub>
