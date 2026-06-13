// main.js — 启动入口：沉浸式世界 + 语义星系 + 选择性 Bloom(只星核/词星发光) + Vignette
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { loadGalaxyRaw, normalizeGalaxy } from './data.js';
import { Galaxy } from './galaxy.js';
import { World, BLOOM_LAYER } from './world.js';
import { setupUI } from './ui.js';

const GALAXY_SCALE = 2.6;

const app = document.getElementById('app');

// ---- 渲染器 ----
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x02030a, 1);
renderer.toneMapping = THREE.ReinhardToneMapping;   // r160 选择性 bloom 官方用值
renderer.toneMappingExposure = 1.0;
app.appendChild(renderer.domElement);

// ---- 场景 / 相机 ----
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 8000);
camera.position.set(0, 90, 340);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 2;
controls.maxDistance = 1600;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.2;

// ---- 沉浸式世界（穹顶 + 星野 + 螺旋星盘 + 尘埃带 + 银河核）----
const world = new World(scene);
world.bakeBackground(renderer);   // Step7：把星云烤成 cube 背景（无缝+省逐帧开销）

// ================= 选择性 Bloom（双 composer）=================
// 原理：bloomComposer 只渲"发光层"(银河核 + 语义词星)，UnrealBloom 抠出辉光；
//      finalComposer 渲完整场景，再把辉光加性叠回 → 只有发光层发光，其余结构清晰不洗白。
const bloomLayerMask = BLOOM_LAYER;

const bloomComposer = new EffectComposer(
  renderer, new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { type: THREE.HalfFloatType })
);
bloomComposer.renderToScreen = false;
bloomComposer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.75,  // strength
  0.6,   // radius
  0.0    // threshold（选择性下背景已是黑，阈值可低）
);
bloomComposer.addPass(bloomPass);

const mixPass = new ShaderPass(
  new THREE.ShaderMaterial({
    uniforms: { baseTexture: { value: null }, bloomTexture: { value: bloomComposer.renderTarget2.texture } },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `uniform sampler2D baseTexture; uniform sampler2D bloomTexture; varying vec2 vUv;
      void main(){ gl_FragColor = texture2D(baseTexture,vUv) + vec4(1.0)*texture2D(bloomTexture,vUv); }`,
    defines: {},
  }), 'baseTexture'
);
mixPass.needsSwap = true;

const vignette = new ShaderPass(VignetteShader);
vignette.uniforms.offset.value = 1.1;
vignette.uniforms.darkness.value = 1.15;

const finalComposer = new EffectComposer(
  renderer, new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { type: THREE.HalfFloatType })
);
finalComposer.addPass(new RenderPass(scene, camera));
finalComposer.addPass(mixPass);
finalComposer.addPass(vignette);
finalComposer.addPass(new OutputPass());

// ---- 相机过渡（有界缓动 tween：飞入/复位都走它，不眩晕、可中断）----
let clusterCentroids = null;
let homeState = null;                 // 全景机位锚点（saveState）
let flight = null;                    // {t0,dur,fromP,toP,fromT,toT} 进行中的飞行
const easeInOutCubic = (k) => (k < 0.5 ? 4*k*k*k : 1 - Math.pow(-2*k+2, 3)/2);

function captureState() { return { pos: camera.position.clone(), target: controls.target.clone() }; }

// 飞向某世界点：沿当前视线方向退 dist，保留方位角不甩头；同步插值 position + target。
function flyToPoint(toPos, dist) {
  const fromP = camera.position.clone(), fromT = controls.target.clone();
  const dir = fromP.clone().sub(fromT).normalize();
  const toP = toPos.clone().add(dir.multiplyScalar(dist));
  flight = { t0: performance.now(), dur: 650, fromP, toP, fromT, toT: toPos.clone() };
  controls.enabled = false;           // 飞行期间锁手动控制，防与补间打架
}
function flyToState(s) {
  flight = { t0: performance.now(), dur: 650, fromP: camera.position.clone(), toP: s.pos.clone(),
             fromT: controls.target.clone(), toT: s.target.clone() };
  controls.enabled = false;
}
function cancelFlight() { if (flight) { flight = null; controls.enabled = true; } }  // 中途打断

const _v = new THREE.Vector3();
function wordWorldPos(i) {
  const d = galaxy.data, m = galaxy.morph;
  return _v.set(
    d.pca[i*3]*(1-m)+d.umap[i*3]*m,
    d.pca[i*3+1]*(1-m)+d.umap[i*3+1]*m,
    d.pca[i*3+2]*(1-m)+d.umap[i*3+2]*m
  ).applyMatrix4(galaxy.points.matrixWorld);
}

function makeCentroids(data) {
  const clusters = data.meta.clusters || [];
  const acc = clusters.map(() => ({ pca: [0,0,0], umap: [0,0,0], n: 0 }));
  for (let i = 0; i < data.n; i++) {
    const c = data.cluster[i] | 0; if (!acc[c]) continue;
    for (let j = 0; j < 3; j++) { acc[c].pca[j] += data.pca[i*3+j]; acc[c].umap[j] += data.umap[i*3+j]; }
    acc[c].n++;
  }
  acc.forEach(a => { if (a.n) for (const k of ['pca','umap']) for (let j=0;j<3;j++) a[k][j]/=a.n; });
  return acc;
}
function focusCluster(id) {
  if (id == null || !clusterCentroids) { return; }
  const c = clusterCentroids[id]; if (!c) return;
  const p = galaxy.morph > 0.5 ? c.umap : c.pca;
  controls.autoRotate = false;
  if (galaxy.setSpin) galaxy.setSpin(false);
  flyToPoint(new THREE.Vector3(p[0], p[1], p[2]).multiplyScalar(GALAXY_SCALE), 130);
  setMode('聚焦：' + (galaxy.data.meta.clusters?.[id]?.name || ('簇' + id)));
}

// ---- 主流程：数据集可整体切换（实时生成 / 导入 / 主银河）----
let galaxy = null, data = null, rawData = null, uiApi = null;
// 探针层状态：输入句子 / 案例义项投到星海，叠加在底图上（不改底图）
const probeLayer = document.getElementById('probe-labels');
const _ppv = new THREE.Vector3();
let probeWords = [];
let probeLabels = [];

// 用一份(原始 schema)数据重建整个星系：dispose 旧的 → 建新的，保留当前视图状态。
function applyGalaxyObj(raw) {
  const cm = galaxy ? galaxy.uniforms.uColorMode.value : 0;
  const morph = galaxy ? galaxy.morph : 1;   // 默认 UMAP 布局（义项分得更开）
  const linksOn = galaxy ? galaxy._linksOn : false;
  if (galaxy) galaxy.dispose();
  rawData = raw;
  data = normalizeGalaxy(raw);
  galaxy = new Galaxy(scene, data);
  for (const o of [galaxy.points, galaxy.links, galaxy.liveGroup]) { o.scale.setScalar(GALAXY_SCALE); o.renderOrder = 3; }
  galaxy.points.layers.enable(BLOOM_LAYER);
  galaxy.uniforms.uColorMode.value = cm;
  galaxy.setLayoutImmediate(morph);
  galaxy.toggleLinks(linksOn);
  clusterCentroids = makeCentroids(data);
}

// 重载底图（仅"重置/主银河"用）：重建 + 刷新 UI + 复位选择/探针/相机模式。
function setDataset(raw) {
  applyGalaxyObj(raw);
  cancelFlight();
  if (typeof clearProbe === 'function') clearProbe();
  if (typeof deselect === 'function') deselect();
  if (uiApi) uiApi.refresh();
  setMode('自由观察');
}

function downloadJSON(obj, name) {
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const ctx = {
  get galaxy() { return galaxy; },
  get data() { return data; },
  get cases() { return (data && data.meta && data.meta.cases) || []; },
  focus: focusCluster,
  setWorldIntensity: (v) => world.setWorldIntensity(v),
  setBackgroundVisible: (on) => { scene.background = on ? (world.bgTexture || null) : null; },
  setBloomStrength: (v) => { bloomPass.strength = v; },
  setPointScale: (v) => { galaxy.uniforms.uPointScale.value = v; },
  loadDefault: async () => { setDataset(await loadGalaxyRaw()); },
  clearProbe: () => clearProbe(),
  showCase: (c) => showCase(c),
  // 把一句话投进星海：调后端取每个词的上下文向量与最近邻，渲染成探针点 + 句子轨迹。
  locate: async (text) => {
    const res = await fetch('/api/locate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const out = await res.json();
    if (out.error) throw new Error(out.error);
    const cases = (data && data.meta && data.meta.cases) || [];
    const words = (out.words || []).map((w) => {
      const o = { ...w, color: [1.0, 0.92, 0.5] };
      const c = cases.find((cc) => cc.word.toLowerCase() === (w.word || '').toLowerCase());
      if (c && c.senses && c.senses.length === 2 && w.umap) o.axis = senseAxisProj(w.umap, c);  // B/D
      return o;
    });
    renderProbe(words, { trail: true });
    return { count: words.length, mode: out.mode };
  },
  // 路径②：让 ecnu-max 判读某符号在这段代码里的含义 + 依据 + 置信
  agent: async (code, symbol) => {
    const res = await fetch('/api/agent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: code, symbol }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.error) throw new Error(out.error || ('HTTP ' + res.status));
    return out.result;
  },
};

(async () => {
  try {
    applyGalaxyObj(await loadGalaxyRaw());
    uiApi = setupUI(ctx);
    controls.update();
    homeState = captureState();        // 锚定全景机位，供"返回总览/ESC"平滑飞回
    setMode('自由观察');
    document.getElementById('loading').classList.add('hidden');
  } catch (e) {
    document.getElementById('loading').textContent = '加载失败：' + e.message;
    console.error(e);
  }
})();

// ---- 动画循环 ----
let last = performance.now();
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  world.update(dt, camera);
  if (galaxy) galaxy.update(dt);

  // 相机飞行（有界缓动 easeInOutCubic：飞入/复位共用，落地交还控制）
  if (flight) {
    const k = easeInOutCubic(Math.min(1, (now - flight.t0) / flight.dur));
    camera.position.lerpVectors(flight.fromP, flight.toP, k);
    controls.target.lerpVectors(flight.fromT, flight.toT, k);
    if (k >= 1) { flight = null; controls.enabled = true; }
  }
  controls.update();
  updateProbeLabels();

  // 选择性 bloom：先只渲发光层(黑背景) → 再渲完整场景(含星云背景)叠加
  const bg = scene.background;
  scene.background = null;                 // bloom 通道必须黑背景，否则星云会被错误发光
  camera.layers.set(BLOOM_LAYER);
  bloomComposer.render();
  scene.background = bg;
  camera.layers.set(0);
  finalComposer.render();
}
animate();

// ---- 自适应 ----
window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  bloomComposer.setSize(w, h);
  finalComposer.setSize(w, h);
});

// ============ 交互（按交互设计计划重做）============
// 分层：hover=轻预览(不动相机) · 单击=纯选择(不动相机) · 双击/聚焦=平滑飞入 · ESC=分级复位。
// 旋转(拖拽)绝不触发选择/聚焦：用位移+时间阈值合成"真单击"，并用 OrbitControls start/end 做闸门。
const el = renderer.domElement;
const tooltip = document.getElementById('tooltip');
const selcard = document.getElementById('selcard');
const modeEl = document.getElementById('mode');
const _pv = new THREE.Vector3();
const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const tokenInfo = (i) => {
  const d = galaxy.data;
  const cl = d.meta.clusters?.[d.cluster[i]]?.name || ('区 ' + d.cluster[i]);
  return { token: d.tokens[i] || '·', cl };
};
function pickAt(mx, my) {
  if (!galaxy) return -1;
  galaxy.points.updateMatrixWorld();
  const d = galaxy.data, m = galaxy.morph;
  const w = window.innerWidth, h = window.innerHeight, mw = galaxy.points.matrixWorld;
  let best = -1, bestD = 16 * 16;   // 16px 命中阈值
  for (let i = 0; i < d.n; i++) {
    _pv.set(d.pca[i*3]*(1-m)+d.umap[i*3]*m, d.pca[i*3+1]*(1-m)+d.umap[i*3+1]*m, d.pca[i*3+2]*(1-m)+d.umap[i*3+2]*m)
       .applyMatrix4(mw).project(camera);
    if (_pv.z > 1) continue;
    const sx = (_pv.x*0.5+0.5)*w, sy = (-_pv.y*0.5+0.5)*h;
    const dx = sx-mx, dy = sy-my, dd = dx*dx+dy*dy;
    if (dd < bestD) { bestD = dd; best = i; }
  }
  return best;
}

function setMode(text) { if (modeEl) modeEl.firstChild ? (modeEl.firstChild.textContent = text) : (modeEl.textContent = text); modeEl?.classList.toggle('focused', !text.startsWith('自由')); }

// ---- 选择（纯高亮，绝不动相机）----
let selected = -1;
function select(i) {
  selected = i;
  galaxy.setHighlight(galaxy.data.cluster[i]);   // 高亮同簇，压暗其余(focus+context)
  if (galaxy.setSpin) galaxy.setSpin(false);     // 暂停自转，选中的词不漂走
  const info = tokenInfo(i);
  selcard.hidden = false;
  selcard.innerHTML = `<div class="tk">${escHtml(info.token)}</div>` +
    `<div class="dv">所在区：${escHtml(info.cl)}</div>` +
    `<div class="row"><button id="sel-focus" class="seg">🎯 飞入(双击)</button><button id="sel-close" class="seg">✕ 取消(Esc)</button></div>`;
  document.getElementById('sel-focus').onclick = () => flyToPoint(wordWorldPos(i).clone(), 55);
  document.getElementById('sel-close').onclick = () => deselect();
}
function deselect() {
  selected = -1;
  galaxy.setHighlight(-1);
  if (galaxy.setSpin) galaxy.setSpin(true);
  selcard.hidden = true;
}

// ---- 拖拽闸门：拖拽中不拾取、不弹卡 ----
let isOrbiting = false;
controls.addEventListener('start', () => { isOrbiting = true; tooltip.hidden = true; });
controls.addEventListener('end', () => { requestAnimationFrame(() => { isOrbiting = false; }); });

// ---- hover 预览（rAF 节流；拖拽/飞行中不打扰；命中切光标）----
let hoverX = 0, hoverY = 0, hoverPending = false, autoRotateStopped = false;
el.addEventListener('pointermove', (e) => {
  hoverX = e.clientX; hoverY = e.clientY;
  if (!hoverPending) { hoverPending = true; requestAnimationFrame(doHover); }
});
function doHover() {
  hoverPending = false;
  if (!galaxy || isOrbiting || flight) { tooltip.hidden = true; el.style.cursor = isOrbiting ? 'grabbing' : 'grab'; return; }
  const i = pickAt(hoverX, hoverY);
  if (i < 0) { tooltip.hidden = true; el.style.cursor = 'grab'; return; }
  el.style.cursor = 'pointer';
  const info = tokenInfo(i);
  tooltip.hidden = false;
  tooltip.style.left = (hoverX + 12) + 'px'; tooltip.style.top = (hoverY) + 'px';
  tooltip.innerHTML = `<div class="tk">${escHtml(info.token)}</div>` +
    `<div class="dv">${escHtml(info.cl)} · 双击飞入</div>`;
}
el.addEventListener('pointerleave', () => { tooltip.hidden = true; });

// ---- 真单击合成（位移≤5px & 时长≤300ms，且非拖拽）→ 仅选择 ----
let down = null;
el.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  if (!autoRotateStopped) { controls.autoRotate = false; autoRotateStopped = true; }
  cancelFlight();                          // 飞行中按下即接管(可中断)
  try { el.setPointerCapture(e.pointerId); } catch (_) {}
  down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
});
el.addEventListener('pointerup', (e) => {
  if (!down || e.pointerId !== down.id) return;
  const dist = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  const dt = performance.now() - down.t;
  const TH = e.pointerType === 'mouse' ? 5 : 10;
  down = null;
  if (isOrbiting || dist > TH || dt > 300) return;   // 拖拽/长按 → 不是点击
  const i = pickAt(e.clientX, e.clientY);
  if (i < 0) { deselect(); return; }                 // 点空白=取消选择
  select(i);                                         // 单击只选择，绝不动相机
});

// ---- 双击 → 平滑飞入 ----
el.addEventListener('dblclick', (e) => {
  const i = pickAt(e.clientX, e.clientY);
  if (i < 0) return;
  select(i);
  flyToPoint(wordWorldPos(i).clone(), 55);
  setMode('聚焦：' + escHtml(tokenInfo(i).token));
});

// ---- ESC 分级：先取消选择，再平滑飞回全景 ----
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (selected >= 0) { deselect(); }
  else if (probeWords.length) { clearProbe(); if (selcard) selcard.hidden = true; setMode('自由观察'); }
  else if (homeState) { if (galaxy.setSpin) galaxy.setSpin(true); flyToState(homeState); setMode('自由观察'); }
});

// ---- 操作提示条：首次显示约 6s 后淡出；? 可再唤出 ----
const hintbar = document.getElementById('hintbar');
const hintToggle = document.getElementById('hint-toggle');
let hintTimer = setTimeout(() => hintbar.classList.add('faded'), 6000);
hintToggle.onclick = () => {
  clearTimeout(hintTimer);
  hintbar.classList.toggle('faded');
  if (!hintbar.classList.contains('faded')) hintTimer = setTimeout(() => hintbar.classList.add('faded'), 6000);
};

// ============ 探针层：把输入句子 / 案例义项投到星海（叠加，不改底图）============
// 探针点在 galaxy.liveGroup 里渲染（发光），词的文字标签用 DOM 浮层，每帧投影到屏幕。
function renderProbe(words, opts = {}) {
  probeWords = words || [];
  galaxy.setProbe(probeWords, opts);
  galaxy.liveGroup.traverse((o) => { if (o.layers) o.layers.enable(BLOOM_LAYER); });   // 探针发光
  if (probeLayer) probeLayer.innerHTML = '';
  probeLabels = probeWords.map((p) => {
    const el = document.createElement('div');
    el.className = 'plabel' + (p.sense ? ' sense' : '');
    el.textContent = p.sense ? `${p.word}·${p.sense.split(' ')[0]}` : p.word;
    el.onpointerenter = () => showProbeInfo(p);
    if (probeLayer) probeLayer.appendChild(el);
    return el;
  });
  controls.autoRotate = false;
  if (galaxy.setSpin) galaxy.setSpin(false);    // 暂停自转，探针不漂走
  updateProbeLabels();
}
function clearProbe() {
  probeWords = []; probeLabels = [];
  if (probeLayer) probeLayer.innerHTML = '';
  if (galaxy) galaxy.clearProbe();
}
// B：把一个落点投影到「义项 0 → 义项 1」轴上，得到 0~1 的倾向；D：偏离中点的程度=置信。
function senseAxisProj(pt, c) {
  const a = c.senses[0].uvw || c.senses[0].xyz, b = c.senses[1].uvw || c.senses[1].xyz;
  const ax = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
  const wv = [pt[0]-a[0], pt[1]-a[1], pt[2]-a[2]];
  const len2 = ax[0]*ax[0] + ax[1]*ax[1] + ax[2]*ax[2] || 1;
  let t = (wv[0]*ax[0] + wv[1]*ax[1] + wv[2]*ax[2]) / len2;
  t = Math.max(0, Math.min(1, t));
  return { s0: c.senses[0].name, s1: c.senses[1].name, t, conf: Math.abs(2*t - 1) };
}
function updateProbeLabels() {
  if (!probeWords.length || !galaxy || !probeLayer) return;
  galaxy.liveGroup.updateMatrixWorld();
  const mw = galaxy.liveGroup.matrixWorld;
  const w = window.innerWidth, h = window.innerHeight;
  const key = galaxy.morph > 0.5 ? 'umap' : 'pca';
  for (let i = 0; i < probeWords.length; i++) {
    const xyz = probeWords[i][key] || probeWords[i].pca;
    _ppv.set(xyz[0], xyz[1], xyz[2]).applyMatrix4(mw).project(camera);
    const el = probeLabels[i];
    if (!el) continue;
    if (_ppv.z > 1 || _ppv.z < -1) { el.style.display = 'none'; continue; }
    el.style.display = '';
    el.style.left = ((_ppv.x * 0.5 + 0.5) * w) + 'px';
    el.style.top = ((-_ppv.y * 0.5 + 0.5) * h) + 'px';
  }
}
function showProbeInfo(p) {
  let axisHtml = '';
  if (p.axis) {   // B/D：义项倾向读数 + 置信
    const pct = Math.round(p.axis.t * 100);
    const conf = p.axis.conf > 0.5 ? '较确定' : (p.axis.conf > 0.2 ? '中等' : '含糊');
    axisHtml = `<div class="dv">义项倾向　<b style="color:#ffb066">${escHtml(p.axis.s0.split(' ')[0])} ${100 - pct}%</b> · <b style="color:#7fd0ff">${escHtml(p.axis.s1.split(' ')[0])} ${pct}%</b>（${conf}）</div>`;
  }
  selcard.hidden = false;
  selcard.innerHTML = `<div class="tk">${escHtml(p.word)}</div>` +
    `<div class="dv">${p.sense ? escHtml(p.sense) + ' · ' : ''}此处最近的词</div>` +
    `<div class="nb">${(p.neighbors || []).map(escHtml).join(' · ') || '—'}</div>` +
    axisHtml +
    `<div class="row"><button id="sel-close" class="seg">✕ 清除(Esc)</button></div>`;
  const b = document.getElementById('sel-close'); if (b) b.onclick = () => { clearProbe(); selcard.hidden = true; };
}
// 案例：同一个多义词的两个义项，用预算好的落点和两种颜色标出对比。
function showCase(c) {
  if (!c || !c.senses) return;
  const cols = [[1.0, 0.55, 0.3], [0.4, 0.8, 1.0]];
  const words = [];
  c.senses.forEach((s, i) => {
    words.push({ word: c.word, sense: s.name, neighbors: s.neighbors || [s.example],
      pca: s.xyz, umap: s.uvw || s.xyz, color: cols[i % cols.length] });
    // C：把该义项的最近邻底图词作为同色小星标出来，形成「两窝不同的邻居」
    (s.neighbors || []).forEach((nb) => {
      const idx = data.tokens.indexOf(nb);
      if (idx < 0) return;
      const dim = cols[i % cols.length].map((x) => x * 0.6 + 0.16);
      words.push({ word: nb, neighbors: [`${c.word}「${s.name.split(' ')[0]}」义的邻居`],
        pca: [data.pca[idx*3], data.pca[idx*3+1], data.pca[idx*3+2]],
        umap: [data.umap[idx*3], data.umap[idx*3+1], data.umap[idx*3+2]], color: dim });
    });
  });
  renderProbe(words, { trail: false });
  selcard.hidden = false;
  selcard.innerHTML = `<div class="tk">${escHtml(c.word)}</div>` +
    c.senses.map((s, i) => `<div class="dv" style="color:${i ? '#7fd0ff' : '#ffb066'}">▶ ${escHtml(s.name)}<br><span style="color:var(--txt-dim)">${escHtml(s.example)}</span></div>`).join('') +
    `<div class="row"><button id="sel-close" class="seg">✕ 清除(Esc)</button></div>`;
  const b = document.getElementById('sel-close'); if (b) b.onclick = () => { clearProbe(); selcard.hidden = true; };
}
