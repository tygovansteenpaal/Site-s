// ZONEFALL - local player movement. OWNER: PLAYER. Contract: ARCHITECTURE.md 5.2, numbers in config.PLAYER.
// Kinematic character controller driven by input, sub-stepped at <= 1/60 s. Modes follow entity.life:
//   PLANE     ride the transport (match.planePosAt), Space jumps once the doors are open, forced out at forceJumpAt
//   FREEFALL  steer toward the camera yaw; look down + forward dives (to 52 m/s), level + forward glides (26 m/s);
//             Space deploys above minDeployAGL, the chute opens by itself at autoDeployAGL (once per jump)
//   CHUTE     opens over openTime, steers toward the camera yaw at turnRateDeg, W speeds up, S brakes (slower fall),
//             Space cuts it above cutMinAGL (redeploy above redeployMinAGL)
//   GROUND    walk / sprint / crouch (tap toggles, hold is momentary) / slide / jump / mantle-vault / swim, capsule
//             collision through world.collideCapsule, terrain through world.getHeight, floors and props through
//             world.getGround, steps <= stepHeight, slopes <= maxSlopeDeg, fall damage through damage.applyToSelf
//   DEAD      the body falls and settles, no input                       SPECTATE  nothing
// Writes the local entity's pos/vel/life/speed and CROUCH/SPRINT/SLIDE/AIRBORNE/MANTLE flags, and
// state.local.onGround/surface/stance/altitude/canDeploy/inPlane. Yaw/pitch are written by player/camera.look().
// Footsteps are phase-locked to the gait model shared with player/avatar (gaitRate), so third-person feet and the
// footstep sounds land together. Emits PLAYER_JUMP, PLAYER_CHUTE, PLAYER_LAND, FOOTSTEP.
import * as THREE from 'three';
import { PLAYER, SURFACE, WEAPONS } from '../config.js';
import { emit, on, EV } from '../core/bus.js';
import { state, localPlayer, LIFE, FLAG, setFlag, hasFlag, debug } from '../core/state.js';
import { clamp, damp, DEG, angleDelta, smoothstep } from '../core/util.js';
import * as input from '../engine/input.js';
import * as world from '../world/world.js';
import * as match from '../game/match.js';
import * as damage from '../combat/damage.js';

// ------------------------------------------------------------------------------------------ tunables
const TUNE = {
  maxSubstep: 1 / 60,
  coyoteTime: 0.11,            // s after walking off a ledge in which a jump still counts
  jumpBuffer: 0.14,            // s a jump press is remembered before touching down
  crouchHoldTime: 0.28,        // crouch held longer than this acts as "hold to crouch"
  heightLambda: 13,            // capsule height smoothing (crouch/stand/slide transitions)
  eyeLambda: 15,
  sprintMinForward: 0.55,      // forward stick share needed to sprint
  slideSteerDegPerS: 75,
  slideEndSpeed: 3.0,
  slideDownhillAccel: 6.5,     // extra m/s^2 along steep downhill while sliding
  landPenaltyTime: 0.32,       // hard landings briefly slow you down
  landPenaltyMult: 0.55,
  hardLandSpeed: 8.5,
  swimDepth: 1.3,              // feet depth while swimming (head above the water line)
  swimSpeed: 2.5, swimSprint: 3.4,
  wadeDepth: 0.12,             // feet below the water line -> WATER footsteps
  mantleProbes: [0.1, 0.28, 0.46, 0.64],   // forward probe offsets beyond the capsule radius (reach 0.7)
  mantleVaultDepth: 0.55,      // obstacles thinner than this are vaulted over instead of climbed onto
  mantleMaxDrop: 3.2,          // max drop on the far side of a vault
  planeSeat: [0, -2.4, 0],     // m relative to match.planePosAt (inside the cargo bay)
  planeExitBack: 13,           // m behind the plane centre (rear ramp)
  planeExitDown: 3.2,
  planeExitCarry: 0.42,        // share of the plane velocity kept on exit
  ff: { accel: 8.5, decel: 13, strafe: 7, idleForward: 5, diveStartDeg: 12, diveFullDeg: 70, slowFall: 10 },
  chute: { accel: 3.2, strafe: 2.6, brakeForward: 6.0, openDecel: 34 },
};

/**
 * Locomotion gait shared with player/avatar.js (exported), measured from the soldier_a clips: per anchor the game speed
 * s (m/s) where the clip is fully weighted, the clip's natural ground speed v (2 x step length / cycle), its cycle length
 * T (s) and ph, the normalised clip time of the left heel strike (gait phase 0; the right foot plants at 0.5).
 * Playback rate = clamp((speed / v) ^ exp, minRate, maxRate): cadence rises with speed but never to cartoon rates, so a
 * little foot slide is traded for believable step frequency. Two anchors may share a clip (Jog covers 2.5 to 4.6 m/s).
 */
export const GAIT = Object.freeze({
  stand: Object.freeze([
    { clip: 'Idle', s: 0, v: 0, T: 1, ph: 0 },
    { clip: 'Walk', s: 1.25, v: 1.10, T: 1.167, ph: 0.683 },
    { clip: 'Jog', s: 2.5, v: 2.40, T: 0.933, ph: 0.942 },
    { clip: 'Jog', s: 4.6, v: 2.40, T: 0.933, ph: 0.942 },
    { clip: 'Sprint', s: 6.6, v: 3.33, T: 0.567, ph: 0.767 },
  ]),
  crouch: Object.freeze([
    { clip: 'Crouch_Idle', s: 0, v: 0, T: 1, ph: 0 },
    { clip: 'Crouch_Walk', s: 1.0, v: 0.75, T: 2.0, ph: 0.0 },
  ]),
  exp: 0.62, crouchExp: 0.75, minRate: 0.7, maxRate: 1.75,
});

const COS_MAX_SLOPE = Math.cos(PLAYER.maxSlopeDeg * DEG);
const UP = new THREE.Vector3(0, 1, 0);

// ------------------------------------------------------------------------------------------ module state
const st = {
  stance: 'stand',             // 'stand' | 'crouch' | 'slide' | 'swim'
  height: PLAYER.height,
  eye: PLAYER.eyeHeight,
  grounded: false,
  groundY: 0, groundNY: 1, groundNX: 0, groundNZ: 0, surface: SURFACE.GRASS,
  coyote: 0, jumpBuf: 0,
  crouchHeldT: 0, crouchByPress: false,
  sprinting: false,
  slideT: 0, slideCooldown: 0, slideDirX: 0, slideDirZ: 0,
  mantle: null,                // {t, dur, fx, fy, fz, ax, ay, az, tx, ty, tz, vault, stance}
  apexY: 0,                    // highest point since leaving the ground (fall damage)
  landPenalty: 0,
  gaitPhase: 0, gaitStride: 1.4, gaitSide: 0,
  doorsOpen: false,
  chuteT: 0, autoDeployUsed: false, heading: 0, brake: 0,
  lastLife: -1,
  spawned: false,
};

const tmpAxes = { x: 0, y: 0 };
const v3a = new THREE.Vector3(), v3b = new THREE.Vector3(), v3c = new THREE.Vector3();
const capA = new THREE.Vector3(), capB = new THREE.Vector3();
const planePos = new THREE.Vector3(), planePos2 = new THREE.Vector3();
const prevPos = new THREE.Vector3();
const gRes = { y: 0, nx: 0, ny: 1, nz: 0, surface: SURFACE.GRASS };
const rayO = new THREE.Vector3(), rayD = new THREE.Vector3();

// ------------------------------------------------------------------------------------------ world helpers
/** getGround with a terrain fallback and the result unpacked into gRes (no allocation kept). */
function ground(x, z, fromY) {
  let g = null;
  try { g = world.getGround(x, z, fromY); } catch (err) { g = null; }
  if (g && Number.isFinite(g.y)) {
    gRes.y = g.y;
    const n = g.normal;
    if (n) { gRes.nx = n[0]; gRes.ny = n[1]; gRes.nz = n[2]; } else { gRes.nx = 0; gRes.ny = 1; gRes.nz = 0; }
    gRes.surface = g.surface == null ? SURFACE.GRASS : g.surface;
  } else {
    gRes.y = world.getHeight(x, z);
    gRes.nx = 0; gRes.ny = 1; gRes.nz = 0;
    gRes.surface = SURFACE.GRASS;
  }
  return gRes;
}

/** Terrain normal from the analytic height function (finite differences), into out [x, y, z]. */
const tn = { x: 0, y: 1, z: 0 };
function terrainNormal(x, z) {
  const e = 0.35;
  const hx = world.getHeight(x + e, z) - world.getHeight(x - e, z);
  const hz = world.getHeight(x, z + e) - world.getHeight(x, z - e);
  const nx = -hx / (2 * e), nz = -hz / (2 * e);
  const l = Math.hypot(nx, 1, nz);
  tn.x = nx / l; tn.y = 1 / l; tn.z = nz / l;
  return tn;
}

function waterDepthAt(x, z, groundY) {
  let wet = false;
  try { wet = world.isWater(x, z); } catch (err) { wet = groundY < 0; }
  return wet || groundY < 0 ? -groundY : 0;
}

function collide(pos, bottomLift, height, radius) {
  capA.set(pos.x, pos.y + bottomLift + radius, pos.z);
  capB.set(pos.x, pos.y + Math.max(bottomLift + radius, height - radius), pos.z);
  return world.collideCapsule(capA, capB, radius);
}

function blocked(res, tol = 0.012) {
  return !!(res && res.hit && res.push && res.push.lengthSq() > tol * tol);
}

function stanceHeight(s) { return s === 'crouch' ? PLAYER.crouchHeight : s === 'slide' ? PLAYER.slideHeight : PLAYER.height; }
function stanceEye(s) {
  if (s === 'crouch') return PLAYER.crouchEyeHeight;
  if (s === 'slide') return PLAYER.slideEyeHeight;
  if (s === 'swim') return PLAYER.eyeHeight - 0.15;
  return PLAYER.eyeHeight;
}

function canOccupy(pos, height) {
  const r = PLAYER.radius - 0.05;
  return !blocked(collide(pos, PLAYER.stepHeight * 0.6, height, r), 0.02);
}

// ------------------------------------------------------------------------------------------ gait (shared with avatar)
/** Playback rate of one gait anchor at a speed (1 = the clip's own speed). */
export function gaitClipRate(anchor, speed, crouch) {
  if (!(anchor.v > 0)) return 0;
  const r = Math.pow(Math.max(0, speed) / anchor.v, crouch ? GAIT.crouchExp : GAIT.exp);
  return clamp(r, GAIT.minRate, GAIT.maxRate);
}

/**
 * Locomotion gait shared with player/avatar: blend between two neighbouring GAIT anchors and the common cycle rate.
 * @param {number} speed horizontal m/s
 * @param {boolean} crouch
 * @param {object} [out] receives {rate (cycles/s), stride (m per step), i0, i1, w (weight of i1), crouch, table}
 */
export function gaitRate(speed, crouch, out = {}) {
  const table = crouch ? GAIT.crouch : GAIT.stand;
  let i = 0;
  while (i < table.length - 2 && speed > table[i + 1].s) i++;
  const a = table[i], b = table[i + 1];
  const w = clamp((speed - a.s) / Math.max(1e-3, b.s - a.s), 0, 1);
  const fa = a.v > 0 ? gaitClipRate(a, speed, crouch) / a.T : 0;
  const fb = b.v > 0 ? gaitClipRate(b, speed, crouch) / b.T : 0;
  // Idle (v = 0) contributes no cycling: between idle and the first gait the cycle fades in with the walk weight.
  const rate = (1 - w) * fa + w * fb;
  out.rate = rate;
  out.stride = rate > 1e-3 ? speed / (2 * rate) : 1;
  out.i0 = i; out.i1 = i + 1; out.w = w; out.crouch = !!crouch; out.table = table;
  return out;
}

// ------------------------------------------------------------------------------------------ public API
export function init() {
  on(EV.PLANE_DOORS, ({ open }) => { st.doorsOpen = !!open; });
  on(EV.MATCH_START, () => { st.doorsOpen = false; st.autoDeployUsed = false; });
  on(EV.PLAYER_KILLED, ({ id }) => {
    if (id !== state.selfId) return;
    st.mantle = null;
    st.sprinting = false;
  });
  debug.player = debug.player || {};
  Object.assign(debug.player, {
    setPos: (p) => teleport(p),
    /** number: burst of that many m/s along the facing; [x, y, z]: set the velocity. */
    giveSpeed: (v) => {
      const me = localPlayer();
      if (!me) return;
      if (Array.isArray(v)) me.vel.set(v[0], v[1], v[2]);
      else { me.vel.x = -Math.sin(me.yaw) * v; me.vel.z = -Math.cos(me.yaw) * v; }
      if (me.vel.y > 0) st.grounded = false;
    },
    controllerState: () => ({ stance: st.stance, grounded: st.grounded, sprinting: st.sprinting, slideT: st.slideT, mantle: !!st.mantle,
      height: st.height, eye: st.eye, apexY: st.apexY, chuteT: st.chuteT, doorsOpen: st.doorsOpen, gaitPhase: st.gaitPhase }),
  });
}

/**
 * Place the local player for a new life.
 * @param {'plane'|'ground'|'spectate'} mode
 * @param {number[]} [pos] [x, y, z] for 'ground' (y is snapped to getGround)
 */
export function spawn(mode, pos) {
  const me = localPlayer();
  if (!me) throw new Error('[PLAYER/controller] spawn() before the local entity exists (match must createPlayer first)');
  resetMotion();
  me.vel.set(0, 0, 0);
  me.flags &= ~(FLAG.CROUCH | FLAG.SPRINT | FLAG.SLIDE | FLAG.AIRBORNE | FLAG.MANTLE);
  st.spawned = true;
  if (mode === 'plane') {
    me.life = LIFE.PLANE;
    me.alive = true;
    st.autoDeployUsed = false;
    ridePlane(me);
  } else if (mode === 'ground') {
    me.life = LIFE.GROUND;
    me.alive = true;
    const x = pos ? pos[0] : 0, z = pos ? pos[2] : 0;
    const fromY = pos && Number.isFinite(pos[1]) ? pos[1] + 1.5 : Infinity;
    const g = ground(x, z, fromY);
    me.pos.set(x, g.y, z);
    st.grounded = true;
    st.groundY = g.y;
    st.apexY = g.y;
  } else if (mode === 'spectate') {
    me.life = LIFE.SPECTATE;
  } else {
    throw new Error(`[PLAYER/controller] unknown spawn mode '${mode}'`);
  }
  st.lastLife = me.life;
  writeLocal(me);
}

function resetMotion() {
  st.stance = 'stand';
  st.height = PLAYER.height;
  st.eye = PLAYER.eyeHeight;
  st.grounded = false;
  st.coyote = 0; st.jumpBuf = 0;
  st.crouchByPress = false; st.crouchHeldT = 0;
  st.sprinting = false;
  st.slideT = 0; st.slideCooldown = 0;
  st.mantle = null;
  st.landPenalty = 0;
  st.chuteT = 0;
  st.gaitPhase = 0;
}

export function update(dt) {
  const me = localPlayer();
  if (!me || !st.spawned) return;
  if (!(dt > 0)) return;
  if (me.life !== st.lastLife) onLifeChanged(me, st.lastLife);

  switch (me.life) {
    case LIFE.PLANE: updatePlane(me); break;
    case LIFE.FREEFALL:
    case LIFE.CHUTE: updateAir(me, dt); break;
    case LIFE.GROUND: updateGround(me, dt); break;
    case LIFE.DEAD: updateDead(me, dt); break;
    default: break;
  }
  st.lastLife = me.life;
  writeLocal(me);
}

/** Leave the plane now (also triggered by the jump action while doors are open). */
export function jumpFromPlane() {
  const me = localPlayer();
  if (!me || me.life !== LIFE.PLANE) return;
  const t = state.match.time;
  match.planePosAt(t, planePos);
  match.planePosAt(t + 0.1, planePos2);
  const dx = planePos2.x - planePos.x, dz = planePos2.z - planePos.z;
  const len = Math.hypot(dx, dz) || 1;
  const fx = dx / len, fz = dz / len;
  const speed = len / 0.1;
  me.pos.set(planePos.x - fx * TUNE.planeExitBack, planePos.y - TUNE.planeExitDown, planePos.z - fz * TUNE.planeExitBack);
  me.vel.set(fx * speed * TUNE.planeExitCarry, -3, fz * speed * TUNE.planeExitCarry);
  me.life = LIFE.FREEFALL;
  st.heading = Math.atan2(-fx, -fz);
  st.autoDeployUsed = false;
  st.lastLife = me.life;
  st.apexY = me.pos.y;
  emit(EV.PLAYER_JUMP, { id: me.id });
  writeLocal(me);
}

/** Add a velocity change [x, y, z] in m/s (explosion knockback). */
export function applyImpulse(v) {
  const me = localPlayer();
  if (!me || !v) return;
  if (me.life === LIFE.PLANE || me.life === LIFE.SPECTATE) return;
  me.vel.x += v[0]; me.vel.y += v[1]; me.vel.z += v[2];
  if (v[1] > 0.5 && me.life === LIFE.GROUND) { st.grounded = false; st.coyote = 0; }
  if (st.stance === 'slide') endSlide(me);
}

/** Move instantly to [x, y, z] (debug, spawn). */
export function teleport(pos) {
  const me = localPlayer();
  if (!me || !pos) return;
  me.pos.set(pos[0], pos[1], pos[2]);
  me.vel.set(0, 0, 0);
  st.mantle = null;
  st.grounded = false;
  st.apexY = pos[1];
  if (me.life === LIFE.GROUND) {
    const g = ground(pos[0], pos[2], pos[1] + 0.3);
    if (pos[1] - g.y < 0.3) { me.pos.y = g.y; st.grounded = true; st.apexY = g.y; }
  }
  writeLocal(me);
}

/** Eye position for the current stance into out (THREE.Vector3); returns out. */
export function getEye(out) {
  const me = localPlayer();
  if (!me) return out.set(0, PLAYER.eyeHeight, 0);
  switch (me.life) {
    case LIFE.FREEFALL: return out.set(me.pos.x, me.pos.y + 0.9, me.pos.z);
    case LIFE.CHUTE: return out.set(me.pos.x, me.pos.y + PLAYER.eyeHeight - 0.05, me.pos.z);
    case LIFE.DEAD: return out.set(me.pos.x, me.pos.y + 0.35, me.pos.z);
    default: return out.set(me.pos.x, me.pos.y + st.eye, me.pos.z);
  }
}

// ------------------------------------------------------------------------------------------ additions (PLAYER)
/** Local gait for avatar sync: {phase 0..1 (0 = left plant), stride m, side (last foot 0 left / 1 right)}. */
const gaitOut = { phase: 0, stride: 1.4, side: 0 };
export function gait() {
  gaitOut.phase = st.gaitPhase; gaitOut.stride = st.gaitStride; gaitOut.side = st.gaitSide;
  return gaitOut;
}

/** Current stance 'stand' | 'crouch' | 'slide' | 'swim', capsule height and smoothed eye height. */
export function stanceInfo() { return { stance: st.stance, height: st.height, eye: st.eye, grounded: st.grounded, mantle: !!st.mantle, chuteT: st.chuteT }; }

/** Freefall / chute state for the avatar and camera: {chuteT 0..1 canopy opening, brake 0..1, heading rad}. */
const airOut = { chuteT: 0, brake: 0, heading: 0 };
export function airInfo() {
  airOut.chuteT = st.chuteT; airOut.brake = st.brake; airOut.heading = st.heading;
  return airOut;
}

/** True while the doors are open and the local player may jump from the plane. */
export function doorsOpen() {
  if (st.doorsOpen) return true;
  try {
    const p = match.planePath();
    return !!(p && Number.isFinite(p.doorsOpenAt) && state.match.time >= p.doorsOpenAt);
  } catch (err) { return false; }
}

// ------------------------------------------------------------------------------------------ life transitions
function onLifeChanged(me, prev) {
  if (me.life === LIFE.GROUND && prev !== LIFE.GROUND) {
    st.apexY = me.pos.y;
  }
  if (me.life === LIFE.DEAD) {
    st.mantle = null;
    st.sprinting = false;
  }
}

// ------------------------------------------------------------------------------------------ PLANE
function ridePlane(me) {
  const t = state.match.time;
  match.planePosAt(t, planePos);
  match.planePosAt(t + 0.1, planePos2);
  me.pos.set(planePos.x + TUNE.planeSeat[0], planePos.y + TUNE.planeSeat[1], planePos.z + TUNE.planeSeat[2]);
  me.vel.set((planePos2.x - planePos.x) * 10, 0, (planePos2.z - planePos.z) * 10);
}

function updatePlane(me) {
  ridePlane(me);
  if (input.pressed('jump') && doorsOpen()) { jumpFromPlane(); return; }
  let force = Infinity;
  try { const p = match.planePath(); if (p && Number.isFinite(p.forceJumpAt)) force = p.forceJumpAt; } catch (err) { force = Infinity; }
  if (state.match.time >= force) jumpFromPlane();
}

// ------------------------------------------------------------------------------------------ FREEFALL / CHUTE
function agl(me) {
  const g = ground(me.pos.x, me.pos.z, me.pos.y + 0.5);
  const water = waterDepthAt(me.pos.x, me.pos.z, g.y) > 0 ? 0 : -Infinity;
  return me.pos.y - Math.max(g.y, water);
}

function openChute(me) {
  me.life = LIFE.CHUTE;
  st.chuteT = 0;
  st.autoDeployUsed = true;
  st.lastLife = me.life;
  emit(EV.PLAYER_CHUTE, { id: me.id, open: true });
}

function cutChute(me) {
  me.life = LIFE.FREEFALL;
  st.lastLife = me.life;
  st.apexY = me.pos.y;
  emit(EV.PLAYER_CHUTE, { id: me.id, open: false });
}

function updateAir(me, dt) {
  const a = agl(me);
  // Edges once per frame.
  if (input.pressed('jump')) {
    if (me.life === LIFE.FREEFALL) {
      const min = st.autoDeployUsed ? PLAYER.chute.redeployMinAGL : PLAYER.freefall.minDeployAGL;
      if (a > min) openChute(me);
    } else if (a > PLAYER.chute.cutMinAGL) cutChute(me);
  }
  if (me.life === LIFE.FREEFALL && !st.autoDeployUsed && a <= PLAYER.freefall.autoDeployAGL) openChute(me);

  const n = Math.max(1, Math.ceil(dt / TUNE.maxSubstep));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    if (me.life === LIFE.FREEFALL) stepFreefall(me, h); else stepChute(me, h);
    if (airCollide(me)) return;   // landed
  }
}

function stepFreefall(me, h) {
  const F = PLAYER.freefall, T = TUNE.ff;
  const ax = input.moveAxes(tmpAxes);
  const freelook = input.down('freelook');
  if (!freelook) st.heading += clamp(angleDelta(st.heading, me.yaw), -F.turnRateDeg * DEG * h, F.turnRateDeg * DEG * h);
  const fx = -Math.sin(st.heading), fz = -Math.cos(st.heading);
  const rx = Math.cos(st.heading), rz = -Math.sin(st.heading);
  const lookDown = -me.pitch / DEG;            // degrees below the horizon
  const dive = ax.y > 0.1 ? smoothstep(T.diveStartDeg, T.diveFullDeg, lookDown) * ax.y : 0;
  const glide = ax.y > 0.1 ? ax.y * (1 - dive) : 0;
  const fwdTarget = ax.y < -0.1 ? 0 : T.idleForward + (F.glideSpeed - T.idleForward) * glide + 6 * dive;
  const termV = F.terminal + (F.diveTerminal - F.terminal) * dive - (ax.y < -0.1 ? 4 : 0);
  // Horizontal: approach the target velocity in the heading frame.
  const tx = fx * fwdTarget + rx * ax.x * T.strafe;
  const tz = fz * fwdTarget + rz * ax.x * T.strafe;
  const dvx = tx - me.vel.x, dvz = tz - me.vel.z;
  const dl = Math.hypot(dvx, dvz);
  const maxDv = (fwdTarget > Math.hypot(me.vel.x, me.vel.z) ? T.accel : T.decel) * h;
  if (dl > 1e-5) { const k = Math.min(1, maxDv / dl); me.vel.x += dvx * k; me.vel.z += dvz * k; }
  // Vertical: gravity up to the terminal speed, aerodynamic braking above it.
  if (-me.vel.y < termV) me.vel.y = Math.max(-termV, me.vel.y - F.gravity * h);
  else me.vel.y = Math.min(-termV, me.vel.y + T.slowFall * h);
  me.pos.addScaledVector(me.vel, h);
}

function stepChute(me, h) {
  const C = PLAYER.chute, T = TUNE.chute;
  const ax = input.moveAxes(tmpAxes);
  st.chuteT = Math.min(1, st.chuteT + h / C.openTime);
  const open = smoothstep(0, 1, st.chuteT);
  const freelook = input.down('freelook');
  if (!freelook) st.heading += clamp(angleDelta(st.heading, me.yaw), -C.turnRateDeg * DEG * h, C.turnRateDeg * DEG * h);
  const fx = -Math.sin(st.heading), fz = -Math.cos(st.heading);
  const rx = Math.cos(st.heading), rz = -Math.sin(st.heading);
  const brake = ax.y < -0.1 ? -ax.y : 0;
  st.brake = brake;
  const fwd = ax.y > 0.1 ? C.forwardSpeed + (C.maxForward - C.forwardSpeed) * ax.y : C.forwardSpeed - (C.forwardSpeed - T.brakeForward) * brake;
  const fall = C.fallSpeed - (C.fallSpeed - C.brakeFallSpeed) * brake;
  // While opening, the canopy bleeds off freefall speed hard (the "snatch").
  const tx = fx * fwd + rx * ax.x * T.strafe, tz = fz * fwd + rz * ax.x * T.strafe;
  const k = 1 - Math.exp(-(open < 1 ? 3.5 : T.accel) * h);
  me.vel.x += (tx - me.vel.x) * k;
  me.vel.z += (tz - me.vel.z) * k;
  if (-me.vel.y > fall) me.vel.y = Math.min(-fall, me.vel.y + T.openDecel * (0.25 + 0.75 * open) * h);
  else me.vel.y += (-fall - me.vel.y) * (1 - Math.exp(-4 * h));
  me.pos.addScaledVector(me.vel, h);
}

/** Static collision and ground contact while airborne in FREEFALL/CHUTE. Returns true when the player landed. */
function airCollide(me) {
  const r = PLAYER.radius;
  const res = collide(me.pos, 0.2, PLAYER.height, r);
  if (blocked(res)) {
    me.pos.add(res.push);
    const nrm = res.normal;
    const vn = me.vel.dot(nrm);
    if (vn < 0) me.vel.addScaledVector(nrm, -vn);
  }
  const g = ground(me.pos.x, me.pos.z, me.pos.y + 0.6);
  const depth = waterDepthAt(me.pos.x, me.pos.z, g.y);
  const floor = depth > TUNE.swimDepth ? -TUNE.swimDepth : g.y;
  if (me.pos.y > floor) return false;
  // Touchdown.
  const impact = -me.vel.y;
  const wasChute = me.life === LIFE.CHUTE;
  me.pos.y = floor;
  me.life = LIFE.GROUND;
  st.lastLife = me.life;
  st.grounded = true;
  st.groundY = floor;
  st.surface = depth > TUNE.wadeDepth ? SURFACE.WATER : g.surface;
  st.stance = depth > TUNE.swimDepth ? 'swim' : 'stand';
  me.vel.y = 0;
  me.vel.x *= wasChute ? 0.45 : 0.2;
  me.vel.z *= wasChute ? 0.45 : 0.2;
  if (wasChute) emit(EV.PLAYER_CHUTE, { id: me.id, open: false });
  const fall = wasChute ? 0 : Math.max(0, st.apexY - floor);
  emit(EV.PLAYER_LAND, { id: me.id, pos: [me.pos.x, me.pos.y, me.pos.z], speed: impact, fall });
  if (!wasChute && depth <= TUNE.swimDepth) applyFallDamage(fall);
  st.apexY = floor;
  st.landPenalty = impact > TUNE.hardLandSpeed ? TUNE.landPenaltyTime : 0;
  return true;
}

// ------------------------------------------------------------------------------------------ GROUND
function weaponMobility(me) {
  const w = me.weapon && WEAPONS[me.weapon];
  return w && w.mobility ? w.mobility : 1;
}

function updateGround(me, dt) {
  // ---- per-frame input edges
  const ax = input.moveAxes(tmpAxes);
  const ads = state.local.ads || 0;
  if (input.pressed('jump')) st.jumpBuf = TUNE.jumpBuffer;

  if (input.pressed('crouch')) {
    st.crouchHeldT = 0;
    if (st.stance === 'stand') {
      const speedH = Math.hypot(me.vel.x, me.vel.z);
      if (st.sprinting && st.grounded && speedH >= PLAYER.slide.minSpeed && st.slideCooldown <= 0) startSlide(me);
      else { st.stance = 'crouch'; st.crouchByPress = true; }
    } else if (st.stance === 'crouch') {
      if (canOccupy(me.pos, PLAYER.height)) { st.stance = 'stand'; st.crouchByPress = false; }
    } else if (st.stance === 'slide') {
      endSlide(me);
    }
  }
  if (input.down('crouch')) st.crouchHeldT += dt;
  if (input.released('crouch') && st.stance === 'crouch' && st.crouchByPress && st.crouchHeldT > TUNE.crouchHoldTime) {
    if (canOccupy(me.pos, PLAYER.height)) { st.stance = 'stand'; st.crouchByPress = false; }
  }

  // Sprint: forward, standing, not aiming or shooting, on the ground. Sprinting from a crouch stands you up.
  const wantSprint = input.down('sprint') && ax.y >= TUNE.sprintMinForward && ads < 0.25 && !input.down('fire') &&
    !input.down('ads') && st.stance !== 'slide' && st.stance !== 'swim';
  if (wantSprint && st.stance === 'crouch' && input.pressed('sprint') && canOccupy(me.pos, PLAYER.height)) { st.stance = 'stand'; st.crouchByPress = false; }
  st.sprinting = wantSprint && st.stance === 'stand' && (st.grounded || st.sprinting);

  // Mantle attempt: jump pressed near a ledge, or jump held while airborne against one.
  if (!st.mantle && st.stance !== 'swim') {
    const tryIt = (st.jumpBuf > 0 && (st.grounded || st.coyote > 0)) || (!st.grounded && input.down('jump') && me.vel.y < 3.5);
    if (tryIt && (ax.y > 0.1 || st.jumpBuf > 0)) {
      const m = findMantle(me, !st.grounded);
      if (m) startMantle(me, m);
    }
  }

  st.slideCooldown = Math.max(0, st.slideCooldown - dt);
  st.landPenalty = Math.max(0, st.landPenalty - dt);

  // ---- sub-stepped physics
  const n = Math.max(1, Math.ceil(dt / TUNE.maxSubstep));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    if (st.mantle) { stepMantle(me, h); continue; }
    stepGround(me, h, ax, ads);
  }

  // ---- stance shape smoothing
  st.height = damp(st.height, stanceHeight(st.stance), TUNE.heightLambda, dt);
  st.eye = damp(st.eye, stanceEye(st.stance), TUNE.eyeLambda, dt);
}

function stepGround(me, h, ax, ads) {
  const P = PLAYER;
  const r = P.radius;
  const yaw = me.yaw;
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  const fx = -sy, fz = -cy, rx = cy, rz = -sy;

  // ---- wish velocity
  let base;
  if (st.stance === 'swim') base = st.sprinting || input.down('sprint') ? TUNE.swimSprint : TUNE.swimSpeed;
  else if (st.stance === 'crouch') base = P.crouchSpeed;
  else base = st.sprinting ? P.sprintSpeed : P.walkSpeed;
  let mx = ax.x * P.strafeMult;
  let my = ax.y < 0 ? ax.y * P.backwardMult : ax.y;
  const mobility = weaponMobility(me);
  let mult = mobility * (1 - (1 - P.adsSpeedMult) * clamp(ads, 0, 1));
  if (st.landPenalty > 0) mult *= TUNE.landPenaltyMult;
  const wx = (rx * mx + fx * my) * base * mult;
  const wz = (rz * mx + fz * my) * base * mult;

  // ---- horizontal acceleration
  if (st.stance === 'slide') {
    stepSlideVelocity(me, h, ax);
  } else if (st.grounded) {
    const dvx = wx - me.vel.x, dvz = wz - me.vel.z;
    const dl = Math.hypot(dvx, dvz);
    const hasInput = Math.abs(ax.x) + Math.abs(ax.y) > 0.01;
    if (hasInput) {
      if (dl > 1e-6) { const k = Math.min(1, (P.accelGround * h) / dl); me.vel.x += dvx * k; me.vel.z += dvz * k; }
    } else {
      const f = Math.exp(-P.friction * h);
      me.vel.x *= f; me.vel.z *= f;
      if (me.vel.x * me.vel.x + me.vel.z * me.vel.z < 0.0025) { me.vel.x = 0; me.vel.z = 0; }
    }
  } else {
    // Air: keep momentum, steer a little toward the wish direction (never speeds you past it).
    const dvx = wx - me.vel.x, dvz = wz - me.vel.z;
    const dl = Math.hypot(dvx, dvz);
    if (dl > 1e-6 && Math.abs(ax.x) + Math.abs(ax.y) > 0.01) {
      const k = Math.min(1, (P.accelAir * (0.5 + P.airControl * 2) * h) / dl);
      me.vel.x += dvx * k; me.vel.z += dvz * k;
    }
  }

  // ---- jump
  if (st.jumpBuf > 0) {
    st.jumpBuf -= h;
    if ((st.grounded || st.coyote > 0) && st.stance !== 'swim') {
      if (st.stance === 'crouch') {
        if (canOccupy(me.pos, P.height)) { st.stance = 'stand'; st.crouchByPress = false; }
        st.jumpBuf = 0;
      } else {
        if (st.stance === 'slide') { endSlide(me, true); me.vel.x *= 0.94; me.vel.z *= 0.94; }
        me.vel.y = P.jumpVelocity;
        st.grounded = false;
        st.coyote = 0;
        st.jumpBuf = 0;
        st.apexY = me.pos.y;
        emitStep(me, st.surface, false);
      }
    }
  }

  // ---- gravity
  if (!st.grounded) me.vel.y -= P.gravity * h;

  // ---- integrate horizontal, with terrain steepness handling
  prevPos.copy(me.pos);
  me.pos.x += me.vel.x * h;
  me.pos.z += me.vel.z * h;
  me.pos.y += me.vel.y * h;
  limitTerrain(me);

  // ---- static geometry (buildings, props, rocks, trunks)
  const height = Math.min(st.height, stanceHeight(st.stance) + 0.25);
  const lift = st.grounded ? clamp(height - 2 * r - 0.02, 0.05, P.stepHeight) : 0.12;
  for (let it = 0; it < 3; it++) {
    const res = collide(me.pos, lift, height, r);
    if (!blocked(res, 0.002)) break;
    me.pos.add(res.push);
    const nrm = res.normal;
    const vn = me.vel.x * nrm.x + me.vel.y * nrm.y + me.vel.z * nrm.z;
    if (vn < 0) { me.vel.x -= nrm.x * vn; me.vel.y -= nrm.y * vn; me.vel.z -= nrm.z * vn; }
    if (nrm.y < -0.5 && me.vel.y > 0) me.vel.y = 0;
  }

  // ---- ground contact
  const wasGrounded = st.grounded;
  const g = ground(me.pos.x, me.pos.z, me.pos.y + (wasGrounded ? P.stepHeight : 0.25));
  const depth = waterDepthAt(me.pos.x, me.pos.z, g.y);
  const swimming = depth > TUNE.swimDepth + 0.05;
  const floorY = swimming ? -TUNE.swimDepth : g.y;
  const walkable = swimming || g.ny >= COS_MAX_SLOPE;
  const snap = wasGrounded && walkable && st.jumpBuf <= 0 ? P.stepHeight : 0.0005;
  st.groundNX = g.nx; st.groundNY = g.ny; st.groundNZ = g.nz;

  if (me.vel.y <= 0.01 && me.pos.y <= floorY + snap) {
    const impact = -me.vel.y;
    me.pos.y = floorY;
    if (walkable) {
      me.vel.y = 0;
      if (!wasGrounded) land(me, impact, depth);
      st.grounded = true;
      st.coyote = TUNE.coyoteTime;
    } else {
      // Too steep: slide down, never stick.
      st.grounded = false;
      const nhx = g.nx, nhz = g.nz, nl = Math.hypot(nhx, nhz) || 1;
      const acc = P.gravity * Math.sqrt(Math.max(0, 1 - g.ny * g.ny));
      me.vel.x += (nhx / nl) * acc * h;
      me.vel.z += (nhz / nl) * acc * h;
      me.vel.y = Math.min(0, me.vel.y);
    }
    st.groundY = floorY;
  } else {
    if (wasGrounded) st.apexY = Math.max(me.pos.y, prevPos.y);
    st.grounded = false;
    st.coyote = Math.max(0, st.coyote - h);
  }
  if (!st.grounded) st.apexY = Math.max(st.apexY, me.pos.y);

  // Swimming / wading state.
  if (swimming && me.pos.y <= floorY + 0.01) {
    if (st.stance !== 'swim') { st.stance = 'swim'; st.sprinting = false; }
  } else if (st.stance === 'swim' && !swimming) {
    st.stance = 'stand';
  }
  st.surface = depth > TUNE.wadeDepth ? SURFACE.WATER : g.surface;

  // Ceiling check when standing up is blocked: stay crouched.
  if (st.stance === 'stand' && st.height < P.height - 0.05 && !canOccupy(me.pos, P.height)) { st.stance = 'crouch'; st.crouchByPress = true; }

  // ---- slide timing
  if (st.stance === 'slide') {
    st.slideT += h;
    const sp = Math.hypot(me.vel.x, me.vel.z);
    if (st.slideT >= P.slide.duration + 0.35 || (st.slideT > 0.25 && sp < TUNE.slideEndSpeed) || (!st.grounded && st.slideT > 0.1 && me.vel.y < -4)) endSlide(me);
  }

  // ---- footsteps (phase-locked gait)
  advanceGait(me, h);
}

function limitTerrain(me) {
  // The terrain is not part of collideCapsule: refuse to walk up slopes steeper than maxSlopeDeg or into terrain walls.
  const th = world.getHeight(me.pos.x, me.pos.z);
  if (th <= me.pos.y + 0.02) return;
  const climb = th - Math.max(prevPos.y, st.groundY);
  const n = terrainNormal(me.pos.x, me.pos.z);
  if (n.y >= COS_MAX_SLOPE && climb <= PLAYER.stepHeight) return;
  const nl = Math.hypot(n.x, n.z);
  if (nl < 1e-4) return;
  const nx = n.x / nl, nz = n.z / nl;          // horizontal downhill direction
  const dx = me.pos.x - prevPos.x, dz = me.pos.z - prevPos.z;
  const into = dx * nx + dz * nz;               // < 0 when moving uphill
  if (into < 0) {
    me.pos.x -= nx * into; me.pos.z -= nz * into;
    const vin = me.vel.x * nx + me.vel.z * nz;
    if (vin < 0) { me.vel.x -= nx * vin; me.vel.z -= nz * vin; }
  }
  if (world.getHeight(me.pos.x, me.pos.z) > me.pos.y + PLAYER.stepHeight) { me.pos.x = prevPos.x; me.pos.z = prevPos.z; }
}

function land(me, impact, depth) {
  const fall = Math.max(0, st.apexY - me.pos.y);
  st.apexY = me.pos.y;
  if (impact < 1.2 && fall < 0.35) return;
  emit(EV.PLAYER_LAND, { id: me.id, pos: [me.pos.x, me.pos.y, me.pos.z], speed: impact, fall });
  if (depth <= TUNE.swimDepth) applyFallDamage(fall);
  if (impact > TUNE.hardLandSpeed) st.landPenalty = TUNE.landPenaltyTime;
  emitStep(me, st.surface, false);
}

function applyFallDamage(fall) {
  const F = PLAYER.fall;
  if (fall <= F.safeHeight) return;
  const amount = clamp(((fall - F.safeHeight) / (F.lethalHeight - F.safeHeight)) * PLAYER.health, 0, PLAYER.health);
  if (amount <= 0) return;
  damage.applyToSelf(amount, { kind: 'fall', from: null, weapon: 'fall', zone: null, dir: null });
}

// ------------------------------------------------------------------------------------------ slide
function startSlide(me) {
  const sp = Math.hypot(me.vel.x, me.vel.z) || 1;
  st.stance = 'slide';
  st.slideT = 0;
  st.slideDirX = me.vel.x / sp;
  st.slideDirZ = me.vel.z / sp;
  const boost = Math.max(sp, PLAYER.slide.boost);
  me.vel.x = st.slideDirX * boost;
  me.vel.z = st.slideDirZ * boost;
  st.sprinting = false;
  st.crouchByPress = true;
  emitStep(me, st.surface, true);
}

function endSlide(me, toStand = false) {
  if (st.stance !== 'slide') return;
  st.slideCooldown = PLAYER.slide.cooldown;
  const stand = (toStand || !input.down('crouch')) && canOccupy(me.pos, PLAYER.height);
  st.stance = stand ? 'stand' : 'crouch';
  st.crouchByPress = !stand;
}

function stepSlideVelocity(me, h, ax) {
  const S = PLAYER.slide;
  // Steer gently toward the stick direction.
  const yaw = me.yaw;
  const wx = Math.cos(yaw) * ax.x - Math.sin(yaw) * ax.y, wz = -Math.sin(yaw) * ax.x - Math.cos(yaw) * ax.y;
  if (Math.abs(ax.x) + Math.abs(ax.y) > 0.1) {
    const cur = Math.atan2(st.slideDirX, st.slideDirZ), want = Math.atan2(wx, wz);
    const turn = clamp(angleDelta(cur, want), -TUNE.slideSteerDegPerS * DEG * h, TUNE.slideSteerDegPerS * DEG * h);
    const a = cur + turn;
    st.slideDirX = Math.sin(a); st.slideDirZ = Math.cos(a);
  }
  let sp = Math.hypot(me.vel.x, me.vel.z);
  // Boost decays over the slide duration (friction), downhill keeps you going.
  sp *= Math.exp(-S.friction * h * (st.slideT < S.duration ? 1 : 1.8) * 0.42);
  if (st.grounded && st.groundNY < 0.995) {
    const downhill = st.groundNX * st.slideDirX + st.groundNZ * st.slideDirZ;
    sp += downhill * TUNE.slideDownhillAccel * h;
  }
  sp = Math.max(0, sp);
  me.vel.x = st.slideDirX * sp;
  me.vel.z = st.slideDirZ * sp;
}

// ------------------------------------------------------------------------------------------ mantle / vault
function findMantle(me, airborne) {
  const M = PLAYER.mantle, r = PLAYER.radius;
  const fx = -Math.sin(me.yaw), fz = -Math.cos(me.yaw);
  const baseY = me.pos.y;
  const minH = airborne ? 0.3 : M.minHeight;
  let prevTop = baseY;
  for (let i = 0; i < TUNE.mantleProbes.length; i++) {
    const off = TUNE.mantleProbes[i];
    if (off > M.reach + 0.02) break;
    const d = r + off;
    const px = me.pos.x + fx * d, pz = me.pos.z + fz * d;
    const g = ground(px, pz, baseY + M.maxHeight + 0.08);
    const top = g.y, hgt = top - baseY, ny = g.ny;
    if (hgt < minH || ny < 0.72) { prevTop = top; continue; }
    if (hgt > M.maxHeight + 0.08) return null;
    if (prevTop > baseY + PLAYER.stepHeight + 0.05 && i > 0) return null;   // the approach itself is already a ledge
    // Head room along the way: two rays from above our feet toward the ledge.
    for (const yy of [top + 0.3, top + PLAYER.crouchHeight - 0.15]) {
      rayO.set(me.pos.x, yy, me.pos.z);
      rayD.set(fx, 0, fz);
      const hit = world.raycast(rayO, rayD, d + r + 0.1);
      if (hit && hit.distance < d + 0.05) return null;
    }
    // Thin obstacle (sill, fence, low wall)? Look for its far side.
    const farD = d + TUNE.mantleVaultDepth;
    const gf = ground(me.pos.x + fx * farD, me.pos.z + fz * farD, top + 0.05);
    const thin = top - gf.y > 0.45;
    const apex = v3a.set(px + fx * 0.05, top + 0.04, pz + fz * 0.05);
    if (thin) {
      const landD = d + TUNE.mantleVaultDepth + r + 0.1;
      const lx = me.pos.x + fx * landD, lz = me.pos.z + fz * landD;
      const gl = ground(lx, lz, top + 0.05);
      if (top - gl.y <= TUNE.mantleMaxDrop && gl.ny >= COS_MAX_SLOPE) {
        const landPos = v3b.set(lx, gl.y, lz);
        if (canOccupy(apex, PLAYER.crouchHeight - 0.1) && canOccupy(landPos, PLAYER.crouchHeight)) {
          return {
            vault: true, hgt, tx: lx, ty: gl.y, tz: lz, ax: apex.x, ay: apex.y, az: apex.z,
            stance: canOccupy(landPos, PLAYER.height) ? 'stand' : 'crouch',
          };
        }
      }
    }
    // Climb on top.
    const tD = d + r * 0.9;
    const tx = me.pos.x + fx * tD, tz = me.pos.z + fz * tD;
    const gt = ground(tx, tz, top + 0.1);
    const ty = Math.abs(gt.y - top) < 0.2 ? gt.y : top;
    const target = v3c.set(Math.abs(gt.y - top) < 0.2 ? tx : apex.x, ty, Math.abs(gt.y - top) < 0.2 ? tz : apex.z);
    if (!canOccupy(target, PLAYER.crouchHeight)) return null;
    return {
      vault: false, hgt, tx: target.x, ty: target.y, tz: target.z, ax: target.x, ay: target.y, az: target.z,
      stance: canOccupy(target, PLAYER.height) ? 'stand' : 'crouch',
    };
  }
  return null;
}

function startMantle(me, m) {
  const M = PLAYER.mantle;
  const dur = M.duration * (0.72 + 0.28 * clamp(m.hgt / M.maxHeight, 0, 1)) * (m.vault ? 1.15 : 1);
  st.mantle = { t: 0, dur, fx: me.pos.x, fy: me.pos.y, fz: me.pos.z, ...m };
  st.jumpBuf = 0;
  st.sprinting = false;
  if (st.stance === 'slide') endSlide(me);
  me.vel.set(0, 0, 0);
  emitStep(me, st.surface, false);
}

function stepMantle(me, h) {
  const m = st.mantle;
  m.t = Math.min(1, m.t + h / m.dur);
  const u = m.t;
  if (m.vault) {
    // Up onto the obstacle, across, and down the far side.
    if (u < 0.5) {
      const k = u / 0.5;
      const ky = 1 - Math.pow(1 - k, 3);
      me.pos.set(m.fx + (m.ax - m.fx) * smoothstep(0.15, 1, k), m.fy + (m.ay + 0.12 - m.fy) * ky, m.fz + (m.az - m.fz) * smoothstep(0.15, 1, k));
    } else {
      const k = (u - 0.5) / 0.5;
      const ky = k * k;
      me.pos.set(m.ax + (m.tx - m.ax) * k, m.ay + 0.12 + (m.ty - m.ay - 0.12) * ky, m.az + (m.tz - m.az) * k);
    }
  } else {
    const ky = 1 - Math.pow(1 - Math.min(1, u / 0.62), 3);
    const kx = smoothstep(0.28, 1, u);
    me.pos.set(m.fx + (m.tx - m.fx) * kx, m.fy + (m.ty + 0.02 - m.fy) * ky, m.fz + (m.tz - m.fz) * kx);
  }
  if (m.t >= 1) {
    me.pos.set(m.tx, m.ty, m.tz);
    const fx = -Math.sin(me.yaw), fz = -Math.cos(me.yaw);
    const carry = m.vault ? 3.2 : 1.2;
    me.vel.set(fx * carry, 0, fz * carry);
    st.stance = m.stance;
    st.crouchByPress = m.stance === 'crouch';
    st.grounded = true;
    st.groundY = m.ty;
    st.apexY = m.ty;
    st.mantle = null;
    emit(EV.PLAYER_LAND, { id: me.id, pos: [me.pos.x, me.pos.y, me.pos.z], speed: 2.2, fall: 0 });
    emitStep(me, ground(me.pos.x, me.pos.z, me.pos.y + 0.3).surface, false);
  }
}

// ------------------------------------------------------------------------------------------ DEAD
function updateDead(me, dt) {
  const n = Math.max(1, Math.ceil(dt / TUNE.maxSubstep));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    const g = ground(me.pos.x, me.pos.z, me.pos.y + 0.5);
    const depth = waterDepthAt(me.pos.x, me.pos.z, g.y);
    const floor = depth > TUNE.swimDepth ? -0.4 : g.y;
    if (me.pos.y > floor + 0.001) {
      me.vel.y -= PLAYER.gravity * h;
      me.pos.addScaledVector(me.vel, h);
      if (me.pos.y <= floor) { me.pos.y = floor; me.vel.set(0, 0, 0); }
    } else {
      me.pos.y = floor;
      const f = Math.exp(-6 * h);
      me.vel.x *= f; me.vel.z *= f; me.vel.y = 0;
      me.pos.x += me.vel.x * h; me.pos.z += me.vel.z * h;
    }
  }
  st.grounded = true;
}

// ------------------------------------------------------------------------------------------ gait + footsteps
const gaitTmp = {};
function advanceGait(me, h) {
  const sp = Math.hypot(me.vel.x, me.vel.z);
  if (!st.grounded || st.stance === 'slide' || st.mantle) return;
  const crouch = st.stance === 'crouch';
  const g = gaitRate(st.stance === 'swim' ? sp * 0.7 : sp, crouch, gaitTmp);
  st.gaitStride = g.stride;
  if (sp < 0.35) {
    // Settle onto the nearest planted foot so the next step starts cleanly.
    return;
  }
  // Backpedalling runs the cycle backwards (the avatar plays the gait in reverse).
  const fwdDot = (-Math.sin(me.yaw)) * me.vel.x + (-Math.cos(me.yaw)) * me.vel.z;
  const dir = fwdDot < -0.3 * sp ? -1 : 1;
  const prev = st.gaitPhase;
  let p = prev + dir * g.rate * h;
  p -= Math.floor(p);
  // Plant events at phase 0 (left) and 0.5 (right), in either direction.
  const crossed = (a, b, mark) => (dir > 0 ? (a < mark && b >= mark) || (b < a && (mark >= a || mark <= b)) : (a > mark && b <= mark) || (b > a && (mark <= a || mark >= b)));
  if (crossed(prev, p, 0.5)) { st.gaitSide = 1; emitStep(me, st.surface, false); }
  else if (crossed(prev, p, 0) || crossed(prev, p, 1)) { st.gaitSide = 0; emitStep(me, st.surface, false); }
  st.gaitPhase = p;
}

function emitStep(me, surface, slide) {
  emit(EV.FOOTSTEP, {
    id: me.id, pos: [me.pos.x, me.pos.y, me.pos.z], surface,
    sprint: st.sprinting || slide, crouch: st.stance === 'crouch', local: true,
  });
}

// ------------------------------------------------------------------------------------------ shared state
function writeLocal(me) {
  const L = state.local;
  me.speed = Math.hypot(me.vel.x, me.vel.z);
  const ground = me.life === LIFE.GROUND;
  setFlag(me, FLAG.CROUCH, ground && st.stance === 'crouch');
  setFlag(me, FLAG.SPRINT, ground && st.sprinting && me.speed > 1);
  setFlag(me, FLAG.SLIDE, ground && st.stance === 'slide');
  setFlag(me, FLAG.MANTLE, ground && !!st.mantle);
  setFlag(me, FLAG.AIRBORNE, (ground && !st.grounded && !st.mantle) || me.life === LIFE.FREEFALL || me.life === LIFE.CHUTE);
  L.onGround = ground && st.grounded;
  L.surface = st.surface;
  L.stance = ground ? st.stance : 'stand';
  L.inPlane = me.life === LIFE.PLANE;
  if (me.life === LIFE.FREEFALL || me.life === LIFE.CHUTE) {
    const a = agl(me);
    L.altitude = Math.max(0, a);
    L.canDeploy = me.life === LIFE.FREEFALL
      ? a > (st.autoDeployUsed ? PLAYER.chute.redeployMinAGL : PLAYER.freefall.minDeployAGL)
      : a > PLAYER.chute.cutMinAGL;
  } else if (me.life === LIFE.PLANE) {
    L.altitude = Math.max(0, me.pos.y);
    L.canDeploy = doorsOpen();
  } else {
    L.altitude = 0;
    L.canDeploy = false;
  }
}
