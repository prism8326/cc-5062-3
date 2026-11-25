// 端到端浏览器冒烟：真实打开页面并操作。node tools/browser-smoke.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const PORT = 8137;
const server = spawn('node', [path.join(ROOT, 'tools/serve.mjs'), String(PORT)], {
  cwd: ROOT,
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const failures = [];
function assert(cond, msg) {
  if (cond) console.log('PASS', msg);
  else {
    failures.push(msg);
    console.error('FAIL', msg);
  }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const consoleErrors = [];
const consoleWarnings = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
  if (m.type() === 'warning') consoleWarnings.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
page.on('dialog', (d) => d.accept());

try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  // 说明弹窗
  await page.screenshot({ path: path.join(OUT, 'ui-01-help.png') });
  await page.click('#btn-help-close');
  await page.waitForFunction(() => document.querySelector('#help-modal').hidden, null, { timeout: 5000 });
  assert(await page.locator('#help-modal').isHidden(), '说明弹窗可关闭');

  // 内核检查应在启动时自动跑完（列表在非活动标签页中，只需挂载）
  await page.waitForSelector('#checks-list li', { state: 'attached' });
  const checkCount = await page.locator('#checks-list li').count();
  const failCount = await page.locator('#checks-list li.fail').count();
  assert(checkCount >= 13 && failCount === 0, `启动自动检查 ${checkCount} 项，失败 ${failCount}`);

  // 调群青并蘸笔
  await page.locator('.pigment-row:has-text("群青") [data-act=plus]').click();
  await page.locator('.pigment-row:has-text("群青") [data-act=plus]').click();
  await page.click('#btn-dip');
  const massText = await page.textContent('#brush-mass');
  assert(!massText.includes(' 0'), `蘸笔后有笔上质量：${massText}`);

  const box = await page.locator('#view').boundingBox();
  const toClient = (x, y) => ({
    x: box.x + (x / 400) * box.width,
    y: box.y + (y / 300) * box.height,
  });
  async function draw(points) {
    const p0 = toClient(points[0][0], points[0][1]);
    await page.mouse.move(p0.x, p0.y);
    await page.mouse.down();
    for (let i = 1; i < points.length; i++) {
      const p = toClient(points[i][0], points[i][1]);
      await page.mouse.move(p.x, p.y, { steps: 6 });
    }
    await page.mouse.up();
    await page.waitForTimeout(120);
  }

  await draw([
    [30, 90],
    [100, 70],
    [170, 120],
    [250, 90],
    [330, 130],
  ]);
  await page.screenshot({ path: path.join(OUT, 'ui-02-stroke.png') });

  const changedPixels = await page.evaluate(() => {
    const c = document.querySelector('#view');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - 251) + Math.abs(d[i + 1] - 251) + Math.abs(d[i + 2] - 246) > 24) n++;
    }
    return n;
  });
  assert(changedPixels > 800, `画布上有明显笔迹像素（${changedPixels}）`);

  // 晾干，再用纯净柠檬黄罩染/交叉
  await page.click('#btn-dry');
  await page.click('#btn-mixer-clear');
  await page.locator('.pigment-row:has-text("柠檬黄") [data-act=plus]').click();
  await page.click('#btn-dip');
  await draw([
    [40, 150],
    [120, 120],
    [200, 150],
    [300, 110],
    [370, 150],
  ]);
  await page.screenshot({ path: path.join(OUT, 'ui-03-layer.png') });

  // 取样 A / B
  await page.click('[data-arm="A"]');
  let p = toClient(170, 120);
  await page.mouse.click(p.x, p.y);
  const hexA = await page.textContent('#sample-a-hex');
  assert(!hexA.includes('未取样'), `样本 A 已取：${hexA.trim()}`);

  await page.click('[data-arm="B"]');
  p = toClient(120, 120);
  await page.mouse.click(p.x, p.y);
  const hexB = await page.textContent('#sample-b-hex');
  assert(!hexB.includes('未取样'), `样本 B 已取：${hexB.trim()}`);
  const de = await page.textContent('#delta-e00');
  assert(de !== '—' && Number(de) >= 0, `色差已计算 ΔE00=${de}`);
  await page.click('.tab[data-tab="sample"]');
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, 'ui-03b-sample.png') });

  // 缩放独立性：底层缓冲像素不变
  const pxBefore = await page.evaluate(() => {
    const c = document.querySelector('#view');
    return Array.from(c.getContext('2d').getImageData(200, 150, 1, 1).data).join(',');
  });
  await page.click('#zoom-in');
  await page.click('#zoom-in');
  await page.waitForTimeout(150);
  const pxAfter = await page.evaluate(() => {
    const c = document.querySelector('#view');
    return Array.from(c.getContext('2d').getImageData(200, 150, 1, 1).data).join(',');
  });
  assert(pxBefore === pxAfter, `缩放前后文档缓冲像素一致（${pxBefore}）`);
  await page.screenshot({ path: path.join(OUT, 'ui-04-zoom.png') });

  // 测试台
  await page.click('.tab[data-tab="bench"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, 'ui-05-bench.png') });
  const benchPainted = await page.evaluate(() => {
    const c = document.querySelector('#bench-thickness');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) n++;
    return n;
  });
  assert(benchPainted > 1000, '测试台厚度梯度由内核绘制');

  // 封存试混台：未封存水洗 -> 封存 -> 阻挡
  await page.click('.tab[data-tab="lab"]');
  await page.waitForSelector('#lab-cards .lab-card', { state: 'attached' });
  await page.waitForSelector('#lab-seal-compare table', { state: 'attached' });
  const compareText = await page.textContent('#lab-seal-compare');
  assert(compareText.includes('1.584') && compareText.includes('0.000'), '封存前/后对照表由复算数据渲染');
  await page.click('#btn-lab-water');
  const openMass = await page.evaluate(() => window.__pigmentStudio.getLabSwatches()[0].remainingMass());
  assert(Math.abs(openMass - 0.616) < 0.01, `未封存可溶底层被清水回取（剩余 ${openMass.toFixed(3)}）`);
  await page.click('#btn-lab-reset');
  await page.click('#btn-lab-seal');
  await page.click('#btn-lab-water');
  const sealedMass = await page.evaluate(() => window.__pigmentStudio.getLabSwatches()[0].remainingMass());
  assert(Math.abs(sealedMass - 2.2) < 1e-6, `封存后清水不能带走底层（剩余 ${sealedMass.toFixed(3)}）`);
  const metamerDE = await page.evaluate(() => {
    const r = window.__pigmentStudio.buildExperimentReport();
    return { d65: r.metamer.brightD65DeltaE00, warm: r.metamer.warmADeltaE00 };
  });
  assert(metamerDE.d65 < 1.5 && metamerDE.warm > 2, `同色异颜料指标成立（D65=${metamerDE.d65.toFixed(2)}, warm=${metamerDE.warm.toFixed(2)}）`);

  const [labJson] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-lab-export-json'),
  ]);
  const labJsonPath = path.join(OUT, 'lab-samples.json');
  await labJson.saveAs(labJsonPath);
  const labJsonSize = fs.statSync(labJsonPath).size;
  assert(labJsonSize > 5000, `封存试混 JSON 已导出（${(labJsonSize / 1024).toFixed(1)} KB）`);

  const [labPng] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-lab-export-png'),
  ]);
  const labPngPath = path.join(OUT, 'lab-samples.png');
  await labPng.saveAs(labPngPath);
  assert(fs.statSync(labPngPath).size > 8000, '封存试混 PNG 已导出');

  // 绘画窗口真实接点：混色、晾干、叠画并读取画布像素
  await page.click('#btn-integration-check');
  await page.waitForSelector('#integration-panel.ok, #integration-panel.bad', { timeout: 5000 });
  const integration = await page.evaluate(() => window.__pigmentLastIntegration);
  assert(integration && integration.anomalies.length === 0, `绘画接点自检无异常（ΔE=${integration?.colorChangeDE?.toFixed?.(2)}, maxPixelDiff=${integration?.maxChannelDiff}）`);
  assert(integration && integration.maxChannelDiff === 0, `画布像素与内核缓冲逐通道一致（max=${integration?.maxChannelDiff}）`);
  const runtimeState = await page.textContent('#runtime-state');
  const integrationPanelClass = await page.getAttribute('#integration-panel', 'class');
  const healthDotBad = await page.evaluate(() => document.querySelector('#health-dot')?.classList.contains('bad') ?? null);
  const browserEvidence = await page.evaluate(() => {
    const report = window.__pigmentStudio.buildExperimentReport();
    return {
      metamer: {
        brightD65DeltaE00: report.metamer.brightD65DeltaE00,
        warmADeltaE00: report.metamer.warmADeltaE00,
        dimWarmADeltaE00: report.metamer.dimWarmADeltaE00,
      },
      sealWater: report.sealWater.map((x) => ({
        recipeId: x.recipeId,
        soluble: x.soluble,
        beforeSealRemovedMass: x.waterBeforeSeal.result.removedMass,
        beforeSealRemainingMass: x.waterBeforeSeal.wet.remainingMass,
        afterSealRemovedMass: x.waterAfterSeal.result.removedMass,
        afterSealRemainingMass: x.waterAfterSeal.wet.remainingMass,
      })),
      repeatedMixMaxRelativeDrift: report.repeatedMix.spectral.maxRelativeDrift,
    };
  });
  const evidencePath = path.join(OUT, 'integration-evidence.json');
  fs.writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        schema: 'browser-integration-evidence-v1',
        generatedAt: new Date().toISOString(),
        browser: 'playwright-chromium',
        viewport: { width: 1600, height: 1000 },
        runtimeState: runtimeState.trim(),
        integrationPanelClass,
        healthDotBad,
        consoleWarnings,
        integration,
        ...browserEvidence,
      },
      null,
      2
    )
  );
  assert(fs.statSync(evidencePath).size > 1000, '浏览器接点与色差证据 JSON 已写出');
  await page.screenshot({ path: path.join(OUT, 'ui-07-integration.png') });

  // 像素页
  await page.click('.tab[data-tab="pixels"]');
  const mp = toClient(200, 150);
  await page.mouse.move(mp.x, mp.y);
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(OUT, 'ui-06-pixels.png') });

  // 保存色料状态
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-save'),
  ]);
  const savePath = path.join(OUT, 'saved.pigm');
  await download.saveAs(savePath);
  const sz = fs.statSync(savePath).size;
  assert(sz > 2000, `色料状态已下载（${(sz / 1024).toFixed(1)} KB gzip）`);

  // 读取状态
  await page.setInputFiles('#file-load', savePath);
  await page.waitForTimeout(800);
  const toastText = await page.locator('.toast').last().textContent().catch(() => '');
  assert(toastText.includes('已读取'), `状态回读成功：${toastText}`);

  // 导出 PNG
  const [pngDl] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-export'),
  ]);
  const pngPath = path.join(OUT, 'export.png');
  await pngDl.saveAs(pngPath);
  const pngSz = fs.statSync(pngPath).size;
  assert(pngSz > 5000, `PNG 已导出（${(pngSz / 1024).toFixed(1)} KB）`);

  assert(consoleErrors.length === 0, `浏览器控制台无错误（${consoleErrors.length}）${consoleErrors.length ? '：\n' + consoleErrors.slice(0, 5).join('\n') : ''}`);
} catch (e) {
  failures.push('脚本异常: ' + e.message);
  console.error(e);
  await page.screenshot({ path: path.join(OUT, 'ui-error.png') }).catch(() => {});
} finally {
  await browser.close();
  server.kill();
}

if (failures.length) {
  console.error(`\n${failures.length} 项失败`);
  process.exit(1);
}
console.log('\n浏览器冒烟全部通过');
