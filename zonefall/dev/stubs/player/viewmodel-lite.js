// ZONEFALL dev harness helper (PLAYER group): first-person weapon for the harness's FP view (the game's real one is
// combat/viewmodel.js). The active weapon GLB in an overlay scene, hip pose with sway and bob, ADS moves the
// WEAPONS[w].model.eye point onto the camera axis, kick per shot. Hidden outside 'fp' mode and at full scope.
import * as THREE from 'three';
import { WEAPONS, RENDER } from '../../../src/config.js';
import { on, EV } from '../../../src/core/bus.js';
import { state, gfx, localPlayer } from '../../../src/core/state.js';
import * as assets from '../../../src/engine/assets.js';
import * as renderer from '../../../src/engine/renderer.js';
import * as input from '../../../src/engine/input.js';
import * as controller from '../../../src/player/controller.js';

const overlay = new THREE.Scene();
const rig = new THREE.Group();
const holder = new THREE.Group();
const models = new Map();
let current = null, kick = 0, kickV = 0, swayX = 0, swayY = 0;
const HIP = new THREE.Vector3(0.17, -0.16, -0.36);

export function init() {
  overlay.add(rig);
  rig.add(holder);
  const sun = new THREE.DirectionalLight(RENDER.sunColor, RENDER.sunIntensity * 0.8);
  sun.position.set(...RENDER.sunDir);
  overlay.add(sun);
  renderer.setOverlay(overlay, gfx.camera);
  on(EV.WEAPON_FIRE, ({ id, weapon }) => {
    if (id !== state.selfId) return;
    const r = WEAPONS[weapon] && WEAPONS[weapon].recoil;
    kickV += (r ? r.viewKickZ : 0.04) * 16;
  });
}

function model(id) {
  if (models.has(id)) return models.get(id);
  const W = WEAPONS[id];
  const m = assets.cloneModel(W.model.key);
  m.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  if (W.model.scope) {
    const sc = assets.model(W.model.scope.key).scene.getObjectByName(W.model.scope.node).clone(true);
    sc.position.add(new THREE.Vector3(...W.model.scope.offset));
    m.add(sc);
  }
  models.set(id, m);
  return m;
}

export function update(dt) {
  const me = localPlayer();
  const show = !!me && state.local.mode === 'fp' && !state.local.scoped && me.weapon && WEAPONS[me.weapon] && WEAPONS[me.weapon].model && WEAPONS[me.weapon].class !== 'lethal';
  rig.visible = show;
  if (!show) return;
  if (current !== me.weapon) {
    holder.clear();
    holder.add(model(me.weapon));
    current = me.weapon;
  }
  const W = WEAPONS[me.weapon];
  const ads = state.local.ads || 0;
  const m = input.mouse();
  swayX += (-m.dx * 0.00025 - swayX) * Math.min(1, dt * 10);
  swayY += (m.dy * 0.00025 - swayY) * Math.min(1, dt * 10);
  kickV += (-260 * kick - 26 * kickV) * dt; kick += kickV * dt;
  const g = controller.gait();
  const bob = Math.min(1, (me.speed || 0) / 6.9) * (1 - ads);
  const eye = new THREE.Vector3(...W.model.eye);
  // hip: weapon origin at HIP; ads: eye point on the camera axis 0.0 m ahead
  const hipPos = HIP.clone();
  const adsPos = eye.clone().negate();
  holder.position.lerpVectors(hipPos, adsPos, ads * ads * (3 - 2 * ads));
  holder.position.x += swayX * (1 - ads * 0.8) + Math.sin(g.phase * Math.PI * 2) * 0.012 * bob;
  holder.position.y += swayY * (1 - ads * 0.8) - Math.abs(Math.sin(g.phase * Math.PI * 2)) * 0.012 * bob;
  holder.position.z += kick;
  holder.rotation.set(kick * 1.6 + swayY * 2, swayX * 2, -0.04 * (1 - ads));
  rig.position.copy(gfx.camera.position);
  rig.quaternion.copy(gfx.camera.quaternion);
}
