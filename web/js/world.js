// world.js — 沉浸式"银河"环境：星云穹顶 + 银河带星野 + 体积星云云团
//
// 目标：让人感到"置身银河系当中"，而不是从外面看一团点。
// 三层构成（从远到近）：
//   1) 星云穹顶(Nebula Dome)：域扭曲 fbm 噪声生成的彩色气体，包裹整个场景 —— 没入感的背骨。
//   2) 银河带星野(Starfield)：两万多颗星，盘状(银河带)分布 + 球状晕，环绕相机。
//   3) 体积星云云团(Nebula Clouds)：几十片柔软加性 billboard，飞行时穿过它们 → 体积/视差感。
//
// 全部程序化生成，无外部贴图，离线可跑。配合 main.js 的 UnrealBloom 出辉光。

import * as THREE from 'three';

// ============ 程序化软粒子贴图（给星云云团 / 亮星用）============
function softSprite(inner = 0.0, color = '#ffffff') {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s/2, s/2, s*inner, s/2, s/2, s/2);
  g.addColorStop(0.0, color);
  g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  g.addColorStop(1.0, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============ 星云穹顶 ============
const DOME_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = position;                 // 球面上的方向
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
  float fbm(vec3 p){ float a=0.5,s=0.0; for(int i=0;i<5;i++){ s+=a*vnoise(p); p*=2.03; a*=0.5; } return s; }

  // IQ 余弦调色板
  vec3 pal(float t){ return 0.5 + 0.5*cos(6.28318*(t + vec3(0.0, 0.35, 0.62))); }

  void main() {
    vec3 d = normalize(vDir);
    float t = uTime * 0.015;
    // 域扭曲：fbm 自我馈入两次 → 缠绕的云丝
    vec3 q = vec3(fbm(d*2.0 + t), fbm(d*2.0 + 5.2), fbm(d*2.0 + 1.3));
    vec3 r = vec3(fbm(d*2.0 + q*2.0 + t*1.2), fbm(d*2.0 + q*2.0 + 8.3), fbm(d*2.0 + q*2.0 + 2.8));
    float v = fbm(d*2.0 + r*2.0);

    // 深空底色（蓝紫）+ 星云丝（品红/青）随 v 提亮
    vec3 deep = vec3(0.02, 0.03, 0.07);
    vec3 neb = pal(0.55 + 0.35*v);             // 偏蓝紫-品红
    float fil = smoothstep(0.45, 0.95, v);     // 只有高值处才出亮丝
    vec3 col = deep + neb * fil * 0.55;
    // 银河带：在 y≈0 的平面附近加亮，形成横贯天幕的"银河"
    float band = exp(-pow(d.y*2.6, 2.0));
    col += neb * band * 0.12;

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
    // ---- 1) 星云穹顶 ----
    const domeGeo = new THREE.SphereGeometry(2600, 48, 32);
    const domeMat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime },
      vertexShader: DOME_VERT, fragmentShader: DOME_FRAG,
      side: THREE.BackSide, depthWrite: false, fog: false,
    });
    this.dome = new THREE.Mesh(domeGeo, domeMat);
    this.dome.renderOrder = -10;
    this.scene.add(this.dome);

    // ---- 2) 银河带星野 ----
    this.scene.add(this._starfield(26000));

    // ---- 3) 体积星云云团 ----
    this._nebulaClouds(70);
  }

  // 盘状(银河带) + 球状晕 的星野
  _starfield(N) {
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const siz = new Float32Array(N);
    const palettes = [
      [0.75, 0.82, 1.0], [0.9, 0.92, 1.0], [1.0, 0.9, 0.78], [0.8, 0.88, 1.0], [1.0, 0.82, 0.85],
    ];
    for (let i = 0; i < N; i++) {
      let x, y, z;
      if (Math.random() < 0.7) {
        // 银河盘：薄盘 + 螺旋感
        const r = 200 + Math.pow(Math.random(), 0.6) * 1700;
        const a = Math.random() * Math.PI * 2 + r * 0.004;
        x = Math.cos(a) * r;
        z = Math.sin(a) * r;
        y = (Math.random() - 0.5) * 120 * (1 - r / 2200);
      } else {
        // 球状晕
        const r = 300 + Math.random() * 1700;
        const t = Math.random() * Math.PI * 2;
        const p = Math.acos(2 * Math.random() - 1);
        x = r * Math.sin(p) * Math.cos(t);
        y = r * Math.sin(p) * Math.sin(t);
        z = r * Math.cos(p);
      }
      pos[i*3] = x; pos[i*3+1] = y; pos[i*3+2] = z;
      const c = palettes[(Math.random() * palettes.length) | 0];
      const b = 0.5 + Math.random() * 0.5;
      col[i*3] = c[0]*b; col[i*3+1] = c[1]*b; col[i*3+2] = c[2]*b;
      siz[i] = Math.random() < 0.03 ? 5 + Math.random()*4 : 1 + Math.random()*2; // 少量亮星
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime, uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) } },
      vertexShader: /* glsl */`
        attribute float aSize; attribute vec3 color;
        uniform float uTime; uniform float uPixelRatio;
        varying vec3 vCol; varying float vTw;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_Position = projectionMatrix * mv;
          float tw = 0.6 + 0.4*sin(uTime*2.0 + position.x*0.5 + position.z*0.3);
          vTw = tw;
          gl_PointSize = aSize * uPixelRatio * tw * (300.0 / -mv.z);
          vCol = color;
        }`,
      fragmentShader: /* glsl */`
        precision highp float; varying vec3 vCol; varying float vTw;
        void main(){
          vec2 uv = gl_PointCoord - 0.5; float r = length(uv);
          if(r>0.5) discard;
          float a = smoothstep(0.5,0.0,r);
          gl_FragColor = vec4(vCol*(0.6+0.8*vTw), a);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    this.starfield = pts;
    return pts;
  }

  _nebulaClouds(N) {
    const tints = ['#3a5cff', '#7a3cff', '#ff3ca0', '#1fb6c8', '#5a3cff', '#ff6a3c'];
    const group = new THREE.Group();
    for (let i = 0; i < N; i++) {
      const tint = tints[(Math.random() * tints.length) | 0];
      const tex = softSprite(0.0, tint);
      const mat = new THREE.SpriteMaterial({
        map: tex, color: new THREE.Color(tint),
        transparent: true, opacity: 0.05 + Math.random() * 0.10,
        depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const sp = new THREE.Sprite(mat);
      // 盘状分布，形成"银河气体带"
      const r = 100 + Math.pow(Math.random(), 0.7) * 1300;
      const a = Math.random() * Math.PI * 2 + r * 0.004;
      sp.position.set(Math.cos(a) * r, (Math.random()-0.5) * 160, Math.sin(a) * r);
      const s = 250 + Math.random() * 700;
      sp.scale.set(s, s, 1);
      group.add(sp);
    }
    this.clouds = group;
    this.scene.add(group);
  }

  update(dt) {
    this.uTime.value += dt;
    if (this.starfield) this.starfield.rotation.y += dt * 0.004;
    if (this.clouds) this.clouds.rotation.y += dt * 0.006;
  }
}
