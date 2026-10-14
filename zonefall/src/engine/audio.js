// ZONEFALL - Web Audio engine and the event-to-sound map. OWNER: COMBAT. Contract: ARCHITECTURE.md 5.3 and 10.
// STUB. Buses: master -> {sfx, ui, ambience} with volumes from core/settings (listen to SETTINGS_CHANGED, 'muted').
// Files: config.AUDIO manifest, config.audioUrl(name or name_i). Decode once; trim leading near-silence (|x| < 1e-3)
// on transient sounds (MP3 encoder padding). Variants are picked round-robin with playbackRate jitter +-4 %.
// Spatial: PannerNode 'HRTF' within 25 m, 'equalpower' beyond; distance model 'inverse' (ref 2 m, rolloff 1.1);
// gunshots far away get a low-pass (cutoff falls with distance) and arrive delayed by distance / 343 m/s.
// Voice limits: 32 total, 6 per gunshot sample (oldest fades out over 30 ms).
// Subscribes to the bus itself (sound on every action, see the table in ARCHITECTURE.md 10).
import { notImplemented } from '../core/util.js';

/** Create the AudioContext (suspended) and buses. */
export function init() { notImplemented('engine/audio.init'); }

/** Resume the context; call from the first user gesture (menu click). */
export function unlock() { notImplemented('engine/audio.unlock'); }

export function isUnlocked() { notImplemented('engine/audio.isUnlocked'); }

/** Fetch and decode every file in config.AUDIO. @param {(p:number) => void} onProgress */
export async function loadAll(onProgress) { notImplemented('engine/audio.loadAll'); }

/**
 * Play a 2D sound. name = AUDIO key (variant chosen automatically).
 * @param {string} name
 * @param {{volume?:number, rate?:number, jitter?:number, bus?:'sfx'|'ui'|'ambience', delay?:number}} [opts]
 * @returns {{stop:(fade?:number) => void}|null}
 */
export function play(name, opts = {}) { notImplemented('engine/audio.play'); }

/** Play a positional sound at [x, y, z]. Same opts as play plus {refDistance, maxDistance}. */
export function playAt(name, pos, opts = {}) { notImplemented('engine/audio.playAt'); }

/** Weapon report: pos null = local (2D, louder, with a synthesized low thump layer). */
export function gunshot(weaponId, pos = null) { notImplemented('engine/audio.gunshot'); }

/** Footstep by surface; pos null = local. */
export function footstep(surface, pos = null, opts = {}) { notImplemented('engine/audio.footstep'); }

/** Bullet impact sound by surface at pos. */
export function impact(surface, pos) { notImplemented('engine/audio.impact'); }

export function explosion(pos) { notImplemented('engine/audio.explosion'); }

/** UI sound: 'hover' | 'click' | 'confirm' | 'back' | 'error' | 'tick' | 'go'. */
export function ui(name) { notImplemented('engine/audio.ui'); }

/**
 * Looping channel (one sound per channel, cross-faded over 0.6 s). channel: 'ambience' | 'vehicle' | 'zone' | 'heartbeat'.
 * name null stops the channel. volume can be updated every frame.
 */
export function loop(channel, name, volume = 1) { notImplemented('engine/audio.loop'); }

/** Listener follows this object (gfx.camera) every update. */
export function setListener(object3d) { notImplemented('engine/audio.setListener'); }

export function update(dt) { notImplemented('engine/audio.update'); }
