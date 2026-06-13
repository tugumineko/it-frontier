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
    status.textContent = '正在用 bge 编码代码标识符…';
    try {
      const r = await ctx.locate(text);
      status.textContent = r.mode === 'real'
        ? `已把 ${r.count} 个标识符投进星海。鼠标移到符号上看它在此处的最近邻。`
        : `mock 模式（未接 bge）：${r.count} 个符号散点占位。`;
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

  // ---- Agent 判读（ecnu-max）：用上方代码 + 一个符号，让模型判断含义与依据 ----
  const agentSymbol = document.getElementById('agent-symbol');
  const agentStatus = document.getElementById('agent-status');
  const agentResult = document.getElementById('agent-result');
  document.getElementById('btn-agent').onclick = async () => {
    const code = input.value.trim();
    const sym = agentSymbol.value.trim();
    if (!code || !sym) { agentStatus.textContent = '请先在上方贴代码，并填要判读的符号。'; return; }
    agentStatus.textContent = `正在让 ecnu-max 判读 “${sym}” …`;
    agentResult.hidden = true;
    try {
      const r = await ctx.agent(code, sym);
      agentStatus.textContent = '判读完成：';
      const conf = (r.confidence != null) ? `　置信 ${Math.round(r.confidence * 100)}%` : '';
      const ev = (r.evidence || []).map((e) => `<div class="ev">${esc(e)}</div>`).join('');
      agentResult.hidden = false;
      agentResult.innerHTML = `<div class="ag-sense">${esc(r.sense || '—')}<span class="ag-conf">${conf}</span></div>` +
        (ev ? `<div class="ag-ev-title">依据行</div>${ev}` : '');
    } catch (e) {
      agentStatus.innerHTML = '⚠ 判读失败（需后端 + ECNU 凭据）：' + esc(String(e.message || e));
      agentResult.hidden = true;
    }
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

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
