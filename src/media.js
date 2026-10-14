// Leitura e gravação de vídeo no navegador (WebCodecs via mediabunny).
import {
  Input, Output, Conversion, ALL_FORMATS, BlobSource, BufferTarget, StreamTarget, Mp4OutputFormat,
  CanvasSink, AudioBufferSink, VideoSample, canEncodeVideo, canEncodeAudio, getEncodableVideoCodecs,
  QUALITY_VERY_HIGH, QUALITY_HIGH, QUALITY_MEDIUM,
} from 'mediabunny';
import { drawCaption, makeCueCursor } from './captions.js';

const open = file => new Input({ source: new BlobSource(file), formats: ALL_FORMATS });

/** Informações do arquivo para a lista e o painel. */
export async function probe(file) {
  const input = open(file);
  try {
    const v = await input.getPrimaryVideoTrack();
    if (!v) throw new Error('Não achei uma faixa de vídeo neste arquivo.');
    const a = await input.getPrimaryAudioTrack();
    const dur = await input.computeDuration();
    let fps = null, bitrate = null;
    try { const ps = await v.computePacketStats(120); fps = ps.averagePacketRate; } catch (e) {}
    try { bitrate = (file.size * 8) / dur; } catch (e) {}
    let hdr = false;
    try { hdr = await v.hasHighDynamicRange(); } catch (e) {}
    const canV = await v.canDecode().catch(() => false);
    const canA = a ? await a.canDecode().catch(() => false) : false;
    return {
      dur, w: v.displayWidth, h: v.displayHeight, fps, bitrate, hdr,
      vcodec: v.codec, acodec: a ? a.codec : null, hz: a ? a.sampleRate : null, channels: a ? a.numberOfChannels : 0,
      canDecode: canV, canDecodeAudio: canA, mime: await input.getMimeType().catch(() => ''),
    };
  } finally { input.dispose?.(); }
}

/** Um quadro do vídeo (a 1/3 da duração), para o preview e as miniaturas. */
export async function frameAt(file, maxW = 1920) {
  const input = open(file);
  try {
    const v = await input.getPrimaryVideoTrack();
    const dur = await input.computeDuration();
    const w = Math.min(maxW, v.displayWidth);
    const sink = new CanvasSink(v, { width: w, height: Math.round(w * v.displayHeight / v.displayWidth), fit: 'fill' });
    const c = await sink.getCanvas(Math.max(0, dur / 3));
    return c ? { canvas: c.canvas, w: v.displayWidth, h: v.displayHeight } : null;
  } finally { input.dispose?.(); }
}

/** Áudio em 16 kHz mono, que é o que o Whisper espera. */
export async function audio16k(file, onPct) {
  const input = open(file);
  try {
    const a = await input.getPrimaryAudioTrack();
    if (!a) throw new Error('Este vídeo não tem áudio.');
    const dur = await input.computeDuration();
    const sr = a.sampleRate;
    const mono = new Float32Array(Math.ceil((dur + 1) * sr));
    let max = 0;
    for await (const { buffer, timestamp } of new AudioBufferSink(a).buffers()) {
      const off = Math.max(0, Math.round(timestamp * sr));
      const n = buffer.numberOfChannels, len = buffer.length;
      const chs = []; for (let c = 0; c < n; c++) chs.push(buffer.getChannelData(c));
      for (let i = 0; i < len && off + i < mono.length; i++) {
        let s = 0; for (let c = 0; c < n; c++) s += chs[c][i];
        mono[off + i] = s / n;
      }
      max = Math.max(max, off + len);
      onPct?.(Math.min(1, timestamp / dur));
    }
    const src = mono.subarray(0, Math.min(max, mono.length));
    if (sr === 16000) return src.slice();
    const outLen = Math.ceil(src.length * 16000 / sr);
    const ctx = new OfflineAudioContext(1, outLen, 16000);
    const buf = ctx.createBuffer(1, src.length, sr);
    buf.copyToChannel(src, 0);
    const node = ctx.createBufferSource(); node.buffer = buf; node.connect(ctx.destination); node.start();
    return (await ctx.startRendering()).getChannelData(0).slice();
  } finally { input.dispose?.(); }
}

const QUALITY = { alta: QUALITY_VERY_HIGH, padrao: QUALITY_HIGH, leve: QUALITY_MEDIUM };

/** Codec de vídeo de saída: H.264 sempre que o navegador souber gerar. */
export async function pickVideoCodec(w = 1920, h = 1080) {
  if (await canEncodeVideo('avc', { width: w, height: h }).catch(() => false)) return 'avc';
  const list = await getEncodableVideoCodecs(['hevc', 'vp9', 'av1'], { width: w, height: h }).catch(() => []);
  return list[0] || null;
}

/**
 * Gera o vídeo com a legenda desenhada em cada quadro.
 * writable: FileSystemWritableFileStream (pasta escolhida) ou null para gerar em memória.
 */
export async function burn(file, { cues, style, font, quality, writable, onPct, signal }) {
  const input = open(file);
  const v = await input.getPrimaryVideoTrack();
  const W = v.displayWidth - (v.displayWidth % 2), H = v.displayHeight - (v.displayHeight % 2);
  const codec = await pickVideoCodec(W, H);
  if (!codec) throw new Error('Este navegador não consegue gerar vídeo. Use o Chrome ou o Edge atualizados.');
  const target = writable ? new StreamTarget(writable, { chunked: true }) : new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: writable ? false : 'in-memory' }), target });
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const cursor = makeCueCursor(cues);
  const conv = await Conversion.init({
    input, output, tracks: 'primary', showWarnings: false,
    video: {
      codec, quality: QUALITY[quality] || QUALITY_HIGH, forceTranscode: true,
      allowTransformationMetadata: false, width: W, height: H, fit: 'fill',
      process: sample => {
        ctx.clearRect(0, 0, W, H);
        sample.draw(ctx, 0, 0, W, H);
        const hit = cursor(sample.timestamp);
        if (hit) drawCaption(ctx, W, H, hit.cue, hit.hi, style, font);
        return new VideoSample(canvas, { timestamp: sample.timestamp, duration: sample.duration });
      },
      processedWidth: W, processedHeight: H,
    },
    audio: async track => {
      // MP4 aceita bem estes; o resto (Vorbis, PCM...) é convertido
      if (['aac', 'mp3', 'opus', 'ac3', 'eac3', 'flac'].includes(track.codec)) return {};
      return { codec: (await canEncodeAudio('aac').catch(() => false)) ? 'aac' : 'opus' };
    },
  });
  if (!conv.isValid) {
    const why = conv.discardedTracks.map(d => d.reason).join(', ');
    throw new Error('Não deu para converter este arquivo neste navegador (' + why + ').');
  }
  conv.onProgress = p => onPct?.(p);
  const abort = () => conv.cancel();
  signal?.addEventListener('abort', abort);
  try {
    await conv.execute();
  } finally { signal?.removeEventListener('abort', abort); input.dispose?.(); }
  return { codec, buffer: writable ? null : target.buffer };
}
