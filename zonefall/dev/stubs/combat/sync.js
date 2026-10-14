// ZONEFALL dev harness stand-in for src/net/sync.js (COMBAT group). Not shipped in the game.
// Keeps the local player's and the bots' pose history (1 s) so combat/damage.validateHit can be exercised, and
// records SHOT messages (encoded with net/protocol to prove they fit the 44-byte layout).
import { encodeShot, decodeShot } from '../../../src/net/protocol.js';
import { state, localPlayer } from '../../../src/core/state.js';
export const shots = [];
const hist = new Map();          // id -> [{t, x, y, z}]
export function init() {}
export function update() {
  const now = performance.now();
  for (const e of state.players.values()) {
    let h = hist.get(e.id);
    if (!h) { h = []; hist.set(e.id, h); }
    h.push({ t: now, x: e.pos.x, y: e.pos.y, z: e.pos.z });
    while (h.length && now - h[0].t > 1000) h.shift();
  }
}
export function sendShot(shot) {
  const buf = encodeShot({ ...shot, seq: shots.length & 0xffff, t: performance.now() });
  shots.push(decodeShot(buf));
  if (shots.length > 100) shots.shift();
}
export function clockOffset() { return 0; }
export function toLocalTime(peerId, t) { return t; }
function at(id, tMs) {
  const h = hist.get(id);
  if (!h || !h.length) return null;
  let best = h[0];
  for (const p of h) if (Math.abs(p.t - tMs) < Math.abs(best.t - tMs)) best = p;
  return { x: best.x, y: best.y, z: best.z };
}
export function selfPoseAt(tMs) { const me = localPlayer(); return me ? at(me.id, tMs) : null; }
export function botPoseAt(botId, tMs) { return at(botId, tMs); }
export function interpDelay() { return 100; }
