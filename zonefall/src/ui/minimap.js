// ZONEFALL - minimap and full-map canvas renderers. OWNER: UI (internal to src/ui; map.js is the contract facade).
// Both draw from the 1024 px north-up base image (world.getMapImage(), util.worldToMap frame), and from plain view
// objects, so the dev harness can feed mock data. Nothing here touches the DOM outside the given canvas.
import { MAP, POIS, LANDMARKS } from '../core/mapdata.js';

export const TUNE = {
  minimapRadius: 150,        // m from the centre to the edge of the minimap
  gasFill: 'rgba(255, 106, 61, 0.24)',
  gasEdge: 'rgba(255, 106, 61, 0.9)',
  zoneLine: 'rgba(244, 242, 236, 0.95)',
  nextLine: 'rgba(244, 242, 236, 0.85)',
  ping: '#e5484d',
  self: '#e8b23a',
  sea: '#16272c',
  gridEvery: 120,            // full map grid cell size in metres (10 x 10 cells)
};

const HALF = MAP.half;
let base = null;             // processed copy of the base image (graded for HUD contrast)
let baseSrc = null;

/** Grade the base map once (slightly darker and cooler so HUD lines read on top). */
export function setBase(img) {
  if (!img || img === baseSrc) return;
  baseSrc = img;
  const c = document.createElement('canvas');
  c.width = img.width || 1024;
  c.height = img.height || 1024;
  const g = c.getContext('2d');
  try { g.filter = 'saturate(0.78) brightness(0.86) contrast(1.06)'; } catch (e) { /* filter unsupported: draw as is */ }
  g.drawImage(img, 0, 0, c.width, c.height);
  g.filter = 'none';
  base = c;
}
export const hasBase = () => !!base;

function sizeCanvas(cv) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(cv.clientWidth * dpr));
  const hgt = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== hgt) { cv.width = w; cv.height = hgt; }
  return dpr;
}

function gas(g, zone, extent) {
  if (!zone || !(zone.r > 0) || zone.state === 'pre') return;
  g.beginPath();
  g.rect(-extent, -extent, extent * 2, extent * 2);
  g.arc(zone.x, zone.z, zone.r, 0, Math.PI * 2, true);
  g.fillStyle = TUNE.gasFill;
  g.fill('evenodd');
}

function circles(g, zone, px) {
  if (!zone) return;
  if (zone.r > 0 && zone.state !== 'pre') {
    g.beginPath();
    g.arc(zone.x, zone.z, zone.r, 0, Math.PI * 2);
    g.strokeStyle = TUNE.gasEdge;
    g.lineWidth = 3.2 * px;
    g.globalAlpha = 0.35;
    g.stroke();
    g.globalAlpha = 1;
    g.strokeStyle = TUNE.zoneLine;
    g.lineWidth = 1.6 * px;
    g.stroke();
  }
  if (zone.nr > 0 && zone.state !== 'pre' && zone.state !== 'final') {
    g.beginPath();
    g.arc(zone.nx, zone.nz, zone.nr, 0, Math.PI * 2);
    g.setLineDash([6 * px, 5 * px]);
    g.strokeStyle = TUNE.nextLine;
    g.lineWidth = 1.3 * px;
    g.stroke();
    g.setLineDash([]);
  }
}

function pingMarks(g, pings, now, px, scaleR) {
  for (const p of pings) {
    const age = (now - p.t) / 1000;
    if (age > 1.5) continue;
    const a = 1 - age / 1.5;
    g.beginPath();
    g.arc(p.x, p.z, (3.2 + age * 9) * px * scaleR, 0, Math.PI * 2);
    g.strokeStyle = `rgba(229, 72, 77, ${(a * 0.8).toFixed(3)})`;
    g.lineWidth = 1.4 * px * scaleR;
    g.stroke();
    g.beginPath();
    g.arc(p.x, p.z, 3 * px * scaleR, 0, Math.PI * 2);
    g.fillStyle = `rgba(229, 72, 77, ${Math.min(1, a * 1.6).toFixed(3)})`;
    g.fill();
  }
}

function selfArrow(g, x, y, s, rot) {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.beginPath();
  g.moveTo(0, -8 * s);
  g.lineTo(6 * s, 7 * s);
  g.lineTo(0, 3.6 * s);
  g.lineTo(-6 * s, 7 * s);
  g.closePath();
  g.lineJoin = 'round';
  g.lineWidth = 3 * s;
  g.strokeStyle = 'rgba(8, 9, 9, 0.85)';
  g.stroke();
  g.fillStyle = TUNE.self;
  g.fill();
  g.restore();
}

/**
 * Draw the heading-up minimap.
 * view: {x, z, heading (rad, clockwise from north), zone: state.zone, pings: [{x, z, t}], now, plane: {a, b}|null,
 *        radius?: metres}
 * Returns the north marker offset {nx, ny} in CSS px from the centre (for the DOM "N" label).
 */
export function drawMinimap(cv, view) {
  const dpr = sizeCanvas(cv);
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const R = view.radius || TUNE.minimapRadius;
  const scale = (Math.min(W, H) / 2) / R;        // device px per metre
  const px = 1 / scale * dpr;                      // one CSS px expressed in metres
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = TUNE.sea;
  g.fillRect(0, 0, W, H);

  g.save();
  g.translate(W / 2, H / 2);
  g.rotate(-view.heading);
  g.scale(scale, scale);
  g.translate(-view.x, -view.z);
  if (base) g.drawImage(base, -HALF, -HALF, HALF * 2, HALF * 2);
  const ext = R * 3 + Math.abs(view.x) + Math.abs(view.z) + HALF;
  gas(g, view.zone, ext);
  if (view.plane) {
    g.beginPath();
    g.moveTo(view.plane.a[0], view.plane.a[2]);
    g.lineTo(view.plane.b[0], view.plane.b[2]);
    g.setLineDash([4 * px, 4 * px]);
    g.strokeStyle = 'rgba(244, 242, 236, 0.75)';
    g.lineWidth = 1.2 * px;
    g.stroke();
    g.setLineDash([]);
  }
  circles(g, view.zone, px);
  // path to safety when outside the current circle
  const z = view.zone;
  if (z && z.r > 0 && z.state !== 'pre') {
    const dx = view.x - z.x, dz = view.z - z.z;
    const d = Math.hypot(dx, dz);
    if (d > z.r) {
      const ex = z.x + dx / d * z.r, ez = z.z + dz / d * z.r;
      g.beginPath();
      g.moveTo(view.x, view.z);
      g.lineTo(ex, ez);
      g.setLineDash([2 * px, 4 * px]);
      g.strokeStyle = TUNE.gasEdge;
      g.lineWidth = 2 * px;
      g.stroke();
      g.setLineDash([]);
    }
  }
  pingMarks(g, view.pings || [], view.now || performance.now(), px, 1);
  g.restore();

  // view cone + self arrow (screen space, always pointing up)
  const cx = W / 2, cy = H / 2;
  const cone = g.createRadialGradient(cx, cy, 0, cx, cy, H * 0.42);
  cone.addColorStop(0, 'rgba(244, 242, 236, 0.20)');
  cone.addColorStop(1, 'rgba(244, 242, 236, 0)');
  g.beginPath();
  g.moveTo(cx, cy);
  g.arc(cx, cy, H * 0.42, -Math.PI / 2 - 0.62, -Math.PI / 2 + 0.62);
  g.closePath();
  g.fillStyle = cone;
  g.fill();
  selfArrow(g, cx, cy, dpr, 0);

  // edge vignette for depth
  const vg = g.createRadialGradient(cx, cy, Math.min(W, H) * 0.3, cx, cy, Math.max(W, H) * 0.72);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.38)');
  g.fillStyle = vg;
  g.fillRect(0, 0, W, H);

  const sx = -Math.sin(view.heading), sy = -Math.cos(view.heading);
  const k = 1 / Math.max(Math.abs(sx), Math.abs(sy));
  return { nx: sx * k, ny: sy * k };
}

const GRID_COLS = 'ABCDEFGHIJ';

/** Grid reference of a world position on the full map ('D6'). */
export function gridRef(x, z) {
  const n = Math.round((HALF * 2) / TUNE.gridEvery);
  const c = Math.max(0, Math.min(n - 1, Math.floor((x + HALF) / TUNE.gridEvery)));
  const r = Math.max(0, Math.min(n - 1, Math.floor((z + HALF) / TUNE.gridEvery)));
  return GRID_COLS[c] + (r + 1);
}

function label(g, text, x, y, size, color, spacing, weight = 600) {
  g.font = `${weight} ${size}px "Barlow Condensed", "Barlow", sans-serif`;
  if ('letterSpacing' in g) g.letterSpacing = `${spacing}px`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = Math.max(2, size * 0.28);
  g.strokeStyle = 'rgba(8, 9, 9, 0.78)';
  g.lineJoin = 'round';
  g.strokeText(text, x, y);
  g.fillStyle = color;
  g.fillText(text, x, y);
  if ('letterSpacing' in g) g.letterSpacing = '0px';
}

/**
 * Draw the north-up full map.
 * view: {x, z, heading, zone, pings, now, plane: {a, b, doorsA, doorsB, pos}|null, selfVisible}
 */
export function drawFullMap(cv, view) {
  const dpr = sizeCanvas(cv);
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const S = Math.min(W, H);
  const scale = S / (HALF * 2);
  const px = dpr / scale;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = TUNE.sea;
  g.fillRect(0, 0, W, H);

  g.save();
  g.translate(W / 2, H / 2);
  g.scale(scale, scale);
  if (base) g.drawImage(base, -HALF, -HALF, HALF * 2, HALF * 2);

  // grid
  g.beginPath();
  for (let v = -HALF + TUNE.gridEvery; v < HALF; v += TUNE.gridEvery) {
    g.moveTo(v, -HALF); g.lineTo(v, HALF);
    g.moveTo(-HALF, v); g.lineTo(HALF, v);
  }
  g.strokeStyle = 'rgba(244, 242, 236, 0.09)';
  g.lineWidth = px;
  g.stroke();

  gas(g, view.zone, HALF * 3);
  if (view.plane) {
    const p = view.plane;
    g.beginPath();
    g.moveTo(p.a[0], p.a[2]);
    g.lineTo(p.b[0], p.b[2]);
    g.setLineDash([7 * px, 6 * px]);
    g.strokeStyle = 'rgba(244, 242, 236, 0.7)';
    g.lineWidth = 1.5 * px;
    g.stroke();
    g.setLineDash([]);
    if (p.doorsA && p.doorsB) {
      g.beginPath();
      g.moveTo(p.doorsA[0], p.doorsA[2]);
      g.lineTo(p.doorsB[0], p.doorsB[2]);
      g.strokeStyle = 'rgba(232, 178, 58, 0.95)';
      g.lineWidth = 3 * px;
      g.stroke();
    }
    if (p.pos) {
      g.save();
      g.translate(p.pos[0], p.pos[2]);
      g.rotate(Math.atan2(p.b[0] - p.a[0], -(p.b[2] - p.a[2])));
      g.beginPath();
      g.moveTo(0, -10 * px); g.lineTo(7 * px, 8 * px); g.lineTo(0, 4 * px); g.lineTo(-7 * px, 8 * px); g.closePath();
      g.fillStyle = '#f4f2ec';
      g.fill();
      g.restore();
    }
  }
  circles(g, view.zone, px * 1.15);
  pingMarks(g, view.pings || [], view.now || performance.now(), px, 1.2);
  g.restore();

  // labels (screen space so type stays crisp), sized with the map
  const toS = (x, z) => [W / 2 + x * scale, H / 2 + z * scale];
  const k = Math.max(0.6, Math.min(1.35, S / dpr / 720));
  const fit = (x, text, size, spacing) => {
    g.font = `700 ${size}px "Barlow Condensed", "Barlow", sans-serif`;
    const half = (g.measureText(text).width + text.length * spacing) / 2 + 6 * dpr;
    return Math.max((W - S) / 2 + half, Math.min((W + S) / 2 - half, x));
  };
  for (const s of LANDMARKS) {
    const [x, y] = toS(s.x, s.z);
    g.beginPath(); g.arc(x, y, 2.2 * dpr, 0, Math.PI * 2); g.fillStyle = 'rgba(244,242,236,0.7)'; g.fill();
    const fs = 10.5 * dpr * k;
    label(g, s.name, fit(x, s.name, fs, 1.4 * dpr * k), y + 11 * dpr * k, fs, 'rgba(244, 242, 236, 0.72)', 1.4 * dpr * k, 600);
  }
  for (const s of POIS) {
    const [x, y] = toS(s.x, s.z);
    const fs = 15 * dpr * k;
    label(g, s.name, fit(x, s.name, fs, 2.4 * dpr * k), y, fs, '#f4f2ec', 2.4 * dpr * k, 700);
  }
  // grid letters
  const n = Math.round((HALF * 2) / TUNE.gridEvery);
  for (let i = 0; i < n; i++) {
    const c = (i + 0.5) * TUNE.gridEvery * scale;
    label(g, GRID_COLS[i], (W - S) / 2 + c, (H - S) / 2 + 10 * dpr, 10 * dpr, 'rgba(244,242,236,0.55)', 0, 600);
    label(g, String(i + 1), (W - S) / 2 + 9 * dpr, (H - S) / 2 + c, 10 * dpr, 'rgba(244,242,236,0.55)', 0, 600);
  }
  // scale bar: 200 m
  const bar = 200 * scale;
  const bx = (W - S) / 2 + 22 * dpr, by = (H + S) / 2 - 20 * dpr;
  g.fillStyle = 'rgba(8,9,9,0.6)';
  g.fillRect(bx - 8 * dpr, by - 18 * dpr, bar + 16 * dpr, 28 * dpr);
  g.fillStyle = '#f4f2ec';
  g.fillRect(bx, by, bar, 2 * dpr);
  g.fillRect(bx, by - 5 * dpr, 1.5 * dpr, 7 * dpr);
  g.fillRect(bx + bar / 2, by - 3 * dpr, 1.5 * dpr, 5 * dpr);
  g.fillRect(bx + bar - 1.5 * dpr, by - 5 * dpr, 1.5 * dpr, 7 * dpr);
  g.font = `500 ${10 * dpr}px "JetBrains Mono", monospace`;
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.fillText('0', bx, by - 7 * dpr);
  g.textAlign = 'right';
  g.fillText('200 M', bx + bar, by - 7 * dpr);

  if (view.selfVisible !== false) {
    const [x, y] = toS(view.x, view.z);
    const t = (view.now || performance.now()) / 1000;
    g.beginPath();
    g.arc(x, y, (10 + (t % 1.4) * 10) * dpr, 0, Math.PI * 2);
    g.strokeStyle = `rgba(232, 178, 58, ${(0.55 * (1 - (t % 1.4) / 1.4)).toFixed(3)})`;
    g.lineWidth = 1.5 * dpr;
    g.stroke();
    selfArrow(g, x, y, dpr * 1.25, view.heading);
  }
}
