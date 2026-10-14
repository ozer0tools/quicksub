// Catálogo de fontes: as que vêm com o site, as do computador (Chrome/Edge) e as enviadas pelo usuário.
const BASE = new URL('./static/fonts/', document.baseURI).href;

const BUILTIN = {
  'Montserrat': { file: 'montserrat', weights: [400, 500, 600, 700, 800, 900], italics: [700, 800] },
  'Inter': { file: 'inter', weights: [400, 500, 600, 700, 800, 900], italics: [] },
  'Poppins': { file: 'poppins', weights: [400, 500, 600, 700, 800, 900], italics: [700] },
  'Anton': { file: 'anton', weights: [400], italics: [] },
  'Bebas Neue': { file: 'bebas-neue', weights: [400], italics: [] },
  'Space Mono': { file: null, weights: [400, 700], italics: [] },
};

const WEIGHT_NAMES = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
export const weightName = (w, it) => (WEIGHT_NAMES[w] || w) + (it ? ' Italic' : '');

// família -> [{id, label, weight, italic, src}]
export const families = new Map();
const loaded = new Map(); // id -> {family, weight, italic}
let localCount = 0;

for (const [fam, d] of Object.entries(BUILTIN)) {
  const faces = [];
  for (const w of d.weights) faces.push({ id: `b:${fam}|${w}|0`, weight: w, italic: false, origin: 'b' });
  for (const w of d.italics) faces.push({ id: `b:${fam}|${w}|1`, weight: w, italic: true, origin: 'b' });
  families.set(fam, faces.sort(sortFaces));
}

function sortFaces(a, b) { return (a.italic - b.italic) || (a.weight - b.weight); }

function styleToWeight(style) {
  const s = String(style || '').toLowerCase().replace(/[\s_-]/g, '');
  const table = [['thin', 100], ['hairline', 100], ['extralight', 200], ['ultralight', 200], ['light', 300],
    ['semibold', 600], ['demibold', 600], ['extrabold', 800], ['ultrabold', 800], ['black', 900], ['heavy', 900],
    ['medium', 500], ['bold', 700]];
  for (const [k, w] of table) if (s.includes(k)) return w;
  return 400;
}

export const hasLocalFonts = () => 'queryLocalFonts' in window;
export const localFontCount = () => localCount;

/** Lê as fontes do computador (pede permissão no Chrome/Edge). */
export async function loadLocalFonts() {
  const list = await window.queryLocalFonts();
  const seen = new Set();
  for (const f of list) {
    const fam = f.family;
    if (!fam || fam.startsWith('.')) continue;
    if (!families.has(fam)) families.set(fam, []);
    const weight = styleToWeight(f.style);
    const italic = /italic|oblique/i.test(f.style);
    const key = fam + '|' + f.style;
    if (seen.has(key)) continue;
    seen.add(key);
    const faces = families.get(fam);
    if (faces.some(x => x.origin === 'b')) continue; // mantém a versão embutida
    faces.push({ id: 'l:' + f.postscriptName, weight, italic, label: f.style, origin: 'l', fontData: f });
    faces.sort(sortFaces);
  }
  localCount = seen.size;
  return localCount;
}

/** Fonte enviada pelo usuário (.ttf/.otf/.woff/.woff2). */
export async function addUploadedFont(file) {
  const fam = file.name.replace(/\.(ttf|otf|woff2?)$/i, '').replace(/[-_](regular|bold|italic|light|medium|black|semibold|extrabold|thin)+$/i, '').replace(/[-_]+/g, ' ').trim() || 'Fonte enviada';
  const style = file.name.replace(/\.(ttf|otf|woff2?)$/i, '');
  const weight = styleToWeight(style.slice(fam.length) || style);
  const italic = /italic|oblique/i.test(style);
  const id = 'u:' + file.name;
  if (!families.has(fam)) families.set(fam, []);
  const faces = families.get(fam);
  if (!faces.some(x => x.id === id)) faces.push({ id, weight, italic, label: style, origin: 'u', file });
  faces.sort(sortFaces);
  return { family: fam, id };
}

export function facesOf(fam) { return families.get(fam) || []; }

export function bestFace(fam, want = 700, italic = false) {
  const faces = facesOf(fam);
  if (!faces.length) return null;
  return faces.slice().sort((a, b) => ((a.italic !== italic) * 1000 + Math.abs(a.weight - want)) -
    ((b.italic !== italic) * 1000 + Math.abs(b.weight - want)))[0];
}

/** Garante que a face está carregada e devolve como desenhá-la no canvas. */
export async function ensureFace(id, famHint) {
  if (loaded.has(id)) return loaded.get(id);
  let face = null, fam = famHint;
  for (const [f, faces] of families) { const x = faces.find(y => y.id === id); if (x) { face = x; fam = f; break; } }
  if (!face) {
    const fb = bestFace(famHint || 'Montserrat') || families.get('Montserrat')[6];
    return ensureFace(fb.id, famHint && families.has(famHint) ? famHint : 'Montserrat');
  }
  let css = fam, src;
  if (face.origin === 'b') {
    const d = BUILTIN[fam];
    src = d.file ? `${BASE}${d.file}-latin-${face.weight}-${face.italic ? 'italic' : 'normal'}.woff2`
      : new URL(`./static/space-mono-${face.weight}.ttf`, document.baseURI).href;
    css = 'QS ' + fam;
    const ff = new FontFace(css, `url(${src})`, { weight: String(face.weight), style: face.italic ? 'italic' : 'normal' });
    document.fonts.add(await ff.load());
  } else {
    const blob = face.origin === 'l' ? await face.fontData.blob() : face.file;
    css = 'QSX ' + id.replace(/[^\w]/g, '_');
    const ff = new FontFace(css, await blob.arrayBuffer(), { weight: String(face.weight), style: face.italic ? 'italic' : 'normal' });
    document.fonts.add(await ff.load());
  }
  const out = { family: css, weight: face.weight, italic: face.italic, label: face.label || weightName(face.weight, face.italic) };
  loaded.set(id, out);
  return out;
}
