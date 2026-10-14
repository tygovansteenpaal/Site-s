// ZONEFALL - deterministic site layout for Kessler Isle. OWNER: WORLD (internal). Pure: no three.js, no DOM.
// Places every building, wall, slab, fence, prop and crate from core/mapdata.js with MAP.seed, so the same island
// (and the same loot spawn points) comes out on every peer. Harrow and the roadside houses use a street-front
// placer that walks the roads and faces buildings onto them; the other sites are hand-composed around their
// centres and checked against road corridors. Ground paint (yards, fields, trampled ground) is registered here.
import { MAP, POIS, LANDMARKS, ALL_SITES, ROADSIDE, siteById } from '../core/mapdata.js';
import { Rng, mixSeed, hashString } from '../core/rng.js';
import { heightAt, nearestRoad, roads, addPaint, onRoad, forestAt } from './heightfield.js';

export const TUNE = {
  setback: 3.2,               // front-yard depth between road shoulder and facade
  buildingGap: 3.0,
  roadClear: 2.5,             // extra clearance from a road edge to any footprint corner
  roadsideMinSpacing: 110,
};

const rngFor = (label) => new Rng(mixSeed(MAP.seed, hashString(label)));

/** Footprint polygon (4 corners) of a rectangle centred at (x, z) with yaw (three.js convention). */
export function corners(x, z, w, d, yaw, pad = 0) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const hw = w / 2 + pad, hd = d / 2 + pad;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([lx, lz]) => [x + lx * c + lz * s, z - lx * s + lz * c]);
}

function obbOverlap(a, b) {
  const A = corners(a.x, a.z, a.w, a.d, a.yaw, a.pad || 0), B = corners(b.x, b.z, b.w, b.d, b.yaw, b.pad || 0);
  for (const poly of [A, B]) {
    for (let i = 0; i < 4; i++) {
      const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % 4];
      const nx = z2 - z1, nz = x1 - x2;
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (const [x, z] of A) { const p = x * nx + z * nz; amin = Math.min(amin, p); amax = Math.max(amax, p); }
      for (const [x, z] of B) { const p = x * nx + z * nz; bmin = Math.min(bmin, p); bmax = Math.max(bmax, p); }
      if (amax < bmin || bmax < amin) return false;
    }
  }
  return true;
}

const rq = {};
function clearOfRoads(x, z, w, d, yaw, clear = TUNE.roadClear) {
  const pts = corners(x, z, w, d, yaw);
  pts.push([x, z]);
  for (let i = 0; i < 4; i++) pts.push([(pts[i][0] + pts[(i + 1) % 4][0]) / 2, (pts[i][1] + pts[(i + 1) % 4][1]) / 2]);
  for (const [px, pz] of pts) {
    const r = nearestRoad(px, pz, rq, 40);
    if (r && r.edge < 3 + clear) return false;
  }
  return true;
}

/** Yaw that turns a building's local +Z (its front) toward world direction (dx, dz). */
export const yawFacing = (dx, dz) => Math.atan2(dx, dz);

function roadPoint(r, s) {
  s = Math.max(0, Math.min(r.len, s));
  let i = 0;
  while (i < r.cum.length - 2 && r.cum[i + 1] < s) i++;
  const t = (s - r.cum[i]) / Math.max(1e-6, r.cum[i + 1] - r.cum[i]);
  const x = r.xs[i] + (r.xs[i + 1] - r.xs[i]) * t, z = r.zs[i] + (r.zs[i + 1] - r.zs[i]) * t;
  let tx = r.xs[i + 1] - r.xs[i], tz = r.zs[i + 1] - r.zs[i];
  const l = Math.hypot(tx, tz) || 1;
  return { x, z, tx: tx / l, tz: tz / l };
}

function closestS(r, x, z) {
  let best = Infinity, bs = 0;
  for (let i = 0; i < r.xs.length - 1; i++) {
    const ax = r.xs[i], az = r.zs[i], ex = r.xs[i + 1] - ax, ez = r.zs[i + 1] - az;
    const l2 = ex * ex + ez * ez;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
    const d = Math.hypot(ax + ex * t - x, az + ez * t - z);
    if (d < best) { best = d; bs = r.cum[i] + Math.sqrt(l2) * t; }
  }
  return { s: bs, d: best };
}

// ------------------------------------------------------------------------------------------ layout container
function createLayout() {
  return {
    buildings: [],   // {id, site, kind, x, z, yaw, w, d, storeys, variant, seed}
    walls: [],       // perimeter walls: {kind:'twall', pts:[[x,z],...], gates:[{x,z,w}], site}
    slabs: [],       // paved pads: {x, z, w, d, yaw, y, site, kind:'concrete'|'helipad'|'panels'}
    fences: [],      // {pts:[[x,z]...], kind:'wood'|'wire'}
    props: [],       // {key, x, z, yaw, site, y?, s?}
    crates: [],      // {x, z, yaw, site, tier}
    outdoor: [],     // outdoor loot/cover candidates {x, z, site}
    poles: [],       // power poles {x, z, yaw}
    special: [],     // site set pieces: {kind, ...}
    footprints: [],  // for the map image {x, z, w, d, rot, round}
  };
}

function addBuilding(L, b) {
  const id = `${b.site || 'road'}:${b.kind}:${L.buildings.length}`;
  const rec = { storeys: 1, variant: 0, ...b, id, seed: mixSeed(MAP.seed, hashString(id)) };
  L.buildings.push(rec);
  L.footprints.push({ x: rec.x, z: rec.z, w: rec.w, d: rec.d, rot: rec.yaw, round: !!rec.round });
  // trampled ground around every building grounds it in the terrain
  addPaint({ shape: 'rect', ch: 0, x: rec.x, z: rec.z, hw: rec.w / 2 + 1.2, hd: rec.d / 2 + 1.2, rot: rec.yaw, edge: 2.2, w: 0.45, noise: 0.6 });
  return rec;
}

function fits(L, b, extra = TUNE.buildingGap) {
  for (const o of L.buildings) if (obbOverlap({ ...b, pad: extra / 2 }, { ...o, pad: extra / 2 })) return false;
  for (const s of L.slabs) if (s.block && obbOverlap({ ...b, pad: 0.5 }, { ...s, pad: 0.5 })) return false;
  return true;
}

// ------------------------------------------------------------------------------------------ street placer (Harrow, roadside)
/**
 * Walk the given roads outward from (cx, cz) and offer street-front slots on both sides.
 * @returns {Array<{x, z, yaw, dist}>} candidate centres for a building of size (w, d)
 */
function streetSlots(site, roadIds, w, d, spacing, maxR) {
  const out = [];
  for (const id of roadIds) {
    const r = roads.find((q) => q.id === id);
    if (!r) continue;
    const c = closestS(r, site.x, site.z);
    for (const dir of [1, -1]) {
      for (let k = 0; k < 40; k++) {
        const s = c.s + dir * (10 + k * spacing);
        if (s < 0 || s > r.len) break;
        const p = roadPoint(r, s);
        const dist = Math.hypot(p.x - site.x, p.z - site.z);
        if (dist > maxR) break;
        for (const side of [1, -1]) {
          const nx = -p.tz * side, nz = p.tx * side;   // left (side 1) / right (side -1) of travel
          const off = r.half + 3 + TUNE.setback + d / 2;
          const x = p.x + nx * off, z = p.z + nz * off;
          out.push({ x, z, yaw: yawFacing(-nx, -nz), dist: Math.hypot(x - site.x, z - site.z) });
        }
      }
    }
  }
  return out;
}

function placeStreet(L, site, kind, sizeFn, count, roadIds, rng, opts = {}) {
  let placed = 0;
  for (let attempt = 0; attempt < count * 6 && placed < count; attempt++) {
    const { w, d, storeys, variant } = sizeFn(rng);
    let slots = streetSlots(site, roadIds, w, d, opts.spacing || 7, opts.maxR || site.r * 0.8);
    slots = slots.filter((sl) => sl.dist + Math.hypot(w, d) / 2 < (opts.maxR || site.r * 0.8) && sl.dist > (opts.minR || 0));
    if (opts.near) slots.sort((a, b) => a.dist - b.dist);
    else { for (const sl of slots) sl.key = sl.dist + rng.next() * 38; slots.sort((a, b) => a.key - b.key); }
    let ok = false;
    for (const sl of slots) {
      const b = { site: site.id, kind, x: sl.x, z: sl.z, yaw: sl.yaw, w, d, storeys, variant };
      if (!fits(L, b) || !clearOfRoads(b.x, b.z, w, d, b.yaw)) continue;
      addBuilding(L, b);
      placed++; ok = true;
      break;
    }
    if (!ok && !opts.near) break;
  }
  return placed;
}

// ------------------------------------------------------------------------------------------ sites
const HOUSE = (rng) => ({ w: 8 + Math.round(rng.range(0, 3)), d: 7 + Math.round(rng.range(0, 2)), storeys: 2, variant: rng.int(0, 5) });
const SHOP = (rng) => ({ w: 10 + Math.round(rng.range(0, 2)), d: 9, storeys: 1, variant: rng.int(0, 3) });

function harrow(L) {
  const s = siteById('harrow');
  const rng = rngFor('harrow');
  // central square: paved, with the church on its north-east corner
  L.slabs.push({ site: s.id, kind: 'panels', x: s.x + 22, z: s.z - 20, w: 24, d: 22, yaw: 0.38, block: true, panel: 4 });
  const cy = 0.38;
  const ch = { site: s.id, kind: 'church', x: s.x + 40, z: s.z - 42, yaw: cy + Math.PI * 0.75, w: 10, d: 20, storeys: 1 };
  if (fits(L, ch) && clearOfRoads(ch.x, ch.z, ch.w, ch.d + 5, ch.yaw)) addBuilding(L, ch);
  else placeStreet(L, s, 'church', () => ({ w: 10, d: 20, storeys: 1, variant: 0 }), 1, ['R3', 'R2'], rng, { near: true, minR: 30 });
  placeStreet(L, s, 'shop', SHOP, 4, ['R2', 'R1', 'R3'], rng, { near: true, spacing: 6 });
  placeStreet(L, s, 'house', HOUSE, 12, ['R2', 'R1', 'R3'], rng, { spacing: 6 });
  // a second row of houses behind the street fronts if the streets filled up
  const houses = L.buildings.filter((b) => b.site === s.id && b.kind === 'house').length;
  if (houses < 12) {
    for (let a = 0; a < 200 && L.buildings.filter((b) => b.site === s.id && b.kind === 'house').length < 12; a++) {
      const [x, z] = rng.inDisc(s.x, s.z, s.r * 0.72);
      const sz = HOUSE(rng);
      const r = nearestRoad(x, z, rq, 80);
      const yaw = r ? yawFacing(r.road.xs[r.seg] - x, r.road.zs[r.seg] - z) : rng.range(0, Math.PI * 2);
      const b = { site: s.id, kind: 'house', x, z, yaw, ...sz };
      if (fits(L, b, 5) && clearOfRoads(x, z, b.w, b.d, yaw, 4)) addBuilding(L, b);
    }
  }
  // street furniture
  for (const b of L.buildings.filter((q) => q.site === s.id)) {
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
    if (b.kind === 'house' && rng.chance(0.55)) {
      const side = rng.chance(0.5) ? 1 : -1;
      const ox = Math.cos(b.yaw) * side, oz = -Math.sin(b.yaw) * side;
      L.props.push({ key: 'covered_car', x: b.x + fx * (b.d / 2 + 2.2) + ox * (b.w / 2 + 2.6), z: b.z + fz * (b.d / 2 + 2.2) + oz * (b.w / 2 + 2.6), yaw: b.yaw + Math.PI / 2 + rng.range(-0.15, 0.15), site: s.id });
    }
    if (b.kind === 'shop') {
      L.props.push({ key: 'utility_box', x: b.x + fx * (b.d / 2 + 1.4) + Math.cos(b.yaw) * (b.w / 2 - 0.8), z: b.z + fz * (b.d / 2 + 1.4) - Math.sin(b.yaw) * (b.w / 2 - 0.8), yaw: b.yaw, site: s.id });
      L.props.push({ key: 'cardboard_box', x: b.x - fx * (b.d / 2 + 1.0), z: b.z - fz * (b.d / 2 + 1.0), yaw: rng.range(0, 6), site: s.id });
    }
    L.outdoor.push({ x: b.x + fx * (b.d / 2 + 1.6), z: b.z + fz * (b.d / 2 + 1.6), site: s.id });
  }
  crateSpots(L, s, 3, rng);
}

function millbrook(L) {
  const s = siteById('millbrook');
  const rng = rngFor('millbrook');
  const P = (dx, dz) => [s.x + dx, s.z + dz];
  const put = (kind, dx, dz, yaw, w, d, storeys = 1, extra = {}) => {
    const [x, z] = P(dx, dz);
    const b = { site: s.id, kind, x, z, yaw, w, d, storeys, ...extra };
    if (fits(L, b, 2) && clearOfRoads(x, z, w, d, yaw, 1)) return addBuilding(L, b);
    // nudge outward along the radius until it fits
    for (let k = 1; k < 12; k++) {
      const f = 1 + k * 0.08;
      const b2 = { ...b, x: s.x + dx * f, z: s.z + dz * f };
      if (fits(L, b2, 2) && clearOfRoads(b2.x, b2.z, w, d, yaw, 1)) return addBuilding(L, b2);
    }
    return null;
  };
  put('farmhouse', -4, 26, Math.PI, 12, 9, 2);
  put('barn', -36, 2, 0, 12, 20, 1);
  put('shed', 26, 26, -0.35, 7, 9, 1);
  put('shed', 34, 12, -0.25, 6, 8, 1);
  put('silo', -21, 19, 0, 6.4, 6.4, 1, { round: true });
  put('silo', -29, 25, 0, 6.4, 6.4, 1, { round: true });
  // farmyard and fields
  addPaint({ shape: 'disc', ch: 3, x: s.x - 6, z: s.z + 4, r: 22, edge: 8, w: 0.55, noise: 0.8 });
  addPaint({ shape: 'disc', ch: 0, x: s.x - 10, z: s.z + 2, r: 16, edge: 6, w: 0.6, noise: 0.8 });
  const fields = [[46, 58, 34, 22, 0.12, 3], [-62, 52, 26, 24, -0.08, 1], [70, -10, 22, 30, 0.2, 1], [-70, -46, 24, 20, 0.3, 3]];
  for (const [dx, dz, hw, hd, rot, ch] of fields) {
    const [x, z] = P(dx, dz);
    addPaint({ shape: 'rect', ch, x, z, hw, hd, rot, edge: 1.5, w: ch === 3 ? 0.9 : 0.85, noise: 0.25 });
    // fence the ploughed fields
    if (ch === 3) {
      const c = corners(x, z, hw * 2 + 2, hd * 2 + 2, rot);
      const fpts = [c[0], c[1], c[2], c[3], c[0]].filter((p) => !onRoad(p[0], p[1], 2));
      if (fpts.length >= 2) L.fences.push({ pts: fpts, kind: 'wood', site: s.id });
    }
  }
  L.props.push({ key: 'tyre', x: s.x + 8, z: s.z + 14, yaw: 0, site: s.id }, { key: 'tyre', x: s.x + 9.2, z: s.z + 14.5, yaw: 1, site: s.id });
  L.props.push({ key: 'barrel_blue', x: s.x - 28, z: s.z + 14, yaw: 0, site: s.id }, { key: 'barrel_blue', x: s.x - 27.2, z: s.z + 14.9, yaw: 0.5, site: s.id });
  L.props.push({ key: 'jerrycan', x: s.x + 22, z: s.z + 20, yaw: 0.4, site: s.id });
  L.outdoor.push({ x: s.x - 20, z: s.z + 10, site: s.id }, { x: s.x + 14, z: s.z + 16, site: s.id }, { x: s.x - 30, z: s.z - 14, site: s.id });
  crateSpots(L, s, 2, rng);
}

function kessler(L) {
  const s = siteById('kessler');
  const W = s.wall;
  const rng = rngFor('kessler');
  // perimeter T-wall with the two gates
  L.walls.push({ kind: 'twall', site: s.id, pts: [[W.x0, W.z0], [W.x1, W.z0], [W.x1, W.z1], [W.x0, W.z1], [W.x0, W.z0]], gates: W.gates.map(([x, z]) => ({ x, z, w: 9 })), h: 3.6 });
  addPaint({ shape: 'rect', ch: 0, x: (W.x0 + W.x1) / 2, z: (W.z0 + W.z1) / 2, hw: (W.x1 - W.x0) / 2 - 2, hd: (W.z1 - W.z0) / 2 - 2, edge: 3, w: 0.62, noise: 0.9 });
  const add = (kind, x, z, yaw, w, d, storeys = 1, extra = {}) => addBuilding(L, { site: s.id, kind, x, z, yaw, w, d, storeys, ...extra });
  add('barracks', 192, -302, 0, 26, 8);
  add('barracks', 192, -280, 0, 26, 8);
  add('barracks', 192, -258, 0, 26, 8);
  add('hangar', 300, -214, 0, 24, 30);
  add('command', 252, -262, Math.PI, 12, 10, 2);
  add('watchtower', W.x0 + 7, W.z0 + 7, Math.PI * 0.75, 3.2, 3.2);
  add('watchtower', W.x1 - 7, W.z0 + 7, -Math.PI * 0.75, 3.2, 3.2);
  add('watchtower', W.x1 - 7, W.z1 - 7, -Math.PI * 0.25, 3.2, 3.2);
  add('watchtower', W.x0 + 7, W.z1 - 7, Math.PI * 0.25, 3.2, 3.2);
  // container stacks: [x, z, yaw, layout]
  const stacks = [[215, -196, 0, 'L'], [176, -214, Math.PI / 2, 'row'], [262, -312, 0, 'row'], [318, -306, 0.0, 'L'], [232, -322, 0, 'single'], [322, -268, Math.PI / 2, 'row']];
  stacks.forEach(([x, z, yaw, kind], i) => L.special.push({ kind: 'containers', site: s.id, x, z, yaw, layout: kind, seed: 900 + i }));
  stacks.forEach(([x, z, yaw]) => L.footprints.push({ x, z, w: 7, d: 6, rot: yaw }));
  // paved: hangar apron, parade ground, helipad
  L.slabs.push({ site: s.id, kind: 'panels', x: 300, z: -186, w: 30, d: 24, yaw: 0, panel: 6, block: true });
  L.slabs.push({ site: s.id, kind: 'panels', x: 252, z: -236, w: 26, d: 18, yaw: 0, panel: 6, block: true });
  L.slabs.push({ site: s.id, kind: 'helipad', x: 296, z: -296, w: 22, d: 22, yaw: 0, block: true });
  // gate chicanes and defensive props
  L.props.push({ key: 'barrier', x: 226, z: -160, yaw: 0, site: s.id }, { key: 'barrier', x: 234, z: -156, yaw: 0, site: s.id }, { key: 'barrier', x: 228, z: -152, yaw: 0, site: s.id });
  L.props.push({ key: 'barrier', x: 350, z: -246, yaw: Math.PI / 2, site: s.id }, { key: 'barrier', x: 354, z: -254, yaw: Math.PI / 2, site: s.id });
  for (let i = 0; i < 6; i++) L.props.push({ key: 'barrier', x: 248 + i * 1.65, z: -248, yaw: 0, site: s.id });
  for (let i = 0; i < 5; i++) L.props.push({ key: 'barrier', x: 210, z: -236 + i * 1.65, yaw: Math.PI / 2, site: s.id });
  L.props.push({ key: 'generator', x: 266, z: -270, yaw: 0.3, site: s.id }, { key: 'generator', x: 314, z: -238, yaw: 1.2, site: s.id });
  for (const [x, z] of [[280, -230], [281, -229], [279.6, -228.6], [205, -320], [206, -321.2]]) L.props.push({ key: rng.chance(0.5) ? 'barrel_red' : 'barrel_blue', x, z, yaw: rng.range(0, 6), site: s.id });
  L.props.push({ key: 'covered_car', x: 280, z: -200, yaw: 0.1, site: s.id }, { key: 'covered_car', x: 284, z: -200.5, yaw: -0.05, site: s.id });
  L.props.push({ key: 'crate_military', x: 306, z: -222, yaw: 0, site: s.id }, { key: 'crate_military', x: 306, z: -220.7, yaw: 0.05, site: s.id }, { key: 'ammo_box', x: 292, z: -224, yaw: 0.4, site: s.id });
  L.props.push({ key: 'jerrycan', x: 268, z: -268, yaw: 0, site: s.id }, { key: 'jerrycan', x: 268.6, z: -268.1, yaw: 0.2, site: s.id });
  for (const [x, z] of [[230, -250], [270, -290], [320, -250], [180, -230], [240, -200], [300, -330 + 8]]) L.outdoor.push({ x, z, site: s.id });
  crateSpots(L, s, 8, rng);
}

function greystone(L) {
  const s = siteById('greystone');
  const rng = rngFor('greystone');
  const at = (ang, r) => [s.x + Math.cos(ang) * r, s.z + Math.sin(ang) * r];
  let [x, z] = at(0.35, 72);
  addBuilding(L, { site: s.id, kind: 'site_office', x, z, yaw: yawFacing(s.x - x, s.z - z), w: 9, d: 3.6, storeys: 1 });
  [x, z] = at(1.25, 76);
  addBuilding(L, { site: s.id, kind: 'shed', x, z, yaw: yawFacing(s.x - x, s.z - z), w: 7, d: 9, storeys: 1, variant: 1 });
  [x, z] = at(1.75, 74);
  addBuilding(L, { site: s.id, kind: 'shed', x, z, yaw: yawFacing(s.x - x, s.z - z), w: 6, d: 8, storeys: 1, variant: 2 });
  // conveyor from the pit floor up to a hopper on the west rim
  const a = Math.PI;
  L.special.push({ kind: 'conveyor', site: s.id, x0: s.x + Math.cos(a) * 18, z0: s.z + Math.sin(a) * 18, x1: s.x + Math.cos(a) * 70, z1: s.z + Math.sin(a) * 70 });
  L.footprints.push({ x: s.x + Math.cos(a) * 70, z: s.z, w: 6, d: 6, rot: 0 });
  addPaint({ shape: 'disc', ch: 0, x: s.x, z: s.z, r: 64, edge: 8, w: 0.75, noise: 0.7 });
  addPaint({ shape: 'disc', ch: 0, x: s.x, z: s.z, r: 84, edge: 10, w: 0.35, noise: 0.9 });
  L.special.push({ kind: 'gravelpile', site: s.id, x: s.x - 14, z: s.z + 4, r: 6, h: 3.4 }, { kind: 'gravelpile', site: s.id, x: s.x + 6, z: s.z - 10, r: 5, h: 2.6 }, { kind: 'gravelpile', site: s.id, x: s.x - 74, z: s.z - 8, r: 5, h: 3 });
  L.props.push({ key: 'generator', x: s.x + Math.cos(0.5) * 66, z: s.z + Math.sin(0.5) * 66, yaw: 1, site: s.id });
  L.props.push({ key: 'barrel_red', x: s.x - 10, z: s.z + 14, yaw: 0, site: s.id }, { key: 'barrel_red', x: s.x - 9.2, z: s.z + 14.6, yaw: 1, site: s.id }, { key: 'tyre', x: s.x + 12, z: s.z + 8, yaw: 0, site: s.id });
  for (const [ang, r] of [[2.4, 20], [4.0, 22], [0.8, 74], [5.2, 72]]) { const [px, pz] = at(ang, r); L.outdoor.push({ x: px, z: pz, site: s.id }); }
  crateSpots(L, s, 2, rng);
}

function signal(L) {
  const s = siteById('signal');
  const rng = rngFor('signal');
  L.special.push({ kind: 'mast', site: s.id, x: s.x + 14, z: s.z - 16, h: 55 });
  L.footprints.push({ x: s.x + 14, z: s.z - 16, w: 7, d: 7, rot: 0 });
  addBuilding(L, { site: s.id, kind: 'equipment_shed', x: s.x - 10, z: s.z - 14, yaw: Math.PI / 2, w: 7, d: 5, storeys: 1 });
  addBuilding(L, { site: s.id, kind: 'bunker', x: s.x - 22, z: s.z + 14, yaw: Math.PI * 0.85, w: 10, d: 8, storeys: 1 });
  addPaint({ shape: 'disc', ch: 0, x: s.x + 4, z: s.z - 10, r: 22, edge: 6, w: 0.7, noise: 0.8 });
  L.fences.push({ pts: corners(s.x + 14, s.z - 16, 13, 13, 0).concat([corners(s.x + 14, s.z - 16, 13, 13, 0)[0]]), kind: 'wire', site: s.id, gap: 1 });
  L.props.push({ key: 'generator', x: s.x - 4, z: s.z - 20, yaw: 0, site: s.id }, { key: 'utility_box', x: s.x + 6, z: s.z - 8, yaw: Math.PI, site: s.id });
  L.outdoor.push({ x: s.x, z: s.z, site: s.id }, { x: s.x - 14, z: s.z + 2, site: s.id });
  crateSpots(L, s, 2, rng);
}

function southport(L) {
  const s = siteById('southport');
  const rng = rngFor('southport');
  const Hb = MAP.harbor;
  const add = (kind, x, z, yaw, w, d, storeys = 1, extra = {}) => addBuilding(L, { site: s.id, kind, x, z, yaw, w, d, storeys, ...extra });
  add('warehouse', 10, 405, 0, 36, 20, 1, { variant: 0 });
  add('warehouse', 110, 405, 0, 36, 20, 1, { variant: 1 });
  add('warehouse', 10, 350, 0, 36, 20, 1, { variant: 2, mezzanine: true });
  add('office', 100, 340, -0.5, 12, 9, 2);
  // quay wall, yard paving, pier, crane, tanks
  L.special.push({ kind: 'quay', site: s.id, x0: Hb.x0, x1: Hb.x1, z: Hb.z, top: s.h + 0.25, bottom: -8.5 });
  L.slabs.push({ site: s.id, kind: 'panels', x: 60, z: 428, w: 160, d: 54, yaw: 0, panel: 8, under: true });
  L.slabs.push({ site: s.id, kind: 'panels', x: 34, z: 377, w: 92, d: 30, yaw: 0, panel: 8, under: true });
  L.special.push({ kind: 'pier', site: s.id, x: 126, z0: Hb.z + 0.4, z1: Hb.z + 64, w: 4.4, y: s.h });
  L.footprints.push({ x: 126, z: Hb.z + 32, w: 4.4, d: 64, rot: 0 });
  L.special.push({ kind: 'crane', site: s.id, x: 92, z: 444, span: 16, h: 18, boom: 26 });
  L.footprints.push({ x: 92, z: 444, w: 13, d: 17, rot: 0 });
  L.special.push({ kind: 'fueltank', site: s.id, x: -24, z: 374, r: 6, h: 9 }, { kind: 'fueltank', site: s.id, x: -24, z: 354, r: 6, h: 9 });
  L.footprints.push({ x: -24, z: 374, w: 12, d: 12, rot: 0, round: true }, { x: -24, z: 354, w: 12, d: 12, rot: 0, round: true });
  // container rows along the quay apron
  const xs = [-12, 4, 20, 36, 80, 96, 112];
  xs.forEach((x, i) => { L.special.push({ kind: 'containers', site: s.id, x, z: 432 + (i % 2) * 3, yaw: Math.PI / 2, layout: i % 3 === 0 ? 'L' : 'row', seed: 700 + i }); L.footprints.push({ x, z: 432 + (i % 2) * 3, w: 6, d: 7, rot: Math.PI / 2 }); });
  for (const [x, z, yaw] of [[58, 372, 0], [140, 376, 0.4], [70, 340, Math.PI / 2]]) { L.special.push({ kind: 'containers', site: s.id, x, z, yaw, layout: 'single', seed: Math.round(x * 7 + z) }); L.footprints.push({ x, z, w: 3, d: 6.5, rot: yaw }); }
  for (let i = 0; i < 6; i++) L.props.push({ key: 'barrel_blue', x: 40 + (i % 3) * 0.9, z: 392 + Math.floor(i / 3) * 0.9, yaw: rng.range(0, 6), site: s.id });
  L.props.push({ key: 'barrel_red', x: -12, z: 366, yaw: 0, site: s.id }, { key: 'barrel_red', x: -11.2, z: 366.7, yaw: 2, site: s.id });
  L.props.push({ key: 'tyre', x: 132, z: 452, yaw: 0, site: s.id }, { key: 'tyre', x: 120, z: 452.4, yaw: 0, site: s.id }, { key: 'tyre', x: 30, z: 452.6, yaw: 0, site: s.id });
  L.props.push({ key: 'covered_car', x: 84, z: 362, yaw: 1.2, site: s.id }, { key: 'covered_car', x: 88, z: 366, yaw: 1.3, site: s.id });
  L.props.push({ key: 'crate_wood', x: 52, z: 398, yaw: 0.2, site: s.id }, { key: 'crate_wood', x: 53, z: 398.2, yaw: 0, site: s.id }, { key: 'cardboard_box', x: 30, z: 420, yaw: 0.3, site: s.id });
  L.props.push({ key: 'generator', x: 102, z: 430, yaw: 0, site: s.id }, { key: 'utility_box', x: 118, z: 352, yaw: -0.5, site: s.id });
  for (const [x, z] of [[48, 440], [70, 420], [130, 425], [-4, 380], [60, 360], [104, 380]]) L.outdoor.push({ x, z, site: s.id });
  crateSpots(L, s, 4, rng);
}

function fuel(L) {
  const s = siteById('fuel');
  const r2 = roads.find((r) => r.id === 'R2');
  const c = closestS(r2, s.x, s.z);
  const p = roadPoint(r2, c.s);
  const nx = p.tz, nz = -p.tx;   // right-hand side of R2 (toward the south)
  const sgn = (s.z + nz * 10) > s.z ? 1 : 1;
  const off = (k) => [s.x + nx * k * sgn, s.z + nz * k * sgn];
  let [x, z] = off(r2.half + 3 + 6.5);
  L.special.push({ kind: 'canopy', site: s.id, x: x - p.tx * 2, z: z - p.tz * 2, yaw: yawFacing(-nx, -nz), w: 14, d: 9, h: 5 });
  L.footprints.push({ x: x - p.tx * 2, z: z - p.tz * 2, w: 14, d: 9, rot: yawFacing(-nx, -nz), fill: 'rgba(90,88,82,0.6)' });
  [x, z] = off(r2.half + 3 + 17);
  addBuilding(L, { site: s.id, kind: 'shop', x: x + p.tx * 6, z: z + p.tz * 6, yaw: yawFacing(-nx, -nz), w: 10, d: 8, storeys: 1, variant: 4 });
  [x, z] = off(r2.half + 3 + 8);
  L.slabs.push({ site: s.id, kind: 'panels', x, z, w: 28, d: 18, yaw: yawFacing(-nx, -nz), panel: 4.5, under: true });
  L.props.push({ key: 'jerrycan', x: x + p.tx * 9, z: z + p.tz * 9, yaw: 0, site: s.id }, { key: 'utility_box', x: x - p.tx * 12, z: z - p.tz * 12, yaw: yawFacing(-nx, -nz), site: s.id });
  L.outdoor.push({ x: x - p.tx * 8, z: z - p.tz * 8, site: s.id });
  crateSpots(L, s, 1, rngFor('fuel'));
}

function cabins(L) {
  const s = siteById('cabins');
  for (const [dx, dz] of [[-24, 4], [6, 22], [24, -2]]) {
    const x = s.x + dx, z = s.z + dz;
    addBuilding(L, { site: s.id, kind: 'cabin', x, z, yaw: yawFacing(s.x - x, s.z - z), w: 6, d: 8, storeys: 1 });
  }
  addPaint({ shape: 'disc', ch: 0, x: s.x, z: s.z + 4, r: 9, edge: 5, w: 0.5, noise: 0.9 });
  L.special.push({ kind: 'firepit', site: s.id, x: s.x, z: s.z + 6 });
  L.outdoor.push({ x: s.x + 2, z: s.z + 2, site: s.id });
  crateSpots(L, s, 1, rngFor('cabins'));
}

function lighthouse(L) {
  const s = siteById('lighthouse');
  addBuilding(L, { site: s.id, kind: 'lighthouse', x: s.x + 8, z: s.z - 8, yaw: Math.PI * 0.25, w: 7.6, d: 7.6, storeys: 1, round: true });
  addBuilding(L, { site: s.id, kind: 'cabin', x: s.x - 12, z: s.z - 14, yaw: Math.PI * 0.2, w: 6, d: 8, storeys: 1 });
  addPaint({ shape: 'disc', ch: 0, x: s.x, z: s.z - 6, r: 10, edge: 6, w: 0.45, noise: 0.9 });
  L.outdoor.push({ x: s.x - 2, z: s.z - 2, site: s.id });
  crateSpots(L, s, 1, rngFor('lighthouse'));
}

function bunkerSite(L) {
  const s = siteById('bunker');
  const r = nearestRoad(s.x, s.z, rq, 60);
  let nx = 1, nz = 0;
  if (r) { const p = roadPoint(r.road, r.s); nx = -p.tz; nz = p.tx; if (nx < 0) { nx = -nx; nz = -nz; } }
  const x = s.x + nx * 15, z = s.z + nz * 15;
  addBuilding(L, { site: s.id, kind: 'bunker', x, z, yaw: yawFacing(-nx, -nz), w: 10, d: 8, storeys: 1 });
  L.props.push({ key: 'barrier', x: s.x + nx * 7 - nz * 6, z: s.z + nz * 7 + nx * 6, yaw: Math.atan2(nx, nz) + Math.PI / 2, site: s.id });
  L.outdoor.push({ x: x + nz * 8, z: z - nx * 8, site: s.id });
  crateSpots(L, s, 1, rngFor('bunker'));
}

function roadside(L) {
  const rng = rngFor('roadside');
  const allRoads = roads.filter((r) => r.id !== 'RQ');
  let placed = 0;
  for (let a = 0; a < 600 && placed < ROADSIDE.houses; a++) {
    const r = rng.pick(allRoads);
    const s = rng.range(0, r.len);
    const p = roadPoint(r, s);
    const side = rng.chance(0.5) ? 1 : -1;
    const nx = -p.tz * side, nz = p.tx * side;
    const sz = HOUSE(rng);
    const off = r.half + 3 + TUNE.setback + 1.5 + sz.d / 2;
    const x = p.x + nx * off, z = p.z + nz * off;
    if (ALL_SITES.some((st) => Math.hypot(st.x - x, st.z - z) < Math.max(60, st.r + 22))) continue;
    if (L.buildings.some((b) => b.site === null && Math.hypot(b.x - x, b.z - z) < TUNE.roadsideMinSpacing)) continue;
    if (forestAt(x, z) > 0.6) continue;
    const yaw = yawFacing(-nx, -nz);
    const hs = corners(x, z, sz.w, sz.d, yaw).map(([cx, cz]) => heightAt(cx, cz));
    if (Math.min(...hs) < 3 || Math.max(...hs) - Math.min(...hs) > 2.2) continue;
    const b = { site: null, kind: 'house', x, z, yaw, ...sz, roadside: true };
    if (!fits(L, b, 6) || !clearOfRoads(x, z, sz.w, sz.d, yaw)) continue;
    const rec = addBuilding(L, b);
    rec.lootTarget = ROADSIDE.lootPointsEach;
    if (rng.chance(0.6)) L.props.push({ key: 'covered_car', x: x + Math.cos(yaw) * (sz.w / 2 + 3), z: z - Math.sin(yaw) * (sz.w / 2 + 3), yaw: yaw + Math.PI / 2, site: null });
    placed++;
  }
}

/** Crate spots for a site: beside buildings' side walls or at outdoor cover, deterministic. */
function crateSpots(L, site, n, rng) {
  const own = L.buildings.filter((b) => b.site === site.id && !['silo', 'watchtower', 'lighthouse'].includes(b.kind));
  const spots = [];
  for (const b of own) {
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    for (const side of [1, -1]) {
      const lx = side * (b.w / 2 + 0.9), lz = (rng.next() - 0.5) * b.d * 0.5;
      spots.push({ x: b.x + lx * c + lz * s, z: b.z - lx * s + lz * c, yaw: b.yaw + Math.PI / 2 });
    }
  }
  for (const o of L.outdoor.filter((q) => q.site === site.id)) spots.push({ x: o.x, z: o.z, yaw: rng.range(0, 6) });
  rng.shuffle(spots);
  let k = 0;
  for (const sp of spots) {
    if (k >= n) break;
    if (onRoad(sp.x, sp.z, 1.5)) continue;
    if (L.buildings.some((b) => obbOverlap({ x: sp.x, z: sp.z, w: 1.0, d: 0.6, yaw: sp.yaw, pad: 0.3 }, b))) continue;
    if (L.crates.some((c) => Math.hypot(c.x - sp.x, c.z - sp.z) < 6)) continue;
    L.crates.push({ x: sp.x, z: sp.z, yaw: sp.yaw, site: site.id, tier: site.tier });
    k++;
  }
}

function powerLines(L) {
  for (const r of roads.filter((q) => q.type === 'asphalt')) {
    const step = 46;
    for (let s = 12; s < r.len - 8; s += step) {
      const p = roadPoint(r, s);
      const nx = -p.tz, nz = p.tx;
      const x = p.x + nx * (r.half + 4.2), z = p.z + nz * (r.half + 4.2);
      if (L.buildings.some((b) => obbOverlap({ x, z, w: 1, d: 1, yaw: 0, pad: 1.5 }, b))) continue;
      if (heightAt(x, z) < 1) continue;
      L.poles.push({ x, z, yaw: Math.atan2(p.tx, p.tz), road: r.id });
    }
  }
}

/** Build the whole island layout (deterministic). Registers ground paint as a side effect. */
export function buildLayout() {
  const L = createLayout();
  harrow(L); millbrook(L); kessler(L); greystone(L); signal(L); southport(L);
  fuel(L); cabins(L); lighthouse(L); bunkerSite(L);
  roadside(L);
  powerLines(L);
  // scattered props along roads and in the countryside
  const rng = rngFor('scatter');
  for (const r of roads.filter((q) => q.type === 'asphalt')) {
    for (let s = 30; s < r.len; s += rng.range(70, 140)) {
      const p = roadPoint(r, s);
      const side = rng.chance(0.5) ? 1 : -1;
      const x = p.x - p.tz * side * (r.half + 3.6), z = p.z + p.tx * side * (r.half + 3.6);
      if (ALL_SITES.some((st) => Math.hypot(st.x - x, st.z - z) < st.r * 0.85)) continue;
      L.props.push({ key: rng.pick(['barrier', 'tyre', 'barrel_blue']), x, z, yaw: Math.atan2(p.tx, p.tz) + rng.range(-0.3, 0.3), site: null });
    }
  }
  return L;
}

export { POIS, LANDMARKS };
