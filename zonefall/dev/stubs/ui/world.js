// ZONEFALL dev/ui.html stand-in for world/world.js: getMapImage() paints a 1024 px top-down map of Kessler Isle from
// core/mapdata (coastline, beach, hills, forests, roads, site footprints) so the minimap and full map have real content.
import { MAP, POIS, LANDMARKS, ROADS, FORESTS } from '../../../src/core/mapdata.js';

let img = null;
const S = 1024, H = MAP.half;
const px = (v) => (v + H) / (2 * H) * S;

function coast(t) { return MAP.coastBase + 28 * Math.sin(3 * t + 0.9) + 14 * Math.sin(7 * t + 2.3); }

function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, y) => noise(x, y) * 0.5 + noise(x * 2.1, y * 2.1) * 0.27 + noise(x * 4.3, y * 4.3) * 0.15 + noise(x * 8.7, y * 8.7) * 0.08;

export function getMapImage() {
  if (img) return img;
  img = document.createElement('canvas');
  img.width = img.height = S;
  const g = img.getContext('2d');
  const data = g.createImageData(S, S);
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const x = i / S * 2 * H - H, z = j / S * 2 * H - H;
      const r = Math.hypot(x, z), t = Math.atan2(z, x), c = coast(t);
      let R, G, B;
      const n = fbm(x / 140, z / 140);
      if (r > c) {
        const d = Math.min(1, (r - c) / 90);
        R = 34 - d * 12; G = 66 - d * 18; B = 74 - d * 12;
      } else if (r > c - MAP.beachWidth) {
        R = 176 + n * 20; G = 162 + n * 18; B = 124 + n * 10;
      } else {
        const hgt = n;
        R = 74 + hgt * 46; G = 90 + hgt * 38; B = 56 + hgt * 20;
        const shade = (fbm((x + 4) / 140, (z - 4) / 140) - n) * 600;
        R += shade; G += shade; B += shade;
      }
      const k = (j * S + i) * 4;
      data.data[k] = R; data.data[k + 1] = G; data.data[k + 2] = B; data.data[k + 3] = 255;
    }
  }
  g.putImageData(data, 0, 0);
  // forests
  for (const [x, z, r] of FORESTS) {
    const grd = g.createRadialGradient(px(x), px(z), 0, px(x), px(z), r / (2 * H) * S);
    grd.addColorStop(0, 'rgba(34, 52, 30, 0.75)');
    grd.addColorStop(1, 'rgba(34, 52, 30, 0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(px(x), px(z), r / (2 * H) * S, 0, Math.PI * 2); g.fill();
  }
  // site pads
  for (const s of [...POIS, ...LANDMARKS]) {
    g.fillStyle = 'rgba(150, 146, 132, 0.35)';
    g.beginPath(); g.arc(px(s.x), px(s.z), s.r * 0.75 / (2 * H) * S, 0, Math.PI * 2); g.fill();
  }
  // roads
  for (const r of ROADS) {
    g.beginPath();
    r.pts.forEach(([x, z], i) => (i ? g.lineTo(px(x), px(z)) : g.moveTo(px(x), px(z))));
    g.strokeStyle = r.type === 'asphalt' ? '#3c3d3b' : '#8a7652';
    g.lineWidth = (r.type === 'asphalt' ? 8 : 5) / (2 * H) * S * 1.3;
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.stroke();
  }
  // building footprints
  const rnd = (n) => { const s = Math.sin(n * 91.7) * 1e4; return s - Math.floor(s); };
  let seed = 1;
  for (const s of [...POIS, ...LANDMARKS]) {
    const count = s.buildings.reduce((a, b) => a + b.count, 0);
    for (let i = 0; i < count; i++) {
      const a = rnd(seed++) * Math.PI * 2, d = rnd(seed++) * s.r * 0.6;
      const w = 8 + rnd(seed++) * 14, hgt = 6 + rnd(seed++) * 10;
      const x = px(s.x + Math.cos(a) * d), z = px(s.z + Math.sin(a) * d);
      g.fillStyle = '#5b5a55';
      g.fillRect(x - w / 2 * 0.85, z - hgt / 2 * 0.85, w * 0.85, hgt * 0.85);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(x - w / 2 * 0.85 + 2, z + hgt / 2 * 0.85, w * 0.85, 2);
    }
  }
  return img;
}

export const getHeight = () => 10;
export const lineOfSight = () => true;
