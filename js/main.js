// 颜料 KM 绘画原型 —— 界面控制器。
// 所有颜色/状态变更都调用 js/ 下的内核模块；UI 只负责采集输入与呈现求值结果。

import {
  PIGMENTS,
  PIGMENT_SET_ID,
  PIGMENT_SET_NOTE,
  SUBSTRATES,
} from './pigments.js';
import { PAPER, mixtureColor, evaluatePixelSpectrum } from './render.js';
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
  const ctx = view.getContext('2d');
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
  renderChecks();
  fillHelp();
  bindUI();
  bindCanvasPointer();
  applyZoom();

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
