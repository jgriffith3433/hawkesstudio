// The phone UI layer, Studio's side (docs/playtest.md#ui; the rubric's "menus-and-ui" rule). The page probe
// (clients/web/hawkes-ui.js, or a Unity UiRects reporter) pushes `ui-layout` events (every control's rect, with the
// problems the probe found at this viewport and orientation) and `ui-press` events (a press, and whether the screen
// changed within 100 ms). Studio turns the timeline into ui.* metrics, checks each press against the audio probe's
// sound starts (a press with no sound start within 150 ms is silent) and files one finding per broken control, named,
// with its place and (when the probe outlined it) the screenshot.

import { audioEventsOf } from './audio.ts';

export type UiIssue = { kind: 'small' | 'spacing' | 'reach' | 'inset' | 'offscreen'; id: string; label: string; rect: [number, number, number, number]; detail: string };
export type UiLayout = {
  t: number; orientation: 'portrait' | 'landscape'; viewport: [number, number]; scene?: string; controls: number;
  insets?: { top: number; right: number; bottom: number; left: number }; issues: UiIssue[]; shot?: string; outlined?: boolean; source?: string;
};
export type UiPress = { t: number; id: string; label: string; orientation?: string; scene?: string; visual: boolean; visualMs: number | null; rect?: number[]; sound?: boolean };

export type UiTransition = { t: number; from?: string | null; to?: string; ms: number; plannedMs: number; reduced: boolean };

/** A screen slide runs this long (ms); with reduced motion on it runs 0 (a small timer slack is allowed on the upper bound). */
export const TRANSITION_MIN_MS = 150;
export const TRANSITION_MAX_MS = 200;
/** Two ui-press entries for the same control this close together are one press logged twice. */
export const DUPLICATE_PRESS_S = 0.03;

/** A press with no visual change within this long is dead; one with no sound start within SOUND_MS is silent. */
export const VISUAL_MS = 100;
export const SOUND_MS = 150;

const r2 = (n: number) => Math.round(n * 100) / 100;
const parse = (e: any) => {
  if (e?.detail == null) return null;
  try { const d = typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail; return d && typeof d === 'object' ? d : null; } catch { return null; }
};

/** The layouts and presses the page (or the Unity reporter) put on the run's event timeline. */
export function uiEventsOf(result: any): { layouts: UiLayout[]; presses: UiPress[] } {
  const layouts: UiLayout[] = [];
  const presses: UiPress[] = [];
  for (const e of Array.isArray(result?.events) ? result.events : []) {
    if (e?.type === 'ui-layout') {
      const d = parse(e);
      if (!d || !Array.isArray(d.issues)) continue;
      const o = d.orientation === 'landscape' ? 'landscape' : 'portrait';
      layouts.push({
        t: Number(e.t) || 0, orientation: o, viewport: Array.isArray(d.viewport) ? [Number(d.viewport[0]) || 0, Number(d.viewport[1]) || 0] : [0, 0],
        scene: d.scene != null ? String(d.scene).slice(0, 80) : undefined, controls: Number(d.controls) || 0, insets: d.insets, shot: d.shot ? String(d.shot) : undefined,
        outlined: Boolean(d.outlined), source: d.source ? String(d.source).slice(0, 20) : undefined,
        issues: d.issues.slice(0, 200).map((i: any) => ({
          kind: ['small', 'spacing', 'reach', 'inset', 'offscreen'].includes(i?.kind) ? i.kind : 'small',
          id: String(i?.id ?? i?.label ?? 'control').slice(0, 120), label: String(i?.label ?? i?.id ?? 'control').slice(0, 80),
          rect: Array.isArray(i?.rect) ? (i.rect.slice(0, 4).map((n: any) => Math.round(Number(n) || 0)) as any) : [0, 0, 0, 0], detail: String(i?.detail ?? '').slice(0, 200),
        })),
      });
    } else if (e?.type === 'ui-press') {
      const d = parse(e);
      if (!d) continue;
      const vm = Number(d.visualMs);
      presses.push({
        t: Number.isFinite(Number(d.t)) ? Number(d.t) : Number(e.t) || 0, id: String(d.id ?? d.label ?? 'control').slice(0, 120), label: String(d.label ?? d.id ?? 'control').slice(0, 80),
        orientation: d.orientation, scene: d.scene != null ? String(d.scene).slice(0, 80) : undefined, visual: Boolean(d.visual), visualMs: Number.isFinite(vm) ? vm : null,
        rect: Array.isArray(d.rect) ? d.rect.slice(0, 4).map((n: any) => Math.round(Number(n) || 0)) : undefined,
      });
    }
  }
  return { layouts, presses };
}

/** The `ui-transition` events the UI kit logs (a screen slide: its length, and whether reduced motion was on). */
export function uiTransitionsOf(result: any): UiTransition[] {
  const out: UiTransition[] = [];
  for (const e of Array.isArray(result?.events) ? result.events : []) {
    if (e?.type !== 'ui-transition') continue;
    const d = parse(e);
    if (!d) continue;
    out.push({ t: Number(e.t) || 0, from: d.from ?? null, to: d.to != null ? String(d.to) : undefined, ms: Number(d.ms) || 0, plannedMs: Number(d.plannedMs) || 0, reduced: Boolean(d.reduced) });
  }
  return out;
}

/** Presses of one control logged twice inside DUPLICATE_PRESS_S: the press logger must write exactly one entry per press. */
export function duplicatePresses(presses: UiPress[]): number {
  let n = 0;
  const last = new Map<string, number>();
  for (const p of [...presses].sort((a, b) => a.t - b.t)) {
    const prev = last.get(p.id);
    if (prev != null && p.t - prev < DUPLICATE_PRESS_S) n++;
    last.set(p.id, p.t);
  }
  return n;
}

/** Each press checked against the sound starts (audio probe): heard when one starts from just before the press to 150 ms after. */
function withSound(presses: UiPress[], sounds: number[], audioOn: boolean): UiPress[] {
  return presses.map((p) => ({ ...p, sound: audioOn ? sounds.some((s) => s >= p.t - 0.03 && s <= p.t + SOUND_MS / 1000) : undefined }));
}

/**
 * The ui.* metrics. A control is counted once per orientation however many screens or checks it showed in.
 * `ui.smallTargets` counts controls under 44 px, `ui.offscreen` those outside the screen, `ui.insetOverlaps` those under a
 * simulated notch or home bar, `ui.deadPresses` and `ui.silentPresses` the presses that did nothing seen or heard.
 * Spacing and thumb reach are readings (no rubric limit). Silent presses are measured only when the audio probe ran.
 */
export function uiMetricsFromEvents(result: any) {
  const { layouts, presses } = uiEventsOf(result);
  const audio = audioEventsOf(result);
  const audioOn = audio.length > 0 || (Array.isArray(result?.events) && result.events.some((e: any) => e?.type === 'audio-sensor' && !/"adapter":"none"/.test(String(e.detail ?? ''))));
  const heard = withSound(presses, audio.filter((a) => a.type === 'sound-start').map((a) => a.t), audioOn);
  const seen: Record<string, Set<string>> = {};
  const add = (o: string, kind: string, id: string) => { (seen[`${o}.${kind}`] ??= new Set()).add(id); };
  for (const l of layouts) for (const i of l.issues) add(l.orientation, i.kind, i.id);
  const count = (kind: string, o?: string) => (o ? seen[`${o}.${kind}`]?.size ?? 0 : (seen[`portrait.${kind}`]?.size ?? 0) + (seen[`landscape.${kind}`]?.size ?? 0));
  const deadSet = new Set(heard.filter((p) => !p.visual).map((p) => p.id));
  const silentSet = new Set(heard.filter((p) => p.sound === false).map((p) => p.id));
  const metrics: Record<string, number> = {};
  if (layouts.length || presses.length) {
    metrics['ui.layouts'] = layouts.length;
    metrics['ui.presses'] = presses.length;
    metrics['ui.controls'] = layouts.reduce((m, l) => Math.max(m, l.controls), 0);
    for (const [k, kind] of [['smallTargets', 'small'], ['spacingTight', 'spacing'], ['outOfReach', 'reach'], ['insetOverlaps', 'inset'], ['offscreen', 'offscreen']] as const) {
      metrics[`ui.${k}`] = count(kind);
      for (const o of ['portrait', 'landscape']) if (layouts.some((l) => l.orientation === o)) metrics[`ui.${o}.${k}`] = count(kind, o);
    }
    metrics['ui.deadPresses'] = deadSet.size;
    if (audioOn) metrics['ui.silentPresses'] = silentSet.size;
    metrics['ui.duplicatePresses'] = duplicatePresses(presses);
  }
  // The UI kit's screen transitions: 150-200 ms, and 0 ms with reduced motion (readings the review and the criteria judge).
  const transitions = uiTransitionsOf(result);
  if (transitions.length) {
    const off = transitions.filter((t) => (t.reduced ? t.ms !== 0 : t.ms < TRANSITION_MIN_MS || t.ms > TRANSITION_MAX_MS + 40));
    metrics['ui.transitions'] = transitions.length;
    metrics['ui.transitionsOffSpec'] = off.length;
    const full = transitions.filter((t) => !t.reduced).map((t) => t.ms);
    if (full.length) { metrics['ui.transitionMsMin'] = Math.min(...full); metrics['ui.transitionMsMax'] = Math.max(...full); }
  }
  return { metrics, layouts, presses: heard };
}

/** Merge ui.* metrics into a playtest result. Never throws; a run with no UI events gets no ui.* readings (unmeasured). */
export function enrichUi(result: any) {
  if (!result || typeof result !== 'object') return result;
  try {
    const u = uiMetricsFromEvents(result);
    if (!Object.keys(u.metrics).length) return result;
    return { ...result, metrics: { ...(result.metrics ?? {}), ...u.metrics }, _ui: { layouts: u.layouts, presses: u.presses } };
  } catch { return result; }
}

export type UiFinding = { title: string; severity: string; area: string; detail: string; fix: string; shots: string[]; replay: null };

const FIX_SMALL = 'Make the control at least 44x44 px (Apple 44 pt, Material 48 dp): grow its hit area with padding or a transparent ::before/min-width and min-height (the picture can stay small), keep 8 px between neighbours.';
const FIX_INSET = 'Keep controls out of the notch and home-bar areas: pad the layout with env(safe-area-inset-*) (and viewport-fit=cover), or for canvas and Unity UI use Screen.safeArea.';
const FIX_OFFSCREEN = 'Bring the control on screen at this size and orientation: let the layout wrap or scroll, use vw/vh-relative sizes, and test both 390x844 and 844x390.';
const FIX_DEAD = 'Answer the press on the frame it arrives: a pressed state (colour, scale, glow), then the result. Hades menus react within a frame; nothing visible within 100 ms reads as broken.';
const FIX_SILENT = 'Play a short UI click on the press within 150 ms (the audio probe sees WebAudio buffer sources, so play it through the WebAudio context and tag it: source.__hawkesSampleId = "ui-click").';

/** One finding per broken control (small, under an inset, offscreen) per orientation, and one per dead or silent button, each naming it. */
export function uiFindings(result: any, { scenario }: { scenario: string }): UiFinding[] {
  const u = result?._ui ?? uiMetricsFromEvents(result);
  const layouts: UiLayout[] = u.layouts ?? [];
  const presses: UiPress[] = u.presses ?? [];
  const out: UiFinding[] = [];
  const done = new Set<string>();
  const device = (o: string) => (o === 'landscape' ? '844x390 landscape' : '390x844 portrait');
  for (const l of layouts) {
    for (const i of l.issues) {
      if (!['small', 'inset', 'offscreen'].includes(i.kind)) continue; // spacing and reach are readings
      const key = `${l.orientation}|${i.kind}|${i.id}`;
      if (done.has(key) || out.length >= 24) continue;
      done.add(key);
      const what = i.kind === 'small' ? 'Target under 44 px' : i.kind === 'inset' ? 'Control under the notch or home bar' : 'Control off screen';
      out.push({
        title: `${what}: ${i.label} (${l.orientation})`,
        severity: 'bug', area: 'mobile',
        detail: `In ${scenario} at ${device(l.orientation)}${l.scene ? ` on "${l.scene}"` : ''}, "${i.label}" ${i.detail || i.kind} (x ${i.rect[0]}, y ${i.rect[1]}, ${i.rect[2]}x${i.rect[3]} px).${l.shot ? ` Outlined screenshot: Gen asset ${l.shot}.` : l.outlined ? ' The probe outlined the control on screen at that moment (see the clip).' : ''}`,
        fix: i.kind === 'small' ? FIX_SMALL : i.kind === 'inset' ? FIX_INSET : FIX_OFFSCREEN, shots: l.shot ? [l.shot] : [], replay: null,
      });
    }
  }
  for (const p of presses) {
    const dead = !p.visual;
    const silent = p.sound === false;
    if (!dead && !silent) continue;
    const key = `press|${dead ? 'dead' : 'silent'}|${p.id}`;
    if (done.has(key) || out.length >= 32) continue;
    done.add(key);
    out.push({
      title: dead ? `Dead press: ${p.label}` : `Silent press: ${p.label}`,
      severity: 'bug', area: 'ui',
      detail: dead
        ? `In ${scenario}, pressing "${p.label}" at ${r2(p.t)} s changed nothing on screen within ${VISUAL_MS} ms${silent ? ' and played no sound within 150 ms' : ''}.`
        : `In ${scenario}, pressing "${p.label}" at ${r2(p.t)} s started no sound within ${SOUND_MS} ms (the screen did answer in ${p.visualMs ?? '?'} ms).`,
      fix: dead ? FIX_DEAD : FIX_SILENT, shots: [], replay: null,
    });
  }
  return out;
}

/** A short summary of the menu screens and presses for the fun reviewer and the critic (they see frames, not the DOM). */
export function uiSummary(result: any, max = 16): string {
  const u = result?._ui ?? uiMetricsFromEvents(result);
  const m = result?.metrics ?? {};
  if (!u.layouts?.length && !u.presses?.length) return '';
  const head = ['smallTargets', 'insetOverlaps', 'offscreen', 'deadPresses', 'silentPresses', 'spacingTight', 'outOfReach'].map((k) => `ui.${k}=${m[`ui.${k}`] ?? 'n/a'}`).join(', ');
  const screens = (u.layouts as UiLayout[]).slice(0, max).map((l) => `${r2(l.t)}s ${l.orientation} ${l.viewport.join('x')}${l.scene ? ` "${l.scene}"` : ''}: ${l.controls} controls, ${l.issues.length} issues${l.issues.length ? ` (${l.issues.slice(0, 4).map((i) => `${i.kind}: ${i.label}`).join('; ')})` : ''}`);
  const pr = (u.presses as UiPress[]).slice(0, max).map((p) => `${r2(p.t)}s press "${p.label}": ${p.visual ? `visual in ${p.visualMs ?? '?'} ms` : 'NO visual change'}${p.sound === undefined ? '' : p.sound ? ', sound' : ', NO sound'}`);
  return [head, ...screens, ...pr].join('\n');
}

/** One line for a playtest step detail. */
export function uiLine(result: any): string {
  const m = result?.metrics ?? {};
  if (m['ui.layouts'] == null && m['ui.presses'] == null) return '';
  return `ui: ${m['ui.smallTargets'] ?? 0} small, ${m['ui.offscreen'] ?? 0} offscreen, ${m['ui.insetOverlaps'] ?? 0} under insets, ${m['ui.deadPresses'] ?? 0} dead, ${m['ui.silentPresses'] ?? '?'} silent`;
}
