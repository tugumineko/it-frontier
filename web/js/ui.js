// ui.js — 控制面板逻辑：布局切换 / 测谎着色 / 案例库 / 实时检验
//
// 这里不碰渲染，只负责把用户操作翻译成对 Galaxy 的调用，并更新读数。

export function setupUI(ctx) {
  const { galaxy, data } = ctx;

  // ---- 预计算：每个聚类的平均失真，用于案例库排序与读数 ----
  const clusters = (data.meta.clusters || []);
  const stat = clusters.map((c, id) => {
    let sum = 0, cnt = 0;
    for (let i = 0; i < data.n; i++) {
      if (data.cluster[i] === id) { sum += data.distortion[i]; cnt++; }
    }
    return { id, name: c.name || `聚类${id}`, avg: cnt ? sum / cnt : 0, count: cnt };
  });

  // ---- 顶部读数 ----
  document.getElementById('ro-count').textContent = data.n.toLocaleString();
  const M = data.meta.metrics || {};
  // 双指标：局部可信度(保近邻) + 全局保真(保距离)。UMAP 局部高、全局低 = 它的"谎"。
  const setTrust = () => {
    const u = galaxy.morph > 0.5;
    const tr = u ? M.umap_trustworthiness : M.pca_trustworthiness;
    const gl = u ? M.umap_global : M.pca_global;
    document.getElementById('ro-layout').textContent = u ? 'UMAP' : 'PCA';
    document.getElementById('ro-trust').textContent = tr != null ? tr.toFixed(3) : '—';
    document.getElementById('ro-global').textContent = gl != null ? gl.toFixed(3) : '—';
  };
  setTrust();

  // ---- 布局：PCA / UMAP 按钮 + 渐变滑条 ----
  const btnPca = document.getElementById('btn-pca');
  const btnUmap = document.getElementById('btn-umap');
  const morph = document.getElementById('morph');
  const selectLayout = (toUmap) => {
    btnPca.classList.toggle('active', !toUmap);
    btnUmap.classList.toggle('active', toUmap);
    galaxy.setLayoutTarget(toUmap ? 1 : 0);
    morph.value = toUmap ? 1 : 0;
    setTimeout(setTrust, 350);
  };
  btnPca.onclick = () => selectLayout(false);
  btnUmap.onclick = () => selectLayout(true);
  morph.oninput = () => {
    const v = parseFloat(morph.value);
    galaxy.setLayoutImmediate(v);
    btnPca.classList.toggle('active', v < 0.5);
    btnUmap.classList.toggle('active', v >= 0.5);
    setTrust();
  };

  // ---- 着色：聚类 / Turbo / viridis（感知均匀配色，禁用 rainbow）----
  const btnCluster = document.getElementById('btn-cluster');
  const btnLie = document.getElementById('btn-lie');       // Turbo
  const btnViridis = document.getElementById('btn-viridis');
  const legend = document.getElementById('lie-legend');
  const cmapNote = document.getElementById('cmap-note');
  drawLegend('turbo');
  const setColor = (mode) => {  // 'cluster' | 'turbo' | 'viridis'
    btnCluster.classList.toggle('active', mode === 'cluster');
    btnLie.classList.toggle('active', mode === 'turbo');
    btnViridis.classList.toggle('active', mode === 'viridis');
    const heat = mode !== 'cluster';
    legend.hidden = !heat; cmapNote.hidden = !heat;
    if (heat) drawLegend(mode);
    galaxy.setColorMode(mode);
  };
  btnCluster.onclick = () => setColor('cluster');
  btnLie.onclick = () => setColor('turbo');
  btnViridis.onclick = () => setColor('viridis');

  // ---- 真·近邻连线（意大利面）开关 ----
  const btnLinks = document.getElementById('btn-links');
  let linksOn = false;
  const setLinks = (on) => {
    linksOn = on;
    btnLinks.classList.toggle('active', on);
    galaxy.toggleLinks(on);
  };
  btnLinks.onclick = () => setLinks(!linksOn);

  // ---- 一键测谎：切到 UMAP + 测谎色（汇报爆点）----
  document.getElementById('btn-reveal').onclick = () => {
    selectLayout(true);
    setColor('turbo');
  };

  // ---- 案例库：按失真从高到低排，"最会骗人的聚类"在前 ----
  const sel = document.getElementById('case-select');
  const focusRow = document.getElementById('ro-focus-wrap');
  [...stat].sort((a, b) => b.avg - a.avg).forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.name} — 失真 ${(s.avg * 100).toFixed(0)}%`;
    sel.appendChild(opt);
  });
  sel.onchange = () => {
    const id = parseInt(sel.value, 10);
    galaxy.setHighlight(id);
    if (id < 0) { focusRow.hidden = true; ctx.focus?.(null); return; }
    const s = stat[id];
    focusRow.hidden = false;
    document.getElementById('ro-focus-name').textContent = s.name;
    document.getElementById('ro-focus').textContent = `失真 ${(s.avg * 100).toFixed(0)}% · ${s.count} 点`;
    ctx.focus?.(id);      // 让相机聚焦该聚类（main.js 提供）
    setColor('turbo');        // 聚焦时自动切测谎色，效果更明显
    setLinks(true);        // 自动亮出真·近邻连线：看它的邻居在 UMAP 里被扯到哪
  };

  // ---- 实时检验：调本地后端 ----
  const liveInput = document.getElementById('live-input');
  const liveStatus = document.getElementById('live-status');
  const runLive = async () => {
    const text = liveInput.value.trim();
    if (!text) return;
    liveStatus.textContent = '正在跑模型…';
    try {
      const res = await fetch('/api/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const out = await res.json();
      galaxy.setLivePoints(out.points);
      liveStatus.textContent = `已插入 ${out.points.length} 个 token（亮星）。`;
    } catch (e) {
      // 后端没开也不慌，引导用案例库
      liveStatus.innerHTML = '⚠ 未连接本地后端。请运行 <code>server/app.py</code>，或改用上方「精选案例库」。';
    }
  };
  document.getElementById('btn-live').onclick = runLive;
  liveInput.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runLive(); } };

  ctx._setColor = setColor; ctx._setLinks = setLinks;   // 供其它交互复用

  // ---- 展示：背景强度 / 聚焦星系 / 辉光 ----
  const bgSlider = document.getElementById('bg-intensity');
  const bloomSlider = document.getElementById('bloom');
  const btnFocus = document.getElementById('btn-focus');
  bgSlider.oninput = () => {
    const v = parseFloat(bgSlider.value);
    ctx.setWorldIntensity?.(v);
    ctx.setBackgroundVisible?.(v > 0.08);   // 调到很低时直接黑场，最大对比
  };
  bloomSlider.oninput = () => ctx.setBloomStrength?.(parseFloat(bloomSlider.value));
  const ptSlider = document.getElementById('pt-size');
  if (ptSlider) ptSlider.oninput = () => ctx.setPointScale?.(parseFloat(ptSlider.value));
  let focusOn = false;
  btnFocus.onclick = () => {
    focusOn = !focusOn;
    btnFocus.classList.toggle('active', focusOn);
    const v = focusOn ? 0.18 : 1.0;
    bgSlider.value = v;
    ctx.setWorldIntensity?.(v);
    ctx.setBackgroundVisible?.(!focusOn);
    if (focusOn) setLinks(true);             // 聚焦时亮出近邻连线，突出"星系连结"
  };
}

// ---- 图例配色（JS 版 Turbo/viridis，与 shader 完全一致，保证图例=点色）----
function turboJS(x) {
  x = Math.max(0, Math.min(1, x));
  const x2 = x * x, x3 = x2 * x, x4 = x2 * x2, x5 = x4 * x;
  const d4 = (k) => k[0] + k[1] * x + k[2] * x2 + k[3] * x3;
  const d2 = (k) => k[0] * x4 + k[1] * x5;
  const r = d4([0.13572138, 4.61539260, -42.66032258, 132.13108234]) + d2([-152.94239396, 59.28637943]);
  const g = d4([0.09140261, 2.19418839, 4.84296658, -14.18503333]) + d2([4.27729857, 2.82956604]);
  const b = d4([0.10667330, 12.64194608, -60.58204836, 110.36276771]) + d2([-89.90310912, 27.34824973]);
  return [r, g, b].map((c) => Math.max(0, Math.min(1, c)) * 255);
}
function viridisJS(t) {
  t = Math.max(0, Math.min(1, t));
  const C = [[0.2777273,0.0054073,0.3340998],[0.1050930,1.4046135,1.3845902],[-0.3308618,0.2148476,0.0950952],
    [-4.6342305,-5.7991010,-19.3324410],[6.2282699,14.1799334,56.6905526],[4.7763850,-13.7451454,-65.3530326],
    [-5.4354559,4.6458526,26.3124352]];
  return [0,1,2].map((ch) => {
    let v = C[6][ch];
    for (let i = 5; i >= 0; i--) v = C[i][ch] + t * v;
    return Math.max(0, Math.min(1, v)) * 255;
  });
}
function drawLegend(mode) {
  const cv = document.getElementById('cmap-legend');
  if (!cv) return;
  const g = cv.getContext('2d'), w = cv.width, h = cv.height;
  for (let x = 0; x < w; x++) {
    const c = (mode === 'viridis' ? viridisJS : turboJS)(x / (w - 1));
    g.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
    g.fillRect(x, 0, 1, h);
  }
}
