// ZONEFALL - the shrinking circle. OWNER: GAME. Contract: ARCHITECTURE.md 2.4 and 5.6, numbers in config.ZONE.
// setup(seed) precomputes every circle with stream(seed, 'zone'): the centre of phase k+1 lies uniformly inside
// (r_k - r_{k+1}) of centre k, retried ZONE.landRetries times until it is on land (world.getHeight > 2). The timeline
// is pure (circleAt / phaseAt of match time), so every peer agrees without messages.
// Visual: one open cylinder at the current circle with an animated gas shader (rising streaks, vertical falloff,
// grazing-angle density, partial atmospheric fog) plus a bright ground band, visible once the circle is smaller than
// the island-covering initial one. When the local player stands outside, the scene fog thickens and turns to gas
// (the UI adds its tint from state.zone.outside).
// Damage: the active phase's dps, once per second while outside, to the local player (damage.applyToSelf, kind 'zone',
// armor ignored) and, on the host, to every bot (bots.applyDamage). Writes state.zone each frame; emits ZONE_UPDATE
// (2 Hz and on every state change) and ZONE_PHASE (when a wait or a shrink begins). DEV.fastZone scales all times x0.1.
import * as THREE from 'three';
import { ZONE, DEV } from '../config.js';
import { emit, EV, on } from '../core/bus.js';
import { state, gfx, localPlayer, getPlayer, LIFE, debug } from '../core/state.js';
import { stream } from '../core/rng.js';
import { clamp, damp, lerp } from '../core/util.js';
import * as world from '../world/world.js';
import * as damage from '../combat/damage.js';
import * as bots from './bots.js';

const TUNE = {
  timeScale: DEV.fastZone ? 0.1 : 1,
  landMinHeight: 2,            // m: a circle centre must sit on land at least this high
  coastPull: 0.65,             // retries shrink the offset toward the previous centre by this factor
  wallBase: -40,               // m: the wall starts below sea level so it never shows a bottom edge
  segments: 256,
  updateHz: 2,                 // ZONE_UPDATE rate between state changes
  gasColor: new THREE.Color(0.46, 0.2, 0.035),  // fog colour while standing in the gas (linear)
  gasFogMult: 7,             // scene fog density multiplier while outside
  gasLambda: 2.2,              // fog blend speed (1/s)
  tickSeconds: 1,              // zone damage interval
};

const T = (s) => s * TUNE.timeScale;

let scene = null;
let wall = null, group = null;
let visible = true;
let list = [ { ...ZONE.initial } ];      // circles: index 0 = initial
let schedule = [];                      // per phase {waitAt, shrinkAt, endAt, dps}
let lastKey = '';
let lastUpdateAt = 0;
let localAcc = 0;
const botAcc = new Map();
let gasBlend = 0;
let fogBase = null;                     // {color, density} of the scene fog without gas
let fogWritten = null;                  // density we wrote last frame (detects external changes)
let elapsed = 0;

// ------------------------------------------------------------------------------------------ setup / pure timeline
/** Precompute all circles for a match seed. */
export function setup(seed) {
  const rng = stream(seed >>> 0, 'zone');
  list = [{ x: ZONE.initial.x, z: ZONE.initial.z, r: ZONE.initial.r }];
  for (let k = 0; k < ZONE.phases.length; k++) {
    const prev = list[k];
    const r = ZONE.phases[k].r;
    const room = Math.max(0, prev.r - r);
    let best = null;
    for (let tries = 0; tries <= ZONE.landRetries; tries++) {
      const span = room * Math.pow(TUNE.coastPull, Math.max(0, tries - 4));   // later retries search closer in
      const [x, z] = rng.inDisc(prev.x, prev.z, span);
      const h = safeHeight(x, z);
      if (!best || h > best.h) best = { x, z, h };
      if (h > TUNE.landMinHeight) { best = { x, z, h }; break; }
    }
    if (!best || best.h <= TUNE.landMinHeight) best = { x: prev.x, z: prev.z, h: 0 };
    list.push({ x: best.x, z: best.z, r });
  }
  schedule = [];
  let t = T(ZONE.startAt);
  for (const ph of ZONE.phases) {
    const waitAt = t, shrinkAt = t + T(ph.wait), endAt = shrinkAt + T(ph.shrink);
    schedule.push({ waitAt, shrinkAt, endAt, dps: ph.dps });
    t = endAt;
  }
  lastKey = '';
  localAcc = 0;
  botAcc.clear();
  writeState(state.match.time || 0, true);
  return list;
}

function safeHeight(x, z) {
  try { const h = world.getHeight(x, z); return Number.isFinite(h) ? h : -1; } catch (e) { return -1; }
}

/** All precomputed circles [{x, z, r}] (index 0 = initial). */
export function circles() { return list.map((c) => ({ ...c })); }

/** Phase schedule (match seconds): [{waitAt, shrinkAt, endAt, dps}] per phase. GAME addition for the UI and harness. */
export function timeline() { return schedule.map((s) => ({ ...s })); }

const cOut = { x: 0, z: 0, r: 0 };
/** Pure: current circle {x, z, r} at match time t (s). */
export function circleAt(t, out = { x: 0, z: 0, r: 0 }) {
  if (!schedule.length || t < schedule[0].shrinkAt) { const c = list[0]; out.x = c.x; out.z = c.z; out.r = c.r; return out; }
  for (let k = 0; k < schedule.length; k++) {
    const s = schedule[k];
    if (t < s.shrinkAt) { const c = list[k]; out.x = c.x; out.z = c.z; out.r = c.r; return out; }
    if (t < s.endAt) {
      const a = list[k], b = list[k + 1];
      const f = (t - s.shrinkAt) / Math.max(1e-6, s.endAt - s.shrinkAt);
      out.x = lerp(a.x, b.x, f); out.z = lerp(a.z, b.z, f); out.r = lerp(a.r, b.r, f);
      return out;
    }
  }
  const c = list[list.length - 1]; out.x = c.x; out.z = c.z; out.r = c.r;
  return out;
}

/**
 * Pure: {phase, state: 'pre'|'waiting'|'shrinking'|'final', current: {x,z,r}, next: {x,z,r}, timeLeft, dps} at time t.
 * phase is -1 before the first wait; timeLeft counts down to the next state change (0 when final).
 */
export function phaseAt(t) {
  const current = circleAt(t, { x: 0, z: 0, r: 0 });
  const n = schedule.length;
  if (!n || t < schedule[0].waitAt) {
    const first = schedule[0];
    return { phase: -1, state: 'pre', current, next: { ...(list[1] || list[0]) }, timeLeft: first ? first.waitAt - t : 0, dps: ZONE.phases[0].dps };
  }
  for (let k = 0; k < n; k++) {
    const s = schedule[k];
    if (t < s.shrinkAt) return { phase: k, state: 'waiting', current, next: { ...list[k + 1] }, timeLeft: s.shrinkAt - t, dps: s.dps };
    if (t < s.endAt) return { phase: k, state: 'shrinking', current, next: { ...list[k + 1] }, timeLeft: s.endAt - t, dps: s.dps };
  }
  return { phase: n - 1, state: 'final', current, next: { ...list[n] }, timeLeft: 0, dps: schedule[n - 1].dps };
}

/** Inside the current circle (state.zone, i.e. as of this frame). */
export function isInside(x, z) {
  const zs = state.zone;
  if (zs.state === 'pre') return true;
  return Math.hypot(x - zs.x, z - zs.z) <= zs.r;
}

/** Inside the circle at match time t (pure; bots plan with it). GAME addition. */
export function isInsideAt(x, z, t, margin = 0) {
  const c = circleAt(t, cOut);
  return Math.hypot(x - c.x, z - c.z) <= c.r - margin;
}

// ------------------------------------------------------------------------------------------ per frame
function writeState(t, force) {
  const p = phaseAt(t);
  const zs = state.zone;
  zs.phase = p.phase;
  zs.state = p.state;
  zs.x = p.current.x; zs.z = p.current.z; zs.r = Math.max(0, p.current.r);
  zs.nx = p.next.x; zs.nz = p.next.z; zs.nr = p.next.r;
  zs.timeLeft = p.timeLeft;
  zs.dps = p.dps;
  const key = `${p.phase}:${p.state}`;
  const changed = key !== lastKey;
  if (changed) {
    const prevKey = lastKey;
    lastKey = key;
    if (!force && prevKey && (p.state === 'waiting' || p.state === 'shrinking')) {
      emit(EV.ZONE_PHASE, { phase: p.phase, state: p.state, next: { ...p.next }, seconds: p.timeLeft });
    }
  }
  return changed;
}

export function update(dt) {
  const m = state.match;
  if (m.phase === 'idle' || !schedule.length) return;
  elapsed += dt;
  const t = m.time;
  const changed = writeState(t, false);
  const zs = state.zone;

  // outside test for the local view (player, or the camera while spectating)
  const me = localPlayer();
  let ox, oz;
  const playing = me && me.alive && me.life !== LIFE.PLANE && me.life !== LIFE.SPECTATE && me.life !== LIFE.DEAD;
  if (playing) { ox = me.pos.x; oz = me.pos.z; } else if (gfx.camera) { ox = gfx.camera.position.x; oz = gfx.camera.position.z; } else { ox = 0; oz = 0; }
  const outside = zs.state !== 'pre' && Math.hypot(ox - zs.x, oz - zs.z) > zs.r;
  const outChanged = outside !== zs.outside;
  zs.outside = outside;

  const now = performance.now();
  if (changed || outChanged || now - lastUpdateAt > 1000 / TUNE.updateHz) {
    lastUpdateAt = now;
    emit(EV.ZONE_UPDATE, { zone: { ...zs } });
  }

  // damage (not after the match ended)
  if (m.phase === 'live' || m.phase === 'plane') {
    if (playing && outside) {
      localAcc += dt;
      if (localAcc >= TUNE.tickSeconds) {
        localAcc -= TUNE.tickSeconds;
        damage.applyToSelf(zs.dps * TUNE.tickSeconds, { kind: 'zone', weapon: 'zone', from: null, zone: null, dir: null });
      }
    } else localAcc = 0;
    if (state.isHost || !state.online) tickBots(dt, zs);
  }
  updateVisual(dt, t, outside && playing);
}

function tickBots(dt, zs) {
  let ids;
  try { ids = bots.list(); } catch (e) { ids = []; }
  for (const id of ids) {
    const b = getPlayer(id);
    if (!b || !b.alive || b.life === LIFE.PLANE || b.life === LIFE.DEAD) { botAcc.delete(id); continue; }
    const out = zs.state !== 'pre' && Math.hypot(b.pos.x - zs.x, b.pos.z - zs.z) > zs.r;
    if (!out) { botAcc.set(id, 0); continue; }
    const acc = (botAcc.get(id) || 0) + dt;
    if (acc >= TUNE.tickSeconds) {
      botAcc.set(id, acc - TUNE.tickSeconds);
      bots.applyDamage(id, zs.dps * TUNE.tickSeconds, { kind: 'zone', weapon: 'zone', from: null, zone: null, dir: null });
    } else botAcc.set(id, acc);
  }
}

// ------------------------------------------------------------------------------------------ visuals
const WALL_VS = /* glsl */`
  varying vec3 vWorld;
  varying vec3 vNormalW;
  #include <fog_pars_vertex>
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * vec3(position.x, 0.0, position.z));
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const WALL_FS = /* glsl */`
  uniform float uTime;
  uniform float uRadius;
  uniform vec3 uCenter;
  uniform vec3 uColorLow;
  uniform vec3 uColorHigh;
  uniform float uOpacity;
  uniform float uTop;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  #include <common>
  #include <fog_pars_fragment>

  float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 3.7); a *= 0.5; }
    return s;
  }

  void main() {
    // arc-length coordinate around the circle keeps the texture density constant while the radius shrinks
    vec2 d = vWorld.xz - uCenter.xz;
    float ang = atan(d.y, d.x);
    float s = ang * max(uRadius, 1.0);
    float y = vWorld.y;
    float hNorm = clamp(y / uTop, 0.0, 1.0);

    // rising gas: two fbm layers at different scales drifting up and sideways
    vec2 p1 = vec2(s * 0.018, y * 0.012 - uTime * 0.09);
    vec2 p2 = vec2(s * 0.034 + uTime * 0.05, y * 0.03 - uTime * 0.26);
    float n1 = fbm(p1);
    float n2 = fbm(p2 + n1 * 1.7);
    float streak = smoothstep(0.32, 0.86, n2 * 0.65 + n1 * 0.55);
    // fine vertical striations
    float stria = 0.88 + 0.12 * sin(s * 0.21 + n1 * 7.0 + uTime * 0.4);

    // density: heavy near the ground, thinning with height, never fully clear low down
    float low = 1.0 - smoothstep(0.0, 0.55, hNorm);
    float density = mix(0.42, 1.0, low) * (0.45 + 0.95 * streak) * stria;
    density *= 1.0 - smoothstep(0.7, 1.0, hNorm);
    // bright band where the gas meets the ground
    float band = exp(-max(y - 2.0, 0.0) * 0.06) * 0.6;

    // grazing angles look denser (a curtain seen edge-on)
    vec3 V = normalize(cameraPosition - vWorld);
    float ndv = abs(dot(normalize(vNormalW), V));
    float graze = mix(1.55, 0.7, ndv);
    // fade the sheet right in front of the camera so crossing it is not a flat colour slab
    float camDist = length(cameraPosition - vWorld);
    float nearFade = smoothstep(1.5, 22.0, camDist);

    vec3 col = mix(uColorLow, uColorHigh, smoothstep(0.0, 0.7, hNorm + (n1 - 0.5) * 0.25));
    col *= 0.85 + band * 0.9 + streak * 0.3;
    float alpha = clamp((density * graze + band) * uOpacity * nearFade, 0.0, 0.94);

    gl_FragColor = vec4(col, alpha);
    vec3 unfogged = gl_FragColor.rgb;
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    vec3 mapped = gl_FragColor.rgb;
    #include <fog_fragment>
    // the wall must stay readable from far away: only part of the atmospheric fog applies
    gl_FragColor.rgb = mix(mapped, gl_FragColor.rgb, 0.28);
  }
`;

function buildVisual() {
  group = new THREE.Group();
  group.name = 'zone';
  const geo = new THREE.CylinderGeometry(1, 1, 1, TUNE.segments, 1, true);
  geo.translate(0, 0.5, 0);
  const top = ZONE.wallHeight;
  const mat = new THREE.ShaderMaterial({
    name: 'zone-wall',
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 }, uRadius: { value: 100 }, uCenter: { value: new THREE.Vector3() },
      uColorLow: { value: new THREE.Color(1.15, 0.3, 0.06) }, uColorHigh: { value: new THREE.Color(0.62, 0.13, 0.05) },
      uOpacity: { value: 0.72 }, uTop: { value: top },
    }]),
    vertexShader: WALL_VS, fragmentShader: WALL_FS,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
  });
  wall = new THREE.Mesh(geo, mat);
  wall.name = 'zone-wall';
  wall.frustumCulled = false;
  wall.renderOrder = 20;
  group.add(wall);
  group.visible = false;
  scene.add(group);
}

function updateVisual(dt, t, inGas) {
  if (!wall) return;
  const zs = state.zone;
  const show = visible && state.match.phase !== 'idle' && zs.r > 0.5 && zs.r < ZONE.initial.r - 1;
  group.visible = show;
  if (show) {
    wall.position.set(zs.x, TUNE.wallBase, zs.z);
    wall.scale.set(zs.r, ZONE.wallHeight - TUNE.wallBase, zs.r);
    const u = wall.material.uniforms;
    u.uTime.value = elapsed;
    u.uRadius.value = zs.r;
    u.uCenter.value.set(zs.x, 0, zs.z);
    // shrinking walls pulse slightly brighter
    u.uOpacity.value = zs.state === 'shrinking' ? 0.9 : 0.8;
  }
  gasFog(dt, inGas);
}

function gasFog(dt, inGas) {
  const fog = scene && scene.fog;
  if (!fog || !fog.isFogExp2) return;
  if (!fogBase || (fogWritten != null && Math.abs(fog.density - fogWritten) > 1e-9)) {
    // first frame, or someone else (quality switch) changed the fog: re-base from the current value
    const mult = 1 + (TUNE.gasFogMult - 1) * gasBlend;
    fogBase = { color: fogBase ? fogBase.color : fog.color.clone(), density: fog.density / (fogWritten != null ? mult : 1) };
  }
  gasBlend = damp(gasBlend, inGas ? 1 : 0, TUNE.gasLambda, dt);
  if (gasBlend < 1e-3 && !inGas) gasBlend = 0;
  const mult = 1 + (TUNE.gasFogMult - 1) * gasBlend;
  fog.density = fogBase.density * mult;
  fog.color.copy(fogBase.color).lerp(TUNE.gasColor, gasBlend * 0.93);
  fogWritten = fog.density;
}

/** Restore the scene fog (match end / leave). */
function resetFog() {
  const fog = scene && scene.fog;
  if (fog && fogBase) { fog.density = fogBase.density; fog.color.copy(fogBase.color); }
  gasBlend = 0;
  fogBase = null;
  fogWritten = null;
}

export function setVisible(on) {
  visible = !!on;
  if (group) group.visible = visible && group.visible;
}

/** Current gas blend 0..1 (harness, UI). GAME addition. */
export const gasAmount = () => gasBlend;

export function init(sc) {
  scene = sc;
  buildVisual();
  on(EV.MATCH_START, () => { localAcc = 0; botAcc.clear(); lastKey = ''; resetFog(); });
  on(EV.APP_STATE, ({ to }) => { if (to === 'menu' || to === 'lobby') { resetFog(); if (group) group.visible = false; } });
  debug.game = debug.game || {};
  Object.assign(debug.game, {
    zoneCircles: () => circles(),
    zonePhaseAt: (t) => phaseAt(t),
    zoneTimeline: () => timeline(),
  });
}
