// ZONEFALL - Trystero (Nostr) room, peers, host election, channels, relay. OWNER: NET. Contract: ARCHITECTURE.md 5.5 and 8.
// Transport: Trystero's Nostr strategy is imported lazily inside connect(), so the menu and practice mode never wait for
// the CDN or the relays. `?net=local` swaps in net/localroom.js (BroadcastChannel between tabs) for tests; the rest of
// this module is identical for both transports.
// Channels: reliable Trystero actions (JSON, one per protocol.ACTIONS entry, every payload validated) and one
// unreliable, unordered RTCDataChannel per peer (negotiated id NET.channelId) for PSNAP/BOTS/SHOT. Until that channel is
// open, binary goes through the reliable 'bin' action.
// Joining (protocol 4): no Trystero room password (the private code is already part of the room id) and no handshake
// exchange: both ran inside Trystero's per-peer handshake queue, whose messages are keyed by peer id only, so under
// jitter and loss a stale challenge from a replaced connection failed the next attempt again and again and a pair of
// players never connected. A connected peer counts (PEER_JOIN, rosters, election, snapshots) once its first 'hello'
// carries our game version; a hello of another version is a version mismatch the lobby explains.
// Relay: a peer we have no working direct connection to (symmetric NAT on both ends, a strict firewall, a link that broke
// mid-match), but that another player reaches directly, is reached through that player: reliable payloads ride in the
// 'fwd' action, binary in FWD frames; the relay player passes them on over its own direct link (one hop, never further).
// Hellos list every player's direct links (`ln`, with round trips `lr`), so each client picks the relay with the lowest
// total round trip and finds players it has never connected to. A direct connection that answers nothing for
// TUNE.directHealthyMs is bypassed through a relay while Trystero keeps trying to restore it; pings over the direct
// connection run on regardless, so the direct path comes back the moment it works. Rosters, host election and liveness
// treat a relayed peer exactly like a direct one, so the lobby and the match have one consistent view.
// Contexts: every peer is either in the lobby context (menu, lobby, results: match tag 0) or inside one match (tag =
// protocol.matchTag(match id)); the tag rides on every snapshot (net/sync calls notePeerContext). Host election only
// counts peers in this client's own context, so a player who went back to the lobby never stays host of the match he
// left, and players still in a match never host (or join) the lobby's next round.
//   lobby host = the peer that joined the room first (hello `js`, then the lowest id), so a private lobby's creator
//                keeps START NOW;
//   match host = the lowest id among the roster's humans still in that match (not left, dropped or unresponsive).
// Drops: a player silent past NET.dropMs is dropped by the match host, who announces it ('death' {w:'left'} for that
// player), so every client takes him out at the same moment; net/sync only drops on its own when it hears nobody at all.
// Connection repair: Trystero reuses one RTCPeerConnection per remote peer across rooms. A connection that died without
// a clean close (sleep, frozen tab) would be reused forever and every later handshake would time out, so a peer we drop,
// a peer still silent when we leave a room, and a peer whose handshake fails get their connection closed; Trystero
// then sees it as stale and negotiates a fresh one.
import { NET, DEV } from '../config.js';
import { emit, on, EV } from '../core/bus.js';
import { state, debug, APP } from '../core/state.js';
import { PROTOCOL_VERSION, ACTIONS, RELAYABLE, MSG, validate, toArrayBuffer, matchTag, AWAY_TAG, encodeFwd, decodeFwd, FWD_TO, FWD_FROM } from './protocol.js';

const Q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');

export const TUNE = {
  transport: Q.get('net') === 'local' ? 'local' : 'nostr',   // 'nostr' (production) | 'local' (BroadcastChannel tests)
  protocol: Q.has('netv') ? Number(Q.get('netv')) : PROTOCOL_VERSION, // test-only override to exercise the mismatch path
  forceFallback: Q.has('netnochan'),                                  // test-only: never open the unreliable channel
  pingEveryMs: 2000,
  diagEveryMs: 3000,
  electEveryMs: 500,       // re-evaluate the election as context grace periods run out
  relayPollMs: 100,
  channelRetryMs: 250,
  channelTries: 80,
  binaryLimitMult: 4,      // binary allowance per peer = NET.maxMsgsPerSec x this (20 Hz PSNAP + shots fit easily)
  hostLimitMult: 3,        // the host also carries BOTS batches, bot shots and bot hits
  muteMs: 1000,
  joinErrorToastMs: 6000,
  rttLambda: 0.3,          // EMA weight of a new ping sample
  ctxGraceMs: 2500,        // a peer that just switched context still counts in its old one (its 'start'/'leave' is in flight)
  startGraceMs: 8000,      // after our match starts, roster humans still showing the lobby tag count as on their way in
  repairToastAfter: 2,     // handshake failures with one peer before the player is told a connection is being repaired
  joinerBiasMs: 1e12,      // added to the join time a private-lobby joiner announces, so the creator (even one coming
                           // back after a refresh) hosts the lobby before anyone who joined by code
  mismatchShowMs: 300000,  // a version mismatch stays explained in the lobby while we stay in that room (up to this)
  mismatchToastMs: 20000,
  probeEveryMs: 3000,      // own-link probe (a HEAD request to the page's own origin) at most this often
  probeTimeoutMs: 4000,
  directHealthyMs: 3500,   // a direct connection that delivered nothing (not even a pong) this long is bypassed by a relay
  linksFreshMs: 6500,      // a hello's list of direct links counts for routing this long (hellos come every 2 s)
  routeLossMs: 5000,       // a relayed peer without any route and without relayed traffic this long is gone
  maintainEveryMs: 500,    // route upkeep, relayed peer discovery, re-greeting peers whose hello is outstanding
  greetEveryMs: 2500,      // a connected peer whose hello has not arrived is greeted again this often
  pendingMaxMs: 20000,     // a relayed peer that never answers our hello is forgotten after this
  pingStaleMs: 6000,       // a ping still unanswered after this no longer blocks the next one
  maxPeers: 40,
  failedShowMs: 30000,     // "could not connect" evidence about a player counts this long (lobby connectivity hints)
  attemptStuckMs: 15000,   // a connection attempt (offer/answer exchanged) still not connected after this has failed
  helloWaitMs: 12000,      // a peer Trystero connected that has not said hello this long (greeted 3+ times) is a
                           // one-sided handshake: its connection is closed so both sides negotiate a fresh one
  orphanMinMs: 8000,       // a connected peer connection nobody owns, whose Trystero channel has been open this long,
                           // is the leftover of a handshake that failed on our side (closed on that handshake error)
  rejoinEveryMs: 8000,     // soft room re-join after closing a broken connection (lobby only): at most this often ...
  rejoinBurst: 5,          // ... and this many times in two minutes
  lostGraceMs: 4000,       // a verified peer whose direct connection Trystero dropped (no relay either) is kept this
                           // long: a player re-joining the room (softRejoin) comes back within about a second
};

const ACTION_EVENT = {
  hello: EV.NET_HELLO, lobby: EV.NET_LOBBY, start: EV.NET_START, hit: EV.NET_HIT, death: EV.NET_DEATH,
  pick: EV.NET_PICK, drop: EV.NET_DROP, nade: EV.NET_NADE, leave: EV.NET_LEAVE, kick: EV.NET_KICK,
};
const RELAY_OK = new Set(RELAYABLE);
const ACTION_NAMES = Object.values(ACTIONS);
// Payloads that belong to one match: dropped unless their mid is the match this client is playing.
const IN_MATCH = new Set([ACTIONS.HIT, ACTIONS.DEATH, ACTIONS.PICK, ACTIONS.DROP, ACTIONS.NADE, ACTIONS.LEAVE, ACTIONS.KICK]);

// ------------------------------------------------------------------------------------------------ module state
let room = null;
let roomId = null;
let transport = null;
let mySelf = null;
let mySince = 0;                   // wall-clock ms this client joined the current room (lobby host = earliest)
let relaySockets = null;           // () => object/Map of url -> WebSocket-like
let acts = {};                     // action name -> Trystero action
let binHandler = null;
let curHost = null;
let curEpoch = 0;
let pendingHost = null;            // {id, ep, ctx}: a 'host' announcement for someone we have not elected yet
let status = 'offline';
let statusText = 'Offline';
let relaysOpen = 0;
let lastRelayMsgAt = 0;            // performance.now() of the last message from any relay socket (own link probe)
let probeOkAt = 0, probeFailAt = 0, probeAt = 0, probeBusy = false;   // own-link probe: start times of the last good/bad one
const probedSockets = new WeakSet();
const socketHeardAt = new WeakMap();  // relay socket -> performance.now() of its last message
let timers = [];
let connectToken = 0;
let myCtx = 0, myCtxAt = 0, myMid = null;
let selfOut = false;               // this client lost its place in the current match (connection lost, kicked)
let blackhole = false;             // test hook (debug.net.session.blackhole): drop all traffic both ways, like a dead network
const outIds = new Set();          // peers that left or were dropped from the match `outMid`
let outMid = null;
const peerMap = new Map();         // id -> Peer
const lastPc = new Map();          // peer id -> the last RTCPeerConnection seen for it (outlives rooms, like Trystero's)
const chByPc = new WeakMap();      // RTCPeerConnection -> our negotiated channel (Trystero may share a connection between rooms)
const repairs = new Map();         // peer id -> handshake failures since its connection was last reset
let joinSeq = 0;
const counters = {
  joinErrors: 0, lastJoinError: null, lastJoinErrorAt: 0, lastToastAt: 0, invalid: 0, muted: 0, hostConflicts: 0, resets: 0, wrongMatch: 0,
  relayedOut: 0, relayedIn: 0, relayPassed: 0, relayNoRoute: 0, relayDropped: 0, declared: 0, declAccepted: 0, declRejected: 0,
};
let mismatch = null;               // {theirs, ours, at, room, peer, first}: the last peer whose hello had another game version
let greeter = null;                // (peerId) => void: says hello to one peer (net/lobby), the moment a peer connects
const failed = new Map();          // peer id -> performance.now() of its last "SDP exchanged but could not connect" error
const directRxAt = new Map();      // peer id -> last time anything arrived from it over its own direct connection (kept
                                   // after the peer is gone: pathLost() asks how a silent player was reached)
const linkSeen = new Map();        // peer id -> Map(neighbour id -> last time that neighbour's hello listed a direct link
                                   // to it): who could relay it (pathLost)

function makePeer(id, direct) {
  const now = performance.now();
  return {
    id, seq: ++joinSeq, joinedAt: now, stale: false, dead: false, dropped: false,
    ctx: null, prevCtx: null, ctxAt: now, since: 0,
    rtt: 0, rttMin: Infinity, pings: 0, pingAt: 0, channel: null, chTimer: null, pc: null, pair: '?',
    win: { t: 0, rel: 0, bin: 0 }, mutedUntil: 0,
    rx: { rel: 0, unrel: 0, fallback: 0, invalid: 0, bytes: 0, relayed: 0 }, tx: { rel: 0, unrel: 0, fallback: 0, dropped: 0, bytes: 0, relayed: 0 },
    // version check (protocol 4): ok once a hello with our version arrived; incompatible after one with another.
    // directAt: when Trystero connected it directly; greets: hellos sent to it since (a one-sided handshake check)
    ok: false, incompatible: false, greetAt: 0, bye: false, directAt: direct ? now : 0, greets: 0,
    // routing: a direct Trystero connection and/or a relay player (via) that reaches it directly
    direct: !!direct, via: null, lastDirectRx: now, lastRelayRx: 0, noRouteSince: 0,
    links: null, linkRtt: null, linksAt: 0, hears: null, hearsAt: 0,
  };
}

// ------------------------------------------------------------------------------------------------ status
function setStatus(s, text) {
  status = s;
  statusText = text;
  emit(EV.NET_STATUS, { status: s, text, relaysOpen });
}

function socketList() {
  if (!relaySockets) return [];
  let socks;
  try { socks = relaySockets(); } catch { return []; }
  if (!socks) return [];
  return socks instanceof Map ? [...socks.values()] : Object.values(socks);
}

function countRelays() {
  let n = 0;
  for (const s of socketList()) {
    if (!s) continue;
    if (s.readyState === 1) n++;
    // Own-link probe: Nostr relays answer every announce (OK) and forward other peers' announces, so a healthy link
    // hears from some relay every few seconds. Trystero sets onmessage; an extra listener does not disturb it.
    if (typeof s.addEventListener === 'function' && !probedSockets.has(s)) {
      probedSockets.add(s);
      s.addEventListener('message', () => { lastRelayMsgAt = performance.now(); socketHeardAt.set(s, lastRelayMsgAt); });
    }
  }
  return n;
}

// ------------------------------------------------------------------------------------------------ connect / leave
/**
 * Join a room. Resolves once a relay works (open and answering); rejects after NET.relayTimeoutMs otherwise.
 * opts.joiner: a private-lobby joiner (not its creator); its announced join time is biased so the creator hosts.
 * No room password and no handshake callback (see the header): the version check happens on the first 'hello'.
 * @param {{roomId:string, transport?:'nostr'|'local', joiner?:boolean}} opts
 */
export async function connect(opts) {
  if (!opts || typeof opts.roomId !== 'string' || !opts.roomId) throw new Error('[NET/session] connect needs a roomId');
  if (room) leave();
  const token = ++connectToken;
  const kind = opts.transport || TUNE.transport;
  setStatus('connecting', 'Connecting to matchmaking servers');

  const config = { appId: NET.appId };
  const callbacks = { onJoinError };
  let r, self, sockets;
  try {
    if (kind === 'local') {
      const mod = await import('./localroom.js');
      self = state.selfId;
      // ?netsim on the test transport: localroom delays this page's outgoing messages only, so the whole ping goes there
      if (SIM && typeof mod.setLinkConditions === 'function') mod.setLinkConditions({ latency: SIM.ping, jitter: SIM.jitter, loss: SIM.loss });
      r = mod.joinLocalRoom(config, opts.roomId, callbacks, self);
      sockets = () => ({ local: { readyState: 1 } });
    } else {
      const mod = await loadTrystero();
      self = mod.selfId;
      config.relayConfig = { urls: NET.relays };
      if (NET.turn && NET.turn.length) config.turnConfig = NET.turn;
      const PC = peerConnectionClass();
      if (PC) config.rtcPolyfill = PC;
      r = mod.joinRoom(config, opts.roomId, callbacks);
      sockets = mod.getRelaySockets;
      joinArgs = { mod, config, callbacks };
    }
  } catch (err) {
    if (token === connectToken) setStatus('error', "Can't reach matchmaking servers");
    throw new Error(`Can't reach matchmaking servers (${err && err.message || err})`);
  }
  if (token !== connectToken) { try { r.leave(); } catch { /* superseded */ } throw new Error('Connection cancelled'); }

  room = r; roomId = opts.roomId; transport = kind; mySelf = self; relaySockets = sockets;
  roomAt = performance.now();
  mySince = Date.now() + (opts.joiner ? TUNE.joinerBiasMs : 0);
  bindRoom(room);

  // Wait for a relay that works: an open socket that has also spoken since we joined (Nostr relays answer the room
  // subscription with EOSE and the announce with OK within a round trip). A socket that opens and drops at once, or
  // accepts and never answers, is not matchmaking: that used to pass, and quick play then started a bot match alone.
  // countRelays() hooks every socket as soon as Trystero creates it, before it can open, so no answer is missed.
  const t0 = performance.now();
  if (kind !== 'local') keeperKick();          // relays that are down reconnect now, not at the keeper's next backoff step
  // An open relay socket that never answered is a dead path (a middlebox holding the connection, a relay that stopped
  // serving). Halfway through the wait the silent ones are replaced once (a network that came back meanwhile is picked
  // up in this attempt; the new sockets resubscribe the room when they open), and again on failure for the next one.
  const retireSilent = () => {
    if (kind === 'local') return;
    for (const ws of socketList()) if (ws && ws.readyState === 1 && !((socketHeardAt.get(ws) || 0) > t0)) dropSocket(ws);
    keeperKick();
  };
  let refreshed = false;
  await new Promise((resolve, reject) => {
    const tick = () => {
      if (token !== connectToken) { reject(new Error('Connection cancelled')); return; }
      relaysOpen = countRelays();
      if (relaysOpen > 0 && (kind === 'local' || lastRelayMsgAt > t0)) { resolve(); return; }
      if (!refreshed && performance.now() - t0 > NET.relayTimeoutMs / 2) { refreshed = true; retireSilent(); }
      if (performance.now() - t0 > NET.relayTimeoutMs) { retireSilent(); reject(new Error("Can't reach matchmaking servers")); return; }
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
  lastRelayMsgAt = performance.now();
  curEpoch = 0;
  curHost = null;
  pendingHost = null;
  refreshMyCtx();
  elect();
  timers.push(setInterval(pingAll, TUNE.pingEveryMs));
  timers.push(setInterval(refreshDiagnostics, TUNE.diagEveryMs));
  timers.push(setInterval(elect, TUNE.electEveryMs));
  timers.push(setInterval(maintain, TUNE.maintainEveryMs));
  setStatus('online', relayText());
  if (SIM && !simAnnounced) {
    simAnnounced = true;
    emit(EV.TOAST, { text: `Network simulation on: +${SIM.ping} ms ping, ${Math.round(SIM.loss * 100)}% loss, ${SIM.jitter} ms jitter.`, kind: 'warn', ms: 6000 });
  }
  return { roomId, selfId: mySelf };
}

/** Our actions and peer callbacks on a (new) Trystero room object. */
function bindRoom(r) {
  acts = {};
  for (const name of ACTION_NAMES) {
    const a = r.makeAction(name);
    a.onMessage = (data, meta) => onAction(name, data, meta && typeof meta === 'object' ? meta.peerId : meta);
    acts[name] = a;
  }
  r.onPeerJoin = (id) => addPeer(id);
  r.onPeerLeave = (id) => directLost(id);
}

/**
 * Re-join the Trystero room under the same id, keeping every session state (peers, routes, host, join time). Trystero
 * 0.25.4 announces itself on the relays only when it joins a room and then once a minute; it does not announce again
 * when an established connection dies. So after we close a broken connection (a one-sided handshake), the two players
 * would only find each other at the next minute's announce. A fresh room instance announces at once (and greets the
 * players it still has a working connection to over that connection, which Trystero keeps for 2 minutes), so the pair
 * negotiates a new connection within a few seconds. Those players see our room leave and come back within about a
 * second; directLost() keeps a verified peer through such a gap, so their rosters do not flicker. Lobby only (a match
 * must not lose reliable messages for that moment). At most every TUNE.rejoinEveryMs (a request inside that time runs
 * when it is over, so a repair that needs a second round still gets its announce) and TUNE.rejoinBurst times in 2 min.
 */
let joinArgs = null;               // {mod, config, callbacks} of the current Trystero room (soft re-join)
let rejoining = false, rejoinAt = -1e9, rejoinTimer = 0;
const rejoinTimes = [];
function softRejoin(why) {
  const now = performance.now();
  if (rejoinTimer) return false;                       // one already scheduled
  while (rejoinTimes.length && now - rejoinTimes[0] > 120000) rejoinTimes.shift();
  if (rejoinTimes.length >= TUNE.rejoinBurst) return false;
  const wait = rejoinAt + TUNE.rejoinEveryMs - now;
  if (wait > 0 || rejoining) {
    const tok = connectToken;
    rejoinTimer = setTimeout(() => { rejoinTimer = 0; if (tok === connectToken) softRejoin(why); }, Math.max(wait, 500));
    return false;
  }
  doRejoin(why);
  return true;
}
async function doRejoin(why) {
  const now = performance.now();
  refreshMyCtx();
  if (!room || !state.online || transport !== 'nostr' || !joinArgs || rejoining || myCtx !== 0) return false;
  rejoining = true;
  rejoinTimes.push(now);
  rejoinAt = now;
  const old = room, id = roomId, tok = connectToken;
  counters.rejoins = (counters.rejoins || 0) + 1;
  counters.lastRejoin = { why, at: Math.round(now) };
  try { old.onPeerJoin = null; old.onPeerLeave = null; } catch { /* closing */ }
  try { await old.leave(); } catch { /* already gone */ }
  if (room !== old || roomId !== id || connectToken !== tok) { rejoining = false; return false; }
  // players that never said hello are nobody's business yet: forget them, the new room meets them afresh
  for (const p of [...peerMap.values()]) if (!p.ok && !p.incompatible) removePeer(p.id, 'left', true);
  let r = null;
  try { r = joinArgs.mod.joinRoom(joinArgs.config, id, joinArgs.callbacks); } catch (err) { console.warn('[NET/session] re-join failed', err); }
  rejoining = false;
  if (!r) { teardown(); setStatus('error', "Can't reach matchmaking servers"); return false; }
  room = r;
  bindRoom(r);
  return true;
}

function relayText() {
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
  // Tell everyone, relayed peers included, that we are going: a relay player stops passing our traffic at once and
  // nobody keeps a relayed ghost of us waiting for a route timeout.
  if (room && state.online && !blackhole) { try { send(ACTIONS.BYE, {}); } catch { /* leaving anyway */ } }
  const r = room;
  room = null;
  for (const t of timers) clearInterval(t);
  timers = [];
  clearTimeout(rejoinTimer);
  rejoinTimer = 0;
  const ids = [...peerMap.keys()];
  for (const id of ids) {
    const p = peerMap.get(id);
    // A peer we stopped hearing from has a connection Trystero would carry into the next room; close it now.
    if (p && (p.dropped || p.stale || p.dead)) resetConnection(id, 'left-silent');
    removePeer(id, 'self-left', true);
  }
  if (r) { try { const p = r.leave(); if (p && p.catch) p.catch(() => {}); } catch { /* already gone */ } }
  acts = {};
  roomId = null;
  relaysOpen = 0;
  state.online = false;
  state.isHost = true;
  state.hostId = null;
  curHost = null;
  curEpoch = 0;
  pendingHost = null;
  selfOut = false;
  outIds.clear();
  outMid = null;
  failed.clear();
  directRxAt.clear();
  linkSeen.clear();
}

// ------------------------------------------------------------------------------------------------ version, join errors
/** The game protocol version this client speaks (hello `v`; `?netv=` overrides it in tests). */
export function protocolVersion() { return TUNE.protocol; }

/**
 * Register the function that says hello (net/lobby): fn(peerId) to one peer, the moment it connects (directly or via
 * a relay); fn(null) to everyone (helloNow).
 */
export function setGreeter(fn) { greeter = typeof fn === 'function' ? fn : null; }

let helloNowAt = 0;
/** Broadcast a hello now (at most every 400 ms): net/sync calls it when a player goes silent, so everyone learns at
 * once who still hears him (hello `hr`) instead of on the next 2 s tick. */
export function helloNow() {
  const now = performance.now();
  if (!greeter || !room || now - helloNowAt < 400) return;
  helloNowAt = now;
  try { greeter(null); } catch (err) { console.warn('[NET/session] hello failed', err); }
}

function greet(p) {
  if (!greeter || !room) return;
  p.greetAt = performance.now();
  if (state.online) p.greets++;              // a hello actually sent (before connect() resolves, sends are refused)
  try { greeter(p.id); } catch (err) { console.warn('[NET/session] greeting failed', err); }
}

/** A hello of another game version: remember it for the lobby text; the peer never counts as connected. */
function noteMismatch(p, theirs, js) {
  const now = performance.now();
  let first = js > 0 && mySince > 0 ? js < mySince : null;     // were they in this room before us?
  // any mismatching player who was here before us makes it their lobby we tried to join (a later joiner's hello
  // must not turn that around)
  if (mismatch && mismatch.room === roomId && mismatch.first === true && theirs === mismatch.theirs) first = true;
  mismatch = { theirs, ours: TUNE.protocol, at: now, room: roomId, peer: p ? p.id : null, first };
  if (p) p.incompatible = true;
  if (now - (counters.lastMismatchToastAt || -1e9) < TUNE.mismatchToastMs) return;
  counters.lastMismatchToastAt = now;
  counters.lastToastAt = now;
  const newer = theirs > TUNE.protocol;
  emit(EV.TOAST, {
    text: newer ? 'A newer version of ZONEFALL is out. Reload the page to update.' : 'A player with an older version of ZONEFALL cannot play with you until they reload their page.',
    kind: 'warn', ms: 6000,
  });
}

/**
 * A game-version mismatch seen in the current room (it stays valid while we stay in the room, up to
 * TUNE.mismatchShowMs): {theirs, ours, first} (first: they were in the room before us; null when unknown), else null.
 */
export function versionMismatch() {
  return mismatch && mismatch.room === roomId && roomId && performance.now() - mismatch.at < TUNE.mismatchShowMs ? { theirs: mismatch.theirs, ours: mismatch.ours, first: mismatch.first } : null;
}

function onJoinError(e) {
  const text = String((e && e.error) || e || 'join error');
  const peerId = e && typeof e === 'object' ? e.peerId : null;
  counters.joinErrors++;
  counters.lastJoinError = text;
  const now = performance.now();
  counters.lastJoinErrorAt = now;
  if (peerId && /incorrect room password/i.test(text)) {
    // Protocol 4 rooms have no password, so an offer we cannot decrypt comes from a client of protocol 3 or older
    // (which still encrypts with the lobby code): an older version.
    noteMismatch(null, Math.min(3, TUNE.protocol - 1), 0);
    if (mismatch) mismatch.peer = peerId;
    return;
  }
  if (peerId && /after exchanging SDP|could not connect/i.test(text)) failed.set(peerId, now);
  if (peerId && /timed out|could not connect|disconnected during handshake|handshake/i.test(text)) {
    // The usual cause: a connection to this peer that died silently and that Trystero keeps reusing. Close it so the
    // next attempt (Trystero re-announces every few seconds) negotiates a fresh one.
    const n = (repairs.get(peerId) || 0) + 1;
    repairs.set(peerId, n);
    // Trystero's own ready/ready exchange still runs without a password (10 s timeout). When it times out here but the
    // other side got our 'ready', that side activated us and treats the connection as live: it never offers again, and
    // Trystero here keeps re-attaching the same connection to a handshake whose answer never comes. That connection
    // belongs to no peer we know (Trystero never activated it), so it is found as the orphan and closed: the other side
    // sees the close and both negotiate a fresh connection.
    if (!resetConnection(peerId, 'handshake-failed') && /timed out|handshake/i.test(text) && closeOrphans('handshake-orphan')) softRejoin('handshake-orphan');
    // A player we still reach through a relay is not lost; the direct path keeps being retried quietly. Nor is a player
    // already out of our match (his connection is being rebuilt for the next round).
    const p = peerMap.get(peerId);
    const relayed = !!(p && p.ok && p.via);
    const versionPeer = mismatch && mismatch.peer === peerId && mismatch.room === roomId;
    const gone = selfOut || outIds.has(peerId) || !!(p && p.dropped);
    if (!relayed && !versionPeer && !gone && n >= TUNE.repairToastAfter && now - counters.lastToastAt >= TUNE.joinErrorToastMs) {
      counters.lastToastAt = now;
      emit(EV.TOAST, { text: 'Reconnecting to a player. This can take a few seconds.', kind: 'warn', ms: 4000 });
    }
  }
}

/**
 * Players whose connection attempts reached us (offer and answer exchanged) but never connected, during the last
 * TUNE.failedShowMs, and that we do not reach in any other way: [{id}] (id null for an attempt still pending past
 * TUNE.attemptStuckMs, whose peer Trystero has not named yet). net/lobby explains a blocked network with it.
 */
export function unreachable() {
  const now = performance.now();
  const out = [];
  for (const [id, at] of failed) {
    if (now - at > TUNE.failedShowMs) { failed.delete(id); continue; }
    const p = peerMap.get(id);
    if (p && p.ok) continue;
    out.push({ id });
  }
  // attempts of this room still unconnected well past a normal setup (one per pc; a pc Trystero already reported as
  // failed is closed by then and counted above)
  let stuck = 0;
  for (const pc of attempts) {
    if (pc.connectionState === 'closed') { attempts.delete(pc); continue; }
    if (pc.zfAttemptAt >= roomAt && now - pc.zfAttemptAt > TUNE.attemptStuckMs && pc.connectionState !== 'connected') stuck++;
  }
  // a player we reach through a relay accounts for one stuck direct attempt
  for (const p of peerMap.values()) if (p.ok && !p.direct) stuck--;
  for (let i = out.length; i < stuck; i++) out.push({ id: null });
  return out;
}

/**
 * Connection attempts of this room under way, stuck or not: a remote description that has not connected yet, and a
 * peer Trystero connected (or a neighbour introduced) whose hello has not arrived yet (a handshake still settling).
 */
export function pendingAttempts() {
  let n = 0;
  for (const pc of attempts) if (pc.zfAttemptAt >= roomAt && pc.connectionState !== 'connected' && pc.connectionState !== 'closed') n++;
  for (const p of peerMap.values()) if (!p.ok && !p.incompatible && !p.bye) n++;
  // connected in this room but not activated by Trystero yet: its handshake is still running (or failed and is about to
  // be repaired)
  const owned = ownedPcs(), now = performance.now();
  for (const pc of livePcs) if (pc.zfAttemptAt >= roomAt && pc.connectionState === 'connected' && !owned.has(pc) && pc.zfDataAt && now - pc.zfDataAt < 25000) n++;
  return n;
}

/**
 * The RTCPeerConnection class handed to Trystero (rtcPolyfill). Trystero 0.25.4 keeps a pool of pre-made offers and
 * refreshes one older than ~57 s with rollback + restartIce() + createOffer({iceRestart: true}) before sending it.
 * In Chrome, rolling back that first offer drops the 'data' channel's m-section: the refreshed offer and its answer
 * carry no media section at all, ICE has nothing to connect, and the attempt ends in "could not connect to peer ...
 * after exchanging SDP" (verified by logging the SDPs). That broke every connection a page offered after its first
 * minute in a room: late joiners, players coming back to the lobby, reconnects after a drop. Here the rollback of an
 * offering peer's unanswered offer is skipped, so createOffer({iceRestart: true}) re-offers on top of the existing
 * description (fresh ICE credentials, data section intact), and restartIce() is a no-op because that offer already
 * renews the credentials (otherwise a restart stays pending and fires negotiationneeded after the answer).
 * The glare rollback Trystero does on answering peers is untouched (those never create the 'data' channel).
 */
let PCClass = null;
const attempts = new Set();        // peer connections with a remote description that have not connected (yet)
const livePcs = new Set();         // every peer connection Trystero made through PCClass that is not closed
let roomAt = 0;                    // performance.now() this client joined the current room
/** Remember when Trystero's own 'data' channel of a connection opened (its handshake starts then). */
function noteDataChannel(pc, ch) {
  if (!ch || ch.label !== 'data') return;
  if (ch.readyState === 'open') pc.zfDataAt = performance.now();
  else ch.addEventListener('open', () => { pc.zfDataAt = performance.now(); }, { once: true });
}
function peerConnectionClass() {
  if (PCClass || typeof RTCPeerConnection !== 'function') return PCClass;
  PCClass = class ZonefallPeerConnection extends RTCPeerConnection {
    constructor(...args) {
      super(...args);
      livePcs.add(this);
      this.addEventListener('datachannel', (e) => {
        noteDataChannel(this, e.channel);
        // ?netsim: wrap channels the remote side opens before Trystero's ondatachannel handler sees them
        if (SIM) simChannel(e.channel);
      });
      this.addEventListener('connectionstatechange', () => {
        if (this.connectionState === 'connected' || this.connectionState === 'closed') attempts.delete(this);
        if (this.connectionState === 'closed') livePcs.delete(this);
      });
    }
    close() { livePcs.delete(this); attempts.delete(this); return super.close(); }
    // A remote description means another player's offer or answer reached us: a connection attempt is under way. One
    // that never connects is the earliest sign of a network that blocks direct connections (ICE gives up only after
    // about 30 s), so net/lobby can say so instead of "nobody is here".
    setRemoteDescription(desc, ...rest) {
      if (!this.zfAttemptAt && desc && (desc.type === 'offer' || desc.type === 'answer')) { this.zfAttemptAt = performance.now(); attempts.add(this); }
      return super.setRemoteDescription(desc, ...rest);
    }
    createDataChannel(label, opts) {
      if (label === 'data' && !(opts && opts.negotiated)) this.zfOfferer = true;
      const ch = super.createDataChannel(label, opts);
      noteDataChannel(this, ch);
      return simChannel(ch);
    }
    setLocalDescription(desc) {
      if (this.zfOfferer && desc && desc.type === 'rollback' && this.signalingState === 'have-local-offer' && !this.remoteDescription) {
        return Promise.resolve();
      }
      return desc === undefined ? super.setLocalDescription() : super.setLocalDescription(desc);
    }
    restartIce() { /* see peerConnectionClass */ }
  };
  return PCClass;
}

// ------------------------------------------------------------------------------------------------ relay keeper
// Trystero 0.25.4 retries a closed relay socket with a doubling backoff (3.3 s up to 60 s) and then gives up on that
// relay for good (client.isClosed). Its relay registry hands the same dead client to every later joinRoom, so a relay
// outage of a minute or two without a browser 'offline' event (blocked relays, flaky or captive Wi-Fi, a relay-side
// outage) left matchmaking dead until a reload, with the lobby blaming a connection that was fine again. The keeper
// takes reconnection over with Trystero's own pause/resume switch (exported for exactly this): reconnection stays
// paused, so a closed socket waits instead of counting toward the give-up, and while any relay is down the keeper
// resumes once every 2 s (doubling to 15 s while the attempts keep failing), which reopens every waiting socket, then
// pauses again. A relay client that died anyway (its socket object did not change across two resumes) makes the next
// connect() import a fresh instance of Trystero's relay layer, which builds new relay clients.
const keeper = { mod: null, timer: 0, nextAt: 0, fails: 0, tried: new Map(), stuck: new Map(), dead: false, gen: 0, resumes: 0 };

async function loadTrystero() {
  if (keeper.mod && !keeper.dead) return keeper.mod;
  let mod;
  if (keeper.mod && keeper.dead && typeof import.meta.resolve === 'function') {
    // a new module instance (the fragment makes a new module map entry; the file comes from the HTTP cache)
    keeper.gen++;
    mod = await import(`${import.meta.resolve('trystero')}#relays-${keeper.gen}`);
  } else mod = await import('trystero');
  keeper.mod = mod;
  keeper.dead = false;
  keeper.tried.clear();
  keeper.stuck.clear();
  keeper.fails = 0;
  keeper.nextAt = 0;
  try { mod.pauseRelayReconnection(); } catch { /* older build without the switch: Trystero's own backoff applies */ }
  if (!keeper.timer) keeper.timer = setInterval(keeperTick, 1000);
  return mod;
}

/**
 * Retire a relay socket that is open but dead. close() alone can leave it CLOSING for a long time when the far end
 * never answers, and Trystero only reconnects on the close event; so its close handler is detached first (a late real
 * close must not replace the next socket) and called at once: the relay client then waits for the keeper's resume.
 */
function dropSocket(ws) {
  const onclose = typeof ws.onclose === 'function' ? ws.onclose : null;
  ws.onclose = null;
  try { ws.close(); } catch { /* already closing */ }
  if (onclose) { try { onclose.call(ws, new Event('close')); } catch { /* client gone */ } }
}

/** connect(): reconnect relays that are down right away (a Retry, or the lobby's automatic retry, must not wait). */
function keeperKick() {
  keeper.nextAt = 0;
  keeper.fails = Math.min(keeper.fails, 1);
  keeperTick();
}

function keeperTick() {
  const mod = keeper.mod;
  if (!mod || typeof mod.resumeRelayReconnection !== 'function') return;
  let socks;
  try { socks = Object.entries(mod.getRelaySockets() || {}); } catch { return; }
  try { mod.pauseRelayReconnection(); } catch { return; }       // idempotent; Trystero itself resumes on 'online'
  const down = socks.filter(([, ws]) => ws && ws.readyState >= 2);
  if (!down.length) { keeper.fails = 0; keeper.nextAt = 0; return; }
  const now = performance.now();
  if (now < keeper.nextAt) return;
  let allStuck = down.length === socks.length;
  for (const [url, ws] of down) {
    const n = keeper.tried.get(url) === ws ? (keeper.stuck.get(url) || 0) + 1 : 0;
    keeper.stuck.set(url, n);
    keeper.tried.set(url, ws);
    if (n < 2) allStuck = false;
  }
  if (allStuck) keeper.dead = true;
  keeper.resumes++;
  mod.resumeRelayReconnection();
  setTimeout(() => { try { mod.pauseRelayReconnection(); } catch { /* gone */ } }, 0);
  keeper.fails++;
  keeper.nextAt = now + Math.min(15000, 2000 * 2 ** Math.min(4, keeper.fails - 1));
}

// ------------------------------------------------------------------------------------------------ network simulation
// ?netsim=ping,loss,jitter (config DEV.netsim, inert without it). Every data channel of this page's peer connections
// (Trystero's reliable 'data' channel, its pings included, and our unreliable snapshot channel) gets ping/2 extra delay
// on the way out and ping/2 on the way in, plus 0..jitter ms per message. Unreliable messages are lost with
// probability `loss` in each direction; reliable ones keep their order and pay a retransmission delay instead. RTTs,
// interpolation, hit validation and liveness all see it exactly like a slow connection on the production code path.
const SIM = DEV.netsim;
let simAnnounced = false;
const simStats = { out: 0, in: 0, lost: 0, late: 0, afterClose: 0 };
const ON_MESSAGE = typeof RTCDataChannel === 'function' ? Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'onmessage') : null;

/**
 * Delivery time for one simulated message, or -1 if it is lost. Jitter is correlated per direction (a random walk over
 * 0..jitter, like a queue that fills and drains) and every direction keeps its order, as real paths almost always do:
 * independent jitter per message reordered a fifth of the snapshots and overstated the stutter of a jittery link.
 * `q` holds, per direction, the last delivery time and the current jitter.
 */
function simAt(q, key, unreliable) {
  const now = performance.now();
  const jk = key + 'J';
  q[jk] = Math.max(0, Math.min(SIM.jitter, (q[jk] ?? Math.random() * SIM.jitter) + (Math.random() - 0.5) * SIM.jitter * 0.5));
  let at = now + SIM.ping / 2 + q[jk];
  if (unreliable) {
    if (Math.random() < SIM.loss) { simStats.lost++; return -1; }
    const uk = key + 'U';
    if (at < (q[uk] || 0)) at = q[uk];
    q[uk] = at;
    return at;
  }
  if (Math.random() < SIM.loss) { at += Math.max(200, SIM.ping * 1.5); simStats.late++; }
  if (at < q[key]) at = q[key];
  q[key] = at;
  return at;
}

function simChannel(ch) {
  if (!SIM || !ch || ch.zfSim) return ch;
  ch.zfSim = true;
  const unreliable = ch.ordered === false || ch.maxRetransmits === 0;
  const q = { out: 0, in: 0 };
  const rawSend = ch.send;
  ch.send = function simSend(data) {
    let d = data;   // the caller may reuse its buffer before the delayed send runs
    if (d instanceof ArrayBuffer) d = d.slice(0);
    else if (ArrayBuffer.isView(d)) d = d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
    const at = simAt(q, 'out', unreliable);
    if (at < 0) return;
    simStats.out++;
    setTimeout(() => { if (ch.readyState === 'open') { try { rawSend.call(ch, d); } catch { /* closing */ } } }, at - performance.now());
  };
  if (ON_MESSAGE && ON_MESSAGE.set) {
    let user = null;
    Object.defineProperty(ch, 'onmessage', {
      configurable: true,
      get: () => user,
      set: (fn) => {
        user = typeof fn === 'function' ? fn : null;
        ON_MESSAGE.set.call(ch, user ? (e) => {
          const at = simAt(q, 'in', unreliable);
          if (at < 0) return;
          simStats.in++;
          // a closed channel delivers nothing more (as in a real browser): without this check, messages of a
          // connection Trystero just replaced reached the new connection's handshake for the same peer id
          setTimeout(() => {
            if (ch.readyState !== 'open') { simStats.afterClose++; return; }
            if (user) user.call(ch, e);
          }, at - performance.now());
        } : null);
      },
    });
  }
  return ch;
}

/** Close the RTCPeerConnection to a peer so Trystero renegotiates it (see the header). Returns true if one was open. */
function resetConnection(peerId, why) {
  const p = peerMap.get(peerId);
  let pc = p && p.pc;
  if (!pc && room) { try { pc = (room.getPeers() || {})[peerId] || null; } catch { pc = null; } }
  if (!pc) pc = lastPc.get(peerId) || null;
  lastPc.delete(peerId);
  if (!pc || typeof pc.close !== 'function' || pc.connectionState === 'closed') return false;
  try { pc.close(); } catch { return false; }
  counters.resets++;
  counters.lastReset = { id: peerId, why, at: Math.round(performance.now()) };
  return true;
}

/**
 * Close connected peer connections that belong to no peer: not active in the room (room.getPeers), not any known peer's,
 * and with Trystero's channel open for TUNE.orphanMinMs (so a handshake that is still running on a fresh connection is
 * left alone). Only called on a handshake failure Trystero could not tie to a connection we know: what is left is the
 * connection of that failed handshake (or an idle one from a room we left, which Trystero would rebuild if needed).
 */
function ownedPcs() {
  const owned = new Set();
  if (room) { try { for (const pc of Object.values(room.getPeers() || {})) owned.add(pc); } catch { /* room closing */ } }
  for (const p of peerMap.values()) if (p.pc) owned.add(p.pc);
  for (const [id, pc] of lastPc) if (peerMap.has(id)) owned.add(pc);
  return owned;
}
function closeOrphans(why) {
  const owned = ownedPcs();
  const now = performance.now();
  let n = 0;
  for (const pc of [...livePcs]) {
    if (owned.has(pc) || pc.connectionState !== 'connected' || !pc.zfDataAt || now - pc.zfDataAt < TUNE.orphanMinMs) continue;
    try { pc.close(); n++; } catch { /* already closing */ }
  }
  if (n) {
    counters.resets += n;
    counters.orphans = (counters.orphans || 0) + n;
    counters.lastReset = { id: null, why, at: Math.round(now) };
  }
  return n;
}

/** Remember the connection of each peer (Trystero keeps it across rooms, so must we, to be able to close it). */
function notePc(id) {
  if (!room) return null;
  let pc = null;
  try { pc = (room.getPeers() || {})[id] || null; } catch { pc = null; }
  if (pc) lastPc.set(id, pc);
  return pc;
}

// ------------------------------------------------------------------------------------------------ peers
/** Trystero connected a peer (its own handshake done). It counts once its hello carries our version (onAction). */
function addPeer(id) {
  if (!room || !id || id === mySelf) return;
  let p = peerMap.get(id);
  if (p) {
    if (p.direct) {
      // Trystero activated it again (after a room re-join, or on a new connection): follow its current connection
      const pc = notePc(id);
      if (pc && p.pc && pc !== p.pc) {
        clearTimeout(p.chTimer);
        if (p.channel) { const ch = p.channel; p.channel = null; ch.onmessage = null; ch.onclose = null; }
        p.pc = null;
        openChannel(p, 0);
      }
      if (!p.ok) greet(p);
      return;
    }
    // a peer we reached through a relay now has a direct connection too: the direct path takes over
    p.direct = true;
    p.lastDirectRx = performance.now();
    p.directAt = p.lastDirectRx;
    p.greets = 0;
    p.via = null;
    p.lostGrace = false;
    p.noRouteSince = 0;
    repairs.delete(id);
    failed.delete(id);
    notePc(id);
    openChannel(p, 0);
    pingPeer(p);
    if (!p.ok) greet(p);
    return;
  }
  if (peerMap.size >= TUNE.maxPeers) return;
  p = makePeer(id, true);
  peerMap.set(id, p);
  repairs.delete(id);
  failed.delete(id);
  notePc(id);
  openChannel(p, 0);
  greet(p);
  pingPeer(p);
}

/** A hello with our version arrived: the peer counts from now on (rosters, election, snapshots). */
function verify(p) {
  if (p.ok) return;
  p.ok = true;
  p.incompatible = false;
  emit(EV.PEER_JOIN, { id: p.id });
  elect();
}

/** Trystero lost the direct connection: keep the peer through a relay when another player still reaches it. */
function directLost(id) {
  const p = peerMap.get(id);
  if (!p) return;
  if (p.bye || !p.ok) { removePeer(id, 'left'); return; }
  const via = bestRoute(id);
  // No relay either: a verified peer that did not say 'bye' is kept for TUNE.lostGraceMs (maintain() removes it then).
  // A player leaving says 'bye' first; one re-joining the room (softRejoin) reconnects within about a second.
  p.direct = false;
  p.via = via;
  p.noRouteSince = via ? 0 : performance.now();
  if (!via) p.lostGrace = true;
  clearTimeout(p.chTimer);
  if (p.channel) { const ch = p.channel; p.channel = null; ch.onmessage = null; ch.onclose = null; }
  p.pc = null;
  counters.lastDowngrade = { id, via, at: Math.round(performance.now()) };
}

function removePeer(id, reason, silentElect = false) {
  const p = peerMap.get(id);
  if (!p) return;
  peerMap.delete(id);
  clearTimeout(p.chTimer);
  if (p.channel) { const ch = p.channel; p.channel = null; ch.onmessage = null; ch.onclose = null; }
  if (p.ok && !p.dropped) emit(EV.PEER_LEAVE, { id, reason });
  if (!silentElect) elect();
}

/** Connected (directly or through a relay), verified, non-stale peer ids (join order). */
export function peers() {
  const out = [];
  for (const p of peerMap.values()) if (p.ok && !p.stale && !p.dropped) out.push(p.id);
  return out;
}

/** Every verified peer id, stale or not (diagnostics, lobby roster). */
export function allPeers() { const out = []; for (const p of peerMap.values()) if (p.ok) out.push(p.id); return out; }

/**
 * Non-stale peers in this client's own context (the lobby while in the menu/lobby/results, else the current match),
 * ordered lobby-host first (join time, then id). net/lobby builds its roster from these.
 */
export function contextPeers() {
  const now = performance.now();
  const out = [];
  for (const p of peerMap.values()) if (p.ok && !p.stale && !p.dropped && inContext(p, now)) out.push(p.id);
  return out.sort(bySince);
}

/** Non-stale peers currently playing a match other than ours (their snapshots carry a match tag; away is none). */
export function peersInMatch() {
  const out = [];
  for (const p of peerMap.values()) if (p.ok && !p.stale && !p.dropped && p.ctx && p.ctx !== AWAY_TAG && p.ctx !== myCtx) out.push(p.id);
  return out;
}

// ------------------------------------------------------------------------------------------------ routes (relay)
/** The direct connection to a peer delivered something (data or a pong) recently: send to it directly. */
function directHealthy(p, now = performance.now()) {
  return p.direct && now - p.lastDirectRx < TUNE.directHealthyMs;
}

/**
 * The best relay for a peer: a verified, live peer we reach directly whose latest hello lists a working direct link
 * to it; the lowest total round trip wins. null when nobody can pass our traffic on.
 */
function bestRoute(id, now = performance.now()) {
  let best = null, cost = Infinity;
  for (const n of peerMap.values()) {
    if (n.id === id || !n.ok || n.bye || n.stale || n.dead || n.dropped || !directHealthy(n, now)) continue;
    if (!n.links || now - n.linksAt > TUNE.linksFreshMs) continue;
    const i = n.links.indexOf(id);
    if (i < 0) continue;
    const c = (n.rtt || 100) + (n.linkRtt && n.linkRtt[i] || 100);
    if (c < cost) { cost = c; best = n.id; }
  }
  return best;
}

/** How to reach a peer right now: 'direct', the id of a relay player, or null when there is no way. */
function routeOf(p, now = performance.now()) {
  if (directHealthy(p, now)) return 'direct';
  const via = bestRoute(p.id, now);
  if (via) return via;
  return p.direct ? 'direct' : null;     // a direct connection that went quiet is still the best guess without a relay
}

/**
 * Direct links of this client for its hello (`ln`, `lr`): verified peers whose direct connection works. Relayed peers
 * are never listed, so a route crosses at most one relay.
 */
export function directLinks() {
  const now = performance.now();
  const out = [];
  for (const p of peerMap.values()) {
    if (!p.ok || p.bye || p.dropped || !directHealthy(p, now)) continue;
    const inLobby = (p.ctx == null || p.ctx === 0) && !p.inResults;
    out.push({ id: p.id, rtt: Math.round(p.rtt || 0), js: inLobby && p.since > 0 ? p.since : 0 });
  }
  return out.slice(0, 16);
}

/**
 * Route upkeep (every TUNE.maintainEveryMs): find players that a neighbour reaches directly but we do not know yet
 * (they become relayed peers and are greeted through that neighbour), pick each relayed peer's relay, re-greet peers
 * whose hello is outstanding, and forget relayed peers that lost every route.
 */
function maintain() {
  if (!room || !state.online) return;
  const now = performance.now();
  for (const n of [...peerMap.values()]) {
    if (!n.ok || !n.links || n.bye || now - n.linksAt > TUNE.linksFreshMs || !directHealthy(n, now)) continue;
    for (const id of n.links) {
      if (id === mySelf || peerMap.has(id) || peerMap.size >= TUNE.maxPeers) continue;
      const q = makePeer(id, false);
      q.via = n.id;
      peerMap.set(id, q);
      greet(q);
    }
  }
  for (const p of [...peerMap.values()]) {
    if (p.bye) { removePeer(p.id, 'left'); continue; }
    if (!p.ok && !p.incompatible && now - p.greetAt > TUNE.greetEveryMs) greet(p);
    if (p.direct && !p.ok && !p.incompatible && p.directAt && now - p.directAt > TUNE.helloWaitMs && p.greets >= 3) {
      // Trystero connected this peer here, but in all this time (greeted again and again) it never said hello: its
      // Trystero handshake failed on its side (it never activated us, so it drops what we send). Neither side would
      // ever try again on its own; closing the connection makes both negotiate a fresh one.
      p.directAt = now;
      p.greets = 0;
      counters.noHello = (counters.noHello || 0) + 1;
      resetConnection(p.id, 'no-hello');
      removePeer(p.id, 'left');               // never verified: nobody saw it, nothing to announce
      softRejoin('no-hello');
      continue;
    }
    if (p.direct) { p.via = directHealthy(p, now) ? null : bestRoute(p.id, now); continue; }
    const via = bestRoute(p.id, now);
    if (via) { p.via = via; p.noRouteSince = 0; p.lostGrace = false; continue; }
    if (!p.noRouteSince) p.noRouteSince = now;
    const quiet = now - Math.max(p.noRouteSince, p.lastRelayRx);
    if (quiet > (p.lostGrace ? TUNE.lostGraceMs : TUNE.routeLossMs) || (!p.ok && now - p.joinedAt > TUNE.pendingMaxMs)) removePeer(p.id, 'left');
  }
}

export function online() { return !!room && state.online; }
export function selfId() { return mySelf || state.selfId; }
export function hostId() { return curHost; }
export function isHost() { return !state.online || curHost === selfId(); }
export function epoch() { return curEpoch; }
export function roomName() { return roomId; }
export function transportKind() { return transport; }
/** Wall-clock ms this client joined the room (sent in 'hello'; the earliest peer hosts the lobby). */
export function joinedAt() { return mySince; }
/** This client's context: matchTag(match id) inside a match, 0 in the menu, lobby and results. */
export function contextTag() { refreshMyCtx(); return myCtx; }

/**
 * The tag this client's snapshots carry: its context, or protocol.AWAY_TAG once it lost its place in the match
 * (Disconnected screen), so players back in the lobby neither wait for it nor count it in their roster.
 */
export function advertisedTag() { refreshMyCtx(); return selfOut && myCtx ? AWAY_TAG : myCtx; }
/** True while this client is out of its match but still on its screen (see advertisedTag). */
export function isAway() { refreshMyCtx(); return selfOut && !!myCtx; }

/** Join order index of a peer (lower joined earlier, from this client's point of view). */
export function joinIndex(id) { return id === selfId() ? 0 : (peerMap.get(id)?.seq ?? Infinity); }

function sinceOf(id) {
  if (id === selfId()) return mySince || Infinity;
  const p = peerMap.get(id);
  return p && p.since > 0 ? p.since : Infinity;
}
function bySince(a, b) { return sinceOf(a) - sinceOf(b) || (a < b ? -1 : a > b ? 1 : 0); }

/** Mark a peer stale/fresh (net/sync: no snapshot for NET.staleMs). Stale peers drop out of lobby rosters. */
export function setStale(peerId, stale) {
  const p = peerMap.get(peerId);
  if (!p || p.stale === !!stale) return;
  p.stale = !!stale;
  elect();
}

/**
 * Mark a peer unresponsive (net/sync: silent for NET.hostStaleMs, own stalls not counted). Only this excludes a peer
 * from host election: a host that misses a few snapshots (a long frame, a shader compile) keeps its bots.
 */
export function setUnresponsive(peerId, dead) {
  const p = peerMap.get(peerId);
  if (!p || p.dead === !!dead) return;
  p.dead = !!dead;
  elect();
}

/** net/sync, on every PSNAP: the context tag the peer is in (0 lobby, else its match tag). */
export function notePeerContext(peerId, tag) {
  const p = peerMap.get(peerId);
  if (!p || p.ctx === tag) return;
  p.prevCtx = p.ctx;
  p.ctx = tag;
  p.ctxAt = performance.now();
  elect();
}

/** True if a peer left, was dropped from, or was kicked out of the match this client is playing. */
export function isOut(peerId) { refreshOut(); return outIds.has(peerId); }

/** A roster human of our match who is still in it (net/game accept bot picks and deaths from any of them). */
export function inMatchPeer(peerId) {
  if (!myCtx || isOut(peerId)) return false;
  const p = peerMap.get(peerId);
  return !!p && inContext(p, performance.now());
}

/**
 * Does another player of our match still hear this peer (its latest hello, at most 6 s old, lists it)? Then a silence
 * we see is our own link to that peer, not the peer leaving: net/sync keeps it as a ghost and repairs the connection
 * instead of dropping it, so a broken link between two players never kills either of them.
 */
export function heardByOthers(peerId) {
  const now = performance.now();
  for (const p of peerMap.values()) {
    if (p.id === peerId || !p.ok || p.dropped || p.stale || !p.hears || now - p.hearsAt > 6000 || !inContext(p, now)) continue;
    if (p.hears.has(peerId)) return true;
  }
  return false;
}

/**
 * Every other player of our context sent a hello after `heardAt` + NET.staleMs (so it reflects the silence) that leaves
 * this peer out of the players it hears, and there is at least one such player: the peer is gone for everyone, not
 * just on our link. net/sync uses it to hand a crashed host's bots over before NET.hostStaleMs.
 */
export function silenceConfirmed(peerId, heardAt) {
  const now = performance.now();
  let n = 0;
  for (const p of peerMap.values()) {
    if (p.id === peerId || !p.ok || p.stale || p.dropped || p.dead || !inContext(p, now)) continue;
    if (!p.hears || p.hearsAt < heardAt + NET.staleMs || p.hears.has(peerId)) return false;
    n++;
  }
  return n > 0;
}

/**
 * Is the silence of a player that began at `since` explained by losing our only path to him, rather than by him going
 * away? True when we had no working direct connection to him at that moment (he was reached through a relay), and
 * every player whose hellos listed a direct link to him around then is gone from us too (left, or silent itself). That
 * is a pair without a direct path (no TURN, symmetric NAT) whose relay closed or reloaded his page: both sides are
 * still playing, neither can reach the other, and neither can tell the other anything. net/sync then applies a rule
 * both sides reach on their own (the side with the lowest player id keeps the match), instead of both dropping each
 * other and both winning separate copies. False when a player still with us had a direct link to him: then he is the
 * one who went silent (crash, sleep, lost network), and the usual drop applies.
 */
export function pathLost(peerId, since) {
  if ((directRxAt.get(peerId) ?? -Infinity) >= since - TUNE.directHealthyMs) return false;
  const seen = linkSeen.get(peerId);
  if (seen) {
    for (const [n, at] of seen) {
      if (at < since - TUNE.linksFreshMs) continue;
      const q = peerMap.get(n);
      if (q && q.ok && !q.bye && !q.stale && !q.dead && !q.dropped) return false;
    }
  }
  return true;
}

/** Close a peer's connection so Trystero negotiates a new one, without dropping it (net/sync's link repair). */
export function repairConnection(peerId) { return resetConnection(peerId, 'repair'); }

/** This client lost its place in the current match (game/match on a forfeit): it stops hosting and is never elected. */
export function setSelfOut(on) {
  if (selfOut === !!on) return;
  selfOut = !!on;
  elect();
}

/**
 * net/sync detected that this page itself stalled for ms (frozen tab, long task): silence during it is ours, not the
 * relays' or the peers'. Every receive time kept here moves forward with it (relay messages, direct traffic, relayed
 * traffic, the hellos that say who hears whom), so a stall never makes a link look dead or a ghost unprotected.
 */
export function noteLocalStall(ms) {
  const now = performance.now();
  const d = Math.max(0, ms);
  lastRelayMsgAt = Math.min(now, lastRelayMsgAt + d);
  for (const p of peerMap.values()) {
    p.lastDirectRx = Math.min(now, p.lastDirectRx + d);
    if (p.directAt) p.directAt = Math.min(now, p.directAt + d);
    if (p.lastRelayRx) p.lastRelayRx = Math.min(now, p.lastRelayRx + d);
    if (p.hearsAt) p.hearsAt = Math.min(now, p.hearsAt + d);
    if (p.linksAt) p.linksAt = Math.min(now, p.linksAt + d);
    if (p.noRouteSince) p.noRouteSince = Math.min(now, p.noRouteSince + d);
  }
  for (const [id, at] of directRxAt) directRxAt.set(id, Math.min(now, at + d));
  for (const m of linkSeen.values()) for (const [n, at] of m) m.set(n, Math.min(now, at + d));
}

/**
 * Own link probe for net/sync: relays open, when a relay last spoke, the browser's online flag, and the start times of
 * the last successful / failed probe (probeLink). Nostr relays only talk about once a minute once peers are connected,
 * so the probe is what answers "is it me or them?" when every other player goes quiet.
 */
export function linkHealth() {
  const now = performance.now();
  const local = transport === 'local';
  return {
    relaysOpen: local ? 1 : countRelays(),
    relaySilentMs: local ? 0 : now - lastRelayMsgAt,
    lastRelayMsgAt: local ? now : lastRelayMsgAt,
    browserOnline: typeof navigator === 'undefined' || navigator.onLine !== false,
    probeOkAt: local ? now : probeOkAt,
    probeFailAt: local ? 0 : probeFailAt,
  };
}

/** Start an own-link probe (a tiny no-store HEAD request to the page's own URL) unless one ran in the last probeEveryMs. */
export function probeLink() {
  const now = performance.now();
  if (transport === 'local' || probeBusy || now - probeAt < TUNE.probeEveryMs || typeof fetch !== 'function') return;
  probeAt = now;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) { probeFailAt = now; return; }
  probeBusy = true;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { if (ctl) ctl.abort(); }, TUNE.probeTimeoutMs);
  fetch(location.origin + location.pathname, { method: 'HEAD', cache: 'no-store', signal: ctl ? ctl.signal : undefined })
    .then(() => { probeOkAt = now; }, () => { probeFailAt = now; })
    .finally(() => { clearTimeout(timer); probeBusy = false; });
}

/**
 * A peer silent for NET.dropMs during a match counts as gone: PEER_LEAVE {reason:'timeout'} is emitted once (game/match
 * turns it into a 'left' death), it is out of this match for good, its traffic is ignored until the next round, and
 * its connection is closed so Trystero rebuilds it if the peer comes back. Called by net/sync, also for a peer whose
 * connection Trystero already removed.
 */
export function markDropped(peerId) {
  refreshOut();
  const p = peerMap.get(peerId);
  if (p && p.dropped) return;
  if (!p && outIds.has(peerId)) return;
  if (myMid) outIds.add(peerId);
  emit(EV.PEER_LEAVE, { id: peerId, reason: 'timeout' });
  if (p) p.dropped = true;
  resetConnection(peerId, 'dropped');
  elect();
}

on(EV.APP_STATE, ({ to }) => {
  if (to === APP.LOBBY || to === APP.MENU || to === APP.RESULTS) {
    // A new round: peers that timed out during the match but are still connected are welcome again.
    for (const p of peerMap.values()) {
      if (!p.dropped) continue;
      p.dropped = false;
      p.stale = false;
      p.dead = false;
      emit(EV.PEER_JOIN, { id: p.id });
    }
    selfOut = false;
  }
  elect();
});
on(EV.MATCH_START, () => { selfOut = false; elect(); });

// ------------------------------------------------------------------------------------------------ contexts
function computeMyCtx() {
  const m = state.match;
  return state.app === APP.MATCH && m.phase !== 'idle' && m.id ? matchTag(m.id) : 0;
}

/** Returns true when this client's context changed (a match began or was left). */
function refreshMyCtx() {
  const c = computeMyCtx();
  if (c === myCtx) return false;
  myCtx = c;
  myCtxAt = performance.now();
  myMid = c ? state.match.id : null;
  return true;
}

function refreshOut() {
  if (outMid === myMid) return;
  outMid = myMid;
  outIds.clear();
}

let rosterCacheId = null, rosterCache = new Set();
function rosterSet() {
  const m = state.match;
  if (rosterCacheId !== m.id || rosterCache.size === 0) {
    rosterCacheId = m.id;
    rosterCache = new Set((m.roster || []).filter((r) => r.kind === 'human').map((r) => r.id));
  }
  return rosterCache;
}

/** Is a peer in this client's context right now (see the header)? Grace periods cover messages still in flight. */
function inContext(p, now) {
  if (!myCtx) {
    if (p.ctx == null || p.ctx === 0) return true;
    return p.prevCtx === 0 && now - p.ctxAt < TUNE.ctxGraceMs;          // just deployed; its 'start' may still be on the way
  }
  refreshOut();
  if (outIds.has(p.id) || !rosterSet().has(p.id)) return false;
  if (p.ctx === myCtx) return true;
  if (p.prevCtx === myCtx && now - p.ctxAt < TUNE.ctxGraceMs) return true; // just left; its 'leave' may still be on the way
  // still showing the lobby tag right after our start: its own 'start' may be a moment behind ours
  return (p.ctx == null || p.ctx === 0) && p.prevCtx !== myCtx && now - myCtxAt < TUNE.startGraceMs;
}

// ------------------------------------------------------------------------------------------------ host election
/**
 * Pure election rule (exported for tests). Candidates: self (unless `selfOut`) and every peer that is not unresponsive
 * (`dead`), not `dropped`, not `away` (another context) and, legacy flag, not `stale`. During a match only the roster's
 * humans count. Lobby: earliest `since` wins (unknown = Infinity), then the lowest id. Match: the lowest id.
 * Returns null when nobody qualifies (a client that lost its place in the match).
 * @param {string} self
 * @param {Array<{id:string, stale?:boolean, dead?:boolean, dropped?:boolean, away?:boolean, since?:number}>} list
 * @param {string[]|null} rosterHumans
 * @param {{bySince?:boolean, selfSince?:number, selfOut?:boolean}} [opts]
 */
export function electHost(self, list, rosterHumans = null, opts = {}) {
  let cands = opts.selfOut ? [] : [{ id: self, since: opts.selfSince || Infinity }];
  for (const p of list) if (!p.stale && !p.dead && !p.dropped && !p.away) cands.push({ id: p.id, since: p.since > 0 ? p.since : Infinity });
  if (rosterHumans && rosterHumans.length) {
    const set = new Set(rosterHumans);
    const f = cands.filter((c) => set.has(c.id));
    if (f.length || opts.selfOut) cands = f;
  }
  if (!cands.length) return null;
  let best = cands[0];
  for (const c of cands) {
    if (opts.bySince) { if (c.since < best.since || (c.since === best.since && c.id < best.id)) best = c; }
    else if (c.id < best.id) best = c;
  }
  return best.id;
}

function elect() {
  if (!room || !state.online) return;
  const switched = refreshMyCtx();
  const self = selfId();
  const now = performance.now();
  if (switched) {
    // A new context starts a new term: no migration, no epoch bump, no announcement (the start/lobby flow carries it).
    curHost = null;
    pendingHost = null;
  }
  const list = [];
  // On the results screen a player belongs to the lobby (the next round pulls him in) but does not run the lobby
  // countdown, so neither he nor anyone else picks him as the lobby host.
  const inResults = myCtx === 0 && state.app === APP.RESULTS;
  for (const p of peerMap.values()) {
    if (p.ok) list.push({ id: p.id, dead: p.dead, dropped: p.dropped, away: !inContext(p, now) || (myCtx === 0 && !!p.inResults), since: p.since });
    // Lobby: a player a neighbour reaches (and reports in its lobby) while our relayed connection to him is still
    // forming takes part in the election already, so we never host a second countdown during those seconds.
    else if (myCtx === 0 && !p.incompatible && p.reportedSince > 0 && !p.bye) list.push({ id: p.id, since: p.reportedSince });
  }
  const next = electHost(self, list, null, { bySince: myCtx === 0, selfSince: mySince, selfOut: (selfOut && myCtx !== 0) || inResults });
  if (next === curHost) return;
  // In a match, hearing nobody at all is ambiguous (everyone else froze, or our own link died): do not grab the bots
  // until net/sync has decided (it drops the silent players or declares our connection lost at NET.dropMs).
  if (myCtx && next === self && curHost && curHost !== self && isolated(now)) return;
  const prev = curHost;
  curHost = next;
  state.hostId = next;
  state.isHost = next === self;
  if (pendingHost && pendingHost.id === next && pendingHost.ctx === myCtx) curEpoch = Math.max(curEpoch, pendingHost.ep);
  pendingHost = null;
  if (state.isHost && prev !== null) {
    curEpoch++;                                   // migration: a new term, announced to whoever is still here
    if (peerMap.size) send(ACTIONS.HOST, { ep: curEpoch, id: self, mid: myMid });
  } else if (prev === self && next && next !== self) {
    // Hand the epoch to the new host so its messages carry the newest one.
    send(ACTIONS.HOST, { ep: curEpoch, id: next, mid: myMid }, next);
  }
  emit(EV.HOST_CHANGED, { hostId: next, epoch: curEpoch, self: state.isHost, migrated: prev !== null });
}

/** Every other player of our context is unresponsive but none has been dropped yet. */
function isolated(now) {
  let any = false;
  for (const p of peerMap.values()) {
    if (!p.ok || p.dropped || !inContext(p, now)) continue;
    if (!p.dead) return false;
    any = true;
  }
  return any;
}

function onHostMessage(d, from) {
  if ((d.mid || null) !== myMid) return;          // a term of another context (the lobby, or another match)
  if (d.id === curHost) {
    curEpoch = Math.max(curEpoch, d.ep);
    return;
  }
  // We have not elected that peer (yet): keep its epoch so we adopt it the moment we do (liveness will converge).
  if (!pendingHost || d.ep >= pendingHost.ep) pendingHost = { id: d.id, ep: d.ep, ctx: myCtx };
  if (d.ep > curEpoch) {
    counters.hostConflicts++;
    elect();
  }
}

// ------------------------------------------------------------------------------------------------ reliable actions
function trySend(a, data, target) {
  try {
    const pr = a.send(data, target ? { target } : undefined);
    if (pr && pr.catch) pr.catch(() => {});
    return true;
  } catch (err) {
    console.warn('[NET/session] send failed', err);
    return false;
  }
}

/** Reliable send to one peer along its route (direct, or wrapped in 'fwd' to its relay). */
function sendTo(p, action, data, now) {
  const r = routeOf(p, now);
  if (r === 'direct') {
    if (!trySend(acts[action], data, p.id)) return false;
    p.tx.rel++;
    return true;
  }
  if (!r || !RELAY_OK.has(action)) { counters.relayNoRoute++; return false; }
  if (!trySend(acts[ACTIONS.FWD], { to: p.id, a: action, d: data }, r)) return false;
  p.tx.rel++; p.tx.relayed++; counters.relayedOut++;
  return true;
}

/**
 * Reliable send of a protocol action payload to everyone or one peer. Returns false when offline. Peers with a
 * working direct connection get it in one Trystero send; everyone else through its relay (see the header).
 */
export function send(action, data, target = null) {
  if (!room || !state.online) return false;
  if (blackhole || rejoining) return true;
  const a = acts[action];
  if (!a) throw new Error(`[NET/session] unknown action '${action}'`);
  const now = performance.now();
  if (target) {
    const p = peerMap.get(target);
    if (!p) return trySend(a, data, target);
    return sendTo(p, action, data, now);
  }
  const direct = [];
  for (const p of peerMap.values()) {
    if (p.incompatible || p.bye) continue;
    if (routeOf(p, now) === 'direct') { direct.push(p.id); p.tx.rel++; } else sendTo(p, action, data, now);
  }
  if (direct.length) return trySend(a, data, direct);
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

/** A relayed message reached us from `id` through `relay`: the peer it comes from (a relayed peer is created). */
function relayedPeer(id, relay) {
  if (!id || id === mySelf) return null;
  let p = peerMap.get(id);
  if (!p) {
    if (peerMap.size >= TUNE.maxPeers) return null;
    p = makePeer(id, false);
    p.via = relay.id;
    peerMap.set(id, p);
    greet(p);
  }
  p.lastRelayRx = performance.now();
  return p;
}

/** 'fwd' from a direct peer: either pass it on (we are the relay) or unwrap it (it is for us). */
function onForward(relay, v) {
  if (!relay.ok || !relay.direct) { counters.relayDropped++; return; }
  if (v.to) {
    const dest = peerMap.get(v.to);
    if (!dest || !dest.direct || !dest.ok || dest.bye) { counters.relayDropped++; return; }
    if (trySend(acts[ACTIONS.FWD], { f: relay.id, a: v.a, d: v.d }, dest.id)) counters.relayPassed++;
    return;
  }
  const p = relayedPeer(v.f, relay);
  if (!p) return;
  counters.relayedIn++;
  p.rx.relayed++;
  onAction(v.a, v.d, p.id, true);
}

function onAction(name, data, from, relayed = false) {
  const p = peerMap.get(from);
  if (!p || blackhole) return;
  if (!relayed) { p.lastDirectRx = performance.now(); directRxAt.set(from, p.lastDirectRx); }
  if (name === ACTIONS.BIN) { onBinaryIn(p, data, false); return; }
  if (!rateOk(p, false)) return;
  p.rx.rel++;
  const v = validate[name] ? validate[name](data) : null;
  if (!v) { p.rx.invalid++; counters.invalid++; return; }
  if (name === ACTIONS.FWD) { if (!relayed) onForward(p, v); return; }
  if (name === ACTIONS.BYE) { p.bye = true; removePeer(p.id, 'left'); return; }
  if (name === ACTIONS.HELLO) {
    if (v.v !== TUNE.protocol) { noteMismatch(p, v.v, v.js); return; }
    verify(p);
    // hellos always pass (lobby rosters, quick-play probes); the join time decides the lobby host
    if (v.js > 0 && p.since !== v.js) { p.since = v.js; elect(); }
    const now = performance.now();
    p.hears = new Set(v.hr);
    p.hearsAt = now;
    p.links = v.ln;
    p.linkRtt = v.lr;
    p.linksAt = now;
    for (const id of v.ln) {
      if (id === mySelf) continue;
      let m = linkSeen.get(id);
      if (!m) { if (linkSeen.size >= TUNE.maxPeers * 2) continue; m = new Map(); linkSeen.set(id, m); }
      m.set(from, now);
    }
    // players this peer reaches that we are still connecting to (through it): their lobby join time counts already
    for (let i = 0; i < v.ln.length; i++) {
      const q = peerMap.get(v.ln[i]);
      if (q && !q.ok && !q.incompatible) q.reportedSince = v.lj[i] || 0;
    }
    if (p.inResults !== v.rs) { p.inResults = v.rs; elect(); }
  } else if (!p.ok) return;                                 // nothing counts before a hello with our version
  else if (p.dropped && name !== ACTIONS.DROP) return;      // a peer dropped from our match: only its death drop still counts
  if (IN_MATCH.has(name)) {
    if (!myMid || v.mid !== myMid) { counters.wrongMatch++; return; }
    if (name === ACTIONS.LEAVE) { refreshOut(); outIds.add(from); elect(); }
    else if (name === ACTIONS.DEATH && v.w === 'left' && v.id !== from) { onDeclaredDrop(v, from); return; }
    else if (name !== ACTIONS.DROP && name !== ACTIONS.KICK && isOut(from)) return;
  }
  if (name === ACTIONS.HOST) { onHostMessage(v, from); return; }
  if ((name === ACTIONS.LOBBY || name === ACTIONS.START) && from === curHost) curEpoch = Math.max(curEpoch, v.ep);
  emit(ACTION_EVENT[name], { from, data: v });
}

// ------------------------------------------------------------------------------------------------ shared drops
/**
 * The match host decided that a silent player is gone (net/sync, past NET.dropMs with nobody hearing him): drop him
 * here and tell everyone with his 'left' death at the time he was last heard, so all clients take him out at once and
 * rank him alike (no more one-sided drops that left alive counts and winners disagreeing).
 * @param {string} peerId @param {{t:number, pos:number[]}} info  t: match ms he was last heard, pos: his last position
 */
export function declareDropped(peerId, info) {
  markDropped(peerId);
  if (!myMid || !state.online) return;
  counters.declared++;
  send(ACTIONS.DEATH, { mid: myMid, id: peerId, by: null, w: 'left', hs: false, sid: null, pos: info.pos, t: Math.round(info.t) });
}

/**
 * A 'left' death about someone else: a drop declared by the match host. It counts from the host, or from any player
 * of our match when we stopped hearing the dropped player too (a host change may still be on its way to us).
 * About ourselves it means we were dropped: net/sync forfeits through the usual kick path.
 */
function onDeclaredDrop(v, from) {
  const target = peerMap.get(v.id);
  const fromOk = from === curHost || (inMatchPeer(from) && (!target || target.dead || target.dropped));
  if (!fromOk || isOut(from)) { counters.declRejected++; return; }
  counters.declAccepted++;
  if (v.id === selfId()) { emit(EV.NET_KICK, { from, data: { mid: v.mid } }); return; }
  refreshOut();
  if (myMid) outIds.add(v.id);
  if (target && !target.dropped) { target.dropped = true; resetConnection(v.id, 'declared'); }
  elect();
  emit(EV.NET_DEATH, { from, data: { ...v, decl: true } });
}

// ------------------------------------------------------------------------------------------------ binary
/** Register the single binary consumer (net/sync): fn(fromPeerId, arrayBuffer). */
export function setBinaryHandler(fn) { binHandler = typeof fn === 'function' ? fn : null; }

function onBinaryIn(p, data, unreliable, relayed = false) {
  // Dropped peers still reach net/sync (liveness, and a kick if they still think they are in our match).
  if (!p || blackhole) return;
  if (!relayed) { p.lastDirectRx = performance.now(); directRxAt.set(p.id, p.lastDirectRx); }
  const buf = toArrayBuffer(data);
  if (!buf || buf.byteLength > NET.maxReceiveBytes) { p.rx.invalid++; return; }
  if (!relayed && buf.byteLength > 0 && new Uint8Array(buf, 0, 1)[0] === MSG.FWD) { onFwdFrame(p, buf); return; }
  if (!p.ok || !rateOk(p, true)) return;                    // nothing counts before a hello with our version
  if (unreliable) p.rx.unrel++; else p.rx.fallback++;
  p.rx.bytes += buf.byteLength;
  if (binHandler) binHandler(p.id, buf);
}

/** FWD frame from a direct peer: pass it on to its destination, or unwrap one that reached us through a relay. */
function onFwdFrame(relay, buf) {
  const f = decodeFwd(buf);
  if (!f || !relay.ok || !relay.direct) { counters.relayDropped++; return; }
  if (f.dir === FWD_TO) {
    const dest = peerMap.get(f.id);
    if (!dest || !dest.direct || !dest.ok || dest.bye || !rateOk(relay, true)) { counters.relayDropped++; return; }
    if (rawBinTo(dest, encodeFwd(FWD_FROM, relay.id, f.payload))) counters.relayPassed++;
    return;
  }
  const p = relayedPeer(f.id, relay);
  if (!p) return;
  counters.relayedIn++;
  p.rx.relayed++;
  onBinaryIn(p, f.payload, true, true);
}

/**
 * Unreliable send of a binary message (ArrayBuffer) to everyone or one peer (reliable 'bin' fallback until open; a
 * FWD frame through the relay for a peer without a working direct connection).
 * opts.contextOnly: only peers in this client's context (bot batches and shots are of no use to anyone else).
 */
export function sendBinary(buf, target = null, opts = null) {
  if (!room || !state.online) return 0;
  let n = 0;
  const now = performance.now();
  if (target) { const p = peerMap.get(target); if (p && !p.incompatible) n += sendBinTo(p, buf, now); return n; }
  const only = !!(opts && opts.contextOnly);
  for (const p of peerMap.values()) {
    if (!p.ok || p.bye || (only && !inContext(p, now))) continue;
    n += sendBinTo(p, buf, now);
  }
  return n;
}

function sendBinTo(p, buf, now = performance.now()) {
  if (blackhole) return 1;
  const r = routeOf(p, now);
  if (r === 'direct') return rawBinTo(p, buf);
  const relay = r && peerMap.get(r);
  if (!relay) { p.tx.dropped++; return 0; }
  if (!rawBinTo(relay, encodeFwd(FWD_TO, p.id, buf))) { p.tx.dropped++; return 0; }
  p.tx.relayed++; p.tx.bytes += buf.byteLength;
  counters.relayedOut++;
  return 1;
}

/** Binary over a peer's own direct connection: the unreliable channel when open, else the reliable 'bin' action. */
function rawBinTo(p, buf) {
  const ch = p.channel;
  if (ch && ch.readyState === 'open') {
    if (ch.bufferedAmount > NET.bufferedLimit) { p.tx.dropped++; return 0; }   // drop instead of queueing stale snapshots
    try { ch.send(buf); } catch { p.tx.dropped++; return 0; }
    p.tx.unrel++; p.tx.bytes += buf.byteLength;
    return 1;
  }
  const a = acts[ACTIONS.BIN];
  if (!a || !p.direct) return 0;
  const pr = a.send(buf, { target: p.id });
  if (pr && pr.catch) pr.catch(() => {});
  p.tx.fallback++; p.tx.bytes += buf.byteLength;
  return 1;
}

// ------------------------------------------------------------------------------------------------ unreliable channel
function openChannel(p, tries) {
  clearTimeout(p.chTimer);
  if (!room || peerMap.get(p.id) !== p || p.channel || !p.direct || TUNE.forceFallback) return;
  if (typeof room.openUnreliable === 'function') { attachChannel(p, room.openUnreliable(p.id), null); return; }
  const pc = notePc(p.id);
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
  ch.onmessage = (e) => { const q = peerMap.get(p.id); if (q === p && p.direct) onBinaryIn(p, e.data, true); };
  ch.onclose = () => {
    if (p.channel !== ch) return;
    p.channel = null;
    if (pc) chByPc.delete(pc);
    if (peerMap.get(p.id) === p && p.direct) p.chTimer = setTimeout(() => openChannel(p, 0), 500);
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
  // Pings run over the direct connection only. A pong is proof that the direct path works, which brings a peer we
  // bypassed through a relay back onto it; a ping still pending (a dead path never answers) blocks the next one only
  // for TUNE.pingStaleMs.
  if (!room || !p.direct) return 0;
  const now = performance.now();
  if (p.pingAt && now - p.pingAt < TUNE.pingStaleMs) return 0;
  p.pingAt = now;
  try {
    const ms = await room.ping(p.id);
    if (peerMap.get(p.id) !== p) return 0;
    p.pingAt = 0;
    if (!Number.isFinite(ms)) return 0;
    p.lastDirectRx = performance.now();
    directRxAt.set(p.id, p.lastDirectRx);
    p.rtt = p.pings === 0 ? ms : p.rtt + (ms - p.rtt) * TUNE.rttLambda;
    p.rttMin = Math.min(p.rttMin, ms);
    p.pings++;
    return ms;
  } catch { if (peerMap.get(p.id) === p) p.pingAt = 0; return 0; }
}

function pingAll() { for (const p of peerMap.values()) if (p.direct && !p.dropped && !p.incompatible) pingPeer(p); }

/** A relayed peer's round trip: ours to its relay plus the relay's own to it (from the relay's hello). */
function relayRtt(p, min) {
  const r = p.via && peerMap.get(p.via);
  if (!r || !r.links) return 0;
  const i = r.links.indexOf(p.id);
  const own = min ? (Number.isFinite(r.rttMin) ? r.rttMin : r.rtt) : r.rtt;
  return Math.round((own || 0) + (i >= 0 && r.linkRtt ? r.linkRtt[i] || 0 : 0));
}

/** Last measured RTT in ms (0 if unknown); through the relay for a relayed peer. */
export function rtt(peerId) {
  const p = peerMap.get(peerId);
  if (!p) return 0;
  return p.via && !directHealthy(p) ? relayRtt(p, false) || p.rtt || 0 : p.rtt || 0;
}

/** Lowest RTT seen for a peer in ms (0 if unknown); net/sync uses it to turn the snapshot clock offset into a skew. */
export function rttMin(peerId) {
  const p = peerMap.get(peerId);
  if (!p) return 0;
  if (p.via && !directHealthy(p)) return relayRtt(p, true);
  return Number.isFinite(p.rttMin) ? p.rttMin : 0;
}

/** How a peer is reached: {route: 'direct'|'relay'|'none', via: relay peer id|null} (lobby roster, diagnostics). */
export function routeInfo(peerId) {
  const p = peerMap.get(peerId);
  if (!p) return { route: 'none', via: null };
  const r = routeOf(p);
  return r === 'direct' ? { route: 'direct', via: null } : r ? { route: 'relay', via: r } : { route: 'none', via: null };
}

async function refreshDiagnostics() {
  const n = countRelays();
  if (n !== relaysOpen) { relaysOpen = n; if (status === 'online') setStatus('online', relayText()); }
  if (!room) return;
  let pcs = {};
  try { pcs = room.getPeers() || {}; } catch { pcs = {}; }
  for (const p of peerMap.values()) {
    if (!p.direct) { p.pair = 'relay'; continue; }
    const pc = pcs[p.id];
    if (pc) lastPc.set(p.id, pc);
    if (pc && p.pc && pc !== p.pc) {          // Trystero replaced the connection: rebuild our channel on the new one
      if (p.channel) { p.channel.onmessage = null; p.channel.onclose = null; p.channel = null; }
      openChannel(p, 0);
    } else if (!p.channel) openChannel(p, 0);
    if (pc && typeof pc.getStats === 'function') p.pair = await icePair(pc).catch(() => p.pair);
    else if (transport === 'local') p.pair = 'local';
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
  const now = performance.now();
  return {
    status, text: statusText, transport, roomId, selfId: selfId(), hostId: curHost, epoch: curEpoch, isHost: isHost(), relaysOpen,
    joinErrors: counters.joinErrors, lastJoinError: counters.lastJoinError, invalid: counters.invalid, muted: counters.muted,
    hostConflicts: counters.hostConflicts, resets: counters.resets, lastReset: counters.lastReset || null, wrongMatch: counters.wrongMatch,
    noHello: counters.noHello || 0, orphans: counters.orphans || 0, rejoins: counters.rejoins || 0, lastRejoin: counters.lastRejoin || null,
    relay: { out: counters.relayedOut, in: counters.relayedIn, passed: counters.relayPassed, noRoute: counters.relayNoRoute, dropped: counters.relayDropped, lastDowngrade: counters.lastDowngrade || null },
    drops: { declared: counters.declared, accepted: counters.declAccepted, rejected: counters.declRejected },
    unreachable: unreachable().map((u) => u.id), mismatch: versionMismatch(),
    context: myCtx, selfOut, out: [...outIds], relaySilentMs: Math.round(now - lastRelayMsgAt),
    netsim: SIM ? { ...SIM, ...simStats } : null,
    relayKeeper: { resumes: keeper.resumes, fails: keeper.fails, dead: keeper.dead, gen: keeper.gen },
    peers: [...peerMap.values()].map((p) => ({
      id: p.id, rtt: Math.round(rtt(p.id)), rttMin: Math.round(rttMin(p.id)),
      channel: p.channel && p.channel.readyState === 'open' ? 'unreliable' : 'fallback', pair: p.pair,
      ok: p.ok, incompatible: p.incompatible, direct: p.direct, route: routeOf(p, now), directQuietMs: Math.round(now - p.lastDirectRx),
      stale: p.stale, unresponsive: p.dead, dropped: p.dropped, ctx: p.ctx, inContext: inContext(p, now), since: p.since,
      rx: { ...p.rx }, tx: { ...p.tx },
    })),
  };
}

// Trystero logs every remote data-channel close as console.error('Trystero peer error:', RTCError 'User-Initiated
// Abort, reason=Close called'). That is a normal leave (or one of our own connection resets), not a failure, and it made
// user bug reports look alarming. Only that exact benign message is filtered; every other error passes through.
if (typeof console !== 'undefined' && !console.error.__zfFiltered) {
  const orig = console.error.bind(console);
  const filtered = (...args) => {
    const [a, b] = args;
    if (typeof a === 'string' && a.startsWith('Trystero peer error') && b && /User-Initiated Abort|Close called/i.test(String(b.message || b))) return;
    orig(...args);
  };
  filtered.__zfFiltered = true;
  console.error = filtered;
}

debug.net = Object.assign(debug.net || {}, {
  diag: diagnostics,
  session: { TUNE, electHost, peers: () => peerMap, resetConnection, linkHealth, routeInfo, directLinks, blackhole: (on = true) => { blackhole = !!on; return blackhole; } },
});
