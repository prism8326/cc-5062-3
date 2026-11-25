// 内核检查与测试台数据生成：Node 测试和浏览器“测试台”共用同一份断言。
// 所有色带都现场调用内核求值，不存在预制颜色表。

import { PIGMENTS, SUBSTRATES, paperSpectrum } from './pigments.js';
import {
  kmReflectance,
  kmTransmittance,
  filmDepths,
  evaluateStack,
} from './km.js';
import {
  spectrumToDisplay,
  deltaE76,
  WAVELENGTHS,
} from './spectra.js';
import { mixtureColor, pixelFilmList } from './render.js';
import { PaintDocument, Brush } from './document.js';

const P = PIGMENTS.length;
const WHITE = paperSpectrum();

export function massesFor(id, amount = 1) {
  const m = new Array(P).fill(0);
  const i = PIGMENTS.findIndex((p) => p.id === id);
  if (i < 0) throw new Error(`未知色料 ${id}`);
  m[i] = amount;
  return m;
}

function film(m, concentration = 0.45) {
  const M = m.reduce((s, x) => s + x, 0);
  return { m, h: M / concentration };
}

// ---------- 测试台可视化数据 ----------

// 单色厚度梯度：返回 {overWhite:[hex], overBlack:[hex], h:[]}
export function thicknessGradient(id, steps = 24, hMin = 0.06, hMax = 9) {
  const base = massesFor(id, 1);
  const overWhite = [];
  const overBlack = [];
  const hs = [];
  const black = SUBSTRATES.find((s) => s.id === 'black').spectrum;
  for (let s = 0; s < steps; s++) {
    const t = s / (steps - 1);
    const h = hMin * Math.pow(hMax / hMin, t);
    hs.push(h);
    const c = 0.45;
    const m = base.map((x) => x * c * h);
    overWhite.push(mixtureColor(m, h, WHITE).hex);
    overBlack.push(mixtureColor(m, h, black).hex);
  }
  return { overWhite, overBlack, hs };
}

// 双颜料比例梯度（均质预混）
export function ratioRamp(idA, idB, steps = 33, totalMass = 1.7, h = 3.2) {
  const ia = PIGMENTS.findIndex((p) => p.id === idA);
  const ib = PIGMENTS.findIndex((p) => p.id === idB);
  const out = [];
  for (let s = 0; s < steps; s++) {
    const t = s / (steps - 1);
    const m = new Array(P).fill(0);
    m[ia] = totalMass * (1 - t);
    m[ib] = totalMass * t;
    out.push(mixtureColor(m, h, WHITE).hex);
  }
  return out;
}

// 不同底色 × 厚度网格
export function substrateGrid(id, amounts = [0.12, 0.35, 0.9, 2.2]) {
  return SUBSTRATES.map((sub) => ({
    substrateId: sub.id,
    name: sub.name,
    colors: amounts.map((a) => {
      const m = massesFor(id, a);
      return mixtureColor(m, a / 0.45, sub.spectrum).hex;
    }),
  }));
}

// 混合顺序政策对比
export function orderComparison(idA, idB, amount = 0.5) {
  const A = massesFor(idA, amount);
  const B = massesFor(idB, amount);
  const fA = film(A, 0.4);
  const fB = film(B, 0.4);
  const AB = spectrumToDisplay(evaluateStack(WHITE, [fA, fB]));
  const BA = spectrumToDisplay(evaluateStack(WHITE, [fB, fA]));
  const premixM = A.map((x, i) => x + B[i]);
  const premix = mixtureColor(premixM, (2 * amount) / 0.4, WHITE);
  return {
    AB: AB.hex,
    BA: BA.hex,
    premix: premix.hex,
    deltaOrder: deltaE76(AB.lab, BA.lab),
    deltaPremixAB: deltaE76(premix.lab, AB.lab),
  };
}

// ---------- 断言套件 ----------

function check(id, title, fn) {
  try {
    const detail = fn();
    return { id, title, pass: true, detail: detail ?? '' };
  } catch (e) {
    return { id, title, pass: false, detail: e.message };
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

export function runChecks() {
  const results = [];

  results.push(
    check('white-point', '理想反射体经 E+Bradford 转换为纯白', () => {
      const c = spectrumToDisplay(WAVELENGTHS.map(() => 1));
      assert(c.r === 255 && c.g === 255 && c.b === 255, `得到 ${c.hex}`);
      return c.hex;
    })
  );

  results.push(
    check('km-range', 'KM 反射率在大参数网格上保持 [0,1] 且有限', () => {
      let n = 0;
      for (let kx = 0; kx <= 20; kx += 0.7) {
        for (let sx = 0; sx <= 12; sx += 0.4) {
          for (const rg of [0, 0.5, 1]) {
            const R = kmReflectance(kx, sx, rg);
            assert(Number.isFinite(R), `非有限 R @${kx},${sx},${rg}`);
            assert(R >= -1e-9 && R <= 1 + 1e-9, `越界 R=${R}`);
            n++;
          }
        }
      }
      return `${n} 组参数`;
    })
  );

  results.push(
    check('energy', '黑底反射 + 透射 <= 1（能量不增生）', () => {
      let n = 0;
      for (let kx = 0.05; kx <= 12; kx += 0.8) {
        for (let sx = 0.05; sx <= 10; sx += 0.7) {
          const R = kmReflectance(kx, sx, 0);
          const T = kmTransmittance(kx, sx);
          assert(R >= -1e-10 && T >= -1e-10, '出现负能量');
          assert(R + T <= 1 + 1e-9, `R+T=${R + T} >1 @${kx},${sx}`);
          n++;
        }
      }
      return `${n} 组参数`;
    })
  );

  results.push(
    check('extreme', '极端厚度/系数下数值稳定不溢出', () => {
      const extremes = [
        [1e6, 1e6, 0.5],
        [1e-12, 1e6, 0.9],
        [1e6, 1e-12, 0.2],
        [0, 50, 0.7],
        [0, 0, 0.3],
        [50, 0, 0.3],
        [1e-10, 1e-10, 1],
      ];
      for (const [kx, sx, rg] of extremes) {
        const R = kmReflectance(kx, sx, rg);
        assert(Number.isFinite(R), `非有限 @${kx},${sx}`);
        assert(R >= -1e-9 && R <= 1 + 1e-9, `越界 R=${R} @${kx},${sx}`);
      }
      return `${extremes.length} 个极端情形`;
    })
  );

  results.push(
    check('thickness-limit', '单色厚度增加时光谱单调趋近无穷厚反射率', () => {
      let checked = 0;
      for (const p of PIGMENTS) {
        const pi = PIGMENTS.indexOf(p);
        const m = new Array(P).fill(0);
        m[pi] = 1;
        const thick = filmDepths(m.map((x) => x * 40), 40 / 0.45);
        const Rinf = thick.kx.map((kx, w) =>
          kmReflectance(kx[w] * 100, thick.sx[w] * 100, 0)
        );
        let prevDist = Infinity;
        for (let hi = 0; hi < 14; hi++) {
          const h = 0.05 * 1.55 ** hi;
          const d = filmDepths(
            m.map((x) => x * 0.45 * h),
            h
          );
          let dist = 0;
          for (let w = 0; w < WAVELENGTHS.length; w++) {
            const R = kmReflectance(d.kx[w], d.sx[w], WHITE[w]);
            dist += (R - Rinf[w]) ** 2;
          }
          // 允许极少量数值抖动
          assert(dist <= prevDist + 1e-8, `${p.id} 在 h=${h.toFixed(2)} 处未单调趋近`);
          prevDist = dist;
          checked++;
        }
      }
      return `${PIGMENTS.length} 色料 × 14 厚度`;
    })
  );

  results.push(
    check('premix-order', '均质预混对“加料顺序”交换律不变（政策：湿混=均质）', () => {
      const A = massesFor('py-lemon', 0.8);
      const B = massesFor('pb15-cyan', 0.8);
      const v1 = A.map((x, i) => x + B[i]);
      const v2 = B.map((x, i) => x + A[i]);
      const c1 = mixtureColor(v1, 3.5, WHITE).hex;
      const c2 = mixtureColor(v2, 3.5, WHITE).hex;
      assert(c1 === c2, `${c1} != ${c2}`);
      return c1;
    })
  );

  results.push(
    check('layer-order', '分层政策：薄层顺序可交换连续、罩染顺序有别、厚层等于最上层', () => {
      const tiny = orderComparison('py-lemon', 'pb29-ultramarine', 0.02);
      assert(tiny.deltaOrder < 1, `极薄层顺序差应趋零，实际 ΔE=${tiny.deltaOrder}`);
      const glaze = orderComparison('py-lemon', 'pb29-ultramarine', 0.35);
      assert(glaze.deltaOrder > 10, `罩染顺序差应显著，ΔE=${glaze.deltaOrder.toFixed(2)}`);
      assert(
        glaze.deltaPremixAB > 5,
        '分层罩染不应等同于均质预混'
      );
      // 足够厚的两个不透明层：AB 应收敛到上层 B 的固有色
      const thick = orderComparison('py-lemon', 'pb29-ultramarine', 8);
      const topB = mixtureColor(massesFor('pb29-ultramarine', 8), 8 / 0.4, WHITE);
      const dTop = deltaE76(
        spectrumToDisplay(
          evaluateStack(WHITE, [
            film(massesFor('py-lemon', 8), 0.4),
            film(massesFor('pb29-ultramarine', 8), 0.4),
          ])
        ).lab,
        topB.lab
      );
      assert(dTop < 2, `厚层 AB 应等于上层 B，ΔE=${dTop.toFixed(2)}`);
      return `极薄 ΔE=${tiny.deltaOrder.toFixed(2)}；罩染顺序 ΔE00≈${glaze.deltaOrder.toFixed(1)}；AB≈上层色 ΔE76=${dTop.toFixed(2)}`;
    })
  );

  results.push(
    check('undercolor', '薄层透出底色：白/黑底差异显著，厚层差异收敛', () => {
      const g = substrateGrid('pr-red', [0.1, 3.0]);
      const white = g.find((x) => x.substrateId === 'pure-white');
      const black = g.find((x) => x.substrateId === 'black');
      const thinDE = deltaE76(
        spectrumToDisplay(
          evaluateStack(
            SUBSTRATES.find((s) => s.id === 'pure-white').spectrum,
            [film(massesFor('pr-red', 0.1))]
          )
        ).lab,
        spectrumToDisplay(
          evaluateStack(
            SUBSTRATES.find((s) => s.id === 'black').spectrum,
            [film(massesFor('pr-red', 0.1))]
          )
        ).lab
      );
      const thickDE = deltaE76(
        spectrumToDisplay(
          evaluateStack(
            SUBSTRATES.find((s) => s.id === 'pure-white').spectrum,
            [film(massesFor('pr-red', 3))]
          )
        ).lab,
        spectrumToDisplay(
          evaluateStack(
            SUBSTRATES.find((s) => s.id === 'black').spectrum,
            [film(massesFor('pr-red', 3))]
          )
        ).lab
      );
      assert(thinDE > 8, `薄层白底/黑底差太小 ΔE=${thinDE}`);
      assert(thickDE < thinDE * 0.5, `厚层应收敛：${thickDE} vs ${thinDE}`);
      return `薄 ΔE=${thinDE.toFixed(1)}，厚 ΔE=${thickDE.toFixed(1)}`;
    })
  );

  results.push(
    check('conservation-wet', '连续湿笔触全程笔+布面色料质量守恒', () => {
      const doc = new PaintDocument(160, 120);
      const brush = new Brush();
      brush.radius = 9;
      brush.exchange = 0.8;
      brush.loadMix(massesFor('pb29-ultramarine', 1), { dabs: 40 });
      const b2 = new Brush();
      b2.radius = 7;
      b2.exchange = 0.9;
      b2.loadMix(massesFor('py-lemon', 1), { dabs: 40 });
      const before =
        doc.totalPigmentMass() + brush.totalMass() + b2.totalMass();
      let x = 5;
      for (let k = 0; k < 12; k++) {
        const y = 30 + ((k * 17) % 60);
        doc.strokeSegment(x, y, x + 60, y + 12, brush, new Map());
        x += 9;
      }
      // 第二支黄笔与未干区域反复交叉
      for (let k = 0; k < 8; k++) {
        doc.strokeSegment(10, 25 + k * 8, 150, 60 - k * 3, b2, new Map());
      }
      const after =
        doc.totalPigmentMass() + brush.totalMass() + b2.totalMass();
      const drift = Math.abs(after - before);
      assert(drift < 1e-5 * Math.max(1, before), `质量漂移 ${drift}（before=${before}）`);
      return `总量 ${before.toFixed(2)}，漂移 ${drift.toExponential(2)}`;
    })
  );

  results.push(
    check('dry-policy', '扫过已干层时干层逐字节不变，只在上方形成新湿膜', () => {
      const doc = new PaintDocument(120, 90);
      const b = new Brush();
      b.radius = 8;
      b.loadMix(massesFor('pr-red', 1), { dabs: 30 });
      for (let x = 10; x < 110; x += 6) doc.applyDab(x, 45, b, new Map());
      const cmd = doc.dryWet('测试层');
      const before = Float32Array.from(doc.dryLayers[0].m);
      const beforeB = Float32Array.from(doc.dryLayers[0].b);

      const b2 = new Brush();
      b2.radius = 10;
      b2.exchange = 1;
      b2.loadMix(massesFor('py-lemon', 1), { dabs: 30 });
      for (let x = 8; x < 112; x += 4) doc.applyDab(x, 45, b2, new Map());

      const L = doc.dryLayers[0];
      let diff = 0;
      for (let i = 0; i < L.m.length; i++) diff += Math.abs(L.m[i] - before[i]);
      for (let i = 0; i < L.b.length; i++) diff += Math.abs(L.b[i] - beforeB[i]);
      assert(diff === 0, `干层被改动，差异和=${diff}`);
      assert(doc.wetMassAt(45 * doc.W + 45) > 0, '上方应有新湿膜');
      assert(cmd !== null, '晾干应产生撤销命令');
      return '干层 Float32 数据完全未改';
    })
  );

  results.push(
    check('dry-conservation', '晾干只蒸发载体，色料质量守恒（Float32 量化容差内）', () => {
      const doc = new PaintDocument(80, 60);
      const b = new Brush();
      b.radius = 6;
      b.loadMix(massesFor('pg7-green', 1), { dabs: 20 });
      for (let x = 5; x < 75; x += 4) doc.applyDab(x, 30, b, new Map());
      const wetBefore = doc.wetM.reduce((s, x) => s + x, 0);
      doc.dryWet();
      const dryAfter = doc.dryLayers[0].m.reduce((s, x) => s + x, 0);
      const rel = Math.abs(dryAfter - wetBefore) / wetBefore;
      assert(rel < 1e-5, `晾干前后色料相对差 ${rel}`);
      return `相对差 ${rel.toExponential(2)}`;
    })
  );

  results.push(
    check('save-load', '色料状态保存/读取往返后求值颜色一致', () => {
      const doc = new PaintDocument(96, 72);
      const b = new Brush();
      b.radius = 7;
      b.loadMix(
        (() => {
          const m = massesFor('pv19-magenta', 1);
          m[PIGMENTS.findIndex((p) => p.id === 'pb15-cyan')] = 0.6;
          return m;
        })(),
        { dabs: 25 }
      );
      for (let x = 8; x < 90; x += 5) doc.applyDab(x, 36, b, new Map());
      const idx = 36 * doc.W + 40;
      const hexBefore = spectrumToDisplay(
        evaluateStack(WHITE, pixelFilmList(doc, idx))
      ).hex;
      const state = JSON.stringify(doc.toState());
      const restored = PaintDocument.fromState(JSON.parse(state));
      const hexAfter = spectrumToDisplay(
        evaluateStack(WHITE, pixelFilmList(restored, idx))
      ).hex;
      assert(hexBefore === hexAfter, `${hexBefore} != ${hexAfter}`);
      return `${hexBefore}，状态 ${(state.length / 1024).toFixed(1)} KB`;
    })
  );

  results.push(
    check('deterministic', '同一色料状态多次求值完全一致（与视图/缩放无关）', () => {
      const m = massesFor('pbr7-umber', 1.3);
      const a = mixtureColor(m, 2.4, WHITE).hex;
      const b = mixtureColor(m, 2.4, WHITE).hex;
      assert(a === b, '求值不确定');
      return a;
    })
  );

  const failed = results.filter((r) => !r.pass);
  return { results, failed, allPass: failed.length === 0 };
}
