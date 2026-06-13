// main.js — 启动入口：沉浸式世界 + 语义星系 + 选择性 Bloom(只星核/词星发光) + Vignette
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

// ---- 相机聚焦某聚类（案例库用）----
let focusTarget = null;
let clusterCentroids = null;

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
    for (const obj of [galaxy.points, galaxy.links, galaxy.liveGroup]) obj.scale.setScalar(GALAXY_SCALE);
    galaxy.points.layers.enable(BLOOM_LAYER);   // 词星核进 bloom（发光），但结构靠 base 仍清晰
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

  // 选择性 bloom：先只渲发光层 → 再渲完整场景叠加
  camera.layers.set(BLOOM_LAYER);
  bloomComposer.render();
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
