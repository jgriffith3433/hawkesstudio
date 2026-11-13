// Phone load budget and mid-range performance (J, 2026-11-11: every phone playtest under 4x CPU + Slow 4G + DPR 2).
//
// Gen's playtest.run with mobile:true applies CDP Emulation.setCPUThrottlingRate(4), Slow-4G network conditions and
// DPR 2 (iPhone 13 profile), then reports transferred bytes before the gameplay milestone, seconds to gameplay and
// fps p5 (Gen change for the throttle + byte rollup; this file reads the result). Studio turns that into phone.*
// metrics the rubric's "phone-load" checks read (quality/game-rubric.json; qualityGate), files findings that name the
// five largest pre-gameplay assets (or the clip time of an fps dip), and shows the numbers on the playtest report.
//
//   result.phone = {
//     throttling: { cpu: 4, network: 'slow-4g', dpr: 2 },
//     mbBeforeGameplay, secondsToGameplay, fpsP5, fpsDipAt,
//     assets: [{ url, bytes, path }]  // largest first
//   }
//   metrics: phone.mbBeforeGameplay, phone.secondsToGameplay, phone.fpsP5
//
// A desktop play is left alone. Software rendering drops the fps reading (frame rate means nothing then). Limits:
// at most 20 MB before gameplay, at most 20 s to gameplay, fps p5 at least 30 (CrazyGames / Poki bar).

export const LIMITS = { mbBeforeGameplay: 20, secondsToGameplay: 20, fpsP5: 30 } as const;
/** Unity WebGL (J, 2026-11-13, q_d0be912a94e9): the engine alone is about 7 MB, so 20 s on Slow 4G can't be met; 20 MB and 60 s. */
export const UNITY_LIMITS = { mbBeforeGameplay: 20, secondsToGameplay: 60, fpsP5: 30 } as const;
export type PhoneLimits = { mbBeforeGameplay: number; secondsToGameplay: number; fpsP5: number };

/** The phone budget of a project: by engine, then the project's own `tuning` (phone.* metrics) over it. */
export function phoneLimitsFor(p?: { engine?: string; tuning?: Record<string, { max?: number; min?: number }> } | null): PhoneLimits {
  const base: PhoneLimits = { ...(p?.engine === 'unity' ? UNITY_LIMITS : LIMITS) };
  const t = p?.tuning ?? {};
  return {
    mbBeforeGameplay: t['phone.mbBeforeGameplay']?.max ?? base.mbBeforeGameplay,
    secondsToGameplay: t['phone.secondsToGameplay']?.max ?? base.secondsToGameplay,
    fpsP5: t['phone.fpsP5']?.min ?? base.fpsP5,
  };
}

export type PhoneAsset = { url: string; bytes: number; path: string };
export type PhonePerf = {
  device: 'phone';
  throttling: { cpu: number; network: string; dpr: number };
  mbBeforeGameplay: number | null;
  secondsToGameplay: number | null;
  fpsP5: number | null;
  /** Seconds into the recording where the fps sample at/near p5 occurred (for the finding's clip time). */
  fpsDipAt: number | null;
  assets: PhoneAsset[];
  /** True when Gen applied the mid-range throttle (or said it did). */
  throttled: boolean;
};

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const round1 = (n: number) => Math.round(n * 10) / 10;
const round0 = (n: number) => Math.round(n);

const pathOf = (url: string): string => {
  try {
    const u = new URL(url, 'https://play.local');
    const p = u.pathname || '/';
    return (p.length > 80 ? `…${p.slice(-77)}` : p) + (u.search ? '?…' : '');
  } catch {
    return String(url).slice(0, 80);
  }
};

const assetsOf = (raw: any): PhoneAsset[] => {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20).map((a: any) => {
    const url = String(a?.url ?? a?.name ?? '').slice(0, 500);
    const bytes = Math.max(0, round0(Number(a?.bytes) || 0));
    return { url, bytes, path: String(a?.path ?? pathOf(url)).slice(0, 120) };
  }).filter((a) => a.url || a.bytes > 0).sort((a, b) => b.bytes - a.bytes);
};

/** Seconds to the gameplay milestone from events / metrics / loadSeconds (same names first-five uses). */
export function secondsToGameplayOf(r: any): number | null {
  const m = r?.metrics ?? {};
  const fromMetric = num(m['phone.secondsToGameplay']) ?? num(m['ftue.secondsToGameplay']) ?? num(m['milestone.gameplay']);
  if (fromMetric !== null) return round1(fromMetric);
  const events: any[] = Array.isArray(r?.events) ? r.events : [];
  const hit = events.find((e) => e?.type === 'milestone' && String(e.detail ?? '').trim().toLowerCase() === 'gameplay');
  if (hit) return round1(num(hit.t) ?? 0);
  const load = num(r?.loadSeconds);
  return load !== null ? round1(load) : null;
}

/** Pure: the phone numbers of a playtest result (Gen's phone block, fps, milestones). */
export function phonePerfOf(r: any): PhonePerf | null {
  if (!r || typeof r !== 'object') return null;
  const device = String(r.device ?? '').toLowerCase();
  const p = r.phone && typeof r.phone === 'object' ? r.phone : null;
  // Only phone / mobile runs. Gen sets device: 'phone' when mobile:true; Studio may call with device forced.
  if (device && device !== 'phone' && !p) return null;
  if (!device && !p && r.fps?.p5 == null && r.metrics?.['phone.mbBeforeGameplay'] == null) return null;

  const throttling = {
    cpu: num(p?.throttling?.cpu) ?? 4,
    network: String(p?.throttling?.network ?? 'slow-4g').slice(0, 40),
    dpr: num(p?.throttling?.dpr) ?? 2,
  };
  const throttled = Boolean(p?.throttling) || Boolean(p?.throttled) || (p != null && (p.mbBeforeGameplay != null || p.assets));
  const mb = num(p?.mbBeforeGameplay) ?? num(r.metrics?.['phone.mbBeforeGameplay']);
  const fpsP5 = r.software ? null : (num(p?.fpsP5) ?? num(r.fps?.p5) ?? num(r.metrics?.['phone.fpsP5']));
  const fpsDipAt = r.software ? null : (num(p?.fpsDipAt) ?? num(r.metrics?.['phone.fpsDipAt']));
  const seconds = num(p?.secondsToGameplay) ?? secondsToGameplayOf(r);
  return {
    device: 'phone',
    throttling,
    mbBeforeGameplay: mb !== null ? round1(mb) : null,
    secondsToGameplay: seconds,
    fpsP5: fpsP5 !== null ? round0(fpsP5) : null,
    fpsDipAt: fpsDipAt !== null ? round1(fpsDipAt) : null,
    assets: assetsOf(p?.assets),
    throttled,
  };
}

/** The phone.* metrics the rubric checks read. Missing readings are left out (optional checks: unmeasured is not a fail). */
export function phoneMetrics(f: PhonePerf): Record<string, number> {
  const out: Record<string, number> = {};
  if (f.mbBeforeGameplay !== null) out['phone.mbBeforeGameplay'] = f.mbBeforeGameplay;
  if (f.secondsToGameplay !== null) out['phone.secondsToGameplay'] = f.secondsToGameplay;
  if (f.fpsP5 !== null) out['phone.fpsP5'] = f.fpsP5;
  if (f.fpsDipAt !== null) out['phone.fpsDipAt'] = f.fpsDipAt;
  if (f.throttled) out['phone.throttled'] = 1;
  return out;
}

/**
 * Merge phone numbers into a phone playtest result. Desktop (or a result with no phone signal) comes back unchanged.
 * Pure; never throws.
 */
export function enrichPhonePerf(r: Record<string, any>, device: 'desktop' | 'phone' = 'desktop'): Record<string, any> & { phone?: PhonePerf } {
  if (!r || device !== 'phone') return r;
  try {
    const base: Record<string, any> = { ...r, device: r.device ?? 'phone' };
    const f = phonePerfOf(base);
    if (!f) return { ...base, device: 'phone' };
    // Keep Gen's richer assets / throttle block; fill gaps from fps and milestones.
    const phone: PhonePerf = {
      ...f,
      assets: f.assets.length ? f.assets : assetsOf(r.phone?.assets),
    };
    return { ...base, device: 'phone', phone, metrics: { ...(base.metrics ?? {}), ...phoneMetrics(phone) } };
  } catch {
    return r;
  }
}

const mbLabel = (n: number) => `${n} MB`;
const assetLine = (a: PhoneAsset) => `${a.path || a.url} (${mbLabel(round1(a.bytes / 1e6))})`;

/** Top five pre-gameplay assets by transferred size, for a finding or the report. */
export function topAssets(f: PhonePerf | null | undefined, n = 5): PhoneAsset[] {
  return (f?.assets ?? []).slice(0, n);
}

/** Report lines for one phone play (Markdown, readable at 390 px). */
export function phonePerfLines(f: PhonePerf | null | undefined, opts: { limits?: Partial<PhoneLimits>; step?: string; name?: string } = {}): string[] {
  if (!f) return [];
  const L = { ...LIMITS, ...(opts.limits ?? {}) };
  const head = opts.name ? `**${opts.name}:** ` : '';
  const mb = f.mbBeforeGameplay === null ? 'MB before gameplay not measured' : `${f.mbBeforeGameplay} MB before gameplay${f.mbBeforeGameplay > L.mbBeforeGameplay ? ` (limit ${L.mbBeforeGameplay})` : ''}`;
  const sec = f.secondsToGameplay === null ? 'seconds to gameplay not measured' : `${f.secondsToGameplay} s to gameplay${f.secondsToGameplay > L.secondsToGameplay ? ` (limit ${L.secondsToGameplay} s)` : ''}`;
  const fps = f.fpsP5 === null ? 'fps p5 not measured' : `fps p5 ${f.fpsP5}${f.fpsP5 < L.fpsP5 ? ` (limit ${L.fpsP5})` : ''}${f.fpsDipAt != null ? ` (dip at ${f.fpsDipAt} s)` : ''}`;
  const throttle = f.throttled
    ? `under ${f.throttling.cpu}x CPU, ${f.throttling.network}, DPR ${f.throttling.dpr}`
    : 'throttle not confirmed (Gen may still be rolling out phone CDP)';
  const out = [`- ${head}${mb}; ${sec}; ${fps}; ${throttle}.`];
  const big = topAssets(f, 5);
  if (big.length && (f.mbBeforeGameplay === null || f.mbBeforeGameplay > L.mbBeforeGameplay || (f.secondsToGameplay !== null && f.secondsToGameplay > L.secondsToGameplay))) {
    out.push(`  - Largest pre-gameplay assets: ${big.map(assetLine).join('; ')}.`);
  }
  if (opts.step) out.push(`  - [playtest](#playtests/${opts.step})`);
  return out;
}

export type PhoneFinding = { title: string; severity: string; area: string; detail: string; fix: string; shots: string[]; replay: null };

const fixMb = (L: PhoneLimits) => `Cut what loads before gameplay: defer non-critical assets, compress textures and audio, code-split, and keep the first playable payload at most ${L.mbBeforeGameplay} MB (CrazyGames mobile homepage bar).`;
const fixTime = (L: PhoneLimits) => `Get to gameplay in at most ${L.secondsToGameplay} s on Slow 4G with a 4x CPU: fewer blocking requests, a smaller first paint, start play before secondary downloads finish.`;
const FIX_FPS = 'Raise the low percentiles on a mid-range phone: lower draw calls and overdraw, smaller textures, fewer per-frame allocations; watch the clip at the dip time.';

/**
 * Findings for a phone play that missed the load or fps budget. Names the five largest pre-gameplay assets on a size
 * or time miss, and the clip time on an fps p5 miss. Empty when the numbers are inside the limits or not measured.
 */
export function phonePerfFindings(r: any, { scenario, product }: { scenario: string; product?: { engine?: string; tuning?: Record<string, { max?: number; min?: number }> } | null }): PhoneFinding[] {
  const LIMITS = phoneLimitsFor(product);
  const f: PhonePerf | undefined = r?.phone ?? (r?.device === 'phone' || r?.metrics?.['phone.mbBeforeGameplay'] != null ? phonePerfOf(r) ?? undefined : undefined);
  if (!f) return [];
  const out: PhoneFinding[] = [];
  const overMb = f.mbBeforeGameplay !== null && f.mbBeforeGameplay > LIMITS.mbBeforeGameplay;
  const overTime = f.secondsToGameplay !== null && f.secondsToGameplay > LIMITS.secondsToGameplay;
  if (overMb || overTime) {
    const big = topAssets(f, 5);
    const why = [
      overMb ? `${f.mbBeforeGameplay} MB before gameplay (limit ${LIMITS.mbBeforeGameplay} MB)` : null,
      overTime ? `${f.secondsToGameplay} s to gameplay (limit ${LIMITS.secondsToGameplay} s)` : null,
    ].filter(Boolean).join('; ');
    const list = big.length
      ? ` Five largest pre-gameplay assets by transferred size: ${big.map(assetLine).join('; ')}.`
      : ' Gen did not list pre-gameplay assets on this run.';
    out.push({
      title: `Phone load budget missed: ${why}`,
      severity: 'bug', area: 'performance',
      detail: `In ${scenario} (390x844, ${f.throttling.cpu}x CPU, ${f.throttling.network}, DPR ${f.throttling.dpr}): ${why}.${list}`,
      fix: overMb ? fixMb(LIMITS) : fixTime(LIMITS), shots: [], replay: null,
    });
  }
  if (f.fpsP5 !== null && f.fpsP5 < LIMITS.fpsP5) {
    const at = f.fpsDipAt != null ? ` Dip at ${f.fpsDipAt} s in the recording.` : ' Clip time of the dip was not reported.';
    out.push({
      title: `Phone fps p5 under ${LIMITS.fpsP5}: ${f.fpsP5}`,
      severity: 'bug', area: 'performance',
      detail: `In ${scenario} (390x844, ${f.throttling.cpu}x CPU, ${f.throttling.network}): fps p5 was ${f.fpsP5} (limit ${LIMITS.fpsP5}).${at}`,
      fix: FIX_FPS, shots: [], replay: null,
    });
  }
  return out;
}

/** Extra evidence lines for qualityFindings when a phone.* metric fails. */
export function phoneEvidence(check: string, r: any): string {
  const f = r?.phone as PhonePerf | undefined;
  if (!f || !check.startsWith('phone-')) return '';
  if (check === 'phone-load-mb' || check === 'phone-load-time') {
    const big = topAssets(f, 5);
    return big.length ? ` Five largest pre-gameplay assets: ${big.map(assetLine).join('; ')}.` : '';
  }
  if (check === 'phone-fps-p5' && f.fpsDipAt != null) return ` Dip at ${f.fpsDipAt} s in the recording.`;
  return '';
}
