// ZONEFALL dev harness stand-in for src/game/match.js (COMBAT group). Not shipped in the game.
// The range has no plane; the timeline is a running clock the harness started.
import * as THREE from 'three';
import { state } from '../../../src/core/state.js';
export function init() {}
export function startPractice() {}
export function hostBegin() {}
export function beginFromNetwork() {}
export function update() { state.match.time = (performance.now() - state.match.t0) / 1000; }
export function leave() {}
export function planePath() { return { a: [0, 380, 600], b: [0, 380, -600], dir: [0, 0, -1], speed: 55, length: 1200 }; }
export function planePosAt(t, out = new THREE.Vector3()) { return out.set(0, 380, 600 - 55 * t); }
