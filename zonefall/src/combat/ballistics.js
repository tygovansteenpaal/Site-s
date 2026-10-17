// ZONEFALL - hitscan, hitboxes, shot routing. OWNER: COMBAT. Contract: ARCHITECTURE.md 5.3, 6.5 and 8.5.
// Every bullet is hitscan up to WEAPONS[w].range. Hitboxes are procedural capsules from entity pos/yaw/flags/life
// (never bones), so every peer computes identical boxes (ARCHITECTURE.md 6.5):
//   standing: head sphere y 1.62 r 0.13 | body capsule y 0.95..1.45 r 0.24 | limb capsule y 0.10..0.95 r 0.17
//   The body capsule's rounded top (to 1.69 m) wraps the lower head sphere, so a level shot at the face would meet it
//   first: a ray that passes through an entity's head sphere always counts as a head hit (rayPlayers).
//   crouch: heights x 0.68 | slide: body lying 0.9 m along the facing from y 0.35, head at 0.6 |
//   freefall: horizontal body along the facing at the entity position | chute: hanging upright.
// Remote entities are tested at their interpolated (rendered) pose, which favours the shooter.
// Thin cover: one penetration through wood, glass or sheet metal up to PEN[surface].max metres thick, with the damage
// scaled by PEN[surface].mult (the scaled distance is reported as extra range so damage falls off).
// The spread cone is seeded from (shooterId, seq): a peer replaying a shot reproduces the same pellet direction.
import * as THREE from 'three';
import { WEAPONS, SURFACE } from '../config.js';
import { on, emit, EV, registerEvents } from '../core/bus.js';
import { state, getPlayer, localPlayer, isBotId, LIFE, FLAG, hasFlag, debug } from '../core/state.js';
import { DEG } from '../core/util.js';
import { SHOT_HIT } from '../net/protocol.js';
import * as world from '../world/world.js';
import * as damage from './damage.js';
import * as sync from '../net/sync.js';
import * as avatar from '../player/avatar.js';
import * as viewmodel from './viewmodel.js';
import * as camera from '../player/camera.js';

const TUNE = {
  nearMiss: 3.0,                // m from the local eye: BULLET_NEAR
  broadRadius: 1.45,            // m around pos + 0.8 for the per-entity broad phase
  headDepth: 0.3,               // m: a head sphere hit at most this far behind the entity's first contact still wins
                                // (a level face shot is <= 0.24 m behind the body cap; a steep shot up through the chest is not)
  penetration: true,
  remoteNormalProbe: true,      // re-cast remote world hits locally for an exact decal normal
};
// Thin cover: max thickness (m) a round passes and the damage multiplier after it.
const PEN = {
  [SURFACE.WOOD]: { max: 0.32, mult: 0.62 },
  [SURFACE.GLASS]: { max: 0.08, mult: 0.88 },
  [SURFACE.METAL]: { max: 0.06, mult: 0.5 },
};
const PEN_POWER = { ak47: 1, m4a1: 0.85, mp5: 0.55, m700: 1.4, m1911: 0.5 };

/** COMBAT-local event: a round passed through cover {point, normal, surface, exit:[x,y,z]} for exit-hole fx. */
export const BEV = registerEvents({ PENETRATE: 'combat:penetrate' });

// ------------------------------------------------------------------------------------------ hitboxes
const boxCache = new Map();   // id -> [{zone, a, b, r}] reused every call
function boxesFor(id) {
  let b = boxCache.get(id);
  if (!b) {
    b = [
      { zone: 'head', a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0.13 },
      { zone: 'body', a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0.24 },
      { zone: 'limb', a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0.17 },
    ];
    boxCache.set(id, b);
  }
  return b;
}

/**
 * Procedural hitbox capsules of an entity: [{zone, a: Vector3, b: Vector3, r}] (sphere when a equals b).
 * The returned array and vectors are reused per entity: copy them if you keep them past the next call.
 */
export function hitboxes(entity) {
  const bx = boxesFor(entity.id);
  const p = entity.pos;
  const fx = -Math.sin(entity.yaw || 0), fz = -Math.cos(entity.yaw || 0);
  const [head, body, limb] = bx;
  if (entity.life === LIFE.FREEFALL) {
    // Belly-down, head forward along the facing; centre about 0.9 m above the entity position.
    const cy = p.y + 0.9;
    head.a.set(p.x + fx * 0.78, cy + 0.05, p.z + fz * 0.78); head.b.copy(head.a);
    body.a.set(p.x + fx * 0.5, cy, p.z + fz * 0.5); body.b.set(p.x - fx * 0.05, cy, p.z - fz * 0.05);
    limb.a.set(p.x - fx * 0.12, cy - 0.02, p.z - fz * 0.12); limb.b.set(p.x - fx * 0.95, cy - 0.04, p.z - fz * 0.95);
    return bx;
  }
  if (hasFlag(entity, FLAG.SLIDE)) {
    // Feet first, leaning back: body 0.9 m along the facing from y 0.35, head behind at 0.6.
    head.a.set(p.x - fx * 0.12, p.y + 0.6, p.z - fz * 0.12); head.b.copy(head.a);
    body.a.set(p.x, p.y + 0.38, p.z); body.b.set(p.x + fx * 0.9, p.y + 0.3, p.z + fz * 0.9);
    limb.a.set(p.x + fx * 0.9, p.y + 0.22, p.z + fz * 0.9); limb.b.set(p.x + fx * 1.35, p.y + 0.15, p.z + fz * 1.35);
    return bx;
  }
  const k = hasFlag(entity, FLAG.CROUCH) ? 0.68 : 1;
  head.a.set(p.x, p.y + 1.62 * k, p.z); head.b.copy(head.a);
  body.a.set(p.x, p.y + 0.95 * k, p.z); body.b.set(p.x, p.y + 1.45 * k, p.z);
  limb.a.set(p.x, p.y + 0.10 * k, p.z); limb.b.set(p.x, p.y + 0.95 * k, p.z);
  return bx;
}

function hittable(e, ignoreId) {
  if (!e.alive || e.id === ignoreId || e.stale) return false;
  return e.life === LIFE.GROUND || e.life === LIFE.FREEFALL || e.life === LIFE.CHUTE;
}

const rpOut = { id: null, zone: 'body', distance: 0, point: new THREE.Vector3() };
/** Ray vs player hitboxes only: {id, zone, distance, point} or null. (The returned object is reused per call.) */
export function rayPlayers(origin, dir, range, ignoreId) {
  let best = range, bestId = null, bestZone = null;
  for (const e of state.players.values()) {
    if (!hittable(e, ignoreId)) continue;
    // broad phase: sphere around the body centre
    const cx = e.pos.x - origin.x, cy = e.pos.y + 0.8 - origin.y, cz = e.pos.z - origin.z;
    const along = cx * dir.x + cy * dir.y + cz * dir.z;
    const R = TUNE.broadRadius + (e.life === LIFE.FREEFALL || hasFlag(e, FLAG.SLIDE) ? 0.6 : 0);
    if (along < -R || along - R > best) continue;
    const perp2 = cx * cx + cy * cy + cz * cz - along * along;
    if (perp2 > R * R) continue;
    const bx = hitboxes(e);
    let entry = Infinity, zone = null, headT = -1;
    for (let i = 0; i < bx.length; i++) {
      const h = bx[i];
      const t = rayCapsuleExact(origin, dir, h.a, h.b, h.r);
      if (t < 0) continue;
      if (h.zone === 'head') headT = t;
      if (t < entry) { entry = t; zone = h.zone; }
    }
    // head priority: the ray goes through the head sphere of this entity (within its body depth) -> a head hit there
    if (headT >= 0 && headT - entry < TUNE.headDepth) { entry = headT; zone = 'head'; }
    if (zone && entry < best) { best = entry; bestId = e.id; bestZone = zone; }
  }
  if (!bestId) return null;
  rpOut.id = bestId; rpOut.zone = bestZone; rpOut.distance = best;
  rpOut.point.copy(origin).addScaledVector(dir, best);
  return rpOut;
}

/** Robust ray-capsule (closest-approach + caps), returns entry distance or -1. */
function rayCapsuleExact(o, d, a, b, r) {
  const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z;
  const baba = bax * bax + bay * bay + baz * baz;
  let best = -1;
  const sphere = (cx, cy, cz) => {
    const ox = o.x - cx, oy = o.y - cy, oz = o.z - cz;
    const bb = d.x * ox + d.y * oy + d.z * oz;
    const cc = ox * ox + oy * oy + oz * oz - r * r;
    const hh = bb * bb - cc;
    if (hh < 0) return;
    let t = -bb - Math.sqrt(hh);
    if (t < 0) t = cc <= 0 ? 0 : -1;
    if (t >= 0 && (best < 0 || t < best)) best = t;
  };
  sphere(a.x, a.y, a.z);
  if (baba < 1e-10) return best;
  sphere(b.x, b.y, b.z);
  // cylinder body
  const oax = o.x - a.x, oay = o.y - a.y, oaz = o.z - a.z;
  const bard = bax * d.x + bay * d.y + baz * d.z;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = d.x * oax + d.y * oay + d.z * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  const A = baba - bard * bard;
  const B = baba * rdoa - baoa * bard;
  const C = baba * oaoa - baoa * baoa - r * r * baba;
  const h = B * B - A * C;
  if (h >= 0 && A > 1e-12) {
    let t = (-B - Math.sqrt(h)) / A;
    if (t < 0 && C <= 0) t = 0;
    const y = baoa + t * bard;
    if (t >= 0 && y > 0 && y < baba && (best < 0 || t < best)) best = t;
  }
  return best;
}

// ------------------------------------------------------------------------------------------ hitscan
const pTmp = new THREE.Vector3(), penO = new THREE.Vector3();
/**
 * Nearest hit along a ray against the world (world.raycast) and all living player hitboxes except ignoreId.
 * @returns {{kind:'player', id:string, zone:string, distance:number, point:import('three').Vector3}|{kind:'world', surface:number, distance:number, point:import('three').Vector3, normal:import('three').Vector3}|null}
 */
export function hitscan(origin, dir, range, ignoreId) {
  const w = world.raycast(origin, dir, range);
  const p = rayPlayers(origin, dir, w ? w.distance : range, ignoreId);
  if (p) return { kind: 'player', id: p.id, zone: p.zone, distance: p.distance, point: p.point.clone() };
  if (w) return { kind: 'world', surface: w.surface, distance: w.distance, point: w.point, normal: w.normal, wkind: w.kind };
  return null;
}

/** Hitscan with one penetration of thin cover. Returns the final hit plus {pen: {point, normal, surface, exit}|null, mult}. */
function traceShot(origin, dir, range, ignoreId, weaponId) {
  const h = hitscan(origin, dir, range, ignoreId);
  if (!TUNE.penetration || !h || h.kind !== 'world' || h.wkind === 'terrain' || h.wkind === 'water') return { hit: h, pen: null, mult: 1 };
  const P = PEN[h.surface];
  if (!P) return { hit: h, pen: null, mult: 1 };
  const maxT = P.max * (PEN_POWER[weaponId] || 1);
  // Exit face: from just inside the entry point the double-sided collider returns the far side of the slab.
  penO.copy(h.point).addScaledVector(dir, 0.004);
  const ex = world.raycast(penO, dir, maxT + 0.01);
  if (!ex || ex.distance > maxT) return { hit: h, pen: null, mult: 1 };
  const thick = ex.distance + 0.004;
  const exit = pTmp.copy(penO).addScaledVector(dir, ex.distance + 0.006);
  const rest = range - h.distance - thick;
  if (rest <= 0.5) return { hit: h, pen: null, mult: 1 };
  const h2 = hitscan(exit, dir, rest, ignoreId);
  const pen = { point: [h.point.x, h.point.y, h.point.z], normal: [h.normal.x, h.normal.y, h.normal.z], surface: h.surface, exit: [exit.x, exit.y, exit.z] };
  if (h2) h2.distance += h.distance + thick;
  return { hit: h2, pen, mult: P.mult * (1 - 0.5 * thick / Math.max(maxT, 1e-3)), entry: h };
}

// ------------------------------------------------------------------------------------------ deterministic spread
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
function mulberry(a) {
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sU = new THREE.Vector3(), sV = new THREE.Vector3(), UPV = new THREE.Vector3(0, 1, 0);
/** Rotate unit dir into a cone of full angle spreadDeg (uniform over the disc), seeded per shooter + seq. */
export function spreadDir(dir, spreadDeg, shooterId, seq, out) {
  out.copy(dir);
  if (!(spreadDeg > 0)) return out;
  const rnd = mulberry((hashStr(String(shooterId)) ^ Math.imul((seq | 0) + 1, 2654435761)) >>> 0);
  const r = Math.sqrt(rnd()) * Math.tan(spreadDeg * 0.5 * DEG);
  const a = rnd() * Math.PI * 2;
  sU.crossVectors(dir, UPV);
  if (sU.lengthSq() < 1e-8) sU.set(1, 0, 0); else sU.normalize();
  sV.crossVectors(sU, dir).normalize();
  out.addScaledVector(sU, Math.cos(a) * r).addScaledVector(sV, Math.sin(a) * r).normalize();
  return out;
}

// ------------------------------------------------------------------------------------------ fire
const fDir = new THREE.Vector3(), muz = new THREE.Vector3(), eyeV = new THREE.Vector3();
let localSeq = 0;
/**
 * Fire one bullet for any shooter simulated on this peer (the local player, or a bot on the host).
 * Applies a cone of spreadDeg (seeded per shot from shooterId + seq), hitscans, emits WEAPON_FIRE, routes player hits to
 * combat/damage.dealHit, and when online broadcasts a SHOT binary (net/sync.sendShot) for remote tracers/sound.
 * @param {string} shooterId
 * @param {string} weaponId
 * @param {import('three').Vector3} origin  eye position (local) or bot head
 * @param {import('three').Vector3} dir     normalized aim direction (recoil included)
 * @param {{spreadDeg?:number, seq?:number}} [opts]
 * @returns {{end:number[], hit:({kind:'player', id:string, zone:'head'|'body'|'limb', distance:number}|{kind:'world', surface:number, distance:number, normal:number[]}|null)}}
 */
export function fire(shooterId, weaponId, origin, dir, opts = {}) {
  const W = WEAPONS[weaponId];
  if (!W || W.class === 'lethal') throw new Error(`[COMBAT/ballistics] fire with non-gun '${weaponId}'`);
  const seq = opts.seq ?? (localSeq = (localSeq + 1) & 0xffff);
  spreadDir(dir, opts.spreadDeg || 0, shooterId, seq, fDir);
  const tr = traceShot(origin, fDir, W.range, shooterId, weaponId);
  const h = tr.hit;
  const dist = h ? h.distance : W.range;
  const end = [origin.x + fDir.x * dist, origin.y + fDir.y * dist, origin.z + fDir.z * dist];
  const isLocal = shooterId === state.selfId;
  let hitOut = null, hitFlags = 0, surface = null;
  if (h && h.kind === 'player') {
    const target = getPlayer(h.id);
    const tp = target ? [h.point.x, h.point.y, h.point.z] : end;
    hitOut = { kind: 'player', id: h.id, zone: h.zone, distance: h.distance, surface: SURFACE.FLESH, normal: [-fDir.x, -fDir.y, -fDir.z] };
    hitFlags |= SHOT_HIT.PLAYER;
    if (h.zone === 'head') hitFlags |= SHOT_HIT.HEAD;
    surface = SURFACE.FLESH;
    // Penetrated rounds lose damage: report a longer distance to the falloff plus the multiplier via the hit object.
    const res = damage.dealHit({
      sid: damage.nextSid(), shooter: shooterId, target: h.id, weapon: weaponId, zone: h.zone,
      distance: tr.mult < 1 ? Math.max(h.distance, effectiveDistance(weaponId, h.zone, h.distance, tr.mult)) : h.distance,
      origin: [origin.x, origin.y, origin.z], targetPos: tp,
    });
    if (res && res.kill) hitFlags |= SHOT_HIT.KILL;
    if (res && res.killed) hitFlags |= SHOT_HIT.KILL;
  } else if (h) {
    hitOut = { kind: 'world', surface: h.surface, distance: h.distance, normal: [h.normal.x, h.normal.y, h.normal.z], wkind: h.wkind };
    surface = h.surface;
  }
  // Tracer origin: the visible muzzle (first-person viewmodel, else the avatar's weapon).
  let muzzle = null;
  if (isLocal && state.local.mode === 'fp' && viewmodel.getMuzzle(muz)) muzzle = [muz.x, muz.y, muz.z];
  else if (avatar.getMuzzleWorld(shooterId, muz)) muzzle = [muz.x, muz.y, muz.z];
  emit(EV.WEAPON_FIRE, {
    id: shooterId, weapon: weaponId, origin: [origin.x, origin.y, origin.z], dir: [fDir.x, fDir.y, fDir.z], end,
    local: isLocal, hit: hitOut, muzzle, pen: tr.pen,
  });
  if (tr.pen) emit(BEV.PENETRATE, tr.pen);
  if (!isLocal) nearMiss(shooterId, origin, fDir, dist);
  if (state.online) {
    const shooter = getPlayer(shooterId);
    sync.sendShot({
      weapon: weaponId, origin: [origin.x, origin.y, origin.z], dir: [fDir.x, fDir.y, fDir.z], dist, surface, hitFlags,
      botSlot: isBotId(shooterId) && shooter ? shooter.slot : null,
    });
  }
  return { end, hit: hitOut };
}

/** Distance at which the unpenetrated round would do mult x its damage (so damageAt stays the single source of truth). */
function effectiveDistance(weaponId, zone, d, mult) {
  const base = damage.damageAt(weaponId, zone, d) * mult;
  const W = WEAPONS[weaponId];
  // walk the steps: the first step at or beyond d whose damage is <= base
  for (const s of W.damage) if (s.d >= d && s.dmg * (zone === 'head' ? W.head : zone === 'limb' ? W.limb : 1) <= base + 1e-6) return s.d;
  return Math.min(W.range, d + 60);
}

// ------------------------------------------------------------------------------------------ remote shots
const nmA = new THREE.Vector3(), nmP = new THREE.Vector3();
function nearMiss(shooterId, origin, dir, dist) {
  const me = localPlayer();
  if (!me || !me.alive || shooterId === state.selfId || me.life !== LIFE.GROUND && me.life !== LIFE.CHUTE && me.life !== LIFE.FREEFALL) return;
  const eye = state.local.eye && state.local.eye.lengthSq() > 0 ? state.local.eye : eyeV.set(me.pos.x, me.pos.y + 1.6, me.pos.z);
  nmA.subVectors(eye, origin);
  const t = nmA.dot(dir);
  if (t < 2 || t > dist + 1) return;
  nmP.copy(origin).addScaledVector(dir, t);
  const d = nmP.distanceTo(eye);
  if (d > TUNE.nearMiss) return;
  emit(EV.BULLET_NEAR, { pos: [nmP.x, nmP.y, nmP.z], from: shooterId, dist: d });
}

const rO = new THREE.Vector3(), rD = new THREE.Vector3();
function onNetShot({ shooterId, shot }) {
  if (!shot || !shooterId || shooterId === state.selfId) return;
  const W = WEAPONS[shot.weapon];
  if (!W || W.class === 'lethal') return;
  rO.set(shot.origin[0], shot.origin[1], shot.origin[2]);
  rD.set(shot.dir[0], shot.dir[1], shot.dir[2]);
  if (rD.lengthSq() < 1e-6) return;
  rD.normalize();
  const dist = Math.max(0, Math.min(shot.dist, W.range));
  const end = [rO.x + rD.x * dist, rO.y + rD.y * dist, rO.z + rD.z * dist];
  let hit = null;
  if (shot.hitFlags & SHOT_HIT.PLAYER) {
    hit = { kind: 'player', id: null, zone: shot.hitFlags & SHOT_HIT.HEAD ? 'head' : 'body', distance: dist, surface: SURFACE.FLESH, normal: [-rD.x, -rD.y, -rD.z] };
  } else if (shot.surface != null) {
    let normal = [-rD.x, -rD.y, -rD.z], wkind = 'static';
    if (TUNE.remoteNormalProbe) {
      const w = world.raycast(rO, rD, dist + 0.6);
      if (w && Math.abs(w.distance - dist) < 0.8) { normal = [w.normal.x, w.normal.y, w.normal.z]; wkind = w.kind; }
    }
    hit = { kind: 'world', surface: shot.surface, distance: dist, normal, wkind };
  }
  const muzzle = avatar.getMuzzleWorld(shooterId, muz) ? [muz.x, muz.y, muz.z] : null;
  emit(EV.WEAPON_FIRE, { id: shooterId, weapon: shot.weapon, origin: shot.origin, dir: [rD.x, rD.y, rD.z], end, local: false, hit, muzzle, pen: null });
  nearMiss(shooterId, rO, rD, dist);
}

/** Subscribe to NET_SHOT: remote/bot shots become WEAPON_FIRE {local:false} for vfx/audio, plus BULLET_NEAR checks. */
let inited = false;
export function init() {
  if (inited) return;
  inited = true;
  on(EV.NET_SHOT, onNetShot);
  on(EV.PLAYER_REMOVE, ({ id }) => boxCache.delete(id));
  debug.combat = debug.combat || {};
  Object.assign(debug.combat, {
    hitboxes: (id) => { const e = getPlayer(id); return e ? hitboxes(e).map((h) => ({ zone: h.zone, a: h.a.toArray(), b: h.b.toArray(), r: h.r })) : null; },
    rayTest: (o, d, range = 500) => { const r = hitscan(new THREE.Vector3(...o), new THREE.Vector3(...d).normalize(), range, state.selfId); return r && { kind: r.kind, id: r.id, zone: r.zone, distance: r.distance, surface: r.surface }; },
    aimTest: () => { const o = new THREE.Vector3(), d = new THREE.Vector3(); camera.getAimRay(o, d); const r = hitscan(o, d, 900, state.selfId); return r && { kind: r.kind, id: r.id, zone: r.zone, distance: +r.distance.toFixed(2), surface: r.surface }; },
  });
}
