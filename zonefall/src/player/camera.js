// ZONEFALL - camera rig: look, third/first person, ADS through the sights, recoil, shake, death cam, spectate, menu
// flyover. OWNER: PLAYER. Contract: ARCHITECTURE.md 5.2.
//
// look(dt) runs early in the frame (before controller and weapons): mouse / right stick -> the local entity's yaw/pitch
// (sensitivity x PLAYER.mouseRadPerPx, ADS sensitivity scaled by the zoom, invert Y, pitch clamp), recoil applied over a
// few frames, and the recoil recovery of ARCHITECTURE.md 6.3 (autoRecover x the burst's climb at `recover` deg/s once
// the trigger is released, reduced by however much the player already pulled down). Alt is free look: the camera
// orbits while the body keeps its heading (freefall and chute steering ignore it).
// update(dt) runs late: places gfx.camera by mode and writes state.local.eye/aimDir/fov/mode/spectating.
// Modes (state.local.mode):
//   'menu'      slow cinematic drone orbit over Kessler Isle (menu, lobby, loading)
//   'plane'     orbit around the transport (mouse), 'freefall' / 'chute' third-person chase with speed FOV and buffeting
//   'tp'        over-the-shoulder third person on the ground (default view): damped pivot, shoulder swap (Q),
//               collision-aware boom (5-ray probe, snaps in, eases out), FOV kick on sprint and slide
//   (ADS)       aiming from third person: the camera travels from the shoulder to the first-person eye as
//               state.local.ads rises (head, helmet and gear shadow-only on the way); past TUNE.adsFpAt the mode is
//               'fp' and combat/viewmodel's detailed weapon and sights take over (INTEGRATION: the avatar's own
//               low-detail hands filled the screen when the camera sat in its sight)
//   'fp'        first person at controller.getEye with head bob (V toggles tp/fp, remembered); the avatar is
//               shadow-only and combat/viewmodel draws the weapon
//   'dead'      2.5 s: rise out of the body, orbit it, turn toward the killer, then automatic spectate
//   'spectate'  over-the-shoulder of another living player (cycleSpectate), or the plane / chase cams they are in
//   'results'   slow orbit around the last focus point
import * as THREE from 'three';
import { PLAYER, RENDER, WEAPONS } from '../config.js';
import { on, EV } from '../core/bus.js';
import { state, gfx, LIFE, FLAG, hasFlag, localPlayer, getPlayer, APP, debug } from '../core/state.js';
import * as settings from '../core/settings.js';
import { clamp, damp, dampAngle, angleDelta, DEG, smoothstep, settingsFovToVertical, lerp, storage } from '../core/util.js';
import { ALL_SITES } from '../core/mapdata.js';
import * as input from '../engine/input.js';
import * as controller from './controller.js';
import * as avatar from './avatar.js';
import * as plane from '../game/plane.js';
import * as world from '../world/world.js';

// ------------------------------------------------------------------------------------------ tunables
const TUNE = {
  viewKey: 'zonefall.view.v1',
  tp: {
    pivotStand: 1.56, pivotCrouch: 1.06, pivotSlide: 0.78, pivotSwim: 1.72,
    shoulder: 0.56, up: 0.1, dist: 2.3, distSprint: 2.65, distCrouch: 2.05, distAds: 1.5,
    probe: 0.16, margin: 0.14, minDist: 0.25,
    inLambda: 40, outLambda: 4.5, shoulderLambda: 9,
    pivotLambdaH: 26, pivotLambdaV: 12,
    bob: 0.35,
  },
  fpBob: { amp: 0.028, sway: 0.016 },
  sprintFovKick: 0.075, slideFovKick: 0.11, fovLambda: 9,
  chase: { freefallDist: 4.6, freefallUp: 1.9, chuteDist: 8.0, chuteUp: 2.7, freefallFovKick: 0.16 },
  planeOrbit: { dist: 42, up: 6 },
  death: { duration: 2.5, dist: 4.2, up: 2.2 },
  spectate: { dist: 2.9, shoulder: 0.5 },
  menu: { radius: 360, height: 105, speed: 0.011, lookRadius: 120 },
  results: { radius: 6.5, height: 2.4, speed: 0.12 },
  recoilApplyRate: 38,          // 1/s: pending recoil is applied over a few frames, never as a snap
  recoilReleaseDelay: 0.09,     // s without new recoil (or trigger up) before recovery starts
  shake: { maxDeg: 2.6, maxPos: 0.045, freq: 18 },
  landSpring: { k: 160, c: 17, perSpeed: 0.022, max: 0.32 },
  flinch: { k: 220, c: 22, deg: 1.6 },
  freelookReturn: 7,
  adsTravelExp: 2.6,            // ease exponent of the shoulder -> sight camera travel
  adsTravelLambda: 40,
  adsHideDist: 0.6,             // closer than this to the eye: the body is drawn as arms only (shadow kept)
  adsFpAt: 0.55,                // ADS travel beyond which the first-person view model draws the sights
};

// ------------------------------------------------------------------------------------------ module state
let camObj = null;
let view = storage.get(TUNE.viewKey, 'tp') === 'fp' ? 'fp' : 'tp';
let shoulder = 1;                 // +1 right shoulder, -1 left
let shoulderX = TUNE.tp.shoulder;
let boom = TUNE.tp.dist;
let fovNow = 70;
let kickNow = 0;
let modeNow = 'menu';
const pivot = new THREE.Vector3();
let pivotInit = false;
let freeYaw = 0, freePitch = 0;
let orbitYaw = 0, orbitPitch = -0.25;
let deathT = -1;
const deathPos = new THREE.Vector3();
let spectating = null;
let menuT = Math.random() * 100;
let resultsT = 0;
const resultsFocus = new THREE.Vector3();
let lastLife = -1;
// recoil
let pendP = 0, pendY = 0, burstClimb = 0, lastRecoilAt = -1e9, recoverBudget = 0, inBurst = false;
// shake / springs
let trauma = 0, traumaDecay = 2.5, shakeT = 0;
let landY = 0, landV = 0;
let flinchP = 0, flinchPV = 0, flinchY = 0, flinchYV = 0;
let bobT = 0;
let adsTravel = 0, lastRawAds = 0, adsDir = 1;

const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), tmp3 = new THREE.Vector3();
const fwd = new THREE.Vector3(), right = new THREE.Vector3();
const eye = new THREE.Vector3(), camPos = new THREE.Vector3(), lookAt = new THREE.Vector3();
const rayO = new THREE.Vector3(), rayD = new THREE.Vector3();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const UP = new THREE.Vector3(0, 1, 0);
const shakeSeeds = [Math.random() * 10, Math.random() * 10, Math.random() * 10, Math.random() * 10, Math.random() * 10, Math.random() * 10];

function err(msg) { return new Error(`[PLAYER/camera] ${msg}`); }

// ------------------------------------------------------------------------------------------ helpers
function dirFrom(yaw, pitch, out) {
  const cp = Math.cos(pitch);
  return out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}
function rightFrom(yaw, out) { return out.set(Math.cos(yaw), 0, -Math.sin(yaw)); }

function baseFov() { return settingsFovToVertical(settings.get('fov')); }

function adsFovTarget(me) {
  if (state.local.adsFov > 0) return state.local.adsFov;
  const W = me && me.weapon && WEAPONS[me.weapon];
  return baseFov() * (W && W.adsFovMult ? W.adsFovMult : 0.8);
}

function adsBlend() {
  const a = clamp(state.local.ads || 0, 0, 1);
  // ease in-out so the camera leaves the shoulder gently and settles into the sight
  return a * a * (3 - 2 * a);
}

function raycast(o, d, max) {
  try { return world.raycast(o, d, max); } catch (e) { return null; }
}

/** Distance along d from o before the probe hits static geometry or terrain (5 rays: centre + 4 offsets). */
const prR = new THREE.Vector3(), prU = new THREE.Vector3();
function probeDistance(o, d, max, radius) {
  let best = max;
  // probe frame perpendicular to d (private temporaries: callers keep their own right/up vectors)
  prR.crossVectors(d, UP);
  if (prR.lengthSq() < 1e-6) prR.set(1, 0, 0); else prR.normalize();
  prU.crossVectors(prR, d).normalize();
  for (let i = 0; i < 5; i++) {
    rayO.copy(o);
    if (i === 1) rayO.addScaledVector(prR, radius);
    else if (i === 2) rayO.addScaledVector(prR, -radius);
    else if (i === 3) rayO.addScaledVector(prU, radius);
    else if (i === 4) rayO.addScaledVector(prU, -radius);
    const h = raycast(rayO, d, max + radius);
    if (h && h.distance < best + radius) best = Math.min(best, h.distance - (i === 0 ? radius : radius * 0.5));
  }
  return Math.max(0, best);
}

function pivotHeight(e, isLocal) {
  if (isLocal) {
    const s = controller.stanceInfo();
    if (s.stance === 'swim') return TUNE.tp.pivotSwim;
    // follow the controller's smoothed eye, offset to the shoulder line
    return clamp(s.eye - 0.08, TUNE.tp.pivotSlide, TUNE.tp.pivotStand);
  }
  if (hasFlag(e, FLAG.SLIDE)) return TUNE.tp.pivotSlide;
  if (hasFlag(e, FLAG.CROUCH)) return TUNE.tp.pivotCrouch;
  return TUNE.tp.pivotStand;
}

function setMode(m) {
  modeNow = m;
  state.local.mode = m;
}

// ------------------------------------------------------------------------------------------ public API
/** @param {import('three').PerspectiveCamera} camera  gfx.camera */
export function init(camera) {
  if (!camera) throw err('init needs gfx.camera');
  camObj = camera;
  camObj.rotation.order = 'YXZ';
  fovNow = RENDER.menuFov;
  camObj.fov = fovNow;
  camObj.updateProjectionMatrix();
  on(EV.MATCH_START, () => { resetMatch(); });
  on(EV.APP_STATE, ({ to }) => {
    if (to === APP.RESULTS) { resultsT = 0; captureResultsFocus(); }
    if (to === APP.MENU || to === APP.LOBBY) { spectating = null; state.local.spectating = null; }
  });
  on(EV.PLAYER_KILLED, ({ id }) => {
    if (id === state.selfId && deathT < 0) startDeathCam();
    if (spectating === id) setTimeout(() => { if (spectating === id) setSpectate(null); }, 1200);
  });
  on(EV.PLAYER_LAND, ({ id, speed }) => {
    if (id !== state.selfId) return;
    landV -= Math.min(TUNE.landSpring.max, (speed || 0) * TUNE.landSpring.perSpeed) * 9;
    if (speed > 9) addShake(clamp(speed / 30, 0.15, 0.6), 0.45);
  });
  on(EV.BULLET_NEAR, () => addShake(0.14, 0.25));
  on(EV.PLAYER_DAMAGED, ({ id, amount, dir, kind }) => {
    if (id !== state.selfId || kind === 'zone') return;
    const k = clamp((amount || 10) / 40, 0.2, 1);
    addShake(0.18 + 0.3 * k, 0.35);
    // Flinch away from the hit direction (a view punch that springs back; aim is not changed).
    let side = (Math.random() - 0.5);
    if (Array.isArray(dir)) {
      const me = localPlayer();
      if (me) { rightFrom(me.yaw, right); side = clamp(-(dir[0] * right.x + dir[2] * right.z), -1, 1); }
    }
    flinchPV += TUNE.flinch.deg * DEG * 14 * k;
    flinchYV += side * TUNE.flinch.deg * DEG * 10 * k;
  });
  debug.player = debug.player || {};
  Object.assign(debug.player, {
    camera: () => ({ mode: modeNow, view, shoulder, boom: +boom.toFixed(3), fov: +fovNow.toFixed(2), spectating, deathT,
      pos: camObj.position.toArray().map((v) => +v.toFixed(3)) }),
    setView: (v) => setView(v),
    swapShoulder: () => { shoulder = -shoulder; },
    cameraTune: TUNE,
  });
}

/** Early in the frame: apply mouse look and recoil (plus recovery) to the local entity's yaw/pitch. */
export function look(dt) {
  const me = localPlayer();
  const m = input.mouse();
  const pad = input.stick('look');
  if (input.pressed('view')) setView(view === 'tp' ? 'fp' : 'tp');
  if (input.pressed('shoulder')) shoulder = -shoulder;
  if (!me) return;
  const ads = clamp(state.local.ads || 0, 0, 1);
  const zoom = Math.tan(fovNow * 0.5 * DEG) / Math.tan(baseFov() * 0.5 * DEG);
  const sens = settings.get('sensitivity') * lerp(1, settings.get('adsSensitivity') * Math.min(1, zoom), ads);
  const inv = settings.get('invertY') ? -1 : 1;
  const padRate = input.padLookRate() * dt * settings.get('sensitivity') * lerp(1, settings.get('adsSensitivity') * Math.min(1, zoom), ads);
  const dYaw = -m.dx * PLAYER.mouseRadPerPx * sens - pad.x * padRate;
  const dPitch = (-m.dy * PLAYER.mouseRadPerPx * sens - pad.y * padRate) * inv;
  const lim = PLAYER.pitchLimitDeg * DEG;
  const freelook = input.down('freelook') && ads < 0.05;

  switch (me.life) {
    case LIFE.DEAD:
    case LIFE.SPECTATE:
      orbitYaw += dYaw;
      orbitPitch = clamp(orbitPitch + dPitch, -1.2, 0.6);
      return;
    case LIFE.FREEFALL:
    case LIFE.CHUTE:
    case LIFE.GROUND:
      if (freelook) {
        freeYaw = clamp(freeYaw + dYaw, -2.6, 2.6);
        freePitch = clamp(freePitch + dPitch, -1.2, 1.0);
      } else {
        me.yaw += dYaw;
        me.pitch = clamp(me.pitch + dPitch, me.life === LIFE.GROUND ? -lim : -88 * DEG, me.life === LIFE.GROUND ? lim : 45 * DEG);
        freeYaw = damp(freeYaw, 0, TUNE.freelookReturn, dt);
        freePitch = damp(freePitch, 0, TUNE.freelookReturn, dt);
      }
      break;
    case LIFE.PLANE:
      me.yaw += dYaw;
      me.pitch = clamp(me.pitch + dPitch, -70 * DEG, 30 * DEG);
      return;
    default:
      return;
  }
  // ---- recoil: pending kick applied over a few frames
  const now = performance.now();
  if (pendP !== 0 || pendY !== 0) {
    const k = 1 - Math.exp(-TUNE.recoilApplyRate * dt);
    const ap = pendP * k, ay = pendY * k;
    me.pitch = clamp(me.pitch + ap, -lim, lim);
    me.yaw += ay;
    pendP -= ap; pendY -= ay;
    if (Math.abs(pendP) < 1e-6) pendP = 0;
    if (Math.abs(pendY) < 1e-6) pendY = 0;
    burstClimb += ap;
  }
  // ---- recovery after the trigger is released
  const W = me.weapon && WEAPONS[me.weapon];
  const released = !input.down('fire') || now - lastRecoilAt > 250;
  if (inBurst && released && now - lastRecoilAt > TUNE.recoilReleaseDelay * 1000) {
    inBurst = false;
    recoverBudget = Math.max(0, burstClimb) * (W && W.recoil ? W.recoil.autoRecover : 0.4);
    burstClimb = 0;
  }
  if (recoverBudget > 0) {
    if (dPitch < 0) recoverBudget = Math.max(0, recoverBudget + dPitch);   // the player already pulled down
    const rate = (W && W.recoil ? W.recoil.recover : 10) * DEG;
    const step = Math.min(recoverBudget, rate * dt);
    me.pitch = clamp(me.pitch - step, -lim, lim);
    recoverBudget -= step;
  }
}

/** Late in the frame: position/orient gfx.camera, apply shake, update FOV and state.local camera fields. */
export function update(dt) {
  if (!camObj) return;
  springs(dt);
  const app = state.app;
  let targetFov = baseFov();
  if (app === APP.MATCH) {
    const me = localPlayer();
    if (!me) { menuCam(dt); targetFov = RENDER.menuFov; }
    else {
      if (me.life !== lastLife) onLifeChange(me, lastLife);
      lastLife = me.life;
      targetFov = matchCam(me, dt);
    }
  } else if (app === APP.RESULTS) {
    resultsCam(dt);
    targetFov = RENDER.menuFov + 10;
  } else {
    menuCam(dt);
    targetFov = RENDER.menuFov;
  }
  // FOV: exact during ADS (the sight picture must not lag), damped otherwise.
  const ads = adsBlend();
  if (ads > 0.001 && app === APP.MATCH) fovNow = targetFov;
  else fovNow = damp(fovNow, targetFov, TUNE.fovLambda, dt);
  if (Math.abs(camObj.fov - fovNow) > 1e-3) { camObj.fov = fovNow; camObj.updateProjectionMatrix(); }
  state.local.fov = fovNow;
  // Shake and springs on top of the final transform.
  applyShake(dt);
  camObj.updateMatrixWorld();
}

/** Add recoil in degrees (pitch up positive, yaw right positive); weapons calls this per shot. */
export function addRecoil(pitchDeg, yawDeg) {
  pendP += (pitchDeg || 0) * DEG;
  pendY -= (yawDeg || 0) * DEG;
  const now = performance.now();
  if (!inBurst) { inBurst = true; burstClimb = 0; recoverBudget = 0; }
  lastRecoilAt = now;
}

/** Trauma-style shake: amount 0..1 adds trauma that decays over ~duration seconds. */
export function addShake(amount, duration = 0.4) {
  trauma = clamp(trauma + Math.max(0, amount || 0), 0, 1);
  traumaDecay = Math.max(traumaDecay * 0.5, 1 / Math.max(0.05, duration));
}

/** Aim ray from the eye along the view direction (recoil included) into outOrigin/outDir (THREE.Vector3). */
export function getAimRay(outOrigin, outDir) {
  const me = localPlayer();
  if (!me) {
    outOrigin.copy(camObj ? camObj.position : tmp.set(0, 0, 0));
    return outDir.set(0, 0, -1).applyQuaternion(camObj ? camObj.quaternion : new THREE.Quaternion());
  }
  dirFrom(me.yaw, me.pitch, outDir);
  controller.getEye(eye);
  if (me.life !== LIFE.GROUND || view === 'fp') { outOrigin.copy(eye); return outDir; }
  // Looking through the sights (first-person view model): the shot leaves from the eye along the sight line.
  if (adsTravel > TUNE.adsFpAt) { outOrigin.copy(eye); return outDir; }
  // Third person: start the ray where the crosshair line passes the shoulder plane, so the shot lands exactly under the
  // crosshair without hitting anything between the camera and the player; never start inside a wall beside the head.
  tpCameraPosition(me, tmp2);
  const t = tmp3.subVectors(eye, tmp2).dot(outDir);
  outOrigin.copy(tmp2).addScaledVector(outDir, Math.max(0, t));
  rayD.subVectors(outOrigin, eye);
  const len = rayD.length();
  if (len > 1e-3) {
    rayD.multiplyScalar(1 / len);
    const h = raycast(eye, rayD, len);
    if (h) outOrigin.copy(eye).addScaledVector(rayD, Math.max(0, h.distance - 0.05));
  }
  return outDir;
}

/** Spectate a player id (null = automatic: killer, then next alive). Writes state.local.spectating. */
export function setSpectate(id) {
  let target = id;
  if (target != null) {
    const p = getPlayer(target);
    if (!p || !p.alive || target === state.selfId) target = null;
  }
  if (target == null) {
    const killer = state.local.killer && state.local.killer.id;
    const kp = killer ? getPlayer(killer) : null;
    if (kp && kp.alive && killer !== state.selfId) target = killer;
    else target = nearestAlive();
  }
  spectating = target;
  state.local.spectating = target;
  if (target) { const p = getPlayer(target); if (p) { orbitYaw = 0; orbitPitch = -0.2; } }
  return target;
}

/** Cycle spectate target: dir = +1 / -1 over living players. */
export function cycleSpectate(dir) {
  const list = [];
  for (const p of state.players.values()) if (p.alive && p.id !== state.selfId && p.life !== LIFE.SPECTATE) list.push(p.id);
  if (!list.length) { spectating = null; state.local.spectating = null; return null; }
  list.sort();
  let i = list.indexOf(spectating);
  i = i < 0 ? 0 : (i + (dir < 0 ? -1 : 1) + list.length) % list.length;
  spectating = list[i];
  state.local.spectating = spectating;
  return spectating;
}

// ------------------------------------------------------------------------------------------ additions (PLAYER)
/** Ground view preference: 'tp' (over the shoulder, default) or 'fp'. Persisted per browser. */
export function setView(v) {
  if (v !== 'tp' && v !== 'fp') throw err(`unknown view '${v}'`);
  view = v;
  storage.set(TUNE.viewKey, v);
}
export function getView() { return view; }
/** +1 right shoulder, -1 left. */
export function getShoulder() { return shoulder; }

// ------------------------------------------------------------------------------------------ modes
function resetMatch() {
  pivotInit = false;
  deathT = -1;
  spectating = null;
  state.local.spectating = null;
  freeYaw = freePitch = 0;
  pendP = pendY = 0; recoverBudget = 0; inBurst = false;
  trauma = 0;
  lastLife = -1;
}

function onLifeChange(me, prev) {
  if (me.life === LIFE.GROUND) { pivotInit = false; }
  if (me.life === LIFE.DEAD && deathT < 0) startDeathCam();
  if (me.life !== LIFE.DEAD && me.life !== LIFE.SPECTATE) deathT = -1;
  if (me.life === LIFE.SPECTATE && !spectating) setSpectate(null);
}

function startDeathCam() {
  deathT = 0;
  deathPos.copy(camObj.position);
  const me = localPlayer();
  orbitYaw = me ? me.yaw : 0;
  orbitPitch = -0.35;
}

function matchCam(me, dt) {
  switch (me.life) {
    case LIFE.PLANE: return planeCam(me, dt);
    case LIFE.FREEFALL:
    case LIFE.CHUTE: return chaseCam(me, dt, me.life === LIFE.CHUTE);
    case LIFE.GROUND: return groundCam(me, dt);
    case LIFE.DEAD: return deadCam(me, dt);
    default: return spectateCam(dt);
  }
}

function tpCameraPosition(me, out) {
  const yaw = me.yaw + freeYaw, pitch = me.pitch + freePitch;
  dirFrom(yaw, pitch, fwd);
  rightFrom(yaw, right);
  const base = pivotInit ? pivot : tmp3.set(me.pos.x, me.pos.y + pivotHeight(me, true), me.pos.z);
  out.copy(base).addScaledVector(right, shoulderX);
  out.y += TUNE.tp.up;
  out.addScaledVector(fwd, -boom);
  return out;
}

function groundCam(me, dt) {
  const T = TUNE.tp;
  controller.getEye(eye);
  const ads = adsBlend();
  const speed = me.speed || 0;
  const sprint = hasFlag(me, FLAG.SPRINT) && speed > 4.5;
  const slide = hasFlag(me, FLAG.SLIDE);
  // FOV kick (sprint, slide), blended out by ADS.
  const kick = slide ? TUNE.slideFovKick : sprint ? TUNE.sprintFovKick : 0;
  kickNow = damp(kickNow, kick, 6, dt);
  const fovHip = baseFov() * (1 + kickNow);
  const fov = lerp(fovHip, adsFovTarget(me), ads);
  // Head bob phase from the controller's gait (shared with the footstep sounds).
  const g = controller.gait();
  const bobAmp = clamp(speed / PLAYER.sprintSpeed, 0, 1) * (controller.stanceInfo().grounded ? 1 : 0);
  bobT = g.phase;
  const bobY = (Math.cos(bobT * Math.PI * 4) - 1) * 0.5 * TUNE.fpBob.amp * bobAmp;
  const bobX = Math.sin(bobT * Math.PI * 2) * TUNE.fpBob.sway * bobAmp;
  const yaw = me.yaw + freeYaw, pitch = me.pitch + freePitch;
  dirFrom(yaw, pitch, fwd);
  rightFrom(yaw, right);

  if (view === 'fp') {
    setMode('fp');
    avatar.setLocalViewMode('hidden');
    camPos.copy(eye).addScaledVector(right, bobX * (1 - ads));
    camPos.y += bobY * (1 - ads * 0.8) + landY;
    placeCamera(camPos, yaw, pitch);
    writeLocal(me);
    return fov;
  }
  // ---- third person pivot (damped; horizontal tight, vertical softer for steps and stance changes)
  const ph = pivotHeight(me, true);
  tmp.set(me.pos.x, me.pos.y + ph, me.pos.z);
  if (!pivotInit) { pivot.copy(tmp); pivotInit = true; boom = T.dist; }
  pivot.x = damp(pivot.x, tmp.x, T.pivotLambdaH, dt);
  pivot.z = damp(pivot.z, tmp.z, T.pivotLambdaH, dt);
  pivot.y = damp(pivot.y, tmp.y, T.pivotLambdaV, dt);
  // ---- shoulder offset with a lateral collision check
  const wantShoulder = T.shoulder * shoulder;
  tmp2.copy(right).multiplyScalar(Math.sign(wantShoulder));
  const side = probeDistance(pivot, tmp2, Math.abs(wantShoulder) + T.margin, 0.08);
  const sideMax = Math.max(0, side - T.margin);
  const targetSX = Math.sign(wantShoulder) * Math.min(Math.abs(wantShoulder), sideMax);
  shoulderX = damp(shoulderX, targetSX, Math.abs(targetSX) < Math.abs(shoulderX) && Math.sign(targetSX) === Math.sign(shoulderX) ? 30 : T.shoulderLambda, dt);
  const sh = tmp3.copy(pivot).addScaledVector(right, shoulderX);
  sh.y += T.up;
  // ---- boom length with probe
  let want = sprint ? T.distSprint : (hasFlag(me, FLAG.CROUCH) ? T.distCrouch : T.dist);
  want = lerp(want, T.distAds, clamp((state.local.ads || 0) * 2, 0, 1));
  tmp2.copy(fwd).negate();
  const free = probeDistance(sh, tmp2, want + T.margin, T.probe);
  const target = Math.max(T.minDist, Math.min(want, free - T.margin));
  boom = target < boom ? damp(boom, target, T.inLambda, dt) : damp(boom, target, T.outLambda, dt);
  camPos.copy(sh).addScaledVector(fwd, -boom);
  // subtle bob in third person
  camPos.y += bobY * T.bob + landY * 0.6;
  camPos.addScaledVector(right, bobX * T.bob);
  // swimming: the boom never dips under the water surface (sea level)
  if (controller.stanceInfo().stance === 'swim') camPos.y = Math.max(camPos.y, 0.3);
  // ---- ADS: travel to the first-person eye, where the view model's sights take over. Entering eases out (the camera
  // is at the eye well before the weapon finishes raising), leaving eases in; the travel value itself is damped so
  // a reversal mid-way never jumps.
  const rawAds = clamp(state.local.ads || 0, 0, 1);
  if (rawAds > lastRawAds + 1e-5) adsDir = 1;
  else if (rawAds < lastRawAds - 1e-5) adsDir = -1;
  const adsWant = adsDir > 0 ? 1 - Math.pow(1 - rawAds, TUNE.adsTravelExp) : Math.pow(rawAds, TUNE.adsTravelExp);
  lastRawAds = rawAds;
  adsTravel = rawAds <= 0 ? 0 : rawAds >= 1 ? 1 : damp(adsTravel, adsWant, TUNE.adsTravelLambda, dt);
  let mode = 'tp';
  let near = boom < 0.55;
  if (adsTravel > 0.001) {
    camPos.lerp(eye, adsTravel);
    if (camPos.distanceTo(eye) < TUNE.adsHideDist) near = true;
    if (adsTravel > TUNE.adsFpAt) mode = 'fp';
  }
  setMode(mode);
  avatar.setLocalViewMode(mode === 'fp' || state.local.scoped ? 'hidden' : near ? 'ads' : 'full');
  placeCamera(camPos, yaw, pitch);
  writeLocal(me);
  return fov;
}

function chaseCam(me, dt, chute) {
  const C = TUNE.chase;
  setMode(chute ? 'chute' : 'freefall');
  avatar.setLocalViewMode('full');
  const yaw = me.yaw + freeYaw, pitch = me.pitch + freePitch;
  dirFrom(yaw, pitch, fwd);
  const up = chute ? C.chuteUp : C.freefallUp;
  const dist = chute ? C.chuteDist : C.freefallDist;
  tmp.set(me.pos.x, me.pos.y + up, me.pos.z);
  if (!pivotInit) { pivot.copy(tmp); pivotInit = true; }
  pivot.lerp(tmp, 1 - Math.exp(-20 * dt));
  if (pivot.distanceTo(tmp) > 4) pivot.copy(tmp);
  tmp2.copy(fwd).negate();
  const free = probeDistance(pivot, tmp2, dist, 0.3);
  const d = Math.max(1.2, Math.min(dist, free - 0.3));
  camPos.copy(pivot).addScaledVector(fwd, -d);
  // never below the ground
  let gy = -Infinity;
  try { gy = world.getHeight(camPos.x, camPos.z); } catch (e) { gy = -Infinity; }
  if (camPos.y < gy + 0.6) camPos.y = gy + 0.6;
  placeCamera(camPos, yaw, pitch);
  // Freefall buffeting grows with speed.
  const fall = Math.max(0, -me.vel.y);
  if (!chute) trauma = Math.max(trauma, clamp((fall - 20) / 60, 0, 0.32));
  writeLocal(me);
  const speedKick = chute ? 0 : clamp((fall - 25) / 27, 0, 1) * C.freefallFovKick;
  return baseFov() * (1 + speedKick);
}

function planeCam(me, dt) {
  setMode('plane');
  let pos = null, dir = null;
  try { const t = plane.getTransform(); if (t && t.pos) { pos = t.pos; dir = t.dir; } } catch (e) { pos = null; }
  if (!pos) { pos = tmp3.copy(me.pos); }
  const yaw = me.yaw, pitch = clamp(me.pitch - 0.18, -1.2, 0.5);
  dirFrom(yaw, pitch, fwd);
  lookAt.copy(pos);
  if (dir) lookAt.addScaledVector(tmp.set(dir.x, 0, dir.z).normalize(), 6);
  camPos.copy(lookAt).addScaledVector(fwd, -TUNE.planeOrbit.dist);
  camPos.y += TUNE.planeOrbit.up;
  camObj.position.copy(camPos);
  camObj.lookAt(lookAt);
  writeLocal(me);
  return baseFov() * 0.92;
}

function deadCam(me, dt) {
  if (deathT < 0) startDeathCam();
  deathT += dt;
  const D = TUNE.death;
  if (deathT > D.duration && state.app === APP.MATCH && !state.match.netLost) {   // disconnected: nothing live to watch
    if (!spectating) setSpectate(null);
    if (spectating) return spectateCam(dt);
  }
  setMode('dead');
  avatar.setLocalViewMode('full');
  const k = smoothstep(0, 1.1, deathT);
  // Orbit target: the body; in the last second turn to face the killer.
  const body = tmp.set(me.pos.x, me.pos.y + 0.6, me.pos.z);
  const killer = state.local.killer && state.local.killer.id ? getPlayer(state.local.killer.id) : null;
  let yaw = orbitYaw + deathT * 0.18;
  if (killer && killer.id !== state.selfId) {
    const ky = Math.atan2(-(killer.pos.x - me.pos.x), -(killer.pos.z - me.pos.z));
    const turn = smoothstep(1.2, D.duration, deathT);
    yaw = yaw + angleDelta(yaw, ky + Math.PI) * turn;   // camera behind the body, facing the killer
  }
  const pitch = clamp(orbitPitch, -1.1, 0.3);
  dirFrom(yaw, pitch, fwd);
  tmp2.copy(fwd).negate();
  const free = probeDistance(body, tmp2, D.dist, 0.2);
  camPos.copy(body).addScaledVector(fwd, -Math.max(0.8, Math.min(D.dist, free - 0.2)));
  camPos.y += D.up * 0.3;
  camPos.lerpVectors(deathPos, camPos, k);
  camObj.position.copy(camPos);
  lookAt.copy(body);
  if (killer && deathT > 1.2) lookAt.lerp(tmp3.set(killer.pos.x, killer.pos.y + 1.2, killer.pos.z), smoothstep(1.2, D.duration, deathT) * 0.5);
  camObj.lookAt(lookAt);
  writeLocal(me);
  return baseFov();
}

function spectateCam(dt) {
  let target = spectating ? getPlayer(spectating) : null;
  if (!target || !target.alive) { setSpectate(null); target = spectating ? getPlayer(spectating) : null; }
  setMode('spectate');
  if (!target) { menuCam(dt); return RENDER.menuFov; }
  if (target.life === LIFE.PLANE) {
    let pos = null;
    try { const t = plane.getTransform(); pos = t && t.pos; } catch (e) { pos = null; }
    const p = pos || target.pos;
    dirFrom(orbitYaw, clamp(orbitPitch - 0.15, -1.2, 0.4), fwd);
    camObj.position.copy(p).addScaledVector(fwd, -TUNE.planeOrbit.dist);
    camObj.position.y += TUNE.planeOrbit.up;
    camObj.lookAt(p);
    return baseFov();
  }
  const yaw = target.yaw + orbitYaw, pitch = clamp(target.pitch * 0.7 + orbitPitch, -1.2, 0.8);
  dirFrom(yaw, pitch, fwd);
  rightFrom(yaw, right);
  const air = target.life === LIFE.FREEFALL || target.life === LIFE.CHUTE;
  tmp.set(target.pos.x, target.pos.y + (air ? 1.6 : pivotHeight(target, false)), target.pos.z);
  if (!pivotInit || pivot.distanceTo(tmp) > 6) { pivot.copy(tmp); pivotInit = true; }
  pivot.lerp(tmp, 1 - Math.exp(-14 * dt));
  const sh = tmp3.copy(pivot).addScaledVector(right, air ? 0 : TUNE.spectate.shoulder);
  sh.y += 0.12;
  const dist = air ? (target.life === LIFE.CHUTE ? TUNE.chase.chuteDist : TUNE.chase.freefallDist) : TUNE.spectate.dist;
  tmp2.copy(fwd).negate();
  const free = probeDistance(sh, tmp2, dist, TUNE.tp.probe);
  camPos.copy(sh).addScaledVector(fwd, -Math.max(0.6, Math.min(dist, free - TUNE.tp.margin)));
  placeCamera(camPos, yaw, pitch);
  return baseFov();
}

function menuCam(dt) {
  setMode('menu');
  const M = TUNE.menu;
  menuT += dt;
  const a = menuT * M.speed;
  const r = M.radius + 50 * Math.sin(a * 1.7 + 0.6);
  camPos.set(Math.cos(a) * r, 0, Math.sin(a) * r);
  let gy = 0;
  try { gy = Math.max(0, world.getHeight(camPos.x, camPos.z)); } catch (e) { gy = 0; }
  camPos.y = Math.max(gy + 45, M.height + 28 * Math.sin(a * 0.9 + 1.3));
  // Look toward a slowly wandering point over the island's sites.
  const n = ALL_SITES.length;
  const s = (a * 0.6) % n;
  const i0 = Math.floor(s), i1 = (i0 + 1) % n, f = smoothstep(0, 1, s - i0);
  const A = ALL_SITES[i0], B = ALL_SITES[i1];
  lookAt.set(lerp(A.x, B.x, f) * 0.55, 10, lerp(A.z, B.z, f) * 0.55);
  // smooth heading so the shot never whips around
  tmp.subVectors(lookAt, camPos).normalize();
  const yaw = Math.atan2(-tmp.x, -tmp.z), pitch = Math.asin(clamp(tmp.y, -1, 1));
  if (!menuInit) { menuYaw = yaw; menuPitch = pitch; menuInit = true; }
  menuYaw = dampAngle(menuYaw, yaw, 0.6, dt);
  menuPitch = damp(menuPitch, pitch, 0.6, dt);
  placeCamera(camPos, menuYaw, menuPitch);
  state.local.eye.copy(camPos);
  dirFrom(menuYaw, menuPitch, state.local.aimDir);
}
let menuYaw = 0, menuPitch = 0, menuInit = false;

function captureResultsFocus() {
  const me = localPlayer();
  const w = state.match.winnerId ? getPlayer(state.match.winnerId) : null;
  const f = (w && w.alive ? w : me);
  if (f) resultsFocus.copy(f.pos);
  else resultsFocus.copy(camObj.position).addScaledVector(dirFrom(camObj.rotation.y, camObj.rotation.x, tmp), 8);
}

function resultsCam(dt) {
  setMode('results');
  avatar.setLocalViewMode('full');
  resultsT += dt;
  const R = TUNE.results;
  const a = resultsT * R.speed;
  camPos.set(resultsFocus.x + Math.cos(a) * R.radius, resultsFocus.y + R.height, resultsFocus.z + Math.sin(a) * R.radius);
  lookAt.set(resultsFocus.x, resultsFocus.y + 1.1, resultsFocus.z);
  camObj.position.lerp(camPos, 1 - Math.exp(-2.5 * dt));
  camObj.lookAt(lookAt);
}

function placeCamera(p, yaw, pitch) {
  camObj.position.copy(p);
  camObj.rotation.set(pitch, yaw, 0, 'YXZ');
}

function writeLocal(me) {
  controller.getEye(state.local.eye);
  dirFrom(me.yaw, me.pitch, state.local.aimDir);
}

function nearestAlive() {
  const me = localPlayer();
  let best = null, bd = Infinity;
  for (const p of state.players.values()) {
    if (!p.alive || p.id === state.selfId || p.life === LIFE.SPECTATE) continue;
    const d = me ? me.pos.distanceToSquared(p.pos) : 0;
    if (d < bd) { bd = d; best = p.id; }
  }
  return best;
}

// ------------------------------------------------------------------------------------------ shake and springs
function springs(dt) {
  const L = TUNE.landSpring, F = TUNE.flinch;
  const n = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    landV += (-L.k * landY - L.c * landV) * h; landY += landV * h;
    flinchPV += (-F.k * flinchP - F.c * flinchPV) * h; flinchP += flinchPV * h;
    flinchYV += (-F.k * flinchY - F.c * flinchYV) * h; flinchY += flinchYV * h;
  }
  trauma = Math.max(0, trauma - traumaDecay * dt * 0.5);
  if (trauma <= 0) traumaDecay = 2.5;
}

function noise(seed, t) {
  return Math.sin(t * 1.0 + seed) * 0.5 + Math.sin(t * 2.31 + seed * 1.7) * 0.3 + Math.sin(t * 4.13 + seed * 2.9) * 0.2;
}

function applyShake(dt) {
  shakeT += dt * TUNE.shake.freq;
  const s = trauma * trauma;
  const S = TUNE.shake;
  if (s > 1e-5) {
    camObj.rotation.x += noise(shakeSeeds[0], shakeT) * S.maxDeg * DEG * s;
    camObj.rotation.y += noise(shakeSeeds[1], shakeT) * S.maxDeg * DEG * s;
    camObj.rotation.z += noise(shakeSeeds[2], shakeT) * S.maxDeg * DEG * s * 0.7;
    camObj.position.x += noise(shakeSeeds[3], shakeT) * S.maxPos * s;
    camObj.position.y += noise(shakeSeeds[4], shakeT) * S.maxPos * s;
    camObj.position.z += noise(shakeSeeds[5], shakeT) * S.maxPos * s;
  }
  if (modeNow === 'tp' || modeNow === 'ads' || modeNow === 'fp') {
    camObj.rotation.x += flinchP + landY * 0.35;
    camObj.rotation.y += flinchY;
  }
}
