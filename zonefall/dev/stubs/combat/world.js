// ZONEFALL dev harness stand-in for src/world/world.js (COMBAT group firing range). Not shipped in the game.
// Same exported names as the WORLD facade. A 300 m range with real ray/capsule collision:
//   firing line on a concrete pad at z = 0 looking north (-Z); target lanes at 10/25/50/100/200 m; a backstop berm;
//   a recoil-pattern wall with a painted grid at 25 m (west); a cover row (wood wall, sheet metal, glass pane, concrete
//   block, sandbags) with thin cover a round can pass through; a sunken water trough; props on the line.
// Lit like the island: the RENDER.sky HDRI through PMREM, one shadowed sun following the view, exp2 fog.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SURFACE, RENDER, ASSETS } from '../../../src/config.js';
import * as assets from '../../../src/engine/assets.js';
import { gfx } from '../../../src/core/state.js';
import { clamp, smoothstep } from '../../../src/core/util.js';

const boxes = [];        // {min, max, surface}
const pads = [];         // {x0, x1, z0, z1, surface}
let sun = null, scene = null;
const sunDir = new THREE.Vector3(...RENDER.sunDir).normalize();
let quality = null;

export const RANGE = Object.freeze({
  lanes: [[-5, 10], [2.5, 25], [-2, 50], [4, 100], [0, 200]],     // [x, distance]
  wall: { x0: -24, x1: -14, z: -25, h: 4.2, t: 0.4 },
  cover: { z: -14 },
  trough: { x0: 16, x1: 32, z0: -46, z1: -34 },
  start: [0, 0, 2],
});
const BASE = 0.6;        // ground level above the water line (the trough is sunken)

// ------------------------------------------------------------------------------------------ terrain
export function getHeight(x, z) {
  let h = BASE;
  // backstop berm behind the 200 m lane and side berms
  h += 9 * smoothstep(-226, -242, z);
  h += 4 * smoothstep(60, 90, Math.abs(x)) * smoothstep(20, -20, z);
  h += 0.6 * Math.sin(x * 0.05 + 0.4) * Math.cos(z * 0.04) * smoothstep(30, 60, Math.abs(x));
  // sunken water trough
  const T = RANGE.trough;
  const dx = Math.max(T.x0 - x, 0, x - T.x1), dz = Math.max(T.z0 - z, 0, z - T.z1);
  const d = Math.hypot(dx, dz);
  if (d < 2) h = Math.min(h, BASE - 1.9 * smoothstep(2, 0, d));
  return h;
}
function terrainNormal(x, z, out) {
  const e = 0.25;
  const hx = getHeight(x + e, z) - getHeight(x - e, z), hz = getHeight(x, z + e) - getHeight(x, z - e);
  return out.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
}
export function isWater(x, z) { return getHeight(x, z) < 0; }
export function getSurface(x, z) {
  for (const p of pads) if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1) return p.surface;
  if (isWater(x, z)) return SURFACE.WATER;
  return SURFACE.GRASS;
}

// ------------------------------------------------------------------------------------------ queries
const nTmp = new THREE.Vector3();
export function getGround(x, z, fromY = Infinity) {
  let y = getHeight(x, z), surface = getSurface(x, z), terrain = true;
  const lim = fromY + 1e-3;
  for (const b of boxes) {
    if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
    if (b.max.y <= lim && b.max.y > y) { y = b.max.y; surface = b.surface; terrain = false; }
  }
  if (terrain) { terrainNormal(x, z, nTmp); return { y, normal: [nTmp.x, nTmp.y, nTmp.z], surface }; }
  return { y, normal: [0, 1, 0], surface };
}

const push = new THREE.Vector3(), nrm = new THREE.Vector3();
export function collideCapsule(start, end, radius) {
  push.set(0, 0, 0); nrm.set(0, 0, 0);
  const x = start.x, z = start.z;
  const y0 = Math.min(start.y, end.y) - radius, y1 = Math.max(start.y, end.y) + radius;
  let hit = false;
  for (const b of boxes) {
    if (y1 <= b.min.y || y0 >= b.max.y) continue;
    const cx = clamp(x, b.min.x, b.max.x), cz = clamp(z, b.min.z, b.max.z);
    const dx = x - cx, dz = z - cz;
    const d = Math.hypot(dx, dz);
    if (d >= radius) continue;
    let px, pz;
    if (d > 1e-6) { const pen = radius - d; px = dx / d * pen; pz = dz / d * pen; }
    else {
      const ex = [x - b.min.x, b.max.x - x, z - b.min.z, b.max.z - z];
      let k = 0; for (let i = 1; i < 4; i++) if (ex[i] < ex[k]) k = i;
      const pen = ex[k] + radius;
      px = k === 0 ? -pen : k === 1 ? pen : 0; pz = k === 2 ? -pen : k === 3 ? pen : 0;
    }
    push.x += px; push.z += pz;
    const l = Math.hypot(px, pz) || 1;
    nrm.x += px / l; nrm.z += pz / l;
    hit = true;
  }
  if (hit && nrm.lengthSq() > 0) nrm.normalize();
  return { hit, push: push.clone(), normal: nrm.clone() };
}

/** Slab test; when the origin is inside the box the exit face is returned (double-sided like the real BVH). */
function rayBox(o, d, b, maxD) {
  let tmin = -Infinity, tmax = Infinity, inAxis = -1, inSign = 0, outAxis = -1, outSign = 0;
  for (let i = 0; i < 3; i++) {
    const oi = i === 0 ? o.x : i === 1 ? o.y : o.z;
    const di = i === 0 ? d.x : i === 1 ? d.y : d.z;
    const lo = i === 0 ? b.min.x : i === 1 ? b.min.y : b.min.z;
    const hi = i === 0 ? b.max.x : i === 1 ? b.max.y : b.max.z;
    if (Math.abs(di) < 1e-12) { if (oi < lo || oi > hi) return null; continue; }
    let t1 = (lo - oi) / di, t2 = (hi - oi) / di;
    let s1 = -1, s2 = 1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s1 = 1; s2 = -1; }
    if (t1 > tmin) { tmin = t1; inAxis = i; inSign = s1; }
    if (t2 < tmax) { tmax = t2; outAxis = i; outSign = s2; }
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  if (tmin >= 0) return tmin <= maxD ? { t: tmin, axis: inAxis, sign: inSign } : null;
  return tmax <= maxD ? { t: tmax, axis: outAxis, sign: -outSign } : null;   // inside: exit face, normal facing the ray
}

export function raycast(origin, dir, maxDist) {
  let best = null;
  for (const b of boxes) {
    const h = rayBox(origin, dir, b, maxDist);
    if (h && (!best || h.t < best.distance)) {
      const n = new THREE.Vector3();
      if (h.axis === 0) n.x = h.sign; else if (h.axis === 1) n.y = h.sign; else n.z = h.sign;
      if (n.dot(dir) > 0) n.negate();
      best = { distance: h.t, normal: n, surface: b.surface, kind: 'static' };
    }
  }
  const lim = best ? best.distance : maxDist;
  if (origin.y - getHeight(origin.x, origin.z) > 0) {
    const step = 0.6;
    let prevT = 0;
    for (let t = step; t <= lim + step; t += step) {
      const tt = Math.min(t, lim);
      const x = origin.x + dir.x * tt, y = origin.y + dir.y * tt, z = origin.z + dir.z * tt;
      if (y - getHeight(x, z) <= 0) {
        let a = prevT, bb = tt;
        for (let k = 0; k < 18; k++) {
          const m = (a + bb) * 0.5;
          if (origin.y + dir.y * m - getHeight(origin.x + dir.x * m, origin.z + dir.z * m) > 0) a = m; else bb = m;
        }
        const px = origin.x + dir.x * bb, pz = origin.z + dir.z * bb;
        if (!best || bb < best.distance) best = { distance: bb, normal: terrainNormal(px, pz, new THREE.Vector3()), surface: getSurface(px, pz), kind: 'terrain' };
        break;
      }
      prevT = tt;
      if (tt >= lim) break;
    }
  }
  if (dir.y < -1e-6 && origin.y > 0) {
    const t = -origin.y / dir.y;
    if (t <= maxDist && (!best || t < best.distance)) {
      const px = origin.x + dir.x * t, pz = origin.z + dir.z * t;
      if (isWater(px, pz)) best = { distance: t, normal: new THREE.Vector3(0, 1, 0), surface: SURFACE.WATER, kind: 'water' };
    }
  }
  if (!best) return null;
  best.point = new THREE.Vector3().copy(origin).addScaledVector(dir, best.distance);
  return best;
}

const losD = new THREE.Vector3();
export function lineOfSight(a, b) {
  losD.subVectors(b, a);
  const len = losD.length();
  if (len < 1e-4) return true;
  losD.multiplyScalar(1 / len);
  const h = raycast(a, losD, len);
  return !h || h.distance >= len - 0.02;
}

export function getLootSpawns() { return []; }
export function getNavHints() { return { doors: [], covers: [], sites: [] }; }
export function getMapImage() { const c = document.createElement('canvas'); c.width = c.height = 1024; return c; }
export function getSunDirection() { return [sunDir.x, sunDir.y, sunDir.z]; }
export function setCrateOpen() {}

// ------------------------------------------------------------------------------------------ building
function boxGeo(sx, sy, sz, tile) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  const uv = g.attributes.uv, pos = g.attributes.position, nor = g.attributes.normal;
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let u, v;
    if (nx > 0.5) { u = z; v = y; } else if (ny > 0.5) { u = x; v = z; } else { u = x; v = y; }
    uv.setXY(i, u / tile, v / tile);
  }
  g.setAttribute('uv1', uv.clone());
  return g;
}

function addBox(cx, cy, cz, sx, sy, sz, matId, surface, opts = {}) {
  const tile = ASSETS.textures[matId] || 2;
  const mat = opts.material || assets.pbr(matId, { tint: opts.tint, roughness: opts.roughness, metalness: opts.metalness });
  const mesh = new THREE.Mesh(boxGeo(sx, sy, sz, tile), mat);
  mesh.position.set(cx, cy + sy / 2, cz);
  mesh.castShadow = opts.shadow !== false; mesh.receiveShadow = true;
  mesh.userData.mergeable = !opts.material;
  scene.add(mesh);
  if (opts.collide !== false) boxes.push({ min: new THREE.Vector3(cx - sx / 2, cy, cz - sz / 2), max: new THREE.Vector3(cx + sx / 2, cy + sy, cz + sz / 2), surface });
  return mesh;
}

function addPad(x0, x1, z0, z1, matId, surface, lift = 0.02) {
  pads.push({ x0, x1, z0, z1, surface });
  const tile = ASSETS.textures[matId] || 2;
  const sx = Math.max(1, Math.round((x1 - x0) / 4)), sz = Math.max(1, Math.round((z1 - z0) / 4));
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0, sx, sz);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + (x0 + x1) / 2, z = pos.getZ(i) + (z0 + z1) / 2;
    pos.setY(i, getHeight(x, z) + lift);
    uv.setXY(i, x / tile, z / tile);
  }
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, assets.pbr(matId, {}));
  m.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
  m.receiveShadow = true;
  scene.add(m);
}

function placeProp(key, x, z, rotY = 0, surface = SURFACE.METAL, collide = true) {
  const obj = assets.cloneModel(key);
  const g = getGround(x, z, 50);
  obj.position.set(x, g.y, z);
  obj.rotation.y = rotY;
  scene.add(obj);
  obj.updateMatrixWorld(true);
  if (collide) {
    const bb = new THREE.Box3().setFromObject(obj);
    boxes.push({ min: bb.min.clone(), max: bb.max.clone(), surface });
  }
  return obj;
}

/** Canvas sign with large condensed type (distance markers, labels). */
function signTexture(text, sub) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#e9e7e1'; g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#1a1c1b'; g.fillRect(6, 6, 244, 116);
  g.fillStyle = '#e8b23a'; g.fillRect(6, 100, 244, 6);
  g.fillStyle = '#e9e7e1';
  g.font = '700 64px "Barlow Condensed", "Arial Narrow", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 128, 52);
  if (sub) { g.font = '600 18px "JetBrains Mono", monospace'; g.fillStyle = '#8f948f'; g.fillText(sub, 128, 88); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function addSign(x, z, text, sub, rotY = 0, h = 1.5) {
  const y = getHeight(x, z);
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, h, 0.08), assets.pbr('weathered_brown_planks', {}));
  post.position.set(x, y + h / 2, z);
  post.castShadow = true;
  const board = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.45), new THREE.MeshStandardMaterial({ map: signTexture(text, sub), roughness: 0.8 }));
  board.position.set(x, y + h + 0.1, z + 0.05);
  board.rotation.y = rotY;
  board.castShadow = true;
  scene.add(post, board);
}

/** Painted grid on the recoil wall: 0.25 m lines, 1 m bold lines, centre ring at aim height. */
function gridTexture() {
  const S = 1024, c = document.createElement('canvas'); c.width = S; c.height = S * 0.42;
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const px = S / 10;                       // 10 m wide -> 1 m per px
  for (let i = 0; i <= 40; i++) {
    const x = i * px / 4;
    g.strokeStyle = i % 4 === 0 ? 'rgba(235,232,225,0.75)' : 'rgba(235,232,225,0.28)';
    g.lineWidth = i % 4 === 0 ? 3 : 1.4;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, c.height); g.stroke();
  }
  for (let j = 0; j <= 17; j++) {
    const y = c.height - j * px / 4;
    g.strokeStyle = j % 4 === 0 ? 'rgba(235,232,225,0.75)' : 'rgba(235,232,225,0.28)';
    g.lineWidth = j % 4 === 0 ? 3 : 1.4;
    g.beginPath(); g.moveTo(0, y); g.lineTo(S, y); g.stroke();
  }
  // aim mark at 1.6 m height in the middle
  const cx = S / 2, cy = c.height - 1.6 * px;
  g.strokeStyle = 'rgba(232,178,58,0.95)'; g.lineWidth = 5;
  g.beginPath(); g.arc(cx, cy, px * 0.12, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.moveTo(cx - px * 0.25, cy); g.lineTo(cx + px * 0.25, cy); g.moveTo(cx, cy - px * 0.25); g.lineTo(cx, cy + px * 0.25); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export async function build({ scene: sc, quality: q, onProgress = () => {} }) {
  scene = sc; quality = q;
  const renderer = gfx.renderer;
  const sky = assets.sky(RENDER.sky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(sky.hdr).texture;
  scene.environmentIntensity = RENDER.envIntensity;
  scene.background = sky.bg;
  scene.fog = new THREE.FogExp2(RENDER.fogColor, q.fogDensity * 1.2);
  sun = new THREE.DirectionalLight(RENDER.sunColor, RENDER.sunIntensity);
  sun.castShadow = true;
  sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
  const r = Math.min(70, q.shadowRange);
  Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 500 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.035;
  scene.add(sun, sun.target);
  onProgress(0.2, 'Sky');

  // terrain: 1.2 km of ground, dense around the range
  const seg = 220;
  const tg = new THREE.PlaneGeometry(2, 2, seg, seg);
  tg.rotateX(-Math.PI / 2);
  const pos = tg.attributes.position, uv = tg.attributes.uv;
  const warp = (u) => 150 * u + 450 * u * u * u;
  for (let i = 0; i < pos.count; i++) {
    const x = warp(pos.getX(i)), z = warp(pos.getZ(i)) - 100;
    pos.setXYZ(i, x, getHeight(x, z), z);
    uv.setXY(i, x / 2, z / 2);
  }
  tg.computeVertexNormals();
  tg.computeBoundingSphere();
  const terrain = new THREE.Mesh(tg, assets.pbr('sparse_grass', {}));
  terrain.receiveShadow = true;
  scene.add(terrain);
  onProgress(0.4, 'Ground');

  // surfaces
  addPad(-16, 16, -4, 7, 'concrete_floor_worn_001', SURFACE.CONCRETE);
  addPad(-7, 7, -222, -4, 'brown_mud_02', SURFACE.DIRT, 0.015);
  addPad(-26, -12, -30, -20, 'gravelly_sand', SURFACE.SAND, 0.015);
  addPad(8, 34, -20, -8, 'asphalt_02', SURFACE.ASPHALT, 0.015);
  // water trough
  const T = RANGE.trough;
  const water = new THREE.Mesh(new THREE.PlaneGeometry(T.x1 - T.x0 + 4, T.z1 - T.z0 + 4),
    new THREE.MeshStandardMaterial({ color: 0x1b3236, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.88, envMapIntensity: 1.3 }));
  water.rotation.x = -Math.PI / 2;
  water.position.set((T.x0 + T.x1) / 2, 0, (T.z0 + T.z1) / 2);
  scene.add(water);
  onProgress(0.55, 'Range');

  // firing line: bench and barriers
  addBox(-9, BASE, 1.2, 3.0, 0.9, 0.7, 'weathered_brown_planks', SURFACE.WOOD);
  addBox(9, BASE, 1.2, 3.0, 0.9, 0.7, 'weathered_brown_planks', SURFACE.WOOD);
  // lane dividers (low earth berms covered in sandbag-coloured concrete)
  for (const x of [-8.5, 8.5]) addBox(x, BASE, -60, 0.8, 0.6, 110, 'concrete_wall_008', SURFACE.CONCRETE, { tint: 0x9a8f7a });
  // recoil wall with a painted grid
  const Wl = RANGE.wall;
  addBox((Wl.x0 + Wl.x1) / 2, BASE, Wl.z, Wl.x1 - Wl.x0, Wl.h, Wl.t, 'concrete_wall_008', SURFACE.CONCRETE);
  const grid = new THREE.Mesh(new THREE.PlaneGeometry(Wl.x1 - Wl.x0, (Wl.x1 - Wl.x0) * 0.42), new THREE.MeshStandardMaterial({ map: gridTexture(), transparent: true, roughness: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
  grid.position.set((Wl.x0 + Wl.x1) / 2, BASE + (Wl.x1 - Wl.x0) * 0.21, Wl.z + Wl.t / 2 + 0.002);
  grid.receiveShadow = true;
  scene.add(grid);
  addSign((Wl.x0 + Wl.x1) / 2 + 6, Wl.z + 1.5, 'RECOIL', 'PATTERN WALL 25 M');
  // cover row (thin cover can be shot through)
  const cz = RANGE.cover.z;
  addBox(11, BASE, cz, 2.2, 2.2, 0.1, 'weathered_brown_planks', SURFACE.WOOD);
  addSign(11, cz + 1.2, 'WOOD', '0.10 M');
  addBox(15, BASE, cz, 2.2, 2.2, 0.03, 'green_metal_rust', SURFACE.METAL, { tint: 0x8d948c, metalness: 1 });
  addSign(15, cz + 1.2, 'STEEL', '0.03 M SHEET');
  addBox(19, BASE, cz, 2.2, 2.0, 0.02, null, SURFACE.GLASS, { material: new THREE.MeshStandardMaterial({ color: 0x9fb4b8, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.22, envMapIntensity: 1.6, depthWrite: false }), shadow: false });
  addBox(19, BASE + 2.0, cz, 2.4, 0.12, 0.12, 'weathered_brown_planks', SURFACE.WOOD);
  addSign(19, cz + 1.2, 'GLASS', '0.02 M PANE');
  addBox(23, BASE, cz, 2.2, 1.6, 1.0, 'concrete_wall_008', SURFACE.CONCRETE);
  addSign(23, cz + 1.2, 'CONCRETE', '1.0 M BLOCK');
  for (let i = 0; i < 4; i++) addBox(27 + (i % 2) * 0.1, BASE + i * 0.28, cz, 2.2, 0.28, 0.7, 'gravelly_sand', SURFACE.SAND, { tint: 0xb9a57d });
  addSign(27, cz + 1.2, 'SANDBAGS', 'SAND');
  // distance markers
  for (const [x, d] of RANGE.lanes) addSign(x + 1.6, -d + 0.6, `${d} M`, 'TARGET');
  // props
  placeProp('barrel_red', -12.5, 3.2, 0.3, SURFACE.METAL);
  placeProp('barrel_blue', -13.3, 4.2, 1.2, SURFACE.METAL);
  placeProp('crate_military', 12.6, 3.4, 0.2, SURFACE.WOOD);
  placeProp('ammo_box', 9.6, 1.25, 0.4, SURFACE.WOOD, false).position.y = BASE + 0.9;
  placeProp('barrier', -4, -6, 0, SURFACE.CONCRETE);
  placeProp('barrier', 6, -32, 0.1, SURFACE.CONCRETE);
  placeProp('generator', 14, 5, 2.1, SURFACE.METAL);
  placeProp('covered_car', 30, -60, 0.7, SURFACE.METAL);
  mergeStatic();
  onProgress(1, 'Ready');
}

function mergeStatic() {
  const groups = new Map();
  for (const o of scene.children.slice()) {
    if (!o.isMesh || !o.userData.mergeable) continue;
    if (!groups.has(o.material)) groups.set(o.material, []);
    groups.get(o.material).push(o);
  }
  for (const [material, list] of groups) {
    if (list.length < 2) continue;
    const geos = list.map((m) => { m.updateMatrixWorld(true); return m.geometry.clone().applyMatrix4(m.matrixWorld); });
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    for (const m of list) { m.removeFromParent(); m.geometry.dispose(); }
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true; mesh.receiveShadow = true;
    scene.add(mesh);
  }
}

const follow = new THREE.Vector3();
export function update(dt, viewPos) {
  if (!sun || !viewPos) return;
  const r = sun.shadow.camera.right;
  const texel = (2 * r) / sun.shadow.mapSize.x;
  follow.set(Math.round(viewPos.x / texel) * texel, Math.max(0, viewPos.y - 10), Math.round((viewPos.z - r * 0.6) / texel) * texel);
  sun.target.position.copy(follow);
  sun.position.copy(follow).addScaledVector(sunDir, 200);
  sun.target.updateMatrixWorld();
  void quality;
}
