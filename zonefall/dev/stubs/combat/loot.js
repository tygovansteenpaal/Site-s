// ZONEFALL dev harness stand-in for src/game/loot.js (COMBAT group). Not shipped in the game.
// Records death drops so the harness can show what combat/damage.kill handed to loot.drop.
export const drops = [];
let listener = null;
export function onDrop(fn) { listener = fn; }
export function init() {}
export function setup() {}
export function update() {}
export function interact() { return null; }
export function pickup() { return false; }
export function drop(items, pos, ownerId) {
  const rec = { items: items.map((i) => ({ ...i })), pos: pos.slice(), owner: ownerId, t: performance.now() };
  drops.push(rec);
  if (drops.length > 20) drops.shift();
  if (listener) listener(rec);
  return rec.items;
}
export function nearest() { return null; }
export function all() { return []; }
export function clear() { drops.length = 0; }
