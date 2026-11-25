// 简化二通量 Kubelka-Munk 光学模型。
//
// 状态严格区分：
//   m_i  : 单位面积上第 i 种色料的质量（显式色料表示）
//   h    : 膜层覆盖厚度（色料体积 + 载体体积）
//   c    : 色料体积浓度 c = M / h
// K/S 按浓度与配方占比合成，再乘以厚度得到 KX、SX。
// 最终只通过光谱 -> XYZ -> sRGB 得到显示颜色，绝不直接平均屏幕 RGB。

import { PIGMENTS } from './pigments.js';
import { WAVELENGTHS } from './spectra.js';
import { health } from './health.js';

export const EPS_MASS = 1e-7;

// 湿膜中水替代空气，降低折射率反差 -> 散射下降，颜色更深更透明。
// 这是本原型明确声明的经验简化，不是实测湿干差。
export const WET_SCATTER_MUL = 0.62;
// 晾干后载体中黏合剂留存比例（其余视为水蒸发）
export const BINDER_SOLID_FRACTION = 0.12;

function tanhc(u) {
  const a = Math.abs(u);
  if (a < 1e-4) return 1 - (u * u) / 3 + (2 * u ** 4) / 15;
  return Math.tanh(u) / u;
}

// 单层 KM 反射率（覆盖在反射率为 rg 的底材/下层之上）。
// kx = K*X, sx = S*X。
// 用 tanh 稳定形式，避免厚层时 cosh/sinh 溢出：
//   R = [rg + q(1 - a rg)] / [1 + q(a - rg)], q = tanh(b*sx)/b
// 该形式在 b -> 0（K -> 0）时仍有正确极限 q -> sx。
export function kmReflectance(kx, sx, rg) {
  if (![kx, sx, rg].every(Number.isFinite)) {
    health.report('km', 'KM 输入非有限值', { kx, sx, rg });
    return 0;
  }
  kx = Math.max(0, kx);
  sx = Math.max(0, sx);
  rg = Math.min(1, Math.max(0, rg));

  if (sx < 1e-10) {
    // 无散射极限：往返 Beer-Lambert 衰减 R = rg * exp(-2 KX)
    return rg * Math.exp(-2 * Math.min(kx, 80));
  }
  const r = kx / sx;
  const a = 1 + r;
  const b = Math.sqrt(Math.max(0, r * (2 + r)));
  const u = b * sx;
  const q = sx * tanhc(u); // = tanh(u)/b，b=0 时极限为 sx
  return (rg + q * (1 - a * rg)) / (1 + q * (a - rg));
}

// 自由膜 KM 漫透射率 T = 1 / (1 + a q)
export function kmTransmittance(kx, sx) {
  if (![kx, sx].every(Number.isFinite)) return 0;
  kx = Math.max(0, kx);
  sx = Math.max(0, sx);
  if (sx < 1e-10) return Math.exp(-Math.min(kx, 80));
  const r = kx / sx;
  const a = 1 + r;
  const b = Math.sqrt(Math.max(0, r * (2 + r)));
  const u = b * sx;
  const q = sx * tanhc(u);
  return 1 / (1 + a * q);
}

// 由色料质量向量与膜厚计算每个波段的 KX、SX。
// m: number[]，长度 = PIGMENTS.length
// h: 覆盖厚度（体积/面积原型单位）
export function filmDepths(m, h, wet = false) {
  const P = PIGMENTS.length;
  let M = 0;
  for (let i = 0; i < P; i++) M += m[i] || 0;
  if (M < EPS_MASS || !(h > EPS_MASS)) return null;

  const c = Math.min(1, M / h); // 色料体积浓度
  const scatterMul = wet ? WET_SCATTER_MUL : 1;
  const kx = new Float64Array(WAVELENGTHS.length);
  const sx = new Float64Array(WAVELENGTHS.length);

  for (let w = 0; w < WAVELENGTHS.length; w++) {
    let kPer = 0; // 单位厚度吸收系数（按配方质量占比）
    let sPer = 0;
    for (let i = 0; i < P; i++) {
      const mi = m[i] || 0;
      if (mi <= 0) continue;
      const f = mi / M;
      kPer += f * PIGMENTS[i].k[w];
      sPer += f * PIGMENTS[i].s[w];
    }
    const K = c * kPer;
    const S = c * sPer * scatterMul;
    kx[w] = K * h;
    sx[w] = S * h;
  }
  return { kx, sx, concentration: c, totalMass: M, thickness: h };
}

// 把有序膜层（自下而上）依次折叠到底材光谱上。
// films: Array<{m:number[], h:number, wet?:boolean}>
export function evaluateStack(baseSpectrum, films) {
  let R = Float64Array.from(baseSpectrum);
  for (const film of films) {
    if (!film) continue;
    const d = filmDepths(film.m, film.h, !!film.wet);
    if (!d) continue;
    for (let w = 0; w < R.length; w++) {
      R[w] = kmReflectance(d.kx[w], d.sx[w], R[w]);
    }
  }
  return R;
}

// 均质预混色料的便捷求值（调色皿/笔色样用）。
// masses: number[]；thickness 与 concentration 由 h 显式给出。
export function evaluatePremix(masses, h, baseSpectrum, wet = false) {
  return evaluateStack(baseSpectrum, [{ m: masses, h, wet }]);
}
