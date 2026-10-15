// ZONEFALL - transport aircraft for the drop. OWNER: GAME. Contract: ARCHITECTURE.md 5.6.
// A procedural high-wing four-turboprop military transport (30 m fuselage, 40 m span, T-tail, rear cargo ramp)
// built at init from lofted airfoils and lathe bodies: upswept tail with a real opening behind the ramp and a dark
// cargo bay inside, anhedral wings, nacelles with spinners and blurred eight-blade propeller discs, cockpit glazing,
// navigation lights, wingtip strobes and red beacons. Paint is a PBR material with a generated panel-line /
// grime albedo + roughness map and a fine metal normal map. The ramp lowers when the doors open (PLANE_DOORS).
// It flies match.planePath() with a little turbulence, is visible during the plane phase and until it leaves the map.
// The 'vehicle' loop (plane_loop) is driven by engine/audio from the local life state.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { on, EV } from '../core/bus.js';
import { state, debug } from '../core/state.js';
import { clamp, damp, smoothstep } from '../core/util.js';
import * as assets from '../engine/assets.js';
import * as match from './match.js';

const TUNE = {
  fuselageRadius: 2.3,
  propRadius: 2.45,
  propSpin: 31,                 // rad/s of the blur disc (reads as a fast prop without strobing)
  rampOpenDeg: 13,              // ramp angle when open (positive = tip down), closed follows the tail upsweep
  rampClosedDeg: -12,
  rampSpeed: 0.55,              // 1/s
  bobAmp: 0.35, rollAmpDeg: 1.1, pitchAmpDeg: 0.5,
  hideAfterExit: 6,             // s after reaching the end of the flight line
};

let group = null;
let props = [];
let ramp = null, rampT = 0, rampTarget = 0;
let strobes = [], beacons = [];
let visible = true;
let clock = 0;
const _pos = new THREE.Vector3(), _dir = new THREE.Vector3(0, 0, -1), _tmp = new THREE.Vector3();

// ------------------------------------------------------------------------------------------ geometry helpers
/** Closed airfoil loop (chord fraction, thickness fraction), trailing edge -> top -> leading edge -> bottom. */
const AIRFOIL = [
  [1, 0], [0.82, 0.12], [0.62, 0.27], [0.42, 0.42], [0.26, 0.5], [0.13, 0.48], [0.05, 0.36], [0.012, 0.18], [0, 0],
  [0.012, -0.14], [0.05, -0.24], [0.13, -0.3], [0.26, -0.31], [0.42, -0.27], [0.62, -0.18], [0.82, -0.08],
];
const SYMMETRIC = [
  [1, 0], [0.82, 0.1], [0.62, 0.2], [0.42, 0.32], [0.26, 0.4], [0.13, 0.42], [0.05, 0.34], [0.012, 0.18], [0, 0],
  [0.012, -0.18], [0.05, -0.34], [0.13, -0.42], [0.26, -0.4], [0.42, -0.32], [0.62, -0.2], [0.82, -0.1],
];

/**
 * Loft an airfoil through stations. Each station: {o: [x,y,z] leading edge, c: chord (m), t: thickness (m)}.
 * chordDir / thickDir are shared unit vectors. UVs: u = chord fraction, v = span fraction. Ends are capped.
 */
function loft(stations, chordDir, thickDir, profile = AIRFOIL) {
  const n = profile.length;
  const pos = [], uv = [], idx = [];
  const C = new THREE.Vector3(...chordDir), Tn = new THREE.Vector3(...thickDir);
  stations.forEach((s, si) => {
    for (let i = 0; i < n; i++) {
      const [cx, cy] = profile[i];
      pos.push(s.o[0] + C.x * cx * s.c + Tn.x * cy * s.t, s.o[1] + C.y * cx * s.c + Tn.y * cy * s.t, s.o[2] + C.z * cx * s.c + Tn.z * cy * s.t);
      uv.push(cx, si / (stations.length - 1));
    }
  });
  for (let si = 0; si < stations.length - 1; si++) {
    for (let i = 0; i < n; i++) {
      const a = si * n + i, b = si * n + (i + 1) % n, c = (si + 1) * n + i, d = (si + 1) * n + (i + 1) % n;
      idx.push(a, c, b, b, c, d);
    }
  }
  // caps (centre fans)
  for (const [si, flip] of [[0, true], [stations.length - 1, false]]) {
    const s = stations[si];
    const ci = pos.length / 3;
    pos.push(s.o[0] + C.x * 0.4 * s.c + Tn.x * 0.08 * s.t, s.o[1] + C.y * 0.4 * s.c + Tn.y * 0.08 * s.t, s.o[2] + C.z * 0.4 * s.c + Tn.z * 0.08 * s.t);
    uv.push(0.4, si ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const a = si * n + i, b = si * n + (i + 1) % n;
      if (flip) idx.push(ci, a, b); else idx.push(ci, b, a);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // winding sanity: normals of the first station's top point must face +thickDir
  const nrm = g.getAttribute('normal');
  const topI = profile.findIndex((p) => p[1] === Math.max(...profile.map((q) => q[1])));
  const nx = nrm.getX(topI), ny = nrm.getY(topI), nz = nrm.getZ(topI);
  if (nx * Tn.x + ny * Tn.y + nz * Tn.z < 0) {
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  return g;
}

/** Radius of the fuselage at lathe height h (nose at +15, tail at -15). */
function fuselageProfile() {
  const R = TUNE.fuselageRadius;
  const pts = [
    [0, 17.1], [0.55, 16.95], [1.0, 16.6], [1.42, 16.0], [1.78, 15.2], [2.04, 14.2], [2.2, 13.0], [2.28, 11.6], [R, 10],
    [R, 6], [R, 3], [R, 0], [R, -3], [R, -4.6], [2.28, -6], [2.2, -7.6], [2.04, -9.3], [1.8, -11], [1.5, -12.6],
    [1.15, -14], [0.78, -15.2], [0.45, -16.2], [0.2, -16.8], [0, -17.1],
  ];
  // LatheGeometry wants the profile bottom-to-top for outward-facing triangles
  return pts.map(([r, h]) => new THREE.Vector2(r, h)).reverse();
}

/** Tail upsweep: vertical centre offset at fuselage z (tail at +z). */
function upsweep(z) {
  const k = clamp((z - 3.5) / 13.6, 0, 1);
  return TUNE.fuselageRadius * 0.78 * Math.pow(k, 1.45);
}

/** Lathe the fuselage; the cargo opening (below the upswept tail) is cut out when cut = true. */
function buildFuselage(cut, inner = false) {
  const R = TUNE.fuselageRadius;
  let prof = fuselageProfile();
  if (inner) prof = prof.map((v) => new THREE.Vector2(Math.max(0, v.x - 0.09), v.y));
  const g = new THREE.LatheGeometry(prof, 48);
  g.rotateX(-Math.PI / 2);          // lathe height -> -z (nose forward at -z)
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    y *= 1.06;
    // flatten the belly a little (cargo floor)
    const fl = -0.84 * R;
    if (y < fl) y = fl + (y - fl) * 0.35;
    y += upsweep(z);
    p.setXYZ(i, x, y, z);
  }
  if (cut) {
    // remove the faces of the ramp opening: bottom of the tail between z 5.6 and 12.6, |x| < 1.65
    const idx = g.getIndex().array;
    const keep = [];
    for (let i = 0; i < idx.length; i += 3) {
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < 3; k++) { cx += p.getX(idx[i + k]); cy += p.getY(idx[i + k]); cz += p.getZ(idx[i + k]); }
      cx /= 3; cy /= 3; cz /= 3;
      const below = cy < upsweep(cz) - 0.15 * R;
      if (cz > 5.6 && cz < 12.6 && Math.abs(cx) < 1.65 && below) continue;
      keep.push(idx[i], idx[i + 1], idx[i + 2]);
    }
    g.setIndex(keep);
  }
  g.computeVertexNormals();
  return g;
}

function nacelleGeometry() {
  const pts = [[0.0, 3.4], [0.32, 3.36], [0.55, 3.2], [0.66, 2.9], [0.72, 2.2], [0.74, 1.0], [0.72, -0.4], [0.66, -1.6], [0.52, -2.6], [0.4, -3.0], [0.36, -3.1]];
  const g = new THREE.LatheGeometry(pts.map(([r, h]) => new THREE.Vector2(r, h)).reverse(), 20);
  g.rotateX(-Math.PI / 2);
  return g;
}

function spinnerGeometry() {
  const pts = [[0, 0.95], [0.18, 0.86], [0.3, 0.64], [0.38, 0.36], [0.42, 0.0]];
  const g = new THREE.LatheGeometry(pts.map(([r, h]) => new THREE.Vector2(r, h)).reverse(), 16);
  g.rotateX(-Math.PI / 2);
  return g;
}

// ------------------------------------------------------------------------------------------ materials
function paintTextures() {
  const W = 1024, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  // base: matte military grey-green with low-frequency mottling
  g.fillStyle = '#767b72';
  g.fillRect(0, 0, W, H);
  let s = 1234567;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 900; i++) {
    const x = rnd() * W, y = rnd() * H, r = 8 + rnd() * 60;
    const v = rnd() < 0.5 ? 0 : 255;
    g.fillStyle = `rgba(${v},${v},${v},${0.012 + rnd() * 0.022})`;
    g.beginPath(); g.ellipse(x, y, r * 1.6, r, 0, 0, Math.PI * 2); g.fill();
  }
  // panel seams: around (vertical lines in v = along length) and along (horizontal in u)
  // a few panels in a slightly different shade (repairs, replaced skins)
  for (let i = 0; i < 26; i++) {
    const x = Math.floor(rnd() * 16) * (W / 16), y = Math.floor(rnd() * 18) * (H / 18);
    g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.04)';
    g.fillRect(x, y, W / 16, (H / 18) * (1 + Math.floor(rnd() * 3)));
  }
  g.strokeStyle = 'rgba(22,26,22,0.32)';
  g.lineWidth = 1.2;
  for (let i = 1; i < 18; i++) { const y = (i / 18) * H; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  for (let i = 0; i < 16; i++) { const x = (i / 16) * W; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  // rivet rows beside the seams
  g.fillStyle = 'rgba(28,30,26,0.28)';
  for (let i = 1; i < 18; i++) {
    const y = (i / 18) * H + 3;
    for (let x = 2; x < W; x += 7) g.fillRect(x, y, 1.2, 1.2);
  }
  // hatches
  g.strokeStyle = 'rgba(16,18,16,0.7)';
  g.lineWidth = 1.6;
  for (let i = 0; i < 18; i++) {
    const x = rnd() * W, y = rnd() * H, w = 12 + rnd() * 30, h = 10 + rnd() * 24;
    g.strokeRect(x, y, w, h);
  }
  // grime streaks running aft (toward +v) and soot behind the engines
  for (let i = 0; i < 160; i++) {
    const x = rnd() * W, y = rnd() * H, len = 30 + rnd() * 140;
    const grad = g.createLinearGradient(0, y, 0, y + len);
    grad.addColorStop(0, 'rgba(30,26,20,0.16)');
    grad.addColorStop(1, 'rgba(30,26,20,0)');
    g.fillStyle = grad;
    g.fillRect(x, y, 1.5 + rnd() * 3, len);
  }
  const albedo = new THREE.CanvasTexture(c);
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.wrapS = albedo.wrapT = THREE.RepeatWrapping;
  albedo.anisotropy = 4;
  // roughness: seams and grime rougher, worn panels a little smoother
  const r = document.createElement('canvas');
  r.width = W / 2; r.height = H / 2;
  const rg = r.getContext('2d');
  rg.drawImage(c, 0, 0, W / 2, H / 2);
  const img = rg.getImageData(0, 0, W / 2, H / 2);
  for (let i = 0; i < img.data.length; i += 4) {
    const lum = (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
    const v = clamp(255 - lum * 1.15 + 40, 120, 245);     // dark grime -> rough
    img.data[i] = 255; img.data[i + 1] = v; img.data[i + 2] = 255 * 0.35;   // G = roughness, B = metalness (glTF)
  }
  rg.putImageData(img, 0, 0);
  const rough = new THREE.CanvasTexture(r);
  rough.wrapS = rough.wrapT = THREE.RepeatWrapping;
  return { albedo, rough };
}

function propTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const cx = S / 2;
  g.clearRect(0, 0, S, S);
  // soft annulus of motion blur with eight faint blade sweeps
  for (let b = 0; b < 8; b++) {
    const a0 = (b / 8) * Math.PI * 2;
    const grad = g.createRadialGradient(cx, cx, S * 0.08, cx, cx, S * 0.5);
    grad.addColorStop(0, 'rgba(30,32,30,0.0)');
    grad.addColorStop(0.25, 'rgba(32,34,32,0.22)');
    grad.addColorStop(0.85, 'rgba(38,40,38,0.16)');
    grad.addColorStop(0.97, 'rgba(210,200,120,0.18)');
    grad.addColorStop(1, 'rgba(40,40,40,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(cx, cx);
    g.arc(cx, cx, S * 0.5, a0, a0 + 0.42);
    g.closePath();
    g.fill();
  }
  const ring = g.createRadialGradient(cx, cx, S * 0.1, cx, cx, S * 0.5);
  ring.addColorStop(0, 'rgba(30,30,30,0.0)');
  ring.addColorStop(0.3, 'rgba(30,30,30,0.07)');
  ring.addColorStop(0.95, 'rgba(30,30,30,0.06)');
  ring.addColorStop(1, 'rgba(30,30,30,0)');
  g.fillStyle = ring;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function metalNormal(repeatU, repeatV) {
  try {
    const t = assets.texture('green_metal_rust', 'nor_gl').clone();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeatU, repeatV);
    t.needsUpdate = true;
    return t;
  } catch (e) { return null; }
}

// ------------------------------------------------------------------------------------------ build
function build() {
  const R = TUNE.fuselageRadius;
  const root = new THREE.Group();
  root.name = 'transport';
  const { albedo, rough } = paintTextures();
  const nrm = metalNormal(10, 22);
  const paint = new THREE.MeshStandardMaterial({
    name: 'plane-paint', map: albedo, roughnessMap: rough, metalnessMap: rough, roughness: 1, metalness: 1,
    normalMap: nrm, normalScale: new THREE.Vector2(0.25, 0.25), envMapIntensity: 0.9,
  });
  const wingAlbedo = albedo.clone(); wingAlbedo.repeat.set(1, 3); wingAlbedo.needsUpdate = true;
  const wingRough = rough.clone(); wingRough.repeat.set(1, 3); wingRough.needsUpdate = true;
  const wingPaint = paint.clone();
  wingPaint.map = wingAlbedo; wingPaint.roughnessMap = wingRough; wingPaint.metalnessMap = wingRough;
  const darkMetal = new THREE.MeshStandardMaterial({ name: 'plane-dark', color: 0x1d1f1c, roughness: 0.45, metalness: 0.85 });
  const glass = new THREE.MeshStandardMaterial({ name: 'plane-glass', color: 0x0a0e12, roughness: 0.06, metalness: 0.2, envMapIntensity: 1.6 });
  const interior = new THREE.MeshStandardMaterial({ name: 'plane-bay', color: 0x2b2e28, roughness: 0.9, metalness: 0.2, side: THREE.BackSide });
  let rampMat;
  try { rampMat = assets.pbr('green_metal_rust', { tint: 0x9aa094, roughness: 0.9, metalness: 1 }); } catch (e) { rampMat = darkMetal; }

  // fuselage + inner cargo bay
  const fus = new THREE.Mesh(buildFuselage(true), paint);
  fus.name = 'fuselage';
  root.add(fus);
  const bay = new THREE.Mesh(buildFuselage(false, true), interior);
  bay.name = 'cargo-bay';
  root.add(bay);

  // wings (high, anhedral), stabilisers: one merged mesh
  const parts = [];
  for (const side of [-1, 1]) {
    const st = [];
    const span = 20.2;
    for (const [f, c, t] of [[0, 5.3, 0.78], [0.12, 5.1, 0.74], [0.45, 4.1, 0.58], [0.8, 3.0, 0.4], [1, 2.35, 0.3]]) {
      const x = side * f * span;
      st.push({ o: [x, R * 1.04 + 0.12 - f * 0.95, -2.9 + f * 1.55], c, t });
    }
    if (side < 0) st.reverse();
    parts.push(loft(st, [0, 0, 1], [0, 1, 0]));
    // horizontal T-tail half
    const ht = [];
    for (const [f, c, t] of [[0, 3.3, 0.36], [0.5, 2.6, 0.28], [1, 1.75, 0.2]]) ht.push({ o: [side * f * 7.6, upsweep(11) + R * 0.78 + 5.95 + f * 0.25, 13.15 + f * 1.7], c, t });
    if (side < 0) ht.reverse();
    parts.push(loft(ht, [0, 0, 1], [0, 1, 0], SYMMETRIC));
  }
  // vertical fin
  const fin = [];
  for (const [f, c, t] of [[0, 5.7, 0.55], [0.5, 4.5, 0.42], [1, 3.4, 0.3]]) fin.push({ o: [0, upsweep(11) + R * 0.78 + f * 6.1, 9.5 + f * 3.65], c, t });
  parts.push(loft(fin, [0, 0, 1], [1, 0, 0], SYMMETRIC));
  // wing-root fairing on the fuselage top
  const fair = new THREE.CapsuleGeometry(0.85, 6.5, 4, 12);
  fair.rotateX(Math.PI / 2);
  fair.scale(1.5, 0.55, 1);
  fair.translate(0, R * 1.02, -0.6);
  parts.push(fair);
  // main gear sponsons along the lower fuselage
  for (const side of [-1, 1]) {
    const sp = new THREE.CapsuleGeometry(0.75, 5.5, 4, 12);
    sp.rotateX(Math.PI / 2);
    sp.scale(0.9, 0.85, 1);
    sp.translate(side * (R - 0.15), -R * 0.62, 1.2);
    parts.push(sp);
  }
  const wings = new THREE.Mesh(mergeGeometries(parts.map(cleanForMerge)), wingPaint);
  wings.name = 'airframe';
  root.add(wings);

  // nacelles + spinners
  const nac = [], spin = [], exhaust = [];
  const engineX = [-12.6, -6.6, 6.6, 12.6];
  for (const x of engineX) {
    const f = Math.abs(x) / 20.2;
    const wy = R * 1.04 + 0.12 - f * 0.95;
    const wz = -2.9 + f * 1.55;
    const n = nacelleGeometry();
    n.translate(x, wy - 0.42, wz + 0.25);
    nac.push(n);
    const sg = spinnerGeometry();
    sg.translate(x, wy - 0.42, wz + 0.25 - 3.4);
    spin.push(sg);
    const ex = new THREE.CylinderGeometry(0.22, 0.26, 0.6, 12, 1, true);
    ex.rotateZ(Math.PI / 2);
    ex.translate(x + Math.sign(x) * 0.62, wy - 0.55, wz + 1.6);
    exhaust.push(ex);
  }
  root.add(named(new THREE.Mesh(mergeGeometries(nac.map(cleanForMerge)), paint), 'nacelles'));
  root.add(named(new THREE.Mesh(mergeGeometries([...spin, ...exhaust].map(cleanForMerge)), darkMetal), 'spinners'));

  // propeller blur discs
  const propMat = new THREE.MeshStandardMaterial({ name: 'plane-prop', map: propTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.3 });
  const disc = new THREE.CircleGeometry(TUNE.propRadius, 40);
  props = [];
  engineX.forEach((x, i) => {
    const f = Math.abs(x) / 20.2;
    const m = new THREE.Mesh(disc, propMat);
    m.position.set(x, R * 1.04 + 0.12 - f * 0.95 - 0.42, -2.9 + f * 1.55 + 0.25 - 3.55);
    m.userData.dir = i % 2 ? 1 : -1;
    m.renderOrder = 5;
    props.push(m);
    root.add(m);
  });

  // cockpit glazing: panels tangent to the nose
  const glassParts = [];
  const lathe = fuselageProfile();
  const radiusAt = (h) => {
    for (let i = 0; i < lathe.length - 1; i++) {
      const a = lathe[i], b = lathe[i + 1];
      if (h >= Math.min(a.y, b.y) && h <= Math.max(a.y, b.y)) return a.x + (b.x - a.x) * ((h - a.y) / (b.y - a.y || 1));
    }
    return R;
  };
  const panel = new THREE.PlaneGeometry(0.8, 0.52);
  for (const [h, angs] of [[15.0, [-48, -24, 0, 24, 48]], [14.2, [-64, -40, 40, 64]]]) {
    for (const deg of angs) {
      const a = deg * Math.PI / 180;
      const r = radiusAt(h) + 0.025;
      const p = new THREE.Vector3(Math.sin(a) * r, Math.cos(a) * r * 1.06, -h);
      const nrmv = new THREE.Vector3(Math.sin(a), Math.cos(a), -0.55).normalize();
      const m = new THREE.Object3D();
      m.position.copy(p);
      m.lookAt(p.clone().add(nrmv));
      m.updateMatrix();
      glassParts.push(panel.clone().applyMatrix4(m.matrix));
    }
  }
  root.add(named(new THREE.Mesh(mergeGeometries(glassParts), glass), 'glazing'));

  // cargo ramp (hinged at its front edge)
  const rampGeo = new THREE.BoxGeometry(3.15, 0.14, 5.6);
  rampGeo.translate(0, 0, 2.8);
  const rampMesh = new THREE.Mesh(rampGeo, rampMat);
  ramp = new THREE.Group();
  ramp.position.set(0, -0.84 * R + upsweep(5.6) + 0.1, 5.6);
  ramp.add(rampMesh);
  root.add(ramp);

  // lights
  const bulb = new THREE.SphereGeometry(0.13, 10, 8);
  const mk = (color, pos, list) => {
    const m = new THREE.Mesh(bulb, new THREE.MeshBasicMaterial({ color, toneMapped: true }));
    m.position.set(...pos);
    root.add(m);
    if (list) list.push(m);
    return m;
  };
  mk(new THREE.Color(6, 0.25, 0.2), [-20.25, R * 1.04 + 0.12 - 0.95, -0.4]);         // port red
  mk(new THREE.Color(0.2, 6, 0.6), [20.25, R * 1.04 + 0.12 - 0.95, -0.4]);           // starboard green
  mk(new THREE.Color(5, 5, 5), [0, upsweep(17) + 0.15, 17.15]);                      // tail white
  strobes = [];
  mk(new THREE.Color(14, 14, 14), [-20.3, R * 1.04 + 0.05 - 0.95, 0.2], strobes);
  mk(new THREE.Color(14, 14, 14), [20.3, R * 1.04 + 0.05 - 0.95, 0.2], strobes);
  beacons = [];
  mk(new THREE.Color(9, 0.3, 0.2), [0, R * 1.32, 1.5], beacons);
  mk(new THREE.Color(9, 0.3, 0.2), [0, -R * 0.92, -2.0], beacons);

  root.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return root;
}

function cleanForMerge(g) {
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
  return g;
}

function named(o, name) { o.name = name; return o; }

// ------------------------------------------------------------------------------------------ public API
export function init(scene) {
  group = build();
  group.visible = false;
  scene.add(group);
  on(EV.PLANE_DOORS, ({ open }) => { rampTarget = open ? 1 : 0; });
  on(EV.MATCH_START, () => { rampT = 0; rampTarget = 0; });
  debug.game = debug.game || {};
  Object.assign(debug.game, {
    planeObject: () => group,
    planeRamp: (t) => { rampT = rampTarget = clamp(t, 0, 1); },
  });
}

export function update(dt) {
  if (!group) return;
  clock += dt;
  const m = state.match;
  let show = visible && m.phase !== 'idle';
  if (show) {
    const p = match.planePath();
    show = m.time < p.exitAt + TUNE.hideAfterExit;
  }
  group.visible = show;
  if (!show) return;
  transformAt(m.time, _pos, _dir);
  group.position.copy(_pos);
  const yaw = Math.atan2(-_dir.x, -_dir.z);
  const roll = Math.sin(clock * 0.43) * TUNE.rollAmpDeg * Math.PI / 180 + Math.sin(clock * 1.7) * 0.15 * Math.PI / 180;
  const pitch = Math.sin(clock * 0.31 + 1.2) * TUNE.pitchAmpDeg * Math.PI / 180;
  group.rotation.set(pitch, yaw, roll, 'YXZ');
  for (const pr of props) pr.rotation.z += pr.userData.dir * TUNE.propSpin * dt;
  // ramp
  rampT = damp(rampT, rampTarget, 3.2 * TUNE.rampSpeed, dt);
  const deg = TUNE.rampClosedDeg + (TUNE.rampOpenDeg - TUNE.rampClosedDeg) * smoothstep(0, 1, rampT);
  ramp.rotation.x = deg * Math.PI / 180;
  // lights: wingtip strobes double-flash every 1.3 s, beacons pulse at 1 Hz
  const ph = clock % 1.3;
  const strobeOn = ph < 0.05 || (ph > 0.16 && ph < 0.21);
  for (const s of strobes) s.visible = strobeOn;
  const bOn = (clock % 1.0) < 0.12;
  for (const b of beacons) b.visible = bOn;
}

/** Plane pose at match time t into pos/dir (with the same turbulence bob the mesh shows). */
function transformAt(t, pos, dir) {
  match.planePosAt(t, pos);
  const p = match.planePath();
  dir.set(p.dir[0], 0, p.dir[2]).normalize();
  pos.y += Math.sin(clock * 0.37) * TUNE.bobAmp + Math.sin(clock * 1.13 + 0.6) * TUNE.bobAmp * 0.25;
  return pos;
}

/** {pos: Vector3, dir: Vector3} of the plane now (copies). */
export function getTransform() {
  const pos = new THREE.Vector3(), dir = new THREE.Vector3();
  if (state.match.phase === 'idle') return { pos: pos.set(0, 380, 0), dir: dir.set(0, 0, -1) };
  transformAt(state.match.time, pos, dir);
  return { pos, dir };
}

export function setVisible(on) {
  visible = !!on;
  if (group && !visible) group.visible = false;
}
