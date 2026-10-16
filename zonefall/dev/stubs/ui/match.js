// ZONEFALL dev/ui.html stand-in for game/match.js: a fixed plane route across Kessler Isle.
export function planePath() {
  const dx = Math.cos(0.5), dz = Math.sin(0.5);
  const a = [-900 * dx, 380, -900 * dz - 60], b = [900 * dx, 380, 900 * dz - 60];
  return { a, b, dir: [dx, 0, dz], center: [0, 380, -60], speed: 55, length: 1800, doorsOpenAt: 6.9, forceJumpAt: 24, exitAt: 32.7 };
}
