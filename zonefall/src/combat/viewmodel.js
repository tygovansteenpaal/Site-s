// ZONEFALL - first-person weapon (and arms). OWNER: COMBAT. Contract: ARCHITECTURE.md 5.3 and 6.4.
// STUB. Own overlay Scene + PerspectiveCamera (near 0.01, FOV follows gfx.camera, registered with
// renderer.setOverlay). Preferred look: a soldier_a clone posed with the upper-body Rifle_Idle/Rifle_Aim clip, head
// bone scaled to 0, camera at the head, weapon in WeaponSocket_R, so gloved arms hold the gun; ADS moves the rig so
// the weapon's sight line (model.eye / model.sight) lands on the camera axis. Pistol uses Aim_Idle. Procedural layers:
// sway (mouse delta), bob (speed), sprint pose, ADS blend, recoil kick (viewKickZ/viewKickRotDeg, spring back),
// reload (dip + roll, MAGAZINE node drops and returns at the reload cues, bolt/slide nodes rack), plate insert dip,
// grenade throw arc, raise/lower on switch, hidden while scoped (state.local.scoped) and when not in first person.
import { notImplemented } from '../core/util.js';

export function init() { notImplemented('combat/viewmodel.init'); }
export function update(dt) { notImplemented('combat/viewmodel.update'); }

/** Recoil kick for one shot of weaponId. */
export function kick(weaponId) { notImplemented('combat/viewmodel.kick'); }

/** Approximate world-space muzzle position of the first-person weapon into out (THREE.Vector3); returns out. */
export function getMuzzle(out) { notImplemented('combat/viewmodel.getMuzzle'); }

export function setVisible(on) { notImplemented('combat/viewmodel.setVisible'); }
