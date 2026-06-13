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
  const trustUmap = data.meta.metrics?.umap_trustworthiness;
  const trustPca = data.meta.metrics?.pca_trustworthiness;
  const setTrust = () => {
    const v = galaxy.morph > 0.5 ? trustUmap : trustPca;
    document.getElementById('ro-trust').textContent = v != null ? v.toFixed(3) : '—';
    document.getElementById('ro-layout').textContent = galaxy.morph > 0.5 ? 'UMAP' : 'PCA';
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

  // ---- 着色：聚类 / 测谎 ----
  const btnCluster = document.getElementById('btn-cluster');
  const btnLie = document.getElementById('btn-lie');
  const legend = document.getElementById('lie-legend');
  const setColor = (lie) => {
    btnCluster.classList.toggle('active', !lie);
    btnLie.classList.toggle('active', lie);
    legend.hidden = !lie;
    galaxy.setColorMode(lie ? 'lie' : 'cluster');
  };
  btnCluster.onclick = () => setColor(false);
  btnLie.onclick = () => setColor(true);

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
    setColor(true);
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
    setColor(true);        // 聚焦时自动切测谎色，效果更明显
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
}
