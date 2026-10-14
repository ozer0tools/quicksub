// QuickSub: ponte para os modelos do Hugging Face, rodando no Cloudflare Workers (plano grátis).
// O navegador baixa do Cloudflare (rápido no Brasil) e o Cloudflare busca no Hugging Face.
// Cada pedaço baixado fica guardado no cache do Cloudflare, então os próximos usuários pegam de lá.
//
// Como publicar: Cloudflare → Workers & Pages → Create → Worker → cole este arquivo → Deploy.

const ORIGIN = 'https://huggingface.co';
const ALLOWED_ORIGINS = ['https://ozer0tools.github.io', 'http://localhost:5173', 'http://localhost:4173'];
// só os repositórios que o QuickSub usa
const ALLOWED_REPOS = /^\/onnx-community\/whisper-(large-v3-turbo|small|base)\/resolve\/[^/]+\/[\w./-]+$/;

function cors(req, h = new Headers()) {
  const o = req.headers.get('Origin');
  h.set('Access-Control-Allow-Origin', o && ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0]);
  h.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Range');
  h.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, ETag');
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
  h.set('Vary', 'Origin');
  return h;
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Método não permitido', { status: 405, headers: cors(req) });
    const url = new URL(req.url);
    if (!ALLOWED_REPOS.test(url.pathname)) return new Response('Não encontrado', { status: 404, headers: cors(req) });

    const range = req.headers.get('Range') || '';
    const cacheKey = new Request(url.origin + url.pathname + (range ? '?r=' + encodeURIComponent(range) : ''), { method: 'GET' });
    const cache = caches.default;
    let res = await cache.match(cacheKey);
    if (!res) {
      // Sem "cf.cacheEverything": nos arquivos acima de 512 MB (ex.: o ouvido fp16 do turbo, 1,27 GB)
      // o cache do Cloudflare recusa o arquivo inteiro e devolve 403. O cache dos pedaços é feito abaixo.
      const up = await fetch(ORIGIN + url.pathname, {
        headers: range ? { Range: range } : {},
        redirect: 'follow',
      });
      if (!up.ok && up.status !== 206) return new Response('Erro na origem: ' + up.status + ' (' + new URL(up.url || ORIGIN).host + ')', { status: up.status, headers: cors(req) });
      const h = new Headers();
      for (const k of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag']) {
        const v = up.headers.get(k); if (v) h.set(k, v);
      }
      h.set('Cache-Control', 'public, max-age=2592000, immutable');
      res = new Response(up.body, { status: up.status, headers: h });
      // guarda pedaços de até 500 MB no cache do Cloudflare (o limite do plano grátis é 512 MB)
      const len = +(up.headers.get('Content-Length') || 0);
      if (len && len <= 500 * 1024 * 1024) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }
    const out = new Response(req.method === 'HEAD' ? null : res.body, { status: res.status, headers: cors(req, new Headers(res.headers)) });
    return out;
  },
};
