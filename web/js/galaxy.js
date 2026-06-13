// galaxy.js — 星系渲染核心（Three.js）
//
// 设计要点（图形侧，你熟）：
//   1) 用单个 THREE.Points + BufferGeometry 渲染数万词向量点，开销低。
//   2) PCA / UMAP 两套坐标都作为顶点属性传上 GPU，用 uMorph 在着色器里 mix，
//      所以"从老实的 PCA 渐变到戏精的 UMAP"是 GPU 端实时插值，丝滑且零 CPU 开销。
//   3) 着色有两种：语义聚类色 / 失真测谎色（蓝→红）。用 uColorMode 在着色器里切。
//   4) 加性混合 + 软圆点，做出"发光星海"，不依赖后处理 Bloom，保证离线稳定。

import * as THREE from 'three';

const VERT = /* glsl */`
  attribute vec3 aPca;
  attribute vec3 aUmap;
  attribute vec3 aClusterColor;
  attribute float aDistortion;   // 0..1，越高 = UMAP 越在这里"撒谎"
  attribute float aCluster;
  attribute float aSize;

  uniform float uMorph;          // 0 = PCA, 1 = UMAP
  uniform float uColorMode;      // 0 = 聚类色, 1 = 测谎色
  uniform float uPointScale;
  uniform float uPixelRatio;
  uniform float uHighlight;      // 高亮的聚类 id；-1 = 不高亮

  varying vec3 vColor;
  varying float vAlpha;

  // 失真 → 颜色：蓝(可信) → 青 → 黄 → 红(编造)
  vec3 lieColor(float d) {
    vec3 cBlue = vec3(0.17, 0.42, 1.0);
    vec3 cCyan = vec3(0.13, 0.82, 0.78);
    vec3 cYellow = vec3(1.0, 0.88, 0.30);
    vec3 cRed = vec3(1.0, 0.23, 0.23);
    if (d < 0.33) return mix(cBlue, cCyan, d / 0.33);
    if (d < 0.66) return mix(cCyan, cYellow, (d - 0.33) / 0.33);
    return mix(cYellow, cRed, (d - 0.66) / 0.34);
  }

  void main() {
    vec3 pos = mix(aPca, aUmap, uMorph);
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    // 透视衰减的点尺寸
    gl_PointSize = aSize * uPointScale * uPixelRatio * (300.0 / -mv.z);

    vColor = mix(aClusterColor, lieColor(aDistortion), uColorMode);

    // 高亮某个聚类：其余点压暗，让"案例"聚焦
    float hi = 1.0;
    if (uHighlight >= 0.0) {
      hi = abs(aCluster - uHighlight) < 0.5 ? 1.0 : 0.08;
    }
    vAlpha = hi;
  }
`;

const FRAG = /* glsl */`
  precision mediump float;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    // 软圆点：到中心的距离做羽化，外圈透明
    vec2 uv = gl_PointCoord - vec2(0.5);
    float r = length(uv);
    if (r > 0.5) discard;
    float glow = smoothstep(0.5, 0.0, r);
    gl_FragColor = vec4(vColor, glow * vAlpha);
  }
`;

export class Galaxy {
  constructor(scene, data) {
    this.scene = scene;
    this.data = data;
    this._morphTarget = 0;
    this._morph = 0;

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data.pca, 3)); // 占位，真正位置在着色器算
    g.setAttribute('aPca', new THREE.BufferAttribute(data.pca, 3));
    g.setAttribute('aUmap', new THREE.BufferAttribute(data.umap, 3));
    g.setAttribute('aClusterColor', new THREE.BufferAttribute(data.clusterColor, 3));
    g.setAttribute('aDistortion', new THREE.BufferAttribute(data.distortion, 1));
    g.setAttribute('aCluster', new THREE.BufferAttribute(data.cluster, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(data.size, 1));
    g.computeBoundingSphere();

    this.uniforms = {
      uMorph: { value: 0 },
      uColorMode: { value: 0 },
      uPointScale: { value: 1.6 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      uHighlight: { value: -1 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);

    // 实时输入返回的点（高亮白星），单独一组
    this.liveGroup = new THREE.Group();
    scene.add(this.liveGroup);
  }

  // 平滑过渡到目标布局：0=PCA, 1=UMAP
  setLayoutTarget(t) { this._morphTarget = Math.max(0, Math.min(1, t)); }
  setLayoutImmediate(t) { this._morphTarget = this._morph = t; this.uniforms.uMorph.value = t; }

  setColorMode(mode) { // 'cluster' | 'lie'
    this.uniforms.uColorMode.value = mode === 'lie' ? 1 : 0;
  }

  setHighlight(clusterId) { this.uniforms.uHighlight.value = clusterId; }

  // 实时检验：把后端返回的新 token 当作亮星插进星系
  setLivePoints(points) {
    this.liveGroup.clear();
    if (!points || !points.length) return;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(points.length * 3);
    const col = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const xyz = this._morph > 0.5 ? p.umap : p.pca;
      pos[i * 3] = xyz[0]; pos[i * 3 + 1] = xyz[1]; pos[i * 3 + 2] = xyz[2];
      // 失真高→偏红，低→偏白
      const d = p.distortion ?? 0;
      col[i * 3] = 1.0; col[i * 3 + 1] = 1.0 - 0.7 * d; col[i * 3 + 2] = 1.0 - 0.9 * d;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({
      size: 6, sizeAttenuation: true, vertexColors: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.liveGroup.add(new THREE.Points(g, m));
  }

  update(dt) {
    // 布局插值
    if (Math.abs(this._morph - this._morphTarget) > 1e-4) {
      this._morph += (this._morphTarget - this._morph) * Math.min(1, dt * 3.0);
      this.uniforms.uMorph.value = this._morph;
    }
    this.points.rotation.y += dt * 0.02; // 缓慢自转，星海更有生命感
    this.liveGroup.rotation.y = this.points.rotation.y;
  }

  get morph() { return this._morph; }
}
