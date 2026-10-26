// ZONEFALL - RPG rockets. OWNER: COMBAT. Config: WEAPONS.rpg.rocket / .blast.
// A fired rocket is a projectile, not a hitscan round. The shooter's peer sends 'rkt' {rid, by, o, v, t}; every peer
// (the shooter included) simulates the same flight from the same start in fixed 1/120 s steps, fast-forwarding a late
// message by (match time now - t), like grenades. Each step sweeps the segment against the world (terrain, static
// geometry, water) and against player capsules (the shooter is ignored for armTime). On impact, or when its life
// runs out, the rocket explodes: GRENADE_EXPLODE drives the fireball, smoke and sound (vfx, audio), and
// damage.explosionAt(pos, owner, 'rpg') applies the blast with WEAPONS.rpg.blast on each peer to its own player
// and, on the host, to the bots. The rocket mesh is the launcher's own warhead (its MAGAZINE node) with an exhaust.
import * as THREE from 'three';
import { WEAPONS } from '../config.js';
import { on, emit, EV } from '../core/bus.js';
import { state, debug, localPlayer, getPlayer, LIFE } from '../core/state.js';
import { clamp } from '../core/util.js';
import * as assets from '../engine/assets.js';
import * as world from '../world/world.js';
import * as session from '../net/session.js';
import { NEV } from '../net/session.js';
import * as damage from './damage.js';
import * as vfx from './vfx.js';
import * as avatar from '../player/avatar.js';
import * as camera from '../player/camera.js';

const STEP = 1 / 120;
const TUNE = { trailEvery: 0.018, playerRadius: 0.5, shakeRadius: 30, maxLive: 24 };

let scene = null;
let proto = null;
let seq = 0;
const live = [];
let lastBoom = null;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Vector3();
const NOSE = new THREE.Vector3(0, 0, -1);

function err(msg) { return new Error(`[COMBAT/rockets] ${msg}`); }

function rocketMesh() {
  if (!proto) {
    proto = new THREE.Group();
    const warhead = assets.model('rpg').scene.getObjectByName('MAGAZINE');
    if (warhead) {
      const w = warhead.clone(true);
      warhead.updateWorldMatrix(true, true);
      w.applyMatrix4(warhead.matrixWorld);
      const c = new THREE.Box3().setFromObject(w).getCenter(new THREE.Vector3());
      w.position.sub(c);
      proto.add(w);
    }
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 3.4, 1.2) }));
    glow.position.z = 0.32;
    proto.add(glow);
  }
  return proto.clone(true);
}

/** Start a rocket: {rid, by, o: [x,y,z], v: [x,y,z], t: match ms}. */
function spawn(msg) {
  if (live.some((r) => r.rid === msg.rid)) return;
  if (live.length >= TUNE.maxLive) explode(live[0], live[0].pos.toArray());
  const R = WEAPONS.rpg.rocket;
  const r = {
    rid: msg.rid, owner: msg.by,
    pos: new THREE.Vector3(...msg.o), vel: new THREE.Vector3(...msg.v),
    age: 0, acc: 0, trailT: 0, done: false, mesh: rocketMesh(), from: msg.o,
  };
  scene.add(r.mesh);
  live.push(r);
  // fast-forward a late message so every peer sees the rocket at the same place
  const lag = clamp((state.match.time * 1000 - msg.t) / 1000, 0, R.life);
  if (lag > 0) advance(r, lag, true);
  place(r);
  return r;
}

function advance(r, dt, silent) {
  const R = WEAPONS.rpg.rocket;
  r.acc += dt;
  while (r.acc >= STEP && !r.done) {
    r.acc -= STEP;
    r.age += STEP;
    _a.copy(r.pos);
    r.vel.y -= R.gravity * STEP;
    r.pos.addScaledVector(r.vel, STEP);
    const len = _a.distanceTo(r.pos);
    if (len < 1e-6) continue;
    _d.subVectors(r.pos, _a).divideScalar(len);
    let hitT = Infinity, hitPos = null;
    const w = world.raycast(_a, _d, len);
    if (w) { hitT = w.distance; hitPos = w.point.toArray(); }
    const p = playerHit(r, _a, _d, len);
    if (p && p.t < hitT) { hitT = p.t; hitPos = [_a.x + _d.x * p.t, _a.y + _d.y * p.t, _a.z + _d.z * p.t]; }
    if (hitPos) { explode(r, hitPos); return; }
    if (r.age >= R.life) { explode(r, r.pos.toArray()); return; }
    if (!silent) {
      r.trailT += STEP;
      if (r.trailT >= TUNE.trailEvery) { r.trailT = 0; vfx.rocketTrail([r.pos.x, r.pos.y, r.pos.z], [_d.x, _d.y, _d.z]); }
    }
  }
}

/** First player capsule (feet + 0.25 .. 1.65 m) the segment enters: {t, id} or null. */
function playerHit(r, o, d, len) {
  const R = WEAPONS.rpg.rocket;
  let best = null;
  for (const e of state.players.values()) {
    if (!e.alive || e.life === LIFE.PLANE || e.life === LIFE.SPECTATE || e.life === LIFE.DEAD) continue;
    if (e.id === r.owner && r.age < R.armTime + 0.25) continue;
    // closest approach between the flight segment and the capsule axis, sampled (cheap and exact enough at 0.6 m)
    for (let s = 0; s <= len + 1e-6; s += 0.3) {
      _p.copy(o).addScaledVector(d, Math.min(s, len));
      const y = clamp(_p.y, e.pos.y + 0.25, e.pos.y + 1.65);
      _q.set(e.pos.x, y, e.pos.z);
      if (_p.distanceTo(_q) < TUNE.playerRadius) { const t = Math.min(s, len); if (!best || t < best.t) best = { t, id: e.id }; break; }
    }
  }
  return best;
}

function explode(r, pos) {
  if (r.done) return;
  r.done = true;
  lastBoom = { rid: r.rid, at: pos.map((v) => +v.toFixed(2)), age: +r.age.toFixed(3), from: r.from };
  const i = live.indexOf(r);
  if (i >= 0) live.splice(i, 1);
  r.mesh.removeFromParent();
  const water = world.isWater(pos[0], pos[2]) && pos[1] < 0.6;
  emit(EV.GRENADE_EXPLODE, { gid: r.rid, owner: r.owner, pos, water });
  damage.explosionAt(pos, r.owner, 'rpg');
  const me = localPlayer();
  if (me && me.alive && me.life !== LIFE.PLANE) {
    const k = clamp(1 - me.pos.distanceTo(_p.fromArray(pos)) / TUNE.shakeRadius, 0, 1);
    if (k > 0) camera.addShake(0.35 + 0.9 * k * k, 0.6 + 0.6 * k);
  }
}

function place(r) {
  r.mesh.position.copy(r.pos);
  if (r.vel.lengthSq() > 1e-6) r.mesh.quaternion.setFromUnitVectors(NOSE, _d.copy(r.vel).normalize());
}

// ------------------------------------------------------------------------------------------ public API
export function init(sc) {
  if (!sc) throw err('init needs the world scene');
  scene = sc;
  on(NEV.NET_RKT, ({ from, data }) => {
    if (data.by !== from) return;            // only the shooter announces their rockets
    spawn(data);
    remoteFire(data);
  });
  on(EV.MATCH_START, () => { for (const r of [...live]) { r.done = true; r.mesh.removeFromParent(); } live.length = 0; });
  debug.combat = debug.combat || {};
  Object.assign(debug.combat, { lastRocket: () => lastBoom, rockets: () => live.map((r) => ({ rid: r.rid, pos: r.pos.toArray().map((v) => +v.toFixed(1)), age: +r.age.toFixed(2) })) });
}

/**
 * The local player (or a test) fires: the rocket leaves the launcher's muzzle along the aim ray.
 * @param {string} shooterId @param {THREE.Vector3} aimO camera aim origin @param {THREE.Vector3} aimD unit aim dir
 */
export function fire(shooterId, aimO, aimD) {
  const R = WEAPONS.rpg.rocket;
  const muz = new THREE.Vector3();
  let origin = aimO.clone().addScaledVector(aimD, 1.2);
  if (avatar.getMuzzleWorld(shooterId, muz)) origin = muz.addScaledVector(aimD, 0.15);
  // aim converges on what the crosshair is on
  const target = world.raycast(aimO, aimD, 600);
  const tp = target ? target.point : aimO.clone().addScaledVector(aimD, 600);
  const dir = tp.clone().sub(origin).normalize();
  if (dir.dot(aimD) < 0.5) dir.copy(aimD);
  const msg = {
    rid: `${shooterId.slice(0, 12)}:${++seq}`, by: shooterId,
    o: origin.toArray().map((v) => Math.round(v * 1000) / 1000),
    v: dir.multiplyScalar(R.speed).toArray().map((v) => Math.round(v * 1000) / 1000),
    t: Math.round(state.match.time * 1000),
  };
  spawn(msg);
  if (state.online) { try { session.send('rkt', msg); } catch (e) { /* offline */ } }
  emit(EV.WEAPON_FIRE, { id: shooterId, weapon: 'rpg', origin: msg.o, dir: dir.normalize().toArray(), end: msg.o, local: shooterId === state.selfId, hit: null, muzzle: msg.o });
  return msg.rid;
}

/** Other peers: the shooter's avatar recoils and the launch sounds where they stand. */
function remoteFire(msg) {
  const e = getPlayer(msg.by);
  if (!e) return;
  const v = new THREE.Vector3(...msg.v).normalize();
  emit(EV.WEAPON_FIRE, { id: msg.by, weapon: 'rpg', origin: msg.o, dir: v.toArray(), end: msg.o, local: false, hit: null, muzzle: msg.o });
}

export function update(dt) {
  for (let i = live.length - 1; i >= 0; i--) {
    const r = live[i];
    if (!r) continue;
    advance(r, dt, false);
    if (!r.done) place(r);
  }
}

export const count = () => live.length;
