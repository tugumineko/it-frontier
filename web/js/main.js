// main.js — 启动入口：场景 / 相机 / 控制 / Bloom 后处理 / 动画循环
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { loadGalaxy } from './data.js';
import { Galaxy } from './galaxy.js';
import { setupUI } from './ui.js';

const app = document.getElementById('app');

// ---- 渲染器 ----
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x03040a, 1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
app.appendChild(renderer.domElement);

// ---- 场景 / 相机 ----
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x03040a, 0.0011);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 4000);
camera.position.set(0, 26, 210);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.minDistance = 5;
controls.maxDistance = 1200;
controls.autoRotate = true;        // 缓慢自动环绕，开场更"高级"
controls.autoRotateSpeed = 0.25;

// ---- Bloom 后处理（发光星海的关键）----
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.95,   // strength
  0.5,    // radius
  0.12    // threshold（只让亮核发光）
);
composer.addPass(bloom);
composer.addPass(new OutputPass());

addStardust(scene);

// ---- 相机聚焦某聚类（案例库用）----
let focusTarget = null;
let clusterCentroids = null;

function makeCentroids(data) {
  const clusters = data.meta.clusters || [];
  const acc = clusters.map(() => ({ pca: [0,0,0], umap: [0,0,0], n: 0 }));
  for (let i = 0; i < data.n; i++) {
    const c = data.cluster[i] | 0;
    if (!acc[c]) continue;
    for (let j = 0; j < 3; j++) {
      acc[c].pca[j] += data.pca[i*3+j];
      acc[c].umap[j] += data.umap[i*3+j];
    }
    acc[c].n++;
  }
  acc.forEach(a => { if (a.n) for (const k of ['pca','umap']) for (let j=0;j<3;j++) a[k][j]/=a.n; });
  return acc;
}

function focusCluster(id) {
  if (id == null || !clusterCentroids) { focusTarget = null; controls.autoRotate = true; return; }
  const c = clusterCentroids[id]; if (!c) return;
  const p = galaxy.morph > 0.5 ? c.umap : c.pca;
  focusTarget = { pos: new THREE.Vector3(p[0], p[1], p[2]), dist: 64 };
  controls.autoRotate = false;
}

// ---- 主流程 ----
let galaxy;
(async () => {
  try {
    const data = await loadGalaxy();
    galaxy = new Galaxy(scene, data);
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

// ---- 背景星尘 ----
function addStardust(scene) {
  const N = 2000;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = 600 + Math.random() * 1600;
    const t = Math.random() * Math.PI * 2;
    const p = Math.acos(2 * Math.random() - 1);
    pos[i*3] = r * Math.sin(p) * Math.cos(t);
    pos[i*3+1] = r * Math.sin(p) * Math.sin(t);
    pos[i*3+2] = r * Math.cos(p);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({ color: 0x3a4a72, size: 1.1, sizeAttenuation: true, transparent: true, opacity: 0.55 });
  scene.add(new THREE.Points(g, m));
}

// ---- 自适应 ----
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});
