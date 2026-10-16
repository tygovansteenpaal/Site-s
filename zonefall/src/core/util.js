// ZONEFALL - small shared helpers. OWNER: LEAD. Complete.

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : clamp((v - a) / (b - a), 0, 1));
export const smoothstep = (a, b, v) => { const t = invLerp(a, b, v); return t * t * (3 - 2 * t); };

/** Frame-rate independent exponential smoothing: approaches b at rate lambda (1/s). */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}
/** Shortest signed difference b - a between two angles. */
export const angleDelta = (a, b) => wrapAngle(b - a);
export const dampAngle = (a, b, lambda, dt) => a + angleDelta(a, b) * (1 - Math.exp(-lambda * dt));

/** Compass heading in degrees (0 = north = -Z, 90 = east = +X) from a yaw (rad, 0 looks at -Z, positive turns left). */
export const headingFromYaw = (yaw) => ((-yaw * RAD) % 360 + 360) % 360;

/** Vertical FOV (deg) for a given horizontal FOV (deg) at an aspect ratio. */
export const vfovFromHfov = (hfovDeg, aspect) => 2 * Math.atan(Math.tan((hfovDeg * DEG) / 2) / aspect) * RAD;
/** Settings FOV is horizontal at 16:9; this keeps the vertical FOV constant across window shapes. */
export const settingsFovToVertical = (hfovDeg) => vfovFromHfov(hfovDeg, 16 / 9);

export const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

/** Seconds -> 'm:ss'. */
export function fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Ordinal placement: 1 -> '#1'. */
export const fmtPlace = (n) => `#${n}`;

/** World XZ (metres) -> map UV (0..1, north at the top). */
export const worldToMap = (x, z, half = 600) => [(x + half) / (half * 2), (z + half) / (half * 2)];
export const mapToWorld = (u, v, half = 600) => [u * half * 2 - half, v * half * 2 - half];

export const toArr = (v) => [v.x, v.y, v.z];

/** Thrown by unimplemented contract stubs. Builders replace every call when they implement the function. */
export function notImplemented(where) {
  throw new Error(`[ZONEFALL] ${where} is not implemented yet`);
}

/** Read/write localStorage without ever throwing (private mode, blocked storage). */
export const storage = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
};
