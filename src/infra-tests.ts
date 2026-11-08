// The test check of a Hawkes Gen (or Studio) change, in Studio, not on GitHub Actions (J, 2026-11-08, q_4d2d7ca6facf:
// "run the same test suite as a Studio check on every Gen change before it merges"). Pure helpers: the failing tests
// out of node's test output, and the comparison with beta's own result, so a test already red on a clean checkout is
// shown (as "known") but never blocks, and only a test that fails here and not there does.

/** Names of the tests that failed in `node --test` output (TAP or the default spec reporter; subtests and their parents, flat). */
export function failingTests(out: string): string[] {
  const names = new Set<string>();
  // TAP prints a subtest's own line after its children: leaf and parent names are both kept, flat.
  for (const line of out.split('\n')) {
    // TAP ("not ok 2 - name") or node's default spec reporter ("✖ name (1.2ms)"; its "failing tests:" recap repeats them).
    const m = /^\s*not ok \d+ - (.*?)(?: # (?:SKIP|TODO).*)?$/.exec(line) ?? /^\s*✖ (.*?) \([\d.]+m?s\)(?: # .*)?$/.exec(line);
    if (m && !/^# /.test(m[1])) names.add(m[1].trim());
  }
  return [...names];
}

export type TestComparison = { failed: string[]; known: string[]; fresh: string[]; fixed: string[] };

/** failed: red here; base: red on beta's own checkout. fresh = new failures (these block), known = red in both. */
export function compareFailures(failed: string[], base: string[]): TestComparison {
  const b = new Set(base);
  const f = new Set(failed);
  return { failed, known: failed.filter((x) => b.has(x)), fresh: failed.filter((x) => !b.has(x)), fixed: base.filter((x) => !f.has(x)) };
}

/** One plain line for the change's summary: what failed, what was already red on beta, and the time. */
export function describeTests(cmp: TestComparison, seconds: number, ok: boolean): string {
  const list = (a: string[]) => a.slice(0, 8).map((x) => `"${x}"`).join(', ') + (a.length > 8 ? ` and ${a.length - 8} more` : '');
  const parts: string[] = [];
  if (cmp.fresh.length) parts.push(`${cmp.fresh.length} new failing test${cmp.fresh.length === 1 ? '' : 's'}: ${list(cmp.fresh)}`);
  if (cmp.known.length) parts.push(`${cmp.known.length} already failing on beta (not blocking): ${list(cmp.known)}`);
  return `tests ${ok ? 'passed' : 'FAILED'} in ${seconds} s${parts.length ? ` (${parts.join('; ')})` : ''}`;
}
