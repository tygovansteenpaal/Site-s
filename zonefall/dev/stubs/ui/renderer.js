// ZONEFALL dev/ui.html stand-in for engine/renderer.js (read-only getters the UI uses).
import { state } from '../../../src/core/state.js';
export function detectTier() { return 'medium'; }
export function stats() { return { fps: 60, ms: 16.6, calls: 142, tris: 612000, dpr: 1, tier: state.quality || 'medium' }; }
export function getQuality() { return {}; }
