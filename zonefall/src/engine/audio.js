// ZONEFALL - Web Audio engine and the event-to-sound map. OWNER: COMBAT. Contract: ARCHITECTURE.md 5.3 and 10.
// Graph: voices -> {sfx, ui, ambience} buses -> master -> pause low-pass -> limiter -> destination, plus a shared
// outdoor reverb (procedural impulse response) that gunshots, explosions and distant sounds send into.
// Files: config.AUDIO manifest via config.audioUrl(name or name_i). Decoded once (OfflineAudioContext, so loading
// needs no user gesture); leading near-silence (|x| < 1e-3) is trimmed from transient sounds (MP3 encoder padding).
// Variants are picked round-robin with playbackRate jitter +-4 %.
// Spatial: PannerNode 'HRTF' within 25 m, 'equalpower' beyond; distance model 'inverse' (ref 2 m, rolloff 1.1);
// gunshots and explosions far away get a low-pass whose cutoff falls with distance and arrive delayed by d / 343 m/s.
// Every gunshot is layered: the recorded report + a synthesized sub thump + a noise crack (local), a slap-back
// echo and a reverb tail that grow with distance (remote), and casings for rifles and pistols.
// Voice limits: 32 total, 6 per gunshot sample (the oldest fades out over 30 ms).
// Subscribes to the bus itself (sound on every action, ARCHITECTURE.md 10). Loops ('ambience', 'vehicle', 'zone',
// 'heartbeat') are driven from state in update().
import { AUDIO, WEAPONS, SURFACE, PLAYER, audioUrl } from '../config.js';
import { on, EV, registerEvents } from '../core/bus.js';
import { state, localPlayer, LIFE, APP } from '../core/state.js';
import * as settings from '../core/settings.js';
import { clamp } from '../core/util.js';

const TUNE = {
  maxVoices: 32,
  perSample: 6,
  stealFade: 0.03,
  loopFade: 0.6,
  hrtfRange: 25,
  refDistance: 2, rolloff: 1.1,
  gunRef: 9, gunRolloff: 1.0, gunAudible: 900,
  speedOfSound: 343,
  trimThreshold: 1e-3,
  jitter: 0.04,
  reverbSeconds: 2.2,
  local: { gun: 0.78, thump: 0.55, crack: 0.22, casing: 0.22, reverb: 0.16 },
  footsteps: { sprint: 0.62, walk: 0.42, crouch: 0.2, remoteRef: 3 },
  pauseCutoff: 600,
};
const LOOPS = new Set(['wind_loop', 'plane_loop', 'freefall_loop', 'chute_loop', 'zone_hum_loop', 'heartbeat_loop']);
const IMPACT_MAP = {
  [SURFACE.CONCRETE]: 'impact_concrete', [SURFACE.ASPHALT]: 'impact_concrete', [SURFACE.ROCK]: 'impact_rock',
  [SURFACE.GRASS]: 'impact_dirt', [SURFACE.DIRT]: 'impact_dirt', [SURFACE.SAND]: 'impact_dirt', [SURFACE.WOOD]: 'impact_wood',
  [SURFACE.METAL]: 'impact_metal', [SURFACE.GLASS]: 'impact_glass', [SURFACE.FLESH]: 'hit_body',
};
const STEP_MAP = {
  [SURFACE.CONCRETE]: 'footstep_concrete', [SURFACE.ASPHALT]: 'footstep_concrete', [SURFACE.ROCK]: 'footstep_concrete',
  [SURFACE.METAL]: 'footstep_concrete', [SURFACE.GRASS]: 'footstep_grass', [SURFACE.WOOD]: 'footstep_wood',
  [SURFACE.DIRT]: 'footstep_gravel', [SURFACE.SAND]: 'footstep_gravel',
};
/** COMBAT audio-local events (emitted by combat/weapons). */
export const AEV = registerEvents({ COOK: 'combat:cook', SWAY_BREATH: 'combat:breath' });

let ctx = null;
let unlocked = false;
let master = null, limiter = null, pauseLp = null, reverb = null, reverbIn = null;
const buses = {};
const buffers = new Map();       // name -> AudioBuffer[]
const peaks = new Map();         // name -> seconds to the loudest sample (plate thunk alignment)
const rr = new Map();            // name -> round-robin index
const voices = [];               // {name, src, gain, t, ended}
const channels = new Map();      // loop channel -> {name, src, gain, filter, vol}
let listenerObj = null;
let loadedAll = false;
let noiseBuf = null;
let inited = false;
let autoLoops = true;
const lp = { x: 0, y: 0, z: 0 };  // listener position (for distance maths)

function err(msg) { return new Error(`[COMBAT/audio] ${msg}`); }

// ------------------------------------------------------------------------------------------ setup
function buildGraph() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC({ latencyHint: 'interactive' });
  limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6; limiter.knee.value = 6; limiter.ratio.value = 12; limiter.attack.value = 0.002; limiter.release.value = 0.16;
  pauseLp = ctx.createBiquadFilter();
  pauseLp.type = 'lowpass'; pauseLp.frequency.value = 22000; pauseLp.Q.value = 0.5;
  master = ctx.createGain();
  master.connect(pauseLp); pauseLp.connect(limiter); limiter.connect(ctx.destination);
  for (const b of ['sfx', 'ui', 'ambience']) { buses[b] = ctx.createGain(); buses[b].connect(master); }
  reverb = ctx.createConvolver();
  reverb.buffer = impulse(TUNE.reverbSeconds);
  reverbIn = ctx.createGain();
  reverbIn.gain.value = 1;
  const revOut = ctx.createGain();
  revOut.gain.value = 0.85;
  reverbIn.connect(reverb); reverb.connect(revOut); revOut.connect(buses.sfx);
  noiseBuf = makeNoise(1.5);
  applyVolumes();
}

/** Outdoor impulse response: sparse early reflections then a decaying, darkening noise tail (stereo). */
function impulse(seconds) {
  const sr = ctx.sampleRate, n = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lpState = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.exp(-t * 3.1) * (t < 0.012 ? t / 0.012 : 1);
      const k = 0.55 - 0.5 * Math.min(1, t / seconds);          // darker as it decays
      lpState += ((Math.random() * 2 - 1) - lpState) * k;
      d[i] = lpState * env * 0.55;
    }
    // early reflections (ground, nearby walls)
    for (const [ms, g] of [[11, 0.5], [23, 0.32], [41, 0.26], [67, 0.2], [97, 0.14], [151, 0.1]]) {
      const i = Math.floor((ms + c * 3.7) * sr / 1000);
      if (i < n) d[i] += g * (c ? -1 : 1);
    }
  }
  return buf;
}

function makeNoise(seconds) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

function applyVolumes() {
  if (!ctx) return;
  const muted = settings.get('muted');
  const t = ctx.currentTime;
  master.gain.setTargetAtTime(muted ? 0 : settings.get('masterVolume'), t, 0.03);
  buses.sfx.gain.setTargetAtTime(settings.get('sfxVolume'), t, 0.03);
  buses.ui.gain.setTargetAtTime(settings.get('uiVolume'), t, 0.03);
  buses.ambience.gain.setTargetAtTime(settings.get('ambienceVolume'), t, 0.03);
}

/** Create the AudioContext (suspended) and buses. Without prior user activation the context is created in unlock(). */
export function init() {
  if (inited) return;
  inited = true;
  const active = typeof navigator !== 'undefined' && navigator.userActivation && navigator.userActivation.hasBeenActive;
  if (active) buildGraph();
  // Any first gesture unlocks audio (the menu click normally does it through main.js).
  const gesture = () => { unlock(); if (unlocked) { removeEventListener('pointerdown', gesture, true); removeEventListener('keydown', gesture, true); } };
  addEventListener('pointerdown', gesture, true);
  addEventListener('keydown', gesture, true);
  on(EV.SETTINGS_CHANGED, ({ key }) => { if (/Volume$|^muted$/.test(key)) applyVolumes(); });
  subscribe();
}

/** Resume the context; call from the first user gesture (menu click). */
export function unlock() {
  if (!ctx) buildGraph();
  if (!ctx) return;
  if (ctx.state === 'running') { unlocked = true; return; }
  ctx.resume().then(() => { unlocked = ctx.state === 'running'; }, () => {});
}

export function isUnlocked() { return !!ctx && ctx.state === 'running'; }

// ------------------------------------------------------------------------------------------ loading
function fileList() {
  const out = [];
  for (const [name, n] of Object.entries(AUDIO)) {
    if (n === 0) out.push([name, name, 0]);
    else for (let i = 0; i < n; i++) out.push([name, `${name}_${i}`, i]);
  }
  return out;
}

function trim(buf) {
  const ch = buf.numberOfChannels, n = buf.length;
  let start = 0;
  outer: for (; start < n; start++) for (let c = 0; c < ch; c++) if (Math.abs(buf.getChannelData(c)[start]) > TUNE.trimThreshold) break outer;
  start = Math.max(0, start - 16);
  if (start < 32 || start >= n - 32) return buf;
  const out = new AudioBuffer({ numberOfChannels: ch, length: n - start, sampleRate: buf.sampleRate });
  for (let c = 0; c < ch; c++) out.copyToChannel(buf.getChannelData(c).subarray(start), c);
  return out;
}

function peakTime(buf) {
  const d = buf.getChannelData(0);
  let m = 0, at = 0;
  for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > m) { m = a; at = i; } }
  return at / buf.sampleRate;
}

/** Fetch and decode every file in config.AUDIO. @param {(p:number) => void} onProgress */
export async function loadAll(onProgress = () => {}) {
  if (loadedAll) { onProgress(1); return; }
  const list = fileList();
  const decoder = new OfflineAudioContext(2, 1, 48000);
  let done = 0;
  const slots = new Map();
  for (const [name, , i] of list) { if (!slots.has(name)) slots.set(name, []); slots.get(name)[i] = null; }
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const [name, file, i] = list[next++];
      const res = await fetch(audioUrl(file));
      if (!res.ok) throw err(`HTTP ${res.status} for ${audioUrl(file)}`);
      const raw = await res.arrayBuffer();
      let buf = await decoder.decodeAudioData(raw);
      if (!LOOPS.has(name)) buf = trim(buf);
      slots.get(name)[i] = buf;
      done++;
      onProgress(done / list.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  for (const [name, arr] of slots) buffers.set(name, arr);
  peaks.set('plate_insert', peakTime(buffers.get('plate_insert')[0]));
  loadedAll = true;
  onProgress(1);
}

export const isLoaded = () => loadedAll;
export const names = () => [...buffers.keys()];
export const context = () => ctx;

function pick(name) {
  const arr = buffers.get(name);
  if (!arr || !arr.length) return null;
  const i = (rr.get(name) || 0) % arr.length;
  rr.set(name, i + 1);
  return arr[i];
}

// ------------------------------------------------------------------------------------------ voices
function ready() { return !!ctx && ctx.state === 'running' && loadedAll; }

function addVoice(name, src, gain, group) {
  const v = { name: group || name, src, gain, t: ctx.currentTime, ended: false };
  src.onended = () => { v.ended = true; const i = voices.indexOf(v); if (i >= 0) voices.splice(i, 1); };
  voices.push(v);
  // per-sample limit, then global
  let same = 0;
  for (let i = voices.length - 1; i >= 0; i--) if (voices[i].name === v.name && ++same > TUNE.perSample) { steal(voices[i]); break; }
  if (voices.length > TUNE.maxVoices) steal(voices[0]);
  return v;
}

function steal(v) {
  const i = voices.indexOf(v);
  if (i >= 0) voices.splice(i, 1);
  try {
    const t = ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(v.gain.gain.value, t);
    v.gain.gain.linearRampToValueAtTime(0, t + TUNE.stealFade);
    v.src.stop(t + TUNE.stealFade + 0.01);
  } catch (e) { /* already stopped */ }
}

function handle(v) {
  return {
    stop(fade = 0.05) {
      if (v.ended) return;
      const t = ctx.currentTime;
      try {
        v.gain.gain.cancelScheduledValues(t);
        v.gain.gain.setValueAtTime(v.gain.gain.value, t);
        v.gain.gain.linearRampToValueAtTime(0, t + Math.max(0.005, fade));
        v.src.stop(t + Math.max(0.005, fade) + 0.02);
      } catch (e) { /* ignore */ }
    },
  };
}

function source(buf, rate, jitter) {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const j = jitter == null ? TUNE.jitter : jitter;
  src.playbackRate.value = (rate || 1) * (1 + (Math.random() * 2 - 1) * j);
  return src;
}

/**
 * Play a 2D sound. name = AUDIO key (variant chosen automatically).
 * @param {string} name
 * @param {{volume?:number, rate?:number, jitter?:number, bus?:'sfx'|'ui'|'ambience', delay?:number, reverb?:number, lowpass?:number}} [opts]
 * @returns {{stop:(fade?:number) => void}|null}
 */
export function play(name, opts = {}) {
  if (!ready()) return null;
  const buf = pick(name);
  if (!buf) throw err(`unknown sound '${name}'`);
  const src = source(buf, opts.rate, opts.jitter);
  const g = ctx.createGain();
  g.gain.value = opts.volume == null ? 1 : opts.volume;
  let head = src;
  if (opts.lowpass) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = opts.lowpass; head.connect(f); head = f; }
  head.connect(g);
  g.connect(buses[opts.bus || 'sfx']);
  if (opts.reverb) { const s = ctx.createGain(); s.gain.value = opts.reverb; g.connect(s); s.connect(reverbIn); }
  src.start(ctx.currentTime + Math.max(0, opts.delay || 0));
  return handle(addVoice(name, src, g, opts.group));
}

function distTo(pos) { return Math.hypot(pos[0] - lp.x, pos[1] - lp.y, pos[2] - lp.z); }

/** Play a positional sound at [x, y, z]. Same opts as play plus {refDistance, rolloff, maxDistance, sound: true (delay by d/343)}. */
export function playAt(name, pos, opts = {}) {
  if (!ready()) return null;
  if (!pos) return play(name, opts);
  const buf = pick(name);
  if (!buf) throw err(`unknown sound '${name}'`);
  const d = distTo(pos);
  if (opts.maxDistance && d > opts.maxDistance) return null;
  const src = source(buf, opts.rate, opts.jitter);
  const g = ctx.createGain();
  g.gain.value = opts.volume == null ? 1 : opts.volume;
  const p = makePanner(pos, d, opts);
  let head = src;
  const cutoff = opts.lowpass || (opts.farLowpass ? farCutoff(d, opts.farLowpass) : 0);
  if (cutoff && cutoff < 18000) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff; f.Q.value = 0.4; head.connect(f); head = f; }
  head.connect(g); g.connect(p); p.connect(buses[opts.bus || 'sfx']);
  if (opts.reverb) { const s = ctx.createGain(); s.gain.value = opts.reverb; g.connect(s); s.connect(reverbIn); }
  const delay = Math.max(0, opts.delay || 0) + (opts.sound ? d / TUNE.speedOfSound : 0);
  src.start(ctx.currentTime + delay);
  return handle(addVoice(name, src, g, opts.group));
}

function makePanner(pos, d, opts) {
  const p = ctx.createPanner();
  p.panningModel = d < TUNE.hrtfRange ? 'HRTF' : 'equalpower';
  p.distanceModel = 'inverse';
  p.refDistance = opts.refDistance || TUNE.refDistance;
  p.rolloffFactor = opts.rolloff == null ? TUNE.rolloff : opts.rolloff;
  p.maxDistance = 10000;
  p.positionX.value = pos[0]; p.positionY.value = pos[1]; p.positionZ.value = pos[2];
  return p;
}

/** Low-pass cutoff for a sound d metres away: full band near, dull and boomy far (scale: metres per halving). */
function farCutoff(d, scale) { return clamp(18000 * Math.pow(0.5, d / scale), 380, 18000); }

// ------------------------------------------------------------------------------------------ synthesis layers
/** Sub thump: a sine sweeping fStart -> fEnd over len seconds. */
function thump(dest, when, fStart, fEnd, len, vol) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(fStart, when);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, fEnd), when + len);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(vol, when + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0008, when + len);
  o.connect(g); g.connect(dest);
  o.start(when); o.stop(when + len + 0.02);
  return g;
}

/** Filtered noise burst: type 'bandpass'|'lowpass'|'highpass' at freq, attack/decay seconds. */
function noise(dest, when, type, freq, q, attack, decay, vol, freqEnd) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  s.playbackRate.value = 0.9 + Math.random() * 0.2;
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.setValueAtTime(freq, when); f.Q.value = q;
  if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, when + attack + decay);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(vol, when + Math.max(0.001, attack));
  g.gain.exponentialRampToValueAtTime(0.0006, when + attack + decay);
  s.connect(f); f.connect(g); g.connect(dest);
  const off = Math.random() * 0.8;
  s.start(when, off, attack + decay + 0.05);
  return g;
}

function sendNode(level, dest) {
  const g = ctx.createGain();
  g.gain.value = level;
  g.connect(dest);
  return g;
}

/** Small cloth/gear swish (reload start, weapon switch, ADS). */
function swish(vol = 0.12, pos = null) {
  if (!ready()) return;
  const t = ctx.currentTime;
  let dest = buses.sfx;
  if (pos) { const p = makePanner(pos, distTo(pos), { refDistance: 2 }); p.connect(buses.sfx); dest = p; }
  noise(dest, t, 'bandpass', 900 + Math.random() * 500, 0.8, 0.04, 0.16, vol, 2400);
}

/** Water splash (no recorded file ships): two noise bursts, bright then low. */
function splash(pos, vol = 0.5) {
  if (!ready()) return;
  const t = ctx.currentTime;
  let dest = buses.sfx;
  if (pos) { const p = makePanner(pos, distTo(pos), { refDistance: 3 }); p.connect(buses.sfx); dest = p; }
  noise(dest, t, 'bandpass', 2400, 0.7, 0.003, 0.09, vol * 0.7, 900);
  noise(dest, t + 0.02, 'lowpass', 1200, 0.5, 0.01, 0.35, vol * 0.5, 300);
}

// ------------------------------------------------------------------------------------------ public sound API
/** Weapon report: pos null = local (2D, louder, with a synthesized low thump layer). */
export function gunshot(weaponId, pos = null) {
  if (!ready()) return;
  const W = WEAPONS[weaponId];
  if (!W || !W.sound) return;
  const s = W.sound;
  const sniper = W.class === 'sniper', pistol = W.class === 'pistol', smg = W.class === 'smg';
  const t = ctx.currentTime;
  if (!pos) {
    const L = TUNE.local;
    play(s.shot, { volume: L.gun * (sniper ? 1.05 : 1), rate: s.rate, jitter: 0.03, reverb: L.reverb * (sniper ? 1.6 : 1), group: s.shot });
    thump(buses.sfx, t, sniper ? 70 : pistol ? 95 : 60, sniper ? 32 : 40, sniper ? 0.16 : pistol ? 0.07 : 0.09, L.thump * (sniper ? 1.2 : pistol ? 0.6 : smg ? 0.55 : 0.85));
    noise(buses.sfx, t, 'highpass', sniper ? 1800 : 2600, 0.6, 0.001, sniper ? 0.05 : 0.03, L.crack * (smg ? 0.7 : 1));
    // Close environment slap: a darker repeat 60-110 ms later (open ground reflects little, so it is subtle).
    const slap = sendNode(0.12 * (sniper ? 1.5 : 1), reverbIn);
    noise(slap, t + 0.07, 'lowpass', 1400, 0.5, 0.005, sniper ? 0.5 : 0.28, 0.5);
    if (W.mode !== 'bolt' && W.class !== 'smg') play('casing', { volume: L.casing * (pistol ? 0.8 : 1), delay: 0.38 + Math.random() * 0.12, rate: pistol ? 1.15 : 1 });
    else if (smg) play('casing', { volume: L.casing * 0.6, delay: 0.32 + Math.random() * 0.15, rate: 1.2 });
    return;
  }
  const d = distTo(pos);
  if (d > TUNE.gunAudible) return;
  const delay = d / TUNE.speedOfSound;
  const loud = sniper ? 1.25 : pistol ? 0.8 : smg ? 0.85 : 1;
  // Direct report: positional, duller with distance.
  playAt(s.shot, pos, {
    volume: 0.95 * loud, rate: s.rate * (d > 200 ? 0.94 : 1), jitter: 0.04, refDistance: TUNE.gunRef, rolloff: TUNE.gunRolloff,
    farLowpass: 140, sound: true, reverb: clamp(0.08 + d / 500, 0.08, 0.7), group: s.shot,
  });
  // Distant boom body and a late slap-back echo from the terrain.
  if (d > 40) {
    const p = makePanner(pos, d, { refDistance: TUNE.gunRef * 1.5, rolloff: 0.9 });
    p.connect(buses.sfx);
    const k = clamp((d - 40) / 160, 0, 1);
    noise(p, t + delay, 'lowpass', clamp(1600 - d * 2, 260, 1600), 0.6, 0.006, 0.4 + 0.5 * k, 0.65 * loud * k, 180);
    const echo = makePanner(pos, d, { refDistance: TUNE.gunRef * 2, rolloff: 0.8 });
    echo.connect(reverbIn);
    noise(echo, t + delay + 0.18 + Math.random() * 0.3, 'lowpass', 700, 0.5, 0.02, 0.7, 0.35 * loud * k, 200);
  } else if (d < 12) {
    // Close shots: a bit of the sub thump so nearby fire feels physical.
    const p = makePanner(pos, d, { refDistance: 4, rolloff: 1.2 });
    p.connect(buses.sfx);
    thump(p, t + delay, 62, 40, 0.08, 0.35 * loud);
  }
}

/** Footstep by surface; pos null = local. opts {sprint, crouch, volume}. */
export function footstep(surface, pos = null, opts = {}) {
  if (!ready()) return;
  const F = TUNE.footsteps;
  const vol = (opts.volume || 1) * (opts.sprint ? F.sprint : opts.crouch ? F.crouch : F.walk);
  if (surface === SURFACE.WATER) { splash(pos, vol * 0.8); return; }
  const name = STEP_MAP[surface] || 'footstep_gravel';
  if (pos) playAt(name, pos, { volume: vol * 1.3, refDistance: F.remoteRef, rolloff: 1.3, maxDistance: 60, jitter: 0.07 });
  else {
    play(name, { volume: vol, jitter: 0.07 });
    if (surface === SURFACE.METAL) play('impact_metal', { volume: vol * 0.12, rate: 1.6 });
  }
}

/** Bullet impact sound by surface at pos. */
export function impact(surface, pos) {
  if (!ready() || !pos) return;
  const d = distTo(pos);
  if (d > 80) return;
  if (surface === SURFACE.WATER) { splash(pos, 0.45); return; }
  const name = IMPACT_MAP[surface] || 'impact_dirt';
  playAt(name, pos, { volume: surface === SURFACE.FLESH ? 0.5 : 0.62, refDistance: 3, rolloff: 1.4, jitter: 0.08, sound: true });
}

export function explosion(pos) {
  if (!ready()) return;
  const t = ctx.currentTime;
  if (!pos) { play('explosion', { volume: 1, reverb: 0.5 }); thump(buses.sfx, t, 55, 25, 0.8, 0.9); return; }
  const d = distTo(pos);
  const delay = d / TUNE.speedOfSound;
  playAt('explosion', pos, { volume: 1.1, refDistance: 7, rolloff: 1.0, farLowpass: 60, sound: true, reverb: clamp(0.25 + d / 200, 0.25, 0.9) });
  const p = makePanner(pos, d, { refDistance: 8, rolloff: 1.0 });
  p.connect(buses.sfx);
  thump(p, t + delay, 58, 24, 0.9, 0.95);
  noise(p, t + delay + 0.05, 'lowpass', 900, 0.5, 0.05, 1.6, 0.35, 160);          // rumble
  if (d < 40) noise(p, t + delay + 0.25, 'bandpass', 3200, 1.2, 0.02, 0.7, 0.12); // debris rattle
}

/** UI sound: 'hover' | 'click' | 'confirm' | 'back' | 'error' | 'tick' | 'go'. */
export function ui(name) {
  if (!ready()) return null;
  const key = 'ui_' + name;
  if (!buffers.has(key)) throw err(`unknown ui sound '${name}'`);
  return play(key, { bus: 'ui', volume: name === 'hover' ? 0.5 : 0.85, jitter: name === 'hover' || name === 'click' ? 0.06 : 0.02 });
}

/**
 * Looping channel (one sound per channel, cross-faded over 0.6 s). channel: 'ambience' | 'vehicle' | 'zone' | 'heartbeat'.
 * name null stops the channel. volume can be updated every frame. opts.lowpass sets the channel filter cutoff.
 */
export function loop(channel, name, volume = 1, opts = {}) {
  if (!ready()) return;
  const t = ctx.currentTime;
  let ch = channels.get(channel);
  if (ch && ch.name === name) {
    if (Math.abs(ch.vol - volume) > 1e-3) { ch.vol = volume; ch.gain.gain.setTargetAtTime(volume, t, 0.12); }
    if (opts.lowpass != null && ch.filter) ch.filter.frequency.setTargetAtTime(opts.lowpass, t, 0.15);
    return;
  }
  if (ch) {
    const old = ch;
    old.gain.gain.cancelScheduledValues(t);
    old.gain.gain.setValueAtTime(old.gain.gain.value, t);
    old.gain.gain.linearRampToValueAtTime(0, t + TUNE.loopFade);
    try { old.src.stop(t + TUNE.loopFade + 0.05); } catch (e) { /* ignore */ }
    channels.delete(channel);
  }
  if (!name) return;
  const buf = pick(name);
  if (!buf) throw err(`unknown loop '${name}'`);
  const src = ctx.createBufferSource();
  src.buffer = buf; src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass'; filter.frequency.value = opts.lowpass || 20000; filter.Q.value = 0.5;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(volume, t + TUNE.loopFade);
  src.connect(filter); filter.connect(g); g.connect(buses[channel === 'ambience' ? 'ambience' : 'sfx']);
  src.start(t, Math.random() * Math.max(0, buf.duration - 0.1));
  channels.set(channel, { name, src, gain: g, filter, vol: volume });
}

/** Listener follows this object (gfx.camera) every update. */
export function setListener(object3d) { listenerObj = object3d || null; }

// ------------------------------------------------------------------------------------------ per-frame
const fwd = [0, 0, -1], up = [0, 1, 0];
export function update(dt) {
  if (!ctx || ctx.state !== 'running') return;
  if (listenerObj) {
    const e = listenerObj.matrixWorld.elements;
    lp.x = e[12]; lp.y = e[13]; lp.z = e[14];
    fwd[0] = -e[8]; fwd[1] = -e[9]; fwd[2] = -e[10];
    up[0] = e[4]; up[1] = e[5]; up[2] = e[6];
    const L = ctx.listener, t = ctx.currentTime;
    if (L.positionX) {
      L.positionX.setTargetAtTime(lp.x, t, 0.015); L.positionY.setTargetAtTime(lp.y, t, 0.015); L.positionZ.setTargetAtTime(lp.z, t, 0.015);
      L.forwardX.setTargetAtTime(fwd[0], t, 0.015); L.forwardY.setTargetAtTime(fwd[1], t, 0.015); L.forwardZ.setTargetAtTime(fwd[2], t, 0.015);
      L.upX.setTargetAtTime(up[0], t, 0.015); L.upY.setTargetAtTime(up[1], t, 0.015); L.upZ.setTargetAtTime(up[2], t, 0.015);
    } else {
      L.setPosition(lp.x, lp.y, lp.z);
      L.setOrientation(fwd[0], fwd[1], fwd[2], up[0], up[1], up[2]);
    }
  }
  if (loadedAll && autoLoops) driveLoops();
}

/** Loops follow the game state (default); false hands the loop channels to manual loop() calls (harness sound board). */
export function setAutoLoops(on) { autoLoops = !!on; }

/** Ambience, vehicle, zone and heartbeat beds from the current state (ARCHITECTURE.md 10). */
function driveLoops() {
  const app = state.app;
  const me = localPlayer();
  if (app !== APP.MATCH || !me) {
    loop('vehicle', null); loop('zone', null); loop('heartbeat', null);
    loop('ambience', app === APP.LOADING || app === APP.BOOT ? null : 'wind_loop', 0.32);
    return;
  }
  const life = me.life;
  // vehicle: inside the plane full and muffled; after the jump it fades with distance to the plane's line
  if (life === LIFE.PLANE) loop('vehicle', 'plane_loop', 0.85, { lowpass: 1100 });
  else if (state.match.phase === 'plane' && (life === LIFE.FREEFALL || life === LIFE.CHUTE)) loop('vehicle', 'plane_loop', 0.35, { lowpass: 2400 });
  else loop('vehicle', null);
  // ambience bed
  if (life === LIFE.FREEFALL) {
    const fall = Math.max(0, -me.vel.y);
    loop('ambience', 'freefall_loop', clamp(0.35 + fall / 60, 0.35, 1));
  } else if (life === LIFE.CHUTE) loop('ambience', 'chute_loop', 0.6);
  else if (life === LIFE.PLANE) loop('ambience', null);
  else loop('ambience', 'wind_loop', 0.22 + clamp((me.pos.y - 20) / 200, 0, 0.3));
  // zone wall hum: louder near the wall, constant when outside
  const z = state.zone;
  if (z && z.r > 0 && life !== LIFE.PLANE) {
    const dc = Math.hypot(me.pos.x - z.x, me.pos.z - z.z);
    const wall = Math.abs(dc - z.r);
    const v = z.outside ? 0.75 : clamp(1 - wall / 70, 0, 1) * 0.6;
    if (v > 0.01) loop('zone', 'zone_hum_loop', v, { lowpass: z.outside ? 1800 : 6000 });
    else loop('zone', null);
  } else loop('zone', null);
  // heartbeat
  if (me.alive && life === LIFE.GROUND && me.hp < 35) loop('heartbeat', 'heartbeat_loop', clamp(0.35 + (35 - me.hp) / 50, 0.35, 0.9));
  else loop('heartbeat', null);
}

// ------------------------------------------------------------------------------------------ event map
function weaponOf(id, w) { return w || (localPlayer() && id === state.selfId ? localPlayer().weapon : null); }
function posOf(id) { const p = state.players.get(id); return p ? [p.pos.x, p.pos.y + 1.4, p.pos.z] : null; }
const isSelf = (id) => id === state.selfId;

function subscribe() {
  on(EV.WEAPON_FIRE, (e) => {
    const local = !!e.local;
    gunshot(e.weapon, local ? null : (e.muzzle || e.origin));
    if (e.hit && e.hit.kind === 'world') impact(e.hit.surface, e.end);
    else if (e.hit && e.hit.kind === 'player' && !local && e.hit.id !== state.selfId) impact(SURFACE.FLESH, e.end);
    if (e.pen && e.pen.point) impact(e.pen.surface, e.pen.point);
  });
  on(EV.WEAPON_BOLT, ({ id }) => {
    const pos = isSelf(id) ? null : posOf(id);
    if (pos) playAt('bolt_cycle', pos, { volume: 0.7, refDistance: 3, maxDistance: 60 });
    else play('bolt_cycle', { volume: 0.75 });
    if (pos) playAt('casing', pos, { volume: 0.25, delay: 0.55, refDistance: 2, maxDistance: 30 });
    else play('casing', { volume: 0.2, delay: 0.55 });
  });
  on(EV.WEAPON_RELOAD, ({ id, weapon, phase }) => {
    const W = WEAPONS[weaponOf(id, weapon)];
    if (!W) return;
    const pistol = W.sound && W.sound.mech === 'pistol';
    let name = null, rate = 1, vol = 0.8;
    if (phase === 'magout') name = pistol ? 'pistol_mag_out' : 'rifle_mag_out';
    else if (phase === 'magin') name = pistol ? 'pistol_mag_in' : 'rifle_mag_in';
    else if (phase === 'charge') { name = 'rifle_charge'; if (pistol) { rate = 1.35; vol = 0.6; } if (W.mode === 'bolt') name = 'bolt_cycle'; }
    const pos = isSelf(id) ? null : posOf(id);
    if (phase === 'start') { swish(0.1, pos); return; }
    if (!name) return;
    if (pos) playAt(name, pos, { volume: vol, rate, refDistance: 2.5, maxDistance: 45 });
    else play(name, { volume: vol, rate });
  });
  on(EV.WEAPON_DRY, ({ id }) => {
    if (isSelf(id)) play('dry_fire', { volume: 0.7, rate: 1.6 });
    else { const pos = posOf(id); if (pos) playAt('dry_fire', pos, { volume: 0.5, rate: 1.6, maxDistance: 20 }); }
  });
  on(EV.WEAPON_SWITCH, ({ id }) => {
    if (isSelf(id)) { play('pistol_mag_in', { volume: 0.35, rate: 1.3 }); swish(0.12); }
    else { const pos = posOf(id); if (pos) playAt('pistol_mag_in', pos, { volume: 0.3, rate: 1.3, maxDistance: 25 }); }
  });
  on(EV.ADS, ({ active }) => { if (active) { play('pickup', { volume: 0.12, rate: 1.5 }); swish(0.05); } else swish(0.035); });
  on(EV.HIT_CONFIRMED, ({ zone, armorBroke }) => {
    if (armorBroke) play('armor_break', { volume: 0.9, jitter: 0.02 });
    play(zone === 'head' ? 'hitmarker_head' : 'hitmarker', { volume: zone === 'head' ? 0.85 : 0.7, jitter: 0.03 });
  });
  on(EV.PLAYER_KILLED, ({ id, by }) => {
    if (by && by === state.selfId && id !== state.selfId) play('kill_confirm', { volume: 0.9, jitter: 0.01, delay: 0.06 });
  });
  on(EV.PLAYER_DAMAGED, ({ id, kind, absorbed, armorBroke, amount }) => {
    if (id !== state.selfId) return;
    if (kind === 'zone') { play('hit_body', { volume: 0.18, rate: 0.8, lowpass: 1200 }); return; }
    if (absorbed > 0) play('hit_armor', { volume: 0.75 });
    if (!(absorbed > 0) || amount > absorbed) play('hit_body', { volume: kind === 'fall' ? 0.6 : 0.7 });
    if (armorBroke) play('armor_break', { volume: 0.7, rate: 0.9 });
  });
  on(EV.BULLET_NEAR, ({ pos }) => { if (pos) playAt('whizz', pos, { volume: 0.8, refDistance: 1.5, jitter: 0.08 }); });
  on(EV.FOOTSTEP, ({ pos, surface, sprint, crouch, local }) => footstep(surface, local ? null : pos, { sprint, crouch }));
  on(EV.PLAYER_LAND, ({ id, pos, speed }) => {
    const vol = clamp(0.35 + (speed || 0) / 14, 0.35, 1);
    if (isSelf(id)) play('land', { volume: vol });
    else if (pos) playAt('land', pos, { volume: vol, refDistance: 3, maxDistance: 60 });
  });
  on(EV.PLAYER_CHUTE, ({ id, open }) => {
    if (!open) return;
    if (isSelf(id)) play('chute_open', { volume: 0.9 });
    else { const pos = posOf(id); if (pos) playAt('chute_open', pos, { volume: 0.8, refDistance: 6, maxDistance: 250 }); }
  });
  on(EV.PLAYER_JUMP, ({ id }) => { if (isSelf(id)) swish(0.25); });
  on(AEV.COOK, ({ id }) => {
    if (isSelf(id)) play('grenade_pin', { volume: 0.8 });
    else { const pos = posOf(id); if (pos) playAt('grenade_pin', pos, { volume: 0.6, maxDistance: 25 }); }
  });
  on(EV.GRENADE_THROW, ({ origin, local }) => { if (local) swish(0.2); else if (origin) swish(0.15, origin); });
  on(EV.GRENADE_BOUNCE, ({ pos, speed }) => {
    if (pos) playAt('grenade_bounce', pos, { volume: clamp((speed || 4) / 10, 0.15, 0.9), refDistance: 3, maxDistance: 70, jitter: 0.08 });
  });
  on(EV.GRENADE_EXPLODE, ({ pos }) => explosion(pos));
  on(EV.PLATE_START, ({ id }) => {
    if (!isSelf(id)) { const pos = posOf(id); if (pos) playAt('plate_insert', pos, { volume: 0.7, maxDistance: 30 }); return; }
    // Time-aligned so the loud thunk of the sample lands when the plate seats.
    const at = Math.max(0, PLAYER.armor.insertTime - (peaks.get('plate_insert') || 0) - 0.03);
    play('plate_insert', { volume: 0.9, delay: at, jitter: 0 });
    swish(0.1);
  });
  on(EV.LOOT_PICKED, ({ by }) => { if (by === state.selfId) play('pickup', { volume: 0.7 }); });
  on(EV.CRATE_OPENED, ({ by, pos }) => {
    if (by === state.selfId) play('pickup', { volume: 0.7, rate: 0.85 });
    else if (pos) playAt('pickup', pos, { volume: 0.5, rate: 0.85, maxDistance: 30 });
    if (pos) playAt('impact_wood', pos, { volume: 0.5, rate: 0.8, maxDistance: 30 });
  });
  on(EV.ZONE_PHASE, ({ state: zs }) => { if (zs === 'shrinking') play('zone_warning', { volume: 0.8, bus: 'ui' }); });
  on(EV.MATCH_START, () => play('ui_go', { bus: 'ui', volume: 0.8 }));
  on(EV.PLANE_DOORS, ({ open }) => {
    if (!open || !ready()) return;
    // jump-light buzzer: two short square tones through a low-pass
    const t = ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 220;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1400;
      const g = ctx.createGain();
      const s = t + i * 0.32;
      g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(0.12, s + 0.01); g.gain.setValueAtTime(0.12, s + 0.2); g.gain.linearRampToValueAtTime(0, s + 0.24);
      o.connect(f); f.connect(g); g.connect(buses.sfx); o.start(s); o.stop(s + 0.26);
    }
  });
  on(EV.PAUSE, ({ paused }) => {
    if (!ctx) return;
    pauseLp.frequency.setTargetAtTime(paused ? TUNE.pauseCutoff : 22000, ctx.currentTime, 0.08);
  });
}
