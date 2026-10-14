// ZONEFALL - bot players, simulated on the host only. OWNER: GAME. Contract: ARCHITECTURE.md 5.6 and 8.5, tuning in config.BOTS.
// STUB. Each bot is a normal entity (kind 'bot', id botId(slot), owner = host). Behaviour (think at BOTS.thinkHz,
// move every frame): plane -> jump over a chosen site (seeded) -> freefall/chute toward it -> loot (walk to nearby items
// via loot.nearest, take them with loot.pickup(uid, botId), BOTS.lootTime) -> roam toward the safe zone along roads
// -> engage visible enemies (world.lineOfSight, BOTS.viewDistance/fovDeg, hearing gunshots within BOTS.hearing),
// reaction delay, aim error that settles over time, bursts, strafing, crouching behind cover, plating when low
// -> leave the gas. Movement uses world.getGround + world.collideCapsule with the same speeds as players.
// Firing uses ballistics.fire(botId, weapon, headPos, dir, {spreadDeg}) so damage, vfx, sound and SHOT broadcast are shared.
import { notImplemented } from '../core/util.js';

export function init() { notImplemented('game/bots.init'); }

/** Create bot state for the roster's bots (entities already exist). @param {Array<{id:string, name:string, slot:number}>} roster */
export function setup(roster, seed) { notImplemented('game/bots.setup'); }

/** Host only (state.isHost): AI and movement for every living bot. No-op on non-hosts. */
export function update(dt) { notImplemented('game/bots.update'); }

/** Host: apply damage to a bot (combat/damage.applyToEntity); on death combat/damage.kill. */
export function applyDamage(botId, amount, info) { notImplemented('game/bots.applyDamage'); }

/** Became host mid-match: rebuild AI state from the current entities (positions/hp come from the last snapshots). */
export function takeOver() { notImplemented('game/bots.takeOver'); }

/** Ids of all bots in the match. */
export function list() { notImplemented('game/bots.list'); }
