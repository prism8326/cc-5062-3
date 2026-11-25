# 色料 KM 绘画原型

显式色料质量、光谱/Kubelka–Munk 光学与浏览器绘画窗口连接的实验原型。屏幕 RGB 只由光谱经独立显示变换生成，**不把 RGB 平均当作物理混色结论**。

## 图形入口（主要使用方式）

```bash
npm install
npm start
```

浏览器打开 <http://localhost:8123>。

图形界面入口：

1. 左栏“色料库 / 调色皿 / 画笔”设定配方并蘸笔。
2. 中央“绘画窗口”直接拖动画笔；“晾干成层”后可薄层罩染。
3. 顶栏画布工具组的 **“绘画接点自检”** 会自动混合黄＋青、晾干、品红叠画，并逐像素对照真实 `#view` 画布与内核颜色；异常会显示在状态条、自检面板和画布红框中。
4. 右栏 **“封存试混”** 是可封存湿色样入口：
   - “滴同一滴清水”：比较未封存可溶底层的颜料回取；
   - “封存全部湿样”后再滴水：隔离层应阻止底色被带走；
   - “干燥复算”；
   - 导出明亮 D65 / 昏暗暖光下的色样、光谱和剩余颜料量 JSON/PNG。
5. 右栏“取样比较 / 测试台 / 画布像素”提供色差、厚度梯度、比例条、顺序政策和像素放大。

不要直接双击 `index.html`；ES Module 在 `file://` 下可能被浏览器安全策略拦截。

## 命令行（仅辅助复算）

```bash
npm test
npm run experiments
npm run preview
npm run smoke
```

- `npm test`：Node 测试与内核不变量。
- `npm run experiments`：复算双模型、同色异颜料、封存水洗、质量守恒、互补色/薄层和深色混合，生成：
  - `docs/色料模型实验.md`
  - `tools/out/pigment-model-experiments.json`
  - `tools/out/pigment-reflection-responses.csv`
  - `tools/out/pigment-reflection-responses.svg`
- `npm run preview`：生成旧绘画样例和厚度/比例 PNG。
- `npm run smoke`：真实浏览器端到端冒烟（需要 Playwright 浏览器可用）。

命令行用于测试和证据复算，不替代上述图形绘画入口。

## 文档

- [色料模型实验](./docs/色料模型实验.md)
- [混色表示取舍：待验假设](./docs/混色表示取舍-待验假设.md)

## 模型边界

色料 K/S 曲线是人工构造的原型参数，不是真实品牌颜料实测数据。当前能力限定为漫射二通量 KM、简化光源、湿散射经验系数、无荧光/干涉/金属/颗粒流动动力学。详见待验假设文档。
