// ZONEFALL - frag grenades (thrown, bouncing, exploding). OWNER: COMBAT. Contract: ARCHITECTURE.md 5.3, config.WEAPONS.frag.
// STUB. Deterministic simulation on every peer from the 'nade' message (fixed 1/120 s steps, raycast vs world,
// restitution/friction, GRENADE_BOUNCE events); late receivers fast-forward by (match time now - t).
// On explosion: GRENADE_EXPLODE, damage.explosionAt (each peer applies to itself; host to bots), camera shake by distance.
import { notImplemented } from '../core/util.js';

export function init(scene) { notImplemented('combat/grenades.init'); }

/** Throw from the local eye along the aim with WEAPONS.frag.throwSpeed (+ upBoost, + player velocity); fuse - cookSeconds. */
export function throwLocal(cookSeconds) { notImplemented('combat/grenades.throwLocal'); }

/**
 * Start simulating a grenade (local throw, bot throw on host, or NET_NADE).
 * @param {{gid:string, owner:string, origin:number[], vel:number[], fuse:number, t:number}} g  t = match time ms at throw
 */
export function spawn(g) { notImplemented('combat/grenades.spawn'); }

export function update(dt) { notImplemented('combat/grenades.update'); }

/** Number of live grenades. */
export function count() { notImplemented('combat/grenades.count'); }
