// Hawkes Studio: the "report a bug" button on the beta sites (https://<sub>.hawkesgen.ai/, behind Studio's login).
// previews.ts puts it into every HTML page it publishes, with a tiny console hook at the top of <head>; it is never in a
// product repo or a live site. Served by the product's /dev/ front door as /dev/__studio/report.js (dev-front.ts);
// reports go to POST /dev/__studio/report (src/bugreport.ts), which makes them findings with source "J".
//
// The button is a small dot on the right edge (drag it up or down; "hide" shrinks it to a sliver). Tapping it takes the
// screenshot first (the moment J saw it), then opens the panel: type, or hold the mic to talk (the browser's speech
// recognition, where there is one), then send. Events inside it never reach the game.
//
// It also reports the page's uncaught errors by itself (window errors, unhandled rejections, console.error) to
// POST /dev/__studio/error: noise skipped, once per signature and at most 5 per tab session, with the same context as a
// report and the game's frame as the screenshot when there is one (never the whole page: nothing the player would
// notice). The only sign of it is a tiny "Error reported" toast.
//
// And it asks the front door which build beta serves now (GET /dev/__studio/build: on load, when the tab comes back,
// once, never on a timer): a page of an older build shows a small "New build: reload" prompt (Studio
// keeps the previous Unity build published, so the old page keeps working until J taps it).
(() => {
  if (window.__hawkesReport) return;
  try { if (window.top !== window) return; } catch { return; }
  window.__hawkesReport = true;
  const me = document.currentScript;
  let cfg = {};
  try { cfg = JSON.parse((me && me.getAttribute('data-hawkes')) || '{}'); } catch {}
  // A game on the shared sites. host lives under a path (cfg.root, e.g. /b/<game>): so do its endpoints.
  const ROOT = typeof cfg.root === 'string' ? cfg.root : '';
  // A project's own pages (reportkey.ts) post to their Studio's address with the project's key instead.
  const ENDPOINT = typeof cfg.endpoint === 'string' ? cfg.endpoint : ROOT + '/dev/__studio/report';
  const ERRORS = typeof cfg.errors === 'string' ? cfg.errors : ROOT + '/dev/__studio/error';
  const H2C = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  const store = {
    get(k, d) { try { const v = localStorage.getItem('hawkesReport.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('hawkesReport.' + k, JSON.stringify(v)); } catch {} },
  };

  // Console: the early hook (window.__hawkesLog, put at the top of <head>) catches what happens before this loads.
  // Uncaught errors go to autoError (below); the hook queues them in window.__hawkesErrs until then.
  const log = (window.__hawkesLog = window.__hawkesLog || []);
  const errs = (window.__hawkesErrs = window.__hawkesErrs || []);
  if (!window.__hawkesLogHooked) {
    window.__hawkesLogHooked = true;
    const str = (a, m) => { try { return a instanceof Error ? (m ? a.message : a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); } };
    const push = (level, args) => { try { log.push({ level, at: Date.now(), text: [...args].map((a) => str(a)).join(' ').slice(0, 400) }); if (log.length > 60) log.splice(0, log.length - 60); } catch {} };
    const caught = (kind, message, stack, source) => { const x = { kind, message: String(message || '').slice(0, 1000), stack: String(stack || '').slice(0, 3000), source: String(source || ''), at: Date.now() }; if (window.__hawkesOnError) window.__hawkesOnError(x); else errs.push(x); };
    for (const level of ['error', 'warn']) {
      const o = console[level];
      console[level] = function (...a) {
        push(level, a);
        if (level === 'error') try { caught('console', a.map((x) => str(x, true)).join(' '), (a.find((x) => x instanceof Error) || {}).stack); } catch {}
        return o.apply(this, a);
      };
    }
    addEventListener('error', (e) => { push('error', [e.message || 'error', e.filename ? `${e.filename}:${e.lineno}` : '']); caught('error', e.message || (e.error && e.error.message), (e.error && e.error.stack) || (e.filename ? `at ${e.filename}:${e.lineno}:${e.colno}` : ''), e.filename); });
    addEventListener('unhandledrejection', (e) => { push('error', ['unhandled rejection:', e.reason]); caught('rejection', str(e.reason, true), e.reason && e.reason.stack); });
  }

  // ------------------------------------------------------------- Babylon perf probe
  // Auto-attaches a Babylon.js performance & leak root-cause monitor if the game hasn't installed window.hawkesPerf yet,
  // so every Babylon beta page (icanbe, phorigins, doseofdestruction) gets diagnostics automatically.
  const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
  const fmtK = (n) => (n >= 1e6 ? `${r1(n / 1e6)}M` : n >= 1000 ? `${r1(n / 1000)}k` : String(Math.round(n || 0)));
  const isScene = (s) => Boolean(s && typeof s === 'object' && !s.isDisposed && (Array.isArray(s.meshes) || typeof s.getEngine === 'function'));
  const findBabylonScene = () => {
    try {
      const engines = window.BABYLON && window.BABYLON.Engine && window.BABYLON.Engine.Instances;
      if (Array.isArray(engines)) {
        for (let i = engines.length - 1; i >= 0; i--) {
          const scenes = engines[i] && engines[i].scenes;
          if (Array.isArray(scenes)) {
            for (let j = scenes.length - 1; j >= 0; j--) if (isScene(scenes[j])) return scenes[j];
          }
        }
      }
      const last = window.BABYLON && window.BABYLON.Engine && window.BABYLON.Engine.LastCreatedScene;
      if (isScene(last)) return last;
      const dayScene = window.day && (typeof window.day.world === 'function' ? window.day.world() && window.day.world().scene : window.day.world && window.day.world.scene);
      if (isScene(dayScene)) return dayScene;
      for (const c of [window.__babylonScene, window.scene, window.game && window.game.scene]) if (isScene(c)) return c;
    } catch {}
    return null;
  };
  function installAutoPerf(initialScene) {
    if (window.hawkesPerf) return window.hawkesPerf;
    let scene = initialScene || null;
    let sceneInst = null, engineInst = null;
    let baseline = null, baselineAt = 0;
    const marks = {};
    const frameTimes = [], fpsSamples = [];
    let rafFrames = 0, rafLast = performance.now(), lastFrame = rafLast, curFps = 60, jankFrames = 0;
    let dirtyWin = 0, dirtyT0 = rafLast, dirtyPerSec = 0;
    const hookedMats = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    let hookedIpc = null, hookedIpcObs = null;
    const obsT = { frameMs: 0, activeMeshesEvalMs: 0, renderTargetsMs: 0, mainRenderMs: 0, animationsMs: 0, particlesMs: 0 };
    let tf0 = 0, te0 = 0, tr0 = 0, td0 = 0, ta0 = 0, tp0 = 0;
    let hudEl = null, hudTimer = 0;

    const tick = (t) => {
      const dt = t - lastFrame;
      lastFrame = t;
      if (dt > 0 && dt < 5000) { frameTimes.push(dt); if (frameTimes.length > 120) frameTimes.shift(); if (dt > 33.3) jankFrames++; }
      rafFrames++;
      if (t - rafLast >= 1000) {
        curFps = Math.round((rafFrames * 1000) / (t - rafLast));
        fpsSamples.push(curFps); if (fpsSamples.length > 300) fpsSamples.shift();
        rafFrames = 0; rafLast = t;
        dirtyPerSec = r1(dirtyWin / Math.max(0.2, (t - dirtyT0) / 1000));
        dirtyWin = 0; dirtyT0 = t;
      }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tick);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tick);

    const meshTris = (m) => { try { const i = typeof m.getTotalIndices === 'function' ? m.getTotalIndices() : (m._totalIndices || 0); return i > 0 ? Math.round(i / 3) : 0; } catch { return 0; } };
    const meshVerts = (m) => { try { return typeof m.getTotalVertices === 'function' ? m.getTotalVertices() : (m._totalVertices || 0); } catch { return 0; } };
    const meshOn = (m) => { try { return m && (typeof m.isEnabled !== 'function' || m.isEnabled()) && m.isVisible !== false; } catch { return true; } };
    const countRes = (sc) => {
      const docAud = typeof document !== 'undefined' && document.querySelectorAll ? document.querySelectorAll('audio').length : 0;
      if (!sc) return { meshes: 0, geometries: 0, materials: 0, textures: 0, estimatedTextureMB: 0, animationGroups: 0, skeletons: 0, particleSystems: 0, lights: 0, transformNodes: 0, renderTargets: 0, observers: 0, audioElements: docAud };
      const texs = Array.isArray(sc.textures) ? sc.textures : [];
      let bytes = 0;
      const seenT = new Set();
      for (const tx of texs) {
        if (!tx) continue;
        const k = tx._texture || tx.uniqueId || tx;
        if (seenT.has(k)) continue;
        seenT.add(k);
        const sz = typeof tx.getSize === 'function' ? tx.getSize() : tx._size;
        const w = Number((sz && sz.width) || (tx._texture && tx._texture._width) || 0);
        const h = Number((sz && sz.height) || (tx._texture && tx._texture._height) || 0);
        if (w > 0 && h > 0) bytes += w * h * 4 * 1.33;
      }
      let obs = 0;
      for (const k of ['onBeforeRenderObservable', 'onAfterRenderObservable', 'onPointerObservable', 'onKeyboardObservable', 'onBeforeAnimationsObservable']) {
        const a = sc[k] && (sc[k].observers || sc[k]._observers);
        if (Array.isArray(a)) obs += a.length;
      }
      return {
        meshes: (sc.meshes && sc.meshes.length) || 0,
        geometries: (sc.geometries && sc.geometries.length) || 0,
        materials: (sc.materials && sc.materials.length) || 0,
        textures: texs.length,
        estimatedTextureMB: r1(bytes / (1024 * 1024)),
        animationGroups: (sc.animationGroups && sc.animationGroups.length) || 0,
        skeletons: (sc.skeletons && sc.skeletons.length) || 0,
        particleSystems: (sc.particleSystems && sc.particleSystems.length) || 0,
        lights: (sc.lights && sc.lights.length) || 0,
        transformNodes: (sc.transformNodes && sc.transformNodes.length) || 0,
        renderTargets: Math.max((sc.customRenderTargets && sc.customRenderTargets.length) || 0, texs.filter((t) => t && t.isRenderTarget).length),
        observers: obs,
        audioElements: docAud + ((sc.mainSoundTrack && sc.mainSoundTrack.soundCollection && sc.mainSoundTrack.soundCollection.length) || 0),
      };
    };
    const hookDirty = (sc) => {
      if (!sc) return;
      try {
        const ipc = sc.imageProcessingConfiguration;
        if (ipc && ipc !== hookedIpc && ipc.onUpdateParameters && ipc.onUpdateParameters.add) {
          hookedIpc = ipc;
          hookedIpcObs = ipc.onUpdateParameters.add(() => { dirtyWin++; });
        }
        for (const m of sc.materials || []) {
          if (!m || !hookedMats || hookedMats.has(m)) continue;
          hookedMats.add(m);
          if (typeof m.markAsDirty === 'function') {
            const o = m.markAsDirty;
            m.markAsDirty = function (...a) { dirtyWin++; return o.apply(this, a); };
          }
        }
      } catch {}
    };
    const attach = (sc) => {
      if (!isScene(sc)) return false;
      if (scene === sc && (sceneInst || baseline)) return true;
      scene = sc;
      const B = window.BABYLON;
      const eng = typeof sc.getEngine === 'function' ? sc.getEngine() : sc._engine;
      try {
        if (B && typeof B.SceneInstrumentation === 'function') {
          sceneInst = new B.SceneInstrumentation(sc);
          sceneInst.captureFrameTime = true;
          sceneInst.captureActiveMeshesEvaluationTime = true;
          sceneInst.captureRenderTargetsRenderTime = true;
          sceneInst.captureAnimationsTime = true;
          sceneInst.captureParticlesRenderTime = true;
        }
      } catch {}
      try {
        if (B && typeof B.EngineInstrumentation === 'function' && eng) {
          engineInst = new B.EngineInstrumentation(eng);
          engineInst.captureGPUFrameTime = true;
          engineInst.captureShaderCompilationTime = true;
        }
      } catch {}
      const addO = (ob, fn) => { try { if (ob && typeof ob.add === 'function') ob.add(fn); } catch {} };
      addO(sc.onBeforeRenderObservable, () => { tf0 = performance.now(); obsT.renderTargetsMs = 0; obsT.mainRenderMs = 0; });
      addO(sc.onAfterRenderObservable, () => { if (tf0) obsT.frameMs = r1(performance.now() - tf0); });
      addO(sc.onBeforeActiveMeshesEvaluationObservable, () => { te0 = performance.now(); });
      addO(sc.onAfterActiveMeshesEvaluationObservable, () => { if (te0) obsT.activeMeshesEvalMs = r1(performance.now() - te0); });
      addO(sc.onBeforeRenderTargetsRenderObservable, () => { tr0 = performance.now(); });
      addO(sc.onAfterRenderTargetsRenderObservable, () => { if (tr0) obsT.renderTargetsMs = r1(obsT.renderTargetsMs + (performance.now() - tr0)); });
      addO(sc.onBeforeDrawPhaseObservable, () => { td0 = performance.now(); });
      addO(sc.onAfterDrawPhaseObservable, () => { if (td0) obsT.mainRenderMs = r1(obsT.mainRenderMs + (performance.now() - td0)); });
      addO(sc.onBeforeAnimationsObservable, () => { ta0 = performance.now(); });
      addO(sc.onAfterAnimationsObservable, () => { if (ta0) obsT.animationsMs = r1(performance.now() - ta0); });
      addO(sc.onBeforeParticlesRenderingObservable, () => { tp0 = performance.now(); });
      addO(sc.onAfterParticlesRenderingObservable, () => { if (tp0) obsT.particlesMs = r1(performance.now() - tp0); });
      hookDirty(sc);
      baseline = countRes(sc);
      baselineAt = Date.now();
      return true;
    };
    if (scene) attach(scene);

    const checkLeaks = (fromLabel) => {
      const sc = isScene(scene) ? scene : findBabylonScene();
      if (sc && sc !== scene) attach(sc);
      const cur = countRes(scene);
      const ref = (fromLabel && marks[fromLabel] && marks[fromLabel].counts) || baseline || cur;
      const refAt = (fromLabel && marks[fromLabel] && marks[fromLabel].at) || baselineAt || Date.now();
      const delta = {};
      for (const k of Object.keys(cur)) delta[k] = r1((cur[k] || 0) - (ref[k] || 0));
      const notes = [];
      if (delta.meshes >= 25) notes.push(`Mesh leak: +${delta.meshes} meshes (${ref.meshes} -> ${cur.meshes})`);
      if (delta.geometries >= 20) notes.push(`Geometry leak: +${delta.geometries} geometries`);
      if (delta.materials >= 15) notes.push(`Material leak: +${delta.materials} materials`);
      if (delta.textures >= 10 || delta.estimatedTextureMB >= 16) notes.push(`Texture/VRAM growth: +${delta.textures} textures (+${delta.estimatedTextureMB} MB)`);
      if (delta.particleSystems >= 5) notes.push(`ParticleSystem leak: +${delta.particleSystems} systems`);
      if (delta.observers >= 15) notes.push(`Observer leak: +${delta.observers} scene observers`);
      if (delta.audioElements >= 8) notes.push(`Audio leak: +${delta.audioElements} audio instances`);
      return { leaked: notes.length > 0, from: fromLabel || 'baseline', baselineAgeSec: r1(Math.max(0, (Date.now() - refAt) / 1000)), current: cur, baseline: ref, delta, notes };
    };

    const snapshot = () => {
      const sc = isScene(scene) ? scene : findBabylonScene();
      if (sc && sc !== scene) attach(sc);
      hookDirty(sc);
      const eng = sc && (typeof sc.getEngine === 'function' ? sc.getEngine() : sc._engine);
      const engFps = eng && typeof eng.getFps === 'function' ? Math.round(eng.getFps()) : curFps;
      const avgDt = frameTimes.length ? frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length : (1000 / Math.max(1, engFps));
      const fps = {
        current: engFps || curFps,
        avg: fpsSamples.length ? Math.round(fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length) : (engFps || curFps),
        worst: fpsSamples.length ? Math.min(...fpsSamples, engFps || curFps) : (engFps || curFps),
        jankFrames: Math.max(jankFrames, frameTimes.filter((d) => d > 33.3).length),
        frameMs: r1(avgDt),
      };
      const cMs = (c, fb) => r1((c && (c.average || c.current)) || fb || 0);
      const timing = {
        frameMs: cMs(sceneInst && sceneInst.frameTimeCounter, obsT.frameMs || avgDt),
        activeMeshesEvalMs: cMs(sceneInst && sceneInst.activeMeshesEvaluationTimeCounter, obsT.activeMeshesEvalMs),
        renderTargetsMs: cMs(sceneInst && sceneInst.renderTargetsRenderTimeCounter, obsT.renderTargetsMs),
        mainRenderMs: r1(obsT.mainRenderMs),
        animationsMs: cMs(sceneInst && sceneInst.animationsTimeCounter, obsT.animationsMs),
        particlesMs: cMs(sceneInst && sceneInst.particlesRenderTimeCounter, obsT.particlesMs),
        gpuFrameMs: r1(engineInst && engineInst.gpuFrameTimeCounter ? (engineInst.gpuFrameTimeCounter.average || engineInst.gpuFrameTimeCounter.current || 0) * 1e-6 : 0),
        shaderCompiles: Math.round((engineInst && engineInst.shaderCompilationTimeCounter && engineInst.shaderCompilationTimeCounter.count) || 0),
      };
      const meshes = (sc && Array.isArray(sc.meshes)) ? sc.meshes : [];
      const actRaw = sc && (typeof sc.getActiveMeshes === 'function' ? (sc.getActiveMeshes() && (sc.getActiveMeshes().data || sc.getActiveMeshes())) : (sc._activeMeshes && (sc._activeMeshes.data || sc._activeMeshes)));
      const actArr = Array.isArray(actRaw) ? actRaw.filter(Boolean) : [];
      const actSet = new Set(actArr);
      const shadowCasters = new Set();
      let shadowTris = 0;
      const renderPasses = [];
      const seenRt = new Set();
      for (const l of (sc && sc.lights) || []) {
        if (!l) continue;
        const sg = typeof l.getShadowGenerator === 'function' ? l.getShadowGenerator() : null;
        if (!sg) continue;
        const map = typeof sg.getShadowMap === 'function' ? sg.getShadowMap() : sg._shadowMap;
        if (map) seenRt.add(map);
        const rl = map ? map.renderList : sg.renderList;
        const full = rl == null;
        let pTris = 0;
        for (const cm of (Array.isArray(rl) ? rl : (full ? meshes : []))) {
          if (!cm) continue;
          shadowCasters.add(cm);
          pTris += meshTris(cm) * Math.max(1, cm.thinInstanceCount || 1);
        }
        shadowTris += pTris;
        const sz = map && typeof map.getSize === 'function' ? map.getSize() : null;
        renderPasses.push({ name: sg.id || l.name || 'ShadowGenerator', kind: 'ShadowGenerator', resolution: sz ? `${sz.width}x${sz.height}` : '?', renderListCount: Array.isArray(rl) ? rl.length : meshes.length, fullScene: full, tris: pTris });
      }
      for (const el of (sc && sc.effectLayers) || []) {
        if (!el) continue;
        const tx = el._mainTexture || el.mainTexture;
        if (tx) seenRt.add(tx);
        const cn = (typeof el.getClassName === 'function' && el.getClassName()) || 'EffectLayer';
        const custom = Boolean(Array.isArray(el._includedOnlyMeshes) && el._includedOnlyMeshes.length > 0);
        renderPasses.push({ name: el.name || cn, kind: /glow/i.test(cn) ? 'GlowLayer' : cn, resolution: 'auto', renderListCount: custom ? el._includedOnlyMeshes.length : meshes.length, fullScene: !custom });
      }
      for (const rt of [...((sc && sc.customRenderTargets) || []), ...(((sc && sc.textures) || []).filter((t) => t && t.isRenderTarget))]) {
        if (!rt || seenRt.has(rt)) continue;
        seenRt.add(rt);
        const cn = (typeof rt.getClassName === 'function' && rt.getClassName()) || 'RenderTargetTexture';
        const kind = /mirror/i.test(cn) || rt.mirrorPlane ? 'MirrorTexture' : 'RenderTargetTexture';
        const rl = rt.renderList;
        const sz = typeof rt.getSize === 'function' ? rt.getSize() : rt._size;
        renderPasses.push({ name: rt.name || kind, kind, resolution: sz ? `${sz.width || sz}x${sz.height || sz}` : '?', renderListCount: Array.isArray(rl) ? rl.length : meshes.length, fullScene: rl == null });
      }
      let totalTris = 0, compActTris = 0, skinnedMeshes = 0, compBones = 0, thinInstanceMeshes = 0, thinInstancesTotal = 0, unfrozenMeshes = 0;
      const skels = new Set(), heavy = [], matGroups = new Map();
      for (let i = 0; i < meshes.length; i++) {
        const m = meshes[i];
        if (!m) continue;
        const bt = meshTris(m), thin = Number(m.thinInstanceCount) || 0, et = bt * Math.max(1, thin);
        totalTris += et;
        const on = meshOn(m);
        if (actSet.size ? actSet.has(m) : on) compActTris += et;
        if (on && !m.isWorldMatrixFrozen && !m._isWorldMatrixFrozen) unfrozenMeshes++;
        const sk = m.skeleton, isSk = Boolean(sk && (m.numBoneInfluencers ?? 4) > 0), bCount = (sk && Array.isArray(sk.bones)) ? sk.bones.length : 0;
        if (isSk) { skinnedMeshes++; if (!skels.has(sk)) { skels.add(sk); compBones += bCount; } }
        if (thin > 0) { thinInstanceMeshes++; thinInstancesTotal += thin; }
        if (et > 0 || meshVerts(m) > 0) heavy.push({ name: m.name || m.id || `mesh_${i}`, tris: et, verts: meshVerts(m), skinned: isSk, bones: bCount, thin, castsShadow: shadowCasters.has(m) });
        const inst = Boolean((m.instances && m.instances.length > 0) || thin > 0 || m.isAnInstance);
        if (m.material && !inst && !isSk && on && bt > 0) {
          const mk = m.material.name || m.material.id || 'unnamed';
          const g = matGroups.get(mk) || { material: mk, meshCount: 0, tris: 0 };
          g.meshCount++; g.tris += bt; matGroups.set(mk, g);
        }
      }
      heavy.sort((a, b) => b.tris - a.tris);
      const topHeavyMeshes = heavy.slice(0, 5);
      const unmergedMaterialGroups = [...matGroups.values()].filter((g) => g.meshCount >= 10).sort((a, b) => b.meshCount - a.meshCount);
      const unfrozenMaterials = ((sc && sc.materials) || []).filter((m) => m && !m.isFrozen && !m._isFrozen).length;
      let enabledLights = 0, zeroIntensityEnabledLights = 0;
      for (const l of (sc && sc.lights) || []) {
        if (!l) continue;
        if (typeof l.isEnabled !== 'function' || l.isEnabled()) { enabledLights++; if ((l.intensity ?? 1) <= 0.001) zeroIntensityEnabledLights++; }
      }
      const rawActIdx = sc && typeof sc.getActiveIndices === 'function' ? sc.getActiveIndices() : 0;
      const activeTris = rawActIdx > 0 ? Math.round(rawActIdx / 3) : compActTris;
      const activeBones = (sc && typeof sc.getActiveBones === 'function' && sc.getActiveBones() > 0) ? sc.getActiveBones() : compBones;
      const drawCalls = Math.round((sceneInst && sceneInst.drawCallsCounter && sceneInst.drawCallsCounter.current) ?? (eng && eng._drawCalls && eng._drawCalls.current) ?? (actArr.length || 0));
      const activeMeshes = actArr.length || meshes.filter(meshOn).length;
      const liveDirty = Math.max(dirtyPerSec, dirtyWin > 0 ? r1(dirtyWin / Math.max(0.25, (performance.now() - dirtyT0) / 1000)) : 0);
      const leaks = checkLeaks();
      const suspects = [];
      if (fps.current > 0 && fps.current < 45) suspects.push(`Low FPS (${fps.current} fps, worst ${fps.worst} fps, ${fps.jankFrames} jank frames >33.3ms)`);
      if (timing.activeMeshesEvalMs >= 4) suspects.push(`CPU bottleneck in active-mesh evaluation (${timing.activeMeshesEvalMs}ms/frame across ${meshes.length} meshes)`);
      if (timing.renderTargetsMs >= 4) suspects.push(`Extra render passes taking ${timing.renderTargetsMs}ms/frame (${renderPasses.length} passes)`);
      if (topHeavyMeshes[0] && topHeavyMeshes[0].tris >= 40000) suspects.push(`High-poly mesh "${topHeavyMeshes[0].name}" has ${fmtK(topHeavyMeshes[0].tris)} tris (${fmtK(topHeavyMeshes[0].verts)} verts)`);
      if (activeTris >= 250000) suspects.push(`High active triangle count: ${fmtK(activeTris)} active tris`);
      if (shadowTris >= 80000) suspects.push(`Shadow-map triangle bloat: ${fmtK(shadowTris)} shadow caster tris`);
      for (const p of renderPasses) if (p.fullScene) suspects.push(`Full-scene ${p.kind} "${p.name}" (${p.resolution}) has no restricted renderList`);
      if (drawCalls >= 150) suspects.push(`High draw call count: ${drawCalls} draw calls`);
      if (unmergedMaterialGroups[0]) suspects.push(`Unmerged static meshes: "${unmergedMaterialGroups[0].material}" drawn by ${unmergedMaterialGroups[0].meshCount} separate meshes`);
      if (unfrozenMeshes >= 80 && (drawCalls >= 80 || fps.current < 55)) suspects.push(`${unfrozenMeshes} enabled meshes have unfrozen world matrices`);
      if (liveDirty >= 10) suspects.push(`Per-frame material/imageProcessing dirtying (${liveDirty}/sec)`);
      if (enabledLights > 4) suspects.push(`Excess active lights: ${enabledLights} enabled lights`);
      if (zeroIntensityEnabledLights > 0) suspects.push(`${zeroIntensityEnabledLights} enabled light(s) have 0 intensity`);
      for (const n of leaks.notes) suspects.push(n);
      const summaryText = `${fps.current} fps · ${drawCalls} draws · ${fmtK(activeTris)} tris${suspects.length ? ` · ⚠ ${suspects[0]}` : ''}`;
      return {
        version: 1, at: Date.now(), sceneAttached: Boolean(sc), fps, timing,
        drawCalls, activeMeshes, totalMeshes: meshes.length, activeTris, totalTris, shadowTris,
        skinnedMeshes, activeBones, thinInstanceMeshes, thinInstancesTotal,
        renderPasses, topHeavyMeshes, unfrozenMeshes, unfrozenMaterials, enabledLights, zeroIntensityEnabledLights,
        unmergedMaterialGroups, materialDirtyPerSec: liveDirty,
        resources: { current: leaks.current, baseline: leaks.baseline, delta: leaks.delta, baselineAgeSec: leaks.baselineAgeSec },
        leaks: { leaked: leaks.leaked, notes: leaks.notes }, suspects, summary: summaryText,
      };
    };
    const toggleHud = (force) => {
      const want = force !== undefined ? Boolean(force) : !hudEl;
      if (!want) { if (hudTimer) { clearInterval(hudTimer); hudTimer = 0; } if (hudEl) { hudEl.remove(); hudEl = null; } return false; }
      if (!hudEl) {
        hudEl = document.createElement('pre');
        hudEl.style.cssText = 'position:fixed;left:8px;top:8px;z-index:2147483645;margin:0;padding:8px 10px;border-radius:8px;background:#0e1014dd;color:#e9ecf1;border:1px solid #333a46;font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;pointer-events:none;max-width:min(520px,calc(100vw - 16px));white-space:pre-wrap;box-shadow:0 4px 16px #0008;';
        (document.body || document.documentElement).appendChild(hudEl);
      }
      const paint = () => {
        if (!hudEl) return;
        const s = snapshot();
        hudEl.textContent = [
          `FPS: ${s.fps.current} (avg ${s.fps.avg}, worst ${s.fps.worst}, jank ${s.fps.jankFrames}) | CPU ${s.timing.frameMs}ms`,
          `Draws: ${s.drawCalls} | Meshes: ${s.activeMeshes}/${s.totalMeshes} | Tris: ${fmtK(s.activeTris)}/${fmtK(s.totalTris)} (shadow ${fmtK(s.shadowTris)})`,
          `Unfrozen: ${s.unfrozenMeshes}m/${s.unfrozenMaterials}mat | Lights: ${s.enabledLights} | Dirty/s: ${s.materialDirtyPerSec} | VRAM: ${s.resources.current.estimatedTextureMB}MB`,
          ...(s.suspects.slice(0, 4).map((x) => `⚠ ${x}`)),
        ].join('\n');
      };
      paint();
      if (!hudTimer) hudTimer = setInterval(paint, 500);
      return true;
    };
    const api = {
      version: 1, attach, snapshot,
      summary: () => snapshot().summary,
      mark: (label = 'mark') => { const c = countRes(scene || findBabylonScene()); marks[String(label)] = { at: Date.now(), counts: c }; return c; },
      checkLeaks, toggleHud,
    };
    window.hawkesPerf = api;
    return api;
  }
  const ensurePerfProbe = () => {
    if (window.hawkesPerf) return window.hawkesPerf;
    const sc = findBabylonScene();
    return sc ? installAutoPerf(sc) : null;
  };
  let probeTries = 0;
  const probeTimer = setInterval(() => {
    if (ensurePerfProbe() || ++probeTries >= 60) clearInterval(probeTimer);
  }, 1000);

  // ------------------------------------------------------------- the button
  const host = document.createElement('div');
  host.setAttribute('data-hawkes-report', '');
  host.style.cssText = 'position:fixed;right:0;z-index:2147483646;top:0;width:0;height:0;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
  :host { all: initial; }
  * { box-sizing: border-box; font: 14px/1.35 system-ui, -apple-system, Segoe UI, sans-serif; }
  .dot { position: fixed; right: 6px; width: 38px; height: 38px; border-radius: 50%; border: 0; padding: 0; cursor: pointer;
    background: #c62f3c; color: #fff; font-size: 18px; box-shadow: 0 2px 8px #0007; opacity: .55; touch-action: none; user-select: none; -webkit-user-select: none; }
  .dot:hover, .dot:focus-visible { opacity: 1; }
  .dot.hidden { width: 9px; height: 34px; right: 0; border-radius: 6px 0 0 6px; font-size: 0; opacity: .45; }
  .panel { position: fixed; right: 8px; width: min(360px, calc(100vw - 16px)); background: #16181d; color: #e9ecf1; border-radius: 12px;
    box-shadow: 0 6px 28px #000a; padding: 12px; display: none; max-height: calc(100vh - 16px); overflow: auto; }
  .panel.open { display: block; }
  .row { display: flex; gap: 8px; align-items: center; }
  .top { justify-content: space-between; margin-bottom: 8px; }
  .top b { font-weight: 600; }
  .x { background: none; border: 0; color: #9aa3b2; font-size: 20px; cursor: pointer; padding: 0 4px; }
  textarea { width: 100%; min-height: 84px; resize: vertical; border-radius: 8px; border: 1px solid #333a46; background: #0e1014; color: #e9ecf1; padding: 8px; font-size: 16px; }
  .shot { position: relative; margin: 8px 0; }
  .shot img { max-width: 100%; max-height: 120px; border-radius: 6px; display: block; border: 1px solid #333a46; }
  .shot button { position: absolute; top: 4px; left: 4px; background: #000a; color: #fff; border: 0; border-radius: 6px; font-size: 12px; padding: 2px 6px; cursor: pointer; }
  .btn { border: 0; border-radius: 8px; padding: 10px 14px; cursor: pointer; background: #2a303b; color: #e9ecf1; font-weight: 600; }
  .send { background: #3b82f6; color: #fff; flex: 1; }
  .mic { flex: 1; touch-action: none; user-select: none; -webkit-user-select: none; }
  .mic.on { background: #c62f3c; color: #fff; }
  .btn:disabled { opacity: .5; cursor: default; }
  label { display: flex; gap: 6px; align-items: center; color: #9aa3b2; font-size: 13px; margin: 8px 0; }
  .msg { margin-top: 8px; font-size: 13px; color: #9aa3b2; min-height: 1em; white-space: pre-wrap; }
  .msg.ok { color: #7ee2a1; } .msg.err { color: #ff8b8b; }
  .foot { margin-top: 6px; display: flex; justify-content: space-between; font-size: 12px; color: #6b7382; }
  .foot a { color: #9aa3b2; cursor: pointer; text-decoration: underline; }
  .toast { position: fixed; left: 8px; bottom: 8px; padding: 3px 8px; border-radius: 6px; background: #000a; color: #e9ecf1; font-size: 11px;
    pointer-events: none; opacity: 0; transition: opacity .3s; }
  .toast.on { opacity: .8; }
  .fresh { position: fixed; left: 50%; top: 8px; transform: translateX(-50%); display: none; align-items: center; gap: 2px; border-radius: 999px;
    background: #16181dee; color: #e9ecf1; box-shadow: 0 2px 10px #0008; font-size: 13px; }
  .fresh.on { display: flex; }
  .fresh button { background: none; border: 0; color: inherit; cursor: pointer; padding: 6px 10px; font-size: 13px; }
  .fresh .go { font-weight: 600; color: #8fc1ff; padding-right: 4px; }
  .fresh .no { color: #9aa3b2; padding-left: 4px; }
  .perf { display: none; margin: 8px 0; padding: 6px 8px; border-radius: 8px; background: #0e1014; border: 1px solid #28303d; font-size: 12px; color: #c9d1dc; }
  .perf.on { display: block; }
  .perf-bar { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
  .perf-sum { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; }
  .perf-warn { color: #fbbf24; margin-top: 4px; font-size: 11px; line-height: 1.3; }
  .perf-acts { display: flex; gap: 4px; flex-shrink: 0; }
  .perf-acts button { background: #232934; border: 1px solid #333a46; color: #c9d1dc; border-radius: 5px; padding: 2px 6px; font-size: 11px; cursor: pointer; }
  .perf-pre { display: none; margin: 6px 0 0; padding: 6px; border-radius: 6px; background: #16181d; border: 1px solid #28303d; font: 10.5px/1.35 ui-monospace, SFMono-Regular, Consolas, monospace; color: #9aa3b2; max-height: 140px; overflow: auto; white-space: pre-wrap; }
  .perf-pre.on { display: block; }
  </style>
  <div class="toast" aria-hidden="true">Error reported</div>
  <div class="fresh" role="status"><button class="go" type="button">New build: reload</button><button class="no" type="button" aria-label="Not now">×</button></div>
  <button class="dot" title="Report a bug (Hawkes Studio, beta only)" aria-label="Report a bug">🐞</button>
  <div class="panel" role="dialog" aria-label="Report a bug">
    <div class="row top"><b>Report a bug</b><button class="x" aria-label="Close">×</button></div>
    <textarea placeholder="What's wrong? (what you did, what you expected)"></textarea>
    <div class="shot"></div>
    <div class="perf"><div class="perf-bar"><span class="perf-sum"></span><span class="perf-acts"><button type="button" class="perf-inspect">Inspect</button><button type="button" class="perf-copy">Copy</button><button type="button" class="perf-hud">HUD</button></span></div><div class="perf-warn"></div><pre class="perf-pre"></pre></div>
    <label><input type="checkbox" class="block"> It blocks me (can't go on)</label>
    <div class="row"><button class="btn mic" type="button">🎙 Hold to talk</button><button class="btn send" type="button">Send</button></div>
    <div class="msg"></div>
    <div class="foot"><span class="info"></span><a class="hide">hide button</a></div>
  </div>`;
  const $ = (s) => root.querySelector(s);
  const dot = $('.dot'), panel = $('.panel'), ta = $('textarea'), shotBox = $('.shot'), msg = $('.msg'), send = $('.send'), mic = $('.mic');
  const perfBox = $('.perf'), perfSum = $('.perf-sum'), perfWarn = $('.perf-warn'), perfPre = $('.perf-pre');
  $('.info').textContent = [cfg.ref, cfg.sha].filter(Boolean).join(' ') || 'beta';

  let perfUiTimer = 0;
  const formatPerfPre = (s) => {
    if (!s) return '';
    const lines = [
      `FPS: ${s.fps?.current ?? '?'} (avg ${s.fps?.avg ?? '?'}, worst ${s.fps?.worst ?? '?'}, jank ${s.fps?.jankFrames ?? 0})`,
      `Timings: frame ${s.timing?.frameMs ?? 0}ms · eval ${s.timing?.activeMeshesEvalMs ?? 0}ms · RT ${s.timing?.renderTargetsMs ?? 0}ms · draw ${s.timing?.mainRenderMs ?? 0}ms · anim ${s.timing?.animationsMs ?? 0}ms`,
      `Draws: ${s.drawCalls ?? 0} · Meshes: ${s.activeMeshes ?? 0}/${s.totalMeshes ?? 0} · Tris: ${fmtK(s.activeTris)}/${fmtK(s.totalTris)} (shadow ${fmtK(s.shadowTris)})`,
      `Unfrozen: ${s.unfrozenMeshes ?? 0} meshes, ${s.unfrozenMaterials ?? 0} mats · Lights: ${s.enabledLights ?? 0} · Dirty/s: ${s.materialDirtyPerSec ?? 0}`,
    ];
    if (Array.isArray(s.topHeavyMeshes) && s.topHeavyMeshes.length) {
      lines.push(`Heavy meshes: ${s.topHeavyMeshes.map((m) => `${m.name} (${fmtK(m.tris)} tris)`).join(', ')}`);
    }
    if (Array.isArray(s.suspects) && s.suspects.length) {
      lines.push(`Suspects:\n  - ${s.suspects.join('\n  - ')}`);
    }
    return lines.join('\n');
  };
  const updatePerfBadge = () => {
    const p = ensurePerfProbe();
    if (!p || typeof p.snapshot !== 'function') { perfBox.classList.remove('on'); return; }
    try {
      const s = p.snapshot();
      if (!s || (!s.sceneAttached && !s.totalMeshes && !s.drawCalls)) { perfBox.classList.remove('on'); return; }
      perfBox.classList.add('on');
      perfSum.textContent = `${s.fps?.current ?? '?'} fps · ${s.drawCalls ?? 0} draws · ${fmtK(s.activeTris)} tris`;
      perfWarn.textContent = Array.isArray(s.suspects) && s.suspects.length ? `⚠ ${s.suspects[0]}` : '';
      perfWarn.style.display = perfWarn.textContent ? 'block' : 'none';
      if (perfPre.classList.contains('on')) perfPre.textContent = formatPerfPre(s);
    } catch { perfBox.classList.remove('on'); }
  };
  $('.perf-inspect').onclick = () => {
    const on = perfPre.classList.toggle('on');
    if (on) updatePerfBadge();
    place();
  };
  $('.perf-copy').onclick = () => {
    const p = ensurePerfProbe();
    if (!p || typeof p.snapshot !== 'function') return;
    try {
      const txt = JSON.stringify(p.snapshot(), null, 2);
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt);
      $('.perf-copy').textContent = 'Copied';
      setTimeout(() => { $('.perf-copy').textContent = 'Copy'; }, 1200);
    } catch {}
  };
  $('.perf-hud').onclick = () => {
    const p = ensurePerfProbe();
    if (p && typeof p.toggleHud === 'function') p.toggleHud();
  };

  // Nothing typed or tapped in here reaches the game (its listeners are on window/document).
  for (const t of ['keydown', 'keyup', 'keypress', 'pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend', 'touchmove', 'wheel', 'contextmenu']) {
    host.addEventListener(t, (e) => e.stopPropagation());
  }
  // And while a field in here has focus, keys beat everything on the page: window-capture listeners
  // (added after this one) never see them (stopImmediatePropagation), so game shortcuts and Unity's keyboard capture can't steal the typing.
  // Keys only: clicks and drags on the panel's own buttons still need to reach their handlers.
  const inModal = (e) => { const p = e.composedPath ? e.composedPath() : []; return p.indexOf(host) >= 0; };
  for (const t of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'compositionstart', 'compositionend']) {
    addEventListener(t, (e) => { if (inModal(e)) e.stopImmediatePropagation(); }, true);
    document.addEventListener(t, (e) => { if (inModal(e)) e.stopImmediatePropagation(); }, true);
  }
  // Unity WebGL grabs the whole keyboard (and preventDefaults it) unless told not to: off while the panel is open.
  let unityKeys;
  const unityCapture = (on) => {
    try {
      const w = window.WebGLInput || (window.Module && window.Module.WebGLInput) || (window.unityInstance && window.unityInstance.Module && window.unityInstance.Module.WebGLInput);
      if (!w) return;
      if (on) { if (unityKeys !== undefined) w.captureAllKeyboardInput = unityKeys; unityKeys = undefined; }
      else { if (unityKeys === undefined) unityKeys = w.captureAllKeyboardInput; w.captureAllKeyboardInput = false; }
    } catch {}
  };

  // Where it starts (until it's dragged): on phones a quarter of the way down, above the games' right-edge buttons (the
  // portal's ➕ spawn button sits at 40% on the right: J couldn't find the dot on it, 2026-10-24).
  const touch = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } })();
  let top = store.get('top', touch ? 0.24 : 0.42);
  let hidden = store.get('hidden', false);
  const place = () => {
    const y = Math.round(Math.max(8, Math.min(innerHeight - 46, top * innerHeight)));
    dot.style.top = y + 'px';
    dot.classList.toggle('hidden', hidden);
    const ph = panel.offsetHeight || 300;
    panel.style.top = Math.max(8, Math.min(innerHeight - ph - 8, y - 40)) + 'px';
  };
  addEventListener('resize', place);

  // Drag up and down the edge (a move of more than 6px is a drag, not a tap).
  let drag = null;
  dot.addEventListener('pointerdown', (e) => { drag = { y: e.clientY, moved: false }; dot.setPointerCapture(e.pointerId); });
  dot.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (Math.abs(e.clientY - drag.y) > 6) drag.moved = true;
    if (drag.moved) { top = Math.max(0, Math.min(1, (e.clientY - 19) / innerHeight)); place(); }
  });
  dot.addEventListener('pointerup', () => {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.moved) return store.set('top', top);
    if (hidden) { hidden = false; store.set('hidden', false); place(); return; }
    if (panel.classList.contains('open')) close(); else open();
  });
  dot.addEventListener('pointercancel', () => { drag = null; });
  $('.x').onclick = () => close();
  $('.hide').onclick = () => { close(); hidden = true; store.set('hidden', true); place(); };

  // ------------------------------------------------------------ screenshot
  let shot = null;
  let shotNote = null;
  const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);
  const toJpeg = (src, w, h) => {
    const k = Math.min(1, 1280 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    const g = c.getContext('2d');
    g.drawImage(src, 0, 0, c.width, c.height);
    // A WebGL canvas read at the wrong moment is all one color: no screenshot then.
    const px = g.getImageData(0, 0, c.width, c.height).data;
    let same = true;
    for (let i = 4; i < px.length && same; i += 4 * 97) same = px[i] === px[0] && px[i + 1] === px[1] && px[i + 2] === px[2] && px[i + 3] === px[3];
    return same ? null : c.toDataURL('image/jpeg', 0.72);
  };
  const loadH2c = () => window.html2canvas ? Promise.resolve(window.html2canvas) : new Promise((ok, bad) => {
    const s = document.createElement('script');
    s.src = H2C;
    s.onload = () => ok(window.html2canvas);
    s.onerror = bad;
    document.head.appendChild(s);
  });
  // The game's frame, read right after the game draws (our frame callback runs after its). The page's early hook
  // (bugreport.ts) makes WebGL keep its drawing buffer; a context it missed can read blank on a phone (iOS drops the
  // buffer once the frame is shown), so a few more frames before giving up.
  const readFrame = (game) => new Promise((ok) => {
    let n = 0;
    const once = () => { let f = null; try { f = toJpeg(game, game.width, game.height); } catch {} if (f || ++n >= 6) ok(f); else requestAnimationFrame(once); };
    requestAnimationFrame(once);
  });
  // A canvas game: its biggest visible canvas (at least a quarter of the screen), else null.
  const gameCanvas = () => {
    const canvases = [...document.querySelectorAll('canvas')].map((c) => ({ c, r: c.getBoundingClientRect() })).filter((x) => x.c.width && x.c.height && area(x.r) > 0).sort((a, b) => area(b.r) - area(a.r));
    return canvases[0] && area(canvases[0].r) >= 0.25 * innerWidth * innerHeight ? canvases[0].c : null;
  };
  async function capture() {
    const game = gameCanvas();
    const frame = game ? await readFrame(game) : null;
    // No frame: the page alone, with a plain box where the game is (never an all-black picture), and a note in the report.
    const note = game && !frame ? "game frame couldn't be captured (its canvas read as one flat color); the screenshot is the page around it" : null;
    // The page as J sees it (html2canvas, loaded only now), with the game's frame in place of its canvas (a WebGL
    // canvas reads blank outside its frame), so HUDs and menus drawn in HTML are in the picture too.
    try {
      const h2c = await loadH2c();
      if (game) game.setAttribute('data-hawkes-shot', '');
      const late = new Promise((ok) => setTimeout(() => ok(null), 6000)); // a heavy page: the game's frame alone
      const c = await Promise.race([late, h2c(document.body, {
        logging: false, useCORS: true, x: scrollX, y: scrollY, width: innerWidth, height: innerHeight, scale: Math.min(devicePixelRatio || 1, 1280 / innerWidth),
        ignoreElements: (el) => el === host,
        onclone: (doc) => {
          const cv = doc.querySelector('canvas[data-hawkes-shot]');
          if (!cv) return;
          const img = doc.createElement(frame ? 'img' : 'div');
          if (frame) img.src = frame;
          img.style.cssText = cv.style.cssText;
          img.className = cv.className;
          const r = game.getBoundingClientRect();
          img.style.width = r.width + 'px';
          img.style.height = r.height + 'px';
          if (!frame) {
            img.style.background = '#2a2f38';
            img.style.color = '#c9d1dc';
            img.style.display = 'flex';
            img.style.alignItems = 'center';
            img.style.justifyContent = 'center';
            img.style.font = '16px system-ui, sans-serif';
            img.textContent = "Game frame couldn't be captured";
          }
          cv.replaceWith(img);
        },
      })]);
      return { shot: (c && toJpeg(c, c.width, c.height)) || frame, note };
    } catch { return { shot: frame, note }; } finally { if (game) game.removeAttribute('data-hawkes-shot'); }
  }
  const showShot = () => {
    shotBox.innerHTML = '';
    if (!shot) { shotBox.textContent = ''; return; }
    const img = document.createElement('img');
    img.src = shot;
    img.alt = 'screenshot';
    const rm = document.createElement('button');
    rm.textContent = 'remove';
    rm.onclick = () => { shot = null; shotNote = null; showShot(); };
    shotBox.append(img, rm);
  };

  async function open() {
    msg.className = 'msg';
    msg.textContent = 'Taking a screenshot…';
    ({ shot, note: shotNote } = await capture());
    showShot();
    msg.textContent = !shot ? 'No screenshot (sending without one).' : shotNote ? "The game's picture couldn't be captured; the screenshot shows the page around it." : '';
    panel.classList.add('open');
    unityCapture(false);
    try { const c = document.activeElement; if (c && c !== document.body && c !== host && /^canvas$/i.test(c.tagName)) c.blur(); } catch {}
    updatePerfBadge();
    if (!perfUiTimer) perfUiTimer = setInterval(updatePerfBadge, 1000);
    place();
    if (!matchMedia('(pointer: coarse)').matches) ta.focus();
  }
  function close() {
    panel.classList.remove('open');
    unityCapture(true);
    if (perfUiTimer) { clearInterval(perfUiTimer); perfUiTimer = 0; }
    stopMic();
  }

  // ------------------------------------------------------------ hold to talk
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let base = '';
  if (!SR) mic.style.display = 'none';
  const startMic = (e) => {
    e.preventDefault();
    if (!SR || rec) return;
    try {
      rec = new SR();
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = true;
      rec.continuous = true;
      base = ta.value ? ta.value.replace(/\s*$/, ' ') : '';
      rec.onresult = (ev) => { let s = ''; for (const r of ev.results) s += r[0].transcript; ta.value = base + s; };
      rec.onerror = (ev) => { msg.className = 'msg err'; msg.textContent = `Speech: ${ev.error}`; };
      rec.onend = () => { rec = null; mic.classList.remove('on'); mic.textContent = '🎙 Hold to talk'; };
      rec.start();
      mic.classList.add('on');
      mic.textContent = '🎙 Listening… let go when done';
    } catch (err) { rec = null; msg.className = 'msg err'; msg.textContent = String(err.message || err); }
  };
  const stopMic = () => { if (rec) try { rec.stop(); } catch {} };
  mic.addEventListener('pointerdown', (e) => { try { mic.setPointerCapture(e.pointerId); } catch {} startMic(e); });
  for (const t of ['pointerup', 'pointercancel']) mic.addEventListener(t, stopMic);

  // ------------------------------------------------------------------ send
  const json = (v, n) => { try { const s = JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + '…' : s; } catch { return null; } };
  // What the page knows, for a report or an error: where, the device, the build, the console, the game's state, and Babylon perf.
  const context = () => {
    const pt = window.hawkesPlaytest;
    const pf = ensurePerfProbe();
    let state = null, report = null, perf = null;
    try { if (pt && typeof pt.state === 'function') state = json(pt.state(), 4000); } catch (err) { state = `state() threw: ${err.message || err}`; }
    // What an app knows that a game's playtest state doesn't (Hawkes Gen: the account, the scene and its tabs, the job in
    // front...): window.hawkesReportContext(), kept with the report as its state.
    try { if (typeof window.hawkesReportContext === 'function') state = json({ ...(state ? { playtest: state } : {}), ...window.hawkesReportContext() }, 6000); } catch (err) { state = `hawkesReportContext() threw: ${err.message || err}`; }
    try { if (pt && typeof pt.report === 'function') report = json(pt.report(), 4000); } catch (err) { report = `report() threw: ${err.message || err}`; }
    try { if (pf && typeof pf.snapshot === 'function') perf = pf.snapshot(); } catch (err) { perf = `snapshot() threw: ${err.message || err}`; }
    return {
      url: location.href, title: document.title,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      device: { ua: navigator.userAgent, touch: matchMedia('(pointer: coarse)').matches, touchPoints: navigator.maxTouchPoints || 0, platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform, lang: navigator.language },
      console: log.slice(-25), state, report, perf, build: cfg,
    };
  };
  send.onclick = async () => {
    stopMic();
    const text = ta.value.trim();
    if (!text && !shot) { msg.className = 'msg err'; msg.textContent = 'Say what is wrong first.'; return; }
    send.disabled = true;
    msg.className = 'msg';
    msg.textContent = 'Sending…';
    const body = { text, blocker: $('.block').checked, shot, shotNote, ...context() };
    try {
      const r = await fetch(ENDPOINT, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
      msg.className = 'msg ok';
      msg.textContent = `${out.message || 'Got it.'}\n${out.id || ''}`;
      ta.value = '';
      $('.block').checked = false;
      shot = null;
      shotNote = null;
      showShot();
      setTimeout(() => { if (!ta.value) close(); }, 3500);
    } catch (err) {
      msg.className = 'msg err';
      msg.textContent = `Not sent: ${err.message || err}. Your text is still here; try again.`;
    } finally { send.disabled = false; }
  };

  // --------------------------------------------------- errors, reported by themselves
  // Same rules as the server's (bugreport.ts isNoise, errorSignature), which has the last word.
  const NOISE = [/(chrome|moz|safari|safari-web|ms-browser)-extension:\/\/|webkit-masked-url:|extensions::/i];
  const BENIGN = /ResizeObserver loop|The play\(\) request was interrupted|play\(\) failed because the user didn't interact|Non-Error promise rejection captured|\[Violation\]/i;
  const AUTO_MAX = 5;
  const sess = {
    get() { try { return JSON.parse(sessionStorage.getItem('hawkesReport.auto') || 'null') || { n: 0, sigs: [] }; } catch { return mem; } },
    set(v) { try { sessionStorage.setItem('hawkesReport.auto', JSON.stringify(v)); } catch {} mem = v; },
  };
  let mem = { n: 0, sigs: [] };
  const sigOf = (x) => {
    const top = (x.stack || '').split('\n').map((l) => l.trim()).find((l) => /^at\s|@/.test(l) && !/__studio\/report\.js/.test(l)) || '';
    return `${x.message.split('\n')[0]} | ${top}`.replace(/\?[^\s:)]*/g, '').replace(/\d+/g, '#').slice(0, 400);
  };
  const queue = [];
  let sending = false;
  let toastT = 0;
  const toast = () => { const t = $('.toast'); t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2200); };
  function autoError(x) {
    try {
      if (!x || !x.message) return;
      const where = `${x.stack} ${x.source}`;
      if (NOISE.some((r) => r.test(where) || r.test(x.message)) || BENIGN.test(x.message) || /__studio\/report\.js/.test((x.stack || '').split('\n').slice(0, 2).join(' '))) return;
      if (/^(uncaught )?script error\.?$/i.test(x.message.trim()) && !/\bat |@/.test(x.stack || '')) return;
      const st = sess.get();
      const sig = sigOf(x);
      if (st.n >= AUTO_MAX || st.sigs.includes(sig)) return;
      sess.set({ n: st.n + 1, sigs: [...st.sigs, sig] });
      queue.push(x);
      setTimeout(flush, 1200); // a moment, so the console has what followed it
    } catch {}
  }
  async function flush() {
    if (sending) return;
    sending = true;
    try {
      while (queue.length) {
        const x = queue.shift();
        // The game's frame only (read right after it draws): no html2canvas, nothing the player would notice.
        const game = gameCanvas();
        let frame = null;
        // (a hidden tab draws no frames: then none)
        try { frame = game ? await Promise.race([readFrame(game), new Promise((ok) => setTimeout(() => ok(null), 1500))]) : null; } catch {}
        const body = { error: { kind: x.kind, message: x.message, stack: x.stack, source: x.source }, shot: frame, shotNote: game && !frame ? "game frame couldn't be captured" : null, ...context() };
        try {
          const r = await fetch(ERRORS, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const out = await r.json().catch(() => ({}));
          if (r.ok && !out.ignored) toast();
        } catch {}
      }
    } finally { sending = false; }
  }
  // --------------------------------------------------- a newer build on beta
  // Not on a change's preview (/c/<id>/: that's the change, not beta) or a page that doesn't know its build.
  const fresh = $('.fresh');
  const same = (a, b) => { a = String(a || '').toLowerCase(); b = String(b || '').toLowerCase(); return Boolean(a && b) && (a.startsWith(b) || b.startsWith(a)); };
  // <newer-build> (test/report-widget-build.test.ts runs this block on its own)
  // A version as a number list, whatever it is written as: 42, "v42", "web 42", "1.2.3+20261107" (a +stamp or -suffix is
  // dropped). null when it has no digits.
  const verOf = (v) => {
    const m = /(\d+(?:\.\d+)*)/.exec(String(v == null ? '' : v).split(/[+\-]/)[0]);
    return m ? m[1].split('.').map(Number) : null;
  };
  const verCmp = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d < 0 ? -1 : 1; } return 0; };
  // Is the build beta serves (b: sha, version, at) really newer than the page (c: sha, version, built)? Versions decide
  // when both sides have one (equal or older: no); else the same commit is not newer; else the served build must have been
  // published after this page was (a minute of slack: build.json is written just after the pages of one publish).
  const isNewer = (b, c) => {
    const bv = verOf(b.version), cv = verOf(c.version);
    if (bv && cv) return verCmp(bv, cv) > 0;
    if (same(b.sha, c.sha)) return false;
    if (Number(b.at) > 0 && Number(c.built) > 0) return Number(b.at) > Number(c.built) + 60000;
    return true;
  };
  // </newer-build>
  const seen = {
    get() { try { return sessionStorage.getItem('hawkesReport.freshDismissed') || ''; } catch { return ''; } },
    set(v) { try { sessionStorage.setItem('hawkesReport.freshDismissed', v); } catch {} },
  };
  let dismissed = seen.get();
  let hideTimer = 0;
  const dismiss = () => { clearTimeout(hideTimer); dismissed = fresh.dataset.build || ''; seen.set(dismissed); fresh.classList.remove('on'); };
  async function checkBuild() {
    if (cfg.change || !cfg.sha || document.visibilityState === 'hidden') return;
    // Only the hosts that answer it (beta sites): a local or unknown host would log a console 404 for nothing.
    if (!/(^|\.)hawkesgen\.ai$/.test(location.hostname)) return;
    try {
      const r = await fetch(ROOT + '/dev/__studio/build', { credentials: 'same-origin', cache: 'no-store' });
      const b = r.ok ? await r.json() : null;
      if (!b || !b.sha) return;
      const key = `${b.sha}/${b.version || ''}`;
      fresh.dataset.build = key;
      const show = isNewer(b, cfg) && dismissed !== key;
      fresh.classList.toggle('on', show);
      clearTimeout(hideTimer);
      // It is a hint, not a fixture: gone after about 8 seconds, and not asked again this tab session.
      if (show) hideTimer = setTimeout(dismiss, 8000);
    } catch {}
  }
  $('.go').onclick = () => location.reload();
  $('.no').onclick = dismiss;
  if (!cfg.change && cfg.sha) {
    // Once when the page opens and whenever it comes back to the screen; never on a timer (no polling).
    setTimeout(checkBuild, 3000);
    addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkBuild(); });
    addEventListener('pageshow', (e) => { if (e.persisted) checkBuild(); });
  }

  window.__hawkesOnError = autoError;
  for (const x of errs.splice(0)) autoError(x);

  const mount = () => { (document.body || document.documentElement).appendChild(host); place(); };
  if (document.body) mount(); else addEventListener('DOMContentLoaded', mount);
})();
