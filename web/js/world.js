// world.js — 沉浸式"银河"环境（迭代1：去掉简陋 billboard，星云改为域扭曲 fbm 穹顶 + 尘埃遮罩）
//
// 构成层（本文件负责 L0/L1，语义星系在 galaxy.js）：
//   [L0] 星云穹顶：BackSide 大球 + 域扭曲 fbm(IQ 自我馈入) + 低频尘埃遮罩 → 包裹全场的暗霞底座
//        亮度刻意压到 bloom 阈值以下，永远不被 bloom 洗白。
//   [L1] 深空星野：40k 程序化软圆点，银河带(薄盘)+球状晕分布，色温分布 + 微闪 → 密度与纵深。
// 全部程序化生成，无外部贴图，离线可跑。
//
// 设计铁律（来自调研计划）：除"星核/亮星"外，所有层最终亮度 ≤ 0.8（bloom 阈值），保证结构清晰不洗白。

import * as THREE from 'three';

// ============ 星云穹顶（域扭曲 fbm + 尘埃遮罩）============
const DOME_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const DOME_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vDir;
  uniform float uTime;

  float hash(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
  float vnoise(vec3 x){
    vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
    return mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x),
                   mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
               mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),
                   mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
  }
  // 4 octave fbm
  float fbm(vec3 p){ float a=0.5,s=0.0; for(int i=0;i<4;i++){ s+=a*vnoise(p); p*=2.02; a*=0.5; } return s; }

  void main() {
    vec3 d = normalize(vDir);
    float t = uTime * 0.012;

    // IQ 域扭曲：fbm 自我馈入两次 → 缠绕的云丝
    vec3 q = vec3(fbm(d*1.8 + t), fbm(d*1.8 + 5.2), fbm(d*1.8 + 1.3));
    vec3 r = vec3(fbm(d*1.8 + 4.0*q + 1.7), fbm(d*1.8 + 4.0*q + 9.2), fbm(d*1.8 + 4.0*q + 8.3));
    float v = fbm(d*1.8 + 4.0*r);

    // 多项式压暗中灰、保留亮丝（结构清晰核心）
    v = clamp(v, 0.0, 1.0);
    float fil = v*v*v + 0.55*v*v + 0.30*v;   // 暗处更暗、亮丝突出
    fil *= 0.85;

    // 颜色按 q/r 分层（低饱和：深蓝→品红→暖白），不要纯白
    vec3 deep   = vec3(0.012, 0.018, 0.045);
    vec3 cNeb   = mix(vec3(0.05,0.08,0.30), vec3(0.42,0.12,0.36), clamp(length(q),0.0,1.0));
    cNeb        = mix(cNeb, vec3(0.45,0.40,0.50), clamp(r.y,0.0,1.0)*0.5);

    // 低频尘埃遮罩：旋臂间暗带（乘性消光）
    float dust = fbm(d*0.9 + 13.0);
    float extinction = mix(0.18, 1.0, smoothstep(0.35, 0.72, dust));

    // 银河带：y≈0 平面附近加亮，横贯天幕
    float band = exp(-pow(d.y*2.4, 2.0));

    vec3 col = deep + cNeb * fil * (0.42 + 0.5*band);
    col *= extinction;
    col *= 0.34;                       // ★整体压到 bloom 阈值以下，绝不洗白

    gl_FragColor = vec4(col, 1.0);
  }
`;

export class World {
  constructor(scene) {
    this.scene = scene;
    this.uTime = { value: 0 };
    this._build();
  }

  _build() {
    // ---- L0 星云穹顶 ----
    const domeGeo = new THREE.SphereGeometry(2600, 48, 32);
    const domeMat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime },
      vertexShader: DOME_VERT, fragmentShader: DOME_FRAG,
      side: THREE.BackSide, depthWrite: false, fog: false,
    });
    this.dome = new THREE.Mesh(domeGeo, domeMat);
    this.dome.renderOrder = -10;
    this.scene.add(this.dome);

    // ---- L1 深空星野 ----
    this.scene.add(this._starfield(40000));
  }

  _starfield(N) {
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const siz = new Float32Array(N);
    const seed = new Float32Array(N);
    // 色温分布：蓝白 / 白 / 暖黄 / 橙红（权重 4:5:3:1）
    const temps = [
      [0.72,0.80,1.0],[0.72,0.80,1.0],[0.72,0.80,1.0],[0.72,0.80,1.0],
      [0.92,0.93,1.0],[0.92,0.93,1.0],[0.92,0.93,1.0],[0.92,0.93,1.0],[0.92,0.93,1.0],
      [1.0,0.90,0.72],[1.0,0.90,0.72],[1.0,0.90,0.72],
      [1.0,0.74,0.55],
    ];
    for (let i = 0; i < N; i++) {
      let x, y, z;
      if (Math.random() < 0.7) {
        // 银河薄盘 + 螺旋感
        const rr = 220 + Math.pow(Math.random(), 0.6) * 1700;
        const a = Math.random() * Math.PI * 2 + rr * 0.004;
        x = Math.cos(a) * rr; z = Math.sin(a) * rr;
        y = (Math.random() - 0.5) * 130 * (1 - rr / 2300);
      } else {
        // 球状均匀晕（u 均匀避免极点聚堆）
        const rr = 320 + Math.random() * 1700;
        const u = 2 * Math.random() - 1, th = Math.random() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        x = rr * s * Math.cos(th); y = rr * s * Math.sin(th); z = rr * u;
      }
      pos[i*3] = x; pos[i*3+1] = y; pos[i*3+2] = z;
      const c = temps[(Math.random() * temps.length) | 0];
      const b = 0.32 + Math.random() * 0.30;            // 多数偏暗，≤ ~0.62
      col[i*3] = c[0]*b; col[i*3+1] = c[1]*b; col[i*3+2] = c[2]*b;
      siz[i] = Math.random() < 0.02 ? 4 + Math.random()*4 : 1 + Math.random()*1.6;
      seed[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime, uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) } },
      vertexShader: /* glsl */`
        attribute float aSize; attribute float aSeed; attribute vec3 color;
        uniform float uTime; uniform float uPixelRatio;
        varying vec3 vCol; varying float vTw;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_Position = projectionMatrix * mv;
          float tw = 0.7 + 0.3*sin(uTime*(0.5+aSeed*1.5) + aSeed*6.2831);
          vTw = tw;
          gl_PointSize = clamp(aSize * uPixelRatio * (300.0 / -mv.z), 1.0, 12.0);
          vCol = color;
        }`,
      fragmentShader: /* glsl */`
        precision highp float; varying vec3 vCol; varying float vTw;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          if(d>0.5) discard;
          float core = smoothstep(0.5,0.0,d);
          gl_FragColor = vec4(vCol*(0.7+0.5*vTw), core);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    this.starfield = pts;
    return pts;
  }

  update(dt) {
    this.uTime.value += dt;
    if (this.starfield) this.starfield.rotation.y += dt * 0.004;
  }
}
