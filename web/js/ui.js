// ui.js — 控制面板逻辑：布局切换 / 测谎着色 / 案例库 / 实时检验
//
// 这里不碰渲染，只负责把用户操作翻译成对 Galaxy 的调用，并更新读数。

export function setupUI(ctx) {
  // 读数（双指标随当前数据集刷新）
  const setTrust = () => {
    const M = ctx.data.meta.metrics || {};
    const u = ctx.galaxy.morph > 0.5;
    const tr = u ? M.umap_trustworthiness : M.pca_trustworthiness;
    const gl = u ? M.umap_global : M.pca_global;
    document.getElementById('ro-layout').textContent = u ? 'UMAP' : 'PCA';
    document.getElementById('ro-trust').textContent = tr != null ? tr.toFixed(3) : '—';
    document.getElementById('ro-global').textContent = gl != null ? gl.toFixed(3) : '—';
  };

  // ---- 布局：PCA / UMAP ----
  const btnPca = document.getElementById('btn-pca');
  const btnUmap = document.getElementById('btn-umap');
  const morph = document.getElementById('morph');
  const selectLayout = (toUmap) => {
    btnPca.classList.toggle('active', !toUmap);
    btnUmap.classList.toggle('active', toUmap);
    ctx.galaxy.setLayoutTarget(toUmap ? 1 : 0);
    morph.value = toUmap ? 1 : 0;
    setTimeout(setTrust, 350);
  };
  btnPca.onclick = () => selectLayout(false);
  btnUmap.onclick = () => selectLayout(true);
  morph.oninput = () => {
    const v = parseFloat(morph.value);
    ctx.galaxy.setLayoutImmediate(v);
    btnPca.classList.toggle('active', v < 0.5);
    btnUmap.classList.toggle('active', v >= 0.5);
    setTrust();
  };

  // ---- 着色：聚类 / Turbo / viridis ----
  const btnCluster = document.getElementById('btn-cluster');
  const btnLie = document.getElementById('btn-lie');
  const btnViridis = document.getElementById('btn-viridis');
  const legend = document.getElementById('lie-legend');
  const cmapNote = document.getElementById('cmap-note');
  const setColor = (mode) => {
    btnCluster.classList.toggle('active', mode === 'cluster');
    btnLie.classList.toggle('active', mode === 'turbo');
    btnViridis.classList.toggle('active', mode === 'viridis');
    const heat = mode !== 'cluster';
    legend.hidden = !heat; cmapNote.hidden = !heat;
    if (heat) drawLegend(mode);
    ctx.galaxy.setColorMode(mode);
  };
  btnCluster.onclick = () => setColor('cluster');
  btnLie.onclick = () => setColor('turbo');
  btnViridis.onclick = () => setColor('viridis');

  // ---- 全局错配连线 ----
  const btnLinks = document.getElementById('btn-links');
  let linksOn = false;
  const setLinks = (on) => { linksOn = on; btnLinks.classList.toggle('active', on); ctx.galaxy.toggleLinks(on); };
  btnLinks.onclick = () => setLinks(!linksOn);
  const linkThresh = document.getElementById('link-thresh');
  if (linkThresh) linkThresh.oninput = () => ctx.galaxy.setLinkThreshold(parseFloat(linkThresh.value));

  // ---- 一键测谎 ----
  document.getElementById('btn-reveal').onclick = () => { selectLayout(true); setColor('turbo'); };

  // ---- 案例库（聚类聚焦，作用于当前数据集；切换数据集时重建）----
  const sel = document.getElementById('case-select');
  const focusRow = document.getElementById('ro-focus-wrap');
  let stat = [];
  function buildCases() {
    const D = ctx.data;
    stat = (D.meta.clusters || []).map((c, id) => {
      let sum = 0, cnt = 0;
      for (let i = 0; i < D.n; i++) if (D.cluster[i] === id) { sum += D.distortion[i]; cnt++; }
      return { id, name: c.name || `聚类${id}`, avg: cnt ? sum / cnt : 0, count: cnt };
    });
    sel.innerHTML = '<option value="-1">— 全部 —</option>';
    [...stat].sort((a, b) => b.avg - a.avg).forEach((s) => {
      const o = document.createElement('option');
      o.value = s.id; o.textContent = `${s.name} — 失真 ${(s.avg * 100).toFixed(0)}%`;
      sel.appendChild(o);
    });
    focusRow.hidden = true;
  }
  sel.onchange = () => {
    const id = parseInt(sel.value, 10);
    ctx.galaxy.setHighlight(id);
    if (id < 0) { focusRow.hidden = true; ctx.focus?.(null); return; }
    const s = stat[id];
    focusRow.hidden = false;
    document.getElementById('ro-focus-name').textContent = s.name;
    document.getElementById('ro-focus').textContent = `失真 ${(s.avg * 100).toFixed(0)}% · ${s.count} 点`;
    ctx.focus?.(id); setColor('turbo'); setLinks(true);
  };

  // ---- 数据集：实时生成 / 保存 / 导入 / 主银河 ----
  const liveInput = document.getElementById('live-input');
  const liveStatus = document.getElementById('live-status');
  const runLive = async () => {
    const text = liveInput.value.trim();
    if (!text) return;
    liveStatus.textContent = '正在用 GPT-2 现跑并重新生成星系…（数秒）';
    try {
      const r = await ctx.generate(text);          // 由 main 调后端 /api/generate 并整体替换数据集
      liveStatus.textContent = `已生成新星系：${r.count} 个词（你的输入已标星）。`;
    } catch (e) {
      liveStatus.innerHTML = '⚠ 未连接本地后端。请运行 <code>server/app.py</code> 并从 <b>http://127.0.0.1:5000</b> 打开本页；或用「导入数据/案例」。';
    }
  };
  document.getElementById('btn-live').onclick = runLive;
  liveInput.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runLive(); } };

  document.getElementById('btn-save').onclick = () => ctx.saveData?.();
  document.getElementById('btn-default').onclick = async () => {
    liveStatus.textContent = '正在加载主银河…';
    try { await ctx.loadDefault?.(); liveStatus.textContent = '已切回主银河（8000 词）。'; }
    catch (_) { liveStatus.textContent = '加载主银河失败。'; }
  };
  const fileImport = document.getElementById('file-import');
  document.getElementById('btn-import').onclick = () => fileImport.click();
  fileImport.onchange = () => {
    const f = fileImport.files && fileImport.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try { ctx.importData?.(JSON.parse(rd.result)); liveStatus.textContent = `已导入数据集：${f.name}`; }
      catch (e) { liveStatus.textContent = '导入失败：不是有效的星系 JSON。'; }
      fileImport.value = '';
    };
    rd.readAsText(f);
  };

  ctx._setColor = setColor; ctx._setLinks = setLinks;

  // ---- 展示：背景强度 / 聚焦星系 / 辉光 / 词星大小 ----
  const bgSlider = document.getElementById('bg-intensity');
  const bloomSlider = document.getElementById('bloom');
  const btnFocus = document.getElementById('btn-focus');
  bgSlider.oninput = () => { const v = parseFloat(bgSlider.value); ctx.setWorldIntensity?.(v); ctx.setBackgroundVisible?.(v > 0.08); };
  bloomSlider.oninput = () => ctx.setBloomStrength?.(parseFloat(bloomSlider.value));
  const ptSlider = document.getElementById('pt-size');
  if (ptSlider) ptSlider.oninput = () => ctx.setPointScale?.(parseFloat(ptSlider.value));
  let focusOn = false;
  btnFocus.onclick = () => {
    focusOn = !focusOn;
    btnFocus.classList.toggle('active', focusOn);
    const v = focusOn ? 0.18 : 1.0;
    bgSlider.value = v; ctx.setWorldIntensity?.(v); ctx.setBackgroundVisible?.(!focusOn);
    if (focusOn) setLinks(true);
  };

  // ---- 初始化 + 数据集切换刷新 ----
  drawLegend('turbo');
  function refresh() {
    document.getElementById('ro-count').textContent = ctx.data.n.toLocaleString();
    buildCases();
    setTrust();
    if (linkThresh) ctx.galaxy.setLinkThreshold(parseFloat(linkThresh.value));
  }
  refresh();
  return { refresh };
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
