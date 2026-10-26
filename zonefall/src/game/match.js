// ZONEFALL - match lifecycle and timeline. OWNER: GAME. Contract: ARCHITECTURE.md 2 and 5.6.
// Phases (state.match.phase): idle -> plane (t0 - startLead .. everyone out) -> live -> ended. All timing derives from
// state.match.time = (performance.now() - t0) / 1000, so every peer agrees without messages.
// begin(): resetMatchState(), one entity per roster entry (local 'local', other humans 'remote', bots 'bot' owned by the
// host), inventory.reset(), controller.spawn('plane') (or 'ground' with DEV.skipPlane), zone.setup(seed),
// loot.setup(seed), bots.setup(...), MATCH_START, MATCH_PHASE. Alive counting, placement and kill/damage counters
// come from PLAYER_KILLED / PLAYER_DAMAGED; when <= 1 is alive: phase 'ended' and MATCH_END {winnerId, placement, stats}.
// The plane flight line comes from stream(seed, 'plane'); planePath() and planePosAt() are pure.
// Host migration: HOST_CHANGED to self during a match -> bots.takeOver(). A peer that leaves mid-match counts as dead
// (PLAYER_KILLED {weapon: 'left'}, no drop, no credit).
import * as THREE from 'three';
import { MATCH, BOTS, DEV, SPAWN_LOADOUT, PLAYER, SKINS, SKIN_DEFAULT, ECONOMY } from '../config.js';
import * as profile from '../core/profile.js';
import { on, emit, EV } from '../core/bus.js';
import { state, debug, createPlayer, resetMatchState, getPlayer, localPlayer, botId, randomId, LIFE, APP } from '../core/state.js';
import { stream, randomSeed } from '../core/rng.js';
import { siteById, POIS } from '../core/mapdata.js';
import * as session from '../net/session.js';
import * as sync from '../net/sync.js';
import * as lobby from '../net/lobby.js';
import * as controller from '../player/controller.js';
import * as inventory from '../player/inventory.js';
import * as camera from '../player/camera.js';
import * as world from '../world/world.js';
import * as zone from './zone.js';
import * as loot from './loot.js';
import * as bots from './bots.js';
import * as plane from './plane.js';

const TUNE = {
  practiceLeadMs: MATCH.startLeadMs,   // practice shows the same outside pre-roll as online
  liveGrace: 1.5,                      // s after the forced jump before 'live' even if a remote snapshot still says PLANE
};

let inited = false;
let pathCache = null, pathSeed = -1;
const dead = new Set();
const fates = new Map();       // id -> {place, by, weapon, at}: final placement and cause, for the scoreboard
let lastVictim = null;
let doorsOpen = false;
let endedAt = 0;
let pausedAt = 0;

function err(msg) { return new Error(`[GAME/match] ${msg}`); }

// ------------------------------------------------------------------------------------------ plane path (pure)
/**
 * Plane flight line for the current seed: {a, b, dir, center, speed, length, doorsOpenAt, forceJumpAt, exitAt}
 * (times in match seconds). Deterministic from the match seed (stream 'plane').
 */
export function planePath() {
  const seed = state.match.seed >>> 0;
  if (pathCache && pathSeed === seed) return pathCache;
  const P = MATCH.plane;
  const rng = stream(seed, 'plane');
  const ang = rng.range(0, Math.PI * 2);
  const [cx, cz] = rng.inDisc(0, 0, P.centerJitter);
  const dx = Math.cos(ang), dz = Math.sin(ang);
  const a = [cx - dx * P.preDistance, P.altitude, cz - dz * P.preDistance];
  const b = [cx + dx * P.postDistance, P.altitude, cz + dz * P.postDistance];
  // doors open where the line first comes within doorsOpenRadius of the island centre (origin)
  const ad = a[0] * dx + a[2] * dz;
  const aa = a[0] * a[0] + a[2] * a[2];
  const disc = ad * ad - aa + P.doorsOpenRadius * P.doorsOpenRadius;
  const uOpen = disc > 0 ? -ad - Math.sqrt(disc) : P.preDistance - P.doorsOpenRadius;
  const length = P.preDistance + P.postDistance;
  pathCache = {
    a, b, dir: [dx, 0, dz], center: [cx, P.altitude, cz], speed: P.speed, length,
    doorsOpenAt: Math.max(0, uOpen) / P.speed,
    forceJumpAt: (P.preDistance + P.forceJumpAt) / P.speed,
    exitAt: length / P.speed,
  };
  pathSeed = seed;
  return pathCache;
}

/** Plane position at match time t (s) into out (THREE.Vector3); returns out. Extrapolates before 0 (pre-roll). */
export function planePosAt(t, out) {
  const p = planePath();
  const u = p.speed * t;
  return out.set(p.a[0] + p.dir[0] * u, p.a[1], p.a[2] + p.dir[2] * u);
}

// ------------------------------------------------------------------------------------------ begin
function buildBots(seed, humans, count) {
  const ro = humans.slice(0, MATCH.maxHumans).map((h, i) => ({ id: h.id, name: h.name, kind: 'human', slot: i, sk: h.sk || SKIN_DEFAULT }));
  const names = stream(seed, 'bots').shuffle(BOTS.names.slice());
  const looks = stream(seed, 'bot-skins');
  const pool = Object.keys(SKINS).filter((k) => k !== SKIN_DEFAULT);
  const want = Math.max(0, Math.min(MATCH.maxPlayers - ro.length, count));
  for (let i = 0; i < want; i++) {
    const slot = ro.length;
    const sk = looks.chance(ECONOMY.botSkinChance) ? looks.pick(pool) : SKIN_DEFAULT;
    ro.push({ id: botId(slot), name: names[i % names.length], kind: 'bot', slot, sk });
  }
  return ro;
}

function botCount(requested) {
  if (Number.isFinite(requested)) return Math.max(0, requested | 0);
  if (Number.isFinite(DEV.bots)) return Math.max(0, DEV.bots | 0);
  return MATCH.maxPlayers;
}

/** Offline match: self + bots (MATCH.maxPlayers - 1, or DEV.bots). seed: DEV.seed or random. */
export function startPractice(opts = {}) {
  const seed = (Number.isFinite(opts.seed) ? opts.seed : Number.isFinite(DEV.seed) ? DEV.seed : randomSeed()) >>> 0;
  const humans = [{ id: state.selfId, name: state.name || 'Operator', sk: profile.equipped() }];
  const roster = buildBots(seed, humans, botCount(opts.bots));
  begin({ mid: randomId(8), seed, ro: roster }, performance.now() + (opts.leadMs ?? TUNE.practiceLeadMs), 'practice');
}

/**
 * Host: build the roster (humans in join order, then bots to MATCH.maxPlayers), pick seed and match id, broadcast
 * 'start' {mid, seed, t0h: now + MATCH.startLeadMs, th: now, ro, ep}, then begin locally.
 * @param {Array<{id:string, name:string}>} humans
 */
export function hostBegin(humans) {
  if (!Array.isArray(humans) || !humans.length) throw err('hostBegin needs at least one human');
  const seed = (Number.isFinite(DEV.seed) ? DEV.seed : randomSeed()) >>> 0;
  const roster = buildBots(seed, humans, botCount());
  const th = performance.now();
  const mid = randomId(8);
  const msg = { mid, seed, t0h: th + MATCH.startLeadMs, th, ro: roster.map((r) => ({ id: r.id, name: r.name, kind: r.kind === 'bot' ? 'b' : 'h', slot: r.slot, sk: r.sk })), ep: safe(() => session.epoch(), 0) };
  if (state.online) session.send('start', msg);
  let mode = 'quick';
  try { mode = state.online ? (lobby.get().mode || 'quick') : 'practice'; } catch (e) { mode = state.online ? 'quick' : 'practice'; }
  begin({ mid, seed, ro: roster }, msg.t0h, mode);
}

/** Non-host: begin from a validated 'start' payload; t0 = t0h + sync.clockOffset(from) (fallback: now + (t0h - th) - rtt/2). */
export function beginFromNetwork(start, fromPeerId) {
  if (!start || !Array.isArray(start.ro)) throw err('beginFromNetwork needs a validated start payload');
  const off = safe(() => sync.clockOffset(fromPeerId), null);
  const t0 = off != null ? start.t0h + off : performance.now() + (start.t0h - start.th) - safe(() => session.rtt(fromPeerId), 0) / 2;
  let mode = 'quick';
  try { mode = lobby.get().mode || 'quick'; } catch (e) { mode = 'quick'; }
  begin({ mid: start.mid, seed: start.seed, ro: start.ro }, t0, mode);
}

function begin(start, t0, mode) {
  resetMatchState();
  dead.clear();
  fates.clear();
  lastVictim = null;
  doorsOpen = false;
  endedAt = 0;
  pausedAt = 0;
  pathCache = null;
  const host = state.online ? (safe(() => session.hostId(), null) || state.selfId) : state.selfId;
  for (const r of start.ro) {
    const kind = r.id === state.selfId ? 'local' : r.kind === 'bot' ? 'bot' : 'remote';
    const e = createPlayer({ id: r.id, name: r.name, kind, owner: kind === 'bot' ? host : r.id, slot: r.slot, skin: r.sk || SKIN_DEFAULT });
    e.life = LIFE.PLANE;
    e.alive = true;
    e.hp = PLAYER.health;
    e.armor = kind === 'local' ? SPAWN_LOADOUT.armor : 0;
  }
  const m = state.match;
  m.id = start.mid;
  m.seed = start.seed >>> 0;
  m.mode = mode;
  m.t0 = t0;
  m.time = (performance.now() - t0) / 1000;
  m.roster = start.ro.map((r) => ({ id: r.id, name: r.name, kind: r.kind === 'bot' ? 'bot' : 'human', slot: r.slot, sk: r.sk || SKIN_DEFAULT }));
  m.alive = start.ro.length;
  m.winnerId = null;
  m.placement = 0;
  m.stats = { kills: 0, damage: 0, headshots: 0, survived: 0, longest: 0 };
  m.phase = 'plane';
  planePath();

  zone.setup(m.seed);
  loot.setup(m.seed);
  const me = localPlayer();
  if (me) {
    inventory.reset(SPAWN_LOADOUT);
    if (DEV.skipPlane) controller.spawn('ground', groundSpawn(m.seed));
    else controller.spawn('plane');
  }
  bots.setup(m.roster.filter((r) => r.kind === 'bot'), m.seed);
  plane.setVisible(true);
  zone.setVisible(true);
  emit(EV.MATCH_START, { id: m.id, seed: m.seed, t0: m.t0, roster: m.roster.map((r) => ({ ...r })), mode: m.mode });
  emit(EV.MATCH_PHASE, { phase: 'plane', prev: 'idle' });
  if (DEV.skipPlane) setPhase('live');
}

/** ?skipplane spawn point: DEV.spawn site (or a seeded POI), a seeded spot inside its core. */
function groundSpawn(seed) {
  const rng = stream(seed, 'spawn:' + state.selfId);
  const site = siteById(DEV.spawn) || rng.pick(POIS);
  const [x, z] = rng.inDisc(site.x, site.z, site.r * 0.35);
  return [x, safe(() => world.getHeight(x, z), 0), z];
}

// ------------------------------------------------------------------------------------------ update
function setPhase(next) {
  const m = state.match;
  if (m.phase === next) return;
  const prev = m.phase;
  m.phase = next;
  emit(EV.MATCH_PHASE, { phase: next, prev });
}

export function update(dt) {
  const m = state.match;
  if (m.phase === 'idle') return;
  m.time = (performance.now() - m.t0) / 1000;
  const p = planePath();

  if (m.phase === 'plane') {
    if (!doorsOpen && m.time >= p.doorsOpenAt) { doorsOpen = true; emit(EV.PLANE_DOORS, { open: true }); }
    let aboard = 0;
    for (const e of state.players.values()) if (e.alive && e.life === LIFE.PLANE) aboard++;
    if ((m.time >= 0 && aboard === 0) || m.time >= p.forceJumpAt + TUNE.liveGrace) {
      if (doorsOpen) { doorsOpen = false; emit(EV.PLANE_DOORS, { open: false }); }
      setPhase('live');
    }
  }

  // alive count, local survival time, local damage counter
  let alive = 0;
  for (const e of state.players.values()) if (e.alive && e.life !== LIFE.SPECTATE && !dead.has(e.id)) alive++;
  m.alive = alive;
  const me = localPlayer();
  if (me) {
    if (me.alive && m.phase !== 'ended') m.stats.survived = Math.max(0, m.time);
    me.damage = Math.round(m.stats.damage);
  }

  if (m.phase !== 'ended' && m.roster.length >= 2 && alive <= 1 && m.time > 0) finish();
}

function finish() {
  const m = state.match;
  let winner = null;
  for (const e of state.players.values()) if (e.alive && e.life !== LIFE.SPECTATE && !dead.has(e.id)) { winner = e.id; break; }
  if (!winner) winner = lastVictim;
  m.winnerId = winner;
  if (winner) fates.set(winner, { place: 1, by: null, weapon: null, at: m.time });
  if (winner === state.selfId) m.placement = 1;
  else if (!m.placement) m.placement = Math.max(1, m.alive + 1);
  endedAt = performance.now();
  setPhase('ended');
  emit(EV.MATCH_END, { winnerId: winner, placement: m.placement, stats: { ...m.stats } });
}

/** Leave the current match (local cleanup, resetMatchState). The caller decides the next app state. */
export function leave() {
  try { loot.clear(); } catch (e) { console.warn('[GAME/match] loot.clear failed', e); }
  try { bots.setup([], 0); } catch (e) { console.warn('[GAME/match] bots reset failed', e); }
  plane.setVisible(false);
  zone.setVisible(false);
  dead.clear();
  fates.clear();
  lastVictim = null;
  doorsOpen = false;
  resetMatchState();
}

// ------------------------------------------------------------------------------------------ events
function onKilled({ id, by, weapon, headshot, pos }) {
  const m = state.match;
  if (m.phase === 'idle' || dead.has(id)) return;
  dead.add(id);
  lastVictim = id;
  const victim = getPlayer(id);
  if (victim && weapon === 'left') { victim.alive = false; victim.life = LIFE.DEAD; }
  let alive = 0;
  for (const e of state.players.values()) if (e.alive && e.life !== LIFE.SPECTATE && !dead.has(e.id)) alive++;
  m.alive = alive;
  fates.set(id, { place: alive + 1, by: by || null, weapon: weapon || null, at: m.time });
  if (by && by !== id && weapon !== 'left') {
    const k = getPlayer(by);
    if (k) k.kills = (k.kills || 0) + 1;
    if (by === state.selfId) {
      m.stats.kills++;
      if (headshot) m.stats.headshots++;
      const me = localPlayer();
      if (me && victim) {
        const d = pos ? Math.hypot(pos[0] - me.pos.x, pos[1] - me.pos.y, pos[2] - me.pos.z) : me.pos.distanceTo(victim.pos);
        m.stats.longest = Math.max(m.stats.longest, Math.round(d));
      }
    }
  }
  if (id === state.selfId) {
    m.placement = alive + 1;
    m.stats.survived = Math.max(0, m.time);
  }
}

function onDamaged({ id, amount, from }) {
  if (state.match.phase === 'idle' || !from || from === id || !(amount > 0)) return;
  if (from === state.selfId) return;                   // the local counter mirrors stats.damage (combat/damage)
  const a = getPlayer(from);
  if (a) a.damage = (a.damage || 0) + amount;
}

function onPeerLeave({ id }) {
  const m = state.match;
  if (m.phase === 'idle' || m.phase === 'ended') return;
  const e = getPlayer(id);
  if (!e || e.kind !== 'remote' || !e.alive || dead.has(id)) return;
  emit(EV.PLAYER_KILLED, { id, by: null, weapon: 'left', headshot: false, pos: [e.pos.x, e.pos.y, e.pos.z] });
}

function onHostChanged({ hostId, self }) {
  const m = state.match;
  if (m.phase === 'idle') return;
  for (const e of state.players.values()) if (e.kind === 'bot') e.owner = hostId;
  if (self && m.phase !== 'ended') bots.takeOver();
}

function onNetStart({ from, data }) {
  if (!data || from !== safe(() => session.hostId(), null)) return;
  if (!data.ro.some((r) => r.id === state.selfId)) return;          // a full round without us: net/lobby keeps us waiting
  if (state.match.id === data.mid && state.match.phase !== 'idle') return;
  if (state.app !== APP.LOBBY && state.app !== APP.RESULTS) return;
  beginFromNetwork(data, from);
}

function safe(fn, fallback) { try { const v = fn(); return v == null ? fallback : v; } catch (e) { return fallback; } }

export function init() {
  if (inited) return;
  inited = true;
  on(EV.NET_START, onNetStart);
  on(EV.PLAYER_KILLED, onKilled);
  on(EV.PLAYER_DAMAGED, onDamaged);
  on(EV.PEER_LEAVE, onPeerLeave);
  on(EV.HOST_CHANGED, onHostChanged);
  // practice pauses freeze the shared clock (online matches never pause)
  on(EV.PAUSE, ({ paused }) => {
    const m = state.match;
    if (m.phase === 'idle' || state.online) { pausedAt = 0; return; }
    if (paused) pausedAt = performance.now();
    else if (pausedAt) { m.t0 += performance.now() - pausedAt; pausedAt = 0; }
  });
  debug.game = debug.game || {};
  Object.assign(debug.game, {
    /** Jump the shared match clock to time t (s). */
    skipTo: (t) => {
      const m = state.match;
      if (m.phase === 'idle') return false;
      const p = planePath();
      if (t > p.forceJumpAt && m.time < p.forceJumpAt) {
        // leave the plane over the island first, so a long skip does not eject everyone far out at sea
        const tj = (p.doorsOpenAt + p.forceJumpAt) / 2;
        m.t0 = performance.now() - tj * 1000;
        m.time = tj;
        const me = localPlayer();
        if (me && me.life === LIFE.PLANE) controller.jumpFromPlane();
        bots.forceJump();
      }
      m.t0 = performance.now() - t * 1000;
      m.time = t;
      return true;
    },
    planePath: () => ({ ...planePath() }),
    matchInfo: () => ({ phase: state.match.phase, time: state.match.time, alive: state.match.alive, winnerId: state.match.winnerId, placement: state.match.placement, stats: { ...state.match.stats } }),
    spectate: (id) => camera.setSpectate(id ?? null),
    scoreboard: () => scoreboard(),
  });
}

/** Seconds since the match ended (0 while running). GAME addition for the UI. */
export const endedFor = () => (endedAt ? (performance.now() - endedAt) / 1000 : 0);

/**
 * Scoreboard rows (GAME addition for the UI's Tab overlay and results screen): every roster entry with
 * {id, name, kind:'human'|'bot', self, alive, kills, damage, place (0 while alive), by, byName, weapon}.
 * Sorted: living players by kills then damage, then the dead by placement (best first).
 */
export function scoreboard() {
  const rows = [];
  for (const r of state.match.roster) {
    const e = getPlayer(r.id);
    const f = fates.get(r.id);
    const alive = !!(e && e.alive && !dead.has(r.id)) && !(f && f.place > 1);
    const by = f && f.by ? getPlayer(f.by) : null;
    rows.push({
      id: r.id, name: r.name, kind: r.kind, self: r.id === state.selfId, alive,
      kills: e ? e.kills || 0 : 0, damage: Math.round(e ? e.damage || 0 : 0),
      place: f ? f.place : 0, by: f ? f.by : null, byName: by ? by.name : null, weapon: f ? f.weapon : null,
    });
  }
  rows.sort((a, b) => {
    const pa = a.place || 0, pb = b.place || 0;
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    if (a.alive || (pa === 1) || (pb === 1)) {
      if (pa === 1 || pb === 1) return pa === 1 ? -1 : 1;
      return b.kills - a.kills || b.damage - a.damage;
    }
    return pa - pb;
  });
  return rows;
}
