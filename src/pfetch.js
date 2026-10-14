// Download em várias conexões ao mesmo tempo, com retomada por pedaço.
// ---------------------------------------------------------------- download em várias conexões
// O Hugging Face limita a velocidade de cada conexão em algumas redes. Arquivos grandes são
// baixados em pedaços, vários ao mesmo tempo, como na versão para Windows.
export const BIG = 24 << 20;
const DL = new Map(); // url -> [loaded, total]
let dlMark = { t: 0, b: 0, speed: 0 };
const nativeFetch = self.fetch.bind(self);
let reporter = () => {};
let HOST = /^https:\/\/huggingface\.co\/.+\/resolve\//;
export function setReporter(fn) { reporter = fn; }
export function setHost(rx) { HOST = rx; }
export function setModelHost(base) {
  if (!base) return;
  BRIDGE = base;
  const e = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  HOST = new RegExp('^' + e + '|^https:\\/\\/huggingface\\.co\\/.+\\/resolve\\/');
}
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

async function getRange(url, a, b, onBytes, maxTries = 6) {
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
      if (tries >= maxTries) throw e;
      await new Promise(r => setTimeout(r, 1000 * (tries + 1)));
    }
  }
}

// Pedaços pequenos e muitas conexões para o Hugging Face direto (o limite lá é por conexão);
// pedaços grandes, que cabem no cache do Cloudflare, quando o download passa pela ponte.
const PLAN = { hf: { piece: 16 << 20, conns: 8, tries: 6 }, bridge: { piece: 256 << 20, conns: 4, tries: 2 } };
let BRIDGE = '';
const toHF = u => 'https://huggingface.co/' + u.slice(BRIDGE.length);

async function doParallel(u, plan) {
  const probe = await nativeFetch(u, { headers: { Range: 'bytes=0-0' } });
  if (probe.status !== 206 && !probe.ok) throw new Error('origem respondeu ' + probe.status);
  const cr = probe.headers.get('content-range') || '';
  const total = probe.status === 206 ? +cr.split('/')[1] : 0;
  try { await probe.body?.cancel(); } catch (e) {}
  if (!total || total < BIG) return null; // arquivo pequeno: baixa inteiro
  const finalUrl = probe.url || u;
  const n = Math.ceil(total / plan.piece), blobs = new Array(n);
  DL.set(u, [0, total]);
  const onBytes = k => { const v = DL.get(u); if (v) { v[0] += k; dlReport(); } };
  let next = 0;
  const work = async () => {
    while (next < n) {
      const i = next++;
      const a = i * plan.piece, b = Math.min(total, a + plan.piece) - 1;
      blobs[i] = await getRange(finalUrl, a, b, onBytes, plan.tries);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(plan.conns, n) }, work));
  } catch (e) { DL.delete(u); throw e; }
  const body = new Blob(blobs, { type: probe.headers.get('content-type') || 'application/octet-stream' });
  return new Response(body, { status: 200, headers: { 'content-length': String(total), 'content-type': body.type } });
}

export async function parallelFetch(url, init) {
  const u = String(url);
  if (!HOST.test(u) || (init && init.method && init.method !== 'GET')) return nativeFetch(url, init);
  if (BRIDGE && u.startsWith(BRIDGE)) {
    // pela ponte; se ela falhar (fora do ar ou limite do dia), cai para o Hugging Face direto
    try {
      const r = await doParallel(u, PLAN.bridge);
      if (r) return r;
      const s = await nativeFetch(u, init);
      if (s.ok) return s;
      throw new Error('ponte respondeu ' + s.status);
    } catch (e) {
      reporter('dl-source', { source: 'hf', reason: String(e.message || e) });
      return parallelFetch(toHF(u), init);
    }
  }
  try {
    const r = await doParallel(u, PLAN.hf);
    if (r) return r;
  } catch (e) {}
  return nativeFetch(url, init); // se o servidor não aceitar partes, baixa do jeito normal
}
