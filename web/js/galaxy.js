// galaxy.js — 星系渲染核心（Three.js）
//
// 设计要点（图形侧）：
//   1) 单个 THREE.Points 渲染数万词向量点；PCA / UMAP 两套坐标都上 GPU，用 uMorph 在着色器里 mix，
//      "从老实的 PCA 渐变到戏精的 UMAP"是 GPU 端实时插值，丝滑且零 CPU 开销。
//   2) 着色两种：语义聚类色 / 失真测谎色（蓝→红）。
//   3) HDR 亮核 + 软晕 + 轻微 curl 漂移 + 呼吸闪烁 → 配合 UnrealBloom 出"会发光的星海"。
//   4) Links（意大利面）：真·高维近邻连线。PCA 里短、UMAP 里被扯成横跨全图的长线，
//      用"边结构"展示"本该相邻的概念被 UMAP 拆散" —— 这是热力图给不了的东西。

import * as THREE from 'three';

// 感知均匀配色（标量场/热力的正确选择，禁用 jet/rainbow）。
//  - Turbo: Google 的 Apache-2.0 数值拟合（saturate→clamp 适配 GLSL ES）。沉浸醒目，红=高失真。
//  - viridis: BIDS 的 CC0 数值拟合。亮度单调、暗背景发光感、严谨。
// 二者都是公开的多项式数值近似（算法/常数，非创作内容）。
const COLORMAP_GLSL = /* glsl */`
  vec3 turbo(float x){
    x = clamp(x, 0.0, 1.0);
    const vec4 kR4 = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
    const vec4 kG4 = vec4(0.09140261, 2.19418839,   4.84296658, -14.18503333);
    const vec4 kB4 = vec4(0.10667330,12.64194608, -60.58204836, 110.36276771);
    const vec2 kR2 = vec2(-152.94239396, 59.28637943);
    const vec2 kG2 = vec2(   4.27729857,  2.82956604);
    const vec2 kB2 = vec2( -89.90310912, 27.34824973);
    vec4 v4 = vec4(1.0, x, x*x, x*x*x);
    vec2 v2 = v4.zw * v4.z;
    return clamp(vec3(dot(v4,kR4)+dot(v2,kR2), dot(v4,kG4)+dot(v2,kG2), dot(v4,kB4)+dot(v2,kB2)), 0.0, 1.0);
  }
  vec3 viridis(float t){ t=clamp(t,0.0,1.0);
    const vec3 c0=vec3(0.2777273,0.0054073,0.3340998);
    const vec3 c1=vec3(0.1050930,1.4046135,1.3845902);
    const vec3 c2=vec3(-0.3308618,0.2148476,0.0950952);
    const vec3 c3=vec3(-4.6342305,-5.7991010,-19.3324410);
    const vec3 c4=vec3(6.2282699,14.1799334,56.6905526);
    const vec3 c5=vec3(4.7763850,-13.7451454,-65.3530326);
    const vec3 c6=vec3(-5.4354559,4.6458526,26.3124352);
    return clamp(c0+t*(c1+t*(c2+t*(c3+t*(c4+t*(c5+t*c6))))), 0.0, 1.0);
  }
  // 失真配色：uColorMode 0=聚类 1=Turbo 2=viridis
  vec3 heatColor(float d, float mode){ return mode < 1.5 ? turbo(d) : viridis(d); }
`;

const VERT = /* glsl */`
  attribute vec3 aPca;
  attribute vec3 aUmap;
  attribute vec3 aClusterColor;
  attribute float aDistortion;
  attribute float aCluster;
  attribute float aSize;

  uniform float uMorph;
  uniform float uColorMode;     // 0=聚类色 1=Turbo热力 2=viridis热力
  uniform float uPointScale;
  uniform float uPixelRatio;
  uniform float uHighlight;
  uniform float uTime;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vBoost;

  ${COLORMAP_GLSL}

  vec3 drift(vec3 p) {
    float t = uTime * 0.25;
    return vec3(
      sin(p.y * 0.06 + t) + cos(p.z * 0.05 - t),
      sin(p.z * 0.06 + t * 1.1) + cos(p.x * 0.05 - t),
      sin(p.x * 0.06 + t * 0.9) + cos(p.y * 0.05 - t)
    ) * 0.6;
  }

  void main() {
    vec3 pos = mix(aPca, aUmap, uMorph) + drift(aPca);
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    float d = clamp(aDistortion, 0.0, 1.0);
    float lie = step(0.5, uColorMode);          // 0 聚类模式 / 1 任一热力模式

    // 失真同时驱动：颜色 + 大小 + 亮度 → 高失真词=报警的红巨星
    vColor = mix(aClusterColor, heatColor(d, uColorMode), lie);
    float tw = 0.85 + 0.15 * sin(uTime * 1.5 + aCluster * 2.0 + aSize * 30.0);
    float sizeMul = mix(1.0, 2.4, d * lie);     // 热力模式下高失真更大
    gl_PointSize = aSize * uPointScale * uPixelRatio * tw * sizeMul * (320.0 / -mv.z);
    vBoost = mix(1.0, 0.55 + d * 1.7, lie);     // 热力模式下高失真更亮、低失真压暗

    float hi = 1.0;
    if (uHighlight >= 0.0) hi = abs(aCluster - uHighlight) < 0.5 ? 1.0 : 0.06;
    vAlpha = hi;
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vBoost;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float r = length(uv);
    if (r > 0.5) discard;
    float halo = smoothstep(0.5, 0.0, r);
    float core = smoothstep(0.18, 0.0, r);
    vec3 col = vColor * (0.7 + 1.6 * core) * vBoost;   // 核提亮 + 失真亮度
    float a = (halo * 0.55 + core * 0.9) * vAlpha;
    gl_FragColor = vec4(col, a);
  }
`;

// ---- 意大利面连线 ----
const LINK_VERT = /* glsl */`
  attribute vec3 aPca;
  attribute vec3 aUmap;
  attribute float aDistortion;
  attribute float aCluster;
  uniform float uMorph;
  uniform float uHighlight;
  uniform float uTime;
  varying float vDist;
  varying float vAlpha;
  // 与星点相同的漂移，保证连线端点贴住星星
  vec3 drift(vec3 p) {
    float t = uTime * 0.25;
    return vec3(
      sin(p.y * 0.06 + t) + cos(p.z * 0.05 - t),
      sin(p.z * 0.06 + t * 1.1) + cos(p.x * 0.05 - t),
      sin(p.x * 0.06 + t * 0.9) + cos(p.y * 0.05 - t)
    ) * 0.6;
  }
  void main() {
    vec3 pos = mix(aPca, aUmap, uMorph) + drift(aPca);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    vDist = aDistortion;
    float hi = 1.0;
    if (uHighlight >= 0.0) hi = abs(aCluster - uHighlight) < 0.5 ? 1.0 : 0.04;
    vAlpha = hi;
  }
`;
const LINK_FRAG = /* glsl */`
  precision highp float;
  uniform float uOpacity;
  varying float vDist;
  varying float vAlpha;
  ${COLORMAP_GLSL}
  void main() {
    gl_FragColor = vec4(turbo(vDist) * 1.2, uOpacity * vAlpha * (0.25 + 0.6 * vDist));
  }
`;

export class Galaxy {
  constructor(scene, data) {
    this.scene = scene;
    this.data = data;
    this._morphTarget = 0;
    this._morph = 0;
    this._time = 0;

    // ---- 星点 ----
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data.pca, 3));
    g.setAttribute('aPca', new THREE.BufferAttribute(data.pca, 3));
    g.setAttribute('aUmap', new THREE.BufferAttribute(data.umap, 3));
    g.setAttribute('aClusterColor', new THREE.BufferAttribute(data.clusterColor, 3));
    g.setAttribute('aDistortion', new THREE.BufferAttribute(data.distortion, 1));
    g.setAttribute('aCluster', new THREE.BufferAttribute(data.cluster, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(data.size, 1));
    g.computeBoundingSphere();

    this.uniforms = {
      uMorph: { value: 0 }, uColorMode: { value: 0 },
      uPointScale: { value: 2.0 }, uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      uHighlight: { value: -1 }, uTime: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);

    // ---- 意大利面连线 ----
    this._buildLinks(data);

    // ---- 实时输入返回的亮星 ----
    this.liveGroup = new THREE.Group();
    scene.add(this.liveGroup);
  }

  _buildLinks(data) {
    const links = data.links || [];
    const m = links.length;
    const aPca = new Float32Array(m * 2 * 3);
    const aUmap = new Float32Array(m * 2 * 3);
    const aDist = new Float32Array(m * 2);
    const aClu = new Float32Array(m * 2);
    for (let e = 0; e < m; e++) {
      const [i, j] = links[e];
      for (let s = 0; s < 2; s++) {
        const idx = s === 0 ? i : j;
        const v = e * 2 + s;
        aPca[v*3] = data.pca[idx*3]; aPca[v*3+1] = data.pca[idx*3+1]; aPca[v*3+2] = data.pca[idx*3+2];
        aUmap[v*3] = data.umap[idx*3]; aUmap[v*3+1] = data.umap[idx*3+1]; aUmap[v*3+2] = data.umap[idx*3+2];
        aDist[v] = data.distortion[idx];
        aClu[v] = data.cluster[idx];
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(aPca, 3));
    g.setAttribute('aPca', new THREE.BufferAttribute(aPca, 3));
    g.setAttribute('aUmap', new THREE.BufferAttribute(aUmap, 3));
    g.setAttribute('aDistortion', new THREE.BufferAttribute(aDist, 1));
    g.setAttribute('aCluster', new THREE.BufferAttribute(aClu, 1));
    this.linkUniforms = {
      uMorph: this.uniforms.uMorph, uHighlight: this.uniforms.uHighlight,
      uTime: this.uniforms.uTime,
      uOpacity: { value: 0 },   // 默认隐藏，切换时淡入
    };
    this.linkMat = new THREE.ShaderMaterial({
      uniforms: this.linkUniforms, vertexShader: LINK_VERT, fragmentShader: LINK_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.links = new THREE.LineSegments(g, this.linkMat);
    this.links.frustumCulled = false;
    this._linksOn = false;
    this.scene.add(this.links);
  }

  setLayoutTarget(t) { this._morphTarget = Math.max(0, Math.min(1, t)); }
  setLayoutImmediate(t) { this._morphTarget = this._morph = t; this.uniforms.uMorph.value = t; }
  setColorMode(mode) { // 'cluster' | 'turbo'/'lie' | 'viridis'
    this.uniforms.uColorMode.value = mode === 'viridis' ? 2 : (mode === 'cluster' ? 0 : 1);
  }
  setHighlight(clusterId) { this.uniforms.uHighlight.value = clusterId; }
  toggleLinks(on) { this._linksOn = on; }

  setLivePoints(points) {
    this.liveGroup.clear();
    if (!points || !points.length) return;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(points.length * 3);
    const col = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const xyz = this._morph > 0.5 ? p.umap : p.pca;
      pos[i*3] = xyz[0]; pos[i*3+1] = xyz[1]; pos[i*3+2] = xyz[2];
      const d = p.distortion ?? 0;
      col[i*3] = 1.0; col[i*3+1] = 1.0 - 0.7 * d; col[i*3+2] = 1.0 - 0.9 * d;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({ size: 8, sizeAttenuation: true, vertexColors: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.liveGroup.add(new THREE.Points(g, mat));
  }

  update(dt) {
    this._time += dt;
    this.uniforms.uTime.value = this._time;
    if (Math.abs(this._morph - this._morphTarget) > 1e-4) {
      this._morph += (this._morphTarget - this._morph) * Math.min(1, dt * 2.2);
      this.uniforms.uMorph.value = this._morph;
    }
    // 连线淡入淡出
    const target = this._linksOn ? 1 : 0;
    const o = this.linkUniforms.uOpacity;
    o.value += (target - o.value) * Math.min(1, dt * 4.0);
    this.points.rotation.y += dt * 0.015;
    this.links.rotation.y = this.points.rotation.y;
    this.liveGroup.rotation.y = this.points.rotation.y;
  }

  get morph() { return this._morph; }
}
