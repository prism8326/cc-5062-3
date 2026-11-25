// 原型色料参数集 "proto-pigments-v1"。
//
// 重要声明：
// 这里的 K/S 曲线全部由少量高斯吸收带 + 吸收边参数人工构造，
// 用来得到“色相方向合理”的演示效果，不是任何真实品牌颜料的实测数据。
// 模型能力限定为：漫射二通量 Kubelka-Munk、单一散射近似、无光泽/荧光/干涉色。
//
// 每个色料给出按单位色料面密度归一化的吸收系数 k(lambda) 与散射系数 s(lambda)。
// 数值是原型任意单位，配合文档中的质量/膜厚尺度一起标定。

import { WAVELENGTHS } from './spectra.js';

function buildCoefficient(spec) {
  return WAVELENGTHS.map((wl) => {
    let v = spec.base ?? 0;
    if (spec.bands) {
      for (const b of spec.bands) {
        v += b.a * Math.exp(-0.5 * ((wl - b.c) / b.w) ** 2);
      }
    }
    if (spec.edges) {
      // sigmoid 吸收边：wl << c 时贡献 amp，wl >> c 时趋于 0
      for (const e of spec.edges) {
        v += e.a / (1 + Math.exp((wl - e.c) / e.w));
      }
    }
    if (spec.slope) {
      v += spec.slope * ((wl - 550) / 150);
    }
    return Math.max(v, 0);
  });
}

// staining: 染色/牢固程度 0..1，越高越不容易被湿画笔回取
// density: 相对密度（原型单位，用于质量->体积/厚度）
export const PIGMENTS = [
  {
    id: 'pw6-white',
    name: '原型钛白',
    code: 'PW6*',
    density: 1.25,
    staining: 0.85,
    kSpec: { base: 0.03, bands: [{ c: 395, w: 22, a: 1.1 }] },
    sSpec: { base: 7.5, slope: 0.8 },
    note: '高散射、可见光区低吸收，紫端略增吸收',
  },
  {
    id: 'pbk9-black',
    name: '原型炭黑',
    code: 'PBk9*',
    density: 0.7,
    staining: 0.95,
    kSpec: { base: 8.5, slope: -0.6 },
    sSpec: { base: 0.22 },
    note: '全波段强吸收、弱散射',
  },
  {
    id: 'py-lemon',
    name: '原型柠檬黄',
    code: 'PY-L*',
    density: 1.0,
    staining: 0.45,
    kSpec: { base: 0.03, edges: [{ c: 470, w: 15, a: 7.5 }] },
    sSpec: { base: 2.6 },
    note: '吸收蓝紫，反射绿到红',
  },
  {
    id: 'py43-ochre',
    name: '原型土黄',
    code: 'PY43*',
    density: 1.2,
    staining: 0.7,
    kSpec: { base: 0.1, edges: [{ c: 488, w: 22, a: 3.8 }] },
    sSpec: { base: 1.5 },
    note: '黄中带褐，蓝区吸收更宽',
  },
  {
    id: 'pr-red',
    name: '原型吡咯红',
    code: 'PR-X*',
    density: 1.05,
    staining: 0.75,
    kSpec: { base: 0.04, edges: [{ c: 585, w: 15, a: 8.5 }] },
    sSpec: { base: 1.4 },
    note: '580nm 以下陡吸收，反射红端',
  },
  {
    id: 'pv19-magenta',
    name: '原型喹吖啶酮玫红',
    code: 'PV19*',
    density: 1.1,
    staining: 0.8,
    kSpec: {
      base: 0.04,
      bands: [{ c: 548, w: 19, a: 8.8 }],
    },
    sSpec: { base: 1.4 },
    note: '主要吸收绿区，同时保留红与蓝反射 -> 品红',
  },
  {
    id: 'pb29-ultramarine',
    name: '原型群青',
    code: 'PB29*',
    density: 0.9,
    staining: 0.55,
    kSpec: {
      base: 0.07,
      bands: [
        { c: 598, w: 38, a: 5.6 },
        { c: 560, w: 55, a: 0.8 },
      ],
    },
    sSpec: { base: 1.3 },
    note: '吸收橙红，蓝紫反射，略带红相',
  },
  {
    id: 'pb15-cyan',
    name: '原型酞青蓝(青相)',
    code: 'PB15:3*',
    density: 0.85,
    staining: 0.9,
    kSpec: {
      base: 0.05,
      bands: [
        { c: 670, w: 42, a: 7.2 },
        { c: 600, w: 30, a: 2.4 },
      ],
    },
    sSpec: { base: 1.6 },
    note: '强吸收红端，绿蓝均反射 -> 青相蓝',
  },
  {
    id: 'pg7-green',
    name: '原型酞青绿',
    code: 'PG7*',
    density: 0.95,
    staining: 0.9,
    kSpec: {
      base: 0.05,
      bands: [
        { c: 650, w: 40, a: 6.2 },
        { c: 428, w: 32, a: 5.2 },
      ],
    },
    sSpec: { base: 1.35 },
    note: '吸收红与蓝紫，保留绿区',
  },
  {
    id: 'pbr7-umber',
    name: '原型熟褐',
    code: 'PBr7*',
    density: 1.2,
    staining: 0.8,
    kSpec: {
      base: 0.5,
      edges: [{ c: 545, w: 70, a: 3.2 }],
      bands: [{ c: 445, w: 42, a: 2.0 }],
    },
    sSpec: { base: 0.6 },
    note: '宽波段蓝绿吸收，低散射土褐',
  },
];

export const PIGMENT_BY_ID = new Map(PIGMENTS.map((p, i) => [p.id, { ...p, index: i }]));

// 预计算每个色料的 k/s 光谱数组
for (const p of PIGMENTS) {
  p.k = buildCoefficient(p.kSpec);
  p.s = buildCoefficient(p.sSpec);
}

export const PIGMENT_SET_ID = 'proto-pigments-v1';
export const PIGMENT_SET_NOTE =
  '人工参数原型色料集，K/S 曲线为高斯近似，不对应任何真实品牌实测数据';

// 画纸/底材反射光谱：暖白，紫端略暗
export function paperSpectrum() {
  return WAVELENGTHS.map((wl) => {
    const v = 0.965 - 0.085 * Math.exp(-(((wl - 398) / 62) ** 2));
    return Math.min(0.98, Math.max(0, v));
  });
}

// 测试台使用的几种明确声明的自定义底色
export const SUBSTRATES = [
  { id: 'paper-white', name: '暖白纸', spectrum: paperSpectrum() },
  {
    id: 'pure-white',
    name: '中性白',
    spectrum: WAVELENGTHS.map(() => 0.97),
  },
  { id: 'black', name: '黑底', spectrum: WAVELENGTHS.map(() => 0.02) },
  {
    id: 'kraft',
    name: '牛皮纸',
    spectrum: WAVELENGTHS.map((wl) => {
      const t = (wl - 400) / 300;
      return 0.28 + 0.42 * t; // 0.28 -> 0.70
    }),
  },
  {
    id: 'blue-ground',
    name: '灰蓝底',
    spectrum: WAVELENGTHS.map((wl) => {
      return 0.18 + 0.3 * Math.exp(-0.5 * ((wl - 470) / 45) ** 2);
    }),
  },
  {
    id: 'red-ground',
    name: '铁红底',
    spectrum: WAVELENGTHS.map((wl) => {
      return 0.12 + 0.34 / (1 + Math.exp(-(wl - 590) / 16));
    }),
  },
];
