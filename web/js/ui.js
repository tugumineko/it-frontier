// ui.js — 控制面板：分析代码 / 着色切换 / 星海数据导入导出 / 展示参数。
// 不碰渲染，只把操作翻译成对 ctx 的调用（ctx 由 main.js 提供）。

export function setupUI(ctx) {
  const input = document.getElementById('code-input');
  const status = document.getElementById('analyze-status');

  // ---- 分析代码 ----
  const run = async () => {
    const code = input.value.trim();
    if (!code) { status.textContent = '请先在上方粘贴一段代码。'; return; }
    status.textContent = '正在分析：bge 逐符号编码 + ecnu-max 判读义项…（约 20 秒）';
    try {
      const r = await ctx.analyze(code);
      status.textContent = `完成：${r.count} 个符号出现、${r.senses} 个义项。点代码里的符号或星海里的点查看判读。`;
    } catch (e) {
      status.innerHTML = '⚠ 分析失败（需后端 + ECNU 凭据，从 <b>http://127.0.0.1:5000</b> 打开）：' + esc(String(e.message || e));
    }
  };
  document.getElementById('btn-analyze').onclick = run;

  // ---- 着色切换（按义项 / 按符号名）----
  const cs = document.getElementById('color-sense'), cy = document.getElementById('color-symbol');
  const setColor = (mode) => {
    cs.classList.toggle('active', mode === 'sense');
    cy.classList.toggle('active', mode === 'symbol');
    ctx.setColorBy(mode);
  };
  cs.onclick = () => setColor('sense');
  cy.onclick = () => setColor('symbol');

  // ---- 星海数据导入 / 导出 ----
  document.getElementById('btn-export').onclick = () => {
    if (!ctx.hasData) { status.textContent = '还没有可导出的数据，先分析一段代码。'; return; }
    ctx.exportData();
  };
  const fi = document.getElementById('file-import');
  document.getElementById('btn-import').onclick = () => fi.click();
  fi.onchange = () => {
    const f = fi.files && fi.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const obj = JSON.parse(rd.result);
        ctx.importData(obj);
        if (obj.meta && obj.meta.code) input.value = obj.meta.code;
        status.textContent = `已导入星海数据：${f.name}`;
      } catch (e) {
        status.textContent = '导入失败：不是有效的分析 JSON。';
      }
      fi.value = '';
    };
    rd.readAsText(f);
  };

  // ---- 展示参数 ----
  const bg = document.getElementById('bg-intensity'), bl = document.getElementById('bloom');
  bg.oninput = () => { const v = parseFloat(bg.value); ctx.setWorldIntensity?.(v); ctx.setBackgroundVisible?.(v > 0.08); };
  bl.oninput = () => ctx.setBloomStrength?.(parseFloat(bl.value));

  function refresh() {
    const d = ctx.data;
    document.getElementById('ro-count').textContent =
      d ? `${d.n} / ${(d.meta.clusters || []).length}` : '—';
    setColor('sense');
  }
  refresh();
  return { refresh };
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
