// ZONEFALL dev harness stand-in for src/game/plane.js (COMBAT group). Not shipped in the game: the range has no plane.
import * as THREE from 'three';
const pos = new THREE.Vector3(0, 380, 0), dir = new THREE.Vector3(0, 0, -1);
export function init() {}
export function update() {}
export function getTransform() { return { pos, dir }; }
export function setVisible() {}
