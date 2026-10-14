// ZONEFALL - transport aircraft for the drop. OWNER: GAME. Contract: ARCHITECTURE.md 5.6.
// STUB. Procedural high-wing four-turboprop transport (~30 m long, 40 m span, T-tail, open rear ramp) built from
// Lathe/Extrude geometry with green_metal_rust / concrete-grey PBR materials, spinning blurred propeller discs,
// navigation and strobe lights, contrails optional. Flies along match.planePath(); visible during the plane phase
// and until it leaves the map. Drives the audio 'vehicle' loop (plane_loop) by distance to the camera.
import { notImplemented } from '../core/util.js';

export function init(scene) { notImplemented('game/plane.init'); }
export function update(dt) { notImplemented('game/plane.update'); }

/** {pos: Vector3, dir: Vector3} of the plane now (copies). */
export function getTransform() { notImplemented('game/plane.getTransform'); }

export function setVisible(on) { notImplemented('game/plane.setVisible'); }
