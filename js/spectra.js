// 光谱网格、CIE 颜色匹配函数近似与光谱 -> 显示 RGB 转换。
// 颜色求值只在这里发生一次；视图缩放/采样不参与计算。

export const WL_START = 400; // nm
export const WL_END = 700; // nm
export const WL_STEP = 10; // nm，31 个波段
export const WAVELENGTHS = (() => {
  const a = [];
  for (let w = WL_START; w <= WL_END + 1e-9; w += WL_STEP) a.push(Math.round(w));
  return a;
})();

// Wyman, Sloan & Shirley (2013) 对 CIE 1931 2° 颜色匹配函数的解析高斯近似。
// 用解析式而非手抄数表，避免转录错误；属于本原型“有说明的自定义参数集”的一部分。
function gauss(x, mu, sigma) {
  const t = (x - mu) / sigma;
  return Math.exp(-0.5 * t * t);
}

export function cmfX(wl) {
  const t1 = (wl - 442.0) * (wl < 442.0 ? 0.0624 : 0.0374);
  const t2 = (wl - 599.8) * (wl < 599.8 ? 0.0264 : 0.0323);
  const t3 = (wl - 501.1) * (wl < 501.1 ? 0.049 : 0.0382);
  return (
    0.362 * Math.exp(-0.5 * t1 * t1) +
    1.056 * Math.exp(-0.5 * t2 * t2) -
    0.065 * Math.exp(-0.5 * t3 * t3)
  );
}

export function cmfY(wl) {
  const t1 = (wl - 568.8) * (wl < 568.8 ? 0.0213 : 0.0247);
  const t2 = (wl - 530.9) * (wl < 530.9 ? 0.0613 : 0.0322);
  return 0.821 * Math.exp(-0.5 * t1 * t1) + 0.286 * Math.exp(-0.5 * t2 * t2);
}

export function cmfZ(wl) {
  const t1 = (wl - 437.0) * (wl < 437.0 ? 0.0845 : 0.0278);
  const t2 = (wl - 459.0) * (wl < 459.0 ? 0.0385 : 0.0725);
  return 1.217 * Math.exp(-0.5 * t1 * t1) + 0.681 * Math.exp(-0.5 * t2 * t2);
}

const CMF = WAVELENGTHS.map((w) => [cmfX(w), cmfY(w), cmfZ(w)]);

// 原型采用等能光源 E（S(lambda)=1），再用 Bradford 色适应映射到 sRGB 的 D65 白点。
// 这是明确声明的简化选择，不冒充 D65 实测配色。
export const ILLUMINANT_ID = 'equal-energy-E + Bradford->D65';

const sumY = CMF.reduce((s, c) => s + c[1], 0) * WL_STEP;
const NORM = 1 / sumY; // 使理想反射体 Y = 1

export function spectrumToXYZ(R) {
  let X = 0,
    Y = 0,
    Z = 0;
  for (let i = 0; i < WAVELENGTHS.length; i++) {
    const r = R[i];
    const [x, y, z] = CMF[i];
    X += r * x;
    Y += r * y;
    Z += r * z;
  }
  const k = NORM * WL_STEP;
  return { X: X * k, Y: Y * k, Z: Z * k };
}

const D65_WHITE = { X: 0.95047, Y: 1.0, Z: 1.08883 };

// 理想反射体在 E 下的白点
const WHITE_E = spectrumToXYZ(WAVELENGTHS.map(() => 1));

// Bradford 色适应矩阵
const M_BFD = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];
const M_BFD_INV = [
  [0.9869929, -0.1470543, 0.1599627],
  [0.4323053, 0.5183603, 0.0492912],
  [-0.0085287, 0.0400428, 0.9684867],
];

function matVec(M, v) {
  return [
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
  ];
}

function bradfordAdaptXYZ(X, Y, Z) {
  const src = matVec(M_BFD, [WHITE_E.X, WHITE_E.Y, WHITE_E.Z]);
  const dst = matVec(M_BFD, [D65_WHITE.X, D65_WHITE.Y, D65_WHITE.Z]);
  const g = [dst[0] / src[0], dst[1] / src[1], dst[2] / src[2]];
  const cones = matVec(M_BFD, [X, Y, Z]);
  const adapted = [cones[0] * g[0], cones[1] * g[1], cones[2] * g[2]];
  const out = matVec(M_BFD_INV, adapted);
  return { X: out[0], Y: out[1], Z: out[2] };
}

// 线性 XYZ(D65) -> linear sRGB
const XYZ_TO_LINSRGB = [
  [3.2404542, -1.5371385, -0.4985314],
  [-0.969266, 1.8760108, 0.041556],
  [0.0556434, -0.2040259, 1.0572252],
];

function gammaEncode(c) {
  if (c <= 0.0031308) return 12.92 * c;
  return 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
}

export function spectrumToDisplay(R) {
  const xyzE = spectrumToXYZ(R);
  const xyz = bradfordAdaptXYZ(xyzE.X, xyzE.Y, xyzE.Z);
  const lin = matVec(XYZ_TO_LINSRGB, [xyz.X, xyz.Y, xyz.Z]);
  const encoded = lin.map(gammaEncode);
  const raw = encoded.map((c) => Math.round(clamp01(c) * 255));
  const clipped = lin.some((c) => c < -1e-5 || c > 1 + 1e-5);
  return {
    r: raw[0],
    g: raw[1],
    b: raw[2],
    css: `rgb(${raw[0]},${raw[1]},${raw[2]})`,
    hex:
      '#' +
      raw
        .map((v) => v.toString(16).padStart(2, '0'))
        .join(''),
    xyz,
    lab: xyzToLab(xyz.X, xyz.Y, xyz.Z),
    linear: lin,
    clipped,
  };
}

export function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// ---- Lab 与色差（取样比较用） ----
function labF(t) {
  const d = 6 / 29;
  if (t > d * d * d) return Math.cbrt(t);
  return t / (3 * d * d) + 4 / 29;
}

export function xyzToLab(X, Y, Z) {
  const fx = labF(X / D65_WHITE.X);
  const fy = labF(Y / D65_WHITE.Y);
  const fz = labF(Z / D65_WHITE.Z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function deltaE76(l1, l2) {
  return Math.hypot(l1.L - l2.L, l1.a - l2.a, l1.b - l2.b);
}

// CIEDE2000（Sharma 等 2005 修正公式）
export function deltaE2000(l1, l2) {
  const { L: L1, a: a1, b: b1 } = l1;
  const { L: L2, a: a2, b: b2 } = l2;
  const avgL = (L1 + L2) / 2;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const avgC = (C1 + C2) / 2;
  const G =
    0.5 * (1 - Math.sqrt(Math.pow(avgC, 7) / (Math.pow(avgC, 7) + Math.pow(25, 7))));
  const a1p = a1 * (1 + G);
  const a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const avgCp = (C1p + C2p) / 2;
  let h1p = (Math.atan2(b1, a1p) * 180) / Math.PI;
  if (h1p < 0) h1p += 360;
  if (C1p === 0) h1p = 0;
  let h2p = (Math.atan2(b2, a2p) * 180) / Math.PI;
  if (h2p < 0) h2p += 360;
  if (C2p === 0) h2p = 0;
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    let diff = h2p - h1p;
    if (diff > 180) diff -= 360;
    else if (diff < -180) diff += 360;
    dhp = diff;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * (Math.PI / 180));
  const avgLp = avgL;
  let avgHp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) {
      if (h1p + h2p < 360) avgHp = (h1p + h2p + 360) / 2;
      else avgHp = (h1p + h2p - 360) / 2;
    } else avgHp = (h1p + h2p) / 2;
  }
  if (C1p * C2p === 0) avgHp = h1p + h2p;
  const T =
    1 -
    0.17 * Math.cos(((avgHp - 30) * Math.PI) / 180) +
    0.24 * Math.cos((2 * avgHp * Math.PI) / 180) +
    0.32 * Math.cos(((3 * avgHp + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * avgHp - 63) * Math.PI) / 180);
  const dTheta = 30 * Math.exp(-Math.pow((avgHp - 275) / 25, 2));
  const Rc =
    2 * Math.sqrt(Math.pow(avgCp, 7) / (Math.pow(avgCp, 7) + Math.pow(25, 7)));
  const Sl =
    1 + (0.015 * (avgLp - 50) * (avgLp - 50)) / Math.sqrt(20 + (avgLp - 50) ** 2);
  const Sc = 1 + 0.045 * avgCp;
  const Sh = 1 + 0.015 * avgCp * T;
  const Rt = -Math.sin((2 * dTheta * Math.PI) / 180) * Rc;
  const kL = 1,
    kC = 1,
    kH = 1;
  return Math.sqrt(
    (dLp / (kL * Sl)) ** 2 +
      (dCp / (kC * Sc)) ** 2 +
      (dHp / (kH * Sh)) ** 2 +
      Rt * (dCp / (kC * Sc)) * (dHp / (kH * Sh))
  );
}
