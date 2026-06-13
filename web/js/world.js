// world.js — 沉浸式"银河"环境（构成层 L0/L1/L2/L3 + 银河核 L4）
//
//   [L0] 星云穹顶   BackSide 球 + 域扭曲 fbm + 尘埃遮罩         不进 bloom（×0.34 压暗）
//   [L1] 深空星野   40k 软圆点，银河带+晕，色温+微闪          不进 bloom
//   [L2] 银河星盘   100k Points 螺旋臂(Bruno Simon) 差速自转   不进 bloom（结构骨架）
//   [L3] 尘埃带     30k Points NormalBlending 遮挡(负空间)     不进 bloom
//   [L4] 银河核     发光 sprite                                ★进 bloom（辉光源）
//
// 亮度铁律：除 L4 外所有层亮度 ≤ bloom 阈值，保证"看得清、不洗白"。
// 全程序化、无外部贴图、离线可跑。fog 用乘性消光在各 shader 里手写（additive 友好）。

import * as THREE from 'three';

export const BLOOM_LAYER = 1;   // 只有这层进 bloom

// ============ L0 星云穹顶 ============
const DOME_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vDir;
  uniform float uTime;
  float hash(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
  float vnoise(vec3 x){ vec3 i=floor(x),f=fract(x); f=f*f*(3.0-2.0*f);
    return mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
               mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z); }
  float fbm(vec3 p){ float a=0.5,s=0.0; for(int i=0;i<4;i++){ s+=a*vnoise(p); p*=2.02; a*=0.5; } return s; }
  void main(){
    vec3 d = normalize(vDir); float t = uTime*0.012;
    vec3 q = vec3(fbm(d*1.8+t), fbm(d*1.8+5.2), fbm(d*1.8+1.3));
    vec3 r = vec3(fbm(d*1.8+4.0*q+1.7), fbm(d*1.8+4.0*q+9.2), fbm(d*1.8+4.0*q+8.3));
    float v = clamp(fbm(d*1.8+4.0*r), 0.0, 1.0);
    float fil = (v*v*v + 0.55*v*v + 0.30*v) * 0.85;
    vec3 cNeb = mix(vec3(0.05,0.08,0.30), vec3(0.42,0.12,0.36), clamp(length(q),0.0,1.0));
    cNeb = mix(cNeb, vec3(0.45,0.40,0.50), clamp(r.y,0.0,1.0)*0.5);
    float dust = fbm(d*0.9+13.0);
    float ext = mix(0.18, 1.0, smoothstep(0.35,0.72,dust));
    float band = exp(-pow(d.y*2.4, 2.0));
    vec3 col = vec3(0.012,0.018,0.045) + cNeb*fil*(0.42+0.5*band);
    col *= ext * 0.34;
    gl_FragColor = vec4(col, 1.0);
  }
`;

// 软圆点 + 乘性 fog 的通用片段/顶点工具（additive 友好）
const STAR_VERT = /* glsl */`
  attribute float aSize; attribute float aSeed; attribute vec3 color;
  uniform float uTime; uniform float uPixelRatio; uniform float uFog;
  varying vec3 vCol; varying float vTw;
  void main(){
    vec4 mv = modelViewMatrix * vec4(position,1.0);
    gl_Position = projectionMatrix * mv;
    float tw = 0.7 + 0.3*sin(uTime*(0.5+aSeed*1.5) + aSeed*6.2831);
    vTw = tw;
    gl_PointSize = clamp(aSize * uPixelRatio * (300.0 / -mv.z), 1.0, 12.0);
    float fog = exp(-uFog * (-mv.z));            // 乘性消光：远处淡出
    vCol = color * fog;
  }
`;
const STAR_FRAG = /* glsl */`
  precision highp float; varying vec3 vCol; varying float vTw;
  void main(){
    float d = length(gl_PointCoord - 0.5);
    if(d>0.5) discard;
    float core = smoothstep(0.5,0.0,d);
    gl_FragColor = vec4(vCol*(0.7+0.5*vTw), core);
  }
`;

export class World {
  constructor(scene) {
    this.scene = scene;
    this.uTime = { value: 0 };
    this.uFog = { value: 0.00035 };               // 大气透视密度（乘性）
    this.uPR = { value: Math.min(window.devicePixelRatio, 2) };
    this._build();
  }

  _build() {
    this._dome();
    this.scene.add(this._starfield(40000));
    this.scene.add(this._spiralDisk(100000));
    this.scene.add(this._dustLanes(30000));
    this._galacticCore();
  }

  _dome() {
    const geo = new THREE.SphereGeometry(2600, 48, 32);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime },
      vertexShader: `varying vec3 vDir; void main(){ vDir=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: DOME_FRAG, side: THREE.BackSide, depthWrite: false, fog: false,
    });
    this.dome = new THREE.Mesh(geo, mat);
    this.dome.renderOrder = -10;
    this.scene.add(this.dome);
  }

  _starMaterial(blending) {
    return new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime, uPixelRatio: this.uPR, uFog: this.uFog },
      vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
      transparent: true, depthWrite: false, blending,
    });
  }

  // ---- L1 深空星野 ----
  _starfield(N) {
    const pos = new Float32Array(N*3), col = new Float32Array(N*3), siz = new Float32Array(N), seed = new Float32Array(N);
    const temps = [[0.72,0.80,1.0],[0.72,0.80,1.0],[0.72,0.80,1.0],[0.72,0.80,1.0],
      [0.92,0.93,1.0],[0.92,0.93,1.0],[0.92,0.93,1.0],[0.92,0.93,1.0],[0.92,0.93,1.0],
      [1.0,0.90,0.72],[1.0,0.90,0.72],[1.0,0.90,0.72],[1.0,0.74,0.55]];
    for (let i=0;i<N;i++){
      let x,y,z;
      if (Math.random()<0.7){ const rr=220+Math.pow(Math.random(),0.6)*1700; const a=Math.random()*Math.PI*2+rr*0.004;
        x=Math.cos(a)*rr; z=Math.sin(a)*rr; y=(Math.random()-0.5)*130*(1-rr/2300); }
      else { const rr=320+Math.random()*1700; const u=2*Math.random()-1, th=Math.random()*Math.PI*2, s=Math.sqrt(1-u*u);
        x=rr*s*Math.cos(th); y=rr*s*Math.sin(th); z=rr*u; }
      pos[i*3]=x; pos[i*3+1]=y; pos[i*3+2]=z;
      const c=temps[(Math.random()*temps.length)|0]; const b=0.32+Math.random()*0.30;
      col[i*3]=c[0]*b; col[i*3+1]=c[1]*b; col[i*3+2]=c[2]*b;
      siz[i]=Math.random()<0.02?4+Math.random()*4:1+Math.random()*1.6; seed[i]=Math.random();
    }
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.BufferAttribute(pos,3));
    g.setAttribute('color',new THREE.BufferAttribute(col,3));
    g.setAttribute('aSize',new THREE.BufferAttribute(siz,1));
    g.setAttribute('aSeed',new THREE.BufferAttribute(seed,1));
    const pts=new THREE.Points(g, this._starMaterial(THREE.AdditiveBlending));
    pts.frustumCulled=false; this.starfield=pts; return pts;
  }

  // ---- L2 银河星盘（Bruno Simon 螺旋臂 + 差速自转）----
  _spiralDisk(N) {
    const R = 1050, branches = 3, spinTurns = 1.6, randomness = 0.22, rp = 3.0, yFlat = 0.05;
    const inside = new THREE.Color('#ffe1ad'), outside = new THREE.Color('#3a6bd8');
    const pos = new Float32Array(N*3), col = new Float32Array(N*3), siz = new Float32Array(N), seed = new Float32Array(N);
    for (let i=0;i<N;i++){
      const radius = Math.pow(Math.random(), 1.5) * R;            // 向心集中
      const branchAngle = ((i % branches) / branches) * Math.PI * 2;
      const spinAngle = (radius / R) * spinTurns * Math.PI * 2;
      const sgn = () => (Math.random()<0.5?1:-1);
      const rx = Math.pow(Math.random(), rp)*sgn()*randomness*radius;
      const ry = Math.pow(Math.random(), rp)*sgn()*randomness*radius*yFlat*8.0;
      const rz = Math.pow(Math.random(), rp)*sgn()*randomness*radius;
      pos[i*3]   = Math.cos(branchAngle+spinAngle)*radius + rx;
      pos[i*3+1] = ry;
      pos[i*3+2] = Math.sin(branchAngle+spinAngle)*radius + rz;
      const c = inside.clone().lerp(outside, radius/R);
      const b = 0.55;                                            // 压在阈值下，不洗白
      col[i*3]=c.r*b; col[i*3+1]=c.g*b; col[i*3+2]=c.b*b;
      siz[i]=Math.random()<0.04?2.5+Math.random()*2:0.9+Math.random()*1.4;
      seed[i]=Math.random();
    }
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.BufferAttribute(pos,3));
    g.setAttribute('color',new THREE.BufferAttribute(col,3));
    g.setAttribute('aSize',new THREE.BufferAttribute(siz,1));
    g.setAttribute('aSeed',new THREE.BufferAttribute(seed,1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime, uPixelRatio: this.uPR, uFog: this.uFog },
      vertexShader: /* glsl */`
        attribute float aSize; attribute vec3 color;
        uniform float uTime; uniform float uPixelRatio; uniform float uFog;
        varying vec3 vCol;
        void main(){
          vec3 p = position;
          float len = length(p.xz);
          float ang = uTime * 6.0 / (len + 40.0);     // 内圈快、外圈慢 → 漩涡
          float ca = cos(ang), sa = sin(ang);
          p.xz = mat2(ca,-sa,sa,ca) * p.xz;
          vec4 mv = modelViewMatrix * vec4(p,1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(aSize * uPixelRatio * (260.0 / -mv.z), 1.0, 8.0);
          float fog = exp(-uFog * (-mv.z));
          vCol = color * fog;
        }`,
      fragmentShader: /* glsl */`
        precision highp float; varying vec3 vCol;
        void main(){
          float d = distance(gl_PointCoord, vec2(0.5));
          float s = pow(1.0 - clamp(d*2.0,0.0,1.0), 8.0);   // 紧致核，边缘快衰减不糊
          if(s < 0.02) discard;
          gl_FragColor = vec4(vCol * s, s);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const pts=new THREE.Points(g, mat); pts.frustumCulled=false; this.disk=pts; return pts;
  }

  // ---- L3 尘埃带（NormalBlending 遮挡，做出暗带/负空间）----
  _dustLanes(N) {
    const R = 1050, branches = 3, spinTurns = 1.6;
    const pos = new Float32Array(N*3), alp = new Float32Array(N);
    for (let i=0;i<N;i++){
      const radius = (0.25 + Math.random()*0.75) * R;             // 偏外圈
      const branchAngle = ((i % branches) / branches) * Math.PI * 2;
      const spinAngle = (radius / R) * spinTurns * Math.PI * 2 + 0.12;  // 略偏旋臂前缘
      const scatter = (s)=>Math.pow(Math.random(),2.0)*(Math.random()<0.5?1:-1)*s*radius;
      pos[i*3]   = Math.cos(branchAngle+spinAngle)*radius + scatter(0.10);
      pos[i*3+1] = scatter(0.018);                                 // 比星盘更薄
      pos[i*3+2] = Math.sin(branchAngle+spinAngle)*radius + scatter(0.10);
      alp[i] = 0.35 + Math.random()*0.35;
    }
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.BufferAttribute(pos,3));
    g.setAttribute('aAlpha',new THREE.BufferAttribute(alp,1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime, uPixelRatio: this.uPR },
      vertexShader: /* glsl */`
        attribute float aAlpha;
        uniform float uTime; uniform float uPixelRatio;
        varying float vA;
        void main(){
          vec3 p = position; float len = length(p.xz);
          float ang = uTime * 6.0 / (len + 40.0);                 // 与星盘同步自转
          float ca=cos(ang), sa=sin(ang); p.xz = mat2(ca,-sa,sa,ca)*p.xz;
          vec4 mv = modelViewMatrix * vec4(p,1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(uPixelRatio * (2200.0 / -mv.z), 2.0, 40.0);   // 大而软
          vA = aAlpha;
        }`,
      fragmentShader: /* glsl */`
        precision highp float; varying float vA;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.12, d) * vA;
          gl_FragColor = vec4(vec3(0.04,0.025,0.02), a);          // 暗红棕，NormalBlending 遮挡
        }`,
      transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    });
    const pts=new THREE.Points(g, mat); pts.frustumCulled=false; this.dust=pts; return pts;
  }

  // ---- L4 银河核（唯一进 bloom 的发光源）----
  _galacticCore() {
    const s=128, c=document.createElement('canvas'); c.width=c.height=s;
    const ctx=c.getContext('2d'); const g=ctx.createRadialGradient(s/2,s/2,0,s/2,s/2,s/2);
    g.addColorStop(0,'rgba(255,240,210,1)'); g.addColorStop(0.3,'rgba(255,210,150,0.6)'); g.addColorStop(1,'rgba(255,180,120,0)');
    ctx.fillStyle=g; ctx.fillRect(0,0,s,s);
    const tex=new THREE.CanvasTexture(c); tex.colorSpace=THREE.SRGBColorSpace;
    const mat=new THREE.SpriteMaterial({ map:tex, color:0xffffff, transparent:true, opacity:0.7,
      depthWrite:false, blending:THREE.AdditiveBlending });
    const sp=new THREE.Sprite(mat); sp.scale.set(170,170,1);      // 别盖住中心的语义星系
    sp.layers.enable(BLOOM_LAYER);                                 // ★进 bloom
    this.core=sp; this.scene.add(sp);
  }

  update(dt) {
    this.uTime.value += dt;
    if (this.starfield) this.starfield.rotation.y += dt*0.004;
  }
}
