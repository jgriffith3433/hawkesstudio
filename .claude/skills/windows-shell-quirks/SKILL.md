---
name: windows-shell-quirks
description: Traps when editing files and running commands across J's Windows PC, the Linux control server and the Windows build server - CRLF working trees, heredoc and Python escaping, path styles, git safe.directory, PowerShell vs bash. Load before scripted edits or shell commands that write files.
---
# Shell and Windows quirks

## Line endings

- On J's PC many working-tree files are **CRLF** (`* text=auto`; Git normalizes to LF on commit). An exact-match edit
  of multi-line text written with `\n` fails silently or matches nothing. Normalize (`s.replace(/\r\n/g, '\n')`),
  edit, and write back with the file's own endings; or use the editor tools, which handle it.
- The Windows build server's Git checks repos out with CRLF unless `core.autocrlf=false`: website repos must be LF
  there (Gen sets it), Unity projects stay CRLF.
- `.sh` files and `bin/git-credential-hawkes` are LF always (`.gitattributes`); `.bat`, `.cmd`, `.ps1` are CRLF.

## Escaping

- **Heredocs:** `cat <<'EOF'` (quoted) passes text literally; unquoted expands `$vars` and backticks. Inside Git Bash on
  Windows even quoted heredocs have mangled `\\` sequences in practice. Python or JS inside a heredoc doubles the
  trouble: `\n` in a Python string becomes a real newline in the file you write; `\'` disappears.
- Safer: write the script to a file with the editor (no shell in between), then run it with arguments. For JSON
  payloads, write a `.json` file and read it.
- PowerShell 5.1: no `&&`; single-quoted here-strings `@' ... '@` with the closing `'@` at column 0.

## Paths

- J's PC: `C:\Projects\...` (Git Bash: `/c/Projects/...`); the control server: `/srv/hawkes/...` (same layout); the
  build server mirrors `C:\Projects`. Code that runs in more than one place uses `path.join` and config
  (`PROJECTS`, `STUDIO_PROJECTS`), never a hard-coded drive.
- Forward slashes work in Node on Windows; `path.relative` output needs `.replace(/\\/g, '/')` before it goes into a
  URL, a git pathspec or a prompt.

## Git on the server

- The repos in `/srv/hawkes` belong to the `hawkes` user. Git as anyone else fails with "dubious ownership": run it as
  that user (`sudo -u hawkes git ...`), never `safe.directory = *`.
- Only refs move in the server's own checkouts of Studio and Gen (their files change through `hawkes-pull.mjs`);
  agents work in worktrees under `/srv/hawkes/.work`.
- Never `git stash` in a shared checkout (other sessions use the same stash); commit a WIP instead.
