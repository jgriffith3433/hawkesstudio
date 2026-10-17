# Learned: Hawkes Gen

Generated from Hawkes Studio's shared memory (2026-10-17 02:41 UTC). Edit entries in Studio's Memory tab, not here.

## Lessons (what broke, and the fix)

- **playtester bootstrap runs once**: server/playtester/bootstrap.sh only runs at first boot, so anything new a running playtester needs must also be installed on demand (the encode script apt-installs ffmpeg if missing).  
  <sub>m_625f32c091cf · agent c_da182fef16cd · 2026-10-17 · c_da182fef16cd</sub>
- **testing ssh paths offline**: put a fake `ssh` script (`exec bash -c "${@: -1}"`) first on PATH in the test; spawn() picks it up, so the whole remote path is tested without a server.  
  <sub>m_71c2c03ad3a9 · agent c_da182fef16cd · 2026-10-17 · c_da182fef16cd</sub>
