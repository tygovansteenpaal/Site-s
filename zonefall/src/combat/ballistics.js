// ZONEFALL - hitscan, hitboxes, shot routing. OWNER: COMBAT. Contract: ARCHITECTURE.md 5.3 and 8.6.
// STUB. Every bullet is hitscan up to WEAPONS[w].range. Hitboxes are procedural capsules from entity pos/yaw/flags
// (no bone reads), so every peer computes identical boxes:
//   standing: head sphere c = pos + (0, 1.62, 0) r 0.13 | body capsule y 0.95..1.45 r 0.24 | limb capsule y 0.10..0.95 r 0.17
//   crouch: multiply heights by 0.68 | slide/freefall/chute: body capsule lies along the facing direction, see 6.5.
// Remote entities are tested at their interpolated (rendered) pose: favour the shooter.
import { notImplemented } from '../core/util.js';

/** Subscribe to NET_SHOT: remote/bot shots become WEAPON_FIRE {local:false} for vfx/audio, plus BULLET_NEAR checks. */
export function init() { notImplemented('combat/ballistics.init'); }

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
export function fire(shooterId, weaponId, origin, dir, opts = {}) { notImplemented('combat/ballistics.fire'); }

/**
 * Nearest hit along a ray against the world (world.raycast) and all living player hitboxes except ignoreId.
 * @returns {{kind:'player', id:string, zone:string, distance:number, point:import('three').Vector3}|{kind:'world', surface:number, distance:number, point:import('three').Vector3, normal:import('three').Vector3}|null}
 */
export function hitscan(origin, dir, range, ignoreId) { notImplemented('combat/ballistics.hitscan'); }

/** Procedural hitbox capsules of an entity: [{zone, a: Vector3, b: Vector3, r}] (sphere when a equals b). */
export function hitboxes(entity) { notImplemented('combat/ballistics.hitboxes'); }

/** Ray vs player hitboxes only: {id, zone, distance, point} or null. */
export function rayPlayers(origin, dir, range, ignoreId) { notImplemented('combat/ballistics.rayPlayers'); }
