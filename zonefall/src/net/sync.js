// ZONEFALL - snapshot send loop, clock mapping, interpolation, pose history. OWNER: NET. Contract: ARCHITECTURE.md 5.5 and 8.
// STUB. Send: local PSNAP at NET.snapRate in a match (NET.lobbySnapRate in the lobby, life = SPECTATE, for liveness and
// clock offsets); host also sends a BOTS batch at NET.botRate. Receive: offset = min(recvTime - tSender) with +0.02 ms
// per sample upward drift; discard older seq; buffer 30. Interpolate each remote entity at now - interpDelay
// (adaptive clamp(2*interval + 2*jitter, interpMin, interpMax)); extrapolate <= 100 ms then hold; stale after
// NET.staleMs (session.setStale), removed from the match roster view after NET.dropMs. Writes remote entities'
// pos/yaw/pitch/flags/hp/armor/life/weapon/speed and, for bots on non-hosts, the same from BOTS batches.
// Only roster members are applied during a match. SHOT messages -> emit NET_SHOT {from, shooterId, shot}.
import { notImplemented } from '../core/util.js';

/** Register as session's binary handler. */
export function init() { notImplemented('net/sync.init'); }

/** Send loop + interpolation of all remote entities into state.players. No-op offline. */
export function update(dt) { notImplemented('net/sync.update'); }

/** Broadcast a SHOT for a local or (host) bot shot. shot: {weapon, origin, dir, dist, surface, hitFlags, botSlot}. */
export function sendShot(shot) { notImplemented('net/sync.sendShot'); }

/** Estimated (remote clock - local clock) mapping for a peer in ms: local = remote + offset. */
export function clockOffset(peerId) { notImplemented('net/sync.clockOffset'); }

/** Convert a peer's performance.now() timestamp to local performance.now() ms. */
export function toLocalTime(peerId, tRemote) { notImplemented('net/sync.toLocalTime'); }

/** Own position at local time tMs from the NET.historyMs ring buffer: {x, y, z} or null. */
export function selfPoseAt(tMs) { notImplemented('net/sync.selfPoseAt'); }

/** Host only: a bot's position at local time tMs ({x, y, z} or null). */
export function botPoseAt(botId, tMs) { notImplemented('net/sync.botPoseAt'); }

/** Current interpolation delay in ms. */
export function interpDelay() { notImplemented('net/sync.interpDelay'); }
