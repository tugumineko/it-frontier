// charts.js — 研究图 HUD（Canvas2D）：Shepard 散点 + 全局失真直方图
//
// Shepard 图是降维"测谎"的标准铁证：横轴=高维距离，纵轴=低维距离。
//   - 若降维忠实保距，点应贴近对角线 y=x；
//   - UMAP 全局失真 → 点散成一团（高维远近在 UMAP 里都被压成差不多），= 全局距离没意义。
//   - PCA 相对更贴对角线（保全局方差结构）。

function turbo(x) {
  x = Math.max(0, Math.min(1, x));
  const x2 = x*x, x3 = x2*x, x4 = x2*x2, x5 = x4*x;
  const d4 = (k) => k[0] + k[1]*x + k[2]*x2 + k[3]*x3;
  const d2 = (k) => k[0]*x4 + k[1]*x5;
  const r = d4([0.13572138,4.61539260,-42.66032258,132.13108234]) + d2([-152.94239396,59.28637943]);
  const g = d4([0.09140261,2.19418839,4.84296658,-14.18503333]) + d2([4.27729857,2.82956604]);
  const b = d4([0.10667330,12.64194608,-60.58204836,110.36276771]) + d2([-89.90310912,27.34824973]);
  return [r,g,b].map(c => (Math.max(0,Math.min(1,c))*255)|0);
}
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

function drawShepard(cv, shep, which, metrics) {
  const g = cv.getContext('2d'), W = cv.width, H = cv.height, pad = 22;
  g.clearRect(0,0,W,H);
  if (!shep) { g.fillStyle = '#8a93b8'; g.font = '11px sans-serif'; g.fillText('无 Shepard 数据(mock)', 12, H/2); return; }
  const x0 = pad, y0 = H - pad, x1 = W - 8, y1 = 8, sx = x1-x0, sy = y0-y1;
  // 轴
  g.strokeStyle = 'rgba(140,150,190,0.35)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(x0,y0); g.lineTo(x1,y0); g.moveTo(x0,y0); g.lineTo(x0,y1); g.stroke();
  // 对角线 y=x（理想保距）
  g.strokeStyle = 'rgba(255,211,107,0.6)'; g.setLineDash([4,3]);
  g.beginPath(); g.moveTo(x0,y0); g.lineTo(x1,y1); g.stroke(); g.setLineDash([]);
  // 点
  const dy = which === 'pca' ? shep.dPca : shep.dUmap;
  const col = which === 'pca' ? 'rgba(90,200,255,0.5)' : 'rgba(255,90,110,0.5)';
  g.fillStyle = col;
  for (let i = 0; i < shep.dHi.length; i++) {
    const px = x0 + shep.dHi[i]*sx, py = y0 - dy[i]*sy;
    g.beginPath(); g.arc(px, py, 1.6, 0, 6.283); g.fill();
  }
  // 标注：全局保真
  const gv = which === 'pca' ? metrics?.pca_global : metrics?.umap_global;
  g.fillStyle = '#dfe6ff'; g.font = '10px sans-serif';
  g.fillText('高维距离 →', x0, H-6);
  g.save(); g.translate(10, y1+40); g.rotate(-Math.PI/2); g.fillText('低维距离 →', 0, 0); g.restore();
  if (gv != null) { g.fillStyle = which==='pca'?'#5ac8ff':'#ff5a6e'; g.font = '11px sans-serif';
    g.fillText(`全局保真 ${gv.toFixed(3)}`, x1-92, y1+12); }
}

function drawHistogram(cv, distortion) {
  const g = cv.getContext('2d'), W = cv.width, H = cv.height, pad = 4, bins = 28;
  g.clearRect(0,0,W,H);
  const hist = new Array(bins).fill(0);
  for (let i = 0; i < distortion.length; i++) {
    let b = Math.floor(distortion[i]*bins); if (b<0) b=0; if (b>=bins) b=bins-1; hist[b]++;
  }
  const max = Math.max(...hist) || 1, bw = (W-pad*2)/bins;
  for (let b = 0; b < bins; b++) {
    const t = (b+0.5)/bins, hgt = (hist[b]/max)*(H-16);
    g.fillStyle = rgb(turbo(t));
    g.fillRect(pad + b*bw, H-8-hgt, bw-1, hgt);
  }
  g.fillStyle = '#8a93b8'; g.font = '9px sans-serif';
  g.fillText('诚实', pad, H-1); g.fillText('编造', W-26, H-1);
}

export function setupCharts(data) {
  const body = document.getElementById('ch-body');
  const toggle = document.getElementById('ch-toggle');
  const shepCv = document.getElementById('shepard');
  const histCv = document.getElementById('histogram');
  const shep = data.meta?.shepard;
  const metrics = data.meta?.metrics;
  let which = 'umap';

  const redraw = () => {
    if (body.hidden) return;
    drawShepard(shepCv, shep, which, metrics);
    drawHistogram(histCv, data.distortion);
  };
  toggle.onclick = () => {
    body.hidden = !body.hidden;
    toggle.textContent = body.hidden ? '展开' : '收起';
    redraw();
  };
  const sp = document.getElementById('shep-pca'), su = document.getElementById('shep-umap');
  const cap = document.getElementById('shep-cap');
  const pick = (w) => {
    which = w;
    sp.classList.toggle('active', w==='pca'); su.classList.toggle('active', w==='umap');
    cap.textContent = w==='umap'
      ? 'UMAP：点散成一团 = 全局距离基本没意义（在撒谎）。'
      : 'PCA：点更贴对角线 = 全局距离相对保真（更诚实）。';
    redraw();
  };
  sp.onclick = () => pick('pca');
  su.onclick = () => pick('umap');
}
