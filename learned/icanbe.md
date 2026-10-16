# Learned: I Can Be

Generated from Hawkes Studio's shared memory (2026-10-16 21:28 UTC). Edit entries in Studio's Memory tab, not here.

## J's decisions

- **I Can Be bugs and tasks get dismissed, not fixed**: On 2026-10-16 J had every I Can Be finding marked won't-fix (f_a61570b31ea1, f_de71f1a8771e). The roadmap had no I Can Be items. Don't start fixes or tasks for I Can Be, and mark new findings won't-fix, until J gives it a direction.  
  <sub>m_7614cb204c05 · Talk · 2026-10-16 · t_01639fac177e</sub>

## How the code works

- **I Can Be playtest scenarios**: each is an async fn(options, t) in js/playtest.js, listed in installPlaytest scenarios[] and dispatched by id in start(); helpers world/scrubTo/clickSpeed/pressKey/checkBasics are at the top of the file.  
  <sub>m_44e93a0697d3 · agent c_34900a2a4607 · 2026-10-16 · https://github.com/jgriffith3433/icanbeaiwebsite/pull/2</sub>
- **I Can Be's public site stays scene-only: no HUD on beta or live (J's Inbox answer)**: index.html adds a `public` class on non-local hosts and css/site.css hides .hud, .side and .errors for it, on purpose. J answered q_8daa3fd15e49 'Keep it as is and mark the finding won't-fix' (2026-10-16). Reviews reporting a missing narration, day bar, stats or Things panel on beta or live are by design (f_a3875bc6630a won't-fix). The HUD shows locally. Don't change this without J.  
  <sub>m_577f05d1f592 · Talk (PM) · 2026-10-16 · q_8daa3fd15e49 (J's Inbox answer, 2026-10-16)</sub>

## Lessons (what broke, and the fix)

- **Multi-commit changes can land partly**: c_27c0945b76a6 reached beta with only its first commit, so the playtest asked for a scenario beta didn't have; check that every scenario a change names is registered in js/playtest.js installPlaytest({scenarios}) and in start().  
  <sub>m_0069fff796e0 · agent c_34900a2a4607 · 2026-10-16 · https://github.com/jgriffith3433/icanbeaiwebsite/pull/2</sub>
- **car cabin hid the driver**: makeCar's cabin is a solid box the person sits inside; hiding only the roof still showed a dark lump. Cabin and roof are both disabled while pp.inCar.  
  <sub>m_795075f485fa · agent c_1fff7ea72482 · 2026-10-16 · https://github.com/jgriffith3433/icanbeaiwebsite/pull/3</sub>
- **drive camera must be locked to the car**: a damped follow trails a fast car by speed/follow units and shows empty road; world.js sets the camera target to the car exactly while pp.inCar (soft follow only when walking). The playtest `day` logs car-on-screen.  
  <sub>m_1b58d02fd990 · agent c_1fff7ea72482 · 2026-10-16 · https://github.com/jgriffith3433/icanbeaiwebsite/pull/3</sub>
