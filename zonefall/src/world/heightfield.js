// ZONEFALL - analytic island heightfield, roads and ground paint. OWNER: WORLD (internal).
// Pure (no three.js, no DOM) so bots, loot and tests can call it thousands of times per frame, and so it can be
// verified in Node. Everything derives from core/mapdata.js and MAP.seed, so every peer builds the same island.
//
// Height pipeline (ARCHITECTURE.md 3.2):
//   natural fbm hills (6..34 m, lower toward the coast)  ->  coastline profile (beach / rocky shore / seabed)
//   -> Signal Hill massif  ->  flatten rectangles (Fort Kessler)  ->  site discs (h inside 0.8 r, blended to r)
//   -> Greystone pit (terraces + spiral haul ramp)  ->  Southport harbour basin  ->  road corridors.
// Roads are Chaikin-smoothed polylines with a smoothed longitudinal profile sampled from the pre-road terrain.
// Ground paint (dirt, straw, forest floor, mud) is a list of analytic primitives evaluated identically by the
// splat-control rasterizer (GPU look) and by surfaceAt (footsteps, impacts).
import { MAP, ALL_SITES, ROADS, ROAD_WIDTH, FORESTS, WATERWAYS, siteById } from '../core/mapdata.js';
import { SURFACE } from '../config.js';
import { mixSeed, hashString } from '../core/rng.js';
import { makeSimplex, fbm, ridged, smooth01, smoother01, sstep, mix, smax, segDist } from './noise.js';

export const TUNE = {
  shoulder: 3,               // road shoulder each side (m): placement clearance, paint and lookups
  flatShoulder: 1.6,         // level verge beside the carriageway before the bank starts
  talusBase: 2.2,            // bank width (m) where the road sits at grade
  talusPerM: 1.9,            // + bank metres per metre of cut or fill: ~1:1.9 embankments and cuttings
  ditch: { depth: 0.42, at: 1.25, w: 0.7 },  // drainage ditch beside asphalt in cuttings and at grade
  maxBlend: 34,
  // Mountains: ridged ranges rise only where the land is free of sites, roads and water (distance field below), so
  // valleys carry the roads and towns and the high ground fills the space between them. Rock bands come from a
  // terrace curve mixed into the upper slopes.
  mountain: { amp: 66, scale: 230, free: [-4, 46], inland: [30, 140], terrace: 9, terraceMix: 0.42, freeCell: 8 },
  // Lake and river (WATERWAYS): the bed falls to `bed` over `shelf` metres from the waterline; the banks climb back
  // to the land over bank + bankPerM per metre of height (capped), so deep valleys get wide slopes.
  water: { bed: -5.5, shelf: 11, shore: 0.3, bank: 14, bankPerM: 2.4, maxBank: 80 },
  profileStep: 4,            // road profile sample spacing (m)
  profileSigma: { asphalt: 22, dirt: 12 },
  maxGrade: { asphalt: 0.11, dirt: 0.2 },
  landMargin: 22,            // sites and roads keep this much land beyond their edge
  coastSmooth: 18,
  beachHeight: 2.6,
  seabedFall: 28,            // m of offshore distance for the seabed to reach ~63% of MAP.seabed
  hill: { id: 'signal', radius: 125, crest: 4 },
  pit: { faces: [[63, 56], [49, 42], [35, 28]], floorNoise: 0.35, rockNy: 0.84 },
  ramp: { width: 7, top: 22, startR: 44.7, endR: 25, sweep: 3.9 },
  harbour: { depth: -7.5, taper: 28 },
  kesslerPad: { x0: 150, x1: 350, z0: -340, z1: -160, blend: 26 },
  gridCell: 32,
  rockSlope: 0.72,           // normal.y below this reads as rock
};

const seedOf = (label) => mixSeed(MAP.seed, hashString(label));
const NA = makeSimplex(seedOf('terrain-a'));
const NB = makeSimplex(seedOf('terrain-b'));
const NC = makeSimplex(seedOf('terrain-c'));
const ND = makeSimplex(seedOf('terrain-d'));
const NE = makeSimplex(seedOf('paint'));

const H0 = MAP.naturalHeight[0], H1 = MAP.naturalHeight[1];
const SIGNAL = siteById('signal');
const GREY = siteById('greystone');
const PORT = siteById('southport');
const tmp = [0];

// ------------------------------------------------------------------------------------------ natural terrain
// Raw fbm mix, then an affine remap calibrated on land samples so the natural range lands on MAP.naturalHeight.
function rawNatural(x, z) {
  const broad = fbm(NA, x / 560, z / 560, 4, 0.5);
  const rid = ridged(NB, x / 330 + 11.3, z / 330 - 4.1, 3);
  return 0.62 * broad + 0.55 * (rid - 0.35);
}
let natLo = -0.6, natHi = 0.6;
(function calibrate() {
  const vals = [];
  for (let i = 0; i < 70; i++) {
    for (let j = 0; j < 70; j++) {
      const x = -460 + i * (920 / 69), z = -460 + j * (920 / 69);
      if (Math.hypot(x, z) < 430) vals.push(rawNatural(x, z));
    }
  }
  vals.sort((a, b) => a - b);
  natLo = vals[Math.floor(vals.length * 0.02)];
  natHi = vals[Math.floor(vals.length * 0.985)];
})();

/** Coastline radius at angle theta (default formula plus a little low-frequency irregularity). */
export function coastRadius(theta) {
  const c = Math.cos(theta), s = Math.sin(theta);
  return MAP.coastBase + 28 * Math.sin(3 * theta + 0.9) + 14 * Math.sin(7 * theta + 2.3) + 5 * NC(c * 1.7, s * 1.7);
}

function natural(x, z, inland) {
  let t = (rawNatural(x, z) - natLo) / (natHi - natLo);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const detail = fbm(NC, x / 95, z / 95, 3, 0.5) * 1.6;
  let h = H0 + (H1 - H0) * t + detail;
  // coastal lowlands: the interior carries the big hills
  const k = sstep(25, 190, inland);
  h = mix(H0 + 2 + 5 * t, h, k);
  return h < H0 ? H0 + (h - H0) * 0.25 : h;
}

// ------------------------------------------------------------------------------------------ roads
function chaikin(pts, iterations) {
  let p = pts;
  for (let it = 0; it < iterations; it++) {
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1];
      if (i > 0) out.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25]);
      if (i < p.length - 2) out.push([ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

function makeRoad(id, type, rawPts, width, iterations = 3) {
  const pts = iterations ? chaikin(rawPts, iterations) : rawPts;
  const n = pts.length;
  const xs = new Float64Array(n), zs = new Float64Array(n), cum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = pts[i][0]; zs[i] = pts[i][1];
    if (i) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
  }
  return { id, type, width, half: width / 2, xs, zs, cum, len: cum[n - 1], profile: null, raw: rawPts };
}

/** Smoothed and internal roads: [{id, type, width, half, xs, zs, cum, len, profile}] (the quarry ramp is 'RQ'). */
export const roads = ROADS.map((r) => makeRoad(r.id, r.type, r.pts, ROAD_WIDTH[r.type]));

// Greystone haul ramp: from the end of R2 spiralling down to the pit floor.
const ramp = (() => {
  const R = TUNE.ramp, pts = [];
  const a0 = Math.atan2(150 - GREY.z, 300 - GREY.x);
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = a0 + R.sweep * t;
    const r = mix(R.startR, R.endR, smoother01(t * 0.85 + 0.15 * t * t));
    pts.push([GREY.x + Math.cos(a) * r, GREY.z + Math.sin(a) * r]);
  }
  const road = makeRoad('RQ', 'dirt', pts, R.width, 0);
  return road;
})();
roads.push(ramp);

// Spatial grid of road segments (cells of TUNE.gridCell metres) for fast corridor lookups.
const G = { n: Math.ceil((MAP.size + 80) / TUNE.gridCell), off: MAP.half + 40, cells: null };
(function buildGrid() {
  G.cells = Array.from({ length: G.n * G.n }, () => []);
  const reach = 4 + TUNE.shoulder + TUNE.maxBlend + 2;
  roads.forEach((r, ri) => {
    for (let i = 0; i < r.xs.length - 1; i++) {
      const x0 = Math.min(r.xs[i], r.xs[i + 1]) - reach, x1 = Math.max(r.xs[i], r.xs[i + 1]) + reach;
      const z0 = Math.min(r.zs[i], r.zs[i + 1]) - reach, z1 = Math.max(r.zs[i], r.zs[i + 1]) + reach;
      const cx0 = Math.max(0, Math.floor((x0 + G.off) / TUNE.gridCell)), cx1 = Math.min(G.n - 1, Math.floor((x1 + G.off) / TUNE.gridCell));
      const cz0 = Math.max(0, Math.floor((z0 + G.off) / TUNE.gridCell)), cz1 = Math.min(G.n - 1, Math.floor((z1 + G.off) / TUNE.gridCell));
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) G.cells[cz * G.n + cx].push(ri, i);
    }
  });
})();

function cellAt(x, z) {
  const cx = Math.floor((x + G.off) / TUNE.gridCell), cz = Math.floor((z + G.off) / TUNE.gridCell);
  if (cx < 0 || cz < 0 || cx >= G.n || cz >= G.n) return null;
  return G.cells[cz * G.n + cx];
}

/**
 * Nearest road to (x, z) within reach. Writes {road, dist, s, seg, t} into out and returns it, or null.
 * s = arc length along the road at the closest point.
 */
export function nearestRoad(x, z, out = {}, maxDist = 30) {
  const cell = cellAt(x, z);
  if (!cell || cell.length === 0) return null;
  let best = maxDist, br = -1, bs = 0, bseg = 0, bt = 0;
  for (let k = 0; k < cell.length; k += 2) {
    const r = roads[cell[k]], i = cell[k + 1];
    const d = segDist(x, z, r.xs[i], r.zs[i], r.xs[i + 1], r.zs[i + 1], tmp) - r.half;
    if (d < best) { best = d; br = cell[k]; bseg = i; bt = tmp[0]; bs = r.cum[i] + (r.cum[i + 1] - r.cum[i]) * tmp[0]; }
  }
  if (br < 0) return null;
  out.road = roads[br]; out.dist = best + roads[br].half; out.edge = best; out.s = bs; out.seg = bseg; out.t = bt;
  return out;
}

function profileAt(r, s) {
  const f = s / r.pstep;
  const i = Math.max(0, Math.min(r.profile.length - 2, Math.floor(f)));
  const t = Math.min(1, Math.max(0, f - i));
  return r.profile[i] + (r.profile[i + 1] - r.profile[i]) * t;
}

/** Road surface height at arc length s along road r. */
export function roadHeight(r, s) { return profileAt(r, s); }

// ------------------------------------------------------------------------------------------ height
const SITES = ALL_SITES.map((s) => ({ ...s, r08: s.r * 0.8 }));

// ------------------------------------------------------------------------------------------ inland water
const RIVER = (() => {
  const r = makeRoad('W1', 'water', WATERWAYS.river.pts, WATERWAYS.river.w0, 2);
  return r;
})();
const LAKE = WATERWAYS.lake;
/** Signed distance (m) to the waterline of the lake or river: negative on the water. */
export function waterEdge(x, z) {
  const a = Math.atan2(z - LAKE.z, x - LAKE.x);
  const lr = LAKE.r * (1 + 0.16 * NC(Math.cos(a) * 1.4 + 9, Math.sin(a) * 1.4 - 5));
  const dl = Math.hypot(x - LAKE.x, z - LAKE.z) - lr;
  let dr = 1e9;
  const R = RIVER, W = WATERWAYS.river;
  for (let i = 0; i < R.xs.length - 1; i++) {
    const d = segDist(x, z, R.xs[i], R.zs[i], R.xs[i + 1], R.zs[i + 1], tmp);
    if (d - W.w1 > dr) continue;
    const sAlong = R.cum[i] + (R.cum[i + 1] - R.cum[i]) * tmp[0];
    const half = mix(W.w0, W.w1, sAlong / R.len) / 2 * (1 + 0.15 * NC(sAlong / 30, 3.3));
    if (d - half < dr) dr = d - half;
  }
  // smooth union so the river mouth opens into the lake without a notch
  const k = 10, hh = Math.max(k - Math.abs(dl - dr), 0) / k;
  return Math.min(dl, dr) - hh * hh * k * 0.25;
}

// The banks never dig into a site's core or under a pad (Downtown's street plane would float over the valley).
function waterProtect(x, z) {
  let k = 1;
  for (const s of SITES) { const d = Math.hypot(x - s.x, z - s.z); if (d < s.r) k = Math.min(k, sstep(s.r * 0.86, s.r, d)); }
  for (const P of PADS) {
    const dx = Math.max(P.x0 - x, 0, x - P.x1), dz = Math.max(P.z0 - z, 0, z - P.z1);
    k = Math.min(k, sstep(3, 24, Math.sqrt(dx * dx + dz * dz)));
  }
  return k;
}

function carveWater(x, z, h) {
  const W = TUNE.water;
  const e = waterEdge(x, z);
  if (e > W.maxBank) return h;
  let c;
  if (e <= 0) c = Math.min(h, -W.shore - (-W.bed - W.shore) * smoother01(-e / W.shelf));
  else {
    const bank = Math.min(W.maxBank, W.bank + Math.max(0, h - 1) * W.bankPerM);
    if (e >= bank) return h;
    c = Math.min(h, mix(W.shore, h, smooth01(e / bank)));
  }
  return mix(h, c, waterProtect(x, z));
}

// ------------------------------------------------------------------------------------------ free-land field
// Distance (m) from every point to the nearest site edge, road edge or waterline, sampled on a coarse grid at load
// and read bilinearly: the mountain mask.
const FREE = (() => {
  const c = TUNE.mountain.freeCell, n = Math.ceil(MAP.size / c) + 1, off = MAP.half;
  const f = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = -off + j * c;
    for (let i = 0; i < n; i++) {
      const x = -off + i * c;
      let d = 1e9;
      for (const st of SITES) { const v = Math.hypot(x - st.x, z - st.z) - st.r; if (v < d) d = v; }
      for (const r of roads) {
        for (let k = 0; k < r.xs.length - 1; k++) {
          // roads count at 1.8x distance: they may run close under high ground (cuttings), towns and water may not
          const v = (segDist(x, z, r.xs[k], r.zs[k], r.xs[k + 1], r.zs[k + 1], tmp) - r.half) * 1.8;
          if (v < d) d = v;
        }
      }
      const w = waterEdge(x, z);
      if (w < d) d = w;
      f[j * n + i] = d;
    }
  }
  return { c, n, off, f };
})();
function freeAt(x, z) {
  const F = FREE, fx = (x + F.off) / F.c, fz = (z + F.off) / F.c;
  const i = Math.max(0, Math.min(F.n - 2, Math.floor(fx))), j = Math.max(0, Math.min(F.n - 2, Math.floor(fz)));
  const tx = Math.min(1, Math.max(0, fx - i)), tz = Math.min(1, Math.max(0, fz - j));
  const a = F.f[j * F.n + i], b = F.f[j * F.n + i + 1], c = F.f[(j + 1) * F.n + i], d = F.f[(j + 1) * F.n + i + 1];
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}

/** Mountain height added at (x, z) (0 near sites, roads, water and the coast). */
function mountains(x, z, inland) {
  const M = TUNE.mountain;
  const free = freeAt(x, z);
  if (free <= M.free[0] || inland <= M.inland[0]) return 0;
  const mask = sstep(M.free[0], M.free[1], free) * sstep(M.inland[0], M.inland[1], inland);
  const r = ridged(ND, x / M.scale + 3.7, z / M.scale - 8.1, 4);
  const amp = M.amp * (0.6 + 0.4 * fbm(NA, x / 420 + 20, z / 420 - 13, 2));
  const shape = Math.pow(sstep(0.1, 0.66, r), 1.15);   // ridged() has its median near 0.28
  let hm = amp * mask * shape;
  if (hm > 4) {
    // rock bands: a terrace curve with a wandering phase, mixed into the upper slopes only
    const t = (hm + 3.2 * NC(x / 46, z / 46)) / M.terrace;
    const fl = Math.floor(t), fr = t - fl;
    const terr = M.terrace * (fl + sstep(0.6, 0.93, fr)) - 3.2 * NC(x / 46, z / 46);
    hm = mix(hm, Math.max(0, terr), M.terraceMix * sstep(6, 20, hm));
  }
  return hm;
}

function inlandDistance(x, z) {
  const r = Math.sqrt(x * x + z * z);
  const theta = Math.atan2(z, x);
  let d = coastRadius(theta) - r;
  // land guarantee around sites and roads (they always win)
  let g = -1e9;
  for (let i = 0; i < SITES.length; i++) {
    const s = SITES[i];
    const v = s.r + TUNE.landMargin - Math.hypot(x - s.x, z - s.z);
    if (v > g) g = v;
  }
  if (g < d + TUNE.coastSmooth) {
    const rr = nearestRoad(x, z, rq, 40);
    if (rr) { const v = rr.road.half + TUNE.shoulder + TUNE.landMargin - rr.dist; if (v > g) g = v; }
  }
  return smax(d, g, TUNE.coastSmooth);
}
const rq = {};

// Rocky versus sandy shore, varying around the coast.
function cliffiness(x, z) {
  const a = Math.atan2(z, x);
  return sstep(0.05, 0.45, NE(Math.cos(a) * 2.2 + 3.1, Math.sin(a) * 2.2 - 1.7));
}

function coastal(x, z, d, nat) {
  if (d <= 0) return MAP.seabed * (1 - Math.exp(d / TUNE.seabedFall));
  const cliff = cliffiness(x, z);
  const bw = MAP.beachWidth * (1 - 0.7 * cliff);
  const u = Math.min(d / bw, 1);
  const beach = TUNE.beachHeight * (1 - (1 - u) * (1 - u)) * (1 + cliff * 1.5);
  const k = sstep(bw * 0.5, bw + 110 - 70 * cliff, d);
  return mix(beach, nat, k);
}

function signalHill(x, z, h) {
  const dx = x - SIGNAL.x, dz = z - SIGNAL.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const a = Math.atan2(dz, dx);
  const R = TUNE.hill.radius * (1 + 0.28 * NA(Math.cos(a) * 1.3 + 7, Math.sin(a) * 1.3 - 2));
  if (d > SIGNAL.r + R) return h;
  const t = d <= SIGNAL.r ? 1 : 1 - (d - SIGNAL.r) / R;
  const p = smoother01(t);
  const top = SIGNAL.h - TUNE.hill.crest;
  const spur = ridged(NB, x / 55, z / 55, 2) - 0.4;
  return Math.max(h, mix(h, top, p) + spur * 16 * p * (1 - p));
}

// Rectangular pads held flat at a site's height: Fort Kessler's yard (TUNE.kesslerPad) and every site with a
// `pad` {w, d, blend} centred on it (Downtown). Inside: exactly the pad height; out to `blend`: an eased ramp back
// to the land; beyond that a wide, noisy pull (4x blend) so the pad sits in the hills instead of on a plinth.
const PADS = (() => {
  const k = TUNE.kesslerPad, out = [{ ...k, h: siteById('kessler').h }];
  for (const s of ALL_SITES) if (s.pad) out.push({ x0: s.x - s.pad.w / 2, x1: s.x + s.pad.w / 2, z0: s.z - s.pad.d / 2, z1: s.z + s.pad.d / 2, blend: s.pad.blend, h: s.h });
  return out;
})();
function rectFlatten(x, z, h) {
  for (const P of PADS) {
    const dx = Math.max(P.x0 - x, 0, x - P.x1), dz = Math.max(P.z0 - z, 0, z - P.z1);
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d <= 0) { h = P.h; continue; }
    const sig = P.blend * 1.6 * (1 + 0.3 * NC(x / 70, z / 70));
    if (d > sig * 3) continue;
    const u = d / sig;
    h = mix(h, P.h, Math.exp(-u * u * 1.4));
  }
  return h;
}

// Each site holds its height across its core (0.9 r, wavy) and lets go of it with a Gaussian tail, so there is no
// edge anywhere: the land eases into the town over roughly another radius instead of meeting a ring or a step.
function siteBlend(x, z, h) {
  for (let i = 0; i < SITES.length; i++) {
    const s = SITES[i];
    const dx = x - s.x, dz = z - s.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > s.r * 2.4) continue;
    const a = Math.atan2(dz, dx), ca = Math.cos(a), sa = Math.sin(a);
    const rin = s.r * 0.9 * (1 + 0.05 * NC(ca * 2 + i * 3.1, sa * 2 - i));
    if (d <= rin) { h = s.h; continue; }
    const sig = s.r * 0.58 * (1 + 0.3 * NC(ca * 1.6 - i * 1.7, sa * 1.6 + i * 2.3));
    const u = (d - rin) / sig;
    h = mix(h, s.h, Math.exp(-u * u * 1.4));
  }
  return h;
}

// (superseded by siteBlend; kept for reference by tests)
function siteApproach(x, z, h) {
  for (let i = 0; i < SITES.length; i++) {
    const s = SITES[i];
    const dx = x - s.x, dz = z - s.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const R = s.r * (1.85 + 0.4 * NC(dx / 90 + i * 3.1, dz / 90 - i));
    if (d >= R) continue;
    const t = d <= s.r ? 1 : smoother01((R - d) / (R - s.r));
    h = mix(h, s.h, 0.66 * t);
  }
  return h;
}

function siteDiscs(x, z, h) {
  for (let i = 0; i < SITES.length; i++) {
    const s = SITES[i];
    const dx = x - s.x, dz = z - s.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= s.r * s.r) continue;
    const d = Math.sqrt(d2);
    const t = d <= s.r08 ? 1 : smoother01((s.r - d) / (s.r - s.r08));
    h = mix(h, s.h, t);
  }
  return h;
}

/** Greystone pit depth profile at distance d from the centre (absolute height). */
function pitHeight(x, z, d, h) {
  const faces = TUNE.pit.faces;
  if (d >= faces[0][0] + 1) return h;
  const a = Math.atan2(z - GREY.z, x - GREY.x);
  const wob = 1.6 + 1.1 * NA(Math.cos(a) * 2.4 + 40, Math.sin(a) * 2.4) + 0.5 * NC(Math.cos(a) * 6 - 3, Math.sin(a) * 6);
  const dd = d + Math.max(0, wob);
  const top = GREY.h, floor = GREY.pitFloor;
  const step = (top - floor) / faces.length;
  let y = top;
  for (let k = 0; k < faces.length; k++) {
    const [ro, ri] = faces[k];
    if (dd < ro) y = top - step * k - step * smoother01((ro - dd) / (ro - ri));
  }
  if (dd < faces[faces.length - 1][1]) y = floor + TUNE.pit.floorNoise * NC(x / 9, z / 9);
  // the rim lip blends into the plateau
  const lip = sstep(faces[0][0] - 0.5, faces[0][0] + 1, d);
  return mix(Math.min(y, h), h, lip);
}

function harbour(x, z, h) {
  const B = MAP.harbor, T = TUNE.harbour;
  const ex = Math.max(B.x0 - x, 0, x - B.x1);
  if (ex >= T.taper || z < B.z - 1) return h;
  const wx = 1 - smoother01(ex / T.taper);
  const zEdge = B.z + 0.4 + (1 - wx) * 30;
  const wz = ex <= 0 ? (z > B.z + 0.4 ? 1 : 0) : sstep(B.z + 0.4, zEdge, z);
  return mix(h, Math.min(h, T.depth), wx * wz);
}

/** Terrain height before road corridors are applied (noPit skips the quarry carve, for road profiles). */
export function heightPre(x, z, noPit = false) {
  const d = inlandDistance(x, z);
  const nat = natural(x, z, d);
  let h = coastal(x, z, d, nat);
  if (d > 0) h += mountains(x, z, d);
  h = signalHill(x, z, h);
  h = rectFlatten(x, z, h);
  h = siteBlend(x, z, h);
  if (!noPit) {
    const gd = Math.hypot(x - GREY.x, z - GREY.z);
    if (gd < 66) h = pitHeight(x, z, gd, h);
  }
  if (z > MAP.harbor.z - 2 && x > MAP.harbor.x0 - 40 && x < MAP.harbor.x1 + 40) h = harbour(x, z, h);
  h = carveWater(x, z, h);
  return h;
}

// Road profiles: dense samples of the pre-road terrain, grade-limited and Gaussian-smoothed along the road.
// Endpoints inside a site disc are pinned to the site height; endpoints on an earlier road are pinned to that road's
// profile so junctions meet without a step. Asphalt roads are profiled first, then dirt tracks.
function sampleRoadPoint(r, s, out) {
  let seg = 0;
  while (seg < r.cum.length - 2 && r.cum[seg + 1] < s) seg++;
  const t = (s - r.cum[seg]) / Math.max(1e-6, r.cum[seg + 1] - r.cum[seg]);
  out[0] = r.xs[seg] + (r.xs[seg + 1] - r.xs[seg]) * t;
  out[1] = r.zs[seg] + (r.zs[seg + 1] - r.zs[seg]) * t;
  return out;
}

function endPin(r, end, done) {
  const x = end ? r.xs[r.xs.length - 1] : r.xs[0], z = end ? r.zs[r.zs.length - 1] : r.zs[0];
  if (Math.hypot(x - GREY.x, z - GREY.z) < TUNE.pit.faces[0][0]) return TUNE.ramp.top;
  for (const s of SITES) if (Math.hypot(x - s.x, z - s.z) <= s.r08) return s.h;
  let best = null, bd = 6;
  for (const o of done) {
    for (let i = 0; i < o.xs.length - 1; i++) {
      const d = segDist(x, z, o.xs[i], o.zs[i], o.xs[i + 1], o.zs[i + 1], tmp);
      if (d < bd) { bd = d; best = profileAt(o, o.cum[i] + (o.cum[i + 1] - o.cum[i]) * tmp[0]); }
    }
  }
  return best != null ? best : heightPre(x, z, true);
}

function limitGrade(p, maxStep, pins) {
  const n = p.length;
  for (let it = 0; it < 80; it++) {
    for (const [i, h] of pins) p[i] = h;
    for (let k = 1; k < n; k++) { const lo = p[k - 1] - maxStep, hi = p[k - 1] + maxStep; if (p[k] < lo) p[k] = lo; else if (p[k] > hi) p[k] = hi; }
    for (const [i, h] of pins) p[i] = h;
    for (let k = n - 2; k >= 0; k--) { const lo = p[k + 1] - maxStep, hi = p[k + 1] + maxStep; if (p[k] < lo) p[k] = lo; else if (p[k] > hi) p[k] = hi; }
  }
  for (const [i, h] of pins) p[i] = h;
}

function gaussian(src, sig) {
  const n = src.length, rad = Math.ceil(sig * 2.5), out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let sw = 0, sh = 0;
    for (let j = -rad; j <= rad; j++) {
      const kk = Math.min(n - 1, Math.max(0, k + j));
      const w = Math.exp(-(j * j) / (2 * sig * sig));
      sw += w; sh += w * src[kk];
    }
    out[k] = sh / sw;
  }
  return out;
}

function pinBlend(p, idx, h, over, step) {
  const n = p.length, delta = h - p[idx];
  for (let k = 0; k < n; k++) {
    const d = Math.abs(k - idx) * step;
    if (d > over) continue;
    p[k] += delta * smoother01(1 - d / over);
  }
}

(function buildProfiles() {
  const step = TUNE.profileStep;
  const pt = [0, 0];
  const done = [];
  const order = [...roads.filter((r) => r.type === 'asphalt'), ...roads.filter((r) => r.type === 'dirt' && r !== ramp)];
  for (const r of order) {
    const n = Math.max(2, Math.ceil(r.len / step) + 1);
    const st = r.len / (n - 1);
    r.pstep = st;
    let p = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      sampleRoadPoint(r, Math.min(r.len, k * st), pt);
      p[k] = heightPre(pt[0], pt[1], true);
    }
    const pins = [];
    const h0 = endPin(r, false, done), h1 = endPin(r, true, done);
    if (h0 != null) pins.push([0, h0]);
    if (h1 != null) pins.push([n - 1, h1]);
    p = gaussian(p, (TUNE.profileSigma[r.type] || 12) / st);
    limitGrade(p, TUNE.maxGrade[r.type] * st, pins);
    p = gaussian(p, 2.2);
    for (const [i, h] of pins) pinBlend(p, i, h, 18, st);
    r.profile = p;
    done.push(r);
  }
  // The haul ramp has an explicit linear grade from the R2 end down to the pit floor.
  const n = Math.max(2, Math.ceil(ramp.len / step) + 1);
  ramp.pstep = ramp.len / (n - 1);
  ramp.profile = new Float32Array(n);
  for (let k = 0; k < n; k++) ramp.profile[k] = mix(TUNE.ramp.top, GREY.pitFloor + 0.2, k / (n - 1));
})();

const rr2 = {};
/** Terrain height at (x, z), metres above sea level. Analytic and cheap. */
export function heightAt(x, z) {
  let h = heightPre(x, z);
  const cell = cellAt(x, z);
  if (!cell || cell.length === 0) return h;
  // apply every road corridor that reaches this point (the strongest wins where they overlap)
  // Each road sits on a level verge, then a bank (embankment or cutting) at a fixed ratio down or up to the land.
  let bestW = 0, bestH = h, bestD = 0, bestR = null;
  for (let k = 0; k < cell.length; k += 2) {
    const r = roads[cell[k]], i = cell[k + 1];
    const d = segDist(x, z, r.xs[i], r.zs[i], r.xs[i + 1], r.zs[i + 1], tmp);
    const flat = r.half + TUNE.flatShoulder;
    if (d >= flat + TUNE.maxBlend) continue;
    const s = r.cum[i] + (r.cum[i + 1] - r.cum[i]) * tmp[0];
    const rh = profileAt(r, s);
    const blend = Math.min(TUNE.maxBlend, TUNE.talusBase + Math.abs(h - rh) * TUNE.talusPerM);
    if (d >= flat + blend) continue;
    const w = d <= flat ? 1 : 1 - smooth01((d - flat) / blend);
    if (w > bestW + 1e-6 || (w >= 0.999 && bestW >= 0.999 && r.type === 'asphalt')) { bestW = w; bestH = rh; bestD = d; bestR = r; }
  }
  if (bestW <= 0) return h;
  let out = mix(h, bestH, bestW);
  // drainage ditch beside asphalt where the land is level with or above the road (never in towns)
  if (bestR.type === 'asphalt' && h > bestH - 0.3) {
    const D = TUNE.ditch, u = (bestD - bestR.half - TUNE.flatShoulder - D.at) / D.w;
    if (u > -3 && u < 3 && !SITES.some((st) => Math.hypot(x - st.x, z - st.z) < st.r + 12)) {
      out -= D.depth * sstep(-0.3, 0.5, h - bestH) * Math.exp(-u * u);
    }
  }
  return out;
}

/** Surface normal by central differences, written into out ([x,y,z] array or {x,y,z}). */
export function normalAt(x, z, out = [0, 1, 0], e = 0.5) {
  const hx = heightAt(x + e, z) - heightAt(x - e, z);
  const hz = heightAt(x, z + e) - heightAt(x, z - e);
  let nx = -hx, ny = 2 * e, nz = -hz;
  const l = Math.hypot(nx, ny, nz);
  nx /= l; ny /= l; nz /= l;
  if (Array.isArray(out)) { out[0] = nx; out[1] = ny; out[2] = nz; } else { out.x = nx; out.y = ny; out.z = nz; }
  return out;
}

export const isWaterAt = (x, z) => heightAt(x, z) < MAP.seaLevel;

// ------------------------------------------------------------------------------------------ forests and paint
const FOREST_DISCS = FORESTS.map(([x, z, r]) => ({ x, z, r }));

/** Forest density 0..1 (1 deep inside a FORESTS disc), with noisy edges. */
export function forestAt(x, z) {
  let f = 0;
  const n = 0.18 * NE(x / 55, z / 55);
  for (const d of FOREST_DISCS) {
    const k = Math.hypot(x - d.x, z - d.z) / d.r + n;
    if (k < 1.15) f = Math.max(f, 1 - sstep(0.7, 1.15, k));
  }
  return f;
}

/**
 * Paint primitives: {shape:'disc'|'rect', ch:0..3, x, z, r | hw, hd, c, s, edge, w, noise}
 *   ch 0 = dirt/gravel, 1 = straw/dry grass, 2 = forest floor (extra), 3 = mud/ploughed.
 * Added by the world layout (yards, fields, trampled ground around buildings) before the control map is baked.
 */
const paints = [];
const PB = { cell: 64, n: Math.ceil((MAP.size + 128) / 64), off: MAP.half + 64, bins: null };

export function addPaint(p) {
  const prim = { shape: 'disc', ch: 0, x: 0, z: 0, r: 5, hw: 1, hd: 1, c: 1, s: 0, edge: 2, w: 1, noise: 0.35, ...p };
  if (prim.shape === 'rect' && p.rot != null) { prim.c = Math.cos(p.rot); prim.s = Math.sin(p.rot); }
  paints.push(prim);
  PB.bins = null;
  return prim;
}
export const paintList = () => paints;

function binPaints() {
  PB.bins = Array.from({ length: PB.n * PB.n }, () => []);
  paints.forEach((p, idx) => {
    const ext = (p.shape === 'disc' ? p.r : Math.hypot(p.hw, p.hd)) + p.edge + 4;
    const cx0 = Math.max(0, Math.floor((p.x - ext + PB.off) / PB.cell)), cx1 = Math.min(PB.n - 1, Math.floor((p.x + ext + PB.off) / PB.cell));
    const cz0 = Math.max(0, Math.floor((p.z - ext + PB.off) / PB.cell)), cz1 = Math.min(PB.n - 1, Math.floor((p.z + ext + PB.off) / PB.cell));
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) PB.bins[cz * PB.n + cx].push(idx);
  });
}

const rp = {};
/**
 * Ground paint weights at (x, z) into out[0..3] (dirt, straw, forest, mud), each 0..1.
 * Also returns roadEdge (distance outside the asphalt edge, negative on the asphalt) in out[4].
 */
export function paintAt(x, z, out = new Float32Array(5)) {
  out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0; out[4] = 1e9;
  const nz = NE(x / 7.5, z / 7.5) * 0.6 + NE(x / 2.3, z / 2.3) * 0.4;
  // roads: dirt tracks are painted; asphalt gets a gravel shoulder (the asphalt itself is a ribbon mesh)
  const r = nearestRoad(x, z, rp, 20);
  if (r) {
    const edge = r.edge;
    if (r.road.type === 'asphalt') {
      out[4] = edge;
      const sh = 1 - sstep(0.6 + nz * 0.5, 2.6 + nz * 0.8, edge);
      out[0] = Math.max(out[0], sh * 0.95);
    } else {
      const core = 1 - sstep(-0.6 + nz * 0.9, 1.4 + nz * 0.9, edge);
      out[0] = Math.max(out[0], core);
      // wheel ruts read as mud
      const lat = Math.abs(r.dist);
      const rut = Math.exp(-Math.pow((lat - r.road.half * 0.42) / 0.35, 2)) * (1 - sstep(-0.5, 0.5, edge));
      out[3] = Math.max(out[3], rut * 0.65);
    }
  }
  // forests
  const f = forestAt(x, z);
  if (f > 0) out[2] = Math.max(out[2], sstep(0.15, 0.75, f + nz * 0.15));
  // painted primitives
  if (paints.length) {
    if (!PB.bins) binPaints();
    const cx = Math.floor((x + PB.off) / PB.cell), cz = Math.floor((z + PB.off) / PB.cell);
    if (cx >= 0 && cz >= 0 && cx < PB.n && cz < PB.n) {
      const bin = PB.bins[cz * PB.n + cx];
      for (let k = 0; k < bin.length; k++) {
        const p = paints[bin[k]];
        let d;
        if (p.shape === 'disc') d = Math.hypot(x - p.x, z - p.z) - p.r;
        else {
          const lx = (x - p.x) * p.c + (z - p.z) * p.s, lz = -(x - p.x) * p.s + (z - p.z) * p.c;
          const qx = Math.abs(lx) - p.hw, qz = Math.abs(lz) - p.hd;
          d = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
        }
        d += nz * p.noise * p.edge;
        if (d >= p.edge) continue;
        const w = (1 - sstep(-p.edge * 0.5, p.edge, d)) * p.w;
        if (w > out[p.ch]) out[p.ch] = w;
      }
    }
  }
  return out;
}

const pw = new Float32Array(5);
const nrm = [0, 1, 0];
/** Terrain surface type (config SURFACE id) at (x, z). Static geometry surfaces come from the collision BVH. */
export function surfaceAt(x, z) {
  const h = heightAt(x, z);
  if (h < -0.35) return SURFACE.WATER;
  paintAt(x, z, pw);
  if (pw[4] < 0.05) return SURFACE.ASPHALT;
  normalAt(x, z, nrm, 0.8);
  if (nrm[1] < TUNE.rockSlope) return SURFACE.ROCK;
  const gd = Math.hypot(x - GREY.x, z - GREY.z);
  if (gd < TUNE.pit.faces[0][0] + 1) return nrm[1] < TUNE.pit.rockNy ? SURFACE.ROCK : SURFACE.DIRT;
  if (pw[0] > 0.45 || pw[3] > 0.5) return SURFACE.DIRT;
  if (h < TUNE.beachHeight + 0.4 && sandiness(x, z) > 0.5) return SURFACE.SAND;
  return SURFACE.GRASS;
}

/** Sand weight from height above sea level (shared rule with the splat shader). */
export function sandiness(x, z, h = heightAt(x, z)) {
  return 1 - sstep(TUNE.beachHeight - 0.2, TUNE.beachHeight + 0.6, h);
}

/** True if (x, z) is on a road corridor (asphalt or dirt core plus the shoulder). */
export function onRoad(x, z, extra = 0) {
  const r = nearestRoad(x, z, rp, 20);
  return !!r && r.edge < TUNE.shoulder * 0.5 + extra;
}

export const quarry = { x: GREY.x, z: GREY.z, rim: TUNE.pit.faces[0][0], floor: GREY.pitFloor, floorR: TUNE.pit.faces[TUNE.pit.faces.length - 1][1] };
export const harbourDef = { ...MAP.harbor, depth: TUNE.harbour.depth, siteH: PORT.h };
