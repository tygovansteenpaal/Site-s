// ZONEFALL - static collision world. OWNER: WORLD (internal; other groups use world/world.js).
// Every static collider (building walls, floors, stair ramps and roofs, prop boxes, rocks, tree trunks, the fort
// wall) is emitted as triangles into one BufferGeometry carrying a per-vertex surface id, and a MeshBVH
// (three-mesh-bvh) answers ray, capsule and segment queries. The terrain is not in the BVH: rays march the
// analytic heightfield (adaptive steps + bisection) and ground queries take the max of terrain and BVH floors.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { SURFACE } from '../config.js';
import { heightAt, normalAt } from './heightfield.js';

const TUNE = {
  groundTop: 420,           // ground probes start here when fromY is unbounded
  marchMin: 0.2, marchMax: 9, marchRate: 2.6, bisect: 7,
};

let bvh = null;
let geom = null;
let surfAttr = null;

// ------------------------------------------------------------------------------------------ collider builder
const _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1);
const BOX_CORNERS = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
const BOX_FACES = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 4, 7, 3], [1, 2, 6, 5], [3, 7, 6, 2], [0, 1, 5, 4]];

/** Accumulates collision triangles (world space) with a surface id per triangle. */
export class ColliderSet {
  constructor(name = 'colliders') { this.name = name; this.pos = []; this.surf = []; }
  get triangles() { return this.surf.length; }
  tri(a, b, c, s) {
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.surf.push(s);
  }
  quad(a, b, c, d, s) { this.tri(a, b, c, s); this.tri(a, c, d, s); }
  /** Box with half extents (hx, hy, hz) centred at (x, y, z), rotated by yaw about Y. */
  box(x, y, z, hx, hy, hz, yaw, s) {
    _q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw || 0);
    _m.compose(_v.set(x, y, z), _q, _s.set(1, 1, 1));
    this.boxMatrix(_m, hx, hy, hz, s);
  }
  /** Box of half extents (hx, hy, hz) in the local frame of matrix m. */
  boxMatrix(m, hx, hy, hz, s) {
    const e = m.elements;
    const P = BOX_CORNERS.map(([a, b, c]) => {
      const lx = a * hx, ly = b * hy, lz = c * hz;
      return [e[0] * lx + e[4] * ly + e[8] * lz + e[12], e[1] * lx + e[5] * ly + e[9] * lz + e[13], e[2] * lx + e[6] * ly + e[10] * lz + e[14]];
    });
    for (const f of BOX_FACES) this.quad(P[f[0]], P[f[1]], P[f[2]], P[f[3]], s);
  }
  /** Vertical prism (cylinder approximation) from y0 to y1. */
  prism(x, z, y0, y1, r, sides, s) {
    const ring = [];
    for (let i = 0; i < sides; i++) { const a = (i / sides) * Math.PI * 2; ring.push([x + Math.cos(a) * r, z + Math.sin(a) * r]); }
    for (let i = 0; i < sides; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % sides];
      this.quad([ax, y0, az], [ax, y1, az], [bx, y1, bz], [bx, y0, bz], s);
      this.tri([x, y1, z], [bx, y1, bz], [ax, y1, az], s);
    }
  }
  /** Indexed or non-indexed geometry transformed by matrix m. */
  geometry(g, m, s) {
    const p = g.attributes.position, idx = g.index;
    const n = idx ? idx.count : p.count;
    const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    for (let i = 0; i < n; i += 3) {
      for (let k = 0; k < 3; k++) { v[k].fromBufferAttribute(p, idx ? idx.getX(i + k) : i + k); if (m) v[k].applyMatrix4(m); }
      this.tri([v[0].x, v[0].y, v[0].z], [v[1].x, v[1].y, v[1].z], [v[2].x, v[2].y, v[2].z], s);
    }
  }
}

// ------------------------------------------------------------------------------------------ build
/**
 * Merge collider sets into the BVH.
 * @param {ColliderSet[]} sets
 * @returns {{triangles:number, ms:number}}
 */
export function buildCollision(sets) {
  const t0 = performance.now();
  let tris = 0;
  for (const s of sets) tris += s.triangles;
  const pos = new Float32Array(Math.max(1, tris) * 9);
  const surf = new Uint8Array(Math.max(1, tris) * 3);
  let o = 0, t = 0;
  for (const s of sets) {
    pos.set(s.pos, o); o += s.pos.length;
    for (const id of s.surf) { surf[t * 3] = surf[t * 3 + 1] = surf[t * 3 + 2] = id; t++; }
  }
  if (tris === 0) { pos.fill(-1e4); }
  geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  surfAttr = new THREE.BufferAttribute(surf, 1);
  geom.setAttribute('surface', surfAttr);
  const vcount = pos.length / 3;
  const index = vcount > 65535 ? new Uint32Array(vcount) : new Uint16Array(vcount);
  for (let i = 0; i < vcount; i++) index[i] = i;
  geom.setIndex(new THREE.BufferAttribute(index, 1));
  bvh = new MeshBVH(geom, { maxLeafSize: 8 });
  return { triangles: tris, ms: Math.round(performance.now() - t0) };
}

export const collisionGeometry = () => geom;
export const isReady = () => !!bvh;

// ------------------------------------------------------------------------------------------ queries
const _ray = new THREE.Ray();
const _box = new THREE.Box3();
const _seg = new THREE.Line3();
const _tp = new THREE.Vector3(), _cp = new THREE.Vector3(), _dir = new THREE.Vector3(), _n = new THREE.Vector3();

/** Ray vs the static BVH. Returns {distance, point, normal, surface} (fresh vectors) or null. */
export function raycastStatic(origin, dir, maxDist) {
  if (!bvh) return null;
  _ray.origin.copy(origin); _ray.direction.copy(dir);
  const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, maxDist);
  if (!hit) return null;
  const normal = hit.face ? hit.face.normal.clone() : new THREE.Vector3(0, 1, 0);
  if (normal.dot(dir) > 0) normal.negate();
  return { distance: hit.distance, point: hit.point.clone(), normal, surface: hit.face ? surfAttr.getX(hit.face.a) : SURFACE.CONCRETE };
}

/** Ray vs the analytic terrain (adaptive march + bisection). Returns {distance, point, normal} or null. */
export function raycastTerrain(origin, dir, maxDist) {
  let t = 0;
  let diff = origin.y - heightAt(origin.x, origin.z);
  if (diff < 0) {
    return { distance: 0, point: origin.clone(), normal: new THREE.Vector3(...normalAt(origin.x, origin.z)) };
  }
  let prevT = 0;
  const hz = Math.hypot(dir.x, dir.z);
  const rate = TUNE.marchRate * hz + Math.max(0, -dir.y) + 0.05;
  while (t < maxDist) {
    prevT = t;
    t = Math.min(maxDist, t + Math.min(TUNE.marchMax, Math.max(TUNE.marchMin, diff / rate)));
    const x = origin.x + dir.x * t, y = origin.y + dir.y * t, z = origin.z + dir.z * t;
    diff = y - heightAt(x, z);
    if (diff <= 0) {
      let a = prevT, b = t;
      for (let i = 0; i < TUNE.bisect; i++) {
        const m = (a + b) * 0.5;
        const mx = origin.x + dir.x * m, my = origin.y + dir.y * m, mz = origin.z + dir.z * m;
        if (my - heightAt(mx, mz) > 0) a = m; else b = m;
      }
      const point = new THREE.Vector3(origin.x + dir.x * b, origin.y + dir.y * b, origin.z + dir.z * b);
      return { distance: b, point, normal: new THREE.Vector3(...normalAt(point.x, point.z)) };
    }
    if (t >= maxDist) break;
  }
  return null;
}

/**
 * Capsule (segment start..end, radius) against the BVH. Pushes the capsule out of every contact in turn.
 * @returns {{hit:boolean, push:THREE.Vector3, normal:THREE.Vector3}}
 */
export function capsule(start, end, radius) {
  const res = { hit: false, push: new THREE.Vector3(), normal: new THREE.Vector3() };
  if (!bvh) return res;
  _seg.start.copy(start); _seg.end.copy(end);
  for (let pass = 0; pass < 2; pass++) {
    _box.makeEmpty();
    _box.expandByPoint(_seg.start); _box.expandByPoint(_seg.end);
    _box.min.addScalar(-radius); _box.max.addScalar(radius);
    let deepest = 0;
    let any = false;
    bvh.shapecast({
      intersectsBounds: (b) => b.intersectsBox(_box),
      intersectsTriangle: (tri) => {
        const d = tri.closestPointToSegment(_seg, _tp, _cp);
        if (d >= radius) return false;
        const depth = radius - d;
        if (d > 1e-5) _dir.subVectors(_cp, _tp).divideScalar(d);
        else { tri.getNormal(_dir); if (_dir.dot(_n.subVectors(_seg.start, _tp)) < 0) _dir.negate(); }
        _seg.start.addScaledVector(_dir, depth);
        _seg.end.addScaledVector(_dir, depth);
        if (depth > deepest) { deepest = depth; res.normal.copy(_dir); }
        any = true;
        return false;
      },
    });
    if (!any) break;
    res.hit = true;
  }
  res.push.subVectors(_seg.start, start);
  if (res.hit && res.push.lengthSq() > 1e-10 && res.normal.lengthSq() < 1e-6) res.normal.copy(res.push).normalize();
  return res;
}

const _down = new THREE.Vector3(0, -1, 0);
const _o = new THREE.Vector3();
/** Highest static surface at (x, z) at or below fromY: {y, normal, surface} or null. */
export function groundBelow(x, z, fromY = Infinity) {
  if (!bvh) return null;
  const top = Number.isFinite(fromY) ? fromY : TUNE.groundTop;
  _o.set(x, top + 0.001, z);
  _ray.origin.copy(_o); _ray.direction.copy(_down);
  const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, top + 50);
  if (!hit) return null;
  const n = hit.face ? hit.face.normal : _n.set(0, 1, 0);
  const ny = Math.abs(n.y);
  return { y: hit.point.y, normal: [n.x * Math.sign(n.y || 1), ny, n.z * Math.sign(n.y || 1)], surface: surfAttr.getX(hit.face.a) };
}

/** True if no static collider blocks the segment a..b. */
export function segmentClear(a, b) {
  if (!bvh) return true;
  _dir.subVectors(b, a);
  const len = _dir.length();
  if (len < 1e-4) return true;
  _ray.origin.copy(a); _ray.direction.copy(_dir.divideScalar(len));
  return !bvh.raycastFirst(_ray, THREE.DoubleSide, 0, len);
}

/** Debug mesh of every collider (wireframe), for the WORLD harness. */
export function debugMesh() {
  if (!geom) return null;
  const m = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: 0xff7a2e, wireframe: true, transparent: true, opacity: 0.45, depthTest: true }));
  m.name = 'collider-debug';
  m.frustumCulled = false;
  return m;
}
