// BLOKSTORM - everything three.js draws apart from the characters: block meshes, sky, the zone wall,
// flat 2D item sprites and pixel particles.
import * as THREE from 'three';
import { WORLD, BLOCKS, ITEMS } from './config.js';
import { blockAtlas, tileUV, itemCanvas } from './textures.js';

const { CHUNK, CX, CZ, H } = WORLD;

export function pixelTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const itemTex = new Map();
export function itemTexture(id) {
  if (!itemTex.has(id)) itemTex.set(id, pixelTexture(itemCanvas(id)));
  return itemTex.get(id);
}
let atlasTex = null;
/** Block texture. Close by it keeps hard pixels; far away it switches to smaller copies so the ground does not shimmer. */
export function atlasTexture() {
  if (!atlasTex) {
    atlasTex = pixelTexture(blockAtlas());
    atlasTex.generateMipmaps = true;
    atlasTex.minFilter = THREE.NearestMipmapLinearFilter;
  }
  return atlasTex;
}

// ---- item models ----
// Blocks are small 3D cubes. Everything else is its 16x16 sprite given one pixel of thickness: every solid pixel
// gets a front, a back and side walls where it borders an empty pixel.
const itemGeo = new Map(), itemMat = new Map();
export const isBlockItem = (id) => !!ITEMS[id] && ITEMS[id].kind === 'block';

function cubeGeometry(def) {
  const geo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const tiles = [def.side, def.side, def.top, def.bottom, def.side, def.side], light = [0.8, 0.8, 1, 0.5, 0.66, 0.66];
  const uv = geo.attributes.uv, col = new Float32Array(72);
  tiles.forEach((t, f) => {
    const [u0, v0, u1, v1] = tileUV(t);
    uv.setXY(f * 4, u0, v1); uv.setXY(f * 4 + 1, u1, v1); uv.setXY(f * 4 + 2, u0, v0); uv.setXY(f * 4 + 3, u1, v0);
    col.fill(light[f], f * 12, f * 12 + 12);
  });
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}
function spriteGeometry(id) {
  const N = 16, th = 1 / N / 2, c = itemCanvas(id);
  const d = c.getContext('2d').getImageData(0, 0, N, N).data;
  const solid = (x, y) => x >= 0 && y >= 0 && x < N && y < N && d[(y * N + x) * 4 + 3] > 0;
  const pos = [], uv = [], col = [], idx = [];
  const quad = (p, u, shade) => {
    const b = pos.length / 3;
    for (let i = 0; i < 4; i++) { pos.push(p[i][0], p[i][1], p[i][2]); uv.push(u[i][0], u[i][1]); col.push(shade, shade, shade); }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (!solid(x, y)) continue;
    const x0 = x / N - 0.5, x1 = (x + 1) / N - 0.5, y1 = 0.5 - y / N, y0 = 0.5 - (y + 1) / N;
    const e = 0.004, u0 = x / N + e, u1 = (x + 1) / N - e, v1 = 1 - y / N - e, v0 = 1 - (y + 1) / N + e;
    const mid = [(u0 + u1) / 2, (v0 + v1) / 2], m4 = [mid, mid, mid, mid];
    quad([[x0, y0, th], [x1, y0, th], [x1, y1, th], [x0, y1, th]], [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], 1);
    quad([[x1, y0, -th], [x0, y0, -th], [x0, y1, -th], [x1, y1, -th]], [[u1, v0], [u0, v0], [u0, v1], [u1, v1]], 0.82);
    if (!solid(x - 1, y)) quad([[x0, y0, -th], [x0, y0, th], [x0, y1, th], [x0, y1, -th]], m4, 0.7);
    if (!solid(x + 1, y)) quad([[x1, y0, th], [x1, y0, -th], [x1, y1, -th], [x1, y1, th]], m4, 0.7);
    if (!solid(x, y - 1)) quad([[x0, y1, th], [x1, y1, th], [x1, y1, -th], [x0, y1, -th]], m4, 0.92);
    if (!solid(x, y + 1)) quad([[x0, y0, -th], [x1, y0, -th], [x1, y0, th], [x0, y0, th]], m4, 0.55);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}
function itemParts(id) {
  if (!itemGeo.has(id)) {
    const block = isBlockItem(id);
    itemGeo.set(id, block ? cubeGeometry(BLOCKS[ITEMS[id].block]) : spriteGeometry(id));
    itemMat.set(id, new THREE.MeshBasicMaterial({ map: block ? atlasTexture() : itemTexture(id), vertexColors: true }));
  }
  return [itemGeo.get(id), itemMat.get(id)];
}
/** A new mesh showing an item. */
export function makeItem(id) { const [g, m] = itemParts(id); const mesh = new THREE.Mesh(g, m); mesh.userData.id = id; return mesh; }
/** Change which item an existing mesh shows. */
export function setItem(mesh, id) { if (mesh.userData.id === id) return; const [g, m] = itemParts(id); mesh.geometry = g; mesh.material = m; mesh.userData.id = id; }

// corner order per face: bottom left, bottom right, top right, top left (seen from outside)
const FACES = [
  { n: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], s: 0.8, t: 'side' },
  { n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], s: 0.8, t: 'side' },
  { n: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], s: 1, t: 'top' },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], s: 0.5, t: 'bottom' },
  { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], s: 0.66, t: 'side' },
  { n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], s: 0.66, t: 'side' },
];

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.gl.setPixelRatio(1);
    this.scale = 1;
    this.scene = new THREE.Scene();
    this.sky = new THREE.Color('#8fc4e6');
    this.scene.background = this.sky;
    this.scene.fog = new THREE.Fog(this.sky, 70, 190);
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.05, 500);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    this.blockMat = new THREE.MeshBasicMaterial({ map: atlasTexture(), vertexColors: true });
    // the hand is drawn as its own layer on top of the world, so a held item never pokes through a wall
    this.handScene = new THREE.Scene();
    this.handCamera = new THREE.PerspectiveCamera(62, 1, 0.01, 10);
    this.chunks = new Map();
    this.worldGroup = new THREE.Group();
    this.scene.add(this.worldGroup);

    this.#sky();
    this.#zone();
    this.#particles();
    this.#highlight();
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  setScale(s) { this.scale = s; this.resize(); }
  resize() {
    const w = innerWidth, h = innerHeight;
    // scale 1 = full sharpness of the screen; higher numbers give the chunky pixel look
    const pr = this.scale === 1 ? Math.min(devicePixelRatio || 1, 2) : 1 / this.scale;
    this.gl.setSize(Math.max(160, Math.round(w * pr)), Math.max(90, Math.round(h * pr)), false);
    this.canvas.style.imageRendering = this.scale === 1 ? 'auto' : 'pixelated';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.handCamera.aspect = w / h;
    this.handCamera.updateProjectionMatrix();
  }

  #sky() {
    // pixel clouds: flat white slabs drifting over the map
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({ color: '#f4f8fb', fog: false, transparent: true, opacity: 0.92 });
    const n = 70;
    this.clouds = new THREE.InstancedMesh(geo, mat, n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    let seed = 99;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      p.set((r() - 0.5) * 520, 62 + r() * 14, (r() - 0.5) * 520);
      s.set(8 + Math.floor(r() * 5) * 4, 2, 6 + Math.floor(r() * 4) * 4);
      this.clouds.setMatrixAt(i, m.compose(p, q, s));
    }
    this.scene.add(this.clouds);
    // sky dome: deeper blue overhead, pale at the horizon
    const dome = new THREE.SphereGeometry(420, 24, 14);
    const top = new THREE.Color('#3f8fd8'), mid = new THREE.Color('#8fc4e6'), low = new THREE.Color('#d6ecf7'), c = new THREE.Color();
    const dc = new Float32Array(dome.attributes.position.count * 3);
    for (let i = 0; i < dome.attributes.position.count; i++) {
      const h = dome.attributes.position.getY(i) / 420;
      if (h > 0) c.copy(mid).lerp(top, Math.min(1, h * 1.6)); else c.copy(mid).lerp(low, Math.min(1, -h * 3));
      dc[i * 3] = c.r; dc[i * 3 + 1] = c.g; dc[i * 3 + 2] = c.b;
    }
    dome.setAttribute('color', new THREE.BufferAttribute(dc, 3));
    this.dome = new THREE.Mesh(dome, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    this.dome.renderOrder = -10; this.dome.frustumCulled = false;
    this.scene.add(this.dome);
    const sun = new THREE.Mesh(new THREE.PlaneGeometry(26, 26), new THREE.MeshBasicMaterial({ color: '#fff3c4', fog: false }));
    sun.position.set(CX + 140, 150, CZ - 180); sun.lookAt(CX, 20, CZ);
    this.scene.add(sun);
  }

  #zone() {
    const c = document.createElement('canvas'); c.width = c.height = 16;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(255,255,255,.28)'; g.fillRect(0, 0, 16, 16);
    g.fillStyle = 'rgba(255,255,255,1)'; g.fillRect(0, 0, 16, 1); g.fillRect(0, 0, 1, 16);
    const tex = pixelTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;   // no flickering grid in the distance
    this.zoneTex = tex;
    this.zoneMat = new THREE.MeshBasicMaterial({ map: tex, color: '#20e7b7', transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false, fog: false });
    this.zone = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 120, 72, 1, true), this.zoneMat);
    this.zone.position.set(CX, 20, CZ);
    this.zone.visible = false;
    this.scene.add(this.zone);
  }
  setZone(radius, closing, t, opacity = 0.3) {
    this.zone.visible = radius > 0;
    if (!this.zone.visible) return;
    this.zone.scale.set(radius, 1, radius);
    this.zoneTex.repeat.set(Math.max(4, Math.round(radius * 6.28 / 4)), 30);
    this.zoneTex.offset.y = -t * 0.15;
    this.zoneMat.color.set(closing ? '#e5484d' : '#20e7b7');
    this.zoneMat.opacity = opacity;
  }

  #particles() {
    this.pMax = 400;
    this.pPos = new Float32Array(this.pMax * 3); this.pCol = new Float32Array(this.pMax * 3);
    this.pVel = new Float32Array(this.pMax * 3); this.pLife = new Float32Array(this.pMax);
    this.pNext = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.16, vertexColors: true, sizeAttenuation: true }));
    this.points.frustumCulled = false;
    this.pPos.fill(-999);
    this.scene.add(this.points);
  }
  burst(x, y, z, color, n = 10, speed = 3) {
    const c = new THREE.Color(color);
    for (let k = 0; k < n; k++) {
      const i = this.pNext; this.pNext = (this.pNext + 1) % this.pMax;
      this.pPos[i * 3] = x; this.pPos[i * 3 + 1] = y; this.pPos[i * 3 + 2] = z;
      this.pVel[i * 3] = (Math.random() - 0.5) * speed; this.pVel[i * 3 + 1] = Math.random() * speed; this.pVel[i * 3 + 2] = (Math.random() - 0.5) * speed;
      const f = 0.8 + Math.random() * 0.4;
      this.pCol[i * 3] = c.r * f; this.pCol[i * 3 + 1] = c.g * f; this.pCol[i * 3 + 2] = c.b * f;
      this.pLife[i] = 0.4 + Math.random() * 0.5;
    }
  }
  #stepParticles(dt) {
    for (let i = 0; i < this.pMax; i++) {
      if (this.pLife[i] <= 0) continue;
      this.pLife[i] -= dt;
      if (this.pLife[i] <= 0) { this.pPos[i * 3 + 1] = -999; continue; }
      this.pVel[i * 3 + 1] -= 14 * dt;
      this.pPos[i * 3] += this.pVel[i * 3] * dt; this.pPos[i * 3 + 1] += this.pVel[i * 3 + 1] * dt; this.pPos[i * 3 + 2] += this.pVel[i * 3 + 2] * dt;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }

  #highlight() {
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004));
    this.highlight = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: '#0b0c0c' }));
    this.highlight.visible = false;
    this.scene.add(this.highlight);
    // breaking overlay: a dark cube that grows more opaque
    this.crack = new THREE.Mesh(new THREE.BoxGeometry(1.01, 1.01, 1.01), new THREE.MeshBasicMaterial({ color: '#0b0c0c', transparent: true, opacity: 0, depthWrite: false }));
    this.crack.visible = false;
    this.scene.add(this.crack);
  }
  setTarget(hit, progress = 0) {
    this.highlight.visible = !!hit;
    this.crack.visible = !!hit && progress > 0;
    if (!hit) return;
    this.highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    this.crack.position.copy(this.highlight.position);
    this.crack.material.opacity = Math.floor(progress * 5) / 5 * 0.7;
  }

  /** Rebuild the meshes of chunks that changed. */
  syncWorld(world, budget = 6) {
    if (!world.dirty.size) return;
    let n = 0;
    for (const key of world.dirty) {
      world.dirty.delete(key);
      const [cx, cy, cz] = key.split(',').map(Number);
      if (cx < 0 || cy < 0 || cz < 0 || cx >= WORLD.W / CHUNK || cy >= H / CHUNK || cz >= WORLD.D / CHUNK) continue;
      this.#buildChunk(world, key, cx, cy, cz);
      if (++n >= budget) break;
    }
  }
  clearWorld() {
    for (const m of this.chunks.values()) { this.worldGroup.remove(m); m.geometry.dispose(); }
    this.chunks.clear();
  }
  #buildChunk(world, key, cx, cy, cz) {
    const pos = [], uv = [], col = [], idx = [];
    const x0 = cx * CHUNK, y0 = cy * CHUNK, z0 = cz * CHUNK;
    for (let y = y0; y < y0 + CHUNK; y++) for (let z = z0; z < z0 + CHUNK; z++) for (let x = x0; x < x0 + CHUNK; x++) {
      const id = world.get(x, y, z);
      if (!id) continue;
      const def = BLOCKS[id];
      for (const f of FACES) {
        const ax = x + f.n[0], ay = y + f.n[1], az = z + f.n[2];
        if (world.get(ax, ay, az)) continue;
        const [u0, v0, u1, v1] = tileUV(def[f.t]);
        const base = pos.length / 3;
        const ao = [];
        for (const c of f.c) {
          pos.push(x + c[0], y + c[1], z + c[2]);
          // ambient occlusion: darker where neighbouring blocks close in on this corner
          const d = [c[0] ? 1 : -1, c[1] ? 1 : -1, c[2] ? 1 : -1];
          const axes = [0, 1, 2].filter((a) => f.n[a] === 0);
          const o1 = [0, 0, 0], o2 = [0, 0, 0];
          o1[axes[0]] = d[axes[0]]; o2[axes[1]] = d[axes[1]];
          const s1 = world.get(ax + o1[0], ay + o1[1], az + o1[2]) ? 1 : 0;
          const s2 = world.get(ax + o2[0], ay + o2[1], az + o2[2]) ? 1 : 0;
          const cr = world.get(ax + o1[0] + o2[0], ay + o1[1] + o2[1], az + o1[2] + o2[2]) ? 1 : 0;
          const a = s1 && s2 ? 0 : 3 - (s1 + s2 + cr);
          ao.push(a);
          const b = f.s * (0.58 + 0.14 * a);
          col.push(b, b, b);
        }
        uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
        if (ao[0] + ao[2] > ao[1] + ao[3]) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        else idx.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
      }
    }
    let mesh = this.chunks.get(key);
    if (!idx.length) {
      if (mesh) { this.worldGroup.remove(mesh); mesh.geometry.dispose(); this.chunks.delete(key); }
      return;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    if (mesh) { mesh.geometry.dispose(); mesh.geometry = geo; }
    else { mesh = new THREE.Mesh(geo, this.blockMat); this.chunks.set(key, mesh); this.worldGroup.add(mesh); }
  }

  /** A soft dark spot on the ground under a character. */
  makeShadow() {
    const m = new THREE.Mesh(new THREE.CircleGeometry(0.42, 12), new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.3, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    this.scene.add(m);
    return m;
  }
  /** Floating number that rises and fades, for damage and healing. */
  popText(text, x, y, z, color = '#ffffff') {
    const c = document.createElement('canvas'); c.width = 64; c.height = 32;
    const g = c.getContext('2d');
    g.font = '24px Silkscreen, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#0b0c0c'; g.fillText(text, 34, 18); g.fillStyle = color; g.fillText(text, 32, 16);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: pixelTexture(c), depthTest: false, transparent: true }));
    s.scale.set(1.1, 0.55, 1); s.position.set(x, y, z); s.renderOrder = 50;
    this.scene.add(s);
    (this.pops || (this.pops = [])).push({ s, life: 0.9, vx: (Math.random() - 0.5) * 0.8 });
  }
  #stepPops(dt) {
    if (!this.pops) return;
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i];
      p.life -= dt; p.s.position.y += dt * 1.3; p.s.position.x += p.vx * dt; p.s.material.opacity = Math.min(1, p.life * 2.5);
      if (p.life <= 0) { this.scene.remove(p.s); p.s.material.map.dispose(); p.s.material.dispose(); this.pops.splice(i, 1); }
    }
  }
  render(dt) {
    this.#stepPops(dt);
    this.dome.position.copy(this.camera.position);
    this.#stepParticles(dt);
    this.clouds.position.x = ((performance.now() / 1000) * 1.2) % 40;
    this.gl.autoClear = true;
    this.gl.render(this.scene, this.camera);
    this.gl.autoClear = false;
    this.gl.clearDepth();
    this.gl.render(this.handScene, this.handCamera);
  }
}
