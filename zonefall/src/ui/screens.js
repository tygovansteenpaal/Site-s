// ZONEFALL - death, spectate, results and pause overlays. OWNER: UI. Contract: ARCHITECTURE.md 9.
// STUB. Death: "ELIMINATED" + killer name, weapon, headshot, distance (state.local.killer), placement, kills, damage;
// buttons SPECTATE / LEAVE MATCH. Spectating bar: target name, previous/next, LEAVE MATCH. Results (state.app
// 'results'): VICTORY ("LAST ONE STANDING") or placement, kills, damage, headshots, longest kill, time survived;
// PLAY AGAIN (same mode) / MAIN MENU. Pause (Escape / lost pointer lock): RESUME, SETTINGS, LEAVE MATCH; practice
// mode freezes the simulation (UI_INTENT 'pause'/'resume').
import { notImplemented } from '../core/util.js';

export function mount(root) { notImplemented('ui/screens.mount'); }
export function showDeath(info) { notImplemented('ui/screens.showDeath'); }
export function showSpectate(targetName) { notImplemented('ui/screens.showSpectate'); }
export function showResults(info) { notImplemented('ui/screens.showResults'); }
export function showPause(open) { notImplemented('ui/screens.showPause'); }
export function hideAll() { notImplemented('ui/screens.hideAll'); }
