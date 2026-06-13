// ui.js — 控制面板逻辑：输入句子投进星海 / 多义词案例 / 展示参数。
//
// 这里不碰渲染，只把用户操作翻译成对 ctx 的调用（ctx 由 main.js 提供）。

export function setupUI(ctx) {
  // ---- 多义词案例库（数据来自构建期预算好的 meta.cases）----
  const sel = document.getElementById('case-select');
  function buildCases() {
    const cases = ctx.cases || [];
    sel.innerHTML = '<option value="-1">— 选一个多义词 —</option>';
    cases.forEach((c, i) => {
      const o = document.createElement('option');
      o.value = i;
      o.textContent = `${c.word}（${c.senses.map((s) => s.name.split(' ')[0]).join(' / ')}）`;
      sel.appendChild(o);
    });
  }
  sel.onchange = () => {
    const i = parseInt(sel.value, 10);
    if (i < 0) { ctx.clearProbe(); return; }
    ctx.showCase(ctx.cases[i]);
  };

  // ---- 输入一句话 → 投进星海 ----
  const input = document.getElementById('sentence-input');
  const status = document.getElementById('locate-status');
  const run = async () => {
    const text = input.value.trim();
    if (!text) return;
    status.textContent = '正在用 GPT-2 取每个词的上下文向量…';
    try {
      const r = await ctx.locate(text);
      status.textContent = r.mode === 'real'
        ? `已把 ${r.count} 个词投进星海。把鼠标移到词上看它在此处的最近邻。`
        : `mock 模式（未接 GPT-2）：${r.count} 个词散点占位，仅供链路演示。`;
    } catch (e) {
      status.innerHTML = '⚠ 未连接后端。请运行 <code>server/app.py</code> 并从 <b>http://127.0.0.1:5000</b> 打开本页。';
    }
  };
  document.getElementById('btn-locate').onclick = run;
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); } };
  document.getElementById('btn-clear').onclick = () => {
    ctx.clearProbe();
    sel.value = '-1';
    status.textContent = '已清除探针。';
  };

  // ---- 展示：聚焦星海 / 背景强度 / 辉光 / 词星大小 ----
  const bgSlider = document.getElementById('bg-intensity');
  const bloomSlider = document.getElementById('bloom');
  const ptSlider = document.getElementById('pt-size');
  const btnFocus = document.getElementById('btn-focus');
  bgSlider.oninput = () => { const v = parseFloat(bgSlider.value); ctx.setWorldIntensity?.(v); ctx.setBackgroundVisible?.(v > 0.08); };
  bloomSlider.oninput = () => ctx.setBloomStrength?.(parseFloat(bloomSlider.value));
  if (ptSlider) ptSlider.oninput = () => ctx.setPointScale?.(parseFloat(ptSlider.value));
  let focusOn = false;
  btnFocus.onclick = () => {
    focusOn = !focusOn;
    btnFocus.classList.toggle('active', focusOn);
    const v = focusOn ? 0.18 : 1.0;
    bgSlider.value = v; ctx.setWorldIntensity?.(v); ctx.setBackgroundVisible?.(!focusOn);
  };

  // ---- 初始化 / 数据刷新 ----
  function refresh() {
    document.getElementById('ro-count').textContent = ctx.data.n.toLocaleString();
    buildCases();
  }
  refresh();
  return { refresh };
}
