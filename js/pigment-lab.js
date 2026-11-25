// 试混台实验内核：
//  - spectral-km：31 波段光谱近似 + 二通量 KM；
//  - constrained-ks：同一质量/覆盖厚度输入，但把每色料 K/S 约束为 7 个非负箱参数；
//  - 可封存湿样、清水回取、同色异颜料底层与反复混合守恒都在这里统一记账。
//
// 关键边界：质量向量是唯一物质事实；光学反射率只是由质量、厚度、湿度、封层状态
// 推导出的映射。任何 UI/报告都不得把朴素 RGB 平均当作物理混色结果。

import { PIGMENTS, paperSpectrum } from './pigments.js';
import { WAVELENGTHS, spectrumToDisplay, deltaE2000 } from './spectra.js';
import { evaluateStack, kmReflectance } from './km.js';

export const LAB_H = 4;
export const LAB_CONCENTRATION = 0.55;
export const LAB_MASS = LAB_H * LAB_CONCENTRATION;
export const LAB_PAPER = paperSpectrum();

export const OPTICAL_BINS = [
  { id: 'b420', center: 420, from: 400, to: 440 },
  { id: 'b470', center: 470, from: 450, to: 490 },
  { id: 'b515', center: 515, from: 500, to: 530 },
  { id: 'b555', center: 555, from: 540, to: 570 },
  { id: 'b595', center: 595, from: 580, to: 610 },
  { id: 'b635', center: 635, from: 620, to: 650 },
  { id: 'b680', center: 680, from: 660, to: 700 },
];

const BIN_INDEX_GROUPS = OPTICAL_BINS.map((bin) =>
  WAVELENGTHS.map((wl, i) => (wl >= bin.from && wl <= bin.to ? i : -1)).filter((i) => i >= 0)
);

export function recipeMasses(parts, totalMass = LAB_MASS) {
  const m = new Array(PIGMENTS.length).fill(0);
  let sum = 0;
  for (const [id, weight] of Object.entries(parts)) {
    const i = PIGMENTS.findIndex((p) => p.id === id);
    if (i < 0) throw new Error(`未知色料 ${id}`);
    sum += Math.max(0, Number(weight) || 0);
  }
  if (sum <= 0) return m;
  for (const [id, weight] of Object.entries(parts)) {
    const i = PIGMENTS.findIndex((p) => p.id === id);
    m[i] = (totalMass * Math.max(0, Number(weight) || 0)) / sum;
  }
  return m;
}

export const METAMER_RECIPES = [
  {
    id: 'ochre-ground',
    name: '土黄单颜料底层',
    soluble: true,
    binder: '原型可溶性动物胶',
    parts: { 'py43-ochre': 1 },
  },
  {
    id: 'lemon-red-ground',
    name: '柠檬黄＋吡咯红异颜料底层',
    soluble: false,
    binder: '原型耐水丙烯酸结合剂',
    parts: { 'py-lemon': 0.927, 'pr-red': 0.073 },
  },
];

export function spectralMix(masses, h = LAB_H, base = LAB_PAPER, wet = false) {
  return evaluateStack(base, [{ m: masses, h, wet }]);
}

function averageInBin(arr, indices) {
  let s = 0;
  for (const i of indices) s += arr[i];
  return s / indices.length;
}

// 从完整 K/S 光谱构造受约束的非负 7 箱参数。参数只由色料集推导，不接触 RGB。
export function constrainedPigmentParameters() {
  return PIGMENTS.map((p) => ({
    id: p.id,
    k: BIN_INDEX_GROUPS.map((idx) => Math.max(0, averageInBin(p.k, idx))),
    s: BIN_INDEX_GROUPS.map((idx) => Math.max(0, averageInBin(p.s, idx))),
  }));
}

export const CONSTRAINED_PARAMETERS = constrainedPigmentParameters();

function interpolateBinSpectrum(Rbin) {
  const centers = OPTICAL_BINS.map((b) => b.center);
  return WAVELENGTHS.map((wl) => {
    if (wl <= centers[0]) return Rbin[0];
    if (wl >= centers[centers.length - 1]) return Rbin[Rbin.length - 1];
    let j = 0;
    while (j < centers.length - 2 && wl > centers[j + 1]) j++;
    const t = (wl - centers[j]) / (centers[j + 1] - centers[j]);
    return Rbin[j] * (1 - t) + Rbin[j + 1] * t;
  });
}

// 与 spectralMix 相同的 m/h/base/wet 输入；区别仅在光学表示为受限参数模型。
export function constrainedMix(masses, h = LAB_H, base = LAB_PAPER, wet = false) {
  const P = PIGMENTS.length;
  let M = 0;
  for (let i = 0; i < P; i++) M += Math.max(0, masses[i] || 0);
  if (M <= 1e-10 || !(h > 1e-10)) return Float64Array.from(base);
  const c = Math.min(1, M / h);
  const wetScatter = wet ? 0.62 : 1;
  const baseBins = BIN_INDEX_GROUPS.map((idx) => averageInBin(base, idx));
  const Rbin = OPTICAL_BINS.map((_, b) => {
    let kPer = 0;
    let sPer = 0;
    for (let i = 0; i < P; i++) {
      const mi = Math.max(0, masses[i] || 0);
      if (mi <= 0) continue;
      const f = mi / M;
      kPer += f * CONSTRAINED_PARAMETERS[i].k[b];
      sPer += f * CONSTRAINED_PARAMETERS[i].s[b];
    }
    const kx = c * kPer * h;
    const sx = c * sPer * wetScatter * h;
    return kmReflectance(kx, sx, baseBins[b]);
  });
  return Float64Array.from(interpolateBinSpectrum(Rbin));
}

export function mixWithModel(modelId, masses, h = LAB_H, base = LAB_PAPER, wet = false) {
  if (modelId === 'spectral-km') return spectralMix(masses, h, base, wet);
  if (modelId === 'constrained-ks') return constrainedMix(masses, h, base, wet);
  throw new Error(`未知混色模型：${modelId}`);
}

// 仅作为“屏幕 RGB 平均”反例，明确不进入画布、导出结论或质量守恒账本。
export function naiveRgbAverageControl(masses, h = LAB_H) {
  let total = 0;
  const rgb = [0, 0, 0];
  masses.forEach((m, i) => {
    if (m <= 0) return;
    total += m;
    const c = spectrumToDisplay(spectralMix((() => {
      const one = new Array(PIGMENTS.length).fill(0);
      one[i] = m;
      return one;
    })(), h));
    rgb[0] += c.r * m;
    rgb[1] += c.g * m;
    rgb[2] += c.b * m;
  });
  if (total <= 0) return { hex: '#ffffff', rgb: [255, 255, 255], physical: false };
  const out = rgb.map((v) => Math.round(v / total));
  return {
    rgb: out,
    hex: '#' + out.map((v) => v.toString(16).padStart(2, '0')).join(''),
    physical: false,
  };
}

export function colorReport(R) {
  const bright = spectrumToDisplay(R, { illuminant: 'brightD65' });
  const dim = spectrumToDisplay(R, { illuminant: 'dimWarmA' });
  const lamp = spectrumToDisplay(R, { illuminant: 'A' });
  return {
    brightD65: {
      hex: bright.hex,
      lab: bright.surfaceLab,
      apparentLab: bright.lab,
      clipped: bright.clipped,
    },
    warmA: { hex: lamp.hex, lab: lamp.surfaceLab, clipped: lamp.clipped },
    dimWarmA: { hex: dim.hex, lab: dim.lab, surfaceLab: dim.surfaceLab, clipped: dim.clipped },
  };
}

export function spectralRmse(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s / a.length);
}

export function modelDifference(masses, h = LAB_H) {
  const Rs = spectralMix(masses, h, LAB_PAPER, false);
  const Rc = constrainedMix(masses, h, LAB_PAPER, false);
  const cs = colorReport(Rs);
  const cc = colorReport(Rc);
  return {
    spectralRmse: spectralRmse(Rs, Rc),
    deltaEBright: deltaE2000(cs.brightD65.lab, cc.brightD65.lab),
    deltaEWarm: deltaE2000(cs.warmA.lab, cc.warmA.lab),
    spectral: cs,
    constrained: cc,
    R_spectral: Array.from(Rs),
    R_constrained: Array.from(Rc),
  };
}

export class SealableSwatch {
  constructor(recipe, options = {}) {
    this.recipeId = recipe.id;
    this.name = recipe.name;
    this.soluble = options.soluble ?? recipe.soluble ?? false;
    this.h = options.h ?? LAB_H;
    this.concentration = options.concentration ?? LAB_CONCENTRATION;
    this.sealed = false;
    this.sealedAt = null;
    this.wet = options.wet ?? true;
    this.waterVolume = options.waterVolume ?? this.h * (1 - this.concentration);
    this.layers = [
      {
        id: recipe.id,
        name: recipe.name,
        soluble: this.soluble,
        m: Float64Array.from(recipeMasses(recipe.parts, this.h * this.concentration)),
        v: this.waterVolume,
      },
    ];
    this.barrierWater = 0;
    this.effluent = { m: new Float64Array(PIGMENTS.length), water: 0 };
    this.events = [];
  }

  remainingMasses() {
    const m = new Float64Array(PIGMENTS.length);
    for (const layer of this.layers) for (let i = 0; i < m.length; i++) m[i] += layer.m[i];
    return m;
  }

  remainingMass() {
    return this.remainingMasses().reduce((s, x) => s + x, 0);
  }

  totalPigmentMass() {
    return this.remainingMass() + this.effluent.m.reduce((s, x) => s + x, 0);
  }

  seal(at = 'seal') {
    if (this.sealed) return this.snapshot();
    this.sealed = true;
    this.sealedAt = at;
    this.events.push({ type: 'seal', at });
    return this.snapshot();
  }

  // 同一滴清水：volume/lift 固定。封存后透明隔离层阻止水到达可溶物质层。
  applyWater(drop = { volume: 0.85, lift: 0.72 }, at = 'water') {
    const removed = new Float64Array(PIGMENTS.length);
    let removedMass = 0;
    if (this.sealed) {
      this.barrierWater += drop.volume;
      this.events.push({ type: 'water-blocked', at, volume: drop.volume, removedMass: 0 });
    } else {
      for (const layer of this.layers) {
        if (!layer.soluble) continue;
        const fraction = Math.min(0.95, Math.max(0, drop.lift));
        for (let i = 0; i < PIGMENTS.length; i++) {
          const take = layer.m[i] * fraction;
          layer.m[i] -= take;
          this.effluent.m[i] += take;
          removed[i] += take;
          removedMass += take;
        }
        layer.v += drop.volume;
        this.effluent.water += 0; // 水滴进入膜内；流出实验只承接颜料，水量不做外部账本
      }
      this.wet = true;
      this.events.push({ type: 'water-lift', at, volume: drop.volume, lift: drop.lift, removedMass });
    }
    return { removed: Array.from(removed), removedMass, snapshot: this.snapshot() };
  }

  dry() {
    this.wet = false;
    for (const layer of this.layers) layer.v *= 0.12;
    this.events.push({ type: 'dry' });
    return this.snapshot();
  }

  filmSpecs() {
    return this.layers.map((layer) => {
      const M = layer.m.reduce((s, x) => s + x, 0);
      return { m: layer.m, h: this.h, wet: this.wet && !this.sealed ? true : this.wet };
    });
  }

  reflectance(modelId = 'spectral-km') {
    const films = this.layers.map((layer) => ({ m: layer.m, h: this.h, wet: this.wet }));
    if (modelId === 'spectral-km') return evaluateStack(LAB_PAPER, films);
    // 受限模型目前以主物质层为对照；试混片只有一个底层。
    return constrainedMix(this.remainingMasses(), this.h, LAB_PAPER, this.wet);
  }

  snapshot() {
    const remaining = Array.from(this.remainingMasses());
    const effluent = Array.from(this.effluent.m);
    return {
      recipeId: this.recipeId,
      name: this.name,
      soluble: this.soluble,
      sealed: this.sealed,
      sealedAt: this.sealedAt,
      wet: this.wet,
      remaining,
      remainingMass: remaining.reduce((s, x) => s + x, 0),
      effluent,
      effluentMass: effluent.reduce((s, x) => s + x, 0),
      totalPigmentMass: this.totalPigmentMass(),
      events: this.events.map((e) => ({ ...e })),
      colors: {
        spectral: colorReport(this.reflectance('spectral-km')),
        constrained: colorReport(this.reflectance('constrained-ks')),
      },
    };
  }
}

// 反复“均质混合 -> 分盘 -> 再混合”。质量域表示下，光学模型不参与物质增减。
export function repeatedMixTrial(recipeA = METAMER_RECIPES[0], recipeB = METAMER_RECIPES[1], cycles = 64) {
  const unitA = recipeMasses(recipeA.parts, 0.37);
  const unitB = recipeMasses(recipeB.parts, 0.29);
  let pan = new Float64Array(PIGMENTS.length);
  let other = new Float64Array(PIGMENTS.length);
  let source = 0;
  const driftByCycle = [];
  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < PIGMENTS.length; i++) {
      pan[i] += unitA[i] + unitB[i];
      source += unitA[i] + unitB[i];
    }
    // 对半分盘，再把 B 盘的 37% 与 A 盘交换，强制反复混合但不丢弃质量。
    for (let i = 0; i < PIGMENTS.length; i++) {
      const half = pan[i] * 0.5;
      pan[i] = half;
      other[i] += half;
      const swap = other[i] * 0.37;
      other[i] -= swap;
      pan[i] += swap;
    }
    let total = 0;
    for (let i = 0; i < PIGMENTS.length; i++) total += pan[i] + other[i];
    driftByCycle.push(Math.abs(total - source));
  }
  const finalMasses = pan.map((m, i) => m + other[i]);
  const drift = Math.max(...driftByCycle);
  return {
    cycles,
    sourceMass: source,
    finalMass: finalMasses.reduce((s, x) => s + x, 0),
    maxAbsoluteDrift: drift,
    maxRelativeDrift: drift / Math.max(source, 1e-12),
    finalMasses: Array.from(finalMasses),
    driedColors: {
      'spectral-km': colorReport(spectralMix(finalMasses, LAB_H, LAB_PAPER, false)),
      'constrained-ks': colorReport(constrainedMix(finalMasses, LAB_H, LAB_PAPER, false)),
    },
  };
}

export function sealWaterExperiment() {
  const drops = [];
  for (const recipe of METAMER_RECIPES) {
    const before = new SealableSwatch(recipe, { wet: false });
    const beforeInitial = before.snapshot();
    const beforeResult = before.applyWater();
    const beforeWet = before.snapshot();
    before.dry();
    const beforeDry = before.snapshot();

    const after = new SealableSwatch(recipe, { wet: false });
    const afterInitial = after.snapshot();
    after.seal('before-water');
    const afterResult = after.applyWater();
    const afterWet = after.snapshot();
    after.dry();
    const afterDry = after.snapshot();

    drops.push({
      recipeId: recipe.id,
      name: recipe.name,
      soluble: recipe.soluble,
      initial: beforeInitial,
      waterBeforeSeal: { result: { removedMass: beforeResult.removedMass, removed: beforeResult.removed }, wet: beforeWet, dry: beforeDry },
      waterAfterSeal: { result: { removedMass: afterResult.removedMass, removed: afterResult.removed }, wet: afterWet, dry: afterDry },
    });
  }
  return drops;
}

export function complementaryThinLayerExperiment() {
  const pairs = [
    { id: 'yellow-blue', a: 'py-lemon', b: 'pb15-cyan', label: '黄×青蓝（互补附近）' },
    { id: 'red-green', a: 'pr-red', b: 'pg7-green', label: '红×绿（强互补）' },
    { id: 'magenta-green', a: 'pv19-magenta', b: 'pg7-green', label: '品红×绿（互补）' },
    { id: 'orange-blue', a: 'py43-ochre', b: 'pb29-ultramarine', label: '土黄×群青（暖灰）' },
  ];
  const thicknesses = [0.08, 0.16, 0.32, 0.64, 1.28, 2.56];
  return pairs.map((pair) => {
    const rows = thicknesses.map((h) => {
      const amount = LAB_CONCENTRATION * h;
      const ma = recipeMasses({ [pair.a]: 1 }, amount);
      const mb = recipeMasses({ [pair.b]: 1 }, amount);
      const premix = ma.map((x, i) => x + mb[i]);
      const AB = evaluateStack(LAB_PAPER, [
        { m: ma, h, wet: false },
        { m: mb, h, wet: false },
      ]);
      const BA = evaluateStack(LAB_PAPER, [
        { m: mb, h, wet: false },
        { m: ma, h, wet: false },
      ]);
      const mixR = spectralMix(premix, 2 * h, LAB_PAPER, false);
      const constrainedR = constrainedMix(premix, 2 * h, LAB_PAPER, false);
      const rgb = naiveRgbAverageControl(premix, 2 * h);
      const abColor = spectrumToDisplay(AB, { illuminant: 'D65' });
      const baColor = spectrumToDisplay(BA, { illuminant: 'D65' });
      const mixColor = spectrumToDisplay(mixR, { illuminant: 'D65' });
      const constrainedColor = spectrumToDisplay(constrainedR, { illuminant: 'D65' });
      return {
        h,
        deltaOrder: deltaE2000(abColor.surfaceLab, baColor.surfaceLab),
        deltaLayerPremix: deltaE2000(abColor.surfaceLab, mixColor.surfaceLab),
        deltaSpectralConstrained: deltaE2000(mixColor.surfaceLab, constrainedColor.surfaceLab),
        deltaKmVsRgbAverage: deltaE2000(mixColor.surfaceLab, hexToLabApprox(rgb.hex)),
        spectralRmseConstrained: spectralRmse(mixR, constrainedR),
        AB: abColor.hex,
        BA: baColor.hex,
        premix: mixColor.hex,
        constrained: constrainedColor.hex,
        rgbAverageControl: rgb.hex,
      };
    });
    return { ...pair, rows };
  });
}

function hexToLabApprox(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // 仅用于反例指标：走与显示转换一致的 sRGB->XYZ->Lab 近似，避免在 RGB 空间比较色差。
  const lin = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const M = [
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.072175],
    [0.0193339, 0.119192, 0.9503041],
  ];
  const xyz = M.map((row) => row.reduce((s, v, i) => s + v * lin[i], 0));
  return {
    L: 116 * Math.cbrt(xyz[1] / 1) - 16,
    a: 500 * (Math.cbrt(xyz[0] / 0.95047) - Math.cbrt(xyz[1])),
    b: 200 * (Math.cbrt(xyz[1]) - Math.cbrt(xyz[2] / 1.08883)),
  };
}

export function darkMixExperiment() {
  const recipes = [
    { id: 'black-only', parts: { 'pbk9-black': 1 } },
    { id: 'black-umber', parts: { 'pbk9-black': 0.72, 'pbr7-umber': 0.28 } },
    { id: 'complement-dark', parts: { 'pr-red': 0.5, 'pg7-green': 0.5 } },
    { id: 'blue-umber-dark', parts: { 'pb15-cyan': 0.56, 'pbr7-umber': 0.44 } },
  ];
  const hs = [0.4, 1, 2.5, 6];
  return recipes.map((recipe) => {
    const rows = hs.map((h) => {
      const m = recipeMasses(recipe.parts, LAB_CONCENTRATION * h);
      const diff = modelDifference(m, h);
      const R = spectralMix(m, h);
      const c = colorReport(R);
      return { h, ...diff, colors: c };
    });
    return { ...recipe, rows };
  });
}

export function benchmarkModels(iterations = 200) {
  const m = recipeMasses({ 'py-lemon': 0.5, 'pb15-cyan': 0.5 }, LAB_MASS);
  function time(fn) {
    fn();
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    const t1 = performance.now();
    return { totalMs: +(t1 - t0).toFixed(3), perCallUs: +(((t1 - t0) / iterations) * 1000).toFixed(2) };
  }
  return {
    iterations,
    spectral: time(() => spectralMix(m, LAB_H)),
    constrained: time(() => constrainedMix(m, LAB_H)),
    parameterCounts: {
      spectralPerPigment: WAVELENGTHS.length * 2,
      constrainedPerPigment: OPTICAL_BINS.length * 2,
      totalSpectral: PIGMENTS.length * WAVELENGTHS.length * 2,
      totalConstrained: PIGMENTS.length * OPTICAL_BINS.length * 2,
    },
  };
}

export function buildExperimentReport() {
  const specimens = METAMER_RECIPES.map((recipe) => {
    const m = recipeMasses(recipe.parts);
    return {
      ...recipe,
      parts: recipe.parts,
      masses: m,
      models: modelDifference(m, LAB_H),
    };
  });
  const referenceDelta = deltaE2000(
    specimens[0].models.spectral.brightD65.lab,
    specimens[1].models.spectral.brightD65.lab
  );
  const warmDelta = deltaE2000(
    specimens[0].models.spectral.warmA.lab,
    specimens[1].models.spectral.warmA.lab
  );
  const dimWarmDelta = deltaE2000(
    specimens[0].models.spectral.dimWarmA.lab,
    specimens[1].models.spectral.dimWarmA.lab
  );
  return {
    schema: 'pigment-model-experiments-v1',
    generatedAt: new Date().toISOString(),
    constants: {
      LAB_H,
      LAB_CONCENTRATION,
      LAB_MASS,
      wavelengths: WAVELENGTHS,
      bins: OPTICAL_BINS,
    },
    metamer: {
      brightD65DeltaE00: referenceDelta,
      warmADeltaE00: warmDelta,
      dimWarmADeltaE00: dimWarmDelta,
      specimens,
    },
    sealWater: sealWaterExperiment(),
    repeatedMix: {
      spectral: repeatedMixTrial(METAMER_RECIPES[0], METAMER_RECIPES[1], 64),
      constrained: repeatedMixTrial(METAMER_RECIPES[0], METAMER_RECIPES[1], 64),
    },
    complementaryThinLayers: complementaryThinLayerExperiment(),
    darkMix: darkMixExperiment(),
    benchmark: benchmarkModels(120),
  };
}
