// ZONEFALL - third-person soldiers for every entity (remote humans, bots, and the local player when seen from outside).
// OWNER: PLAYER. Contract: ARCHITECTURE.md 5.2 and 7 (animation map).
//
// One avatar per entity in state.players: soldier_a for even slots, soldier_b for odd slots, camo tint
// config.TEAM_TINTS[slot % n] on body/helmet/equipment (head untinted; materials cloned per model+tint, not per avatar).
// The same code drives the local player (from the controller's state) and remote players and bots (from the entity
// fields that net/sync and game/bots write), so what other people see is exactly what you see of yourself.
//
// Animation (all clips from soldier_a; they play on soldier_b too):
//  - Every clip is split into a lower half (root, pelvis, Spine, legs) and an upper half (Spine1 and everything above,
//    mask in ARCHITECTURE.md 7). Two weighted layers are evaluated by one AnimationMixer per avatar; every action is
//    time-driven by this module (timeScale 0), so lower and upper halves of one clip stay in lock-step and one-shots
//    never drift.
//  - Lower layer: a locomotion blend tree driven by velocity in local space. Speed picks and phase-syncs the GAIT clips
//    shared with the controller (Idle / Walk / Jog / Sprint, Crouch_Idle / Crouch_Walk); the direction of travel turns the
//    hips toward the movement by up to 65 degrees (backpedalling plays the cycle in reverse); standing still, the legs hold
//    until the aim has twisted 50 degrees away and then step around. Jump start/loop/land, slide start/loop/exit, mantle,
//    freefall, chute, swim and death are full-body states with their own fades.
//  - Upper layer: rifle low-ready (Rifle_Idle) and raised (Rifle_Aim) blended by a "raise" weight (ADS, firing, aiming),
//    pistol Aim_Idle, plus overlays: Rifle_Shoot/Shoot per shot, Hit_Chest/Hit_Head (0.6), Throw_Grenade, Use_Medkit
//    (plates), PickUp. Unarmed and full-body states follow the lower clip's own upper half.
//  - Procedural pass after the mixer: an exact aim solver rotates Spine1/Spine2/Neck (30/40/30) so the held weapon points
//    along the entity's yaw/pitch (which also un-twists the hips), two-bone IK keeps the left hand on the handguard and
//    performs the reload (mag out, to the pouch, new mag in, charge), recoil kick on a pivot under WeaponSocket_R, chute
//    risers pulled by turn and brake, freefall body pitch from the dive.
// Weapons: per-weapon prototypes are merged by material at first use (static body + separately animated magazine and
// bolt for near avatars, one or two draw calls for far ones). The M700 gets the cc0pack scope. Slung on the back during
// freefall/chute/throw/plate/swim.
// Performance: avatars beyond 400 m or outside the frustum skip animation; the nearest quality.maxAnimatedAvatars run
// at full rate, the rest at 15 Hz (6 Hz beyond 150 m); shadows only inside the tier's shadow range.
// Emits FOOTSTEP for remote avatars within 40 m (the local player's steps come from the controller).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WEAPONS, TEAM_TINTS, QUALITY, PLAYER, SURFACE } from '../config.js';
import { on, emit, EV } from '../core/bus.js';
import { state, gfx, LIFE, FLAG, hasFlag, debug } from '../core/state.js';
import { clamp, damp, dampAngle, angleDelta, wrapAngle, smoothstep, lerp, DEG } from '../core/util.js';
import * as assets from '../engine/assets.js';
import * as world from '../world/world.js';
import { GAIT, gaitRate, gaitClipRate, gait as localGait, stanceInfo as localStance, airInfo as localAir } from './controller.js';

// ------------------------------------------------------------------------------------------ tunables
const TUNE = {
  hideDistance: 400,
  footstepDistance: 40,
  nearWeaponDistance: 16,       // closer than this: weapon with animated magazine/bolt (hysteresis +4 m)
  farMixerDistance: 150,
  midRateHz: 15, farRateHz: 6, culledRateHz: 3,
  createPerFrame: 2,            // avatar instantiation is spread over frames (SkeletonUtils.clone is not free)
  hipYawMaxDeg: 65,
  hipYawLambda: 7,
  backpedalDeg: 108,            // travel direction beyond this from the aim plays the gait backwards
  turnStartDeg: 52, turnStopDeg: 6, turnLambda: 7.5,
  aimSplit: [0.3, 0.4, 0.3],    // Spine1, Spine2, Neck
  aimMaxDeg: 95,
  raiseHold: 0.85,              // s the rifle stays raised after the last shot
  readyRaise: 0.3,              // standing ready pose between low ready (0) and shouldered (1)
  lowReady: { pitchDeg: -22, yawDeg: 9 },
  sprintCarry: { pitchDeg: -34, yawDeg: 14 },
  pistolLow: { pitchDeg: -30, yawDeg: 6 },
  shootPulse: 0.16, hitPulse: 0.26, hitWeight: 0.6,
  landMinSpeed: 2.2,
  kick: { k: 520, c: 34 },
  slingPos: [0.02, 1.33, -0.19], slingDir: [-0.48, 0.86, 0.0], slingUp: [0, 0, -1],  // model space (faces +Z)
  pouch: [0.13, 1.08, 0.17],    // model space: left mag pouch on the plate carrier
  chute: { height: 5.4, forward: 0.35, span: 7.6, chord: 2.6, cells: 9, arcRadius: 5.4, thickness: 0.34 },
  freefallFrame: 0.83, freefallFlutter: 0.06,
  swimLift: 1.25,               // model lift while swimming: feet are 1.3 m under the surface, this puts the head out and the back awash
  swimPitchDeg: 11,             // head up, legs trailing under the surface
  remoteGroundSnap: 0.35,
  // Extra eye relief (m, along weapon +Z) added to WEAPONS[w].model.eye for iron sights, measured from each model's top
  // profile so the camera clears the receiver by more than the near plane: the AK's dust cover and the MP5's drum
  // would otherwise be cut open by it.
  adsEyeBack: { ak47: 0.17, m4a1: 0.045, mp5: 0.12, m1911: 0.045 },
  adsArmBones: /Forearm|Hand|Finger/,   // bones whose skin stays visible while the camera looks through the sights
  adsArmCut: 0.4,               // vertices with less than this weight on those bones are discarded in ADS
};
const UPPER_RE = /Spine1|Spine2|Neck|Head|Clavicle|UpperArm|Forearm|Hand|Finger/;
const NO_ROOT_STRIP = new Set(['Death', 'Hit_Knockback']);
const STRIP_ALL_ROOT = new Set(['Climb_1m']);
const CLIP_NAMES = ['Idle', 'Walk', 'Jog', 'Run', 'Sprint', 'Crouch_Idle', 'Crouch_Walk', 'Jump_Start', 'Jump_Loop', 'Jump_Land',
  'Slide_Start', 'Slide_Loop', 'Slide_Exit', 'Climb_1m', 'Swim', 'Death', 'Rifle_Idle', 'Rifle_Aim', 'Rifle_Shoot', 'Aim_Idle',
  'Shoot', 'Throw_Grenade', 'Use_Medkit', 'PickUp', 'Hit_Chest', 'Hit_Head'];
const CI = Object.freeze(Object.fromEntries(CLIP_NAMES.map((n, i) => [n, i])));
const NC = CLIP_NAMES.length;
const LOWER_STATES = ['loco', 'air', 'slide', 'mantle', 'freefall', 'chute', 'swim', 'dead'];
const LS = Object.freeze(Object.fromEntries(LOWER_STATES.map((n, i) => [n, i])));
const LS_FADE = [10, 11, 13, 16, 4, 3.5, 5, 9];   // fade-in rate (1/s) of each lower state
// Handguard grip shift (weapon space, metres added to the baked rifle grip) so each gun's handguard is held.
const GRIP_SHIFT = { ak47: [0, -0.004, -0.045], m4a1: [0, 0, -0.02], mp5: [0, 0.012, 0.03], m700: [0, -0.012, -0.07] };

// ------------------------------------------------------------------------------------------ module state
let scene = null;
let inited = false;
const avatars = new Map();          // id -> Avatar
let localMode = 'full';             // 'full' | 'ads' | 'hidden' (shadow only)
let qual = QUALITY.medium;
const clipCache = new Map();        // name -> {lower, upper, duration}
const tintCache = new Map();        // 'model|tint' -> Map(srcMaterial -> tinted)
const ghostCache = new Map();
const protos = new Map();           // weapon id -> prototype
let probe = null;                   // reference measurements from a posed probe skeleton
let canopyGeo = null, canopyLines = null, canopyMat = null, lineMat = null;
const debris = [];                  // dropped magazines

// temporaries (hot paths never allocate)
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), v4 = new THREE.Vector3(), v5 = new THREE.Vector3();
const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3(), vt = new THREE.Vector3();
const q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion(), q3 = new THREE.Quaternion(), qp = new THREE.Quaternion();
const m1 = new THREE.Matrix4(), m2 = new THREE.Matrix4();
const e1 = new THREE.Euler(0, 0, 0, 'YXZ');
const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, -1);
const frustum = new THREE.Frustum();
const projView = new THREE.Matrix4();
const sphere = new THREE.Sphere();
const gaitTmp = {};

function err(msg) { return new Error(`[PLAYER/avatar] ${msg}`); }

// ------------------------------------------------------------------------------------------ clips
/** Lower/upper halves of a clip, with horizontal root drift removed (the controller moves the body). */
function sub(name) {
  let c = clipCache.get(name);
  if (c) return c;
  const src = assets.clips()[name];
  if (!src) throw err(`soldier clip '${name}' is missing`);
  const tracks = src.tracks.map((t) => {
    if (t.name !== 'Bip01.position' || NO_ROOT_STRIP.has(name)) return t;
    const tt = t.clone();
    const v = tt.values;
    const x0 = v[0], y0 = v[1], z0 = v[2];
    for (let i = 0; i < v.length; i += 3) {
      v[i] = x0; v[i + 2] = z0;
      if (STRIP_ALL_ROOT.has(name)) v[i + 1] = y0;
    }
    return tt;
  });
  c = {
    duration: src.duration,
    lower: new THREE.AnimationClip(name + '|L', src.duration, tracks.filter((t) => !UPPER_RE.test(t.name))),
    upper: new THREE.AnimationClip(name + '|U', src.duration, tracks.filter((t) => UPPER_RE.test(t.name))),
  };
  clipCache.set(name, c);
  return c;
}
const dur = (i) => sub(CLIP_NAMES[i]).duration;

// ------------------------------------------------------------------------------------------ materials
function kindOfMaterial(m) {
  const n = (m && m.name || '').toLowerCase();
  if (n.endsWith('_head')) return 'head';
  if (n.endsWith('_helmet')) return 'helmet';
  if (n.endsWith('_equipment')) return 'equipment';
  if (n.includes('knife')) return 'knife';
  return 'body';
}

function tinted(modelKey, tintIdx, src) {
  const key = modelKey + '|' + tintIdx;
  let map = tintCache.get(key);
  if (!map) { map = new Map(); tintCache.set(key, map); }
  let m = map.get(src);
  if (m) return m;
  const kind = kindOfMaterial(src);
  if (kind === 'head' || kind === 'knife' || tintIdx === 0) m = src;
  else {
    m = src.clone();
    m.color.multiply(new THREE.Color(TEAM_TINTS[tintIdx]));
    m.name = src.name + '#t' + tintIdx;
  }
  map.set(src, m);
  return m;
}

function ghostOf(m) {
  let g = ghostCache.get(m);
  if (g) return g;
  g = m.clone();
  g.transparent = true;
  g.opacity = 0.32;
  g.depthWrite = false;
  g.name = m.name + '#ghost';
  ghostCache.set(m, g);
  return g;
}

function shadowOnly(m) {
  const s = m.clone();
  s.colorWrite = false;
  s.depthWrite = false;
  s.name = m.name + '#shadow';
  return s;
}

/**
 * ADS body material: draws only the forearms, hands and fingers (the skin weights of those bones decide per vertex,
 * so the sleeve ends cleanly above the wrist and elbow), everything else of the body is discarded. The shadow map
 * still receives the whole body because shadows use the depth material, not this one.
 */
const armsCache = new Map();
function armsOnly(m, skeleton) {
  const key = m.uuid + '|' + skeleton.bones.length;
  let a = armsCache.get(key);
  if (a) return a;
  const n = skeleton.bones.length;
  const mask = new Float32Array(n);
  for (let i = 0; i < n; i++) mask[i] = TUNE.adsArmBones.test(skeleton.bones[i].name) ? 1 : 0;
  a = m.clone();
  a.name = m.name + '#arms';
  a.onBeforeCompile = (shader) => {
    shader.uniforms.zfBoneMask = { value: mask };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float zfBoneMask[${n}];\nvarying float vZfArm;`)
      .replace('#include <skinbase_vertex>', `#include <skinbase_vertex>
  vZfArm = zfBoneMask[int(skinIndex.x)] * skinWeight.x + zfBoneMask[int(skinIndex.y)] * skinWeight.y
         + zfBoneMask[int(skinIndex.z)] * skinWeight.z + zfBoneMask[int(skinIndex.w)] * skinWeight.w;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vZfArm;')
      .replace('void main() {', `void main() {\n  if (vZfArm < ${TUNE.adsArmCut.toFixed(3)}) discard;`);
  };
  a.customProgramCacheKey = () => 'zf-arms-' + n;
  armsCache.set(key, a);
  return a;
}

// ------------------------------------------------------------------------------------------ probe measurements
/** Pose a throwaway skeleton once to measure where the baked poses hold the weapon and the left hand. */
function measure() {
  if (probe) return probe;
  const root = assets.cloneModel('soldier_a');
  const mixer = new THREE.AnimationMixer(root);
  const sock = root.getObjectByName('WeaponSocket_R');
  const lHand = root.getObjectByName('Bip01_L_Hand');
  const spine2 = root.getObjectByName('Bip01_Spine2');
  if (!sock || !lHand || !spine2) throw err('soldier skeleton is missing WeaponSocket_R / Bip01_L_Hand / Bip01_Spine2');
  const pose = (name) => {
    mixer.stopAllAction();
    const a = mixer.clipAction(assets.clips()[name]);
    a.reset().play();
    a.time = 0;
    mixer.update(0);
    root.updateMatrixWorld(true);
  };
  const handRel = () => new THREE.Matrix4().copy(sock.matrixWorld).invert().multiply(lHand.matrixWorld);
  const weaponDir = () => new THREE.Vector3(0, 0, -1).transformDirection(sock.matrixWorld);
  pose('Rifle_Aim');
  const rifleGrip = handRel();
  const aimDir = weaponDir();
  pose('Rifle_Idle');
  const lowDir = weaponDir();
  pose('Aim_Idle');
  const pistolGrip = handRel();
  pose('Idle');
  // Sling: weapon across the back, muzzle up over the left shoulder, expressed in Spine2's frame.
  const d = new THREE.Vector3(...TUNE.slingDir).normalize();
  const upv = new THREE.Vector3(...TUNE.slingUp).normalize();
  const z = d.clone().negate();                         // weapon +Z points away from the muzzle
  const x = new THREE.Vector3().crossVectors(upv, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  const slingModel = new THREE.Matrix4().makeBasis(x, y, z).setPosition(new THREE.Vector3(...TUNE.slingPos));
  const sling = new THREE.Matrix4().copy(spine2.matrixWorld).invert().multiply(slingModel);
  const slingPos = new THREE.Vector3(), slingQuat = new THREE.Quaternion(), slingScale = new THREE.Vector3();
  sling.decompose(slingPos, slingQuat, slingScale);
  probe = { rifleGrip, pistolGrip, aimDir, lowDir, slingPos, slingQuat };
  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  return probe;
}

// ------------------------------------------------------------------------------------------ weapon prototypes
function commonAttributes(geos) {
  const names = Object.keys(geos[0].attributes).filter((n) => geos.every((g) => g.attributes[n]));
  return names;
}

/** Merge meshes (already in weapon space) by material. Returns [{geometry, material}] */
function mergeByMaterial(list) {
  const byMat = new Map();
  for (const it of list) {
    if (!byMat.has(it.material)) byMat.set(it.material, []);
    byMat.get(it.material).push(it.geometry);
  }
  const out = [];
  for (const [material, geos] of byMat) {
    let gs = geos;
    const anyNonIndexed = gs.some((g) => !g.index);
    if (anyNonIndexed) gs = gs.map((g) => (g.index ? g.toNonIndexed() : g));
    const keep = commonAttributes(gs);
    gs = gs.map((g) => {
      const c = new THREE.BufferGeometry();
      for (const n of keep) c.setAttribute(n, g.attributes[n]);
      if (g.index) c.setIndex(g.index);
      return c;
    });
    const merged = gs.length === 1 ? gs[0] : mergeGeometries(gs, false);
    if (!merged) throw err('could not merge weapon geometry');
    merged.computeBoundingSphere();
    out.push({ geometry: merged, material });
  }
  return out;
}

function collectMeshes(rootObj, rootInv, filter, offsetInv) {
  const out = [];
  rootObj.traverse((o) => {
    if (!o.isMesh || !filter(o)) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    m1.multiplyMatrices(rootInv, o.matrixWorld);
    if (offsetInv) m1.premultiply(offsetInv);
    if (Array.isArray(o.material) && o.geometry.groups.length) {
      for (const g of o.geometry.groups) {
        const part = o.geometry.clone();
        const idx = part.index;
        if (idx) part.setIndex(new THREE.BufferAttribute(idx.array.slice(g.start, g.start + g.count), 1));
        part.clearGroups();
        part.applyMatrix4(m1);
        out.push({ geometry: part, material: mats[g.materialIndex] });
      }
    } else {
      const geo = o.geometry.clone();
      geo.applyMatrix4(m1);
      out.push({ geometry: geo, material: mats[0] });
    }
  });
  return out;
}

function isUnder(o, top, name) {
  for (let p = o; p && p !== top; p = p.parent) if (p.name === name) return true;
  return false;
}

function buildMeshes(parts, castShadow) {
  const g = new THREE.Group();
  for (const p of parts) {
    const mesh = new THREE.Mesh(p.geometry, p.material);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    g.add(mesh);
  }
  return g;
}

function weaponProto(id) {
  if (protos.has(id)) return protos.get(id);
  const W = WEAPONS[id];
  if (!W || !W.model || !W.model.key || W.class === 'lethal') { protos.set(id, null); return null; }
  const gltf = assets.model(W.model.key);
  const src = gltf.scene;
  src.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(src.matrixWorld).invert();
  const nodePos = (name) => {
    const n = name && src.getObjectByName(name);
    return n ? new THREE.Vector3().setFromMatrixPosition(m2.multiplyMatrices(rootInv, n.matrixWorld)) : null;
  };
  const magName = W.model.mag, boltName = W.model.bolt;
  const magPos = nodePos(magName) || new THREE.Vector3();
  const boltPos = nodePos(boltName) || new THREE.Vector3();
  const isMag = (o) => !!magName && isUnder(o, src, magName);
  const isBolt = (o) => !!boltName && isUnder(o, src, boltName);
  const staticParts = collectMeshes(src, rootInv, (o) => !isMag(o) && !isBolt(o));
  const magParts = collectMeshes(src, rootInv, isMag, new THREE.Matrix4().makeTranslation(-magPos.x, -magPos.y, -magPos.z));
  const boltParts = collectMeshes(src, rootInv, isBolt, new THREE.Matrix4().makeTranslation(-boltPos.x, -boltPos.y, -boltPos.z));
  if (W.model.scope) {
    const sc = W.model.scope;
    const sg = assets.model(sc.key).scene;
    sg.updateMatrixWorld(true);
    const sInv = new THREE.Matrix4().copy(sg.matrixWorld).invert();
    const node = sg.getObjectByName(sc.node);
    if (!node) throw err(`scope node '${sc.node}' not found in ${sc.key}`);
    const off = new THREE.Matrix4().makeTranslation(sc.offset[0], sc.offset[1], sc.offset[2]);
    for (const p of collectMeshes(node, sInv, () => true, off)) staticParts.push(p);
  }
  const muzzle = nodePos(W.model.muzzle) || new THREE.Vector3(0, 0.06, -0.6);
  const eye = new THREE.Vector3(...(W.model.eye || [0, 0.1, 0]));
  const near = new THREE.Group();
  near.name = 'weapon:' + id;
  near.add(buildMeshes(mergeByMaterial(staticParts), true));
  const magPivot = new THREE.Group(); magPivot.name = 'mag'; magPivot.position.copy(magPos);
  if (magParts.length) magPivot.add(buildMeshes(mergeByMaterial(magParts), true));
  const boltPivot = new THREE.Group(); boltPivot.name = 'bolt'; boltPivot.position.copy(boltPos);
  if (boltParts.length) boltPivot.add(buildMeshes(mergeByMaterial(boltParts), true));
  near.add(magPivot, boltPivot);
  // Far version: one mesh per material, magazine and bolt baked in place.
  const all = staticParts.slice();
  for (const p of magParts) { const g = p.geometry.clone(); g.translate(magPos.x, magPos.y, magPos.z); all.push({ geometry: g, material: p.material }); }
  for (const p of boltParts) { const g = p.geometry.clone(); g.translate(boltPos.x, boltPos.y, boltPos.z); all.push({ geometry: g, material: p.material }); }
  const far = buildMeshes(mergeByMaterial(all), false);
  far.name = 'weapon-far:' + id;
  // Loose magazine for the reload drop (the same geometry as the magazine pivot).
  const looseMag = magParts.length ? buildMeshes(mergeByMaterial(magParts), true) : null;
  const shift = GRIP_SHIFT[id] || [0, 0, 0];
  const p = {
    id, W, near, far, muzzle, eye, magPos, boltPos, looseMag, pistol: W.class === 'pistol',
    gripShift: new THREE.Vector3(shift[0], shift[1], shift[2]),
    boltTravel: W.class === 'pistol' ? 0.035 : 0.06,
  };
  protos.set(id, p);
  return p;
}

function weaponInstance(av, id, near) {
  const key = id + (near ? ':n' : ':f');
  let inst = av.weapons.get(key);
  if (inst) return inst;
  const p = weaponProto(id);
  if (!p) return null;
  const obj = (near ? p.near : p.far).clone(true);
  const muzzle = new THREE.Object3D();
  muzzle.position.copy(p.muzzle);
  obj.add(muzzle);
  inst = {
    id, near, proto: p, obj, muzzle,
    mag: near ? obj.getObjectByName('mag') : null,
    bolt: near ? obj.getObjectByName('bolt') : null,
  };
  av.weapons.set(key, inst);
  return inst;
}

// ------------------------------------------------------------------------------------------ parachute canopy
function buildCanopy() {
  if (canopyGeo) return;
  const C = TUNE.chute;
  const segU = C.cells * 4, segV = 22;
  const pos = [], col = [], idx = [];
  const arc = C.span / C.arcRadius;
  const olive = new THREE.Color(0x4f5638), sand = new THREE.Color(0x8d8160), dark = new THREE.Color(0x3a3f2a);
  const tmp = new THREE.Color();
  const profile = (t) => {
    // t 0..1 around the airfoil: 0..0.5 top surface leading->trailing, 0.5..1 bottom trailing->leading
    const top = t < 0.5;
    const x = top ? t * 2 : (1 - t) * 2;                 // chord position 0 (leading) .. 1 (trailing)
    const thick = 0.12 * (1.0 - x) * Math.sqrt(Math.max(x, 0)) * 2.6 + 0.012;
    const camber = 0.05 * Math.sin(Math.PI * Math.min(1, x * 1.1));
    const y = top ? camber + thick * 0.62 : camber * 0.25 - thick * 0.38;
    return [x, y];
  };
  for (let iu = 0; iu <= segU; iu++) {
    const u = iu / segU;
    const cell = Math.min(C.cells - 1, Math.floor(u * C.cells));
    const inCell = u * C.cells - cell;
    const bulge = 1 + 0.16 * Math.sin(Math.PI * inCell);
    const phi = (u - 0.5) * arc;
    const cx = C.arcRadius * Math.sin(phi), cy = C.arcRadius * Math.cos(phi) - C.arcRadius;
    const rx = Math.sin(phi), ry = Math.cos(phi);
    const mid = Math.abs(cell - (C.cells - 1) / 2) < 0.6;
    const stripe = mid || cell === 0 || cell === C.cells - 1;
    for (let iv = 0; iv <= segV; iv++) {
      const t = iv / segV;
      const [x, y] = profile(t);
      const thick = y * bulge * (C.thickness / 0.1);
      const z = (0.38 - x) * C.chord * (0.94 + 0.06 * Math.sin(Math.PI * inCell));   // leading edge toward +Z (model forward)
      pos.push(cx + rx * thick, cy + ry * thick, z);
      tmp.copy(stripe ? sand : olive);
      if (t > 0.5) tmp.lerp(dark, 0.35);
      col.push(tmp.r, tmp.g, tmp.b);
    }
  }
  for (let iu = 0; iu < segU; iu++) {
    for (let iv = 0; iv < segV; iv++) {
      const a = iu * (segV + 1) + iv, b = a + segV + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  canopyGeo = new THREE.BufferGeometry();
  canopyGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  canopyGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  canopyGeo.setIndex(idx);
  canopyGeo.computeVertexNormals();
  canopyGeo.computeBoundingSphere();
  canopyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0, side: THREE.DoubleSide, name: 'chute-canopy' });
  // Suspension lines: from each rib (4 attachment points along the chord) to the left or right riser.
  const lp = [];
  for (let r = 0; r <= C.cells; r++) {
    const u = r / C.cells;
    const phi = (u - 0.5) * arc;
    const cx = C.arcRadius * Math.sin(phi), cy = C.arcRadius * Math.cos(phi) - C.arcRadius;
    const side = u < 0.5 ? -1 : 1;
    for (const x of [0.06, 0.32, 0.58, 0.86]) {
      const z = (0.38 - x) * C.chord;
      lp.push(cx, cy - 0.06, z, side * 0.26, -C.height + 2.05, 0.04);
    }
  }
  canopyLines = new THREE.BufferGeometry();
  canopyLines.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  lineMat = new THREE.LineBasicMaterial({ color: 0x1d1f1a, transparent: true, opacity: 0.75 });
}

function makeCanopy() {
  buildCanopy();
  const g = new THREE.Group();
  g.name = 'chute';
  const mesh = new THREE.Mesh(canopyGeo, canopyMat);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.position.y = TUNE.chute.height;
  const lines = new THREE.LineSegments(canopyLines, lineMat);
  lines.position.y = TUNE.chute.height;
  g.add(mesh, lines);
  g.visible = false;
  return { group: g, mesh, lines, open: 0, detached: false, detachT: 0, mode: 'packed', cut: false };
}

// ------------------------------------------------------------------------------------------ avatar construction
function modelKeyFor(slot) { return (slot | 0) % 2 === 0 ? 'soldier_a' : 'soldier_b'; }

function createAvatar(e) {
  measure();
  const modelKey = modelKeyFor(e.slot);
  const tintIdx = (((e.slot | 0) % TEAM_TINTS.length) + TEAM_TINTS.length) % TEAM_TINTS.length;
  const model = assets.cloneModel(modelKey);
  const root = new THREE.Group();
  root.name = 'avatar:' + e.id;
  root.add(model);
  const B = (n) => {
    const b = model.getObjectByName(n);
    if (!b) throw err(`bone '${n}' missing in ${modelKey}`);
    return b;
  };
  const meshes = [];
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    o.frustumCulled = true;           // against a pose-independent sphere (set below), by the renderer's own camera
    const src = o.material;
    const kind = kindOfMaterial(src);
    const mat = tinted(modelKey, tintIdx, src);
    o.material = mat;
    meshes.push({ mesh: o, kind, base: mat, shadow: null });
  });
  const bones = {
    hips: B('Bip01'), pelvis: B('Bip01_Pelvis'), spine: B('Bip01_Spine'), spine1: B('Bip01_Spine1'), spine2: B('Bip01_Spine2'),
    neck: B('Bip01_Neck'), head: B('Bip01_Head'),
    lUpper: B('Bip01_L_UpperArm'), lFore: B('Bip01_L_Forearm'), lHand: B('Bip01_L_Hand'),
    rUpper: B('Bip01_R_UpperArm'), rFore: B('Bip01_R_Forearm'), rHand: B('Bip01_R_Hand'),
    lFoot: B('Bip01_L_Foot'), rFoot: B('Bip01_R_Foot'), socket: B('WeaponSocket_R'),
  };
  const handHolder = new THREE.Group(); handHolder.name = 'hand-holder';
  bones.socket.add(handHolder);
  const backHolder = new THREE.Group(); backHolder.name = 'back-holder';
  backHolder.position.copy(probe.slingPos);
  backHolder.quaternion.copy(probe.slingQuat);
  bones.spine2.add(backHolder);
  const kickPivot = new THREE.Group(); kickPivot.name = 'kick';
  handHolder.add(kickPivot);
  // Skinned meshes are culled by three.js with mesh.boundingSphere; give them one sphere that holds every pose
  // (bind-pose sphere grown 1.6x: arms out, prone death, slide), so culling never depends on last frame's camera.
  model.updateMatrixWorld(true);
  for (const m of meshes) {
    if (!m.mesh.isSkinnedMesh) continue;
    m.mesh.computeBoundingSphere();
    m.mesh.boundingSphere.radius *= 1.6;
  }
  const mixer = new THREE.AnimationMixer(model);
  const av = {
    id: e.id, entity: e, slot: e.slot, modelKey, tintIdx, root, model, mixer, meshes, bones,
    handHolder, backHolder, kickPivot,
    actL: new Array(NC).fill(null), actU: new Array(NC).fill(null),
    wL: new Float32Array(NC), wU: new Float32Array(NC), tL: new Float32Array(NC), tU: new Float32Array(NC),
    lsw: new Float32Array(LOWER_STATES.length), ls: -1, lsT: 0,
    crouchW: 0, raise: 0, follow: 0, aimW: 0, ikW: 0, slingW: 0,
    phase: 0, gaitSide: 0, speed: 0, vf: 0, vr: 0, vy: 0,
    lastPos: new THREE.Vector3().copy(e.pos), vel: new THREE.Vector3(), velInit: false,
    bodyYaw: e.yaw, hipYaw: 0, turning: false, turnPhase: 0, yawRate: 0, prevYaw: e.yaw, aimPitch: e.pitch,
    airT: 0, airStart: false, landT: 9, landW: 0, slideT: 0, slideExitT: 9, mantleT: 0,
    deathT: -1, deathYaw: 0, ffT: 0, chuteArms: 0, chuteTurn: 0, chuteBrake: 0,
    upT: 0, shootT: 9, hitT: 9, hitHead: false, throwT: -1, plateT: -1, pickT: 9,
    reloadT: -1, reloadDur: 1, reloadEmpty: false, magDropped: false,
    kickZ: 0, kickZv: 0, kickR: 0, kickRv: 0,
    weaponId: null, weapon: null, weaponNear: true, weaponOnBack: false,
    weapons: new Map(),
    canopy: null, prevLife: e.life, prevFlags: e.flags,
    visible: true, mode: 'full', ghost: false, castShadow: true,
    acc: 0, lastUpdate: 0, dist: 0, culled: false,
    adsEye: new THREE.Vector3(), adsValid: false, muzzleValid: false,
    groundY: e.pos.y, lastFallSpeed: 0, swimT: 0, pouchLocal: null,
    handle: { root, muzzle: null, head: bones.head },
  };
  scene.add(root);
  applyLocalMode(av);
  placeRoot(av, 0);
  return av;
}

function disposeAvatar(av) {
  if (av.canopy) { av.canopy.group.removeFromParent(); }
  av.root.removeFromParent();
  av.mixer.stopAllAction();
  av.mixer.uncacheRoot(av.model);
  for (const m of av.meshes) if (m.shadow) m.shadow.dispose();
}

// ------------------------------------------------------------------------------------------ actions
function action(av, i, upper) {
  const arr = upper ? av.actU : av.actL;
  let a = arr[i];
  if (a) return a;
  const c = sub(CLIP_NAMES[i]);
  a = av.mixer.clipAction(upper ? c.upper : c.lower);
  a.setLoop(THREE.LoopRepeat, Infinity);
  a.timeScale = 0;
  a.play();
  a.setEffectiveWeight(0);
  arr[i] = a;
  return a;
}

function applyWeights(av) {
  for (let i = 0; i < NC; i++) {
    const wl = av.wL[i], wu = av.wU[i];
    if (wl > 1e-4 || av.actL[i]) {
      const a = action(av, i, false);
      a.setEffectiveWeight(wl > 1e-4 ? wl : 0);
      if (wl > 1e-4) a.time = clampTime(av.tL[i], i);
    }
    if (wu > 1e-4 || av.actU[i]) {
      const a = action(av, i, true);
      a.setEffectiveWeight(wu > 1e-4 ? wu : 0);
      if (wu > 1e-4) a.time = clampTime(av.tU[i], i);
    }
  }
}

function clampTime(t, i) {
  const d = dur(i);
  if (t < 0) return 0;
  return t >= d ? d - 1e-4 : t;
}

const loopT = (t, i) => { const d = dur(i); return ((t % d) + d) % d; };

// ------------------------------------------------------------------------------------------ public API
export function init(sc) {
  if (!sc) throw err('init needs the world scene');
  scene = sc;
  if (inited) return;
  inited = true;
  qual = currentQuality();
  on(EV.PLAYER_REMOVE, ({ id }) => {
    const av = avatars.get(id);
    if (av) { disposeAvatar(av); avatars.delete(id); }
  });
  on(EV.QUALITY_CHANGED, () => { qual = currentQuality(); });
  on(EV.WEAPON_FIRE, ({ id }) => {
    const av = avatars.get(id);
    if (!av) return;
    av.shootT = 0;
    const W = WEAPONS[av.entity.weapon];
    const r = W && W.recoil;
    av.kickZv += (r ? r.viewKickZ : 0.04) * 9;
    av.kickRv += (r ? r.viewKickRotDeg : 2) * DEG * 7;
  });
  on(EV.WEAPON_RELOAD, ({ id, phase, empty, weapon }) => {
    const av = avatars.get(id);
    if (!av) return;
    if (phase === 'start') startReload(av, weapon || av.entity.weapon, !!empty);
    else if (phase === 'cancel' || phase === 'end') { if (phase === 'cancel') av.reloadT = -1; }
  });
  on(EV.PLAYER_DAMAGED, ({ id, zone, kind }) => {
    const av = avatars.get(id);
    if (!av || kind === 'zone' || kind === 'fall') return;
    av.hitT = 0;
    av.hitHead = zone === 'head';
  });
  on(EV.PLAYER_KILLED, ({ id }) => {
    const av = avatars.get(id);
    if (av && av.deathT < 0) startDeath(av);
  });
  on(EV.LOOT_PICKED, ({ by }) => { const av = avatars.get(by); if (av) av.pickT = 0; });
  on(EV.CRATE_OPENED, ({ by }) => { const av = avatars.get(by); if (av) av.pickT = 0; });
  debug.player = debug.player || {};
  Object.assign(debug.player, {
    avatars: () => [...avatars.values()].map((a) => ({ id: a.id, ls: LOWER_STATES[a.ls], visible: a.root.visible, culled: a.culled,
      weapon: a.weaponId, near: a.weaponNear, raise: +a.raise.toFixed(2), follow: +a.follow.toFixed(2), dist: +a.dist.toFixed(1) })),
    avatarObject: (id) => avatars.get(id) || null,
    avatarTune: TUNE,
  });
}

/** Create/remove/animate avatars to match state.players. */
export function update(dt) {
  if (!scene) return;
  // Membership: create missing (a few per frame), drop orphans.
  let created = 0;
  for (const e of state.players.values()) {
    if (avatars.has(e.id)) continue;
    if (created >= TUNE.createPerFrame) break;
    avatars.set(e.id, createAvatar(e));
    created++;
  }
  for (const [id, av] of avatars) {
    if (!state.players.has(id)) { disposeAvatar(av); avatars.delete(id); }
    else av.entity = state.players.get(id);
  }
  // Visibility and LOD.
  const cam = gfx.camera;
  if (cam) {
    cam.updateMatrixWorld();
    projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView);
  }
  const list = sorted;
  list.length = 0;
  for (const av of avatars.values()) {
    const e = av.entity;
    av.dist = cam ? cam.position.distanceTo(e.pos) : 0;
    const hiddenLife = e.life === LIFE.PLANE || e.life === LIFE.SPECTATE;
    const isLocal = e.id === state.selfId;
    av.root.visible = !hiddenLife && av.dist < TUNE.hideDistance;
    if (av.canopy && av.canopy.detached) updateDetachedCanopy(av, dt);
    if (!av.root.visible) { av.prevLife = e.life; continue; }
    sphere.center.set(e.pos.x, e.pos.y + 0.9, e.pos.z);
    sphere.radius = av.canopy && av.canopy.group.visible && !av.canopy.detached ? 7.5 : 1.4;
    // Off-screen avatars (last frame's view) animate at a low rate; drawing is culled by the renderer itself.
    av.culled = cam && !isLocal ? !frustum.intersectsSphere(sphere) : false;
    list.push(av);
  }
  list.sort(byDist);
  const full = Math.max(1, qual.maxAnimatedAvatars | 0);
  const shadowRange = (qual.shadowRange || 90) * 0.85;
  let fullUsed = 0, shadowsUsed = 0;
  const now = performance.now();
  for (const av of list) {
    const isLocal = av.entity.id === state.selfId;
    let hz;
    if (isLocal) hz = 0;
    else if (av.culled) hz = TUNE.culledRateHz;
    else if (fullUsed < full) { hz = 0; fullUsed++; }
    else hz = av.dist > TUNE.farMixerDistance ? TUNE.farRateHz : TUNE.midRateHz;
    av.acc += dt;
    // Shadow casters: the local player plus the nearest avatars up to the tier's animated budget (each caster costs
    // its draw calls a second time in the shadow pass).
    const cast = isLocal || (av.dist < shadowRange && shadowsUsed < full);
    if (cast && !isLocal) shadowsUsed++;
    if (cast !== av.castShadow) setCastShadow(av, cast);
    if (hz > 0 && av.acc < 1 / hz) { placeRoot(av, dt); continue; }
    const step = Math.min(av.acc, 0.25);
    av.acc = 0;
    animate(av, step, isLocal);
    av.lastUpdate = now;
  }
  updateDebris(dt);
}
const sorted = [];
const byDist = (a, b) => a.dist - b.dist;

/** @returns {{root: import('three').Object3D, muzzle: import('three').Object3D|null, head: import('three').Object3D}|null} */
export function get(id) {
  const av = avatars.get(id);
  if (!av) return null;
  const r = av.handle;
  r.muzzle = av.weapon && !av.weaponOnBack ? av.weapon.muzzle : null;
  return r;
}

/** World position of the avatar's weapon muzzle into out; returns out or null if unknown. */
export function getMuzzleWorld(id, out) {
  const av = avatars.get(id);
  if (!av || !av.weapon || av.weaponOnBack) return null;
  av.weapon.muzzle.updateWorldMatrix(true, false);
  return out.setFromMatrixPosition(av.weapon.muzzle.matrixWorld);
}

/** Show the local player's own avatar (third-person phases, death cam). Hidden in first person (shadow kept). */
export function setLocalVisible(on) { setLocalViewMode(on ? 'full' : 'hidden'); }

// ------------------------------------------------------------------------------------------ additions (PLAYER)
/**
 * Local avatar presentation: 'full' (third person), 'ads' (camera through the sights: head, helmet and equipment drawn
 * to the shadow map only), 'hidden' (first person: everything shadow-only).
 */
export function setLocalViewMode(mode) {
  if (mode !== 'full' && mode !== 'ads' && mode !== 'hidden') throw err(`unknown local view mode '${mode}'`);
  if (mode === localMode) return;
  localMode = mode;
  const av = avatars.get(state.selfId);
  if (av) applyLocalMode(av);
}
export function localViewMode() { return localMode; }

/** World-space ADS eye point of the local avatar's weapon sight (camera position at full ADS); false if unavailable. */
export function getAdsEye(out) {
  const av = avatars.get(state.selfId);
  if (!av || !av.adsValid) return false;
  out.copy(av.adsEye);
  return true;
}

/** World-space position between the eyes of an avatar's head (spectate and death cams). */
export function getHeadWorld(id, out) {
  const av = avatars.get(id);
  if (!av || !av.root.visible) return null;
  av.bones.head.updateWorldMatrix(true, false);
  out.setFromMatrixPosition(av.bones.head.matrixWorld);
  return out;
}

/** Number of live avatars (tests and the harness). */
export function count() { return avatars.size; }

// ------------------------------------------------------------------------------------------ visibility helpers
function setCastShadow(av, on) {
  av.castShadow = on;
  for (const m of av.meshes) m.mesh.castShadow = on;
  for (const inst of av.weapons.values()) inst.obj.traverse((o) => { if (o.isMesh) o.castShadow = on && inst.near; });
}

function applyLocalMode(av) {
  const isLocal = av.entity.id === state.selfId;
  const mode = isLocal ? localMode : 'full';
  av.mode = mode;
  for (const m of av.meshes) {
    let hide = false;
    if (mode === 'hidden') hide = true;
    else if (mode === 'ads') hide = m.kind !== 'body' || !m.mesh.isSkinnedMesh;
    if (hide) {
      if (!m.shadow) m.shadow = shadowOnly(m.base);
      m.mesh.material = m.shadow;
    } else if (mode === 'ads') {
      m.mesh.material = armsOnly(m.base, m.mesh.skeleton);
    } else {
      m.mesh.material = av.ghost ? ghostOf(m.base) : m.base;
    }
  }
  // In first person the weapon belongs to the viewmodel; the avatar's gun keeps only its shadow.
  const hideWeapon = mode === 'hidden';
  for (const inst of av.weapons.values()) {
    inst.obj.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.userData.baseMaterial) o.userData.baseMaterial = o.material;
      if (hideWeapon) {
        if (!o.userData.shadowMaterial) o.userData.shadowMaterial = shadowOnly(o.userData.baseMaterial);
        o.material = o.userData.shadowMaterial;
      } else o.material = o.userData.baseMaterial;
    });
  }
}

function setGhost(av, on) {
  if (av.ghost === on) return;
  av.ghost = on;
  applyLocalMode(av);
}

// ------------------------------------------------------------------------------------------ per-frame animation
function currentQuality() { return QUALITY[state.quality] || QUALITY.medium; }

function placeRoot(av, dt) {
  const e = av.entity;
  av.root.position.copy(e.pos);
  if (e.id !== state.selfId && dt > 0 && (e.life === LIFE.GROUND) && !hasFlag(e, FLAG.AIRBORNE) && !hasFlag(e, FLAG.MANTLE)) {
    // Remote poses arrive interpolated; keep the feet on the floor through small errors.
    let gy = e.pos.y;
    try { const g = world.getGround(e.pos.x, e.pos.z, e.pos.y + 0.6); if (g && Number.isFinite(g.y)) gy = g.y; } catch (x) { gy = e.pos.y; }
    if (Math.abs(gy - e.pos.y) < TUNE.remoteGroundSnap) av.groundY = damp(av.groundY, gy, 18, dt);
    else av.groundY = e.pos.y;
    av.root.position.y = av.groundY;
  } else av.groundY = av.root.position.y;
}

function startReload(av, weaponId, empty) {
  const W = WEAPONS[weaponId];
  if (!W || !W.reload) return;
  av.reloadT = 0;
  av.reloadEmpty = empty;
  av.reloadDur = empty ? W.reloadEmpty : W.reload;
  av.magDropped = false;
}

function startDeath(av) {
  av.deathT = 0;
  av.deathYaw = av.root.rotation.y - Math.PI;
  av.reloadT = -1; av.throwT = -1; av.plateT = -1;
}

function animate(av, dt, isLocal) {
  const e = av.entity;
  // ---------------------------------------------------------------- kinematics
  if (isLocal) av.vel.copy(e.vel);
  else {
    if (!av.velInit || dt <= 0) { av.lastPos.copy(e.pos); av.velInit = true; }
    const inv = dt > 1e-4 ? 1 / dt : 0;
    v1.subVectors(e.pos, av.lastPos).multiplyScalar(inv);
    if (v1.lengthSq() > 900) v1.set(0, 0, 0);       // teleport / respawn
    av.vel.x = damp(av.vel.x, v1.x, 12, dt); av.vel.y = damp(av.vel.y, v1.y, 12, dt); av.vel.z = damp(av.vel.z, v1.z, 12, dt);
    av.lastPos.copy(e.pos);
  }
  const yaw = e.yaw;
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  av.vf = av.vel.x * -sy + av.vel.z * -cy;
  av.vr = av.vel.x * cy + av.vel.z * -sy;
  av.vy = av.vel.y;
  av.speed = Math.hypot(av.vel.x, av.vel.z);
  av.yawRate = dt > 0 ? angleDelta(av.prevYaw, yaw) / dt : 0;
  av.prevYaw = yaw;
  if (!isLocal) setGhost(av, !!e.stale);

  // ---------------------------------------------------------------- life transitions
  const alive = e.alive && e.life !== LIFE.DEAD;
  if (!alive && av.deathT < 0) startDeath(av);
  if (alive && av.deathT >= 0) { av.deathT = -1; }
  const flags = e.flags;
  const rising = flags & ~av.prevFlags;
  if (rising & FLAG.RELOAD && av.reloadT < 0 && !isLocal) startReload(av, e.weapon, false);
  if (!(flags & FLAG.RELOAD) && av.reloadT >= 0 && !isLocal && av.reloadT > 0.3) av.reloadT = -1;
  if (rising & FLAG.THROW) av.throwT = 0;
  if (!(flags & FLAG.THROW) && av.throwT > 0.9) av.throwT = -1;
  if (rising & FLAG.PLATE) av.plateT = 0;
  if (!(flags & FLAG.PLATE)) av.plateT = av.plateT >= 0 && av.plateT < 0.25 ? av.plateT : -1;
  if (rising & FLAG.FIRING && av.shootT > 0.3) av.shootT = 0;
  av.prevFlags = flags;
  updateCanopyState(av, e, dt, isLocal);
  av.prevLife = e.life;

  // ---------------------------------------------------------------- weapon selection
  const wantId = e.weapon && WEAPONS[e.weapon] && WEAPONS[e.weapon].class !== 'lethal' ? e.weapon : null;
  const nearWanted = isLocal || av.dist < (av.weaponNear ? TUNE.nearWeaponDistance + 4 : TUNE.nearWeaponDistance);
  if (wantId !== av.weaponId || nearWanted !== av.weaponNear) equip(av, wantId, nearWanted);
  const pistol = !!(av.weapon && av.weapon.proto.pistol);

  // ---------------------------------------------------------------- lower body state
  let ls;
  const swim = e.life === LIFE.GROUND && (isLocal ? localStance().stance === 'swim' : e.pos.y < -0.85);
  if (av.deathT >= 0) ls = LS.dead;
  else if (e.life === LIFE.FREEFALL) ls = LS.freefall;
  else if (e.life === LIFE.CHUTE) ls = LS.chute;
  else if (swim) ls = LS.swim;
  else if (hasFlag(e, FLAG.MANTLE)) ls = LS.mantle;
  else if (hasFlag(e, FLAG.SLIDE)) ls = LS.slide;
  else if (hasFlag(e, FLAG.AIRBORNE)) ls = LS.air;
  else ls = LS.loco;
  if (ls !== av.ls) enterLower(av, ls, av.ls);
  av.ls = ls;
  av.lsT += dt;
  for (let i = 0; i < LOWER_STATES.length; i++) {
    const target = i === ls ? 1 : 0;
    const rate = target > av.lsw[i] ? LS_FADE[i] : LS_FADE[ls];
    av.lsw[i] = av.lsw[i] < 0 ? 0 : damp(av.lsw[i], target, rate, dt);
    if (ls === LS.dead && i !== ls) av.lsw[i] *= Math.exp(-6 * dt);
  }
  let sum = 0;
  for (let i = 0; i < LOWER_STATES.length; i++) sum += av.lsw[i];
  if (sum < 1e-4) { av.lsw[ls] = 1; sum = 1; }
  for (let i = 0; i < LOWER_STATES.length; i++) av.lsw[i] /= sum;

  av.wL.fill(0); av.wU.fill(0);
  // Body facing (lower) and hip yaw.
  updateFacing(av, e, dt, ls);
  // Each lower state writes its clips scaled by its state weight.
  lowerLoco(av, e, dt, isLocal, av.lsw[LS.loco]);
  lowerAir(av, dt, av.lsw[LS.air]);
  lowerSlide(av, dt, av.lsw[LS.slide]);
  lowerMantle(av, e, dt, av.lsw[LS.mantle]);
  lowerFreefall(av, dt, av.lsw[LS.freefall]);
  lowerChute(av, dt, av.lsw[LS.chute]);
  lowerSwim(av, dt, av.lsw[LS.swim]);
  lowerDead(av, dt, av.lsw[LS.dead]);

  // ---------------------------------------------------------------- upper body
  upperBody(av, e, dt, isLocal, ls, pistol);

  applyWeights(av);
  av.mixer.update(0);

  // ---------------------------------------------------------------- root transform and procedural pass
  placeRoot(av, dt);
  av.root.rotation.set(0, 0, 0);
  let rootYaw = av.bodyYaw + av.hipYaw;
  if (ls === LS.dead) rootYaw = av.deathYaw;
  av.root.rotation.y = rootYaw + Math.PI;
  av.model.rotation.set(0, 0, 0);
  av.model.position.set(0, 0, 0);
  if (av.lsw[LS.freefall] > 0.01) freefallBody(av, e, av.lsw[LS.freefall]);
  // Swimming: the entity's feet are PLAYER-controller swimDepth below the surface; lift the horizontal Swim pose so
  // the back rides at the water line and the head breaks the surface, bobbing with the stroke.
  if (av.lsw[LS.swim] > 0.01) {
    const sw = av.lsw[LS.swim];
    av.model.position.y += sw * (TUNE.swimLift + 0.03 * Math.sin(av.upT * 2.2));
    av.model.rotation.x -= sw * (TUNE.swimPitchDeg + 2.5 * Math.sin(av.upT * 2.2 + 0.8)) * DEG;
  }
  av.root.updateMatrixWorld(true);

  procedural(av, e, dt, isLocal, ls, pistol);
}

function enterLower(av, ls, prev) {
  av.lsT = 0;
  if (ls === LS.air) {
    av.airT = 0;
    av.airStart = av.vy > 1.2;
  }
  if (ls === LS.slide) av.slideT = 0;
  if (prev === LS.slide && ls !== LS.slide) av.slideExitT = 0;
  if (ls === LS.mantle) av.mantleT = 0;
  if ((prev === LS.air || prev === LS.freefall || prev === LS.chute) && (ls === LS.loco)) {
    const impact = prev === LS.chute ? 4 : Math.max(-av.vy, prev === LS.freefall ? 12 : 0, av.lastFallSpeed || 0);
    av.landT = 0;
    av.landW = impact > TUNE.landMinSpeed ? clamp(0.35 + impact / 14, 0.35, 1) : 0.28;
  }
  if (ls === LS.freefall) av.ffT = 0;
}

function updateFacing(av, e, dt, ls) {
  const aim = e.yaw;
  if (ls === LS.freefall || ls === LS.chute) {
    // Face the direction of travel (or the aim when hovering), no hip twist.
    const h = av.speed > 2.5 ? Math.atan2(-av.vel.x, -av.vel.z) : aim;
    av.bodyYaw = dampAngle(av.bodyYaw, h, ls === LS.chute ? 2.5 : 4, dt);
    av.hipYaw = damp(av.hipYaw, 0, 8, dt);
    av.turning = false;
    return;
  }
  if (ls === LS.dead) return;
  if (ls === LS.slide || ls === LS.mantle || ls === LS.swim) {
    const h = av.speed > 1 ? Math.atan2(-av.vel.x, -av.vel.z) : aim;
    av.bodyYaw = dampAngle(av.bodyYaw, h, 10, dt);
    av.hipYaw = damp(av.hipYaw, 0, 10, dt);
    av.turning = false;
    return;
  }
  let hipTarget = 0;
  if (av.speed > 0.6) {
    // Hips toward the travel direction (right-positive angle a), backwards gait beyond backpedalDeg.
    const a = Math.atan2(av.vr, av.vf);
    const back = Math.abs(a) > TUNE.backpedalDeg * DEG;
    const rel = back ? wrapAngle(a - Math.PI) : a;
    hipTarget = -clamp(rel, -TUNE.hipYawMaxDeg * DEG, TUNE.hipYawMaxDeg * DEG);
    av.bodyYaw = dampAngle(av.bodyYaw, aim, 14, dt);
    av.turning = false;
  } else {
    // Feet planted until the twist gets large, then step around to face the aim.
    const twist = angleDelta(av.bodyYaw, aim);
    if (!av.turning && Math.abs(twist) > TUNE.turnStartDeg * DEG) av.turning = true;
    if (av.turning) {
      av.bodyYaw = dampAngle(av.bodyYaw, aim, TUNE.turnLambda, dt);
      if (Math.abs(angleDelta(av.bodyYaw, aim)) < TUNE.turnStopDeg * DEG) av.turning = false;
    }
  }
  av.hipYaw = damp(av.hipYaw, hipTarget, TUNE.hipYawLambda, dt);
}

// ---------------------------------------------------------------- lower states
function addL(av, i, w, t) { if (w <= 0) return; av.wL[i] += w; av.tL[i] = t; }

function lowerLoco(av, e, dt, isLocal, W) {
  const crouchTarget = hasFlag(e, FLAG.CROUCH) ? 1 : 0;
  av.crouchW = damp(av.crouchW, crouchTarget, 9, dt);
  if (W <= 1e-4) return;
  const speed = av.speed;
  // Gait phase: the local player's comes from the controller (it emits the footstep sounds on the same phase).
  if (isLocal) {
    av.phase = localGait().phase;
  } else {
    const g = gaitRate(speed, av.crouchW > 0.5, gaitTmp);
    const backwards = av.vf < -0.3 * speed && speed > 0.6;
    const prev = av.phase;
    let p = prev + (backwards ? -1 : 1) * g.rate * dt;
    p -= Math.floor(p);
    if (speed > 0.35) remoteFootsteps(av, e, prev, p, backwards);
    av.phase = p;
  }
  // Turning in place: step the feet with a slow walk cycle.
  let turnW = 0;
  if (av.turning && speed < 0.6) {
    turnW = 0.55;
    av.turnPhase += dt * 1.25;
  } else av.turnPhase = 0;
  const land = av.landT < 0.6 ? av.landW * (1 - smoothstep(0.12, 0.5, av.landT)) : 0;
  av.landT += dt;
  const exitW = av.slideExitT < 0.5 ? 1 - smoothstep(0.05, 0.45, av.slideExitT) : 0;
  av.slideExitT += dt;
  const base = W * (1 - land) * (1 - exitW * 0.85);
  for (let set = 0; set < 2; set++) {
    const sw = set === 0 ? 1 - av.crouchW : av.crouchW;
    if (sw <= 1e-3) continue;
    const g = gaitRate(speed, set === 1, gaitTmp);
    const table = g.table;
    const a = table[g.i0], b = table[g.i1];
    const wa = base * sw * (1 - g.w), wb = base * sw * g.w;
    addGait(av, a, wa, set === 1);
    addGait(av, b, wb, set === 1);
  }
  if (turnW > 0) {
    const iw = CI.Walk;
    const k = base * turnW * (1 - av.crouchW);
    // Steal weight from idle.
    const idle = av.wL[CI.Idle];
    const take = Math.min(idle, k);
    av.wL[CI.Idle] -= take;
    addL(av, iw, take, loopT(av.turnPhase * dur(iw), iw));
  }
  if (land > 0) addL(av, CI.Jump_Land, W * land, 0.32 * dur(CI.Jump_Land) + av.landT * 1.1);
  if (exitW > 0) addL(av, CI.Slide_Exit, W * (1 - land) * exitW * 0.85, Math.min(av.slideExitT * 1.2, dur(CI.Slide_Exit) - 0.01));
}

function addGait(av, anchor, w, crouch) {
  if (w <= 1e-4) return;
  const i = CI[anchor.clip];
  if (!(anchor.v > 0)) {
    // Idle clips run on their own clock.
    av.wL[i] += w;
    av.tL[i] = loopT(av.upT, i);
    return;
  }
  const d = dur(i);
  const t = (((av.phase + anchor.ph) % 1) + 1) % 1 * d;
  av.wL[i] += w;
  av.tL[i] = t;
}

function lowerAir(av, dt, W) {
  av.airT += dt;
  if (W <= 1e-4) return;
  const startW = av.airStart ? 1 - smoothstep(0.18, 0.42, av.airT) : 0;
  const ds = dur(CI.Jump_Start);
  addL(av, CI.Jump_Start, W * startW, Math.min(ds * 0.42 + av.airT * 1.3, ds - 0.01));
  addL(av, CI.Jump_Loop, W * (1 - startW), loopT(0.25 + av.airT * 0.8, CI.Jump_Loop));
  av.lastFallSpeed = Math.max(0, -av.vy);
}

function lowerSlide(av, dt, W) {
  av.slideT += dt;
  if (W <= 1e-4) return;
  const startW = 1 - smoothstep(0.32, 0.55, av.slideT);
  const ds = dur(CI.Slide_Start);
  addL(av, CI.Slide_Start, W * startW, Math.min(0.12 * ds + av.slideT * 1.25, ds - 0.01));
  addL(av, CI.Slide_Loop, W * (1 - startW), loopT(av.slideT * 0.6, CI.Slide_Loop));
}

function lowerMantle(av, e, dt, W) {
  av.mantleT += dt;
  if (W <= 1e-4) return;
  const d = dur(CI.Climb_1m);
  addL(av, CI.Climb_1m, W, Math.min(av.mantleT * (d / (PLAYER.mantle.duration * 1.05)), d - 0.01));
}

function lowerFreefall(av, dt, W) {
  av.ffT += dt;
  if (W <= 1e-4) return;
  const d = dur(CI.Swim);
  const t = (TUNE.freefallFrame + TUNE.freefallFlutter * Math.sin(av.ffT * 3.1)) * d;
  addL(av, CI.Swim, W, t);
}

function lowerChute(av, dt, W) {
  if (W <= 1e-4) return;
  addL(av, CI.Jump_Loop, W, loopT(0.4 + av.upT * 0.35, CI.Jump_Loop));
}

function lowerSwim(av, dt, W) {
  if (W <= 1e-4) return;
  const rate = 0.55 + clamp(av.speed / 2.5, 0, 1) * 0.6;
  av.swimT = (av.swimT || 0) + dt * rate;
  addL(av, CI.Swim, W, loopT(av.swimT, CI.Swim));
}

function lowerDead(av, dt, W) {
  if (av.deathT >= 0) av.deathT += dt;
  if (W <= 1e-4) return;
  addL(av, CI.Death, W, Math.min(Math.max(0, av.deathT), dur(CI.Death) - 0.01));
}

// ---------------------------------------------------------------- upper body
function upperBody(av, e, dt, isLocal, ls, pistol) {
  av.upT += dt;
  av.shootT += dt; av.hitT += dt; av.pickT += dt;
  if (av.throwT >= 0) av.throwT += dt;
  if (av.plateT >= 0) av.plateT += dt;
  if (av.reloadT >= 0) { av.reloadT += dt; if (av.reloadT > av.reloadDur + 0.05) av.reloadT = -1; }
  const armed = !!av.weapon;
  const sprint = hasFlag(e, FLAG.SPRINT) && ls === LS.loco;
  const fullBody = ls === LS.dead || ls === LS.freefall || ls === LS.chute || ls === LS.swim || ls === LS.mantle;
  const throwing = av.throwT >= 0 && av.throwT < 1.15;
  const plating = av.plateT >= 0;
  // Follow the lower clip's own upper half?
  let followTarget = 0;
  if (fullBody || !armed) followTarget = 1;
  else if (pistol && sprint) followTarget = 1;
  if (throwing || plating) followTarget = 0;
  av.follow = damp(av.follow, followTarget, followTarget > av.follow ? 9 : 7, dt);
  // Raise: shouldered when aiming or shooting, low ready otherwise.
  const ads = isLocal ? (state.local.ads || 0) : (hasFlag(e, FLAG.ADS) ? 1 : 0);
  let raiseTarget = TUNE.readyRaise;
  if (ads > 0.05 || hasFlag(e, FLAG.ADS)) raiseTarget = 1;
  else if (av.shootT < TUNE.raiseHold || hasFlag(e, FLAG.FIRING)) raiseTarget = 1;
  if (sprint) raiseTarget = 0;
  if (av.reloadT >= 0) raiseTarget = Math.min(raiseTarget, 0.55);
  const raiseRate = raiseTarget > av.raise ? (ads > 0.05 ? 16 : 12) : 6;
  av.raise = damp(av.raise, raiseTarget, raiseRate, dt);
  if (isLocal && ads > 0.02) av.raise = Math.max(av.raise, Math.min(1, ads * 1.6));

  const base = 1 - av.follow;
  // Overlays.
  const shootDur = pistol ? dur(CI.Shoot) : dur(CI.Rifle_Shoot);
  const shootW = armed && !throwing && !plating && av.shootT < TUNE.shootPulse + 0.12 ? (1 - smoothstep(0, TUNE.shootPulse + 0.12, av.shootT)) * 0.7 : 0;
  const hitW = av.hitT < TUNE.hitPulse ? TUNE.hitWeight * Math.sin(Math.PI * clamp(av.hitT / TUNE.hitPulse, 0, 1)) : 0;
  const throwW = throwing ? smoothstep(0, 0.08, av.throwT) * (1 - smoothstep(0.95, 1.15, av.throwT)) : 0;
  const plateW = plating ? smoothstep(0, 0.15, av.plateT) : 0;
  const pickW = av.pickT < 0.85 && !throwing && !plating && ls === LS.loco ? Math.sin(Math.PI * clamp(av.pickT / 0.85, 0, 1)) * 0.85 : 0;
  let over = 0;
  const overlays = [shootW, hitW, throwW, plateW, pickW];
  for (const w of overlays) over = Math.min(1, over + w);
  const keep = 1 - over;
  // Follow: copy the lower weights' upper halves.
  if (av.follow > 1e-3) {
    for (let i = 0; i < NC; i++) {
      if (av.wL[i] <= 0) continue;
      av.wU[i] += av.wL[i] * av.follow * keep;
      av.tU[i] = av.tL[i];
    }
  }
  if (base > 1e-3) {
    const bw = base * keep;
    if (!armed) {
      // Unarmed but not following (throw/plate): idle upper half.
      addU(av, CI.Idle, bw, loopT(av.upT, CI.Idle));
    } else if (pistol) {
      addU(av, CI.Aim_Idle, bw, loopT(av.upT, CI.Aim_Idle));
    } else {
      addU(av, CI.Rifle_Idle, bw * (1 - av.raise), loopT(av.upT, CI.Rifle_Idle));
      addU(av, CI.Rifle_Aim, bw * av.raise, loopT(av.upT, CI.Rifle_Aim));
    }
  }
  const sum = shootW + hitW + throwW + plateW + pickW;
  const k = sum > 0 ? over / sum : 0;
  if (shootW > 0) addU(av, pistol ? CI.Shoot : CI.Rifle_Shoot, shootW * k, Math.min(av.shootT * 1.2, shootDur - 0.01));
  if (hitW > 0) addU(av, av.hitHead ? CI.Hit_Head : CI.Hit_Chest, hitW * k, Math.min(av.hitT * 1.3, dur(av.hitHead ? CI.Hit_Head : CI.Hit_Chest) - 0.01));
  if (throwW > 0) {
    // The clip's release lands at WEAPONS.frag.throwTime.
    const d = dur(CI.Throw_Grenade);
    const rate = (d * 0.5) / Math.max(0.2, WEAPONS.frag.throwTime);
    addU(av, CI.Throw_Grenade, throwW * k, Math.min(av.throwT * rate, d - 0.01));
  }
  if (plateW > 0) {
    const d = dur(CI.Use_Medkit);
    addU(av, CI.Use_Medkit, plateW * k, loopT(av.plateT * (d / PLAYER.armor.insertTime), CI.Use_Medkit));
  }
  if (pickW > 0) addU(av, CI.PickUp, pickW * k, Math.min(av.pickT, dur(CI.PickUp) - 0.01));
  // Normalise (overlays and follow can leave tiny gaps).
  let s = 0;
  for (let i = 0; i < NC; i++) s += av.wU[i];
  if (s > 1e-4 && Math.abs(s - 1) > 1e-3) for (let i = 0; i < NC; i++) av.wU[i] /= s;
  else if (s <= 1e-4) addU(av, CI.Idle, 1, loopT(av.upT, CI.Idle));

  // Procedural weights for this frame.
  av.slingW = (ls === LS.freefall || ls === LS.chute || ls === LS.swim || throwing || plating) ? 1 : 0;
  let aimW = armed && !av.slingW ? 1 - av.follow : 0;
  if (ls === LS.slide) aimW *= 0.8;
  if (ls === LS.air) aimW *= 0.9;
  av.aimW = damp(av.aimW, aimW, 12, dt);
  const ikTarget = armed && !av.slingW && ls !== LS.dead ? (1 - av.follow) : 0;
  av.ikW = damp(av.ikW, ikTarget, 14, dt);
}

function addU(av, i, w, t) { if (w <= 0) return; av.wU[i] += w; av.tU[i] = t; }

// ------------------------------------------------------------------------------------------ equipment
function equip(av, id, near) {
  // Detach the current weapon.
  if (av.weapon) av.weapon.obj.removeFromParent();
  av.weaponId = id;
  av.weaponNear = near;
  av.weapon = id ? weaponInstance(av, id, near) : null;
  av.weaponOnBack = false;
  if (av.weapon) {
    av.weapon.obj.traverse((o) => { if (o.isMesh) { o.userData.weapon = true; o.castShadow = av.castShadow && near; } });
    av.kickPivot.add(av.weapon.obj);
    applyLocalMode(av);
  }
  av.reloadT = -1;
}

function sling(av, onBack) {
  if (av.weaponOnBack === onBack || !av.weapon) return;
  av.weaponOnBack = onBack;
  (onBack ? av.backHolder : av.kickPivot).add(av.weapon.obj);
}

// ------------------------------------------------------------------------------------------ procedural pass
function procedural(av, e, dt, isLocal, ls, pistol) {
  const W = av.weapon ? av.weapon.proto.W : null;
  if (av.weapon) sling(av, av.slingW > 0.5);
  // ---- aim solver: point the held weapon along the entity's aim
  av.aimPitch = isLocal ? e.pitch : damp(av.aimPitch, e.pitch, 18, dt);
  if (av.weapon && av.aimW > 0.01 && !av.weaponOnBack) {
    aimDirection(av, e, pistol, v5);
    solveAim(av, v5, av.aimW);
  } else if (!av.weapon && ls === LS.loco && Math.abs(av.hipYaw) > 0.01) {
    // Unarmed: keep the chest facing the aim when the hips turn.
    q1.setFromAxisAngle(UP, -av.hipYaw * 0.4);
    rotateBoneWorld(av.bones.spine1, q1);
    rotateBoneWorld(av.bones.spine2, q1);
  }
  // ---- weapon kick (spring) and cant
  // Semi-implicit Euler in fixed sub-steps: far avatars animate at 6 to 15 Hz, where one big explicit step of this
  // stiff spring would diverge and pin the weapon at its clamp.
  const K = TUNE.kick;
  const ns = Math.min(64, Math.ceil(dt / (1 / 240)));
  const h = ns > 0 ? dt / ns : 0;
  for (let i = 0; i < ns; i++) {
    av.kickZv += (-K.k * av.kickZ - K.c * av.kickZv) * h;
    av.kickZ += av.kickZv * h;
    av.kickRv += (-K.k * av.kickR - K.c * av.kickRv) * h;
    av.kickR += av.kickRv * h;
  }
  const rl = reloadPose(av, W);
  av.kickPivot.position.set(0, -0.012 * rl.dip, clamp(av.kickZ, -0.02, 0.12));
  av.kickPivot.rotation.set(clamp(av.kickR, -0.1, 0.35) - rl.dip * 0.12, rl.dip * 0.05, rl.cant);
  // ---- ADS eye (before the kick) for the camera
  if (av.weapon && !av.weaponOnBack) {
    av.handHolder.updateWorldMatrix(true, false);
    av.adsEye.copy(av.weapon.proto.eye);
    if (!av.weapon.proto.W.scope) av.adsEye.z += TUNE.adsEyeBack[av.weapon.id] || 0.045;
    av.adsEye.applyMatrix4(av.handHolder.matrixWorld);
    av.adsValid = true;
  } else av.adsValid = false;
  av.kickPivot.updateMatrixWorld(true);
  // ---- magazine / bolt
  animateParts(av, W, rl);
  // ---- left hand IK onto the weapon (grip or reload path)
  if (av.weapon && av.ikW > 0.01 && !av.weaponOnBack) leftHandIK(av, pistol, rl);
  // ---- chute risers
  if (av.lsw[LS.chute] > 0.01) chuteArms(av, e, dt, isLocal, av.lsw[LS.chute]);
  // ---- canopy follows the body
  if (av.canopy && !av.canopy.detached && av.canopy.group.visible) placeCanopy(av, e, dt);
}

const aimEuler = new THREE.Euler(0, 0, 0, 'YXZ');
/** Desired weapon direction (world) from the entity's aim and the current pose family. */
function aimDirection(av, e, pistol, out) {
  let pitch = av.aimPitch, yaw = e.yaw;
  const r = av.raise;
  const low = pistol ? TUNE.pistolLow : TUNE.lowReady;
  const sprint = hasFlag(e, FLAG.SPRINT) && av.ls === LS.loco;
  const lp = (sprint ? TUNE.sprintCarry.pitchDeg : low.pitchDeg) * DEG, lyw = (sprint ? TUNE.sprintCarry.yawDeg : low.yawDeg) * DEG;
  pitch = lerp(clamp(pitch + lp, -75 * DEG, 20 * DEG), pitch, r);
  yaw += lyw * (1 - r);
  if (av.reloadT >= 0) {
    const rl = reloadPose(av, av.weapon.proto.W);
    pitch -= rl.dip * 16 * DEG;
    yaw += rl.dip * 10 * DEG;
  }
  aimEuler.set(pitch, yaw, 0, 'YXZ');
  return out.copy(FWD).applyEuler(aimEuler);
}

/** Rotate a bone by a world-space rotation about its own pivot (parent world matrix must be current). */
function rotateBoneWorld(bone, qWorld) {
  bone.parent.getWorldQuaternion(qp);
  q3.copy(qp).invert().multiply(qWorld).multiply(qp);
  bone.quaternion.premultiply(q3);
  bone.updateMatrixWorld(true);
}

function setBoneWorldQuat(bone, qWorld) {
  bone.parent.getWorldQuaternion(qp);
  bone.quaternion.copy(qp.invert()).multiply(qWorld);
  bone.updateMatrixWorld(true);
}

function solveAim(av, desired, weight) {
  const b = av.bones;
  b.socket.getWorldQuaternion(q1);
  v1.copy(FWD).applyQuaternion(q1);
  q2.setFromUnitVectors(v1, desired);
  let angle = 2 * Math.acos(clamp(q2.w, -1, 1));
  if (angle < 1e-4) return;
  const s = Math.sqrt(Math.max(1e-12, 1 - q2.w * q2.w));
  v2.set(q2.x / s, q2.y / s, q2.z / s);
  angle = Math.min(angle, TUNE.aimMaxDeg * DEG) * weight;
  const split = TUNE.aimSplit;
  q1.setFromAxisAngle(v2, angle * split[0]); rotateBoneWorld(b.spine1, q1);
  q1.setFromAxisAngle(v2, angle * split[1]); rotateBoneWorld(b.spine2, q1);
  q1.setFromAxisAngle(v2, angle * split[2]); rotateBoneWorld(b.neck, q1);
}

// ---- reload choreography: {dip 0..1, cant rad, mag: 'rest'|'out'|'hidden'|'in', magOffset weapon-space, hand target}
const rlOut = { dip: 0, cant: 0, u: -1, phase: 'none', k: 0 };
function reloadPose(av, W) {
  rlOut.dip = 0; rlOut.cant = 0; rlOut.u = -1; rlOut.phase = 'none'; rlOut.k = 0;
  if (av.reloadT < 0 || !W || !W.reloadCues) return rlOut;
  const u = clamp(av.reloadT / av.reloadDur, 0, 1);
  const cue = W.reloadCues;
  rlOut.u = u;
  rlOut.dip = smoothstep(0, 0.12, u) * (1 - smoothstep(0.86, 1, u));
  rlOut.cant = rlOut.dip * (W.class === 'pistol' ? 0.35 : 0.42);
  const pouchAt = (cue.magout + cue.magin) * 0.5;
  if (u < cue.magout) { rlOut.phase = 'reach'; rlOut.k = smoothstep(0.02, cue.magout, u); }
  else if (u < cue.magout + 0.12) { rlOut.phase = 'pull'; rlOut.k = (u - cue.magout) / 0.12; }
  else if (u < pouchAt + 0.04) { rlOut.phase = 'pouch'; rlOut.k = smoothstep(cue.magout + 0.12, pouchAt + 0.04, u); }
  else if (u < cue.magin) { rlOut.phase = 'insert'; rlOut.k = smoothstep(pouchAt + 0.04, cue.magin, u); }
  else if (av.reloadEmpty && W.class !== 'pistol' && u < cue.charge + 0.08) { rlOut.phase = 'charge'; rlOut.k = clamp((u - cue.magin) / Math.max(0.05, cue.charge + 0.08 - cue.magin), 0, 1); }
  else { rlOut.phase = 'return'; rlOut.k = smoothstep(cue.magin, Math.min(1, cue.magin + 0.18), u); }
  return rlOut;
}

const magWorld = new THREE.Vector3();
function animateParts(av, W, rl) {
  const inst = av.weapon;
  if (!inst || !inst.mag) return;
  const p = inst.proto;
  inst.mag.visible = true;
  inst.mag.position.copy(p.magPos);
  inst.mag.rotation.set(0, 0, 0);
  if (inst.bolt) inst.bolt.position.copy(p.boltPos);
  if (rl.u < 0) return;
  const cue = W.reloadCues;
  if (rl.phase === 'pull') {
    inst.mag.position.y -= 0.2 * rl.k;
    inst.mag.position.z += 0.03 * rl.k;
    inst.mag.rotation.x = -0.25 * rl.k;
  } else if (rl.phase === 'pouch') {
    inst.mag.visible = false;
    if (!av.magDropped) { av.magDropped = true; dropMagazine(av); }
  } else if (rl.phase === 'insert') {
    // The new magazine travels from the pouch to the well with the hand.
    const k = rl.k;
    pouchWorld(av, v1);
    inst.mag.parent.updateWorldMatrix(true, false);
    m1.copy(inst.mag.parent.matrixWorld).invert();
    v2.copy(v1).applyMatrix4(m1);                       // pouch in weapon space
    v3.copy(p.magPos); v3.y -= 0.06;                    // just under the well
    inst.mag.position.lerpVectors(v2, v3, smoothstep(0, 0.82, k));
    if (k > 0.82) inst.mag.position.lerpVectors(v3, p.magPos, (k - 0.82) / 0.18);
    inst.mag.rotation.x = -0.35 * (1 - k);
  }
  // Bolt / slide rack.
  if (inst.bolt) {
    let rack = 0;
    if (rl.phase === 'charge') rack = Math.sin(Math.PI * clamp(rl.k * 1.25, 0, 1));
    if (W.class === 'pistol' && av.reloadEmpty && rl.u > cue.magin && rl.u < cue.charge + 0.06) rack = Math.sin(Math.PI * clamp((rl.u - cue.magin) / (cue.charge + 0.06 - cue.magin), 0, 1)) * 0.6;
    inst.bolt.position.z += rack * p.boltTravel;
  }
  // Bolt-action cycle after each sniper shot.
  if (W.mode === 'bolt' && av.shootT > 0.18 && av.shootT < (W.boltTime || 1) && inst.bolt) {
    const k = (av.shootT - 0.18) / ((W.boltTime || 1) - 0.18);
    inst.bolt.position.z += Math.sin(Math.PI * k) * 0.08;
  }
}

function pouchWorld(av, out) {
  out.set(TUNE.pouch[0], TUNE.pouch[1], TUNE.pouch[2]);
  // Pouch rides on the chest: express it relative to Spine2 at its current pose.
  av.bones.spine2.updateWorldMatrix(true, false);
  if (!av.pouchLocal) {
    // Model-space pouch -> Spine2 space, captured on first use at the current pose's chest height.
    av.model.updateWorldMatrix(true, false);
    out.applyMatrix4(av.model.matrixWorld);
    av.pouchLocal = out.clone().applyMatrix4(m2.copy(av.bones.spine2.matrixWorld).invert());
    return out;
  }
  return out.copy(av.pouchLocal).applyMatrix4(av.bones.spine2.matrixWorld);
}

const handTarget = new THREE.Matrix4();
const htPos = new THREE.Vector3(), htQuat = new THREE.Quaternion(), htScale = new THREE.Vector3();
const gripPos = new THREE.Vector3(), gripQuat = new THREE.Quaternion();
const pole = new THREE.Vector3();
function leftHandIK(av, pistol, rl) {
  const p = av.weapon.proto;
  const rel = pistol ? probe.pistolGrip : probe.rifleGrip;
  av.kickPivot.updateWorldMatrix(true, false);
  handTarget.multiplyMatrices(av.kickPivot.matrixWorld, rel);
  handTarget.decompose(gripPos, gripQuat, htScale);
  // Per-weapon handguard shift (weapon space -> world).
  if (!pistol) { v1.copy(p.gripShift).transformDirection(av.kickPivot.matrixWorld).multiplyScalar(p.gripShift.length()); gripPos.add(v1); }
  htPos.copy(gripPos);
  htQuat.copy(gripQuat);
  let weight = av.ikW;
  if (rl.u >= 0 && av.weapon.mag) {
    // Reload path: grip -> magazine -> pull -> pouch -> insert -> grip.
    av.weapon.mag.updateWorldMatrix(true, false);
    magWorld.setFromMatrixPosition(av.weapon.mag.matrixWorld);
    v2.set(0, -0.07, 0.01).transformDirection(av.kickPivot.matrixWorld).multiplyScalar(0.07);
    v3.copy(magWorld).add(v2);                          // palm under the magazine
    pouchWorld(av, v4);
    switch (rl.phase) {
      case 'reach': htPos.lerpVectors(gripPos, v3, rl.k); break;
      case 'pull': htPos.copy(v3); break;
      case 'pouch': htPos.lerpVectors(v3, v4, rl.k); break;
      case 'insert': htPos.copy(v3); break;
      case 'charge': {
        // Support hand slaps the charging handle side of the receiver.
        v2.set(0.0, 0.11, -0.12).applyMatrix4(av.kickPivot.matrixWorld);
        htPos.lerpVectors(v3, v2, Math.sin(Math.PI * clamp(rl.k, 0, 1)));
        break;
      }
      default: htPos.lerpVectors(v3, gripPos, rl.k);
    }
    weight = Math.max(weight, 0.95);
  }
  const b = av.bones;
  // Elbow hint: down and out to the left of the chest.
  b.spine2.updateWorldMatrix(true, false);
  pole.set(0.6, -0.9, -0.1).applyQuaternion(av.root.quaternion).add(b.lUpper.getWorldPosition(v4));
  ikTwoBone(b.lUpper, b.lFore, b.lHand, htPos, pole, weight);
  // Hand orientation from the baked grip relative to the weapon.
  b.lHand.getWorldQuaternion(q1);
  q1.slerp(htQuat, weight);
  setBoneWorldQuat(b.lHand, q1);
}

const ikU = new THREE.Vector3(), ikW = new THREE.Vector3(), ikN = new THREE.Vector3(), ikP = new THREE.Vector3(), ikE = new THREE.Vector3();
function ikTwoBone(upper, lower, end, target, poleW, weight) {
  upper.getWorldPosition(va);
  lower.getWorldPosition(vb);
  end.getWorldPosition(vc);
  vt.lerpVectors(vc, target, clamp(weight, 0, 1));
  const l1 = va.distanceTo(vb), l2 = vb.distanceTo(vc);
  if (l1 < 1e-4 || l2 < 1e-4) return;
  const d = clamp(va.distanceTo(vt), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
  // 1) elbow angle
  ikU.subVectors(va, vb); ikW.subVectors(vc, vb);
  const cur = ikU.angleTo(ikW);
  const des = Math.acos(clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1));
  ikN.crossVectors(ikU, ikW);
  if (ikN.lengthSq() < 1e-10) { ikN.subVectors(vt, va).cross(ikP.subVectors(poleW, va)); }
  if (ikN.lengthSq() < 1e-10) return;
  ikN.normalize();
  q1.setFromAxisAngle(ikN, des - cur);
  rotateBoneWorld(lower, q1);
  // 2) swing the chain onto the target
  end.getWorldPosition(vc);
  ikU.subVectors(vc, va).normalize();
  ikW.subVectors(vt, va).normalize();
  q1.setFromUnitVectors(ikU, ikW);
  rotateBoneWorld(upper, q1);
  // 3) twist about the shoulder-target axis so the elbow points at the pole
  lower.getWorldPosition(vb);
  ikE.subVectors(vb, va); ikP.subVectors(poleW, va);
  ikE.addScaledVector(ikW, -ikE.dot(ikW));
  ikP.addScaledVector(ikW, -ikP.dot(ikW));
  if (ikE.lengthSq() > 1e-8 && ikP.lengthSq() > 1e-8) {
    ikE.normalize(); ikP.normalize();
    let ang = Math.acos(clamp(ikE.dot(ikP), -1, 1));
    ikN.crossVectors(ikE, ikP);
    if (ikN.dot(ikW) < 0) ang = -ang;
    q1.setFromAxisAngle(ikW, ang * 0.85);
    rotateBoneWorld(upper, q1);
  }
}

function dropMagazine(av) {
  const p = av.weapon && av.weapon.proto;
  if (!p || !p.looseMag || !scene || av.dist > 30) return;
  const obj = p.looseMag.clone(true);
  av.weapon.mag.updateWorldMatrix(true, false);
  av.weapon.mag.matrixWorld.decompose(obj.position, obj.quaternion, v1);
  scene.add(obj);
  const rootQ = av.root.quaternion;
  const vel = new THREE.Vector3(0.6, -0.5, 0.3).applyQuaternion(rootQ).add(av.vel);
  debris.push({ obj, vel, spin: new THREE.Vector3(3 + Math.random() * 4, Math.random() * 3, Math.random() * 3), t: 0, rest: false });
  if (debris.length > 8) { const d = debris.shift(); d.obj.removeFromParent(); }
}

function updateDebris(dt) {
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i];
    d.t += dt;
    if (!d.rest) {
      d.vel.y -= 9.81 * dt;
      d.obj.position.addScaledVector(d.vel, dt);
      d.obj.rotation.x += d.spin.x * dt; d.obj.rotation.y += d.spin.y * dt; d.obj.rotation.z += d.spin.z * dt;
      let gy = -100;
      try { const g = world.getGround(d.obj.position.x, d.obj.position.z, d.obj.position.y + 0.5); gy = g ? g.y : -100; } catch (x) { gy = -100; }
      if (d.obj.position.y <= gy + 0.02) {
        d.obj.position.y = gy + 0.02;
        if (Math.abs(d.vel.y) > 1.2) { d.vel.y *= -0.3; d.vel.x *= 0.5; d.vel.z *= 0.5; d.spin.multiplyScalar(0.5); }
        else { d.rest = true; d.obj.rotation.set(Math.PI / 2, d.obj.rotation.y, 0); }
      }
    }
    if (d.t > 12) { d.obj.removeFromParent(); debris.splice(i, 1); }
  }
}

// ---- freefall body attitude
function freefallBody(av, e, w) {
  // Belly to earth: the Swim frame is already horizontal. Diving pitches the head down, strafing banks.
  const descent = -av.vel.y;
  const dive = smoothstep(33, 50, descent);
  const fwd = clamp(av.speed / 26, 0, 1);
  const pitchDown = (dive * 55 + fwd * 8) * DEG;
  const bank = clamp(av.vr / 7, -1, 1) * 18 * DEG;
  av.model.position.y = 0.9 * w;
  av.model.rotation.set(pitchDown * w, 0, -bank * w, 'YXZ');
}

// ---- chute arms: hands up on the toggles, pulled down by turning and braking
function chuteArms(av, e, dt, isLocal, w) {
  let turn = clamp(-av.yawRate / (PLAYER.chute.turnRateDeg * DEG), -1, 1);
  let brake = 0;
  if (isLocal) {
    const a = localAir();
    brake = a.brake;
  } else {
    brake = clamp((PLAYER.chute.forwardSpeed - av.speed) / (PLAYER.chute.forwardSpeed - 6), 0, 1);
  }
  av.chuteTurn = damp(av.chuteTurn, turn, 6, dt);
  av.chuteBrake = damp(av.chuteBrake, brake, 6, dt);
  const b = av.bones;
  for (const side of [-1, 1]) {
    const upperB = side < 0 ? b.lUpper : b.rUpper;
    const foreB = side < 0 ? b.lFore : b.rFore;
    const handB = side < 0 ? b.lHand : b.rHand;
    const pull = clamp(av.chuteBrake + (side < 0 ? Math.max(0, av.chuteTurn) : Math.max(0, -av.chuteTurn)), 0, 1);
    // Target: toggle position above the shoulder, lower when pulled.
    upperB.getWorldPosition(v1);
    v2.set(side * -0.24, 0.62 - pull * 0.55, 0.06 + pull * 0.08).applyQuaternion(av.root.quaternion);
    v3.copy(v1).add(v2);
    pole.set(side * -0.8, -0.4, -0.5).applyQuaternion(av.root.quaternion).add(v1);
    ikTwoBone(upperB, foreB, handB, v3, pole, w);
  }
}

// ---- canopy lifecycle
function updateCanopyState(av, e, dt, isLocal) {
  const inChute = e.life === LIFE.CHUTE && av.deathT < 0;
  if (inChute && !av.canopy) { av.canopy = makeCanopy(); av.root.add(av.canopy.group); }
  const c = av.canopy;
  if (!c) return;
  if (inChute) {
    if (c.detached) { c.detached = false; c.group.removeFromParent(); av.root.add(c.group); }
    c.group.visible = true;
    c.open = isLocal ? clamp(localAir().chuteT, 0, 1) : Math.min(1, c.open + dt / PLAYER.chute.openTime);
    c.mode = 'open';
  } else if (c.mode === 'open') {
    // Landed or cut: the canopy stays in the world and collapses or flies off.
    c.mode = e.life === LIFE.FREEFALL ? 'cut' : 'collapse';
    c.detached = true;
    c.detachT = 0;
    c.group.updateWorldMatrix(true, false);
    c.group.matrixWorld.decompose(c.group.position, c.group.quaternion, c.group.scale);
    c.group.removeFromParent();
    scene.add(c.group);
    c.vel = new THREE.Vector3().copy(av.vel);
  } else if (!c.detached) {
    c.group.visible = false;
    c.open = 0;
  }
}

function placeCanopy(av, e, dt) {
  const c = av.canopy;
  const k = c.open;
  // Deployment: the pack streams up from the back and the cells inflate span-wise with a little overshoot.
  const inflate = k < 1 ? 1 - Math.pow(1 - k, 3) + Math.sin(k * Math.PI) * 0.08 : 1;
  const g = c.group;
  // The group lives in avatar root space; undo the body's freefall pitch.
  g.position.set(0, -0.0 + (1 - inflate) * -1.5, TUNE.chute.forward * inflate);
  g.scale.set(Math.max(0.08, inflate), Math.max(0.25, Math.min(1, k * 1.6)), Math.max(0.3, inflate));
  const bank = clamp(av.chuteTurn, -1, 1) * 14 * DEG;
  const pitch = av.chuteBrake * 8 * DEG;
  g.rotation.set(-pitch, 0, -bank);
}

function updateDetachedCanopy(av, dt) {
  const c = av.canopy;
  c.detachT += dt;
  const g = c.group;
  if (c.mode === 'cut') {
    c.vel.y += 6 * dt;
    g.position.addScaledVector(c.vel, dt);
    g.rotation.z += dt * 0.6;
    g.scale.multiplyScalar(Math.exp(-0.4 * dt));
  } else {
    // Collapse forward over the jumper and settle on the ground.
    const k = smoothstep(0, 1.6, c.detachT);
    c.vel.multiplyScalar(Math.exp(-1.5 * dt));
    g.position.x += c.vel.x * dt * (1 - k);
    g.position.z += c.vel.z * dt * (1 - k);
    let gy = 0;
    try { gy = world.getHeight(g.position.x, g.position.z); } catch (x) { gy = 0; }
    g.position.y = Math.max(gy - TUNE.chute.height * 0.12, g.position.y - dt * 3.2 * (0.3 + k));
    g.scale.y = Math.max(0.06, 1 - k * 0.94);
    g.rotation.x = Math.min(1.35, g.rotation.x + dt * 1.2);
  }
  if (c.detachT > (c.mode === 'cut' ? 6 : 9)) {
    c.detached = false;
    c.mode = 'packed';
    g.visible = false;
    g.removeFromParent();
    av.root.add(g);
    g.position.set(0, 0, 0); g.rotation.set(0, 0, 0); g.scale.set(1, 1, 1);
  }
}

// ---- remote footsteps (local footsteps come from the controller)
function remoteFootsteps(av, e, prev, p, backwards) {
  if (e.id === state.selfId || av.dist > TUNE.footstepDistance) return;
  const dir = backwards ? -1 : 1;
  const crossed = (a, b, mark) => (dir > 0 ? (a < mark && b >= mark) || (b < a && (mark >= a || mark <= b)) : (a > mark && b <= mark) || (b > a && (mark <= a || mark >= b)));
  let side = -1;
  if (crossed(prev, p, 0.5)) side = 1;
  else if (crossed(prev, p, 0) || crossed(prev, p, 1)) side = 0;
  if (side < 0) return;
  av.gaitSide = side;
  let surface = SURFACE.GRASS;
  try {
    const g = world.getGround(e.pos.x, e.pos.z, e.pos.y + 0.5);
    if (g && g.surface != null) surface = g.surface;
    if (e.pos.y < -0.1) surface = SURFACE.WATER;
  } catch (x) { surface = SURFACE.GRASS; }
  emit(EV.FOOTSTEP, {
    id: e.id, pos: [e.pos.x, e.pos.y, e.pos.z], surface,
    sprint: hasFlag(e, FLAG.SPRINT), crouch: hasFlag(e, FLAG.CROUCH), local: false,
  });
}
