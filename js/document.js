// 绘画文档与画笔：笔上颜料和布面质量分开核算。
//
// 裁决政策（v1，明确且可测）：
//  1. 笔触接触到“湿膜”像素：先走颜料交换（湿色可被回取到笔上，
//     染色度越高越难回取），再把笔上颜料沉积进同一湿膜，像素内均质混合。
//     该过程只在 笔 <-> 湿膜 之间转移质量，全局色料守恒。
//  2. 笔触接触到“已干层”：v1 不回取、不交换干色（干层质量不变），
//     新颜料作为其上方的新湿膜沉积；最终由 KM 分层光学叠加表现覆盖与底色透出。
//  3. 同时存在湿膜与干层时：只与顶层湿膜交换，干层保持不变并参与下方光学叠置。
//  4. 晾干：湿膜整体转为一个有序干层（色料质量不变；载体仅留存黏合剂固体份）。

import { PIGMENTS, PIGMENT_SET_ID } from './pigments.js';
import { BINDER_SOLID_FRACTION, EPS_MASS } from './km.js';
import { f32ToBase64, base64ToF32, f64ToBase64AsF32 } from './codec.js';
import { health } from './health.js';

export const DOC_W = 400;
export const DOC_H = 300;
const P = PIGMENTS.length;

// 单个 dab 在 g=1 处希望沉积的色料质量（原型单位）。
// 一次连续走笔在中心线上会叠加约 3.5 个印模，故 0.3 左右可堆到接近不透明。
export const STAMP_CENTER_MASS = 0.3;

export class Brush {
  constructor() {
    this.m = new Float64Array(P); // 笔上每种色料的质量（与布面质量分账）
    this.v = 0; // 笔上载体（水+调和剂）质量/体积
    this.radius = 7; // 模拟像素半径
    this.flow = 1; // 沉积量倍率
    this.exchange = 0.55; // 湿画交换强度 0..1
    this.loadedDabs = 180; // 本次蘸取预计支撑的 dab 数（决定载量）
  }

  totalMass() {
    let t = 0;
    for (const x of this.m) t += x;
    return t;
  }

  concentration() {
    const M = this.totalMass();
    const h = M + this.v;
    return h > EPS_MASS ? M / h : 0;
  }

  // 按配方份数蘸取；载量按笔面积与目标 dab 数标定，保证走笔前期色度稳定。
  loadMix(parts, opts = {}) {
    const dabs = opts.dabs ?? this.loadedDabs;
    const vehicleRatio = opts.vehicleRatio ?? 1.8; // v / M
    const area = Math.PI * this.radius * this.radius;
    let sum = 0;
    for (const x of parts) sum += Math.max(0, x);
    this.m.fill(0);
    if (sum <= 0) {
      this.v = 0;
      return;
    }
    // 印模 g 在圆盘上的均值约 0.4，故 sumAll ≈ 0.4*area
    const totalMass = dabs * STAMP_CENTER_MASS * 0.4 * area;
    for (let i = 0; i < P; i++) {
      this.m[i] = totalMass * (Math.max(0, parts[i] || 0) / sum);
    }
    this.v = totalMass * vehicleRatio;
    this.loadedDabs = dabs;
  }

  // 直接把若干“份”某色料加到笔上（调色后补色用）
  addPigment(index, units = 1, massPerUnit = 1.2) {
    this.m[index] += units * massPerUnit;
    this.v += units * massPerUnit * 1.4;
  }

  clean() {
    this.m.fill(0);
    this.v = 0;
  }

  toJSON() {
    return {
      m: Array.from(this.m),
      v: this.v,
      radius: this.radius,
      flow: this.flow,
      exchange: this.exchange,
      loadedDabs: this.loadedDabs,
    };
  }

  static fromJSON(o) {
    const b = new Brush();
    if (o) {
      o.m?.forEach((x, i) => {
        if (i < P) b.m[i] = Number(x) || 0;
      });
      b.v = Number(o.v) || 0;
      b.radius = Number(o.radius) || b.radius;
      b.flow = Number(o.flow) ?? b.flow;
      b.exchange = Number(o.exchange) ?? b.exchange;
      b.loadedDabs = Number(o.loadedDabs) || b.loadedDabs;
    }
    return b;
  }
}

export class PaintDocument {
  constructor(w = DOC_W, h = DOC_H) {
    this.W = w;
    this.H = h;
    this.N = w * h;
    this.P = P;
    this.pigmentSet = PIGMENT_SET_ID;
    this.wetM = new Float64Array(this.N * P); // 交错存储 [idx*P+i]
    this.wetV = new Float64Array(this.N);
    this.dryLayers = []; // 自下而上；{id,name,m:Float32Array(N*P),b:Float32Array(N)}
    this.seq = 0;
  }

  index(x, y) {
    return y * this.W + x;
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.W && y < this.H;
  }

  wetMassAt(idx) {
    let t = 0;
    const o = idx * P;
    for (let i = 0; i < P; i++) t += this.wetM[o + i];
    return t;
  }

  // 像素的完整色料分层信息（取样检查器用）
  pixelInfo(idx) {
    const o = idx * P;
    const wetM = [];
    let wetTotal = 0;
    for (let i = 0; i < P; i++) {
      wetM.push(this.wetM[o + i]);
      wetTotal += this.wetM[o + i];
    }
    const wetV = this.wetV[idx];
    const layers = this.dryLayers.map((L) => {
      const m = [];
      let M = 0;
      for (let i = 0; i < P; i++) {
        const x = L.m[o + i];
        m.push(x);
        M += x;
      }
      const b = L.b[idx];
      return {
        id: L.id,
        name: L.name,
        m,
        binder: b,
        totalMass: M,
        h: M + b,
        concentration: M + b > EPS_MASS ? M / (M + b) : 0,
      };
    });
    return {
      idx,
      x: idx % this.W,
      y: Math.floor(idx / this.W),
      wet:
        wetTotal + wetV > EPS_MASS
          ? {
              m: wetM,
              v: wetV,
              totalMass: wetTotal,
              h: wetTotal + wetV,
              concentration: wetTotal + wetV > EPS_MASS ? wetTotal / (wetTotal + wetV) : 0,
            }
          : null,
      layers,
      totalPigmentMass:
        wetTotal +
        layers.reduce((s, l) => s + l.totalMass, 0),
    };
  }

  // 记录某像素湿状态，供撤销恢复
  snapshotWetPixel(idx) {
    const o = idx * P;
    return {
      idx,
      m: Float64Array.from(this.wetM.subarray(o, o + P)),
      v: this.wetV[idx],
    };
  }

  restoreWetPixel(snap) {
    const o = snap.idx * P;
    this.wetM.set(snap.m, o);
    this.wetV[snap.idx] = snap.v;
  }

  // 在 (cx,cy) 模拟像素坐标处打一个 dab。
  // before: 可选 Map<idx, snapshot>，首次触碰时记录（一笔撤销用）。
  applyDab(cx, cy, brush, before = null) {
    const r = Math.max(0.6, brush.radius);
    const x0 = Math.floor(cx - r),
      x1 = Math.ceil(cx + r);
    const y0 = Math.floor(cy - r),
      y1 = Math.ceil(cy + r);

    const touched = [];
    let sumAll = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx,
          dy = y - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > r) continue;
        const q = 1 - (dist / r) ** 2;
        const g = q > 0 ? q ** 1.5 : 0;
        if (g <= 0) continue;
        sumAll += g;
        if (this.inBounds(x, y)) touched.push({ idx: y * this.W + x, g });
      }
    }
    if (!touched.length || sumAll <= 0) {
      return { cells: [], picked: new Array(P).fill(0), deposited: new Array(P).fill(0) };
    }

    if (before) {
      for (const { idx } of touched) {
        if (!before.has(idx)) before.set(idx, this.snapshotWetPixel(idx));
      }
    }

    const picked = new Float64Array(P);
    let pickedV = 0;

    // —— 阶段 1：湿膜交换/回取（干层不参与） ——
    if (brush.exchange > 0) {
      for (const { idx, g } of touched) {
        const o = idx * P;
        const kappa = Math.min(0.85, brush.exchange * g);
        if (kappa <= 0) continue;
        for (let i = 0; i < P; i++) {
          const cell = this.wetM[o + i];
          if (cell <= EPS_MASS) continue;
          const staining = PIGMENTS[i].staining ?? 0.5;
          const lift = 1 - 0.85 * staining; // 高染色度颜料难回取
          const take = cell * kappa * lift;
          this.wetM[o + i] = cell - take;
          brush.m[i] += take;
          picked[i] += take;
        }
        const wv = this.wetV[idx];
        if (wv > EPS_MASS) {
          const takeV = wv * kappa * 0.9;
          this.wetV[idx] = wv - takeV;
          brush.v += takeV;
          pickedV += takeV;
        }
      }
    }

    // —— 阶段 2：笔 -> 湿膜/新湿膜沉积（固定印模剂量，末段渐淡） ——
    const deposited = new Float64Array(P);
    let depositedV = 0;
    let sumIn = 0;
    for (const t of touched) sumIn += t.g;
    const M = brush.totalMass();
    if (M > EPS_MASS && brush.flow > 0) {
      const desired = STAMP_CENTER_MASS * brush.flow * sumAll;
      const loadScale = Math.min(1, M / (desired * 5 + 1e-12));
      const fracFull = (desired * loadScale) / M; // 全圆盘计划沉积占笔质量比例
      for (const { idx, g } of touched) {
        const o = idx * P;
        const w = g / sumAll; // 含画外权重，边缘自然少沉积
        for (let i = 0; i < P; i++) {
          const give = fracFull * brush.m[i] * w;
          this.wetM[o + i] += give;
          deposited[i] += give;
        }
        const giveV = fracFull * brush.v * w;
        this.wetV[idx] += giveV;
        depositedV += giveV;
      }
      const keep = 1 - fracFull * (sumIn / sumAll);
      for (let i = 0; i < P; i++) brush.m[i] *= keep;
      brush.v *= keep;
    }

    return {
      cells: touched.map((t) => t.idx),
      picked: Array.from(picked),
      deposited: Array.from(deposited),
      pickedV,
      depositedV,
    };
  }

  // 插值连续笔迹：在 p0->p1 之间按固定模拟像素间距补 dab。
  strokeSegment(x0, y0, x1, y1, brush, before) {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const spacing = Math.max(1.2, brush.radius / 3);
    const steps = Math.max(1, Math.ceil(dist / spacing));
    const cells = new Set();
    let picked = new Float64Array(P);
    let deposited = new Float64Array(P);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      const res = this.applyDab(x, y, brush, before);
      for (const c of res.cells) cells.add(c);
      for (let i = 0; i < P; i++) {
        picked[i] += res.picked[i];
        deposited[i] += res.deposited[i];
      }
    }
    return { cells, picked: Array.from(picked), deposited: Array.from(deposited) };
  }

  // 晾干全部湿膜 -> 新的有序干层。返回撤销所需备份。
  dryWet(name) {
    const m = new Float32Array(this.N * P);
    const b = new Float32Array(this.N);
    let any = false;
    for (let idx = 0; idx < this.N; idx++) {
      const o = idx * P;
      let M = 0;
      for (let i = 0; i < P; i++) {
        const v = this.wetM[o + i];
        m[o + i] = v;
        M += v;
      }
      if (M > EPS_MASS || this.wetV[idx] > EPS_MASS) any = true;
      b[idx] = this.wetV[idx] * BINDER_SOLID_FRACTION;
    }
    if (!any) return null;
    const wetMBackup = Float64Array.from(this.wetM);
    const wetVBackup = Float64Array.from(this.wetV);
    const layer = {
      id: `layer-${++this.seq}-${Date.now().toString(36)}`,
      name: name || `色层 ${this.dryLayers.length + 1}`,
      m,
      b,
    };
    this.dryLayers.push(layer);
    this.wetM.fill(0);
    this.wetV.fill(0);
    return { type: 'dry', layer, wetMBackup, wetVBackup };
  }

  undoDry(command) {
    const li = this.dryLayers.indexOf(command.layer);
    if (li >= 0) this.dryLayers.splice(li, 1);
    this.wetM.set(command.wetMBackup);
    this.wetV.set(command.wetVBackup);
  }

  clear() {
    const backup = {
      wetM: Float64Array.from(this.wetM),
      wetV: Float64Array.from(this.wetV),
      layers: this.dryLayers.slice(),
    };
    this.wetM.fill(0);
    this.wetV.fill(0);
    this.dryLayers.length = 0;
    return backup;
  }

  restoreClear(backup) {
    this.wetM.set(backup.wetM);
    this.wetV.set(backup.wetV);
    this.dryLayers = backup.layers.slice();
  }

  totalPigmentMass() {
    let t = 0;
    for (const x of this.wetM) t += x;
    for (const L of this.dryLayers) for (const x of L.m) t += x;
    return t;
  }

  // —— 保存/读取“色料状态”（不是截图） ——
  toState() {
    return {
      app: 'pigment-km-studio',
      format: 1,
      pigmentSet: this.pigmentSet,
      W: this.W,
      H: this.H,
      wetM: f64ToBase64AsF32(this.wetM),
      wetV: f64ToBase64AsF32(this.wetV),
      layers: this.dryLayers.map((L) => ({
        id: L.id,
        name: L.name,
        m: f32ToBase64(L.m),
        b: f32ToBase64(L.b),
      })),
      seq: this.seq,
    };
  }

  static fromState(obj) {
    if (!obj || obj.app !== 'pigment-km-studio') {
      throw new Error('不是本原型保存的色料状态文件');
    }
    if (obj.pigmentSet !== PIGMENT_SET_ID) {
      health.report('load', '色料参数集版本不一致', {
        file: obj.pigmentSet,
        current: PIGMENT_SET_ID,
      });
      throw new Error(
        `色料参数集不兼容：文件为 ${obj.pigmentSet}，当前为 ${PIGMENT_SET_ID}`
      );
    }
    const doc = new PaintDocument(obj.W, obj.H);
    const wetM = base64ToF32(obj.wetM);
    const wetV = base64ToF32(obj.wetV);
    if (wetM.length !== doc.N * P || wetV.length !== doc.N) {
      throw new Error('状态文件尺寸与当前色料通道数不匹配');
    }
    doc.wetM.set(wetM);
    doc.wetV.set(wetV);
    doc.dryLayers = (obj.layers || []).map((L) => {
      const m = base64ToF32(L.m);
      const b = base64ToF32(L.b);
      if (m.length !== doc.N * P || b.length !== doc.N) {
        throw new Error(`色层 ${L.name} 数据尺寸不匹配`);
      }
      return { id: L.id, name: L.name, m, b };
    });
    doc.seq = obj.seq || doc.dryLayers.length;
    return doc;
  }
}
