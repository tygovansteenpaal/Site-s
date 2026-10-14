// ZONEFALL - matchmaking and pre-match lobby. OWNER: NET. Contract: ARCHITECTURE.md 5.5 and 8.7.
// STUB. Quick play: rooms `${NET.quickPrefix}-${region}-${n}` (region from the time zone: eu|na|sa|as|oc|af),
// n = 1..NET.buckets; wait NET.bucketProbeMs for 'hello' replies; hop to n+1 if any peer reports st:'live' or
// >= MATCH.maxHumans humans. Private: code of NET.codeLength chars from NET.codeAlphabet, room
// `${NET.privatePrefix}-${code}`, password = code. Every peer sends 'hello' on join and every 2 s.
// Host runs the countdown (MATCH.lobbyCountdown once >= minHumansToCountdown humans, MATCH.lobbyCountdownFull at >= 6,
// quick play alone: start vs bots after MATCH.aloneStartAfter) and broadcasts 'lobby' {ep, cd, ro, mode} every second.
// At zero the host calls game/match.hostBegin(humans). Non-hosts mirror the countdown from 'lobby'.
import { notImplemented } from '../core/util.js';

export function init() { notImplemented('net/lobby.init'); }

/** Find or open a public lobby. Resolves when joined (state.app should already be 'lobby'). */
export async function quickPlay() { notImplemented('net/lobby.quickPlay'); }

/** Open a private lobby; resolves to its code. */
export async function createPrivate() { notImplemented('net/lobby.createPrivate'); }

/** Join a private lobby by code (case-insensitive, validated against NET.codeAlphabet). */
export async function joinPrivate(code) { notImplemented('net/lobby.joinPrivate'); }

/** Leave the lobby and the room. */
export function leave() { notImplemented('net/lobby.leave'); }

/** Host only: start now (empty slots filled with bots). Non-hosts: no-op returning false. */
export function requestStart() { notImplemented('net/lobby.requestStart'); }

/** Countdown, heartbeats, LOBBY_UPDATE emission. */
export function update(dt) { notImplemented('net/lobby.update'); }

/**
 * @returns {{mode:'quick'|'private', code:string|null, roomId:string|null, status:'connecting'|'waiting'|'countdown'|'starting'|'error',
 *   text:string, hostId:string|null, isHost:boolean, roster:Array<{id:string, name:string, self:boolean, host:boolean}>,
 *   countdownEndsAt:number|null}}  countdownEndsAt in local performance.now() ms
 */
export function get() { notImplemented('net/lobby.get'); }
