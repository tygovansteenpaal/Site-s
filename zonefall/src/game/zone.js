// ZONEFALL - the shrinking circle. OWNER: GAME. Contract: ARCHITECTURE.md 2.4 and 5.6, numbers in config.ZONE.
// STUB. setup(seed) precomputes every circle with stream(seed, 'zone'): centre of phase k+1 uniformly inside
// (r_k - r_{k+1}) of centre k, retried ZONE.landRetries times until world.getHeight(centre) > 2 (land).
// Visual: a tall translucent cylinder wall (animated noise, orange-red, additive, depthWrite false, double-sided)
// plus a ground ring decal; when the local camera is outside, tint the screen (UI reads state.zone.outside) and
// raise fog. Damage: dps of the active phase to the local player (damage.applyToSelf kind 'zone', armor ignored)
// once per second while outside; host applies the same to bots. Writes state.zone every frame; emits ZONE_UPDATE
// (2 Hz and on change) and ZONE_PHASE (when a wait or shrink begins). DEV.fastZone scales all times by 0.1.
import { notImplemented } from '../core/util.js';

export function init(scene) { notImplemented('game/zone.init'); }

/** Precompute all circles for a match seed. */
export function setup(seed) { notImplemented('game/zone.setup'); }

export function update(dt) { notImplemented('game/zone.update'); }

/** Pure: current circle {x, z, r} at match time t (s). */
export function circleAt(t) { notImplemented('game/zone.circleAt'); }

/** Pure: {phase, state:'pre'|'waiting'|'shrinking'|'final', current:{x,z,r}, next:{x,z,r}, timeLeft, dps} at time t. */
export function phaseAt(t) { notImplemented('game/zone.phaseAt'); }

/** All precomputed circles [{x, z, r}] (index 0 = initial). */
export function circles() { notImplemented('game/zone.circles'); }

export function isInside(x, z) { notImplemented('game/zone.isInside'); }

export function setVisible(on) { notImplemented('game/zone.setVisible'); }
