# Learned: PH Origins

Generated from Hawkes Studio's shared memory (2026-10-16 22:00 UTC). Edit entries in Studio's Memory tab, not here.

## How the code works

- **Mobile HUD layout lives in game.html CSS**: the inventory panel is anchored by `bottom` per device (`data-device`), so its max-height has to be set in the same three places (base, mobile/tablet, short landscape).  
  <sub>m_c12968d11efb · agent c_82c75559d4ce · 2026-10-16 · https://github.com/jgriffith3433/phoriginswebsite/pull/2</sub>

## Lessons (what broke, and the fix)

- **Playtest steps that open a panel must hold it**: the smoke bot closed Inventory after 0.5 s, so no frame showed it and the criterion read 'unclear'; hold UI under test open for a couple of seconds and log an event.  
  <sub>m_180565fe0bee · agent c_82c75559d4ce · 2026-10-16 · https://github.com/jgriffith3433/phoriginswebsite/pull/2</sub>
