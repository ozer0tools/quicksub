// Editor de legendas: lista de falas editáveis + vídeo com a legenda por cima, no estilo escolhido.
import { drawCaption, makeCueCursor, wordsFromSegments, toSrt } from './captions.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ft = t => {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`.replace('.', ',');
};
const parseT = v => {
  const m = String(v).trim().replace(',', '.').match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  return m ? (+(m[1] || 0)) * 60 + +m[2] : NaN;
};
const textOf = c => c.w.map(w => w.t).join(' ');
const withText = (c, text) => ({ s: c.s, e: c.e, w: wordsFromSegments([{ text, timestamp: [c.s, c.e] }]) });

let state = null;

export function openEditor(f, { style, font, onSave, onGenerate }) {
  closeEditor();
  const box = $('#edModal');
  const cues = f.cues.map(c => ({ s: c.s, e: c.e, w: c.w.map(w => ({ ...w })) }));
  const url = URL.createObjectURL(f.file);
  state = { f, cues, url, cur: -1, stopAt: null, raf: 0, dirty: false, style, font, onSave, onGenerate };
  $('#edName').textContent = f.name;
  const v = $('#edVideo');
  v.src = url;
  const W = f.info?.w || 16, H = f.info?.h || 9;
  state.ar = W / H;
  v.onloadedmetadata = () => { $('#edSeek').max = v.duration || 1; draw(); };
  v.onerror = () => { $('#edNote').textContent = 'Este navegador não toca este formato aqui; dá para editar o texto normalmente.'; };
  v.onplay = () => { $('#edPP').textContent = '❚❚'; loop(); };
  v.onpause = () => { $('#edPP').textContent = '▶'; cancelAnimationFrame(state?.raf); draw(); };
  v.onseeked = () => draw();
  $('#edNote').textContent = '';
  renderList();
  box.hidden = false;
  document.body.style.overflow = 'hidden';
  fit(); draw();
}

export function closeEditor() {
  if (!state) return;
  const v = $('#edVideo');
  v.pause(); v.removeAttribute('src'); v.load();
  cancelAnimationFrame(state.raf);
  URL.revokeObjectURL(state.url);
  $('#edModal').hidden = true;
  document.body.style.overflow = '';
  state = null;
}

// encaixa o vídeo no espaço disponível, sem passar dos limites (horizontal ou vertical)
function fit() {
  if (!state) return;
  const left = $('.edleft'), st = $('#edStage');
  const cs = getComputedStyle(left);
  const aw = left.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const narrow = window.innerWidth <= 860;
  const ah = narrow ? window.innerHeight * 0.32 : left.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 110;
  let w = aw, h = w / state.ar;
  if (h > ah) { h = ah; w = h * state.ar; }
  st.style.width = Math.max(40, Math.floor(w)) + 'px'; st.style.height = Math.max(40, Math.floor(h)) + 'px';
}

function loop() {
  if (!state) return;
  const v = $('#edVideo');
  if (state.stopAt != null && v.currentTime >= state.stopAt) { v.pause(); state.stopAt = null; }
  draw();
  if (!v.paused) state.raf = requestAnimationFrame(loop);
}

function draw() {
  if (!state) return;
  const v = $('#edVideo'), c = $('#edCanvas');
  const r = c.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.max(2, Math.round(r.width * dpr)), H = Math.max(2, Math.round(r.height * dpr));
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const t = v.currentTime || 0;
  $('#edSeek').value = t; $('#edT').textContent = ft(t);
  const hit = makeCueCursor(state.cues)(t);
  if (hit) drawCaption(ctx, W, H, hit.cue, hit.hi, state.style, state.font);
  const idx = hit ? state.cues.indexOf(hit.cue) : -1;
  if (idx !== state.cur) {
    document.querySelectorAll('#edList .ed-row').forEach((el, i) => el.classList.toggle('on', i === idx));
    state.cur = idx;
  }
}

function renderList() {
  const list = $('#edList');
  list.innerHTML = state.cues.map((c, i) => `
    <div class="ed-row" data-i="${i}">
      <div class="ed-top"><button class="ed-play" data-act="play" title="Tocar este trecho">▶</button>
        <input class="ed-t" data-t="s" value="${ft(c.s)}" inputmode="decimal" aria-label="Início"><span class="ed-arrow">→</span><input class="ed-t" data-t="e" value="${ft(c.e)}" inputmode="decimal" aria-label="Fim">
        <span class="ed-acts">
          <button class="mini" data-act="split" title="Dividir onde está o cursor">Dividir</button>
          ${i < state.cues.length - 1 ? '<button class="mini" data-act="merge" title="Juntar com a próxima">Juntar ↓</button>' : ''}
          <button class="mini" data-act="del" title="Apagar esta fala">Apagar</button></span></div>
      <textarea rows="2" spellcheck="true" lang="pt-BR">${esc(textOf(c))}</textarea>
    </div>`).join('') || '<p class="hint" style="padding:16px">Nenhuma fala. Feche e transcreva de novo.</p>';
  $('#edCount').textContent = state.cues.length + ' falas';
}

function playCue(i) {
  const v = $('#edVideo'), c = state.cues[i];
  if (!c) return;
  v.currentTime = c.s + 0.01;
  state.stopAt = c.e;
  v.play().catch(() => {});
}

function wire() {
  const list = $('#edList');
  list.addEventListener('change', e => {
    const inp = e.target.closest('.ed-t'); if (!inp || !state) return;
    const i = +inp.closest('.ed-row').dataset.i, c = state.cues[i], t = parseT(inp.value);
    const s = inp.dataset.t === 's' ? t : c.s, en = inp.dataset.t === 'e' ? t : c.e;
    if (!isFinite(t) || t < 0 || en - s < 0.1) { inp.value = ft(c[inp.dataset.t]); inp.classList.add('bad'); setTimeout(() => inp.classList.remove('bad'), 1200); return; }
    state.cues[i] = withText({ s, e: en }, textOf(c));
    state.cues.sort((a, b) => a.s - b.s);
    state.dirty = true; renderList(); draw();
  });
  list.addEventListener('input', e => {
    const ta = e.target.closest('textarea'); if (!ta || !state) return;
    const i = +ta.closest('.ed-row').dataset.i;
    state.cues[i] = withText(state.cues[i], ta.value);
    state.dirty = true; draw();
  });
  list.addEventListener('focusin', e => {
    const row = e.target.closest('.ed-row'); if (!row || !state) return;
    const v = $('#edVideo'), c = state.cues[+row.dataset.i];
    if (v.paused && c) { v.currentTime = c.s + Math.min(0.3, (c.e - c.s) / 2); }
  });
  list.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b || !state) return;
    const row = b.closest('.ed-row'), i = +row.dataset.i, c = state.cues[i];
    const act = b.dataset.act;
    if (act === 'play') return playCue(i);
    if (act === 'del') { state.cues.splice(i, 1); }
    if (act === 'merge' && state.cues[i + 1]) {
      const n = state.cues[i + 1];
      state.cues.splice(i, 2, { s: c.s, e: n.e, w: wordsFromSegments([{ text: textOf(c) + ' ' + textOf(n), timestamp: [c.s, n.e] }]) });
    }
    if (act === 'split') {
      const ta = row.querySelector('textarea'), text = ta.value;
      let pos = ta.selectionStart || 0;
      if (pos <= 0 || pos >= text.length) pos = Math.floor(text.length / 2);
      const sp = text.lastIndexOf(' ', pos) > 0 ? text.lastIndexOf(' ', pos) : text.indexOf(' ', pos);
      if (sp <= 0) return;
      const a = text.slice(0, sp).trim(), bTxt = text.slice(sp).trim();
      const mid = c.s + (c.e - c.s) * (a.length / Math.max(1, a.length + bTxt.length));
      state.cues.splice(i, 1, withText({ s: c.s, e: mid }, a), withText({ s: mid, e: c.e }, bTxt));
    }
    state.dirty = true; renderList(); draw();
  });
  $('#edClose').onclick = () => {
    if (state?.dirty && !confirmLeave()) return;
    closeEditor();
  };
  $('#edSave').onclick = () => { const s = state; s.onSave(clean(s.cues)); s.dirty = false; closeEditor(); };
  $('#edGen').onclick = () => { const s = state; s.onSave(clean(s.cues)); closeEditor(); s.onGenerate(); };
  $('#edSrt').onclick = () => {
    const blob = new Blob([toSrt(clean(state.cues), state.style)], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = state.f.name.replace(/\.[^.]+$/, '') + '.srt'; document.body.appendChild(a); a.click(); a.remove();
  };
  window.addEventListener('resize', () => { fit(); draw(); });
  const v = $('#edVideo');
  const pp = () => { if (!state) return; state.stopAt = null; v.paused ? v.play().catch(() => {}) : v.pause(); };
  $('#edPP').onclick = pp; v.onclick = pp;
  $('#edSeek').oninput = e => { v.currentTime = +e.target.value; draw(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && state && !$('#edModal').hidden) $('#edClose').click(); });
}

// sem diálogos do navegador: pede confirmação no próprio botão
let leaveArmed = 0;
function confirmLeave() {
  const b = $('#edClose');
  if (Date.now() - leaveArmed < 4000) return true;
  leaveArmed = Date.now();
  const old = b.textContent; b.textContent = 'Descartar alterações?';
  setTimeout(() => { b.textContent = old; }, 4000);
  return false;
}

const clean = cues => cues.filter(c => c.w.length).sort((a, b) => a.s - b.s);

wire();
