import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  METAMER_RECIPES,
  SealableSwatch,
  constrainedMix,
  spectralMix,
  repeatedMixTrial,
  buildExperimentReport,
  recipeMasses,
  LAB_H,
} from '../js/pigment-lab.js';
import { ILLUMINANTS, spectrumToDisplay, deltaE2000 } from '../js/spectra.js';
import { PaintDocument, Brush } from '../js/document.js';
import { renderAll, evaluatePixelColor } from '../js/render.js';

test('光源变换：明亮 D65 与暖 A 的理想反射体都映射为白色', () => {
  const R = Array(31).fill(1);
  assert.equal(spectrumToDisplay(R, { illuminant: 'D65' }).hex, '#ffffff');
  assert.equal(spectrumToDisplay(R, { illuminant: 'A' }).hex, '#ffffff');
  const dim = spectrumToDisplay(R, { illuminant: 'dimWarmA' });
  assert.ok(dim.r < 255 && dim.exposure === 0.45);
  assert.ok(ILLUMINANTS.brightD65 && ILLUMINANTS.dimWarmA);
});

test('同色异颜料底层在 D65 下接近，在暖光下分离', () => {
  const report = buildExperimentReport();
  assert.ok(report.metamer.brightD65DeltaE00 < 1.5);
  assert.ok(report.metamer.warmADeltaE00 > 2.0);
  assert.notEqual(METAMER_RECIPES[0].parts, METAMER_RECIPES[1].parts);
});

test('封存前清水可带走可溶底层；封存后被阻挡，且总量守恒', () => {
  const open = new SealableSwatch(METAMER_RECIPES[0], { wet: false });
  const initial = open.totalPigmentMass();
  const before = open.applyWater();
  assert.ok(before.removedMass > 1);
  assert.ok(open.remainingMass() < initial);
  assert.ok(Math.abs(open.totalPigmentMass() - initial) < 1e-10);

  const sealed = new SealableSwatch(METAMER_RECIPES[0], { wet: false });
  sealed.seal();
  const after = sealed.applyWater();
  assert.equal(after.removedMass, 0);
  assert.ok(Math.abs(sealed.remainingMass() - initial) < 1e-10);
  assert.ok(Math.abs(sealed.totalPigmentMass() - initial) < 1e-10);

  const insoluble = new SealableSwatch(METAMER_RECIPES[1], { wet: false });
  const result = insoluble.applyWater();
  assert.equal(result.removedMass, 0);
});

test('两种模型的反射率均有限且在 [0,1]，反复混合质量守恒', () => {
  const m = recipeMasses({ 'py-lemon': 0.5, 'pb15-cyan': 0.5 });
  for (const R of [spectralMix(m, LAB_H), constrainedMix(m, LAB_H)]) {
    assert.equal(R.length, 31);
    for (const x of R) {
      assert.ok(Number.isFinite(x));
      assert.ok(x >= -1e-9 && x <= 1 + 1e-9);
    }
  }
  const trial = repeatedMixTrial();
  assert.ok(trial.maxRelativeDrift < 1e-10);
  assert.ok(Math.abs(trial.finalMass - trial.sourceMass) < 1e-8);
});

test('绘画接点：混合、晾干、叠画后渲染缓冲逐像素等于内核显示变换', () => {
  const doc = new PaintDocument(96, 72);
  const brush = new Brush();
  brush.radius = 10;
  brush.exchange = 0.2;
  brush.loadMix(recipeMasses({ 'py-lemon': 1, 'pb15-cyan': 1 }, 120), { dabs: 80 });
  for (let x = 12; x <= 60; x += 5) doc.applyDab(x, 36, brush, new Map());
  doc.dryWet();

  const glaze = new Brush();
  glaze.radius = 12;
  glaze.flow = 0.35;
  glaze.loadMix(recipeMasses({ 'pv19-magenta': 1 }, 100), { dabs: 80, vehicleRatio: 3 });
  for (let x = 36; x <= 84; x += 5) doc.applyDab(x, 36, glaze, new Map());

  const target = { data: new Uint8ClampedArray(doc.N * 4) };
  renderAll(doc, target);
  let checked = 0;
  let maxDiff = 0;
  for (const idx of [36 * 96 + 24, 36 * 96 + 48, 36 * 96 + 72]) {
    const expected = evaluatePixelColor(doc, idx);
    const p = idx * 4;
    maxDiff = Math.max(
      maxDiff,
      Math.abs(target.data[p] - expected.r),
      Math.abs(target.data[p + 1] - expected.g),
      Math.abs(target.data[p + 2] - expected.b)
    );
    assert.equal(target.data[p], expected.r);
    assert.equal(target.data[p + 1], expected.g);
    assert.equal(target.data[p + 2], expected.b);
    checked++;
  }
  assert.equal(checked, 3);
  assert.equal(maxDiff, 0);

  const overlap = 36 * 96 + 48;
  const color = evaluatePixelColor(doc, overlap);
  assert.ok(/^#[0-9a-f]{6}$/.test(color.hex));
});
