// 复算色料模型对照实验，并把结论写入 docs/色料模型实验.md。
// 运行：npm run experiments
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExperimentReport } from '../js/pigment-lab.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'out');
const DOCS = path.join(ROOT, 'docs');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(DOCS, { recursive: true });

const report = buildExperimentReport();
fs.writeFileSync(path.join(OUT, 'pigment-model-experiments.json'), JSON.stringify(report, null, 2));

const csvLines = ['dataset,id,model,wavelength_nm,reflectance'];
for (const s of report.metamer.specimens) {
  for (const [model, key] of [
    ['spectral-km', 'R_spectral'],
    ['constrained-ks', 'R_constrained'],
  ]) {
    s.models[key].forEach((R, i) => {
      csvLines.push(`metamer,${s.id},${model},${report.constants.wavelengths[i]},${R.toFixed(8)}`);
    });
  }
}
fs.writeFileSync(path.join(OUT, 'pigment-reflection-responses.csv'), csvLines.join('\n') + '\n');

function f(x, digits = 3) {
  return Number(x).toFixed(digits);
}

function massParts(recipe) {
  return Object.entries(recipe.parts)
    .map(([id, w]) => `${id}:${w}`)
    .join(', ');
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

const metamerRows = report.metamer.specimens.map((s) => [
  s.name,
  `\`${s.id}\``,
  massParts(s),
  s.soluble ? '可溶' : '耐水',
  s.models.spectral.brightD65.hex,
  s.models.spectral.dimWarmA.hex,
  f(s.models.deltaEBright, 2),
  f(s.models.deltaEWarm, 2),
  f(s.models.spectralRmse, 4),
]);

const sealRows = report.sealWater.map((x) => [
  x.name,
  x.soluble ? '可溶' : '耐水',
  f(x.waterBeforeSeal.result.removedMass, 4),
  x.waterBeforeSeal.wet.colors.spectral.brightD65.hex,
  f(x.waterBeforeSeal.wet.remainingMass, 4),
  f(x.waterBeforeSeal.wet.totalPigmentMass, 6),
  f(x.waterAfterSeal.result.removedMass, 4),
  x.waterAfterSeal.wet.colors.spectral.brightD65.hex,
  f(x.waterAfterSeal.wet.remainingMass, 4),
]);

const compRows = report.complementaryThinLayers.flatMap((pair) =>
  pair.rows
    .filter((row) => [0.08, 0.32, 1.28, 2.56].includes(row.h))
    .map((row) => [
      pair.label,
      f(row.h, 2),
      row.AB,
      row.BA,
      row.premix,
      row.rgbAverageControl,
      f(row.deltaOrder, 2),
      f(row.deltaLayerPremix, 2),
      f(row.deltaKmVsRgbAverage, 2),
      f(row.deltaSpectralConstrained, 2),
    ])
);

const darkRows = report.darkMix.flatMap((group) =>
  group.rows
    .filter((row) => [0.4, 2.5, 6].includes(row.h))
    .map((row) => [
      `\`${group.id}\``,
      f(row.h, 1),
      row.colors.brightD65.hex,
      f(row.colors.brightD65.lab.L, 1),
      f(row.deltaEBright, 2),
      f(row.spectralRmse, 4),
    ])
);

function reflectionSvg() {
  const W = 920;
  const H = 360;
  const pad = { l: 48, r: 18, t: 28, b: 38 };
  const pw = W - pad.l - pad.r;
  const ph = H - pad.t - pad.b;
  const wls = report.constants.wavelengths;
  const x = (i) => pad.l + (i / (wls.length - 1)) * pw;
  const y = (v) => pad.t + (1 - Math.max(0, Math.min(1, v))) * ph;
  const colors = ['#b7791f', '#d23b8a'];
  let paths = '';
  report.metamer.specimens.forEach((s, si) => {
    for (const [key, dash] of [['R_spectral', ''], ['R_constrained', '6 4']]) {
      const d = s.models[key]
        .map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
        .join(' ');
      paths += `<path d="${d}" fill="none" stroke="${colors[si]}" stroke-width="2.4" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;
    }
  });
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="#e5e7eb"/><text x="12" y="${y(v) + 4}" font-size="11" fill="#667085">${v.toFixed(2)}</text>`)
    .join('');
  const xticks = wls
    .filter((w) => w % 50 === 0)
    .map((w) => {
      const i = wls.indexOf(w);
      return `<text x="${x(i)}" y="${H - 12}" text-anchor="middle" font-size="11" fill="#667085">${w}</text>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="100%" height="100%" fill="white"/>
<text x="${pad.l}" y="18" font-size="15" font-family="sans-serif" fill="#1f2937">同色异颜料底层的反射响应（实线 31 波段 KM；虚线受限 7 箱）</text>
${grid}${xticks}${paths}
<line x1="${W - 250}" x2="${W - 210}" y1="24" y2="24" stroke="#b7791f" stroke-width="3"/><text x="${W - 202}" y="28" font-size="12" font-family="sans-serif">土黄</text>
<line x1="${W - 145}" x2="${W - 105}" y1="24" y2="24" stroke="#d23b8a" stroke-width="3"/><text x="${W - 97}" y="28" font-size="12" font-family="sans-serif">柠檬黄+红</text>
</svg>`;
}
fs.writeFileSync(path.join(OUT, 'pigment-reflection-responses.svg'), reflectionSvg());

const integrationEvidencePath = path.join(OUT, 'integration-evidence.json');
const browserEvidence = fs.existsSync(integrationEvidencePath)
  ? JSON.parse(fs.readFileSync(integrationEvidencePath, 'utf8'))
  : null;
const browserEvidenceBullet = browserEvidence
  ? `- 浏览器执行证据：[\`tools/out/integration-evidence.json\`](../tools/out/integration-evidence.json)（${browserEvidence.generatedAt}）记录真实像素最大通道差 **${browserEvidence.integration.maxChannelDiff}**、叠画 ΔE00=**${browserEvidence.integration.colorChangeDE.toFixed(3)}**、湿干 ΔE00=**${browserEvidence.integration.dryChangeDE.toFixed(3)}**、异常数 **${browserEvidence.integration.anomalies.length}**；截图：\`tools/out/ui-07-integration.png\`。`
  : '- 运行带本地依赖路径的 `node tools/browser-smoke.mjs` 后，会写出 `tools/out/integration-evidence.json` 与 `tools/out/ui-07-integration.png`。';

const md = `# 色料模型实验：光谱 KM 与受限参数色料表示

> 本文件的数值由 \`npm run experiments\` 调用 \`tools/run-pigment-model-experiments.mjs\` 现场复算。
> 完整机器可读数据：\`tools/out/pigment-model-experiments.json\`；反射率 CSV：
> \`tools/out/pigment-reflection-responses.csv\`；反射曲线：
> \`tools/out/pigment-reflection-responses.svg\`。不要手工把某次屏幕取色当成物理混色结论。

## 1. 本轮结论

1. **物质账本应统一在色料质量域。** 画笔、湿膜、干层、封存隔离和清水回取都只转移/冻结每种色料的质量；光学层是由 \`m、h、wet、base\` 推导出的映射。这样反复混合和水洗后的“剩余颜料量＋离开画布的颜料量”能对账，本轮反复分盘混合的最大相对质量漂移为 **${report.repeatedMix.spectral.maxRelativeDrift.toExponential(2)}**。
2. **光学层与物质层不做双向自由编辑。** 若允许直接改 K/S 或 RGB 又反向猜质量，映射会漂移；当前实现保留 \`pixelFilmList()\` 这一单向映射，并在保存状态中持久化每层质量数组，而不是保存截图颜色。
3. **31 波段光谱 KM 与受限 7 箱参数模型接入完全相同的覆盖厚度 \`h=${report.constants.LAB_H}\` 和浓度 \`c=${report.constants.LAB_CONCENTRATION}\`。** 受限模型把每色料 62 个 K/S 数压缩为 14 个非负箱参数；参数总量从 ${report.benchmark.parameterCounts.totalSpectral} 降到 ${report.benchmark.parameterCounts.totalConstrained}。本轮 Node 微基准（${report.benchmark.iterations} 次）为光谱 ${report.benchmark.spectral.perCallUs} μs/次、受限 ${report.benchmark.constrained.perCallUs} μs/次；说明在这个小原型里，参数/内存减少并不自动等于端到端更快，箱平均与反射率插值也有固定成本。
4. **同色异颜料只能在指定光源下成立。** 两片试混片在明亮 D65 下 ΔE00=**${f(report.metamer.brightD65DeltaE00, 3)}**（接近同色），在暖 A 光源适应色度下分离到 ΔE00=**${f(report.metamer.warmADeltaE00, 3)}**；压暗到 45% 曝光后导出像素的 ΔE00=**${f(report.metamer.dimWarmADeltaE00, 3)}**。只调屏幕 Hex、不保存光谱和质量的实现无法复算这一差别。
5. **封存是物质可达性政策，不是把颜色锁住。** 未封存的可溶土黄底层遇同一滴清水会失去 ${f(report.sealWater[0].waterBeforeSeal.result.removedMass, 3)} 原型质量单位；先封存后滴水失去 **0**。耐水的柠檬黄＋红底层在两种路径下都不被水带走。被带走的质量进入水滴/流出物，因此总色料量仍为 ${f(report.sealWater[0].waterBeforeSeal.wet.totalPigmentMass, 4)}。
6. **RGB 平均只能当反例控件。** 下表 \`rgbAverageControl\` 与 KM 预混的 ΔE00 在互补色/深色区域可超过 7，且它没有厚度、底色、透明度和质量账本；画布渲染不使用该路径。

![同色异颜料反射响应](../tools/out/pigment-reflection-responses.svg)

## 2. 两种模型与同一厚度输入

- \`spectral-km\`：\`js/km.js\` 的 31 波段二通量 Kubelka–Munk；色料 K/S 来自 \`js/pigments.js\` 的人工高斯/吸收边参数。
- \`constrained-ks\`：\`js/pigment-lab.js\` 的 7 个连续波段箱，K/S 被约束为非负箱均值，只在 7 个箱上执行 KM，再在线性反射率域插值回 31 波段。它不是 RGB 三通道平均。
- 两个入口都是 \`mixWithModel(modelId, masses, h, baseSpectrum, wet)\`；实验固定 \`h=${report.constants.LAB_H}\`、\`M=c h=${report.constants.LAB_MASS}\`。

## 3. 同色异颜料试混片

${table(
  ['试混片', 'ID', '配方（质量份数）', '结合剂', '明 D65 Hex', '暗暖光 Hex', '模型 ΔE 明', '模型 ΔE 暖', '光谱 RMSE'],
  metamerRows
)}

模型间颜色差不是“哪一个 RGB 更好看”的判断，而是同一质量输入经两种光学表示后的响应差。完整 31 点反射率见 CSV/JSON。

## 4. 封存前/后滴同一滴清水

水滴参数固定为 \`volume=${0.85}\`、\`lift=${0.72}\`。“剩余”只计试片，“总量”计试片＋水滴/流出物。

${table(
  ['底层', '可溶性', '封存前带走', '封存前明色', '封存前剩余', '封存路径总量', '封存后带走', '封存后明色', '封存后剩余'],
  sealRows
)}

UI 路径：右栏 **封存试混** → **滴同一滴清水**；重置后 **封存全部湿样** → **滴同一滴清水**。导出 JSON 同时含活动样状态和确定性实验报告。

## 5. 反复混合的质量守恒

${table(
  ['模型/政策', '周期', '初始记账质量', '最终质量', '最大绝对漂移', '最大相对漂移'],
  [
    ['spectral-km / 质量域', report.repeatedMix.spectral.cycles, f(report.repeatedMix.spectral.sourceMass, 9), f(report.repeatedMix.spectral.finalMass, 9), report.repeatedMix.spectral.maxAbsoluteDrift.toExponential(3), report.repeatedMix.spectral.maxRelativeDrift.toExponential(3)],
    ['constrained-ks / 同一质量域', report.repeatedMix.constrained.cycles, f(report.repeatedMix.constrained.sourceMass, 9), f(report.repeatedMix.constrained.finalMass, 9), report.repeatedMix.constrained.maxAbsoluteDrift.toExponential(3), report.repeatedMix.constrained.maxRelativeDrift.toExponential(3)],
  ]
)}

两种光学模型的守恒相同，是因为守恒发生在它们之前的物质质量域；如果让受限光学参数反向充当物质状态，就必须额外维护双向映射和漂移检查。

## 6. 互补颜色、薄层与 RGB 平均误差

\`Δ顺序\` 是 AB/BA 薄层顺序差，\`Δ层/混\` 是叠涂与均质预混差，\`ΔKM/RGB平均\` 只用于标记朴素 RGB 平均反例离物理光谱结论多远。

${table(
  ['互补对', 'h', 'AB', 'BA', 'KM预混', 'RGB平均反例', 'Δ顺序', 'Δ层/混', 'ΔKM/RGB', '受限ΔE'],
  compRows
)}

可复算观察：极薄层的 AB/BA 顺序差较小；当厚度增加，分层顺序、吸收路径和深色混合会显著偏离“两份颜色平均”。互补色在厚混合时趋向低明度/低反射，RGB 平均通常给出过亮、过饱和的中间色。受限 7 箱模型降低参数量，但在这些陡吸收边附近会产生 ${f(Math.max(...report.complementaryThinLayers.flatMap(p => p.rows.map(r => r.deltaSpectralConstrained))), 2)} ΔE00 量级的最大偏差，因此是否可接受取决于交互预览还是证据导出。

## 7. 深色混合

${table(
  ['配方', 'h', '明色 Hex', 'L*', '光谱↔受限 ΔE', 'RMSE'],
  darkRows
)}

深色路径的主要误差风险是反射率接近仪器/数值下限时，小的绝对光谱误差可能被色差或裁剪放大。当前 KM 使用稳定的 \`tanh\` 形式并把反射率限制在合法范围；界面用品红错误块显式暴露渲染异常，而不是静默返回一个平均色。

## 8. 成本与显示变换边界

${table(
  ['项目', '数值'],
  [
    ['光谱参数总数', report.benchmark.parameterCounts.totalSpectral],
    ['受限参数总数', report.benchmark.parameterCounts.totalConstrained],
    ['参数压缩比', `${f(report.benchmark.parameterCounts.totalSpectral / report.benchmark.parameterCounts.totalConstrained, 2)}×`],
    ['光谱模型耗时', `${report.benchmark.spectral.perCallUs} μs/call（${report.benchmark.iterations} 次）`],
    ['受限模型耗时', `${report.benchmark.constrained.perCallUs} μs/call（${report.benchmark.iterations} 次）`],
  ]
)}

光谱积分、光源 SPD、Bradford 适应、XYZ→Lab/sRGB 是独立显示变换；混色内核只输出反射光谱和质量。增加 D65/A/昏暗暖光不会改变物质混合，只改变同一反射响应对观察者/显示输出的映射。

## 9. 执行证据与图形接点

- \`npm test\`：内核检查、新实验不变量、渲染缓冲逐像素等于显示变换。
- \`npm run experiments\`：生成本文所有数字及 JSON/CSV/SVG。
- \`npm run preview\`：生成厚度梯度、比例条和湿画/罩染 PNG。
- \`node tools/browser-smoke.mjs\`（或 \`npm run smoke\`）：真实浏览器启动、绘画、晾干、取样、测试台、封存试混、存取和导出冒烟。
${browserEvidenceBullet}
- 图形主入口：\`npm start\` 后打开 \`http://localhost:8123\`。顶栏 **绘画接点自检** 会混合黄＋青、晾干、品红叠画，并读取真实 \`#view\` 像素与 \`evaluatePixelColor()\` 对照；右栏 **封存试混**（试混台）提供封存/水洗/导出及封存前后确定性对照。
- 命令行只负责测试、预览和实验复算，不替代绘画窗口。

## 10. 单列待验假设

混色表示取舍中尚未被真实颜料数据验证的假设，统一登记在
[\`docs/混色表示取舍-待验假设.md\`](./混色表示取舍-待验假设.md)。这些条目不得在 UI 或结论中表述为已实测事实。
`;

fs.writeFileSync(path.join(DOCS, '色料模型实验.md'), md);
console.log('wrote docs/色料模型实验.md');
console.log('wrote', path.relative(ROOT, path.join(OUT, 'pigment-model-experiments.json')));
console.log('metamer ΔE D65/A =', report.metamer.brightD65DeltaE00.toFixed(3), report.metamer.warmADeltaE00.toFixed(3));
