// ZONEFALL - UI facade: screen switching and per-frame HUD refresh. OWNER: UI. Contract: ARCHITECTURE.md 5.7 and 9.
// STUB. Plain DOM inside #ui (no framework). Screens follow state.app (APP_STATE): loading, menu, lobby, match
// (hud + overlays), results. Every interactive element plays audio.ui('hover'/'click') and sends intents with
// emit(EV.UI_INTENT, {type, ...}) (types in ARCHITECTURE.md 9.3); the UI never calls net/game modules directly,
// except read-only getters (lobby.get(), world.getMapImage(), renderer.stats(), session.diagnostics()).
import { notImplemented } from '../core/util.js';

/** Mount all screens into root and show the loading screen. Must not depend on the renderer (runs first at boot). */
export function init(root) { notImplemented('ui/ui.init'); }

/** Per frame: HUD values from state (health, armor, ammo, compass, zone timer, minimap, prompts). */
export function update(dt) { notImplemented('ui/ui.update'); }

/** Loading screen progress (p 0..1, label). */
export function setLoading(p, label) { notImplemented('ui/ui.setLoading'); }

/** Transient message (TOAST events also land here). kind: 'info' | 'warn' | 'danger'. */
export function toast(text, kind = 'info', ms = 2600) { notImplemented('ui/ui.toast'); }

/** Branded unrecoverable error screen with a Reload button (main.js falls back to its own overlay if this throws). */
export function fatal(title, detail) { notImplemented('ui/ui.fatal'); }
