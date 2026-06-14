// ui.js — 控制：分析代码（选语言）/ 词法轨迹开关 / 数据导入导出。
export function setupUI(ctx) {
  const input = document.getElementById('code-input');
  const lang = document.getElementById('lang');
  const status = document.getElementById('analyze-status');

  let busy = false;
  const setBusy = (b) => {
    busy = b;
    document.getElementById('btn-analyze').disabled = b;
    document.querySelectorAll('.samples button').forEach((x) => { x.disabled = b; });
  };
  const run = async () => {
    if (busy) return;   // 分析中忽略重复触发，避免请求积压、画面来回切换
    const code = input.value.trim();
    if (!code) { status.textContent = '请先在上方粘贴一段代码。'; return; }
    setBusy(true);
    status.textContent = '正在词法分析…';
    try {
      const r = await ctx.analyze(code, lang.value);
      if (r.stale) return;   // 被更新的请求取代
      status.textContent = r.llm
        ? `词法地图已出：${r.count} 个 token。点代码或地图上的词，看它在这里干嘛（标识符按需解释、约 2 秒）。`
        : `词法地图已出：${r.count} 个 token（仅词法分类）。配 ECNU 凭据后点词可看解释。`;
    } catch (e) {
      status.innerHTML = '⚠ 失败（需后端，从 <b>http://127.0.0.1:5000</b> 打开）：' + esc(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };
  document.getElementById('btn-analyze').onclick = run;
  input.onkeydown = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } };

  // 分级样例：一键填入并分析，解决「不知道从哪下手」
  const EXAMPLES = {
    var: 'x = 10\nname = "Tom"\nprint(name, x)',
    if: 'score = 75\nif score >= 60:\n    print("pass")\nelse:\n    print("fail")',
    loop: 'total = 0\nfor i in range(5):\n    total = total + i\nprint(total)',
    func: 'def add(a, b):\n    result = a + b\n    return result',
    poly: 'value = config[key]\ncipher = encrypt(data, key)\nkey = generate_key()',
  };
  document.querySelectorAll('.samples button').forEach((b) => {
    b.onclick = () => { input.value = EXAMPLES[b.dataset.eg] || ''; lang.value = 'python'; run(); };
  });

  let on = true;
  const tl = document.getElementById('toggle-links');
  tl.onclick = () => { on = !on; tl.classList.toggle('active', on); ctx.setLinks(on); };

  document.getElementById('btn-export').onclick = () => {
    if (!ctx.hasData) { status.textContent = '先分析一段代码再导出。'; return; }
    ctx.exportData();
  };
  const fi = document.getElementById('file-import');
  document.getElementById('btn-import').onclick = () => fi.click();
  fi.onchange = () => {
    const f = fi.files && fi.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try { const o = JSON.parse(rd.result); ctx.importData(o); if (o.meta && o.meta.code) input.value = o.meta.code; status.textContent = `已导入：${f.name}`; }
      catch (e) { status.textContent = '导入失败：不是有效的词法地图 JSON。'; }
      fi.value = '';
    };
    rd.readAsText(f);
  };

  return {};
}

function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
