// ZONEFALL - deterministic noise for world generation. OWNER: WORLD (internal).
// 2D simplex noise with a permutation table shuffled by core/rng (so every peer builds the same island), fbm and
// ridged variants, plus a few small numeric helpers shared by the world modules. Pure: no three.js, no DOM.
import { Rng } from '../core/rng.js';

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD = new Float32Array([1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1]);

/** Seeded 2D simplex noise. Returns a function (x, y) -> [-1, 1]. */
export function makeSimplex(seed) {
  const rng = new Rng(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  const perm = new Uint8Array(512);
  const pg = new Uint8Array(512);
  for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]; pg[i] = (perm[i] % 8) * 2; }
  return function simplex(x, y) {
    const s = (x + y) * F2;
    const i = Math.floor(x + s), j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t), y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0, tt, g;
    tt = 0.5 - x0 * x0 - y0 * y0;
    if (tt > 0) { g = pg[ii + perm[jj]]; tt *= tt; n += tt * tt * (GRAD[g] * x0 + GRAD[g + 1] * y0); }
    tt = 0.5 - x1 * x1 - y1 * y1;
    if (tt > 0) { g = pg[ii + i1 + perm[jj + j1]]; tt *= tt; n += tt * tt * (GRAD[g] * x1 + GRAD[g + 1] * y1); }
    tt = 0.5 - x2 * x2 - y2 * y2;
    if (tt > 0) { g = pg[ii + 1 + perm[jj + 1]]; tt *= tt; n += tt * tt * (GRAD[g] * x2 + GRAD[g + 1] * y2); }
    return 70 * n;
  };
}

/** Fractal sum of a simplex function: octaves, lacunarity 2.03, gain g. Output roughly in [-1, 1]. */
export function fbm(noise, x, y, octaves = 4, gain = 0.5) {
  let a = 1, f = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += a * noise(x * f + o * 17.31, y * f - o * 9.17);
    norm += a; a *= gain; f *= 2.03;
  }
  return sum / norm;
}

/** Ridged multifractal in [0, 1]: sharp crests, smooth valleys. */
export function ridged(noise, x, y, octaves = 3) {
  let a = 0.5, f = 1, sum = 0, norm = 0, prev = 1;
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(noise(x * f - o * 5.7, y * f + o * 3.3));
    n *= n;
    sum += n * a * prev;
    norm += a;
    prev = n;
    a *= 0.5; f *= 2.1;
  }
  return sum / norm;
}

export const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
export const smoother01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (t * (t * 6 - 15) + 10));
export const sstep = (a, b, v) => smooth01((v - a) / (b - a));
export const mix = (a, b, t) => a + (b - a) * t;

/** Polynomial smooth maximum (k = blend width in the same units). */
export function smax(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

/** Distance from point (px, pz) to segment (ax, az)-(bx, bz); writes the segment parameter to out[0]. */
export function segDist(px, pz, ax, az, bx, bz, out) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  if (out) out[0] = t;
  const qx = ax + dx * t - px, qz = az + dz * t - pz;
  return Math.sqrt(qx * qx + qz * qz);
}

/** Cheap integer hash -> [0, 1) for scattering (stable across peers). */
export function hash2(ix, iz, salt = 0) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ Math.imul(salt | 0, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
