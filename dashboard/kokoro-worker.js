// Kokoro TTS for Talk's calls, in a worker so the page (and speech recognition) never waits on it (dashboard/call.js).
// kokoro-js (82M parameters, Apache-2.0) runs on WebGPU when the browser has it, else on WebAssembly (the CPU). The
// model is downloaded from Hugging Face the first time and kept in the browser's cache (Cache Storage) after that.
//
//   → { type: 'load', device: 'webgpu' | 'wasm', dtype }        ← { type: 'ready', device, dtype, ms } | { type: 'error', error }
//   → { type: 'speak', id, text, voice, speed }                 ← { type: 'audio', id, audio (Float32Array), rate, ms } | { type: 'error', id, error }
import { KokoroTTS } from 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let tts = null;
let loading = null;
// One sentence at a time, in order: a sentence asked for while another is made waits its turn.
let chain = Promise.resolve();

async function load(device, dtype) {
  const t0 = performance.now();
  try {
    tts = await KokoroTTS.from_pretrained(MODEL, { dtype, device });
    return { device, dtype, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    if (device !== 'webgpu') throw e;
    // WebGPU there but not usable (an old driver, a blocked adapter): the CPU instead.
    tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'q8', device: 'wasm' });
    return { device: 'wasm', dtype: 'q8', ms: Math.round(performance.now() - t0), fellBack: String(e?.message ?? e) };
  }
}

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'load') {
    loading ??= load(m.device, m.dtype);
    loading.then((r) => self.postMessage({ type: 'ready', ...r }), (e) => { loading = null; self.postMessage({ type: 'error', error: String(e?.message ?? e) }); });
    return;
  }
  if (m.type === 'speak') {
    chain = chain.then(async () => {
      if (!tts) await loading;
      const t0 = performance.now();
      try {
        const out = await tts.generate(m.text, { voice: m.voice || 'af_heart', speed: m.speed || 1 });
        const audio = out.audio;
        self.postMessage({ type: 'audio', id: m.id, audio, rate: out.sampling_rate, ms: Math.round(performance.now() - t0) }, [audio.buffer]);
      } catch (e) {
        self.postMessage({ type: 'error', id: m.id, error: String(e?.message ?? e) });
      }
    });
  }
};
