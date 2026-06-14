// main.js — 2D 代码词法地图：分析代码 → 四区 token 点 + 词法轨迹 + 代码面板 + 语义卡，点选联动。
import { setupUI } from './ui.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const mapSvg = document.getElementById('map');
const codeView = document.getElementById('code-view');
const selcard = document.getElementById('selcard');
const legend = document.getElementById('legend');

let data = null, selected = -1, linksOn = true, centers = {}, reqSeq = 0;
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const rgb = (c) => `rgb(${Math.round(c[0]*255)},${Math.round(c[1]*255)},${Math.round(c[2]*255)})`;

// viewBox 1000×680，四个词法区（2×2）
const ZONES = {
  keyword:    [40, 56, 440, 280],
  identifier: [520, 56, 440, 280],
  operator:   [40, 372, 440, 264],
  literal:    [520, 372, 440, 264],
};

const ctx = {
  get hasData() { return !!data; },
  get data() { return data; },
  analyze: async (code, lang) => {
    const seq = ++reqSeq;
    const res = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, lang }) });
    const out = await res.json().catch(() => ({}));
    if (seq !== reqSeq) return { stale: true };   // 已有更新的请求，丢弃这次旧结果，避免画面来回切换
    if (!res.ok || out.error) throw new Error(out.error || ('HTTP ' + res.status));
    data = out; render();
    return { count: out.tokens.length, llm: out.meta.llm };
  },
  exportData: () => { if (data) download(data, `code-lex-${Date.now()}.json`); },
  importData: (obj) => { data = obj; render(); },
  setLinks: (on) => { linksOn = on; const g = mapSvg.querySelector('#trace'); if (g) g.style.display = on ? '' : 'none'; },
};

function download(obj, name) {
  const b = new Blob([JSON.stringify(obj)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function catColor(key) { const c = (data.meta.categories || []).find((x) => x.key === key); return c ? rgb(c.color) : '#88aaff'; }
function el(tag, attrs) { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }

function render() {
  selected = -1; selcard.hidden = true;
  renderLegend(); renderMap(); renderCode();
  document.getElementById('ro-count').textContent = `${data.tokens.length} / ${(data.meta.categories || []).length}`;
}

function renderLegend() {
  legend.innerHTML = (data.meta.categories || []).map((c) =>
    `<div class="lg"><span class="dot" style="background:${rgb(c.color)}"></span>${c.name} <b>${data.meta.counts[c.key] || 0}</b></div>`).join('');
}

function renderMap() {
  mapSvg.innerHTML = ''; centers = {};
  const cats = data.meta.categories || [];
  cats.forEach((c) => {
    const z = ZONES[c.key]; if (!z) return;
    const [x, y, w, h] = z;
    mapSvg.appendChild(el('rect', { x, y, width: w, height: h, rx: 14, fill: 'rgba(255,255,255,0.02)',
      stroke: rgb(c.color), 'stroke-width': 1.5, 'stroke-dasharray': '6 5', 'stroke-opacity': 0.6 }));
    const t = el('text', { x: x + 14, y: y + 24, fill: rgb(c.color), 'font-size': 16, 'font-weight': 700 });
    t.textContent = `${c.name}  ${data.meta.counts[c.key] || 0}`;
    mapSvg.appendChild(t);
  });
  // 区内网格布局
  const byCat = {};
  data.tokens.forEach((t) => (byCat[t.cat] = byCat[t.cat] || []).push(t));
  Object.entries(byCat).forEach(([cat, toks]) => {
    const z = ZONES[cat]; if (!z) return;
    const [x, y, w, h] = z;
    const n = toks.length, cols = Math.max(1, Math.ceil(Math.sqrt(n * w / h)));
    const rows = Math.ceil(n / cols), cw = w / cols, ch = (h - 34) / Math.max(1, rows);
    toks.forEach((t, i) => { centers[t.id] = { x: x + cw * (i % cols + 0.5), y: y + 40 + ch * (Math.floor(i / cols) + 0.5) }; });
  });
  // 词法轨迹（代码顺序连线）
  const trace = el('g', { id: 'trace' }); if (!linksOn) trace.style.display = 'none';
  const pts = data.tokens.map((t) => centers[t.id]).filter(Boolean).map((p) => `${p.x},${p.y}`).join(' ');
  trace.appendChild(el('polyline', { points: pts, fill: 'none', stroke: '#5b8cff', 'stroke-width': 1, 'stroke-opacity': 0.22 }));
  mapSvg.appendChild(trace);
  // token 点
  data.tokens.forEach((t) => {
    const p = centers[t.id]; if (!p) return;
    const r = 5 + Math.min(11, (t.weight - 1) * 3);
    const circ = el('circle', { cx: p.x, cy: p.y, r, fill: catColor(t.cat), 'fill-opacity': 0.85,
      stroke: '#fff', 'stroke-opacity': 0.25, class: 'tok', 'data-tok': t.id });
    circ.addEventListener('click', () => selectTok(t.id));
    mapSvg.appendChild(circ);
  });
}

function renderCode() {
  const lines = (data.meta.code || '').split('\n');
  const byLine = {};
  data.tokens.forEach((t) => (byLine[t.line] = byLine[t.line] || []).push(t));
  let html = '';
  lines.forEach((line, li) => {
    const no = li + 1, ts = (byLine[no] || []).slice().sort((a, b) => a.col - b.col);
    let h = '', cur = 0;
    ts.forEach((t) => { if (t.col < cur) return; h += esc(line.slice(cur, t.col)); h += `<span class="tk ${t.cat}" data-tok="${t.id}">${esc(t.text)}</span>`; cur = t.col + t.text.length; });
    h += esc(line.slice(cur));
    html += `<div class="cl" data-line="${no}"><span class="ln">${no}</span><code>${h || ' '}</code></div>`;
  });
  codeView.innerHTML = html;
  codeView.querySelectorAll('.tk').forEach((s) => { s.onclick = () => selectTok(+s.dataset.tok); });
}

function selectTok(id) {
  const t = data.tokens[id]; if (!t) return;
  selected = id;
  mapSvg.querySelectorAll('.tok.sel').forEach((e) => { e.classList.remove('sel'); e.setAttribute('stroke-opacity', '0.25'); });
  const circ = mapSvg.querySelector(`.tok[data-tok="${id}"]`); if (circ) { circ.classList.add('sel'); circ.setAttribute('stroke-opacity', '1'); }
  codeView.querySelectorAll('.tk.hot, .cl.hot-line').forEach((e) => e.classList.remove('hot', 'hot-line'));
  const span = codeView.querySelector(`.tk[data-tok="${id}"]`);
  if (span) { span.classList.add('hot'); span.closest('.cl')?.classList.add('hot-line'); span.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  const cat = (data.meta.categories || []).find((c) => c.key === t.cat);
  selcard.hidden = false;
  selcard.innerHTML = `<div class="tk">${esc(t.text)}</div>` +
    `<div class="cat" style="color:${cat ? rgb(cat.color) : '#ccc'}">${cat ? cat.name : t.cat}${t.weight > 1 ? ` · 出现 ${t.weight} 次` : ''}</div>` +
    `<div class="ex">${esc(t.explain || '（符号）')}</div>` +
    `<div class="row"><button id="sel-close" class="seg">✕ 关闭(Esc)</button></div>`;
  document.getElementById('sel-close').onclick = () => { selcard.hidden = true; selected = -1; };
}

window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { selcard.hidden = true; selected = -1; } });

setupUI(ctx);
document.getElementById('loading').classList.add('hidden');
