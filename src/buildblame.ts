// Which merged change broke beta's build (pm.ts followBuilds): the errors in the build's Unity log and the files they
// name, matched against what each merged change touched. 2026-10-18: one failed Sick Of It build sent three agents
// after the same one-line GameConfig error, all to whichever change merged last, though the error was in another's file.
//
// What the log says (Sick Of It, the GameConfig importer's report and Unity's compiler):
//   Game config import FAILED: 1 error(s), 0 warning(s). Full report: Logs/GameConfig.log
//   ERROR   levels/Level2.json:14 @script[3].line - Unknown speaker "Bob".
//   Assets/Scripts/Shop.cs(12,5): error CS1002: ; expected

/** The error lines of a build log (at most `max`, each once) and the files they name, as the log wrote them. */
export function buildErrors(log: string, max = 20): { lines: string[]; files: string[] } {
  const lines: string[] = [];
  const files: string[] = [];
  const add = (line: string, file?: string | null) => {
    if (!lines.includes(line) && lines.length < max) lines.push(line);
    if (file && !files.includes(file)) files.push(file);
  };
  let config = false;
  for (const raw of log.split(/\r?\n/)) {
    const l = raw.trim();
    if (/Game config \w+ FAILED/.test(l)) {
      config = true;
      add(l);
      continue;
    }
    const cs = /^(.+?)\(\d+,\d+\):\s*error CS\d+/.exec(l);
    if (cs || /\berror CS\d+/.test(l)) {
      add(l, cs?.[1]);
      continue;
    }
    // The report's issues follow its summary line: "ERROR   <file>[:line] [@json.path] - message".
    if (config) {
      const m = /^ERROR\s+(.*)$/.exec(l);
      if (m) {
        const first = m[1].split(/\s+/)[0] ?? '';
        add(l, first && !first.startsWith('@') && first !== '-' ? first.replace(/:\d+$/, '') : null);
      } else if (!/^WARNING\s/.test(l)) config = false;
    }
  }
  return { lines, files };
}

const norm = (f: string) => f.replace(/\\/g, '/').replace(/^\.?\//, '');

/**
 * The files a change touched (`changed`, repo paths) that the log names. The log's paths may be shorter (GameConfig's
 * are relative to Assets/GameConfig, Unity's to the project): either ends with the other.
 */
export function touches(changed: string[], named: string[]) {
  const ns = named.map(norm).filter(Boolean);
  return changed.map(norm).filter((c) => ns.some((n) => c === n || c.endsWith(`/${n}`) || n.endsWith(`/${c}`)));
}

/**
 * The change to send back: the latest merged one whose diff touched a file the errors name, else the latest merged
 * one (as before). `matched`: the files that tied it to the errors (empty when it fell back to the latest).
 */
export function pickCulprit<T extends { at: number; files: string[] }>(candidates: T[], named: string[]): { culprit: T; matched: string[] } {
  const latest = (list: T[]) => list.reduce((a, b) => (a.at >= b.at ? a : b));
  const hits = named.length ? candidates.filter((c) => touches(c.files, named).length) : [];
  const culprit = latest(hits.length ? hits : candidates);
  return { culprit, matched: hits.length ? touches(culprit.files, named) : [] };
}
