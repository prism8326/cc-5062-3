// 颜料 KM 绘画原型 —— 界面控制器。
// 所有颜色/状态变更都调用 js/ 下的内核模块；UI 只负责采集输入与呈现求值结果。

import {
  PIGMENTS,
  PIGMENT_SET_ID,
  PIGMENT_SET_NOTE,
  SUBSTRATES,
} from './pigments.js';
import { PAPER, mixtureColor, evaluatePixelSpectrum, evaluatePixelColor } from './render.js';
import {
  spectrumToDisplay,
  deltaE76,
  deltaE2000,
} from './spectra.js';
import { PaintDocument, Brush, DOC_W, DOC_H, STAMP_CENTER_MASS } from './document.js';
import { renderAll, renderCells } from './render.js';
import {
  runChecks,
  thicknessGradient,
  ratioRamp,
  substrateGrid,
  orderComparison,
} from './checks.js';
import {
  METAMER_RECIPES,
  SealableSwatch,
  modelDifference,
  buildExperimentReport,
} from './pigment-lab.js';
import { paintTwoRowRamp, paintHorizontalStrip, drawSpectrumChart, downloadBlob, nowStamp } from './ui/widgets.js';
import { gzipString, gunzipToText } from './codec.js';
import { health } from './health.js';

const $ = (sel) => document.querySelector(sel);
const P = PIGMENTS.length;

// ---------- 全局应用状态 ----------
let doc = new PaintDocument(DOC_W, DOC_H);
const brush = new Brush();
let imageData = null;

const mixerParts = new Float64Array(P);
let tool = 'brush';
let zoomMode = 'fit';
let zoomFactor = 1;
const ZOOM_LEVELS = [0.5, 0.75, 1, 1.5, 2, 3, 4];

const samples = { A: null, B: null };
const history = [];
const HISTORY_CAP = 16;

const stroke = { active: false, x: 0, y: 0, before: null };

let labSwatches = createLabSwatches();
let lastIntegration = null;

function createLabSwatches() {
  return METAMER_RECIPES.map((recipe) => new SealableSwatch(recipe, { wet: true }));
}

// ---------- 小工具 ----------
function toast(msg, kind = '', ms = 3200) {
  const wrap = $('#toast-wrap');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function pigmentHex(i, amount = 1.6) {
  const m = new Array(P).fill(0);
  m[i] = amount;
  return mixtureColor(m, amount / 0.45, PAPER).hex;
}

function brushColor(wet = true) {
  const M = brush.totalMass();
  if (M < 1e-6) return null;
  return mixtureColor(Array.from(brush.m), M + brush.v, PAPER, wet);
}

function attachBuffer() {
  const view = $('#view');
  view.width = doc.W;
  view.height = doc.H;
  const ctx = view.getContext('2d', { willReadFrequently: true });
  imageData = ctx.createImageData(doc.W, doc.H);
  // 初始纸白不透明
  for (let i = 0; i < doc.N; i++) {
    const c = spectrumToDisplay(PAPER);
    imageData.data[i * 4] = c.r;
    imageData.data[i * 4 + 1] = c.g;
    imageData.data[i * 4 + 2] = c.b;
    imageData.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
}

function paintAll() {
  renderAll(doc, imageData);
  $('#view').getContext('2d').putImageData(imageData, 0, 0);
}

function paintCells(cells) {
  if (!cells || cells.size === 0) return;
  renderCells(doc, cells, imageData);
  $('#view').getContext('2d').putImageData(imageData, 0, 0);
}

// ---------- 色料库列表 ----------
function buildPigmentList() {
  $('#pigment-set-note').textContent = PIGMENT_SET_ID;
  const root = $('#pigment-list');
  root.innerHTML = '';
  PIGMENTS.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'pigment-row';
    const thin = pigmentHex(i, 0.12);
    const thick = pigmentHex(i, 2.4);
    row.innerHTML = `
      <span class="p-swatch" style="background:linear-gradient(135deg,${thin},${thick})" title="薄→厚 kernel 求值"></span>
      <span class="p-name"><b>${p.name}</b><span>${p.code} · 染色 ${p.staining.toFixed(2)}</span></span>
      <span class="stepper">
        <button data-act="minus" aria-label="减少">−</button>
        <input data-role="parts" type="number" min="0" max="20" step="1" value="0" />
        <button data-act="plus" aria-label="增加">＋</button>
      </span>
      <button class="btn mini p-dip" data-act="dip" title="只用此色料蘸笔">蘸</button>
    `;
    const input = row.querySelector('input');
    input.addEventListener('change', () => {
      mixerParts[i] = Math.max(0, Math.min(50, Number(input.value) || 0));
      refreshMixer();
    });
    row.querySelector('[data-act=plus]').addEventListener('click', () => {
      mixerParts[i] = Math.min(20, mixerParts[i] + 1);
      input.value = mixerParts[i];
      refreshMixer();
    });
    row.querySelector('[data-act=minus]').addEventListener('click', () => {
      mixerParts[i] = Math.max(0, mixerParts[i] - 1);
      input.value = mixerParts[i];
      refreshMixer();
    });
    row.querySelector('[data-act=dip]').addEventListener('click', () => {
      const parts = new Array(P).fill(0);
      parts[i] = 1;
      brush.loadMix(parts, { vehicleRatio: Number($('#sl-water').value) });
      refreshBrushUI();
      toast(`已用 ${p.name} 蘸笔`);
    });
    root.appendChild(row);
  });
}

function syncPigmentInputs() {
  document.querySelectorAll('#pigment-list input[data-role=parts]').forEach((inp, i) => {
    inp.value = mixerParts[i] || 0;
  });
}

// ---------- 调色皿 ----------
function refreshMixer() {
  const rows = $('#mixer-rows');
  rows.innerHTML = '';
  let total = 0;
  for (let i = 0; i < P; i++) total += mixerParts[i];

  for (let i = 0; i < P; i++) {
    if (mixerParts[i] <= 0) continue;
    const row = document.createElement('div');
    row.className = 'mix-row';
    row.innerHTML = `
      <span class="mix-dot" style="background:${pigmentHex(i)}"></span>
      <input type="range" min="0" max="8" step="0.5" value="${Math.min(8, mixerParts[i])}" />
      <span class="parts-val">${mixerParts[i]} 份</span>
    `;
    const range = row.querySelector('input');
    const val = row.querySelector('.parts-val');
    range.addEventListener('input', () => {
      mixerParts[i] = Number(range.value);
      val.textContent = `${mixerParts[i]} 份`;
      syncPigmentInputs();
      drawMixerRamp();
      updateMixerSwatch();
    });
    rows.appendChild(row);
  }

  drawMixerRamp();
  updateMixerSwatch();
}

function mixerMassAt(h, c = 0.45) {
  let sum = 0;
  for (const x of mixerParts) sum += x;
  const m = new Array(P).fill(0);
  if (sum <= 0) return m;
  const M = c * h;
  for (let i = 0; i < P; i++) m[i] = (M * mixerParts[i]) / sum;
  return m;
}

function drawMixerRamp() {
  const canvas = $('#mixer-ramp');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  let sum = 0;
  for (const x of mixerParts) sum += x;
  if (sum <= 0) {
    ctx.fillStyle = '#f4f6fa';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#9aa3b5';
    ctx.font = '12px sans-serif';
    ctx.fillText('设定份数后，这里显示该配方的薄→厚求值色带（上白纸 / 下黑底）', 10, 34);
    return;
  }
  const black = SUBSTRATES.find((s) => s.id === 'black').spectrum;
  const n = 34;
  const top = [],
    bottom = [];
  for (let s = 0; s < n; s++) {
    const t = s / (n - 1);
    const h = 0.08 * Math.pow(9 / 0.08, t);
    const m = mixerMassAt(h);
    top.push(mixtureColor(m, h, PAPER).hex);
    bottom.push(mixtureColor(m, h, black).hex);
  }
  paintTwoRowRamp(canvas, top, bottom);
}

function updateMixerSwatch() {
  let sum = 0;
  for (const x of mixerParts) sum += x;
  const sw = $('#mixer-swatch');
  if (sum <= 0) {
    sw.style.background = '';
    $('#mixer-hex').textContent = '—';
    $('#mixer-conc').textContent = '调色皿为空';
    return;
  }
  const c = mixtureColor(mixerMassAt(2.4), 2.4, PAPER);
  sw.style.background = c.hex;
  $('#mixer-hex').textContent = c.hex;
  const kinds = mixerParts.filter((x) => x > 0).length;
  $('#mixer-conc').textContent = `${kinds} 种色料 · 共 ${sum} 份（均质预混）`;
}

// ---------- 画笔面板 ----------
function refreshBrushUI() {
  const c = brushColor(true);
  const sw = $('#brush-swatch');
  if (c) {
    sw.style.background = c.hex;
    $('#brush-mass').textContent = `笔上色料 ${brush.totalMass().toFixed(1)}`;
    $('#brush-conc').textContent = `浓度 ${(brush.concentration() * 100).toFixed(1)}%（湿态显示）`;
  } else {
    sw.style.background = '';
    $('#brush-mass').textContent = '笔上色料 0';
    $('#brush-conc').textContent = '浓度 0%（净笔/清水）';
  }
  const A = Math.PI * brush.radius ** 2;
  const dabMass = STAMP_CENTER_MASS * brush.flow * 0.4 * A;
  const dabs = brush.totalMass() / Math.max(dabMass, 1e-6);
  $('#brush-dabs').textContent = brush.totalMass() > 1e-6 ? `约可走 ${dabs.toFixed(0)} 个 dab（含交换会变化）` : '';

  const bars = $('#brush-bars');
  bars.innerHTML = '';
  const M = brush.totalMass();
  if (M > 1e-6) {
    for (let i = 0; i < P; i++) {
      if (brush.m[i] <= 1e-6) continue;
      const seg = document.createElement('span');
      seg.style.width = `${(brush.m[i] / M) * 100}%`;
      seg.style.background = pigmentHex(i, 2.2);
      seg.title = `${PIGMENTS[i].name} ${brush.m[i].toFixed(1)}`;
      bars.appendChild(seg);
    }
  }
}

// ---------- 缩放 ----------
function applyZoom() {
  const view = $('#view');
  const wrap = $('#canvas-wrap');
  if (zoomMode === 'fit') {
    const availW = wrap.clientWidth - 56;
    const availH = wrap.clientHeight - 56;
    const s = Math.min(availW / doc.W, availH / doc.H);
    zoomFactor = Math.max(0.2, s);
    view.style.width = `${doc.W * zoomFactor}px`;
    $('#zoom-label').textContent = `${Math.round(zoomFactor * 100)}%`;
  } else {
    view.style.width = `${doc.W * zoomFactor}px`;
    $('#zoom-label').textContent = `${Math.round(zoomFactor * 100)}%`;
  }
}

// ---------- 坐标映射与指针绘制 ----------
function eventToDoc(e) {
  const rect = $('#view').getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * doc.W;
  const y = ((e.clientY - rect.top) / rect.height) * doc.H;
  return { x, y };
}

function updateCursor(e) {
  const cursor = $('#brush-cursor');
  if (tool !== 'brush') {
    cursor.style.display = 'none';
    return;
  }
  const frameRect = $('#canvas-frame').getBoundingClientRect();
  const viewRect = $('#view').getBoundingClientRect();
  const scale = viewRect.width / doc.W;
  const d = brush.radius * 2 * scale;
  cursor.style.display = 'block';
  cursor.style.width = `${d}px`;
  cursor.style.height = `${d}px`;
  cursor.style.left = `${e.clientX - frameRect.left}px`;
  cursor.style.top = `${e.clientY - frameRect.top}px`;
}

function updateStatusHover(e) {
  const { x, y } = eventToDoc(e);
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (!doc.inBounds(ix, iy)) {
    $('#status-pos').textContent = `坐标 (${x.toFixed(0)}, ${y.toFixed(0)}) 画外`;
    return;
  }
  const idx = doc.index(ix, iy);
  const p = idx * 4;
  const hex =
    '#' +
    [imageData.data[p], imageData.data[p + 1], imageData.data[p + 2]]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
  const info = doc.pixelInfo(idx);
  $('#status-pos').textContent = `坐标 ${ix},${iy}`;
  $('#status-pixel').textContent = `${hex} · RGB ${imageData.data[p]},${imageData.data[p + 1]},${imageData.data[p + 2]}`;
  $('#status-layer').textContent = `干层 ${info.layers.length} · 湿膜 ${info.wet ? `M=${info.wet.totalMass.toFixed(2)}` : '无'}`;
  drawLoupe(ix, iy);
}

function pushHistory(cmd) {
  history.push(cmd);
  if (history.length > HISTORY_CAP) history.shift();
}

function bindCanvasPointer() {
  const view = $('#view');

  view.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    try {
      const { x, y } = eventToDoc(e);
      if (tool === 'sampleA' || tool === 'sampleB') {
        const ix = Math.floor(x),
          iy = Math.floor(y);
        if (doc.inBounds(ix, iy)) pickSample(tool.slice(-1), doc.index(ix, iy));
        return;
      }
      view.setPointerCapture(e.pointerId);
      stroke.active = true;
      stroke.x = x;
      stroke.y = y;
      stroke.before = new Map();
      const res = doc.applyDab(x, y, brush, stroke.before);
      paintCells(new Set(res.cells));
      refreshBrushUI();
    } catch (err) {
      health.report('pointer', err.message, err.stack);
      toast(`绘画失败：${err.message}`, 'error', 5000);
    }
  });

  view.addEventListener('pointermove', (e) => {
    updateCursor(e);
    updateStatusHover(e);
    if (!stroke.active || tool !== 'brush') return;
    try {
      const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      const events = coalesced && coalesced.length ? coalesced : [e];
      const cells = new Set();
      for (const ev of events) {
        const { x, y } = eventToDoc(ev);
        const res = doc.strokeSegment(stroke.x, stroke.y, x, y, brush, stroke.before);
        for (const c of res.cells) cells.add(c);
        stroke.x = x;
        stroke.y = y;
      }
      paintCells(cells);
      refreshBrushUI();
    } catch (err) {
      health.report('pointer', err.message, err.stack);
      toast(`笔迹求值失败：${err.message}`, 'error', 5000);
      stroke.active = false;
    }
  });

  function endStroke() {
    if (stroke.active) {
      if (stroke.before && stroke.before.size > 0) {
        pushHistory({ type: 'stroke', before: stroke.before });
      }
      stroke.active = false;
      stroke.before = null;
      refreshBrushUI();
    }
  }
  view.addEventListener('pointerup', endStroke);
  view.addEventListener('pointercancel', endStroke);
  view.addEventListener('pointerleave', () => {
    $('#brush-cursor').style.display = 'none';
  });
}

// ---------- 取样比较 ----------
function pickSample(which, idx) {
  try {
    const R = evaluatePixelSpectrum(doc, idx);
    const color = spectrumToDisplay(R);
    samples[which] = { idx, R, color, info: doc.pixelInfo(idx) };
    renderSample(which);
    renderDelta();
    renderSampleDetail();
    drawSpectrumChart($('#spectrum-chart'), [
      samples.A ? { R: samples.A.R, color: '#5b6472', label: 'A' } : null,
      samples.B ? { R: samples.B.R, color: '#d23b8a', label: 'B' } : null,
    ]);
    toast(`已取样到 ${which}：${color.hex}`, 'ok', 1400);
  } catch (err) {
    health.report('sample', err.message, err.stack);
    toast(`取样失败：${err.message}`, 'error');
  }
}

function renderSample(which) {
  const s = samples[which];
  const sw = $(`#sample-${which.toLowerCase()}-swatch`);
  const hex = $(`#sample-${which.toLowerCase()}-hex`);
  const lab = $(`#sample-${which.toLowerCase()}-lab`);
  if (!s) return;
  sw.classList.remove('empty');
  sw.style.background = s.color.hex;
  hex.textContent = `${s.color.hex} · px ${s.idx}`;
  lab.textContent = `L*${s.color.lab.L.toFixed(1)} a*${s.color.lab.a.toFixed(1)} b*${s.color.lab.b.toFixed(1)}`;
}

function renderDelta() {
  if (samples.A && samples.B) {
    const d76 = deltaE76(samples.A.color.lab, samples.B.color.lab);
    const d00 = deltaE2000(samples.A.color.lab, samples.B.color.lab);
    $('#delta-e76').textContent = d76.toFixed(2);
    $('#delta-e00').textContent = d00.toFixed(2);
    let note = '两样本非常接近';
    if (d00 > 2) note = '人眼通常可察觉差异';
    if (d00 > 10) note = '差异明显，近似不同色块';
    $('#delta-note').textContent = note;
  } else {
    $('#delta-e76').textContent = '—';
    $('#delta-e00').textContent = '—';
    $('#delta-note').textContent = 'A、B 都取样后计算色差';
  }
}

function compositionBar(m) {
  const total = m.reduce((s, x) => s + x, 0);
  if (total <= 1e-7) return '';
  const segs = PIGMENTS.map((p, i) =>
    m[i] > 1e-7
      ? `<span style="width:${(m[i] / total) * 100}%;background:${pigmentHex(i, 2.2)}" title="${p.name} ${m[i].toFixed(3)}"></span>`
      : ''
  ).join('');
  return `<div class="comp-bar">${segs}</div>`;
}

function renderSampleDetail() {
  const which = samples.B ? 'B' : samples.A ? 'A' : null;
  if (!which) return;
  const s = samples[which];
  const info = s.info;
  const parts = [];
  parts.push(`<b>最近样本 ${which}</b> 坐标 ${info.x},${info.y}；色料总质量 ${info.totalPigmentMass.toFixed(3)}`);
  if (info.wet) {
    parts.push(
      `<span class="layer-chip">湿膜（参与交换）</span>${compositionBar(info.wet.m)}
       <div class="muted">M=${info.wet.totalMass.toFixed(3)}，载体 V=${info.wet.v.toFixed(3)}，浓度 ${(info.wet.concentration * 100).toFixed(1)}%</div>`
    );
  }
  for (let li = info.layers.length - 1; li >= 0; li--) {
    const L = info.layers[li];
    parts.push(
      `<span class="layer-chip">干层 ${li + 1} · ${L.name}</span>${compositionBar(L.m)}
       <div class="muted">M=${L.totalMass.toFixed(3)}，厚度 h=${L.h.toFixed(3)}，浓度 ${(L.concentration * 100).toFixed(1)}%</div>`
    );
  }
  if (info.layers.length === 0 && !info.wet) parts.push('<div class="muted">该像素只有画纸底色。</div>');
  $('#sample-detail').innerHTML = parts.join('<br style="margin-bottom:6px">');
}

// ---------- 像素放大镜 ----------
function drawLoupe(ix, iy) {
  const canvas = $('#loupe');
  const ctx = canvas.getContext('2d');
  const GW = 30,
    GH = 22;
  const scale = canvas.width / GW; // 10
  let x0 = Math.max(0, Math.min(ix - GW / 2, doc.W - GW));
  let y0 = Math.max(0, Math.min(iy - GH / 2, doc.H - GH));
  x0 = Math.floor(x0);
  y0 = Math.floor(y0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage($('#view'), x0, y0, GW, GH, 0, 0, GW * scale, GH * scale);
  ctx.strokeStyle = 'rgba(20,30,50,.18)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= GW; x++) {
    ctx.beginPath();
    ctx.moveTo(x * scale + 0.5, 0);
    ctx.lineTo(x * scale + 0.5, GH * scale);
    ctx.stroke();
  }
  for (let y = 0; y <= GH; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * scale + 0.5);
    ctx.lineTo(GW * scale, y * scale + 0.5);
    ctx.stroke();
  }
  const hx = (ix - x0) * scale;
  const hy = (iy - y0) * scale;
  ctx.strokeStyle = '#ff3b30';
  ctx.lineWidth = 2;
  ctx.strokeRect(hx + 1, hy + 1, scale - 2, scale - 2);
  const idx = doc.index(ix, iy);
  $('#loupe-info').textContent = `中心 px ${idx} (${ix},${iy}) · ${samples ? '' : ''}文档缓冲固定 ${doc.W}×${doc.H}，缩放不改变求值`;
}

// ---------- 测试台 ----------
function fillPigmentSelects() {
  for (const id of ['bench-pigment', 'bench-a', 'bench-b']) {
    const sel = $(`#${id}`);
    sel.innerHTML = PIGMENTS.map((p, i) => `<option value="${p.id}">${p.name}</option>`).join('');
  }
  $('#bench-pigment').value = 'pr-red';
  $('#bench-a').value = 'py-lemon';
  $('#bench-b').value = 'pb15-cyan';
  for (const id of ['bench-pigment', 'bench-a', 'bench-b']) {
    $(`#${id}`).addEventListener('change', renderBench);
  }
}

function renderBench() {
  const pid = $('#bench-pigment').value;
  const a = $('#bench-a').value;
  const b = $('#bench-b').value;

  const tg = thicknessGradient(pid, 26);
  paintTwoRowRamp($('#bench-thickness'), tg.overWhite, tg.overBlack);

  const rr = ratioRamp(a, b, 40);
  paintHorizontalStrip($('#bench-ratio'), rr);

  const oc = orderComparison(a, b, 0.4);
  $('#bench-order').innerHTML = [
    ['A 后 B（AB）', oc.AB],
    ['B 后 A（BA）', oc.BA],
    ['均质预混', oc.premix],
  ]
    .map(
      ([label, hex]) =>
        `<div class="order-cell"><div class="sw" style="background:${hex}"></div>${label}<br><span class="mono">${hex}</span></div>`
    )
    .join('') + `<div class="muted" style="grid-column:1/-1">分层顺序 ΔE00=${oc.deltaOrder.toFixed(2)}；预混与 AB 差 ΔE00=${oc.deltaPremixAB.toFixed(2)}</div>`;

  const sg = substrateGrid(pid);
  $('#bench-substrates').innerHTML = sg
    .map(
      (row) => `<div class="sub-row">
        <span>${row.name}</span>
        <div class="sub-strip">${row.colors
          .map((hex) => `<span style="background:${hex}" title="${hex}"></span>`)
          .join('')}</div>
      </div>`
    )
    .join('');
}

function renderChecks() {
  const { results, allPass } = runChecks();
  const sum = $('#checks-summary');
  sum.className = `checks-summary ${allPass ? 'ok' : 'bad'}`;
  sum.textContent = allPass
    ? `全部 ${results.length} 项内核检查通过（能量范围 / 数值稳定 / 守恒 / 顺序政策）`
    : `存在失败检查，请反馈`;
  $('#checks-list').innerHTML = results
    .map(
      (r) => `<li class="${r.pass ? 'pass' : 'fail'}">
        <b>${r.title}</b><span class="detail">${r.pass ? r.detail : '错误：' + r.detail}</span>
      </li>`
    )
    .join('');
}

// ---------- 可封存试混台 ----------
const LAB_DROP = Object.freeze({ volume: 0.85, lift: 0.72 });

function labSetStatus(text, kind = '') {
  const el = $('#lab-status');
  if (!el) return;
  el.className = `checks-summary ${kind}`;
  el.textContent = text;
}

function renderLabChart() {
  const canvas = $('#lab-reflectance');
  if (!canvas) return;
  const series = [];
  labSwatches.forEach((swatch, i) => {
    const diff = modelDifference(Array.from(swatch.remainingMasses()), swatch.h);
    const hue = i === 0 ? '#b7791f' : '#d23b8a';
    series.push({ R: diff.R_spectral, color: hue, label: `${i + 1} 光谱` });
    series.push({ R: diff.R_constrained, color: hue, label: `${i + 1} 受限`, dash: [5, 4] });
  });
  drawSpectrumChart(canvas, series);
}

function renderLab() {
  const root = $('#lab-cards');
  if (!root) return;
  const report = buildExperimentReport();
  const compare = $('#lab-seal-compare');
  if (compare) {
    compare.innerHTML = `<table>
      <thead><tr><th>同一滴 0.72 回取强度清水</th><th>封存前带走</th><th>封存前剩余</th><th>封存前干色</th><th>先封存带走</th><th>封存后剩余</th><th>封存后干色</th></tr></thead>
      <tbody>${report.sealWater
        .map((x) => {
          const beforeRemoved = x.waterBeforeSeal.result.removedMass;
          const afterRemoved = x.waterAfterSeal.result.removedMass;
          const beforeHex = x.waterBeforeSeal.dry.colors.spectral.brightD65.hex;
          const afterHex = x.waterAfterSeal.dry.colors.spectral.brightD65.hex;
          return `<tr>
            <td>${x.name}${x.soluble ? '（可溶）' : '（耐水）'}</td>
            <td class="${beforeRemoved > 1e-9 ? 'yes' : 'no'}">${beforeRemoved.toFixed(3)}</td>
            <td>${x.waterBeforeSeal.wet.remainingMass.toFixed(3)}</td>
            <td><span class="lab-mini-swatch" style="background:${beforeHex}"></span>${beforeHex}</td>
            <td class="${afterRemoved > 1e-9 ? 'yes' : 'no'}">${afterRemoved.toFixed(3)}</td>
            <td>${x.waterAfterSeal.wet.remainingMass.toFixed(3)}</td>
            <td><span class="lab-mini-swatch" style="background:${afterHex}"></span>${afterHex}</td>
          </tr>`;
        })
        .join('')}</tbody>
    </table>`;
  }
  root.innerHTML = labSwatches
    .map((swatch, i) => {
      const snap = swatch.snapshot();
      const c = snap.colors.spectral;
      const constrained = snap.colors.constrained;
      const dryModels = modelDifference(snap.remaining, swatch.h);
      const lastLift = [...snap.events].reverse().find((e) => e.type === 'water-lift');
      const badges = [
        `<span class="lab-badge">${snap.soluble ? '可溶底层' : '耐水底层'}</span>`,
        `<span class="lab-badge ${snap.sealed ? 'sealed' : ''}">${snap.sealed ? '已封存隔离' : '未封存'}</span>`,
        `<span class="lab-badge">${snap.wet ? '湿态' : '干燥'}</span>`,
        lastLift ? `<span class="lab-badge lifted">已回取 ${lastLift.removedMass.toFixed(2)}</span>` : '',
      ].join('');
      return `<article class="lab-card ${lastLift ? 'bad' : snap.sealed ? 'ok' : ''}">
        <div class="lab-card-head">
          <div class="lab-card-title"><b>试混片 ${i + 1} · ${snap.name}</b><span>${snap.recipeId}</span></div>
          <div class="lab-badges">${badges}</div>
        </div>
        <div class="lab-swatches">
          <div class="lab-swatch" style="background:${c.brightD65.hex}"><span>明 D65 ${c.brightD65.hex}</span></div>
          <div class="lab-swatch" style="background:${c.dimWarmA.hex}"><span>暗暖光 ${c.dimWarmA.hex}</span></div>
        </div>
        <div class="lab-mass">
          <span>试片剩余色料</span><b>${snap.remainingMass.toFixed(4)}</b>
          <span>水滴/流出物带走</span><b>${snap.effluentMass.toFixed(4)}</b>
          <span>物质总量（试片＋流出）</span><b>${snap.totalPigmentMass.toFixed(4)}</b>
          <span>受限模型明色 / 暗色</span><b>${constrained.brightD65.hex} / ${constrained.dimWarmA.hex}</b>
          <span class="lab-dry-line">干燥复算（同一剩余质量与 h=${swatch.h}）：光谱 <b>${dryModels.spectral.brightD65.hex}</b> · 受限 <b>${dryModels.constrained.brightD65.hex}</b> · ΔE00=<b>${dryModels.deltaEBright.toFixed(2)}</b></span>
        </div>
      </article>`;
    })
    .join('');

  $('#lab-model-summary').innerHTML = report.metamer.specimens
    .map(
      (s) =>
        `<div><code>${s.id}</code>：光谱↔受限 ΔE00 明=${s.models.deltaEBright.toFixed(2)} / 暖=${s.models.deltaEWarm.toFixed(2)}，RMSE=${s.models.spectralRmse.toFixed(4)}</div>`
    )
    .join('') +
    `<div>D65 同色 ΔE00=<b>${report.metamer.brightD65DeltaE00.toFixed(2)}</b>；暖光分离 ΔE00=<b>${report.metamer.warmADeltaE00.toFixed(2)}</b>。反复混合最大相对质量漂移=${report.repeatedMix.spectral.maxRelativeDrift.toExponential(2)}。</div>`;
  renderLabChart();
}

function labWater() {
  const removed = labSwatches.map((s) => s.applyWater(LAB_DROP));
  const totalRemoved = removed.reduce((sum, r) => sum + r.removedMass, 0);
  const blocked = labSwatches.filter((s) => s.sealed).length;
  renderLab();
  labSetStatus(
    totalRemoved > 0
      ? `同一滴清水施予两片：共从可溶未封层回取 ${totalRemoved.toFixed(3)} 色料；封存片阻挡 ${blocked} 片。质量已转入水滴/流出物。`
      : `清水未带走颜料：${blocked ? '封存隔离层阻挡入水，或底层本身耐水。' : '没有可溶底层。'}`,
    totalRemoved > 0 ? 'bad' : 'ok'
  );
  toast(totalRemoved > 0 ? `清水带走 ${totalRemoved.toFixed(2)} 色料；剩余量已更新` : '清水未带走底色', totalRemoved > 0 ? '' : 'ok');
}

function labSeal() {
  labSwatches.forEach((s) => s.seal('ui-button'));
  renderLab();
  labSetStatus('湿样已封存：透明隔离层不改变反射率，但会阻止下一滴清水到达可溶物质层。', 'ok');
  toast('湿样已封存；再滴水将不能回取封层下底色', 'ok');
}

function labDry() {
  labSwatches.forEach((s) => s.dry());
  renderLab();
  labSetStatus('已按晾干政策复算：载体减少，色料质量不变；色样为干燥后反射响应。', 'ok');
}

function labReset() {
  labSwatches = createLabSwatches();
  renderLab();
  labSetStatus('试混片已重置为两片同 D65 色、异颜料的湿色样。');
}

function exportLabJSON() {
  const payload = {
    app: 'pigment-km-studio',
    exportedAt: new Date().toISOString(),
    schema: 'sealable-lab-export-v1',
    lighting: ['brightD65', 'dimWarmA'],
    pigmentIds: PIGMENTS.map((p) => p.id),
    pigmentNames: PIGMENTS.map((p) => p.name),
    activeSwatches: labSwatches.map((s) => s.snapshot()),
    recomputedExperiment: buildExperimentReport(),
  };
  downloadBlob(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    `sealable-pigment-samples-${nowStamp()}.json`
  );
  toast('已导出明暗色样、光谱与剩余颜料量 JSON', 'ok', 4200);
}

function exportLabPNG() {
  const W = 960;
  const H = 560;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f7f8fa';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#1f2430';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText('可封存湿色样：明 D65 / 暗暖光与剩余颜料量', 28, 42);
  ctx.font = '13px monospace';
  ctx.fillStyle = '#5b6472';
  ctx.fillText(`exported ${new Date().toISOString()} · colors are spectral-KM display transforms`, 28, 66);

  labSwatches.forEach((swatch, i) => {
    const snap = swatch.snapshot();
    const x = 28 + i * 456;
    const y = 92;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#dfe3ea';
    ctx.beginPath();
    ctx.roundRect(x, y, 430, 420, 14);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#1f2430';
    ctx.font = 'bold 17px sans-serif';
    ctx.fillText(`${i + 1}. ${snap.name}`, x + 18, y + 34);
    ctx.font = '12px monospace';
    ctx.fillStyle = '#5b6472';
    ctx.fillText(`${snap.recipeId} · sealed=${snap.sealed} · wet=${snap.wet}`, x + 18, y + 56);

    const colors = [
      ['明 D65', snap.colors.spectral.brightD65.hex],
      ['暗暖光', snap.colors.spectral.dimWarmA.hex],
      ['受限明色', snap.colors.constrained.brightD65.hex],
      ['受限暗色', snap.colors.constrained.dimWarmA.hex],
    ];
    colors.forEach(([label, hex], j) => {
      const sx = x + 18 + (j % 2) * 202;
      const sy = y + 82 + Math.floor(j / 2) * 82;
      ctx.fillStyle = hex;
      ctx.fillRect(sx, sy, 184, 54);
      ctx.strokeStyle = 'rgba(0,0,0,.15)';
      ctx.strokeRect(sx + 0.5, sy + 0.5, 183, 53);
      ctx.fillStyle = '#1f2430';
      ctx.font = '12px monospace';
      ctx.fillText(`${label} ${hex}`, sx, sy + 70);
    });

    ctx.fillStyle = '#1f2430';
    ctx.font = '14px monospace';
    const lines = [
      `remaining pigment = ${snap.remainingMass.toFixed(4)}`,
      `effluent pigment  = ${snap.effluentMass.toFixed(4)}`,
      `total mass        = ${snap.totalPigmentMass.toFixed(4)}`,
      `soluble=${snap.soluble} sealed=${snap.sealed}`,
    ];
    lines.forEach((line, j) => ctx.fillText(line, x + 18, y + 286 + j * 26));
  });

  canvas.toBlob((blob) => {
    if (!blob) {
      toast('PNG 导出失败', 'error');
      return;
    }
    downloadBlob(blob, `sealable-pigment-samples-${nowStamp()}.png`);
    toast('已导出色样 PNG（剩余颜料量同时写在图面）', 'ok');
  }, 'image/png');
}

// ---------- 绘画窗口接点自检 ----------
function setRuntimeState(text, kind = 'idle') {
  const dot = $('#health-dot');
  const el = $('#runtime-state');
  if (el) {
    el.className = `runtime-state ${kind}`;
    el.textContent = text;
  }
  if (dot && kind === 'bad') dot.classList.add('bad');
}

function setIntegrationPanel(state) {
  const panel = $('#integration-panel');
  panel.className = `integration-panel ${state.kind}`;
  $('#integration-title').textContent = state.title;
  $('#integration-summary').textContent = state.summary;
  const root = $('#integration-anomalies');
  root.innerHTML = (state.anomalies || [])
    .map((a) => `<div class="anomaly-item">px ${a.idx} (${a.x},${a.y}) ${a.kind}: ${a.detail}</div>`)
    .join('');
  const layer = $('#anomaly-layer');
  layer.innerHTML = '';
  for (const a of state.anomalies || []) {
    const marker = document.createElement('div');
    marker.className = 'anomaly-marker';
    marker.style.left = `${(a.x / doc.W) * 100}%`;
    marker.style.top = `${(a.y / doc.H) * 100}%`;
    marker.style.width = `${Math.max(1.8, (a.r || 5) / doc.W * 100 * 2)}%`;
    marker.style.height = `${Math.max(2.4, (a.r || 5) / doc.H * 100 * 2)}%`;
    layer.appendChild(marker);
  }
  for (const p of state.probes || []) {
    const marker = document.createElement('div');
    marker.className = 'probe-marker';
    marker.style.left = `${(p.x / doc.W) * 100}%`;
    marker.style.top = `${(p.y / doc.H) * 100}%`;
    marker.title = p.label;
    layer.appendChild(marker);
  }
}

function runIntegrationCheck() {
  setRuntimeState('接点自检运行中…', 'running');
  setIntegrationPanel({ kind: 'running', title: '正在混合颜料并叠画色块', summary: '创建可撤销的自检场景…' });
  try {
    const backup = doc.clear();
    pushHistory({ type: 'clear', backup });

    const mixBrush = new Brush();
    mixBrush.radius = 13;
    mixBrush.exchange = 0.15;
    const yellowIdx = PIGMENTS.findIndex((p) => p.id === 'py-lemon');
    const cyanIdx = PIGMENTS.findIndex((p) => p.id === 'pb15-cyan');
    const mixParts = new Array(P).fill(0);
    mixParts[yellowIdx] = 1;
    mixParts[cyanIdx] = 1;
    mixBrush.loadMix(mixParts, { dabs: 90, vehicleRatio: 1.5 });

    for (let x = 24; x <= 150; x += 5) {
      for (const y of [78, 92, 106, 120]) doc.applyDab(x, y, mixBrush, new Map());
    }
    attachBuffer();
    paintAll();

    const mixProbe = { x: 86, y: 99, idx: 99 * DOC_W + 86, label: '黄青均质混合' };
    const mixedBeforeGlaze = evaluatePixelColor(doc, mixProbe.idx);
    doc.dryWet('接点自检混合层');
    paintAll();
    const mixedDry = evaluatePixelColor(doc, mixProbe.idx);

    const glazeBrush = new Brush();
    glazeBrush.radius = 16;
    glazeBrush.flow = 0.42;
    const magentaParts = new Array(P).fill(0);
    magentaParts[PIGMENTS.findIndex((p) => p.id === 'pv19-magenta')] = 1;
    glazeBrush.loadMix(magentaParts, { dabs: 80, vehicleRatio: 3.2 });
    for (let x = 70; x <= 210; x += 5) {
      for (const y of [92, 106, 120]) doc.applyDab(x, y, glazeBrush, new Map());
    }
    paintAll();

    const probes = [
      mixProbe,
      { x: 176, y: 106, idx: 106 * DOC_W + 176, label: '品红叠涂区' },
      { x: 42, y: 99, idx: 99 * DOC_W + 42, label: '混合色块左区' },
    ];
    const view = $('#view');
    const actual = view.getContext('2d').getImageData(0, 0, doc.W, doc.H).data;
    const anomalies = [];
    let maxChannelDiff = 0;
    for (const p of probes) {
      const expected = evaluatePixelColor(doc, p.idx);
      const q = p.idx * 4;
      const actualRgb = { r: actual[q], g: actual[q + 1], b: actual[q + 2] };
      const d = Math.max(
        Math.abs(actualRgb.r - expected.r),
        Math.abs(actualRgb.g - expected.g),
        Math.abs(actualRgb.b - expected.b)
      );
      maxChannelDiff = Math.max(maxChannelDiff, d);
      if (d > 1) {
        anomalies.push({
          idx: p.idx,
          x: p.x,
          y: p.y,
          r: 8,
          kind: '画布像素不一致',
          detail: `actual rgb(${actualRgb.r},${actualRgb.g},${actualRgb.b}) expected ${expected.hex} maxΔ=${d}`,
        });
      }
    }

    const overlappedAfter = evaluatePixelColor(doc, mixProbe.idx);
    const colorChangeDE = deltaE2000(mixedDry.lab, overlappedAfter.lab);
    if (!(colorChangeDE > 2)) {
      anomalies.push({
        idx: mixProbe.idx,
        x: mixProbe.x,
        y: mixProbe.y,
        r: 10,
        kind: '颜色变化异常',
        detail: `叠罩后 ΔE00=${colorChangeDE.toFixed(2)}，预期 >2`,
      });
    }

    const dryChangeDE = deltaE2000(mixedBeforeGlaze.lab, mixedDry.lab);
    const mass = doc.totalPigmentMass() + mixBrush.totalMass() + glazeBrush.totalMass();
    lastIntegration = {
      at: new Date().toISOString(),
      maxChannelDiff,
      colorChangeDE,
      dryChangeDE,
      mass,
      anomalies,
      actualPixel: probes.map((p) => {
        const q = p.idx * 4;
        return { ...p, rgb: [actual[q], actual[q + 1], actual[q + 2]] };
      }),
    };
    window.__pigmentLastIntegration = lastIntegration;

    const pass = anomalies.length === 0;
    setIntegrationPanel({
      kind: pass ? 'ok' : 'bad',
      title: pass ? '绘画接点通过：混色、叠画与画布像素一致' : `发现 ${anomalies.length} 项接点异常`,
      summary: `像素最大通道差 ${maxChannelDiff} · 叠画颜色 ΔE00=${colorChangeDE.toFixed(2)} · 湿干变化 ΔE00=${dryChangeDE.toFixed(2)} · 可见绿点为核对位置`,
      anomalies,
      probes,
    });
    setRuntimeState(pass ? `运行正常 · 接点已核对 ΔE ${colorChangeDE.toFixed(1)}` : '颜色/像素接点异常', pass ? 'ok' : 'bad');
    toast(pass ? '绘画窗口接点自检通过；可 Ctrl/⌘+Z 恢复自检前画布' : '接点自检发现异常，请看红框与列表明细', pass ? 'ok' : 'error', 5200);
  } catch (err) {
    health.report('integration', err.message, err.stack);
    setIntegrationPanel({ kind: 'bad', title: '绘画接点自检执行失败', summary: err.message, anomalies: [{ idx: 0, x: 10, y: 10, kind: 'exception', detail: err.message }] });
    setRuntimeState('运行异常 · 接点自检失败', 'bad');
    toast(`接点自检失败：${err.message}`, 'error', 6000);
  }
}

// ---------- 保存 / 读取 / 导出 ----------
async function saveState() {
  try {
    const state = doc.toState();
    state.ui = {
      brush: brush.toJSON(),
      mixer: Array.from(mixerParts),
      tool,
      savedAt: new Date().toISOString(),
    };
    const gz = await gzipString(JSON.stringify(state));
    downloadBlob(new Blob([gz], { type: 'application/octet-stream' }), `pigment-state-${nowStamp()}.pigm`);
    toast('已保存色料状态（gzip JSON，含每层质量数组，非截图）', 'ok', 4200);
  } catch (err) {
    health.report('save', err.message, err.stack);
    toast(`保存失败：${err.message}`, 'error', 6000);
  }
}

async function loadStateFile(file) {
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const text = await gunzipToText(buf);
    const state = JSON.parse(text);
    const restored = PaintDocument.fromState(state);
    doc = restored;
    if (state.ui?.brush) {
      const b = Brush.fromJSON(state.ui.brush);
      brush.m.set(b.m);
      brush.v = b.v;
      brush.radius = b.radius;
      brush.flow = b.flow;
      brush.exchange = b.exchange;
    }
    if (Array.isArray(state.ui?.mixer)) {
      state.ui.mixer.forEach((x, i) => {
        if (i < P) mixerParts[i] = Number(x) || 0;
      });
      syncPigmentInputs();
      refreshMixer();
    }
    history.length = 0;
    samples.A = samples.B = null;
    ['a', 'b'].forEach((k) => {
      const sw = $(`#sample-${k}-swatch`);
      sw.classList.add('empty');
      sw.style.background = '';
      $(`#sample-${k}-hex`).textContent = '未取样';
      $(`#sample-${k}-lab`).textContent = '';
    });
    renderDelta();
    $('#sample-detail').textContent = '已载入状态；点击“画布取 A/B”检查保存的色料层。';
    attachBuffer();
    paintAll();
    applyZoom();
    refreshBrushUI();
    toast('色料状态已读取并重新求值', 'ok');
  } catch (err) {
    health.report('load', err.message, err.stack);
    toast(`读取状态失败：${err.message}`, 'error', 6000);
  }
}

function exportPNG() {
  try {
    const scale = Number($('#export-scale').value);
    const out = document.createElement('canvas');
    out.width = doc.W * scale;
    out.height = doc.H * scale;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage($('#view'), 0, 0, out.width, out.height);
    out.toBlob((blob) => {
      downloadBlob(blob, `pigment-painting-${scale}x-${nowStamp()}.png`);
      toast(`已导出 ${out.width}×${out.height} PNG（最近邻放大，RGB 与文档缓冲一致）`, 'ok');
    }, 'image/png');
  } catch (err) {
    health.report('export', err.message, err.stack);
    toast(`导出失败：${err.message}`, 'error');
  }
}

// ---------- 撤销 / 晾干 / 清空 ----------
function undo() {
  const cmd = history.pop();
  if (!cmd) {
    toast('没有可撤销的步骤');
    return;
  }
  if (cmd.type === 'stroke') {
    for (const snap of cmd.before.values()) doc.restoreWetPixel(snap);
  } else if (cmd.type === 'dry') {
    doc.undoDry(cmd.cmd);
  } else if (cmd.type === 'clear') {
    doc.restoreClear(cmd.backup);
  }
  paintAll();
  refreshBrushUI();
  toast('已撤销');
}

function dryWet() {
  const cmd = doc.dryWet(`色层 ${doc.dryLayers.length + 1}`);
  if (!cmd) {
    toast('画布上还没有湿色可晾干');
    return;
  }
  pushHistory({ type: 'dry', cmd });
  paintAll();
  refreshBrushUI();
  toast('湿膜已转为干层；再画将作为上层光学罩染（不交换干色）', 'ok', 4200);
}

function clearCanvas() {
  if (!confirm('确定清空全部湿膜与干层？可撤销。')) return;
  const backup = doc.clear();
  pushHistory({ type: 'clear', backup });
  paintAll();
  refreshBrushUI();
}

// ---------- 工具/标签绑定 ----------
function setTool(next) {
  tool = next;
  document.querySelectorAll('#tool-group .tool-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === tool);
  });
  const view = $('#view');
  view.classList.toggle('tool-brush', tool === 'brush');
  if (tool !== 'brush') $('#brush-cursor').style.display = 'none';
  const msg = { sampleA: '取样模式：点击画布取 A', sampleB: '取样模式：点击画布取 B', brush: '画笔模式' };
  $('#status-hint').textContent = msg[tool] || '';
}

function bindUI() {
  document.querySelectorAll('#tool-group .tool-btn').forEach((b) =>
    b.addEventListener('click', () => setTool(b.dataset.tool))
  );
  document.querySelectorAll('[data-arm]').forEach((b) =>
    b.addEventListener('click', () => setTool(`sample${b.dataset.arm}`))
  );

  $('#sl-radius').addEventListener('input', (e) => {
    brush.radius = Number(e.target.value);
    $('#val-radius').textContent = brush.radius;
    refreshBrushUI();
  });
  $('#sl-flow').addEventListener('input', (e) => {
    brush.flow = Number(e.target.value);
    $('#val-flow').textContent = brush.flow.toFixed(2);
    refreshBrushUI();
  });
  $('#sl-exchange').addEventListener('input', (e) => {
    brush.exchange = Number(e.target.value);
    $('#val-exchange').textContent = brush.exchange.toFixed(2);
  });
  $('#sl-water').addEventListener('input', (e) => {
    $('#val-water').textContent = Number(e.target.value).toFixed(1);
  });

  $('#btn-dip').addEventListener('click', () => {
    let sum = 0;
    for (const x of mixerParts) sum += x;
    if (sum <= 0) {
      toast('请先在色料库设定至少一种色料的份数', 'error');
      return;
    }
    brush.loadMix(Array.from(mixerParts), {
      vehicleRatio: Number($('#sl-water').value),
    });
    refreshBrushUI();
    toast('画笔已按配方蘸色');
  });
  $('#btn-mixer-clear').addEventListener('click', () => {
    mixerParts.fill(0);
    syncPigmentInputs();
    refreshMixer();
  });
  $('#btn-brush-clean').addEventListener('click', () => {
    brush.clean();
    refreshBrushUI();
    toast('画笔已清洗（笔上色料与载体清零）');
  });
  $('#btn-brush-water').addEventListener('click', () => {
    brush.v += brush.totalMass() * 0 + 60 * brush.radius; // 直接补清水
    refreshBrushUI();
    toast('笔蘸清水：会稀释湿膜并增强载体交换');
  });

  $('#btn-undo').addEventListener('click', undo);
  $('#btn-dry').addEventListener('click', dryWet);
  $('#btn-clear').addEventListener('click', clearCanvas);
  $('#btn-save').addEventListener('click', saveState);
  $('#btn-load').addEventListener('click', () => $('#file-load').click());
  $('#file-load').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) loadStateFile(f);
    e.target.value = '';
  });
  $('#btn-export').addEventListener('click', exportPNG);

  $('#zoom-in').addEventListener('click', () => {
    zoomMode = 'fixed';
    const i = ZOOM_LEVELS.findIndex((z) => z >= zoomFactor + 0.01);
    zoomFactor = ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, i < 0 ? ZOOM_LEVELS.length - 1 : i)];
    applyZoom();
  });
  $('#zoom-out').addEventListener('click', () => {
    zoomMode = 'fixed';
    const i = ZOOM_LEVELS.findIndex((z) => z >= zoomFactor - 0.01);
    zoomFactor = ZOOM_LEVELS[Math.max(0, (i < 0 ? ZOOM_LEVELS.length : i) - 1)];
    applyZoom();
  });
  $('#zoom-fit').addEventListener('click', () => {
    zoomMode = 'fit';
    applyZoom();
  });

  document.querySelectorAll('.tabs .tab').forEach((t) =>
    t.addEventListener('click', () => {
      document.querySelectorAll('.tabs .tab').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.pane').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      document.querySelector(`.pane[data-pane="${t.dataset.tab}"]`).classList.add('active');
      if (t.dataset.tab === 'bench') {
        /* canvas 已绘制，无需重算 */
      }
    })
  );
  $('#btn-run-checks').addEventListener('click', renderChecks);
  $('#btn-integration-check').addEventListener('click', runIntegrationCheck);
  $('#btn-lab-water').addEventListener('click', labWater);
  $('#btn-lab-seal').addEventListener('click', labSeal);
  $('#btn-lab-dry').addEventListener('click', labDry);
  $('#btn-lab-reset').addEventListener('click', labReset);
  $('#btn-lab-export-json').addEventListener('click', exportLabJSON);
  $('#btn-lab-export-png').addEventListener('click', exportLabPNG);

  $('#btn-help').addEventListener('click', () => ($('#help-modal').hidden = false));
  $('#btn-help-close').addEventListener('click', () => ($('#help-modal').hidden = true));
  $('#help-modal').addEventListener('click', (e) => {
    if (e.target.id === 'help-modal') $('#help-modal').hidden = true;
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
    } else if (e.key === 'Escape') {
      $('#help-modal').hidden = true;
    }
  });

  new ResizeObserver(() => {
    if (zoomMode === 'fit') applyZoom();
  }).observe($('#canvas-wrap'));
}

function fillHelp() {
  $('#help-body').innerHTML = `
    <p>这是一个<strong>显式色料表示 + 简化光学模型</strong>的混色绘画原型。屏幕 RGB 只在最后一步由
    31 波段光谱经 CIE 匹配函数求出，<strong>没有对颜色做算术平均</strong>。</p>
    <h3>如何启动界面</h3>
    <ul>
      <li>仓库根目录运行 <code>npm start</code>（等价于 <code>node tools/serve.mjs</code>），浏览器打开
        <code>http://localhost:8123</code>；或 <code>python3 -m http.server 8123</code> 后访问同地址。</li>
      <li>不要直接双击 index.html：ES Module 在 <code>file://</code> 下会被浏览器安全策略拦截。</li>
      <li>命令行测试：<code>npm test</code>（Node 内置测试运行器，无需安装依赖）。</li>
    </ul>
    <h3>怎么画</h3>
    <ul>
      <li>左栏给色料设定份数 → “按配方蘸入画笔”，或点单行的“蘸”。</li>
      <li>中央画布按住拖动即可得到按固定间距插值的连续笔迹；笔上色料会真实消耗。</li>
      <li>未干区域上的新笔会发生<strong>颜料交换</strong>（回取湿色、改变笔的组成）；点顶栏
        <strong>“晾干成层”</strong>后，新笔触不再交换干色，而是作为上层用 KM 光学叠加，薄层会透出底色。</li>
      <li>右栏可取样 A/B 比较色差与色料组成、查看三种规定测试和像素放大。</li>
      <li>顶栏画布工具组里的 <strong>“绘画接点自检”</strong> 会真实混色、晾干、叠画色块，再逐像素对照绘画窗口；异常会在画布上用红框标出，绿色小点是核对位置。</li>
      <li>右栏 <strong>“封存试混”</strong> 是可封存湿色样图形入口：可滴同一滴清水、先封存再滴水、干燥复算，并导出明亮 D65/昏暗暖光色样与剩余颜料量 JSON/PNG。</li>
      <li>命令行 <code>npm run experiments</code> 只用于复算实验数据和文档证据；日常绘画仍以 <code>npm start</code> 的图形窗口为主入口。</li>
      <li>“保存色料状态”导出的是每层色料质量数组（gzip JSON，<code>.pigm</code>），不是截图；
        “导出图像”才输出 PNG。</li>
    </ul>
    <h3>模型边界（初版自定义参数集 ${PIGMENT_SET_ID}）</h3>
    <ul>
      <li>${PIGMENT_SET_NOTE}。</li>
      <li>采用漫射二通量 Kubelka–Munk、高斯近似 CIE 曲线、等能 E 光源 + Bradford 到 D65。</li>
      <li>不包含：真实品牌数据库、光泽/表面反射、荧光、干涉/金属颜料、颗粒沉淀与流动动力学。</li>
      <li>因此可用于理解混色/罩染/底色透出的机制与数值稳定性，<strong>不冒称准确复现任意真实颜料</strong>。</li>
    </ul>`;
}

// ---------- 启动 ----------
function init() {
  // 画笔光标圈
  const cursor = document.createElement('div');
  cursor.id = 'brush-cursor';
  cursor.className = 'brush-cursor';
  $('#canvas-frame').appendChild(cursor);

  attachBuffer();
  buildPigmentList();
  refreshMixer();
  refreshBrushUI();
  fillPigmentSelects();
  renderBench();
  renderLab();
  renderChecks();
  fillHelp();
  bindUI();
  bindCanvasPointer();
  applyZoom();

  window.__pigmentStudio = {
    runIntegrationCheck,
    getLabSwatches: () => labSwatches,
    buildExperimentReport,
    getDoc: () => doc,
  };

  health.subscribe((issue) => {
    $('#health-dot').classList.add('bad');
    console.warn('[kernel health]', issue);
  });

  window.addEventListener('error', (e) => {
    health.report('window', e.message);
    toast(`界面错误：${e.message}`, 'error', 6000);
  });

  // 首次进入展示说明
  $('#help-modal').hidden = false;
}

init();
