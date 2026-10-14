// ZONEFALL - Trystero (Nostr) room, peers, host election, channels. OWNER: NET. Contract: ARCHITECTURE.md 5.5 and 8.
// STUB. Import Trystero lazily inside connect(): `const { joinRoom, selfId } = await import('trystero')` so practice
// mode works when the CDN or relays are unreachable. joinRoom({appId: NET.appId, relayConfig: {urls: NET.relays},
// password, turnConfig: NET.turn (if any)}, roomId, {onJoinError (debounced), onPeerHandshake (exchange
// {v: PROTOCOL_VERSION}, throw on mismatch)}). On connect: state.selfId = selfId (Trystero), state.online = true.
// Reliable: one Trystero action per protocol.ACTIONS entry; incoming payloads go through protocol.validate[action]
// then emit the matching NET_* event {from, data}. Unreliable: per peer pc.createDataChannel('snap', {negotiated:true,
// id: NET.channelId, ordered:false, maxRetransmits:0}); until open, binary goes through the 'bin' action. Drop sends
// when bufferedAmount > NET.bufferedLimit. Host = lowest id among self + non-stale peers; on change bump epoch,
// emit HOST_CHANGED and (if self) send 'host'. Rate-limit peers (> NET.maxMsgsPerSec -> ignore for 1 s).
// pagehide -> room.leave().
import { notImplemented } from '../core/util.js';

/**
 * Join a room. Resolves once at least one relay socket is open; rejects after NET.relayTimeoutMs otherwise.
 * @param {{roomId:string, password?:string|null}} opts
 */
export async function connect(opts) { notImplemented('net/session.connect'); }

/** Leave the room (graceful: peers notified in ~0.2 s). state.online = false, isHost = true. */
export function leave() { notImplemented('net/session.leave'); }

export function online() { notImplemented('net/session.online'); }
export function selfId() { notImplemented('net/session.selfId'); }
/** Connected, non-stale peer ids. */
export function peers() { notImplemented('net/session.peers'); }
export function hostId() { notImplemented('net/session.hostId'); }
export function isHost() { notImplemented('net/session.isHost'); }
export function epoch() { notImplemented('net/session.epoch'); }

/** Reliable send of a protocol action payload to everyone or one peer. */
export function send(action, data, target = null) { notImplemented('net/session.send'); }

/** Unreliable send of a binary message (ArrayBuffer) to everyone or one peer (reliable 'bin' fallback until open). */
export function sendBinary(buf, target = null) { notImplemented('net/session.sendBinary'); }

/** Register the single binary consumer (net/sync): fn(fromPeerId, arrayBuffer). */
export function setBinaryHandler(fn) { notImplemented('net/session.setBinaryHandler'); }

/** Mark a peer stale/fresh (net/sync calls this from snapshot liveness); stale peers are ignored for host election. */
export function setStale(peerId, stale) { notImplemented('net/session.setStale'); }

/** Round trip in ms (Trystero room.ping). */
export async function ping(peerId) { notImplemented('net/session.ping'); }

/** Last measured RTT in ms (0 if unknown). */
export function rtt(peerId) { notImplemented('net/session.rtt'); }

/** {relaysOpen:number, peers: [{id, rtt, channel:'unreliable'|'fallback', pair:'host'|'srflx'|'relay'|'?'}]} */
export function diagnostics() { notImplemented('net/session.diagnostics'); }
