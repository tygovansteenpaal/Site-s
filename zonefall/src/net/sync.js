// ZONEFALL - snapshot send loop, clock mapping, interpolation, pose history. OWNER: NET. Contract: ARCHITECTURE.md 5.5 and 8.
// Send: the local PSNAP at NET.snapRate in a match (NET.lobbySnapRate otherwise, life = SPECTATE, for liveness and clock
// offsets); the host also sends one BOTS batch at NET.botRate. Receive: per-peer clock offset = min(recv - tSender) over a
// sliding window (so a lasting latency rise is learned within seconds, rising at a limited rate), out-of-order samples
// dropped with seqNewer, a 30-sample buffer per entity. Every remote entity is
// rendered at now - delay, where delay = clamp(2 x interval + 2 x jitter, interpMin, interpMax) is measured per source
// and eased so it never jumps; past the newest sample it extrapolates at most TUNE.extrapolateMs, then holds.
// Context: every binary message carries the sender's match tag (protocol 2). A snapshot only feeds an entity when it is
// from our own match, so a peer back in the lobby never snaps to the origin and a peer in another match never appears in
// ours; BOTS and SHOT from another context are rejected.
// Sending runs from a 20 Hz timer as well as from the frame, so snapshots (and liveness) keep their rate when rendering
// is slow. Liveness (humans): silence is measured with this page's own stalls removed (a frozen tab or a long task must
// not make everyone else look silent). stale after NET.staleMs (ghost, session.setStale); unresponsive after
// NET.hostStaleMs (loses the host role, session.setUnresponsive); in a match, dropped after NET.dropMs (session.markDropped,
// a 'left' death) only with evidence that our own link works: another player is still heard, or a relay spoke / an
// own-link probe (session.probeLink) succeeded after the silence began. A failed probe (or the browser offline) means
// this client is the one cut off: NET_LINK {state:'lost'} and game/match forfeits. Relays down alone decide nothing.
// A page that stalled for about NET.dropMs itself also forfeits (everyone else has dropped it by then), and a peer we
// dropped that still sends live snapshots of our match is told so with a 'kick'.
import { NET, WEAPONS } from '../config.js';
import { on, emit, EV } from '../core/bus.js';
import { state, debug, APP, LIFE, FLAG, botId, isBotId, getPlayer } from '../core/state.js';
import { clamp, damp, wrapAngle } from '../core/util.js';
import {
  MSG, ACTIONS, encodePlayerSnap, decodePlayerSnap, encodeBotBatch, decodeBotBatch, encodeShot, decodeShot, msgType, seqNewer,
} from './protocol.js';
import * as session from './session.js';

export const TUNE = {
  bufferSize: 30,
  extrapolateMs: 100,
  offsetDrift: 0.02,       // ms added per sample by the legacy pure estimator (updateOffset, kept for the self-tests)
  offsetBucketMs: 1000,    // sliding-window clock offset: per-bucket minimum of (recv - send) ...
  offsetBuckets: 5,        // ... over this many closed buckets plus the current one (about 5-6 s of history)
  offsetRise: 0.08,        // ms per ms: how fast the estimate may climb to a higher window minimum (playback at 0.92x)
  teleportDist: 40,        // m between consecutive samples: snap instead of sliding across the map
  intervalAlpha: 0.1,      // EMA weight for arrival interval and jitter
  delayLambda: 1.5,        // 1/s easing of the interpolation delay toward its target
  poseHz: 60,              // own (and host bot) pose history sample rate
  speedLambda: 10,         // 1/s smoothing of the reported speed of remote entities
  pumpMs: 50,              // send/liveness timer, independent of the render loop
  sendEarly: 0.3,          // a tick up to this fraction of a period early still sends (ticks and periods are both 50 ms:
                           // a tick 0.1 ms early used to skip a whole period and halve the snapshot and bot rate)
  catchupJump: 0.25,       // m: a sampled pose off its own motion by more than this (a burst of loss ended, an
  catchupTau: 0.1,         // extrapolation overshot) is blended in with a render offset decaying with this time constant (s)
  catchupMaxSpeed: 30,     // m/s: the blend never closes the offset faster than this (on top of the entity's own motion)
  stallMs: 1000,           // a gap this long between our own ticks is a local stall (not counted as anyone's silence)
  stallForfeitMargin: 500, // a local stall of NET.dropMs minus this means the others have dropped us: forfeit
  evidenceMs: 1000,        // a relay message or link probe this long after a peer went silent proves our link works
  decideMaxMs: 15000,      // past NET.dropMs + this, a silent peer is dropped even without fresh evidence
  kickEveryMs: 2000,       // repeat a 'kick' to a dropped peer that keeps sending live snapshots at most this often
  repairEveryMs: 10000,    // a silent peer that others still hear: reset our connection to it at most this often
  lobbyStaleMs: 6500,      // lobby context: silence (snapshots and hellos) before a peer leaves the roster ...
  lobbyDeadMs: 9000,       // ... and before it can no longer be elected lobby host
  startGraceS: 15,         // match time before which nobody is dropped and no stall forfeits (match start is the
                           // heaviest moment for a slow machine: world reset, shader warm-up; both sides agree on t)
};

// ------------------------------------------------------------------------------------------------ tracks
/** A per-entity snapshot buffer with arrival statistics. Exported through `testing` for the harness self-tests. */
export function createTrack(id) {
  return {
    id, buf: [], newest: null, lastRecv: 0, heardAt: 0, interval: 0, jitter: 0, delay: NET.interpDelay, recv: 0, lost: 0, ooo: 0, late: 0,
    renderT: 0,   // local time this track was last sampled at (an older sample that is still ahead of it is kept)
    stale: false, dead: false, dropped: false, killed: false, speed: 0, starved: false,
    // catch-up smoothing (smoothJump): last raw sampled position and the decaying render offset
    has: false, px: 0, py: 0, pz: 0, ex: 0, ey: 0, ez: 0,
  };
}

/**
 * Push a decoded sample (needs .seq, .t, and .lt = local time) into a track. Returns false if it was useless. A sample
 * that arrives after a newer one (reordered on the way) is slotted into the buffer while it is still ahead of the
 * render time, so a late but usable snapshot is not wasted; behind it, it only counts as out of order.
 */
export function pushSample(tr, s, now) {
  const last = tr.newest;
  if (last) {
    if (!seqNewer(s.seq, last.seq)) return insertLate(tr, s);
    const gap = (s.seq - last.seq) & 0xffff;
    if (gap > 1) tr.lost += gap - 1;
    const dt = now - tr.lastRecv;
    if (tr.recv < 2) { tr.interval = dt; tr.jitter = 0; } else {
      tr.interval += (dt - tr.interval) * TUNE.intervalAlpha;
      tr.jitter += (Math.abs(dt - tr.interval) - tr.jitter) * TUNE.intervalAlpha;
    }
    if (s.lt <= last.lt) s.lt = last.lt + 1;   // the offset estimate only moves forward slowly; keep local times monotonic
  }
  tr.buf.push(s);
  if (tr.buf.length > TUNE.bufferSize) tr.buf.shift();
  tr.newest = s;
  tr.lastRecv = now;
  tr.recv++;
  return true;
}

function insertLate(tr, s) {
  const buf = tr.buf;
  if (!tr.renderT || s.lt <= tr.renderT || !buf.length || !seqNewer(s.seq, buf[0].seq)) { tr.ooo++; return false; }
  let i = buf.length - 1;
  while (i > 0 && seqNewer(buf[i - 1].seq, s.seq)) i--;
  if (buf[i].seq === s.seq || (i > 0 && buf[i - 1].seq === s.seq)) { tr.ooo++; return false; }   // a duplicate
  const lo = i > 0 ? buf[i - 1].lt : -Infinity, hi = buf[i].lt;
  if (!(s.lt > lo && s.lt < hi)) s.lt = Number.isFinite(lo) ? (lo + hi) / 2 : hi - 1;
  if (s.lt <= tr.renderT) { tr.ooo++; return false; }
  buf.splice(i, 0, s);
  if (buf.length > TUNE.bufferSize) buf.shift();
  if (tr.lost > 0) tr.lost--;      // counted as lost when the newer one skipped its sequence number
  tr.late++;
  return true;
}

/** Target interpolation delay for a track: clamp(2 x interval + 2 x jitter, interpMin, interpMax). */
export function targetDelay(tr) {
  if (tr.recv < 3) return NET.interpDelay;
  return clamp(2 * tr.interval + 2 * tr.jitter, NET.interpMin, NET.interpMax);
}

/**
 * Sample a track at local time rt into out {x,y,z,yaw,pitch,vx,vy,vz,src}. src is the sample discrete fields come from
 * (the nearer of the bracketing pair). Returns false when the track is empty.
 */
export function sampleTrack(tr, rt, out) {
  const buf = tr.buf, n = buf.length;
  if (n === 0) return false;
  out.vx = 0; out.vy = 0; out.vz = 0;
  tr.starved = false;
  if (n === 1 || rt <= buf[0].lt) {
    const s = rt <= buf[0].lt ? buf[0] : buf[n - 1];
    out.x = s.x; out.y = s.y; out.z = s.z; out.yaw = s.yaw; out.pitch = s.pitch; out.src = s;
    tr.starved = n === 1 && rt > s.lt + TUNE.extrapolateMs;
    return true;
  }
  const last = buf[n - 1];
  if (rt >= last.lt) {
    const prev = buf[n - 2];
    const span = last.lt - prev.lt;
    const ex = Math.min(rt - last.lt, TUNE.extrapolateMs);
    tr.starved = rt - last.lt > TUNE.extrapolateMs;
    out.x = last.x; out.y = last.y; out.z = last.z; out.yaw = last.yaw; out.pitch = last.pitch; out.src = last;
    if (span > 0) {
      const dx = last.x - prev.x, dy = last.y - prev.y, dz = last.z - prev.z;
      if (dx * dx + dy * dy + dz * dz < TUNE.teleportDist * TUNE.teleportDist) {
        // continue the last motion for at most extrapolateMs, then hold there (velocity reported as 0 while holding)
        const k = ex / span;
        out.x += dx * k; out.y += dy * k; out.z += dz * k;
        if (!tr.starved) { const f = 1000 / span; out.vx = dx * f; out.vy = dy * f; out.vz = dz * f; }
      }
    }
    return true;
  }
  // bracketing pair, searched from the newest end (rt is normally near it)
  let i = n - 2;
  while (i > 0 && buf[i].lt > rt) i--;
  const a = buf[i], b = buf[i + 1];
  const span = b.lt - a.lt;
  const k = span > 0 ? (rt - a.lt) / span : 1;
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  if (dx * dx + dy * dy + dz * dz > TUNE.teleportDist * TUNE.teleportDist) {
    const s = k < 0.5 ? a : b;
    out.x = s.x; out.y = s.y; out.z = s.z; out.yaw = s.yaw; out.pitch = s.pitch; out.src = s;
    return true;
  }
  out.x = a.x + dx * k; out.y = a.y + dy * k; out.z = a.z + dz * k;
  out.yaw = wrapAngle(a.yaw + wrapAngle(b.yaw - a.yaw) * k);
  out.pitch = a.pitch + (b.pitch - a.pitch) * k;
  if (span > 0) { const f = 1000 / span; out.vx = dx * f; out.vy = dy * f; out.vz = dz * f; }
  out.src = k < 0.5 ? a : b;
  return true;
}

/** Legacy pure estimator (self-tests): offset = min(recv - tSender), drifting up TUNE.offsetDrift per sample. */
export function updateOffset(prev, recvMs, senderMs) {
  const o = recvMs - senderMs;
  return prev == null ? o : Math.min(prev + TUNE.offsetDrift, o);
}

/** State of the sliding-window clock offset estimator of one peer (offsetSample). */
export function createOffsetEst() { return { est: null, buckets: [], bStart: 0, bMin: Infinity, at: 0 }; }

/**
 * Clock offset (local = remote + offset, best-case one-way delay included) from one sample: the minimum of
 * (recv - send) over the last TUNE.offsetBuckets seconds. A lower minimum is followed at once (samples arrive earlier
 * than predicted); a higher one, after a lasting latency rise, is approached at TUNE.offsetRise so playback slows down
 * for a moment instead of jumping. A plain running minimum never forgets the low-latency past: after a 150 ms rise it
 * took minutes to learn, and every remote player and bot starved the interpolation buffer in the meantime.
 * @param {ReturnType<typeof createOffsetEst>} o  @param {number} recvMs local receive time  @param {number} senderMs
 */
export function offsetSample(o, recvMs, senderMs) {
  const v = recvMs - senderMs;
  if (o.est == null) { o.est = v; o.bMin = v; o.bStart = recvMs; o.at = recvMs; return v; }
  if (recvMs - o.bStart >= TUNE.offsetBucketMs) {
    o.buckets.push(o.bMin);
    if (o.buckets.length > TUNE.offsetBuckets) o.buckets.shift();
    o.bStart = recvMs;
    o.bMin = v;
  } else if (v < o.bMin) o.bMin = v;
  let target = o.bMin;
  for (const b of o.buckets) if (b < target) target = b;
  const dt = Math.max(0, recvMs - o.at);
  o.at = recvMs;
  o.est = target <= o.est ? target : Math.min(target, o.est + TUNE.offsetRise * dt);
  return o.est;
}

// ------------------------------------------------------------------------------------------------ pose history ring
function createRing(seconds, hz) {
  const cap = Math.ceil(seconds * hz * 1.25) + 4;
  return { cap, t: new Float64Array(cap), p: new Float32Array(cap * 3), head: 0, len: 0 };
}
function ringPush(r, t, x, y, z) {
  r.t[r.head] = t; r.p[r.head * 3] = x; r.p[r.head * 3 + 1] = y; r.p[r.head * 3 + 2] = z;
  r.head = (r.head + 1) % r.cap;
  if (r.len < r.cap) r.len++;
}
function ringAt(r, tMs) {
  if (r.len === 0) return null;
  const idx = (k) => (r.head - 1 - k + r.cap * 2) % r.cap;     // k = 0 newest
  const newest = idx(0), oldest = idx(r.len - 1);
  if (tMs >= r.t[newest]) {
    if (tMs - r.t[newest] > 250) return null;
    return { x: r.p[newest * 3], y: r.p[newest * 3 + 1], z: r.p[newest * 3 + 2] };
  }
  if (tMs < r.t[oldest]) return null;
  for (let k = 0; k < r.len - 1; k++) {
    const b = idx(k), a = idx(k + 1);
    if (r.t[a] <= tMs) {
      const span = r.t[b] - r.t[a], f = span > 0 ? (tMs - r.t[a]) / span : 0;
      return {
        x: r.p[a * 3] + (r.p[b * 3] - r.p[a * 3]) * f,
        y: r.p[a * 3 + 1] + (r.p[b * 3 + 1] - r.p[a * 3 + 1]) * f,
        z: r.p[a * 3 + 2] + (r.p[b * 3 + 2] - r.p[a * 3 + 2]) * f,
      };
    }
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ module state
const tracks = new Map();      // entity id (peer id or bot:<slot>) -> track
const offsets = new Map();     // peer id -> clock offset (windowed min recv - send), ms
const offsetEsts = new Map();  // peer id -> offsetSample state
const killed = new Set();      // entity ids that died this match (snapshots never revive them)
const selfRing = createRing(NET.historyMs / 1000, TUNE.poseHz);
const botRings = new Map();    // bot id -> ring (host only)
let snapSeq = 0, botSeq = 0, shotSeq = 0;
let nextSnapAt = 0, nextBotAt = 0, lastPoseAt = 0, lastBotPoseAt = 0;
let lastSnapRate = 0;
let inited = false;
let lastTickAt = 0;
let linkState = 'ok';          // NET_LINK state during a match: 'ok' | 'interrupted' | 'lost'
const kickAt = new Map();      // peer id -> last 'kick' sent (ms)
const cueState = new Map();    // remote entity id -> {flags, weapon, reloadAt, fired} for reload/switch/plate sounds
const tmp = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, src: null };
const counters = { psnapIn: 0, botsIn: 0, shotsIn: 0, psnapOut: 0, botsOut: 0, shotsOut: 0, rejected: 0, foreign: 0, stalls: 0, maxStallMs: 0, kicks: 0, repairs: 0 };
const snapScratch = { weapon: null, seq: 0, t: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0, hp: 0, armor: 0, life: 0, tag: 0 };
const botScratch = [];
const CTX_ONLY = Object.freeze({ contextOnly: true });   // bot batches and shots only go to players in our match

function trackFor(id) {
  let tr = tracks.get(id);
  if (!tr) { tr = createTrack(id); tr.lastRecv = tr.heardAt = performance.now(); tracks.set(id, tr); }
  return tr;
}

function clearSamples(tr) { tr.buf.length = 0; tr.newest = null; tr.recv = 0; tr.interval = 0; tr.jitter = 0; tr.delay = NET.interpDelay; tr.has = false; tr.ex = 0; tr.ey = 0; tr.ez = 0; }

function setLink(next, reason) {
  if (linkState === next) return;
  linkState = next;
  emit(EV.NET_LINK, { state: next, reason: reason || null });
}

// ------------------------------------------------------------------------------------------------ init
/** Register as session's binary handler. */
export function init() {
  if (inited) return;
  inited = true;
  session.setBinaryHandler(onBinary);
  on(EV.PEER_JOIN, ({ id }) => { const tr = trackFor(id); tr.lastRecv = tr.heardAt = performance.now(); tr.stale = false; tr.dead = false; tr.dropped = false; });
  on(EV.PEER_LEAVE, ({ id, reason }) => {
    if (reason === 'timeout') return;          // keep its last pose as a ghost; the entity is dead for this match
    // Trystero lost the connection of a player in our match without a 'leave' from him: keep the silent track, so the
    // liveness rules decide (drop him, or find that we are the one cut off) instead of a one-sided instant 'left'.
    const e = getPlayer(id);
    if (reason === 'left' && e && e.kind === 'remote' && e.alive && session.contextTag() && !session.isOut(id)) return;
    tracks.delete(id);
    offsets.delete(id);
    offsetEsts.delete(id);
  });
  // In the lobby (menu, lobby, results) any hello proves a peer is alive, not just its 5 Hz snapshots: a peer whose
  // snapshots stall for a few seconds on an overloaded machine must not drop out of the roster and the lobby host
  // election while its reliable messages keep arriving (that split one lobby into two hosts and two matches).
  on(EV.NET_HELLO, ({ from }) => {
    if (session.contextTag()) return;
    const tr = trackFor(from);
    tr.heardAt = Math.max(tr.heardAt, performance.now());
    if (tr.stale) { tr.stale = false; session.setStale(from, false); }
    if (tr.dead) { tr.dead = false; session.setUnresponsive(from, false); }
  });
  on(EV.NET_KICK, ({ from }) => {
    if (!session.contextTag() || linkState === 'lost') return;
    // Two players who dropped each other (a link between them failed while both stayed online) both send a kick;
    // only the higher id gives way, so exactly one of them leaves and both views agree.
    if (session.isOut(from) && session.selfId() < from) return;
    setLink('lost', 'kicked');
  });
  on(EV.HOST_CHANGED, ({ self }) => {
    // Bot samples are only valid from one host's clock and sequence; a new host starts fresh tracks.
    for (const id of [...tracks.keys()]) if (isBotId(id)) tracks.delete(id);
    if (self) { botRings.clear(); nextBotAt = 0; }
  });
  on(EV.MATCH_START, () => {
    killed.clear();
    selfRing.len = 0; selfRing.head = 0;
    botRings.clear();
    kickAt.clear();
    cueState.clear();
    for (const id of [...tracks.keys()]) if (isBotId(id)) tracks.delete(id);
    for (const tr of tracks.values()) { tr.killed = false; tr.dropped = false; clearSamples(tr); }
    nextSnapAt = 0; nextBotAt = 0;
    linkState = 'ok';
  });
  on(EV.PLAYER_KILLED, ({ id }) => { killed.add(id); const tr = tracks.get(id); if (tr) tr.killed = true; });
  on(EV.APP_STATE, ({ to }) => {
    if (to !== APP.MENU && to !== APP.LOBBY && to !== APP.RESULTS) return;
    killed.clear(); botRings.clear(); kickAt.clear();
    linkState = 'ok';
    // ghost tracks of players whose connection is gone were only kept for the match
    const live = new Set(session.allPeers());
    for (const id of [...tracks.keys()]) if (!isBotId(id) && !live.has(id)) { tracks.delete(id); offsets.delete(id); offsetEsts.delete(id); }
  });
  setInterval(pump, TUNE.pumpMs);
}

// ------------------------------------------------------------------------------------------------ receive
function onBinary(from, buf) {
  const type = msgType(buf);
  const now = performance.now();
  const myTag = session.contextTag();
  if (type === MSG.PSNAP) {
    const s = decodePlayerSnap(buf);
    if (!s) { counters.rejected++; return; }
    counters.psnapIn++;
    session.notePeerContext(from, s.tag);
    const off = offsetOf(from, now, s.t);
    s.lt = s.t + off;
    const tr = trackFor(from);
    tr.heardAt = now;
    if (tr.stale) { tr.stale = false; session.setStale(from, false); }
    if (tr.dead) { tr.dead = false; session.setUnresponsive(from, false); }
    if (myTag && s.tag !== myTag) { counters.foreign++; return; }   // lobby, results or another match: not in ours
    if (myTag && (tr.dropped || session.isOut(from))) { kickIfLive(from, s, now); return; }
    pushSample(tr, s, now);
  } else if (type === MSG.BOTS) {
    if (from !== session.hostId() || session.isHost()) { counters.rejected++; return; }
    const b = decodeBotBatch(buf);
    if (!b) { counters.rejected++; return; }
    if (!myTag || b.tag !== myTag) { counters.foreign++; return; }
    counters.botsIn++;
    const off = offsetOf(from, now, b.t);
    for (const e of b.bots) {
      e.seq = b.seq; e.t = b.t; e.lt = b.t + off;
      pushSample(trackFor(botId(e.slot)), e, now);
    }
  } else if (type === MSG.SHOT) {
    const s = decodeShot(buf);
    if (!s) { counters.rejected++; return; }
    if (!myTag || s.tag !== myTag) { counters.foreign++; return; }
    if (session.isOut(from)) { counters.rejected++; return; }
    let shooterId = from;
    if (s.botSlot != null) {
      if (from !== session.hostId()) { counters.rejected++; return; }
      shooterId = botId(s.botSlot);
    }
    counters.shotsIn++;
    emit(EV.NET_SHOT, { from, shooterId, shot: s });
  } else counters.rejected++;
}

/** Feed one (receive, send) pair of a peer into its offset estimator; returns the current offset. */
function offsetOf(from, now, tSender) {
  let o = offsetEsts.get(from);
  if (!o) { o = createOffsetEst(); offsetEsts.set(from, o); }
  const off = offsetSample(o, now, tSender);
  offsets.set(from, off);
  return off;
}

/** A peer we dropped from this match still sends live snapshots of it: tell it (reliable 'kick'), at most every 2 s. */
function kickIfLive(from, s, now) {
  if (s.life === LIFE.DEAD || s.life === LIFE.SPECTATE) return;
  if (now - (kickAt.get(from) || -1e9) < TUNE.kickEveryMs) return;
  kickAt.set(from, now);
  if (session.send(ACTIONS.KICK, { mid: state.match.id }, from)) counters.kicks++;
}

// ------------------------------------------------------------------------------------------------ update
function matchRunning(me) {
  return (state.app === APP.MATCH || state.app === APP.RESULTS) && state.match.phase !== 'idle' && !!me;
}

/** 20 Hz timer: sends and liveness keep running between slow frames (a hidden tab ticks through update instead). */
function pump() {
  const now = performance.now();
  if (!state.online) { lastTickAt = now; return; }
  tick(now);
}

/** Shared by the timer and the frame: own-stall detection, snapshot sends, liveness. */
function tick(now) {
  const gap = lastTickAt ? now - lastTickAt : 0;
  lastTickAt = now;
  const me = getPlayer(state.selfId);
  const inMatch = matchRunning(me);
  if (gap > TUNE.stallMs) onLocalStall(gap, now, me);
  sendSnapshots(now, me, inMatch);
  liveness(now, inMatch);
}

function onLocalStall(gap, now, me) {
  counters.stalls++;
  counters.maxStallMs = Math.max(counters.maxStallMs, Math.round(gap));
  // Nobody can have been heard while this page was not running: do not count the stall as their silence.
  const shift = gap - TUNE.pumpMs;
  for (const tr of tracks.values()) {
    tr.heardAt = Math.min(now, tr.heardAt + shift);
    tr.lastRecv = Math.min(now, tr.lastRecv + shift);
  }
  session.noteLocalStall(shift);
  // Frozen for about NET.dropMs: the other players have dropped us from the match by now.
  if (gap >= NET.dropMs - TUNE.stallForfeitMargin && session.contextTag() && me && othersInMatch() > 0 && state.match.time >= TUNE.startGraceS) setLink('lost', 'stall');
}

/** Remote humans of our match that have not left or been dropped. */
function othersInMatch() {
  let n = 0;
  for (const r of state.match.roster) {
    if (r.kind !== 'human' || r.id === state.selfId || session.isOut(r.id)) continue;
    const tr = tracks.get(r.id);
    if (tr && tr.dropped) continue;
    n++;
  }
  return n;
}

function liveness(now, inMatch) {
  const myTag = session.contextTag();
  // the lobby is relaxed (nothing moves there; hellos count as life too), a match reacts within seconds
  // Match start is the heaviest moment for a slow machine: within the start grace a peer (the host above all) keeps its
  // role through a long stall; bots are still in the plane then, so nothing visible waits on it.
  const starting = myTag && state.match.time < TUNE.startGraceS;
  const staleAfter = myTag ? NET.staleMs : TUNE.lobbyStaleMs;
  const deadAfter = !myTag ? TUNE.lobbyDeadMs : starting ? Math.max(NET.hostStaleMs, TUNE.startGraceS * 1000) : NET.hostStaleMs;
  let others = 0, heard = 0;
  for (const [id, tr] of tracks) {
    if (isBotId(id)) continue;
    const silent = now - tr.heardAt;
    if (!tr.stale && silent > staleAfter) {
      tr.stale = true;
      session.setStale(id, true);
      if (myTag) session.helloNow();          // tell the others at once that we stopped hearing him (hello `hr`)
      // A player of our match that others still hear but that no route reaches from here (no common relay): say so,
      // rather than leaving a frozen figure unexplained. With a relay available this never shows.
      if (myTag && inMatch && !tr.dropped && !session.isOut(id) && session.heardByOthers(id) && now - (tr.unreachToastAt || -1e9) > 30000) {
        tr.unreachToastAt = now;
        const e = getPlayer(id);
        if (e && e.kind === 'remote' && e.alive) emit(EV.TOAST, { text: `Lost the connection to ${e.name}. Reconnecting.`, kind: 'warn', ms: 4000 });
      }
    }
    // Unresponsive after NET.hostStaleMs, or sooner once every other player of the match says he does not hear him
    // either (their hellos after the silence began leave him out): a crashed host hands the bots over in about 4 s.
    if (!tr.dead && (silent > deadAfter || (myTag && !starting && silent > NET.staleMs + 500 && session.silenceConfirmed(id, tr.heardAt)))) {
      tr.dead = true; session.setUnresponsive(id, true);
    }
    if (!inMatch || !myTag || tr.dropped || session.isOut(id)) continue;
    const e = getPlayer(id);
    if (!e || e.kind !== 'remote') continue;
    others++;
    if (silent <= NET.staleMs) heard++;
  }
  if (!inMatch || !myTag || state.app !== APP.MATCH || linkState === 'lost') return;
  if (others > 0 && heard === 0) {
    setLink('interrupted', 'silence');
    session.probeLink();                     // so "is it me or them?" has an answer by the time NET.dropMs is reached
  } else if (linkState === 'interrupted') setLink('ok', null);
  if (state.match.phase === 'ended' || state.match.time < TUNE.startGraceS) return;

  let link = null;
  for (const [id, tr] of tracks) {
    if (isBotId(id) || tr.dropped || session.isOut(id)) continue;
    const silent = now - tr.heardAt;
    if (silent <= NET.dropMs) continue;
    const e = getPlayer(id);
    if (!e || e.kind !== 'remote') continue;
    if (!link) link = session.linkHealth();
    const since = tr.heardAt + TUNE.evidenceMs;
    // The own-link probe is the deciding evidence: relays can be down (relay outage, relays blocked) while our
    // internet works, and the last player standing must not forfeit a won match for it. No relay socket and no
    // probe answer yet is undecided (probe again), not proof that we are the one cut off.
    const probeOk = link.probeOkAt > since && link.probeOkAt >= link.probeFailAt;
    const linkDead = !link.browserOnline || (link.probeFailAt > since && link.probeFailAt > link.probeOkAt);
    const evidence = heard > 0 || (!linkDead && (probeOk || (link.relaysOpen > 0 && link.lastRelayMsgAt > since)));
    if (!evidence && !linkDead) session.probeLink();
    if (heard > 0 && session.heardByOthers(id)) {
      // someone else still hears him: only our link to him broke (his traffic normally comes through that player as a
      // relay). Keep the ghost, renegotiate the connection.
      if (now - (tr.repairAt || 0) > TUNE.repairEveryMs) { tr.repairAt = now; session.repairConnection(id); counters.repairs++; }
      continue;
    }
    if (heard > 0 && !session.isHost() && silent <= NET.dropMs + TUNE.decideMaxMs) {
      // We still hear other players: dropping him is the match host's call ('left' death for everyone at once), so all
      // clients agree. Only if no decision ever comes do we decide on our own.
      continue;
    }
    if (evidence || silent > NET.dropMs + TUNE.decideMaxMs) {
      tr.dropped = true;
      if (session.isHost()) {
        const e2 = getPlayer(id);
        const t = Math.max(0, tr.heardAt - state.match.t0);
        session.declareDropped(id, { t, pos: e2 ? [round2(e2.pos.x), round2(e2.pos.y), round2(e2.pos.z)] : [0, 0, 0] });
      } else session.markDropped(id);
    } else if (linkDead && heard === 0) {
      setLink('lost', 'link');               // nobody heard and no relay either: we are the one cut off
      return;
    }
  }
}

function round2(v) { return Math.round(v * 100) / 100; }

/** Send loop + interpolation of all remote entities into state.players. No-op offline. */
export function update(dt) {
  if (!state.online) return;
  const now = performance.now();
  const me = getPlayer(state.selfId);
  const inMatch = matchRunning(me);

  // own pose history (hit validation), host bot history
  if (me && now - lastPoseAt >= 1000 / TUNE.poseHz) { lastPoseAt = now; ringPush(selfRing, now, me.pos.x, me.pos.y, me.pos.z); }
  if (inMatch && session.isHost() && now - lastBotPoseAt >= 1000 / TUNE.poseHz) {
    lastBotPoseAt = now;
    for (const e of state.players.values()) {
      if (e.kind !== 'bot') continue;
      let r = botRings.get(e.id);
      if (!r) { r = createRing(NET.historyMs / 1000, TUNE.poseHz); botRings.set(e.id, r); }
      ringPush(r, now, e.pos.x, e.pos.y, e.pos.z);
    }
  }

  tick(now);
  interpolate(now, dt, inMatch);
}

function sendSnapshots(now, me, inMatch) {
  const away = session.isAway();
  const rate = inMatch && state.app === APP.MATCH && !away ? NET.snapRate : NET.lobbySnapRate;
  if (rate !== lastSnapRate) { lastSnapRate = rate; nextSnapAt = 0; }
  const period = 1000 / rate;
  if (now >= nextSnapAt - period * TUNE.sendEarly) {
    nextSnapAt = nextSnapAt === 0 || now - nextSnapAt > period ? now + period : nextSnapAt + period;
    const s = snapScratch;
    s.seq = snapSeq = (snapSeq + 1) & 0xffff;
    s.t = now;
    s.tag = session.contextTag();
    if (me && inMatch && s.tag && !away) {
      s.weapon = me.weapon; s.x = me.pos.x; s.y = me.pos.y; s.z = me.pos.z; s.yaw = me.yaw; s.pitch = me.pitch;
      s.flags = me.flags; s.hp = me.hp; s.armor = me.armor; s.life = me.alive ? me.life : LIFE.DEAD;
    } else {
      s.weapon = null; s.x = 0; s.y = 0; s.z = 0; s.yaw = 0; s.pitch = 0; s.flags = 0; s.hp = 100; s.armor = 0; s.life = LIFE.SPECTATE;
      s.tag = session.advertisedTag();
    }
    if (session.sendBinary(encodePlayerSnap(s)) > 0) counters.psnapOut++;
  }
  const bp = 1000 / NET.botRate;
  if (inMatch && state.app === APP.MATCH && !away && session.isHost() && session.contextTag() && now >= nextBotAt - bp * TUNE.sendEarly) {
    nextBotAt = nextBotAt === 0 || now - nextBotAt > bp ? now + bp : nextBotAt + bp;
    let n = 0;
    for (const e of state.players.values()) {
      if (e.kind !== 'bot') continue;
      let o = botScratch[n];
      if (!o) o = botScratch[n] = { slot: 0, weapon: null, flags: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 0, armor: 0, life: 0 };
      o.slot = e.slot; o.weapon = e.weapon; o.flags = e.flags; o.x = e.pos.x; o.y = e.pos.y; o.z = e.pos.z;
      o.yaw = e.yaw; o.pitch = e.pitch; o.hp = e.hp; o.armor = e.armor; o.life = e.alive ? e.life : LIFE.DEAD;
      n++;
    }
    if (n > 0) {
      botScratch.length = Math.max(botScratch.length, n);
      const list = n === botScratch.length ? botScratch : botScratch.slice(0, n);
      botSeq = (botSeq + 1) & 0xffff;
      if (session.sendBinary(encodeBotBatch(now, botSeq, list, session.contextTag()), null, CTX_ONLY) > 0) counters.botsOut++;
    }
  }
}

let lastInterpAt = 0;
function interpolate(now, dt, inMatch) {
  // real time since the last pass (the frame dt is clamped to 50 ms; the catch-up test needs the true elapsed time)
  const rdt = lastInterpAt ? Math.min(1, Math.max(0, (now - lastInterpAt) / 1000)) : dt;
  lastInterpAt = now;
  const host = session.hostId();
  const hostTrack = host ? tracks.get(host) : null;
  for (const [id, tr] of tracks) {
    const bot = isBotId(id);
    if (bot) tr.stale = !!(hostTrack && hostTrack.stale);   // bots inherit their host's liveness

    const target = targetDelay(tr);
    tr.delay = tr.recv < 3 ? target : damp(tr.delay, target, TUNE.delayLambda, dt);

    const e = getPlayer(id);
    if (!e) continue;
    if (bot ? (e.kind !== 'bot' || session.isHost()) : e.kind !== 'remote') continue;
    tr.renderT = now - tr.delay;
    if (!sampleTrack(tr, tr.renderT, tmp)) continue;
    smoothJump(tr, tmp, rdt);
    const src = tmp.src, newest = tr.newest;
    e.pos.set(tmp.x, tmp.y, tmp.z);
    e.vel.set(tmp.vx, tmp.vy, tmp.vz);
    e.yaw = tmp.yaw;
    e.pitch = tmp.pitch;
    actionCues(e, src.flags, src.weapon, now);
    e.flags = src.flags;
    e.weapon = src.weapon;
    e.hp = newest.hp;
    e.armor = newest.armor;
    const dead = killed.has(id) || tr.killed;
    e.life = dead ? (e.life === LIFE.SPECTATE ? LIFE.SPECTATE : LIFE.DEAD) : src.life;   // SPECTATE: left from the air, no body
    e.alive = !dead && newest.life !== LIFE.DEAD && newest.life !== LIFE.SPECTATE;
    tr.speed = damp(tr.speed, Math.hypot(tmp.vx, tmp.vz), TUNE.speedLambda, dt);
    e.speed = tr.speed;
    e.stale = tr.stale;
    e.lastSeen = tr.lastRecv;
  }
}

/**
 * Catch-up instead of a snap. After a starved stretch (a burst of lost snapshots, a Wi-Fi roam) an entity holds still
 * past its newest sample; when samples resume, the interpolated pose is suddenly metres further on. Any sampled pose
 * that departs from its own motion by more than TUNE.catchupJump becomes a render offset (the entity stays where it
 * was drawn) that decays with TUNE.catchupTau, at most TUNE.catchupMaxSpeed, so it runs to its true place in a few
 * tenths of a second instead of jumping in one frame. Real teleports (TUNE.teleportDist) still snap. Writes the rendered position back into out.
 */
function smoothJump(tr, out, dt) {
  const x = out.x, y = out.y, z = out.z;
  if (tr.has) {
    const dx = x - tr.px, dy = y - tr.py, dz = z - tr.pz;
    if (dx * dx + dy * dy + dz * dz > TUNE.teleportDist * TUNE.teleportDist) { tr.ex = 0; tr.ey = 0; tr.ez = 0; }
    else {
      const devx = dx - out.vx * dt, devy = dy - out.vy * dt, devz = dz - out.vz * dt;
      if (devx * devx + devy * devy + devz * devz > TUNE.catchupJump * TUNE.catchupJump) { tr.ex -= devx; tr.ey -= devy; tr.ez -= devz; }
      const e = Math.hypot(tr.ex, tr.ey, tr.ez);
      if (e > 0) {
        const close = Math.min(e * (1 - Math.exp(-dt / TUNE.catchupTau)), TUNE.catchupMaxSpeed * dt);
        const k = e - close > 1e-3 ? (e - close) / e : 0;
        tr.ex *= k; tr.ey *= k; tr.ez *= k;
      }
    }
  }
  tr.has = true;
  tr.px = x; tr.py = y; tr.pz = z;
  out.x = x + tr.ex; out.y = y + tr.ey; out.z = z + tr.ez;
}

/**
 * Remote players (and bots on non-hosts) only arrive as flags and a weapon id, so their reload, weapon switch and plate
 * are re-created here as the same events the local weapons emit (engine/audio plays them at the entity): RELOAD rising
 * starts a reload whose magout/magin cues follow the weapon's timing (charge too when the flag outlasts a normal
 * reload, i.e. an empty one), PLATE rising is PLATE_START, a weapon change while alive is WEAPON_SWITCH.
 */
function actionCues(e, flags, weapon, now) {
  let c = cueState.get(e.id);
  if (!c) { c = { flags, weapon, reloadAt: 0, fired: {}, rw: null }; cueState.set(e.id, c); return; }
  const live = e.alive && e.life === LIFE.GROUND;
  const rose = (f) => (flags & f) !== 0 && (c.flags & f) === 0;
  if (live && rose(FLAG.RELOAD) && WEAPONS[weapon]) {
    c.reloadAt = now; c.fired = {}; c.rw = weapon;
    emit(EV.WEAPON_RELOAD, { id: e.id, weapon, phase: 'start', empty: false });
  }
  if (c.reloadAt) {
    const W = WEAPONS[c.rw];
    if (!(flags & FLAG.RELOAD) || !W || !live || weapon !== c.rw) c.reloadAt = 0;
    else {
      const t = (now - c.reloadAt) / 1000, cues = W.reloadCues || {};
      const empty = t > W.reload * 0.97;
      for (const k of ['magout', 'magin', 'charge']) {
        if (c.fired[k] || cues[k] == null) continue;
        if (k === 'charge' ? !(empty && t >= W.reloadEmpty * cues.charge) : t < W.reload * cues[k]) continue;
        c.fired[k] = true;
        emit(EV.WEAPON_RELOAD, { id: e.id, weapon: c.rw, phase: k, empty });
      }
    }
  }
  if (live && rose(FLAG.PLATE)) emit(EV.PLATE_START, { id: e.id });
  if (live && weapon && c.weapon && weapon !== c.weapon) emit(EV.WEAPON_SWITCH, { id: e.id, weapon });
  c.flags = flags;
  c.weapon = weapon;
}

// ------------------------------------------------------------------------------------------------ public API
/** Broadcast a SHOT for a local or (host) bot shot. shot: {weapon, origin, dir, dist, surface, hitFlags, botSlot}. */
export function sendShot(shot) {
  if (!state.online || !shot) return false;
  shotSeq = (shotSeq + 1) & 0xffff;
  const buf = encodeShot({
    weapon: shot.weapon, seq: shotSeq, t: performance.now(),
    origin: shot.origin, dir: shot.dir, dist: shot.dist ?? 0, surface: shot.surface ?? null,
    hitFlags: shot.hitFlags | 0, botSlot: shot.botSlot ?? null, tag: session.contextTag(),
  });
  const n = session.sendBinary(buf, null, CTX_ONLY);
  if (n > 0) counters.shotsOut++;
  return n > 0;
}

/**
 * Estimated (remote clock - local clock) mapping for a peer in ms: local = remote + offset. It is the snapshot offset
 * (best-case one-way delay included) minus half the lowest measured RTT, so it approximates the true clock skew.
 * Returns null while no snapshot from that peer has arrived (callers use their rtt fallback).
 */
export function clockOffset(peerId) {
  const off = offsets.get(peerId);
  if (off == null) return null;
  return off - session.rttMin(peerId) / 2;
}

/** True once a peer's clock offset is known. */
export function hasClock(peerId) { return offsets.has(peerId); }

/** Convert a peer's performance.now() timestamp to local performance.now() ms (unknown peers: unchanged). */
export function toLocalTime(peerId, tRemote) {
  const off = clockOffset(peerId);
  return off == null ? tRemote : tRemote + off;
}

/** Own position at local time tMs from the NET.historyMs ring buffer: {x, y, z} or null. */
export function selfPoseAt(tMs) { return ringAt(selfRing, tMs); }

/** Host only: a bot's position at local time tMs ({x, y, z} or null). */
export function botPoseAt(id, tMs) {
  const r = botRings.get(id);
  return r ? ringAt(r, tMs) : null;
}

/** Current interpolation delay in ms (the largest among live human peers; NET.interpDelay with nobody connected). */
export function interpDelay() {
  let d = 0;
  for (const [id, tr] of tracks) if (!isBotId(id) && !tr.stale && tr.recv > 0) d = Math.max(d, tr.delay);
  return d || NET.interpDelay;
}

/** Per-source statistics for diagnostics and the dev harness. */
export function stats() {
  const now = performance.now();
  const list = [];
  for (const [id, tr] of tracks) {
    list.push({
      id, bot: isBotId(id), recv: tr.recv, lost: tr.lost, ooo: tr.ooo, late: tr.late, interval: Math.round(tr.interval * 10) / 10,
      jitter: Math.round(tr.jitter * 10) / 10, delay: Math.round(tr.delay), silentMs: Math.round(now - tr.heardAt),
      stale: tr.stale, unresponsive: tr.dead, dropped: tr.dropped, starved: tr.starved, buffered: tr.buf.length,
      offset: offsets.has(id) ? Math.round(clockOffset(id) * 10) / 10 : null,
    });
  }
  return { ...counters, link: linkState, interpDelay: Math.round(interpDelay()), tracks: list };
}

/** The raw buffered samples of an entity (harness drawing): [{x, y, z, lt}] newest last. */
export function samples(id) { return tracks.get(id)?.buf || []; }

/** Peers this client heard within NET.staleMs (sent in 'hello', so others can tell a broken link from a leaver). */
export function heardPeers() {
  const now = performance.now();
  const out = [];
  for (const [id, tr] of tracks) if (!isBotId(id) && !tr.dropped && now - tr.heardAt <= NET.staleMs) out.push(id);
  return out.slice(0, 16);
}

/** performance.now() of the last snapshot heard from a peer (own stalls excluded), or null for an unknown peer. */
export function lastHeardAt(peerId) { const tr = tracks.get(peerId); return tr ? tr.heardAt : null; }

/** Our own connection state during a match: 'ok' | 'interrupted' | 'lost' (also announced as NET_LINK). */
export function link() { return linkState; }

/** Pure helpers for self-tests. */
export const testing = { createTrack, pushSample, sampleTrack, targetDelay, updateOffset, createOffsetEst, offsetSample, createRing, ringPush, ringAt };

debug.net = Object.assign(debug.net || {}, { sync: { stats, TUNE, samples, interpDelay } });
