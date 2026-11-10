// Studio never fails a Gen job over a param Gen doesn't know (2026-11-10: every playtest for hours failed in seconds with
// "Bad params for playtest.run: playtest.run has no param "skipProviders"", because Studio sent a hint Gen never took).
// Gen's refusal lists what the tool takes; Studio learns that list, drops what Gen doesn't take, says so once, and
// submits again. Later submits of that tool drop unknown params before sending. A param Gen does take is never dropped,
// and any other refusal (a bad value, a missing param) is thrown as before.

type Submit = (tool: string, body: { project: string; params: Record<string, unknown>; priority?: number }) => Promise<any>;

/** What each Gen tool takes, learned from its own refusals (process lifetime; a Gen upgrade that adds a param resets on restart). */
const accepted = new Map<string, Set<string>>();
const warned = new Set<string>();

/** The unknown params and the accepted list in a Gen "Bad params" refusal, or null if it isn't one. */
export function parseUnknownParams(message: unknown): { tool: string; unknown: string[]; takes: string[] } | null {
  const m = String(message ?? '');
  const head = /Bad params for ([\w.-]+):/.exec(m);
  if (!head) return null;
  const unknown = [...m.matchAll(/has no param "([^"]+)"/g)].map((x) => x[1]);
  if (!unknown.length) return null;
  const takes = /\(it takes: ([^)]*)\)/.exec(m)?.[1].split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  return { tool: head[1], unknown, takes };
}

/** The params minus any Gen is known not to take for this tool, and which were dropped. */
export function knownParams(tool: string, params: Record<string, unknown>): { params: Record<string, unknown>; dropped: string[] } {
  const ok = accepted.get(tool);
  if (!ok) return { params, dropped: [] };
  const dropped = Object.keys(params).filter((k) => !ok.has(k));
  if (!dropped.length) return { params, dropped };
  return { params: Object.fromEntries(Object.entries(params).filter(([k]) => ok.has(k))), dropped };
}

const tell = (tool: string, dropped: string[]) => {
  const fresh = dropped.filter((k) => !warned.has(`${tool}:${k}`));
  if (!fresh.length) return;
  fresh.forEach((k) => warned.add(`${tool}:${k}`));
  console.warn(`[gen-params] ${tool} doesn't take ${fresh.map((k) => `"${k}"`).join(', ')}; Studio leaves ${fresh.length > 1 ? 'them' : 'it'} out`);
};

/**
 * Submits a Gen job, leaving out params Gen has said it doesn't take. If Gen refuses one it hadn't refused before, the
 * job is submitted again once without it. Returns Gen's job with `droppedParams` when anything was left out.
 */
export async function submitKnown(submit: Submit, tool: string, body: { project: string; params: Record<string, unknown>; priority?: number }) {
  const { params, dropped } = knownParams(tool, body.params ?? {});
  if (dropped.length) tell(tool, dropped);
  try {
    const job = await submit(tool, { ...body, params });
    return dropped.length && job && typeof job === 'object' ? { ...job, droppedParams: dropped } : job;
  } catch (e: any) {
    const bad = parseUnknownParams(e?.message);
    if (!bad || bad.tool !== tool) throw e;
    if (bad.takes.length) accepted.set(tool, new Set(bad.takes));
    const again = bad.takes.length ? knownParams(tool, params) : { params: Object.fromEntries(Object.entries(params).filter(([k]) => !bad.unknown.includes(k))), dropped: bad.unknown };
    // Nothing left to drop (Gen named a param Studio didn't send): not this kind of problem.
    if (!again.dropped.length) throw e;
    tell(tool, again.dropped);
    const job = await submit(tool, { ...body, params: again.params });
    const all = [...new Set([...dropped, ...again.dropped])];
    return job && typeof job === 'object' ? { ...job, droppedParams: all } : job;
  }
}

/** Forget what was learned (tests). */
export const resetKnownParams = () => { accepted.clear(); warned.clear(); };
