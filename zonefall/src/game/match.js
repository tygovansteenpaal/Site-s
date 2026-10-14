// ZONEFALL - match lifecycle and timeline. OWNER: GAME. Contract: ARCHITECTURE.md 2 and 5.6.
// STUB. Phases (state.match.phase): idle -> plane (t0 .. last player out) -> live -> ended. All timing derives from
// state.match.time = (performance.now() - t0) / 1000, so every peer agrees without messages.
// begin(): resetMatchState(), create an entity per roster entry (local kind 'local', other humans 'remote', bots 'bot'
// owned by the host), inventory.reset(), controller.spawn('plane') (or 'ground' with DEV.skipPlane), zone.setup(seed),
// loot.setup(seed), bots.setup(...), emit MATCH_START. Alive counting, placement and kill/damage counters from
// PLAYER_KILLED / PLAYER_DAMAGED; when <= 1 alive: phase 'ended', MATCH_END {winnerId, placement, stats}.
// Host migration: on HOST_CHANGED to self during a match -> bots.takeOver().
import { notImplemented } from '../core/util.js';

export function init() { notImplemented('game/match.init'); }

/** Offline match: self + bots (MATCH.maxPlayers - 1, or DEV.bots). seed: DEV.seed or random. */
export function startPractice(opts = {}) { notImplemented('game/match.startPractice'); }

/**
 * Host: build the roster (humans in join order, then bots to MATCH.maxPlayers), pick seed and match id, broadcast
 * 'start' {mid, seed, t0h: now + MATCH.startLeadMs, th: now, ro, ep}, then begin locally.
 * @param {Array<{id:string, name:string}>} humans
 */
export function hostBegin(humans) { notImplemented('game/match.hostBegin'); }

/** Non-host: begin from a validated 'start' payload; t0 = t0h + sync.clockOffset(from) (fallback: now + (t0h - th) - rtt/2). */
export function beginFromNetwork(start, fromPeerId) { notImplemented('game/match.beginFromNetwork'); }

export function update(dt) { notImplemented('game/match.update'); }

/** Leave the current match (local cleanup, resetMatchState). The caller decides the next app state. */
export function leave() { notImplemented('game/match.leave'); }

/**
 * Plane flight line for the current seed: {a: [x,y,z], b: [x,y,z], dir: [x,0,z], speed, length, doorsOpenAt, forceJumpAt}
 * (times in match seconds). Deterministic from the match seed (stream 'plane').
 */
export function planePath() { notImplemented('game/match.planePath'); }

/** Plane position at match time t (s) into out (THREE.Vector3); returns out. */
export function planePosAt(t, out) { notImplemented('game/match.planePosAt'); }
