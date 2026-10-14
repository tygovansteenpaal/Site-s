// ZONEFALL - ground loot, crates, pickups, drops. OWNER: GAME. Contract: ARCHITECTURE.md 3.5 and 5.6, tables in config.LOOT.
// STUB. setup(seed): for each world.getLootSpawns() entry in order, with stream(seed, 'loot'): floor spawns get an item
// with probability LOOT.floorChance[tier] (kind by LOOT.kinds weights, weapon by LOOT.weapons, quantities from
// LOOT.*Qty), uid `s${id}` (+ `s${id}a` for the ammo that accompanies a weapon); crate spawns get crate uid `k${id}`
// whose LOOT.crateItems contents (uids `c${id}.${k}`, tier min(tier+1, 2)) are generated only when it opens.
// Visuals: weapon models lying on their side, ammo_box for ammo, a procedural plate stack (RoundedBoxGeometry, dark
// ceramic), frag model; a soft rarity glow disc under each item; per-type instancing where possible; culled beyond
// 120 m. update(): state.local.nearby = closest item/crate within PLAYER.interactRange in view, LOOT_NEARBY on change.
// Picks: optimistic local take + 'pick' {uid, t}; conflicts resolved by earliest t, then lowest peer id
// (LOOT.pickConflictMs window, loser calls inventory.revert and gets a toast).
import { notImplemented } from '../core/util.js';

export function init(scene) { notImplemented('game/loot.init'); }

/** Generate the match's items from the world spawn points. */
export function setup(seed) { notImplemented('game/loot.setup'); }

export function update(dt) { notImplemented('game/loot.update'); }

/** Local interact press: pick up state.local.nearby (item) or open it (crate). Returns true if something happened. */
export function interact() { notImplemented('game/loot.interact'); }

/** Apply a pick of uid by a player/bot id (local, NET_PICK, or bot on host). Returns true if the item existed. */
export function pickup(uid, by) { notImplemented('game/loot.pickup'); }

/**
 * Spawn items on the ground around pos (death drop or swapped weapon) and broadcast 'drop' if this peer is the owner.
 * @param {Array<{type:string, ref:string|null, qty:number}>} items
 * @param {number[]} pos [x, y, z]
 * @param {string} ownerId  used for uids `d${short(ownerId)}.${n}`
 */
export function drop(items, pos, ownerId) { notImplemented('game/loot.drop'); }

/** Closest item or crate to pos within maxDist (metres), or null. Bots use it too. */
export function nearest(pos, maxDist) { notImplemented('game/loot.nearest'); }

/** Map uid -> Item ({uid, type, ref, qty, pos:[x,y,z], tier, crate?:boolean, opened?:boolean}). */
export function all() { notImplemented('game/loot.all'); }

/** Remove every item and visual (match end). */
export function clear() { notImplemented('game/loot.clear'); }
