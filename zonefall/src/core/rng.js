// ZONEFALL - deterministic random numbers. OWNER: LEAD. Complete.
// Every peer must derive identical loot, zone circles, plane path and bot rosters from the same seed,
// so all seeded randomness goes through Rng, never Math.random.

/** 32-bit FNV-1a hash of a string. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mix two uint32 values into one (for sub-seeds). */
export function mixSeed(a, b) {
  let h = (a ^ Math.imul(b + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A fresh random uint32 seed (host / practice only). */
export function randomSeed() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] >>> 0;
}

export class Rng {
  /** @param {number} seed uint32 */
  constructor(seed) { this.s = (seed >>> 0) || 0x6d2b79f5; }

  /** Float in [0, 1). mulberry32. */
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Float in [a, b). */
  range(a, b) { return a + (b - a) * this.next(); }
  /** Integer in [a, b] inclusive. */
  int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
  chance(p) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  /** Standard normal (Box-Muller). */
  normal() {
    const u = 1 - this.next(), v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** entries: [[value, weight], ...] or {value: weight}. Returns a value; null if all weights are 0. */
  weighted(entries) {
    const list = Array.isArray(entries) ? entries : Object.entries(entries);
    let total = 0;
    for (const [, w] of list) total += Math.max(0, w);
    if (total <= 0) return null;
    let r = this.next() * total;
    for (const [v, w] of list) { r -= Math.max(0, w); if (r < 0) return v; }
    return list[list.length - 1][0];
  }
  /** In-place Fisher-Yates shuffle; returns arr. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  /** Point uniformly inside a disc of radius r around (cx, cz): returns [x, z]. */
  inDisc(cx, cz, r) {
    const a = this.next() * Math.PI * 2, d = Math.sqrt(this.next()) * r;
    return [cx + Math.cos(a) * d, cz + Math.sin(a) * d];
  }
  /** Independent child stream; the same label always yields the same child for the same parent seed. */
  fork(label) { return new Rng(mixSeed(this.s, hashString(String(label)))); }
}

/** Shorthand: new Rng(mixSeed(seed, hashString(label))). Use one labelled stream per system (e.g. 'loot', 'zone', 'plane'). */
export const stream = (seed, label) => new Rng(mixSeed(seed >>> 0, hashString(label)));
