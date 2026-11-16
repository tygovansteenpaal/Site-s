// BLOKSTORM - small simulation steps that the host and every player run the same way.
import { RULES, WORLD } from './config.js';
import { clamp, lerp } from './util.js';

/** Radius of the circle at match time t (seconds since the round started). */
let ZONE = { start: RULES.zoneStart, shrink: RULES.zoneShrink };
/** A small map gets a small circle that closes faster. [start radius, seconds to close] */
export function setZoneMap(z) { ZONE = z ? { start: z[0], shrink: z[1] } : { start: RULES.zoneStart, shrink: RULES.zoneShrink }; }
export function zoneRadius(t) {
  const k = clamp((t - RULES.zoneDelay) / ZONE.shrink, 0, 1);
  return lerp(ZONE.start, RULES.zoneEnd, k);
}
export const distToMiddle = (x, z) => Math.hypot(x - WORLD.CX, z - WORLD.CZ);

/** A dropped item falls until it lies on a block. */
export function stepDrop(world, d, dt) {
  d.age = (d.age || 0) + dt;
  if (d.rest) { if (world.solid(Math.floor(d.x), Math.floor(d.y - 0.3), Math.floor(d.z))) return; d.rest = false; }
  d.vy = Math.max(-30, d.vy - 22 * dt);
  let nx = d.x + d.vx * dt, nz = d.z + d.vz * dt;
  if (world.solid(Math.floor(nx), Math.floor(d.y), Math.floor(nz))) { nx = d.x; nz = d.z; d.vx = 0; d.vz = 0; }
  let ny = d.y + d.vy * dt;
  if (d.vy <= 0 && world.solid(Math.floor(nx), Math.floor(ny - 0.2), Math.floor(nz))) {
    ny = Math.floor(ny - 0.2) + 1.2; d.vy = 0; d.vx *= 0.5; d.vz *= 0.5;
    if (Math.abs(d.vx) + Math.abs(d.vz) < 0.3) { d.vx = 0; d.vz = 0; d.rest = true; }
  }
  d.x = nx; d.y = ny; d.z = nz;
}

/** A thrown or shot thing flies in an arc. Returns the block it hit, or null. */
export function stepProj(world, p, dt) {
  p.age = (p.age || 0) + dt;
  if (p.stuck) return null;
  p.vy -= 20 * dt;
  const sp = Math.hypot(p.vx, p.vy, p.vz) || 1e-6;
  const hit = world.raycast(p.x, p.y, p.z, p.vx / sp, p.vy / sp, p.vz / sp, sp * dt);
  if (hit) {
    const back = Math.max(0, hit.dist - 0.02);
    p.x += (p.vx / sp) * back; p.y += (p.vy / sp) * back; p.z += (p.vz / sp) * back;
    return hit;
  }
  p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
  return null;
}

/** Does the segment a -> b cross a standing player box at feet position c? */
export function segHitsBox(ax, ay, az, bx, by, bz, c, grow = 0.15) {
  const min = [c.x - 0.3 - grow, c.y - grow, c.z - 0.3 - grow], max = [c.x + 0.3 + grow, c.y + 1.8 + grow, c.z + 0.3 + grow];
  const o = [ax, ay, az], d = [bx - ax, by - ay, bz - az];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < min[i] || o[i] > max[i]) return false; continue; }
    let a = (min[i] - o[i]) / d[i], b = (max[i] - o[i]) / d[i];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return false;
  }
  return true;
}
