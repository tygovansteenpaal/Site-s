// ZONEFALL - ground loot, crates, pickups, drops. OWNER: GAME. Contract: ARCHITECTURE.md 3.5 and 5.6, tables in config.LOOT.
// setup(seed): every world.getLootSpawns() entry in order, with stream(seed, 'loot'): floor spawns get an item with
// probability LOOT.floorChance[tier] (kind by LOOT.kinds, weapon by LOOT.weapons, quantities from LOOT.*Qty), uid
// `s${id}` (+ `s${id}a` for the ammo beside a weapon); crate spawns become crate `k${id}` whose LOOT.crateItems
// contents (uids `c${id}.${k}`, tier min(tier+1, 2), from stream(seed, 'crate' + id)) appear when it opens.
// Visuals are fully instanced (one InstancedMesh per model part, not per item): weapons lying on their side, ammo cans
// tinted by calibre, procedural ceramic plate stacks, frags, and a soft rarity glow ring under every item and unopened
// crate; only items within TUNE.drawDistance of the camera are written each rebuild. update(): picks the item the
// local player is looking at within PLAYER.interactRange (line of sight checked), writes state.local.nearby, emits
// LOOT_NEARBY on change and runs interact() on the interact key.
// Picks: optimistic local take + 'pick' {uid, t}; conflicts are resolved by the earliest t, then the lowest picker id
// (within LOOT.pickConflictMs); the loser reverts its inventory and sees a toast.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { LOOT, WEAPONS, PLAYER, AMMO } from '../config.js';
import { on, emit, EV } from '../core/bus.js';
import { state, gfx, debug, localPlayer, getPlayer, isBotId, LIFE, FLAG, hasFlag } from '../core/state.js';
import { stream, hashString } from '../core/rng.js';
import { clamp } from '../core/util.js';
import * as world from '../world/world.js';
import * as assets from '../engine/assets.js';
import * as input from '../engine/input.js';
import * as inventory from '../player/inventory.js';
import * as weapons from '../combat/weapons.js';
import * as session from '../net/session.js';

// Same pinned simplifier build WORLD uses for prop LODs (meshoptimizer, MIT).
const SIMPLIFIER_URL = 'https://cdn.jsdelivr.net/npm/meshoptimizer@1.2.0/meshopt_simplifier.js';

const TUNE = {
  drawDistance: 80,            // m: item meshes
  lodDistance: 13,             // m: full detail (and shadows) inside, simplified LOD beyond
  lod0Tris: 4000,              // per item kind, after simplification
  lod1Tris: 520,
  ringDistance: 125,           // m: glow rings
  rebuildMove: 3,              // m of camera travel before the visible set is rebuilt
  capacity: 160,               // instances per part
  ammoOffset: 0.42,            // m beside its weapon
  crateScatter: [0.95, 1.35],  // m from the crate centre
  viewConeDeg: 62,             // nearby: half-angle of the look cone (items within 1 m always count)
  closeRange: 1.0,
  ringRadius: 0.42,
  modelSize: { ammo_box: 0.34, frag: 0.115 },
};

/** Rarity colour of an item for the ground ring (and the UI). */
export const RARITY = Object.freeze({
  common: 0xd8d4c8, uncommon: 0x6fcf6a, rare: 0x4fa3ff, epic: 0xb27cff, legendary: 0xf2b636,
});
const WEAPON_RARITY = { m1911: 'common', mp5: 'uncommon', ak47: 'rare', m4a1: 'rare', m700: 'epic', rpg: 'legendary' };
const AMMO_TINT = { ar: 0xb8b48a, light: 0xd2c29a, sniper: 0x9a8f86 };

let scene = null;
let seed = 0;
let items = new Map();            // uid -> Item
let spawnsById = new Map();       // spawn id -> spawn
const localPicks = new Map();     // uid -> {item, t, swapUids}
const remoteTaken = new Map();    // uid -> {by, t}
const dropCounters = new Map();   // owner id -> next drop number
let dirty = true;
const lastRebuildAt = new THREE.Vector3(1e9, 0, 0);
let nearbyUid = null;
let ringTime = 0;

// ------------------------------------------------------------------------------------------ helpers
const rarityOf = (it) => {
  if (it.type === 'crate') return 'legendary';
  if (it.type === 'weapon') return WEAPON_RARITY[it.ref] || 'common';
  if (it.type === 'plate') return 'rare';
  if (it.type === 'frag') return 'uncommon';
  return 'common';
};
export function rarity(it) { return rarityOf(it); }

/** Display name for prompts and toasts. */
export function itemLabel(it) {
  if (!it) return '';
  switch (it.type) {
    case 'weapon': return WEAPONS[it.ref] ? WEAPONS[it.ref].name : it.ref;
    case 'ammo': return `${AMMO[it.ref] ? AMMO[it.ref].name : it.ref} AMMO x${it.qty}`;
    case 'plate': return it.qty > 1 ? `ARMOR PLATES x${it.qty}` : 'ARMOR PLATE';
    case 'frag': return 'FRAG GRENADE';
    case 'crate': return 'SUPPLY CRATE';
    default: return it.type.toUpperCase();
  }
}

function groundY(x, z, fromY) {
  try { const g = world.getGround(x, z, fromY); return g && Number.isFinite(g.y) ? g.y : fromY; } catch (e) { return fromY; }
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3();
function clearPath(p0, p1) {
  _a.set(p0[0], p0[1] + 0.2, p0[2]);
  _b.set(p1[0], p1[1] + 0.2, p1[2]);
  try { return world.lineOfSight(_a, _b); } catch (e) { return true; }
}

/** A floor point offset from base by (dist, angle), kept on the same floor and on this side of any wall. */
function besidePoint(base, dist, ang, startOffset = 0) {
  for (let k = 0; k < 6; k++) {
    const a = ang + k * (Math.PI / 3);
    const d = k < 3 ? dist : dist * 0.6;
    const ca = Math.cos(a), sa = Math.sin(a);
    const x = base[0] + ca * d, z = base[2] + sa * d;
    const y = groundY(x, z, base[1] + 0.6);
    const p = [x, y + 0.05, z];
    const from = startOffset > 0 ? [base[0] + ca * startOffset, base[1], base[2] + sa * startOffset] : base;
    if (Math.abs(y + 0.05 - base[1]) < 0.35 && clearPath(from, p)) return p;
  }
  return [base[0], base[1], base[2]];
}

function makeItem(uid, type, ref, qty, pos, tier, extra) {
  const it = { uid, type, ref: ref ?? null, qty: qty | 0, pos: [pos[0], pos[1], pos[2]], tier: tier | 0, yaw: (hashString(uid) % 6283) / 1000 };
  if (extra) Object.assign(it, extra);
  return it;
}

/** Roll one item of a kind for a tier from rng (always consumes the same draws for the same kind). */
function rollItem(rng, tier) {
  const kinds = LOOT.kinds.map((k) => [k.type, k.w[tier] ?? k.w[k.w.length - 1]]);
  const type = rng.weighted(kinds);
  return rollOfType(rng, type, tier);
}

function rollOfType(rng, type, tier) {
  if (type === 'weapon') {
    const ref = rng.weighted(Object.entries(LOOT.weapons).map(([id, w]) => [id, w[tier] ?? 0])) || 'm1911';
    return { type, ref, qty: WEAPONS[ref].mag };
  }
  if (type === 'ammo') {
    const ref = rng.weighted(LOOT.ammoTypes) || 'ar';
    return { type, ref, qty: LOOT.ammoQty[ref] };
  }
  if (type === 'plate') return { type, ref: null, qty: LOOT.plateQty[tier] ?? 1 };
  return { type: 'frag', ref: null, qty: LOOT.fragQty };
}

function add(it) {
  if (items.has(it.uid)) return null;
  items.set(it.uid, it);
  dirty = true;
  return it;
}

function short(id) { return String(id).slice(0, 6); }

// ------------------------------------------------------------------------------------------ setup
/** Generate the match's items from the world spawn points. */
export function setup(matchSeed) {
  clear();
  seed = matchSeed >>> 0;
  const rng = stream(seed, 'loot');
  let spawns = [];
  try { spawns = world.getLootSpawns() || []; } catch (e) { spawns = []; }
  spawnsById = new Map(spawns.map((s) => [s.id, s]));
  for (const s of spawns) {
    const tier = clamp(s.tier | 0, 0, 2);
    if (s.kind === 'crate') {
      add(makeItem(`k${s.id}`, 'crate', null, 1, s.pos, tier, { spawnId: s.id, crate: true, opened: false, site: s.site }));
      continue;
    }
    if (!rng.chance(LOOT.floorChance[tier])) continue;
    const roll = rollItem(rng, tier);
    const ang = rng.range(0, Math.PI * 2);        // drawn for every item so the stream stays aligned
    const it = add(makeItem(`s${s.id}`, roll.type, roll.ref, roll.qty, s.pos, tier, { site: s.site }));
    if (it && roll.type === 'weapon' && LOOT.weaponSpawnsAmmo) {
      const ammo = WEAPONS[roll.ref].ammo;
      add(makeItem(`s${s.id}a`, 'ammo', ammo, LOOT.ammoQty[ammo], besidePoint(s.pos, TUNE.ammoOffset, ang), tier, { site: s.site }));
    }
  }
  emit(EV.LOOT_SPAWNED, { count: items.size });
  return items.size;
}

/** Crate contents (deterministic on every peer): item 0 is always a weapon, then weighted kinds. */
function crateContents(crate) {
  const id = crate.spawnId;
  const tier = Math.min((crate.tier | 0) + 1, 2);
  const rng = stream(seed, 'crate' + id);
  const out = [];
  const base = rng.range(0, Math.PI * 2);
  const n = LOOT.crateItems;
  for (let k = 0; k < n; k++) {
    const roll = k === 0 ? rollOfType(rng, 'weapon', tier) : rollItem(rng, tier);
    const ang = base + (k - (n - 1) / 2) * 0.85;
    const d = rng.range(TUNE.crateScatter[0], TUNE.crateScatter[1]);
    const p = besidePoint(crate.pos, d, ang, 0.62);
    out.push(makeItem(`c${id}.${k}`, roll.type, roll.ref, roll.qty, p, tier, { site: crate.site }));
    if (roll.type === 'weapon' && LOOT.weaponSpawnsAmmo) {
      const ammo = WEAPONS[roll.ref].ammo;
      out.push(makeItem(`c${id}.${k}a`, 'ammo', ammo, LOOT.ammoQty[ammo], besidePoint(p, TUNE.ammoOffset * 0.8, ang + 1.2), tier, { site: crate.site }));
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------ picks
function nowMs() { return Math.round((state.match.time || 0) * 1000); }

/** Apply a pick without broadcasting. Returns true if the item existed. */
function applyPick(uid, by, t) {
  const it = items.get(uid);
  if (!it) return false;
  if (it.type === 'crate') {
    if (it.opened) return false;
    it.opened = true;
    it.openedBy = by;
    try { world.setCrateOpen(it.spawnId, true); } catch (e) { console.warn('[GAME/loot] setCrateOpen failed', e); }
    for (const c of crateContents(it)) add(c);
    dirty = true;
    emit(EV.CRATE_OPENED, { uid, by, pos: it.pos.slice() });
    return true;
  }
  items.delete(uid);
  dirty = true;
  emit(EV.LOOT_PICKED, { uid, by, item: { ...it } });
  return true;
}

/** Apply a pick of uid by a player/bot id (local, NET_PICK, or bot on host). Returns true if the item existed. */
export function pickup(uid, by) {
  const t = nowMs();
  const ok = applyPick(uid, by, t);
  if (ok && state.online && (by === state.selfId || (isBotId(by) && state.isHost))) {
    session.send('pick', { uid, t, by: isBotId(by) ? by : null });
  }
  return ok;
}

function onNetPick({ from, data }) {
  if (!data || !data.uid) return;
  const by = data.by && isBotId(data.by) ? (from === state.hostId ? data.by : null) : from;
  if (!by) return;
  const t = Number.isFinite(data.t) ? data.t : nowMs();
  const uid = data.uid;
  if (items.has(uid)) { applyPick(uid, by, t); remoteTaken.set(uid, { by, t }); return; }
  const mine = localPicks.get(uid);
  if (!mine) return;
  const within = Math.abs(nowMs() - mine.t) <= LOOT.pickConflictMs + 1500;
  const theyWin = t < mine.t || (t === mine.t && String(by) < String(state.selfId));
  if (!within || !theyWin) return;
  // we lost the claim: undo our take and anything it dropped
  localPicks.delete(uid);
  inventory.revert(mine.item);
  for (const d of mine.swapUids) if (items.has(d)) pickup(d, state.selfId);
  const p = getPlayer(by);
  emit(EV.TOAST, { text: `${p ? p.name.toUpperCase() : 'SOMEONE'} GOT THERE FIRST`, kind: 'warn', ms: 1800 });
}

/**
 * Local interact press: pick up state.local.nearby (item) or open it (crate). Returns true if something happened.
 */
export function interact() {
  const me = localPlayer();
  if (!me || !me.alive || me.life !== LIFE.GROUND) return false;
  const near = state.local.nearby;
  if (!near) return false;
  const it = items.get(near.uid);
  if (!it) return false;
  if (it.type === 'crate') return pickup(it.uid, state.selfId);
  if (it.type === 'weapon' && safeBusy()) {
    // a weapon pickup interrupts a reload, plate or switch (like a manual swap), but never a cooked grenade
    let cooking = false;
    try { const vs = weapons.viewState(); cooking = !!(vs && vs.nade); } catch (e) { cooking = false; }
    if (cooking) { emit(EV.TOAST, { text: 'THROW THE GRENADE FIRST', kind: 'info', ms: 1200 }); return false; }
    try { weapons.cancelActions(); } catch (e) { /* weapons not initialised (harness) */ }
  }
  if (!inventory.canTake(it)) {
    const text = it.type === 'ammo' ? `${AMMO[it.ref] ? AMMO[it.ref].name : ''} AMMO FULL` : it.type === 'plate' ? 'PLATE CARRIER FULL' : it.type === 'frag' ? 'FRAGS FULL' : 'CANNOT CARRY THAT';
    emit(EV.TOAST, { text, kind: 'info', ms: 1400 });
    return false;
  }
  const res = inventory.add(it);
  if (!res.taken) return false;
  const t = nowMs();
  pickup(it.uid, state.selfId);
  const swapUids = [];
  if (res.dropped && res.dropped.length) {
    const fwd = state.local.aimDir;
    const at = [me.pos.x + (fwd ? fwd.x * 0.6 : 0), me.pos.y + 0.05, me.pos.z + (fwd ? fwd.z * 0.6 : 0)];
    for (const d of drop(res.dropped, at, state.selfId, 0.35)) swapUids.push(d.uid);
  }
  localPicks.set(it.uid, { item: it, t, swapUids });
  return true;
}

function safeBusy() { try { return weapons.isBusy(); } catch (e) { return false; } }

// ------------------------------------------------------------------------------------------ drops
/**
 * Spawn items on the ground around pos (death drop or swapped weapon) and broadcast 'drop' if this peer is the owner.
 * @param {Array<{type:string, ref:string|null, qty:number}>} list
 * @param {number[]} pos [x, y, z]
 * @param {string} ownerId  used for uids `d${short(ownerId)}.${n}`
 * @returns {Item[]} the spawned items
 */
export function drop(list, pos, ownerId, scatter = LOOT.dropScatter) {
  if (!Array.isArray(list) || !list.length || !pos) return [];
  const out = [];
  let n = dropCounters.get(ownerId) || 0;
  const k = list.length;
  const baseAng = (hashString(String(ownerId) + n) % 628) / 100;
  for (let i = 0; i < k; i++) {
    const src = list[i];
    if (!src || !['weapon', 'ammo', 'plate', 'frag'].includes(src.type) || !(src.qty > 0 || src.type === 'weapon')) continue;
    const ang = baseAng + (i / k) * Math.PI * 2;
    const r = k === 1 ? scatter * 0.4 : scatter * (0.55 + 0.45 * ((i * 0.618) % 1));
    let uid = `d${short(ownerId)}.${n++}`;
    while (items.has(uid)) uid = `d${short(ownerId)}.${n++}`;
    const p = besidePoint([pos[0], groundY(pos[0], pos[2], pos[1] + 1.2) + 0.05, pos[2]], r, ang);
    const it = add(makeItem(uid, src.type, src.ref, Math.max(0, src.qty | 0), p, src.tier | 0));
    if (it) out.push(it);
  }
  dropCounters.set(ownerId, n);
  const owner = ownerId === state.selfId || (isBotId(ownerId) && state.isHost);
  if (out.length && state.online && owner) {
    for (let i = 0; i < out.length; i += 16) {
      session.send('drop', { items: out.slice(i, i + 16).map((it) => ({ uid: it.uid, type: it.type, ref: it.ref, qty: it.qty, pos: it.pos.map((v) => Math.round(v * 1000) / 1000) })) });
    }
  }
  return out;
}

function onNetDrop({ from, data }) {
  if (!data || !Array.isArray(data.items)) return;
  for (const d of data.items) {
    if (items.has(d.uid) || remoteTaken.has(d.uid) || localPicks.has(d.uid)) continue;
    if (d.type === 'weapon' && !WEAPONS[d.ref]) continue;
    if (d.type === 'ammo' && !AMMO[d.ref]) continue;
    const y = groundY(d.pos[0], d.pos[2], d.pos[1] + 0.5);
    add(makeItem(d.uid, d.type, d.ref, d.qty, [d.pos[0], Math.abs(y - d.pos[1]) < 0.6 ? y + 0.05 : d.pos[1], d.pos[2]], 0));
  }
}

// ------------------------------------------------------------------------------------------ queries
/** Closest item or unopened crate to pos within maxDist (metres), or null. Bots use it too. */
export function nearest(pos, maxDist = Infinity, filter = null) {
  const px = pos.x ?? pos[0], py = pos.y ?? pos[1], pz = pos.z ?? pos[2];
  let best = null, bd = maxDist * maxDist;
  for (const it of items.values()) {
    if (it.type === 'crate' && it.opened) continue;
    if (filter && !filter(it)) continue;
    const dx = it.pos[0] - px, dy = (it.pos[1] - py) * 1.5, dz = it.pos[2] - pz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bd) { bd = d; best = it; }
  }
  return best;
}

/** Map uid -> Item ({uid, type, ref, qty, pos:[x,y,z], tier, crate?:boolean, opened?:boolean}). */
export function all() { return items; }

/** Per-site and per-tier counts of the current items (harness and tests). GAME addition. */
export function stats() {
  const bySite = {}, byTier = [0, 0, 0], byType = {};
  for (const it of items.values()) {
    const s = it.site || 'open';
    bySite[s] = bySite[s] || { total: 0, weapon: 0, ammo: 0, plate: 0, frag: 0, crate: 0 };
    bySite[s].total++;
    bySite[s][it.type] = (bySite[s][it.type] || 0) + 1;
    byTier[it.tier | 0]++;
    byType[it.type === 'weapon' ? it.ref : it.type] = (byType[it.type === 'weapon' ? it.ref : it.type] || 0) + 1;
  }
  return { total: items.size, bySite, byTier, byType };
}

/** Remove every item and visual (match end). */
export function clear() {
  for (const it of items.values()) {
    if (it.type === 'crate' && it.opened) { try { world.setCrateOpen(it.spawnId, false); } catch (e) { /* world not built */ } }
  }
  items = new Map();
  localPicks.clear();
  remoteTaken.clear();
  dropCounters.clear();
  nearbyUid = null;
  if (state.local) state.local.nearby = null;
  dirty = true;
  writeVisible(true);
}

// ------------------------------------------------------------------------------------------ nearby + input
const eyeV = new THREE.Vector3(), toV = new THREE.Vector3(), tgtV = new THREE.Vector3();
function findNearby(me) {
  const eye = state.local.eye && state.local.eye.lengthSq() > 0 ? eyeV.copy(state.local.eye) : eyeV.set(me.pos.x, me.pos.y + 1.6, me.pos.z);
  const aim = state.local.aimDir;
  const cosCone = Math.cos(TUNE.viewConeDeg * Math.PI / 180);
  const R = PLAYER.interactRange;
  let best = null, bestScore = Infinity;
  for (const it of items.values()) {
    if (it.type === 'crate' && it.opened) continue;
    const dx = it.pos[0] - me.pos.x, dz = it.pos[2] - me.pos.z;
    const dy = it.pos[1] - me.pos.y;
    if (dy < -1.2 || dy > 1.6) continue;
    const dh = Math.hypot(dx, dz);
    if (dh > R) continue;
    tgtV.set(it.pos[0], it.pos[1] + (it.type === 'crate' ? 0.35 : 0.08), it.pos[2]);
    toV.subVectors(tgtV, eye);
    const dist = toV.length();
    if (dist > R + 0.8) continue;
    toV.divideScalar(dist || 1);
    const cos = aim ? toV.dot(aim) : 1;
    if (dh > TUNE.closeRange && cos < cosCone) continue;
    const score = dist + (1 - cos) * 2.2;
    if (score >= bestScore) continue;
    try { if (!world.lineOfSight(eye, tgtV)) continue; } catch (e) { /* no world */ }
    best = it; bestScore = score;
  }
  return best;
}

export function update(dt) {
  ringTime += dt;
  const me = localPlayer();
  let near = null;
  if (me && me.alive && me.life === LIFE.GROUND && !hasFlag(me, FLAG.DRIVE) && state.match.phase !== 'idle') near = findNearby(me);
  const uid = near ? near.uid : null;
  if (uid !== nearbyUid) {
    nearbyUid = uid;
    state.local.nearby = near ? { ...near, label: itemLabel(near), rarity: rarityOf(near) } : null;
    emit(EV.LOOT_NEARBY, { item: state.local.nearby });
    dirty = true;
  } else if (near && state.local.nearby && state.local.nearby.qty !== near.qty) {
    state.local.nearby = { ...near, label: itemLabel(near), rarity: rarityOf(near) };
  }
  if (near && input.pressed('interact')) interact();
  writeVisible(false);
}

// ------------------------------------------------------------------------------------------ visuals (instanced)
const kinds = new Map();     // key -> {parts: [{mesh}], base: Matrix4}
let ringMesh = null;
let visualsReady = false;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0), _col = new THREE.Color();

/** Bake a loaded model into per-material merged geometries laid down and centred (base y = 0). */
function bakeModel(key, { lay = true, size = null, scope = null } = {}) {
  let src;
  try { src = assets.model(key).scene; } catch (e) { return null; }
  src.updateMatrixWorld(true);
  const byMat = new Map();
  const collect = (root, rootInv, extra) => {
    root.traverse((o) => {
      if (!o.isMesh || o.isSkinnedMesh || !o.geometry) return;
      const m = new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld);
      if (extra) m.premultiply(extra);
      const g = o.geometry.clone().applyMatrix4(m);
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
      if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
      if (!g.getAttribute('normal')) g.computeVertexNormals();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (mats.length > 1 && g.groups.length && g.index) {
        for (const grp of g.groups) {
          const sub = g.clone();
          sub.setIndex(Array.from(g.index.array.slice(grp.start, grp.start + grp.count)));
          sub.clearGroups();
          const mm = mats[grp.materialIndex] || mats[0];
          if (!byMat.has(mm)) byMat.set(mm, []);
          byMat.get(mm).push(sub);
        }
      } else {
        if (!byMat.has(mats[0])) byMat.set(mats[0], []);
        byMat.get(mats[0]).push(g);
      }
    });
  };
  collect(src, new THREE.Matrix4().copy(src.matrixWorld).invert(), null);
  if (scope) {
    // the M700 optic: scope meshes in the scope file's root space plus the configured offset (as player/avatar does)
    try {
      const sg = assets.model(scope.key).scene;
      sg.updateMatrixWorld(true);
      const node = sg.getObjectByName(scope.node);
      if (node) collect(node, new THREE.Matrix4().copy(sg.matrixWorld).invert(), new THREE.Matrix4().makeTranslation(...(scope.offset || [0, 0, 0])));
    } catch (e) { /* the optic is cosmetic */ }
  }
  if (!byMat.size) return null;
  const parts = [];
  const box = new THREE.Box3();
  for (const [mat, geos] of byMat) {
    const sameIndex = geos.every((g) => !!g.index) || geos.every((g) => !g.index);
    const list = sameIndex ? geos : geos.map((g) => (g.index ? g.toNonIndexed() : g));
    const merged = mergeGeometries(list, false);
    if (!merged) continue;
    parts.push({ geo: merged, mat });
  }
  const pre = new THREE.Matrix4();
  if (lay) pre.makeRotationZ(Math.PI / 2);
  else {
    // props: rest on the largest face (an ammo can authored standing on its end lies down)
    const b0 = new THREE.Box3();
    for (const p of parts) { p.geo.computeBoundingBox(); b0.union(p.geo.boundingBox); }
    const sz = b0.getSize(new THREE.Vector3());
    if (sz.y > Math.max(sz.x, sz.z) * 1.15) pre.makeRotationX(Math.PI / 2);
  }
  for (const p of parts) { p.geo.applyMatrix4(pre); p.geo.computeBoundingBox(); box.union(p.geo.boundingBox); }
  let sc = 1;
  if (size) { const s = box.getSize(new THREE.Vector3()); sc = size / Math.max(s.x, s.y, s.z, 1e-3); }
  const c = box.getCenter(new THREE.Vector3());
  const post = new THREE.Matrix4().makeScale(sc, sc, sc).multiply(new THREE.Matrix4().makeTranslation(-c.x, -box.min.y + 0.004 / sc, -c.z));
  for (const p of parts) { p.geo.applyMatrix4(post); p.geo.computeBoundingSphere(); }
  return parts;
}

function plateParts() {
  const body = new RoundedBoxGeometry(0.255, 0.024, 0.325, 2, 0.008);
  body.translate(0, 0.012, 0);
  const strap = new THREE.BoxGeometry(0.262, 0.03, 0.05);
  strap.translate(0, 0.013, 0.07);
  const tag = new THREE.BoxGeometry(0.08, 0.028, 0.03);
  tag.translate(-0.06, 0.013, -0.11);
  const colorize = (g, hex) => {
    const c = new THREE.Color(hex);
    const n = g.getAttribute('position').count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
    return g.index ? g.toNonIndexed() : g;
  };
  const geo = mergeGeometries([colorize(body, 0x34392f), colorize(strap, 0x8c7c58), colorize(tag, 0x4fa3ff)]);
  let mat;
  try {
    const ref = assets.pbr('concrete_floor_worn_001', { tint: 0xffffff, roughness: 0.8, metalness: 0 });
    mat = new THREE.MeshStandardMaterial({ name: 'loot-plate', vertexColors: true, roughness: 0.72, metalness: 0.05, normalMap: ref.normalMap, normalScale: new THREE.Vector2(0.4, 0.4) });
  } catch (e) {
    mat = new THREE.MeshStandardMaterial({ name: 'loot-plate', vertexColors: true, roughness: 0.72, metalness: 0.05 });
  }
  return [{ geo, mat }];
}

const RING_VS = /* glsl */`
  varying vec2 vUv;
  varying vec3 vCol;
  void main() {
    vUv = uv;
    vCol = instanceColor;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;
const RING_FS = /* glsl */`
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vCol;
  void main() {
    vec2 d = vUv - 0.5;
    float r = length(d) * 2.0;
    float core = exp(-r * r * 6.0) * 0.32;
    float rim = smoothstep(0.66, 0.82, r) * (1.0 - smoothstep(0.82, 1.0, r));
    float pulse = 0.82 + 0.18 * sin(uTime * 2.4);
    float a = (core + rim * 0.9) * pulse;
    // instanceColor brightness above 1 marks the highlighted (nearby) item
    float hi = max(max(vCol.r, vCol.g), vCol.b);
    vec3 col = vCol / max(hi, 1.0);
    a *= (hi > 1.01 ? 1.7 : 0.75);
    gl_FragColor = vec4(col, clamp(a * 0.7, 0.0, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function buildVisuals() {
  if (visualsReady || !scene) return;
  const group = new THREE.Group();
  group.name = 'loot';
  scene.add(group);
  const register = (key, parts, opts = {}) => {
    if (!parts || !parts.length) return;
    const make = (p, lod) => {
      const m = new THREE.InstancedMesh(p.geo, p.mat, TUNE.capacity);
      m.name = `loot:${key}:${lod}`;
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = lod === 0;                 // only nearby items cast shadows
      m.receiveShadow = true;
      m.visible = false;
      if (opts.tint) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(TUNE.capacity * 3).fill(1), 3);
      group.add(m);
      return m;
    };
    kinds.set(key, { meshes: parts.map((p) => make(p, 0)), far: parts.map((p) => make(p, 1)), parts, tint: !!opts.tint });
  };
  for (const id of Object.keys(WEAPONS)) {
    if (WEAPONS[id].class === 'lethal') continue;
    const W = WEAPONS[id];
    register(`w:${id}`, bakeModel(W.model.key, { lay: true, scope: W.model.scope || null }));
  }
  register('ammo', bakeModel('ammo_box', { lay: false, size: TUNE.modelSize.ammo_box }), { tint: true });
  register('frag', bakeModel('frag', { lay: true, size: TUNE.modelSize.frag }));
  register('plate', plateParts());
  // glow rings
  const rg = new THREE.PlaneGeometry(TUNE.ringRadius * 2, TUNE.ringRadius * 2);
  rg.rotateX(-Math.PI / 2);
  const rm = new THREE.ShaderMaterial({
    name: 'loot-ring', uniforms: { uTime: { value: 0 } }, vertexShader: RING_VS, fragmentShader: RING_FS,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  ringMesh = new THREE.InstancedMesh(rg, rm, TUNE.capacity * 3);
  ringMesh.name = 'loot:rings';
  ringMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(TUNE.capacity * 9).fill(1), 3);
  ringMesh.count = 0;
  ringMesh.frustumCulled = false;
  ringMesh.renderOrder = 4;
  group.add(ringMesh);
  visualsReady = true;
  buildLods();
}

/** Simplify every kind into a capped near LOD and a light far LOD once the simplifier has loaded (async). */
async function buildLods() {
  let simp = null;
  try {
    const mod = await import(/* @vite-ignore */ SIMPLIFIER_URL);
    simp = mod.MeshoptSimplifier;
    await simp.ready;
  } catch (e) {
    console.warn('[GAME/loot] simplifier unavailable; loot renders without LODs', e);
    return;
  }
  for (const kind of kinds.values()) {
    let total = 0;
    for (const p of kind.parts) total += (p.geo.index ? p.geo.index.count : p.geo.getAttribute('position').count) / 3;
    kind.parts.forEach((p, i) => {
      const lod0 = total > TUNE.lod0Tris ? simplifyGeo(simp, p.geo, TUNE.lod0Tris / total, 0.004) : null;
      const lod1 = simplifyGeo(simp, p.geo, Math.min(0.5, TUNE.lod1Tris / total), 0.03, true);
      if (lod0) { kind.meshes[i].geometry = lod0; }
      if (lod1) { kind.far[i].geometry = lod1; }
    });
    await new Promise((r) => setTimeout(r, 0));
  }
  dirty = true;
}

function simplifyGeo(simp, g, ratio, maxErr, far = false) {
  try {
    const src = g.index ? g : mergeVertices(g, 1e-5);
    const idx = src.index.array instanceof Uint32Array ? src.index.array : Uint32Array.from(src.index.array);
    const target = Math.min(idx.length, Math.max(36, Math.floor((idx.length * ratio) / 3) * 3));
    if (target >= idx.length) return null;
    // GLB positions can be quantized or interleaved (meshopt + KHR_mesh_quantization): the simplifier wants packed floats.
    const pa = src.attributes.position;
    let pos = pa.array;
    if (!(pos instanceof Float32Array) || pa.isInterleavedBufferAttribute || pa.normalized || pa.itemSize !== 3) {
      pos = new Float32Array(pa.count * 3);
      for (let i = 0; i < pa.count; i++) { pos[i * 3] = pa.getX(i); pos[i * 3 + 1] = pa.getY(i); pos[i * 3 + 2] = pa.getZ(i); }
    }
    let [out] = simp.simplify(idx, pos, 3, target, maxErr, far ? [] : ['LockBorder']);
    // far LOD: weapon GLBs are many small open shells, so edge collapse stalls well above the target; sloppy
    // clustering gets there (the item is a few pixels tall beyond TUNE.lodDistance)
    if (far && out && out.length > target * 2 && typeof simp.simplifySloppy === 'function') {
      const [sl] = simp.simplifySloppy(idx, pos, 3, null, target, maxErr * 2);
      if (sl && sl.length >= 12) out = sl;
    }
    if (!out || out.length < 12 || out.length > idx.length * 0.92) return null;
    const res = new THREE.BufferGeometry();
    for (const k of ['position', 'normal', 'uv']) if (src.attributes[k]) res.setAttribute(k, src.attributes[k]);
    res.setIndex(new THREE.BufferAttribute(new Uint32Array(out), 1));
    res.computeBoundingSphere();
    return res;
  } catch (e) {
    console.warn('[GAME/loot] simplify failed', e);
    return null;
  }
}

function keyOf(it) {
  if (it.type === 'weapon') return `w:${it.ref}`;
  if (it.type === 'ammo') return 'ammo';
  if (it.type === 'plate') return 'plate';
  if (it.type === 'frag') return 'frag';
  return null;
}

const counts = new Map();
/** Rewrite the instance buffers with the items near the camera (only when something changed). */
function writeVisible(force) {
  if (!visualsReady) return;
  ringMesh.material.uniforms.uTime.value = ringTime;
  const cam = gfx.camera;
  const cx = cam ? cam.position.x : 0, cy = cam ? cam.position.y : 0, cz = cam ? cam.position.z : 0;
  const moved = Math.hypot(cx - lastRebuildAt.x, cy - lastRebuildAt.y, cz - lastRebuildAt.z);
  if (!force && !dirty && moved < TUNE.rebuildMove) return;
  dirty = false;
  lastRebuildAt.set(cx, cy, cz);
  counts.clear();
  let rings = 0;
  const show = state.match.phase !== 'idle';
  const d2Mesh = TUNE.drawDistance * TUNE.drawDistance, d2Ring = TUNE.ringDistance * TUNE.ringDistance;
  if (show) {
    for (const it of items.values()) {
      const dx = it.pos[0] - cx, dy = it.pos[1] - cy, dz = it.pos[2] - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > d2Ring) continue;
      const isCrate = it.type === 'crate';
      if (isCrate && it.opened) continue;
      // ring
      if (rings < ringMesh.instanceMatrix.count) {
        const s = isCrate ? 2.2 : it.type === 'weapon' ? 1.3 : 0.9;
        _p.set(it.pos[0], it.pos[1] - 0.036, it.pos[2]);   // spawn points sit 0.05 above the floor
        _s.set(s, 1, s);
        _q.identity();
        _m.compose(_p, _q, _s);
        ringMesh.setMatrixAt(rings, _m);
        _col.setHex(RARITY[rarityOf(it)]);
        if (it.uid === nearbyUid) _col.multiplyScalar(1.6);
        ringMesh.setColorAt(rings, _col);
        rings++;
      }
      if (isCrate || d2 > d2Mesh) continue;
      const key = keyOf(it);
      const kind = key && kinds.get(key);
      if (!kind) continue;
      const stack = it.type === 'plate' ? clamp(it.qty, 1, 3) : 1;
      const far = d2 > TUNE.lodDistance * TUNE.lodDistance;
      const ck = far ? key + '|1' : key;
      const list = far ? kind.far : kind.meshes;
      for (let si = 0; si < stack; si++) {
        const n = counts.get(ck) || 0;
        if (n >= TUNE.capacity) break;
        _q.setFromAxisAngle(_up, it.yaw + si * 0.35);
        _p.set(it.pos[0], it.pos[1] - 0.05 + si * 0.026, it.pos[2]);
        _s.set(1, 1, 1);
        _m.compose(_p, _q, _s);
        for (const mesh of list) {
          mesh.setMatrixAt(n, _m);
          if (kind.tint) mesh.setColorAt(n, _col.setHex(AMMO_TINT[it.ref] || 0xffffff));
        }
        counts.set(ck, n + 1);
      }
    }
  }
  for (const [key, kind] of kinds) {
    for (const [list, ck] of [[kind.meshes, key], [kind.far, key + '|1']]) {
      const n = counts.get(ck) || 0;
      for (const mesh of list) {
        mesh.count = n;
        mesh.visible = n > 0;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
  }
  ringMesh.count = rings;
  ringMesh.visible = rings > 0;
  ringMesh.instanceMatrix.needsUpdate = true;
  ringMesh.instanceColor.needsUpdate = true;
}

// ------------------------------------------------------------------------------------------ init
export function init(sc) {
  scene = sc;
  buildVisuals();
  on(EV.NET_PICK, onNetPick);
  on(EV.NET_DROP, onNetDrop);
  on(EV.QUALITY_CHANGED, () => { dirty = true; });
  debug.game = debug.game || {};
  Object.assign(debug.game, {
    /** Spawn an item next to the local player (or at pos). type: weapon|ammo|plate|frag. */
    spawnItem: (type = 'weapon', ref = null, qty = null, pos = null) => {
      const me = localPlayer();
      const at = pos || (me ? [me.pos.x + (state.local.aimDir ? state.local.aimDir.x : 0) * 1.4, me.pos.y + 0.05, me.pos.z + (state.local.aimDir ? state.local.aimDir.z : -1) * 1.4] : [0, 20, 0]);
      const r = ref ?? (type === 'weapon' ? 'm4a1' : type === 'ammo' ? 'ar' : null);
      const q = qty ?? (type === 'weapon' ? WEAPONS[r].mag : type === 'ammo' ? LOOT.ammoQty[r] : 1);
      const [it] = drop([{ type, ref: r, qty: q }], at, state.selfId, 0.01);
      return it ? it.uid : null;
    },
    lootStats: () => stats(),
    lootItem: (uid) => (items.has(uid) ? { ...items.get(uid) } : null),
    lootNearest: (x, y, z, d = 50) => { const it = nearest([x, y, z], d); return it ? { ...it } : null; },
    lootVisible: () => { const o = {}; for (const [k, v] of kinds) o[k] = `${v.meshes[0].count}/${v.far[0].count}`; o.rings = ringMesh ? ringMesh.count : 0; return o; },
  });
}
