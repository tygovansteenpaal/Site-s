// ZONEFALL - snapshot send loop, clock mapping, interpolation, pose history. OWNER: NET. Contract: ARCHITECTURE.md 5.5 and 8.
// Send: the local PSNAP at NET.snapRate in a match (NET.lobbySnapRate otherwise, life = SPECTATE, for liveness and clock
// offsets); the host also sends one BOTS batch at NET.botRate. Receive: per-peer clock offset = min(recv - tSender) with a
// slow upward drift, out-of-order samples dropped with seqNewer, a 30-sample buffer per entity. Every remote entity is
// rendered at now - delay, where delay = clamp(2 x interval + 2 x jitter, interpMin, interpMax) is measured per source
// and eased so it never jumps; past the newest sample it extrapolates at most TUNE.extrapolateMs, then holds.
// Liveness: stale after NET.staleMs (session.setStale), and during a match dropped after NET.dropMs (session.markDropped).
import { NET } from '../config.js';
import { on, emit, EV } from '../core/bus.js';
import { state, debug, APP, LIFE, botId, isBotId, getPlayer } from '../core/state.js';
import { clamp, damp, wrapAngle } from '../core/util.js';
import {
  MSG, encodePlayerSnap, decodePlayerSnap, encodeBotBatch, decodeBotBatch, encodeShot, decodeShot, msgType, seqNewer,
} from './protocol.js';
import * as session from './session.js';

export const TUNE = {
  bufferSize: 30,
  extrapolateMs: 100,
  offsetDrift: 0.02,       // ms added to a peer's clock offset per sample, so the min estimate follows clock drift
  teleportDist: 40,        // m between consecutive samples: snap instead of sliding across the map
  intervalAlpha: 0.1,      // EMA weight for arrival interval and jitter
  delayLambda: 1.5,        // 1/s easing of the interpolation delay toward its target
  poseHz: 60,              // own (and host bot) pose history sample rate
  speedLambda: 10,         // 1/s smoothing of the reported speed of remote entities
};

// ------------------------------------------------------------------------------------------------ tracks
/** A per-entity snapshot buffer with arrival statistics. Exported through `testing` for the harness self-tests. */
export function createTrack(id) {
  return {
    id, buf: [], newest: null, lastRecv: 0, interval: 0, jitter: 0, delay: NET.interpDelay, recv: 0, lost: 0, ooo: 0,
    stale: false, dropped: false, killed: false, sx: 0, sy: 0, sz: 0, speed: 0, starved: false,
  };
}

/** Push a decoded sample (needs .seq, .t, and .lt = local time) into a track. Returns false if it was out of date. */
export function pushSample(tr, s, now) {
  const last = tr.newest;
  if (last) {
    if (!seqNewer(s.seq, last.seq)) { tr.ooo++; return false; }
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

/** Clock offset estimator (exported for tests): offset = min(recv - tSender), drifting up TUNE.offsetDrift per sample. */
export function updateOffset(prev, recvMs, senderMs) {
  const o = recvMs - senderMs;
  return prev == null ? o : Math.min(prev + TUNE.offsetDrift, o);
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
const offsets = new Map();     // peer id -> clock offset (min recv - send), ms
const killed = new Set();      // entity ids that died this match (snapshots never revive them)
const selfRing = createRing(NET.historyMs / 1000, TUNE.poseHz);
const botRings = new Map();    // bot id -> ring (host only)
let snapSeq = 0, botSeq = 0, shotSeq = 0;
let nextSnapAt = 0, nextBotAt = 0, lastPoseAt = 0, lastBotPoseAt = 0;
let lastSnapRate = 0;
let inited = false;
const tmp = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, src: null };
const counters = { psnapIn: 0, botsIn: 0, shotsIn: 0, psnapOut: 0, botsOut: 0, shotsOut: 0, rejected: 0 };
const snapScratch = { weapon: null, seq: 0, t: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0, hp: 0, armor: 0, life: 0 };
const botScratch = [];

function trackFor(id) {
  let tr = tracks.get(id);
  if (!tr) { tr = createTrack(id); tr.lastRecv = performance.now(); tracks.set(id, tr); }
  return tr;
}

// ------------------------------------------------------------------------------------------------ init
/** Register as session's binary handler. */
export function init() {
  if (inited) return;
  inited = true;
  session.setBinaryHandler(onBinary);
  on(EV.PEER_JOIN, ({ id }) => { const tr = trackFor(id); tr.lastRecv = performance.now(); tr.stale = false; tr.dropped = false; });
  on(EV.PEER_LEAVE, ({ id, reason }) => {
    if (reason === 'timeout') return;          // keep its last pose as a ghost; the entity is dead for this match
    tracks.delete(id);
    offsets.delete(id);
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
    for (const id of [...tracks.keys()]) if (isBotId(id)) tracks.delete(id);
    for (const tr of tracks.values()) { tr.killed = false; tr.dropped = false; }
    nextSnapAt = 0; nextBotAt = 0;
  });
  on(EV.PLAYER_KILLED, ({ id }) => { killed.add(id); const tr = tracks.get(id); if (tr) tr.killed = true; });
  on(EV.APP_STATE, ({ to }) => { if (to === APP.MENU || to === APP.LOBBY) { killed.clear(); botRings.clear(); } });
}

// ------------------------------------------------------------------------------------------------ receive
function onBinary(from, buf) {
  const type = msgType(buf);
  const now = performance.now();
  if (type === MSG.PSNAP) {
    const s = decodePlayerSnap(buf);
    if (!s) { counters.rejected++; return; }
    counters.psnapIn++;
    const off = updateOffset(offsets.get(from), now, s.t);
    offsets.set(from, off);
    s.lt = s.t + off;
    const tr = trackFor(from);
    pushSample(tr, s, now);
    if (tr.stale) { tr.stale = false; session.setStale(from, false); }
  } else if (type === MSG.BOTS) {
    if (from !== session.hostId() || session.isHost()) { counters.rejected++; return; }
    const b = decodeBotBatch(buf);
    if (!b) { counters.rejected++; return; }
    counters.botsIn++;
    const off = updateOffset(offsets.get(from), now, b.t);
    offsets.set(from, off);
    for (const e of b.bots) {
      e.seq = b.seq; e.t = b.t; e.lt = b.t + off;
      pushSample(trackFor(botId(e.slot)), e, now);
    }
  } else if (type === MSG.SHOT) {
    const s = decodeShot(buf);
    if (!s) { counters.rejected++; return; }
    let shooterId = from;
    if (s.botSlot != null) {
      if (from !== session.hostId()) { counters.rejected++; return; }
      shooterId = botId(s.botSlot);
    }
    counters.shotsIn++;
    emit(EV.NET_SHOT, { from, shooterId, shot: s });
  } else counters.rejected++;
}

// ------------------------------------------------------------------------------------------------ update
/** Send loop + interpolation of all remote entities into state.players. No-op offline. */
export function update(dt) {
  if (!state.online) return;
  const now = performance.now();
  const me = getPlayer(state.selfId);
  const inMatch = (state.app === APP.MATCH || state.app === APP.RESULTS) && state.match.phase !== 'idle' && !!me;

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

  sendSnapshots(now, me, inMatch);
  interpolate(now, dt, inMatch);
}

function sendSnapshots(now, me, inMatch) {
  const rate = inMatch && state.app === APP.MATCH ? NET.snapRate : NET.lobbySnapRate;
  if (rate !== lastSnapRate) { lastSnapRate = rate; nextSnapAt = 0; }
  const period = 1000 / rate;
  if (now >= nextSnapAt) {
    nextSnapAt = nextSnapAt === 0 || now - nextSnapAt > period ? now + period : nextSnapAt + period;
    const s = snapScratch;
    s.seq = snapSeq = (snapSeq + 1) & 0xffff;
    s.t = now;
    if (me && inMatch) {
      s.weapon = me.weapon; s.x = me.pos.x; s.y = me.pos.y; s.z = me.pos.z; s.yaw = me.yaw; s.pitch = me.pitch;
      s.flags = me.flags; s.hp = me.hp; s.armor = me.armor; s.life = me.alive ? me.life : LIFE.DEAD;
    } else {
      s.weapon = null; s.x = 0; s.y = 0; s.z = 0; s.yaw = 0; s.pitch = 0; s.flags = 0; s.hp = 100; s.armor = 0; s.life = LIFE.SPECTATE;
    }
    if (session.sendBinary(encodePlayerSnap(s)) > 0) counters.psnapOut++;
  }
  if (inMatch && state.app === APP.MATCH && session.isHost() && now >= nextBotAt) {
    const bp = 1000 / NET.botRate;
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
      if (session.sendBinary(encodeBotBatch(now, botSeq, list)) > 0) counters.botsOut++;
    }
  }
}

function interpolate(now, dt, inMatch) {
  const host = session.hostId();
  const hostTrack = host ? tracks.get(host) : null;
  for (const [id, tr] of tracks) {
    const bot = isBotId(id);
    // liveness (humans only; bots inherit their host's)
    if (!bot) {
      const silent = now - tr.lastRecv;
      if (!tr.stale && silent > NET.staleMs) { tr.stale = true; session.setStale(id, true); }
      if (inMatch && !tr.dropped && silent > NET.dropMs && getPlayer(id)) { tr.dropped = true; session.markDropped(id); }
    } else tr.stale = !!(hostTrack && hostTrack.stale);

    const target = targetDelay(tr);
    tr.delay = tr.recv < 3 ? target : damp(tr.delay, target, TUNE.delayLambda, dt);

    const e = getPlayer(id);
    if (!e) continue;
    if (bot ? (e.kind !== 'bot' || session.isHost()) : e.kind !== 'remote') continue;
    if (!sampleTrack(tr, now - tr.delay, tmp)) continue;
    const src = tmp.src, newest = tr.newest;
    e.pos.set(tmp.x, tmp.y, tmp.z);
    e.vel.set(tmp.vx, tmp.vy, tmp.vz);
    e.yaw = tmp.yaw;
    e.pitch = tmp.pitch;
    e.flags = src.flags;
    e.weapon = src.weapon;
    e.hp = newest.hp;
    e.armor = newest.armor;
    const dead = killed.has(id) || tr.killed;
    e.life = dead ? LIFE.DEAD : src.life;
    e.alive = !dead && newest.life !== LIFE.DEAD && newest.life !== LIFE.SPECTATE;
    tr.speed = damp(tr.speed, Math.hypot(tmp.vx, tmp.vz), TUNE.speedLambda, dt);
    e.speed = tr.speed;
    e.stale = tr.stale;
    e.lastSeen = tr.lastRecv;
  }
}

// ------------------------------------------------------------------------------------------------ public API
/** Broadcast a SHOT for a local or (host) bot shot. shot: {weapon, origin, dir, dist, surface, hitFlags, botSlot}. */
export function sendShot(shot) {
  if (!state.online || !shot) return false;
  shotSeq = (shotSeq + 1) & 0xffff;
  const buf = encodeShot({
    weapon: shot.weapon, seq: shotSeq, t: performance.now(),
    origin: shot.origin, dir: shot.dir, dist: shot.dist ?? 0, surface: shot.surface ?? null,
    hitFlags: shot.hitFlags | 0, botSlot: shot.botSlot ?? null,
  });
  const n = session.sendBinary(buf);
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
      id, bot: isBotId(id), recv: tr.recv, lost: tr.lost, ooo: tr.ooo, interval: Math.round(tr.interval * 10) / 10,
      jitter: Math.round(tr.jitter * 10) / 10, delay: Math.round(tr.delay), silentMs: Math.round(now - tr.lastRecv),
      stale: tr.stale, starved: tr.starved, buffered: tr.buf.length,
      offset: offsets.has(id) ? Math.round(clockOffset(id) * 10) / 10 : null,
    });
  }
  return { ...counters, interpDelay: Math.round(interpDelay()), tracks: list };
}

/** The raw buffered samples of an entity (harness drawing): [{x, y, z, lt}] newest last. */
export function samples(id) { return tracks.get(id)?.buf || []; }

/** Pure helpers for self-tests. */
export const testing = { createTrack, pushSample, sampleTrack, targetDelay, updateOffset, createRing, ringPush, ringAt };

debug.net = Object.assign(debug.net || {}, { sync: { stats, TUNE, samples, interpDelay } });
