// ZONEFALL dev harness stand-in for src/net/session.js (COMBAT group). Not shipped in the game.
// Offline by default; setOnline(true) lets the harness check the reliable payloads combat sends ('hit', 'death',
// 'nade') against net/protocol validators without a network.
import { validate } from '../../../src/net/protocol.js';
import { state } from '../../../src/core/state.js';
export const sent = [];
export function setOnline(on) { state.online = !!on; }
export async function connect() { return false; }
export function leave() { state.online = false; }
export function online() { return state.online; }
export function selfId() { return state.selfId; }
export function peers() { return []; }
export function hostId() { return state.selfId; }
export function isHost() { return true; }
export function epoch() { return 0; }
export function send(action, data, target = null) {
  const v = validate[action] ? validate[action](JSON.parse(JSON.stringify(data))) : null;
  sent.push({ action, data, target, valid: !!v });
  if (sent.length > 200) sent.shift();
}
export function sendBinary() {}
export function setBinaryHandler() {}
export function setStale() {}
export async function ping() { return 0; }
export function rtt() { return 0; }
export function diagnostics() { return { relaysOpen: 0, peers: [] }; }
