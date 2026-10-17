// ZONEFALL - Trystero (Nostr) room, peers, host election, channels. OWNER: NET. Contract: ARCHITECTURE.md 5.5 and 8.
// Transport: Trystero's Nostr strategy is imported lazily inside connect(), so the menu and practice mode never wait for
// the CDN or the relays. `?net=local` swaps in net/localroom.js (BroadcastChannel between tabs) for tests; the rest of
// this module is identical for both transports.
// Channels: reliable Trystero actions (JSON, one per protocol.ACTIONS entry, every payload validated) and one
// unreliable, unordered RTCDataChannel per peer (negotiated id NET.channelId) for PSNAP/BOTS/SHOT. Until that channel is
// open, binary goes through the reliable 'bin' action.
// Contexts: every peer is either in the lobby context (menu, lobby, results: match tag 0) or inside one match (tag =
// protocol.matchTag(match id)); the tag rides on every snapshot (net/sync calls notePeerContext). Host election only
// counts peers in this client's own context, so a player who went back to the lobby never stays host of the match he
// left, and players still in a match never host (or join) the lobby's next round.
//   lobby host = the peer that joined the room first (hello `js`, then the lowest id), so a private lobby's creator
//                keeps START NOW;
//   match host = the lowest id among the roster's humans still in that match (not left, dropped or unresponsive).
// Connection repair: Trystero reuses one RTCPeerConnection per remote peer across rooms. A connection that died without
// a clean close (sleep, frozen tab) would be reused forever and every later handshake would time out, so a peer we drop,
// a peer still silent when we leave a room, and a peer whose handshake times out get their connection closed; Trystero
// then sees it as stale and negotiates a fresh one.
import { NET, DEV } from '../config.js';
import { emit, on, EV } from '../core/bus.js';
import { state, debug, APP } from '../core/state.js';
import { PROTOCOL_VERSION, ACTIONS, validate, toArrayBuffer, matchTag, AWAY_TAG } from './protocol.js';

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
};

const ACTION_EVENT = {
  hello: EV.NET_HELLO, lobby: EV.NET_LOBBY, start: EV.NET_START, hit: EV.NET_HIT, death: EV.NET_DEATH,
  pick: EV.NET_PICK, drop: EV.NET_DROP, nade: EV.NET_NADE, leave: EV.NET_LEAVE, kick: EV.NET_KICK,
};
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
const counters = { joinErrors: 0, lastJoinError: null, lastJoinErrorAt: 0, lastToastAt: 0, invalid: 0, muted: 0, hostConflicts: 0, resets: 0, wrongMatch: 0 };
let mismatch = null;               // {theirs, ours, at}: the last peer that failed the handshake on the game version

function makePeer(id) {
  return {
    id, seq: ++joinSeq, joinedAt: performance.now(), stale: false, dead: false, dropped: false,
    ctx: null, prevCtx: null, ctxAt: performance.now(), since: 0,
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
 * @param {{roomId:string, password?:string|null, transport?:'nostr'|'local', joiner?:boolean}} opts
 */
export async function connect(opts) {
  if (!opts || typeof opts.roomId !== 'string' || !opts.roomId) throw new Error('[NET/session] connect needs a roomId');
  if (room) leave();
  const token = ++connectToken;
  const kind = opts.transport || TUNE.transport;
  setStatus('connecting', 'Connecting to matchmaking servers');

  const config = { appId: NET.appId };
  if (opts.password) config.password = String(opts.password);
  const callbacks = { onPeerHandshake, onJoinError };
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
    }
  } catch (err) {
    if (token === connectToken) setStatus('error', "Can't reach matchmaking servers");
    throw new Error(`Can't reach matchmaking servers (${err && err.message || err})`);
  }
  if (token !== connectToken) { try { r.leave(); } catch { /* superseded */ } throw new Error('Connection cancelled'); }

  room = r; roomId = opts.roomId; transport = kind; mySelf = self; relaySockets = sockets;
  mySince = Date.now() + (opts.joiner ? TUNE.joinerBiasMs : 0);
  acts = {};
  for (const name of ACTION_NAMES) {
    const a = room.makeAction(name);
    a.onMessage = (data, meta) => onAction(name, data, meta && typeof meta === 'object' ? meta.peerId : meta);
    acts[name] = a;
  }
  room.onPeerJoin = (id) => addPeer(id);
  room.onPeerLeave = (id) => removePeer(id, 'left');

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
  setStatus('online', relayText());
  if (SIM && !simAnnounced) {
    simAnnounced = true;
    emit(EV.TOAST, { text: `Network simulation on: +${SIM.ping} ms ping, ${Math.round(SIM.loss * 100)}% loss, ${SIM.jitter} ms jitter.`, kind: 'warn', ms: 6000 });
  }
  return { roomId, selfId: mySelf };
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
  const r = room;
  room = null;
  for (const t of timers) clearInterval(t);
  timers = [];
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
}

// ------------------------------------------------------------------------------------------------ handshake
async function onPeerHandshake(peerId, send, receive) {
  await send({ v: TUNE.protocol, app: NET.appId });
  const got = await receive();
  const d = got && typeof got === 'object' && 'data' in got ? got.data : got;
  // a reply without a version number is not another game version (that toast would tell someone to reload for
  // nothing): a plain handshake failure, Trystero tries again
  if (!d || !Number.isFinite(d.v)) throw new Error('handshake failed: unexpected reply');
  if (d.v !== TUNE.protocol) {
    mismatch = { theirs: d.v, ours: TUNE.protocol, at: performance.now(), room: roomId, peer: peerId };
    throw new Error(`protocol mismatch ${TUNE.protocol}/${d.v}`);
  }
}

/**
 * A game-version mismatch seen in the current room (Trystero stops re-trying the handshake after a few attempts, so it
 * stays valid while we stay in the room, up to TUNE.mismatchShowMs): {theirs, ours} (net/lobby explains it), else null.
 */
export function versionMismatch() {
  return mismatch && mismatch.room === roomId && roomId && performance.now() - mismatch.at < TUNE.mismatchShowMs ? { theirs: mismatch.theirs, ours: mismatch.ours } : null;
}

function onJoinError(e) {
  const text = String((e && e.error) || e || 'join error');
  const peerId = e && typeof e === 'object' ? e.peerId : null;
  counters.joinErrors++;
  counters.lastJoinError = text;
  const now = performance.now();
  counters.lastJoinErrorAt = now;
  if (peerId && /timed out|could not connect|disconnected during handshake/i.test(text)) {
    // The usual cause: a connection to this peer that died silently and that Trystero keeps reusing. Close it so the
    // next attempt (Trystero re-announces every few seconds) negotiates a fresh one.
    const n = (repairs.get(peerId) || 0) + 1;
    repairs.set(peerId, n);
    resetConnection(peerId, 'handshake-failed');
    // the peer that failed the version check keeps timing out afterwards: that is not a connection to repair
    const versionPeer = mismatch && mismatch.peer === peerId && mismatch.room === roomId;
    if (!versionPeer && n >= TUNE.repairToastAfter && now - counters.lastToastAt >= TUNE.joinErrorToastMs) {
      counters.lastToastAt = now;
      emit(EV.TOAST, { text: 'Reconnecting to a player. This can take a few seconds.', kind: 'warn', ms: 4000 });
    }
    return;
  }
  if (/mismatch/i.test(text)) {
    // Trystero retries the handshake every few seconds: one toast now and then, the lobby text explains it meanwhile
    if (now - (counters.lastMismatchToastAt || -1e9) < TUNE.mismatchToastMs) return;
    counters.lastMismatchToastAt = now;
    counters.lastToastAt = now;
    const newer = mismatch && mismatch.theirs > mismatch.ours;
    emit(EV.TOAST, { text: newer ? 'A newer version of ZONEFALL is out. Reload the page to update.' : 'A player with an older version of ZONEFALL cannot join until they reload their page.', kind: 'warn', ms: 6000 });
    return;
  }
  if (now - counters.lastToastAt < TUNE.joinErrorToastMs) return;   // a bad room streams these about once a second
  if (/password/i.test(text)) {
    counters.lastToastAt = now;
    emit(EV.TOAST, { text: 'Lobby code rejected by another player.', kind: 'warn', ms: 4000 });
  }
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
function peerConnectionClass() {
  if (PCClass || typeof RTCPeerConnection !== 'function') return PCClass;
  PCClass = class ZonefallPeerConnection extends RTCPeerConnection {
    constructor(...args) {
      super(...args);
      // ?netsim: wrap channels the remote side opens before Trystero's ondatachannel handler sees them
      if (SIM) this.addEventListener('datachannel', (e) => simChannel(e.channel));
    }
    createDataChannel(label, opts) {
      if (label === 'data' && !(opts && opts.negotiated)) this.zfOfferer = true;
      return simChannel(super.createDataChannel(label, opts));
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

/** Delivery time for one simulated message, or -1 if it is lost. `q` keeps reliable messages in order per direction. */
function simAt(q, key, unreliable) {
  const now = performance.now();
  let at = now + SIM.ping / 2 + Math.random() * SIM.jitter;
  if (unreliable) {
    if (Math.random() < SIM.loss) { simStats.lost++; return -1; }
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

/** Remember the connection of each peer (Trystero keeps it across rooms, so must we, to be able to close it). */
function notePc(id) {
  if (!room) return null;
  let pc = null;
  try { pc = (room.getPeers() || {})[id] || null; } catch { pc = null; }
  if (pc) lastPc.set(id, pc);
  return pc;
}

// ------------------------------------------------------------------------------------------------ peers
function addPeer(id) {
  if (!room || !id || id === mySelf) return;
  let p = peerMap.get(id);
  if (p) return;
  p = makePeer(id);
  peerMap.set(id, p);
  repairs.delete(id);
  notePc(id);
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

/**
 * Non-stale peers in this client's own context (the lobby while in the menu/lobby/results, else the current match),
 * ordered lobby-host first (join time, then id). net/lobby builds its roster from these.
 */
export function contextPeers() {
  const now = performance.now();
  const out = [];
  for (const p of peerMap.values()) if (!p.stale && !p.dropped && inContext(p, now)) out.push(p.id);
  return out.sort(bySince);
}

/** Non-stale peers currently playing a match other than ours (their snapshots carry a match tag; away is none). */
export function peersInMatch() {
  const out = [];
  for (const p of peerMap.values()) if (!p.stale && !p.dropped && p.ctx && p.ctx !== AWAY_TAG && p.ctx !== myCtx) out.push(p.id);
  return out;
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
    if (p.id === peerId || p.dropped || p.stale || !p.hears || now - p.hearsAt > 6000 || !inContext(p, now)) continue;
    if (p.hears.has(peerId)) return true;
  }
  return false;
}

/** Close a peer's connection so Trystero negotiates a new one, without dropping it (net/sync's link repair). */
export function repairConnection(peerId) { return resetConnection(peerId, 'repair'); }

/** This client lost its place in the current match (game/match on a forfeit): it stops hosting and is never elected. */
export function setSelfOut(on) {
  if (selfOut === !!on) return;
  selfOut = !!on;
  elect();
}

/** net/sync detected that this page itself stalled for ms (frozen tab, long task): relay silence during it is ours. */
export function noteLocalStall(ms) {
  const now = performance.now();
  lastRelayMsgAt = Math.min(now, lastRelayMsgAt + Math.max(0, ms));
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
  for (const p of peerMap.values()) list.push({ id: p.id, dead: p.dead, dropped: p.dropped, away: !inContext(p, now) || (myCtx === 0 && !!p.inResults), since: p.since });
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
    if (p.dropped || !inContext(p, now)) continue;
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
/** Reliable send of a protocol action payload to everyone or one peer. Returns false when offline. */
export function send(action, data, target = null) {
  if (!room || !state.online) return false;
  if (blackhole) return true;
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
  if (!p || blackhole) return;
  if (name === ACTIONS.BIN) { onBinaryIn(p, data, false); return; }
  if (!rateOk(p, false)) return;
  p.rx.rel++;
  const v = validate[name] ? validate[name](data) : null;
  if (!v) { p.rx.invalid++; counters.invalid++; return; }
  if (name === ACTIONS.HELLO) {
    // hellos always pass (lobby rosters, quick-play probes); the join time decides the lobby host
    if (v.js > 0 && p.since !== v.js) { p.since = v.js; elect(); }
    p.hears = new Set(v.hr);
    p.hearsAt = performance.now();
    if (p.inResults !== v.rs) { p.inResults = v.rs; elect(); }
  } else if (p.dropped && name !== ACTIONS.DROP) return;   // a peer dropped from our match: only its death drop still counts
  if (IN_MATCH.has(name)) {
    if (!myMid || v.mid !== myMid) { counters.wrongMatch++; return; }
    if (name === ACTIONS.LEAVE) { refreshOut(); outIds.add(from); elect(); }
    else if (name !== ACTIONS.DROP && name !== ACTIONS.KICK && isOut(from)) return;
  }
  if (name === ACTIONS.HOST) { onHostMessage(v, from); return; }
  if ((name === ACTIONS.LOBBY || name === ACTIONS.START) && from === curHost) curEpoch = Math.max(curEpoch, v.ep);
  emit(ACTION_EVENT[name], { from, data: v });
}

// ------------------------------------------------------------------------------------------------ binary
/** Register the single binary consumer (net/sync): fn(fromPeerId, arrayBuffer). */
export function setBinaryHandler(fn) { binHandler = typeof fn === 'function' ? fn : null; }

function onBinaryIn(p, data, unreliable) {
  // Dropped peers still reach net/sync (liveness, and a kick if they still think they are in our match).
  if (!p || blackhole || !rateOk(p, true)) return;
  const buf = toArrayBuffer(data);
  if (!buf || buf.byteLength > NET.maxReceiveBytes) { p.rx.invalid++; return; }
  if (unreliable) p.rx.unrel++; else p.rx.fallback++;
  p.rx.bytes += buf.byteLength;
  if (binHandler) binHandler(p.id, buf);
}

/**
 * Unreliable send of a binary message (ArrayBuffer) to everyone or one peer (reliable 'bin' fallback until open).
 * opts.contextOnly: only peers in this client's context (bot batches and shots are of no use to anyone else).
 */
export function sendBinary(buf, target = null, opts = null) {
  if (!room || !state.online) return 0;
  let n = 0;
  if (target) { const p = peerMap.get(target); if (p) n += sendBinTo(p, buf); return n; }
  const only = !!(opts && opts.contextOnly);
  const now = performance.now();
  for (const p of peerMap.values()) if (!only || inContext(p, now)) n += sendBinTo(p, buf);
  return n;
}

function sendBinTo(p, buf) {
  if (blackhole) return 1;
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

function pingAll() { for (const p of peerMap.values()) if (!p.dropped && !p.dead) pingPeer(p); }

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
    context: myCtx, selfOut, out: [...outIds], relaySilentMs: Math.round(now - lastRelayMsgAt),
    netsim: SIM ? { ...SIM, ...simStats } : null,
    relayKeeper: { resumes: keeper.resumes, fails: keeper.fails, dead: keeper.dead, gen: keeper.gen },
    peers: [...peerMap.values()].map((p) => ({
      id: p.id, rtt: Math.round(p.rtt), rttMin: Number.isFinite(p.rttMin) ? Math.round(p.rttMin) : 0,
      channel: p.channel && p.channel.readyState === 'open' ? 'unreliable' : 'fallback', pair: p.pair,
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
  session: { TUNE, electHost, peers: () => peerMap, resetConnection, linkHealth, blackhole: (on = true) => { blackhole = !!on; return blackhole; } },
});
