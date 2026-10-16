// ZONEFALL - bot players, simulated on the host only. OWNER: GAME. Contract: ARCHITECTURE.md 5.6 and 8.5, tuning in config.BOTS.
// Each bot is a normal entity (kind 'bot', id botId(slot), owner = host) drawn by player/avatar and synced by net/sync,
// so everyone sees the same soldiers, animations, shots and deaths as for humans.
// Behaviour (think at BOTS.thinkHz, staggered; move every frame in <= 1/30 s sub-steps):
//   plane  -> jumps when the plane passes closest to its seeded landing spot (open ground in a site, never a roof)
//   air    -> freefall glide toward it, chute at a personal height, steer, land (PLAYER_CHUTE / PLAYER_LAND)
//   loot   -> walk to useful items and crates (loot.nearest, loot.pickup(uid, botId)), via doorways when the item is
//             indoors, for BOTS.lootTime seconds or until kitted out
//   roam   -> points inside the next safe circle, opportunistic looting, investigates gunfire it hears
//   zone   -> sprint back inside when outside (or about to be outside) the circle
//   engage -> reaction delay, aim error that settles while the target stays in sight (worse with distance, own
//             movement and target speed, scaled by a per-bot skill), bursts, ADS at range, strafing, crouching,
//             reloads, grenades at targets that broke line of sight
//   cover  -> low health under fire: run to a nav cover point the threat cannot see, crouch, insert plates
// Movement: world.getGround + world.collideCapsule with the player speeds and step height, feeler rays for
// obstacles, stuck detection. Firing: ballistics.fire(botId, weapon, eye, dir, {spreadDeg}) so damage, vfx, sound
// and the SHOT broadcast are the production path. HP: combat/damage (applyToEntity, kill, regen, addArmor).
import * as THREE from 'three';
import { BOTS, PLAYER, WEAPONS, AMMO, DEV } from '../config.js';
import { on, emit, EV } from '../core/bus.js';
import { state, debug, getPlayer, LIFE, FLAG, setFlag, hasFlag } from '../core/state.js';
import { stream } from '../core/rng.js';
import { clamp, damp, dampAngle, angleDelta, DEG } from '../core/util.js';
import { POIS, LANDMARKS, siteAt } from '../core/mapdata.js';
import * as world from '../world/world.js';
import * as ballistics from '../combat/ballistics.js';
import * as damage from '../combat/damage.js';
import * as grenades from '../combat/grenades.js';
import * as loot from './loot.js';
import * as match from './match.js';

const TUNE = {
  substep: 1 / 30,
  accel: 30,
  turnRate: 7.5,               // yaw damping toward the desired facing (1/s)
  aimTurnRate: 14,
  height: PLAYER.height, crouchHeight: PLAYER.crouchHeight, radius: PLAYER.radius,
  eye: PLAYER.eyeHeight, crouchEye: PLAYER.crouchEyeHeight,
  pickupRange: 1.25,           // m horizontal to take an item
  pickupDelay: [0.35, 0.7],    // s spent "bending down"
  lootSearch: 38,              // m radius for loot targets
  roamLootSearch: 22,
  maxItemDy: 1.4,              // ignore items on other floors unless in direct sight
  stuckWindow: 1.1,            // s
  stuckDist: 0.35,             // m
  feeler: 1.5,
  deployAGL: [75, 140],
  chuteForward: 12.5,
  ffGlide: 26, ffFall: 32, ffDive: 46,
  landPick: 10,                // landing candidates tried per bot
  engageMemory: 5.5,           // s a lost target is remembered
  coverSearch: 20,
  coverHp: 45,
  plateBelow: 100,             // insert plates while armor is below this and nothing is visible
  grenadeRange: [9, 27],
  grenadeCooldown: [9, 16],
  hearingSniper: 1.8,          // hearing multiplier for sniper shots
  chuteTargetsWithin: 70,      // bots only shoot parachuting players this close
  fallbackPistolEvery: 12,     // s: a bot with no ammo at all scavenges a pistol magazine
  skill: [0.3, 0.85],
  aimMult: 1.8,               // scales config aim error (bots trading shots at 20 m should still miss)
  settleIn: 14,                // s after landing: only react to close or attacking enemies while looting
  pistolSight: 26,             // m: pistol-only bots ignore farther enemies unless attacked
  maxFloorAbove: 1.25,         // m above the terrain: bots keep to ground floors (no stair navigation)
  terrainStep: 0.85,           // m: step-up allowed on bare terrain (heightfield creases)
  maxDrop: 2.2,                // m: drops deeper than this count as walls
  pickupMags: 2,               // reserve magazines a bot finds with a picked-up weapon (the ammo lying beside it)
  noProgress: 7,               // s without getting 1 m closer to the goal before it is given up
  viewMult: 0.8,               // x BOTS.viewDistance
};

const RANK = { m1911: 1, m700: 2.6, mp5: 3, ak47: 4, m4a1: 4.2 };
const WALLED = POIS.filter((p) => p.wall && Array.isArray(p.wall.gates));
const COS_SLOPE = Math.cos(PLAYER.maxSlopeDeg * Math.PI / 180);
const MAX_RISE = Math.tan(PLAYER.maxSlopeDeg * Math.PI / 180);
const brains = new Map();
let matchSeed = 0;
let coverGrid = null, doorGrid = null;
let nadeSeq = 0;

const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), eyeV = new THREE.Vector3();
const capA = new THREE.Vector3(), capB = new THREE.Vector3(), rayO = new THREE.Vector3(), rayD = new THREE.Vector3();
const planeP = new THREE.Vector3(), planeP2 = new THREE.Vector3();

const authority = () => state.isHost || !state.online;
const now = () => state.match.time;

// ------------------------------------------------------------------------------------------ spatial helpers
function buildGrids() {
  let nav = null;
  try { nav = world.getNavHints(); } catch (e) { nav = { doors: [], covers: [], sites: [] }; }
  const grid = (list, get) => {
    const g = new Map();
    for (const it of list) {
      const p = get(it);
      const k = `${Math.floor(p[0] / 24)},${Math.floor(p[2] / 24)}`;
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(it);
    }
    return g;
  };
  coverGrid = grid(nav.covers || [], (c) => c);
  doorGrid = grid(nav.doors || [], (d) => d.pos);
}

function near(grid, x, z, r, get) {
  const out = [];
  if (!grid) return out;
  const c0 = Math.floor((x - r) / 24), c1 = Math.floor((x + r) / 24), r0 = Math.floor((z - r) / 24), r1 = Math.floor((z + r) / 24);
  for (let i = c0; i <= c1; i++) for (let j = r0; j <= r1; j++) {
    const list = grid.get(`${i},${j}`);
    if (!list) continue;
    for (const it of list) {
      const p = get(it);
      const d = Math.hypot(p[0] - x, p[2] - z);
      if (d <= r) out.push({ it, d });
    }
  }
  out.sort((a, b) => a.d - b.d);
  return out;
}

function groundAt(x, z, fromY) {
  try { const g = world.getGround(x, z, fromY); if (g && Number.isFinite(g.y)) return g; } catch (e) { /* fallthrough */ }
  return { y: 0, normal: [0, 1, 0], surface: 0 };
}
function heightAt(x, z) { try { return world.getHeight(x, z); } catch (e) { return 0; } }
function los(a, b) { try { return world.lineOfSight(a, b); } catch (e) { return true; } }

/** Inside a pit carved below its site (the quarry): a navigation trap for bots. */
function inPit(x, z) {
  const site = siteAt(x, z);
  return !!(site && site.pitRadius && Math.hypot(x - site.x, z - site.z) < site.pitRadius + 6);
}

/** Open ground in a site (highest surface is the terrain, on land, not steep, not in a pit). */
function pickLandingSpot(rng, site) {
  let best = null;
  for (let i = 0; i < TUNE.landPick; i++) {
    const [x, z] = rng.inDisc(site.x, site.z, site.r * 0.62);
    const th = heightAt(x, z);
    if (th < 1.5 || inPit(x, z)) continue;
    const top = groundAt(x, z, th + 60).y;
    if (top - th > 0.35) continue;           // a roof or a prop
    best = { x, z };
    break;
  }
  return best || { x: site.x + rng.range(-8, 8), z: site.z + rng.range(-8, 8) };
}

// ------------------------------------------------------------------------------------------ brain
function newBrain(e, seed) {
  const rng = stream(seed, 'bot:' + e.slot);
  const sites = [...POIS.map((p) => [p, p.lootPoints]), ...LANDMARKS.map((p) => [p, p.lootPoints * 1.4])];
  const site = rng.weighted(sites);
  const b = {
    id: e.id, e, slot: e.slot, rng,
    skill: rng.range(TUNE.skill[0], TUNE.skill[1]),
    mode: 'plane',
    site, land: pickLandingSpot(rng, site),
    jumpAt: 0, deployAGL: rng.range(TUNE.deployAGL[0], TUNE.deployAGL[1]),
    inv: { primary: null, pistol: { weapon: 'm1911', mag: WEAPONS.m1911.mag }, active: 'pistol', ammo: { ar: 0, light: 24, sniper: 0 }, plates: 1, frags: 0 },
    lootUntil: 0, lootGoal: null, blacklist: new Set(), pickT: -1,
    goal: null, path: [], pathI: 0, goalKind: null, waitUntil: 0,
    target: null, targetVisible: false, aimTime: 0, reactUntil: 0, lastSeen: null, lastSeenAt: -99, visibleSince: 0,
    burstLeft: 0, nextShotAt: 0, ads: false, threat: null, heard: null,
    strafe: 1, strafeUntil: 0, crouchUntil: 0, crouch: false, sprint: false,
    reloadT: 0, reloadDur: 0, plateT: 0, throwT: 0, nadeReadyAt: 0, firingT: 0,
    stuckRef: new THREE.Vector3(), stuckClock: 0, stuckCount: 0, avoidSide: 0, avoidUntil: 0,
    steer: new THREE.Vector3(), wantSpeed: 0, faceYaw: e.yaw, facePitch: 0, trail: [], trips: 0,
    grounded: false, groundedAt: -1, noPrimarySince: -1, scavengeAt: 0, thinkAcc: rng.range(0, 1 / BOTS.thinkHz),
    vel: e.vel,
  };
  return b;
}

function jumpTime(b) {
  const p = match.planePath();
  // time when the plane is closest to the landing spot
  const rx = b.land.x - p.a[0], rz = b.land.z - p.a[2];
  const u = rx * p.dir[0] + rz * p.dir[2];
  let t = u / p.speed + b.rng.range(-1.6, 1.2);
  return clamp(t, p.doorsOpenAt + 0.4 + b.rng.range(0, 1.2), p.forceJumpAt - 0.4);
}

function weaponOf(b) { return b.inv.active === 'primary' && b.inv.primary ? b.inv.primary : b.inv.pistol; }
function syncWeapon(b) { const s = weaponOf(b); b.e.weapon = s ? s.weapon : null; }

// ------------------------------------------------------------------------------------------ setup / API
/** Create bot state for the roster's bots (entities already exist). @param {Array<{id:string, name:string, slot:number}>} roster */
export function setup(roster, seed) {
  brains.clear();
  matchSeed = seed >>> 0;
  nadeSeq = 0;
  if (!roster || !roster.length) return;
  buildGrids();
  for (const r of roster) {
    const e = getPlayer(r.id);
    if (!e) continue;
    const b = newBrain(e, matchSeed);
    brains.set(e.id, b);
    e.armor = 0;
    syncWeapon(b);
    if (DEV.skipPlane) placeOnGround(b, b.land.x, b.land.z);
    else { b.jumpAt = jumpTime(b); e.life = LIFE.PLANE; }
  }
}

function placeOnGround(b, x, z) {
  const e = b.e;
  const g = groundAt(x, z, heightAt(x, z) + 1.5);
  e.pos.set(x, g.y, z);
  e.vel.set(0, 0, 0);
  e.life = LIFE.GROUND;
  b.mode = 'loot';
  b.grounded = true;
  b.groundedAt = now();
  b.lootUntil = now() + b.rng.range(BOTS.lootTime[0], BOTS.lootTime[1]);
  b.noPrimarySince = now();
}

/** Ids of all bots in the match. */
export function list() { return [...brains.keys()]; }

/**
 * Put a living bot on the ground at (x, z), facing yaw, in roam mode with no target (host only; test hooks and the
 * integration suite use it to bring a fight to the player). Returns false when the bot is unknown, dead, or this peer
 * is not the bot authority. INTEGRATION addition.
 */
export function placeNear(botId, x, z, yaw = 0) {
  if (!authority()) return false;
  const b = brains.get(botId);
  if (!b || !b.e || !b.e.alive || b.e.life === LIFE.DEAD) return false;
  clearActions(b);
  placeOnGround(b, x, z);
  b.mode = 'roam';
  b.lootUntil = now();
  b.goal = null; b.path = []; b.pathI = 0; b.target = null; b.targetVisible = false; b.threat = null; b.heard = null;
  b.stuckRef.copy(b.e.pos); b.stuckClock = 0;
  b.e.yaw = yaw; b.faceYaw = yaw;
  return true;
}

/** Host: apply damage to a bot (combat/damage.applyToEntity); on death combat/damage.kill. */
export function applyDamage(botId, amount, info = {}) {
  const e = getPlayer(botId);
  if (!e || !e.alive) return null;
  const res = damage.applyToEntity(e, amount, info);
  const b = brains.get(botId);
  if (b && info.from && info.from !== botId && info.kind !== 'zone') {
    const a = getPlayer(info.from);
    if (a && a.alive) {
      b.threat = { id: a.id, at: now(), pos: a.pos.clone() };
      if (!b.target || !b.targetVisible) {
        if (b.target !== a.id) { b.target = a.id; b.aimTime = 0; }
        b.reactUntil = Math.min(b.reactUntil > now() ? b.reactUntil : Infinity, now() + reaction(b) * 0.6);
        b.lastSeen = a.pos.clone();
        b.lastSeenAt = now();
      }
    }
  }
  if (res.killed) {
    const zoneOrFall = info.kind === 'zone' || info.kind === 'fall';
    const weapon = info.kind === 'zone' ? 'zone' : info.kind === 'fall' ? 'fall' : (info.weapon || 'frag');
    damage.kill(botId, zoneOrFall ? null : (info.from ?? null), weapon, info.zone === 'head', info.sid ?? null);
    if (b) clearActions(b);
  }
  return res;
}

/** Became host mid-match: rebuild AI state from the current entities (positions/hp come from the last snapshots). */
export function takeOver() {
  if (!matchSeed) matchSeed = state.match.seed >>> 0;
  if (!coverGrid) buildGrids();
  for (const e of state.players.values()) {
    if (e.kind !== 'bot') continue;
    e.owner = state.selfId;
    let b = brains.get(e.id);
    if (!b) { b = newBrain(e, matchSeed); brains.set(e.id, b); }
    b.e = e;
    b.vel = e.vel;
    const w = e.weapon && WEAPONS[e.weapon] && WEAPONS[e.weapon].class !== 'lethal' ? e.weapon : 'm1911';
    if (w !== 'm1911') {
      b.inv.primary = { weapon: w, mag: WEAPONS[w].mag };
      b.inv.active = 'primary';
      b.inv.ammo[WEAPONS[w].ammo] = Math.max(b.inv.ammo[WEAPONS[w].ammo], WEAPONS[w].mag * 2);
    }
    b.inv.plates = Math.max(b.inv.plates, 1);
    if (!e.alive || e.life === LIFE.DEAD) { b.mode = 'dead'; continue; }
    if (e.life === LIFE.PLANE) { b.mode = 'plane'; b.jumpAt = Math.max(now() + 0.5, jumpTime(b)); }
    else if (e.life === LIFE.FREEFALL || e.life === LIFE.CHUTE) { b.mode = 'air'; b.land = pickLandingSpot(b.rng, nearestSite(e.pos.x, e.pos.z)); }
    else { b.mode = 'roam'; b.grounded = true; b.groundedAt = now(); b.goal = null; }
    syncWeapon(b);
  }
  for (const id of [...brains.keys()]) if (!getPlayer(id)) brains.delete(id);
}

function nearestSite(x, z) {
  let best = POIS[0], bd = Infinity;
  for (const s of [...POIS, ...LANDMARKS]) { const d = Math.hypot(s.x - x, s.z - z); if (d < bd) { bd = d; best = s; } }
  return best;
}

function reaction(b) {
  const [lo, hi] = BOTS.reaction;
  return hi - (hi - lo) * b.skill + b.rng.range(-0.06, 0.12);
}

function clearActions(b) {
  b.reloadT = 0; b.plateT = 0; b.throwT = 0; b.firingT = 0; b.mantle = null;
  const e = b.e;
  e.flags &= ~(FLAG.FIRING | FLAG.RELOAD | FLAG.PLATE | FLAG.THROW | FLAG.ADS | FLAG.SPRINT | FLAG.MANTLE);
}

// ------------------------------------------------------------------------------------------ update
export function update(dt) {
  if (!authority() || state.match.phase === 'idle' || !brains.size || !(dt > 0)) return;
  const thinkDt = 1 / BOTS.thinkHz;
  for (const b of brains.values()) {
    const e = b.e;
    if (!e || !e.alive || e.life === LIFE.DEAD) { if (b.mode !== 'dead') { b.mode = 'dead'; clearActions(b); } continue; }
    if (state.match.phase === 'ended') { e.vel.set(0, 0, 0); e.speed = 0; clearActions(b); continue; }
    b.thinkAcc += dt;
    // each bot starts at a random phase of the think period, so thinks spread over frames
    const due = b.thinkAcc >= thinkDt;
    switch (e.life) {
      case LIFE.PLANE: updatePlane(b); break;
      case LIFE.FREEFALL: case LIFE.CHUTE: updateAir(b, dt); break;
      case LIFE.GROUND:
        if (due) { b.thinkAcc = Math.min(b.thinkAcc - thinkDt, thinkDt * 0.5); think(b); }
        act(b, dt);
        damage.regen(e, dt);
        break;
      default: break;
    }
  }
}

// ------------------------------------------------------------------------------------------ plane and air
function updatePlane(b) {
  const e = b.e;
  const t = now();
  match.planePosAt(t, planeP);
  e.pos.set(planeP.x, planeP.y - 2.4, planeP.z);
  const p = match.planePath();
  e.vel.set(p.dir[0] * p.speed, 0, p.dir[2] * p.speed);
  e.yaw = Math.atan2(-p.dir[0], -p.dir[2]);
  if (t >= p.forceJumpAt || (t >= b.jumpAt && t >= p.doorsOpenAt)) eject(b, Math.min(t, p.forceJumpAt));
}

/** Leave the plane through the rear ramp at match time t (same exit point and carry as the local controller). */
function eject(b, t) {
  const e = b.e;
  const p = match.planePath();
  match.planePosAt(t, planeP);
  e.pos.set(planeP.x - p.dir[0] * 13, planeP.y - 3.2, planeP.z - p.dir[2] * 13);
  e.vel.set(p.dir[0] * p.speed * 0.42, -3, p.dir[2] * p.speed * 0.42);
  e.life = LIFE.FREEFALL;
  b.mode = 'air';
}

/** Eject every bot still aboard at the current match time (harness clock skips). GAME addition. */
export function forceJump() {
  if (!authority()) return 0;
  let n = 0;
  for (const b of brains.values()) if (b.e && b.e.alive && b.e.life === LIFE.PLANE) { eject(b, now()); n++; }
  return n;
}

function updateAir(b, dt) {
  const e = b.e;
  const g = groundAt(e.pos.x, e.pos.z, e.pos.y + 0.5);
  const water = heightAt(e.pos.x, e.pos.z) < 0 ? 0 : -Infinity;
  const floor = Math.max(g.y, water);
  const agl = e.pos.y - floor;
  const dx = b.land.x - e.pos.x, dz = b.land.z - e.pos.z;
  const dist = Math.hypot(dx, dz) || 1;
  const ux = dx / dist, uz = dz / dist;
  if (e.life === LIFE.FREEFALL) {
    // glide when the spot is far relative to the height left, dive when it is below us
    const reach = (agl - b.deployAGL) / TUNE.ffFall * TUNE.ffGlide;
    const glide = dist > reach * 0.45;
    const hs = glide ? Math.min(TUNE.ffGlide, dist / 3) : Math.min(8, dist / 3);
    e.vel.x = damp(e.vel.x, ux * hs, 1.4, dt);
    e.vel.z = damp(e.vel.z, uz * hs, 1.4, dt);
    e.vel.y = damp(e.vel.y, glide ? -TUNE.ffFall : -TUNE.ffDive, 1.2, dt);
    if (agl <= b.deployAGL || agl < PLAYER.freefall.autoDeployAGL) {
      e.life = LIFE.CHUTE;
      emit(EV.PLAYER_CHUTE, { id: e.id, open: true });
    }
  } else {
    const fwd = Math.min(TUNE.chuteForward, dist / 2.2);
    e.vel.x = damp(e.vel.x, ux * fwd, 1.1, dt);
    e.vel.z = damp(e.vel.z, uz * fwd, 1.1, dt);
    e.vel.y = damp(e.vel.y, dist < 15 ? -PLAYER.chute.brakeFallSpeed : -PLAYER.chute.fallSpeed, 2.5, dt);
  }
  const sp = Math.hypot(e.vel.x, e.vel.z);
  if (sp > 0.5) e.yaw = dampAngle(e.yaw, Math.atan2(-e.vel.x, -e.vel.z), 3, dt);
  e.pitch = 0;
  e.speed = sp;
  e.pos.addScaledVector(e.vel, dt);
  // walls while gliding in low
  const res = capsule(e.pos, TUNE.height);
  if (res && res.hit) { e.pos.x += res.push.x; e.pos.z += res.push.z; }
  const g2 = groundAt(e.pos.x, e.pos.z, e.pos.y + 1.0);
  if (e.pos.y <= g2.y + 0.02) {
    const fall = -e.vel.y;
    e.pos.y = g2.y;
    e.vel.set(0, 0, 0);
    if (e.life === LIFE.CHUTE) emit(EV.PLAYER_CHUTE, { id: e.id, open: false });
    e.life = LIFE.GROUND;
    b.grounded = true;
    b.groundedAt = now();
    b.mode = 'loot';
    b.lootUntil = now() + b.rng.range(BOTS.lootTime[0], BOTS.lootTime[1]);
    b.noPrimarySince = now();
    emit(EV.PLAYER_LAND, { id: e.id, pos: [e.pos.x, e.pos.y, e.pos.z], speed: fall, fall: 0 });
  }
}

function capsule(pos, height) {
  capA.set(pos.x, pos.y + TUNE.radius + 0.42, pos.z);
  capB.set(pos.x, pos.y + Math.max(TUNE.radius + 0.42, height - TUNE.radius), pos.z);
  try { return world.collideCapsule(capA, capB, TUNE.radius); } catch (e) { return null; }
}

// ------------------------------------------------------------------------------------------ think (10 Hz)
function eyeOf(e, out, crouch) {
  return out.set(e.pos.x, e.pos.y + (crouch || hasFlag(e, FLAG.CROUCH) ? TUNE.crouchEye : TUNE.eye), e.pos.z);
}
function chestOf(e, out) {
  const k = hasFlag(e, FLAG.CROUCH) ? 0.68 : 1;
  if (e.life === LIFE.CHUTE || e.life === LIFE.FREEFALL) return out.set(e.pos.x, e.pos.y + 0.9, e.pos.z);
  return out.set(e.pos.x, e.pos.y + 1.15 * k, e.pos.z);
}

function think(b) {
  const e = b.e;
  const t = now();
  perceive(b, t);
  // ---- mode selection
  const zs = state.zone;
  const danger = zoneDanger(b, zs);
  const tgt = b.target ? getPlayer(b.target) : null;
  const hasTarget = tgt && tgt.alive && (b.targetVisible || t - b.lastSeenAt < TUNE.engageMemory);
  const hurt = e.hp < TUNE.coverHp && b.threat && t - b.threat.at < 4;
  let mode;
  if (danger > 1.5 && !(hasTarget && b.targetVisible && distTo(e, tgt) < 25)) mode = 'zone';
  else if (hurt && b.mode !== 'engage-push' && b.skill > 0.35 && (b.mode === 'cover' || b.rng.chance(0.75))) mode = 'cover';
  else if (hasTarget) mode = 'engage';
  else if (danger > 0.5) mode = 'zone';
  else if (t < b.lootUntil || needsKit(b) || lowAmmo(b)) mode = 'loot';
  else mode = 'roam';
  if (mode !== b.mode) {
    b.mode = mode;
    b.lootGoal = null;
    b.waitUntil = 0;
    if (b.goalKind !== 'retreat') { b.goal = null; b.path = []; }
  }

  // ---- fallback kit
  if (!b.inv.primary && b.noPrimarySince >= 0 && t - b.noPrimarySince > BOTS.fallbackWeaponAfter) {
    const w = b.rng.chance(0.5) ? 'ak47' : 'mp5';
    b.inv.primary = { weapon: w, mag: WEAPONS[w].mag };
    b.inv.ammo[WEAPONS[w].ammo] += WEAPONS[w].mag * 2;
    b.inv.active = 'primary';
    syncWeapon(b);
  }
  if (b.inv.primary && b.inv.active !== 'primary' && b.reloadT <= 0 && (b.inv.primary.mag > 0 || b.inv.ammo[WEAPONS[b.inv.primary.weapon].ammo] > 0)) {
    b.inv.active = 'primary';
    syncWeapon(b);
  }

  progressWatch(b, t);
  if (b.goalKind === 'retreat' && b.goal && t < b.retreatUntil && !(b.mode === 'engage' && b.targetVisible)) {
    const left = Math.hypot(b.goal.x - e.pos.x, b.goal.z - e.pos.z);
    if (left > 1.2) { b.wantSpeed = PLAYER.walkSpeed; b.sprint = false; b.crouch = false; steer(b); return; }
    b.goal = null; b.goalKind = null; b.path = [];
  }
  switch (b.mode) {
    case 'zone': thinkZone(b, zs); break;
    case 'cover': thinkCover(b, t); break;
    case 'engage': thinkEngage(b, t, tgt); break;
    case 'loot': thinkLoot(b, t, TUNE.lootSearch); break;
    default: thinkRoam(b, t, zs); break;
  }
  // plates whenever it is quiet
  if (b.plateT <= 0 && b.reloadT <= 0 && b.throwT <= 0 && b.inv.plates > 0 && e.armor < TUNE.plateBelow && !b.targetVisible && b.mode !== 'engage') {
    b.plateT = PLAYER.armor.insertTime;
    setFlag(e, FLAG.PLATE, true);
    emit(EV.PLATE_START, { id: e.id });
  }
  steer(b);
}

/** No real progress toward the goal for TUNE.noProgress seconds: give it up and approach from another side. */
function progressWatch(b, t) {
  const e = b.e;
  if (!b.goal || b.mode === 'engage' || b.wantSpeed <= 0.1) { b.progBest = Infinity; b.progSince = t; return; }
  const d = Math.hypot(b.goal.x - e.pos.x, b.goal.z - e.pos.z);
  if (d < (b.progBest ?? Infinity) - 1) { b.progBest = d; b.progSince = t; b.trips = 0; return; }
  if (t - (b.progSince ?? t) < TUNE.noProgress) return;
  if (b.lootGoal) b.blacklist.add(b.lootGoal);
  b.lootGoal = null;
  b.trips = (b.trips || 0) + 1;
  if (b.trips >= 2 && b.trail.length > 2) {
    // walk back the way we came (known walkable), then plan again from there
    const back = b.trail.slice(-10).reverse().map((p) => p.clone());
    b.goal = back[back.length - 1];
    b.goalKind = 'retreat';
    b.retreatUntil = t + 14;
    b.path = back;
    b.pathI = 0;
    b.trail.length = Math.max(0, b.trail.length - 10);
    b.trips = 0;
  } else {
    b.goal = null;
    b.path = [];
  }
  b.approach = (b.approach || 0) + 1.3 + b.rng.range(0, 1);
  b.progBest = Infinity;
  b.progSince = t;
}

function distTo(e, o) { return Math.hypot(o.pos.x - e.pos.x, o.pos.z - e.pos.z); }

/** Less than one magazine left for the primary (mag + reserve). */
function lowAmmo(b) {
  const p = b.inv.primary;
  if (!p) return false;
  const W = WEAPONS[p.weapon];
  return p.mag + b.inv.ammo[W.ammo] < W.mag;
}

function needsKit(b) { return !b.inv.primary && now() - b.groundedAt < 150; }

function zoneDanger(b, zs) {
  if (!zs || zs.state === 'pre') return 0;
  const e = b.e;
  const dCur = Math.hypot(e.pos.x - zs.x, e.pos.z - zs.z);
  if (dCur > zs.r - 4) return 2;                       // outside or on the wall
  if (zs.state === 'final') return 2;
  const dNext = Math.hypot(e.pos.x - zs.nx, e.pos.z - zs.nz) - zs.nr;
  if (dNext <= 0) return 0;
  const run = dNext / PLAYER.sprintSpeed;
  const left = zs.state === 'waiting' ? zs.timeLeft + (zs.state === 'waiting' ? 20 : 0) : zs.timeLeft;
  if (run > left - 8) return 2;
  if (run > left * 0.5) return 1;
  return 0.6;
}

function perceive(b, t) {
  const e = b.e;
  eyeOf(e, eyeV);
  const fwdX = -Math.sin(e.yaw), fwdZ = -Math.cos(e.yaw);
  const cosFov = Math.cos(BOTS.fovDeg * 0.5 * DEG);
  let best = null, bestScore = Infinity, checks = 0;
  const cands = [];
  for (const o of state.players.values()) {
    if (o.id === e.id || !o.alive || o.life === LIFE.DEAD || o.life === LIFE.PLANE || o.life === LIFE.SPECTATE || o.life === LIFE.FREEFALL) continue;
    const dx = o.pos.x - e.pos.x, dz = o.pos.z - e.pos.z, dy = o.pos.y - e.pos.y;
    const d = Math.hypot(dx, dz, dy);
    if (d > BOTS.viewDistance * TUNE.viewMult) continue;
    if (o.life === LIFE.CHUTE && d > TUNE.chuteTargetsWithin) continue;
    const threatened = b.threat && b.threat.id === o.id && t - b.threat.at < 3;
    const cos = (dx * fwdX + dz * fwdZ) / (Math.hypot(dx, dz) || 1);
    if (d > 9 && cos < cosFov && !threatened && o.id !== b.target) continue;
    if (!threatened && o.id !== b.target) {
      if (t - b.groundedAt < TUNE.settleIn && d > 18) continue;
      if (!b.inv.primary && d > TUNE.pistolSight) continue;
    }
    let score = d - (threatened ? 40 : 0) - (o.id === b.target ? 25 : 0);
    if (hasFlag(o, FLAG.CROUCH)) score += 12 * (1.2 - b.skill);
    cands.push({ o, score });
  }
  cands.sort((a, c) => a.score - c.score);
  for (const c of cands) {
    if (checks >= 3) break;
    checks++;
    chestOf(c.o, v1);
    if (los(eyeV, v1)) { best = c.o; bestScore = c.score; break; }
  }
  if (best) {
    if (b.target !== best.id) {
      b.target = best.id;
      b.aimTime = 0;
      b.visibleSince = t;
      b.reactUntil = t + reaction(b);
      b.burstLeft = 0;
    } else if (!b.targetVisible) {
      b.reactUntil = Math.max(b.reactUntil, t + reaction(b) * 0.5);
      b.visibleSince = t;
    }
    b.targetVisible = true;
    b.lastSeen = (b.lastSeen || new THREE.Vector3()).copy(best.pos);
    b.lastSeenAt = t;
  } else {
    b.targetVisible = false;
    if (b.target) {
      const o = getPlayer(b.target);
      if (!o || !o.alive || t - b.lastSeenAt > TUNE.engageMemory) b.target = null;
    }
  }
}

// ------------------------------------------------------------------------------------------ behaviours
function setGoal(b, x, y, z, kind) {
  if (b.goal && b.goalKind === kind && Math.hypot(b.goal.x - x, b.goal.z - z) < 1.0 && Math.abs(b.goal.y - y) < 0.8) return;
  b.goal = new THREE.Vector3(x, y, z);
  b.goalKind = kind;
  b.path = plan(b, b.goal);
  b.pathI = 0;
  b.stuckCount = 0;
  b.stuckClock = 0;
  b.stuckRef.copy(b.e.pos);
}

/** True when there is a roof or floor above (x, y, z): the point is inside a building. */
function indoors(x, y, z) { return groundAt(x, z, y + 40).y > y + 1.8; }

/**
 * Waypoints to a goal: direct when visible; otherwise out through the doorway nearest the bot when it is indoors,
 * and in through the best doorway near the goal when the goal is indoors.
 */
function plan(b, goal) {
  const e = b.e;
  v1.set(e.pos.x, e.pos.y + 1.0, e.pos.z);
  v2.set(goal.x, goal.y + 1.0, goal.z);
  const path = [];
  // walled compounds (Fort Kessler): cross the perimeter through the nearest gate
  for (const site of WALLED) {
    const w = site.wall;
    const inA = e.pos.x > w.x0 && e.pos.x < w.x1 && e.pos.z > w.z0 && e.pos.z < w.z1;
    const inB = goal.x > w.x0 && goal.x < w.x1 && goal.z > w.z0 && goal.z < w.z1;
    if (inA === inB) continue;
    let best = null, bc = Infinity;
    for (const [gx, gz] of w.gates) {
      const c = Math.hypot(gx - e.pos.x, gz - e.pos.z) + Math.hypot(goal.x - gx, goal.z - gz);
      if (c < bc) { bc = c; best = [gx, gz]; }
    }
    if (!best) continue;
    const cx = (w.x0 + w.x1) / 2, cz = (w.z0 + w.z1) / 2;
    const dx = best[0] - cx, dz = best[1] - cz;
    // gates sit on an edge: step 4 m perpendicular to that edge on either side
    const onX = Math.min(Math.abs(best[0] - w.x0), Math.abs(best[0] - w.x1)) < Math.min(Math.abs(best[1] - w.z0), Math.abs(best[1] - w.z1));
    const nx = onX ? Math.sign(dx) : 0, nz = onX ? 0 : Math.sign(dz);
    const inP = [best[0] - nx * 4, best[1] - nz * 4], outP = [best[0] + nx * 4, best[1] + nz * 4];
    const [p1, p2] = inA ? [inP, outP] : [outP, inP];
    path.push(new THREE.Vector3(p1[0], heightAt(p1[0], p1[1]), p1[1]), new THREE.Vector3(p2[0], heightAt(p2[0], p2[1]), p2[1]));
    path.push(goal.clone());
    return path;
  }
  if (los(v1, v2)) return [goal.clone()];
  if (indoors(e.pos.x, e.pos.y, e.pos.z)) {
    const exits = near(doorGrid, e.pos.x, e.pos.z, 22, (d) => d.pos);
    let best = null, bc = Infinity;
    for (let i = 0; i < Math.min(exits.length, 10); i++) {
      const d = exits[i].it;
      if (Math.abs(d.pos[1] - e.pos.y) > 1.2) continue;
      const ix = d.pos[0] - d.dir[0] * 1.0, iz = d.pos[2] - d.dir[2] * 1.0;
      v3.set(ix, d.pos[1] + 1.0, iz);
      if (!los(v1, v3)) continue;
      const ox = d.pos[0] + d.dir[0] * 1.8, oz = d.pos[2] + d.dir[2] * 1.8;
      const c = exits[i].d + Math.hypot(goal.x - ox, goal.z - oz) * 0.5;
      if (c < bc) { bc = c; best = { ix, iz, ox, oz, y: d.pos[1] }; }
    }
    if (best) {
      path.push(new THREE.Vector3(best.ix, best.y, best.iz), new THREE.Vector3(best.ox, best.y, best.oz));
      v1.set(best.ox, best.y + 1.0, best.oz);
      if (los(v1, v2)) { path.push(goal.clone()); return path; }
    }
  }
  if (indoors(goal.x, goal.y, goal.z)) {
    const doors = near(doorGrid, goal.x, goal.z, 28, (d) => d.pos);
    let best = null, bc = Infinity;
    for (let i = 0; i < Math.min(doors.length, 8); i++) {
      const d = doors[i].it;
      if (Math.abs(d.pos[1] - goal.y) > 1.6) continue;
      const ox = d.pos[0] + d.dir[0] * 1.7, oz = d.pos[2] + d.dir[2] * 1.7;
      const ix = d.pos[0] - d.dir[0] * 1.3, iz = d.pos[2] - d.dir[2] * 1.3;
      v3.set(ix, d.pos[1] + 1.0, iz);
      if (!los(v3, v2)) continue;
      const c = Math.hypot(ox - v1.x, oz - v1.z) + Math.hypot(goal.x - ix, goal.z - iz);
      if (c < bc) { bc = c; best = { ox, oz, ix, iz, y: d.pos[1] }; }
    }
    if (best) path.push(new THREE.Vector3(best.ox, best.y, best.oz), new THREE.Vector3(best.ix, best.y, best.iz));
  }
  path.push(goal.clone());
  return path;
}

function thinkZone(b, zs) {
  const e = b.e;
  const cx = zs.state === 'final' ? zs.x : zs.nx, cz = zs.state === 'final' ? zs.z : zs.nz;
  const r = zs.state === 'final' ? 0 : zs.nr;
  if (!b.goal || b.goalKind !== 'zone' || Math.hypot(b.goal.x - cx, b.goal.z - cz) > r * 0.8 + 6) {
    const off = (b.approach || 0) * 0.5;
    const ca = Math.cos(off), sa = Math.sin(off);
    const dx0 = e.pos.x - cx, dz0 = e.pos.z - cz;
    const dx = dx0 * ca - dz0 * sa, dz = dx0 * sa + dz0 * ca;
    const d = Math.hypot(dx, dz) || 1;
    const k = Math.min(d, r * 0.45);
    let gx = cx + (dx / d) * k, gz = cz + (dz / d) * k;
    if (heightAt(gx, gz) < 1) { gx = cx; gz = cz; }
    setGoal(b, gx, groundAt(gx, gz, heightAt(gx, gz) + 1).y, gz, 'zone');
  }
  b.sprint = true;
  b.crouch = false;
  b.wantSpeed = PLAYER.sprintSpeed;
}

function thinkCover(b, t) {
  const e = b.e;
  const threat = b.threat ? getPlayer(b.threat.id) : null;
  if (!threat || !threat.alive) { b.mode = 'roam'; return; }
  if (!b.goal || b.goalKind !== 'cover') {
    eyeOf(threat, v2, false);
    const cands = near(coverGrid, e.pos.x, e.pos.z, TUNE.coverSearch, (c) => c);
    let found = null;
    for (let i = 0; i < Math.min(cands.length, 7); i++) {
      const c = cands[i].it;
      if (Math.abs(c[1] - e.pos.y) > 2.5) continue;
      // the cover's far side from the threat
      const ax = c[0] - threat.pos.x, az = c[2] - threat.pos.z;
      const al = Math.hypot(ax, az) || 1;
      const px = c[0] + (ax / al) * 0.9, pz = c[2] + (az / al) * 0.9;
      v1.set(px, groundAt(px, pz, c[1] + 1).y + TUNE.crouchEye, pz);
      if (!los(v2, v1)) { found = [px, v1.y - TUNE.crouchEye, pz]; break; }
    }
    if (found) setGoal(b, found[0], found[1], found[2], 'cover');
    else { b.mode = 'engage'; return; }
  }
  const atCover = b.goal && Math.hypot(b.goal.x - e.pos.x, b.goal.z - e.pos.z) < 1.0;
  b.sprint = !atCover;
  b.crouch = atCover;
  b.wantSpeed = atCover ? 0 : PLAYER.sprintSpeed;
  if (atCover && (e.hp > 85 || t - b.threat.at > 9) && b.plateT <= 0) { b.mode = 'engage'; b.goal = null; }
}

function thinkEngage(b, t, tgt) {
  const e = b.e;
  if (!tgt) return;
  const d = distTo(e, tgt);
  const W = WEAPONS[e.weapon] || WEAPONS.m1911;
  const range = BOTS.engageRange[e.weapon] || 40;
  b.ads = b.targetVisible && d > 14 && b.skill > 0.3;
  b.sprint = false;
  if (b.targetVisible) {
    // strafe and crouch while trading shots; close in when out of range, back off when far too close with a sniper
    if (t > b.strafeUntil) {
      b.strafe = b.rng.chance(0.5) ? 1 : -1;
      b.strafeUntil = t + b.rng.range(0.55, 1.6);
      b.crouch = b.rng.chance(0.25 + b.skill * 0.15) && d > 10;
    }
    const dx = tgt.pos.x - e.pos.x, dz = tgt.pos.z - e.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const fx = dx / len, fz = dz / len;
    let ax = 0;
    if (d > range) ax = 1; else if (W.class === 'sniper' && d < 25) ax = -0.6; else if (d < 6) ax = -0.4;
    const sx = -fz * b.strafe, sz = fx * b.strafe;
    b.goal = null;
    b.path = [];
    b.steer.set(sx + fx * ax, 0, sz + fz * ax).normalize();
    b.wantSpeed = b.crouch ? PLAYER.crouchSpeed : PLAYER.walkSpeed * (b.ads ? 0.62 : 0.9);
    b.directSteer = true;
  } else if (b.lastSeen) {
    b.directSteer = false;
    b.crouch = false;
    // push the last known position, or throw a grenade at it
    const ld = Math.hypot(b.lastSeen.x - e.pos.x, b.lastSeen.z - e.pos.z);
    if (b.inv.frags > 0 && t >= b.nadeReadyAt && ld > TUNE.grenadeRange[0] && ld < TUNE.grenadeRange[1] && t - b.lastSeenAt > 1.2 && b.throwT <= 0 && b.reloadT <= 0) throwGrenade(b, b.lastSeen);
    if (ld > 2) setGoal(b, b.lastSeen.x, b.lastSeen.y, b.lastSeen.z, 'hunt');
    b.wantSpeed = PLAYER.walkSpeed;
  }
  // reload in a lull
  const slot = weaponOf(b);
  if (slot && b.reloadT <= 0 && !b.targetVisible && slot.mag < WEAPONS[slot.weapon].mag * 0.5) startReload(b);
}

function thinkLoot(b, t, radius) {
  const e = b.e;
  if (b.lootGoal) {
    const it = loot.all().get(b.lootGoal);
    if (!it || (it.type === 'crate' && it.opened)) { b.lootGoal = null; b.goal = null; }
  }
  if (!b.lootGoal) {
    const want = lowAmmo(b) ? Math.max(radius, 70) : radius;
    const it = loot.nearest(e.pos, want, (x) => !b.blacklist.has(x.uid) && useful(b, x) && reachable(b, x));
    if (!it) { if (t > b.lootUntil || b.inv.primary) b.lootUntil = Math.min(b.lootUntil, t); thinkRoam(b, t, state.zone); return; }
    b.lootGoal = it.uid;
    setGoal(b, it.pos[0], it.pos[1], it.pos[2], 'loot');
  }
  const it = loot.all().get(b.lootGoal);
  if (!it) return;
  const dh = Math.hypot(it.pos[0] - e.pos.x, it.pos[2] - e.pos.z);
  b.sprint = dh > 12;
  b.crouch = false;
  b.wantSpeed = dh < TUNE.pickupRange ? 0 : (b.sprint ? PLAYER.sprintSpeed : PLAYER.walkSpeed);
  if (dh < TUNE.pickupRange && Math.abs(it.pos[1] - e.pos.y) < 1.3) {
    if (b.pickT < 0) b.pickT = t + b.rng.range(TUNE.pickupDelay[0], TUNE.pickupDelay[1]);
    else if (t >= b.pickT) {
      b.pickT = -1;
      takeItem(b, it);
      b.lootGoal = null;
      b.goal = null;
    }
  } else b.pickT = -1;
}

function useful(b, it) {
  const inv = b.inv;
  switch (it.type) {
    case 'crate': return true;
    case 'weapon': return it.ref !== 'm1911' && (!inv.primary || (RANK[it.ref] || 0) > (RANK[inv.primary.weapon] || 0) + 0.1 || (it.ref === inv.primary.weapon && lowAmmo(b)));
    case 'ammo': {
      const want = new Set([WEAPONS.m1911.ammo]);
      if (inv.primary) want.add(WEAPONS[inv.primary.weapon].ammo);
      return want.has(it.ref) && inv.ammo[it.ref] < AMMO[it.ref].max * 0.6;
    }
    case 'plate': return inv.plates < 4;
    case 'frag': return inv.frags < 2;
    default: return false;
  }
}

function reachable(b, it) {
  // ground-floor items only (bots do not use stairs); the floor must be close to the terrain there
  if (Math.abs(it.pos[1] - b.e.pos.y) > TUNE.maxItemDy) return false;
  return it.pos[1] - 0.05 - heightAt(it.pos[0], it.pos[2]) <= TUNE.maxFloorAbove;
}

function takeItem(b, it) {
  const e = b.e;
  if (!loot.pickup(it.uid, e.id)) return;
  const inv = b.inv;
  switch (it.type) {
    case 'weapon': {
      const W = WEAPONS[it.ref];
      if (inv.primary && inv.primary.weapon === it.ref) {
        inv.ammo[W.ammo] = Math.min(AMMO[W.ammo].max, inv.ammo[W.ammo] + it.qty);     // same gun: strip it for rounds
        break;
      }
      if (inv.primary) loot.drop([{ type: 'weapon', ref: inv.primary.weapon, qty: inv.primary.mag }], [e.pos.x, e.pos.y, e.pos.z], e.id, 0.6);
      inv.primary = { weapon: it.ref, mag: Math.min(it.qty, W.mag) };
      inv.ammo[W.ammo] = Math.min(AMMO[W.ammo].max, inv.ammo[W.ammo] + W.mag * TUNE.pickupMags);
      inv.active = 'primary';
      b.noPrimarySince = -1;
      break;
    }
    case 'ammo': inv.ammo[it.ref] = Math.min(AMMO[it.ref].max, inv.ammo[it.ref] + it.qty); break;
    case 'plate': inv.plates = Math.min(PLAYER.armor.maxCarry, inv.plates + it.qty); break;
    case 'frag': inv.frags = Math.min(WEAPONS.frag.maxCarry, inv.frags + it.qty); break;
    default: break;
  }
  syncWeapon(b);
}

function thinkRoam(b, t, zs) {
  const e = b.e;
  // opportunistic loot close by
  const it = loot.nearest(e.pos, TUNE.roamLootSearch, (x) => !b.blacklist.has(x.uid) && useful(b, x) && reachable(b, x));
  if (it) { b.mode = 'loot'; b.lootUntil = Math.max(b.lootUntil, t + 6); b.lootGoal = null; return; }
  // investigate gunfire
  if (b.heard && t - b.heard.at < 6 && b.rng.chance(0.25 + b.skill * 0.4) && b.goalKind !== 'investigate') {
    setGoal(b, b.heard.pos[0], b.heard.pos[1], b.heard.pos[2], 'investigate');
    b.heard = null;
  }
  const arrived = b.goal && Math.hypot(b.goal.x - e.pos.x, b.goal.z - e.pos.z) < 2.5;
  if (!b.goal || arrived) {
    if (arrived && !b.waitUntil) b.waitUntil = t + b.rng.range(1.5, 5);
    if (b.waitUntil && t < b.waitUntil) { b.wantSpeed = 0; b.lookAround = true; return; }
    b.waitUntil = 0;
    b.lookAround = false;
    const cx = zs && zs.state !== 'pre' ? zs.nx : 0, cz = zs && zs.state !== 'pre' ? zs.nz : 0;
    const r = zs && zs.state !== 'pre' ? Math.max(10, zs.nr * 0.75) : 380;
    for (let k = 0; k < 6; k++) {
      // prefer heading to a site inside the circle, otherwise a random land point
      let gx, gz;
      const sites = [...POIS, ...LANDMARKS].filter((s) => Math.hypot(s.x - cx, s.z - cz) < r);
      if (sites.length && b.rng.chance(0.6)) { const s = b.rng.pick(sites); [gx, gz] = b.rng.inDisc(s.x, s.z, s.r * 0.6); } else [gx, gz] = b.rng.inDisc(cx, cz, r);
      const h = heightAt(gx, gz);
      if (h < 1.5 || inPit(gx, gz)) continue;
      if (Math.hypot(gx - e.pos.x, gz - e.pos.z) > 260) { const d = Math.hypot(gx - e.pos.x, gz - e.pos.z); gx = e.pos.x + (gx - e.pos.x) / d * 160; gz = e.pos.z + (gz - e.pos.z) / d * 160; }
      setGoal(b, gx, groundAt(gx, gz, heightAt(gx, gz) + 1).y, gz, 'roam');
      break;
    }
  }
  b.sprint = b.goal && Math.hypot(b.goal.x - e.pos.x, b.goal.z - e.pos.z) > 40;
  b.crouch = false;
  b.wantSpeed = b.sprint ? PLAYER.sprintSpeed : PLAYER.walkSpeed;
}

/** Steering toward the current waypoint with feeler rays (think rate). */
function steer(b) {
  const e = b.e;
  if (b.mode === 'engage' && b.directSteer) { avoid(b); return; }
  b.directSteer = false;
  if (!b.goal || !b.path.length) { b.steer.set(0, 0, 0); return; }
  let wp = b.path[b.pathI];
  while (wp && Math.hypot(wp.x - e.pos.x, wp.z - e.pos.z) < (b.pathI < b.path.length - 1 ? 1.1 : 0.6)) { b.pathI++; wp = b.path[b.pathI]; }
  if (!wp) { b.steer.set(0, 0, 0); return; }
  const dx = wp.x - e.pos.x, dz = wp.z - e.pos.z;
  const len = Math.hypot(dx, dz) || 1;
  b.steer.set(dx / len, 0, dz / len);
  avoid(b);
}

/**
 * A mantle/vault over a low obstacle straight ahead (fences, barriers, low walls; 0.45..1.35 m like the player):
 * returns {to: Vector3, top} or null. Vaults land on the far side when the obstacle is thin.
 */
const mO = new THREE.Vector3(), mD = new THREE.Vector3();
function mantleTarget(e, dx, dz) {
  mO.set(e.pos.x, e.pos.y + 0.55, e.pos.z);
  mD.set(dx, 0, dz);
  let low = null, high = null;
  try { low = world.raycast(mO, mD, 1.1); } catch (x) { low = null; }
  if (!low || low.kind === 'water' || low.normal.y > 0.6) return null;
  mO.y = e.pos.y + PLAYER.mantle.maxHeight + 0.25;
  try { high = world.raycast(mO, mD, low.distance + 0.6); } catch (x) { high = null; }
  if (high && high.kind !== 'water') return null;            // too tall
  const hx = e.pos.x + dx * low.distance, hz = e.pos.z + dz * low.distance;
  let top = -Infinity;
  for (const k of [0.05, 0.14, 0.3]) top = Math.max(top, groundAt(hx + dx * k, hz + dz * k, e.pos.y + PLAYER.mantle.maxHeight + 0.2).y);
  const rise = top - e.pos.y;
  if (rise < PLAYER.mantle.minHeight - 0.1 || rise > PLAYER.mantle.maxHeight) return null;
  const fx = hx + dx * 0.95, fz = hz + dz * 0.95;
  const far = groundAt(fx, fz, top + 0.2).y;
  const to = far < top - 0.35 && top - far < TUNE.maxDrop + 1 ? new THREE.Vector3(fx, far, fz) : new THREE.Vector3(hx + dx * 0.45, top, hz + dz * 0.45);
  const res = capsule(to, TUNE.height);
  if (res && res.hit && res.push && res.push.lengthSq() > 0.02) return null;
  return { to, top };
}

function blockedDir(e, dx, dz, maxDrop = TUNE.maxDrop) {
  for (const h of [0.6, 1.25]) {
    rayO.set(e.pos.x, e.pos.y + h, e.pos.z);
    rayD.set(dx, 0, dz);
    let hit = null;
    try { hit = world.raycast(rayO, rayD, TUNE.feeler); } catch (x) { hit = null; }
    if (hit && hit.kind !== 'water' && hit.normal.y < 0.6) {
      if (h < 1 && mantleTarget(e, dx, dz)) continue;      // low obstacle: go over it
      return true;
    }
  }
  const px = e.pos.x + dx * 2.2, pz = e.pos.z + dz * 2.2;
  const th = heightAt(px, pz);
  if (th < -0.6) return true;                                 // deep water ahead
  // slopes steeper than the walkable limit (the same rule move() enforces), sampled at 0.8 m and 1.6 m
  let prevY = e.pos.y;
  for (const d of [0.8, 1.6]) {
    const g = groundAt(e.pos.x + dx * d, e.pos.z + dz * d, prevY + PLAYER.stepHeight + 0.05);
    if (g.y - prevY > 0.8 * MAX_RISE + PLAYER.stepHeight * 0.5) return true;
    if (g.normal && g.normal[1] < COS_SLOPE && g.y > prevY + 0.05) return true;
    prevY = g.y;
  }
  if (th > e.pos.y + 1.6 && groundAt(px, pz, e.pos.y + 1.0).y > e.pos.y + 0.9) return true;   // cliff or terrain wall
  if (prevY < e.pos.y - maxDrop) return true;                // a ledge: bots only jump down when there is no other way
  return false;
}

function avoid(b) {
  const e = b.e;
  const s = b.steer;
  if (s.lengthSq() < 1e-4) return;
  const t = now();
  // trapped on a platform (bunker roof, terrace): accept a drop that only just avoids fall damage
  const drop = (b.trips || 0) >= 1 || b.stuckCount >= 2 ? PLAYER.fall.safeHeight - 0.2 : TUNE.maxDrop;
  if (!blockedDir(e, s.x, s.z, drop)) { if (t > b.avoidUntil) b.avoidSide = 0; return; }
  const side = b.avoidSide || (b.rng.chance(0.5) ? 1 : -1);
  for (const deg of [35, 70, 105, 140]) {
    for (const sgn of [side, -side]) {
      const a = deg * DEG * sgn;
      const c = Math.cos(a), sn = Math.sin(a);
      const nx = s.x * c - s.z * sn, nz = s.x * sn + s.z * c;
      if (!blockedDir(e, nx, nz, drop)) { s.set(nx, 0, nz); b.avoidSide = sgn; b.avoidUntil = t + 0.8; return; }
    }
  }
  s.multiplyScalar(-0.5);
}

// ------------------------------------------------------------------------------------------ act (every frame)
function act(b, dt) {
  const e = b.e;
  const t = now();
  // timed actions
  if (b.reloadT > 0) { b.reloadT -= dt; if (b.reloadT <= 0) finishReload(b); }
  if (b.plateT > 0) {
    b.plateT -= dt;
    if (b.plateT <= 0) {
      setFlag(e, FLAG.PLATE, false);
      if (b.inv.plates > 0) { b.inv.plates--; damage.addArmor(e, PLAYER.armor.perPlate); emit(EV.PLATE_DONE, { id: e.id, armor: e.armor }); }
    } else if (b.targetVisible && b.plateT > 0.4) { b.plateT = 0; setFlag(e, FLAG.PLATE, false); }
  }
  if (b.throwT > 0) { b.throwT -= dt; if (b.throwT <= 0) setFlag(e, FLAG.THROW, false); }
  if (b.firingT > 0) { b.firingT -= dt; if (b.firingT <= 0) setFlag(e, FLAG.FIRING, false); }

  // facing
  const tgt = b.target ? getPlayer(b.target) : null;
  let wantYaw = e.yaw, wantPitch = 0, rate = TUNE.turnRate;
  if (tgt && tgt.alive && b.targetVisible && b.mode !== 'zone') {
    eyeOf(e, eyeV);
    chestOf(tgt, v1);
    const dx = v1.x - eyeV.x, dy = v1.y - eyeV.y, dz = v1.z - eyeV.z;
    wantYaw = Math.atan2(-dx, -dz);
    wantPitch = Math.atan2(dy, Math.hypot(dx, dz));
    rate = TUNE.aimTurnRate * (0.6 + b.skill * 0.6);
  } else if (b.steer.lengthSq() > 0.01 && b.wantSpeed > 0) {
    wantYaw = Math.atan2(-b.steer.x, -b.steer.z);
  } else if (b.lookAround) {
    wantYaw = e.yaw + Math.sin(t * 0.7 + b.slot) * 0.6;
    rate = 1.2;
  } else if (b.heard && t - b.heard.at < 3) {
    wantYaw = Math.atan2(-(b.heard.pos[0] - e.pos.x), -(b.heard.pos[2] - e.pos.z));
  }
  e.yaw = dampAngle(e.yaw, wantYaw, rate, dt);
  e.pitch = damp(e.pitch, wantPitch, rate, dt);

  // flags from intent
  const busy = b.plateT > 0 || b.throwT > 0;
  const moving = b.wantSpeed > 0.1 && b.steer.lengthSq() > 0.01;
  const sprint = b.sprint && moving && !busy && b.reloadT <= 0 && !b.targetVisible;
  setFlag(e, FLAG.SPRINT, sprint);
  setFlag(e, FLAG.CROUCH, !!b.crouch && !sprint);
  setFlag(e, FLAG.ADS, !!b.ads && b.targetVisible && !busy && b.reloadT <= 0);

  if (b.mantle) updateMantle(b, dt);
  else {
    move(b, dt, sprint);
    // pressing into something low for a moment: mantle or vault over it
    if (moving && b.wantSpeed > 1 && e.speed < b.wantSpeed * 0.3) b.pressT = (b.pressT || 0) + dt; else b.pressT = 0;
    if (b.pressT > 0.25) {
      b.pressT = 0;
      const m = mantleTarget(e, b.steer.x, b.steer.z);
      if (m) {
        b.mantle = { from: e.pos.clone(), to: m.to, top: m.top, t: 0, dur: PLAYER.mantle.duration * (m.to.y < m.top - 0.3 ? 1.25 : 1) };
        setFlag(e, FLAG.MANTLE, true);
      }
    }
  }
  const last = b.trail[b.trail.length - 1];
  if (!last || Math.hypot(last.x - e.pos.x, last.z - e.pos.z) > 3) {
    b.trail.push(e.pos.clone());
    if (b.trail.length > 40) b.trail.shift();
  }
  shoot(b, dt, t, tgt);
  stuckCheck(b, dt, moving);
}

function move(b, dt, sprint) {
  const e = b.e;
  let speed = b.wantSpeed;
  if (hasFlag(e, FLAG.CROUCH)) speed = Math.min(speed, PLAYER.crouchSpeed);
  if (sprint) speed = PLAYER.sprintSpeed;
  else speed = Math.min(speed, PLAYER.walkSpeed * (hasFlag(e, FLAG.ADS) ? PLAYER.adsSpeedMult + 0.15 : 1));
  if (b.plateT > 0) speed = Math.min(speed, PLAYER.walkSpeed * 0.5);
  const tx = b.steer.x * speed, tz = b.steer.z * speed;
  let left = dt;
  while (left > 1e-5) {
    const h = Math.min(TUNE.substep, left);
    left -= h;
    const ax = clamp(tx - e.vel.x, -TUNE.accel * h, TUNE.accel * h);
    const az = clamp(tz - e.vel.z, -TUNE.accel * h, TUNE.accel * h);
    e.vel.x += ax; e.vel.z += az;
    const nx = e.pos.x + e.vel.x * h, nz = e.pos.z + e.vel.z * h;
    const g = groundAt(nx, nz, e.pos.y + TUNE.terrainStep + 0.05);
    const steep = g.normal && g.normal[1] < COS_SLOPE && g.y > e.pos.y + 0.05;
    const deep = heightAt(nx, nz) < -1.1 && g.y < -1.1;
    const th = heightAt(nx, nz);
    const upstairs = g.y > e.pos.y + 0.02 && g.y - th > TUNE.maxFloorAbove;
    // bare terrain may have small creases (road shoulders): bots step over up to terrainStep there
    const maxStep = Math.abs(g.y - th) < 0.05 ? TUNE.terrainStep : PLAYER.stepHeight;
    if (g.y > e.pos.y + maxStep + 0.01 || steep || deep || upstairs) {
      e.vel.x *= 0.2; e.vel.z *= 0.2;            // wall, cliff or sea: stop here
    } else {
      e.pos.x = nx; e.pos.z = nz;
    }
    const g2 = groundAt(e.pos.x, e.pos.z, e.pos.y + PLAYER.stepHeight + 0.05);
    if (e.pos.y - g2.y <= 0.55 && e.vel.y <= 0.1) {
      e.pos.y = g2.y;
      e.vel.y = 0;
      if (!b.grounded) { b.grounded = true; setFlag(e, FLAG.AIRBORNE, false); }
    } else {
      b.grounded = false;
      setFlag(e, FLAG.AIRBORNE, true);
      e.vel.y -= PLAYER.gravity * h;
      e.pos.y += e.vel.y * h;
      if (e.pos.y <= g2.y) {
        const fallSpeed = -e.vel.y;
        e.pos.y = g2.y; e.vel.y = 0; b.grounded = true;
        setFlag(e, FLAG.AIRBORNE, false);
        const fallH = fallSpeed * fallSpeed / (2 * PLAYER.gravity);
        if (fallH > PLAYER.fall.safeHeight) {
          const dmg = 100 * clamp((fallH - PLAYER.fall.safeHeight) / (PLAYER.fall.lethalHeight - PLAYER.fall.safeHeight), 0, 1);
          applyDamage(e.id, dmg, { kind: 'fall', weapon: 'fall', from: null });
        }
      }
    }
    const res = capsule(e.pos, hasFlag(e, FLAG.CROUCH) ? TUNE.crouchHeight : TUNE.height);
    if (res && res.hit && res.push) {
      e.pos.x += res.push.x; e.pos.z += res.push.z;
      if (res.push.y > 0 && res.push.y < 0.3) e.pos.y += res.push.y;
    }
  }
  e.speed = Math.hypot(e.vel.x, e.vel.z);
}

function updateMantle(b, dt) {
  const e = b.e, m = b.mantle;
  m.t += dt;
  const k = Math.min(1, m.t / m.dur);
  const up = Math.min(1, k / 0.55);                       // rise first, then carry over
  const over = k < 0.35 ? 0 : (k - 0.35) / 0.65;
  const peak = Math.max(m.top + 0.08, m.to.y);
  e.pos.x = m.from.x + (m.to.x - m.from.x) * over;
  e.pos.z = m.from.z + (m.to.z - m.from.z) * over;
  e.pos.y = k < 0.55 ? m.from.y + (peak - m.from.y) * Math.sin(up * Math.PI / 2) : peak + (m.to.y - peak) * ((k - 0.55) / 0.45);
  e.vel.set(0, 0, 0);
  e.speed = 2;
  if (k >= 1) { e.pos.copy(m.to); b.mantle = null; setFlag(e, FLAG.MANTLE, false); b.grounded = true; }
}

function stuckCheck(b, dt, moving) {
  const e = b.e;
  if (!moving || b.mode === 'engage') { b.stuckClock = 0; b.stuckRef.copy(e.pos); return; }
  b.stuckClock += dt;
  if (b.stuckClock < TUNE.stuckWindow) return;
  const d = Math.hypot(e.pos.x - b.stuckRef.x, e.pos.z - b.stuckRef.z);
  b.stuckClock = 0;
  b.stuckRef.copy(e.pos);
  if (d >= TUNE.stuckDist) { b.stuckCount = Math.max(0, b.stuckCount - 1); return; }
  b.stuckCount++;
  b.avoidSide = -b.avoidSide || (b.rng.chance(0.5) ? 1 : -1);
  b.avoidUntil = now() + 1.2;
  if (b.stuckCount >= 3) {
    b.approach = (b.approach || 0) + 1.3;
    if (b.lootGoal) b.blacklist.add(b.lootGoal);
    b.lootGoal = null;
    b.goal = null;
    b.path = [];
    b.stuckCount = 0;
    // shuffle sideways for a moment
    const a = b.rng.range(0, Math.PI * 2);
    b.steer.set(Math.cos(a), 0, Math.sin(a));
  } else if (b.goal) {
    b.path = plan(b, b.goal);
    b.pathI = 0;
  }
}

// ------------------------------------------------------------------------------------------ combat
function startReload(b) {
  const slot = weaponOf(b);
  if (!slot || b.reloadT > 0) return;
  const W = WEAPONS[slot.weapon];
  const have = b.inv.ammo[W.ammo];
  if (have <= 0) {
    if (b.inv.active === 'primary') { b.inv.active = 'pistol'; syncWeapon(b); emit(EV.WEAPON_SWITCH, { id: b.id, weapon: b.e.weapon }); }
    return;
  }
  const empty = slot.mag === 0;
  b.reloadDur = empty ? W.reloadEmpty : W.reload;
  b.reloadT = b.reloadDur * (1.08 - b.skill * 0.12);
  setFlag(b.e, FLAG.RELOAD, true);
  emit(EV.WEAPON_RELOAD, { id: b.id, weapon: slot.weapon, phase: 'start', empty });
}

function finishReload(b) {
  const slot = weaponOf(b);
  setFlag(b.e, FLAG.RELOAD, false);
  if (!slot) return;
  const W = WEAPONS[slot.weapon];
  const take = Math.min(W.mag - slot.mag, b.inv.ammo[W.ammo]);
  slot.mag += take;
  b.inv.ammo[W.ammo] -= take;
  emit(EV.WEAPON_RELOAD, { id: b.id, weapon: slot.weapon, phase: 'end', empty: false });
}

const aimDir = new THREE.Vector3(), aimPt = new THREE.Vector3();
function shoot(b, dt, t, tgt) {
  const e = b.e;
  if (!tgt || !tgt.alive || !b.targetVisible || b.mode === 'zone') { b.aimTime = 0; return; }
  b.aimTime += dt;
  if (t < b.reactUntil || b.reloadT > 0 || b.plateT > 0 || b.throwT > 0 || hasFlag(e, FLAG.SPRINT)) return;
  const slot = weaponOf(b);
  if (!slot) return;
  const W = WEAPONS[slot.weapon];
  if (slot.mag <= 0) {
    if (b.inv.ammo[W.ammo] > 0) startReload(b);
    else if (b.inv.active === 'primary') { b.inv.active = 'pistol'; syncWeapon(b); }
    else if (t > b.scavengeAt) { b.scavengeAt = t + TUNE.fallbackPistolEvery; b.inv.ammo.light += WEAPONS.m1911.mag; }
    return;
  }
  const d = distTo(e, tgt);
  if (d > Math.min(W.range, (BOTS.engageRange[slot.weapon] || 50) * 1.6)) return;
  if (t < b.nextShotAt) return;
  // facing must be roughly on target before the first shot
  eyeOf(e, eyeV);
  const head = b.rng.chance(BOTS.headshotChance * (0.5 + b.skill));
  const k = hasFlag(tgt, FLAG.CROUCH) ? 0.68 : 1;
  if (tgt.life === LIFE.CHUTE) aimPt.set(tgt.pos.x, tgt.pos.y + 0.9, tgt.pos.z);
  else aimPt.set(tgt.pos.x, tgt.pos.y + (head ? 1.6 : 1.12) * k, tgt.pos.z);
  aimDir.subVectors(aimPt, eyeV);
  const dist = aimDir.length();
  aimDir.divideScalar(dist || 1);
  const yawTo = Math.atan2(-aimDir.x, -aimDir.z);
  if (Math.abs(angleDelta(e.yaw, yawTo)) > 0.35) return;
  // aim error: settles while the target stays in sight; worse at range, while moving, against moving targets
  const A = BOTS.aimErrorDeg;
  const settle = A.min + (A.start - A.min) * Math.exp(-b.aimTime / A.settle);
  const skillMult = 1.55 - b.skill;
  const movePen = e.speed > 1 ? 0.7 : 0;
  const tgtPen = Math.min(1.6, (tgt.speed || 0) * 0.14);
  const rangePen = dist / 120;
  const errDeg = (settle + movePen + tgtPen + rangePen) * skillMult * TUNE.aimMult;
  const yawErr = b.rng.normal() * errDeg * 0.5 * DEG, pitchErr = b.rng.normal() * errDeg * 0.42 * DEG;
  const cy = Math.cos(yawErr), sy = Math.sin(yawErr);
  let x = aimDir.x * cy - aimDir.z * sy, z = aimDir.x * sy + aimDir.z * cy;
  const y = aimDir.y + pitchErr;
  aimDir.set(x, y, z).normalize();
  const ads = hasFlag(e, FLAG.ADS);
  const spreadDeg = ads ? W.spread.ads : W.spread.hip * 0.55 + (e.speed > 1 ? W.spread.move * 0.5 : 0);
  try {
    ballistics.fire(e.id, slot.weapon, eyeV, aimDir, { spreadDeg });
  } catch (err) {
    console.warn('[GAME/bots] fire failed', err);
  }
  slot.mag--;
  setFlag(e, FLAG.FIRING, true);
  b.firingT = 0.16;
  // cadence: bursts for automatics, deliberate shots for semi and bolt actions
  const interval = 60 / W.rpm;
  if (W.mode === 'auto') {
    if (b.burstLeft <= 0) b.burstLeft = b.rng.int(BOTS.burstShots[0], BOTS.burstShots[1]) + Math.round(b.skill * 2) - (d > 60 ? 3 : 0);
    b.burstLeft--;
    b.nextShotAt = t + interval * 1.04;
    if (b.burstLeft <= 0) b.nextShotAt = t + b.rng.range(BOTS.burstPause[0], BOTS.burstPause[1]) * (d > 50 ? 1.5 : 1);
  } else if (W.mode === 'bolt') {
    b.nextShotAt = t + (W.boltTime || 1.1) + b.rng.range(0.35, 0.9) * (1.3 - b.skill);
    emit(EV.WEAPON_BOLT, { id: e.id, weapon: slot.weapon });
  } else {
    b.nextShotAt = t + Math.max(interval, b.rng.range(0.22, 0.42) * (1.3 - b.skill * 0.4));
  }
  if (slot.mag <= 0 && b.inv.ammo[W.ammo] > 0) startReload(b);
}

function throwGrenade(b, at) {
  const e = b.e;
  const t = now();
  b.inv.frags--;
  b.nadeReadyAt = t + b.rng.range(TUNE.grenadeCooldown[0], TUNE.grenadeCooldown[1]);
  b.throwT = WEAPONS.frag.throwTime;
  setFlag(e, FLAG.THROW, true);
  eyeOf(e, eyeV);
  const dx = at.x - eyeV.x, dz = at.z - eyeV.z, dy = at.y + 0.3 - eyeV.y;
  const hd = Math.hypot(dx, dz) || 1;
  const T = clamp(hd / 15, 0.7, 1.7);
  const g = WEAPONS.frag.gravity;
  const vx = dx / T + b.rng.normal() * 0.6, vz = dz / T + b.rng.normal() * 0.6;
  const vy = (dy + 0.5 * g * T * T) / T;
  const cook = b.rng.range(0.6, 1.8) * b.skill;
  const ox = eyeV.x + dx / hd * 0.5, oz = eyeV.z + dz / hd * 0.5;
  try {
    grenades.spawn({ gid: `${e.id}:${nadeSeq++}`, owner: e.id, origin: [ox, eyeV.y + 0.1, oz], vel: [vx, vy, vz], fuse: Math.max(0.8, WEAPONS.frag.fuse - cook), t: Math.round(t * 1000) });
  } catch (err) { console.warn('[GAME/bots] grenade failed', err); }
}

// ------------------------------------------------------------------------------------------ events
function onFire({ id, origin, weapon }) {
  if (!authority() || !brains.size || !origin) return;
  const W = WEAPONS[weapon];
  const range = BOTS.hearing * (W && W.class === 'sniper' ? TUNE.hearingSniper : 1);
  const t = now();
  for (const b of brains.values()) {
    if (b.id === id || b.mode === 'dead' || b.e.life !== LIFE.GROUND) continue;
    const d = Math.hypot(origin[0] - b.e.pos.x, origin[2] - b.e.pos.z);
    if (d > range) continue;
    b.heard = { pos: origin.slice(), id, at: t };
    if (!b.target && getPlayer(id) && d < range * 0.5) {
      const shooter = getPlayer(id);
      b.lastSeen = shooter.pos.clone();
      b.lastSeenAt = t - 1.5;
      b.target = id;
      b.targetVisible = false;
      b.reactUntil = t + reaction(b);
    }
  }
}

function onKilled({ id }) {
  for (const b of brains.values()) {
    if (b.target === id) { b.target = null; b.targetVisible = false; b.burstLeft = 0; }
    if (b.threat && b.threat.id === id) b.threat = null;
  }
  const b = brains.get(id);
  if (b) { b.mode = 'dead'; clearActions(b); }
}

export function init() {
  on(EV.WEAPON_FIRE, onFire);
  on(EV.PLAYER_KILLED, onKilled);
  debug.game = debug.game || {};
  Object.assign(debug.game, {
    killAllBots: () => {
      let n = 0;
      for (const b of brains.values()) {
        const e = b.e;
        if (!e || !e.alive) continue;
        if (authority()) { damage.kill(e.id, null, 'zone', false, null); n++; }
      }
      return n;
    },
    bots: () => [...brains.values()].map((b) => ({
      id: b.id, name: b.e.name, mode: b.mode, life: b.e.life, alive: b.e.alive, hp: Math.round(b.e.hp), armor: Math.round(b.e.armor),
      weapon: b.e.weapon, x: +b.e.pos.x.toFixed(1), y: +b.e.pos.y.toFixed(1), z: +b.e.pos.z.toFixed(1), target: b.target, visible: b.targetVisible,
      skill: +b.skill.toFixed(2), site: b.site.id, plates: b.inv.plates, frags: b.inv.frags, kills: b.e.kills,
      goal: b.goal ? [+b.goal.x.toFixed(1), +b.goal.z.toFixed(1)] : null,
    })),
    botBrain: (id) => brains.get(id) || null,
  });
}
