// ZONEFALL - instanced Poly Haven props (crates, barriers, barrels, cars, generators, tyres ...). OWNER: WORLD (internal).
// Each prop model is flattened into one geometry per material, then simplified at load into two lighter LODs with
// meshoptimizer (the hero assets are 2k-26k triangles each). Every LOD is an InstancedMesh; instances are bucketed
// by distance a few times per second and culled beyond quality.propDistance. Loot crates use the closed half of
// old_military_crate with its lid as a separate instanced part, so setCrateLid can swing it open. Each prop gets a
// box collider sized from its geometry.
import * as THREE from 'three';
import { SURFACE } from '../config.js';
import * as assets from '../engine/assets.js';
import { heightAt } from './heightfield.js';

const SIMPLIFIER_URL = 'https://cdn.jsdelivr.net/npm/meshoptimizer@1.2.0/meshopt_simplifier.js';

const TUNE = {
  lodDist: [24, 70],           // LOD0 below, LOD1 below, LOD2 beyond (up to quality.propDistance)
  lodRatio: [0.3, 0.07],
  maxTris0: 7000,              // LOD0 of a prop part is simplified to at most this many triangles (scans run 2k-26k)
  updateEvery: 0.2,            // seconds between bucket rebuilds
  shadowDist: 60,
};

const SURF = {
  barrier: SURFACE.CONCRETE, barrel_red: SURFACE.METAL, barrel_blue: SURFACE.METAL, tyre: SURFACE.DIRT, generator: SURFACE.METAL,
  covered_car: SURFACE.METAL, crate_wood: SURFACE.WOOD, crate_military: SURFACE.WOOD, crate_old: SURFACE.WOOD, cardboard_box: SURFACE.WOOD,
  utility_box: SURFACE.METAL, jerrycan: SURFACE.METAL, ammo_box: SURFACE.METAL, medical_box: SURFACE.METAL,
};

let root = null;
const kinds = new Map();      // key -> {parts:[{lods:[InstancedMesh...]}], items:[{x,y,z,yaw,m:Matrix4}], box}
let crateKind = null;         // {body parts, lid parts, hinge}
const crateState = [];        // per crate instance: {open, t}
let propDistance = 200;
let acc = 0;
let colliders = [];
let simplifier = null;

// ------------------------------------------------------------------------------------------ geometry prep
function floatGeometry(src, matrix) {
  const g = new THREE.BufferGeometry();
  const p = src.attributes.position, n = src.attributes.normal, uv = src.attributes.uv;
  const cnt = p.count;
  const pos = new Float32Array(cnt * 3), nrm = new Float32Array(cnt * 3), tex = new Float32Array(cnt * 2);
  const v = new THREE.Vector3(), nm = new THREE.Matrix3().getNormalMatrix(matrix);
  for (let i = 0; i < cnt; i++) {
    v.fromBufferAttribute(p, i).applyMatrix4(matrix);
    pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
    if (n) { v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize(); nrm[i * 3] = v.x; nrm[i * 3 + 1] = v.y; nrm[i * 3 + 2] = v.z; }
    if (uv) { tex[i * 2] = uv.getX(i); tex[i * 2 + 1] = uv.getY(i); }
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(tex, 2));
  const idx = src.index ? Uint32Array.from(src.index.array) : Uint32Array.from({ length: cnt }, (_, i) => i);
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  if (!n) g.computeVertexNormals();
  return g;
}

function mergeFloat(list) {
  let vc = 0, ic = 0;
  for (const g of list) { vc += g.attributes.position.count; ic += g.index.count; }
  const pos = new Float32Array(vc * 3), nrm = new Float32Array(vc * 3), tex = new Float32Array(vc * 2), idx = new Uint32Array(ic);
  let vo = 0, io = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, vo * 3); nrm.set(g.attributes.normal.array, vo * 3); tex.set(g.attributes.uv.array, vo * 2);
    const ia = g.index.array;
    for (let i = 0; i < ia.length; i++) idx[io + i] = ia[i] + vo;
    vo += g.attributes.position.count; io += ia.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(tex, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

function simplify(g, ratio, maxErr = 0.04) {
  if (!simplifier) return null;
  const idx = g.index.array;
  const target = Math.max(36, Math.floor((idx.length * ratio) / 3) * 3);
  try {
    const [out] = simplifier.simplify(idx, g.attributes.position.array, 3, target, maxErr, []);
    if (!out || out.length < 12 || out.length > idx.length * 0.9) return null;
    const s = new THREE.BufferGeometry();
    for (const k of ['position', 'normal', 'uv']) s.setAttribute(k, g.attributes[k]);
    s.setIndex(new THREE.BufferAttribute(new Uint32Array(out), 1));
    s.computeBoundingSphere();
    return s;
  } catch (e) {
    console.warn('[WORLD/props] simplify failed', e);
    return null;
  }
}

/**
 * Flatten a model into parts by material. filter(name) selects nodes; offset re-centres the model.
 * @returns {Array<{material, geometry}>}
 */
function extract(key, filter = null, offset = null) {
  const gltf = assets.model(key);
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const byMat = new Map();
  const off = offset ? new THREE.Matrix4().makeTranslation(offset[0], offset[1], offset[2]) : null;
  scene.traverse((o) => {
    if (!o.isMesh) return;
    let name = o.name, p = o;
    while (p && filter) { if (filter(p.name)) break; p = p.parent; }
    if (filter && !p) return;
    const m = off ? off.clone().multiply(o.matrixWorld) : o.matrixWorld;
    const g = floatGeometry(o.geometry, m);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.length > 1 && o.geometry.groups.length) {
      for (const grp of o.geometry.groups) {
        const sub = g.clone();
        sub.setIndex(new THREE.BufferAttribute(g.index.array.slice(grp.start, grp.start + grp.count), 1));
        const mm = mats[grp.materialIndex];
        if (!byMat.has(mm)) byMat.set(mm, []);
        byMat.get(mm).push(sub);
      }
    } else {
      if (!byMat.has(mats[0])) byMat.set(mats[0], []);
      byMat.get(mats[0]).push(g);
    }
    name = null;
  });
  return [...byMat.entries()].map(([material, list]) => ({ material, geometry: mergeFloat(list) }));
}

function makeLods(parts, capacity, name) {
  return parts.map(({ material, geometry }) => {
    geometry.computeBoundingSphere();
    const tris = geometry.index.count / 3;
    const r0 = Math.min(1, TUNE.maxTris0 / tris);
    const base = r0 < 0.95 ? simplify(geometry, r0, 0.012) || geometry : geometry;
    const k = (base.index.count / 3) / tris;   // ratios below stay relative to the source scan
    const lods = [base, simplify(geometry, Math.min(TUNE.lodRatio[0], k * 0.45)) || base, simplify(geometry, Math.min(TUNE.lodRatio[1], k * 0.12)) || simplify(geometry, TUNE.lodRatio[0]) || base];
    const meshes = lods.map((lg, li) => {
      const im = new THREE.InstancedMesh(lg, material, Math.max(1, capacity));
      im.name = `${name}_lod${li}`;
      im.count = 0;
      im.castShadow = li < 2;
      im.receiveShadow = true;
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      root.add(im);
      return im;
    });
    return { lods: meshes, tris: lods.map((lg) => lg.index.count / 3) };
  });
}

function boundsOf(parts) {
  const box = new THREE.Box3();
  for (const p of parts) { p.geometry.computeBoundingBox(); box.union(p.geometry.boundingBox); }
  return box;
}

// ------------------------------------------------------------------------------------------ build
/**
 * @param {THREE.Scene} scene
 * @param {object} layout       world layout (props, crates)
 * @param {object} quality
 * @param {(x:number, z:number) => number} groundY  walkable height (terrain or paved slab)
 */
export async function buildProps(scene, layout, quality, groundY = heightAt, onProgress = () => {}) {
  propDistance = quality.propDistance;
  root = new THREE.Group();
  root.name = 'props';
  scene.add(root);
  try {
    const mod = await import(/* @vite-ignore */ SIMPLIFIER_URL);
    simplifier = mod.MeshoptSimplifier;
    await simplifier.ready;
  } catch (e) {
    console.warn('[WORLD/props] meshoptimizer simplifier unavailable; props render without LODs', e);
    simplifier = null;
  }
  onProgress(0.2);
  const byKey = new Map();
  for (const p of layout.props) { if (!byKey.has(p.key)) byKey.set(p.key, []); byKey.get(p.key).push(p); }
  let n = 0;
  for (const [key, list] of byKey) {
    const parts = extract(key);
    const box = boundsOf(parts);
    const k = { key, parts: makeLods(parts, list.length, key), items: [], box };
    for (const p of list) {
      const y = groundY(p.x, p.z) + (p.y || 0);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(p.x, y, p.z), new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, p.yaw || 0), new THREE.Vector3(1, 1, 1));
      k.items.push({ x: p.x, y, z: p.z, yaw: p.yaw || 0, m });
      addCollider(box, p.x, y, p.z, p.yaw || 0, SURF[key] ?? SURFACE.METAL);
    }
    kinds.set(key, k);
    onProgress(0.2 + 0.6 * (++n / byKey.size));
    await new Promise((r) => requestAnimationFrame(() => r()));
  }
  buildCrates(layout.crates, groundY);
  onProgress(1);
  return root;
}

function addCollider(box, x, y, z, yaw, s) {
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  const hx = (box.max.x - box.min.x) / 2, hy = (box.max.y - box.min.y) / 2, hz = (box.max.z - box.min.z) / 2;
  const lx = (box.max.x + box.min.x) / 2, ly = (box.max.y + box.min.y) / 2, lz = (box.max.z + box.min.z) / 2;
  colliders.push({ c: [x + lx * c + lz * sn, y + ly, z - lx * sn + lz * c], a: [c * hx, 0, -sn * hx], b: [0, hy, 0], d: [sn * hz, 0, c * hz], s });
}

function buildCrates(list, groundY) {
  const isA = (nm) => /_a$/.test(nm);
  const isLid = (nm) => nm === 'old_military_crate_lid_a';
  // body = every closed-crate part except the lid; centred on the origin
  const body = extract('crate_old', (nm) => isA(nm) && !isLid(nm), [0.5, 0, 0.01]);
  const lid = extract('crate_old', (nm) => isLid(nm), [0.5, 0, 0.01]);
  const bbox = boundsOf(body.concat(lid));
  const lbox = boundsOf(lid);
  crateKind = {
    body: makeLods(body, list.length, 'crate_body'),
    lid: makeLods(lid, list.length, 'crate_lid'),
    hinge: new THREE.Vector3(0, lbox.max.y - 0.02, lbox.min.z + 0.01),
    items: [],
    box: bbox,
  };
  for (const c of list) {
    const y = groundY(c.x, c.z);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(c.x, y, c.z), new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, c.yaw || 0), new THREE.Vector3(1, 1, 1));
    crateKind.items.push({ x: c.x, y, z: c.z, yaw: c.yaw || 0, m, lidM: m.clone() });
    crateState.push({ open: false, t: 0 });
    addCollider(bbox, c.x, y, c.z, c.yaw || 0, SURFACE.WOOD);
  }
  c0 = crateKind.items.length;
}
let c0 = 0;

/** World position of crate i (index into layout.crates) as [x, y, z]. */
export function cratePosition(i) {
  const it = crateKind && crateKind.items[i];
  return it ? [it.x, it.y, it.z] : null;
}

const _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _h = new THREE.Matrix4(), _hi = new THREE.Matrix4(), _r = new THREE.Matrix4();
function lidMatrix(i, t) {
  const it = crateKind.items[i];
  const ang = -1.85 * t;
  _h.makeTranslation(crateKind.hinge.x, crateKind.hinge.y, crateKind.hinge.z);
  _hi.makeTranslation(-crateKind.hinge.x, -crateKind.hinge.y, -crateKind.hinge.z);
  _r.makeRotationX(ang);
  it.lidM.copy(it.m).multiply(_h).multiply(_r).multiply(_hi);
}

/** Open or close crate i (index in layout.crates order). The lid swings over a quarter second. */
export function setCrateLid(i, open) {
  if (!crateKind || !crateState[i]) return;
  crateState[i].open = !!open;
  acc = TUNE.updateEvery;    // force a rebuild next frame
}

export const propColliders = () => colliders;

// ------------------------------------------------------------------------------------------ per frame
const counts = [0, 0, 0];
function bucket(kindParts, items, view, matrixOf) {
  for (const part of kindParts) { part.lods[0].count = 0; part.lods[1].count = 0; part.lods[2].count = 0; }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const d = Math.hypot(it.x - view.x, it.y - view.y, it.z - view.z);
    if (d > propDistance) continue;
    const l = d < TUNE.lodDist[0] ? 0 : d < TUNE.lodDist[1] ? 1 : 2;
    const m = matrixOf ? matrixOf(i) : it.m;
    for (const part of kindParts) {
      const im = part.lods[l];
      im.setMatrixAt(im.count++, m);
    }
    counts[l]++;
  }
  for (const part of kindParts) for (const im of part.lods) { im.instanceMatrix.needsUpdate = true; im.visible = im.count > 0; }
}

let lastView = new THREE.Vector3(1e9, 0, 0);
export function updateProps(dt, viewPos) {
  if (!root) return;
  let animating = false;
  for (let i = 0; i < crateState.length; i++) {
    const s = crateState[i];
    const target = s.open ? 1 : 0;
    if (s.t !== target) {
      s.t = target > s.t ? Math.min(1, s.t + dt * 4) : Math.max(0, s.t - dt * 4);
      lidMatrix(i, s.t * s.t * (3 - 2 * s.t));
      animating = true;
    }
  }
  acc += dt;
  if (!animating && acc < TUNE.updateEvery && lastView.distanceToSquared(viewPos) < 4) return;
  acc = 0;
  lastView.copy(viewPos);
  counts[0] = counts[1] = counts[2] = 0;
  for (const k of kinds.values()) bucket(k.parts, k.items, viewPos);
  if (crateKind) {
    bucket(crateKind.body, crateKind.items, viewPos);
    bucket(crateKind.lid, crateKind.items, viewPos, (i) => crateKind.items[i].lidM);
  }
}

export function propStats() {
  let inst = 0, tris = 0;
  const all = [...kinds.values()].flatMap((k) => k.parts).concat(crateKind ? [...crateKind.body, ...crateKind.lid] : []);
  for (const p of all) p.lods.forEach((im, li) => { inst += im.count; tris += im.count * p.tris[li]; });
  return { instances: inst, tris, lod: [...counts], simplified: !!simplifier, crates: c0 };
}

/** Change the cull distance (quality switch). */
export function setPropDistance(d) { propDistance = d; acc = TUNE.updateEvery; }
