// ZONEFALL - minimap and full map. OWNER: UI. Contract: ARCHITECTURE.md 9.2.
// STUB. Base image world.getMapImage() (1024 px, north up, util.worldToMap). Minimap: 200 px rotating-with-player
// square (or north-up, setting-free choice of the builder) at 150 m view radius: self arrow, current zone (white line),
// next zone (dashed), gas outside shaded, red pings for unsuppressed enemy fire within 60 m for 1.5 s. Full map (M):
// whole island, POI and landmark names from core/mapdata.js, roads, plane path line during the plane phase, zone
// circles, self marker, scale bar, legend.
import { notImplemented } from '../core/util.js';

export function mount(root) { notImplemented('ui/map.mount'); }
/** Provide the base map image (called once after world.build). */
export function setImage(canvas) { notImplemented('ui/map.setImage'); }
export function updateMinimap(dt) { notImplemented('ui/map.updateMinimap'); }
export function setBigOpen(open) { notImplemented('ui/map.setBigOpen'); }
export function isBigOpen() { notImplemented('ui/map.isBigOpen'); }
