// ZONEFALL dev harness stand-in for src/game/match.js (PLAYER group). Not shipped in the game.
// Only the plane drop timeline is real here: a straight flight line over the test course at MATCH.plane altitude and
// speed, doors open after 3 s and the forced jump at 40 s. The harness sets state.match.t0/time.
import * as THREE from 'three';
import { MATCH } from '../../../src/config.js';
import { state } from '../../../src/core/state.js';

const P = MATCH.plane;
let path = null;

/** Start a drop: the line passes over (cx, cz) heading along angle a (radians, 0 = north). */
export function setupDrop(cx = 0, cz = 0, a = Math.PI * 0.25) {
  const dx = -Math.sin(a), dz = -Math.cos(a);
  const pre = P.speed * 3.4;          // the doors open (3 s) right over the course
  path = {
    a: [cx - dx * pre, P.altitude, cz - dz * pre], b: [cx + dx * pre, P.altitude, cz + dz * pre],
    dir: [dx, 0, dz], speed: P.speed, length: pre * 2, doorsOpenAt: 3, forceJumpAt: 40,
  };
  state.match.t0 = performance.now();
  state.match.time = 0;
  state.match.phase = 'plane';
  return path;
}

export function init() {}
export function startPractice() {}
export function hostBegin() {}
export function beginFromNetwork() {}
export function update() { if (path) state.match.time = (performance.now() - state.match.t0) / 1000; }
export function leave() { path = null; state.match.phase = 'idle'; }
export function planePath() { return path || setupDrop(); }
export function planePosAt(t, out = new THREE.Vector3()) {
  const p = planePath();
  return out.set(p.a[0] + p.dir[0] * p.speed * t, p.a[1], p.a[2] + p.dir[2] * p.speed * t);
}
