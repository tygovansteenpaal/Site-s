// ZONEFALL - in-match HUD. OWNER: UI. Contract: ARCHITECTURE.md 9.2.
// STUB. Compass strip (top centre, heading from the local yaw, POI bearings), minimap (top right, via ui/map.js) with
// players-alive and kills counters and the zone timer under it, kill feed (right, 5 lines, 5 s), health bar + three
// armor plate segments + carried plates (bottom left), weapon name / mag / reserve / frags (bottom right), dynamic
// crosshair from state.local.spread (hidden at full ADS), hitmarkers (HIT_CONFIRMED: white, red on kill, distinct
// headshot), damage direction arcs (PLAYER_DAMAGED dir), low-health vignette, gas tint while outside the zone,
// interaction prompt from state.local.nearby, action progress ring (state.local.action/actionT), plane/freefall/chute
// prompts and altimeter, sniper scope overlay when state.local.scoped, scoreboard on Tab, FPS when settings.showFps.
import { notImplemented } from '../core/util.js';

export function mount(root) { notImplemented('ui/hud.mount'); }
export function show() { notImplemented('ui/hud.show'); }
export function hide() { notImplemented('ui/hud.hide'); }
export function update(dt) { notImplemented('ui/hud.update'); }
