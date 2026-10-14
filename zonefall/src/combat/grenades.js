// ZONEFALL - frag grenades (thrown, bouncing, exploding). OWNER: COMBAT. Contract: ARCHITECTURE.md 5.3, config.WEAPONS.frag.
// Deterministic simulation on every peer from the 'nade' message: fixed 1/120 s steps counted from the throw time,
// segment raycasts against the world, restitution/friction bounces (GRENADE_BOUNCE), rolling to rest; late receivers
// fast-forward by (match time now - t). On explosion: GRENADE_EXPLODE, damage.explosionAt (each peer applies the
// splash to itself; the host to bots), camera shake by distance.
// While the local player cooks, a predicted arc (dots fading with distance) and a landing ring are drawn
// (setPreview, called by combat/weapons). Extra exports: setPreview(on, cook), dropLocal(cook), predictArc().
import * as THREE from 'three';
import { WEAPONS, SURFACE } from '../config.js';
import { on, emit, EV } from '../core/bus.js';
import { state, localPlayer, isBotId, LIFE, debug } from '../core/state.js';
import { clamp } from '../core/util.js';
import * as world from '../world/world.js';
import * as assets from '../engine/assets.js';
import * as damage from './damage.js';
import * as session from '../net/session.js';
import * as camera from '../player/camera.js';

const F = WEAPONS.frag;
const TUNE = {
  step: 1 / 120,
  radius: 0.05,
  restSpeed: 0.35,
  rollFriction: 3.2,          // 1/s velocity decay while rolling on the ground
  bounceEvent: 1.4,           // m/s impact speed for a GRENADE_BOUNCE
  waterDrag: 6,
  maxLive: 16,
  handOffset: { fwd: 0.45, right: 0.18, up: -0.12 },
  playerCarry: 0.7,           // share of the thrower's velocity added to the throw
  preview: { dots: 44, step: 1 / 40, maxTime: 2.6, color: 0xf2efe6 },
};

let scene = null;
let proto = null;
const live = [];                // grenade records
const pool = [];                // spare meshes
let seq = 0;
let inited = false;
// preview
let arcDots = null, arcRing = null, previewOn = false, previewCook = 0;
const dummy = new THREE.Object3D();
const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3(), vN = new THREE.Vector3();
const eyeV = new THREE.Vector3(), dirV = new THREE.Vector3(), rightV = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);

function err(msg) { return new Error(`[COMBAT/grenades] ${msg}`); }

// ------------------------------------------------------------------------------------------ setup
export function init(sc) {
  if (inited) return;
  if (!sc) throw err('init needs the scene');
  inited = true;
  scene = sc;
  proto = buildProto();
  buildPreview();
  on(EV.NET_NADE, ({ data }) => {
    if (!data || live.some((g) => g.gid === data.gid)) return;
    spawnInternal({ gid: data.gid, owner: data.by, origin: data.o, vel: data.v, fuse: data.fuse, t: data.t }, true);
  });
  on(EV.MATCH_START, clearAll);
  on(EV.APP_STATE, ({ to }) => { if (to === 'menu') clearAll(); });
  debug.combat = debug.combat || {};
  Object.assign(debug.combat, {
    grenades: () => live.map((g) => ({ gid: g.gid, pos: g.pos.toArray().map((v) => +v.toFixed(2)), age: +g.age.toFixed(2), rest: g.rest, bounces: g.bounces })),
    spawnGrenade: (origin, vel, fuse = 2) => spawn({ gid: `dbg:${seq++}`, owner: state.selfId, origin, vel, fuse, t: state.match.time * 1000 }),
  });
}

function buildProto() {
  const src = assets.cloneModel(F.model.key);
  src.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
  return src;
}

function meshFromPool() {
  const m = pool.pop() || proto.clone(true);
  const pin = m.getObjectByName(F.model.pin);
  if (pin) pin.visible = false;     // the pin stays in the thrower's hand
  m.visible = true;
  scene.add(m);
  return m;
}

function buildPreview() {
  const P = TUNE.preview;
  const g = new THREE.SphereGeometry(0.035, 8, 6);
  const mat = new THREE.MeshBasicMaterial({ color: P.color, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false, fog: false, blending: THREE.AdditiveBlending });
  arcDots = new THREE.InstancedMesh(g, mat, P.dots);
  arcDots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  arcDots.frustumCulled = false;
  arcDots.renderOrder = 5;
  const colors = new Float32Array(P.dots * 3);
  arcDots.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
  arcDots.visible = false;
  scene.add(arcDots);
  const rg = new THREE.RingGeometry(0.42, 0.5, 40);
  rg.rotateX(-Math.PI / 2);
  const rm = new THREE.MeshBasicMaterial({ color: 0xe8b23a, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false });
  arcRing = new THREE.Mesh(rg, rm);
  arcRing.renderOrder = 5;
  const inner = new THREE.Mesh(new THREE.CircleGeometry(0.09, 20).rotateX(-Math.PI / 2), rm);
  arcRing.add(inner);
  arcRing.visible = false;
  scene.add(arcRing);
}

function clearAll() {
  for (const g of live) recycle(g);
  live.length = 0;
  setPreview(false, 0);
}

function recycle(g) {
  if (!g.mesh) return;
  g.mesh.removeFromParent();
  pool.push(g.mesh);
  g.mesh = null;
}

// ------------------------------------------------------------------------------------------ throwing
/** Hand position and throw velocity from the local player's current aim. */
function throwParams(outPos, outVel) {
  const me = localPlayer();
  camera.getAimRay(eyeV, dirV);
  rightV.crossVectors(dirV, UP);
  if (rightV.lengthSq() < 1e-6) rightV.set(1, 0, 0); else rightV.normalize();
  const H = TUNE.handOffset;
  outPos.copy(eyeV).addScaledVector(dirV, H.fwd).addScaledVector(rightV, H.right).addScaledVector(UP, H.up);
  // never start inside a wall next to the head
  vA.subVectors(outPos, eyeV);
  const len = vA.length();
  if (len > 1e-3) {
    vA.multiplyScalar(1 / len);
    const h = world.raycast(eyeV, vA, len + TUNE.radius);
    if (h) outPos.copy(eyeV).addScaledVector(vA, Math.max(0, h.distance - TUNE.radius * 2));
  }
  outVel.copy(dirV).multiplyScalar(F.throwSpeed);
  outVel.y += F.upBoost;
  if (me) { outVel.x += me.vel.x * TUNE.playerCarry; outVel.z += me.vel.z * TUNE.playerCarry; outVel.y += Math.max(0, me.vel.y) * 0.5; }
  return me;
}

/** Throw from the local eye along the aim with WEAPONS.frag.throwSpeed (+ upBoost, + player velocity); fuse - cookSeconds. */
export function throwLocal(cookSeconds) {
  const me = throwParams(vB, vC);
  if (!me) return null;
  const fuse = Math.max(0, F.fuse - Math.max(0, cookSeconds || 0));
  return spawn({ gid: `${state.selfId.slice(0, 6)}:${seq++}`, owner: state.selfId, origin: [vB.x, vB.y, vB.z], vel: fuse > 0 ? [vC.x, vC.y, vC.z] : [0, 0, 0], fuse, t: state.match.time * 1000 });
}

/** The local player was killed (or interrupted) while cooking: the live grenade falls at their feet. */
export function dropLocal(cookSeconds) {
  const me = localPlayer();
  if (!me) return null;
  const fuse = Math.max(0, F.fuse - Math.max(0, cookSeconds || 0));
  return spawn({ gid: `${state.selfId.slice(0, 6)}:${seq++}`, owner: state.selfId, origin: [me.pos.x, me.pos.y + 1.0, me.pos.z], vel: [me.vel.x * 0.5, 0.5, me.vel.z * 0.5], fuse, t: state.match.time * 1000 });
}

/**
 * Start simulating a grenade (local throw, bot throw on host, or NET_NADE).
 * @param {{gid:string, owner:string, origin:number[], vel:number[], fuse:number, t:number}} g  t = match time ms at throw
 */
export function spawn(g) { return spawnInternal(g, false); }

function spawnInternal(g, fromNet) {
  if (!inited) throw err('spawn before init');
  if (!g || !g.gid || !Array.isArray(g.origin) || !Array.isArray(g.vel)) throw err('spawn needs {gid, owner, origin, vel, fuse, t}');
  while (live.length >= TUNE.maxLive) { const old = live.shift(); explode(old); }
  const rec = {
    gid: g.gid, owner: g.owner, pos: new THREE.Vector3(...g.origin), vel: new THREE.Vector3(...g.vel), fuse: Math.max(0, g.fuse),
    age: 0, rest: false, bounces: 0, mesh: meshFromPool(), spin: new THREE.Vector3(Math.random() * 14 - 7, Math.random() * 10 - 5, Math.random() * 14 - 7),
    lastBounceAge: -1, inWater: false, t: g.t,
  };
  rec.mesh.position.copy(rec.pos);
  live.push(rec);
  const local = g.owner === state.selfId;
  emit(EV.GRENADE_THROW, { gid: g.gid, owner: g.owner, origin: g.origin, vel: g.vel, local });
  if (!fromNet && state.online && (local || (isBotId(g.owner) && state.isHost))) {
    session.send('nade', { gid: g.gid, by: g.owner, o: g.origin.map((v) => Math.round(v * 1000) / 1000), v: g.vel.map((v) => Math.round(v * 1000) / 1000), fuse: Math.round(g.fuse * 1000) / 1000, t: Math.round(g.t) });
  }
  // Late receivers fast-forward to now.
  if (fromNet) {
    const behind = (state.match.time * 1000 - g.t) / 1000;
    if (behind > 0) advance(rec, Math.min(behind, rec.fuse + TUNE.step), true);
  }
  return rec.gid;
}

// ------------------------------------------------------------------------------------------ simulation
/** One fixed step of grenade physics on {pos, vel}; returns impact info or null. Shared with the arc preview. */
const stepDir = new THREE.Vector3();
function physStep(pos, vel, h, state_) {
  if (state_.inWater) {
    vel.multiplyScalar(Math.exp(-TUNE.waterDrag * h));
    vel.y -= F.gravity * 0.15 * h;
    const floorY = world.getHeight(pos.x, pos.z) + TUNE.radius;
    pos.addScaledVector(vel, h);
    if (pos.y < floorY) { pos.y = floorY; vel.set(0, 0, 0); state_.rest = true; }
    return null;
  }
  vel.y -= F.gravity * h;
  const sp = vel.length();
  if (sp < 1e-6) return null;
  const travel = sp * h;
  stepDir.copy(vel).multiplyScalar(1 / sp);
  const hit = world.raycast(pos, stepDir, travel + TUNE.radius);
  if (!hit) { pos.addScaledVector(vel, h); return null; }
  pos.copy(hit.point).addScaledVector(hit.normal, TUNE.radius + 0.002);
  if (hit.kind === 'water' || hit.surface === SURFACE.WATER) {
    state_.inWater = true;
    vel.multiplyScalar(0.25);
    return { speed: sp, normal: hit.normal, point: hit.point, surface: SURFACE.WATER };
  }
  const n = hit.normal;
  const vn = vel.dot(n);
  if (vn < 0) {
    vN.copy(n).multiplyScalar(vn);
    vel.sub(vN);                                   // tangential part
    vel.multiplyScalar(1 - F.friction * clamp(-vn / 12, 0.15, 0.8));
    vel.addScaledVector(n, -vn * F.restitution);
  }
  // settle on walkable ground
  if (n.y > 0.7 && Math.abs(vel.dot(n)) < 1.2) {
    const along = vel.length();
    vel.addScaledVector(n, -vel.dot(n));
    if (along < TUNE.restSpeed) { vel.set(0, 0, 0); state_.rest = true; }
  }
  return { speed: Math.abs(vn), normal: n, point: hit.point, surface: hit.surface };
}

function advance(g, seconds, silent) {
  const target = g.age + seconds;
  while (g.age + TUNE.step <= target + 1e-9) {
    g.age += TUNE.step;
    if (g.age >= g.fuse) { explode(g); return; }
    if (g.rest) continue;                          // at rest until the fuse runs out
    const hit = physStep(g.pos, g.vel, TUNE.step, g);
    if (!g.rest && !g.inWater && hit === null) {
      // rolling friction when moving along the ground
      const gy = world.getGround(g.pos.x, g.pos.z, g.pos.y + 0.05).y;
      if (g.pos.y - gy < TUNE.radius + 0.02 && Math.abs(g.vel.y) < 0.6) {
        g.vel.multiplyScalar(Math.exp(-TUNE.rollFriction * TUNE.step));
        if (g.vel.lengthSq() < TUNE.restSpeed * TUNE.restSpeed * 0.25) { g.vel.set(0, 0, 0); g.rest = true; }
      }
    }
    if (hit) {
      g.spin.multiplyScalar(0.6);
      if (hit.speed > TUNE.bounceEvent && g.age - g.lastBounceAge > 0.08) {
        g.bounces++;
        g.lastBounceAge = g.age;
        if (!silent) emit(EV.GRENADE_BOUNCE, { gid: g.gid, pos: [g.pos.x, g.pos.y, g.pos.z], speed: hit.speed, surface: hit.surface });
      }
    }
  }
}

function explode(g) {
  const i = live.indexOf(g);
  if (i >= 0) live.splice(i, 1);
  if (g.exploded) return;
  g.exploded = true;
  const pos = [g.pos.x, g.pos.y, g.pos.z];
  recycle(g);
  emit(EV.GRENADE_EXPLODE, { gid: g.gid, owner: g.owner, pos, water: g.inWater });
  damage.explosionAt(pos, g.owner, 'frag');
  const me = localPlayer();
  if (me && me.alive && me.life !== LIFE.PLANE) {
    const d = me.pos.distanceTo(g.pos);
    const k = clamp(1 - d / F.shakeRadius, 0, 1);
    if (k > 0) camera.addShake(0.25 + 0.75 * k * k, 0.5 + 0.6 * k);
  }
}

export function update(dt) {
  for (let i = live.length - 1; i >= 0; i--) {
    const g = live[i];
    if (!g) continue;
    advance(g, dt, false);
    if (g.mesh) {
      g.mesh.position.copy(g.pos);
      if (!g.rest) {
        g.mesh.rotation.x += g.spin.x * dt;
        g.mesh.rotation.y += g.spin.y * dt;
        g.mesh.rotation.z += g.spin.z * dt;
      }
    }
  }
  if (previewOn) updatePreview();
}

/** Number of live grenades. */
export function count() { return live.length; }

// ------------------------------------------------------------------------------------------ arc preview
const prPos = new THREE.Vector3(), prVel = new THREE.Vector3();
const prState = { inWater: false, rest: false };
const arcPts = [];
for (let i = 0; i < TUNE.preview.dots; i++) arcPts.push(new THREE.Vector3());
let arcCount = 0;
const landPos = new THREE.Vector3(), landN = new THREE.Vector3();
let landValid = false;

/** Predicted path from the current aim: {points: Vector3[], count, land: Vector3|null} (no allocation). */
export function predictArc() {
  const P = TUNE.preview;
  if (!throwParams(prPos, prVel)) { arcCount = 0; landValid = false; return { points: arcPts, count: 0, land: null }; }
  prState.inWater = false; prState.rest = false;
  arcCount = 0; landValid = false;
  const fuseLeft = Math.max(0.2, F.fuse - previewCook);
  const tMax = Math.min(P.maxTime, fuseLeft);
  const every = Math.max(1, Math.round(tMax / P.step / P.dots));
  let t = 0, k = 0;
  while (t < tMax && arcCount < P.dots) {
    const hit = physStep(prPos, prVel, P.step, prState);
    t += P.step;
    if (hit) { landPos.copy(hit.point); landN.copy(hit.normal); landValid = true; break; }
    if (k++ % every === 0) arcPts[arcCount++].copy(prPos);
  }
  return { points: arcPts, count: arcCount, land: landValid ? landPos : null };
}

/** Show or hide the cooking arc (weapons calls this every frame). */
export function setPreview(on, cook = 0) {
  previewOn = !!on;
  previewCook = cook;
  if (!arcDots) return;
  if (!previewOn) { arcDots.visible = false; arcRing.visible = false; }
}

const colTmp = new THREE.Color();
function updatePreview() {
  const me = localPlayer();
  if (!me || !me.alive || state.local.mode === 'spectate') { arcDots.visible = false; arcRing.visible = false; return; }
  predictArc();
  const n = arcCount;
  for (let i = 0; i < TUNE.preview.dots; i++) {
    if (i < n) {
      dummy.position.copy(arcPts[i]);
      const s = 1 - 0.45 * (i / Math.max(1, n));
      dummy.scale.setScalar(s);
      // fade near the hand so the first dots do not fill the screen
      const f = clamp((i - 1) / 4, 0, 1) * (1 - 0.35 * i / Math.max(1, n));
      colTmp.setRGB(f, f * 0.97, f * 0.9);
    } else { dummy.position.set(0, -1e4, 0); dummy.scale.setScalar(0.0001); colTmp.setRGB(0, 0, 0); }
    dummy.updateMatrix();
    arcDots.setMatrixAt(i, dummy.matrix);
    arcDots.setColorAt(i, colTmp);
  }
  arcDots.count = TUNE.preview.dots;
  arcDots.instanceMatrix.needsUpdate = true;
  arcDots.instanceColor.needsUpdate = true;
  arcDots.visible = n > 1;
  if (landValid) {
    arcRing.visible = true;
    arcRing.position.copy(landPos).addScaledVector(landN, 0.03);
    arcRing.quaternion.setFromUnitVectors(UP, landN);
    const pulse = 1 + 0.08 * Math.sin(performance.now() * 0.008);
    arcRing.scale.setScalar(pulse);
  } else arcRing.visible = false;
}
