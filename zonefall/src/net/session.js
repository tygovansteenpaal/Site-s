// ZONEFALL - Trystero (Nostr) room, peers, host election, channels. OWNER: NET. Contract: ARCHITECTURE.md 5.5 and 8.
// Transport: Trystero's Nostr strategy is imported lazily inside connect(), so the menu and practice mode never wait for
// the CDN or the relays. `?net=local` swaps in net/localroom.js (BroadcastChannel between tabs) for tests; the rest of
// this module is identical for both transports.
// Channels: reliable Trystero actions (JSON, one per protocol.ACTIONS entry, every payload validated) and one
// unreliable, unordered RTCDataChannel per peer (negotiated id NET.channelId) for PSNAP/BOTS/SHOT. Until that channel is
// open, binary goes through the reliable 'bin' action. Host = lexicographically lowest id among self and the non-stale
// peers (during a match: among the roster's humans), recomputed on every membership or liveness change.
import { NET } from '../config.js';
import { emit, on, EV, registerEvents } from '../core/bus.js';
import { state, debug, APP } from '../core/state.js';
import { PROTOCOL_VERSION, ACTIONS, validate, toArrayBuffer } from './protocol.js';

const Q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');

export const TUNE = {
  transport: Q.get('net') === 'local' ? 'local' : 'nostr',   // 'nostr' (production) | 'local' (BroadcastChannel tests)
  protocol: Q.has('netv') ? Number(Q.get('netv')) : PROTOCOL_VERSION, // test-only override to exercise the mismatch path
  forceFallback: Q.has('netnochan'),                                  // test-only: never open the unreliable channel
  pingEveryMs: 2000,
  diagEveryMs: 3000,
  relayPollMs: 100,
  channelRetryMs: 250,
  channelTries: 80,
  binaryLimitMult: 4,      // binary allowance per peer = NET.maxMsgsPerSec x this (20 Hz PSNAP + shots fit easily)
  hostLimitMult: 3,        // the host also carries BOTS batches, bot shots and bot hits
  muteMs: 1000,
  joinErrorToastMs: 6000,
  rttLambda: 0.3,          // EMA weight of a new ping sample
};

/** Events for actions added after the core set: vehicles (game/vehicles) and rockets (combat/rockets). */
export const NEV = registerEvents({ NET_VEH: 'net:veh', NET_RKT: 'net:rkt' });   // {from, data}

const ACTION_EVENT = {
  hello: EV.NET_HELLO, lobby: EV.NET_LOBBY, start: EV.NET_START, hit: EV.NET_HIT, death: EV.NET_DEATH,
  pick: EV.NET_PICK, drop: EV.NET_DROP, nade: EV.NET_NADE, veh: NEV.NET_VEH, rkt: NEV.NET_RKT,
};
const ACTION_NAMES = Object.values(ACTIONS);

// ------------------------------------------------------------------------------------------------ module state
let room = null;
let roomId = null;
let transport = null;
let mySelf = null;
let relaySockets = null;           // () => object/Map of url -> WebSocket-like
let acts = {};                     // action name -> Trystero action
let binHandler = null;
let curHost = null;
let curEpoch = 0;
let status = 'offline';
let statusText = 'Offline';
let relaysOpen = 0;
let timers = [];
let connectToken = 0;
const peerMap = new Map();           // id -> Peer
const chByPc = new WeakMap();      // RTCPeerConnection -> our negotiated channel (Trystero may share a connection between rooms)
let joinSeq = 0;
const counters = { joinErrors: 0, lastJoinError: null, lastJoinErrorAt: 0, lastToastAt: 0, invalid: 0, muted: 0, hostConflicts: 0 };

function makePeer(id) {
  return {
    id, seq: ++joinSeq, joinedAt: performance.now(), stale: false, dropped: false,
    rtt: 0, rttMin: Infinity, pings: 0, channel: null, chTimer: null, pc: null, pair: '?',
    win: { t: 0, rel: 0, bin: 0 }, mutedUntil: 0,
    rx: { rel: 0, unrel: 0, fallback: 0, invalid: 0, bytes: 0 }, tx: { rel: 0, unrel: 0, fallback: 0, dropped: 0, bytes: 0 },
  };
}

// ------------------------------------------------------------------------------------------------ status
function setStatus(s, text) {
  status = s;
  statusText = text;
  emit(EV.NET_STATUS, { status: s, text, relaysOpen });
}

function countRelays() {
  if (!relaySockets) return 0;
  let socks;
  try { socks = relaySockets(); } catch { return 0; }
  if (!socks) return 0;
  const list = socks instanceof Map ? [...socks.values()] : Object.values(socks);
  let n = 0;
  for (const s of list) if (s && s.readyState === 1) n++;
  return n;
}

// ------------------------------------------------------------------------------------------------ connect / leave
// Relays: the public Nostr list, unless the page is served by the ZONEFALL server app (server/), which publishes its
// own relay in /zonefall/server.json. Static hosts (Vercel, GitHub Pages) have no such file and keep the public list.
// A server that also publishes `room` carries all game traffic itself (net/wsbus.js), with no WebRTC between players.
let serverRelays, serverRoom = null;
async function relayList() {
  if (serverRelays === undefined) {
    serverRelays = null;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const res = await fetch(new URL('../../server.json', import.meta.url), { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(t);
      const j = res.ok ? await res.json() : null;
      if (j && Array.isArray(j.relays) && j.relays.length) serverRelays = j.relays.map((u) => new URL(u, location.href).href.replace(/^http/, 'ws'));
      if (j && typeof j.room === 'string' && j.room) serverRoom = new URL(j.room, location.href).href.replace(/^http/, 'ws');
    } catch (e) { serverRelays = null; serverRoom = null; }
  }
  return serverRelays || NET.relays;
}
export const usingServer = () => !!serverRelays;

// TURN relays for players who cannot connect directly (NET.turnEndpoint). Cached for an hour; failures retry after 60 s.
let turnCache = null, turnAt = -Infinity;
async function turnList() {
  const t = performance.now();
  if (turnCache && t - turnAt < 3600e3) return turnCache;
  if (!turnCache && t - turnAt < 60e3) return NET.turn;
  turnAt = t;
  if (!NET.turnEndpoint) return NET.turn;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), NET.turnTimeoutMs);
    const res = await fetch(NET.turnEndpoint, { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(timer);
    const j = res.ok ? await res.json() : null;
    const list = j && Array.isArray(j.iceServers) ? j.iceServers.filter((s) => s && s.urls) : [];
    turnCache = list.length ? [...NET.turn, ...list] : null;
  } catch (e) { turnCache = null; }
  return turnCache || NET.turn;
}
export const turnReady = () => !!turnCache;

/**
 * Join a room. Resolves once at least one relay socket is open; rejects after NET.relayTimeoutMs otherwise.
 * @param {{roomId:string, password?:string|null, transport?:'nostr'|'local'|'server'}} opts
 */
export async function connect(opts) {
  if (!opts || typeof opts.roomId !== 'string' || !opts.roomId) throw new Error('[NET/session] connect needs a roomId');
  if (room) leave();
  const token = ++connectToken;
  let kind = opts.transport || TUNE.transport;
  if (kind === 'nostr') { await relayList(); if (serverRoom) kind = 'server'; }
  setStatus('connecting', 'Connecting to matchmaking servers');

  const config = { appId: NET.appId };
  if (opts.password) config.password = String(opts.password);
  const callbacks = { onPeerHandshake, onJoinError };
  let r, self, sockets;
  try {
    if (kind === 'local') {
      const mod = await import('./localroom.js');
      self = state.selfId;
      r = mod.joinLocalRoom(config, opts.roomId, callbacks, self);
      sockets = () => ({ local: { readyState: 1 } });
    } else if (kind === 'server') {
      const [lr, bus] = await Promise.all([import('./localroom.js'), import('./wsbus.js')]);
      self = state.selfId;
      r = lr.joinLocalRoom(config, opts.roomId, callbacks, self, bus.wsBus(serverRoom));
      sockets = () => ({ server: { readyState: bus.openCount() > 0 ? 1 : 0 } });
    } else {
      const mod = await import('trystero');
      self = mod.selfId;
      const [urls, turn] = await Promise.all([relayList(), turnList()]);
      config.relayConfig = { urls };
      if (turn && turn.length) config.turnConfig = turn;
      r = mod.joinRoom(config, opts.roomId, callbacks);
      sockets = mod.getRelaySockets;
    }
  } catch (err) {
    if (token === connectToken) setStatus('error', "Can't reach matchmaking servers");
    throw new Error(`Can't reach matchmaking servers (${err && err.message || err})`);
  }
  if (token !== connectToken) { try { r.leave(); } catch { /* superseded */ } throw new Error('Connection cancelled'); }

  room = r; roomId = opts.roomId; transport = kind; mySelf = self; relaySockets = sockets;
  acts = {};
  for (const name of ACTION_NAMES) {
    const a = room.makeAction(name);
    a.onMessage = (data, meta) => onAction(name, data, meta && typeof meta === 'object' ? meta.peerId : meta);
    acts[name] = a;
  }
  room.onPeerJoin = (id) => addPeer(id);
  room.onPeerLeave = (id) => removePeer(id, 'left');

  // Wait for a relay socket (Trystero opens them lazily on join).
  const t0 = performance.now();
  await new Promise((resolve, reject) => {
    const tick = () => {
      if (token !== connectToken) { reject(new Error('Connection cancelled')); return; }
      relaysOpen = countRelays();
      if (relaysOpen > 0) { resolve(); return; }
      if (performance.now() - t0 > NET.relayTimeoutMs) { reject(new Error("Can't reach matchmaking servers")); return; }
      setTimeout(tick, TUNE.relayPollMs);
    };
    tick();
  }).catch((err) => {
    if (token === connectToken) {
      teardown();
      setStatus('error', "Can't reach matchmaking servers");
    }
    throw err;
  });

  state.selfId = mySelf;
  state.online = true;
  curEpoch = 0;
  curHost = null;
  elect();
  timers.push(setInterval(pingAll, TUNE.pingEveryMs));
  timers.push(setInterval(refreshDiagnostics, TUNE.diagEveryMs));
  setStatus('online', relayText());
  return { roomId, selfId: mySelf };
}

function relayText() {
  if (transport === 'server') return 'Connected to the ZONEFALL server';
  return transport === 'local' ? 'Connected (local test transport)' : `Connected to ${relaysOpen} relay${relaysOpen === 1 ? '' : 's'}`;
}

/** Leave the room (graceful: peers notified in ~0.2 s). state.online = false, isHost = true. */
export function leave() {
  connectToken++;
  if (!room && !state.online) return;
  teardown();
  setStatus('offline', 'Offline');
}

function teardown() {
  const r = room;
  room = null;
  for (const t of timers) clearInterval(t);
  timers = [];
  const ids = [...peerMap.keys()];
  for (const id of ids) removePeer(id, 'self-left', true);
  if (r) { try { const p = r.leave(); if (p && p.catch) p.catch(() => {}); } catch { /* already gone */ } }
  acts = {};
  roomId = null;
  relaysOpen = 0;
  state.online = false;
  state.isHost = true;
  state.hostId = null;
  curHost = null;
  curEpoch = 0;
}

// ------------------------------------------------------------------------------------------------ handshake
async function onPeerHandshake(peerId, send, receive) {
  await send({ v: TUNE.protocol, app: NET.appId });
  const got = await receive();
  const d = got && typeof got === 'object' && 'data' in got ? got.data : got;
  if (!d || d.v !== TUNE.protocol) throw new Error(`protocol mismatch ${TUNE.protocol}/${d && d.v}`);
}

function onJoinError(e) {
  const text = String((e && e.error) || e || 'join error');
  counters.joinErrors++;
  counters.lastJoinError = text;
  const now = performance.now();
  counters.lastJoinErrorAt = now;
  if (now - counters.lastToastAt < TUNE.joinErrorToastMs) return;   // a bad room streams these about once a second
  if (/mismatch/i.test(text)) {
    counters.lastToastAt = now;
    emit(EV.TOAST, { text: 'A player in this lobby runs a different game version. Reload the page to update.', kind: 'warn', ms: 5000 });
  } else if (/password/i.test(text)) {
    counters.lastToastAt = now;
    emit(EV.TOAST, { text: 'Lobby code rejected by another player.', kind: 'warn', ms: 4000 });
  }
}

// ------------------------------------------------------------------------------------------------ peers
function addPeer(id) {
  if (!room || !id || id === mySelf) return;
  let p = peerMap.get(id);
  if (p) return;
  p = makePeer(id);
  peerMap.set(id, p);
  openChannel(p, 0);
  emit(EV.PEER_JOIN, { id });
  elect();
  pingPeer(p);
}

function removePeer(id, reason, silentElect = false) {
  const p = peerMap.get(id);
  if (!p) return;
  peerMap.delete(id);
  clearTimeout(p.chTimer);
  if (p.channel) { const ch = p.channel; p.channel = null; ch.onmessage = null; ch.onclose = null; }
  if (!p.dropped) emit(EV.PEER_LEAVE, { id, reason });
  if (!silentElect) elect();
}

/** Connected, non-stale peer ids (join order). */
export function peers() {
  const out = [];
  for (const p of peerMap.values()) if (!p.stale && !p.dropped) out.push(p.id);
  return out;
}

/** Every connected peer id, stale or not (diagnostics, lobby roster). */
export function allPeers() { return [...peerMap.keys()]; }

export function online() { return !!room && state.online; }
export function selfId() { return mySelf || state.selfId; }
export function hostId() { return curHost; }
export function isHost() { return !state.online || curHost === selfId(); }
export function epoch() { return curEpoch; }
export function roomName() { return roomId; }
export function transportKind() { return transport; }

/** Join order index of a peer (lower joined earlier, from this client's point of view). */
export function joinIndex(id) { return id === selfId() ? 0 : (peerMap.get(id)?.seq ?? Infinity); }

/** Mark a peer stale/fresh (net/sync calls this from snapshot liveness); stale peers are ignored for host election. */
export function setStale(peerId, stale) {
  const p = peerMap.get(peerId);
  if (!p || p.stale === !!stale) return;
  p.stale = !!stale;
  elect();
}

/**
 * A peer silent for NET.dropMs during a match counts as gone: PEER_LEAVE is emitted once (match turns it into a 'left'
 * death) and its traffic is ignored until the app returns to the lobby. Called by net/sync.
 */
export function markDropped(peerId) {
  const p = peerMap.get(peerId);
  if (!p || p.dropped) return;
  emit(EV.PEER_LEAVE, { id: peerId, reason: 'timeout' });
  p.dropped = true;
  elect();
}

on(EV.APP_STATE, ({ to }) => {
  if (to === APP.LOBBY || to === APP.MENU) {
    // A new round: peers that timed out during the match but are still connected are welcome again.
    for (const p of peerMap.values()) {
      if (!p.dropped) continue;
      p.dropped = false;
      p.stale = false;
      emit(EV.PEER_JOIN, { id: p.id });
    }
  }
  elect();
});
on(EV.MATCH_START, () => elect());

// ------------------------------------------------------------------------------------------------ host election
/**
 * Pure election rule (exported for tests): the lexicographically lowest id among self and the live peers; during a match
 * only the roster's humans are candidates, so a late joiner waiting for the next round never takes over the bots.
 * @param {string} self  @param {Array<{id:string, stale?:boolean, dropped?:boolean}>} list  @param {string[]|null} rosterHumans
 */
export function electHost(self, list, rosterHumans = null) {
  let ids = [self];
  for (const p of list) if (!p.stale && !p.dropped) ids.push(p.id);
  if (rosterHumans && rosterHumans.length) {
    const set = new Set(rosterHumans);
    const f = ids.filter((id) => set.has(id));
    if (f.length) ids = f;
  }
  let best = ids[0];
  for (const id of ids) if (id < best) best = id;
  return best;
}

function rosterHumans() {
  const inMatch = (state.app === APP.MATCH || state.app === APP.RESULTS) && state.match.phase !== 'idle';
  if (!inMatch || !Array.isArray(state.match.roster)) return null;
  return state.match.roster.filter((r) => r.kind === 'human').map((r) => r.id);
}

function elect() {
  if (!room || !state.online) return;
  const self = selfId();
  const next = electHost(self, [...peerMap.values()], rosterHumans());
  if (next === curHost) return;
  const prev = curHost;
  curHost = next;
  state.hostId = next;
  state.isHost = next === self;
  if (state.isHost && prev !== null) {
    curEpoch++;                                   // migration: a new term, announced to whoever is still here
    if (peerMap.size) send(ACTIONS.HOST, { ep: curEpoch, id: self });
  } else if (prev === self && next !== self) {
    // Hand the epoch to the new host so its messages carry the newest one.
    send(ACTIONS.HOST, { ep: curEpoch, id: next }, next);
  }
  emit(EV.HOST_CHANGED, { hostId: next, epoch: curEpoch, self: state.isHost });
}

function onHostMessage(d, from) {
  if (d.id === curHost) {
    curEpoch = Math.max(curEpoch, d.ep);
  } else if (d.ep > curEpoch) {
    counters.hostConflicts++;   // our view of the membership differs from the sender's; liveness will converge
    elect();
  }
}

// ------------------------------------------------------------------------------------------------ reliable actions
/** Reliable send of a protocol action payload to everyone or one peer. Returns false when offline. */
export function send(action, data, target = null) {
  if (!room || !state.online) return false;
  const a = acts[action];
  if (!a) throw new Error(`[NET/session] unknown action '${action}'`);
  try {
    const opts = target ? { target } : undefined;
    const pr = a.send(data, opts);
    if (pr && pr.catch) pr.catch(() => {});
  } catch (err) {
    console.warn('[NET/session] send failed', action, err);
    return false;
  }
  if (target) { const p = peerMap.get(target); if (p) p.tx.rel++; } else for (const p of peerMap.values()) p.tx.rel++;
  return true;
}

function rateOk(p, binary) {
  const now = performance.now();
  if (now < p.mutedUntil) return false;
  if (now - p.win.t >= 1000) { p.win.t = now; p.win.rel = 0; p.win.bin = 0; }
  const hostMult = p.id === curHost ? TUNE.hostLimitMult : 1;
  if (binary) {
    if (++p.win.bin > NET.maxMsgsPerSec * TUNE.binaryLimitMult * hostMult) { p.mutedUntil = now + TUNE.muteMs; counters.muted++; return false; }
  } else if (++p.win.rel > NET.maxMsgsPerSec * hostMult) { p.mutedUntil = now + TUNE.muteMs; counters.muted++; return false; }
  return true;
}

function onAction(name, data, from) {
  const p = peerMap.get(from);
  if (!p || p.dropped) return;
  if (name === ACTIONS.BIN) { onBinaryIn(p, data, false); return; }
  if (!rateOk(p, false)) return;
  p.rx.rel++;
  const v = validate[name] ? validate[name](data) : null;
  if (!v) { p.rx.invalid++; counters.invalid++; return; }
  if (name === ACTIONS.HOST) { onHostMessage(v, from); return; }
  if ((name === ACTIONS.LOBBY || name === ACTIONS.START) && from === curHost) curEpoch = Math.max(curEpoch, v.ep);
  emit(ACTION_EVENT[name], { from, data: v });
}

// ------------------------------------------------------------------------------------------------ binary
/** Register the single binary consumer (net/sync): fn(fromPeerId, arrayBuffer). */
export function setBinaryHandler(fn) { binHandler = typeof fn === 'function' ? fn : null; }

function onBinaryIn(p, data, unreliable) {
  if (!p || p.dropped || !rateOk(p, true)) return;
  const buf = toArrayBuffer(data);
  if (!buf || buf.byteLength > NET.maxReceiveBytes) { p.rx.invalid++; return; }
  if (unreliable) p.rx.unrel++; else p.rx.fallback++;
  p.rx.bytes += buf.byteLength;
  if (binHandler) binHandler(p.id, buf);
}

/** Unreliable send of a binary message (ArrayBuffer) to everyone or one peer (reliable 'bin' fallback until open). */
export function sendBinary(buf, target = null) {
  if (!room || !state.online) return 0;
  let n = 0;
  if (target) { const p = peerMap.get(target); if (p) n += sendBinTo(p, buf); return n; }
  for (const p of peerMap.values()) n += sendBinTo(p, buf);
  return n;
}

function sendBinTo(p, buf) {
  if (p.dropped) return 0;
  const ch = p.channel;
  if (ch && ch.readyState === 'open') {
    if (ch.bufferedAmount > NET.bufferedLimit) { p.tx.dropped++; return 0; }   // drop instead of queueing stale snapshots
    try { ch.send(buf); } catch { p.tx.dropped++; return 0; }
    p.tx.unrel++; p.tx.bytes += buf.byteLength;
    return 1;
  }
  const a = acts[ACTIONS.BIN];
  if (!a) return 0;
  const pr = a.send(buf, { target: p.id });
  if (pr && pr.catch) pr.catch(() => {});
  p.tx.fallback++; p.tx.bytes += buf.byteLength;
  return 1;
}

// ------------------------------------------------------------------------------------------------ unreliable channel
function openChannel(p, tries) {
  clearTimeout(p.chTimer);
  if (!room || peerMap.get(p.id) !== p || p.channel || TUNE.forceFallback) return;
  if (typeof room.openUnreliable === 'function') { attachChannel(p, room.openUnreliable(p.id), null); return; }
  const pc = (room.getPeers() || {})[p.id];
  const ready = pc && (pc.sctp ? pc.sctp.state === 'connected' : pc.connectionState === 'connected');
  if (!ready) {
    if (tries < TUNE.channelTries) p.chTimer = setTimeout(() => openChannel(p, tries + 1), TUNE.channelRetryMs);
    return;
  }
  let ch = chByPc.get(pc);
  if (!ch || ch.readyState === 'closing' || ch.readyState === 'closed') {
    try {
      // negotiated + same id on both sides: no renegotiation, it opens as soon as SCTP is up on both ends
      ch = pc.createDataChannel('zf-snap', { negotiated: true, id: NET.channelId, ordered: false, maxRetransmits: 0 });
    } catch (err) {
      if (tries < TUNE.channelTries) p.chTimer = setTimeout(() => openChannel(p, tries + 1), TUNE.channelRetryMs * 2);
      return;
    }
    ch.binaryType = 'arraybuffer';
    chByPc.set(pc, ch);
  }
  attachChannel(p, ch, pc);
}

function attachChannel(p, ch, pc) {
  p.channel = ch;
  p.pc = pc;
  ch.onmessage = (e) => { const q = peerMap.get(p.id); if (q === p) onBinaryIn(p, e.data, true); };
  ch.onclose = () => {
    if (p.channel !== ch) return;
    p.channel = null;
    if (pc) chByPc.delete(pc);
    if (peerMap.get(p.id) === p) p.chTimer = setTimeout(() => openChannel(p, 0), 500);
  };
}

// ------------------------------------------------------------------------------------------------ ping, diagnostics
/** Round trip in ms (Trystero room.ping). */
export async function ping(peerId) {
  const p = peerMap.get(peerId);
  if (!room || !p) throw new Error(`[NET/session] no peer ${peerId}`);
  return pingPeer(p);
}

async function pingPeer(p) {
  if (!room) return 0;
  try {
    const ms = await room.ping(p.id);
    if (!Number.isFinite(ms) || peerMap.get(p.id) !== p) return 0;
    p.rtt = p.pings === 0 ? ms : p.rtt + (ms - p.rtt) * TUNE.rttLambda;
    p.rttMin = Math.min(p.rttMin, ms);
    p.pings++;
    return ms;
  } catch { return 0; }
}

function pingAll() { for (const p of peerMap.values()) if (!p.dropped) pingPeer(p); }

/** Last measured RTT in ms (0 if unknown). */
export function rtt(peerId) { return peerMap.get(peerId)?.rtt || 0; }

/** Lowest RTT seen for a peer in ms (0 if unknown); net/sync uses it to turn the snapshot clock offset into a skew. */
export function rttMin(peerId) { const v = peerMap.get(peerId)?.rttMin; return Number.isFinite(v) ? v : 0; }

async function refreshDiagnostics() {
  const n = countRelays();
  if (n !== relaysOpen) { relaysOpen = n; if (status === 'online') setStatus('online', relayText()); }
  if (!room) return;
  let pcs = {};
  try { pcs = room.getPeers() || {}; } catch { pcs = {}; }
  for (const p of peerMap.values()) {
    const pc = pcs[p.id];
    if (pc && p.pc && pc !== p.pc) {          // Trystero replaced the connection: rebuild our channel on the new one
      if (p.channel) { p.channel.onmessage = null; p.channel.onclose = null; p.channel = null; }
      openChannel(p, 0);
    } else if (!p.channel) openChannel(p, 0);
    if (pc && typeof pc.getStats === 'function') p.pair = await icePair(pc).catch(() => p.pair);
    else if (transport === 'local' || transport === 'server') p.pair = transport;
  }
}

async function icePair(pc) {
  const stats = await pc.getStats();
  let pairId = null;
  stats.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId; });
  let pair = pairId ? stats.get(pairId) : null;
  if (!pair) stats.forEach((s) => { if (!pair && s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
  if (!pair) return '?';
  const lt = stats.get(pair.localCandidateId)?.candidateType, rt = stats.get(pair.remoteCandidateId)?.candidateType;
  if (lt === 'relay' || rt === 'relay') return 'relay';
  if (lt === 'srflx' || rt === 'srflx' || lt === 'prflx' || rt === 'prflx') return 'srflx';
  return lt === 'host' ? 'host' : '?';
}

/** {relaysOpen, peers: [{id, rtt, channel:'unreliable'|'fallback', pair:'host'|'srflx'|'relay'|'local'|'?'}], ...} */
export function diagnostics() {
  return {
    status, text: statusText, transport, roomId, selfId: selfId(), hostId: curHost, epoch: curEpoch, isHost: isHost(), relaysOpen,
    joinErrors: counters.joinErrors, lastJoinError: counters.lastJoinError, invalid: counters.invalid, muted: counters.muted,
    hostConflicts: counters.hostConflicts,
    peers: [...peerMap.values()].map((p) => ({
      id: p.id, rtt: Math.round(p.rtt), rttMin: Number.isFinite(p.rttMin) ? Math.round(p.rttMin) : 0,
      channel: p.channel && p.channel.readyState === 'open' ? 'unreliable' : 'fallback', pair: p.pair,
      stale: p.stale, dropped: p.dropped, rx: { ...p.rx }, tx: { ...p.tx },
    })),
  };
}

debug.net = Object.assign(debug.net || {}, { diag: diagnostics, session: { TUNE, electHost, peers: () => peerMap } });
