// QuickSub Web: interface + lote. Tudo roda no navegador; os vídeos não saem do computador.
import { DEFAULT_STYLE, buildCues, wordsFromSegments, toSrt, fromSrt, drawCaption, sampleCue } from './captions.js';
import { families, facesOf, bestFace, ensureFace, hasLocalFonts, loadLocalFonts, addUploadedFont, weightName } from './fonts.js';
import { probe, frameAt, audio16k, burn, pickVideoCodec } from './media.js';
import { MODEL_HOST, MODEL_PATH } from './config.js';

const DOWNLOAD_URL = 'https://github.com/ozer0tools/quicksub/releases/latest';
const VIDEO_EXT = /\.(mp4|mov|mkv|m4v|webm|avi|wmv|flv|mts|m2ts|ts|3gp|mpg|mpeg|ogv)$/i;
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDur = s => s ? Math.floor(s / 60) + ':' + String(Math.round(s % 60) % 60).padStart(2, '0') : '—';
const fmtSize = b => b >= 1e9 ? (b / 1e9).toFixed(2).replace('.', ',') + ' GB' : (b / 1e6).toFixed(1).replace('.', ',') + ' MB';
const stem = n => n.replace(/\.[^.]+$/, '');
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };

const DEFAULT_OPTS = { model: 'turbo', mode: 'tudo', quality: 'padrao', reuse_srt: true };
const saved = store.get('qs-web-cfg') || {};
const style = { ...DEFAULT_STYLE, ...(saved.style || {}) };
const opts = { ...DEFAULT_OPTS, ...(saved.opts || {}) };
const save = () => store.set('qs-web-cfg', { style, opts });

let files = [];          // {id, file, name, size, mtime, info, err, srt, status, pct, msg}
let selected = null, view = store.get('qs-view') || 'list';
let running = false, abortCtl = null, outDir = null;
const caps = { webgpu: false, f16: false, codec: null };
const ST = { fila: ['Na fila', ''], audio: ['Lendo áudio', 'run'], modelo: ['Baixando modelo', 'run'], transcrevendo: ['Transcrevendo', 'run'],
  queimando: ['Gerando vídeo', 'run'], pronto: ['Pronto', 'done'], erro: ['Erro', 'bad'], cancelado: ['Cancelado', ''], pulado: ['Sem fala', ''] };
const CODEC = { avc: 'H.264', hevc: 'HEVC (H.265)', vp9: 'VP9', vp8: 'VP8', av1: 'AV1', aac: 'AAC', mp3: 'MP3', opus: 'Opus',
  vorbis: 'Vorbis', ac3: 'AC-3', eac3: 'E-AC-3', flac: 'FLAC' };
const cname = c => c ? (CODEC[c] || (String(c).startsWith('pcm') ? 'PCM' : String(c).toUpperCase())) : '—';
const MODEL_NAME = { turbo: 'turbo', small: 'small', base: 'base' };

// ------------------------------------------------------------ transcrição (worker)
let worker = null, pending = null;
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./asr.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => pending?.(data);
  return worker;
}
function killWorker() { worker?.terminate(); worker = null; }
function transcribe(audio, onMsg) {
  return new Promise((resolve, reject) => {
    pending = d => {
      if (d.type === 'result') { pending = null; resolve(d.segments); }
      else if (d.type === 'error') { pending = null; reject(new Error(d.message)); }
      else onMsg(d);
    };
    getWorker().postMessage({ type: 'run', id: 1, audio, model: opts.model, device: caps.webgpu ? 'webgpu' : 'wasm',
      modelHost: MODEL_HOST, modelPath: MODEL_PATH, ortBase: new URL('./ort/', document.baseURI).href }, [audio.buffer]);
  });
}

let transcribeImpl = transcribe;

// ------------------------------------------------------------ preview
const frames = new Map(); // id -> {canvas,w,h}
async function refFrame() {
  const v = $('#ref').value, f = files.find(x => x.id === v);
  if (f && !f.err) {
    if (!frames.has(f.id)) {
      try { frames.set(f.id, await frameAt(f.file, 1280)); } catch (e) { frames.set(f.id, null); }
    }
    const fr = frames.get(f.id);
    if (fr) return fr;
  }
  const vert = v === '@v';
  return { canvas: null, w: vert ? 1080 : 1920, h: vert ? 1920 : 1080 };
}
let prevBusy = false, prevAgain = false;
async function preview() {
  if (prevBusy) { prevAgain = true; return; }
  prevBusy = true;
  try {
    const fr = await refFrame();
    const font = await ensureFace(style.face, style.font);
    const scale = Math.min(1, 1280 / Math.max(fr.w, fr.h));
    const W = Math.round(fr.w * scale), H = Math.round(fr.h * scale);
    const c = $('#prev'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    if (fr.canvas) ctx.drawImage(fr.canvas, 0, 0, W, H); else { ctx.fillStyle = '#565b63'; ctx.fillRect(0, 0, W, H); }
    const cue = sampleCue($('#sample').value, style);
    drawCaption(ctx, W, H, cue, style.highlight ? Math.min(1, cue.w.length - 1) : -1, style, font);
  } catch (e) { console.error(e); }
  prevBusy = false;
  if (prevAgain) { prevAgain = false; preview(); }
  renderStats();
}
let pt = null;
const queuePreview = () => { clearTimeout(pt); pt = setTimeout(() => { save(); preview(); }, 120); };

function renderStats() {
  const f = files.find(x => x.id === $('#ref').value);
  $('#sRes').textContent = f && f.info ? f.info.w + '×' + f.info.h : $('#ref').value === '@v' ? '1080×1920' : '1920×1080';
  $('#sDur').textContent = f && f.info ? fmtDur(f.info.dur) : '—';
  $('#sDev').textContent = caps.webgpu ? 'WebGPU' : 'Processador';
  $('#sMod').textContent = MODEL_NAME[opts.model] || opts.model;
}
function renderRef() {
  const cur = $('#ref').value, ok = files.filter(f => !f.err);
  $('#ref').innerHTML = ok.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('') +
    '<option value="@h">Fundo neutro 16:9</option><option value="@v">Fundo neutro 9:16</option>';
  if ([...$('#ref').options].some(o => o.value === cur) && !(cur.startsWith('@') && ok.length)) $('#ref').value = cur;
  $('#count').textContent = String(ok.length).padStart(2, '0');
}

// ------------------------------------------------------------ lista e painel
const thumbs = new Map();
async function thumb(f) {
  if (thumbs.has(f.id) || f.err) return;
  thumbs.set(f.id, '');
  try {
    const fr = await frameAt(f.file, 320);
    const blob = await (fr.canvas.convertToBlob ? fr.canvas.convertToBlob({ type: 'image/jpeg', quality: .8 })
      : new Promise(r => fr.canvas.toBlob(r, 'image/jpeg', .8)));
    thumbs.set(f.id, URL.createObjectURL(blob));
    renderList();
  } catch (e) {}
}
function stInfo(f) {
  const st = f.status;
  const [label, cls] = st ? (ST[st] || [st, '']) : [f.err ? 'Inválido' : 'Na lista', f.err ? 'bad' : ''];
  const pct = st === 'pronto' ? 100 : f.pct || 0;
  return { st, label, cls, pct };
}
function rowHtml(f, i) {
  const s = stInfo(f), sel = f.id === selected ? ' sel' : '';
  const rm = running ? '<span></span>' : `<button class="vx" data-rm="${i}" title="Remover da lista" aria-label="Remover">×</button>`;
  const busy = s.st && s.st !== 'pronto' && s.st !== 'fila' && s.st !== 'erro';
  if (view === 'thumbs') {
    thumb(f);
    const t = thumbs.get(f.id);
    return `<div class="vtile${sel}" data-i="${i}" title="${esc(f.name)}"><span class="tag ${s.cls}">${esc(s.label)}</span>${running ? '' : rm}
      <div class="tm">${t ? `<img src="${t}" alt="">` : ''}</div><span class="vn">${esc(f.name)}</span>
      ${busy ? `<i class="vp" style="width:${s.pct}%"></i>` : ''}</div>`;
  }
  return `<div class="vrow${sel}" data-i="${i}" title="${esc(f.name)}"><span class="sq ${s.cls}" title="${esc(s.label)}"></span>
    <span class="vn">${esc(f.name)}${f.srt ? '<span class="vtag">+ srt</span>' : ''}</span>
    <span class="vd">${busy ? s.pct + '%' : fmtDur(f.info && f.info.dur)}</span>${rm}
    ${busy ? `<i class="vp" style="width:${s.pct}%"></i>` : ''}</div>`;
}
function renderList() {
  const box = $('#vitems');
  box.className = view === 'thumbs' && files.length ? 'thumbs' : '';
  box.innerHTML = files.length ? files.map(rowHtml).join('')
    : `<button class="vempty" id="emptyPick"><b>+ Escolher vídeos</b>Selecione ou arraste os vídeos para cá.<br>Eles não saem do seu computador.</button>`;
  const e = $('#emptyPick'); if (e) e.onclick = () => $('#fileInput').click();
}
function ratio(w, h) {
  if (!w || !h) return '—';
  const k = [[16, 9], [9, 16], [4, 3], [3, 4], [1, 1], [4, 5], [21, 9], [2, 3]].find(([a, b]) => Math.abs(w / h - a / b) < 0.01);
  return k ? k.join(':') : (w / h).toFixed(2).replace('.', ',') + ':1';
}
function renderInfo() {
  const f = files.find(x => x.id === selected), box = $('#info');
  if (!f) { box.innerHTML = `<div class="iempty"><div><svg width="34" height="26" viewBox="0 0 34 26" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1" y="1" width="32" height="24" rx="2"/><path d="M6 17h16M25 17h3M9 21h16"/></svg>Clique em um vídeo para ver as informações</div></div>`; return; }
  const d = f.info || {}, s = stInfo(f);
  const cell = (v, l, wide) => `<div${wide ? ' class="wide"' : ''}><b>${esc(v ?? '—')}</b><small>${l}</small></div>`;
  const notes = [];
  if (f.err) notes.push(['warn', f.err]);
  if (f.info) {
    if (!d.acodec) notes.push(['warn', 'Sem áudio: não tem o que transcrever']);
    else if (!d.canDecodeAudio) notes.push(['warn', 'Este navegador não consegue ler o áudio deste arquivo']);
    if (!d.canDecode) notes.push(['warn', 'Este navegador não consegue ler o vídeo deste arquivo']);
    if (d.hdr) notes.push(['warn', 'Vídeo HDR: as cores podem sair lavadas']);
    if (d.w % 2 || d.h % 2) notes.push(['', `Dimensão ímpar: sai como ${d.w - d.w % 2}×${d.h - d.h % 2}`]);
    if (f.srt) notes.push(['', opts.reuse_srt ? `Vai usar o ${f.srt.name} no lugar da transcrição` : `Tem um ${f.srt.name} junto (desligado em Exportação)`]);
  }
  const ch = d.channels === 1 ? 'mono' : d.channels === 2 ? 'estéreo' : d.channels ? d.channels + ' canais' : '—';
  box.innerHTML = `<span class="tag or">Info</span>
    <p class="iname">${esc(f.name)}</p><p class="ipath">${f.file.webkitRelativePath ? esc(f.file.webkitRelativePath.replace(/\/[^/]*$/, '')) : 'Arquivo local'}</p>
    <div class="igrid">
      ${cell(fmtSize(f.size), 'Tamanho')}${cell(fmtDur(d.dur), 'Duração')}
      ${cell(d.w ? d.w + '×' + d.h : '—', 'Resolução')}${cell(ratio(d.w, d.h), 'Proporção')}
      ${cell(d.fps ? (Math.round(d.fps * 100) / 100 + ' fps').replace('.', ',') : '—', 'Quadros')}${cell(d.bitrate ? (d.bitrate / 1e6).toFixed(1).replace('.', ',') + ' Mb/s' : '—', 'Bitrate')}
      ${cell(cname(d.vcodec), 'Vídeo')}${cell(d.acodec ? cname(d.acodec) + (d.hz ? ' · ' + Math.round(d.hz / 1000) + ' kHz' : '') : 'Sem áudio', 'Áudio')}
      ${cell(ch, 'Canais')}${cell((f.name.split('.').pop() || '').toUpperCase(), 'Formato')}
      ${cell(new Date(f.mtime).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }), 'Modificado em', true)}
    </div>
    ${notes.length ? `<ul class="inotes">${notes.map(([c, t]) => `<li class="${c}">${esc(t)}</li>`).join('')}</ul>` : ''}
    ${s.st ? `<div class="istat"><b>${esc(s.label)}</b> · ${s.pct}%${f.msg ? `<div class="${s.st === 'erro' ? 'err' : 'hint'}" style="margin-top:4px;font-size:11px">${esc(f.msg)}</div>` : ''}<div class="pb"><i style="width:${s.pct}%"></i></div></div>` : ''}
    <div class="iact">${f.out ? '<button class="tagbtn" data-act="save">Baixar de novo</button>' : ''}${running ? '' : '<button class="tagbtn" data-act="rm">Remover da lista</button>'}</div>`;
}
function renderFiles() {
  if (selected && !files.some(f => f.id === selected)) selected = null;
  renderList(); renderInfo();
  const n = files.filter(f => !f.err).length;
  $$('[data-go]').forEach(b => {
    b.textContent = running ? 'Cancelar' : n ? `Legendar ${n} vídeo${n > 1 ? 's' : ''}` : 'Legendar';
    b.disabled = !running && !n;
  });
  $('#clear').hidden = running || !files.length;
}
function select(id, fromRef) {
  selected = id; renderList(); renderInfo();
  if (id && !fromRef && [...$('#ref').options].some(o => o.value === id)) { $('#ref').value = id; preview(); }
}
let uid = 0;
async function addFiles(list) {
  const srts = [], vids = [];
  for (const file of list) {
    if (/\.srt$/i.test(file.name)) srts.push(file);
    else if (VIDEO_EXT.test(file.name) || file.type.startsWith('video/')) vids.push(file);
  }
  for (const file of vids) {
    if (/_legendado\./i.test(file.name)) continue;
    if (files.some(f => f.name === file.name && f.size === file.size)) continue;
    files.push({ id: 'v' + (++uid), file, name: file.name, size: file.size, mtime: file.lastModified, info: null });
  }
  for (const s of srts) {
    const f = files.find(x => stem(x.name).toLowerCase() === stem(s.name).toLowerCase());
    if (f) f.srt = s;
  }
  renderFiles(); renderRef();
  for (const f of files.filter(x => !x.info && !x.err)) {
    try { f.info = await probe(f.file); } catch (e) { f.err = String(e.message || e); }
    renderFiles(); renderRef();
    if (f.id === selected) renderInfo();
  }
  if (!files.some(f => f.id === $('#ref').value)) { const first = files.find(f => !f.err); if (first) $('#ref').value = first.id; }
  renderStats(); preview();
}
function removeAt(i) {
  if (running || i < 0) return;
  const [f] = files.splice(i, 1);
  if (f && f.id === selected) selected = null;
  renderFiles(); renderRef(); preview();
}

// ------------------------------------------------------------ fontes na interface
function renderFamilies() {
  const groups = { b: [], o: [] };
  for (const [fam, faces] of families) (faces.some(x => x.origin === 'b') ? groups.b : groups.o).push(fam);
  groups.o.sort((a, b) => a.localeCompare(b));
  $('#family').innerHTML = `<optgroup label="Do QuickSub">${groups.b.map(f => `<option>${esc(f)}</option>`).join('')}</optgroup>` +
    (groups.o.length ? `<optgroup label="Do seu computador">${groups.o.map(f => `<option>${esc(f)}</option>`).join('')}</optgroup>` : '');
  if (!families.has(style.font)) style.font = 'Montserrat';
  $('#family').value = style.font;
  renderFaces();
}
function renderFaces() {
  const faces = facesOf(style.font);
  if (!faces.some(x => x.id === style.face)) style.face = bestFace(style.font, 700)?.id;
  $('#face').innerHTML = faces.map(x => `<option value="${esc(x.id)}">${esc(x.label || weightName(x.weight, x.italic))} · ${x.weight}</option>`).join('');
  $('#face').value = style.face;
}
$('#family').onchange = e => { style.font = e.target.value; style.face = null; renderFaces(); queuePreview(); };
$('#face').onchange = e => { style.face = e.target.value; queuePreview(); };
if (hasLocalFonts()) {
  $('#localFonts').hidden = false;
  $('#localFonts').onclick = async () => {
    try { const n = await loadLocalFonts(); $('#localFonts').textContent = n + ' fontes do computador'; renderFamilies(); }
    catch (e) { $('#localFonts').textContent = 'Permissão negada'; }
  };
}
$('#fontInput').onchange = async e => {
  let last = null;
  for (const f of e.target.files) last = await addUploadedFont(f);
  if (last) { style.font = last.family; style.face = last.id; renderFamilies(); queuePreview(); }
  e.target.value = '';
};

// ------------------------------------------------------------ saída
const canPickDir = 'showDirectoryPicker' in window;
function renderOut() {
  $('#pickOut').hidden = !canPickDir;
  $('#outName').textContent = outDir ? outDir.name : '';
  $('#outNote').textContent = canPickDir
    ? (outDir ? 'Os vídeos e os .srt são gravados direto nesta pasta.'
      : 'O Chrome não deixa usar a Área de Trabalho, Documentos, Downloads ou a raiz do disco direto: escolha ou crie uma subpasta (ex.: Vídeos\\Legendados) com o botão "Nova pasta" da janela. Sem pasta, cada arquivo vira um download.')
    : 'Este navegador não deixa gravar numa pasta: cada vídeo e .srt vira um download. Chrome e Edge gravam direto na pasta.';
}
async function pickOut() {
  outDir = await window.showDirectoryPicker({ id: 'quicksub-out', mode: 'readwrite', startIn: 'videos' });
  renderOut();
}
$('#pickOut').onclick = () => pickOut().catch(() => {});
async function writeOut(name, data) {
  if (outDir) {
    const h = await outDir.getFileHandle(name, { create: true });
    const w = await h.createWritable(); await w.write(data); await w.close();
  } else downloadBlob(name, data instanceof Blob ? data : new Blob([data]));
}
function downloadBlob(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// ------------------------------------------------------------ popup do download do modelo
const mb = n => Math.round(n / 1e6).toLocaleString('pt-BR');
const modal = {
  shown: false,
  progress(l, t, speed) {
    if (!this.shown) { $('#dlModal').hidden = false; this.shown = true; }
    const p = Math.min(100, l / t * 100);
    $('#dlTitle').textContent = `Baixando o modelo ${MODEL_NAME[opts.model]}`;
    $('#dlBar').parentElement.classList.toggle('ind', p >= 99.9);
    $('#dlBar').style.width = p + '%';
    if (p >= 99.9) {
      $('#dlPct').textContent = 'Preparando';
      $('#dlInfo').textContent = caps.webgpu ? 'carregando na placa de vídeo, pode levar até 1 minuto…' : 'carregando o modelo, pode levar até 1 minuto…';
      return;
    }
    $('#dlPct').textContent = Math.floor(p) + '%';
    const eta = speed > 0 ? Math.max(1, Math.round((t - l) / speed)) : 0;
    $('#dlVar').textContent = this.variant || '';
    $('#dlInfo').textContent = `${mb(l)} de ${mb(t)} MB` + (speed > 0 ? ` · ${(speed / 1e6).toFixed(1).replace('.', ',')} MB/s · faltam ${eta < 60 ? eta + ' s' : Math.ceil(eta / 60) + ' min'}` : '');
  },
  hide() { if (this.shown) { $('#dlModal').hidden = true; this.shown = false; } },
};

// ------------------------------------------------------------ lote
const log = m => { $('#log').textContent = m; };
async function processOne(f, signal) {
  const set = (status, pct = f.pct, msg = f.msg) => { Object.assign(f, { status, pct: Math.round(pct), msg }); renderList(); if (f.id === selected) renderInfo(); };
  let cues;
  if (opts.reuse_srt && f.srt) {
    cues = fromSrt(await f.srt.text(), style);
    log(`${f.name}: usando ${f.srt.name}`);
  } else {
    if (!f.info.acodec) throw new Error('Este vídeo não tem áudio.');
    set('audio', 0, '');
    const audio = await audio16k(f.file, p => set('audio', p * 100));
    if (signal.aborted) throw new DOMException('', 'AbortError');
    set('transcrevendo', 0);
    let downloading = false;
    const segs = await transcribeImpl(audio, d => {
      if (d.type === 'dl-progress' && d.total) {
        downloading = true;
        set('modelo', d.loaded / d.total * 100);
        modal.progress(d.loaded, d.total, d.speed);
      }
      if (d.type === 'run-progress') { modal.hide(); set('transcrevendo', d.pct * 100); }
      if (d.type === 'load-plan') {
        modal.variant = d.f16 ? 'versão leve (fp16)' : 'versão completa: o navegador não informou suporte a fp16 na placa';
        console.info('[QuickSub] plano', d);
      }
      if (d.type === 'model-info') {
        const dt = typeof d.dtype === 'string' ? d.dtype : `ouvido ${d.dtype.encoder_model}, texto ${d.dtype.decoder_model_merged}`;
        $('#modelNote').textContent = `Modelo carregado: ${MODEL_NAME[opts.model]} (${dt}).` + (d.errors.length ? ' Versões que falharam antes: ' + d.errors.join(' | ') : '');
        console.info('[QuickSub] modelo', d);
      }
    }).finally(() => modal.hide());
    if (downloading) log('Modelo baixado e guardado neste navegador.');
    cues = buildCues(wordsFromSegments(segs), +style.max_chars, +style.max_lines);
  }
  if (!cues.length) { set('pulado', 100, 'Nenhuma fala detectada.'); return; }
  await writeOut(stem(f.name) + '.srt', new Blob([toSrt(cues, style)], { type: 'text/plain;charset=utf-8' }));
  if (opts.mode === 'srt') { set('pronto', 100, 'SRT gerado'); return; }
  set('queimando', 0);
  const font = await ensureFace(style.face, style.font);
  const name = stem(f.name) + '_legendado.mp4';
  let writable = null;
  if (outDir) writable = await (await outDir.getFileHandle(name, { create: true })).createWritable();
  try {
    const r = await burn(f.file, { cues, style, font, quality: opts.quality, writable, signal, onPct: p => set('queimando', p * 100) });
    if (writable) await writable.close().catch(() => {});
    if (r.buffer) { f.out = { name, blob: new Blob([r.buffer], { type: 'video/mp4' }) }; downloadBlob(name, f.out.blob); }
    set('pronto', 100, r.codec !== 'avc' ? `Gerado em ${cname(r.codec)}: este navegador não gera H.264` : '');
  } catch (e) { if (writable) await writable.abort?.().catch(() => {}); throw e; }
}
async function runBatch() {
  if (!files.some(f => !f.err)) return;
  if (canPickDir && !outDir) {
    log('Escolha onde salvar. Dica: crie uma subpasta, por exemplo Vídeos\\Legendados.');
    try { await pickOut(); }
    catch (e) { log('Sem pasta escolhida: os vídeos e .srt vão como downloads.'); }
  }
  running = true; abortCtl = new AbortController();
  const list = files.filter(f => !f.err);
  list.forEach(f => Object.assign(f, { status: 'fila', pct: 0, msg: '', out: null }));
  renderFiles();
  const t0 = Date.now();
  for (const f of list) {
    if (abortCtl.signal.aborted) break;
    try { await processOne(f, abortCtl.signal); }
    catch (e) {
      if (abortCtl.signal.aborted || e.name === 'AbortError' || /cancel/i.test(e.name + e.message)) { f.status = 'cancelado'; f.msg = ''; break; }
      console.error(e); f.status = 'erro'; f.msg = String(e.message || e);
    }
    renderFiles();
  }
  list.forEach(f => { if (f.status === 'fila') f.status = 'cancelado'; });
  running = false; renderFiles();
  const secs = Math.round((Date.now() - t0) / 1000);
  log(`Lote finalizado em ${secs < 60 ? secs + ' s' : Math.floor(secs / 60) + ' min ' + (secs % 60) + ' s'}.`);
}
function cancelBatch() { abortCtl?.abort(); killWorker(); modal.hide(); if (pending) { pending({ type: 'error', message: 'cancelado' }); } }

// ------------------------------------------------------------ eventos
function bind(sel, obj, attr) {
  $$(sel).forEach(el => {
    const k = el.dataset[attr];
    if (!(k in obj)) return;
    if (el.type === 'checkbox') el.checked = !!obj[k]; else el.value = obj[k];
    const out = el.type === 'range' && el.nextElementSibling?.tagName === 'OUTPUT' ? el.nextElementSibling : null;
    const show = () => { if (out) out.textContent = el.value; };
    show();
    el.addEventListener('input', () => {
      obj[k] = el.type === 'checkbox' ? el.checked : (el.type === 'range' || 'num' in el.dataset) ? +el.value : el.value;
      show(); queuePreview(); if (k === 'model') renderModelNote();
    });
  });
}
$$('[data-tab]').forEach(b => b.onclick = () => {
  $$('[data-tab]').forEach(x => x.classList.toggle('on', x === b));
  $$('[data-panel]').forEach(p => p.classList.toggle('on', p.dataset.panel === b.dataset.tab));
});
$('#vitems').addEventListener('click', e => {
  const rm = e.target.closest('[data-rm]');
  if (rm) { e.stopPropagation(); return removeAt(+rm.dataset.rm); }
  const row = e.target.closest('[data-i]');
  if (row) { const f = files[+row.dataset.i]; select(f && f.id === selected ? null : f && f.id); }
});
$('#info').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const f = files.find(x => x.id === selected);
  if (b.dataset.act === 'save' && f?.out) downloadBlob(f.out.name, f.out.blob);
  if (b.dataset.act === 'rm') removeAt(files.findIndex(x => x.id === selected));
});
$$('[data-view]').forEach(b => {
  b.classList.toggle('on', b.dataset.view === view);
  b.onclick = () => { view = b.dataset.view; $$('[data-view]').forEach(x => x.classList.toggle('on', x === b)); store.set('qs-view', view); renderList(); };
});
$('#pickFiles').onclick = () => $('#fileInput').click();
$('#pickFolder').onclick = () => $('#dirInput').click();
$('#fileInput').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
$('#dirInput').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
const vl = $('.vlist');
vl.addEventListener('dragover', e => { e.preventDefault(); vl.classList.add('drag'); });
vl.addEventListener('dragleave', () => vl.classList.remove('drag'));
vl.addEventListener('drop', async e => {
  e.preventDefault(); vl.classList.remove('drag');
  const out = [];
  const walk = async entry => {
    if (entry.isFile) out.push(await new Promise(r => entry.file(r)));
    else if (entry.isDirectory) {
      const rd = entry.createReader();
      let batch; do { batch = await new Promise(r => rd.readEntries(r)); for (const x of batch) await walk(x); } while (batch.length);
    }
  };
  const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) for (const en of entries) await walk(en); else out.push(...e.dataTransfer.files);
  addFiles(out);
});
$('#sample').addEventListener('input', queuePreview);
$('#ref').addEventListener('change', () => { preview(); const v = $('#ref').value; if (!v.startsWith('@')) select(v, true); });
$('#nextRef').onclick = () => { const s = $('#ref'); s.selectedIndex = (s.selectedIndex + 1) % s.options.length; s.dispatchEvent(new Event('change')); };
$('#clear').onclick = () => { files = []; selected = null; renderFiles(); renderRef(); preview(); };
$('#open').onclick = () => window.open(DOWNLOAD_URL, '_blank', 'noopener');
$$('[data-go]').forEach(b => b.onclick = () => (running ? cancelBatch() : runBatch()));
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#theme .lbl').textContent = t === 'dark' ? 'Claro' : 'Escuro';
  try { localStorage.setItem('qs-theme', t); } catch (e) {}
}
$('#theme').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
setTheme(document.documentElement.dataset.theme || 'light');
window.addEventListener('beforeunload', e => { if (running) { e.preventDefault(); e.returnValue = ''; } });

function renderModelNote() {
  const slow = !caps.webgpu && opts.model === 'turbo';
  $('#modelNote').textContent = slow ? 'O turbo sem placa de vídeo é muito lento no navegador. Prefira o small, ou a versão para Windows.'
    : opts.model === 'base' ? 'O base é rápido, mas erra mais em nomes e palavras difíceis.' : '';
}
function banner(title, text) {
  $('#banner').hidden = false; $('#bannerTitle').textContent = title; $('#bannerText').textContent = text;
  $('#bannerLink').href = DOWNLOAD_URL;
}

// ------------------------------------------------------------ início
(async () => {
  try {
    if (navigator.gpu) {
      const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (ad) { caps.webgpu = true; caps.f16 = ad.features.has('shader-f16'); }
    }
  } catch (e) {}
  const fresh = !saved.opts;
  if (fresh && !caps.webgpu) opts.model = 'small';
  $('#gpuNote').textContent = caps.webgpu
    ? 'Placa de vídeo disponível (WebGPU): a transcrição roda nela.'
    : 'Sem WebGPU neste navegador: a transcrição roda no processador, bem mais devagar.';
  caps.codec = 'VideoEncoder' in window ? await pickVideoCodec().catch(() => null) : null;
  if (!caps.codec) banner('Este navegador não consegue gerar vídeo', 'Use o Chrome ou o Edge atualizados, ou baixe a versão para Windows.');
  else if (!caps.webgpu) banner('Sem aceleração por placa de vídeo neste navegador',
    'Vai funcionar, mas bem mais devagar: a transcrição roda no processador. Para lotes grandes, a versão para Windows é muito mais rápida.');
  renderFamilies();
  bind('[data-k]', style, 'k'); bind('[data-o]', opts, 'o');
  renderModelNote(); renderOut(); renderRef(); renderFiles(); preview();
})();

// gancho de teste: ?demo troca a transcrição por um texto fixo (sem baixar modelo)
if (new URLSearchParams(location.search).has('demo')) {
  window.__qsDemo = true;
  const fake = 'Olá pessoal, hoje eu vou mostrar como funciona a legenda automática direto no navegador.';
  transcribeImpl = async (audio, onMsg) => {
    if (!window.__qsDemoDl && new URLSearchParams(location.search).has('demodl')) {
      window.__qsDemoDl = true;
      const T = 1.55e9;
      for (let i = 0; i <= 20; i++) { await new Promise(r => setTimeout(r, 120)); onMsg({ type: 'dl-progress', loaded: T * i / 20, total: T, speed: 38e6 }); }
      await new Promise(r => setTimeout(r, 900));
    }
    for (let i = 1; i <= 5; i++) { await new Promise(r => setTimeout(r, 150)); onMsg({ type: 'run-progress', pct: i / 5 }); }
    const dur = audio.length / 16000;
    return [{ text: fake, timestamp: [0.2, Math.min(dur, 5.5)] }];
  };
}
