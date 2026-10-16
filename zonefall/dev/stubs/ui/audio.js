// ZONEFALL dev/ui.html stand-in for engine/audio.js (UI harness only). Plays the real assets/audio/ui_*.mp3 files with
// plain WebAudio so hover/click/confirm sounds can be judged without the COMBAT audio engine.
import { audioUrl } from '../../../src/config.js';

let ctx = null;
const buffers = new Map();
const NAMES = ['hover', 'click', 'confirm', 'back', 'error', 'tick', 'go'];

export function init() {}
export function unlock() {
  if (!ctx) {
    ctx = new AudioContext();
    for (const n of NAMES) {
      fetch(audioUrl('ui_' + n)).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b)).then((buf) => buffers.set(n, buf)).catch(() => {});
    }
  }
  if (ctx.state !== 'running') ctx.resume();
}
export function isUnlocked() { return !!ctx && ctx.state === 'running'; }
export function ui(name) {
  if (!NAMES.includes(name)) throw new Error(`[stub audio] unknown ui sound '${name}'`);
  const buf = buffers.get(name);
  if (!ctx || !buf) return null;
  const src = ctx.createBufferSource();
  const g = ctx.createGain();
  g.gain.value = name === 'hover' ? 0.3 : 0.55;
  src.buffer = buf;
  src.playbackRate.value = 1 + (Math.random() - 0.5) * 0.08;
  src.connect(g).connect(ctx.destination);
  src.start();
  return src;
}
export const loadAll = async () => {};
export const play = () => null;
export const playAt = () => null;
export const gunshot = () => null;
export const footstep = () => null;
export const impact = () => null;
export const explosion = () => null;
export const loop = () => null;
export const setListener = () => {};
export const update = () => {};
