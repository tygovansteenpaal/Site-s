// ZONEFALL - drivable cars (McLaren P1, assets/vehicles/p1.glb). OWNER: GAME.
//
// Cars park at fixed road-side spots (TUNE.spawns) and are reset at every match start. Walk up to one and press
// interact to get in, interact again to get out. While driving, the local entity carries FLAG.DRIVE and sits at the
// car's position with yaw = the car's heading, so the regular 20 Hz player snapshot moves the car on every other
// peer: remote cars simply follow their driver's entity. Only entering and leaving are messages ('veh': car id,
// driver or null, pose), and the lower peer id wins when two players grab the same car in the same instant.
//
// Arcade physics on the analytic terrain plus the static BVH: throttle / brake / reverse on forward-back, steering
// with left-right (bicycle model, less lock at speed), handbrake on jump, boost on sprint. Four wheel probes give
// height, pitch and roll; a body capsule against the BVH pushes the car out of walls and kills the speed into them.
// Top speed is higher on asphalt; water floods the engine. The camera chases the car (player/camera.js asks
// cameraFor()). No shooting from the driver's seat (combat/weapons checks FLAG.DRIVE).
import * as THREE from 'three';
import { on, emit, EV } from '../core/bus.js';
import { state, debug, localPlayer, getPlayer, LIFE, FLAG, hasFlag, setFlag } from '../core/state.js';
import { clamp, damp, dampAngle, wrapAngle } from '../core/util.js';
import { SURFACE } from '../config.js';
import * as assets from '../engine/assets.js';
import * as input from '../engine/input.js';
import * as world from '../world/world.js';
import { roads } from '../world/heightfield.js';
import * as session from '../net/session.js';
import { NEV } from '../net/session.js';
import * as controller from '../player/controller.js';

const TUNE = {
  // [road id, near x, near z, side (+1 left of travel, -1 right)]
  spawns: [['R2', -70, 52, 1], ['R10', 30, -210, -1], ['R12', 240, -38, 1], ['R1', 58, 320, -1], ['R8', -202, 165, 1],
    ['R3', 190, -145, -1], ['R6', -380, 0, 1], ['R11', -150, -60, -1]],
  enterDist: 3.4,
  wheelbase: 2.66, track: 1.9,
  accel: 13, accelBoost: 19, accelRev: 7, brake: 26, coast: 2.4, handbrake: 16,
  topRoad: 44, topOff: 27, topBoost: 1.22, topRev: 11, topWater: 3,
  steerMax: 0.6, steerFall: 16, steerLambda: 9, driftYaw: 1.45,
  gravity: 22, cliff: 0.9,
  body: { h: 1.05, r: 0.78, half: 1.75 },
  seat: [0.42, 0.25, 0.15],             // driver feet in car space (x right, y up, z back)
  exit: [-2.1, 0, 0.2],                 // where the driver steps out (left side)
  cam: { dist: 7.2, height: 2.5, look: 1.1, lambda: 6 },
  wheelR: 0.34,
};

const cars = [];                         // {id, obj, wheels, pos, yaw, v, vy, steer, pitch, roll, driver, spin}
let scene = null;
let mine = null;                         // the car the local player drives
const _a = new THREE.Vector3(), _b = new THREE.Vector3();

function err(msg) { return new Error(`[GAME/vehicles] ${msg}`); }

// ------------------------------------------------------------------------------------------ build and spawn
function makeCar(id) {
  const obj = new THREE.Group();
  obj.name = 'car:' + id;
  const model = assets.cloneModel('p1');
  model.rotation.y = Math.PI;            // the model's nose points +Z; cars drive along their local -Z like players
  obj.add(model);
  model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  const wheels = {};
  for (const k of ['lf', 'rf', 'lr', 'rr']) wheels[k] = model.getObjectByName('ZF_wheel_' + k);
  scene.add(obj);
  return { id, obj, wheels, pos: new THREE.Vector3(), yaw: 0, v: 0, vy: 0, steer: 0, pitch: 0, roll: 0, driver: null, spin: 0, home: null };
}

/** Parking pose for a spawn spec: in the outer lane of the road near (nx, nz), shuffled along until the body is clear. */
function spawnPose(spec) {
  const [rid, nx, nz, side] = spec;
  const r = roads.find((q) => q.id === rid);
  if (!r) throw err(`spawn road '${rid}' missing`);
  let best = Infinity, bi = 0;
  for (let i = 0; i < r.xs.length; i++) { const d = Math.hypot(r.xs[i] - nx, r.zs[i] - nz); if (d < best) { best = d; bi = i; } }
  const off = Math.max(0.6, r.half - 1.25);
  let first = null;
  for (const k of [0, 3, -3, 6, -6, 9, -9, 12, -12]) {
    const i = clamp(bi + k, 0, r.xs.length - 2);
    const tx = r.xs[i + 1] - r.xs[i], tz = r.zs[i + 1] - r.zs[i], tl = Math.hypot(tx, tz) || 1;
    const x = r.xs[i] - (tz / tl) * side * off, z = r.zs[i] + (tx / tl) * side * off;
    const pose = { x, z, yaw: Math.atan2(-tx / tl, -tz / tl) };
    if (!first) first = pose;
    const probe = { pos: new THREE.Vector3(x, 0, z), yaw: pose.yaw };
    probe.pos.y = groundAt(x, z, 400).y;
    const hb = TUNE.body.half, by = probe.pos.y + TUNE.body.h;
    _a.set(wx(probe, 0, -hb - 1), by, wz(probe, 0, -hb - 1)); _b.set(wx(probe, 0, hb + 1), by, wz(probe, 0, hb + 1));
    const hit = world.collideCapsule(_a, _b, TUNE.body.r + 0.3);
    if (!hit || !hit.hit) return pose;
  }
  return first;
}

function resetAll() {
  for (const c of cars) {
    c.driver = null; c.v = 0; c.vy = 0; c.steer = 0;
    c.pos.set(c.home.x, 0, c.home.z);
    c.yaw = c.home.yaw;
    settle(c, true);
    place(c, 0);
  }
  if (mine) leave(false);
}

// ------------------------------------------------------------------------------------------ physics
const wx = (c, lx, lz) => c.pos.x + lx * Math.cos(c.yaw) + lz * Math.sin(c.yaw);
const wz = (c, lx, lz) => c.pos.z - lx * Math.sin(c.yaw) + lz * Math.cos(c.yaw);
function groundAt(x, z, fromY) {
  try { return world.getGround(x, z, fromY); } catch (e) { return { y: 0, surface: SURFACE.GRASS }; }
}

/** Terrain under the four wheels -> ground height, pitch, roll. snap: put the car on it. Returns {y, surface}. */
function settle(c, snap) {
  const hw = TUNE.track / 2, hb = TUNE.wheelbase / 2, from = c.pos.y + 1.6;
  const f = (lx, lz) => groundAt(wx(c, lx, lz), wz(c, lx, lz), snap ? 400 : from);
  const lf = f(-hw, -hb), rf = f(hw, -hb), lr = f(-hw, hb), rr = f(hw, hb);
  const y = (lf.y + rf.y + lr.y + rr.y) / 4;
  c.gPitch = Math.atan2((lf.y + rf.y) / 2 - (lr.y + rr.y) / 2, TUNE.wheelbase);
  c.gRoll = Math.atan2((rf.y + rr.y) / 2 - (lf.y + lr.y) / 2, TUNE.track);
  if (snap) { c.pos.y = y; c.pitch = c.gPitch; c.roll = c.gRoll; }
  return { y, surface: lf.surface };
}

function drive(c, dt, me) {
  const ax = input.moveAxes();
  const boost = input.down('sprint');
  const hand = input.down('jump');
  const fwdX = -Math.sin(c.yaw), fwdZ = -Math.cos(c.yaw);
  const g = settle(c, false);
  const grounded = c.pos.y <= g.y + 0.12;
  const water = g.y < -0.4;
  const road = g.surface === SURFACE.ASPHALT || g.surface === SURFACE.CONCRETE;
  let top = (road ? TUNE.topRoad : TUNE.topOff) * (boost ? TUNE.topBoost : 1);
  if (water) top = TUNE.topWater;
  // longitudinal
  if (grounded) {
    const thr = ax.y;
    if (thr > 0.05) c.v += (c.v < -0.5 ? TUNE.brake : boost ? TUNE.accelBoost : TUNE.accel) * thr * dt;
    else if (thr < -0.05) c.v -= (c.v > 0.5 ? TUNE.brake : TUNE.accelRev) * -thr * dt;
    else c.v -= Math.sign(c.v) * Math.min(Math.abs(c.v), TUNE.coast * dt);
    if (hand) c.v -= Math.sign(c.v) * Math.min(Math.abs(c.v), TUNE.handbrake * dt);
    if (c.v > top) c.v = damp(c.v, top, 2.5, dt);
    if (c.v < -TUNE.topRev) c.v = damp(c.v, -TUNE.topRev, 2.5, dt);
    // slope: gravity along the heading
    c.v -= Math.sin(c.gPitch) * 9.81 * dt * 0.6;
  }
  // steering (bicycle model)
  const lock = TUNE.steerMax / (1 + Math.abs(c.v) / TUNE.steerFall);
  c.steer = damp(c.steer, -ax.x * lock, TUNE.steerLambda, dt);
  if (grounded) c.yaw = wrapAngle(c.yaw + (c.v / TUNE.wheelbase) * Math.tan(c.steer) * (hand ? TUNE.driftYaw : 1) * dt);
  // move, then resolve against the BVH
  const ox = c.pos.x, oz = c.pos.z;
  c.pos.x += fwdX * c.v * dt;
  c.pos.z += fwdZ * c.v * dt;
  c.pos.x = clamp(c.pos.x, -595, 595); c.pos.z = clamp(c.pos.z, -595, 595);
  const hb = TUNE.body.half, by = c.pos.y + TUNE.body.h;
  _a.set(wx(c, 0, -hb), by, wz(c, 0, -hb)); _b.set(wx(c, 0, hb), by, wz(c, 0, hb));
  const hit = world.collideCapsule(_a, _b, TUNE.body.r);
  c.lastHit = hit && hit.hit ? [hit.normal.x, hit.normal.y, hit.normal.z].map((v) => +v.toFixed(2)) : null;
  if (hit && hit.hit) {
    c.pos.x += hit.push.x; c.pos.z += hit.push.z;
    const n = hit.normal, into = -(fwdX * n.x + fwdZ * n.z);
    if (into > 0.25) c.v *= into > 0.8 ? -0.18 : 1 - into * 0.7;
  }
  // vertical: follow the ground, fall off ledges, refuse cliffs
  const g2 = settle(c, false);
  if (g2.y - c.pos.y > TUNE.cliff && c.pos.y <= g.y + 0.2) {
    c.pos.x = ox; c.pos.z = oz; c.v *= -0.2;
  } else if (c.pos.y > g2.y + 0.05) {
    // airborne (off a crest or a ledge): fall until the wheels touch
    c.vy -= TUNE.gravity * dt;
    c.pos.y += c.vy * dt;
    if (c.pos.y <= g2.y) { c.pos.y = g2.y; c.vy = 0; }
  } else {
    c.pos.y = g2.y; c.vy = 0;
  }
  c.pitch = damp(c.pitch, c.pos.y > g2.y + 0.3 ? c.pitch : c.gPitch, 10, dt);
  c.roll = damp(c.roll, c.gRoll - c.steer * Math.min(1, Math.abs(c.v) / 30) * 0.08, 8, dt);
  // the driver rides along
  seatDriver(c, me);
}

function seatDriver(c, e) {
  const [sx, sy, sz] = TUNE.seat;
  e.pos.set(wx(c, sx, sz), c.pos.y + sy, wz(c, sx, sz));
  e.yaw = c.yaw;
  e.vel.set(-Math.sin(c.yaw) * c.v, c.vy, -Math.cos(c.yaw) * c.v);
  e.speed = Math.abs(c.v);
}

function place(c, dt) {
  c.obj.position.copy(c.pos);
  c.obj.rotation.set(c.pitch, c.yaw, c.roll, 'YXZ');
  c.spin += (c.v / TUNE.wheelR) * dt;
  for (const [k, w] of Object.entries(c.wheels)) {
    if (!w) continue;
    w.rotation.set(-c.spin, k[1] === 'f' ? c.steer : 0, 0, 'YXZ');
  }
}

// ------------------------------------------------------------------------------------------ enter / exit
function nearestFree(me) {
  let best = null, bd = TUNE.enterDist;
  for (const c of cars) {
    if (c.driver) continue;
    const d = Math.hypot(c.pos.x - me.pos.x, c.pos.z - me.pos.z) - 1.2;
    if (d < bd && Math.abs(c.pos.y - me.pos.y) < 2.5) { best = c; bd = d; }
  }
  return best;
}

function send(c) {
  if (!state.online) return;
  try { session.send('veh', { id: c.id, d: c.driver, p: [c.pos.x, c.pos.y, c.pos.z].map((v) => Math.round(v * 100) / 100), y: Math.round(c.yaw * 1e4) / 1e4, s: Math.round(c.v * 10) / 10 }); } catch (e) { /* offline */ }
}

function enter(c) {
  const me = localPlayer();
  if (!me || c.driver) return;
  c.driver = me.id;
  mine = c;
  setFlag(me, FLAG.DRIVE, true);
  c.v = 0;
  seatDriver(c, me);
  send(c);
  emit(EV.TOAST, { text: 'In the P1: W/S drive, A/D steer, Space handbrake, Shift boost', kind: 'info', ms: 3200 });
}

function leave(announce = true) {
  const c = mine;
  const me = localPlayer();
  mine = null;
  if (me) setFlag(me, FLAG.DRIVE, false);
  if (!c) return;
  c.driver = null;
  c.v *= 0.3;
  if (announce) send(c);
  if (me && me.alive) {
    const [ex, , ez] = TUNE.exit;
    let x = wx(c, ex, ez), z = wz(c, ex, ez);
    const g = groundAt(x, z, c.pos.y + 2);
    if (g.y - c.pos.y > 1.5) { x = wx(c, -ex, ez); z = wz(c, -ex, ez); }
    controller.teleport([x, groundAt(x, z, c.pos.y + 2).y + 0.05, z]);
  }
}

function onNet({ from, data }) {
  const c = cars.find((q) => q.id === data.id);
  if (!c) return;
  if (data.d) {
    // someone got in; if that is our car too, the lower id keeps it
    if (mine === c && data.d !== state.selfId) {
      if (data.d < state.selfId) leave(false); else { send(c); return; }
    }
    if (data.d !== from) return;          // only the driver announces themselves
    c.driver = data.d;
  } else if (c.driver === from || !c.driver) {
    c.driver = null;
    c.pos.set(data.p[0], data.p[1], data.p[2]);
    c.yaw = data.y; c.v = data.s;
    settle(c, false);
  }
}

// ------------------------------------------------------------------------------------------ public API
export function init(sc) {
  scene = sc;
  for (let i = 0; i < TUNE.spawns.length; i++) {
    const c = makeCar(String(i));
    c.home = spawnPose(TUNE.spawns[i]);
    cars.push(c);
  }
  on(EV.MATCH_START, resetAll);
  on(NEV.NET_VEH, onNet);
  on(EV.PLAYER_KILLED, ({ id }) => { if (id === state.selfId && mine) leave(true); for (const c of cars) if (c.driver === id) c.driver = null; });
  on(EV.PLAYER_REMOVE, ({ id }) => { for (const c of cars) if (c.driver === id) c.driver = null; });
  debug.game = debug.game || {};
  Object.assign(debug.game, {
    cars: () => cars.map((c) => ({ id: c.id, pos: c.pos.toArray().map((v) => +v.toFixed(1)), yaw: +c.yaw.toFixed(2), v: +c.v.toFixed(1), driver: c.driver, hit: c.lastHit || null })),
    enterCar: (id) => { const c = cars.find((q) => q.id === String(id)); if (c) enter(c); return !!c; },
    leaveCar: () => leave(true),
  });
}

/** Per frame, after the controller (it skips its own movement while FLAG.DRIVE is set). */
export function update(dt) {
  if (!scene || !(dt > 0)) return;
  const me = localPlayer();
  const L = state.local;
  const inMatch = state.match.phase !== 'idle';
  // the local driver
  let used = false;                         // the interact press that got us out must not put us straight back in
  if (mine) {
    if (!me || !me.alive || me.life !== LIFE.GROUND || !inMatch) leave(true);
    else if (input.pressed('interact')) { leave(true); used = true; }
    else drive(mine, Math.min(dt, 0.05), me);
  }
  // entering
  L.vehicle = null;
  if (!mine && me && me.alive && me.life === LIFE.GROUND && inMatch) {
    const c = nearestFree(me);
    if (c) {
      L.vehicle = { id: c.id, label: 'McLaren P1' };
      if (!used && !L.nearby && input.pressed('interact')) enter(c);
    }
  }
  if (mine) L.vehicle = { id: mine.id, label: 'McLaren P1', driving: true, kmh: Math.round(Math.abs(mine.v) * 3.6) };
  // remote drivers: the car follows the driver's entity (seat offset removed)
  for (const c of cars) {
    if (c === mine || !c.driver) { place(c, dt); continue; }
    const e = getPlayer(c.driver);
    if (!e || !hasFlag(e, FLAG.DRIVE)) { place(c, dt); continue; }
    const [sx, , sz] = TUNE.seat;
    c.yaw = dampAngle(c.yaw, e.yaw, 14, dt);
    const tx = e.pos.x - (sx * Math.cos(c.yaw) + sz * Math.sin(c.yaw)), tz = e.pos.z - (-sx * Math.sin(c.yaw) + sz * Math.cos(c.yaw));
    c.v = e.speed * Math.sign((tx - c.pos.x) * -Math.sin(c.yaw) + (tz - c.pos.z) * -Math.cos(c.yaw) || 1);
    c.pos.set(tx, e.pos.y - TUNE.seat[1], tz);
    settle(c, false);
    c.pitch = damp(c.pitch, c.gPitch, 10, dt); c.roll = damp(c.roll, c.gRoll, 8, dt);
    place(c, dt);
  }
}

/** Chase camera for the local driver: writes camera position and look target; false when not driving. */
export function cameraFor(orbitYaw, orbitPitch, outPos, outLook) {
  const c = mine;
  if (!c) return false;
  const T = TUNE.cam;
  const yaw = c.yaw + orbitYaw;
  const p = clamp(0.18 + orbitPitch, -0.2, 0.9);
  outLook.set(c.pos.x, c.pos.y + T.look, c.pos.z);
  outPos.set(c.pos.x + Math.sin(yaw) * Math.cos(p) * T.dist, c.pos.y + T.height * 0.5 + Math.sin(p) * T.dist, c.pos.z + Math.cos(yaw) * Math.cos(p) * T.dist);
  const gy = groundAt(outPos.x, outPos.z, outPos.y + 3).y + 0.6;
  if (outPos.y < gy) outPos.y = gy;
  return true;
}

export const driving = () => !!mine;
export const all = () => cars;
