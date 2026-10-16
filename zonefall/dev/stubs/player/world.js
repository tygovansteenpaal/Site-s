// ZONEFALL dev harness stand-in for src/world/world.js (PLAYER group test course). Not shipped in the game.
// Same exported names as the WORLD facade. A 360 m course with real collision: rolling terrain with a 30-degree and a
// 52-degree hillside, a pool, mantle blocks (0.5 / 0.9 / 1.2 / 1.35 / 1.6 m), a vault wall and road barriers, a
// two-storey concrete building with stairs and a flat roof, a scaffold tower with decks at 5, 10 and 17 m (fall
// damage), containers, and surface pads (concrete, asphalt, gravel, wood, metal, sand) for footsteps.
// Lit like the real island: the RENDER.sky HDRI through PMREM, one shadowed sun following the view, exp2 fog.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SURFACE, RENDER, ASSETS } from '../../../src/config.js';
import * as assets from '../../../src/engine/assets.js';
import { gfx } from '../../../src/core/state.js';
import { clamp, smoothstep } from '../../../src/core/util.js';

const boxes = [];        // {min: Vector3, max: Vector3, surface}
const ramps = [];        // {x0, x1, z0, z1, axis: 'x'|'z', y0, y1, surface}  height rises from (x0|z0) to (x1|z1)
const pads = [];         // {x0, x1, z0, z1, surface}
let sun = null, scene = null, sunDir = new THREE.Vector3(...RENDER.sunDir).normalize();
let quality = null;

// ------------------------------------------------------------------------------------------ terrain
const POOL = { x0: -58, x1: -30, z0: 18, z1: 46, depth: 2.6 };
function rawHills(x, z) {
  return 3.2 * Math.sin(x * 0.021 + 0.7) * Math.cos(z * 0.017 - 0.4) + 1.6 * Math.sin(x * 0.047 + z * 0.031) + 0.7 * Math.cos(z * 0.083 - x * 0.02);
}
export function getHeight(x, z) {
  const r = Math.max(Math.abs(x), Math.abs(z));
  let h = rawHills(x, z) * smoothstep(62, 110, r) + (6 * Math.sin(x * 0.006 + 1.1) * Math.cos(z * 0.005) + 4) * smoothstep(200, 420, r);
  // 30-degree hillside (east): rises along +x from x = 70
  if (x > 70 && Math.abs(z) < 40) h = Math.max(h, Math.min(24, (x - 70) * Math.tan(30 * Math.PI / 180)) * smoothstep(40, 30, Math.abs(z)));
  // 52-degree face (north-east): too steep to climb
  if (z < -70 && x > 0 && x < 40) h = Math.max(h, Math.min(14, (-70 - z) * Math.tan(52 * Math.PI / 180)) * smoothstep(0, 6, x) * smoothstep(40, 34, x));
  // pool basin
  const px = Math.max(POOL.x0 - x, 0, x - POOL.x1), pz = Math.max(POOL.z0 - z, 0, z - POOL.z1);
  const d = Math.hypot(px, pz);
  if (d < 6) h = Math.min(h, -POOL.depth * smoothstep(6, 0, d) + h * smoothstep(0, 6, d));
  return h;
}
function terrainNormal(x, z, out) {
  const e = 0.25;
  const hx = getHeight(x + e, z) - getHeight(x - e, z), hz = getHeight(x, z + e) - getHeight(x, z - e);
  out.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
  return out;
}
export function isWater(x, z) { return getHeight(x, z) < -0.05; }

export function getSurface(x, z) {
  for (const p of pads) if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1) return p.surface;
  if (isWater(x, z)) return SURFACE.WATER;
  const px = Math.max(POOL.x0 - x, 0, x - POOL.x1), pz = Math.max(POOL.z0 - z, 0, z - POOL.z1);
  if (Math.hypot(px, pz) < 9) return SURFACE.SAND;
  if (x > 70 && Math.abs(z) < 40) return SURFACE.DIRT;
  return SURFACE.GRASS;
}

// ------------------------------------------------------------------------------------------ queries
const nTmp = new THREE.Vector3();
export function getGround(x, z, fromY = Infinity) {
  let y = getHeight(x, z), surface = getSurface(x, z), nx = 0, ny = 1, nz = 0, isTerrain = true;
  const lim = fromY + 1e-3;
  for (const b of boxes) {
    if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
    const top = b.max.y;
    if (top <= lim && top > y) { y = top; surface = b.surface; isTerrain = false; nx = 0; ny = 1; nz = 0; }
  }
  for (const r of ramps) {
    if (x < r.x0 || x > r.x1 || z < r.z0 || z > r.z1) continue;
    const t = r.axis === 'x' ? (x - r.x0) / (r.x1 - r.x0) : (z - r.z0) / (r.z1 - r.z0);
    const ry = r.y0 + (r.y1 - r.y0) * t;
    if (ry <= lim && ry > y) {
      y = ry; surface = r.surface; isTerrain = false;
      const run = r.axis === 'x' ? r.x1 - r.x0 : r.z1 - r.z0;
      const slope = (r.y1 - r.y0) / run;
      const l = Math.hypot(slope, 1);
      if (r.axis === 'x') { nx = -slope / l; ny = 1 / l; nz = 0; } else { nx = 0; ny = 1 / l; nz = -slope / l; }
    }
  }
  if (isTerrain) { terrainNormal(x, z, nTmp); nx = nTmp.x; ny = nTmp.y; nz = nTmp.z; }
  return { y, normal: [nx, ny, nz], surface };
}

const cp = new THREE.Vector3(), push = new THREE.Vector3(), nrm = new THREE.Vector3();
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
    // Horizontal push out of the box (or the shortest way out when the centre is inside it).
    let px, pz, pen;
    if (d > 1e-6) { pen = radius - d; px = dx / d * pen; pz = dz / d * pen; }
    else {
      const ex = [x - b.min.x, b.max.x - x, z - b.min.z, b.max.z - z];
      let k = 0; for (let i = 1; i < 4; i++) if (ex[i] < ex[k]) k = i;
      pen = ex[k] + radius;
      px = k === 0 ? -pen : k === 1 ? pen : 0; pz = k === 2 ? -pen : k === 3 ? pen : 0;
    }
    // Head bump: capsule top under a slab -> push down if that is shorter.
    const down = y1 - b.min.y;
    if (start.y + radius * 0.5 < b.min.y && down < pen && d < 1e-6) {
      push.y -= down; nrm.y -= 1;
    } else {
      push.x += px; push.z += pz;
      const l = Math.hypot(px, pz) || 1;
      nrm.x += px / l; nrm.z += pz / l;
    }
    hit = true;
  }
  if (hit && nrm.lengthSq() > 0) nrm.normalize();
  return { hit, push: push.clone(), normal: nrm.clone() };
}

function rayBox(o, d, b, maxD) {
  let tmin = 0, tmax = maxD, axis = -1, sign = 0;
  for (let i = 0; i < 3; i++) {
    const oi = i === 0 ? o.x : i === 1 ? o.y : o.z;
    const di = i === 0 ? d.x : i === 1 ? d.y : d.z;
    const lo = i === 0 ? b.min.x : i === 1 ? b.min.y : b.min.z;
    const hi = i === 0 ? b.max.x : i === 1 ? b.max.y : b.max.z;
    if (Math.abs(di) < 1e-9) { if (oi < lo || oi > hi) return null; continue; }
    let t1 = (lo - oi) / di, t2 = (hi - oi) / di, s = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (axis < 0) return null;   // origin inside
  return { t: tmin, axis, sign };
}

export function raycast(origin, dir, maxDist) {
  let best = null;
  for (const b of boxes) {
    const h = rayBox(origin, dir, b, maxDist);
    if (h && (!best || h.t < best.distance)) {
      const n = new THREE.Vector3();
      if (h.axis === 0) n.x = h.sign; else if (h.axis === 1) n.y = h.sign; else n.z = h.sign;
      best = { distance: h.t, normal: n, surface: b.surface, kind: 'static' };
    }
  }
  for (const r of ramps) {
    // plane through the ramp
    const run = r.axis === 'x' ? r.x1 - r.x0 : r.z1 - r.z0;
    const slope = (r.y1 - r.y0) / run;
    const n = r.axis === 'x' ? new THREE.Vector3(-slope, 1, 0).normalize() : new THREE.Vector3(0, 1, -slope).normalize();
    const p0 = new THREE.Vector3(r.x0, r.y0, r.z0);
    const den = n.dot(dir);
    if (Math.abs(den) < 1e-6) continue;
    const t = p0.clone().sub(origin).dot(n) / den;
    if (t < 0 || t > maxDist || (best && t >= best.distance)) continue;
    const px = origin.x + dir.x * t, pz = origin.z + dir.z * t;
    if (px < r.x0 || px > r.x1 || pz < r.z0 || pz > r.z1) continue;
    best = { distance: t, normal: den < 0 ? n : n.negate(), surface: r.surface, kind: 'static' };
  }
  // terrain: march then bisect
  const lim = best ? best.distance : maxDist;
  let prevT = 0, prevAbove = origin.y - getHeight(origin.x, origin.z);
  if (prevAbove > 0) {
    const step = 0.5;
    for (let t = step; t <= lim + step; t += step) {
      const tt = Math.min(t, lim);
      const x = origin.x + dir.x * tt, y = origin.y + dir.y * tt, z = origin.z + dir.z * tt;
      const above = y - getHeight(x, z);
      if (above <= 0) {
        let a = prevT, bb = tt;
        for (let k = 0; k < 18; k++) {
          const m = (a + bb) * 0.5;
          const mx = origin.x + dir.x * m, my = origin.y + dir.y * m, mz = origin.z + dir.z * m;
          if (my - getHeight(mx, mz) > 0) a = m; else bb = m;
        }
        const px = origin.x + dir.x * bb, pz = origin.z + dir.z * bb;
        if (!best || bb < best.distance) best = { distance: bb, normal: terrainNormal(px, pz, new THREE.Vector3()), surface: getSurface(px, pz), kind: 'terrain' };
        break;
      }
      prevT = tt; prevAbove = above;
      if (tt >= lim) break;
    }
  }
  // water plane over the pool
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

// ------------------------------------------------------------------------------------------ building the course
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
  const mesh = new THREE.Mesh(boxGeo(sx, sy, sz, tile), assets.pbr(matId, { tint: opts.tint, roughness: opts.roughness, metalness: opts.metalness }));
  mesh.position.set(cx, cy + sy / 2, cz);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.userData.mergeable = true;
  scene.add(mesh);
  if (opts.collide !== false) boxes.push({ min: new THREE.Vector3(cx - sx / 2, cy, cz - sz / 2), max: new THREE.Vector3(cx + sx / 2, cy + sy, cz + sz / 2), surface });
  return mesh;
}

function addStairs(x0, x1, z0, z1, axis, y0, y1, matId, surface) {
  ramps.push({ x0, x1, z0, z1, axis, y0, y1, surface });
  // visual steps
  const run = axis === 'x' ? x1 - x0 : z1 - z0;
  const rise = y1 - y0;
  const n = Math.max(2, Math.round(Math.abs(rise) / 0.18));
  const w = axis === 'x' ? z1 - z0 : x1 - x0;
  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n;
    const hTop = y0 + rise * t1;
    const along0 = (axis === 'x' ? x0 : z0) + run * t0, along1 = (axis === 'x' ? x0 : z0) + run * t1;
    const len = Math.abs(along1 - along0), mid = (along0 + along1) / 2;
    const h = Math.max(0.05, hTop - Math.min(y0, y1) + 0.0);
    if (axis === 'x') addBox(mid, Math.min(y0, y1), (z0 + z1) / 2, len, h, w, matId, surface, { collide: false });
    else addBox((x0 + x1) / 2, Math.min(y0, y1), mid, w, h, len, matId, surface, { collide: false });
  }
}

function addPad(x0, x1, z0, z1, matId, surface, lift = 0.02) {
  pads.push({ x0, x1, z0, z1, surface });
  const tile = ASSETS.textures[matId] || 2;
  const seg = 24;
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0, seg, seg);
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

function placeProp(key, x, z, rotY = 0, collide = true, yOff = 0) {
  const obj = assets.cloneModel(key);
  const g = getGround(x, z, 50);
  obj.position.set(x, g.y + yOff, z);
  obj.rotation.y = rotY;
  scene.add(obj);
  obj.updateMatrixWorld(true);
  if (collide) {
    const bb = new THREE.Box3().setFromObject(obj);
    boxes.push({ min: bb.min.clone(), max: bb.max.clone(), surface: key.includes('barrier') ? SURFACE.CONCRETE : key.includes('crate') ? SURFACE.WOOD : SURFACE.METAL });
  }
  return obj;
}

export async function build({ scene: sc, quality: q, onProgress = () => {} }) {
  scene = sc; quality = q;
  const renderer = gfx.renderer;
  // ---- sky and light
  const sky = assets.sky(RENDER.sky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(sky.hdr).texture;
  scene.environmentIntensity = RENDER.envIntensity;
  scene.background = sky.bg;
  scene.backgroundIntensity = 1.0;
  scene.fog = new THREE.FogExp2(RENDER.fogColor, q.fogDensity * 1.4);
  sun = new THREE.DirectionalLight(RENDER.sunColor, RENDER.sunIntensity);
  sun.castShadow = true;
  sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
  const r = Math.min(60, q.shadowRange);
  Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 400 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.035;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  onProgress(0.2, 'Sky');

  // ---- terrain
  // 3 km of ground with vertices concentrated on the course (about 1 m apart in the middle, 25 m at the rim), so the
  // plane drop and the parachute glide always have terrain under them.
  const seg = q.terrainRes >= 256 ? 360 : 300;
  const tg = new THREE.PlaneGeometry(2, 2, seg, seg);
  tg.rotateX(-Math.PI / 2);
  const pos = tg.attributes.position, uv = tg.attributes.uv;
  const warp = (u) => 170 * u + 1330 * u * u * u;
  for (let i = 0; i < pos.count; i++) {
    const x = warp(pos.getX(i)), z = warp(pos.getZ(i));
    pos.setXYZ(i, x, getHeight(x, z), z);
    uv.setXY(i, x / 2, z / 2);
  }
  tg.computeBoundingSphere();
  tg.computeVertexNormals();
  const grass = assets.pbr('sparse_grass', {});
  const terrain = new THREE.Mesh(tg, grass);
  terrain.receiveShadow = true;
  scene.add(terrain);
  // the hillsides read as worn dirt and rock
  addPad(70.5, 115, -40, 40, 'brown_mud_02', SURFACE.DIRT, 0.03);
  addPad(1, 39, -88, -70.5, 'rocky_terrain_02', SURFACE.ROCK, 0.03);
  onProgress(0.4, 'Terrain');

  // ---- water
  const wg = new THREE.PlaneGeometry(POOL.x1 - POOL.x0 + 14, POOL.z1 - POOL.z0 + 14);
  wg.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(wg, new THREE.MeshPhysicalMaterial({ color: 0x1d3a3f, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.86, envMapIntensity: 1.2, clearcoat: 1, clearcoatRoughness: 0.05 }));
  water.position.set((POOL.x0 + POOL.x1) / 2, -0.02, (POOL.z0 + POOL.z1) / 2);
  scene.add(water);
  addPad(POOL.x0 - 9, POOL.x1 + 9, POOL.z1 + 6, POOL.z1 + 9, 'gravelly_sand', SURFACE.SAND);

  // ---- surface pads
  addPad(-8, 30, 6, 40, 'concrete_floor_worn_001', SURFACE.CONCRETE);          // building yard
  addPad(-150, 150, -4, 4, 'asphalt_02', SURFACE.ASPHALT, 0.025);               // road
  addPad(-30, -12, -30, -10, 'gravelly_sand', SURFACE.DIRT);                    // gravel
  onProgress(0.55, 'Course');

  // ---- mantle blocks along z = -22
  const heights = [0.5, 0.9, 1.2, 1.35, 1.6];
  heights.forEach((h, i) => addBox(-6 + i * 4.2, 0, -22, 2.4, h, 2.4, 'concrete_wall_008', SURFACE.CONCRETE));
  // vault wall and wooden deck
  addBox(20, 0, -20, 6, 1.0, 0.24, 'red_brick_03', SURFACE.CONCRETE);
  addBox(36, 0, -22, 8, 0.6, 6, 'weathered_brown_planks', SURFACE.WOOD);
  // metal floor plates
  addBox(48, 0, -22, 6, 0.08, 6, 'green_metal_rust', SURFACE.METAL, { tint: 0x8a8f86 });
  // containers
  addBox(-24, 0, 8, 6.06, 2.6, 2.44, 'green_metal_rust', SURFACE.METAL);
  addBox(-24, 2.6, 8, 6.06, 2.6, 2.44, 'green_metal_rust', SURFACE.METAL, { tint: 0x9a6f5a });
  addBox(-24, 0, 12, 6.06, 2.6, 2.44, 'green_metal_rust', SURFACE.METAL, { tint: 0x7f8d9a });
  addStairs(-27, -21, 13.3, 15.5, 'x', 0.0, 2.6, 'weathered_brown_planks', SURFACE.WOOD);

  // ---- two-storey building (12 x 10, walls 0.25, door gaps), x 0..12, z 14..24
  const bx = 6, bz = 26, W = 12, D = 10, H = 3.0, T = 0.25;
  const wall = 'concrete_wall_008';
  for (let f = 0; f < 2; f++) {
    const y = f * H;
    // north wall with door (front, -z side)
    addBox(bx - W / 2 + 2.4, y, bz - D / 2, 4.8, H, T, wall, SURFACE.CONCRETE);
    addBox(bx + W / 2 - 2.4 - 1.2, y, bz - D / 2, 4.8 + 2.4, H, T, wall, SURFACE.CONCRETE);
    if (f === 0) addBox(bx - W / 2 + 5.4, y + 2.2, bz - D / 2, 1.2, 0.8, T, wall, SURFACE.CONCRETE);
    else addBox(bx - W / 2 + 5.4, y, bz - D / 2, 1.2, H, T, wall, SURFACE.CONCRETE);
    // south wall with window
    addBox(bx - W / 2 + 3, y, bz + D / 2, 6, H, T, wall, SURFACE.CONCRETE);
    addBox(bx + W / 2 - 2.4, y, bz + D / 2, 4.8, H, T, wall, SURFACE.CONCRETE);
    addBox(bx + 0.6, y, bz + D / 2, 1.2, 0.9, T, wall, SURFACE.CONCRETE);
    addBox(bx + 0.6, y + 2.2, bz + D / 2, 1.2, 0.8, T, wall, SURFACE.CONCRETE);
    // east / west
    addBox(bx - W / 2, y, bz, T, H, D, wall, SURFACE.CONCRETE);
    addBox(bx + W / 2, y, bz, T, H, D, wall, SURFACE.CONCRETE);
  }
  // first floor slab with a stair opening, roof slab and parapet
  addBox(bx + 1.5, H - 0.2, bz, W - 3, 0.2, D, 'concrete_floor_worn_001', SURFACE.CONCRETE);
  addBox(bx - W / 2 + 1.5, H - 0.2, bz + 2.5, 3, 0.2, D - 5, 'concrete_floor_worn_001', SURFACE.CONCRETE);
  addStairs(bx - W / 2 + 0.2, bx - W / 2 + 2.8, bz - D / 2 + 0.3, bz - 0.2, 'z', 0.0, H, 'concrete_floor_worn_001', SURFACE.CONCRETE);
  addBox(bx, 2 * H - 0.2, bz + 1, W, 0.2, D - 2, 'concrete_floor_worn_001', SURFACE.CONCRETE);
  addStairs(bx + W / 2 - 2.8, bx + W / 2 - 0.2, bz - D / 2 + 0.3, bz - D / 2 + 3.6, 'z', H, 2 * H, 'concrete_floor_worn_001', SURFACE.CONCRETE);
  addBox(bx, 2 * H, bz + D / 2, W, 0.9, T, wall, SURFACE.CONCRETE);
  addBox(bx - W / 2, 2 * H, bz, T, 0.9, D, wall, SURFACE.CONCRETE);
  onProgress(0.75, 'Buildings');

  // ---- scaffold tower: decks at 5, 10, 17 m (x 40..46, z 20..26), ramps up the west side
  const tx = 52, tz = 24;
  for (const [y, label] of [[5, 0], [10, 1], [17, 2]]) {
    addBox(tx, y - 0.15, tz, 6, 0.15, 6, 'green_metal_rust', SURFACE.METAL, { tint: 0x8d8f88 });
    void label;
  }
  for (const [px, pz] of [[-2.8, -2.8], [2.8, -2.8], [-2.8, 2.8], [2.8, 2.8]]) addBox(tx + px, 0, tz + pz, 0.3, 17, 0.3, 'green_metal_rust', SURFACE.METAL, { tint: 0x6b6f68 });
  addStairs(tx - 16, tx - 3, tz - 1.2, tz + 1.2, 'x', 0, 5, 'weathered_brown_planks', SURFACE.WOOD);
  addStairs(tx - 3, tx + 3, tz + 3.1, tz + 5.3, 'x', 5, 10, 'weathered_brown_planks', SURFACE.WOOD);
  addBox(tx + 4.2, 9.85, tz + 4.2, 2.6, 0.15, 2.6, 'green_metal_rust', SURFACE.METAL, { tint: 0x8d8f88 });
  addStairs(tx + 3, tx + 5.4, tz - 3.0, tz + 3.0, 'z', 17, 10, 'weathered_brown_planks', SURFACE.WOOD);
  addBox(tx + 4.2, 9.85, tz - 4.0, 2.4, 0.15, 2.0, 'green_metal_rust', SURFACE.METAL, { tint: 0x8d8f88 });

  // ---- props
  placeProp('barrier', 28, -14, 0);
  placeProp('barrier', 30, -14, 0);
  placeProp('barrier', -14, 2, Math.PI / 2);
  placeProp('crate_military', 14, 10, 0.3);
  placeProp('crate_wood', 16, 12, 0.8);
  placeProp('barrel_red', -16, 14, 0);
  placeProp('barrel_blue', -16.8, 15.2, 0);
  placeProp('generator', 22, 34, 1.2);
  placeProp('covered_car', -36, -6, 0.15);
  placeProp('utility_box', 18, 20.5, Math.PI);
  placeProp('tyre', 24, 9, 0, false);
  placeProp('jerrycan', 15, 9.2, 0.4, false);
  mergeStatic();
  onProgress(1, 'Ready');
}

/** One draw call per material for the course's boxes and steps (the real world merges per site and material too). */
function mergeStatic() {
  const groups = new Map();
  for (const o of scene.children.slice()) {
    if (!o.isMesh || !o.userData.mergeable) continue;
    if (!groups.has(o.material)) groups.set(o.material, []);
    groups.get(o.material).push(o);
  }
  for (const [material, list] of groups) {
    if (list.length < 2) continue;
    const geos = list.map((m) => { m.updateMatrixWorld(true); const g = m.geometry.clone().applyMatrix4(m.matrixWorld); m.geometry.dispose(); return g; });
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    for (const m of list) m.removeFromParent();
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true; mesh.receiveShadow = true;
    scene.add(mesh);
  }
}

const shadowFollow = new THREE.Vector3();
export function update(dt, viewPos) {
  if (!sun || !viewPos) return;
  // Thinner haze for a high camera (plane, freefall) so the course stays readable from 380 m.
  if (scene.fog && quality) scene.fog.density = quality.fogDensity * 1.4 / (1 + Math.max(0, viewPos.y - 25) / 45);
  // texel-snapped shadow camera following the view
  const r = sun.shadow.camera.right;
  const texel = (2 * r) / sun.shadow.mapSize.x;
  shadowFollow.set(Math.round(viewPos.x / texel) * texel, Math.max(0, viewPos.y - 10), Math.round(viewPos.z / texel) * texel);
  sun.target.position.copy(shadowFollow);
  sun.position.copy(shadowFollow).addScaledVector(sunDir, 150);
  sun.target.updateMatrixWorld();
}
