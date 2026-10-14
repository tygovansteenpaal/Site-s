// ZONEFALL - terrain meshes, splat control map, road ribbons and the top-down map image. OWNER: WORLD (internal).
// Heights come from world/heightfield.js (analytic, shared with physics). The rendered terrain is a grid of
// 200 m chunks, each with three LODs (full, 1/2, 1/4 resolution) selected by distance with hysteresis, and skirts
// that hide LOD cracks. Pure-ocean chunks are skipped (the water surface covers them). The splat control map is a
// rasterization of heightfield.paintAt so footsteps and visuals agree. Asphalt roads are ribbon meshes on the
// flattened corridors with procedural markings; dirt tracks are painted into the control map.
import * as THREE from 'three';
import { MAP } from '../core/mapdata.js';
import { SURFACE } from '../config.js';
import * as hf from './heightfield.js';
import { terrainMaterial, roadMaterial } from './materials.js';

const TUNE = {
  chunk: 200,
  lodDist: [240, 560],      // metres from the chunk bounds to switch LOD 0 -> 1 -> 2
  hysteresis: 25,
  skirt: 2.5,
  ctrlSize: 1024,
  oceanSkip: -5,            // chunks whose highest point is below this are not rendered
  roadStep: 2,
  roadLift: 0.045,
  sliceMs: 28,              // generation work per frame before yielding
};

const W = MAP.size, HALF = MAP.half;
let grid = null;            // {res, cell, h: Float32Array, nx/ny/nz: Float32Array}
let ctrl = null;            // {size, data: Uint8Array, tex}
let chunks = [];
let material = null;
let roadMeshes = [];
let root = null;

const now = () => performance.now();
const frame = () => new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));

/** Re-exports of the analytic queries (heightfield.js) under the names the stub suggested. */
export const heightAt = hf.heightAt;
export const surfaceAt = hf.surfaceAt;
export const normalAt = hf.normalAt;

/** Grid resolution (cells across the 1200 m world) for a QUALITY.terrainRes value; divisible by 24. */
function resFor(q) {
  const base = q.terrainRes <= 128 ? 240 : q.terrainRes <= 256 ? 480 : 768;
  return base;
}

// ------------------------------------------------------------------------------------------ height grid
/** Sample heightAt on the render grid (and derive normals). Yields to keep frames under ~30 ms. */
export async function buildHeightGrid(quality, onProgress = () => {}) {
  const res = resFor(quality);
  const n = res + 1, cell = W / res;
  const h = new Float32Array(n * n);
  let t0 = now();
  for (let j = 0; j < n; j++) {
    const z = -HALF + j * cell;
    for (let i = 0; i < n; i++) h[j * n + i] = hf.heightAt(-HALF + i * cell, z);
    if (now() - t0 > TUNE.sliceMs) { onProgress(j / n); await frame(); t0 = now(); }
  }
  const nx = new Float32Array(n * n), ny = new Float32Array(n * n), nz = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const hl = h[j * n + Math.max(0, i - 1)], hr = h[j * n + Math.min(n - 1, i + 1)];
      const hu = h[Math.max(0, j - 1) * n + i], hd = h[Math.min(n - 1, j + 1) * n + i];
      const dx = (i > 0 && i < n - 1) ? 2 * cell : cell, dz = (j > 0 && j < n - 1) ? 2 * cell : cell;
      let a = -(hr - hl) / dx, b = 1, c = -(hd - hu) / dz;
      const l = Math.hypot(a, b, c);
      nx[j * n + i] = a / l; ny[j * n + i] = b / l; nz[j * n + i] = c / l;
    }
  }
  grid = { res, n, cell, h, nx, ny, nz };
  onProgress(1);
  return grid;
}

/** Bilinear height from the render grid (what the eye sees); falls back to analytic outside. */
export function gridHeight(x, z) {
  if (!grid) return hf.heightAt(x, z);
  const fx = (x + HALF) / grid.cell, fz = (z + HALF) / grid.cell;
  const i = Math.floor(fx), j = Math.floor(fz);
  if (i < 0 || j < 0 || i >= grid.res || j >= grid.res) return hf.heightAt(x, z);
  const tx = fx - i, tz = fz - j, n = grid.n, H = grid.h;
  const a = H[j * n + i], b = H[j * n + i + 1], c = H[(j + 1) * n + i], d = H[(j + 1) * n + i + 1];
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}
export const getGrid = () => grid;

// ------------------------------------------------------------------------------------------ control map
/** Rasterize heightfield.paintAt into the RGBA splat control texture (dirt, straw, forest, mud). */
export async function buildControlMap(onProgress = () => {}) {
  const S = TUNE.ctrlSize;
  const data = new Uint8Array(S * S * 4);
  const out = new Float32Array(5);
  let t0 = now();
  for (let j = 0; j < S; j++) {
    const z = -HALF + (j + 0.5) * (W / S);
    for (let i = 0; i < S; i++) {
      hf.paintAt(-HALF + (i + 0.5) * (W / S), z, out);
      const o = (j * S + i) * 4;
      data[o] = out[0] * 255; data[o + 1] = out[1] * 255; data[o + 2] = out[2] * 255; data[o + 3] = out[3] * 255;
    }
    if (now() - t0 > TUNE.sliceMs) { onProgress(j / S); await frame(); t0 = now(); }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.flipY = false;
  tex.needsUpdate = true;
  ctrl = { size: S, data, tex };
  onProgress(1);
  return ctrl;
}
export const getControl = () => ctrl;

// ------------------------------------------------------------------------------------------ chunk meshes
function chunkGeometry(ci, cj, lod) {
  const k = grid.res / (W / TUNE.chunk);           // grid cells per chunk at LOD 0
  const st = 1 << lod, m = k / st;                  // quads per side at this LOD
  const n = grid.n;
  const i0 = ci * k, j0 = cj * k;
  const verts = (m + 1) * (m + 1) + 4 * m * 2;
  const pos = new Float32Array(verts * 3), nrm = new Float32Array(verts * 3);
  let v = 0;
  const put = (gi, gj, drop) => {
    const g = gj * n + gi;
    pos[v * 3] = -HALF + gi * grid.cell; pos[v * 3 + 1] = grid.h[g] - drop; pos[v * 3 + 2] = -HALF + gj * grid.cell;
    nrm[v * 3] = grid.nx[g]; nrm[v * 3 + 1] = grid.ny[g]; nrm[v * 3 + 2] = grid.nz[g];
    return v++;
  };
  for (let y = 0; y <= m; y++) for (let x = 0; x <= m; x++) put(i0 + x * st, j0 + y * st, 0);
  const idx = [];
  const at = (x, y) => y * (m + 1) + x;
  for (let y = 0; y < m; y++) {
    for (let x = 0; x < m; x++) {
      const a = at(x, y), b = at(x + 1, y), c = at(x, y + 1), d = at(x + 1, y + 1);
      if ((x + y) & 1) { idx.push(a, c, b, b, c, d); } else { idx.push(a, c, d, a, d, b); }
    }
  }
  // skirts (both windings so they hide cracks from either side)
  const drop = TUNE.skirt + grid.cell * st;
  const edge = (list) => {
    for (let e = 0; e < list.length - 1; e++) {
      const [ax, ay] = list[e], [bx, by] = list[e + 1];
      const p = at(ax, ay), q = at(bx, by);
      const p2 = put(i0 + ax * st, j0 + ay * st, drop), q2 = put(i0 + bx * st, j0 + by * st, drop);
      idx.push(p, q, q2, p, q2, p2, p, q2, q, p, p2, q2);
    }
  };
  const top = [], bottom = [], left = [], right = [];
  for (let s = 0; s <= m; s++) { top.push([s, 0]); bottom.push([s, m]); left.push([0, s]); right.push([m, s]); }
  edge(top); edge(bottom); edge(left); edge(right);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm.subarray(0, v * 3), 3));
  geo.setIndex(v > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/** Build the chunk meshes (all LODs) and the road ribbons. Requires buildHeightGrid and buildControlMap. */
export async function buildTerrain(scene, quality, onProgress = () => {}) {
  if (!grid || !ctrl) throw new Error('[WORLD/terrain] buildHeightGrid and buildControlMap must run first');
  root = new THREE.Group();
  root.name = 'terrain';
  material = terrainMaterial({ ctrl: ctrl.tex, worldSize: W });
  const nC = W / TUNE.chunk, k = grid.res / nC;
  let t0 = now(), done = 0;
  for (let cj = 0; cj < nC; cj++) {
    for (let ci = 0; ci < nC; ci++) {
      let hi = -1e9, lo = 1e9;
      for (let y = cj * k; y <= (cj + 1) * k; y++) for (let x = ci * k; x <= (ci + 1) * k; x++) {
        const hh = grid.h[y * grid.n + x]; if (hh > hi) hi = hh; if (hh < lo) lo = hh;
      }
      done++;
      if (hi < TUNE.oceanSkip) continue;
      const geos = [0, 1, 2].map((l) => chunkGeometry(ci, cj, l));
      const mesh = new THREE.Mesh(geos[1], material);
      mesh.name = `terrain_${ci}_${cj}`;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      const box = new THREE.Box3(new THREE.Vector3(-HALF + ci * TUNE.chunk, lo, -HALF + cj * TUNE.chunk), new THREE.Vector3(-HALF + (ci + 1) * TUNE.chunk, hi, -HALF + (cj + 1) * TUNE.chunk));
      chunks.push({ mesh, geos, lod: 1, box });
      root.add(mesh);
      if (now() - t0 > TUNE.sliceMs) { onProgress(done / (nC * nC) * 0.85); await frame(); t0 = now(); }
    }
  }
  buildRoads(root);
  scene.add(root);
  onProgress(1);
  return root;
}

const tmpV = new THREE.Vector3();
/** Per frame: pick each chunk's LOD from the view position. */
export function updateTerrain(dt, viewPos) {
  for (const c of chunks) {
    const d = c.box.distanceToPoint(viewPos);
    let lod = d < TUNE.lodDist[0] ? 0 : d < TUNE.lodDist[1] ? 1 : 2;
    if (lod !== c.lod) {
      // hysteresis: only switch when clearly past the threshold
      const th = lod > c.lod ? TUNE.lodDist[lod - 1] + TUNE.hysteresis : TUNE.lodDist[lod] - TUNE.hysteresis;
      if ((lod > c.lod && d > th) || (lod < c.lod && d < th) || Math.abs(lod - c.lod) > 1) {
        c.lod = lod;
        c.mesh.geometry = c.geos[lod];
      }
    }
  }
}

/** Force a LOD for every chunk (tests and screenshots). */
export function setTerrainLod(l) { for (const c of chunks) { c.lod = l; c.mesh.geometry = c.geos[l]; } }

export function terrainStats() {
  let tris = 0;
  for (const c of chunks) tris += c.mesh.geometry.index.count / 3;
  return { chunks: chunks.length, tris };
}

// ------------------------------------------------------------------------------------------ road ribbons
function buildRoads(parent) {
  const asphalt = hf.roads.filter((r) => r.type === 'asphalt');
  asphalt.forEach((r, ri) => {
    const step = TUNE.roadStep;
    const n = Math.max(2, Math.ceil(r.len / step) + 1);
    const lats = [-1, -0.5, 0, 0.5, 1];
    const pos = [], nrm = [], road = [], idx = [];
    let seg = 0;
    const pointAt = (s) => {
      s = Math.max(0, Math.min(r.len, s));
      while (seg > 0 && r.cum[seg] > s) seg--;
      while (seg < r.cum.length - 2 && r.cum[seg + 1] < s) seg++;
      const t = (s - r.cum[seg]) / Math.max(1e-6, r.cum[seg + 1] - r.cum[seg]);
      return [r.xs[seg] + (r.xs[seg + 1] - r.xs[seg]) * t, r.zs[seg] + (r.zs[seg + 1] - r.zs[seg]) * t];
    };
    const others = asphalt.filter((o) => o !== r);
    for (let k = 0; k < n; k++) {
      const s = (k / (n - 1)) * r.len;
      const [x, z] = pointAt(s);
      const [xa, za] = pointAt(s - 1.5), [xb, zb] = pointAt(s + 1.5);
      let tx = xb - xa, tz = zb - za; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const px = -tz, pz = tx;   // left of travel
      const h = hf.roadHeight(r, s);
      const g = (hf.roadHeight(r, Math.min(r.len, s + 1)) - hf.roadHeight(r, Math.max(0, s - 1))) / 2;
      const nl = Math.hypot(tx * g, 1, tz * g);
      // fade markings over junctions with other asphalt roads and at the very ends
      let fade = Math.min(1, s / 6, (r.len - s) / 6);
      for (const o of others) {
        let best = 1e9;
        for (let i = 0; i < o.xs.length - 1; i++) {
          const ax = o.xs[i], az = o.zs[i];
          if ((ax - x) * (ax - x) + (az - z) * (az - z) > 1600) continue;
          const ex = o.xs[i + 1] - ax, ez = o.zs[i + 1] - az, l2 = ex * ex + ez * ez;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
          best = Math.min(best, Math.hypot(ax + ex * t - x, az + ez * t - z));
        }
        fade = Math.min(fade, Math.max(0, (best - o.half - 1.0) / 3));
      }
      for (const L of lats) {
        const off = L * (r.half + 0.12);
        pos.push(x + px * off, h + TUNE.roadLift, z + pz * off);
        nrm.push(-tx * g / nl, 1 / nl, -tz * g / nl);
        road.push(L * r.half, s, r.half, fade);
      }
      if (k > 0) {
        const b0 = (k - 1) * lats.length, b1 = k * lats.length;
        for (let c = 0; c < lats.length - 1; c++) {
          // vertices run left (-1) to right (+1); keep the winding facing up
          idx.push(b0 + c, b0 + c + 1, b1 + c, b0 + c + 1, b1 + c + 1, b1 + c);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('aRoad', new THREE.Float32BufferAttribute(road, 4));
    geo.setIndex(idx);
    // winding check: make sure the first triangle faces up, flip all if not
    const p = geo.attributes.position.array, I = geo.index.array;
    const ax = p[I[1] * 3] - p[I[0] * 3], az = p[I[1] * 3 + 2] - p[I[0] * 3 + 2];
    const bx = p[I[2] * 3] - p[I[0] * 3], bz = p[I[2] * 3 + 2] - p[I[0] * 3 + 2];
    if (az * bx - ax * bz < 0) for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; }
    geo.computeBoundingSphere();
    const mat = roadMaterial();
    mat.polygonOffsetUnits = -4 - ri * 3;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `road_${r.id}`;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 1 + ri;
    parent.add(mesh);
    roadMeshes.push(mesh);
  });
}

// ------------------------------------------------------------------------------------------ map image
/**
 * 1024 px top-down map: hillshaded relief, water by depth, ground cover, contour lines, roads and building
 * footprints. North (-Z) is up; pixel (u, v) = util.worldToMap(x, z) * size.
 * @param {number} size
 * @param {Array<{x:number, z:number, w:number, d:number, rot:number, kind:string}>} footprints
 */
export function renderMapImage(size = 1024, footprints = []) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const px = img.data;
  const L = [-0.55, 0.62, -0.56];
  const ll = Math.hypot(...L); L[0] /= ll; L[1] /= ll; L[2] /= ll;
  const sc = W / size;
  const cs = ctrl ? ctrl.size : 0;
  for (let y = 0; y < size; y++) {
    const z = -HALF + (y + 0.5) * sc;
    for (let x = 0; x < size; x++) {
      const wx = -HALF + (x + 0.5) * sc;
      const h = gridHeight(wx, z);
      // normal from the grid
      const e = sc;
      const hx = gridHeight(wx + e, z) - gridHeight(wx - e, z), hz = gridHeight(wx, z + e) - gridHeight(wx, z - e);
      let nx = -hx, ny = 2 * e, nz = -hz; const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
      let r, g, b;
      if (h < 0) {
        const d = Math.min(1, -h / 11);
        r = 44 + (88 - 44) * (1 - d); g = 74 + (128 - 74) * (1 - d); b = 92 + (132 - 92) * (1 - d);
        // shore wash
        if (h > -0.8) { r += 18; g += 18; b += 14; }
      } else {
        let c0 = 0, c1 = 0, c2 = 0, c3 = 0;
        if (cs) {
          const ci = Math.min(cs - 1, Math.floor(((wx + HALF) / W) * cs)), cj = Math.min(cs - 1, Math.floor(((z + HALF) / W) * cs));
          const o = (cj * cs + ci) * 4;
          c0 = ctrl.data[o] / 255; c1 = ctrl.data[o + 1] / 255; c2 = ctrl.data[o + 2] / 255; c3 = ctrl.data[o + 3] / 255;
        }
        r = 118; g = 132; b = 92;                                        // meadow
        r += (150 - r) * c1 * 0.8; g += (142 - g) * c1 * 0.8; b += (92 - b) * c1 * 0.8;   // straw
        r += (72 - r) * c2; g += (94 - g) * c2; b += (62 - b) * c2;      // forest
        r += (124 - r) * c3; g += (104 - g) * c3; b += (80 - b) * c3;    // mud
        r += (156 - r) * c0; g += (142 - g) * c0; b += (116 - b) * c0;   // gravel
        const sand = hf.sandiness(wx, z, h);
        r += (196 - r) * sand; g += (182 - g) * sand; b += (146 - b) * sand;
        if (ny < 0.74) { const k = Math.min(1, (0.74 - ny) * 5); r += (128 - r) * k; g += (126 - g) * k; b += (120 - b) * k; }
        // altitude tint: higher ground lighter
        const t = Math.min(1, h / 65);
        r += 20 * t; g += 16 * t; b += 12 * t;
      }
      // hillshade
      const sh = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
      const k = h < 0 ? 0.92 + 0.08 * sh : 0.55 + 0.6 * sh;
      r *= k; g *= k; b *= k;
      // contour lines every 10 m (index line every 50 m)
      if (h > 1) {
        const c = Math.floor(h / 10), cr = Math.floor(gridHeight(wx + sc, z) / 10), cd = Math.floor(gridHeight(wx, z + sc) / 10);
        if (c !== cr || c !== cd) { const f = Math.max(c, cr, cd) % 5 === 0 ? 0.72 : 0.86; r *= f; g *= f; b *= f; }
      }
      const o = (y * size + x) * 4;
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const toPx = (v) => (v + HALF) / sc;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // dirt tracks
  for (const r of hf.roads.filter((q) => q.type === 'dirt')) {
    ctx.beginPath();
    for (let i = 0; i < r.xs.length; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, toPx(r.xs[i]), toPx(r.zs[i]));
    ctx.strokeStyle = 'rgba(70,58,40,0.55)'; ctx.lineWidth = Math.max(2, (r.width + 2) / sc); ctx.stroke();
    ctx.strokeStyle = 'rgba(214,196,152,0.95)'; ctx.lineWidth = Math.max(1.2, r.width / sc * 0.7); ctx.stroke();
  }
  // asphalt roads
  for (const r of hf.roads.filter((q) => q.type === 'asphalt')) {
    ctx.beginPath();
    for (let i = 0; i < r.xs.length; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, toPx(r.xs[i]), toPx(r.zs[i]));
    ctx.strokeStyle = 'rgba(30,30,28,0.85)'; ctx.lineWidth = (r.width + 3) / sc; ctx.stroke();
    ctx.strokeStyle = 'rgba(232,226,208,1)'; ctx.lineWidth = r.width / sc; ctx.stroke();
  }
  // building footprints
  for (const f of footprints) {
    ctx.save();
    ctx.translate(toPx(f.x), toPx(f.z));
    ctx.rotate(-f.rot);
    const w = f.w / sc, d = f.d / sc;
    if (f.round) { ctx.beginPath(); ctx.arc(0, 0, w / 2, 0, Math.PI * 2); } else { ctx.beginPath(); ctx.rect(-w / 2, -d / 2, w, d); }
    ctx.fillStyle = f.fill || 'rgba(58,56,52,0.92)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(18,18,16,0.9)';
    ctx.stroke();
    ctx.restore();
  }
  return cv;
}

/** Surface ids for convenience in other world modules. */
export { SURFACE };
