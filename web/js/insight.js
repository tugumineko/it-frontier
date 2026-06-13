// insight.js — A：逐层义项可分度曲线 HUD。
//
// 拖「层」滑块看同一个多义词的两个义项，随层数加深的可分度（高维余弦距离）变化：
// 第 0 层接近静态词向量、几乎重合，中间层分得最开，顶层偏向预测下一个词又塌回去。
// 这条曲线不依赖任何降维投影，是逐层最准的证据（呼应 logit lens / 逐层探针的发现）。

export function setupInsight() {
  const hud = document.getElementById('insight');
  const cv = document.getElementById('sep-curve');
  const slider = document.getElementById('layer-slider');
  const readout = document.getElementById('sep-readout');
  const title = document.getElementById('insight-title');
  let cur = null;

  function draw(layer) {
    const g = cv.getContext('2d'), W = cv.width, H = cv.height, pad = 18;
    g.clearRect(0, 0, W, H);
    if (!cur || !cur.sep || !cur.sep.length) {
      g.fillStyle = '#8a93b8'; g.font = '11px sans-serif'; g.fillText('无逐层数据', 12, H / 2); return;
    }
    const sep = cur.sep, n = sep.length, mx = Math.max(...sep) || 1;
    const x0 = pad, y0 = H - pad, x1 = W - 8, y1 = 8, sx = (x1 - x0) / (n - 1), sy = (y0 - y1) / mx;
    g.strokeStyle = 'rgba(140,150,190,0.35)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y0); g.moveTo(x0, y0); g.lineTo(x0, y1); g.stroke();
    g.strokeStyle = '#5b8cff'; g.lineWidth = 2; g.beginPath();
    for (let i = 0; i < n; i++) { const px = x0 + i * sx, py = y0 - sep[i] * sy; i ? g.lineTo(px, py) : g.moveTo(px, py); }
    g.stroke();
    const peak = sep.indexOf(mx);
    g.fillStyle = '#ffd36b'; g.beginPath(); g.arc(x0 + peak * sx, y0 - mx * sy, 3, 0, 6.283); g.fill();
    const cl = Math.max(0, Math.min(n - 1, layer));
    g.strokeStyle = '#ff6b6b'; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(x0 + cl * sx, y1); g.lineTo(x0 + cl * sx, y0); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#ff6b6b'; g.beginPath(); g.arc(x0 + cl * sx, y0 - sep[cl] * sy, 3.5, 0, 6.283); g.fill();
    g.fillStyle = '#8a93b8'; g.font = '9px sans-serif'; g.fillText('层 →', x1 - 24, H - 5);
  }
  function update() {
    const L = parseInt(slider.value, 10);
    const peak = cur.sep.indexOf(Math.max(...cur.sep));
    readout.innerHTML = `第 <b>${L}</b> 层可分度 <b>${(cur.sep[L] ?? 0).toFixed(3)}</b>　峰值在第 <b>${peak}</b> 层`;
    draw(L);
  }
  slider.oninput = update;

  return {
    showCase(c) {
      cur = c; hud.hidden = false;
      title.textContent = `「${c.word}」逐层义项可分度`;
      const n = (c.sep && c.sep.length) || 13;
      slider.max = n - 1; slider.value = Math.min(9, n - 1);
      update();
    },
    hide() { hud.hidden = true; cur = null; },
  };
}
