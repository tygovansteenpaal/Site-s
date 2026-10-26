// ZONEFALL - the drop plane. OWNER: GAME. Contract: ARCHITECTURE.md 5.6.
// A cartoon shark-nose prop plane (assets/vehicles/plane.glb, "Toon Plane" by Spacca, CC BY 4.0, converted by
// tools/build-models.mjs) scaled up to transport size (about 31 m long, 27 m span). The propeller node ZF_prop spins;
// navigation lights and wingtip strobes are added here. It flies match.planePath() with a little turbulence, is
// visible during the plane phase and until it leaves the map. The 'vehicle' loop (plane_loop) is driven by
// engine/audio from the local life state.
import * as THREE from 'three';
import { state, debug } from '../core/state.js';
import * as assets from '../engine/assets.js';
import * as match from './match.js';

const TUNE = {
  scale: 7.5,                   // model metres -> world metres (the source is a 4.1 m toy)
  propSpin: 28,                 // rad/s
  bobAmp: 0.35, rollAmpDeg: 1.1, pitchAmpDeg: 0.5,
  hideAfterExit: 6,             // s after reaching the end of the flight line
};

let group = null;
let prop = null;
let strobes = [];
let visible = true;
let clock = 0;
const _pos = new THREE.Vector3(), _dir = new THREE.Vector3(0, 0, -1);

// ------------------------------------------------------------------------------------------ build
function build() {
  const root = new THREE.Group();
  root.name = 'drop-plane';
  const model = assets.cloneModel('plane');
  // the model's nose points +Z with its wheels on y = 0; the group flies along its local -Z, centred on the fuselage
  const box = new THREE.Box3().setFromObject(model);
  const c = box.getCenter(new THREE.Vector3());
  model.rotation.y = Math.PI;
  model.scale.setScalar(TUNE.scale);
  model.position.set(c.x * TUNE.scale, -c.y * TUNE.scale, c.z * TUNE.scale);
  root.add(model);
  prop = model.getObjectByName('ZF_prop');
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false; o.receiveShadow = false;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m && m.transmission > 0) { m.transmission = 0; m.transparent = true; m.opacity = 0.45; }
  });
  // lights at the wingtips and the tail, in group space (scaled box)
  const half = box.getSize(new THREE.Vector3()).multiplyScalar(TUNE.scale / 2);
  const bulb = new THREE.SphereGeometry(0.22, 10, 8);
  const mk = (color, pos, list) => {
    const m = new THREE.Mesh(bulb, new THREE.MeshBasicMaterial({ color, toneMapped: true }));
    m.position.set(...pos);
    root.add(m);
    if (list) list.push(m);
  };
  const wingY = -half.y * 0.15;
  mk(new THREE.Color(6, 0.25, 0.2), [-half.x * 0.98, wingY, 0]);
  mk(new THREE.Color(0.2, 6, 0.6), [half.x * 0.98, wingY, 0]);
  mk(new THREE.Color(5, 5, 5), [0, half.y * 0.4, half.z * 0.98]);
  strobes = [];
  mk(new THREE.Color(14, 14, 14), [-half.x, wingY, 0.4], strobes);
  mk(new THREE.Color(14, 14, 14), [half.x, wingY, 0.4], strobes);
  return root;
}

// ------------------------------------------------------------------------------------------ public API
export function init(scene) {
  group = build();
  group.visible = false;
  scene.add(group);
  debug.game = debug.game || {};
  Object.assign(debug.game, { planeObject: () => group });
}

export function update(dt) {
  if (!group) return;
  clock += dt;
  const m = state.match;
  let show = visible && m.phase !== 'idle';
  if (show) {
    const p = match.planePath();
    show = m.time < p.exitAt + TUNE.hideAfterExit;
  }
  group.visible = show;
  if (!show) return;
  transformAt(m.time, _pos, _dir);
  group.position.copy(_pos);
  const yaw = Math.atan2(-_dir.x, -_dir.z);
  const roll = Math.sin(clock * 0.43) * TUNE.rollAmpDeg * Math.PI / 180 + Math.sin(clock * 1.7) * 0.15 * Math.PI / 180;
  const pitch = Math.sin(clock * 0.31 + 1.2) * TUNE.pitchAmpDeg * Math.PI / 180;
  group.rotation.set(pitch, yaw, roll, 'YXZ');
  if (prop) prop.rotation.z += TUNE.propSpin * dt;
  // wingtip strobes double-flash every 1.3 s
  const ph = clock % 1.3;
  const strobeOn = ph < 0.05 || (ph > 0.16 && ph < 0.21);
  for (const s of strobes) s.visible = strobeOn;
}

/** Plane pose at match time t into pos/dir (with the same turbulence bob the mesh shows). */
function transformAt(t, pos, dir) {
  match.planePosAt(t, pos);
  const p = match.planePath();
  dir.set(p.dir[0], 0, p.dir[2]).normalize();
  pos.y += Math.sin(clock * 0.37) * TUNE.bobAmp + Math.sin(clock * 1.13 + 0.6) * TUNE.bobAmp * 0.25;
  return pos;
}

/** {pos: Vector3, dir: Vector3} of the plane now (copies). */
export function getTransform() {
  const pos = new THREE.Vector3(), dir = new THREE.Vector3();
  if (state.match.phase === 'idle') return { pos: pos.set(0, 380, 0), dir: dir.set(0, 0, -1) };
  transformAt(state.match.time, pos, dir);
  return { pos, dir };
}

export function setVisible(on) {
  visible = !!on;
  if (group && !visible) group.visible = false;
}
