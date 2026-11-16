// BLOKSTORM - the block grid: data, island generation, ray casting and box collision. No rendering in here,
// so the host logic and the bots can use it too.
import { WORLD, RULES, B, BLOCKS, MAPS } from './config.js';
import { rng } from './util.js';
import { setZoneMap } from './shared.js';

const { W, H, D, CX, CZ, CHUNK } = WORLD;

export class World {
  constructor() {
    this.data = new Uint8Array(W * H * D);
    this.dirty = new Set();      // chunk keys that need a new mesh
    this.diffs = new Map();      // changes since generation, for players who join late
    this.spawns = [];
    this.chests = [];
    this.seed = 0;
  }
  inside(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < W && y < H && z < D; }
  get(x, y, z) { return this.inside(x, y, z) ? this.data[(y * D + z) * W + x] : 0; }
  solid(x, y, z) { return this.get(x, y, z) !== 0; }
  set(x, y, z, id, record = true) {
    if (!this.inside(x, y, z)) return false;
    const i = (y * D + z) * W + x;
    if (this.data[i] === id) return false;
    this.data[i] = id;
    if (record) this.diffs.set(i, id);
    const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK), cz = Math.floor(z / CHUNK);
    this.dirty.add(`${cx},${cy},${cz}`);
    const lx = x % CHUNK, ly = y % CHUNK, lz = z % CHUNK;
    if (lx === 0) this.dirty.add(`${cx - 1},${cy},${cz}`); if (lx === CHUNK - 1) this.dirty.add(`${cx + 1},${cy},${cz}`);
    if (ly === 0) this.dirty.add(`${cx},${cy - 1},${cz}`); if (ly === CHUNK - 1) this.dirty.add(`${cx},${cy + 1},${cz}`);
    if (lz === 0) this.dirty.add(`${cx},${cy},${cz - 1}`); if (lz === CHUNK - 1) this.dirty.add(`${cx},${cy},${cz + 1}`);
    return true;
  }
  applyDiffs(list) { for (const [i, id] of list) { const x = i % W, z = Math.floor(i / W) % D, y = Math.floor(i / (W * D)); this.set(x, y, z, id); } }
  protectedAt(x, y, z) { const b = BLOCKS[this.get(x, y, z)]; return !!b && b.hard === 0; }

  /** Build the map. The same seed always gives exactly the same islands. */
  /** Build the map. The same seed and map name always give exactly the same islands. */
  generate(seed, mapId = 'klassiek') {
    const map = MAPS[mapId] || MAPS.klassiek;
    this.seed = seed; this.mapId = mapId;
    setZoneMap(map.zone);
    this.data.fill(0); this.diffs.clear(); this.spawns = []; this.chests = [];
    const rand = rng(seed);
    const put = (x, y, z, id) => this.set(x, y, z, id, false);
    const top = RULES.spawnY - 1;
    const chest = (x, y, z) => { if (this.get(x, y - 1, z) && !this.get(x, y, z)) { put(x, y, z, B.CHEST); this.chests.push({ x, y, z, open: false }); } };

    // spawn islands: 4 x 4, made of core stone that cannot break
    for (let i = 0; i < RULES.maxPlayers; i++) {
      const a = (i / RULES.maxPlayers) * Math.PI * 2;
      // towers: every tower exactly map.gap blocks from the square platform, also on the diagonals
      // towers: a fixed pattern so every gap is the same. Neighbouring towers are exactly 7 blocks apart,
      // the straight ones 8 blocks from the platform, the diagonal ones 6 across and 6 along.
      const T8 = [[11, 0], [9, 9], [0, 11], [-9, 9], [-11, 0], [-9, -9], [0, -11], [9, -9]];
      const sx = map.towers ? CX + T8[i][0] : Math.round(CX + Math.cos(a) * map.ring), sz = map.towers ? CZ + T8[i][1] : Math.round(CZ + Math.sin(a) * map.ring);
      // towers map: the island is the top of a tall pillar
      const down = map.towers ? top - 3 : 1;
      // towers: a thin 2 x 2 pillar of obsidian, otherwise the 4 x 4 core stone island
      const lo = map.towers ? -1 : -2, hi = map.towers ? 0 : 1, mat = map.towers ? B.PILLAR : B.CORE;
      for (let x = lo; x <= hi; x++) for (let z = lo; z <= hi; z++) for (let k = 0; k <= down; k++) put(sx + x, top - k, sz + z, mat);
      this.spawns.push({ x: sx, y: RULES.spawnY, z: sz, yaw: Math.atan2(CX - sx, CZ - sz) + Math.PI });
    }

    const blob = (cx, cy, cz, r, depth) => {
      const wob = [rand() * 6, rand() * 6, 0.6 + rand() * 0.8];
      for (let x = -Math.ceil(r) - 2; x <= Math.ceil(r) + 2; x++) for (let z = -Math.ceil(r) - 2; z <= Math.ceil(r) + 2; z++) {
        const ang = Math.atan2(z, x);
        const edge = r + Math.sin(ang * 3 + wob[0]) * wob[2] * Math.min(1, r / 3) + Math.sin(ang * 5 + wob[1]) * 0.5;
        const d = Math.hypot(x, z);
        if (d > edge) continue;
        const deep = Math.max(1, Math.round(depth * (1 - (d / edge) ** 2) + rand() * 0.8));
        for (let k = 0; k < deep; k++) put(cx + x, cy - k, cz + z, k === 0 ? B.GRASS : k < 3 ? B.DIRT : B.STONE);
      }
    };
    const tree = (x, y, z) => {
      if (!this.get(x, y - 1, z) || this.get(x, y, z)) return;
      const h = 3 + Math.floor(rand() * 2);
      for (let k = 0; k < h; k++) put(x, y + k, z, B.LOG);
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = 0; dy < 3; dy++) {
        const r = dy === 2 ? 1 : 2;
        if (Math.abs(dx) > r || Math.abs(dz) > r || (Math.abs(dx) === 2 && Math.abs(dz) === 2)) continue;
        if (!this.get(x + dx, y + h - 1 + dy, z + dz)) put(x + dx, y + h - 1 + dy, z + dz, B.LEAVES);
      }
    };

    if (map.towers) {
      // a small gold platform on an obsidian pillar, with the generator in the middle
      // 4 x 4 platform, centred on the same point as the ring of towers
      for (let x = -2; x <= 1; x++) for (let z = -2; z <= 1; z++) put(CX + x, top, CZ + z, B.GOLD);
      for (let x = -1; x <= 0; x++) for (let z = -1; z <= 0; z++) for (let k = 1; k <= top - 3; k++) put(CX + x, top - k, CZ + z, B.PILLAR);
      put(CX, top + 1, CZ, B.GEN);
      this.generator = { x: CX + 0.5, y: top + 2.3, z: CZ + 0.5 };
      this.dirty.clear();
      for (let cx = 0; cx < W / CHUNK; cx++) for (let cy = 0; cy < H / CHUNK; cy++) for (let cz = 0; cz < D / CHUNK; cz++) this.dirty.add(`${cx},${cy},${cz}`);
      return;
    }

    // middle island with the generator
    const R = map.middle;
    blob(CX, top, CZ, R, Math.max(5, R - 1));
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) put(CX + x, top, CZ + z, B.HARD);
    put(CX, top + 1, CZ, B.GEN);
    this.generator = { x: CX + 0.5, y: top + 2.3, z: CZ + 0.5 };
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + rand() * 0.5, r = R * 0.55 + rand();
      const wx = Math.round(CX + Math.cos(a) * r), wz = Math.round(CZ + Math.sin(a) * r);
      const along = Math.abs(Math.cos(a)) > 0.7 ? [0, 1] : [1, 0];
      for (let k = -1; k <= 1; k++) for (let y = 1; y <= 2; y++) if (!(y === 2 && k !== 0)) put(wx + along[0] * k, top + y, wz + along[1] * k, B.STONE);
    }
    for (let i = 0; i < 2; i++) { const a = rand() * 6.28; tree(Math.round(CX + Math.cos(a) * R * 0.75), top + 1, Math.round(CZ + Math.sin(a) * R * 0.75)); }
    for (let i = 0; i < (map.centerChests || 0); i++) { const a = i * Math.PI + 0.8; chest(Math.round(CX + Math.cos(a) * 3), top + 1, Math.round(CZ + Math.sin(a) * 3)); }

    // rings of stepping islands
    map.mids.forEach(([count, dist, size, every], ringNo) => {
      for (let i = 0; i < count; i++) {
        const a = ((i + 0.5 + ringNo * 0.5) / count) * Math.PI * 2;
        const r = dist + rand() * 3;
        const ix = Math.round(CX + Math.cos(a) * r), iz = Math.round(CZ + Math.sin(a) * r), iy = top - 1 + Math.floor(rand() * 3);
        blob(ix, iy, iz, size + rand() * 0.8, Math.max(3, Math.round(size)));
        if (i % every === 0) chest(ix - 1, iy + 1, iz);
        if (map.twin) { chest(ix + 2, iy + 1, iz + 1); tree(ix - 3, iy + 1, iz - 2); tree(ix + 1, iy + 1, iz + 3); }
        else if (rand() < 0.6) tree(ix, iy + 1, iz);
      }
    });
    this.dirty.clear();
    for (let cx = 0; cx < W / CHUNK; cx++) for (let cy = 0; cy < H / CHUNK; cy++) for (let cz = 0; cz < D / CHUNK; cz++) this.dirty.add(`${cx},${cy},${cz}`);
  }

  /** Small flat island used as the lobby backdrop. */
  generateLobby() {
    this.data.fill(0); this.diffs.clear(); this.chests = [];
    const put = (x, y, z, id) => this.set(x, y, z, id, false);
    for (let x = -7; x <= 7; x++) for (let z = -5; z <= 5; z++) {
      const d = Math.hypot(x / 7, z / 5);
      if (d > 1) continue;
      const deep = Math.round(1 + 4 * (1 - d * d));
      for (let k = 0; k < deep; k++) put(CX + x, 20 - k, CZ + z, k === 0 ? (Math.abs(x) < 6 && Math.abs(z) < 2 ? B.CORE : B.GRASS) : k < 3 ? B.DIRT : B.STONE);
    }
    this.dirty.clear();
    for (let cx = 0; cx < W / CHUNK; cx++) for (let cy = 0; cy < H / CHUNK; cy++) for (let cz = 0; cz < D / CHUNK; cz++) this.dirty.add(`${cx},${cy},${cz}`);
  }

  /** Walk a ray through the grid. Returns the first block hit and the face it was hit on. */
  raycast(ox, oy, oz, dx, dy, dz, max) {
    if (!dx) dx = 1e-9; if (!dy) dy = 1e-9; if (!dz) dz = 1e-9;
    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const tdx = Math.abs(1 / dx), tdy = Math.abs(1 / dy), tdz = Math.abs(1 / dz);
    let tx = (dx > 0 ? x + 1 - ox : ox - x) * tdx, ty = (dy > 0 ? y + 1 - oy : oy - y) * tdy, tz = (dz > 0 ? z + 1 - oz : oz - z) * tdz;
    let nx = 0, ny = 0, nz = 0, t = 0;
    for (let i = 0; i < 200; i++) {
      if (this.get(x, y, z)) return { x, y, z, nx, ny, nz, dist: t };
      if (tx < ty && tx < tz) { t = tx; tx += tdx; x += sx; nx = -sx; ny = 0; nz = 0; }
      else if (ty < tz) { t = ty; ty += tdy; y += sy; nx = 0; ny = -sy; nz = 0; }
      else { t = tz; tz += tdz; z += sz; nx = 0; ny = 0; nz = -sz; }
      if (t > max) return null;
    }
    return null;
  }

  /** Does a standing box (feet at x,y,z) overlap a solid block? */
  boxHits(x, y, z, w, h) {
    const r = w / 2 - 1e-4;
    const x0 = Math.floor(x - r), x1 = Math.floor(x + r), y0 = Math.floor(y), y1 = Math.floor(y + h - 1e-4), z0 = Math.floor(z - r), z1 = Math.floor(z + r);
    for (let yy = y0; yy <= y1; yy++) for (let zz = z0; zz <= z1; zz++) for (let xx = x0; xx <= x1; xx++) if (this.get(xx, yy, zz)) return true;
    return false;
  }
}

/**
 * Move a body through the world with gravity already applied to vel. Returns true when it stands on something.
 * sneak = do not walk off edges.
 */
export function moveBody(world, pos, vel, dt, w, h, sneak = false) {
  let ground = false;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(vel.x), Math.abs(vel.y), Math.abs(vel.z)) * dt / 0.35));
  const sdt = dt / steps;
  for (let s = 0; s < steps; s++) {
    const wasGround = world.boxHits(pos.x, pos.y - 0.05, pos.z, w, h);
    let nx = pos.x + vel.x * sdt;
    if (world.boxHits(nx, pos.y, pos.z, w, h)) { nx = pos.x; vel.x = 0; }
    else if (sneak && wasGround && !world.boxHits(nx, pos.y - 0.6, pos.z, w, h)) { nx = pos.x; vel.x = 0; }
    pos.x = nx;
    let nz = pos.z + vel.z * sdt;
    if (world.boxHits(pos.x, pos.y, nz, w, h)) { nz = pos.z; vel.z = 0; }
    else if (sneak && wasGround && !world.boxHits(pos.x, pos.y - 0.6, nz, w, h)) { nz = pos.z; vel.z = 0; }
    pos.z = nz;
    const ny = pos.y + vel.y * sdt;
    if (world.boxHits(pos.x, ny, pos.z, w, h)) {
      if (vel.y < 0) { pos.y = Math.floor(ny) + 1; ground = true; }
      else pos.y = Math.floor(ny + h) - h - 1e-3;
      vel.y = 0;
    } else pos.y = ny;
  }
  return ground;
}
