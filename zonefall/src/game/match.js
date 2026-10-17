// ZONEFALL - match lifecycle and timeline. OWNER: GAME. Contract: ARCHITECTURE.md 2 and 5.6.
// Phases (state.match.phase): idle -> plane (t0 - startLead .. everyone out) -> live -> ended. All timing derives from
// state.match.time = (performance.now() - t0) / 1000, so every peer agrees without messages.
// begin(): resetMatchState(), one entity per roster entry (local 'local', other humans 'remote', bots 'bot' owned by the
// host), inventory.reset(), controller.spawn('plane') (or 'ground' with DEV.skipPlane), zone.setup(seed),
// loot.setup(seed), bots.setup(...), MATCH_START, MATCH_PHASE. Alive counting, placement and kill/damage counters
// come from PLAYER_KILLED / PLAYER_DAMAGED; when <= 1 is alive: phase 'ended' and MATCH_END {winnerId, placement, stats}.
// One result on every client: each death carries the match time it happened at on its authority (the victim for a
// human, the host for a bot: PLAYER_KILLED.at / 'death'.t), and placements are ranked by that time, never by the order
// deaths reach this client. Online, the result waits a latency-sized settle window after the alive count reaches 1
// (deaths still in flight, such as the last two trading kills, are counted); the winner is the survivor, or when
// nobody survived, whoever died last. A death that arrives after the end still revises the result (MATCH_RESULT).
// The plane flight line comes from stream(seed, 'plane'); planePath() and planePosAt() are pure.
// Host migration: HOST_CHANGED {migrated} to self during a match -> bots.takeOver(). A peer that leaves mid-match counts
// as dead (PLAYER_KILLED {weapon: 'left'}, no credit): its own 'death' {w:'left'} + inventory drop when it leaves alive,
// its 'leave' {mid}, or net/sync's drop after NET.dropMs of silence (PEER_LEAVE {reason:'timeout'}). A raw transport
// disconnect is not a death by itself: net/sync decides from liveness, so two players cut off from each other never
// both "win". Leaving (LEAVE MATCH, main menu, closing the tab) announces it: leave() sends 'death' + drop when alive
// and 'leave'. When net/sync reports this client lost its own link (NET_LINK 'lost': frozen for ~NET.dropMs, link down,
// or kicked), forfeit(): state.match.netLost = reason, the local player dies with 'left', session stops hosting.
import * as THREE from 'three';
import { MATCH, BOTS, DEV, SPAWN_LOADOUT, PLAYER } from '../config.js';
import { on, emit, EV } from '../core/bus.js';
import { state, debug, createPlayer, resetMatchState, getPlayer, localPlayer, botId, randomId, LIFE, APP } from '../core/state.js';
import { stream, randomSeed } from '../core/rng.js';
import { siteById, POIS } from '../core/mapdata.js';
import * as session from '../net/session.js';
import * as damage from '../combat/damage.js';
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
  settleMs: 900,                       // online: ms (+ the worst round trip) between the alive count reaching 1 and the
  settleMaxMs: 2500,                   // final result, so deaths still in flight are counted the same way everywhere
};

let inited = false;
let pathCache = null, pathSeed = -1;
const dead = new Set();
const deaths = new Map();      // id -> {at: match s on the death's authority, by, weapon}: placement and cause
let settleUntil = 0;           // performance.now() when a pending result becomes final (0: none pending)
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
  const ro = humans.slice(0, MATCH.maxHumans).map((h, i) => ({ id: h.id, name: h.name, kind: 'human', slot: i }));
  const names = stream(seed, 'bots').shuffle(BOTS.names.slice());
  const want = Math.max(0, Math.min(MATCH.maxPlayers - ro.length, count));
  for (let i = 0; i < want; i++) {
    const slot = ro.length;
    ro.push({ id: botId(slot), name: names[i % names.length], kind: 'bot', slot });
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
  const humans = [{ id: state.selfId, name: state.name || 'Operator' }];
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
  const msg = { mid, seed, t0h: th + MATCH.startLeadMs, th, ro: roster.map((r) => ({ id: r.id, name: r.name, kind: r.kind === 'bot' ? 'b' : 'h', slot: r.slot })), ep: safe(() => session.epoch(), 0) };
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
  deaths.clear();
  settleUntil = 0;
  doorsOpen = false;
  endedAt = 0;
  pausedAt = 0;
  pathCache = null;
  const host = state.online ? (safe(() => session.hostId(), null) || state.selfId) : state.selfId;
  for (const r of start.ro) {
    const kind = r.id === state.selfId ? 'local' : r.kind === 'bot' ? 'bot' : 'remote';
    const e = createPlayer({ id: r.id, name: r.name, kind, owner: kind === 'bot' ? host : r.id, slot: r.slot });
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
  m.roster = start.ro.map((r) => ({ id: r.id, name: r.name, kind: r.kind === 'bot' ? 'bot' : 'human', slot: r.slot }));
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

  if (m.phase !== 'ended' && m.roster.length >= 2 && alive <= 1 && m.time > 0) {
    const now = performance.now();
    if (!state.online) finish();
    else if (!settleUntil) settleUntil = now + settleWindow();
    else if (now >= settleUntil) finish();
  }
}

const isAlive = (e) => !!e && e.alive && e.life !== LIFE.SPECTATE && !dead.has(e.id);

/** Online settle time: deaths decided on another client reach us within about one round trip after our own view. */
function settleWindow() {
  let worst = 0;
  for (const r of state.match.roster) if (r.kind === 'human' && r.id !== state.selfId) worst = Math.max(worst, safe(() => session.rtt(r.id), 0));
  return Math.min(TUNE.settleMaxMs, TUNE.settleMs + worst);
}

/** Dead roster ids, best placed first: the latest death first (ties: lower id), so every client ranks them alike. */
function deathOrder() {
  return [...deaths.entries()]
    .sort((a, b) => b[1].at - a[1].at || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id]) => id);
}

/** Placement of a dead roster entry: everyone without a recorded death ranks above it, then later deaths. 0 if alive. */
function placeOf(id) {
  if (!deaths.has(id)) return 0;
  let undecided = 0;
  for (const r of state.match.roster) if (!deaths.has(r.id)) undecided++;
  return undecided + deathOrder().indexOf(id) + 1;
}

/** The survivor; with nobody alive, whoever died last (a final trade goes to the later death on every client). */
function decideWinner() {
  for (const r of state.match.roster) if (isAlive(getPlayer(r.id))) return r.id;
  for (const r of state.match.roster) if (!deaths.has(r.id)) return r.id;   // shown dead, its death still in flight
  return deathOrder()[0] || null;
}

function finish() {
  const m = state.match;
  settleUntil = 0;
  const winner = decideWinner();
  m.winnerId = winner;
  m.placement = winner === state.selfId ? 1 : (placeOf(state.selfId) || Math.max(1, m.alive + 1));
  endedAt = performance.now();
  setPhase('ended');
  emit(EV.MATCH_END, { winnerId: winner, placement: m.placement, stats: { ...m.stats } });
}

/** A death reached us after the end: re-rank, and tell the UI if the winner or our placement changed. */
function revise() {
  const m = state.match;
  const winner = decideWinner();
  const placement = winner === state.selfId ? 1 : (placeOf(state.selfId) || m.placement);
  if (winner === m.winnerId && placement === m.placement) return;
  m.winnerId = winner;
  m.placement = placement;
  emit(EV.MATCH_RESULT, { winnerId: winner, placement, stats: { ...m.stats }, revised: true });
}

/**
 * Leave the current match (local cleanup, resetMatchState). The caller decides the next app state. Online, the others
 * are told first: a living player forfeits ('death' {w:'left'} and its inventory drop), then 'leave' {mid}.
 */
export function leave() {
  const m = state.match;
  if (state.online && m.id && m.phase !== 'idle') {
    const me = localPlayer();
    const alive = !!(me && me.alive && m.phase !== 'ended');
    if (alive) safe(() => damage.kill(me.id, null, 'left', false, null), null);
    safe(() => session.send('leave', { mid: m.id, alive }), null);
  }
  try { loot.clear(); } catch (e) { console.warn('[GAME/match] loot.clear failed', e); }
  try { bots.setup([], 0); } catch (e) { console.warn('[GAME/match] bots reset failed', e); }
  plane.setVisible(false);
  zone.setVisible(false);
  dead.clear();
  deaths.clear();
  settleUntil = 0;
  doorsOpen = false;
  resetMatchState();
}

// ------------------------------------------------------------------------------------------ events
function onKilled({ id, by, weapon, headshot, pos, at }) {
  const m = state.match;
  if (m.phase === 'idle' || dead.has(id)) return;
  dead.add(id);
  const victim = getPlayer(id);
  if (victim && weapon === 'left') { victim.alive = false; victim.life = LIFE.DEAD; }
  let alive = 0;
  for (const e of state.players.values()) if (isAlive(e)) alive++;
  m.alive = alive;
  // the authority's match time of the death (a peer's clock agrees with ours to a few ms); else the time it reached us
  deaths.set(id, { at: Number.isFinite(at) ? at : Math.round(m.time * 1000) / 1000, by: by || null, weapon: weapon || null });
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
  if (id === state.selfId) m.stats.survived = Math.max(0, deaths.get(id).at);
  // an earlier death that reached us late moves our own placement down a rank (the death screen reads it)
  if (deaths.has(state.selfId) && m.phase !== 'ended') m.placement = placeOf(state.selfId);
  if (m.phase === 'ended') revise();
}

function onDamaged({ id, amount, from }) {
  if (state.match.phase === 'idle' || !from || from === id || !(amount > 0)) return;
  if (from === state.selfId) return;                   // the local counter mirrors stats.damage (combat/damage)
  const a = getPlayer(from);
  if (a) a.damage = (a.damage || 0) + amount;
}

function leftMatch(id, at) {
  const m = state.match;
  if (m.phase === 'idle' || m.phase === 'ended') return;
  const e = getPlayer(id);
  if (!e || e.kind !== 'remote' || !e.alive || dead.has(id)) return;
  emit(EV.PLAYER_KILLED, { id, by: null, weapon: 'left', headshot: false, pos: [e.pos.x, e.pos.y, e.pos.z], at: Number.isFinite(at) ? at : undefined });
}

/**
 * Only net/sync's liveness drop counts here; a transport-level disconnect alone is decided by liveness first. The
 * player is ranked from the moment he was last heard, which every client knows to within a network delay.
 */
function onPeerLeave({ id, reason }) {
  if (reason !== 'timeout') return;
  const heard = safe(() => sync.lastHeardAt(id), null);
  leftMatch(id, heard != null && heard > state.match.t0 ? Math.round(heard - state.match.t0) / 1000 : undefined);
}

function onNetLeave({ from, data }) {
  if (!data || data.mid !== state.match.id) return;
  leftMatch(from);
}

/** This client lost its place in the match (see the header). */
function forfeit(reason) {
  const m = state.match;
  if (!state.online || m.phase === 'idle' || m.netLost) return;
  m.netLost = reason || 'link';
  safe(() => session.setSelfOut(true), null);
  const me = localPlayer();
  if (me && me.alive && m.phase !== 'ended') safe(() => damage.kill(me.id, null, 'left', false, null), null);
}

function onHostChanged({ hostId, self, migrated }) {
  const m = state.match;
  if (m.phase === 'idle') return;
  for (const e of state.players.values()) if (e.kind === 'bot') e.owner = hostId;
  // a context switch (the match just began) is not a migration: bots.setup already built the brains
  if (self && migrated !== false && m.phase !== 'ended') bots.takeOver();
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
  on(EV.NET_LEAVE, onNetLeave);
  on(EV.NET_LINK, ({ state: st, reason }) => { if (st === 'lost') forfeit(reason); });
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
    forfeit: (reason = 'link') => { forfeit(reason); return state.match.netLost; },
    scoreboard: () => scoreboard(),
  });
}

/** Seconds since the match ended (0 while running). GAME addition for the UI. */
export const endedFor = () => (endedAt ? (performance.now() - endedAt) / 1000 : 0);

/**
 * Scoreboard rows (GAME addition for the UI's Tab overlay and results screen): every roster entry with
 * {id, name, kind:'human'|'bot', self, alive, kills, damage, place (0 while alive), by, byName, weapon, at}.
 * Places come from the death times (see the header), so every client lists the same order. A winner who died in a
 * final trade keeps place 1 and its cause. Sorted: living players by kills then damage, then the dead best first.
 */
export function scoreboard() {
  const rows = [];
  const m = state.match;
  for (const r of m.roster) {
    const e = getPlayer(r.id);
    const d = deaths.get(r.id) || null;
    const alive = !d && isAlive(e);
    const place = d ? placeOf(r.id) : (m.phase === 'ended' && r.id === m.winnerId ? 1 : 0);
    const by = d && d.by ? getPlayer(d.by) : null;
    rows.push({
      id: r.id, name: r.name, kind: r.kind, self: r.id === state.selfId, alive,
      kills: e ? e.kills || 0 : 0, damage: Math.round(e ? e.damage || 0 : 0),
      place, by: d ? d.by : null, byName: by ? by.name : null, weapon: d ? d.weapon : null, at: d ? d.at : null,
    });
  }
  rows.sort((a, b) => {
    const pa = a.place || 0, pb = b.place || 0;
    if (pa === 1 || pb === 1) return pa === pb ? 0 : pa === 1 ? -1 : 1;
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    if (a.alive) return b.kills - a.kills || b.damage - a.damage;
    return pa - pb;
  });
  return rows;
}
