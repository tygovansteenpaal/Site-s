// ZONEFALL - procedural enterable buildings and site structures. OWNER: WORLD (internal).
// Rules (ARCHITECTURE.md 3.4): 3.0 m storeys, 0.25 m walls (0.15 exterior skin + 0.10 interior skin, so facades
// and rooms get different materials), door openings 1.2 x 2.2 m, windows 1.2 x 1.3 m with the sill at 0.9 m (no
// glass), stairs as visual steps over a collision ramp (rise 0.18, tread 0.28), flat walkable roofs with parapets
// on military/industrial buildings (stairs or ladder ramps up), pitched roofs on houses.
// Everything of a site merges into ONE geometry drawn with the shared texture-array surface material (layer, tint
// and an ambient-occlusion factor per vertex: rooms receive far less sky light than facades). Each building also
// yields colliders (oriented boxes and triangles), rooms (for loot points), doorways (bot nav hints) and its
// footprint. Generation is deterministic from MAP.seed and independent of the quality tier.
import * as THREE from 'three';
import { SURFACE } from '../config.js';
import { Rng } from '../core/rng.js';
import { L, TILE } from './materials.js';
import { heightAt } from './heightfield.js';

export const TUNE = {
  storey: 3.0, slab: 0.2, outer: 0.15, inner: 0.10,
  door: { w: 1.2, h: 2.2 }, win: { w: 1.2, h: 1.3, sill: 0.9 },
  rise: 3.0 / 17, tread: 0.28, stairW: 1.05,
  ao: { floor: 0.42, wall: 0.46, ceiling: 0.34, reveal: 0.78, groundContact: 0.78 },
  tintScale: 2.0,            // vertex tints are stored / 2 so tints above 1 can brighten (white plaster)
};
const H = TUNE.storey, SLAB = TUNE.slab, OUT = TUNE.outer, INN = TUNE.inner, WT = OUT + INN;
const RUN = 16 * TUNE.tread;

const SURF_OF = {
  [L.red_brick_03]: SURFACE.CONCRETE, [L.concrete_wall_008]: SURFACE.CONCRETE, [L.concrete_floor_worn_001]: SURFACE.CONCRETE,
  [L.weathered_brown_planks]: SURFACE.WOOD, [L.corrugated_iron]: SURFACE.METAL, [L.green_metal_rust]: SURFACE.METAL,
  [L.asphalt_02]: SURFACE.ASPHALT, [L.gravelly_sand]: SURFACE.DIRT, [L.rocky_terrain_02]: SURFACE.ROCK,
  [L.sparse_grass]: SURFACE.GRASS, [L.leafy_grass]: SURFACE.GRASS, [L.forrest_ground_01]: SURFACE.GRASS, [L.brown_mud_02]: SURFACE.DIRT,
};

/** Material reference: array layer + linear tint. */
const M = (layer, r = 1, g = r, b = r) => ({ l: layer, c: [r, g, b] });
const MAT = {
  brick: M(L.red_brick_03, 1.0, 0.97, 0.95), brickDark: M(L.red_brick_03, 0.82, 0.76, 0.74),
  plasterCream: M(L.concrete_wall_008, 1.32, 1.24, 1.06), plasterWhite: M(L.concrete_wall_008, 1.45, 1.43, 1.36),
  plasterOchre: M(L.concrete_wall_008, 1.32, 1.12, 0.78), plasterSage: M(L.concrete_wall_008, 1.06, 1.14, 1.0),
  plasterRose: M(L.concrete_wall_008, 1.34, 1.08, 0.98), plasterGrey: M(L.concrete_wall_008, 1.1, 1.1, 1.08),
  interior: M(L.concrete_wall_008, 1.38, 1.34, 1.24), interiorWarm: M(L.concrete_wall_008, 1.36, 1.24, 1.06),
  concrete: M(L.concrete_wall_008, 1.0, 1.0, 0.97), concreteOlive: M(L.concrete_wall_008, 0.92, 0.95, 0.8),
  concreteSand: M(L.concrete_wall_008, 1.18, 1.1, 0.92), stone: M(L.concrete_wall_008, 1.06, 1.0, 0.9),
  floorWood: M(L.weathered_brown_planks, 1.05, 0.98, 0.92), floorConcrete: M(L.concrete_floor_worn_001, 1.0),
  roofTar: M(L.concrete_floor_worn_001, 0.48, 0.48, 0.47), slab: M(L.concrete_floor_worn_001, 1.05, 1.04, 1.0),
  trimWood: M(L.weathered_brown_planks, 0.62, 0.52, 0.46), trimWhite: M(L.concrete_wall_008, 1.6, 1.58, 1.52),
  planks: M(L.weathered_brown_planks, 1.0), planksRed: M(L.weathered_brown_planks, 1.05, 0.55, 0.45), planksDark: M(L.weathered_brown_planks, 0.66, 0.6, 0.56),
  ironGrey: M(L.corrugated_iron, 0.95, 0.97, 1.0), ironRust: M(L.corrugated_iron, 0.86, 0.5, 0.38), ironGreen: M(L.corrugated_iron, 0.56, 0.7, 0.52),
  ironBlue: M(L.corrugated_iron, 0.55, 0.68, 0.86), ironWhite: M(L.corrugated_iron, 1.32, 1.32, 1.28), ironDark: M(L.corrugated_iron, 0.6, 0.6, 0.62),
  ironRed: M(L.corrugated_iron, 0.95, 0.38, 0.3), ironSand: M(L.corrugated_iron, 1.15, 1.02, 0.8),
  metalGreen: M(L.green_metal_rust, 1.0), metalYellow: M(L.green_metal_rust, 1.9, 1.5, 0.45), metalWhite: M(L.green_metal_rust, 1.7, 1.75, 1.7),
  metalGrey: M(L.green_metal_rust, 1.1, 1.15, 1.2), metalRed: M(L.green_metal_rust, 1.7, 0.7, 0.55), metalBlue: M(L.green_metal_rust, 0.8, 1.0, 1.6),
  metalOrange: M(L.green_metal_rust, 1.9, 1.0, 0.45),
  turf: M(L.sparse_grass, 1.0), gravel: M(L.gravelly_sand, 1.0), rock: M(L.rocky_terrain_02, 1.0),
};

// ------------------------------------------------------------------------------------------ geometry builder
const PX = 1, NX = 2, PY = 4, NY = 8, PZ = 16, NZ = 32;

/** Merged geometry in world space with a local building frame; also collects colliders. */
class Geo {
  constructor() {
    this.pos = []; this.nrm = []; this.uv = []; this.col = []; this.srf = []; this.idx = [];
    this.vc = 0;
    this.boxes = [];   // colliders: {c:[3], a:[3], b:[3], d:[3], s}
    this.tris = [];    // collider triangles: {p:[9], s}
    this.frame(0, 0, 0, 0);
    this.aoFn = null;
  }
  frame(x, y, z, yaw) { this.ox = x; this.oy = y; this.oz = z; this.c = Math.cos(yaw); this.s = Math.sin(yaw); this.yaw = yaw; return this; }
  // local -> world (three.js Y rotation)
  wx(x, z) { return this.ox + x * this.c + z * this.s; }
  wz(x, z) { return this.oz - x * this.s + z * this.c; }
  face(P, N, UV, m, aos) {
    const base = this.vc;
    const nx = N[0] * this.c + N[2] * this.s, nz = -N[0] * this.s + N[2] * this.c;
    let cx = 0, cy = 0, cz = 0;
    for (const p of P) { cx += p[0]; cy += p[1]; cz += p[2]; }
    cx /= P.length; cy /= P.length; cz /= P.length;
    const ao = this.aoFn ? this.aoFn(cx, cy, cz, N[0], N[1], N[2]) : 1;
    const ts = 1 / TUNE.tintScale;
    for (let i = 0; i < P.length; i++) {
      const [x, y, z] = P[i];
      this.pos.push(this.wx(x, z), this.oy + y, this.wz(x, z));
      this.nrm.push(nx, N[1], nz);
      this.uv.push(UV[i][0], UV[i][1]);
      this.col.push(Math.min(255, m.c[0] * ts * 255), Math.min(255, m.c[1] * ts * 255), Math.min(255, m.c[2] * ts * 255));
      let a = aos ? aos[i] * ao : ao;
      if (ao >= 0.99 && y < 0.35 && N[1] < 0.5) a *= TUNE.ao.groundContact + (1 - TUNE.ao.groundContact) * Math.max(0, y / 0.35);
      this.srf.push(m.l, a);
      this.vc++;
    }
    if (P.length === 4) this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else this.idx.push(base, base + 1, base + 2);
  }
  /** Axis-aligned box in the local frame. o: {skip, mats:{px,nx,py,ny,pz,nz}, col:false, surf, uvOff} */
  box(x0, y0, z0, x1, y1, z1, m, o = {}) {
    if (x1 - x0 < 1e-4 || y1 - y0 < 1e-4 || z1 - z0 < 1e-4) return;
    const sk = o.skip || 0, mats = o.mats || {};
    const t = (mm) => 1 / TILE[mm.l];
    const uo = o.uvOff || 0;
    const F = (mask, key, P, N, uvf) => {
      if (sk & mask) return;
      const mm = mats[key] || m;
      const k = t(mm);
      this.face(P, N, P.map((p) => uvf(p, k)), mm);
    };
    F(PX, 'px', [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], (p, k) => [-p[2] * k + uo, p[1] * k]);
    F(NX, 'nx', [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], (p, k) => [p[2] * k + uo, p[1] * k]);
    F(PY, 'py', [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], (p, k) => [p[0] * k + uo, -p[2] * k]);
    F(NY, 'ny', [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], (p, k) => [p[0] * k + uo, p[2] * k]);
    F(PZ, 'pz', [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], (p, k) => [p[0] * k + uo, p[1] * k]);
    F(NZ, 'nz', [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], (p, k) => [-p[0] * k + uo, p[1] * k]);
    if (o.col !== false) this.colBox((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2, o.surf ?? SURF_OF[m.l]);
  }
  /** Collider box in local frame (axis aligned locally). */
  colBox(cx, cy, cz, hx, hy, hz, s) {
    const c = this.c, sn = this.s;
    this.boxes.push({ c: [this.wx(cx, cz), this.oy + cy, this.wz(cx, cz)], a: [c * hx, 0, -sn * hx], b: [0, hy, 0], d: [sn * hz, 0, c * hz], s });
  }
  /**
   * Oriented box with local basis vectors (in the building frame) ax, ay, az (unit) and half extents.
   * UVs are box-local (u along ax, v along az for the +ay face; faces along az use (ax, ay)).
   */
  boxB(cx, cy, cz, ax, ay, azIn, hx, hy, hz, m, o = {}) {
    const mats = o.mats || {}, sk = o.skip || 0;
    // orthonormal, right-handed frame (the box is symmetric, so only the winding depends on az's sign)
    const al = Math.hypot(ax[0], ax[1], ax[2]); ax = [ax[0] / al, ax[1] / al, ax[2] / al];
    const dp = ax[0] * ay[0] + ax[1] * ay[1] + ax[2] * ay[2];
    ay = [ay[0] - ax[0] * dp, ay[1] - ax[1] * dp, ay[2] - ax[2] * dp];
    const yl = Math.hypot(ay[0], ay[1], ay[2]) || 1; ay = [ay[0] / yl, ay[1] / yl, ay[2] / yl];
    const az = [ax[1] * ay[2] - ax[2] * ay[1], ax[2] * ay[0] - ax[0] * ay[2], ax[0] * ay[1] - ax[1] * ay[0]];
    const P = (sx, sy, sz) => [cx + ax[0] * hx * sx + ay[0] * hy * sy + az[0] * hz * sz, cy + ax[1] * hx * sx + ay[1] * hy * sy + az[1] * hz * sz, cz + ax[2] * hx * sx + ay[2] * hy * sy + az[2] * hz * sz];
    const neg = (v) => [-v[0], -v[1], -v[2]];
    const F = (mask, key, pts, N, uvs) => {
      if (sk & mask) return;
      const mm = mats[key] || m;
      const k = 1 / TILE[mm.l];
      this.face(pts, N, uvs.map(([u, v]) => [u * k, v * k]), mm);
    };
    const X = hx, Y = hy, Z = hz;
    F(PY, 'py', [P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), P(-1, 1, -1)], ay, [[-X, Z], [X, Z], [X, -Z], [-X, -Z]]);
    F(NY, 'ny', [P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1)], neg(ay), [[-X, -Z], [X, -Z], [X, Z], [-X, Z]]);
    F(PX, 'px', [P(1, -1, 1), P(1, -1, -1), P(1, 1, -1), P(1, 1, 1)], ax, [[Z, -Y], [-Z, -Y], [-Z, Y], [Z, Y]]);
    F(NX, 'nx', [P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1)], neg(ax), [[-Z, -Y], [Z, -Y], [Z, Y], [-Z, Y]]);
    F(PZ, 'pz', [P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)], az, [[-X, -Y], [X, -Y], [X, Y], [-X, Y]]);
    F(NZ, 'nz', [P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1)], neg(az), [[X, -Y], [-X, -Y], [-X, Y], [X, Y]]);
    if (o.col !== false) {
      const c = this.c, sn = this.s;
      const rot = (v, h) => [(v[0] * c + v[2] * sn) * h, v[1] * h, (-v[0] * sn + v[2] * c) * h];
      this.boxes.push({ c: [this.wx(cx, cz), this.oy + cy, this.wz(cx, cz)], a: rot(ax, hx), b: rot(ay, hy), d: rot(az, hz), s: o.surf ?? SURF_OF[m.l] });
    }
  }
  /** Flat polygon face (3 or 4 points, local) with planar UVs projected on the dominant axes. */
  poly(P, N, m, o = {}) {
    const k = 1 / TILE[m.l];
    const ax = Math.abs(N[0]) > Math.abs(N[2]) ? 'x' : 'z';
    const uv = P.map((p) => (Math.abs(N[1]) > 0.7 ? [p[0] * k, -p[2] * k] : ax === 'x' ? [-p[2] * k * Math.sign(N[0]), p[1] * k] : [p[0] * k * Math.sign(N[2]), p[1] * k]));
    this.face(P, N, uv, m, o.ao);
    if (o.col) {
      const w = P.map(([x, y, z]) => [this.wx(x, z), this.oy + y, this.wz(x, z)]);
      this.tris.push({ p: [...w[0], ...w[1], ...w[2]], s: o.surf ?? SURF_OF[m.l] });
      if (P.length === 4) this.tris.push({ p: [...w[0], ...w[2], ...w[3]], s: o.surf ?? SURF_OF[m.l] });
    }
  }
  /** Vertical cylinder / cone frustum around (cx, cz) in the local frame. o: {top, bottom, inside, col, from, to} */
  cyl(cx, cz, y0, y1, r0, r1, n, m, o = {}) {
    const k = 1 / TILE[m.l];
    const circ = Math.PI * 2 * Math.max(r0, r1);
    const a0 = o.from || 0, a1 = o.to || Math.PI * 2;
    const seg = Math.max(1, Math.round(n * (a1 - a0) / (Math.PI * 2)));
    const slope = (r0 - r1) / Math.max(1e-6, y1 - y0);
    for (let i = 0; i < seg; i++) {
      const ta = a0 + (a1 - a0) * (i / seg), tb = a0 + (a1 - a0) * ((i + 1) / seg);
      const ca = Math.cos(ta), sa = Math.sin(ta), cb = Math.cos(tb), sb = Math.sin(tb);
      const P = [[cx + ca * r0, y0, cz + sa * r0], [cx + cb * r0, y0, cz + sb * r0], [cx + cb * r1, y1, cz + sb * r1], [cx + ca * r1, y1, cz + sa * r1]];
      const tm = (ta + tb) / 2;
      let N = [Math.cos(tm), slope, Math.sin(tm)];
      const nl = Math.hypot(N[0], N[1], N[2]); N = [N[0] / nl, N[1] / nl, N[2] / nl];
      const u0 = (ta / (Math.PI * 2)) * circ * k, u1 = (tb / (Math.PI * 2)) * circ * k;
      if (o.inside) this.face([P[0], P[1], P[2], P[3]], [-N[0], 0, -N[2]], [[u0, y0 * k], [u1, y0 * k], [u1, y1 * k], [u0, y1 * k]], m);
      else this.face([P[1], P[0], P[3], P[2]], N, [[u1, y0 * k], [u0, y0 * k], [u0, y1 * k], [u1, y1 * k]], m);
    }
    if (o.top) {
      for (let i = 0; i < seg; i++) {
        const ta = a0 + (a1 - a0) * (i / seg), tb = a0 + (a1 - a0) * ((i + 1) / seg);
        this.face([[cx, y1, cz], [cx + Math.cos(tb) * r1, y1, cz + Math.sin(tb) * r1], [cx + Math.cos(ta) * r1, y1, cz + Math.sin(ta) * r1]], [0, 1, 0],
          [[cx * k, -cz * k], [(cx + Math.cos(tb) * r1) * k, -(cz + Math.sin(tb) * r1) * k], [(cx + Math.cos(ta) * r1) * k, -(cz + Math.sin(ta) * r1) * k]], o.topMat || m);
      }
    }
    if (o.col) {
      const sides = Math.max(8, Math.min(16, n));
      for (let i = 0; i < sides; i++) {
        const ta = (i / sides) * Math.PI * 2, tb = ((i + 1) / sides) * Math.PI * 2;
        const W = (a, r, y) => [this.wx(cx + Math.cos(a) * r, cz + Math.sin(a) * r), this.oy + y, this.wz(cx + Math.cos(a) * r, cz + Math.sin(a) * r)];
        const p0 = W(ta, r0, y0), p1 = W(tb, r0, y0), p2 = W(tb, r1, y1), p3 = W(ta, r1, y1);
        const s = o.surf ?? SURF_OF[m.l];
        this.tris.push({ p: [...p0, ...p1, ...p2], s }, { p: [...p0, ...p2, ...p3], s });
        if (o.top) this.tris.push({ p: [this.wx(cx, cz), this.oy + y1, this.wz(cx, cz), ...p3, ...p2], s });
      }
    }
  }
  /** Convert to a BufferGeometry (positions world space). */
  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(this.col), 3, true));
    g.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.srf, 2));
    g.setIndex(this.vc > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
  get triangles() { return this.idx.length / 3; }
}

// ------------------------------------------------------------------------------------------ building context
/** Per-building output: rooms (world-space rects for loot), doors (nav), covers. */
function makeCtx(g, b) {
  return { g, b, rooms: [], doors: [], covers: [], rng: new Rng(b.seed) };
}

function setInteriorAO(g, w, d, top, extra = null) {
  const ao = TUNE.ao;
  g.aoFn = (x, y, z, nx, ny, nz) => {
    if (extra) { const v = extra(x, y, z, nx, ny, nz); if (v != null) return v; }
    const ix = Math.abs(x) < w / 2 - WT * 0.7, iz = Math.abs(z) < d / 2 - WT * 0.7;
    if (y < top - 0.02 && y > -0.01 && ix && iz) return ny > 0.5 ? ao.floor : ny < -0.5 ? ao.ceiling : ao.wall;
    const rx = Math.abs(x) < w / 2 - 0.01, rz = Math.abs(z) < d / 2 - 0.01;
    if (y < top && y > 0 && rx && rz && (Math.abs(nx) > 0.5 || Math.abs(nz) > 0.5 || ny !== 0)) return ao.reveal;
    return 1;
  };
}

/** Local room rect -> world-space room record. */
function addRoom(ctx, x0, z0, x1, z1, y, avoid = []) {
  const { g } = ctx;
  ctx.rooms.push({ x0, z0, x1, z1, y: g.oy + y, frame: { x: g.ox, z: g.oz, c: g.c, s: g.s }, avoid, site: ctx.b.site, indoor: true });
}

function addDoor(ctx, lx, lz, nx, nz, y = 0) {
  const { g } = ctx;
  const px = lx + nx * 1.2, pz = lz + nz * 1.2;
  ctx.doors.push({ pos: [g.wx(px, pz), g.oy + y, g.wz(px, pz)], dir: [nx * g.c + nz * g.s, 0, -nx * g.s + nz * g.c], site: ctx.b.site });
}

// ------------------------------------------------------------------------------------------ walls and openings
/**
 * Wall slab running along `axis` ('x' or 'z') from a0 to a1, occupying b0..b1 across, y0..y1, with openings
 * [{c, w, y0, y1}] (c = centre along the axis). Emits pieces around every opening.
 */
function wallRun(g, axis, a0, a1, b0, b1, y0, y1, openings, m, skip = 0, col = true) {
  const ops = openings.filter((o) => o.y1 > y0 + 0.01 && o.y0 < y1 - 0.01 && o.c + o.w / 2 > a0 && o.c - o.w / 2 < a1).sort((p, q) => p.c - q.c);
  const B = (u0, v0, u1, v1, sk) => {
    if (axis === 'x') g.box(u0, v0, b0, u1, v1, b1, m, { skip: sk, col });
    else g.box(b0, v0, u0, b1, v1, u1, m, { skip: sk, col });
  };
  let cur = a0;
  const botSkip = skip | NY;
  for (const o of ops) {
    const o0 = Math.max(a0, o.c - o.w / 2), o1 = Math.min(a1, o.c + o.w / 2);
    if (o0 > cur + 1e-3) B(cur, y0, o0, y1, botSkip);
    const oy0 = Math.max(y0, o.y0), oy1 = Math.min(y1, o.y1);
    if (oy0 > y0 + 1e-3) B(o0, y0, o1, oy0, botSkip);
    if (oy1 < y1 - 1e-3) B(o0, oy1, o1, y1, skip);
    cur = Math.max(cur, o1);
  }
  if (cur < a1 - 1e-3) B(cur, y0, a1, y1, botSkip);
}

/** Window/door frame inside an opening at the wall mid-plane, plus an exterior sill for windows. */
function frameOpening(g, side, o, wallOuter, m) {
  const fw = 0.07, fd = 0.09;
  const mid = wallOuter - Math.sign(wallOuter) * WT * 0.45;
  const isWin = o.y0 > 0.3;
  const B = (a0, a1, y0, y1, depth0, depth1) => {
    if (side === 'x') g.box(a0, y0, Math.min(depth0, depth1), a1, y1, Math.max(depth0, depth1), m, { col: false });
    else g.box(Math.min(depth0, depth1), y0, a0, Math.max(depth0, depth1), y1, a1, m, { col: false });
  };
  const d0 = mid - fd / 2, d1 = mid + fd / 2;
  const a0 = o.c - o.w / 2, a1 = o.c + o.w / 2;
  B(a0, a0 + fw, o.y0, o.y1, d0, d1);
  B(a1 - fw, a1, o.y0, o.y1, d0, d1);
  B(a0 + fw, a1 - fw, o.y1 - fw, o.y1, d0, d1);
  if (isWin) {
    B(a0 + fw, a1 - fw, o.y0, o.y0 + fw * 0.8, d0, d1);
    // mullion for wide windows
    if (o.w > 1.6) B(o.c - fw / 2, o.c + fw / 2, o.y0, o.y1, d0, d1);
    const sg = Math.sign(wallOuter);
    B(a0 - 0.06, a1 + 0.06, o.y0 - 0.06, o.y0, wallOuter - sg * 0.12, wallOuter + sg * 0.07);
  } else {
    // threshold
    B(a0, a1, 0, 0.03, d0 - 0.05, d1 + 0.05);
  }
}

function spread(a0, a1, n, w) {
  const out = [];
  if (n <= 0) return out;
  const step = (a1 - a0) / n;
  for (let i = 0; i < n; i++) out.push(a0 + step * (i + 0.5));
  return out.filter((c) => c - w / 2 > a0 && c + w / 2 < a1);
}

/** Auto window centres along a wall span avoiding given [lo, hi] ranges. */
function windowSpots(a0, a1, w, gap, avoid) {
  const n = Math.max(0, Math.floor((a1 - a0 - 0.8) / (w + gap)));
  return spread(a0 + 0.4, a1 - 0.4, n, w).filter((c) => !avoid.some(([lo, hi]) => c + w / 2 > lo && c - w / 2 < hi));
}

// ------------------------------------------------------------------------------------------ stairs and slabs
function stairs(ctx, x0, z0, wdt, y0, m, sideMat, dirSign = 1, hgt = H) {
  const { g } = ctx;
  const r = hgt / 17, t = TUNE.tread;
  for (let i = 0; i < 16; i++) {
    const xa = dirSign > 0 ? x0 + i * t : x0 - (i + 1) * t, xb = xa + t;
    g.box(xa, y0, z0, xb, y0 + (i + 1) * r, z0 + wdt, m, { col: false, skip: NY });
  }
  // collision ramp: walk surface from (x0, y0) to (x0 + RUN, y0 + H)
  const ang = Math.atan2(hgt, RUN), len = Math.hypot(hgt, RUN);
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const th = 0.25;
  const midX = x0 + dirSign * RUN / 2, midY = y0 + hgt / 2;
  const ax = [dirSign * ca, sa, 0], ay = [-dirSign * sa, ca, 0];
  const cx = midX - ay[0] * th / 2, cy = midY - ay[1] * th / 2;
  const c = g.c, sn = g.s;
  const rot = (v, h) => [(v[0] * c + v[2] * sn) * h, v[1] * h, (-v[0] * sn + v[2] * c) * h];
  g.boxes.push({ c: [g.wx(cx, z0 + wdt / 2), g.oy + cy, g.wz(cx, z0 + wdt / 2)], a: rot(ax, len / 2), b: rot(ay, th / 2), d: rot([0, 0, 1], wdt / 2), s: SURF_OF[m.l] });
  // side panel closing the void under the flight
  const xe = x0 + dirSign * RUN;
  const zf = z0 + wdt;
  const P = dirSign > 0 ? [[x0, y0, zf], [xe, y0, zf], [xe, y0 + hgt - r, zf]] : [[xe, y0, zf], [x0, y0, zf], [xe, y0 + hgt - r, zf]];
  g.poly(P, [0, 0, 1], sideMat, { col: true });
}

/** Rect slab with optional rectangular holes (local coords), as separate boxes. */
function slabWithHoles(g, x0, z0, x1, z1, y0, y1, holes, m, o = {}) {
  let rects = [[x0, z0, x1, z1]];
  for (const [hx0, hz0, hx1, hz1] of holes) {
    const next = [];
    for (const [a0, b0, a1, b1] of rects) {
      if (hx1 <= a0 || hx0 >= a1 || hz1 <= b0 || hz0 >= b1) { next.push([a0, b0, a1, b1]); continue; }
      const cx0 = Math.max(a0, hx0), cx1 = Math.min(a1, hx1), cz0 = Math.max(b0, hz0), cz1 = Math.min(b1, hz1);
      if (cz0 > b0) next.push([a0, b0, a1, cz0]);
      if (cz1 < b1) next.push([a0, cz1, a1, b1]);
      if (cx0 > a0) next.push([a0, cz0, cx0, cz1]);
      if (cx1 < a1) next.push([cx1, cz0, a1, cz1]);
    }
    rects = next;
  }
  for (const [a0, b0, a1, b1] of rects) g.box(a0, y0, b0, a1, y1, b1, m, o);
}

function railing(g, axis, a0, a1, b, y, m, col = true) {
  const h = 1.0, post = 0.05;
  const len = a1 - a0;
  const n = Math.max(1, Math.round(len / 1.2));
  for (let i = 0; i <= n; i++) {
    const a = a0 + (len * i) / n;
    if (axis === 'x') g.box(a - post / 2, y, b - post / 2, a + post / 2, y + h, b + post / 2, m, { col: false });
    else g.box(b - post / 2, y, a - post / 2, b + post / 2, y + h, a + post / 2, m, { col: false });
  }
  if (axis === 'x') { g.box(a0, y + h - 0.05, b - 0.035, a1, y + h, b + 0.035, m, { col: false }); g.box(a0, y + 0.5, b - 0.02, a1, y + 0.54, b + 0.02, m, { col: false }); }
  else { g.box(b - 0.035, y + h - 0.05, a0, b + 0.035, y + h, a1, m, { col: false }); g.box(b - 0.02, y + 0.5, a0, b + 0.02, y + 0.54, a1, m, { col: false }); }
  if (col) {
    if (axis === 'x') g.colBox((a0 + a1) / 2, y + h / 2, b, len / 2, h / 2, 0.06, SURFACE.METAL);
    else g.colBox(b, y + h / 2, (a0 + a1) / 2, 0.06, h / 2, len / 2, SURFACE.METAL);
  }
}

/** Ladder ramp: a 45 degree walkable ramp with ladder rails and rungs drawn on it. dir: local direction (+x etc.). */
function ladderRamp(g, x, z, y0, y1, dirX, dirZ, m) {
  const hgt = y1 - y0, run = hgt * 1.02;
  const len = Math.hypot(hgt, run), ang = Math.atan2(hgt, run);
  const ax = [dirX * Math.cos(ang), Math.sin(ang), dirZ * Math.cos(ang)];
  const ay = [-dirX * Math.sin(ang), Math.cos(ang), -dirZ * Math.sin(ang)];
  const az = [-dirZ, 0, dirX];
  const cx = x + dirX * run / 2, cz = z + dirZ * run / 2, cy = y0 + hgt / 2;
  // rails
  for (const side of [-0.32, 0.32]) {
    g.boxB(cx + az[0] * side, cy, cz + az[2] * side, ax, ay, az, len / 2, 0.04, 0.03, m, { col: false });
  }
  const rungs = Math.floor(len / 0.3);
  for (let i = 1; i < rungs; i++) {
    const t = i / rungs - 0.5;
    g.boxB(cx + ax[0] * len * t, cy + ax[1] * len * t + 0.02, cz + ax[2] * len * t, ax, ay, az, 0.02, 0.02, 0.3, m, { col: false });
  }
  // invisible walk ramp
  const th = 0.2;
  const c = g.c, sn = g.s;
  const rot = (v, h) => [(v[0] * c + v[2] * sn) * h, v[1] * h, (-v[0] * sn + v[2] * c) * h];
  const px = cx - ay[0] * th / 2, py = cy - ay[1] * th / 2, pz = cz - ay[2] * th / 2;
  g.boxes.push({ c: [g.wx(px, pz), g.oy + py, g.wz(px, pz)], a: rot(ax, len / 2), b: rot(ay, th / 2), d: rot(az, 0.4), s: SURFACE.METAL });
}

// ------------------------------------------------------------------------------------------ roofs
function gableRoof(ctx, w, d, top, pitch, m, o = {}) {
  const { g } = ctx;
  const along = o.along || 'x';       // ridge direction
  const ov = o.overhang ?? 0.45, ovEnd = o.overhangEnd ?? 0.35, th = 0.12;
  const span = (along === 'x' ? d : w) / 2;
  const length = (along === 'x' ? w : d) / 2 + ovEnd;
  const rise = span * Math.tan(pitch);
  const ridge = top + rise;
  const slopeLen = (span + ov) / Math.cos(pitch);
  for (const side of [-1, 1]) {
    // slope direction from eave to ridge, in local coordinates
    let ax, ay, az, cx, cz, cy;
    const sd = [0, Math.sin(pitch), 0];
    if (along === 'x') { sd[2] = -side * Math.cos(pitch); az = [1, 0, 0]; } else { sd[0] = -side * Math.cos(pitch); az = [0, 0, 1]; }
    const nrm = along === 'x' ? [0, Math.cos(pitch), side * Math.sin(pitch)] : [side * Math.sin(pitch), Math.cos(pitch), 0];
    const eave = (span + ov) * side, eaveY = top - ov * Math.tan(pitch);
    const mid = eave - side * (span + ov) / 2;
    cy = (eaveY + ridge) / 2 + nrm[1] * th / 2;
    if (along === 'x') { cx = 0; cz = mid + nrm[2] * th / 2; ax = [1, 0, 0]; } else { cz = 0; cx = mid + nrm[0] * th / 2; ax = [0, 0, 1]; }
    // boxB axes: ax = along ridge (u), ay = normal, az = slope direction (v)
    g.boxB(cx, cy, cz, ax, nrm, sd, length, th / 2, slopeLen / 2, m, { mats: { ny: o.soffit || MAT.planksDark } });
  }
  // ridge cap
  if (along === 'x') g.box(-length, ridge - 0.02, -0.16, length, ridge + 0.1, 0.16, o.cap || m, { col: false });
  else g.box(-0.16, ridge - 0.02, -length, 0.16, ridge + 0.1, length, o.cap || m, { col: false });
  // gable triangles (outer skin) at both ends
  const gm = o.gable || MAT.plasterWhite;
  for (const e of [-1, 1]) {
    if (along === 'x') {
      const x = e * w / 2;
      const P = e > 0 ? [[x, top, d / 2], [x, top, -d / 2], [x, ridge, 0]] : [[x, top, -d / 2], [x, top, d / 2], [x, ridge, 0]];
      g.poly(P, [e, 0, 0], gm, { col: true });
      const xi = e * (w / 2 - WT);
      const Pi = e > 0 ? [[xi, top, -d / 2 + WT], [xi, top, d / 2 - WT], [xi, ridge - 0.2, 0]] : [[xi, top, d / 2 - WT], [xi, top, -d / 2 + WT], [xi, ridge - 0.2, 0]];
      if (o.openAttic) g.poly(Pi, [-e, 0, 0], o.inner || MAT.interior);
    } else {
      const z = e * d / 2;
      const P = e > 0 ? [[-w / 2, top, z], [w / 2, top, z], [0, ridge, z]] : [[w / 2, top, z], [-w / 2, top, z], [0, ridge, z]];
      g.poly(P, [0, 0, e], gm, { col: true });
      if (o.openAttic) {
        const zi = e * (d / 2 - WT);
        const Pi = e > 0 ? [[w / 2 - WT, top, zi], [-w / 2 + WT, top, zi], [0, ridge - 0.2, zi]] : [[-w / 2 + WT, top, zi], [w / 2 - WT, top, zi], [0, ridge - 0.2, zi]];
        g.poly(Pi, [0, 0, -e], o.inner || MAT.interior);
      }
    }
  }
  if (o.openAttic) {
    // underside of the roof visible from inside (barns, churches)
    for (const side of [-1, 1]) {
      if (along === 'x') {
        const P = side > 0 ? [[w / 2 - WT, top, d / 2 - WT], [-w / 2 + WT, top, d / 2 - WT], [-w / 2 + WT, ridge - 0.15, 0], [w / 2 - WT, ridge - 0.15, 0]]
          : [[-w / 2 + WT, top, -d / 2 + WT], [w / 2 - WT, top, -d / 2 + WT], [w / 2 - WT, ridge - 0.15, 0], [-w / 2 + WT, ridge - 0.15, 0]];
        g.poly(P, [0, -Math.cos(pitch), -side * Math.sin(pitch)], o.underside || MAT.planksDark);
      } else {
        const P = side > 0 ? [[w / 2 - WT, top, -d / 2 + WT], [w / 2 - WT, top, d / 2 - WT], [0, ridge - 0.15, d / 2 - WT], [0, ridge - 0.15, -d / 2 + WT]]
          : [[-w / 2 + WT, top, d / 2 - WT], [-w / 2 + WT, top, -d / 2 + WT], [0, ridge - 0.15, -d / 2 + WT], [0, ridge - 0.15, d / 2 - WT]];
        g.poly(P, [-side * Math.sin(pitch), -Math.cos(pitch), 0], o.underside || MAT.planksDark);
      }
    }
  }
  return ridge;
}

function flatRoof(ctx, w, d, top, parapet, roofMat, wallMat, holes = []) {
  const { g } = ctx;
  slabWithHoles(g, -w / 2 + OUT, -d / 2 + OUT, w / 2 - OUT, d / 2 - OUT, top - SLAB, top, holes, roofMat, { mats: { ny: MAT.interior }, skip: 0 });
  if (parapet > 0) {
    const p = parapet, t = 0.22;
    const pm = { mats: { py: MAT.slab }, skip: NY };
    g.box(-w / 2, top, d / 2 - t, w / 2, top + p, d / 2, wallMat, pm);
    g.box(-w / 2, top, -d / 2, w / 2, top + p, -d / 2 + t, wallMat, pm);
    g.box(w / 2 - t, top, -d / 2 + t, w / 2, top + p, d / 2 - t, wallMat, pm);
    g.box(-w / 2, top, -d / 2 + t, -w / 2 + t, top + p, d / 2 - t, wallMat, pm);
  }
}

// ------------------------------------------------------------------------------------------ the generic storeyed block
/**
 * spec: {w, d, storeys, out, inn, floor, roof:{type, mat, pitch, parapet, access}, doors:[{side, c, w?, h?}],
 *        big:[{side, c, w, y0, y1}], winW, winH, sill, winGap, partitions:[x], stairs:{x0, side:'back'}, trim,
 *        shutters, noWindows:{front,back,left,right}, plinth, chimney}
 */
function block(ctx, spec) {
  const { g } = ctx;
  const { w, d } = spec;
  const ns = spec.storeys || 1;
  const sh = spec.storeyH || H;
  const top = ns * sh;
  const hw = w / 2, hd = d / 2;
  setInteriorAO(g, w, d, top, spec.aoExtra);
  // plinth down to the lowest terrain under the footprint
  const lowest = spec.lowest ?? 0;
  if (spec.plinth !== false) g.box(-hw - 0.06, Math.min(-0.25, lowest - 0.4), -hd - 0.06, hw + 0.06, 0, hd + 0.06, spec.plinthMat || MAT.concrete, { skip: PY | NY });
  const winW = spec.winW || TUNE.win.w, winH = spec.winH || TUNE.win.h, sill = spec.sill ?? TUNE.win.sill;
  // stairs (back wall, rising along +x)
  const st = ns > 1 || spec.roof?.access === 'stairs' ? spec.stairs || { x0: -hw + WT + 0.35 } : null;
  const stZ0 = -hd + WT, stW = TUNE.stairW;
  const stairRect = st ? [st.x0 - 0.1, stZ0, st.x0 + RUN, stZ0 + stW] : null;
  // partitions (perpendicular to x), kept clear of the stairs
  const parts = (spec.partitions || []).filter((px) => !stairRect || px < stairRect[0] - 0.4 || px > stairRect[2] + 0.9);
  // openings per side
  const sides = { front: [], back: [], left: [], right: [] };
  const doorH = TUNE.door.h, doorW = TUNE.door.w;
  for (const dr of spec.doors || []) {
    const ow = dr.w || doorW;
    sides[dr.side].push({ c: dr.c, w: ow, y0: (dr.storey || 0) * sh, y1: (dr.storey || 0) * sh + (dr.h || doorH), door: true });
  }
  for (const bo of spec.big || []) sides[bo.side].push({ c: bo.c, w: bo.w, y0: bo.y0, y1: bo.y1, big: true });
  const avoidFor = (side, k) => {
    const a = [];
    for (const o of sides[side]) if (o.y0 < (k + 1) * sh && o.y1 > k * sh) a.push([o.c - o.w / 2 - 0.5, o.c + o.w / 2 + 0.5]);
    if (side === 'front' || side === 'back') for (const px of parts) a.push([px - 0.45, px + 0.45]);
    if (st && side === 'back' && k < ns) a.push([stairRect[0] - 0.2, stairRect[2] + 0.2]);
    if (st && side === 'left' && st.x0 < -hw + 1.5) a.push([stZ0 - 0.3, stZ0 + stW + 0.4]);
    return a;
  };
  const winGap = spec.winGap ?? 1.5;
  for (let k = 0; k < ns; k++) {
    const y0 = k * sh + sill, y1 = Math.min(k * sh + sill + winH, (k + 1) * sh - SLAB - 0.25);
    for (const [side, a0, a1] of [['front', -hw, hw], ['back', -hw, hw], ['left', -hd, hd], ['right', -hd, hd]]) {
      if (spec.noWindows && spec.noWindows[side]) continue;
      if (spec.noWindowsGround && k === 0 && spec.noWindowsGround[side]) continue;
      const add = windowSpots(a0 + WT, a1 - WT, winW, winGap, avoidFor(side, k)).map((c) => ({ c, w: winW, y0, y1, win: true }));
      sides[side].push(...add);
    }
  }
  const wallTop = top;
  const out = spec.out, inn = spec.inn;
  // outer skins (full height) and inner skins (per storey)
  wallRun(g, 'x', -hw, hw, hd - OUT, hd, 0, wallTop, sides.front, out, NZ);
  wallRun(g, 'x', -hw, hw, -hd, -hd + OUT, 0, wallTop, sides.back, out, PZ);
  wallRun(g, 'z', -hd + OUT, hd - OUT, hw - OUT, hw, 0, wallTop, sides.right, out, NX);
  wallRun(g, 'z', -hd + OUT, hd - OUT, -hw, -hw + OUT, 0, wallTop, sides.left, out, PX);
  const openTop = spec.roof && spec.roof.type === 'none';
  for (let k = 0; k < ns; k++) {
    const y0 = k * sh, y1 = (k + 1) * sh - (openTop && k === ns - 1 ? 0 : SLAB);
    wallRun(g, 'x', -hw + OUT, hw - OUT, hd - WT, hd - OUT, y0, y1, sides.front, inn, PZ | PY, false);
    wallRun(g, 'x', -hw + OUT, hw - OUT, -hd + OUT, -hd + WT, y0, y1, sides.back, inn, NZ | PY, false);
    wallRun(g, 'z', -hd + WT, hd - WT, hw - WT, hw - OUT, y0, y1, sides.right, inn, PX | PY, false);
    wallRun(g, 'z', -hd + WT, hd - WT, -hw + OUT, -hw + WT, y0, y1, sides.left, inn, NX | PY, false);
  }
  // frames
  const trim = spec.trim || MAT.trimWood;
  for (const o of sides.front) if (!o.big) frameOpening(g, 'x', o, hd, trim);
  for (const o of sides.back) if (!o.big) frameOpening(g, 'x', o, -hd, trim);
  for (const o of sides.right) if (!o.big) frameOpening(g, 'z', o, hw, trim);
  for (const o of sides.left) if (!o.big) frameOpening(g, 'z', o, -hw, trim);
  // shutters beside some windows
  if (spec.shutters) {
    const sm = spec.shutters;
    for (const o of sides.front) if (o.win) {
      g.box(o.c - o.w / 2 - 0.62, o.y0 - 0.02, hd, o.c - o.w / 2 - 0.04, o.y1 + 0.02, hd + 0.04, sm, { col: false });
      g.box(o.c + o.w / 2 + 0.04, o.y0 - 0.02, hd, o.c + o.w / 2 + 0.62, o.y1 + 0.02, hd + 0.04, sm, { col: false });
    }
  }
  // floors
  const floorM = spec.floor || MAT.floorWood;
  g.box(-hw + OUT, 0, -hd + OUT, hw - OUT, 0.005, hd - OUT, floorM, { skip: NY | PX | NX | PZ | NZ, col: false });
  for (let k = 1; k < ns; k++) {
    const holes = st ? [[stairRect[0], stairRect[1], stairRect[2], stairRect[3]]] : [];
    slabWithHoles(g, -hw + OUT, -hd + OUT, hw - OUT, hd - OUT, k * sh - SLAB, k * sh, holes, floorM, { mats: { ny: spec.ceiling || MAT.interior } });
  }
  // stairs between storeys (and to the roof)
  const flights = st ? (spec.roof?.access === 'stairs' ? ns : ns - 1) : 0;
  for (let k = 0; k < flights; k++) {
    stairs(ctx, st.x0, stZ0, stW, k * sh, spec.stairMat || floorM, inn);
    if (k + 1 < ns || spec.roof?.access === 'stairs') {
      railing(g, 'x', st.x0, st.x0 + RUN - 0.05, stZ0 + stW + 0.03, (k + 1) * sh, MAT.trimWood);
      railing(g, 'z', stZ0, stZ0 + stW, st.x0 - 0.13, (k + 1) * sh, MAT.trimWood);
    }
  }
  // partitions with doorways
  for (let k = 0; k < ns; k++) {
    for (const px of parts) {
      const dz = spec.partDoorZ ?? (hd - WT - 1.4);
      wallRun(g, 'z', -hd + WT, hd - WT, px - 0.06, px + 0.06, k * sh, (k + 1) * sh - SLAB, [{ c: dz, w: 1.0, y0: k * sh, y1: k * sh + 2.1 }], inn, PY);
    }
  }
  // roof
  const roof = spec.roof || { type: 'flat' };
  let ridge = top;
  if (roof.type === 'flat') {
    const holes = roof.access === 'stairs' && st ? [[stairRect[0], stairRect[1], stairRect[2], stairRect[3]]] : [];
    flatRoof(ctx, w, d, top, roof.parapet ?? 0.8, roof.mat || MAT.roofTar, out, holes);
    if (holes.length) {
      // hatch guard on the roof
      railing(g, 'x', st.x0, st.x0 + RUN - 0.05, stZ0 + stW + 0.03, top, MAT.metalGrey);
      railing(g, 'z', stZ0, stZ0 + stW, st.x0 - 0.13, top, MAT.metalGrey);
    }
  } else if (roof.type === 'gable' || roof.type === 'gable-z') {
    slabWithHoles(g, -hw + OUT, -hd + OUT, hw - OUT, hd - OUT, top - SLAB, top, [], spec.ceiling || MAT.interior, { mats: { ny: spec.ceiling || MAT.interior, py: MAT.planksDark } });
    ridge = gableRoof(ctx, w, d, top, roof.pitch || 0.6, roof.mat, { along: roof.type === 'gable-z' ? 'z' : 'x', gable: roof.gable || out, overhang: roof.overhang, soffit: roof.soffit });
  }
  if (spec.chimney && roof.type !== 'flat') {
    const cx = hw * 0.55, cz = -hd * 0.3;
    g.box(cx - 0.35, top - 0.5, cz - 0.35, cx + 0.35, ridge + 0.9, cz + 0.35, MAT.brickDark, { col: false });
    g.box(cx - 0.42, ridge + 0.85, cz - 0.42, cx + 0.42, ridge + 1.0, cz + 0.42, MAT.concrete, { col: false });
  }
  // rooms
  const xs = [-hw + WT, ...parts.slice().sort((a, b) => a - b), hw - WT];
  for (let k = 0; k < ns; k++) {
    for (let i = 0; i < xs.length - 1; i++) {
      const avoid = st ? [stairRect] : [];
      addRoom(ctx, xs[i] + (i ? 0.06 : 0), -hd + WT, xs[i + 1] - (i < xs.length - 2 ? 0.06 : 0), hd - WT, k * sh, avoid);
    }
  }
  // doors for nav, steps where the ground falls away
  for (const [side, list] of Object.entries(sides)) {
    for (const o of list) {
      if (!o.door || o.y0 > 0.1) continue;
      let lx, lz, nx, nz;
      if (side === 'front') { lx = o.c; lz = hd; nx = 0; nz = 1; } else if (side === 'back') { lx = o.c; lz = -hd; nx = 0; nz = -1; } else if (side === 'right') { lx = hw; lz = o.c; nx = 1; nz = 0; } else { lx = -hw; lz = o.c; nx = -1; nz = 0; }
      addDoor(ctx, lx, lz, nx, nz);
      doorSteps(ctx, lx, lz, nx, nz, o.w);
    }
  }
  return { top, ridge, sides, stairRect, parts };
}

/** Concrete steps outside a doorway when the terrain is below the floor. */
function doorSteps(ctx, lx, lz, nx, nz, w) {
  const { g } = ctx;
  const px = lx + nx * 0.6, pz = lz + nz * 0.6;
  const ground = heightAt(g.wx(px, pz), g.wz(px, pz)) - g.oy;
  const drop = -ground;
  if (drop < 0.22) return;
  const n = Math.min(8, Math.ceil(drop / 0.18));
  const r = drop / n;
  for (let i = 0; i < n; i++) {
    const out0 = 0.02 + i * 0.3, out1 = out0 + 0.3;
    const y1 = -i * r, y0 = Math.min(-drop - 0.3, y1 - 0.4);
    const a0 = -w / 2 - 0.25, a1 = w / 2 + 0.25;
    if (nz !== 0) g.box(lx + a0, y0, nz > 0 ? lz + out0 : lz - out1, lx + a1, y1, nz > 0 ? lz + out1 : lz - out0, MAT.concrete, { skip: NY });
    else g.box(nx > 0 ? lx + out0 : lx - out1, y0, lz + a0, nx > 0 ? lx + out1 : lx - out0, y1, lz + a1, MAT.concrete, { skip: NY });
  }
}

/** Simple furniture against walls (deterministic), giving rooms cover and silhouettes. */
function furnish(ctx, room, k, style) {
  const { g, rng } = ctx;
  const rx0 = room.x0 + 0.1, rx1 = room.x1 - 0.1, rz0 = room.z0 + 0.1, rz1 = room.z1 - 0.1;
  if (rx1 - rx0 < 2.2 || rz1 - rz0 < 2.2) return;
  const y = room.ly;
  const wood = style === 'industrial' ? MAT.metalGrey : MAT.planksDark;
  const pick = rng.next();
  const avoid = room.avoidLocal || [];
  const clash = (x0, z0, x1, z1) => avoid.some(([a0, b0, a1, b1]) => x1 > a0 - 0.3 && x0 < a1 + 0.3 && z1 > b0 - 0.3 && z0 < b1 + 0.3);
  if (pick < 0.45) {
    // table against the back wall
    const cx = rng.range(rx0 + 1, rx1 - 1), z0 = rz0 + 0.05, z1 = z0 + 0.8;
    if (clash(cx - 0.75, z0, cx + 0.75, z1)) return;
    g.box(cx - 0.75, y + 0.72, z0, cx + 0.75, y + 0.77, z1, wood, { col: false });
    for (const [lx, lz] of [[-0.68, 0.06], [0.68, 0.06], [-0.68, 0.74], [0.68, 0.74]]) g.box(cx + lx - 0.03, y, z0 + lz - 0.03, cx + lx + 0.03, y + 0.72, z0 + lz + 0.03, wood, { col: false });
    g.colBox(cx, y + 0.385, (z0 + z1) / 2, 0.75, 0.385, 0.4, SURFACE.WOOD);
  } else if (pick < 0.8) {
    // shelving unit
    const cx = rng.range(rx0 + 0.8, rx1 - 0.8), z0 = rz1 - 0.42, z1 = rz1;
    if (clash(cx - 0.6, z0, cx + 0.6, z1)) return;
    g.box(cx - 0.6, y, z0, cx - 0.56, y + 1.9, z1, wood, { col: false });
    g.box(cx + 0.56, y, z0, cx + 0.6, y + 1.9, z1, wood, { col: false });
    for (const sy of [0.1, 0.6, 1.1, 1.6, 1.86]) g.box(cx - 0.56, y + sy, z0, cx + 0.56, y + sy + 0.04, z1, wood, { col: false });
    g.colBox(cx, y + 0.95, (z0 + z1) / 2, 0.6, 0.95, 0.21, SURFACE.WOOD);
  } else {
    // cabinet / counter
    const x0 = rx0 + 0.05, x1 = Math.min(rx1, x0 + 1.8), z0 = rz0 + 0.05, z1 = z0 + 0.6;
    if (clash(x0, z0, x1, z1)) return;
    g.box(x0, y, z0, x1, y + 0.9, z1, style === 'industrial' ? MAT.metalGrey : MAT.trimWood);
    g.box(x0 - 0.02, y + 0.9, z0 - 0.02, x1 + 0.02, y + 0.94, z1 + 0.04, MAT.slab, { col: false });
  }
}

function furnishRooms(ctx, fromIndex, style) {
  for (let i = fromIndex; i < ctx.rooms.length; i++) {
    const r = ctx.rooms[i];
    const local = { x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1, ly: r.y - ctx.g.oy, avoidLocal: r.avoid };
    furnish(ctx, local, i, style);
  }
}

// ------------------------------------------------------------------------------------------ building kinds
const HOUSE_WALLS = [MAT.brick, MAT.plasterCream, MAT.plasterWhite, MAT.plasterOchre, MAT.plasterSage, MAT.plasterRose];
const HOUSE_ROOFS = [MAT.ironRed, MAT.ironDark, MAT.ironGrey, MAT.ironGreen, MAT.ironRust];

const KINDS = {
  house(ctx) {
    const { b, rng } = ctx;
    const out = HOUSE_WALLS[b.variant % HOUSE_WALLS.length];
    const r0 = ctx.rooms.length;
    const sx = -b.w / 2 + WT + 0.35;
    const px = sx + RUN + 0.9;
    const parts = b.w / 2 - WT - px >= 2.6 ? [px] : [];
    let fc = rng.range(-0.8, 0.8) + (b.w > 9 ? 0.6 : 0);
    if (parts.length && Math.abs(fc - px) < 1.2) fc = px - 1.6;
    block(ctx, {
      w: b.w, d: b.d, storeys: 2, out, inn: rng.chance(0.5) ? MAT.interior : MAT.interiorWarm, floor: MAT.floorWood,
      roof: { type: 'gable', mat: HOUSE_ROOFS[rng.int(0, HOUSE_ROOFS.length - 1)], pitch: rng.range(0.52, 0.68) },
      doors: [{ side: 'front', c: fc }, { side: 'back', c: b.w / 2 - 1.6 }],
      partitions: parts, stairs: { x0: sx },
      trim: out === MAT.brick ? MAT.trimWhite : MAT.trimWood, shutters: rng.chance(0.45) ? (rng.chance(0.5) ? MAT.planksDark : MAT.metalGreen) : null,
      chimney: rng.chance(0.7), lowest: b.lowest,
    });
    furnishRooms(ctx, r0, 'home');
  },
  farmhouse(ctx) { ctx.b.variant = 2; KINDS.house(ctx); },
  shop(ctx) {
    const { b, rng } = ctx;
    const out = [MAT.plasterGrey, MAT.brickDark, MAT.plasterOchre, MAT.concreteSand, MAT.plasterWhite][b.variant % 5];
    const r0 = ctx.rooms.length;
    const hw = b.w / 2;
    const res = block(ctx, {
      w: b.w, d: b.d, storeys: 1, storeyH: 3.6, out, inn: MAT.interior, floor: MAT.floorConcrete,
      roof: { type: 'flat', parapet: 0.9, mat: MAT.roofTar },
      doors: [{ side: 'front', c: -0.2 }, { side: 'back', c: hw - 1.4 }],
      big: [{ side: 'front', c: -hw / 2 - 0.4, w: 2.4, y0: 0.55, y1: 2.6 }, { side: 'front', c: hw / 2, w: 2.4, y0: 0.55, y1: 2.6 }],
      partitions: [hw - 3.2], noWindows: { front: true }, trim: MAT.trimWhite, lowest: b.lowest,
    });
    // fascia band and awning
    const g = ctx.g, hd = b.d / 2;
    g.box(-hw - 0.05, 2.85, hd, hw + 0.05, 3.45, hd + 0.08, rng.chance(0.5) ? MAT.metalGreen : MAT.metalRed, { col: false });
    const aw = rng.chance(0.6);
    if (aw) g.boxB(0, 2.7, hd + 0.75, [1, 0, 0], [0, Math.cos(0.32), Math.sin(0.32)], [0, -Math.sin(0.32), Math.cos(0.32)], hw - 0.4, 0.03, 0.8, MAT.ironWhite, { col: false });
    // big window frames
    for (const o of res.sides.front.filter((q) => q.big)) {
      g.box(o.c - o.w / 2, o.y0 - 0.08, hd - 0.02, o.c + o.w / 2, o.y0, hd + 0.08, MAT.slab, { col: false });
      g.box(o.c - 0.035, o.y0, hd - 0.14, o.c + 0.035, o.y1, hd - 0.08, MAT.trimWhite, { col: false });
    }
    furnishRooms(ctx, r0, 'shop');
  },
  church(ctx) {
    const { b, g } = ctx;
    const w = b.w, d = b.d, wallH = 6.2;
    const r0 = ctx.rooms.length;
    block(ctx, {
      w, d, storeys: 1, storeyH: wallH + SLAB, out: MAT.stone, inn: MAT.interior, floor: MAT.floorConcrete,
      roof: { type: 'none' }, doors: [{ side: 'front', c: 0, w: 1.6, h: 3.0 }, { side: 'left', c: -d / 2 + 3 }],
      winW: 1.0, winH: 3.2, sill: 1.8, winGap: 2.2, noWindows: { front: true, back: true }, trim: MAT.stone, lowest: b.lowest,
    });
    const top = wallH + SLAB;
    gableRoof(ctx, w, d, top, 0.82, MAT.ironDark, { along: 'z', gable: MAT.stone, overhang: 0.4, openAttic: true, inner: MAT.interior, underside: MAT.planksDark });
    // bell tower over the entrance
    const ts = 4.4, tz = d / 2 + ts / 2 - 0.2, th = 17;
    g.frame(g.ox, g.oy, g.oz, g.yaw);
    const ops = [{ c: 0, w: 1.6, y0: 0, y1: 3.0 }];
    const belfry = [{ c: 0, w: 1.6, y0: th - 4.2, y1: th - 1.6 }];
    wallRun(g, 'x', -ts / 2, ts / 2, tz + ts / 2 - 0.4, tz + ts / 2, 0, th, ops.concat(belfry), MAT.stone);
    wallRun(g, 'z', tz - ts / 2 + 0.4, tz + ts / 2 - 0.4, ts / 2 - 0.4, ts / 2, 0, th, belfry, MAT.stone);
    wallRun(g, 'z', tz - ts / 2 + 0.4, tz + ts / 2 - 0.4, -ts / 2, -ts / 2 + 0.4, 0, th, belfry, MAT.stone);
    wallRun(g, 'x', -ts / 2, ts / 2, tz - ts / 2, tz - ts / 2 + 0.4, top, th, belfry, MAT.stone);
    g.box(-ts / 2 + 0.4, th - 4.4, tz - ts / 2 + 0.4, ts / 2 - 0.4, th - 4.2, tz + ts / 2 - 0.4, MAT.planksDark, { col: false });
    // pyramid roof
    const pr = th + 4.2, e = ts / 2 + 0.25;
    const corners4 = [[-e, tz - e], [e, tz - e], [e, tz + e], [-e, tz + e]];
    for (let i = 0; i < 4; i++) {
      const [ax, az] = corners4[i], [bx, bz] = corners4[(i + 1) % 4];
      const mx = (ax + bx) / 2, mz = (az + bz) / 2 - tz;
      const n = [mx, 0.9, mz]; const l = Math.hypot(...n);
      g.poly([[bx, th, bz], [ax, th, az], [0, pr, tz]], [n[0] / l, n[1] / l, n[2] / l], MAT.ironDark, { col: true });
    }
    g.box(-0.05, pr - 0.2, tz - 0.05, 0.05, pr + 1.6, tz + 0.05, MAT.metalGrey, { col: false });
    g.box(-0.4, pr + 1.0, tz - 0.05, 0.4, pr + 1.1, tz + 0.05, MAT.metalGrey, { col: false });
    // pews
    for (let i = 0; i < 6; i++) {
      const z = -d / 2 + 4 + i * 1.5;
      for (const s of [-1, 1]) g.box(s > 0 ? 0.6 : -w / 2 + 0.8, 0, z, s > 0 ? w / 2 - 0.8 : -0.6, 0.45, z + 0.45, MAT.planksDark);
    }
    ctx.rooms.length = r0;
    addRoom(ctx, -w / 2 + WT, -d / 2 + WT, w / 2 - WT, d / 2 - WT, 0, []);
    addRoom(ctx, -ts / 2 + 0.4, tz - ts / 2 + 0.4, ts / 2 - 0.4, tz + ts / 2 - 0.4, 0, []);
    addDoor(ctx, 0, tz + ts / 2, 0, 1);
  },
  barn(ctx) {
    const { b, g } = ctx;
    const w = b.w, d = b.d, wallH = 5.6;
    setInteriorAO(g, w, d, wallH + 4);
    g.box(-w / 2 - 0.06, Math.min(-0.25, (b.lowest ?? 0) - 0.4), -d / 2 - 0.06, w / 2 + 0.06, 0, d / 2 + 0.06, MAT.concrete, { skip: PY | NY });
    const bigF = [{ c: 0, w: 4.2, y0: 0, y1: 4.4 }], bigB = [{ c: 0, w: 3.0, y0: 0, y1: 3.6 }];
    const side = [{ c: d / 4, w: 1.2, y0: 0, y1: 2.2 }, { c: -d / 4, w: 1.4, y0: 3.6, y1: 4.6 }];
    const t = 0.18;
    wallRun(g, 'x', -w / 2, w / 2, d / 2 - t, d / 2, 0, wallH, bigF, MAT.planksRed);
    wallRun(g, 'x', -w / 2, w / 2, -d / 2, -d / 2 + t, 0, wallH, bigB, MAT.planksRed);
    wallRun(g, 'z', -d / 2 + t, d / 2 - t, w / 2 - t, w / 2, 0, wallH, side, MAT.planksRed);
    wallRun(g, 'z', -d / 2 + t, d / 2 - t, -w / 2, -w / 2 + t, 0, wallH, side.slice(0, 1), MAT.planksRed);
    // door frames painted white
    for (const [o, z] of [[bigF[0], d / 2], [bigB[0], -d / 2]]) {
      g.box(o.c - o.w / 2 - 0.12, 0, z - 0.1, o.c - o.w / 2, o.y1 + 0.12, z + 0.1, MAT.trimWhite, { col: false });
      g.box(o.c + o.w / 2, 0, z - 0.1, o.c + o.w / 2 + 0.12, o.y1 + 0.12, z + 0.1, MAT.trimWhite, { col: false });
      g.box(o.c - o.w / 2 - 0.12, o.y1, z - 0.1, o.c + o.w / 2 + 0.12, o.y1 + 0.12, z + 0.1, MAT.trimWhite, { col: false });
    }
    g.box(-w / 2 + t, 0, -d / 2 + t, w / 2 - t, 0.005, d / 2 - t, MAT.floorConcrete, { skip: NY | PX | NX | PZ | NZ, col: false });
    // hayloft over the back half with a ladder ramp
    const ly = 3.1;
    g.box(-w / 2 + t, ly - 0.15, -d / 2 + t, w / 2 - t, ly, -0.6, MAT.floorWood, { mats: { ny: MAT.planksDark } });
    for (const px of [-w / 4, w / 4]) g.box(px - 0.12, 0, -0.85, px + 0.12, ly - 0.15, -0.61, MAT.planksDark);
    railing(g, 'x', -w / 2 + t, w / 2 - 2.6, -0.62, ly, MAT.planksDark);
    ladderRamp(g, w / 2 - 1.6, 2.6, 0, ly, 0, -1, MAT.planksDark);
    gableRoof(ctx, w, d, wallH, 0.62, MAT.ironRust, { along: 'z', gable: MAT.planksRed, openAttic: true, underside: MAT.planksDark, inner: MAT.planksDark });
    addRoom(ctx, -w / 2 + 0.3, -d / 2 + 0.3, w / 2 - 0.3, d / 2 - 0.3, 0, [[w / 2 - 2.2, -1.0, w / 2 - 1.0, 2.8]]);
    addRoom(ctx, -w / 2 + 0.3, -d / 2 + 0.3, w / 2 - 0.3, -0.8, ly, []);
    addDoor(ctx, 0, d / 2, 0, 1); addDoor(ctx, 0, -d / 2, 0, -1); addDoor(ctx, w / 2, d / 4, 1, 0);
    // hay bales
    for (const [x, z] of [[-w / 2 + 1.2, -d / 2 + 1.2], [-w / 2 + 2.6, -d / 2 + 1.2], [-w / 2 + 1.2, -d / 2 + 2.6]]) g.box(x - 0.6, ly, z - 0.45, x + 0.6, ly + 0.9, z + 0.45, M(L.leafy_grass, 1.5, 1.25, 0.6));
    g.box(w / 2 - 2.4, 0, -d / 2 + 0.6, w / 2 - 0.6, 0.9, -d / 2 + 1.5, M(L.leafy_grass, 1.5, 1.25, 0.6));
  },
  shed(ctx) {
    const { b, g, rng } = ctx;
    const w = b.w, d = b.d, hgt = 3.4;
    const wallM = [MAT.ironGrey, MAT.ironGreen, MAT.ironRust, MAT.ironBlue][(b.variant + rng.int(0, 3)) % 4];
    setInteriorAO(g, w, d, hgt + 1.2);
    g.box(-w / 2 - 0.05, Math.min(-0.2, (b.lowest ?? 0) - 0.3), -d / 2 - 0.05, w / 2 + 0.05, 0, d / 2 + 0.05, MAT.concrete, { skip: PY | NY });
    const t = 0.08;
    const front = [{ c: 0, w: 3.0, y0: 0, y1: 2.8 }];
    const sideW = [{ c: d / 4, w: 1.2, y0: 1.0, y1: 2.0 }];
    wallRun(g, 'x', -w / 2, w / 2, d / 2 - t, d / 2, 0, hgt + 0.5, front, wallM);
    wallRun(g, 'x', -w / 2, w / 2, -d / 2, -d / 2 + t, 0, hgt, [], wallM);
    wallRun(g, 'z', -d / 2 + t, d / 2 - t, w / 2 - t, w / 2, 0, hgt, sideW, wallM);
    wallRun(g, 'z', -d / 2 + t, d / 2 - t, -w / 2, -w / 2 + t, 0, hgt, [{ c: -d / 4, w: 1.2, y0: 0, y1: 2.2 }], wallM);
    // shed roof falling to the back, side wall gussets
    for (const s of [-1, 1]) g.poly(s > 0 ? [[w / 2, hgt, d / 2], [w / 2, hgt, -d / 2], [w / 2, hgt + 0.5, d / 2]] : [[-w / 2, hgt, -d / 2], [-w / 2, hgt, d / 2], [-w / 2, hgt + 0.5, d / 2]], [s, 0, 0], wallM, { col: true });
    const pitch = Math.atan2(0.5, d);
    const len = Math.hypot(d + 0.8, 0.58);
    g.boxB(0, hgt + 0.27 + 0.05, 0, [1, 0, 0], [0, Math.cos(pitch), Math.sin(pitch)], [0, -Math.sin(pitch), Math.cos(pitch)], w / 2 + 0.3, 0.05, len / 2, MAT.ironDark, { mats: { ny: wallM } });
    g.box(-w / 2 + t, 0, -d / 2 + t, w / 2 - t, 0.005, d / 2 - t, MAT.floorConcrete, { skip: NY | PX | NX | PZ | NZ, col: false });
    // workbench and drums
    g.box(-w / 2 + 0.2, 0, -d / 2 + 0.2, -w / 2 + 0.9, 0.9, -d / 2 + 2.6, MAT.planksDark);
    addRoom(ctx, -w / 2 + 0.3, -d / 2 + 0.3, w / 2 - 0.3, d / 2 - 0.3, 0, [[-w / 2, -d / 2, -w / 2 + 1.0, -d / 2 + 2.7]]);
    addDoor(ctx, 0, d / 2, 0, 1); addDoor(ctx, -w / 2, -d / 4, -1, 0);
  },
  silo(ctx) {
    const { g } = ctx;
    const r = 3.2, h = 12.5;
    g.aoFn = null;
    g.cyl(0, 0, -0.6, 0.4, r + 0.3, r + 0.3, 24, MAT.concrete, { top: true, col: true });
    g.cyl(0, 0, 0.4, h, r, r, 24, MAT.ironGrey, { col: true });
    g.cyl(0, 0, h, h + 2.6, r + 0.15, 0.5, 24, MAT.ironGrey, { col: true, top: true });
    for (let k = 1; k < 5; k++) g.cyl(0, 0, k * 2.6, k * 2.6 + 0.12, r + 0.04, r + 0.04, 24, MAT.metalGrey);
    // ladder up the side
    for (const s of [-0.25, 0.25]) g.box(r + 0.1, 0.4, s - 0.03, r + 0.16, h, s + 0.03, MAT.metalGrey, { col: false });
    for (let y = 0.8; y < h; y += 0.35) g.box(r + 0.1, y, -0.25, r + 0.15, y + 0.03, 0.25, MAT.metalGrey, { col: false });
  },
  barracks(ctx) {
    const { b } = ctx;
    const r0 = ctx.rooms.length;
    const hw = b.w / 2;
    block(ctx, {
      w: b.w, d: b.d, storeys: 1, storeyH: 3.2, out: MAT.concreteOlive, inn: MAT.interior, floor: MAT.floorConcrete,
      roof: { type: 'flat', parapet: 0.7, mat: MAT.roofTar },
      doors: [{ side: 'front', c: 0 }, { side: 'left', c: 0 }, { side: 'right', c: 0 }],
      partitions: [-hw / 3, hw / 3], partDoorZ: 0, trim: MAT.metalGrey, lowest: b.lowest, winGap: 1.7,
    });
    ladderRamp(ctx.g, -hw + 2.2, -b.d / 2 - 0.45, 0, 3.3 + 0.7, 1, 0, MAT.metalGrey);
    furnishRooms(ctx, r0, 'industrial');
    // bunk beds
    const g = ctx.g;
    for (let i = 0; i < 5; i++) {
      const x = -hw + 1.2 + i * 2.2;
      if (Math.abs(x + hw / 3) < 0.9 || Math.abs(x - hw / 3) < 0.9) continue;
      g.box(x - 0.45, 0.35, -b.d / 2 + WT + 0.05, x + 0.45, 0.5, -b.d / 2 + WT + 2.0, MAT.metalGreen);
      g.box(x - 0.45, 1.45, -b.d / 2 + WT + 0.05, x + 0.45, 1.6, -b.d / 2 + WT + 2.0, MAT.metalGreen, { col: false });
    }
  },
  hangar(ctx) {
    const { b, g } = ctx;
    const w = b.w, d = b.d, hgt = 8.0;
    setInteriorAO(g, w, d + 4, hgt + 2, (x, y, z, nx, ny, nz) => (z > d / 2 - 6 && y < hgt ? 0.7 : null));
    g.box(-w / 2 - 0.05, Math.min(-0.2, (b.lowest ?? 0) - 0.3), -d / 2 - 0.05, w / 2 + 0.05, 0, d / 2 + 0.05, MAT.concrete, { skip: PY | NY });
    const t = 0.12;
    const wallM = MAT.ironGreen;
    wallRun(g, 'x', -w / 2, w / 2, -d / 2, -d / 2 + t, 0, hgt, [{ c: w / 2 - 3, w: 1.2, y0: 0, y1: 2.2 }], wallM);
    for (const s of [-1, 1]) {
      const ops = [{ c: d / 4, w: 1.2, y0: 0, y1: 2.2 }, { c: -d / 4, w: 1.2, y0: 0, y1: 2.2 }, { c: 0, w: 6, y0: 5.4, y1: 6.6 }];
      wallRun(g, 'z', -d / 2 + t, d / 2, s > 0 ? w / 2 - t : -w / 2, s > 0 ? w / 2 : -w / 2 + t, 0, hgt, ops, wallM);
    }
    // front: open, with a header beam and columns
    g.box(-w / 2, hgt - 1.1, d / 2 - 0.4, w / 2, hgt, d / 2, wallM);
    for (const x of [-w / 2 + 0.25, w / 2 - 0.25]) g.box(x - 0.25, 0, d / 2 - 0.5, x + 0.25, hgt - 1.1, d / 2, MAT.metalGrey);
    gableRoof(ctx, w, d, hgt, 0.2, MAT.ironGrey, { along: 'z', gable: wallM, overhang: 0.6, overhangEnd: 0.8, openAttic: true, underside: MAT.ironDark, inner: wallM });
    g.box(-w / 2 + t, 0, -d / 2 + t, w / 2 - t, 0.005, d / 2, MAT.floorConcrete, { skip: NY | PX | NX | PZ | NZ, col: false });
    // interior steel portal frames
    for (let z = -d / 2 + 6; z < d / 2 - 2; z += 6) {
      for (const s of [-1, 1]) g.box(s * (w / 2 - 0.45) - 0.18, 0, z - 0.18, s * (w / 2 - 0.45) + 0.18, hgt, z + 0.18, MAT.metalGrey);
      g.box(-w / 2 + 0.3, hgt - 0.5, z - 0.12, w / 2 - 0.3, hgt - 0.2, z + 0.12, MAT.metalGrey, { col: false });
    }
    // mezzanine office in the back corner with stairs
    const mx0 = -w / 2 + t, mx1 = -w / 2 + 8, mz0 = -d / 2 + t, mz1 = -d / 2 + 7, my = 3.4;
    wallRun(g, 'x', mx0, mx1, mz1 - 0.2, mz1, 0, my, [{ c: mx0 + 2, w: 1.2, y0: 0, y1: 2.2 }, { c: mx0 + 5.4, w: 2.0, y0: 1.0, y1: 2.4 }], MAT.concreteSand);
    wallRun(g, 'z', mz0, mz1 - 0.2, mx1 - 0.2, mx1, 0, my, [{ c: mz0 + 3.5, w: 1.6, y0: 1.0, y1: 2.4 }], MAT.concreteSand);
    g.box(mx0, my - 0.2, mz0, mx1, my, mz1, MAT.floorConcrete, { mats: { ny: MAT.interior } });
    railing(g, 'x', mx0, mx1, mz1 - 0.05, my, MAT.metalYellow);
    railing(g, 'z', mz0, mz1 - 1.3, mx1 - 0.05, my, MAT.metalYellow);
    ladderRamp(g, mx1 + 0.45, mz1 - 0.6, 0, my, 0, -1, MAT.metalYellow);
    // exterior ladder to the roof
    ladderRamp(g, w / 2 + 0.45, -d / 2 + 2, 0, hgt + 0.1, 0, 1, MAT.metalGrey);
    addRoom(ctx, -w / 2 + 1, -d / 2 + 8, w / 2 - 1, d / 2 - 1, 0, []);
    addRoom(ctx, mx0 + 0.3, mz0 + 0.3, mx1 - 0.5, mz1 - 0.5, 0, []);
    addRoom(ctx, mx0 + 0.3, mz0 + 0.3, mx1 - 0.5, mz1 - 0.5, my, []);
    addDoor(ctx, 0, d / 2, 0, 1); addDoor(ctx, w / 2, d / 4, 1, 0); addDoor(ctx, -w / 2, -d / 4, -1, 0);
  },
  command(ctx) {
    const { b, g } = ctx;
    const r0 = ctx.rooms.length;
    const sx = -b.w / 2 + WT + 0.35;
    block(ctx, {
      w: b.w, d: b.d, storeys: 2, out: MAT.concreteSand, inn: MAT.interior, floor: MAT.floorConcrete,
      roof: { type: 'flat', parapet: 1.0, mat: MAT.roofTar, access: 'stairs' }, stairs: { x0: sx },
      doors: [{ side: 'front', c: 1.2 }, { side: 'right', c: 0 }], partitions: [sx + RUN + 1.0], trim: MAT.metalGrey, lowest: b.lowest,
    });
    // rooftop antenna and dish
    const top = 2 * H;
    g.box(b.w / 2 - 1.6, top, b.d / 2 - 1.6, b.w / 2 - 1.5, top + 7, b.d / 2 - 1.5, MAT.metalGrey, { col: false });
    g.cyl(b.w / 2 - 3.2, b.d / 2 - 1.6, top, top + 0.9, 0.12, 0.12, 8, MAT.metalGrey);
    g.cyl(b.w / 2 - 3.2, b.d / 2 - 1.6, top + 0.9, top + 1.3, 0.75, 0.1, 16, MAT.metalWhite);
    furnishRooms(ctx, r0, 'industrial');
  },
  watchtower(ctx) {
    const { g } = ctx;
    g.aoFn = null;
    const s = 1.5, py = 4.6, roofY = py + 2.4;
    for (const [x, z] of [[-s, -s], [s, -s], [s, s], [-s, s]]) {
      g.box(x - 0.13, -0.6, z - 0.13, x + 0.13, roofY, z + 0.13, MAT.planksDark);
    }
    // cross bracing
    for (const [ax, az, bx, bz] of [[-s, -s, s, -s], [s, -s, s, s], [s, s, -s, s], [-s, s, -s, -s]]) {
      const mx = (ax + bx) / 2, mz = (az + bz) / 2, len = Math.hypot(bx - ax, bz - az, py);
      const dir = [(bx - ax) / len, py / len, (bz - az) / len];
      const side = [(bz - az) / Math.hypot(bx - ax, bz - az), 0, -(bx - ax) / Math.hypot(bx - ax, bz - az)];
      const up = [dir[1] * side[2] - dir[2] * side[1], dir[2] * side[0] - dir[0] * side[2], dir[0] * side[1] - dir[1] * side[0]];
      g.boxB(mx, py / 2, mz, dir, up, side, len / 2, 0.05, 0.05, MAT.planksDark, { col: false });
    }
    g.box(-s - 0.3, py - 0.2, -s - 0.3, s + 0.3, py, s + 0.3, MAT.planks, { mats: { ny: MAT.planksDark } });
    // half walls with a gap for the ladder
    const hwH = 1.1, t = 0.08;
    g.box(-s - 0.3, py, s + 0.3 - t, s + 0.3, py + hwH, s + 0.3, MAT.planks);
    g.box(-s - 0.3, py, -s - 0.3, s + 0.3, py + hwH, -s - 0.3 + t, MAT.planks);
    g.box(s + 0.3 - t, py, -s - 0.3 + t, s + 0.3, py + hwH, s + 0.3 - t, MAT.planks);
    g.box(-s - 0.3, py, -s - 0.3 + t, -s - 0.3 + t, py + hwH, -0.1, MAT.planks);
    g.box(-s - 0.6, roofY, -s - 0.6, s + 0.6, roofY + 0.08, s + 0.6, MAT.ironRust);
    ladderRamp(g, -s - 0.3 - py * 1.02, 0.45, 0, py, 1, 0, MAT.planksDark);
    addRoom(ctx, -s - 0.15, -s - 0.15, s + 0.15, s + 0.15, py, []);
  },
  site_office(ctx) {
    const { b, g } = ctx;
    const r0 = ctx.rooms.length;
    g.frame(g.ox, g.oy + 0.35, g.oz, g.yaw);
    block(ctx, {
      w: b.w, d: b.d, storeys: 1, storeyH: 2.8, out: MAT.ironWhite, inn: MAT.interiorWarm, floor: MAT.floorWood,
      roof: { type: 'flat', parapet: 0.15, mat: MAT.ironGrey }, doors: [{ side: 'front', c: -b.w / 4 }], plinth: false,
      trim: MAT.metalGrey, lowest: (b.lowest ?? 0) - 0.35,
    });
    for (const x of [-b.w / 2 + 0.5, 0, b.w / 2 - 0.5]) for (const z of [-b.d / 2 + 0.4, b.d / 2 - 0.4]) g.box(x - 0.25, -0.35 + Math.min(0, (b.lowest ?? 0) - 0.3), z - 0.25, x + 0.25, 0, z + 0.25, MAT.concrete);
    g.colBox(0, -0.175, 0, b.w / 2, 0.175, b.d / 2, SURFACE.CONCRETE);
    furnishRooms(ctx, r0, 'industrial');
  },
  equipment_shed(ctx) {
    const { b } = ctx;
    const r0 = ctx.rooms.length;
    block(ctx, {
      w: b.w, d: b.d, storeys: 1, storeyH: 3.0, out: MAT.concrete, inn: MAT.interior, floor: MAT.floorConcrete,
      roof: { type: 'flat', parapet: 0.3, mat: MAT.roofTar }, doors: [{ side: 'front', c: 0.6 }], noWindows: { back: true, left: true },
      trim: MAT.metalGrey, lowest: b.lowest,
    });
    const g = ctx.g;
    for (let i = 0; i < 3; i++) g.box(-b.w / 2 + 0.4 + i * 1.0, 0, -b.d / 2 + 0.35, -b.w / 2 + 1.2 + i * 1.0, 2.0, -b.d / 2 + 1.0, MAT.metalGrey);
    furnishRooms(ctx, r0, 'industrial');
  },
  bunker(ctx) {
    const { b, g } = ctx;
    const w = b.w, d = b.d, hgt = 2.7, t = 0.6;
    setInteriorAO(g, w, d, hgt, null);
    g.box(-w / 2 - 0.1, Math.min(-0.3, (b.lowest ?? 0) - 0.5), -d / 2 - 0.1, w / 2 + 0.1, 0, d / 2 + 0.1, MAT.concrete, { skip: PY | NY });
    const slit = (c) => ({ c, w: 1.5, y0: 1.35, y1: 1.8 });
    wallRun(g, 'x', -w / 2, w / 2, d / 2 - t, d / 2, 0, hgt, [slit(-2.4), slit(0), slit(2.4)], MAT.concrete);
    wallRun(g, 'x', -w / 2, w / 2, -d / 2, -d / 2 + t, 0, hgt, [{ c: w / 2 - 1.6, w: 1.2, y0: 0, y1: 2.2 }], MAT.concrete);
    wallRun(g, 'z', -d / 2 + t, d / 2 - t, w / 2 - t, w / 2, 0, hgt, [slit(0)], MAT.concrete);
    wallRun(g, 'z', -d / 2 + t, d / 2 - t, -w / 2, -w / 2 + t, 0, hgt, [slit(0)], MAT.concrete);
    g.box(-w / 2 - 0.3, hgt, -d / 2 - 0.3, w / 2 + 0.3, hgt + 0.6, d / 2 + 0.3, MAT.concrete, { mats: { ny: MAT.interior, py: MAT.turf } });
    // earth berms banked against the sides
    for (const s of [-1, 1]) {
      const pitch = 0.75;
      g.boxB(s * (w / 2 + 1.1), hgt * 0.42, 0, [0, 0, 1], [s * Math.sin(pitch), Math.cos(pitch), 0], null, d / 2 + 0.3, 0.6, 1.8, MAT.turf, { col: true, mats: { ny: MAT.rock } });
    }
    g.box(-w / 2 + t, 0, -d / 2 + t, w / 2 - t, 0.005, d / 2 - t, MAT.floorConcrete, { skip: NY | PX | NX | PZ | NZ, col: false });
    g.box(-w / 2 + t + 0.1, 0, d / 2 - t - 0.6, -w / 2 + t + 2.4, 0.9, d / 2 - t - 0.05, MAT.metalGreen);
    addRoom(ctx, -w / 2 + t + 0.2, -d / 2 + t + 0.2, w / 2 - t - 0.2, d / 2 - t - 0.2, 0, []);
    addDoor(ctx, w / 2 - 1.6, -d / 2, 0, -1);
    doorSteps(ctx, w / 2 - 1.6, -d / 2, 0, -1, 1.2);
  },
  warehouse(ctx) {
    const { b, g } = ctx;
    const w = b.w, d = b.d, hgt = 7.5;
    const wallM = [MAT.ironBlue, MAT.ironGrey, MAT.ironSand][b.variant % 3];
    setInteriorAO(g, w, d, hgt + 2.5);
    g.box(-w / 2 - 0.05, Math.min(-0.2, (b.lowest ?? 0) - 0.3), -d / 2 - 0.05, w / 2 + 0.05, 0, d / 2 + 0.05, MAT.concrete, { skip: PY | NY });
    const t = 0.12;
    const front = [{ c: -w / 4, w: 5, y0: 0, y1: 5 }, { c: w / 4, w: 5, y0: 0, y1: 5 }, { c: 0, w: 1.2, y0: 0, y1: 2.2 }];
    const strip = (len) => windowSpots(-len / 2 + 1, len / 2 - 1, 2.4, 1.2, []).map((c) => ({ c, w: 2.4, y0: 5.6, y1: 6.6 }));
    wallRun(g, 'x', -w / 2, w / 2, d / 2 - t, d / 2, 0, hgt, front, wallM);
    wallRun(g, 'x', -w / 2, w / 2, -d / 2, -d / 2 + t, 0, hgt, [{ c: w / 2 - 3, w: 1.2, y0: 0, y1: 2.2 }, ...strip(w)], wallM);
    wallRun(g, 'z', -d / 2 + t, d / 2 - t, w / 2 - t, w / 2, 0, hgt, [{ c: 2, w: 1.2, y0: 0, y1: 2.2 }, ...strip(d)], wallM);
    wallRun(g, 'z', -d / 2 + t, d / 2 - t, -w / 2, -w / 2 + t, 0, hgt, [{ c: -2, w: 1.2, y0: 0, y1: 2.2 }, ...strip(d)], wallM);
    // roller door frames and concrete kick-wall
    for (const o of front.slice(0, 2)) {
      g.box(o.c - o.w / 2, o.y1, d / 2 - 0.02, o.c + o.w / 2, o.y1 + 0.7, d / 2 + 0.35, MAT.metalGrey, { col: false });
    }
    g.box(-w / 2 - 0.02, 0, d / 2 - 0.1, -w / 4 - 2.5, 1.0, d / 2 + 0.03, MAT.concrete, { col: false });
    gableRoof(ctx, w, d, hgt, 0.21, MAT.ironGrey, { along: 'x', gable: wallM, overhang: 0.5, openAttic: true, underside: MAT.ironDark, inner: wallM });
    g.box(-w / 2 + t, 0, -d / 2 + t, w / 2 - t, 0.005, d / 2 - t, MAT.floorConcrete, { skip: NY | PX | NX | PZ | NZ, col: false });
    for (let x = -w / 2 + 6; x < w / 2 - 3; x += 6) g.box(x - 0.15, 0, -0.15, x + 0.15, hgt + 1.5, 0.15, MAT.metalGrey);
    // pallet racks
    for (let x = -w / 2 + 3; x < w / 2 - 6; x += 7.5) {
      if (b.mezzanine && x < -w / 2 + 14) continue;
      g.box(x, 0, -d / 2 + 1, x + 4.6, 0.12, -d / 2 + 2.1, MAT.metalOrange);
      g.box(x, 1.6, -d / 2 + 1, x + 4.6, 1.72, -d / 2 + 2.1, MAT.metalOrange, { col: false });
      g.box(x, 3.2, -d / 2 + 1, x + 4.6, 3.32, -d / 2 + 2.1, MAT.metalOrange, { col: false });
      for (const px of [x, x + 4.5]) g.box(px, 0, -d / 2 + 1, px + 0.1, 3.4, -d / 2 + 2.1, MAT.metalBlue);
      g.colBox(x + 2.3, 1.7, -d / 2 + 1.55, 2.3, 1.7, 0.55, SURFACE.METAL);
    }
    addRoom(ctx, -w / 2 + 1, -d / 2 + 2.6, w / 2 - 1, d / 2 - 1, 0, []);
    if (b.mezzanine) {
      const my = 4.0, mz1 = -d / 2 + 7;
      g.box(-w / 2 + t, my - 0.2, -d / 2 + t, -w / 2 + 14, my, mz1, MAT.floorConcrete, { mats: { ny: MAT.metalGrey } });
      for (const x of [-w / 2 + 5, -w / 2 + 10, -w / 2 + 13.8]) g.box(x - 0.12, 0, mz1 - 0.24, x + 0.12, my - 0.2, mz1, MAT.metalGrey);
      railing(g, 'x', -w / 2 + 2.4, -w / 2 + 14, mz1 - 0.05, my, MAT.metalYellow);
      railing(g, 'z', -d / 2 + t, mz1, -w / 2 + 14 - 0.05, my, MAT.metalYellow);
      ctx.g.frame(g.ox, g.oy, g.oz, g.yaw);
      stairs(ctx, -w / 2 + t + 0.1 + RUN, mz1, 1.2, 0, MAT.metalGrey, MAT.metalGrey, -1, my);
      addRoom(ctx, -w / 2 + 0.6, -d / 2 + 0.6, -w / 2 + 13.4, mz1 - 0.4, my, []);
    }
    addDoor(ctx, -w / 4, d / 2, 0, 1); addDoor(ctx, w / 4, d / 2, 0, 1); addDoor(ctx, w / 2, 2, 1, 0); addDoor(ctx, -w / 2, -2, -1, 0);
  },
  office(ctx) {
    const { b, g } = ctx;
    const r0 = ctx.rooms.length;
    const sx = -b.w / 2 + WT + 0.35;
    block(ctx, {
      w: b.w, d: b.d, storeys: 2, out: MAT.brick, inn: MAT.interior, floor: MAT.floorConcrete,
      roof: { type: 'flat', parapet: 0.9, mat: MAT.roofTar, access: 'stairs' }, stairs: { x0: sx },
      doors: [{ side: 'front', c: 1.5 }, { side: 'left', c: 1.6 }], partitions: [sx + RUN + 1.0], trim: MAT.trimWhite, winW: 1.6, winGap: 1.2, lowest: b.lowest,
    });
    // string courses between storeys
    g.box(-b.w / 2 - 0.05, H - 0.15, -b.d / 2 - 0.05, b.w / 2 + 0.05, H + 0.05, b.d / 2 + 0.05, MAT.concrete, { col: false, skip: NY | PY });
    furnishRooms(ctx, r0, 'industrial');
  },
  cabin(ctx) {
    const { b, g, rng } = ctx;
    const r0 = ctx.rooms.length;
    block(ctx, {
      w: b.w, d: b.d, storeys: 1, storeyH: 2.8, out: MAT.planks, inn: MAT.planksDark, floor: MAT.floorWood,
      roof: { type: 'gable', mat: rng.chance(0.5) ? MAT.ironGreen : MAT.ironDark, pitch: 0.7 }, doors: [{ side: 'front', c: 0 }],
      trim: MAT.trimWood, plinthMat: MAT.concrete, chimney: true, lowest: b.lowest,
    });
    // porch with posts and a lean-to roof
    const hd = b.d / 2;
    g.box(-b.w / 2, -0.15, hd, b.w / 2, 0.02, hd + 1.8, MAT.planks, { skip: NY });
    for (const x of [-b.w / 2 + 0.2, b.w / 2 - 0.2]) g.box(x - 0.08, 0, hd + 1.55, x + 0.08, 2.5, hd + 1.71, MAT.planksDark);
    g.boxB(0, 2.62, hd + 0.95, [1, 0, 0], [0, Math.cos(0.25), Math.sin(0.25)], [0, -Math.sin(0.25), Math.cos(0.25)], b.w / 2 + 0.2, 0.04, 1.05, MAT.ironDark);
    furnishRooms(ctx, r0, 'home');
  },
  lighthouse(ctx) {
    const { g } = ctx;
    g.aoFn = null;
    const segs = 20, h = 17, r0 = 3.4, r1 = 2.5, th = 0.32;
    const bands = 8, bh = h / bands;
    const doorA = Math.PI / 2;    // door faces local +z
    for (let k = 0; k < bands; k++) {
      const y0 = k * bh, y1 = (k + 1) * bh;
      const rr = r0 + (r1 - r0) * ((k + 0.5) / bands);
      const red = k === 5 || k === 6;
      for (let i = 0; i < segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        const da = Math.abs(Math.atan2(Math.sin(a - doorA), Math.cos(a - doorA)));
        if (k === 0 && da < 0.17) continue;                       // doorway
        if ((k === 3 || k === 5) && i % 5 === 2) continue;          // small windows
        if (k === bands - 1 && da < 0.17) continue;                 // gallery door
        const tw = (2 * Math.PI * rr) / segs + 0.03;
        const cx = Math.cos(a) * rr, cz = Math.sin(a) * rr;
        const ax = [Math.sin(a), 0, -Math.cos(a)];
        g.boxB(cx, (y0 + y1) / 2, cz, ax, [0, 1, 0], null, tw / 2, bh / 2, th / 2, red ? MAT.metalRed : MAT.plasterWhite, { mats: { nz: MAT.interior } });
      }
    }
    // spiral stair around a central column
    g.cyl(0, 0, 0, h, 0.35, 0.35, 10, MAT.concrete, { col: true });
    const stepsPerRev = 16, rise = 0.19, nSteps = Math.ceil((h - 0.2) / rise);
    for (let i = 0; i < nSteps; i++) {
      const a = doorA + Math.PI * 0.35 + (i / stepsPerRev) * Math.PI * 2;
      const y = (i + 1) * rise;
      const rIn = 0.35, rOut = r0 + (r1 - r0) * (y / h) - th / 2 - 0.05;
      const len = rOut - rIn, mid = (rIn + rOut) / 2;
      const ax = [Math.cos(a), 0, Math.sin(a)], az = [-Math.sin(a), 0, Math.cos(a)];
      g.boxB(Math.cos(a) * mid, y - 0.09, Math.sin(a) * mid, ax, [0, 1, 0], az, len / 2, 0.09, 0.36, MAT.concrete);
    }
    // top floor with the stair hatch, gallery deck and railing, lantern
    const topY = h;
    g.cyl(0, 0, topY - 0.25, topY, r1 + 1.1, r1 + 1.1, 24, MAT.concrete, { top: true, topMat: MAT.slab, col: true });
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2, rr = r1 + 1.0;
      g.box(Math.cos(a) * rr - 0.03, topY, Math.sin(a) * rr - 0.03, Math.cos(a) * rr + 0.03, topY + 1.05, Math.sin(a) * rr + 0.03, MAT.metalGrey, { col: false });
    }
    g.cyl(0, 0, topY + 1.0, topY + 1.06, r1 + 1.0, r1 + 1.0, 24, MAT.metalGrey);
    ctx.g.cyl(0, 0, topY, topY + 1.1, r1 + 1.05, r1 + 1.05, 24, MAT.metalGrey, { col: true, inside: false });
    g.cyl(0, 0, topY, topY + 0.6, r1 - 0.2, r1 - 0.2, 16, MAT.metalRed);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g.box(Math.cos(a) * 1.9 - 0.05, topY + 0.6, Math.sin(a) * 1.9 - 0.05, Math.cos(a) * 1.9 + 0.05, topY + 3.0, Math.sin(a) * 1.9 + 0.05, MAT.metalRed, { col: false });
    }
    g.cyl(0, 0, topY + 3.0, topY + 4.2, 2.3, 0.3, 16, MAT.metalRed, { top: true });
    ctx.lamp = { x: g.wx(0, 0), y: g.oy + topY + 1.8, z: g.wz(0, 0) };
    addRoom(ctx, -1.6, -1.6, 1.6, 1.6, 0, [[-0.8, -0.8, 0.8, 0.8]]);
    addDoor(ctx, 0, r0, 0, 1);
  },
};

// ------------------------------------------------------------------------------------------ site structures
function containerBox(g, x, y, z, yaw, colorMat, open, rng) {
  const L0 = 6.06, W0 = 2.44, H0 = 2.59;
  const save = { ox: g.ox, oy: g.oy, oz: g.oz, yaw: g.yaw };
  g.frame(g.wx(x, z), g.oy + y, g.wz(x, z), save.yaw + yaw);
  g.aoFn = open ? (cx, cy, cz, nx, ny, nz) => (Math.abs(cx) < L0 / 2 - 0.1 && Math.abs(cz) < W0 / 2 - 0.1 && cy < H0 - 0.05 && cy > 0.05 ? 0.4 : 1) : null;
  const t = 0.06;
  if (!open) {
    g.box(-L0 / 2, 0, -W0 / 2, L0 / 2, H0, W0 / 2, colorMat, { mats: { px: MAT.metalGreen, nx: colorMat }, skip: NY });
  } else {
    g.box(-L0 / 2, 0, -W0 / 2, L0 / 2, 0.12, W0 / 2, MAT.floorWood, { mats: { px: colorMat, nx: colorMat, pz: colorMat, nz: colorMat }, skip: NY });
    g.box(-L0 / 2, H0 - t, -W0 / 2, L0 / 2, H0, W0 / 2, colorMat);
    g.box(-L0 / 2, 0.12, W0 / 2 - t, L0 / 2, H0 - t, W0 / 2, colorMat);
    g.box(-L0 / 2, 0.12, -W0 / 2, L0 / 2, H0 - t, -W0 / 2 + t, colorMat);
    g.box(-L0 / 2, 0.12, -W0 / 2 + t, -L0 / 2 + t, H0 - t, W0 / 2 - t, colorMat);
    // doors swung open
    for (const s of [-1, 1]) {
      const hx = L0 / 2, hz = s * W0 / 2;
      const ang = s * (1.9 + rng.range(-0.15, 0.25));
      const dx = Math.cos(ang), dz = Math.sin(ang);
      g.boxB(hx + dx * W0 / 4, H0 / 2, hz - s * 0.0 + dz * W0 / 4 * 1, [dx, 0, dz], [0, 1, 0], [-dz, 0, dx], W0 / 4, H0 / 2 - 0.05, 0.03, MAT.metalGreen, { col: true });
    }
  }
  // corner castings and door bars
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.box(sx * L0 / 2 - (sx > 0 ? 0.16 : 0), 0, sz * W0 / 2 - (sz > 0 ? 0.16 : 0), sx * L0 / 2 + (sx > 0 ? 0 : 0.16), H0, sz * W0 / 2 + (sz > 0 ? 0 : 0.16), MAT.metalGrey, { col: false });
  g.frame(save.ox, save.oy, save.oz, save.yaw);
  return { L0, W0, H0 };
}

const CONTAINER_COLORS = [MAT.ironRed, MAT.ironBlue, MAT.ironGreen, MAT.ironRust, MAT.ironSand, MAT.ironGrey, MAT.ironWhite];

function containers(ctx, sp) {
  const { g } = ctx;
  const rng = new Rng(sp.seed * 977 + 13);
  g.frame(sp.x, sp.y, sp.z, sp.yaw);
  const col = () => CONTAINER_COLORS[rng.int(0, CONTAINER_COLORS.length - 1)];
  const put = (x, y, z, yaw, open = false) => containerBox(g, x, y, z, yaw, col(), open, rng);
  if (sp.layout === 'single') {
    put(0, 0, 0, 0, true);
    ctx.rooms.push({ x0: -2.8, z0: -1.0, x1: 2.6, z1: 1.0, y: sp.y + 0.12, frame: { x: g.ox, z: g.oz, c: g.c, s: g.s }, avoid: [], site: sp.site, indoor: true });
  } else if (sp.layout === 'row') {
    put(0, 0, -1.3, 0); put(0, 0, 1.3, 0, true); put(0, 2.6, -1.3, 0);
    ctx.rooms.push({ x0: -2.8, z0: 0.3, x1: 2.6, z1: 2.3, y: sp.y + 0.12, frame: { x: g.ox, z: g.oz, c: g.c, s: g.s }, avoid: [], site: sp.site, indoor: true });
  } else {
    put(0, 0, 0, 0); put(0, 2.6, 0, 0.04); put(-1.8, 0, 3.4, Math.PI / 2, true);
    ctx.rooms.push({ x0: -3.0, z0: 1.0, x1: -0.6, z1: 5.8, y: sp.y + 0.12, frame: { x: g.ox, z: g.oz, c: g.c, s: g.s }, avoid: [], site: sp.site, indoor: true });
  }
  ctx.covers.push([sp.x, sp.y, sp.z]);
}

function twall(ctx, wall) {
  const { g } = ctx;
  g.aoFn = null;
  const segW = 1.52, hgt = wall.h;
  for (let i = 0; i < wall.pts.length - 1; i++) {
    const [ax, az] = wall.pts[i], [bx, bz] = wall.pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const dx = (bx - ax) / len, dz = (bz - az) / len;
    const yaw = Math.atan2(dx, dz) - Math.PI / 2;
    const n = Math.floor(len / segW);
    let colStart = 0;
    const flushCol = (endD) => {
      if (endD - colStart < 0.5) return;
      const mid = (colStart + endD) / 2;
      const mx = ax + dx * mid, mz = az + dz * mid;
      const y = heightAt(mx, mz);
      g.frame(mx, y, mz, yaw);
      g.colBox(0, hgt / 2 - 0.3, 0, (endD - colStart) / 2, hgt / 2 + 0.3, 0.45, SURFACE.CONCRETE);
    };
    for (let k = 0; k < n; k++) {
      const dmid = (k + 0.5) * (len / n);
      const x = ax + dx * dmid, z = az + dz * dmid;
      const inGate = wall.gates.some((gt) => Math.hypot(gt.x - x, gt.z - z) < gt.w / 2);
      if (inGate) { flushCol(k * (len / n)); colStart = (k + 1) * (len / n); continue; }
      const y = heightAt(x, z);
      const jitter = ((k * 7919 + i * 104729) % 100) / 100 - 0.5;
      g.frame(x, y - 0.25, z, yaw + jitter * 0.03);
      const sw = len / n / 2 - 0.02;
      g.box(-sw, 0, -0.42, sw, 0.55, 0.42, MAT.concrete, { col: false, skip: NY });
      g.box(-sw, 0.55, -0.16, sw, hgt + 0.25, 0.16, MAT.concrete, { col: false, skip: NY });
      g.boxB(0, 0.75, 0, [1, 0, 0], [0, Math.cos(0.5), Math.sin(0.5)], [0, -Math.sin(0.5), Math.cos(0.5)], sw, 0.02, 0.35, MAT.concrete, { col: false });
    }
    flushCol(len);
  }
  // gates: posts and raised boom barriers
  for (const gt of wall.gates) {
    const y = heightAt(gt.x, gt.z);
    g.frame(gt.x, y, gt.z, 0);
    const horizontal = wall.pts.some((p, i) => i < wall.pts.length - 1 && Math.abs(p[1] - gt.z) < 1 && Math.abs(wall.pts[i + 1][1] - gt.z) < 1);
    const ax = horizontal ? 1 : 0, az = horizontal ? 0 : 1;
    for (const s of [-1, 1]) g.box(ax * s * gt.w / 2 - 0.3, 0, az * s * gt.w / 2 - 0.3, ax * s * gt.w / 2 + 0.3, 4.2, az * s * gt.w / 2 + 0.3, MAT.concrete);
    const ang = 1.25;
    const bx = -ax * gt.w / 2 + ax * 0.5, bz = -az * gt.w / 2 + az * 0.5;
    const dir = [ax * Math.cos(ang), Math.sin(ang), az * Math.cos(ang)];
    g.boxB(bx + dir[0] * 3, 1.1 + dir[1] * 3, bz + dir[2] * 3, dir, [-ax * Math.sin(ang), Math.cos(ang), -az * Math.sin(ang)], [az, 0, -ax].map((v) => v || 0), 3.0, 0.07, 0.07, MAT.metalRed, { col: false });
    // guard booth
    const bxo = ax ? gt.w / 2 + 2.6 : 2.2, bzo = az ? gt.w / 2 + 2.6 : 2.2;
    g.frame(gt.x + (horizontal ? bxo : -bxo), y, gt.z + (horizontal ? -bzo + 0.0 : bzo), horizontal ? 0 : Math.PI / 2);
    g.box(-1.1, 0, -1.1, 1.1, 0.9, 1.1, MAT.concrete);
    g.box(-1.1, 0.9, -1.1, -0.95, 2.3, 1.1, MAT.concrete); g.box(0.95, 0.9, -1.1, 1.1, 2.3, 1.1, MAT.concrete);
    g.box(-1.25, 2.3, -1.25, 1.25, 2.45, 1.25, MAT.ironDark);
    ctx.covers.push([gt.x, y, gt.z]);
  }
}

function slab(ctx, s) {
  const { g } = ctx;
  g.aoFn = null;
  const cy = Math.max(heightAt(s.x, s.z), 0);
  const panel = s.panel || 6;
  g.frame(s.x, cy, s.z, s.yaw || 0);
  const nx = Math.max(1, Math.round(s.w / panel)), nz = Math.max(1, Math.round(s.d / panel));
  const pw = s.w / nx, pd = s.d / nz;
  const rng = new Rng(Math.round(s.x * 31 + s.z * 17) >>> 0);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const x0 = -s.w / 2 + i * pw, z0 = -s.d / 2 + j * pd;
      const lx = x0 + pw / 2, lz = z0 + pd / 2;
      const hy = heightAt(g.wx(lx, lz), g.wz(lx, lz)) - cy;
      const tone = 0.9 + rng.next() * 0.16;
      const m = s.kind === 'helipad' ? M(L.concrete_floor_worn_001, 0.82) : M(L.concrete_floor_worn_001, tone, tone, tone * 0.98);
      g.box(x0 + 0.02, Math.min(hy, 0) - 0.35, z0 + 0.02, x0 + pw - 0.02, Math.max(hy, 0) + 0.07, z0 + pd - 0.02, m, { skip: NY, col: true, uvOff: rng.next() * 3 });
    }
  }
  if (s.kind === 'helipad') {
    const y = 0.08;
    const white = MAT.trimWhite;
    g.box(-3, y, -4, -2, y + 0.005, 4, white, { col: false, skip: NY });
    g.box(2, y, -4, 3, y + 0.005, 4, white, { col: false, skip: NY });
    g.box(-2, y, -0.5, 2, y + 0.005, 0.5, white, { col: false, skip: NY });
    for (let i = 0; i < 32; i++) {
      const a0 = (i / 32) * Math.PI * 2;
      if (i % 2) continue;
      const r = 8.4;
      g.boxB(Math.cos(a0 + 0.1) * r, y + 0.003, Math.sin(a0 + 0.1) * r, [-Math.sin(a0 + 0.1), 0, Math.cos(a0 + 0.1)], [0, 1, 0], [Math.cos(a0 + 0.1), 0, Math.sin(a0 + 0.1)], 0.8, 0.003, 0.25, MAT.metalYellow, { col: false });
    }
  }
}

function fence(ctx, f) {
  const { g } = ctx;
  g.aoFn = null;
  const wood = f.kind === 'wood';
  const pm = wood ? MAT.planksDark : MAT.metalGrey;
  for (let i = 0; i < f.pts.length - 1; i++) {
    if (f.gap && i === f.gap) continue;
    const [ax, az] = f.pts[i], [bx, bz] = f.pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / 2.5));
    const dx = (bx - ax) / len, dz = (bz - az) / len;
    const yaw = Math.atan2(dx, dz) - Math.PI / 2;
    for (let k = 0; k <= n; k++) {
      const x = ax + dx * len * (k / n), z = az + dz * len * (k / n);
      const y = heightAt(x, z);
      g.frame(x, y, z, yaw);
      g.box(-0.05, -0.3, -0.05, 0.05, wood ? 1.15 : 2.1, 0.05, pm, { col: false });
      if (k < n) {
        const x2 = ax + dx * len * ((k + 1) / n), z2 = az + dz * len * ((k + 1) / n);
        const y2 = heightAt(x2, z2);
        const seg = len / n, pitch = Math.atan2(y2 - y, seg);
        const mx = seg / 2;
        const ax3 = [Math.cos(pitch), Math.sin(pitch), 0], ay3 = [-Math.sin(pitch), Math.cos(pitch), 0];
        if (wood) {
          for (const ry of [0.45, 0.95]) g.boxB(mx, ry + (y2 - y) / 2, 0, ax3, ay3, [0, 0, 1], seg / 2, 0.05, 0.025, pm, { col: false });
        } else {
          for (const ry of [0.2, 2.0]) g.boxB(mx, ry + (y2 - y) / 2, 0, ax3, ay3, [0, 0, 1], seg / 2, 0.02, 0.02, pm, { col: false });
          g.boxB(mx, 1.1 + (y2 - y) / 2, 0, ax3, ay3, [0, 0, 1], seg / 2, 0.9, 0.004, M(L.green_metal_rust, 0.75, 0.8, 0.8), { col: false });
        }
        g.colBox(mx, (wood ? 0.6 : 1.05) + (y2 - y) / 2, 0, seg / 2, wood ? 0.6 : 1.05, 0.06, wood ? SURFACE.WOOD : SURFACE.METAL);
      }
    }
  }
}

function special(ctx, sp) {
  const { g } = ctx;
  g.aoFn = null;
  switch (sp.kind) {
    case 'containers': containers(ctx, { ...sp, y: Math.max(heightAt(sp.x, sp.z), 0) + 0.02 }); break;
    case 'quay': {
      g.frame(0, 0, 0, 0);
      g.box(sp.x0 - 0.5, sp.bottom, sp.z - 2.6, sp.x1 + 0.5, sp.top, sp.z + 0.45, MAT.concrete, { mats: { py: MAT.slab }, skip: NY });
      for (let x = sp.x0 + 4; x < sp.x1; x += 12) {
        g.cyl(x, sp.z - 0.5, sp.top, sp.top + 0.6, 0.22, 0.18, 10, MAT.metalGrey, { top: true, col: true });
        g.cyl(x, sp.z - 0.5, sp.top + 0.6, sp.top + 0.68, 0.3, 0.3, 10, MAT.metalGrey, { top: true });
      }
      for (let x = sp.x0 + 10; x < sp.x1; x += 18) g.box(x - 0.4, 0.4, sp.z + 0.45, x + 0.4, 1.8, sp.z + 0.75, M(L.corrugated_iron, 0.2), { col: false });
      break;
    }
    case 'pier': {
      g.frame(0, 0, 0, 0);
      const hw = sp.w / 2;
      g.box(sp.x - hw, sp.y - 0.25, sp.z0, sp.x + hw, sp.y, sp.z1, MAT.planks, { mats: { ny: MAT.planksDark } });
      for (let z = sp.z0 + 3; z <= sp.z1; z += 4) for (const s of [-1, 1]) g.box(sp.x + s * (hw - 0.2) - 0.16, -9, z - 0.16, sp.x + s * (hw - 0.2) + 0.16, sp.y - 0.25, z + 0.16, MAT.planksDark);
      for (let z = sp.z0 + 3; z <= sp.z1; z += 8) g.box(sp.x - hw, sp.y - 0.6, z - 0.1, sp.x + hw, sp.y - 0.25, z + 0.1, MAT.planksDark, { col: false });
      for (const s of [-1, 1]) g.cyl(sp.x + s * (hw - 0.4), sp.z1 - 0.6, sp.y, sp.y + 0.55, 0.18, 0.15, 10, MAT.metalGrey, { top: true, col: true });
      ctx.covers.push([sp.x, sp.y, sp.z1 - 2]);
      break;
    }
    case 'crane': {
      const y = Math.max(heightAt(sp.x, sp.z), 0);
      g.frame(sp.x, y, sp.z, 0);
      const hs = sp.span / 2, lx = 5.5, h = sp.h;
      const paint = MAT.metalYellow;
      for (const sx of [-lx, lx]) for (const sz of [-hs, hs]) g.box(sx - 0.35, 0, sz - 0.35, sx + 0.35, h, sz + 0.35, paint);
      for (const sx of [-lx, lx]) {
        g.box(sx - 0.5, 0, -hs - 1.2, sx + 0.5, 0.9, hs + 1.2, paint);
        g.box(sx - 0.45, h - 1.2, -hs - 4, sx + 0.45, h, hs + sp.boom, paint);
        for (let z = -hs; z < hs + sp.boom - 2; z += 4) g.box(sx - 0.06, h - 1.2, z, sx + 0.06, h - 1.1, z + 3.8, MAT.metalGrey, { col: false });
      }
      for (const sz of [-hs, hs, hs + sp.boom - 1]) g.box(-lx, h - 1.0, sz - 0.4, lx, h - 0.2, sz + 0.4, paint);
      g.box(-lx, h * 0.45, -hs - 0.3, lx, h * 0.45 + 0.6, -hs + 0.3, paint);
      g.box(-lx, h * 0.45, hs - 0.3, lx, h * 0.45 + 0.6, hs + 0.3, paint);
      g.box(-2.5, h, -hs - 3, 2.5, h + 3, -hs + 2, MAT.ironWhite);
      g.box(-1.2, h - 4.2, hs + 4, 1.2, h - 1.3, hs + 6.4, MAT.ironWhite, { col: false });
      for (const s of [-1, 1]) g.box(s * 0.8 - 0.03, 4, hs + 9, s * 0.8 + 0.03, h - 1.2, hs + 9.06, MAT.metalGrey, { col: false });
      g.box(-1.4, 3.4, hs + 7.8, 1.4, 4.0, hs + 10.2, MAT.metalOrange, { col: false });
      ctx.lights.push({ x: sp.x, y: y + h + 3.2, z: sp.z - hs, kind: 'red' });
      break;
    }
    case 'fueltank': {
      const y = Math.max(heightAt(sp.x, sp.z), 0);
      g.frame(sp.x, y, sp.z, 0);
      g.cyl(0, 0, -0.5, 0.25, sp.r + 0.5, sp.r + 0.5, 28, MAT.concrete, { top: true, col: true });
      g.cyl(0, 0, 0.25, sp.h, sp.r, sp.r, 28, MAT.metalWhite, { col: true });
      g.cyl(0, 0, sp.h, sp.h + 1.1, sp.r, 0.6, 28, MAT.metalWhite, { col: true, top: true });
      for (const yy of [sp.h * 0.33, sp.h * 0.66]) g.cyl(0, 0, yy, yy + 0.1, sp.r + 0.03, sp.r + 0.03, 28, MAT.metalGrey);
      // bund wall
      const bw = sp.r + 2.6;
      g.box(-bw, -0.3, -bw, bw, 1.0, -bw + 0.25, MAT.concrete); g.box(-bw, -0.3, bw - 0.25, bw, 1.0, bw, MAT.concrete);
      g.box(-bw, -0.3, -bw + 0.25, -bw + 0.25, 1.0, bw - 0.25, MAT.concrete); g.box(bw - 0.25, -0.3, -bw + 0.25, bw, 1.0, -1.2, MAT.concrete);
      g.box(bw - 0.25, -0.3, 1.2, bw, 1.0, bw - 0.25, MAT.concrete);
      // caged ladder
      for (const s of [-0.3, 0.3]) g.box(sp.r + 0.12, 0.25, s - 0.03, sp.r + 0.18, sp.h + 1, s + 0.03, MAT.metalGrey, { col: false });
      for (let yy = 0.6; yy < sp.h; yy += 0.4) g.box(sp.r + 0.12, yy, -0.3, sp.r + 0.17, yy + 0.03, 0.3, MAT.metalGrey, { col: false });
      for (const s of [-1, 1]) g.box(-bw + 1, 0.25, s * 2.2 - 0.12, -sp.r + 0.2, 0.45, s * 2.2 + 0.12, MAT.metalGrey, { col: false });
      ctx.covers.push([sp.x + bw + 0.6, y, sp.z]);
      break;
    }
    case 'canopy': {
      const y = Math.max(heightAt(sp.x, sp.z), 0);
      g.frame(sp.x, y, sp.z, sp.yaw);
      const hw = sp.w / 2, hd = sp.d / 2;
      g.box(-hw, sp.h, -hd, hw, sp.h + 0.7, hd, MAT.ironWhite, { mats: { ny: MAT.metalWhite, py: MAT.roofTar } });
      g.box(-hw - 0.05, sp.h + 0.2, -hd - 0.05, hw + 0.05, sp.h + 0.62, hd + 0.05, MAT.metalRed, { skip: PY | NY, col: false });
      for (const x of [-hw + 2.5, hw - 2.5]) {
        g.box(x - 0.2, 0, -0.2, x + 0.2, sp.h, 0.2, MAT.metalWhite);
        g.box(x - 1.6, 0, -0.6, x + 1.6, 0.22, 0.6, MAT.concrete);
        for (const s of [-0.9, 0.9]) g.box(x + s - 0.35, 0.22, -0.28, x + s + 0.35, 1.8, 0.28, MAT.metalWhite);
      }
      ctx.lights.push({ panel: true, x: sp.x, y: y + sp.h - 0.02, z: sp.z, w: sp.w - 2, d: sp.d - 2, yaw: sp.yaw });
      break;
    }
    case 'conveyor': {
      g.frame(0, 0, 0, 0);
      const y0 = heightAt(sp.x0, sp.z0) + 1.2, y1 = heightAt(sp.x1, sp.z1) + 6.5;
      const dx = sp.x1 - sp.x0, dz = sp.z1 - sp.z0, len = Math.hypot(dx, dz, y1 - y0);
      const dir = [dx / len, (y1 - y0) / len, dz / len];
      const side = [-dz / Math.hypot(dx, dz), 0, dx / Math.hypot(dx, dz)];
      const up = [dir[1] * side[2] - dir[2] * side[1], dir[2] * side[0] - dir[0] * side[2], dir[0] * side[1] - dir[1] * side[0]];
      const mx = (sp.x0 + sp.x1) / 2, my = (y0 + y1) / 2, mz = (sp.z0 + sp.z1) / 2;
      for (const s of [-0.7, 0.7]) g.boxB(mx + side[0] * s, my, mz + side[2] * s, dir, up, side, len / 2, 0.22, 0.08, MAT.metalYellow);
      g.boxB(mx, my + 0.12, mz, dir, up, side, len / 2, 0.04, 0.55, M(L.corrugated_iron, 0.25), { col: false });
      for (let t = 0.1; t < 1; t += 0.14) {
        const x = sp.x0 + dx * t, z = sp.z0 + dz * t, y = y0 + (y1 - y0) * t;
        const gy = heightAt(x, z);
        for (const s of [-0.75, 0.75]) g.box(x + side[0] * s - 0.12, gy - 0.3, z + side[2] * s - 0.12, x + side[0] * s + 0.12, y - 0.2, z + side[2] * s + 0.12, MAT.metalYellow);
      }
      const hx = sp.x1, hz = sp.z1, hy = heightAt(hx, hz);
      for (const sx of [-2, 2]) for (const sz of [-2, 2]) g.box(hx + sx - 0.15, hy, hz + sz - 0.15, hx + sx + 0.15, hy + 5.6, hz + sz + 0.15, MAT.metalYellow);
      g.box(hx - 2.6, hy + 5.6, hz - 2.6, hx + 2.6, hy + 8.4, hz + 2.6, MAT.ironRust);
      g.box(hx - 1.2, hy + 3.8, hz - 1.2, hx + 1.2, hy + 5.6, hz + 1.2, MAT.ironRust, { col: false });
      ctx.covers.push([hx, hy, hz]);
      break;
    }
    case 'mast': {
      const y = heightAt(sp.x, sp.z);
      g.frame(sp.x, y, sp.z, 0.4);
      const h = sp.h, base = 3.2, topW = 0.7;
      const sec = 11;
      const wAt = (yy) => base + (topW - base) * (yy / h);
      const leg = (sx, sz, ya, yb) => {
        const wa = wAt(ya) / 2, wb = wAt(yb) / 2;
        const ax = sx * wa, az = sz * wa, bx = sx * wb, bz = sz * wb;
        const len = Math.hypot(bx - ax, yb - ya, bz - az);
        const dir = [(bx - ax) / len, (yb - ya) / len, (bz - az) / len];
        const side = [1, 0, 0];
        const up = [dir[1] * side[2] - dir[2] * side[1], dir[2] * side[0] - dir[0] * side[2], dir[0] * side[1] - dir[1] * side[0]];
        g.boxB((ax + bx) / 2, (ya + yb) / 2, (az + bz) / 2, dir, up, [up[1] * dir[2] - up[2] * dir[1], up[2] * dir[0] - up[0] * dir[2], up[0] * dir[1] - up[1] * dir[0]], len / 2, 0.07, 0.07, MAT.metalWhite, { col: ya < 6 });
      };
      const strut = (p, q, thick = 0.035) => {
        const len = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
        const dir = [(q[0] - p[0]) / len, (q[1] - p[1]) / len, (q[2] - p[2]) / len];
        let side = Math.abs(dir[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
        const up = [dir[1] * side[2] - dir[2] * side[1], dir[2] * side[0] - dir[0] * side[2], dir[0] * side[1] - dir[1] * side[0]];
        const ul = Math.hypot(...up); const u = up.map((v) => v / ul);
        side = [u[1] * dir[2] - u[2] * dir[1], u[2] * dir[0] - u[0] * dir[2], u[0] * dir[1] - u[1] * dir[0]];
        g.boxB((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2, dir, u, side, len / 2, thick, thick, MAT.metalWhite, { col: false });
      };
      for (let k = 0; k < sec; k++) {
        const ya = (k / sec) * h, yb = ((k + 1) / sec) * h;
        const red = k % 2 === 1;
        for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) leg(sx, sz, ya, yb);
        const P = (sx, sz, yy) => [sx * wAt(yy) / 2, yy, sz * wAt(yy) / 2];
        const faces = [[[-1, -1], [1, -1]], [[1, -1], [1, 1]], [[1, 1], [-1, 1]], [[-1, 1], [-1, -1]]];
        for (const [[ax, az], [bx, bz]] of faces) {
          strut(P(ax, az, ya), P(bx, bz, yb));
          strut(P(bx, bz, ya), P(ax, az, yb));
          strut(P(ax, az, yb), P(bx, bz, yb), 0.03);
        }
        if (red) g.boxB(0, yb - 0.1, 0, [1, 0, 0], [0, 1, 0], [0, 0, 1], wAt(yb) / 2 + 0.05, 0.08, wAt(yb) / 2 + 0.05, MAT.metalRed, { col: false, skip: PY | NY });
      }
      g.box(-0.6, h, -0.6, 0.6, h + 0.12, 0.6, MAT.metalGrey, { col: false });
      g.box(-0.04, h, -0.04, 0.04, h + 4, 0.04, MAT.metalGrey, { col: false });
      g.cyl(0.9, 0, h - 6, h - 4.6, 0.6, 0.6, 12, MAT.metalWhite, { col: false });
      g.box(-base / 2 - 0.4, -0.4, -base / 2 - 0.4, base / 2 + 0.4, 0.3, base / 2 + 0.4, MAT.concrete);
      ctx.lights.push({ x: sp.x, y: y + h + 4.05, z: sp.z, kind: 'red' }, { x: sp.x, y: y + h * 0.5, z: sp.z, kind: 'red', dim: true });
      break;
    }
    case 'gravelpile': {
      const y = heightAt(sp.x, sp.z);
      g.frame(sp.x, y, sp.z, 0);
      g.cyl(0, 0, -0.4, sp.h, sp.r, 0.6, 16, MAT.gravel, { top: true, col: true });
      break;
    }
    case 'firepit': {
      const y = heightAt(sp.x, sp.z);
      g.frame(sp.x, y, sp.z, 0);
      for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2; g.box(Math.cos(a) * 0.8 - 0.18, -0.1, Math.sin(a) * 0.8 - 0.14, Math.cos(a) * 0.8 + 0.18, 0.22, Math.sin(a) * 0.8 + 0.14, MAT.rock, { col: false }); }
      for (const [x, z, yaw] of [[2.2, 0, 0], [-1.6, 1.6, 0.8], [0, -2.3, 1.6]]) { g.frame(sp.x + x, y, sp.z + z, yaw); g.box(-1.0, 0, -0.18, 1.0, 0.42, 0.18, MAT.planksDark); }
      break;
    }
    default: break;
  }
}

function powerPoles(ctx, poles) {
  const { g } = ctx;
  g.aoFn = null;
  const tops = [];
  for (const p of poles) {
    const y = heightAt(p.x, p.z);
    g.frame(p.x, y, p.z, p.yaw);
    g.cyl(0, 0, -0.5, 8.6, 0.16, 0.12, 8, MAT.planksDark, { col: true });
    g.box(-1.1, 8.0, -0.06, 1.1, 8.16, 0.06, MAT.planksDark, { col: false });
    for (const x of [-0.95, 0, 0.95]) g.cyl(x, 0, 8.16, 8.36, 0.05, 0.04, 6, MAT.metalWhite);
    tops.push({ p, y, road: p.road });
  }
  // sagging wires between consecutive poles of the same road
  for (let i = 0; i < tops.length - 1; i++) {
    const a = tops[i], b = tops[i + 1];
    if (a.road !== b.road) continue;
    const dist = Math.hypot(b.p.x - a.p.x, b.p.z - a.p.z);
    if (dist > 70) continue;
    for (const off of [-0.95, 0, 0.95]) {
      const ax = a.p.x + Math.cos(a.p.yaw) * off, az = a.p.z - Math.sin(a.p.yaw) * off;
      const bx = b.p.x + Math.cos(b.p.yaw) * off, bz = b.p.z - Math.sin(b.p.yaw) * off;
      const n = 8;
      g.frame(0, 0, 0, 0);
      for (let k = 0; k < n; k++) {
        const t0 = k / n, t1 = (k + 1) / n;
        const sag = (t) => -1.1 * 4 * t * (1 - t);
        const p0 = [ax + (bx - ax) * t0, a.y + 8.36 + (b.y - a.y) * t0 + sag(t0), az + (bz - az) * t0];
        const p1 = [ax + (bx - ax) * t1, a.y + 8.36 + (b.y - a.y) * t1 + sag(t1), az + (bz - az) * t1];
        const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
        const dir = [(p1[0] - p0[0]) / len, (p1[1] - p0[1]) / len, (p1[2] - p0[2]) / len];
        const side = [-dir[2], 0, dir[0]]; const sl = Math.hypot(side[0], side[2]) || 1;
        const sd = [side[0] / sl, 0, side[2] / sl];
        const up = [dir[1] * sd[2] - dir[2] * sd[1], dir[2] * sd[0] - dir[0] * sd[2], dir[0] * sd[1] - dir[1] * sd[0]];
        g.boxB((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2, dir, up, sd, len / 2, 0.012, 0.012, M(L.corrugated_iron, 0.12), { col: false, skip: PX | NX });
      }
    }
  }
}

// ------------------------------------------------------------------------------------------ public build
/**
 * Build every building and structure of the layout.
 * @returns {{groups: Array<{site, geometry}>, boxes, tris, rooms, doors, covers, lights, lamps}}
 */
export async function buildBuildings(layout, onProgress = () => {}) {
  const bySite = new Map();
  const geoFor = (site) => {
    const k = site || 'countryside';
    if (!bySite.has(k)) bySite.set(k, new Geo());
    return bySite.get(k);
  };
  const out = { rooms: [], doors: [], covers: [], lights: [], lamps: [] };
  const frameWait = () => new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));
  let t0 = performance.now();
  const total = layout.buildings.length + layout.special.length + layout.slabs.length + 4;
  let done = 0;
  const tick = async () => {
    done++;
    if (performance.now() - t0 > 30) { onProgress(done / total); await frameWait(); t0 = performance.now(); }
  };
  for (const s of layout.slabs) {
    const g = geoFor(s.site);
    const ctx = { g, b: s, rooms: out.rooms, doors: out.doors, covers: out.covers, lights: out.lights, rng: new Rng(1) };
    slab(ctx, s);
    await tick();
  }
  for (const b of layout.buildings) {
    const g = geoFor(b.site);
    const cs = [[-b.w / 2, -b.d / 2], [b.w / 2, -b.d / 2], [b.w / 2, b.d / 2], [-b.w / 2, b.d / 2], [0, 0]];
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    const hs = cs.map(([lx, lz]) => heightAt(b.x + lx * c + lz * s, b.z - lx * s + lz * c));
    const top = Math.max(...hs), low = Math.min(...hs);
    const base = Math.max(top, 0.2) + 0.15;
    b.y = base;
    b.lowest = low - base;
    g.frame(b.x, base, b.z, b.yaw);
    const ctx = makeCtx(g, b);
    ctx.lights = out.lights;
    const fn = KINDS[b.kind];
    if (!fn) throw new Error(`[WORLD/buildings] unknown building kind '${b.kind}'`);
    fn(ctx);
    g.aoFn = null;
    for (const r of ctx.rooms) out.rooms.push({ ...r, building: b.id, kind: b.kind, target: b.lootTarget || null });
    out.doors.push(...ctx.doors);
    out.covers.push(...ctx.covers);
    if (ctx.lamp) out.lamps.push(ctx.lamp);
    await tick();
  }
  for (const sp of layout.special) {
    const g = geoFor(sp.site);
    const ctx = { g, b: sp, rooms: [], doors: out.doors, covers: out.covers, lights: out.lights, rng: new Rng(sp.seed || 7) };
    special(ctx, sp);
    for (const r of ctx.rooms) out.rooms.push({ ...r, building: `${sp.site}:${sp.kind}`, kind: sp.kind });
    await tick();
  }
  for (const w of layout.walls) { const g = geoFor(w.site); twall({ g, covers: out.covers }, w); await tick(); }
  for (const f of layout.fences) { const g = geoFor(f.site); fence({ g }, f); }
  powerPoles({ g: geoFor(null) }, layout.poles);
  const groups = [];
  const boxes = [], tris = [];
  for (const [site, g] of bySite) {
    if (g.vc === 0) continue;
    groups.push({ site, geometry: g.toGeometry(), triangles: g.triangles });
    boxes.push(...g.boxes);
    tris.push(...g.tris);
  }
  onProgress(1);
  return { groups, boxes, tris, ...out };
}

export { MAT, KINDS };
