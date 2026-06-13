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
  uniform float uDim2;          // focus+context 压暗强度 0..1（平滑动画）
  uniform float uTime;

  varying vec3 vColor;
  varying float vAlpha;

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
    float lie = step(0.5, uColorMode);

    // ★失真只用「颜色」表达（Turbo/viridis）。大小/亮度/辉光对所有点一致，
    //   绝不随失真变化——否则"越亮"会被误读成"越可信"(实则相反)。
    vColor = mix(aClusterColor, heatColor(d, uColorMode), lie);
    float tw = 0.92 + 0.08 * sin(uTime * 1.5 + aCluster * 2.0 + aSize * 30.0); // 轻微闪烁(纯装饰)
    gl_PointSize = aSize * uPointScale * uPixelRatio * tw * (320.0 / -mv.z);   // 大小=词频(轻微)，与失真无关

    // focus+context：非高亮簇按 uDim2 平滑压暗（取消选择时 uDim2→0，不会突然变亮）
    float inC = (uHighlight >= 0.0 && abs(aCluster - uHighlight) < 0.5) ? 1.0 : 0.0;
    vAlpha = mix(mix(1.0, 0.07, uDim2), 1.0, inC);
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float r = length(uv);
    if (r > 0.5) discard;
    float halo = smoothstep(0.5, 0.0, r);
    float core = smoothstep(0.18, 0.0, r);
    vec3 col = vColor * (0.7 + 1.6 * core);   // 均匀核提亮(所有点一致)，不随失真
    float a = (halo * 0.55 + core * 0.9) * vAlpha;
    gl_FragColor = vec4(col, a);
  }
`;

// ---- 全局错配连线（高维 vs UMAP 距离错配最大的对）----
const LINK_VERT = /* glsl */`
  attribute vec3 aPca;
  attribute vec3 aUmap;
  attribute float aScore;    // 全局错配度 0..1
  attribute float aCluster;
  uniform float uMorph;
  uniform float uHighlight;
  uniform float uTime;
  uniform float uLinkThresh; // 只显错配 > 阈值的连线
  varying float vScore;
  varying float vAlpha;
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
    vScore = aScore;
    float hi = (aScore >= uLinkThresh) ? 1.0 : 0.0;            // 低于阈值隐藏
    if (uHighlight >= 0.0 && abs(aCluster - uHighlight) >= 0.5) hi *= 0.05;
    vAlpha = hi;
  }
`;
const LINK_FRAG = /* glsl */`
  precision highp float;
  uniform float uOpacity;
  varying float vScore;
  varying float vAlpha;
  ${COLORMAP_GLSL}
  void main() {
    if (vAlpha <= 0.001) discard;
    gl_FragColor = vec4(turbo(vScore) * 1.3, uOpacity * vAlpha * (0.3 + 0.6 * vScore));
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
      uHighlight: { value: -1 }, uDim2: { value: 0 }, uTime: { value: 0 },
    };
    this._dimTarget = 0;
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
    // 每条连线的全局错配度：优先用 pipeline 的 link_score；缺失则用 |dPca-dUmap| 在前端近似
    let score = data.linkScore && data.linkScore.length === m ? data.linkScore.slice() : null;
    if (!score) {
      const dist3 = (a, ia, b, ib) => Math.hypot(a[ia*3]-b[ib*3], a[ia*3+1]-b[ib*3+1], a[ia*3+2]-b[ib*3+2]);
      const dp = [], du = [];
      for (let e = 0; e < m; e++) { const [i,j]=links[e]; dp.push(dist3(data.pca,i,data.pca,j)); du.push(dist3(data.umap,i,data.umap,j)); }
      const n01 = (arr) => { const lo=Math.min(...arr), hi=Math.max(...arr), sp=(hi-lo)||1; return arr.map(v=>(v-lo)/sp); };
      const dpn = n01(dp), dun = n01(du);
      score = dp.map((_, e) => Math.abs(dpn[e] - dun[e]));
    }
    const aPca = new Float32Array(m * 2 * 3);
    const aUmap = new Float32Array(m * 2 * 3);
    const aScore = new Float32Array(m * 2);
    const aClu = new Float32Array(m * 2);
    for (let e = 0; e < m; e++) {
      const [i, j] = links[e];
      for (let s = 0; s < 2; s++) {
        const idx = s === 0 ? i : j;
        const v = e * 2 + s;
        aPca[v*3] = data.pca[idx*3]; aPca[v*3+1] = data.pca[idx*3+1]; aPca[v*3+2] = data.pca[idx*3+2];
        aUmap[v*3] = data.umap[idx*3]; aUmap[v*3+1] = data.umap[idx*3+1]; aUmap[v*3+2] = data.umap[idx*3+2];
        aScore[v] = score[e];
        aClu[v] = data.cluster[idx];
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(aPca, 3));
    g.setAttribute('aPca', new THREE.BufferAttribute(aPca, 3));
    g.setAttribute('aUmap', new THREE.BufferAttribute(aUmap, 3));
    g.setAttribute('aScore', new THREE.BufferAttribute(aScore, 1));
    g.setAttribute('aCluster', new THREE.BufferAttribute(aClu, 1));
    this.linkUniforms = {
      uMorph: this.uniforms.uMorph, uHighlight: this.uniforms.uHighlight,
      uTime: this.uniforms.uTime,
      uOpacity: { value: 0 },   // 默认隐藏，切换时淡入
      uLinkThresh: { value: 0.0 },
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
  setHighlight(clusterId) {
    if (clusterId >= 0) { this.uniforms.uHighlight.value = clusterId; this._dimTarget = 1; }
    else { this._dimTarget = 0; }   // 取消：保留 uHighlight，仅让 uDim2 平滑回 0（不突然变亮）
  }
  toggleLinks(on) { this._linksOn = on; }
  setSpin(on) { this._spin = on; }
  setLinkThreshold(t) { this.linkUniforms.uLinkThresh.value = t; }

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
    // focus+context 压暗平滑过渡（取消选择时不会突然变亮/辉光跳变）
    const u = this.uniforms.uDim2;
    u.value += (this._dimTarget - u.value) * Math.min(1, dt * 5.0);
    if (this._spin !== false) this.points.rotation.y += dt * 0.015;   // 选中时暂停自转
    this.links.rotation.y = this.points.rotation.y;
    this.liveGroup.rotation.y = this.points.rotation.y;
  }

  get morph() { return this._morph; }

  // 切换数据集时彻底清理，避免内存泄漏
  dispose() {
    this.liveGroup.traverse((c) => { c.geometry && c.geometry.dispose(); c.material && c.material.dispose(); });
    this.scene.remove(this.points); this.points.geometry.dispose(); this.material.dispose();
    this.scene.remove(this.links); this.links.geometry.dispose(); this.linkMat.dispose();
    this.scene.remove(this.liveGroup);
  }
}
