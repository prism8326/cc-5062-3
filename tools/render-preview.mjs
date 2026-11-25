// 生成色卡、比例混合条和模拟笔迹预览，用于人工校准 K/S 参数与模型行为。
import { PIGMENTS, SUBSTRATES } from '../js/pigments.js';
import { mixtureColor } from '../js/render.js';
import { spectrumToDisplay } from '../js/spectra.js';
import { PaintDocument, Brush } from '../js/document.js';
import { renderAll } from '../js/render.js';
import { writePNG } from './png.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'out');

function fillRect(rgba, W, x0, y0, w, h, c) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || y < 0 || x >= W) continue;
      const p = (y * W + x) * 4;
      rgba[p] = c.r;
      rgba[p + 1] = c.g;
      rgba[p + 2] = c.b;
      rgba[p + 3] = 255;
    }
  }
}

// ---------- 1. 单色厚度梯度（上排白底，下排黑底） ----------
{
  const steps = 28;
  const cellW = 22;
  const rowH = 46;
  const labelW = 0;
  const W = steps * cellW;
  const H = PIGMENTS.length * rowH * 2 + 20;
  const rgba = new Uint8ClampedArray(W * H * 4);
  const white = SUBSTRATES[0].spectrum;
  const black = SUBSTRATES.find((s) => s.id === 'black').spectrum;
  rgba.fill(255);

  PIGMENTS.forEach((p, i) => {
    const masses = new Array(PIGMENTS.length).fill(0);
    masses[i] = 1;
    for (let s = 0; s < steps; s++) {
      const h = 0.05 * Math.pow(1.28, s); // 对数厚度梯度
      const c = 0.45;
      const m = masses.map((x) => x * c * h);
      const cw = mixtureColor(m, h, white);
      const cb = mixtureColor(m, h, black);
      fillRect(rgba, W, s * cellW, i * rowH * 2, cellW - 1, rowH - 1, cw);
      fillRect(rgba, W, s * cellW, i * rowH * 2 + rowH, cellW - 1, rowH - 1, cb);
    }
    const rep = mixtureColor(masses.map((x) => x * 0.9), 2, white);
    console.log(p.id.padEnd(18), p.name, rep.hex, 'Lab', rep.lab.L.toFixed(1), rep.lab.a.toFixed(1), rep.lab.b.toFixed(1));
  });
  writePNG(path.join(OUT, 'thickness-ramps.png'), W, H, rgba);
  console.log('wrote thickness-ramps.png', W, H);
}

// ---------- 2. 双颜料比例梯度（均质预混） ----------
{
  const pairs = [
    ['py-lemon', 'pb15-cyan'],
    ['pv19-magenta', 'py-lemon'],
    ['pv19-magenta', 'pb15-cyan'],
    ['pb29-ultramarine', 'pbr7-umber'],
    ['pw6-white', 'pr-red'],
    ['py-lemon', 'pr-red'],
  ];
  const steps = 41;
  const cellW = 16;
  const rowH = 40;
  const W = steps * cellW;
  const H = pairs.length * rowH;
  const rgba = new Uint8ClampedArray(W * H * 4);
  rgba.fill(240);
  const white = SUBSTRATES[0].spectrum;

  pairs.forEach(([a, b], row) => {
    const ia = PIGMENTS.findIndex((p) => p.id === a);
    const ib = PIGMENTS.findIndex((p) => p.id === b);
    for (let s = 0; s < steps; s++) {
      const t = s / (steps - 1);
      const masses = new Array(PIGMENTS.length).fill(0);
      masses[ia] = (1 - t) * 1.6;
      masses[ib] = t * 1.6;
      const h = 2.2;
      const c = 0.5;
      const m = masses.map((x) => x * c); // M = c*h? 简化：直接给质量
      const col = mixtureColor(m, h, white);
      fillRect(rgba, W, s * cellW, row * rowH, cellW - 1, rowH - 4, col);
    }
    const mid = new Array(PIGMENTS.length).fill(0);
    mid[ia] = 0.8;
    mid[ib] = 0.8;
    console.log('mix', a, '+', b, '->', mixtureColor(mid, 2.2, white).hex);
  });
  writePNG(path.join(OUT, 'ratio-ramps.png'), W, H, rgba);
  console.log('wrote ratio-ramps.png');
}

// ---------- 3. 模拟连续笔迹 + 湿交换 + 晾干罩染 ----------
{
  const doc = new PaintDocument(480, 300);
  const brush = new Brush();
  brush.radius = 12;
  brush.flow = 1;
  brush.exchange = 0.7;

  function stroke(points, pigmentParts, opts = {}) {
    brush.loadMix(pigmentParts, { dabs: 200, vehicleRatio: 1.8, ...opts });
    doc.applyDab(points[0][0], points[0][1], brush, new Map());
    for (let i = 1; i < points.length; i++) {
      doc.strokeSegment(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1], brush, new Map());
    }
  }
  const parts = (id, units = 1) => {
    const a = new Array(PIGMENTS.length).fill(0);
    a[PIGMENTS.findIndex((p) => p.id === id)] = units;
    return a;
  };

  // 蓝色波浪
  const wave1 = [];
  for (let x = 40; x <= 250; x += 6) wave1.push([x, 95 + Math.sin(x / 22) * 34]);
  stroke(wave1, parts('pb29-ultramarine'));

  // 黄色交叉（与蓝湿接 -> 应出现交换/混绿）
  const line2 = [];
  for (let x = 50; x <= 260; x += 6) line2.push([x, 175 - (x - 50) * 0.32]);
  stroke(line2, parts('py-lemon'));

  // 红色粗笔
  brush.radius = 18;
  const line3 = [];
  for (let x = 290; x <= 460; x += 6) line3.push([x, 80 + Math.sin(x / 30) * 20]);
  stroke(line3, parts('pr-red'));

  // 绿色点按
  brush.radius = 22;
  brush.loadMix(parts('pg7-green'), { dabs: 50 });
  doc.applyDab(360, 205, brush, new Map());
  doc.applyDab(415, 225, brush, new Map());

  let buf = new Uint8ClampedArray(doc.W * doc.H * 4);
  renderAll(doc, { data: buf });
  writePNG(path.join(OUT, 'stroke-wet.png'), doc.W, doc.H, buf);

  // 晾干后罩一层薄黄（透出底色）
  doc.dryWet('第一层');
  brush.radius = 42;
  brush.flow = 0.16;
  brush.exchange = 0;
  brush.loadMix(parts('py-lemon'), { dabs: 60, vehicleRatio: 4 });
  const glaze = [];
  for (let x = -20; x <= 500; x += 8) glaze.push([x, 150 + Math.sin(x / 60) * 26]);
  doc.applyDab(glaze[0][0], glaze[0][1], brush, new Map());
  for (let i = 1; i < glaze.length; i++) {
    doc.strokeSegment(glaze[i - 1][0], glaze[i - 1][1], glaze[i][0], glaze[i][1], brush, new Map());
  }
  buf = new Uint8ClampedArray(doc.W * doc.H * 4);
  renderAll(doc, { data: buf });
  writePNG(path.join(OUT, 'stroke-glazed.png'), doc.W, doc.H, buf);
  console.log('wrote stroke previews; total pigment mass', doc.totalPigmentMass().toFixed(2));
}
