// Transcrição (Whisper) rodando num Web Worker, para não travar a tela.
import { pipeline, env } from '@huggingface/transformers';
import { parallelFetch, setReporter, clearDownloads } from './pfetch.js';

env.allowLocalModels = false;

setReporter((t, d) => post(t, d));
env.fetch = parallelFetch;

const MODELS = {
  turbo: { repo: 'onnx-community/whisper-large-v3-turbo',
    webgpu: { encoder_model: 'fp16', decoder_model_merged: 'q4' }, wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' } },
  small: { repo: 'onnx-community/whisper-small',
    webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' } },
  base: { repo: 'onnx-community/whisper-base',
    webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' } },
};

let asr = null, loadedKey = '';
const SR = 16000;

function post(type, data = {}) { self.postMessage({ type, ...data }); }

async function load(model, device, ortBase, f16 = true) {
  const key = model + '|' + device + '|' + f16;
  if (asr && loadedKey === key) return;
  post('loading');
  if (ortBase) env.backends.onnx.wasm.wasmPaths = ortBase;
  env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
  const m = MODELS[model];
  const files = new Map();
  const progress_callback = d => {
    if (d.status === 'progress' && d.total) {
      files.set(d.file, [d.loaded, d.total]);
      let l = 0, t = 0;
      for (const [a, b] of files.values()) { l += a; t += b; }
      post('load-progress', { loaded: l, total: t });
    }
  };
  let first = m[device];
  if (device === 'webgpu' && !f16) first = { ...first, encoder_model: 'fp32' };
  const tries = [first, device === 'webgpu' ? 'fp32' : 'q8', undefined];
  let lastErr;
  for (const dtype of tries) {
    try {
      asr = await pipeline('automatic-speech-recognition', m.repo, { device, dtype, progress_callback });
      loadedKey = key;
      clearDownloads();
      return;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/** Divide o áudio em janelas de até ~29 s, cortando no trecho mais silencioso. */
function windows(audio) {
  const out = [], frame = SR / 10;
  let start = 0;
  while (start < audio.length) {
    let end = Math.min(audio.length, start + SR * 29);
    if (end < audio.length) {
      let best = end, bestE = Infinity;
      for (let p = start + SR * 20; p + frame <= end; p += frame) {
        let e = 0;
        for (let i = p; i < p + frame; i++) e += audio[i] * audio[i];
        if (e < bestE) { bestE = e; best = p + frame / 2; }
      }
      end = Math.floor(best);
    }
    out.push([start, end]);
    start = end;
  }
  return out;
}

function rms(a) { let e = 0; for (let i = 0; i < a.length; i += 4) e += a[i] * a[i]; return Math.sqrt(e / Math.max(1, a.length / 4)); }

// frases que o Whisper costuma "inventar" em silêncio, em português
const HALLU = /amara\.org|legendas? pela comunidade|legendado por|inscreva-se no canal/i;

async function run(audio, prompt) {
  const wins = windows(audio);
  const segments = [];
  for (let k = 0; k < wins.length; k++) {
    const [a, b] = wins[k];
    const piece = audio.subarray(a, b);
    if (rms(piece) > 0.002) {
      const out = await asr(piece, { language: 'portuguese', task: 'transcribe', return_timestamps: true });
      const off = a / SR, dur = (b - a) / SR;
      for (const c of out.chunks || [{ text: out.text, timestamp: [0, dur] }]) {
        const text = String(c.text || '').trim();
        if (!text || HALLU.test(text)) continue;
        let [s, e] = c.timestamp || [0, dur];
        if (s == null) s = 0;
        if (e == null || e > dur + 1) e = dur;
        segments.push({ text, timestamp: [off + s, off + Math.max(e, s + 0.2)] });
      }
    }
    post('run-progress', { pct: (k + 1) / wins.length });
  }
  return segments;
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      await load(data.model, data.device, data.ortBase, data.f16);
      post('loaded', { device: data.device });
    } else if (data.type === 'run') {
      await load(data.model, data.device, data.ortBase, data.f16);
      const segments = await run(data.audio, data.prompt);
      post('result', { id: data.id, segments });
    }
  } catch (e) {
    post('error', { id: data.id, message: String(e && e.message || e) });
  }
};
