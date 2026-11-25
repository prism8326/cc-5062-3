// 纯 Canvas 绘制小工具：所有颜色都来自内核求值结果。

export function paintHorizontalStrip(canvas, hexes, y = 0, height = canvas.height) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width / hexes.length;
  hexes.forEach((hex, i) => {
    ctx.fillStyle = hex;
    ctx.fillRect(Math.floor(i * w), y, Math.ceil(w) + 1, height);
  });
}

export function paintTwoRowRamp(canvas, top, bottom) {
  const ctx = canvas.getContext('2d');
  const rowH = canvas.height / 2;
  const n = Math.max(top.length, bottom.length);
  const w = canvas.width / n;
  for (let i = 0; i < n; i++) {
    if (top[i]) {
      ctx.fillStyle = top[i];
      ctx.fillRect(Math.floor((i * canvas.width) / n), 0, Math.ceil(w) + 1, rowH);
    }
    if (bottom[i]) {
      ctx.fillStyle = bottom[i];
      ctx.fillRect(
        Math.floor((i * canvas.width) / n),
        rowH,
        Math.ceil(w) + 1,
        canvas.height - rowH
      );
    }
  }
  ctx.strokeStyle = 'rgba(0,0,0,.18)';
  ctx.beginPath();
  ctx.moveTo(0, rowH + 0.5);
  ctx.lineTo(canvas.width, rowH + 0.5);
  ctx.stroke();
}

export function drawSpectrumChart(canvas, series) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  const padL = 30,
    padR = 8,
    padT = 10,
    padB = 20;
  const pw = W - padL - padR;
  const ph = H - padT - padB;

  // 网格与坐标
  ctx.strokeStyle = '#e6e9f0';
  ctx.fillStyle = '#8a93a3';
  ctx.font = '10px ui-monospace, monospace';
  ctx.lineWidth = 1;
  for (let r = 0; r <= 4; r++) {
    const y = padT + (ph * r) / 4;
    ctx.beginPath();
    ctx.moveTo(padL, y + 0.5);
    ctx.lineTo(W - padR, y + 0.5);
    ctx.stroke();
    ctx.fillText((1 - r / 4).toFixed(2), 4, y + 3);
  }
  for (const wl of [400, 450, 500, 550, 600, 650, 700]) {
    const x = padL + ((wl - 400) / 300) * pw;
    ctx.fillText(String(wl), x - 9, H - 6);
  }

  for (const s of series) {
    if (!s?.R) continue;
    ctx.strokeStyle = s.color || '#2f5fd0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    s.R.forEach((r, i) => {
      const x = padL + (i / (s.R.length - 1)) * pw;
      const y = padT + (1 - Math.max(0, Math.min(1, r))) * ph;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  ctx.strokeStyle = '#c8cedb';
  ctx.strokeRect(padL + 0.5, padT + 0.5, pw, ph);

  const labeled = series.filter((s) => s?.R && s.label);
  if (labeled.length) {
    ctx.font = '11px sans-serif';
    let lx = W - padR - 8;
    const ly = padT + 12;
    for (let i = labeled.length - 1; i >= 0; i--) {
      const s = labeled[i];
      const tw = ctx.measureText(s.label).width;
      const boxW = tw + 22;
      ctx.fillStyle = 'rgba(255,255,255,.82)';
      ctx.fillRect(lx - boxW, ly - 10, boxW, 16);
      ctx.strokeStyle = s.color || '#2f5fd0';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(lx - boxW + 5, ly - 2);
      ctx.lineTo(lx - boxW + 17, ly - 2);
      ctx.stroke();
      ctx.fillStyle = '#1f2430';
      ctx.textAlign = 'left';
      ctx.fillText(s.label, lx - boxW + 20, ly + 2);
      lx -= boxW + 6;
    }
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`;
}
