// Motor de legendas: quebra de linhas, montagem dos blocos, SRT e desenho no canvas.
// Segue as mesmas regras da versão instalada (app.py), para o resultado sair igual.

export const DEFAULT_STYLE = {
  font: 'Montserrat', face: 'b:Montserrat|800|0', size: 5.0, upper: false,
  color: '#FFFFFF', outline: 4.0, outline_color: '#000000', shadow: 0.0,
  box: false, box_color: '#000000', box_opacity: 0.6,
  pos: 90, max_chars: 32, max_lines: 2,
  highlight: false, highlight_color: '#FFD84D',
};

/** Quebra equilibrada: devolve linhas (listas de índices) ou null se não couber. */
export function wrap(words, maxc, maxl) {
  const n = words.length;
  const pre = [0];
  for (const w of words) pre.push(pre[pre.length - 1] + w.length);
  const ln = (a, b) => pre[b] - pre[a] + (b - a - 1);
  for (let k = 1; k <= maxl; k++) {
    const memo = new Map();
    const f = (a, k) => {
      if (k === 1) return ln(a, n) <= maxc ? [ln(a, n), []] : null;
      const key = a * 16 + k;
      if (memo.has(key)) return memo.get(key);
      let best = null;
      for (let b = a + 1; b <= n - k + 1; b++) {
        if (ln(a, b) > maxc) break;
        const r = f(b, k - 1);
        if (r) {
          const c = Math.max(ln(a, b), r[0]);
          if (!best || c < best[0]) best = [c, [b, ...r[1]]];
        }
      }
      memo.set(key, best);
      return best;
    };
    const r = f(0, k);
    if (r) {
      const cuts = [0, ...r[1], n];
      const out = [];
      for (let i = 0; i < cuts.length - 1; i++) {
        const l = [];
        for (let j = cuts[i]; j < cuts[i + 1]; j++) l.push(j);
        out.push(l);
      }
      return out;
    }
  }
  return null;
}

/** Espalha as palavras de cada trecho pelo tempo do trecho, proporcional ao tamanho. */
export function wordsFromSegments(segments) {
  const words = [];
  for (const seg of segments) {
    const toks = String(seg.text || '').trim().split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    let [s, e] = seg.timestamp;
    if (e == null || !(e > s)) e = s + Math.max(1, toks.length * 0.35);
    const total = toks.reduce((a, t) => a + t.length + 1, 0);
    let acc = 0;
    for (const t of toks) {
      const a = s + (e - s) * acc / total;
      acc += t.length + 1;
      words.push({ t, s: a, e: s + (e - s) * (acc - 1) / total });
    }
  }
  return words;
}

export function fixTiming(cues) {
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const nxt = i + 1 < cues.length ? cues[i + 1].s : c.e + 10;
    let end = Math.max(c.e + 0.15, c.s + 1.0);
    if (nxt - end < 0.25) end = nxt;
    c.e = Math.max(Math.min(end, nxt), c.s + 0.05);
  }
}

export function buildCues(words, maxc, maxl) {
  const groups = [];
  let cur = [];
  for (const w of words) {
    if (cur.length) {
      const p = cur[cur.length - 1];
      if (w.s - p.e > 0.7 || /[.!?…]$/.test(p.t) || w.e - cur[0].s > 7 ||
          wrap([...cur.map(x => x.t), w.t], maxc, maxl) === null) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  const cues = groups.map(g => ({ s: g[0].s, e: g[g.length - 1].e, w: g }));
  fixTiming(cues);
  return cues;
}

export function cueLines(cue, st) {
  const texts = cue.w.map(w => w.t);
  const ls = wrap(texts, +st.max_chars, +st.max_lines) || [texts.map((_, i) => i)];
  return ls.map(l => l.map(i => [i, texts[i]]));
}

const tSrt = t => {
  const ms = Math.round(Math.max(0, t) * 1000);
  const p = (n, z = 2) => String(n).padStart(z, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

export function toSrt(cues, st) {
  return cues.map((c, i) => `${i + 1}\n${tSrt(c.s)} --> ${tSrt(c.e)}\n` +
    cueLines(c, st).map(l => l.map(x => x[1]).join(' ')).join('\n') + '\n').join('\n');
}

export function fromSrt(text, st) {
  const raw = text.replace(/^﻿/, '').replace(/\r/g, '');
  const cues = [];
  for (const block of raw.split(/\n\s*\n/)) {
    const m = block.match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)[^\n]*\n([\s\S]*)/);
    if (!m) continue;
    const s = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0').slice(0, 3) / 1000;
    const e = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8].padEnd(3, '0').slice(0, 3) / 1000;
    const words = wordsFromSegments([{ text: m[9].replace(/<[^>]+>/g, ''), timestamp: [s, e] }]);
    if (!words.length || e <= s) continue;
    if (wrap(words.map(w => w.t), +st.max_chars, +st.max_lines)) cues.push({ s, e, w: words });
    else {
      let cur = [];
      for (const w of words) {
        if (cur.length && !wrap([...cur.map(x => x.t), w.t], +st.max_chars, +st.max_lines)) {
          cues.push({ s: cur[0].s, e: cur[cur.length - 1].e, w: cur }); cur = [];
        }
        cur.push(w);
      }
      if (cur.length) cues.push({ s: cur[0].s, e: cur[cur.length - 1].e, w: cur });
    }
  }
  return cues;
}

/** Acha o bloco ativo no tempo t (blocos ordenados). Guarda a posição para ser rápido quadro a quadro. */
export function makeCueCursor(cues) {
  let i = 0;
  return t => {
    if (!cues.length) return null;
    if (i >= cues.length || cues[i].s > t) i = 0;
    while (i < cues.length && cues[i].e <= t) i++;
    const c = cues[i];
    if (!c || c.s > t) return null;
    let hi = 0;
    for (let k = 0; k < c.w.length; k++) if (c.w[k].s <= t) hi = k;
    return { cue: c, hi };
  };
}

function rgba(hex, a = 1) {
  const h = String(hex || '#ffffff').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h.slice(0, 6), 16) || 0;
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

/**
 * Desenha um bloco de legenda. font = {family, weight, italic}.
 * Medidas iguais às da versão instalada: tamanho em % do lado menor, contorno e sombra
 * em "pixels de 1080p", posição em % da altura.
 */
export function drawCaption(ctx, W, H, cue, hi, st, font) {
  if (!cue) return;
  const short = Math.min(W, H), k = short / 1080;
  const fs = Math.max(8, Math.round(+st.size / 100 * short));
  const fontStr = `${font.italic ? 'italic ' : ''}${font.weight} ${fs}px "${font.family}", sans-serif`;
  ctx.save();
  ctx.font = fontStr;
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  const lines = cueLines(cue, st);
  const up = t => (st.upper ? t.toLocaleUpperCase('pt-BR') : t);
  const m = ctx.measureText('Ág');
  const asc = m.fontBoundingBoxAscent ?? fs * 0.93;
  const desc = m.fontBoundingBoxDescent ?? fs * 0.25;
  const lh = asc + desc;
  const space = ctx.measureText(' ').width;
  const bottom = H - Math.round(H * (100 - +st.pos) / 100);
  const top = bottom - lh * lines.length;
  const outline = st.box ? 0 : +st.outline * k;
  const shadow = st.box ? 0 : +st.shadow * k;
  const pad = fs * 0.22;
  lines.forEach((line, li) => {
    const widths = line.map(([, t]) => ctx.measureText(up(t)).width);
    const total = widths.reduce((a, b) => a + b, 0) + space * (line.length - 1);
    let x = (W - total) / 2;
    const base = top + lh * li + asc;
    if (st.box) {
      ctx.fillStyle = rgba(st.box_color, +st.box_opacity);
      ctx.fillRect(Math.round(x - pad), Math.round(base - asc - pad), Math.round(total + pad * 2), Math.round(lh + pad * 2));
    }
    line.forEach(([i, t], j) => {
      const txt = up(t);
      if (shadow > 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = outline * 2;
        if (outline > 0) ctx.strokeText(txt, x + shadow, base + shadow);
        ctx.fillText(txt, x + shadow, base + shadow);
      }
      if (outline > 0) {
        ctx.strokeStyle = st.outline_color;
        ctx.lineWidth = outline * 2;
        ctx.strokeText(txt, x, base);
      }
      ctx.fillStyle = st.highlight && i === hi ? st.highlight_color : st.color;
      ctx.fillText(txt, x, base);
      x += widths[j] + space;
    });
  });
  ctx.restore();
}

/** Bloco de exemplo para o preview, cortando o texto até caber no estilo. */
export function sampleCue(text, st) {
  let toks = String(text || '').split(/\s+/).filter(Boolean);
  if (!toks.length) toks = ['Exemplo', 'de', 'legenda'];
  while (toks.length > 1 && !wrap(toks, +st.max_chars, +st.max_lines)) toks.pop();
  return { s: 0, e: 10, w: toks.map(t => ({ t, s: 0, e: 10 })) };
}
