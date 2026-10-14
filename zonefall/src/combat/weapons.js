// ZONEFALL - local weapon handling. OWNER: COMBAT. Contract: ARCHITECTURE.md 5.3 and 6 (gun feel).
// STUB. One state machine for the local player: idle | firing | reloading | switching | plating | throwing | bolting.
// Reads input (fire, ads, reload, slot1/2, swap, plate, grenade, sprint=hold breath while scoped) only when the local
// entity is GROUND and alive. Fire: rate from rpm, mode auto/semi/bolt, sprint-to-fire delay, spread cone
// (state.local.spread) from config spread params, recoil pattern (config comment) -> camera.addRecoil,
// viewmodel.kick, camera.addShake(recoil.shake * 0.3), ballistics.fire(...). Reload with cue events
// (WEAPON_RELOAD phases magout/magin/charge at reloadCues fractions) and interruptible by sprint/switch/fire (when mag>0).
// ADS: state.local.ads approaches 1 over WEAPONS[w].ads seconds (0 while sprinting/reloading on bolt), adsFov =
// verticalFov * adsFovMult, scoped = scope && ads > 0.9. Plates: hold plate key inserts plates one by one
// (PLAYER.armor.insertTime each, max 3 equipped) -> PLATE_START/PLATE_DONE; grenade: hold G cooks, release throws
// (grenades.throwLocal(cook)), cook >= fuse explodes in hand. Writes ADS/FIRING/RELOAD/THROW/PLATE flags and entity.weapon.
import { notImplemented } from '../core/util.js';

export function init() { notImplemented('combat/weapons.init'); }

export function update(dt) { notImplemented('combat/weapons.update'); }

/** Abort reload/plating/cook (on death, on leaving GROUND). */
export function cancelActions() { notImplemented('combat/weapons.cancelActions'); }

/** True while an action blocks interaction (reload, plate, throw, switch). */
export function isBusy() { notImplemented('combat/weapons.isBusy'); }
