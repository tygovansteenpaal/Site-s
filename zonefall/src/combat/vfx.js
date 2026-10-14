// ZONEFALL - visual effects. OWNER: COMBAT. Contract: ARCHITECTURE.md 5.3.
// STUB. Pooled and instanced (no per-shot allocations): muzzle flash (2-3 crossed additive quads + short PointLight on
// medium/high), tracers (every shot for remote/bot fire, every 3rd for local), impact puffs by surface (dust, sparks
// on metal, splinters on wood, water splash), bullet-hole decals (quality.decals ring buffer), blood puff on flesh,
// explosion (fireball sprite sheet generated on a canvas at init, smoke, debris, light flash), landing dust.
// All textures are generated procedurally at init (canvas gradients/noise); nothing is downloaded.
// Subscribes to WEAPON_FIRE, GRENADE_EXPLODE, PLAYER_LAND, PLAYER_DAMAGED by itself.
import { notImplemented } from '../core/util.js';

export function init(scene) { notImplemented('combat/vfx.init'); }
export function update(dt) { notImplemented('combat/vfx.update'); }

/** @param {number[]} pos @param {number[]} dir @param {number} [scale] */
export function muzzleFlash(pos, dir, scale = 1) { notImplemented('combat/vfx.muzzleFlash'); }
/** @param {number[]} from @param {number[]} to */
export function tracer(from, to) { notImplemented('combat/vfx.tracer'); }
/** @param {number[]} point @param {number[]} normal @param {number} surface config.SURFACE id */
export function impact(point, normal, surface) { notImplemented('combat/vfx.impact'); }
/** @param {number[]} point @param {number[]} dir */
export function blood(point, dir) { notImplemented('combat/vfx.blood'); }
/** @param {number[]} point */
export function explosion(point) { notImplemented('combat/vfx.explosion'); }
/** @param {number[]} point @param {number} amount 0..1 */
export function dust(point, amount = 1) { notImplemented('combat/vfx.dust'); }
