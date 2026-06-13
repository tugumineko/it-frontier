// main.js — 启动入口：沉浸式世界 + 星系 + 相机 + Bloom/Vignette 后处理
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { loadGalaxy } from './data.js';
import { Galaxy } from './galaxy.js';
import { World } from './world.js';
import { setupUI } from './ui.js';

const GALAXY_SCALE = 2.6;   // 把语义星系放大，让相机能"置身其中"

const app = document.getElementById('app');

// ---- 渲染器 ----
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x02030a, 1);
renderer.toneMapping = THREE.ReinhardToneMapping;   // r160 选择性 bloom 官方用值，避免过曝
renderer.toneMappingExposure = 1.0;
app.appendChild(renderer.domElement);

// ---- 场景 / 相机 ----
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 8000);
camera.position.set(0, 38, 205);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 2;
controls.maxDistance = 1500;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.22;

// ---- 沉浸式世界（星云穹顶 + 银河带星野 + 星云云团）----
const world = new World(scene);

// ---- Bloom + Vignette 后处理 ----
// 用 HalfFloat 渲染目标承载 >1 的 HDR 值（否则被 clamp，bloom 阈值失效）。
const rt = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { type: THREE.HalfFloatType });
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.4,    // strength（Step1 止血：从 0.9 降到 0.4）
  0.4,    // radius
  0.8     // threshold（从 0.2 抬到 0.8：只让最亮的星核发光，背景/星云不过曝洗白）
);
composer.addPass(bloom);
const vignette = new ShaderPass(VignetteShader);
vignette.uniforms.offset.value = 1.05;
vignette.uniforms.darkness.value = 1.15;
composer.addPass(vignette);
composer.addPass(new OutputPass());

// ---- 相机聚焦某聚类（案例库用）----
let focusTarget = null;
let clusterCentroids = null;

function makeCentroids(data) {
  const clusters = data.meta.clusters || [];
  const acc = clusters.map(() => ({ pca: [0,0,0], umap: [0,0,0], n: 0 }));
  for (let i = 0; i < data.n; i++) {
    const c = data.cluster[i] | 0;
    if (!acc[c]) continue;
    for (let j = 0; j < 3; j++) { acc[c].pca[j] += data.pca[i*3+j]; acc[c].umap[j] += data.umap[i*3+j]; }
    acc[c].n++;
  }
  acc.forEach(a => { if (a.n) for (const k of ['pca','umap']) for (let j=0;j<3;j++) a[k][j]/=a.n; });
  return acc;
}

function focusCluster(id) {
  if (id == null || !clusterCentroids) { focusTarget = null; controls.autoRotate = true; return; }
  const c = clusterCentroids[id]; if (!c) return;
  const p = galaxy.morph > 0.5 ? c.umap : c.pca;
  focusTarget = { pos: new THREE.Vector3(p[0], p[1], p[2]).multiplyScalar(GALAXY_SCALE), dist: 90 };
  controls.autoRotate = false;
}

// ---- 主流程 ----
let galaxy;
(async () => {
  try {
    const data = await loadGalaxy();
    galaxy = new Galaxy(scene, data);
    // 放大语义星系，让相机置身其中
    for (const obj of [galaxy.points, galaxy.links, galaxy.liveGroup]) obj.scale.setScalar(GALAXY_SCALE);
    clusterCentroids = makeCentroids(data);
    setupUI({ galaxy, data, focus: focusCluster });
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

  world.update(dt);
  if (galaxy) galaxy.update(dt);

  if (focusTarget) {
    controls.target.lerp(focusTarget.pos, dt * 1.8);
    const dir = camera.position.clone().sub(controls.target).normalize();
    const want = focusTarget.pos.clone().add(dir.multiplyScalar(focusTarget.dist));
    camera.position.lerp(want, dt * 1.8);
  }

  controls.update();
  composer.render();
}
animate();

// ---- 自适应 ----
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});
