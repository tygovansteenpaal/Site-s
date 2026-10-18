// ZONEFALL - damage, armor, death, hit validation. OWNER: COMBAT. Contract: ARCHITECTURE.md 5.3, 6.2 and 8.5.
// Authority: a human owns its own HP; the host owns bot HP. Armor (0..150, three 50-point plates) absorbs bullet and
// explosion damage before health; fall and zone damage hit health only. There is no downed state: 0 HP is a direct
// elimination. Regen: PLAYER.regenRate per second after PLAYER.regenDelay without damage.
//
// Flow of a bullet hit (favour the shooter, victim confirms):
//   shooter -> dealHit(): predicted HIT_CONFIRMED (hitmarker) at once, then either applies the damage itself (it owns
//   the target: itself, or a bot while host/offline) or broadcasts 'hit'. The owner of the target runs validateHit() on
//   NET_HIT and applies the damage. At 0 HP the owner calls kill(): PLAYER_KILLED locally + a 'death' broadcast, and
//   every other peer turns NET_DEATH into PLAYER_KILLED.
//
// Extra exports (COMBAT additions): addArmor(entity, amount) used by weapons for plates, maxArmor(),
// setGodMode(on), predict(entity, amount, kind), lastDamageTime(id).
// PLAYER_DAMAGED carries an extra `absorbed` field (armor points the hit removed) and `kind`.
import * as THREE from 'three';
import { WEAPONS, PLAYER, LOOT, NET } from '../config.js';
import { on, emit, EV } from '../core/bus.js';
import { state, getPlayer, localPlayer, isBotId, LIFE, debug } from '../core/state.js';
import { clamp } from '../core/util.js';
import { ZONE_CODE, ZONE_NAME } from '../net/protocol.js';
import * as session from '../net/session.js';
import * as sync from '../net/sync.js';
import * as bots from '../game/bots.js';
import * as loot from '../game/loot.js';
import * as inventory from '../player/inventory.js';
import * as world from '../world/world.js';

const TUNE = {
  armorMax: PLAYER.armor.slots * PLAYER.armor.perPlate,   // 150
  shooterPosSlack: 2.5,        // m, + speed x (rtt + interpolation delay)
  targetPosSlack: 1.5,         // m, + speed x 0.35 s
  targetWindowMs: 600,
  rateSlack: 1.1,              // shots may arrive up to rpm x 1.1
  rateJitterMs: 18,            // timestamp tolerance on top of the rate check
  explosionProbeUp: 0.2,       // LOS from slightly above the blast point
  dedupeKeep: 256,
};

let godMode = false;
let inited = false;
const lastHitAt = new Map();          // entity id -> performance.now() of the last damage taken (regen delay)
const lastShotT = new Map();          // shooter id -> match ms of the last validated hit (rate check)
const seenHits = [];                  // ring of 'by:sid:tgt' keys already applied
const seenSet = new Set();
const suspicion = new Map();          // shooter id -> count of failed validations seen on this peer
const fragCredit = new Map();         // remote human id -> performance.now() our frag's splash was predicted on him
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();

function err(msg) { return new Error(`[COMBAT/damage] ${msg}`); }

// ------------------------------------------------------------------------------------------ maths
/** Body damage at distance from the weapon's damage steps times the zone multiplier (head/limb). */
export function damageAt(weaponId, zone, distance) {
  const W = WEAPONS[weaponId];
  if (!W) throw err(`unknown weapon '${weaponId}'`);
  if (W.class === 'lethal') return W.damageMax || 0;
  const steps = W.damage;
  let dmg = steps[0].dmg;
  const d = Math.max(0, distance || 0);
  for (let i = 1; i < steps.length; i++) if (steps[i].d <= d) dmg = steps[i].dmg;
  const mult = zone === 'head' ? W.head : zone === 'limb' ? W.limb : 1;
  return dmg * mult;
}

export const maxArmor = () => TUNE.armorMax;

const predOut = { killed: false, armorBroke: false, dealt: 0, absorbed: 0, hp: 0, armor: 0 };
/** What a hit of `amount` would do to an entity (no side effects). kind: bullet|explosion use armor, fall|zone do not. */
export function predict(entity, amount, kind = 'bullet') {
  const usesArmor = kind === 'bullet' || kind === 'explosion';
  let armor = Math.max(0, entity.armor || 0), hp = Math.max(0, entity.hp || 0);
  let left = Math.max(0, amount || 0), absorbed = 0;
  if (usesArmor && armor > 0) { absorbed = Math.min(armor, left); armor -= absorbed; left -= absorbed; }
  const toHp = Math.min(hp, left);
  hp -= toHp;
  predOut.absorbed = absorbed;
  predOut.dealt = absorbed + toHp;
  predOut.armorBroke = absorbed > 0 && armor <= 0;
  predOut.killed = hp <= 0;
  predOut.hp = hp;
  predOut.armor = armor;
  return predOut;
}

/** Shared armor/health maths for any entity (bots on the host). @returns {{killed:boolean, armorBroke:boolean, dealt:number}} */
export function applyToEntity(entity, amount, info = {}) {
  if (!entity) throw err('applyToEntity needs an entity');
  if (!entity.alive || !(amount > 0)) return { killed: false, armorBroke: false, dealt: 0 };
  const kind = info.kind || 'bullet';
  const p = predict(entity, amount, kind);
  entity.hp = p.hp;
  entity.armor = p.armor;
  lastHitAt.set(entity.id, performance.now());
  const res = { killed: p.killed, armorBroke: p.armorBroke, dealt: p.dealt, absorbed: p.absorbed };
  if (entity.id !== state.selfId) {
    emit(EV.PLAYER_DAMAGED, {
      id: entity.id, amount: res.dealt, hp: entity.hp, armor: entity.armor, armorBroke: res.armorBroke, absorbed: res.absorbed,
      from: info.from ?? null, weapon: info.weapon ?? null, zone: info.zone ?? null, dir: info.dir ?? null, kind,
    });
  }
  return res;
}

/** Plates: add armor to an entity (capped at 150). Returns the new armor value. */
export function addArmor(entity, amount) {
  if (!entity) return 0;
  entity.armor = clamp((entity.armor || 0) + amount, 0, TUNE.armorMax);
  return entity.armor;
}

export function setGodMode(on) { godMode = !!on; }
export const lastDamageTime = (id) => lastHitAt.get(id) ?? -1e9;

// ------------------------------------------------------------------------------------------ local player
/**
 * Damage the local player. kind: 'bullet' | 'explosion' | 'fall' | 'zone'. Emits PLAYER_DAMAGED; at 0 hp calls kill().
 * @param {number} amount
 * @param {{from?:string|null, weapon?:string|null, zone?:string|null, dir?:number[]|null, kind:string, sid?:number|null}} info
 */
export function applyToSelf(amount, info = {}) {
  const me = localPlayer();
  if (!me || !me.alive || !(amount > 0)) return null;
  if (me.life === LIFE.PLANE || me.life === LIFE.SPECTATE || me.life === LIFE.DEAD) return null;
  const kind = info.kind || 'bullet';
  const p = predict(me, godMode ? 0 : amount, kind);
  me.hp = p.hp;
  me.armor = p.armor;
  const now = performance.now();
  state.local.lastDamageAt = now;
  lastHitAt.set(me.id, now);
  const res = { killed: p.killed, armorBroke: p.armorBroke, dealt: p.dealt, absorbed: p.absorbed };
  emit(EV.PLAYER_DAMAGED, {
    id: me.id, amount: godMode ? amount : res.dealt, hp: me.hp, armor: me.armor, armorBroke: res.armorBroke, absorbed: res.absorbed,
    from: info.from ?? null, weapon: info.weapon ?? null, zone: info.zone ?? null, dir: info.dir ?? null, kind,
  });
  if (res.killed) {
    const cause = kind === 'zone' || kind === 'fall' ? kind : (info.weapon || 'frag');
    kill(me.id, kind === 'zone' || kind === 'fall' ? null : (info.from ?? null), cause, info.zone === 'head', info.sid ?? null);
  }
  return res;
}

// ------------------------------------------------------------------------------------------ hits
let sidSeq = (Math.random() * 1e6) | 0;
/** A fresh shot id for hits made on this peer. */
export function nextSid() { sidSeq = (sidSeq + 1) & 0x7fffffff; return sidSeq; }

/**
 * Route a hit made by a shooter simulated on this peer. Target local -> applyToSelf. Target bot and this peer is
 * authority (host/offline) -> bots.applyDamage. Online -> also broadcast 'hit' (everyone records, the owner applies).
 * Emits HIT_CONFIRMED for the local shooter (hitmarker) once the damage is known to land.
 * @param {{sid:number, shooter:string, target:string, weapon:string, zone:'head'|'body'|'limb', distance:number, origin:number[], targetPos:number[]}} hit
 */
export function dealHit(hit) {
  const target = getPlayer(hit.target);
  if (!target || !target.alive) return null;
  // A remote player we have not heard from for NET.staleMs is a frozen ghost of where he was: a hit on it would only
  // be rejected by his client. No hitmarker, no damage counted, nothing sent.
  if (state.online && target.kind === 'remote' && target.stale) return null;
  const dmg = damageAt(hit.weapon, hit.zone, hit.distance);
  const dir = dirOf(hit.origin, hit.targetPos);
  const info = { from: hit.shooter, weapon: hit.weapon, zone: hit.zone, dir, kind: 'bullet', sid: hit.sid };
  const pred = predict(target, dmg, 'bullet');
  const confirm = { target: target.id, dmg: Math.round(pred.dealt), zone: hit.zone, kill: pred.killed, armorBroke: pred.armorBroke, distance: hit.distance };
  if (hit.shooter === state.selfId) state.match.stats.damage += pred.dealt;

  let applied = null;
  if (target.id === state.selfId) applied = applyToSelf(dmg, info);
  else if (isBotId(target.id) && (state.isHost || !state.online)) applied = bots.applyDamage(target.id, dmg, info) || null;

  if (hit.shooter === state.selfId) emit(EV.HIT_CONFIRMED, confirm);
  if (state.online) {
    session.send('hit', {
      mid: state.match.id, sid: hit.sid, by: hit.shooter, tgt: target.id, w: hit.weapon, z: ZONE_CODE[hit.zone] ?? 0, dmg: Math.round(dmg * 100) / 100,
      d: Math.round(hit.distance * 100) / 100, sp: round3(hit.origin), tp: round3(hit.targetPos), t: Math.round(state.match.time * 1000),
    });
  }
  return applied || confirm;
}

function round3(a) { return [Math.round(a[0] * 1000) / 1000, Math.round(a[1] * 1000) / 1000, Math.round(a[2] * 1000) / 1000]; }

function dirOf(from, to) {
  if (!from || !to) return null;
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const l = Math.hypot(dx, dy, dz) || 1;
  return [dx / l, dy / l, dz / l];
}

// ------------------------------------------------------------------------------------------ death
/**
 * Death of an entity this peer is authority for: set alive=false, life=DEAD, emit PLAYER_KILLED, broadcast 'death',
 * drop its inventory through game/loot.drop (local player: inventory.dropAll(); bots: their weapon + ammo).
 * weapon 'left' on the local player is a forfeit (LEAVE MATCH while alive, connection lost): announced and dropped
 * like any death, without a killer.
 */
export function kill(victimId, killerId, weapon, headshot, sid = null) {
  const e = getPlayer(victimId);
  if (!e || !e.alive && e.life === LIFE.DEAD) return;
  const wasLife = e.life;
  e.alive = false;
  e.life = leaveLife(e.life, weapon);
  e.hp = 0;
  const pos = [e.pos.x, e.pos.y, e.pos.z];
  if (victimId === state.selfId) {
    const k = killerId ? getPlayer(killerId) : null;
    state.local.killer = {
      id: killerId || null, name: k ? k.name : (weapon === 'zone' ? 'The zone' : weapon === 'fall' ? 'Gravity' : weapon === 'left' ? 'Connection lost' : 'Unknown'),
      weapon, headshot: !!headshot, distance: k ? Math.round(k.pos.distanceTo(e.pos)) : 0,
    };
  }
  // The authority's match time of the death (ms): every client ranks placements by it (game/match), not by arrival.
  const t = Math.round(state.match.time * 1000);
  emit(EV.PLAYER_KILLED, { id: victimId, by: killerId || null, weapon, headshot: !!headshot, pos, at: t / 1000 });
  const forfeit = weapon === 'left' && victimId === state.selfId;
  if (state.online && (weapon !== 'left' || forfeit)) {
    session.send('death', { mid: state.match.id, id: victimId, by: killerId || null, w: weapon, hs: !!headshot, sid: sid == null ? null : sid, pos: round3(pos), t });
  }
  if (weapon === 'left' && !forfeit) return;
  // A forfeit from the plane or the sky over the sea drops nothing: the items would land on the sea floor.
  if (weapon === 'left' && isAirborne(wasLife) && safe(() => world.isWater(pos[0], pos[2]), false)) return;
  // Death drop: the authority spawns the items (loot broadcasts 'drop' when online).
  let items = null;
  if (victimId === state.selfId) items = inventory.dropAll();
  else if (isBotId(victimId) && e.weapon && WEAPONS[e.weapon] && WEAPONS[e.weapon].class !== 'lethal') {
    const W = WEAPONS[e.weapon];
    items = [{ type: 'weapon', ref: e.weapon, qty: W.mag, tier: 0 }, { type: 'ammo', ref: W.ammo, qty: LOOT.ammoQty[W.ammo], tier: 0 }];
  }
  if (items && items.length) loot.drop(items, pos, victimId);
}

// ------------------------------------------------------------------------------------------ explosions
/**
 * Splash damage of an explosion at pos [x,y,z] to the local player (and bots when authority), LOS-checked. Remote
 * humans apply their own splash; for them the thrower only predicts it (hitmarker and damage stat, like a bullet hit).
 */
export function explosionAt(pos, ownerId, weapon = 'frag') {
  const F = WEAPONS.frag;
  const blast = tmpA.set(pos[0], pos[1] + TUNE.explosionProbeUp, pos[2]);
  const results = [];
  const authority = state.isHost || !state.online;
  for (const e of state.players.values()) {
    if (!e.alive || e.life === LIFE.PLANE || e.life === LIFE.SPECTATE || e.life === LIFE.DEAD) continue;
    const isSelf = e.id === state.selfId;
    if (!F.selfDamage && e.id === ownerId) continue;
    if (!isSelf && !(authority && isBotId(e.id))) {
      if (ownerId === state.selfId && e.kind === 'remote') {
        const est = splash(e, blast);
        if (est > 0) {
          const pred = predict(e, est, 'explosion');
          state.match.stats.damage += pred.dealt;
          fragCredit.set(e.id, performance.now());
          emit(EV.HIT_CONFIRMED, { target: e.id, dmg: Math.round(pred.dealt), zone: 'body', kill: pred.killed, armorBroke: pred.armorBroke, distance: 0 });
        }
      }
      continue;
    }
    const dmg = splash(e, blast);
    if (dmg <= 0) continue;
    const dir = dirOf(pos, [e.pos.x, e.pos.y + 0.9, e.pos.z]);
    const info = { from: ownerId || null, weapon, zone: 'body', dir, kind: 'explosion' };
    const pred = predict(e, dmg, 'explosion');
    const confirm = { target: e.id, dmg: Math.round(pred.dealt), zone: 'body', kill: pred.killed, armorBroke: pred.armorBroke, distance: 0 };
    if (isSelf) applyToSelf(dmg, info);
    else bots.applyDamage(e.id, dmg, info);
    if (ownerId === state.selfId && !isSelf) { state.match.stats.damage += pred.dealt; emit(EV.HIT_CONFIRMED, confirm); }
    results.push({ id: e.id, dmg });
  }
  return results;
}

/** Frag damage to one entity: full inside innerRadius, falling to damageMin at outerRadius, LOS to chest or head. */
function splash(e, blast) {
  const F = WEAPONS.frag;
  let best = 0;
  // Nearest of feet/chest/head so a grenade under a crouched player still counts as close.
  for (const h of [0.25, 0.95, 1.5]) {
    tmpB.set(e.pos.x, e.pos.y + h, e.pos.z);
    const d = tmpB.distanceTo(blast);
    if (d >= F.outerRadius) continue;
    if (!world.lineOfSight(blast, tmpB)) continue;
    let dmg;
    if (d <= F.innerRadius) dmg = F.damageMax;
    else {
      const t = (d - F.innerRadius) / (F.outerRadius - F.innerRadius);
      dmg = F.damageMax + (F.damageMin - F.damageMax) * Math.pow(t, 0.75);
    }
    if (dmg > best) best = dmg;
  }
  return best;
}

// ------------------------------------------------------------------------------------------ regen
/** Health regeneration step for an entity (used for the local player in update and by bots). */
export function regen(entity, dt) {
  if (!entity || !entity.alive || entity.hp >= PLAYER.health) return;
  const last = entity.id === state.selfId ? state.local.lastDamageAt : (lastHitAt.get(entity.id) ?? -1e9);
  if (performance.now() - last < PLAYER.regenDelay * 1000) return;
  entity.hp = Math.min(PLAYER.health, entity.hp + PLAYER.regenRate * dt);
}

/** Local regeneration. */
export function update(dt) {
  const me = localPlayer();
  if (me && me.alive && me.life !== LIFE.DEAD) regen(me, dt);
}

// ------------------------------------------------------------------------------------------ validation
/**
 * Sanity checks of an incoming hit (rate, damage cap, range, shooter position, target position history).
 * @param {{sid, by, tgt, w, z, dmg, d, sp, tp, t}} hit  validated 'hit' payload
 */
export function validateHit(hit, fromPeerId) {
  const ok = checkHit(hit, fromPeerId);
  if (!ok) suspicion.set(hit.by, (suspicion.get(hit.by) || 0) + 1);
  return ok;
}

function checkHit(hit, fromPeerId) {
  const W = WEAPONS[hit.w];
  if (!W || W.class === 'lethal') return false;
  const zone = ZONE_NAME[hit.z];
  if (!zone) return false;
  const shooter = getPlayer(hit.by);
  if (!shooter || !shooter.alive) return false;
  // Who may report it: the shooter itself, or the current host for a bot shooter.
  if (isBotId(hit.by)) { if (fromPeerId !== state.hostId) return false; } else if (fromPeerId !== hit.by) return false;
  if (hit.dmg > damageAt(hit.w, zone, 0) + 0.01) return false;
  if (hit.d > W.range + 1) return false;
  // Fire rate.
  const prev = lastShotT.get(hit.by);
  const minGap = 60000 / W.rpm / TUNE.rateSlack - TUNE.rateJitterMs;
  if (prev != null && hit.t - prev < minGap && hit.t >= prev) return false;
  // Shooter position against its interpolated pose.
  const rttMs = safe(() => session.rtt(fromPeerId), 0) || 0;
  const interp = safe(() => sync.interpDelay(), NET.interpDelay) || NET.interpDelay;
  const sSpeed = Math.max(shooter.speed || 0, 1);
  tmpA.set(hit.sp[0], hit.sp[1], hit.sp[2]);
  const sDist = Math.hypot(tmpA.x - shooter.pos.x, tmpA.z - shooter.pos.z);
  if (sDist > TUNE.shooterPosSlack + sSpeed * (rttMs + interp) / 1000 + 2.2) return false;   // + eye height slack
  // Target position against our own pose history in [t - 600 ms, t].
  const victim = getPlayer(hit.tgt);
  if (!victim) return false;
  const tLocal = state.match.t0 + hit.t;
  const poseAt = hit.tgt === state.selfId ? (ms) => sync.selfPoseAt(ms) : (ms) => sync.botPoseAt(hit.tgt, ms);
  const vSpeed = Math.max(victim.speed || 0, 1);
  const slack = TUNE.targetPosSlack + vSpeed * 0.35 + 1.1;   // tp is the impact point on the body: up to ~1.7 m above the feet
  let best = Infinity;
  for (let dt = 0; dt <= TUNE.targetWindowMs; dt += 50) {
    const p = safe(() => poseAt(tLocal - dt), null);
    if (!p) continue;
    const d = Math.hypot(hit.tp[0] - p.x, hit.tp[1] - (p.y + 0.9), hit.tp[2] - p.z);
    if (d < best) best = d;
  }
  if (best === Infinity) best = Math.hypot(hit.tp[0] - victim.pos.x, hit.tp[1] - (victim.pos.y + 0.9), hit.tp[2] - victim.pos.z);
  if (best > slack) return false;
  lastShotT.set(hit.by, Math.max(prev ?? -Infinity, hit.t));
  return true;
}

function safe(fn, fallback) { try { const v = fn(); return v == null ? fallback : v; } catch (e) { return fallback; } }

const isAirborne = (life) => life === LIFE.PLANE || life === LIFE.FREEFALL || life === LIFE.CHUTE;

/**
 * Life state after a death: a player who leaves (forfeit, dropped) while in the plane or in the air has no body to
 * leave behind (SPECTATE: hidden, not counted), instead of a corpse hanging in the sky on every client.
 */
export function leaveLife(life, weapon) {
  return weapon === 'left' && (isAirborne(life) || life === LIFE.SPECTATE) ? LIFE.SPECTATE : LIFE.DEAD;
}

function remember(key) {
  if (seenSet.has(key)) return false;
  seenSet.add(key);
  seenHits.push(key);
  if (seenHits.length > TUNE.dedupeKeep) seenSet.delete(seenHits.shift());
  return true;
}

// ------------------------------------------------------------------------------------------ network
function onNetHit({ from, data: h }) {
  if (!h) return;
  const zone = ZONE_NAME[h.z];
  const isOwner = h.tgt === state.selfId || (isBotId(h.tgt) && state.isHost);
  if (!isOwner) { if (!checkHit(h, from)) suspicion.set(h.by, (suspicion.get(h.by) || 0) + 1); return; }
  if (!remember(`${h.by}:${h.sid}:${h.tgt}`)) return;
  if (!validateHit(h, from)) return;
  const dmg = Math.min(h.dmg, damageAt(h.w, zone, h.d));
  const info = { from: h.by, weapon: h.w, zone, dir: dirOf(h.sp, h.tp), kind: 'bullet', sid: h.sid };
  if (h.tgt === state.selfId) applyToSelf(dmg, info);
  else bots.applyDamage(h.tgt, dmg, info);
}

function onNetDeath({ from, data: d }) {
  if (!d) return;
  if (d.id === state.selfId) return;                                 // only we decide our own death
  if (isBotId(d.id)) {
    // Normally only the host reports bot deaths. After a host stall two peers may both have simulated the bots for a
    // moment; a bot death from any player still in our match is accepted (idempotent), so bot fates never diverge.
    if (from !== state.hostId && !safe(() => session.inMatchPeer(from), false)) return;
  } else if (from !== d.id && !(d.decl && d.w === 'left')) return;   // decl: a drop the match host announced (net/session)
  const e = getPlayer(d.id);
  if (!e || (!e.alive && e.life === LIFE.DEAD)) return;
  // Our frag killed a remote player whose own explosion ran a moment before ours (his death arrived first, so our
  // splash prediction found him already dead): credit the hitmarker and the damage from his last snapshot vitals.
  if (d.by === state.selfId && d.w === 'frag' && e.kind === 'remote' && performance.now() - (fragCredit.get(d.id) ?? -1e9) > 2000) {
    const dealt = Math.max(0, (e.hp || 0) + (e.armor || 0));
    state.match.stats.damage += dealt;
    emit(EV.HIT_CONFIRMED, { target: d.id, dmg: Math.round(dealt), zone: 'body', kill: true, armorBroke: (e.armor || 0) > 0, distance: 0 });
  }
  e.alive = false;
  e.life = leaveLife(e.life, d.w);
  e.hp = 0;
  emit(EV.PLAYER_KILLED, { id: d.id, by: d.by, weapon: d.w, headshot: !!d.hs, pos: d.pos, at: d.t == null ? undefined : d.t / 1000 });
}

/** Subscribe to NET_HIT and NET_DEATH. */
export function init() {
  if (inited) return;
  inited = true;
  on(EV.NET_HIT, onNetHit);
  on(EV.NET_DEATH, onNetDeath);
  on(EV.MATCH_START, () => { lastHitAt.clear(); lastShotT.clear(); seenHits.length = 0; seenSet.clear(); fragCredit.clear(); });
  // A practice pause freezes the match clock; the regen delay (wall clock) must not run on while paused either.
  let pausedAt = 0;
  on(EV.PAUSE, ({ paused }) => {
    if (paused) { pausedAt = performance.now(); return; }
    if (!pausedAt) return;
    const shift = performance.now() - pausedAt;
    pausedAt = 0;
    state.local.lastDamageAt += shift;
    for (const [id, t] of lastHitAt) lastHitAt.set(id, t + shift);
  });
  debug.combat = debug.combat || {};
  Object.assign(debug.combat, {
    godMode: (on = true) => { setGodMode(on); return godMode; },
    damageAt,
    suspicion: () => Object.fromEntries(suspicion),
  });
}
