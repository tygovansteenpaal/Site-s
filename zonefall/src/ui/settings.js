// ZONEFALL - settings panel (used by the menu and the pause overlay). OWNER: UI. Contract: ARCHITECTURE.md 9.
// STUB. Bound to core/settings get/set: callsign, mouse sensitivity, ADS sensitivity, field of view (horizontal),
// invert Y, graphics quality (Auto/Low/Medium/High with the auto-detected tier named), master/effects/interface/
// ambience volume, show FPS; read-only controls list from input.bindings() with config.ACTION_LABELS. Changes apply live.
import { notImplemented } from '../core/util.js';

/** Build the panel into container; returns {el, refresh()}. */
export function mountSettings(container) { notImplemented('ui/settings.mountSettings'); }
