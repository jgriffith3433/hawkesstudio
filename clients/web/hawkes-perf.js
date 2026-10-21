// Hawkes Babylon.js performance & leak root-cause monitor v1.
// Source of truth: hawkesstudio/clients/web/hawkes-perf.js
//
// Usage in any Babylon.js project (icanbe, phorigins, doseofdestruction, etc.):
//   import { installPerfMonitor } from './hawkes-perf.js';
//   const perf = installPerfMonitor(scene); // or installPerfMonitor() for auto-discovery
//   perf.snapshot();   // full diagnostic snapshot (timings, draws, passes, heavy meshes, leaks, suspects)
//   perf.summary();    // compact one-line string: "58 fps · 42 draws · 38.4k tris"
//   perf.mark('round-1');
//   perf.checkLeaks(); // compare current resources against baseline or a named mark
//   perf.toggleHud();  // toggle on-screen live diagnostic overlay

export const PERF_MONITOR_VERSION = 1;

const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const fmtK = (n) => (n >= 1e6 ? `${r1(n / 1e6)}M` : n >= 1000 ? `${r1(n / 1000)}k` : String(Math.round(n || 0)));

/**
 * Finds an active Babylon.js Scene on the page, checking:
 * - window.BABYLON?.Engine?.Instances
 * - window.BABYLON?.Engine?.LastCreatedScene
 * - window.day?.world?.()?.scene (I Can Be)
 * - window.__babylonScene / window.scene / window.game?.scene
 */
export function discoverBabylonScene(win = typeof window !== 'undefined' ? window : null) {
  if (!win) return null;
  try {
    const engines = win.BABYLON?.Engine?.Instances;
    if (Array.isArray(engines)) {
      for (let i = engines.length - 1; i >= 0; i--) {
        const scenes = engines[i]?.scenes;
        if (Array.isArray(scenes) && scenes.length) {
          for (let j = scenes.length - 1; j >= 0; j--) {
            if (scenes[j] && !scenes[j].isDisposed) return scenes[j];
          }
        }
      }
    }
    const last = win.BABYLON?.Engine?.LastCreatedScene;
    if (last && !last.isDisposed) return last;
    const dayScene = typeof win.day?.world === 'function' ? win.day.world()?.scene : win.day?.world?.scene;
    if (isBabylonScene(dayScene)) return dayScene;
    for (const cand of [win.__babylonScene, win.scene, win.game?.scene, win.app?.scene, win.world?.scene]) {
      if (isBabylonScene(cand)) return cand;
    }
  } catch {}
  return null;
}

function isBabylonScene(s) {
  return Boolean(s && typeof s === 'object' && !s.isDisposed && (Array.isArray(s.meshes) || typeof s.getEngine === 'function'));
}

export function installPerfMonitor(sceneOrOptions = null, maybeOptions = {}) {
  const win = typeof window !== 'undefined' ? window : null;
  const hasSceneArg = isBabylonScene(sceneOrOptions);
  const opts = (hasSceneArg ? maybeOptions : sceneOrOptions) || {};

  if (win && win.hawkesPerf && !hasSceneArg && !opts.forceNew) {
    const found = discoverBabylonScene(win);
    if (found) win.hawkesPerf.attach(found);
    return win.hawkesPerf;
  }

  let scene = hasSceneArg ? sceneOrOptions : discoverBabylonScene(win);
  let sceneInst = null;
  let engineInst = null;
  let hudEl = null;
  let hudTimer = 0;
  let pollTimer = 0;

  // Rolling frame & jank tracker (last 120 frames + 1s buckets)
  const frameTimes = [];
  const fpsSamples = [];
  let rafFrames = 0;
  let rafLast = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let lastFrameAt = rafLast;
  let currentFps = 60;
  let jankFrames = 0;
  let rafId = 0;

  // Observable fallback timings when BABYLON.SceneInstrumentation isn't globally exposed
  const obsTimings = {
    frameMs: 0,
    activeMeshesEvalMs: 0,
    renderTargetsMs: 0,
    mainRenderMs: 0,
    animationsMs: 0,
    particlesMs: 0,
    gpuFrameMs: 0,
    shaderCompiles: 0,
  };
  let tFrame0 = 0, tEval0 = 0, tRt0 = 0, tDraw0 = 0, tAnim0 = 0, tPart0 = 0;
  let obsCleanups = [];

  // Material & imageProcessingConfiguration dirty rate tracker
  let dirtyCountWindow = 0;
  let dirtyWindowStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let materialDirtyPerSec = 0;
  const hookedMaterials = new WeakSet();
  let hookedImageProc = null;
  let hookedImageProcObs = null;

  // Resource baseline & named marks
  let baseline = null;
  let baselineAt = 0;
  const marks = {};

  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function tickRaf(t) {
    const dt = t - lastFrameAt;
    lastFrameAt = t;
    if (dt > 0 && dt < 5000) {
      frameTimes.push(dt);
      if (frameTimes.length > 120) frameTimes.shift();
      if (dt > 33.3) jankFrames++;
    }
    rafFrames++;
    if (t - rafLast >= 1000) {
      currentFps = Math.round((rafFrames * 1000) / (t - rafLast));
      fpsSamples.push(currentFps);
      if (fpsSamples.length > 300) fpsSamples.shift();
      rafFrames = 0;
      rafLast = t;
      // Roll dirty counter once per second
      const elapsedSec = Math.max(0.2, (t - dirtyWindowStart) / 1000);
      materialDirtyPerSec = r1(dirtyCountWindow / elapsedSec);
      dirtyCountWindow = 0;
      dirtyWindowStart = t;
    }
    if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(tickRaf);
  }
  if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(tickRaf);

  function bumpDirty() {
    dirtyCountWindow++;
  }

  function hookSceneMaterials(sc) {
    if (!sc) return;
    try {
      const ipc = sc.imageProcessingConfiguration;
      if (ipc && ipc !== hookedImageProc && ipc.onUpdateParameters?.add) {
        if (hookedImageProc && hookedImageProcObs) {
          try { hookedImageProc.onUpdateParameters.remove(hookedImageProcObs); } catch {}
        }
        hookedImageProc = ipc;
        hookedImageProcObs = ipc.onUpdateParameters.add(bumpDirty);
      }
      const mats = sc.materials || [];
      for (let i = 0; i < mats.length; i++) {
        const m = mats[i];
        if (!m || hookedMaterials.has(m)) continue;
        hookedMaterials.add(m);
        if (typeof m.markAsDirty === 'function') {
          const orig = m.markAsDirty;
          m.markAsDirty = function (...args) {
            bumpDirty();
            return orig.apply(this, args);
          };
        }
      }
    } catch {}
  }

  function detachInstrumentation() {
    for (const fn of obsCleanups.splice(0)) {
      try { fn(); } catch {}
    }
    if (hookedImageProc && hookedImageProcObs) {
      try { hookedImageProc.onUpdateParameters.remove(hookedImageProcObs); } catch {}
      hookedImageProc = null;
      hookedImageProcObs = null;
    }
    try { sceneInst?.dispose?.(); } catch {}
    try { engineInst?.dispose?.(); } catch {}
    sceneInst = null;
    engineInst = null;
  }

  function addObs(observable, fn) {
    if (!observable || typeof observable.add !== 'function') return;
    const obs = observable.add(fn);
    obsCleanups.push(() => { try { observable.remove(obs); } catch {} });
  }

  function attach(nextScene) {
    if (!isBabylonScene(nextScene)) return false;
    if (scene === nextScene && (sceneInst || obsCleanups.length)) return true;
    detachInstrumentation();
    scene = nextScene;

    const B = win?.BABYLON || opts.BABYLON || null;
    const engine = typeof scene.getEngine === 'function' ? scene.getEngine() : scene._engine;

    // 1. Try BABYLON.SceneInstrumentation & EngineInstrumentation if available
    try {
      const SI = opts.SceneInstrumentation || B?.SceneInstrumentation;
      if (typeof SI === 'function') {
        sceneInst = new SI(scene);
        sceneInst.captureFrameTime = true;
        sceneInst.captureActiveMeshesEvaluationTime = true;
        sceneInst.captureRenderTargetsRenderTime = true;
        sceneInst.captureInterFrameTime = true;
        sceneInst.captureAnimationsTime = true;
        sceneInst.captureParticlesRenderTime = true;
      }
    } catch { sceneInst = null; }

    try {
      const EI = opts.EngineInstrumentation || B?.EngineInstrumentation;
      if (typeof EI === 'function' && engine) {
        engineInst = new EI(engine);
        engineInst.captureGPUFrameTime = true;
        engineInst.captureShaderCompilationTime = true;
      }
    } catch { engineInst = null; }

    // 2. Always wire lightweight observable timers so ES-module Babylon builds work identically
    addObs(scene.onBeforeRenderObservable, () => { tFrame0 = nowMs(); obsTimings.renderTargetsMs = 0; obsTimings.mainRenderMs = 0; });
    addObs(scene.onAfterRenderObservable, () => { if (tFrame0) obsTimings.frameMs = r1(nowMs() - tFrame0); });
    addObs(scene.onBeforeActiveMeshesEvaluationObservable, () => { tEval0 = nowMs(); });
    addObs(scene.onAfterActiveMeshesEvaluationObservable, () => { if (tEval0) obsTimings.activeMeshesEvalMs = r1(nowMs() - tEval0); });
    addObs(scene.onBeforeRenderTargetsRenderObservable, () => { tRt0 = nowMs(); });
    addObs(scene.onAfterRenderTargetsRenderObservable, () => { if (tRt0) obsTimings.renderTargetsMs = r1(obsTimings.renderTargetsMs + (nowMs() - tRt0)); });
    addObs(scene.onBeforeDrawPhaseObservable, () => { tDraw0 = nowMs(); });
    addObs(scene.onAfterDrawPhaseObservable, () => { if (tDraw0) obsTimings.mainRenderMs = r1(obsTimings.mainRenderMs + (nowMs() - tDraw0)); });
    addObs(scene.onBeforeAnimationsObservable, () => { tAnim0 = nowMs(); });
    addObs(scene.onAfterAnimationsObservable, () => { if (tAnim0) obsTimings.animationsMs = r1(nowMs() - tAnim0); });
    addObs(scene.onBeforeParticlesRenderingObservable, () => { tPart0 = nowMs(); });
    addObs(scene.onAfterParticlesRenderingObservable, () => { if (tPart0) obsTimings.particlesMs = r1(nowMs() - tPart0); });

    hookSceneMaterials(scene);
    baseline = readResources(scene);
    baselineAt = Date.now();
    return true;
  }

  if (scene) attach(scene);
  else if (typeof setInterval === 'function') {
    let tries = 0;
    const maxTries = Math.ceil((opts.pollMs ?? 60_000) / 500);
    pollTimer = setInterval(() => {
      const found = discoverBabylonScene(win);
      if (found) {
        attach(found);
        clearInterval(pollTimer);
        pollTimer = 0;
      } else if (++tries >= maxTries) {
        clearInterval(pollTimer);
        pollTimer = 0;
      }
    }, 500);
    if (pollTimer?.unref) pollTimer.unref();
  }

  function ensureScene() {
    if (scene && !scene.isDisposed) {
      hookSceneMaterials(scene);
      return scene;
    }
    const found = discoverBabylonScene(win);
    if (found) attach(found);
    return scene && !scene.isDisposed ? scene : null;
  }

  function counterMs(counter, fallback = 0) {
    if (!counter) return r1(fallback);
    const v = counter.average || counter.current || counter.lastSecAverage || fallback || 0;
    return r1(v);
  }

  function readTiming(sc) {
    const engine = sc && (typeof sc.getEngine === 'function' ? sc.getEngine() : sc._engine);
    const engineFps = engine && typeof engine.getFps === 'function' ? Math.round(engine.getFps()) : currentFps;
    const engineDelta = engine && typeof engine.getDeltaTime === 'function' ? Number(engine.getDeltaTime()) : 0;
    const avgFrameDelta = frameTimes.length ? frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length : (engineDelta || (engineFps > 0 ? 1000 / engineFps : 16.7));
    const worstFrameDelta = frameTimes.length ? Math.max(...frameTimes) : avgFrameDelta;
    const recentJank = frameTimes.filter((d) => d > 33.3).length;

    const fpsCurrent = engineFps || currentFps || Math.round(1000 / Math.max(1, avgFrameDelta));
    const fpsAvg = fpsSamples.length ? Math.round(fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length) : fpsCurrent;
    const fpsWorst = fpsSamples.length ? Math.min(...fpsSamples, fpsCurrent) : Math.min(fpsCurrent, Math.round(1000 / Math.max(1, worstFrameDelta)));

    const frameMs = counterMs(sceneInst?.frameTimeCounter, obsTimings.frameMs || avgFrameDelta);
    const activeMeshesEvalMs = counterMs(sceneInst?.activeMeshesEvaluationTimeCounter, obsTimings.activeMeshesEvalMs);
    const renderTargetsMs = counterMs(sceneInst?.renderTargetsRenderTimeCounter, obsTimings.renderTargetsMs);
    const animationsMs = counterMs(sceneInst?.animationsTimeCounter, obsTimings.animationsMs);
    const particlesMs = counterMs(sceneInst?.particlesRenderTimeCounter, obsTimings.particlesMs);
    const rawDrawMs = obsTimings.mainRenderMs || Math.max(0, frameMs - activeMeshesEvalMs - renderTargetsMs - animationsMs - particlesMs);
    const mainRenderMs = r1(rawDrawMs);
    const gpuRaw = engineInst?.gpuFrameTimeCounter ? (engineInst.gpuFrameTimeCounter.average || engineInst.gpuFrameTimeCounter.current || 0) * 1e-6 : obsTimings.gpuFrameMs;
    const gpuFrameMs = r1(gpuRaw);
    const shaderCompiles = Math.round(engineInst?.shaderCompilationTimeCounter?.count ?? engine?._shaderCompilationCounter ?? obsTimings.shaderCompiles ?? 0);

    return {
      fps: {
        current: fpsCurrent,
        avg: fpsAvg,
        worst: fpsWorst,
        jankFrames: Math.max(jankFrames, recentJank),
        recentJankFrames: recentJank,
        frameMs: r1(avgFrameDelta),
      },
      timing: {
        frameMs,
        activeMeshesEvalMs,
        renderTargetsMs,
        mainRenderMs,
        animationsMs,
        particlesMs,
        gpuFrameMs,
        shaderCompiles,
      },
    };
  }

  function meshTris(m) {
    if (!m) return 0;
    try {
      const idx = typeof m.getTotalIndices === 'function' ? m.getTotalIndices() : (m._totalIndices ?? 0);
      return idx > 0 ? Math.round(idx / 3) : 0;
    } catch { return 0; }
  }

  function meshVerts(m) {
    if (!m) return 0;
    try {
      return typeof m.getTotalVertices === 'function' ? m.getTotalVertices() : (m._totalVertices ?? 0);
    } catch { return 0; }
  }

  function isMeshEnabled(m) {
    if (!m) return false;
    try {
      if (typeof m.isEnabled === 'function' && !m.isEnabled()) return false;
      if (m.isVisible === false) return false;
      return true;
    } catch { return true; }
  }

  function readGeometryAndPasses(sc) {
    if (!sc) {
      return {
        drawCalls: 0, activeMeshes: 0, totalMeshes: 0, activeTris: 0, totalTris: 0, shadowTris: 0,
        skinnedMeshes: 0, activeBones: 0, thinInstanceMeshes: 0, thinInstancesTotal: 0,
        renderPasses: [], topHeavyMeshes: [],
      };
    }
    const engine = typeof sc.getEngine === 'function' ? sc.getEngine() : sc._engine;
    const meshes = Array.isArray(sc.meshes) ? sc.meshes : [];
    const activeList = (typeof sc.getActiveMeshes === 'function' ? sc.getActiveMeshes()?.data || sc.getActiveMeshes() : sc._activeMeshes?.data || sc._activeMeshes) || [];
    const activeArr = Array.isArray(activeList) ? activeList.filter(Boolean) : [];
    const activeSet = new Set(activeArr);

    // Collect shadow casters and render passes first
    const shadowCasters = new Set();
    let shadowTris = 0;
    const renderPasses = [];
    const seenTargets = new Set();

    // 1. ShadowGenerators from lights
    const lights = Array.isArray(sc.lights) ? sc.lights : [];
    for (const light of lights) {
      if (!light) continue;
      const gens = [];
      try {
        const g1 = typeof light.getShadowGenerator === 'function' ? light.getShadowGenerator() : null;
        if (g1) gens.push(g1);
        if (light._shadowGenerators && typeof light._shadowGenerators.values === 'function') {
          for (const g of light._shadowGenerators.values()) if (g && !gens.includes(g)) gens.push(g);
        }
      } catch {}
      for (const sg of gens) {
        const map = typeof sg.getShadowMap === 'function' ? sg.getShadowMap() : sg._shadowMap;
        if (map) seenTargets.add(map);
        const rList = map ? map.renderList : sg.renderList;
        const fullScene = rList == null;
        const casters = Array.isArray(rList) ? rList : (fullScene ? meshes : []);
        let passTris = 0;
        for (const cm of casters) {
          if (!cm) continue;
          shadowCasters.add(cm);
          passTris += meshTris(cm) * Math.max(1, cm.thinInstanceCount || 1);
        }
        shadowTris += passTris;
        const size = map?.getSize?.() || (sg.mapSize ? { width: sg.mapSize, height: sg.mapSize } : null);
        const res = size ? `${size.width || size}x${size.height || size}` : String(sg._mapSize || '?');
        renderPasses.push({
          name: sg.id || light.name || 'ShadowGenerator',
          kind: 'ShadowGenerator',
          resolution: res,
          renderListCount: Array.isArray(rList) ? rList.length : meshes.length,
          fullScene,
          tris: passTris,
        });
      }
    }

    // 2. EffectLayers (GlowLayer, HighlightLayer)
    const effectLayers = Array.isArray(sc.effectLayers) ? sc.effectLayers : [];
    for (const el of effectLayers) {
      if (!el) continue;
      const tex = el._mainTexture || el.mainTexture;
      if (tex) seenTargets.add(tex);
      const className = el.getClassName?.() || (el.constructor?.name) || 'EffectLayer';
      const hasCustomList = Boolean(
        (Array.isArray(el._includedOnlyMeshes) && el._includedOnlyMeshes.length > 0) ||
        (el._meshes && (el._meshes.size > 0 || Object.keys(el._meshes).length > 0)) ||
        (Array.isArray(tex?.renderList) && tex.renderList.length < meshes.length)
      );
      const size = tex?.getSize?.() || el._mainTextureDesiredSize;
      const res = size ? `${size.width || size}x${size.height || size}` : 'auto';
      const listLen = Array.isArray(el._includedOnlyMeshes) && el._includedOnlyMeshes.length
        ? el._includedOnlyMeshes.length
        : Array.isArray(tex?.renderList) ? tex.renderList.length : meshes.length;
      renderPasses.push({
        name: el.name || className,
        kind: /glow/i.test(className) ? 'GlowLayer' : className,
        resolution: res,
        renderListCount: listLen,
        fullScene: !hasCustomList,
      });
    }

    // 3. Custom RenderTargetTextures / MirrorTextures
    const rtts = [
      ...(Array.isArray(sc.customRenderTargets) ? sc.customRenderTargets : []),
      ...(Array.isArray(sc.textures) ? sc.textures.filter((t) => t && t.isRenderTarget) : []),
    ];
    for (const rtt of rtts) {
      if (!rtt || seenTargets.has(rtt)) continue;
      seenTargets.add(rtt);
      const className = rtt.getClassName?.() || rtt.constructor?.name || 'RenderTargetTexture';
      const kind = /mirror/i.test(className) || rtt.mirrorPlane ? 'MirrorTexture' : 'RenderTargetTexture';
      const rList = rtt.renderList;
      const fullScene = rList == null;
      const size = rtt.getSize?.() || rtt._size;
      const res = size ? (typeof size === 'number' ? `${size}x${size}` : `${size.width || '?'}x${size.height || '?'}`) : '?';
      renderPasses.push({
        name: rtt.name || kind,
        kind,
        resolution: res,
        renderListCount: Array.isArray(rList) ? rList.length : meshes.length,
        fullScene,
      });
    }

    let totalTris = 0;
    let computedActiveTris = 0;
    let skinnedMeshes = 0;
    let computedBones = 0;
    let thinInstanceMeshes = 0;
    let thinInstancesTotal = 0;
    const countedSkeletons = new Set();
    const heavyCandidates = [];

    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      if (!m) continue;
      const baseTris = meshTris(m);
      const thin = Number(m.thinInstanceCount) || 0;
      const effectiveTris = baseTris * Math.max(1, thin);
      totalTris += effectiveTris;
      const isAct = activeSet.size ? activeSet.has(m) : isMeshEnabled(m);
      if (isAct) computedActiveTris += effectiveTris;

      const skel = m.skeleton;
      const isSkinned = Boolean(skel && (m.numBoneInfluencers ?? 4) > 0);
      const bones = skel && Array.isArray(skel.bones) ? skel.bones.length : 0;
      if (isSkinned) {
        skinnedMeshes++;
        if (!countedSkeletons.has(skel)) {
          countedSkeletons.add(skel);
          computedBones += bones;
        }
      }
      if (thin > 0) {
        thinInstanceMeshes++;
        thinInstancesTotal += thin;
      }
      if (effectiveTris > 0 || meshVerts(m) > 0) {
        heavyCandidates.push({
          name: m.name || m.id || `mesh_${i}`,
          tris: effectiveTris,
          verts: meshVerts(m),
          skinned: isSkinned,
          bones,
          thin,
          castsShadow: shadowCasters.has(m),
        });
      }
    }

    heavyCandidates.sort((a, b) => b.tris - a.tris || b.verts - a.verts);
    const topHeavyMeshes = heavyCandidates.slice(0, 5);

    const rawActiveIndices = typeof sc.getActiveIndices === 'function' ? sc.getActiveIndices() : 0;
    const activeTris = rawActiveIndices > 0 ? Math.round(rawActiveIndices / 3) : computedActiveTris;
    const rawActiveBones = typeof sc.getActiveBones === 'function' ? sc.getActiveBones() : 0;
    const activeBones = rawActiveBones > 0 ? rawActiveBones : computedBones;
    const drawCalls = Math.round(
      sceneInst?.drawCallsCounter?.current ??
      engine?._drawCalls?.current ??
      sc._drawCalls?.current ??
      (activeArr.length || 0)
    );

    return {
      drawCalls,
      activeMeshes: activeArr.length || meshes.filter(isMeshEnabled).length,
      totalMeshes: meshes.length,
      activeTris,
      totalTris,
      shadowTris,
      skinnedMeshes,
      activeBones,
      thinInstanceMeshes,
      thinInstancesTotal,
      renderPasses,
      topHeavyMeshes,
    };
  }

  function readAudit(sc) {
    if (!sc) {
      return {
        unfrozenMeshes: 0,
        unfrozenMaterials: 0,
        enabledLights: 0,
        zeroIntensityEnabledLights: 0,
        unmergedMaterialGroups: [],
        materialDirtyPerSec: 0,
      };
    }
    const meshes = Array.isArray(sc.meshes) ? sc.meshes : [];
    const materials = Array.isArray(sc.materials) ? sc.materials : [];
    const lights = Array.isArray(sc.lights) ? sc.lights : [];

    let unfrozenMeshes = 0;
    const matGroups = new Map();

    for (const m of meshes) {
      if (!m) continue;
      const frozen = Boolean(m.isWorldMatrixFrozen || m._isWorldMatrixFrozen);
      if (!frozen && isMeshEnabled(m)) unfrozenMeshes++;

      // Count separate non-instanced, non-skinned meshes per material
      const isInstanced = Boolean((m.instances && m.instances.length > 0) || (m.thinInstanceCount > 0) || m.isAnInstance);
      const isSkinned = Boolean(m.skeleton && (m.numBoneInfluencers ?? 4) > 0);
      const mat = m.material;
      if (mat && !isInstanced && !isSkinned && isMeshEnabled(m) && meshTris(m) > 0) {
        const key = mat.name || mat.id || 'unnamed_material';
        const cur = matGroups.get(key) || { material: key, meshCount: 0, tris: 0 };
        cur.meshCount++;
        cur.tris += meshTris(m);
        matGroups.set(key, cur);
      }
    }

    const unmergedMaterialGroups = [...matGroups.values()]
      .filter((g) => g.meshCount >= 10)
      .sort((a, b) => b.meshCount - a.meshCount);

    let unfrozenMaterials = 0;
    for (const mat of materials) {
      if (!mat) continue;
      if (!mat.isFrozen && !mat._isFrozen) unfrozenMaterials++;
    }

    let enabledLights = 0;
    let zeroIntensityEnabledLights = 0;
    for (const l of lights) {
      if (!l) continue;
      const enabled = typeof l.isEnabled === 'function' ? l.isEnabled() : l._isEnabled !== false;
      if (enabled) {
        enabledLights++;
        if ((l.intensity ?? 1) <= 0.001) zeroIntensityEnabledLights++;
      }
    }

    // Current rate including any dirty events in the current partial second
    const elapsedSec = Math.max(0.25, (nowMs() - dirtyWindowStart) / 1000);
    const liveDirtyRate = dirtyCountWindow > 0 ? r1(dirtyCountWindow / elapsedSec) : materialDirtyPerSec;

    return {
      unfrozenMeshes,
      unfrozenMaterials,
      enabledLights,
      zeroIntensityEnabledLights,
      unmergedMaterialGroups,
      materialDirtyPerSec: Math.max(materialDirtyPerSec, liveDirtyRate),
    };
  }

  function estimateTextureMB(textures) {
    if (!Array.isArray(textures)) return 0;
    let bytes = 0;
    const seen = new Set();
    for (const t of textures) {
      if (!t) continue;
      const key = t._texture || t.uniqueId || t;
      if (seen.has(key)) continue;
      seen.add(key);
      let w = 0, h = 0;
      try {
        const sz = typeof t.getSize === 'function' ? t.getSize() : (t._size || null);
        w = Number(sz?.width ?? t._texture?._width ?? t._texture?.baseWidth ?? 0);
        h = Number(sz?.height ?? t._texture?._height ?? t._texture?.baseHeight ?? 0);
      } catch {}
      if (w > 0 && h > 0) bytes += w * h * 4 * 1.33;
    }
    return r1(bytes / (1024 * 1024));
  }

  function countObservers(sc) {
    if (!sc) return 0;
    let total = 0;
    const obsKeys = [
      'onBeforeRenderObservable', 'onAfterRenderObservable',
      'onBeforeActiveMeshesEvaluationObservable', 'onAfterActiveMeshesEvaluationObservable',
      'onBeforeAnimationsObservable', 'onAfterAnimationsObservable',
      'onPointerObservable', 'onPrePointerObservable',
      'onKeyboardObservable', 'onPreKeyboardObservable',
      'onDisposeObservable', 'onReadyObservable',
    ];
    for (const k of obsKeys) {
      const arr = sc[k]?.observers || sc[k]?._observers;
      if (Array.isArray(arr)) total += arr.length;
    }
    return total;
  }

  function readResources(sc) {
    const docAudio = typeof document !== 'undefined' && typeof document.querySelectorAll === 'function'
      ? document.querySelectorAll('audio').length
      : 0;
    const babylonSounds = sc?.mainSoundTrack?.soundCollection?.length ?? 0;
    if (!sc) {
      return {
        meshes: 0, geometries: 0, materials: 0, textures: 0, estimatedTextureMB: 0,
        animationGroups: 0, skeletons: 0, particleSystems: 0, lights: 0,
        transformNodes: 0, renderTargets: 0, observers: 0, audioElements: docAudio,
      };
    }
    const textures = Array.isArray(sc.textures) ? sc.textures : [];
    const customRts = Array.isArray(sc.customRenderTargets) ? sc.customRenderTargets.length : 0;
    const texRts = textures.filter((t) => t && t.isRenderTarget).length;
    return {
      meshes: Array.isArray(sc.meshes) ? sc.meshes.length : 0,
      geometries: Array.isArray(sc.geometries) ? sc.geometries.length : 0,
      materials: Array.isArray(sc.materials) ? sc.materials.length : 0,
      textures: textures.length,
      estimatedTextureMB: estimateTextureMB(textures),
      animationGroups: Array.isArray(sc.animationGroups) ? sc.animationGroups.length : 0,
      skeletons: Array.isArray(sc.skeletons) ? sc.skeletons.length : 0,
      particleSystems: Array.isArray(sc.particleSystems) ? sc.particleSystems.length : 0,
      lights: Array.isArray(sc.lights) ? sc.lights.length : 0,
      transformNodes: Array.isArray(sc.transformNodes) ? sc.transformNodes.length : 0,
      renderTargets: Math.max(customRts, texRts),
      observers: countObservers(sc),
      audioElements: docAudio + babylonSounds,
    };
  }

  function diffResources(cur, base) {
    if (!base) base = cur;
    const delta = {};
    for (const k of Object.keys(cur)) {
      delta[k] = r1((cur[k] || 0) - (base[k] || 0));
    }
    return delta;
  }

  function checkLeaks(fromLabel) {
    const sc = ensureScene();
    const cur = readResources(sc);
    const ref = (fromLabel && marks[fromLabel]?.counts) || baseline || cur;
    const refAt = (fromLabel && marks[fromLabel]?.at) || baselineAt || Date.now();
    const delta = diffResources(cur, ref);
    const notes = [];

    if (delta.meshes >= 25) notes.push(`Mesh leak: +${delta.meshes} meshes (${ref.meshes} -> ${cur.meshes}) not disposed`);
    if (delta.geometries >= 20) notes.push(`Geometry leak: +${delta.geometries} geometries (${ref.geometries} -> ${cur.geometries})`);
    if (delta.materials >= 15) notes.push(`Material leak: +${delta.materials} materials (${ref.materials} -> ${cur.materials})`);
    if (delta.textures >= 10 || delta.estimatedTextureMB >= 16) {
      notes.push(`Texture/VRAM growth: +${delta.textures} textures (+${delta.estimatedTextureMB} MB, now ${cur.estimatedTextureMB} MB)`);
    }
    if (delta.particleSystems >= 5) notes.push(`ParticleSystem leak: +${delta.particleSystems} active particle systems (${ref.particleSystems} -> ${cur.particleSystems})`);
    if (delta.animationGroups >= 10) notes.push(`AnimationGroup leak: +${delta.animationGroups} animation groups (${ref.animationGroups} -> ${cur.animationGroups})`);
    if (delta.observers >= 15) notes.push(`Observer leak: +${delta.observers} scene observers added without removal (${ref.observers} -> ${cur.observers})`);
    if (delta.audioElements >= 8) notes.push(`Audio leak: +${delta.audioElements} <audio>/sound instances (${ref.audioElements} -> ${cur.audioElements})`);
    if (delta.transformNodes >= 30) notes.push(`TransformNode leak: +${delta.transformNodes} transform nodes (${ref.transformNodes} -> ${cur.transformNodes})`);

    return {
      leaked: notes.length > 0,
      from: fromLabel || 'baseline',
      baselineAgeSec: r1(Math.max(0, (Date.now() - refAt) / 1000)),
      current: cur,
      baseline: ref,
      delta,
      notes,
    };
  }

  function buildSuspects(fps, timing, geo, audit, leaks) {
    const suspects = [];

    // 1. Frame rate & timing bottlenecks
    if (fps.current > 0 && fps.current < 45) {
      suspects.push(`Low FPS (${fps.current} fps, worst ${fps.worst} fps, ${fps.jankFrames} jank frames >33.3ms; frame time ${timing.frameMs}ms)`);
    }
    if (timing.activeMeshesEvalMs >= 4) {
      suspects.push(`CPU bottleneck in active-mesh evaluation (${timing.activeMeshesEvalMs}ms/frame across ${geo.totalMeshes} meshes; freeze static world matrices or use octrees)`);
    }
    if (timing.renderTargetsMs >= 4) {
      suspects.push(`Extra render passes taking ${timing.renderTargetsMs}ms/frame (${geo.renderPasses.length} active passes)`);
    }
    if (timing.animationsMs >= 4) {
      suspects.push(`Heavy skeleton/animation evaluation (${timing.animationsMs}ms/frame across ${geo.skinnedMeshes} skinned meshes, ${geo.activeBones} bones)`);
    }
    if (timing.particlesMs >= 3) {
      suspects.push(`Heavy particle simulation/rendering (${timing.particlesMs}ms/frame)`);
    }

    // 2. High-poly meshes & total triangle budget
    const topMesh = geo.topHeavyMeshes[0];
    if (topMesh && topMesh.tris >= 40_000) {
      suspects.push(`High-poly mesh "${topMesh.name}" has ${fmtK(topMesh.tris)} tris (${fmtK(topMesh.verts)} verts${topMesh.skinned ? `, skinned ${topMesh.bones} bones` : ''}${topMesh.castsShadow ? ', casts shadow' : ''})`);
    }
    if (geo.activeTris >= 250_000) {
      suspects.push(`High active triangle count: ${fmtK(geo.activeTris)} active tris (${fmtK(geo.totalTris)} total scene tris)`);
    }

    // 3. Shadow-map triangle bloat & full-scene passes
    if (geo.shadowTris >= 80_000) {
      suspects.push(`Shadow-map triangle bloat: ${fmtK(geo.shadowTris)} tris rendered into shadow maps each frame`);
    }
    for (const p of geo.renderPasses) {
      if (p.fullScene) {
        suspects.push(`Full-scene ${p.kind} "${p.name}" (${p.resolution}) has no restricted renderList/includedOnlyMeshes (re-evaluates all ${p.renderListCount} meshes)`);
      }
    }

    // 4. Draw call bloat, unmerged materials, unfrozen meshes/materials
    if (geo.drawCalls >= 150) {
      suspects.push(`High draw call count: ${geo.drawCalls} draw calls (${geo.activeMeshes} active meshes)`);
    }
    if (audit.unmergedMaterialGroups.length > 0) {
      const topG = audit.unmergedMaterialGroups[0];
      suspects.push(`Unmerged static meshes: material "${topG.material}" is drawn by ${topG.meshCount} separate meshes (${fmtK(topG.tris)} tris; use thin instances or MergeMeshes)`);
    }
    if (audit.unfrozenMeshes >= 80 && (geo.drawCalls >= 80 || timing.activeMeshesEvalMs >= 2 || fps.current < 55)) {
      suspects.push(`${audit.unfrozenMeshes} enabled meshes have unfrozen world matrices (call mesh.freezeWorldMatrix() on static props)`);
    }
    if (audit.unfrozenMaterials >= 25 && (geo.drawCalls >= 80 || fps.current < 55)) {
      suspects.push(`${audit.unfrozenMaterials} materials are unfrozen (call material.freeze() on static materials)`);
    }

    // 5. Per-frame material dirtying & shader recompiles
    if (audit.materialDirtyPerSec >= 10) {
      suspects.push(`Per-frame material/imageProcessing dirtying (${audit.materialDirtyPerSec} dirty updates/sec) causing uniform/shader thrashing`);
    }
    if (timing.shaderCompiles >= 5) {
      suspects.push(`${timing.shaderCompiles} shader compilations recorded (may cause frame hitches)`);
    }

    // 6. Excess lights
    if (audit.enabledLights > 4) {
      suspects.push(`Excess active lights: ${audit.enabledLights} enabled lights in scene (standard Babylon materials recompile/cap at 4 lights per mesh)`);
    }
    if (audit.zeroIntensityEnabledLights > 0) {
      suspects.push(`${audit.zeroIntensityEnabledLights} enabled light(s) have 0 intensity but still add shader cost (disable or dispose unused lights)`);
    }

    // 7. Resource & memory leaks
    for (const note of leaks.notes) {
      suspects.push(note);
    }

    return suspects;
  }

  function snapshot() {
    const sc = ensureScene();
    const { fps, timing } = readTiming(sc);
    const geo = readGeometryAndPasses(sc);
    const audit = readAudit(sc);
    const leaks = checkLeaks();
    const suspects = buildSuspects(fps, timing, geo, audit, leaks);
    const summaryText = `${fps.current} fps · ${geo.drawCalls} draws · ${fmtK(geo.activeTris)} tris${suspects.length ? ` · ⚠ ${suspects[0]}` : ''}`;

    return {
      version: PERF_MONITOR_VERSION,
      at: Date.now(),
      sceneAttached: Boolean(sc),
      fps,
      timing,
      drawCalls: geo.drawCalls,
      activeMeshes: geo.activeMeshes,
      totalMeshes: geo.totalMeshes,
      activeTris: geo.activeTris,
      totalTris: geo.totalTris,
      shadowTris: geo.shadowTris,
      skinnedMeshes: geo.skinnedMeshes,
      activeBones: geo.activeBones,
      thinInstanceMeshes: geo.thinInstanceMeshes,
      thinInstancesTotal: geo.thinInstancesTotal,
      renderPasses: geo.renderPasses,
      topHeavyMeshes: geo.topHeavyMeshes,
      unfrozenMeshes: audit.unfrozenMeshes,
      unfrozenMaterials: audit.unfrozenMaterials,
      enabledLights: audit.enabledLights,
      zeroIntensityEnabledLights: audit.zeroIntensityEnabledLights,
      unmergedMaterialGroups: audit.unmergedMaterialGroups,
      materialDirtyPerSec: audit.materialDirtyPerSec,
      resources: {
        current: leaks.current,
        baseline: leaks.baseline,
        delta: leaks.delta,
        baselineAgeSec: leaks.baselineAgeSec,
      },
      leaks: {
        leaked: leaks.leaked,
        notes: leaks.notes,
      },
      suspects,
      summary: summaryText,
    };
  }

  function summary() {
    return snapshot().summary;
  }

  function mark(label = 'mark') {
    const sc = ensureScene();
    const counts = readResources(sc);
    marks[String(label)] = { at: Date.now(), counts };
    if (!baseline) {
      baseline = counts;
      baselineAt = Date.now();
    }
    return counts;
  }

  function renderHud() {
    if (!hudEl) return;
    const s = snapshot();
    const lines = [
      `FPS: ${s.fps.current} (avg ${s.fps.avg}, worst ${s.fps.worst}, jank ${s.fps.jankFrames})`,
      `CPU: frame ${s.timing.frameMs}ms | eval ${s.timing.activeMeshesEvalMs}ms | RT ${s.timing.renderTargetsMs}ms | draw ${s.timing.mainRenderMs}ms | anim ${s.timing.animationsMs}ms`,
      `Draws: ${s.drawCalls} | Meshes: ${s.activeMeshes}/${s.totalMeshes} | Tris: ${fmtK(s.activeTris)}/${fmtK(s.totalTris)} (shadow ${fmtK(s.shadowTris)})`,
      `Skinned: ${s.skinnedMeshes} (${s.activeBones} bones) | Thin: ${s.thinInstanceMeshes} (${s.thinInstancesTotal}) | Passes: ${s.renderPasses.length}`,
      `Audit: unfrozen ${s.unfrozenMeshes}m/${s.unfrozenMaterials}mat | lights ${s.enabledLights} | dirty/s ${s.materialDirtyPerSec}`,
      `VRAM est: ${s.resources.current.estimatedTextureMB} MB (Δ${s.resources.delta.estimatedTextureMB >= 0 ? '+' : ''}${s.resources.delta.estimatedTextureMB} MB) | Δmeshes ${s.resources.delta.meshes >= 0 ? '+' : ''}${s.resources.delta.meshes}`,
    ];
    if (s.topHeavyMeshes.length) {
      lines.push(`Heavy: ${s.topHeavyMeshes.slice(0, 3).map((m) => `${m.name}(${fmtK(m.tris)})`).join(', ')}`);
    }
    if (s.suspects.length) {
      lines.push('--- Root-Cause Suspects ---');
      for (const sus of s.suspects.slice(0, 4)) lines.push(`⚠ ${sus}`);
    }
    hudEl.textContent = lines.join('\n');
  }

  function toggleHud(force) {
    if (typeof document === 'undefined') return false;
    const want = force !== undefined ? Boolean(force) : !hudEl;
    if (!want) {
      if (hudTimer) { clearInterval(hudTimer); hudTimer = 0; }
      if (hudEl) { hudEl.remove(); hudEl = null; }
      return false;
    }
    if (!hudEl) {
      hudEl = document.createElement('pre');
      hudEl.setAttribute('data-hawkes-perf-hud', '');
      hudEl.style.cssText = 'position:fixed;left:8px;top:8px;z-index:2147483645;margin:0;padding:8px 10px;border-radius:8px;background:#0e1014dd;color:#e9ecf1;border:1px solid #333a46;font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;pointer-events:none;max-width:min(520px,calc(100vw - 16px));white-space:pre-wrap;box-shadow:0 4px 16px #0008;';
      (document.body || document.documentElement).appendChild(hudEl);
    }
    renderHud();
    if (!hudTimer) hudTimer = setInterval(renderHud, 500);
    return true;
  }

  function dispose() {
    toggleHud(false);
    if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
    if (rafId && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(rafId); rafId = 0; }
    detachInstrumentation();
  }

  const api = {
    version: PERF_MONITOR_VERSION,
    attach,
    snapshot,
    summary,
    mark,
    checkLeaks,
    toggleHud,
    dispose,
  };

  if (win) win.hawkesPerf = api;
  return api;
}

// Auto-install on window if loaded directly as a script in a browser
if (typeof window !== 'undefined' && !window.hawkesPerf) {
  try {
    if (discoverBabylonScene(window)) installPerfMonitor();
  } catch {}
}
