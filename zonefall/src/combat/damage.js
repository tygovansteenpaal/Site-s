// ZONEFALL - damage, armor, death, hit validation. OWNER: COMBAT. Contract: ARCHITECTURE.md 5.3 and 8.6.
// STUB. Authority: a human owns its own HP; the host owns bot HP. Armor (up to 150) absorbs bullet and explosion
// damage before health; fall and zone damage hit health only. Regen: PLAYER.regenRate after PLAYER.regenDelay.
import { notImplemented } from '../core/util.js';

/** Subscribe to NET_HIT and NET_DEATH. */
export function init() { notImplemented('combat/damage.init'); }

/** Body damage at distance from the weapon's damage steps times the zone multiplier (head/limb). */
export function damageAt(weaponId, zone, distance) { notImplemented('combat/damage.damageAt'); }

/**
 * Route a hit made by a shooter simulated on this peer. Target local -> applyToSelf. Target bot and this peer is
 * authority (host/offline) -> bots.applyDamage. Online -> also broadcast 'hit' (everyone records, the owner applies).
 * Emits HIT_CONFIRMED for the local shooter (hitmarker) once the damage is known to land.
 * @param {{sid:number, shooter:string, target:string, weapon:string, zone:'head'|'body'|'limb', distance:number, origin:number[], targetPos:number[]}} hit
 */
export function dealHit(hit) { notImplemented('combat/damage.dealHit'); }

/**
 * Damage the local player. kind: 'bullet' | 'explosion' | 'fall' | 'zone'. Emits PLAYER_DAMAGED; at 0 hp calls kill().
 * @param {number} amount
 * @param {{from?:string|null, weapon?:string|null, zone?:string|null, dir?:number[]|null, kind:string}} info
 */
export function applyToSelf(amount, info) { notImplemented('combat/damage.applyToSelf'); }

/** Shared armor/health maths for any entity (bots on the host). @returns {{killed:boolean, armorBroke:boolean, dealt:number}} */
export function applyToEntity(entity, amount, info) { notImplemented('combat/damage.applyToEntity'); }

/**
 * Death of an entity this peer is authority for: set alive=false, life=DEAD, emit PLAYER_KILLED, broadcast 'death',
 * drop its inventory through game/loot.drop (local player: inventory.dropAll(); bots: their weapon + ammo).
 */
export function kill(victimId, killerId, weapon, headshot, sid = null) { notImplemented('combat/damage.kill'); }

/** Splash damage of an explosion at pos [x,y,z] to the local player (and bots when authority), LOS-checked. */
export function explosionAt(pos, ownerId, weapon = 'frag') { notImplemented('combat/damage.explosionAt'); }

/** Health regeneration step for an entity (used for the local player in update and by bots). */
export function regen(entity, dt) { notImplemented('combat/damage.regen'); }

/** Local regeneration and heartbeat state. */
export function update(dt) { notImplemented('combat/damage.update'); }

/** Sanity checks of an incoming hit (rate, damage cap, range, shooter position, target position history). */
export function validateHit(hit, fromPeerId) { notImplemented('combat/damage.validateHit'); }
