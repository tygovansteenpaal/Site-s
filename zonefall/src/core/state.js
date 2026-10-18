// ZONEFALL - shared state. OWNER: LEAD. Complete; builders read anything, but write only the fields their group
// owns (the writer of every field is listed below and in ARCHITECTURE.md section 4).
import * as THREE from 'three';
import { emit, EV } from './bus.js';
import { PLAYER, SETTINGS_DEFAULTS } from '../config.js';

/** Life state of a player entity (u8 on the wire). */
export const LIFE = Object.freeze({ PLANE: 0, FREEFALL: 1, CHUTE: 2, GROUND: 3, DEAD: 4, SPECTATE: 5 });

/** Movement/action bits (u16 on the wire). */
export const FLAG = Object.freeze({
  CROUCH: 1 << 0, ADS: 1 << 1, FIRING: 1 << 2, SPRINT: 1 << 3, RELOAD: 1 << 4,
  SLIDE: 1 << 5, AIRBORNE: 1 << 6, THROW: 1 << 7, PLATE: 1 << 8, MANTLE: 1 << 9,
});

/** App-level screens. */
export const APP = Object.freeze({ BOOT: 'boot', LOADING: 'loading', MENU: 'menu', LOBBY: 'lobby', MATCH: 'match', RESULTS: 'results' });

/** Engine handles. Writer: engine/renderer.js (renderer, scene, camera, canvas). */
export const gfx = { renderer: null, scene: null, camera: null, canvas: null };

/** Test/debug hooks; every group may add a sub-object (debug.world = {...}). Exposed as window.__zf.debug. */
export const debug = {};

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function randomId(len = 20) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[a[i] % ALPHABET.length];
  return s;
}

function freshMatch() {
  return {
    id: null,             // writer: game/match
    seed: 0,              // writer: game/match (uint32)
    mode: 'practice',     // 'practice' | 'quick' | 'private'; writer: game/match
    phase: 'idle',        // 'idle' | 'plane' | 'live' | 'ended'; writer: game/match
    t0: 0,                // local performance.now() ms at plane launch; writer: game/match
    time: 0,              // seconds since t0 (negative before launch); writer: game/match
    roster: [],           // [{id, name, kind: 'human'|'bot', slot}]; writer: game/match
    alive: 0,             // writer: game/match
    winnerId: null,       // writer: game/match
    placement: 0,         // local final placement (1 = winner); writer: game/match
    stats: { kills: 0, damage: 0, headshots: 0, survived: 0, longest: 0 }, // local; writer: game/match (damage: combat/damage)
    netLost: null,        // online: why this client lost its place in the match ('stall'|'link'|'kicked'), else null; writer: game/match
  };
}

function freshZone() {
  // writer: game/zone. Circles in world XZ metres.
  return { phase: -1, state: 'pre', x: 0, z: 0, r: 0, nx: 0, nz: 0, nr: 0, timeLeft: 0, dps: 0, outside: false };
}

function freshLocal() {
  return {
    // writer: combat/weapons
    ads: 0,               // 0..1 ADS blend
    adsFov: 0,            // vertical FOV (deg) at full ADS; 0 = use default
    scoped: false,        // full-screen scope overlay active
    spread: 0,            // current cone in degrees (crosshair bloom)
    action: null,         // null | 'reload' | 'plate' | 'switch' | 'throw' | 'bolt'
    actionT: 0,           // 0..1 progress of action
    cook: 0,              // grenade cook seconds (0 when not cooking)
    breath: 1,            // hold-breath stamina 0..1 (sniper)
    // writer: player/inventory
    inv: null,            // Inventory, see ARCHITECTURE.md 5.4
    // writer: player/controller
    onGround: false, surface: 0, stance: 'stand', altitude: 0, canDeploy: false, inPlane: false,
    // writer: player/camera
    eye: new THREE.Vector3(), aimDir: new THREE.Vector3(0, 0, -1), fov: 70, mode: 'fp', spectating: null,
    // writer: combat/damage
    lastDamageAt: -1e9,   // performance.now() ms
    killer: null,         // {id, name, weapon, headshot, distance} once dead
    // writer: game/loot
    nearby: null,         // closest interactable item or crate
  };
}

export const state = {
  app: APP.BOOT,          // writer: setAppState (main.js)
  selfId: randomId(20),   // writer: net/session (replaced by Trystero selfId on connect, never during a match)
  name: SETTINGS_DEFAULTS.name || 'Operator', // writer: core/settings + main.js
  online: false,          // writer: net/session
  isHost: true,           // writer: net/session (true when offline)
  hostId: null,           // writer: net/session
  paused: false,          // writer: main.js (practice only freezes simulation)
  quality: 'medium',      // writer: engine/renderer
  match: freshMatch(),
  zone: freshZone(),
  players: new Map(),     // id -> PlayerEntity; see createPlayer
  local: freshLocal(),
};

/**
 * Create a player entity and register it. Writers per field:
 *  local entity: controller (pos, vel, yaw, pitch, life, movement flags), weapons (weapon, ADS/FIRING/RELOAD/THROW/PLATE bits),
 *                damage (hp, armor, alive)
 *  remote humans: net/sync (everything except kills)      bots: game/bots on the host, net/sync elsewhere
 *  kills/damage counters: game/match (from PLAYER_KILLED / PLAYER_DAMAGED events)
 */
export function createPlayer({ id, name, kind, owner = id, slot = 0 }) {
  if (state.players.has(id)) return state.players.get(id);
  const e = {
    id, name: String(name || 'Player').slice(0, 16), kind, owner, slot,
    alive: true, life: LIFE.PLANE,
    hp: PLAYER.health, armor: 0,
    pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, pitch: 0,
    flags: 0, weapon: null,
    kills: 0, damage: 0,
    speed: 0,             // horizontal speed m/s (controller for local, net/sync for remote, bots for bots)
    stale: false,         // writer: net/sync (no snapshot for NET.staleMs)
    lastSeen: performance.now(),
  };
  state.players.set(id, e);
  emit(EV.PLAYER_SPAWN, { id });
  return e;
}

export function removePlayer(id) {
  if (!state.players.delete(id)) return;
  emit(EV.PLAYER_REMOVE, { id });
}

export const getPlayer = (id) => state.players.get(id) || null;
export const localPlayer = () => state.players.get(state.selfId) || null;
export const isBotId = (id) => typeof id === 'string' && id.startsWith('bot:');
export const botId = (slot) => `bot:${slot}`;
export const hasFlag = (e, f) => (e.flags & f) !== 0;
export function setFlag(e, f, on) { e.flags = on ? (e.flags | f) : (e.flags & ~f); }

export function aliveCount() {
  let n = 0;
  for (const p of state.players.values()) if (p.alive && p.life !== LIFE.SPECTATE) n++;
  return n;
}

/** Change the app screen. Emits APP_STATE. */
export function setAppState(to) {
  if (!Object.values(APP).includes(to)) throw new Error(`[state] unknown app state '${to}'`);
  const from = state.app;
  if (from === to) return;
  state.app = to;
  emit(EV.APP_STATE, { from, to });
}

/** Clear everything match-related (called by game/match before a new match and after leaving one). */
export function resetMatchState() {
  for (const id of [...state.players.keys()]) removePlayer(id);
  state.match = freshMatch();
  state.zone = freshZone();
  state.local = freshLocal();   // inventory is rebuilt by player/inventory.reset() at spawn
}
