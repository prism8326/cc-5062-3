// 渲染器：把色料状态真实求值为固定文档分辨率的 RGBA 缓冲。
// 视图缩放只允许对这个缓冲做最近邻 blit，绝不重新平均颜色。

import { PIGMENTS, paperSpectrum } from './pigments.js';
import { evaluateStack } from './km.js';
import { spectrumToDisplay } from './spectra.js';
import { health } from './health.js';

const P = PIGMENTS.length;
const PAPER = paperSpectrum();

export function pixelFilmList(doc, idx) {
  const o = idx * P;
  const films = [];
  for (const L of doc.dryLayers) {
    let M = 0;
    for (let i = 0; i < P; i++) M += L.m[o + i];
    if (M <= 1e-7 && L.b[idx] <= 1e-7) continue;
    films.push({ m: L.m.subarray(o, o + P), h: M + L.b[idx], wet: false });
  }
  let wetM = 0;
  for (let i = 0; i < P; i++) wetM += doc.wetM[o + i];
  if (wetM > 1e-7 || doc.wetV[idx] > 1e-7) {
    films.push({
      m: doc.wetM.subarray(o, o + P),
      h: wetM + doc.wetV[idx],
      wet: true,
    });
  }
  return films;
}

export function evaluatePixelSpectrum(doc, idx, substrate = PAPER) {
  return evaluateStack(substrate, pixelFilmList(doc, idx));
}

export function evaluatePixelColor(doc, idx, substrate = PAPER) {
  const R = evaluatePixelSpectrum(doc, idx, substrate);
  return spectrumToDisplay(R);
}

function writePixel(doc, idx, data, substrate) {
  let R;
  try {
    R = evaluatePixelSpectrum(doc, idx, substrate);
  } catch (e) {
    health.report('render', `像素 ${idx} 求值异常: ${e.message}`);
    const p = idx * 4;
    data[p] = 255;
    data[p + 1] = 0;
    data[p + 2] = 255; // 品红报错色，失败显式可见
    data[p + 3] = 255;
    return;
  }
  if (R.some((x) => !Number.isFinite(x))) {
    health.report('render', `像素 ${idx} 光谱非有限值`);
    const p = idx * 4;
    data[p] = 255;
    data[p + 1] = 0;
    data[p + 2] = 255;
    data[p + 3] = 255;
    return;
  }
  const c = spectrumToDisplay(R);
  const p = idx * 4;
  data[p] = c.r;
  data[p + 1] = c.g;
  data[p + 2] = c.b;
  data[p + 3] = 255;
}

// target: { data: Uint8ClampedArray|Uint8Array }，长度 >= W*H*4
export function renderAll(doc, target, substrate = PAPER) {
  for (let idx = 0; idx < doc.N; idx++) writePixel(doc, idx, target.data, substrate);
  return target;
}

export function renderCells(doc, cells, target, substrate = PAPER) {
  for (const idx of cells) {
    if (Number.isInteger(idx) && idx >= 0 && idx < doc.N) {
      writePixel(doc, idx, target.data, substrate);
    }
  }
  return target;
}

// —— 无 DOM 的便捷颜色求值（调色皿、色卡、测试台都走这里） ——
export function mixtureSpectrum(masses, h, substrate = PAPER, wet = false) {
  return evaluateStack(substrate, [{ m: masses, h, wet }]);
}

export function mixtureColor(masses, h, substrate = PAPER, wet = false) {
  return spectrumToDisplay(mixtureSpectrum(masses, h, substrate, wet));
}

export { PAPER };
