// ZONEFALL - world facade: the only world module other groups import. OWNER: WORLD. Contract: ARCHITECTURE.md 5.1
// Builds Kessler Isle from core/mapdata.js with MAP.seed (identical on every peer, independent of quality tier for
// anything gameplay-relevant: heights, buildings, colliders, loot points) and answers spatial queries.
// Build order: height grid -> texture arrays -> layout (+ ground paint) -> splat control map -> sky/IBL ->
// terrain + roads -> water -> buildings -> props -> foliage -> collision BVH -> loot spawns, nav hints, map image.
import * as THREE from 'three';
import { SURFACE, QUALITY } from '../config.js';
import { MAP, ALL_SITES, ROADSIDE } from '../core/mapdata.js';
import { on, EV } from '../core/bus.js';
import { gfx, debug } from '../core/state.js';
import { Rng, mixSeed, hashString } from '../core/rng.js';
import * as hf from './heightfield.js';
import * as terrain from './terrain.js';
import * as sky from './sky.js';
import * as water from './water.js';
import * as props from './props.js';
import * as foliage from './foliage.js';
import * as collision from './collision.js';
import { buildLayout, corners } from './layout.js';
import { buildBuildings } from './buildings.js';
import { buildArrays, surfaceMaterial } from './materials.js';

const TUNE = {
  lootSpacing: 2.5, lootWallMargin: 0.65, lootLift: 0.05,
  lootTolerance: 0.15,
  mapSize: 1024,
};

let built = false;
let layout = null;
let lootSpawns = [];
let navHints = null;
let mapImage = null;
let crateBySpawn = new Map();
let buildingsOut = null;
let worldRoot = null;
let colliderDebug = null;
let lights = [];
let lightMat = null, lightMesh = null;
let qual = QUALITY.medium;
let timeAcc = 0;
const stats = { buildMs: 0, stages: {} };

const err = (m) => new Error(`[WORLD/world] ${m}`);
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

// ------------------------------------------------------------------------------------------ build
/**
 * Build terrain, water, sky/sun/fog, roads, buildings, props, foliage and the static collision BVH.
 * @param {{scene: THREE.Scene, quality: object, onProgress?: (p:number, label:string) => void}} opts
 */
export async function build(opts) {
  if (built) throw err('build called twice');
  const { scene, quality } = opts;
  if (!scene || !quality) throw err('build needs {scene, quality}');
  const onProgress = opts.onProgress || (() => {});
  qual = quality;
  const t0 = performance.now();
  const stages = [['grid', 12, 'Shaping the island'], ['arrays', 8, 'Ground materials'], ['layout', 2, 'Planning sites'], ['control', 12, 'Painting the ground'],
    ['sky', 5, 'Sky and light'], ['terrain', 7, 'Terrain'], ['water', 2, 'Ocean'], ['buildings', 14, 'Buildings'], ['props', 10, 'Props'],
    ['foliage', 20, 'Forests'], ['collision', 5, 'Collision'], ['finish', 3, 'Final touches']];
  const total = stages.reduce((s, x) => s + x[1], 0);
  let doneW = 0;
  let shown = 0;
  const run = async (key, fn) => {
    const st = stages.find((s) => s[0] === key);
    const ts = performance.now();
    const res = await fn((p) => { const v = (doneW + st[1] * Math.min(1, Math.max(0, p))) / total; if (v > shown) { shown = v; onProgress(v, st[2]); } });
    doneW += st[1];
    shown = Math.max(shown, doneW / total);
    onProgress(shown, st[2]);
    stats.stages[key] = Math.round(performance.now() - ts);
    await frame();
    return res;
  };
  worldRoot = new THREE.Group();
  worldRoot.name = 'world';
  scene.add(worldRoot);

  await run('grid', (p) => terrain.buildHeightGrid(quality, p));
  await run('arrays', async (p) => { p(0.1); await buildArrays(quality.anisotropy >= 8 ? 1024 : 512); p(1); });
  layout = await run('layout', async () => buildLayout());
  await run('control', (p) => terrain.buildControlMap(p));
  await run('sky', async () => sky.buildSky(scene, quality));
  await run('terrain', (p) => terrain.buildTerrain(worldRoot, quality, p));
  await run('water', async () => water.buildWater(worldRoot, quality));
  buildingsOut = await run('buildings', (p) => buildBuildings(layout, p));
  const surf = surfaceMaterial();
  for (const g of buildingsOut.groups) {
    const mesh = new THREE.Mesh(g.geometry, surf);
    mesh.name = `site_${g.site}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    worldRoot.add(mesh);
  }
  await run('props', (p) => props.buildProps(worldRoot, layout, quality, groundForProps, p));
  await run('foliage', (p) => foliage.buildFoliage(worldRoot, layout, quality, p));
  await run('collision', async () => {
    const set = new collision.ColliderSet('static');
    const M4 = new THREE.Matrix4();
    const addBoxes = (list) => {
      for (const b of list) {
        M4.set(b.a[0], b.b[0], b.d[0], b.c[0], b.a[1], b.b[1], b.d[1], b.c[1], b.a[2], b.b[2], b.d[2], b.c[2], 0, 0, 0, 1);
        set.boxMatrix(M4, 1, 1, 1, b.s);
      }
    };
    addBoxes(buildingsOut.boxes);
    for (const t of buildingsOut.tris) set.tri([t.p[0], t.p[1], t.p[2]], [t.p[3], t.p[4], t.p[5]], [t.p[6], t.p[7], t.p[8]], t.s);
    addBoxes(props.propColliders());
    foliage.addColliders(set);
    return collision.buildCollision([set]);
  });
  await run('finish', async () => {
    buildLights(worldRoot, buildingsOut.lights, buildingsOut.lamps);
    lootSpawns = buildLoot();
    navHints = buildNav();
  });
  built = true;
  stats.buildMs = Math.round(performance.now() - t0);
  on(EV.QUALITY_CHANGED, ({ tier }) => {
    qual = QUALITY[tier];
    props.setPropDistance(qual.propDistance);
    foliage.applyQuality(qual);
  });
  installDebug();
  return { stats: { ...stats } };
}

function slabTop(x, z) {
  let best = -Infinity;
  for (const s of layout.slabs) {
    const c = Math.cos(s.yaw || 0), sn = Math.sin(s.yaw || 0);
    const lx = (x - s.x) * c - (z - s.z) * sn, lz = (x - s.x) * sn + (z - s.z) * c;
    if (Math.abs(lx) <= s.w / 2 && Math.abs(lz) <= s.d / 2) best = Math.max(best, Math.max(hf.heightAt(x, z), 0) + 0.07);
  }
  return best;
}
function groundForProps(x, z) { return Math.max(hf.heightAt(x, z), slabTop(x, z), 0); }

// ------------------------------------------------------------------------------------------ lights (aviation, lantern, canopy)
function buildLights(parent, list, lamps) {
  lightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4.0, 0.25, 0.15), toneMapped: true, fog: true });
  const geo = new THREE.SphereGeometry(0.22, 10, 8);
  const reds = list.filter((l) => l.kind === 'red');
  lightMesh = new THREE.InstancedMesh(geo, lightMat, Math.max(1, reds.length));
  reds.forEach((l, i) => { lightMesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(l.x, l.y, l.z).scale(new THREE.Vector3(l.dim ? 0.7 : 1, l.dim ? 0.7 : 1, l.dim ? 0.7 : 1))); });
  lightMesh.count = reds.length;
  lightMesh.name = 'aviation-lights';
  lightMesh.frustumCulled = false;
  parent.add(lightMesh);
  for (const l of list.filter((q) => q.panel)) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(l.w, l.d).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.55, 1.4), side: THREE.FrontSide }));
    m.position.set(l.x, l.y, l.z);
    m.rotation.y = l.yaw;
    m.name = 'canopy-light';
    parent.add(m);
  }
  for (const p of lamps) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 1.4, 16, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 2.6, 1.6), side: THREE.DoubleSide }));
    m.position.set(p.x, p.y, p.z);
    m.name = 'lighthouse-lamp';
    parent.add(m);
  }
  lights = reds;
}

// ------------------------------------------------------------------------------------------ loot spawns
function roomPoints(room, rng) {
  const m = TUNE.lootWallMargin;
  const x0 = room.x0 + m, x1 = room.x1 - m, z0 = room.z0 + m, z1 = room.z1 - m;
  if (x1 <= x0 || z1 <= z0) return [];
  const area = (x1 - x0) * (z1 - z0);
  const want = area > 18 ? 3 : area > 7 ? 2 : 1;
  const pts = [];
  for (let a = 0; a < 40 && pts.length < want; a++) {
    const lx = rng.range(x0, x1), lz = rng.range(z0, z1);
    if (room.avoid.some(([a0, b0, a1, b1]) => lx > a0 - 0.5 && lx < a1 + 0.5 && lz > b0 - 0.5 && lz < b1 + 0.5)) continue;
    if (pts.some((p) => Math.hypot(p.lx - lx, p.lz - lz) < TUNE.lootSpacing)) continue;
    pts.push({ lx, lz });
  }
  const f = room.frame;
  return pts.map(({ lx, lz }) => ({ x: f.x + lx * f.c + lz * f.s, z: f.z - lx * f.s + lz * f.c, y: room.y + TUNE.lootLift }));
}

function outdoorAround(siteId, rng, n) {
  const out = [];
  const cands = [];
  for (const o of layout.outdoor) if (o.site === siteId) cands.push([o.x, o.z]);
  for (const p of layout.props) if (p.site === siteId && ['barrier', 'covered_car', 'generator', 'crate_wood', 'utility_box'].includes(p.key)) {
    const a = rng.range(0, Math.PI * 2);
    cands.push([p.x + Math.cos(a) * 1.4, p.z + Math.sin(a) * 1.4]);
  }
  for (const b of layout.buildings) if (b.site === siteId) {
    for (let k = 0; k < 3; k++) {
      const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
      const side = rng.int(0, 3);
      const lx = side < 2 ? (side ? 1 : -1) * (b.w / 2 + 1.3) : rng.range(-b.w / 2, b.w / 2);
      const lz = side >= 2 ? (side === 2 ? 1 : -1) * (b.d / 2 + 1.3) : rng.range(-b.d / 2, b.d / 2);
      cands.push([b.x + lx * c + lz * s, b.z - lx * s + lz * c]);
    }
  }
  for (const [x, z] of cands) {
    if (out.length >= n) break;
    if (hf.heightAt(x, z) < 0.3 || hf.onRoad(x, z, 0.5)) continue;
    const y = collision.groundBelow(x, z, hf.heightAt(x, z) + 3);
    const gy = Math.max(hf.heightAt(x, z), y && y.y < hf.heightAt(x, z) + 1.2 ? y.y : -Infinity);
    if (out.some((p) => Math.hypot(p.x - x, p.z - z) < TUNE.lootSpacing)) continue;
    out.push({ x, z, y: gy + TUNE.lootLift });
  }
  return out;
}

function buildLoot() {
  const list = [];
  crateBySpawn = new Map();
  const push = (p, site, tier, kind, indoor) => {
    const id = list.length;
    list.push({ id, pos: [round3(p.x), round3(p.y), round3(p.z)], site, tier, kind, indoor });
    return id;
  };
  const rooms = buildingsOut.rooms;
  const groups = [];
  for (const s of ALL_SITES) groups.push({ site: s.id, tier: s.tier, target: s.lootPoints, rooms: rooms.filter((r) => r.site === s.id) });
  // roadside houses: one group each so every house gets its share
  const roadside = new Map();
  for (const r of rooms) if (r.site == null) { if (!roadside.has(r.building)) roadside.set(r.building, []); roadside.get(r.building).push(r); }
  for (const [bid, rs] of roadside) groups.push({ site: null, tier: 0, target: ROADSIDE.lootPointsEach, rooms: rs, building: bid });
  const crateIdx = new Map();
  layout.crates.forEach((c, i) => crateIdx.set(c, i));
  for (const g of groups) {
    const rng = new Rng(mixSeed(MAP.seed, hashString('loot:' + (g.site || g.building))));
    const perRoom = g.rooms.map((r) => roomPoints(r, rng));
    const chosen = [];
    for (let pass = 0; pass < 3 && chosen.length < g.target; pass++) {
      for (const pts of perRoom) { if (chosen.length >= g.target) break; if (pts[pass]) chosen.push({ ...pts[pass], indoor: true }); }
    }
    const minCount = Math.ceil(g.target * (1 - TUNE.lootTolerance));
    if (chosen.length < minCount && g.site) chosen.push(...outdoorAround(g.site, rng, g.target - chosen.length).map((p) => ({ ...p, indoor: false })));
    for (const p of chosen) push(p, g.site, g.tier, 'floor', p.indoor);
    if (g.site) {
      for (const c of layout.crates.filter((q) => q.site === g.site)) {
        const ci = crateIdx.get(c);
        const pos = props.cratePosition(ci) || [c.x, groundForProps(c.x, c.z), c.z];
        const id = push({ x: pos[0], y: pos[1] + TUNE.lootLift, z: pos[2] }, g.site, g.tier, 'crate', false);
        crateBySpawn.set(id, ci);
      }
    }
  }
  return list;
}
const round3 = (v) => Math.round(v * 1000) / 1000;

function buildNav() {
  const doors = buildingsOut.doors.map((d) => ({ pos: d.pos.map(round3), dir: d.dir.map(round3), site: d.site }));
  const covers = [];
  for (const c of buildingsOut.covers) covers.push(c.map(round3));
  for (const p of layout.props) if (['barrier', 'covered_car', 'generator', 'crate_wood', 'crate_military', 'utility_box'].includes(p.key)) covers.push([round3(p.x), round3(groundForProps(p.x, p.z)), round3(p.z)]);
  for (const r of foliage.rockPositions()) covers.push(r.map(round3));
  const sites = ALL_SITES.map((s) => {
    const entries = doors.filter((d) => d.site === s.id).map((d) => d.pos);
    for (const r of hf.roads) {
      for (let i = 0; i < r.xs.length - 1; i++) {
        const a = Math.hypot(r.xs[i] - s.x, r.zs[i] - s.z), b = Math.hypot(r.xs[i + 1] - s.x, r.zs[i + 1] - s.z);
        if ((a - s.r * 0.9) * (b - s.r * 0.9) < 0) entries.push([round3(r.xs[i]), round3(hf.heightAt(r.xs[i], r.zs[i])), round3(r.zs[i])]);
      }
    }
    return { id: s.id, entries };
  });
  return { doors, covers, sites };
}

// ------------------------------------------------------------------------------------------ per frame
/** Per frame: shadow camera follows viewPos, foliage/grass/LOD/culling around viewPos, water animation. */
export function update(dt, viewPos) {
  if (!built) return;
  sky.updateSky(dt, viewPos, gfx.camera);
  terrain.updateTerrain(dt, viewPos);
  water.updateWater(dt, viewPos);
  props.updateProps(dt, viewPos);
  foliage.updateFoliage(dt, viewPos, gfx.camera);
  timeAcc += dt;
  if (lightMat) {
    const on1 = (timeAcc % 1.6) < 0.8;
    lightMat.color.setRGB(on1 ? 5.0 : 0.35, on1 ? 0.3 : 0.03, on1 ? 0.18 : 0.02);
  }
}

// ------------------------------------------------------------------------------------------ queries
/** Terrain height at (x, z) in metres (analytic, cheap, no BVH; includes POI flattening, roads, quarry pit). */
export function getHeight(x, z) { return hf.heightAt(x, z); }

/**
 * Highest walkable surface at (x, z) at or below fromY: terrain, floors, stairs, roofs, props.
 * @returns {{y:number, normal:number[], surface:number}}  normal [x,y,z]; surface is a config.SURFACE id
 */
export function getGround(x, z, fromY = Infinity) {
  const th = hf.heightAt(x, z);
  const st = collision.groundBelow(x, z, fromY);
  if (st && st.y >= th - 0.02 && st.y <= fromY + 1e-3) return { y: st.y, normal: st.normal, surface: st.surface };
  const n = hf.normalAt(x, z, [0, 1, 0]);
  return { y: th, normal: n, surface: hf.surfaceAt(x, z) };
}

/** Terrain surface type at (x, z) (GRASS, DIRT, ROCK, ASPHALT, SAND, WATER ...). */
export function getSurface(x, z) { return hf.surfaceAt(x, z); }

/** True where the terrain is below sea level (ocean). */
export function isWater(x, z) { return hf.heightAt(x, z) < MAP.seaLevel; }

const _wn = new THREE.Vector3(0, 1, 0);
/**
 * Ray vs terrain + static geometry + water plane. point/normal are fresh vectors owned by the caller.
 * @returns {{distance:number, point:THREE.Vector3, normal:THREE.Vector3, surface:number, kind:'terrain'|'static'|'water'}|null}
 */
export function raycast(origin, dir, maxDist) {
  let best = null;
  const st = collision.raycastStatic(origin, dir, maxDist);
  if (st) best = { distance: st.distance, point: st.point, normal: st.normal, surface: st.surface, kind: 'static' };
  const lim = best ? best.distance : maxDist;
  const tr = collision.raycastTerrain(origin, dir, lim);
  if (tr && (!best || tr.distance < best.distance)) best = { distance: tr.distance, point: tr.point, normal: tr.normal, surface: hf.surfaceAt(tr.point.x, tr.point.z), kind: 'terrain' };
  if (dir.y < 0 && origin.y > MAP.seaLevel) {
    const t = (MAP.seaLevel - origin.y) / dir.y;
    if (t >= 0 && t < (best ? best.distance : maxDist)) {
      const px = origin.x + dir.x * t, pz = origin.z + dir.z * t;
      if (hf.heightAt(px, pz) < MAP.seaLevel) best = { distance: t, point: new THREE.Vector3(px, MAP.seaLevel, pz), normal: _wn.clone(), surface: SURFACE.WATER, kind: 'water' };
    }
  }
  return best;
}

/**
 * Capsule vs static geometry (terrain is handled by the caller through getGround). Capsule = segment start..end, radius.
 * @returns {{hit:boolean, push:THREE.Vector3, normal:THREE.Vector3}}
 */
export function collideCapsule(start, end, radius) { return collision.capsule(start, end, radius); }

const _d = new THREE.Vector3();
/** True if nothing static (terrain, walls, rocks, trunks) blocks the segment a..b. Foliage leaves do not block. */
export function lineOfSight(a, b) {
  if (!collision.segmentClear(a, b)) return false;
  _d.subVectors(b, a);
  const len = _d.length();
  if (len < 1e-4) return true;
  _d.divideScalar(len);
  return !collision.raycastTerrain(a, _d, len - 0.05);
}

/** Loot spawn points, deterministic from MAP.seed (same list, same order, same ids on every peer). */
export function getLootSpawns() {
  if (!built) throw err('getLootSpawns before build');
  return lootSpawns;
}

/** Navigation hints for bots: doorways, cover spots and per-site entry points. */
export function getNavHints() {
  if (!built) throw err('getNavHints before build');
  return navHints;
}

/** 1024 x 1024 top-down map image (terrain shading, water, roads, building footprints); north up. */
export function getMapImage() {
  if (!built) throw err('getMapImage before build');
  if (!mapImage) mapImage = terrain.renderMapImage(TUNE.mapSize, layout.footprints);
  return mapImage;
}

/** World-space direction to the sun [x, y, z] (aligned with the HDRI). */
export function getSunDirection() { return sky.sunDirection(); }

/** Open or close the lid of the crate standing at a 'crate' loot spawn. */
export function setCrateOpen(spawnId, open) {
  const ci = crateBySpawn.get(spawnId);
  if (ci == null) throw err(`setCrateOpen: spawn ${spawnId} is not a crate`);
  props.setCrateLid(ci, open);
}

// ------------------------------------------------------------------------------------------ verification and debug
/** Terrain constraint check (ARCHITECTURE.md 3.2): every site disc and road vertex above 1.5 m. */
export function terrainCheck() {
  const violations = [];
  for (const s of ALL_SITES) {
    for (let a = 0; a < 48; a++) {
      for (const f of [0, 0.35, 0.7, 1]) {
        const x = s.x + Math.cos((a / 48) * Math.PI * 2) * s.r * f, z = s.z + Math.sin((a / 48) * Math.PI * 2) * s.r * f;
        if (s.id === 'southport' && z > MAP.harbor.z && x > MAP.harbor.x0 - 30 && x < MAP.harbor.x1 + 30) continue;   // harbour basin by design
        const h = hf.heightAt(x, z);
        if (s.id === 'greystone' && Math.hypot(x - s.x, z - s.z) < hf.quarry.rim + 2) { if (h <= 1.5) violations.push({ site: s.id, x, z, h }); continue; }
        if (h <= 1.5) violations.push({ site: s.id, x: Math.round(x), z: Math.round(z), h: Math.round(h * 100) / 100 });
      }
    }
  }
  for (const r of hf.roads) for (let i = 0; i < r.raw.length; i++) {
    const [x, z] = r.raw[i];
    const h = hf.heightAt(x, z);
    if (h <= 1.5) violations.push({ road: r.id, x, z, h });
  }
  return violations;
}

export function lootCounts() {
  const by = {};
  for (const s of lootSpawns) {
    const k = s.site || 'roadside';
    by[k] = by[k] || { floor: 0, crate: 0, indoor: 0 };
    by[k][s.kind]++;
    if (s.indoor) by[k].indoor++;
  }
  return by;
}

export function worldStats() {
  return { ...stats, terrain: terrain.terrainStats(), props: props.propStats(), foliage: foliage.foliageStats(),
    buildingTris: buildingsOut ? buildingsOut.groups.reduce((s, g) => s + g.triangles, 0) : 0, loot: lootSpawns.length };
}

function installDebug() {
  debug.world = debug.world || {};
  Object.assign(debug.world, {
    teleportCamera(x, y, z, yaw = 0, pitch = 0) {
      const cam = gfx.camera;
      cam.position.set(x, y, z);
      cam.rotation.set(pitch, yaw, 0, 'YXZ');
      cam.updateMatrixWorld();
    },
    showColliders(on = true) {
      if (on && !colliderDebug) { colliderDebug = collision.debugMesh(); if (colliderDebug) worldRoot.add(colliderDebug); }
      if (colliderDebug) colliderDebug.visible = !!on;
    },
    terrainCheck, lootCounts, stats: worldStats, layout: () => layout,
    setTerrainLod: terrain.setTerrainLod,
  });
}

export { layout as _layout };
