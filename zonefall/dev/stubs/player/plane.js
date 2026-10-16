// ZONEFALL dev harness stand-in for src/game/plane.js (PLAYER group). Not shipped in the game.
// A procedural high-wing four-engine transport flying the harness drop line, so the plane camera and the jump can be
// tested: lathe fuselage, tapered wing, T-tail, nacelles with spinning prop discs, open rear ramp.
import * as THREE from 'three';
import * as assets from '../../../src/engine/assets.js';
import { state } from '../../../src/core/state.js';
import { planePosAt } from './match.js';

let group = null, props = [];
const pos = new THREE.Vector3(), pos2 = new THREE.Vector3(), dir = new THREE.Vector3(0, 0, -1);

export function init(scene) {
  group = new THREE.Group();
  group.name = 'transport';
  const skin = assets.pbr('green_metal_rust', { tint: 0x8f978a, roughness: 0.75, metalness: 1 }).clone();
  skin.map = skin.map.clone(); skin.map.repeat.set(6, 2);
  const dark = new THREE.MeshStandardMaterial({ color: 0x23261f, roughness: 0.6, metalness: 0.4 });
  // fuselage: radius profile along the length (nose at -z)
  const prof = [];
  const L = 30;
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    let r = 2.0;
    if (t < 0.12) r = 2.0 * Math.sqrt(t / 0.12) * 0.95 + 0.1;
    if (t > 0.7) r = 2.0 - (t - 0.7) / 0.3 * 1.25;
    prof.push(new THREE.Vector2(Math.max(0.05, r), t * L - L / 2));
  }
  const fus = new THREE.Mesh(new THREE.LatheGeometry(prof, 28), skin);
  fus.rotation.x = -Math.PI / 2;
  fus.castShadow = true;
  group.add(fus);
  // wing (tapered, slight dihedral)
  const ws = new THREE.Shape();
  ws.moveTo(-20, 1.2); ws.lineTo(20, 1.2); ws.lineTo(20, -1.0); ws.lineTo(-20, -1.0); ws.closePath();
  const wing = new THREE.Mesh(new THREE.ExtrudeGeometry(ws, { depth: 0.45, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.1, bevelSegments: 2 }), skin);
  wing.rotation.x = Math.PI / 2;
  wing.position.set(0, 2.15, -2.5);
  wing.scale.set(1, 1.6, 1);
  wing.castShadow = true;
  group.add(wing);
  // T-tail
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.4, 6.5, 4.2), skin);
  fin.position.set(0, 4.2, 12.8); fin.rotation.x = -0.25; fin.castShadow = true;
  const stab = new THREE.Mesh(new THREE.BoxGeometry(14, 0.35, 2.8), skin);
  stab.position.set(0, 7.1, 14.0); stab.castShadow = true;
  group.add(fin, stab);
  // nacelles and props
  for (const x of [-11.5, -5.8, 5.8, 11.5]) {
    const nac = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.6, 5, 16), skin);
    nac.rotation.x = Math.PI / 2; nac.position.set(x, 1.6, -4.4); nac.castShadow = true;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(2.1, 32), new THREE.MeshBasicMaterial({ color: 0x15170f, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
    disc.position.set(x, 1.6, -7.0);
    const hub = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.0, 14), dark);
    hub.rotation.x = -Math.PI / 2; hub.position.set(x, 1.6, -7.3);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(4.1, 0.28, 0.06), dark);
    blade.position.set(x, 1.6, -7.05);
    props.push(blade);
    group.add(nac, disc, hub, blade);
  }
  // open rear ramp (dark interior visible)
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 5), skin);
  ramp.position.set(0, -1.2, 15.2); ramp.rotation.x = 0.35;
  const hole = new THREE.Mesh(new THREE.CircleGeometry(1.35, 24), new THREE.MeshBasicMaterial({ color: 0x050505 }));
  hole.position.set(0, -0.3, 12.6); hole.rotation.x = 0.25;
  group.add(ramp, hole);
  group.visible = false;
  scene.add(group);
}

export function update(dt) {
  if (!group) return;
  const t = state.match.time;
  planePosAt(t, pos);
  planePosAt(t + 0.1, pos2);
  dir.subVectors(pos2, pos).normalize();
  group.position.copy(pos);
  group.rotation.set(0, Math.atan2(-dir.x, -dir.z), 0);
  for (const p of props) p.rotation.z += dt * 40;
}

export function getTransform() { return { pos: pos.clone(), dir: dir.clone() }; }
export function setVisible(on) { if (group) group.visible = !!on; }
