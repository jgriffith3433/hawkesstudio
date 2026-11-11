// The playtest viewer's markers (used by playtests.js): where each finding and each scenario event sits on the video's
// timeline. Pure functions, no DOM, so test/ptmarkers.test.ts can run them. Times are seconds from the start of the run,
// the same clock the report's shots, events and timeline use (and the video's currentTime).

const PT_FAIL = /fail|lost|lose|death|died|dead|stuck|softlock|error|crash|timeout|timed out|abort/i;
const PT_PASS = /pass|won|win\b|victory|complete|cleared|finish|success|reached|goal/i;

const ptFinite = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** Where a finding happened: its own time if it has one, else the time of its first screenshot (assets matched to the run's shots). */
function ptFindingTime(f, shots) {
  for (const k of ['t', 'time', 'at', 'seconds']) if (ptFinite(f?.[k])) return f[k];
  const times = (f?.shots ?? []).map((a) => (shots ?? []).find((s) => s.asset === a)?.t).filter(ptFinite);
  if (times.length) return Math.min(...times);
  const ev = f?.evidence;
  if (Array.isArray(ev)) {
    const t = ev.map((i) => shots?.[i]?.t).filter(ptFinite);
    if (t.length) return Math.min(...t);
  }
  return null;
}

/** pass / fail / null for a scenario event (start, scene changes and the like are not marked). */
function ptEventTone(e) {
  const type = String(e?.type ?? '');
  const text = `${type} ${e?.detail ?? ''}`;
  if (/^(start|begin|scene|log|note|info)$/i.test(type)) return null;
  if (PT_FAIL.test(type)) return 'fail';
  if (PT_PASS.test(type)) return 'pass';
  if (/^(end|done|level|check)/i.test(type)) return PT_FAIL.test(text) ? 'fail' : PT_PASS.test(text) ? 'pass' : null;
  return null;
}

/**
 * Markers for the scrubber, sorted by time. Findings are review findings (a time, else their screenshot's time); events
 * are the run's events that read as a pass or a fail. A finding with no time at all is returned in `untimed` (still listed).
 */
function ptMarkers({ findings = [], events = [], shots = [] } = {}) {
  const markers = [];
  const untimed = [];
  findings.forEach((f, i) => {
    const t = ptFindingTime(f, shots);
    const m = { kind: 'finding', key: `f${i}`, index: i, t, sev: f.severity ?? 'bug', label: f.title ?? 'Finding' };
    if (t == null) untimed.push(m);
    else markers.push(m);
  });
  events.forEach((e, i) => {
    const tone = ptEventTone(e);
    if (tone && ptFinite(e.t)) markers.push({ kind: 'event', key: `e${i}`, index: i, t: e.t, tone, label: `${e.type}${e.detail ? `: ${e.detail}` : ''}` });
  });
  markers.sort((a, b) => a.t - b.t);
  return { markers, untimed };
}

/** The screenshot showing at time t: the latest one at or before it (the first one before any have happened). */
function ptShotIndexAt(shots, t) {
  let at = -1;
  (shots ?? []).forEach((s, i) => { if (ptFinite(s.t) && s.t <= t + 0.25 && (at < 0 || s.t >= shots[at].t)) at = i; });
  return at < 0 && shots?.length ? 0 : at;
}

/** The marker at time t that a tap near it means (nearest within the given reach in seconds), for the track's own taps. */
function ptNearest(markers, t, reach) {
  let best = null;
  for (const m of markers) if (Math.abs(m.t - t) <= reach && (!best || Math.abs(m.t - t) < Math.abs(best.t - t))) best = m;
  return best;
}

if (typeof globalThis !== 'undefined') Object.assign(globalThis, { ptFindingTime, ptEventTone, ptMarkers, ptShotIndexAt, ptNearest });
