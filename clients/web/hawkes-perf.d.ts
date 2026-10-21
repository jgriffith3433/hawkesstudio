// Types for hawkes-perf.js (the Hawkes Babylon.js performance & leak root-cause monitor v1,
// copied from hawkesstudio/clients/web).

export const PERF_MONITOR_VERSION: 1;

export interface PerfFpsBreakdown {
  current: number;
  avg: number;
  worst: number;
  jankFrames: number;
  recentJankFrames: number;
  frameMs: number;
}

export interface PerfTimingBreakdown {
  frameMs: number;
  activeMeshesEvalMs: number;
  renderTargetsMs: number;
  mainRenderMs: number;
  animationsMs: number;
  particlesMs: number;
  gpuFrameMs: number;
  shaderCompiles: number;
}

export interface PerfRenderPass {
  name: string;
  kind: 'ShadowGenerator' | 'GlowLayer' | 'MirrorTexture' | 'RenderTargetTexture' | string;
  resolution: string;
  renderListCount: number;
  fullScene: boolean;
  tris?: number;
}

export interface PerfHeavyMesh {
  name: string;
  tris: number;
  verts: number;
  skinned: boolean;
  bones: number;
  thin: number;
  castsShadow: boolean;
}

export interface PerfMaterialGroup {
  material: string;
  meshCount: number;
  tris: number;
}

export interface PerfResourceCounts {
  meshes: number;
  geometries: number;
  materials: number;
  textures: number;
  estimatedTextureMB: number;
  animationGroups: number;
  skeletons: number;
  particleSystems: number;
  lights: number;
  transformNodes: number;
  renderTargets: number;
  observers: number;
  audioElements: number;
}

export interface PerfLeakReport {
  leaked: boolean;
  from: string;
  baselineAgeSec: number;
  current: PerfResourceCounts;
  baseline: PerfResourceCounts;
  delta: PerfResourceCounts;
  notes: string[];
}

export interface PerfSnapshot {
  version: 1;
  at: number;
  sceneAttached: boolean;
  fps: PerfFpsBreakdown;
  timing: PerfTimingBreakdown;
  drawCalls: number;
  activeMeshes: number;
  totalMeshes: number;
  activeTris: number;
  totalTris: number;
  shadowTris: number;
  skinnedMeshes: number;
  activeBones: number;
  thinInstanceMeshes: number;
  thinInstancesTotal: number;
  renderPasses: PerfRenderPass[];
  topHeavyMeshes: PerfHeavyMesh[];
  unfrozenMeshes: number;
  unfrozenMaterials: number;
  enabledLights: number;
  zeroIntensityEnabledLights: number;
  unmergedMaterialGroups: PerfMaterialGroup[];
  materialDirtyPerSec: number;
  resources: {
    current: PerfResourceCounts;
    baseline: PerfResourceCounts;
    delta: PerfResourceCounts;
    baselineAgeSec: number;
  };
  leaks: {
    leaked: boolean;
    notes: string[];
  };
  suspects: string[];
  summary: string;
}

export interface PerfMonitorOptions {
  pollMs?: number;
  forceNew?: boolean;
  BABYLON?: unknown;
  SceneInstrumentation?: unknown;
  EngineInstrumentation?: unknown;
}

export interface PerfMonitorApi {
  version: 1;
  attach(scene: unknown): boolean;
  snapshot(): PerfSnapshot;
  summary(): string;
  mark(label?: string): PerfResourceCounts;
  checkLeaks(fromLabel?: string): PerfLeakReport;
  toggleHud(force?: boolean): boolean;
  dispose(): void;
}

export function discoverBabylonScene(win?: unknown): unknown | null;
export function installPerfMonitor(sceneOrOptions?: unknown, maybeOptions?: PerfMonitorOptions): PerfMonitorApi;
