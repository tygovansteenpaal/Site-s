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
  roadsideMinSpacing: 70,
  outposts: 34,               // countryside cover clusters between the sites
  outpostSpacing: 58,
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
    sidewalks: [],   // town pavements: {road, s0, s1, side, site}
    lamps: [],       // street lamps: {x, z, yaw (arm points along -local z toward the road), road, s}
    gardenTrees: [], // {x, z, s, site}
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
  townStreets(L, s, ['R1', 'R2', 'R3'], rng);
  for (const b of L.buildings.filter((q) => q.site === s.id && q.kind === 'house')) yard(L, b, rng);
  crateSpots(L, s, 3, rng);
}

// ------------------------------------------------------------------------------------------ town dressing
const SIDEWALK = { inner: 0.12, outer: 2.1, step: 2, junction: 3.5, lampEvery: 26 };
/** Pavement runs on both sides of the given roads inside the town core, broken at junctions; lamps along them. */
function townStreets(L, site, roadIds, rng) {
  for (const id of roadIds) {
    const r = roads.find((q) => q.id === id);
    const others = roads.filter((q) => q !== r);
    for (const side of [1, -1]) {
      let run = null;
      const flush = () => { if (run && run.s1 - run.s0 >= 6) L.sidewalks.push(run); run = null; };
      for (let sa = 0; sa <= r.len; sa += SIDEWALK.step) {
        const p = roadPoint(r, sa);
        const nx = -p.tz * side, nz = p.tx * side;
        const ox = p.x + nx * (r.half + 1.1), oz = p.z + nz * (r.half + 1.1);
        let ok = Math.hypot(p.x - site.x, p.z - site.z) < site.r * 0.74;
        if (ok) for (const o of others) { const q = nearestOn(o, ox, oz); if (q < o.half + SIDEWALK.junction) { ok = false; break; } }
        if (ok) for (const b of L.buildings) if (obbOverlap({ x: ox, z: oz, w: 2.4, d: 2.4, yaw: 0 }, { ...b, pad: 0.2 })) { ok = false; break; }
        if (ok) { if (!run) run = { road: id, s0: sa, s1: sa, side, site: site.id }; run.s1 = sa; } else flush();
      }
      flush();
    }
  }
  // lamps: alternate sides along each run, on the outer pavement edge
  let k = 0;
  for (const w of L.sidewalks.filter((q) => q.site === site.id)) {
    const r = roads.find((q) => q.id === w.road);
    for (let sa = w.s0 + 4 + ((k++ * 7) % 11); sa < w.s1 - 3; sa += SIDEWALK.lampEvery) {
      const p = roadPoint(r, sa);
      const nx = -p.tz * w.side, nz = p.tx * w.side;
      const x = p.x + nx * (r.half + SIDEWALK.outer - 0.35), z = p.z + nz * (r.half + SIDEWALK.outer - 0.35);
      L.lamps.push({ x, z, yaw: yawFacing(nx, nz), road: r.id, s: sa });
    }
  }
}

function nearestOn(r, x, z) {
  let best = Infinity;
  for (let i = 0; i < r.xs.length - 1; i++) {
    const ax = r.xs[i], az = r.zs[i], ex = r.xs[i + 1] - ax, ez = r.zs[i + 1] - az;
    const l2 = ex * ex + ez * ez;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + ex * t - x, az + ez * t - z));
  }
  return best;
}

/**
 * Front and back yard for a house: style picked here, geometry built with the house (the gate lines up with the
 * front door chosen there). The back garden is dropped when it would run into another building or a road.
 */
function yard(L, b, rng) {
  const style = rng.pick(['picket', 'picket', 'wall', 'hedge', 'hedge', 'rail']);
  const front = 3.6;
  const back = 6.5;
  const c = Math.cos(b.yaw), sn = Math.sin(b.yaw);
  const at = (lx, lz) => [b.x + lx * c + lz * sn, b.z - lx * sn + lz * c];
  const [fx, fz] = at(0, b.d / 2 + front / 2);
  const frontOk = clearOfRoads(fx, fz, b.w + 1.2, front, b.yaw, -1.2) &&
    !L.buildings.some((o) => o !== b && obbOverlap({ x: fx, z: fz, w: b.w + 1.2, d: front, yaw: b.yaw, pad: 0.4 }, o));
  const [bx, bz] = at(0, -b.d / 2 - back / 2);
  let backOk = clearOfRoads(bx, bz, b.w + 1.2, back, b.yaw, 0.5) && !L.slabs.some((q) => obbOverlap({ x: bx, z: bz, w: b.w + 1.2, d: back, yaw: b.yaw }, q));
  if (backOk) for (const o of L.buildings) if (o !== b && obbOverlap({ x: bx, z: bz, w: b.w + 1.2, d: back, yaw: b.yaw, pad: 0.6 }, o)) { backOk = false; break; }
  b.yard = { style, front: frontOk ? front : 0, back: backOk ? back : 0, rear: rng.pick(['picket', 'rail', 'wire']) };
  if (backOk && rng.chance(0.75)) {
    const side = rng.chance(0.5) ? 1 : -1;
    const [tx, tz] = at(side * rng.range(0.6, b.w / 2 - 1.2), -b.d / 2 - back * rng.range(0.5, 0.7));
    L.gardenTrees.push({ x: tx, z: tz, s: rng.range(0.7, 0.95), site: b.site });
  }
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
  // HESCO compounds: a U around the command post (open to the north), a screen east of the barracks with a gap,
  // a line shielding the hangar apron and an L by the helipad. Each is real cover in the open yard.
  const hesco = [
    { pts: [[247, -273], [240, -273], [240, -250], [264, -250], [264, -273], [257, -273]], h: 1.37 },
    { pts: [[220, -306], [220, -276]], h: 1.37 }, { pts: [[220, -266], [220, -240]], h: 1.37 },
    { pts: [[248, -206], [276, -206]], h: 2.2 },
    { pts: [[281, -312], [281, -283], [292, -283]], h: 1.37 },
  ];
  for (const hh of hesco) {
    L.special.push({ kind: 'hesco', site: s.id, ...hh });
    for (let i = 0; i < hh.pts.length - 1; i++) {
      const [ax, az] = hh.pts[i], [bx, bz] = hh.pts[i + 1];
      L.footprints.push({ x: (ax + bx) / 2, z: (az + bz) / 2, w: Math.hypot(bx - ax, bz - az), d: 1.1, rot: -Math.atan2(bz - az, bx - ax), fill: 'rgba(120,108,82,0.9)' });
    }
  }
  // sandbag emplacements inside both gates (horseshoes open toward the yard)
  for (const [x, z, face] of [[219, -179, Math.PI], [241, -179, Math.PI], [331, -239, -Math.PI / 2], [331, -261, -Math.PI / 2]]) {
    L.special.push({ kind: 'sandbags', site: s.id, x, z, yaw: face, r: 2.1 });
    L.footprints.push({ x, z, w: 4.6, d: 4.6, rot: 0, round: true, fill: 'rgba(120,108,82,0.8)' });
  }
  for (const [x, z] of [[206, -238], [276, -244], [286, -322], [312, -258]]) L.special.push({ kind: 'floodlight', site: s.id, x, z });
  // concrete roads from both gates into the yard
  L.slabs.push({ site: s.id, kind: 'panels', x: 230, z: -201, w: 7, d: 54, yaw: 0, panel: 7 });
  L.slabs.push({ site: s.id, kind: 'panels', x: 316, z: -250, w: 44, d: 7, yaw: 0, panel: 7 });
  // tent lines south of the command post and by the east road: shelter and indoor loot in the open yard
  [[238, -290, 0], [247, -290, 0], [256, -290, 0], [300, -271, 0], [309, -271, 0]].forEach(([x, z, yaw], i) => {
    L.special.push({ kind: 'tent', site: s.id, x, z, yaw, seed: 40 + i });
    L.footprints.push({ x, z, w: 5.2, d: 8.4, rot: yaw, fill: 'rgba(98,106,72,0.95)' });
  });
  // more container cover in the north-west yard
  for (const [x, z, yaw, lay, seed] of [[190, -190, 0.2, 'L', 931], [190, -236, Math.PI / 2, 'row', 932]]) {
    L.special.push({ kind: 'containers', site: s.id, x, z, yaw, layout: lay, seed });
    L.footprints.push({ x, z, w: 7, d: 6, rot: yaw });
  }
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

function city(L) {
  const s = siteById('city');
  const rng = rngFor('city');
  const P = s.pad;
  // the street plane (map image, and no grass or trees through the asphalt), then the buildings on top
  L.footprints.push({ x: s.x, z: s.z, w: P.w, d: P.d, rot: 0, fill: 'rgba(62,62,60,0.95)' });
  for (const [x0, z0, x1, z1] of s.blocks) L.footprints.push({ x: s.x + (x0 + x1) / 2, z: s.z + (z0 + z1) / 2, w: x1 - x0, d: z1 - z0, rot: 0, fill: 'rgba(96,74,62,0.95)' });
  L.special.push({ kind: 'city', site: s.id, x: s.x, z: s.z });
  // street points between the blocks: loot, crates and cover candidates
  const inBlock = (x, z, m) => s.blocks.some(([x0, z0, x1, z1]) => x > x0 - m && x < x1 + m && z > z0 - m && z < z1 + m);
  for (let lx = -P.w / 2 + 6; lx < P.w / 2 - 4; lx += 11) {
    for (let lz = -P.d / 2 + 6; lz < P.d / 2 - 4; lz += 11) {
      const x = lx + rng.range(-2, 2), z = lz + rng.range(-2, 2);
      if (!inBlock(x, z, 2.5)) L.outdoor.push({ x: s.x + x, z: s.z + z, site: s.id });
    }
  }
  crateSpots(L, s, s.crates, rng);
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

// ------------------------------------------------------------------------------------------ added sites
/** Road point nearest a site with its unit tangent and the normal pointing to `side` (+1 left of travel, -1 right). */
function roadFrame(id, site, side = 1) {
  const r = roads.find((q) => q.id === id);
  const p = roadPoint(r, closestS(r, site.x, site.z).s);
  return { r, x: p.x, z: p.z, tx: p.tx, tz: p.tz, nx: -p.tz * side, nz: p.tx * side };
}

/** Place a building at road-frame offsets (along, across), facing the road; nudged outward until it fits. */
function putOff(L, site, F, kind, along, across, w, d, extra = {}) {
  for (let k = 0; k < 14; k++) {
    const a = across + Math.sign(across || 1) * k * 1.5;
    const x = F.x + F.tx * along + F.nx * a, z = F.z + F.tz * along + F.nz * a;
    const yaw = extra.yaw ?? yawFacing(-F.nx * Math.sign(a), -F.nz * Math.sign(a));
    const b = { site: site.id, kind, x, z, w, d, storeys: 1, ...extra, yaw };
    if (fits(L, b, 2) && clearOfRoads(x, z, w, d, yaw, 1)) return addBuilding(L, b);
  }
  return null;
}
const at = (F, along, across) => [F.x + F.tx * along + F.nx * across, F.z + F.tz * along + F.nz * across];

function pinecrest(L) {
  const s = siteById('pinecrest');
  const rng = rngFor('pinecrest');
  const F = roadFrame('R10', s, 1);
  // village green by the road (no pavement: R10 climbs through the village and stepped kerbs float on the slope)
  const [gx, gz] = at(F, 4, 16);
  addPaint({ shape: 'disc', ch: 1, x: gx, z: gz, r: 9, edge: 4, w: 0.5, noise: 0.5 });
  L.gardenTrees.push({ x: gx + F.nx * 7, z: gz + F.nz * 7, s: 1.0, site: s.id }, { x: gx + F.tx * 7, z: gz + F.tz * 7, s: 0.85, site: s.id });
  placeStreet(L, s, 'shop', SHOP, 2, ['R10'], rng, { near: true, spacing: 6 });
  placeStreet(L, s, 'house', HOUSE, 9, ['R10'], rng, { spacing: 6 });
  for (let a = 0; a < 200 && L.buildings.filter((b) => b.site === s.id && b.kind === 'house').length < 9; a++) {
    const [x, z] = rng.inDisc(s.x, s.z, s.r * 0.7);
    const sz = HOUSE(rng);
    const yaw = yawFacing(F.x - x, F.z - z);
    const b = { site: s.id, kind: 'house', x, z, yaw, ...sz };
    if (fits(L, b, 5) && clearOfRoads(x, z, b.w, b.d, yaw, 4)) addBuilding(L, b);
  }
  for (const b of L.buildings.filter((q) => q.site === s.id)) {
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
    if (b.kind === 'house' && rng.chance(0.5)) {
      const ox = Math.cos(b.yaw), oz = -Math.sin(b.yaw);
      L.props.push({ key: 'covered_car', x: b.x + fx * (b.d / 2 + 2.2) + ox * (b.w / 2 + 2.6), z: b.z + fz * (b.d / 2 + 2.2) + oz * (b.w / 2 + 2.6), yaw: b.yaw + Math.PI / 2, site: s.id });
    }
    if (b.kind === 'shop') L.props.push({ key: 'cardboard_box', x: b.x - fx * (b.d / 2 + 1.0), z: b.z - fz * (b.d / 2 + 1.0), yaw: rng.range(0, 6), site: s.id });
    L.outdoor.push({ x: b.x + fx * (b.d / 2 + 1.6), z: b.z + fz * (b.d / 2 + 1.6), site: s.id });
  }
  for (const b of L.buildings.filter((q) => q.site === s.id && q.kind === 'house')) yard(L, b, rng);
  crateSpots(L, s, s.crates, rng);
}

function timber(L) {
  const s = siteById('timber');
  const rng = rngFor('timber');
  const F = roadFrame('R11', s, 1);
  const N = F.nz < 0 ? 1 : -1;               // across sign that points north (-Z): the mill side
  putOff(L, s, F, 'warehouse', -4, N * 24, 28, 14, { variant: 1 });
  putOff(L, s, F, 'shed', 24, N * 20, 7, 9, { variant: 1 });
  putOff(L, s, F, 'shed', -30, N * 19, 6, 8, { variant: 2 });
  putOff(L, s, F, 'cabin', -14, -N * 17, 6, 8);
  putOff(L, s, F, 'cabin', 2, -N * 19, 6, 8);
  putOff(L, s, F, 'cabin', 18, -N * 17, 6, 8);
  // log yard between the hall and the track
  const yaw = yawFacing(F.nx, F.nz) + Math.PI / 2;
  for (const [a, c, rows, len] of [[-18, 11, 3, 8], [-6, 10, 2, 7], [8, 11, 3, 8], [20, 9, 2, 6]]) {
    const [x, z] = at(F, a, N * c);
    L.special.push({ kind: 'logpile', site: s.id, x, z, yaw, rows, len });
    L.footprints.push({ x, z, w: len, d: 2.6, rot: yaw, fill: 'rgba(110,84,58,0.9)' });
  }
  const [px, pz] = at(F, -4, N * 12);
  addPaint({ shape: 'rect', ch: 0, x: px, z: pz, hw: 30, hd: 9, rot: yaw, edge: 4, w: 0.6, noise: 0.9 });
  const [cx, cz] = at(F, 34, N * 9);
  L.special.push({ kind: 'containers', site: s.id, x: cx, z: cz, yaw, layout: 'L', seed: 1201 });
  L.footprints.push({ x: cx, z: cz, w: 7, d: 6, rot: yaw });
  for (const [a, c, key] of [[-26, 8, 'generator'], [14, 7, 'barrel_red'], [15, 7.9, 'barrel_red'], [-2, -8, 'tyre'], [28, 6, 'crate_wood'], [28.8, 6.1, 'crate_wood']]) {
    const [x, z] = at(F, a, N * c);
    L.props.push({ key, x, z, yaw: rng.range(0, 6), site: s.id });
  }
  for (const [a, c] of [[-12, 12], [14, 13], [-2, -12], [30, 12]]) { const [x, z] = at(F, a, N * c); L.outdoor.push({ x, z, site: s.id }); }
  crateSpots(L, s, s.crates, rng);
}

function motel(L) {
  const s = siteById('motel');
  const rng = rngFor('motel');
  const F = roadFrame('R12', s, 1);
  const N = F.nz < 0 ? 1 : -1;               // the north side of the road
  const lotYaw = yawFacing(F.tx, F.tz);
  const [lx, lz] = at(F, -6, N * 17);
  L.slabs.push({ site: s.id, kind: 'panels', x: lx, z: lz, w: 34, d: 15, yaw: lotYaw + Math.PI / 2, panel: 5, block: true });
  // six room cabins: four in a row behind the lot, two on its west end, all facing the lot
  for (const a of [-19, -9, 1, 11]) putOff(L, s, F, 'cabin', a, N * 31, 6, 8);
  const face = yawFacing(F.tx, F.tz);
  for (const c of [14, 23]) putOff(L, s, F, 'cabin', -29, N * c, 6, 8, { yaw: face });
  putOff(L, s, F, 'shop', 22, N * 13, 11, 9, { variant: 2 });
  for (const [a, c, rot] of [[-14, 14, 0], [-4, 15, 0.1], [6, 14, -0.08]]) {
    const [x, z] = at(F, a, N * c);
    L.props.push({ key: 'covered_car', x, z, yaw: lotYaw + rot, site: s.id });
  }
  const [ux, uz] = at(F, 16, N * 8);
  L.props.push({ key: 'utility_box', x: ux, z: uz, yaw: lotYaw, site: s.id }, { key: 'jerrycan', x: ux + 1.2, z: uz, yaw: 0.4, site: s.id });
  for (const [a, c] of [[-10, 20], [8, 21], [22, 6]]) { const [x, z] = at(F, a, N * c); L.outdoor.push({ x, z, site: s.id }); }
  crateSpots(L, s, s.crates, rng);
}

function roadside(L) {
  const rng = rngFor('roadside');
  const allRoads = roads.filter((r) => r.id !== 'RQ');
  let placed = 0;
  for (let a = 0; a < 2500 && placed < ROADSIDE.houses; a++) {
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
    yard(L, rec, rng);
    if (rng.chance(0.6)) L.props.push({ key: 'covered_car', x: x + Math.cos(yaw) * (sz.w / 2 + 3), z: z - Math.sin(yaw) * (sz.w / 2 + 3), yaw: yaw + Math.PI / 2, site: null });
    placed++;
  }
}

/**
 * Countryside cover between the sites, so open ground is never a long walk without something to hide behind:
 * a field shed with a couple of loot spots, a pair of wrecked cars, a stack of crates and barrels, or a broken
 * concrete barrier line. Spots are open land (no site, road, forest, water or steep slope), well apart.
 */
function countryside(L) {
  const rng = rngFor('countryside');
  const placed = [];
  const level = (x, z, rad) => {
    const hs = [[0, 0], [rad, 0], [-rad, 0], [0, rad], [0, -rad]].map(([dx, dz]) => heightAt(x + dx, z + dz));
    return Math.min(...hs) > 2.5 && Math.max(...hs) - Math.min(...hs) < 1.6;
  };
  for (let a = 0; a < 3000 && placed.length < TUNE.outposts; a++) {
    const ang = rng.range(0, Math.PI * 2), rad = Math.sqrt(rng.next()) * 430;
    const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
    if (ALL_SITES.some((st) => Math.hypot(st.x - x, st.z - z) < st.r + 26)) continue;
    if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < TUNE.outpostSpacing)) continue;
    if (L.buildings.some((b) => Math.hypot(b.x - x, b.z - z) < 30)) continue;
    if (forestAt(x, z) > 0.45 || onRoad(x, z, 9) || !level(x, z, 5)) continue;
    const yaw = rng.range(0, Math.PI * 2), c = Math.cos(yaw), sn = Math.sin(yaw);
    const at = (lx, lz) => [x + lx * c + lz * sn, z - lx * sn + lz * c];
    const kind = rng.pick(['shed', 'shed', 'wrecks', 'stack', 'barriers']);
    if (kind === 'shed') {
      const b = { site: null, kind: 'shed', x, z, yaw, w: 6 + Math.round(rng.range(0, 2)), d: 7 + Math.round(rng.range(0, 2)), storeys: 1, variant: rng.int(0, 2) };
      if (!fits(L, b, 6) || !clearOfRoads(x, z, b.w, b.d, yaw)) continue;
      const rec = addBuilding(L, b);
      rec.lootTarget = 2;
      const [px, pz] = at(b.w / 2 + 1.6, rng.range(-2, 2));
      L.props.push({ key: rng.pick(['barrel_red', 'barrel_blue', 'crate_wood']), x: px, z: pz, yaw: rng.range(0, 6), site: null });
    } else if (kind === 'wrecks') {
      for (const [lx, lz, dy] of [[0, 0, 0], [3.4, 2.6, 0.5]]) { const [px, pz] = at(lx, lz); L.props.push({ key: 'covered_car', x: px, z: pz, yaw: yaw + dy, site: null }); }
      for (const [lx, lz] of [[-2.6, 1], [-2.9, 1.9]]) { const [px, pz] = at(lx, lz); L.props.push({ key: 'tyre', x: px, z: pz, yaw: rng.range(0, 6), site: null }); }
    } else if (kind === 'stack') {
      for (const [lx, lz] of [[0, 0], [1.05, 0], [0.5, 1.0], [-1.2, 0.3]]) { const [px, pz] = at(lx, lz); L.props.push({ key: 'crate_wood', x: px, z: pz, yaw: yaw + rng.range(-0.2, 0.2), site: null }); }
      for (const [lx, lz] of [[2.4, -0.6], [2.9, 0.3]]) { const [px, pz] = at(lx, lz); L.props.push({ key: rng.pick(['barrel_blue', 'barrel_red']), x: px, z: pz, yaw: rng.range(0, 6), site: null }); }
    } else {
      for (let i = 0; i < 5; i++) { const [px, pz] = at(i * 1.7 - 3.4, Math.sin(i * 1.3) * 0.5); L.props.push({ key: 'barrier', x: px, z: pz, yaw: yaw + rng.range(-0.25, 0.25), site: null }); }
    }
    addPaint({ shape: 'disc', ch: 0, x, z, r: 6, edge: 3, w: 0.5, noise: 0.7 });
    L.outdoor.push({ x, z, site: null });
    placed.push({ x, z });
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
  fuel(L); city(L); lighthouse(L); bunkerSite(L);
  pinecrest(L); timber(L); motel(L);
  roadside(L);
  countryside(L);
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
