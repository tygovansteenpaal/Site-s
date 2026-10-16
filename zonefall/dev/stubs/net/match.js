// ZONEFALL dev harness stand-in for game/match.js (NET harness only, never shipped in index.html).
// It implements the network half of the match contract exactly as ARCHITECTURE.md 8.4/8.5 describes it, so dev/net.html
// can show a full start round trip: the host builds the roster (humans in join order, then bots), picks seed and
// match id, broadcasts 'start' {mid, seed, t0h, th, ro, ep} MATCH.startLeadMs early and begins; every other peer begins
// from the validated payload with t0 = t0h + sync.clockOffset(host) (fallback now + (t0h - th) - rtt/2).
// Everything gameplay-related (plane, zone, loot, bots AI) is out of scope here; the harness page moves the dummies.
import { MATCH, BOTS } from '../../../src/config.js';
import { on, emit, EV } from '../../../src/core/bus.js';
import { state, createPlayer, resetMatchState, randomId, botId, LIFE } from '../../../src/core/state.js';
import * as session from '../../../src/net/session.js';
import * as sync from '../../../src/net/sync.js';
import * as lobby from '../../../src/net/lobby.js';

export const HARNESS = { bots: 6, lastStart: null };

export function init() {
  on(EV.NET_START, ({ from, data }) => {
    if (from !== session.hostId()) return;            // only the current host may start a match
    if (!data.ro.some((r) => r.id === state.selfId)) return;   // full roster without us: wait in the lobby (net/lobby)
    beginFromNetwork(data, from);
  });
  on(EV.PEER_LEAVE, ({ id }) => {
    const e = state.players.get(id);
    if (e && e.alive && state.match.phase !== 'idle') emit(EV.PLAYER_KILLED, { id, by: null, weapon: 'left', headshot: false, pos: [e.pos.x, e.pos.y, e.pos.z] });
  });
  on(EV.PLAYER_KILLED, ({ id }) => {
    const e = state.players.get(id);
    if (e && (e.kind === 'local' || (e.kind === 'bot' && state.isHost))) e.alive = false;
  });
}

export function startPractice() { begin({ mid: randomId(8), seed: 1, ro: [{ id: state.selfId, name: state.name, kind: 'human', slot: 0 }] }, performance.now(), 'practice'); }

export function hostBegin(humans) {
  const seed = (Math.random() * 0xffffffff) >>> 0;
  const ro = humans.slice(0, MATCH.maxHumans).map((h, i) => ({ id: h.id, name: h.name, kind: 'h', slot: i }));
  const names = BOTS.names;
  for (let i = 0; i < HARNESS.bots && ro.length < MATCH.maxPlayers; i++) {
    const slot = ro.length;
    ro.push({ id: botId(slot), name: names[(seed + i * 7) % names.length], kind: 'b', slot });
  }
  const th = performance.now();
  const msg = { mid: randomId(8), seed, t0h: th + MATCH.startLeadMs, th, ro, ep: session.epoch() };
  session.send('start', msg);
  begin({ ...msg, ro: ro.map((r) => ({ ...r, kind: r.kind === 'b' ? 'bot' : 'human' })) }, msg.t0h, state.online ? lobby.get().mode : 'practice');
}

export function beginFromNetwork(start, from) {
  const off = sync.clockOffset(from);
  const t0 = off != null ? start.t0h + off : performance.now() + (start.t0h - start.th) - session.rtt(from) / 2;
  HARNESS.lastStart = { from, offset: off, t0, usedFallback: off == null };
  begin(start, t0, lobby.get().mode);
}

function begin(start, t0, mode) {
  resetMatchState();
  for (const r of start.ro) {
    const kind = r.id === state.selfId ? 'local' : r.kind === 'bot' ? 'bot' : 'remote';
    const e = createPlayer({ id: r.id, name: r.name, kind, owner: r.kind === 'bot' ? session.hostId() : r.id, slot: r.slot });
    e.life = LIFE.GROUND;
  }
  Object.assign(state.match, { id: start.mid, seed: start.seed, mode, phase: 'plane', t0, time: (performance.now() - t0) / 1000, roster: start.ro.map((r) => ({ ...r })), alive: start.ro.length });
  emit(EV.MATCH_START, { id: start.mid, seed: start.seed, t0, roster: state.match.roster, mode });
}

export function update() {
  if (state.match.phase === 'idle') return;
  state.match.time = (performance.now() - state.match.t0) / 1000;
  if (state.match.phase === 'plane' && state.match.time >= 0) {
    state.match.phase = 'live';
    emit(EV.MATCH_PHASE, { phase: 'live', prev: 'plane' });
  }
  let alive = 0;
  for (const p of state.players.values()) if (p.alive) alive++;
  state.match.alive = alive;
}

export function leave() { resetMatchState(); }

export function planePath() { return { a: [-900, 380, 0], b: [900, 380, 0], dir: [1, 0, 0], speed: MATCH.plane.speed, length: 1800, doorsOpenAt: 7, forceJumpAt: 24 }; }

export function planePosAt(t, out) { out.set(-900 + MATCH.plane.speed * t, MATCH.plane.altitude, 0); return out; }
