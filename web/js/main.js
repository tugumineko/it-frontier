// main.js — 代码符号语义探索器：空场 → 分析代码 → occurrence 星海 + 代码面板 + 判读卡三视图联动。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { normalizeGalaxy } from './data.js';
import { Galaxy } from './galaxy.js';
import { World, BLOOM_LAYER } from './world.js';
import { setupUI } from './ui.js';

const GALAXY_SCALE = 2.6;
const app = document.getElementById('app');

// ---- 渲染器 / 场景 / 相机 ----
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x02030a, 1);
renderer.toneMapping = THREE.ReinhardToneMapping;
renderer.toneMappingExposure = 1.0;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 8000);
camera.position.set(0, 90, 340);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 2;
controls.maxDistance = 1600;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.18;

const world = new World(scene);
world.bakeBackground(renderer);

// ---- 选择性 Bloom（双 composer，仅发光层进 bloom）----
const bloomComposer = new EffectComposer(
  renderer, new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { type: THREE.HalfFloatType }));
bloomComposer.renderToScreen = false;
bloomComposer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.75, 0.6, 0.0);
bloomComposer.addPass(bloomPass);
const mixPass = new ShaderPass(new THREE.ShaderMaterial({
  uniforms: { baseTexture: { value: null }, bloomTexture: { value: bloomComposer.renderTarget2.texture } },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `uniform sampler2D baseTexture; uniform sampler2D bloomTexture; varying vec2 vUv;
    void main(){ gl_FragColor = texture2D(baseTexture,vUv) + vec4(1.0)*texture2D(bloomTexture,vUv); }`,
}), 'baseTexture');
mixPass.needsSwap = true;
const vignette = new ShaderPass(VignetteShader);
vignette.uniforms.offset.value = 1.1; vignette.uniforms.darkness.value = 1.15;
const finalComposer = new EffectComposer(
  renderer, new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { type: THREE.HalfFloatType }));
finalComposer.addPass(new RenderPass(scene, camera));
finalComposer.addPass(mixPass);
finalComposer.addPass(vignette);
finalComposer.addPass(new OutputPass());

// ---- 相机缓动飞行 ----
let homeState = null, flight = null;
const easeInOutCubic = (k) => (k < 0.5 ? 4*k*k*k : 1 - Math.pow(-2*k+2, 3)/2);
function captureState() { return { pos: camera.position.clone(), target: controls.target.clone() }; }
function flyToPoint(toPos, dist) {
  const fromP = camera.position.clone(), fromT = controls.target.clone();
  const dir = fromP.clone().sub(fromT).normalize();
  flight = { t0: performance.now(), dur: 650, fromP, toP: toPos.clone().add(dir.multiplyScalar(dist)), fromT, toT: toPos.clone() };
  controls.enabled = false;
}
function flyToState(s) {
  flight = { t0: performance.now(), dur: 650, fromP: camera.position.clone(), toP: s.pos.clone(),
             fromT: controls.target.clone(), toT: s.target.clone() };
  controls.enabled = false;
}
function cancelFlight() { if (flight) { flight = null; controls.enabled = true; } }

// ---- 状态 ----
let galaxy = null, data = null, rawData = null, uiApi = null;
let selected = -1;
const _v = new THREE.Vector3(), _pv = new THREE.Vector3();
const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const codeView = document.getElementById('code-view');
const selcard = document.getElementById('selcard');
const modeEl = document.getElementById('mode');
const tooltip = document.getElementById('tooltip');

function occWorldPos(i) {
  const d = galaxy.data, m = galaxy.morph;
  return _v.set(d.pca[i*3]*(1-m)+d.umap[i*3]*m, d.pca[i*3+1]*(1-m)+d.umap[i*3+1]*m, d.pca[i*3+2]*(1-m)+d.umap[i*3+2]*m)
    .applyMatrix4(galaxy.points.matrixWorld);
}

// 用一份分析数据重建星海（occurrence 点云）。
function applyGalaxyObj(raw) {
  const colorBy = galaxy ? galaxy._colorBy : 'sense';
  if (galaxy) galaxy.dispose();
  rawData = raw;
  data = normalizeGalaxy(raw);
  galaxy = new Galaxy(scene, data);
  for (const o of [galaxy.points, galaxy.links, galaxy.liveGroup]) { o.scale.setScalar(GALAXY_SCALE); o.renderOrder = 3; }
  galaxy.points.layers.enable(BLOOM_LAYER);
  galaxy.setLayoutImmediate(1);          // 默认 UMAP（义项分得更开）
  galaxy.setColorBy(colorBy);
}

function setDataset(raw) {
  applyGalaxyObj(raw);
  cancelFlight();
  deselectOcc();
  renderCodeView(raw.meta?.code || '', raw.occ || []);
  if (uiApi) uiApi.refresh();
  controls.autoRotate = true;
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
  get hasData() { return !!data; },
  setWorldIntensity: (v) => world.setWorldIntensity(v),
  setBackgroundVisible: (on) => { scene.background = on ? (world.bgTexture || null) : null; },
  setBloomStrength: (v) => { bloomPass.strength = v; },
  setColorBy: (mode) => { if (galaxy) galaxy.setColorBy(mode); },
  exportData: () => { if (rawData) downloadJSON(rawData, `code-galaxy-${Date.now()}.json`); },
  importData: (obj) => setDataset(obj),
  // 分析一段代码：调后端 /api/analyze，一次拿回 occurrence 向量 + agent 判读，建星海 + 代码面板。
  analyze: async (code) => {
    const res = await fetch('/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.error) throw new Error(out.error || ('HTTP ' + res.status));
    setDataset(out);
    return { count: out.occ.length, senses: out.meta.clusters.length };
  },
};

// ---- 代码面板：渲染带行号 + 可点符号方框 ----
function renderCodeView(code, occ) {
  if (!codeView) return;
  const byLine = {};
  occ.forEach((o) => { (byLine[o.line] || (byLine[o.line] = [])).push(o); });
  const lines = code.split('\n');
  let html = '';
  lines.forEach((line, li) => {
    const no = li + 1;
    const occs = (byLine[no] || []).slice().sort((a, b) => a.col - b.col);
    const re = /[A-Za-z_]\w*/g; let m, cur = 0, h = '';
    while ((m = re.exec(line))) {
      const o = occs.find((x) => x.col === m.index);
      h += escHtml(line.slice(cur, m.index));
      h += o ? `<span class="sym s${o.senseId}" data-occ="${o.id}">${escHtml(m[0])}</span>` : escHtml(m[0]);
      cur = m.index + m[0].length;
    }
    h += escHtml(line.slice(cur));
    html += `<div class="cl" data-line="${no}"><span class="ln">${no}</span><code>${h || ' '}</code></div>`;
  });
  codeView.innerHTML = html;
  codeView.querySelectorAll('.sym').forEach((s) => { s.onclick = () => selectOcc(+s.dataset.occ, false); });
  // 同步符号颜色到义项色
  if (data && data.meta.clusters) {
    data.meta.clusters.forEach((c) => {
      const rgb = (c.color || [0.6, 0.7, 1]).map((v) => Math.round(v * 255));
      codeView.querySelectorAll(`.sym.s${c.id}`).forEach((e) => { e.style.setProperty('--sc', `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`); });
    });
  }
}

// ---- 联动核心：选中一个 occurrence，三视图同步 ----
function selectOcc(occId, fly) {
  if (!data || !data.occ[occId]) return;
  selected = occId;
  const o = data.occ[occId];
  galaxy.setHighlight(o.senseId);          // 星海高亮同义项簇、压暗其余
  if (galaxy.setSpin) galaxy.setSpin(false);
  galaxy.highlightNeighbors(occId, o.neighbors || []);   // 连选中点→最近邻
  // 代码面板高亮
  codeView?.querySelectorAll('.sym.hot, .cl.hot-line').forEach((e) => e.classList.remove('hot', 'hot-line'));
  const span = codeView?.querySelector(`.sym[data-occ="${occId}"]`);
  if (span) { span.classList.add('hot'); span.closest('.cl')?.classList.add('hot-line'); span.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  renderJudgeCard(o);
  if (fly) flyToPoint(occWorldPos(occId).clone(), 60);
  setMode(`选中：${o.symbol} · ${o.sense}`);
}
function deselectOcc() {
  selected = -1;
  if (galaxy) { galaxy.setHighlight(-1); galaxy.clearProbe(); if (galaxy.setSpin) galaxy.setSpin(true); }
  codeView?.querySelectorAll('.sym.hot, .cl.hot-line').forEach((e) => e.classList.remove('hot', 'hot-line'));
  if (selcard) selcard.hidden = true;
}
function renderJudgeCard(o) {
  if (!selcard) return;
  const conf = (o.confidence != null) ? `<span class="conf">置信 ${Math.round(o.confidence * 100)}%</span>` : '';
  const ev = (o.evidence || []).map((e) => `<div class="ev">${escHtml(e)}</div>`).join('');
  const nb = (o.neighbors || []).map((nid) => {
    const n = data.occ[nid]; if (!n) return '';
    return `<span class="nb-i s${n.senseId}" data-occ="${nid}">${escHtml(n.symbol)}·${escHtml((n.sense || '').split(' ')[0])}</span>`;
  }).join('');
  selcard.hidden = false;
  selcard.innerHTML = `<div class="tk">${escHtml(o.symbol)}<span class="lntag">第 ${o.line} 行</span></div>` +
    `<div class="dv sense">义项：<b>${escHtml(o.sense)}</b> ${conf}</div>` +
    (ev ? `<div class="sub">agent 依据</div>${ev}` : '') +
    (nb ? `<div class="sub">最近邻（同集合内）</div><div class="nbs">${nb}</div>` : '') +
    `<div class="row"><button id="sel-fly" class="seg">🎯 飞入</button><button id="sel-close" class="seg">✕ (Esc)</button></div>`;
  selcard.querySelectorAll('.nb-i').forEach((e) => { e.onclick = () => selectOcc(+e.dataset.occ, false); });
  const fb = document.getElementById('sel-fly'); if (fb) fb.onclick = () => flyToPoint(occWorldPos(o.id).clone(), 55);
  const cb = document.getElementById('sel-close'); if (cb) cb.onclick = () => deselectOcc();
}

function setMode(text) { if (modeEl) (modeEl.firstChild ? modeEl.firstChild.textContent = text : modeEl.textContent = text), modeEl.classList.toggle('focused', !text.startsWith('自由')); }

// ---- 星海拾取 ----
function pickAt(mx, my) {
  if (!galaxy) return -1;
  galaxy.points.updateMatrixWorld();
  const d = galaxy.data, m = galaxy.morph, w = window.innerWidth, h = window.innerHeight, mw = galaxy.points.matrixWorld;
  let best = -1, bestD = 18 * 18;
  for (let i = 0; i < d.n; i++) {
    _pv.set(d.pca[i*3]*(1-m)+d.umap[i*3]*m, d.pca[i*3+1]*(1-m)+d.umap[i*3+1]*m, d.pca[i*3+2]*(1-m)+d.umap[i*3+2]*m)
      .applyMatrix4(mw).project(camera);
    if (_pv.z > 1) continue;
    const sx = (_pv.x*0.5+0.5)*w, sy = (-_pv.y*0.5+0.5)*h, dx = sx-mx, dy = sy-my, dd = dx*dx+dy*dy;
    if (dd < bestD) { bestD = dd; best = i; }
  }
  return best;
}

// ---- 启动：空场，等用户分析 ----
uiApi = setupUI(ctx);
controls.update();
homeState = captureState();
setMode('自由观察');
document.getElementById('loading').classList.add('hidden');

// ---- 动画循环 ----
let last = performance.now();
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
  world.update(dt, camera);
  if (galaxy) galaxy.update(dt);
  if (flight) {
    const k = easeInOutCubic(Math.min(1, (now - flight.t0) / flight.dur));
    camera.position.lerpVectors(flight.fromP, flight.toP, k);
    controls.target.lerpVectors(flight.fromT, flight.toT, k);
    if (k >= 1) { flight = null; controls.enabled = true; }
  }
  controls.update();
  const bg = scene.background;
  scene.background = null;
  camera.layers.set(BLOOM_LAYER); bloomComposer.render();
  scene.background = bg;
  camera.layers.set(0); finalComposer.render();
}
animate();

window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setSize(w, h); bloomComposer.setSize(w, h); finalComposer.setSize(w, h);
});

// ---- 星海交互：拖拽=旋转(不选择)，轻点=选 occurrence，双击=飞入，ESC=复位 ----
const el = renderer.domElement;
let isOrbiting = false;
controls.addEventListener('start', () => { isOrbiting = true; tooltip.hidden = true; });
controls.addEventListener('end', () => { requestAnimationFrame(() => { isOrbiting = false; }); });

let hoverX = 0, hoverY = 0, hoverPending = false, autoStopped = false;
el.addEventListener('pointermove', (e) => { hoverX = e.clientX; hoverY = e.clientY; if (!hoverPending) { hoverPending = true; requestAnimationFrame(doHover); } });
function doHover() {
  hoverPending = false;
  if (!galaxy || isOrbiting || flight) { tooltip.hidden = true; el.style.cursor = isOrbiting ? 'grabbing' : 'grab'; return; }
  const i = pickAt(hoverX, hoverY);
  if (i < 0) { tooltip.hidden = true; el.style.cursor = 'grab'; return; }
  el.style.cursor = 'pointer';
  const o = data.occ[i];
  tooltip.hidden = false;
  tooltip.style.left = (hoverX + 12) + 'px'; tooltip.style.top = hoverY + 'px';
  tooltip.innerHTML = `<div class="tk">${escHtml(o.symbol)}</div><div class="dv">${escHtml(o.sense)} · 第${o.line}行</div>`;
}
el.addEventListener('pointerleave', () => { tooltip.hidden = true; });

let down = null;
el.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  if (!autoStopped) { controls.autoRotate = false; autoStopped = true; }
  cancelFlight();
  try { el.setPointerCapture(e.pointerId); } catch (_) {}
  down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
});
el.addEventListener('pointerup', (e) => {
  if (!down || e.pointerId !== down.id) return;
  const dist = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = performance.now() - down.t;
  const TH = e.pointerType === 'mouse' ? 5 : 10; down = null;
  if (isOrbiting || dist > TH || dt > 300) return;
  const i = pickAt(e.clientX, e.clientY);
  if (i < 0) { deselectOcc(); return; }
  selectOcc(i, false);
});
el.addEventListener('dblclick', (e) => { const i = pickAt(e.clientX, e.clientY); if (i >= 0) selectOcc(i, true); });

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (selected >= 0) deselectOcc();
  else if (homeState && galaxy) { if (galaxy.setSpin) galaxy.setSpin(true); controls.autoRotate = true; flyToState(homeState); setMode('自由观察'); }
});

const hintbar = document.getElementById('hintbar');
const hintToggle = document.getElementById('hint-toggle');
let hintTimer = setTimeout(() => hintbar.classList.add('faded'), 6000);
hintToggle.onclick = () => {
  clearTimeout(hintTimer);
  hintbar.classList.toggle('faded');
  if (!hintbar.classList.contains('faded')) hintTimer = setTimeout(() => hintbar.classList.add('faded'), 6000);
};

// 暴露给 ui 的选择跳转（按符号名定位第一个 occurrence）
ctx.selectOcc = (id) => selectOcc(id, false);
