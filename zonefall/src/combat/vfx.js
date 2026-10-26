// ZONEFALL - visual effects. OWNER: COMBAT. Contract: ARCHITECTURE.md 5.3.
// Pooled and instanced, no per-shot allocations after init:
//  - two GPU billboard particle systems (one alpha-blended for smoke, dust, debris and blood, one additive for sparks,
//    flashes and fire), each a single draw call; sparks stretch along their screen-space velocity;
//  - muzzle flash: three crossed additive cards (front star + two side flames) per flash, plus one shared PointLight
//    on medium/high (the first-person viewmodel draws its own flash in the overlay and uses the same light);
//  - tracers (every shot for remote/bot fire, every 3rd for local), streaks travelling at TUNE.tracerSpeed;
//  - impacts by surface (concrete dust and chips, metal sparks, wood splinters, dirt kicks, water spray, glass glints);
//  - bullet-hole decals: one instanced ring buffer per decal family (quality.decals in total), lit PBR cards;
//  - blood mist and droplets, explosion (fireball, smoke column, dust ring, fragments, light flash, scorch), landing
//    dust, ejected brass for third-person and remote shots.
// All textures are generated on canvases at init; nothing is downloaded.
// Subscribes to WEAPON_FIRE, GRENADE_EXPLODE, GRENADE_BOUNCE, PLAYER_LAND by itself.
import * as THREE from 'three';
import { SURFACE, WEAPONS, QUALITY } from '../config.js';
import { on, EV } from '../core/bus.js';
import { state, gfx, debug } from '../core/state.js';
import { clamp } from '../core/util.js';
import * as world from '../world/world.js';

const TUNE = {
  maxAlpha: 900, maxAdd: 700, maxFire: 160,
  tracerSpeed: 520, tracerLen: 7.5, tracerWidth: 0.06, localTracerEvery: 3, maxTracers: 64,
  muzzleLight: { intensity: 38, distance: 9, life: 0.05 },
  explosionLight: { intensity: 2600, distance: 34, life: 0.28 },
  decalSize: { concrete: 0.11, metal: 0.08, wood: 0.095, dirt: 0.17 },
  maxCasings: 48,
  casingRange: 28,
};

let scene = null;
let inited = false;
let qual = QUALITY.medium;
let alphaSys = null, addSys = null, fireSys = null;
let tracers = null;
let flashes = null;
let decals = {};
let casings = null;
let muzzleLight = null, boomLight = null;
let muzzleLightT = 0, boomLightT = 0, boomK = 1;
let localShots = 0;
const tex = {};

// temporaries
const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3(), vD = new THREE.Vector3(), vE = new THREE.Vector3();
const qA = new THREE.Quaternion();
const mA = new THREE.Matrix4();
const cA = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0), ZAX = new THREE.Vector3(0, 0, 1);
const dummy = new THREE.Object3D();

function err(msg) { return new Error(`[COMBAT/vfx] ${msg}`); }
const rnd = (a, b) => a + Math.random() * (b - a);

// ------------------------------------------------------------------------------------------ procedural textures
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function toTex(c, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 2;
  return t;
}

/** Soft cloudy puff (white, alpha in the alpha channel). */
function puffTexture() {
  const S = 128, c = canvas(S, S), g = c.getContext('2d');
  const img = g.createImageData(S, S);
  // value noise octaves
  const grid = (n, seed) => { const a = []; let s = seed; for (let i = 0; i < (n + 1) * (n + 1); i++) { s = (s * 16807) % 2147483647; a.push(s / 2147483647); } return a; };
  const oct = [[4, grid(4, 7)], [8, grid(8, 13)], [16, grid(16, 29)]];
  const sample = (n, a, x, y) => {
    const fx = x * n, fy = y * n, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const k = (i, j) => a[Math.min(n, iy + j) * (n + 1) + Math.min(n, ix + i)];
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    return (k(0, 0) * (1 - sx) + k(1, 0) * sx) * (1 - sy) + (k(0, 1) * (1 - sx) + k(1, 1) * sx) * sy;
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S, dx = u - 0.5, dy = v - 0.5;
    const r = Math.sqrt(dx * dx + dy * dy) * 2;
    let n = 0, amp = 0.55;
    for (const [k, a] of oct) { n += sample(k, a, u, v) * amp; amp *= 0.5; }
    const edge = clamp(1 - r, 0, 1);
    const a = clamp(Math.pow(edge, 1.3) * (0.55 + n * 0.9) - 0.08, 0, 1);
    const i = (y * S + x) * 4;
    const shade = 200 + n * 55;
    img.data[i] = shade; img.data[i + 1] = shade; img.data[i + 2] = shade; img.data[i + 3] = a * 255;
  }
  g.putImageData(img, 0, 0);
  return toTex(c);
}

/** Hot round glow: white core, soft falloff. */
function glowTexture() {
  const S = 64, c = canvas(S, S), g = c.getContext('2d');
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.18, 'rgba(255,255,255,0.85)');
  gr.addColorStop(0.45, 'rgba(255,255,255,0.25)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  return toTex(c);
}

/** Muzzle flash, front view: a hot core with 5-7 irregular petals. */
function flashFrontTexture() {
  const S = 128, c = canvas(S, S), g = c.getContext('2d');
  g.translate(S / 2, S / 2);
  g.globalCompositeOperation = 'lighter';
  const petals = 6;
  for (let i = 0; i < petals; i++) {
    g.save();
    g.rotate((i / petals) * Math.PI * 2 + (i % 2) * 0.2);
    const len = S * (0.32 + (i % 3) * 0.06);
    const gr = g.createLinearGradient(0, 0, len, 0);
    gr.addColorStop(0, 'rgba(255,240,210,0.95)');
    gr.addColorStop(0.5, 'rgba(255,170,70,0.5)');
    gr.addColorStop(1, 'rgba(255,120,30,0)');
    g.fillStyle = gr;
    g.beginPath(); g.moveTo(0, -S * 0.05); g.quadraticCurveTo(len * 0.6, -S * 0.035, len, 0); g.quadraticCurveTo(len * 0.6, S * 0.035, 0, S * 0.05); g.fill();
    g.restore();
  }
  const core = g.createRadialGradient(0, 0, 0, 0, 0, S * 0.22);
  core.addColorStop(0, 'rgba(255,255,245,1)');
  core.addColorStop(0.4, 'rgba(255,220,150,0.8)');
  core.addColorStop(1, 'rgba(255,140,40,0)');
  g.fillStyle = core; g.beginPath(); g.arc(0, 0, S * 0.22, 0, Math.PI * 2); g.fill();
  return toTex(c);
}

/** Muzzle flash, side view: a tapered flame tongue along +X (u), base at the left. */
function flashSideTexture() {
  const W = 128, H = 64, c = canvas(W, H), g = c.getContext('2d');
  g.globalCompositeOperation = 'lighter';
  for (let k = 0; k < 3; k++) {
    const len = W * (0.75 + k * 0.1), h = H * (0.22 - k * 0.05);
    const gr = g.createLinearGradient(0, 0, len, 0);
    gr.addColorStop(0, 'rgba(255,245,220,0.95)');
    gr.addColorStop(0.35, 'rgba(255,190,90,0.65)');
    gr.addColorStop(1, 'rgba(255,110,30,0)');
    g.fillStyle = gr;
    g.beginPath(); g.moveTo(0, H / 2 - h * 0.5);
    g.quadraticCurveTo(len * 0.35, H / 2 - h * (1.1 + k * 0.2), len, H / 2);
    g.quadraticCurveTo(len * 0.35, H / 2 + h * (1.1 + k * 0.2), 0, H / 2 + h * 0.5);
    g.fill();
  }
  return toTex(c);
}

/** Tracer streak: bright thin core with a soft halo, brightest at the head (v = 1). */
function tracerTexture() {
  const W = 32, H = 128, c = canvas(W, H), g = c.getContext('2d');
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = Math.abs(x / (W - 1) - 0.5) * 2, v = 1 - y / (H - 1);
    const core = Math.exp(-u * u * 40), halo = Math.exp(-u * u * 6) * 0.35;
    const along = Math.pow(v, 1.6);
    const a = clamp((core + halo) * along, 0, 1);
    const i = (y * W + x) * 4;
    img.data[i] = 255; img.data[i + 1] = 235 + 20 * core; img.data[i + 2] = 200 + 55 * core; img.data[i + 3] = a * 255;
  }
  g.putImageData(img, 0, 0);
  return toTex(c);
}

/** Bullet hole decal families drawn on 128 px canvases: colour + alpha, sRGB. */
function decalTexture(kind) {
  const S = 128, c = canvas(S, S), g = c.getContext('2d');
  const C = S / 2;
  let seed = kind.length * 977;
  const r = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  if (kind === 'dirt') {
    const gr = g.createRadialGradient(C, C, 0, C, C, C);
    gr.addColorStop(0, 'rgba(20,15,10,0.95)'); gr.addColorStop(0.35, 'rgba(40,30,20,0.7)'); gr.addColorStop(1, 'rgba(60,45,30,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 26; i++) { g.fillStyle = `rgba(30,22,14,${0.3 + r() * 0.4})`; const a = r() * 6.28, d = C * (0.3 + r() * 0.6); g.beginPath(); g.arc(C + Math.cos(a) * d, C + Math.sin(a) * d, 1 + r() * 4, 0, 6.28); g.fill(); }
    return toTex(c);
  }
  // chipped ring
  const ring = kind === 'metal' ? 'rgba(205,203,196,0.98)' : kind === 'wood' ? 'rgba(185,150,105,0.95)' : 'rgba(96,92,86,0.92)';
  g.fillStyle = ring;
  g.beginPath();
  const pts = 22;
  for (let i = 0; i <= pts; i++) {
    const a = (i / pts) * Math.PI * 2, rr = C * (kind === 'metal' ? 0.42 : 0.62) * (0.7 + r() * 0.45);
    if (i === 0) g.moveTo(C + Math.cos(a) * rr, C + Math.sin(a) * rr); else g.lineTo(C + Math.cos(a) * rr, C + Math.sin(a) * rr);
  }
  g.closePath(); g.fill();
  if (kind === 'wood') {
    g.strokeStyle = 'rgba(70,45,25,0.8)'; g.lineWidth = 2;
    for (let i = 0; i < 8; i++) { const a = r() * 6.28, d0 = C * 0.2, d1 = C * (0.6 + r() * 0.35); g.beginPath(); g.moveTo(C + Math.cos(a) * d0, C + Math.sin(a) * d0); g.lineTo(C + Math.cos(a) * d1, C + Math.sin(a) * d1); g.stroke(); }
  }
  if (kind === 'concrete') {
    g.strokeStyle = 'rgba(40,38,36,0.55)'; g.lineWidth = 1.2;
    for (let i = 0; i < 5; i++) { let x = C, y = C; const a0 = r() * 6.28; g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 4; k++) { const a = a0 + (r() - 0.5) * 0.9; x += Math.cos(a) * C * 0.2; y += Math.sin(a) * C * 0.2; g.lineTo(x, y); } g.stroke(); }
  }
  // dark hole with a soft inner shadow
  const hole = g.createRadialGradient(C, C, 0, C, C, C * 0.38);
  hole.addColorStop(0, 'rgba(4,4,4,1)'); hole.addColorStop(0.62, 'rgba(10,9,8,1)'); hole.addColorStop(1, 'rgba(30,28,26,0)');
  g.fillStyle = hole; g.beginPath(); g.arc(C, C, C * 0.38, 0, 6.28); g.fill();
  // soot / dust halo
  const halo = g.createRadialGradient(C, C, C * 0.3, C, C, C);
  halo.addColorStop(0, kind === 'metal' ? 'rgba(25,25,25,0.4)' : 'rgba(34,30,27,0.5)'); halo.addColorStop(1, 'rgba(40,36,32,0)');
  g.globalCompositeOperation = 'destination-over';
  g.fillStyle = halo; g.fillRect(0, 0, S, S);
  return toTex(c);
}

/** Scorch mark for explosions. */
function scorchTexture() {
  const S = 128, c = canvas(S, S), g = c.getContext('2d');
  const C = S / 2;
  const gr = g.createRadialGradient(C, C, 0, C, C, C);
  gr.addColorStop(0, 'rgba(8,7,6,0.92)'); gr.addColorStop(0.5, 'rgba(18,15,12,0.6)'); gr.addColorStop(1, 'rgba(30,25,20,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  let seed = 4242;
  const r = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  g.strokeStyle = 'rgba(10,9,8,0.5)';
  for (let i = 0; i < 18; i++) { const a = r() * 6.28; g.lineWidth = 1 + r() * 3; g.beginPath(); g.moveTo(C + Math.cos(a) * C * 0.3, C + Math.sin(a) * C * 0.3); g.lineTo(C + Math.cos(a) * C * (0.6 + r() * 0.4), C + Math.sin(a) * C * (0.6 + r() * 0.4)); g.stroke(); }
  return toTex(c);
}

// ------------------------------------------------------------------------------------------ particle system
const VERT = /* glsl */`
  attribute vec3 iPos;
  attribute vec4 iVel;     // xyz velocity, w stretch (s)
  attribute vec4 iCol;     // rgb, alpha
  attribute vec2 iSize;    // size, rotation
  varying vec2 vUv;
  varying vec4 vCol;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vCol = iCol;
    vec4 mvPosition = modelViewMatrix * vec4(iPos, 1.0);
    vec2 corner = position.xy;
    float size = iSize.x;
    if (iVel.w > 0.0) {
      vec3 vv = (modelViewMatrix * vec4(iVel.xyz, 0.0)).xyz;
      vec2 sv = vv.xy;
      float l = length(sv);
      vec2 ax = l > 1e-4 ? sv / l : vec2(0.0, 1.0);
      vec2 px = vec2(-ax.y, ax.x);
      float len = size + iVel.w * l;
      mvPosition.xy += px * corner.x * size + ax * (corner.y * len - 0.5 * iVel.w * l);
    } else {
      float c = cos(iSize.y), s = sin(iSize.y);
      mvPosition.xy += vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * size;
    }
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;
const FRAG_ALPHA = /* glsl */`
  uniform sampler2D map;
  varying vec2 vUv;
  varying vec4 vCol;
  #include <common>
  #include <fog_pars_fragment>
  void main() {
    vec4 t = texture2D(map, vUv);
    gl_FragColor = vec4(vCol.rgb * t.rgb, vCol.a * t.a);
    if (gl_FragColor.a < 0.004) discard;
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;
const FRAG_ADD = /* glsl */`
  uniform sampler2D map;
  varying vec2 vUv;
  varying vec4 vCol;
  #include <common>
  #include <fog_pars_fragment>
  void main() {
    vec4 t = texture2D(map, vUv);
    vec3 c = vCol.rgb * t.rgb * t.a * vCol.a;
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogF = exp(-pow(fogDensity * vFogDepth, 2.0));
        c *= fogF;
      #endif
    #endif
    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

class Particles {
  constructor(max, map, additive) {
    this.max = max; this.n = 0;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.aPos); g.setAttribute('iVel', this.aVel); g.setAttribute('iCol', this.aCol); g.setAttribute('iSize', this.aSize);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: map } }]),
      vertexShader: VERT, fragmentShader: additive ? FRAG_ADD : FRAG_ALPHA,
      transparent: true, depthWrite: false, fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 3 : 2;
    this.geo = g;
    // simulation arrays
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3);
    this.life = new Float32Array(max); this.age = new Float32Array(max);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max);
    this.rot = new Float32Array(max); this.rotV = new Float32Array(max);
    this.col = new Float32Array(max * 3); this.a0 = new Float32Array(max);
    this.drag = new Float32Array(max); this.grav = new Float32Array(max); this.stretch = new Float32Array(max);
    this.fadeIn = new Float32Array(max); this.ground = new Float32Array(max);
  }
  /** Spawn one particle. o: {p:[x,y,z]|Vector3, v, life, s0, s1, color:[r,g,b], a, drag, grav, stretch, rot, rotV, fadeIn, ground} */
  spawn(px, py, pz, vx, vy, vz, life, s0, s1, r, g, b, a, drag, grav, stretch, fadeIn = 0.05, ground = -1e9) {
    if (this.n >= this.max) return -1;
    const i = this.n++;
    this.p[i * 3] = px; this.p[i * 3 + 1] = py; this.p[i * 3 + 2] = pz;
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    this.life[i] = life; this.age[i] = 0; this.s0[i] = s0; this.s1[i] = s1;
    this.rot[i] = Math.random() * 6.283; this.rotV[i] = (Math.random() - 0.5) * 1.2;
    this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b; this.a0[i] = a;
    this.drag[i] = drag; this.grav[i] = grav; this.stretch[i] = stretch; this.fadeIn[i] = fadeIn; this.ground[i] = ground;
    return i;
  }
  kill(i) {
    const j = --this.n;
    if (i === j) return;
    const c3 = (arr) => { arr[i * 3] = arr[j * 3]; arr[i * 3 + 1] = arr[j * 3 + 1]; arr[i * 3 + 2] = arr[j * 3 + 2]; };
    c3(this.p); c3(this.v); c3(this.col);
    for (const arr of [this.life, this.age, this.s0, this.s1, this.rot, this.rotV, this.a0, this.drag, this.grav, this.stretch, this.fadeIn, this.ground]) arr[i] = arr[j];
  }
  update(dt) {
    for (let i = this.n - 1; i >= 0; i--) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) { this.kill(i); continue; }
      const k = Math.exp(-this.drag[i] * dt);
      this.v[i * 3] *= k; this.v[i * 3 + 1] = this.v[i * 3 + 1] * k - this.grav[i] * dt; this.v[i * 3 + 2] *= k;
      this.p[i * 3] += this.v[i * 3] * dt; this.p[i * 3 + 1] += this.v[i * 3 + 1] * dt; this.p[i * 3 + 2] += this.v[i * 3 + 2] * dt;
      if (this.p[i * 3 + 1] < this.ground[i]) {
        this.p[i * 3 + 1] = this.ground[i];
        this.v[i * 3 + 1] = -this.v[i * 3 + 1] * 0.25; this.v[i * 3] *= 0.5; this.v[i * 3 + 2] *= 0.5;
      }
      this.rot[i] += this.rotV[i] * dt;
    }
    const P = this.aPos.array, V = this.aVel.array, C = this.aCol.array, S = this.aSize.array;
    for (let i = 0; i < this.n; i++) {
      const t = this.age[i] / this.life[i];
      P[i * 3] = this.p[i * 3]; P[i * 3 + 1] = this.p[i * 3 + 1]; P[i * 3 + 2] = this.p[i * 3 + 2];
      V[i * 4] = this.v[i * 3]; V[i * 4 + 1] = this.v[i * 3 + 1]; V[i * 4 + 2] = this.v[i * 3 + 2]; V[i * 4 + 3] = this.stretch[i];
      const fi = this.fadeIn[i] > 0 ? Math.min(1, this.age[i] / this.fadeIn[i]) : 1;
      const fo = 1 - t * t;
      C[i * 4] = this.col[i * 3]; C[i * 4 + 1] = this.col[i * 3 + 1]; C[i * 4 + 2] = this.col[i * 3 + 2]; C[i * 4 + 3] = this.a0[i] * fi * fo;
      S[i * 2] = this.s0[i] + (this.s1[i] - this.s0[i]) * (1 - (1 - t) * (1 - t));
      S[i * 2 + 1] = this.rot[i];
    }
    this.geo.instanceCount = this.n;
    if (this.n > 0) {
      this.aPos.addUpdateRange(0, this.n * 3); this.aPos.needsUpdate = true;
      this.aVel.addUpdateRange(0, this.n * 4); this.aVel.needsUpdate = true;
      this.aCol.addUpdateRange(0, this.n * 4); this.aCol.needsUpdate = true;
      this.aSize.addUpdateRange(0, this.n * 2); this.aSize.needsUpdate = true;
    }
  }
  clear() { this.n = 0; this.geo.instanceCount = 0; }
}

// ------------------------------------------------------------------------------------------ tracers
function buildTracers() {
  const max = TUNE.maxTracers;
  const g = new THREE.PlaneGeometry(1, 1);
  g.translate(0, 0.5, 0);           // y 0..1 along the streak, x across
  const m = new THREE.MeshBasicMaterial({ map: tex.tracer, color: new THREE.Color(7.0, 3.7, 1.4), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false, toneMapped: true });
  const mesh = new THREE.InstancedMesh(g, m, max);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.renderOrder = 4;
  const list = [];
  for (let i = 0; i < max; i++) list.push({ a: new THREE.Vector3(), b: new THREE.Vector3(), len: 0, t: 0, alive: false, w: 1 });
  return { mesh, list };
}

function spawnTracer(from, to, width = 1) {
  const T = tracers;
  let s = T.list.find((x) => !x.alive);
  if (!s) s = T.list.reduce((m, x) => (x.t > m.t ? x : m), T.list[0]);
  s.a.fromArray(from); s.b.fromArray(to);
  s.len = s.a.distanceTo(s.b);
  if (s.len < 1.5) { s.alive = false; return; }
  s.t = 0; s.alive = true; s.w = width;
}

function updateTracers(dt) {
  const T = tracers, cam = gfx.camera;
  let n = 0;
  for (const s of T.list) {
    if (!s.alive) continue;
    s.t += dt;
    const travel = s.t * TUNE.tracerSpeed;
    // the streak runs past the end point and is gone once its tail arrives (it never parks at the impact)
    if (travel - TUNE.tracerLen >= s.len) { s.alive = false; continue; }
    const head = Math.min(s.len, travel);
    const tail = Math.max(0, travel - TUNE.tracerLen);
    if (head - tail < 0.05) { s.alive = false; continue; }
    vA.subVectors(s.b, s.a).multiplyScalar(1 / s.len);       // dir
    vB.copy(s.a).addScaledVector(vA, tail);                   // tail point
    const L = head - tail;
    // billboard about the streak axis toward the camera
    vC.subVectors(cam.position, vB).normalize();
    vD.crossVectors(vA, vC);
    if (vD.lengthSq() < 1e-8) vD.set(1, 0, 0); else vD.normalize();
    vC.crossVectors(vD, vA).normalize();
    const dist = cam.position.distanceTo(vB);
    // about 5 px wide at 720p (bright core ~1.5 px plus halo) whatever the distance: a physical width vanishes
    const w = Math.max(TUNE.tracerWidth, dist * 0.0075) * s.w;
    mA.makeBasis(vD.multiplyScalar(w), vA.multiplyScalar(L), vC);
    mA.setPosition(vB);
    T.mesh.setMatrixAt(n++, mA);
  }
  T.mesh.count = n;
  if (n) T.mesh.instanceMatrix.needsUpdate = true;
}

// ------------------------------------------------------------------------------------------ muzzle flashes (world)
function buildFlashes() {
  const max = 24;
  const front = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex.flashFront, color: new THREE.Color(3.2, 2.6, 1.9), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }), max);
  const sg = new THREE.PlaneGeometry(1, 0.5); sg.translate(0.5, 0, 0);
  const side = new THREE.InstancedMesh(sg, new THREE.MeshBasicMaterial({ map: tex.flashSide, color: new THREE.Color(3.0, 2.3, 1.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }), max * 2);
  for (const m of [front, side]) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; m.count = 0; m.renderOrder = 4; }
  const list = [];
  for (let i = 0; i < max; i++) list.push({ p: new THREE.Vector3(), d: new THREE.Vector3(), s: 1, t: 0, life: 0.05, alive: false, roll: 0 });
  return { front, side, list };
}

function updateFlashes(dt) {
  const F = flashes;
  let nf = 0, ns = 0;
  for (const f of F.list) {
    if (!f.alive) continue;
    f.t += dt;
    if (f.t >= f.life) { f.alive = false; continue; }
    const k = 1 - f.t / f.life;
    const s = f.s * (0.75 + 0.5 * k);
    // front star facing along the barrel
    qA.setFromUnitVectors(ZAX, f.d);
    dummy.position.copy(f.p);
    dummy.quaternion.copy(qA);
    dummy.rotateZ(f.roll);
    dummy.scale.setScalar(0.32 * s);
    dummy.updateMatrix();
    F.front.setMatrixAt(nf++, dummy.matrix);
    // two crossed side flames along the barrel
    for (let j = 0; j < 2; j++) {
      vA.copy(f.d);
      vB.crossVectors(vA, Math.abs(vA.y) > 0.9 ? ZAX : UP).normalize();
      if (j) vB.applyAxisAngle(vA, Math.PI / 2);
      vC.crossVectors(vA, vB).normalize();
      mA.makeBasis(vE.copy(vA).multiplyScalar(0.55 * s), vB.multiplyScalar(0.55 * s), vC);
      mA.setPosition(f.p);
      F.side.setMatrixAt(ns++, mA);
    }
  }
  F.front.count = nf; F.side.count = ns;
  if (nf) F.front.instanceMatrix.needsUpdate = true;
  if (ns) F.side.instanceMatrix.needsUpdate = true;
}

// ------------------------------------------------------------------------------------------ decals
function buildDecals() {
  const total = qual.decals || 64;
  const fam = { concrete: 0.4, metal: 0.2, wood: 0.2, dirt: 0.2, scorch: 0.08 };
  const out = {};
  for (const [kind, share] of Object.entries(fam)) {
    const n = Math.max(6, Math.round(total * share));
    const map = kind === 'scorch' ? tex.scorch : tex['decal_' + kind];
    const m = new THREE.MeshStandardMaterial({
      map, transparent: true, depthWrite: false, roughness: kind === 'metal' ? 0.45 : 0.95, metalness: kind === 'metal' ? 0.6 : 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, envMapIntensity: 0.6,
    });
    const g = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.InstancedMesh(g, m, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    out[kind] = { mesh, n, next: 0 };
  }
  return out;
}

function decalKind(surface) {
  switch (surface) {
    case SURFACE.METAL: return 'metal';
    case SURFACE.WOOD: return 'wood';
    case SURFACE.GRASS: case SURFACE.DIRT: case SURFACE.SAND: return 'dirt';
    case SURFACE.WATER: case SURFACE.FLESH: return null;
    default: return 'concrete';
  }
}

/** Place a bullet hole (or scorch) on a surface. point/normal arrays. */
export function decal(point, normal, surface, scale = 1, kindOverride = null) {
  const kind = kindOverride || decalKind(surface);
  if (!kind || !decals[kind]) return;
  const D = decals[kind];
  const size = (kindOverride === 'scorch' ? 1 : TUNE.decalSize[kind]) * scale * rnd(0.8, 1.2);
  vA.fromArray(normal).normalize();
  qA.setFromUnitVectors(ZAX, vA);
  dummy.position.fromArray(point).addScaledVector(vA, 0.004);
  dummy.quaternion.copy(qA);
  dummy.rotateZ(Math.random() * Math.PI * 2);
  dummy.scale.set(size, size, 1);
  dummy.updateMatrix();
  D.mesh.setMatrixAt(D.next, dummy.matrix);
  D.next = (D.next + 1) % D.n;
  D.mesh.count = Math.min(D.n, Math.max(D.mesh.count, D.next === 0 ? D.n : D.next));
  D.mesh.instanceMatrix.needsUpdate = true;
}

// ------------------------------------------------------------------------------------------ casings (world)
function buildCasings() {
  const g = new THREE.CylinderGeometry(0.0055, 0.0055, 0.042, 8, 1);
  g.rotateZ(Math.PI / 2);
  const m = new THREE.MeshStandardMaterial({ color: 0xc8a050, metalness: 1, roughness: 0.32 });
  const mesh = new THREE.InstancedMesh(g, m, TUNE.maxCasings);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false; mesh.count = 0;
  const list = [];
  for (let i = 0; i < TUNE.maxCasings; i++) list.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), rv: new THREE.Vector3(), t: 0, alive: false, rest: false, gy: 0, bounces: 0 });
  return { mesh, list, next: 0 };
}

function ejectCasing(pos, dir, pistol) {
  const C = casings;
  const c = C.list[C.next];
  C.next = (C.next + 1) % C.list.length;
  vA.fromArray(dir);
  vB.crossVectors(vA, UP); if (vB.lengthSq() < 1e-6) vB.set(1, 0, 0); else vB.normalize();   // right of the shooter
  c.p.fromArray(pos).addScaledVector(vA, -0.45).addScaledVector(vB, 0.06);
  c.v.copy(vB).multiplyScalar(rnd(1.8, 2.8)).addScaledVector(UP, rnd(1.4, 2.4)).addScaledVector(vA, rnd(-0.6, 0.2));
  c.r.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
  c.rv.set(rnd(-25, 25), rnd(-25, 25), rnd(-25, 25));
  c.t = 0; c.alive = true; c.rest = false; c.bounces = 0;
  c.gy = world.getGround(c.p.x, c.p.z, c.p.y).y;
  c.scale = pistol ? 0.7 : 1;
}

function updateCasings(dt) {
  const C = casings;
  let n = 0;
  for (const c of C.list) {
    if (!c.alive) continue;
    c.t += dt;
    if (c.t > 6) { c.alive = false; continue; }
    if (!c.rest) {
      c.v.y -= 9.81 * dt;
      c.p.addScaledVector(c.v, dt);
      c.r.x += c.rv.x * dt; c.r.y += c.rv.y * dt; c.r.z += c.rv.z * dt;
      if (c.p.y < c.gy + 0.006) {
        c.p.y = c.gy + 0.006;
        if (c.bounces++ < 2 && c.v.y < -0.6) { c.v.y = -c.v.y * 0.35; c.v.x *= 0.5; c.v.z *= 0.5; c.rv.multiplyScalar(0.5); }
        else { c.rest = true; c.r.x = Math.PI / 2 * Math.round(c.r.x / (Math.PI / 2)); c.r.z = 0; }
      }
    }
    dummy.position.copy(c.p);
    dummy.rotation.copy(c.r);
    dummy.scale.setScalar(c.scale || 1);
    dummy.updateMatrix();
    C.mesh.setMatrixAt(n++, dummy.matrix);
  }
  C.mesh.count = n;
  if (n) C.mesh.instanceMatrix.needsUpdate = true;
}

// ------------------------------------------------------------------------------------------ lights
function ensureLights() {
  const want = state.quality !== 'low';
  if (want && !muzzleLight) {
    muzzleLight = new THREE.PointLight(0xffb060, 0, TUNE.muzzleLight.distance, 2);
    boomLight = new THREE.PointLight(0xff9a40, 0, TUNE.explosionLight.distance, 2);
    muzzleLight.castShadow = false; boomLight.castShadow = false;
    scene.add(muzzleLight, boomLight);
  } else if (!want && muzzleLight) {
    muzzleLight.removeFromParent(); boomLight.removeFromParent();
    muzzleLight = null; boomLight = null;
  }
}

/** Flash the shared muzzle light at a world position (used by the viewmodel too). */
export function muzzleLightAt(pos, scale = 1) {
  if (!muzzleLight) return;
  muzzleLight.position.fromArray(pos);
  muzzleLight.intensity = TUNE.muzzleLight.intensity * scale;
  muzzleLightT = TUNE.muzzleLight.life;
}

/** Shared procedural textures (the viewmodel builds its own flash cards from them). */
export function textures() { return tex; }

// ------------------------------------------------------------------------------------------ public effects
/** @param {number[]} pos @param {number[]} dir @param {number} [scale] */
/** Rocket exhaust at p (array): a hot flame core and a puff of grey smoke that lingers (combat/rockets.js). */
export function rocketTrail(p, dir) {
  if (!inited) return;
  addSys.spawn(p[0], p[1], p[2], -dir[0] * 3, -dir[1] * 3, -dir[2] * 3, rnd(0.05, 0.09), 0.22, 0.08, 3.2, 2.0, 0.9, 1, 4, 0, 0, 0);
  alphaSys.spawn(p[0] + rnd(-0.05, 0.05), p[1] + rnd(-0.05, 0.05), p[2] + rnd(-0.05, 0.05), rnd(-0.25, 0.25), 0.3 + rnd(0, 0.3), rnd(-0.25, 0.25),
    rnd(1.6, 2.6), 0.16, 1.2, 0.8, 0.79, 0.77, 0.42, 1.4, -0.12, 0, 0.04);
}

export function muzzleFlash(pos, dir, scale = 1) {
  if (!inited) return;
  const f = flashes.list.find((x) => !x.alive) || flashes.list[0];
  f.p.fromArray(pos); f.d.fromArray(dir).normalize(); f.s = scale; f.t = 0; f.life = 0.045 + Math.random() * 0.02; f.alive = true; f.roll = Math.random() * 6.28;
  // a puff of gas
  const q = qual.particles;
  if (Math.random() < q) alphaSys.spawn(f.p.x + f.d.x * 0.1, f.p.y + f.d.y * 0.1, f.p.z + f.d.z * 0.1, f.d.x * 1.5, f.d.y * 1.5 + 0.2, f.d.z * 1.5, rnd(0.5, 0.9), 0.08 * scale, 0.45 * scale, 0.75, 0.74, 0.72, 0.16, 2.5, -0.15, 0, 0.02);
  muzzleLightAt(pos, scale);
}

/** @param {number[]} from @param {number[]} to */
export function tracer(from, to) { if (inited) spawnTracer(from, to, 1); }

/** @param {number[]} point @param {number[]} normal @param {number} surface config.SURFACE id */
export function impact(point, normal, surface) {
  if (!inited) return;
  const q = qual.particles;
  const [px, py, pz] = point;
  const nx = normal[0], ny = normal[1], nz = normal[2];
  const camD = gfx.camera ? gfx.camera.position.distanceTo(vD.fromArray(point)) : 10;
  const far = camD > 120 ? 0.4 : 1;
  const count = (n) => Math.max(1, Math.round(n * q * far));
  const spray = (n, speed, cone, cb) => {
    for (let i = 0; i < n; i++) {
      vA.set(nx, ny, nz).add(vB.set(rnd(-cone, cone), rnd(-cone, cone), rnd(-cone, cone))).normalize().multiplyScalar(speed * rnd(0.5, 1.2));
      cb(vA);
    }
  };
  switch (surface) {
    case SURFACE.METAL: {
      spray(count(12), 9, 0.9, (v) => addSys.spawn(px, py, pz, v.x, v.y, v.z, rnd(0.12, 0.35), 0.02, 0.012, 3.2, 2.2, 1.2, 1, 1.5, 9.8, 0.035, 0));
      addSys.spawn(px + nx * 0.02, py + ny * 0.02, pz + nz * 0.02, 0, 0, 0, 0.06, 0.18, 0.1, 3, 2.4, 1.6, 1, 0, 0, 0, 0);
      spray(count(2), 0.6, 0.4, (v) => alphaSys.spawn(px, py, pz, v.x, v.y + 0.2, v.z, rnd(0.6, 1.0), 0.06, 0.3, 0.55, 0.53, 0.5, 0.35, 2, -0.1, 0, 0.03));
      break;
    }
    case SURFACE.WOOD: {
      spray(count(8), 4.5, 0.8, (v) => alphaSys.spawn(px, py, pz, v.x, v.y, v.z, rnd(0.5, 0.9), 0.02, 0.015, 0.35, 0.24, 0.13, 1, 1.2, 9.8, 0.012, 0, py - 3));
      spray(count(3), 0.9, 0.5, (v) => alphaSys.spawn(px, py, pz, v.x, v.y + 0.1, v.z, rnd(0.8, 1.3), 0.08, 0.42, 0.62, 0.52, 0.4, 0.4, 2.2, -0.05, 0, 0.03));
      break;
    }
    case SURFACE.GRASS: case SURFACE.DIRT: case SURFACE.SAND: {
      const sand = surface === SURFACE.SAND;
      const cr = sand ? 0.72 : 0.42, cg = sand ? 0.63 : 0.34, cb = sand ? 0.5 : 0.25;
      spray(count(4), 2.6, 0.35, (v) => alphaSys.spawn(px, py, pz, v.x * 0.6, v.y, v.z * 0.6, rnd(0.9, 1.6), 0.1, rnd(0.5, 0.8), cr, cg, cb, 0.55, 2.4, 0.4, 0, 0.03));
      spray(count(9), 5.5, 0.6, (v) => alphaSys.spawn(px, py, pz, v.x, v.y, v.z, rnd(0.5, 0.9), 0.025, 0.02, cr * 0.5, cg * 0.5, cb * 0.5, 1, 0.8, 9.8, 0.02, 0, py - 0.02));
      if (surface === SURFACE.GRASS) spray(count(4), 3, 0.7, (v) => alphaSys.spawn(px, py, pz, v.x, v.y, v.z, rnd(0.6, 1.0), 0.02, 0.02, 0.25, 0.32, 0.12, 1, 2, 4, 0.01, 0, py - 0.02));
      break;
    }
    case SURFACE.WATER: {
      spray(count(14), 5, 0.35, (v) => alphaSys.spawn(px, py, pz, v.x * 0.5, v.y * 1.2, v.z * 0.5, rnd(0.5, 0.9), 0.04, 0.05, 0.86, 0.9, 0.92, 0.85, 0.5, 9.8, 0.02, 0, py - 0.05));
      alphaSys.spawn(px, py + 0.05, pz, 0, 0.6, 0, 0.6, 0.12, 0.6, 0.9, 0.93, 0.95, 0.5, 2, 0, 0, 0.02);
      break;
    }
    case SURFACE.GLASS: {
      spray(count(10), 4, 0.8, (v) => addSys.spawn(px, py, pz, v.x, v.y, v.z, rnd(0.3, 0.7), 0.012, 0.01, 1.4, 1.5, 1.6, 0.9, 0.8, 9.8, 0.01, 0));
      spray(count(2), 0.6, 0.4, (v) => alphaSys.spawn(px, py, pz, v.x, v.y, v.z, 0.7, 0.05, 0.25, 0.8, 0.82, 0.85, 0.25, 2, 0, 0, 0.03));
      break;
    }
    case SURFACE.FLESH: blood(point, [-nx, -ny, -nz]); return;
    default: {
      // concrete, asphalt, rock
      const g0 = surface === SURFACE.ASPHALT ? 0.36 : surface === SURFACE.ROCK ? 0.5 : 0.6;
      // fast burst (reads in the first frames), then the lingering dust and chips
      alphaSys.spawn(px + nx * 0.03, py + ny * 0.03, pz + nz * 0.03, nx * 2.2, ny * 2.2 + 0.2, nz * 2.2, 0.28, 0.12, 0.62, g0 * 0.82, g0 * 0.8, g0 * 0.76, 0.8, 7, 0, 0, 0.01);
      addSys.spawn(px + nx * 0.02, py + ny * 0.02, pz + nz * 0.02, 0, 0, 0, 0.05, 0.09, 0.05, 2.2, 1.7, 1.1, 1, 0, 0, 0, 0);
      spray(count(4), 1.4, 0.45, (v) => alphaSys.spawn(px, py, pz, v.x, v.y + 0.15, v.z, rnd(0.9, 1.6), 0.07, rnd(0.45, 0.75), g0, g0 * 0.97, g0 * 0.93, 0.55, 2.6, -0.06, 0, 0.03));
      spray(count(8), 6, 0.7, (v) => alphaSys.spawn(px, py, pz, v.x, v.y, v.z, rnd(0.4, 0.8), 0.018, 0.014, g0 * 0.6, g0 * 0.58, g0 * 0.55, 1, 0.7, 9.8, 0.02, 0, py - 2));
      if (Math.random() < 0.35) spray(1, 7, 0.6, (v) => addSys.spawn(px, py, pz, v.x, v.y, v.z, 0.12, 0.008, 0.006, 3, 2, 1, 1, 1, 9.8, 0.03, 0));
    }
  }
  decal(point, normal, surface);
}

/** @param {number[]} point @param {number[]} dir */
export function blood(point, dir) {
  if (!inited) return;
  const q = qual.particles;
  const [px, py, pz] = point;
  vC.fromArray(dir).normalize();
  // entry puff back toward the shooter (what the shooter actually sees), then the exit mist and droplets
  for (let i = 0; i < 3; i++) {
    vA.copy(vC).multiplyScalar(-rnd(0.5, 1.2)).add(vB.set(rnd(-0.4, 0.4), rnd(-0.2, 0.5), rnd(-0.4, 0.4)));
    alphaSys.spawn(px - vC.x * 0.05, py, pz - vC.z * 0.05, vA.x, vA.y, vA.z, rnd(0.22, 0.36), 0.1, rnd(0.32, 0.46), 0.62, 0.05, 0.04, 0.9, 6, 0.5, 0, 0.01);
  }
  for (let i = 0; i < Math.max(2, Math.round(5 * q)); i++) {
    vA.copy(vC).multiplyScalar(rnd(0.6, 1.8)).add(vB.set(rnd(-0.6, 0.6), rnd(-0.3, 0.6), rnd(-0.6, 0.6)));
    alphaSys.spawn(px, py, pz, vA.x, vA.y, vA.z, rnd(0.3, 0.5), 0.1, rnd(0.45, 0.7), 0.5, 0.04, 0.03, 0.78, 5, 0.6, 0, 0.01);
  }
  for (let i = 0; i < Math.max(3, Math.round(9 * q)); i++) {
    vA.copy(vC).multiplyScalar(rnd(1.5, 4)).add(vB.set(rnd(-1, 1), rnd(-0.5, 1.2), rnd(-1, 1)));
    alphaSys.spawn(px, py, pz, vA.x, vA.y, vA.z, rnd(0.35, 0.6), 0.026, 0.018, 0.4, 0.025, 0.02, 1, 0.5, 9.8, 0.015, 0);
  }
}

/** @param {number[]} point */
export function explosion(point, water = false) {
  if (!inited) return;
  const q = Math.max(0.5, qual.particles);
  const [px, py, pz] = point;
  let gy = py;
  try { gy = world.getGround(px, pz, py + 0.5).y; } catch (e) { gy = py; }
  if (water) {
    for (let i = 0; i < Math.round(40 * q); i++) {
      vA.set(rnd(-0.35, 0.35), 1, rnd(-0.35, 0.35)).normalize().multiplyScalar(rnd(6, 16));
      alphaSys.spawn(px, py, pz, vA.x, vA.y, vA.z, rnd(1.0, 2.0), 0.2, rnd(0.6, 1.4), 0.88, 0.92, 0.95, 0.85, 0.6, 9.8, 0.0, 0.03, py - 0.1);
    }
    for (let i = 0; i < Math.round(10 * q); i++) alphaSys.spawn(px + rnd(-1, 1), py + 0.3, pz + rnd(-1, 1), rnd(-2, 2), rnd(0.5, 2), rnd(-2, 2), rnd(2, 3.5), 1, 3.5, 0.9, 0.92, 0.94, 0.4, 1.4, -0.1, 0, 0.1);
    flashLight(point, 0.4);
    return;
  }
  // brief white-hot flash, then a billowing fireball (cloudy additive puffs cooling from yellow to deep orange)
  addSys.spawn(px, py + 0.5, pz, 0, 0, 0, 0.07, 1.6, 4.2, 2.4, 1.9, 1.3, 1, 0, 0, 0, 0);
  for (let i = 0; i < Math.round(14 * q); i++) {
    vA.set(rnd(-1, 1), rnd(0.15, 1.3), rnd(-1, 1)).normalize().multiplyScalar(rnd(2.5, 8));
    const hot = Math.random();
    fireSys.spawn(px + vA.x * 0.04, py + 0.35, pz + vA.z * 0.04, vA.x, vA.y, vA.z, rnd(0.26, 0.5), rnd(0.5, 0.9), rnd(2.0, 3.4),
      2.6 + hot * 0.8, 1.05 + hot * 0.7, 0.25 + hot * 0.25, 1, 6, -1.5, 0, 0.015);
  }
  for (let i = 0; i < Math.round(6 * q); i++) {
    vA.set(rnd(-1, 1), rnd(0.6, 1.5), rnd(-1, 1)).normalize().multiplyScalar(rnd(3, 6));
    fireSys.spawn(px, py + 0.5, pz, vA.x, vA.y, vA.z, rnd(0.45, 0.7), rnd(0.8, 1.2), rnd(2.4, 3.6), 1.5, 0.42, 0.1, 0.9, 4, -2.5, 0, 0.05);
  }
  // dirt geyser: heavy brown puffs and clods thrown up, falling back
  for (let i = 0; i < Math.round(12 * q); i++) {
    vA.set(rnd(-0.45, 0.45), 1, rnd(-0.45, 0.45)).normalize().multiplyScalar(rnd(5, 12));
    alphaSys.spawn(px, gy + 0.2, pz, vA.x, vA.y, vA.z, rnd(1.1, 1.9), rnd(0.3, 0.5), rnd(1.3, 2.4), 0.3, 0.25, 0.19, 0.85, 1.6, 6, 0, 0.04, gy + 0.2);
  }
  // smoke column (dark, slowly rising and spreading) and ground dust ring
  for (let i = 0; i < Math.round(16 * q); i++) {
    const a = rnd(0.13, 0.24);
    alphaSys.spawn(px + rnd(-0.7, 0.7), py + rnd(0.3, 1.5), pz + rnd(-0.7, 0.7), rnd(-1.2, 1.2), rnd(1.2, 4), rnd(-1.2, 1.2), rnd(3.5, 6.5), rnd(1.2, 2.2), rnd(5, 8), a, a * 0.95, a * 0.9, 0.82, 1.0, -0.3, 0, 0.18);
  }
  for (let i = 0; i < Math.round(16 * q); i++) {
    const ang = (i / 16) * Math.PI * 2 + rnd(-0.2, 0.2);
    alphaSys.spawn(px, gy + 0.3, pz, Math.cos(ang) * rnd(5, 9), rnd(0.3, 1.2), Math.sin(ang) * rnd(5, 9), rnd(1.6, 2.8), 0.8, rnd(2.5, 4), 0.55, 0.49, 0.4, 0.6, 2.2, -0.05, 0, 0.08);
  }
  // fragments and sparks
  for (let i = 0; i < Math.round(30 * q); i++) {
    vA.set(rnd(-1, 1), rnd(0, 1), rnd(-1, 1)).normalize().multiplyScalar(rnd(10, 26));
    addSys.spawn(px, py + 0.2, pz, vA.x, vA.y, vA.z, rnd(0.25, 0.6), 0.03, 0.02, 3, 1.8, 0.8, 1, 0.5, 9.8, 0.03, 0);
  }
  for (let i = 0; i < Math.round(22 * q); i++) {
    vA.set(rnd(-1, 1), rnd(0.3, 1.2), rnd(-1, 1)).normalize().multiplyScalar(rnd(4, 12));
    alphaSys.spawn(px, py + 0.2, pz, vA.x, vA.y, vA.z, rnd(0.9, 1.8), rnd(0.05, 0.11), 0.06, 0.13, 0.1, 0.075, 1, 0.3, 9.8, 0.01, 0, gy);
  }
  flashLight(point, 1);
  decal([px, gy + 0.01, pz], [0, 1, 0], SURFACE.DIRT, rnd(2.6, 3.4), 'scorch');
}

function flashLight(point, k) {
  if (!boomLight) return;
  boomLight.position.set(point[0], point[1] + 1, point[2]);
  boomK = k;
  boomLight.intensity = TUNE.explosionLight.intensity * k;
  boomLightT = TUNE.explosionLight.life;
}

/** @param {number[]} point @param {number} amount 0..1 */
export function dust(point, amount = 1) {
  if (!inited) return;
  const q = qual.particles;
  const [px, py, pz] = point;
  let surf = SURFACE.DIRT;
  try { surf = world.getSurface(px, pz); } catch (e) { surf = SURFACE.DIRT; }
  if (surf === SURFACE.WATER) { impact(point, [0, 1, 0], SURFACE.WATER); return; }
  const sand = surf === SURFACE.SAND, grass = surf === SURFACE.GRASS, hard = surf === SURFACE.CONCRETE || surf === SURFACE.ASPHALT || surf === SURFACE.ROCK || surf === SURFACE.METAL || surf === SURFACE.WOOD;
  const r = sand ? 0.7 : grass ? 0.46 : hard ? 0.55 : 0.5, g = sand ? 0.62 : grass ? 0.42 : hard ? 0.53 : 0.43, b = sand ? 0.5 : grass ? 0.32 : hard ? 0.5 : 0.34;
  const n = Math.max(2, Math.round((4 + 8 * amount) * q));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rnd(-0.3, 0.3);
    const s = rnd(1, 2.5) * (0.5 + amount);
    alphaSys.spawn(px + Math.cos(a) * 0.2, py + 0.08, pz + Math.sin(a) * 0.2, Math.cos(a) * s, rnd(0.1, 0.6), Math.sin(a) * s, rnd(0.8, 1.5), 0.2, rnd(0.7, 1.2) * (0.6 + amount * 0.6), r, g, b, hard ? 0.25 : 0.42, 3, -0.05, 0, 0.05);
  }
}

// ------------------------------------------------------------------------------------------ events
function onFire(e) {
  const W = WEAPONS[e.weapon];
  if (!W) return;
  const fp = e.local && state.local.mode === 'fp';
  const muzzle = e.muzzle || e.origin;
  const camPos = gfx.camera ? gfx.camera.position : null;
  const nearCam = camPos ? camPos.distanceTo(vD.fromArray(muzzle)) : 0;
  const scale = W.class === 'sniper' ? 1.35 : W.class === 'pistol' ? 0.7 : W.class === 'smg' ? 0.8 : 1;
  // First-person flash belongs to the viewmodel; scoped shots show none (the scope fills the screen).
  if (!fp && !(e.local && state.local.scoped) && nearCam < 600) muzzleFlash(muzzle, e.dir, scale);
  if (fp || (e.local && state.local.scoped)) muzzleLightAt(muzzle, scale);
  // first person: propellant smoke drifts off the muzzle (the flash itself is drawn by the viewmodel)
  if (fp && !state.local.scoped && Math.random() < 0.7 * qual.particles + 0.2) {
    const d = e.dir;
    alphaSys.spawn(muzzle[0] + d[0] * 0.45, muzzle[1] + d[1] * 0.45 + 0.02, muzzle[2] + d[2] * 0.45, d[0] * 0.9 + rnd(-0.15, 0.15), 0.25 + rnd(0, 0.2), d[2] * 0.9 + rnd(-0.15, 0.15),
      rnd(0.7, 1.2), 0.05 * scale, 0.32 * scale, 0.78, 0.77, 0.75, 0.13, 2.2, -0.2, 0, 0.03);
  }
  // Tracers: every remote shot, every 3rd local one (never from inside the scope).
  let draw = !e.local && W.class !== 'launcher';
  if (e.local && W.class !== 'launcher') { localShots++; draw = localShots % TUNE.localTracerEvery === 1 && !state.local.scoped; }
  if (draw) {
    vA.fromArray(e.dir);
    // start the streak a little ahead of the muzzle so it never covers the barrel
    const from = [muzzle[0] + vA.x * 1.2, muzzle[1] + vA.y * 1.2, muzzle[2] + vA.z * 1.2];
    spawnTracer(from, e.end, W.class === 'sniper' ? 1.4 : 1);
  }
  // Brass for third-person / remote rifles and pistols nearby.
  if (!fp && W.mode !== 'bolt' && W.class !== 'launcher' && nearCam < TUNE.casingRange) ejectCasing(muzzle, e.dir, W.class === 'pistol');
  const h = e.hit;
  if (e.pen) { impact(e.pen.point, e.pen.normal, e.pen.surface); impact(e.pen.exit, [e.dir[0], e.dir[1], e.dir[2]], e.pen.surface); }
  if (!h) return;
  if (h.kind === 'world') impact(e.end, h.normal || [-e.dir[0], -e.dir[1], -e.dir[2]], h.surface);
  else if (h.kind === 'player') blood(e.end, e.dir);
}

export function init(sc) {
  if (inited) return;
  if (!sc) throw err('init needs the scene');
  scene = sc;
  qual = QUALITY[state.quality] || QUALITY.medium;
  tex.puff = puffTexture();
  tex.glow = glowTexture();
  tex.flashFront = flashFrontTexture();
  tex.flashSide = flashSideTexture();
  tex.tracer = tracerTexture();
  tex.scorch = scorchTexture();
  for (const k of ['concrete', 'metal', 'wood', 'dirt']) tex['decal_' + k] = decalTexture(k);
  alphaSys = new Particles(TUNE.maxAlpha, tex.puff, false);
  addSys = new Particles(TUNE.maxAdd, tex.glow, true);
  fireSys = new Particles(TUNE.maxFire, tex.puff, true);     // billowing fire (cloudy texture, additive)
  tracers = buildTracers();
  flashes = buildFlashes();
  decals = buildDecals();
  casings = buildCasings();
  scene.add(alphaSys.mesh, addSys.mesh, fireSys.mesh, tracers.mesh, flashes.front, flashes.side, casings.mesh);
  for (const d of Object.values(decals)) scene.add(d.mesh);
  ensureLights();
  inited = true;
  on(EV.WEAPON_FIRE, onFire);
  on(EV.GRENADE_EXPLODE, ({ pos, water }) => explosion(pos, !!water));
  on(EV.GRENADE_BOUNCE, ({ pos, speed }) => { if (pos && speed > 3) dust(pos, 0.1); });
  on(EV.PLAYER_LAND, ({ pos, speed }) => { if (pos && speed > 3) dust(pos, clamp((speed - 3) / 12, 0.15, 1)); });
  on(EV.QUALITY_CHANGED, ({ tier }) => { qual = QUALITY[tier] || qual; ensureLights(); });
  on(EV.MATCH_START, clearAll);
  debug.combat = debug.combat || {};
  Object.assign(debug.combat, {
    vfxStats: () => ({ alpha: alphaSys.n, add: addSys.n, fire: fireSys.n, tracers: tracers.mesh.count, flashes: flashes.front.count, casings: casings.mesh.count,
      decals: Object.fromEntries(Object.entries(decals).map(([k, d]) => [k, d.mesh.count])), lights: !!muzzleLight }),
    clearDecals: () => { for (const d of Object.values(decals)) { d.mesh.count = 0; d.next = 0; } },
  });
}

function clearAll() {
  alphaSys.clear(); addSys.clear(); fireSys.clear();
  for (const t of tracers.list) t.alive = false;
  for (const f of flashes.list) f.alive = false;
  for (const c of casings.list) c.alive = false;
  for (const d of Object.values(decals)) { d.mesh.count = 0; d.next = 0; }
}

export function update(dt) {
  if (!inited) return;
  alphaSys.update(dt);
  addSys.update(dt);
  fireSys.update(dt);
  updateTracers(dt);
  updateFlashes(dt);
  updateCasings(dt);
  if (muzzleLight) {
    muzzleLightT -= dt;
    muzzleLight.intensity = muzzleLightT > 0 ? muzzleLight.intensity * Math.exp(-dt * 40) : 0;
    boomLightT -= dt;
    boomLight.intensity = boomLightT > 0 ? TUNE.explosionLight.intensity * boomK * Math.pow(boomLightT / TUNE.explosionLight.life, 1.5) : 0;
  }
}
