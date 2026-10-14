// Download em várias conexões ao mesmo tempo, com retomada por pedaço.
// ---------------------------------------------------------------- download em várias conexões
// O Hugging Face limita a velocidade de cada conexão em algumas redes. Arquivos grandes são
// baixados em pedaços, 8 de cada vez, como na versão para Windows.
export const CONNS = 8, PIECE = 16 << 20, BIG = 24 << 20;
const DL = new Map(); // url -> [loaded, total]
let dlMark = { t: 0, b: 0, speed: 0 };
const nativeFetch = self.fetch.bind(self);
let reporter = () => {};
let HOST = /^https:\/\/huggingface\.co\/.+\/resolve\//;
export function setReporter(fn) { reporter = fn; }
export function setHost(rx) { HOST = rx; }
export function clearDownloads() { DL.clear(); }

function dlReport() {
  const post = (t, d) => reporter(t, d);
  let l = 0, t = 0;
  for (const [a, b] of DL.values()) { l += a; t += b; }
  const now = performance.now();
  if (!dlMark.t) dlMark = { t: now, b: l, speed: 0 };
  if (now - dlMark.t > 800) { dlMark = { t: now, b: l, speed: (l - dlMark.b) / ((now - dlMark.t) / 1000) }; }
  post('dl-progress', { loaded: l, total: t, speed: dlMark.speed });
}

async function getRange(url, a, b, onBytes) {
  for (let tries = 0; ; tries++) {
    let got = 0;
    try {
      const r = await nativeFetch(url, { headers: { Range: `bytes=${a}-${b}` } });
      if (r.status !== 206) throw new Error('sem suporte a partes (' + r.status + ')');
      const reader = r.body.getReader(), parts = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); got += value.length; onBytes(value.length);
      }
      if (got !== b - a + 1) throw new Error('pedaço incompleto');
      return new Blob(parts);
    } catch (e) {
      onBytes(-got);
      if (tries >= 6) throw e;
      await new Promise(r => setTimeout(r, 1000 * (tries + 1)));
    }
  }
}

export async function parallelFetch(url, init) {
  const u = String(url);
  if (!HOST.test(u) || (init && init.method && init.method !== 'GET')) return nativeFetch(url, init);
  // descobre o tamanho e o endereço final (depois do redirecionamento para a CDN)
  let probe;
  try { probe = await nativeFetch(u, { headers: { Range: 'bytes=0-0' } }); } catch (e) { return nativeFetch(url, init); }
  const cr = probe.headers.get('content-range') || '';
  const total = probe.status === 206 ? +cr.split('/')[1] : 0;
  try { await probe.body?.cancel(); } catch (e) {}
  if (!total || total < BIG) return nativeFetch(url, init);
  const finalUrl = probe.url || u;
  const n = Math.ceil(total / PIECE), blobs = new Array(n);
  DL.set(u, [0, total]);
  const onBytes = k => { const v = DL.get(u); v[0] += k; dlReport(); };
  let next = 0;
  const work = async () => {
    while (next < n) {
      const i = next++;
      const a = i * PIECE, b = Math.min(total, a + PIECE) - 1;
      blobs[i] = await getRange(finalUrl, a, b, onBytes);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONNS, n) }, work));
  } catch (e) {
    DL.delete(u);
    return nativeFetch(url, init); // se o servidor não aceitar partes, baixa do jeito normal
  }
  const body = new Blob(blobs, { type: probe.headers.get('content-type') || 'application/octet-stream' });
  return new Response(body, { status: 200, headers: { 'content-length': String(total), 'content-type': body.type } });
}
