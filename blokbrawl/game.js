import * as THREE from 'three';

// ============================================================================
// Config
// ============================================================================
const CELL = 4;
const GRAVITY = -28;
const JUMP = 10.2;
const SPEED = 7.4;
const RADIUS = 0.45;
const HEIGHT = 1.85;
const STEP = 0.65;
const ARENA = 92;
const GOAL = 5;
const MAX_MATS = 999;
const START_MATS = 500;
const PIECE_COST = 10;

const WEAPONS = {
  ar: { name: 'AR', mag: 30, rate: 0.11, reload: 1.6, dmg: 24, pellets: 1, spread: 0.012, moveSpread: 0.03, range: 160 },
  sg: { name: 'SHOTGUN', mag: 5, rate: 0.85, reload: 2.1, dmg: 11, pellets: 9, spread: 0.075, moveSpread: 0.02, range: 60 },
};

const PIECES = {
  wall: { hp: 150 },
  floor: { hp: 140 },
  ramp: { hp: 140 },
};

const DIFFICULTY = {
  easy:   { err: 0.075, react: 0.55, fireMul: 1.7, build: 0.25, strafe: 0.6 },
  normal: { err: 0.042, react: 0.32, fireMul: 1.2, build: 0.6,  strafe: 0.85 },
  hard:   { err: 0.024, react: 0.16, fireMul: 1.0, build: 1.0,  strafe: 1.0 },
};

const COLORS = {
  grass: 0x7fd36b, grassDark: 0x5fb552, sand: 0xf2d79b, water: 0x4cb8ff,
  wood: 0xe0a050, woodDark: 0xb8742e, ghost: 0xfff8ec,
  player: 0xffc23a, playerDark: 0xe08a1e,
  bot: 0xa77bff, botDark: 0x6f47d6,
  skin: 0xffd9b0, ink: 0x141218,
  trunk: 0x9a5a2a, leaf: 0x4fbf5a, leafLight: 0x79d96b, rock: 0xb9b4c4,
};

// ============================================================================
// Renderer / scene
// ============================================================================
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fd3ff);
scene.fog = new THREE.Fog(0x8fd3ff, 90, 220);

const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 400);

scene.add(new THREE.HemisphereLight(0xdff3ff, 0x6a8f4a, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(40, 70, 25);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 200 });
sun.shadow.bias = -0.0008;
scene.add(sun);

// Three-step toon ramp.
const toonRamp = (() => {
  const data = new Uint8Array([110, 110, 110, 255, 190, 190, 190, 255, 255, 255, 255, 255]);
  const t = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
})();

const matCache = new Map();
function toon(color) {
  if (!matCache.has(color)) matCache.set(color, new THREE.MeshToonMaterial({ color, gradientMap: toonRamp }));
  return matCache.get(color);
}
const outlineMat = new THREE.MeshBasicMaterial({ color: COLORS.ink, side: THREE.BackSide });

/** A toon mesh with an inverted-hull outline sized for a constant thickness. */
function cartoon(geo, color, thickness = 0.05, { shadow = true } = {}) {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(geo, toon(color));
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  geo.computeBoundingBox();
  const s = new THREE.Vector3();
  geo.boundingBox.getSize(s);
  const line = new THREE.Mesh(geo, outlineMat);
  line.scale.set((s.x + thickness * 2) / s.x, (s.y + thickness * 2) / s.y, (s.z + thickness * 2) / s.z);
  group.add(mesh, line);
  group.userData.mesh = mesh;
  return group;
}

// ============================================================================
// World
// ============================================================================
const solids = [];     // meshes bullets collide with
const circles = [];    // static round colliders {x, z, r, h}

function buildWorld() {
  const ground = new THREE.Mesh(new THREE.CircleGeometry(ARENA + 6, 64), toon(COLORS.grass));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  solids.push(ground);

  const beach = new THREE.Mesh(new THREE.RingGeometry(ARENA + 6, ARENA + 16, 64), toon(COLORS.sand));
  beach.rotation.x = -Math.PI / 2;
  beach.position.y = -0.05;
  beach.receiveShadow = true;
  scene.add(beach);

  const water = new THREE.Mesh(new THREE.CircleGeometry(400, 48), toon(COLORS.water));
  water.rotation.x = -Math.PI / 2;
  water.position.y = -0.6;
  scene.add(water);

  // Grid tiles: darker checker patches so the build grid reads on the ground.
  const tileGeo = new THREE.PlaneGeometry(CELL - 0.15, CELL - 0.15);
  const tileMat = toon(COLORS.grassDark);
  const tiles = new THREE.InstancedMesh(tileGeo, tileMat, 900);
  let n = 0;
  const m = new THREE.Matrix4();
  for (let x = -15; x < 15; x++) {
    for (let z = -15; z < 15; z++) {
      if ((x + z) & 1) continue;
      if (Math.hypot(x * CELL, z * CELL) > ARENA - 4) continue;
      m.makeRotationX(-Math.PI / 2).setPosition(x * CELL + CELL / 2, 0.01, z * CELL + CELL / 2);
      tiles.setMatrixAt(n++, m);
    }
  }
  tiles.count = n;
  tiles.receiveShadow = true;
  scene.add(tiles);

  const rnd = mulberry32(7);
  for (let i = 0; i < 70; i++) {
    const a = rnd() * Math.PI * 2;
    const r = 46 + rnd() * (ARENA - 50);
    addTree(Math.cos(a) * r, Math.sin(a) * r, 0.8 + rnd() * 0.7, rnd);
  }
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2;
    const r = 28 + rnd() * (ARENA - 30);
    addRock(Math.cos(a) * r, Math.sin(a) * r, 0.8 + rnd() * 1.6, rnd);
  }
  // A few rocks in the middle for early cover.
  addRock(-14, 3, 1.5, rnd);
  addRock(15, -4, 1.7, rnd);
  addRock(3, 13, 1.1, rnd);
  addRock(-4, -12, 1.2, rnd);

  for (let i = 0; i < 9; i++) addCloud(rnd);
}

function addTree(x, z, s, rnd) {
  const g = new THREE.Group();
  const trunk = cartoon(new THREE.CylinderGeometry(0.35 * s, 0.5 * s, 3 * s, 8), COLORS.trunk);
  trunk.position.y = 1.5 * s;
  g.add(trunk);
  const puffs = [[0, 4.2, 0, 1.9], [1.1, 3.5, 0.3, 1.3], [-1, 3.6, -0.4, 1.4], [0.2, 5.2, 0.2, 1.3]];
  for (const [px, py, pz, pr] of puffs) {
    const p = cartoon(new THREE.IcosahedronGeometry(pr * s, 1), rnd() > 0.5 ? COLORS.leaf : COLORS.leafLight, 0.08);
    p.position.set(px * s, py * s, pz * s);
    g.add(p);
  }
  g.position.set(x, 0, z);
  g.rotation.y = rnd() * Math.PI * 2;
  scene.add(g);
  g.traverse(o => { if (o.isMesh && o.material !== outlineMat) solids.push(o); });
  circles.push({ x, z, r: 0.6 * s, h: 8 * s });
}

function addRock(x, z, s, rnd) {
  const r = cartoon(new THREE.DodecahedronGeometry(s, 0), COLORS.rock, 0.07);
  r.position.set(x, s * 0.45, z);
  r.rotation.set(rnd(), rnd() * 6, rnd());
  r.scale.y = 0.75;
  scene.add(r);
  solids.push(r.userData.mesh);
  circles.push({ x, z, r: s * 0.9, h: s * 1.2 });
}

const clouds = [];
function addCloud(rnd) {
  const g = new THREE.Group();
  const white = 0xffffff;
  for (let i = 0; i < 5; i++) {
    const p = cartoon(new THREE.IcosahedronGeometry(2 + rnd() * 2.5, 1), white, 0.12, { shadow: false });
    p.position.set(i * 3 - 6, rnd() * 1.5, rnd() * 2);
    g.add(p);
  }
  g.position.set((rnd() - 0.5) * 300, 42 + rnd() * 20, (rnd() - 0.5) * 300);
  scene.add(g);
  clouds.push(g);
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// Building
// ============================================================================
const pieces = new Map(); // key -> piece
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // +x, +z, -x, -z

const pieceGeo = {
  wall: [new THREE.BoxGeometry(0.28, CELL, CELL), new THREE.BoxGeometry(CELL, CELL, 0.28)],
  floor: new THREE.BoxGeometry(CELL, 0.25, CELL),
  ramp: new THREE.BoxGeometry(CELL, 0.25, CELL * Math.SQRT2),
};

function pieceKey(type, ix, iy, iz, dir) {
  if (type === 'wall') {
    // Canonical edge so the same wall can't be placed twice from both sides.
    if (dir === 2) { ix -= 1; dir = 0; }
    if (dir === 3) { iz -= 1; dir = 1; }
    return { key: `w${ix},${iy},${iz},${dir}`, ix, iy, iz, dir };
  }
  if (type === 'floor') return { key: `f${ix},${iy},${iz}`, ix, iy, iz, dir: 0 };
  return { key: `r${ix},${iy},${iz}`, ix, iy, iz, dir };
}

/** Geometry + transform + collider box for a piece. */
function pieceShape(type, ix, iy, iz, dir) {
  const y0 = iy * CELL;
  if (type === 'wall') {
    const geo = pieceGeo.wall[dir];
    const pos = dir === 0
      ? new THREE.Vector3((ix + 1) * CELL, y0 + CELL / 2, iz * CELL + CELL / 2)
      : new THREE.Vector3(ix * CELL + CELL / 2, y0 + CELL / 2, (iz + 1) * CELL);
    const box = dir === 0
      ? { x0: pos.x - 0.16, x1: pos.x + 0.16, z0: iz * CELL, z1: iz * CELL + CELL, y0, y1: y0 + CELL }
      : { x0: ix * CELL, x1: ix * CELL + CELL, z0: pos.z - 0.16, z1: pos.z + 0.16, y0, y1: y0 + CELL };
    return { geo, pos, rot: 0, box };
  }
  if (type === 'floor') {
    const pos = new THREE.Vector3(ix * CELL + CELL / 2, y0 + 0.125, iz * CELL + CELL / 2);
    return { geo: pieceGeo.floor, pos, rot: 0, box: { x0: ix * CELL, x1: ix * CELL + CELL, z0: iz * CELL, z1: iz * CELL + CELL, y0, y1: y0 + 0.25 } };
  }
  const pos = new THREE.Vector3(ix * CELL + CELL / 2, y0 + CELL / 2, iz * CELL + CELL / 2);
  return { geo: pieceGeo.ramp, pos, rot: dir, box: { x0: ix * CELL, x1: ix * CELL + CELL, z0: iz * CELL, z1: iz * CELL + CELL, y0, y1: y0 + CELL } };
}

function orientRamp(obj, dir) {
  // Ramp geometry is long along z. Tilt so it rises toward DIRS[dir].
  obj.rotation.set(0, 0, 0);
  const yaw = [-Math.PI / 2, Math.PI, Math.PI / 2, 0][dir];
  obj.rotation.order = 'YXZ';
  obj.rotation.y = yaw;
  obj.rotation.x = Math.PI / 4;
}

function rampHeight(p, x, z) {
  const lx = (x - p.ix * CELL) / CELL;
  const lz = (z - p.iz * CELL) / CELL;
  const t = [lx, lz, 1 - lx, 1 - lz][p.dir];
  return p.iy * CELL + Math.min(1, Math.max(0, t)) * CELL;
}

function canPlace(type, ix, iy, iz, dir) {
  if (iy < 0 || iy > 12) return false;
  const { key } = pieceKey(type, ix, iy, iz, dir);
  if (pieces.has(key)) return false;
  const cx = ix * CELL + CELL / 2, cz = iz * CELL + CELL / 2;
  if (Math.hypot(cx, cz) > ARENA - 2) return false;
  return true;
}

function placePiece(type, ix, iy, iz, dir, owner) {
  const k = pieceKey(type, ix, iy, iz, dir);
  if (pieces.has(k.key)) return null;
  const shape = pieceShape(type, k.ix, k.iy, k.iz, k.dir);
  const obj = cartoon(shape.geo, COLORS.wood, 0.06);
  obj.position.copy(shape.pos);
  if (type === 'ramp') orientRamp(obj, k.dir);
  obj.scale.setScalar(0.01);
  scene.add(obj);
  const piece = {
    type, ...k, obj, box: shape.box,
    hp: PIECES[type].hp * 0.2, maxHp: PIECES[type].hp, grow: 0, owner,
  };
  obj.userData.mesh.userData.piece = piece;
  solids.push(obj.userData.mesh);
  pieces.set(k.key, piece);
  if (owner) sfx.build();
  return piece;
}

function damagePiece(piece, dmg, point) {
  piece.hp -= dmg;
  const mesh = piece.obj.userData.mesh;
  if (mesh.material !== fadeMat) {
    mesh.material = toon(0xfff1d6);
    setTimeout(() => { if (mesh.material !== fadeMat) mesh.material = toon(COLORS.wood); }, 60);
  }
  if (point) popDamage(point, Math.round(dmg), 'build');
  if (piece.hp <= 0) removePiece(piece, true);
}

function removePiece(piece, burst) {
  if (!pieces.has(piece.key)) return;
  pieces.delete(piece.key);
  scene.remove(piece.obj);
  const i = solids.indexOf(piece.obj.userData.mesh);
  if (i >= 0) solids.splice(i, 1);
  if (burst) { chips(piece.obj.position, COLORS.wood, 10); sfx.crack(); }
}

function clearPieces() {
  for (const p of [...pieces.values()]) removePiece(p, false);
}

function updatePieces(dt) {
  for (const p of pieces.values()) {
    if (p.grow < 1) {
      p.grow = Math.min(1, p.grow + dt / 0.22);
      const e = 1 - Math.pow(1 - p.grow, 3);
      p.obj.scale.setScalar(Math.max(0.01, e));
      p.hp = Math.min(p.maxHp, p.hp + (p.maxHp * 0.8) * dt / 0.22);
    }
  }
}

// ============================================================================
// Effects
// ============================================================================
const effects = [];

function tracer(from, to, color) {
  const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1 });
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  effects.push({ obj: line, life: 0.09, max: 0.09, kind: 'fade' });
}

function puff(point, color = 0xffffff, size = 0.25) {
  const m = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 0), new THREE.MeshBasicMaterial({ color, transparent: true }));
  m.position.copy(point);
  scene.add(m);
  effects.push({ obj: m, life: 0.3, max: 0.3, kind: 'puff' });
}

function chips(center, color, n) {
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.35), toon(color));
    m.position.copy(center).add(new THREE.Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3));
    scene.add(m);
    effects.push({
      obj: m, life: 0.8, max: 0.8, kind: 'chip',
      vel: new THREE.Vector3((Math.random() - 0.5) * 10, Math.random() * 9 + 3, (Math.random() - 0.5) * 10),
    });
  }
}

function flash(obj) {
  const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.22, 0), new THREE.MeshBasicMaterial({ color: 0xffe066 }));
  obj.add(m);
  m.position.set(0, 0, -0.55);
  effects.push({ obj: m, life: 0.05, max: 0.05, kind: 'flash' });
}

function updateEffects(dt) {
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    e.life -= dt;
    const t = Math.max(0, e.life / e.max);
    if (e.kind === 'fade') e.obj.material.opacity = t;
    if (e.kind === 'puff') { e.obj.scale.setScalar(1 + (1 - t) * 2.5); e.obj.material.opacity = t; }
    if (e.kind === 'chip') {
      e.vel.y += GRAVITY * dt;
      e.obj.position.addScaledVector(e.vel, dt);
      e.obj.rotation.x += dt * 8; e.obj.rotation.z += dt * 6;
      e.obj.scale.setScalar(Math.max(0.01, t));
    }
    if (e.life <= 0) {
      e.obj.parent?.remove(e.obj);
      e.obj.geometry?.dispose();
      if (e.kind !== 'chip') e.obj.material?.dispose();
      effects.splice(i, 1);
    }
  }
}

// ============================================================================
// Audio (synthesized, no files)
// ============================================================================
const sfx = (() => {
  let ctx = null;
  const ensure = () => { if (!ctx) { try { ctx = new AudioContext(); } catch { ctx = null; } } return ctx; };
  function noise(dur, freq, gain, type = 'lowpass') {
    const c = ensure(); if (!c) return;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = c.createGain(); g.gain.value = gain;
    src.connect(f).connect(g).connect(c.destination); src.start();
  }
  function tone(freq, dur, gain, type = 'square', slide = 0) {
    const c = ensure(); if (!c) return;
    const o = c.createOscillator(); o.type = type; o.frequency.value = freq;
    if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, c.currentTime + dur);
    const g = c.createGain(); g.gain.setValueAtTime(gain, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + dur);
  }
  return {
    unlock: () => ensure()?.resume(),
    ar: (near = 1) => noise(0.09, 2600, 0.22 * near),
    sg: (near = 1) => { noise(0.22, 1400, 0.38 * near); tone(90, 0.12, 0.15 * near, 'sine', 0.5); },
    hit: () => tone(1300, 0.06, 0.05, 'square', 1.4),
    head: () => tone(1900, 0.09, 0.07, 'square', 1.2),
    build: () => tone(220, 0.07, 0.06, 'triangle', 0.6),
    crack: () => noise(0.15, 800, 0.2, 'bandpass'),
    hurt: () => tone(160, 0.15, 0.1, 'sawtooth', 0.6),
    reload: () => { tone(500, 0.04, 0.04); setTimeout(() => tone(700, 0.04, 0.04), 120); },
    win: () => [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.18, 0.07, 'square'), i * 110)),
    lose: () => [392, 330, 262].forEach((f, i) => setTimeout(() => tone(f, 0.22, 0.07, 'square'), i * 140)),
  };
})();

// ============================================================================
// Fighters
// ============================================================================
function makeCharacter(main, dark) {
  const g = new THREE.Group();
  const body = cartoon(new THREE.BoxGeometry(0.82, 0.8, 0.5), main);
  body.position.y = 1.08;
  const belt = cartoon(new THREE.BoxGeometry(0.84, 0.14, 0.52), dark, 0.03);
  belt.position.y = 0.72;
  const head = new THREE.Group();
  const skull = cartoon(new THREE.SphereGeometry(0.36, 18, 14), COLORS.skin);
  const hat = cartoon(new THREE.SphereGeometry(0.38, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2.1), main, 0.04);
  hat.position.y = 0.04;
  const brim = cartoon(new THREE.BoxGeometry(0.5, 0.06, 0.28), dark, 0.03);
  brim.position.set(0, 0.08, -0.36);
  const hair = cartoon(new THREE.SphereGeometry(0.37, 18, 14), dark, 0.03);
  hair.position.set(0, 0.03, 0.06);
  head.add(skull, hair, hat, brim);
  for (const sx of [-0.13, 0.13]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), toon(0xffffff));
    eye.position.set(sx, -0.02, -0.31);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), toon(COLORS.ink));
    pupil.position.set(0, 0, -0.06);
    eye.add(pupil);
    head.add(eye);
  }
  head.position.y = 1.78;

  const limb = (w, h, d, color) => {
    const pivot = new THREE.Group();
    const m = cartoon(new THREE.BoxGeometry(w, h, d), color, 0.035);
    m.position.y = -h / 2;
    pivot.add(m);
    return pivot;
  };
  const legL = limb(0.3, 0.68, 0.32, dark); legL.position.set(-0.2, 0.68, 0);
  const legR = limb(0.3, 0.68, 0.32, dark); legR.position.set(0.2, 0.68, 0);
  const armL = limb(0.22, 0.62, 0.22, main); armL.position.set(-0.52, 1.42, 0);
  const armR = limb(0.22, 0.62, 0.22, main); armR.position.set(0.52, 1.42, 0);
  armL.rotation.set(-1.25, 0, 0.45);
  armR.rotation.set(-1.4, 0, -0.1);

  const gun = new THREE.Group();
  const barrel = cartoon(new THREE.BoxGeometry(0.14, 0.18, 0.95), 0x3a3540, 0.035);
  const stripe = cartoon(new THREE.BoxGeometry(0.15, 0.06, 0.4), 0xed3833, 0.02);
  stripe.position.set(0, 0.1, 0.1);
  gun.add(barrel, stripe);
  gun.position.set(0.32, 1.3, -0.55);

  g.add(body, belt, head, legL, legR, armL, armR, gun);

  // Invisible hitboxes (raycast still hits them).
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  const hbBody = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.45, 0.7), hitMat);
  hbBody.position.y = 0.75;
  const hbHead = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.62, 0.72), hitMat);
  hbHead.position.y = 1.8;
  g.add(hbBody, hbHead);

  return { group: g, head, legL, legR, armL, armR, gun, hitboxes: [hbBody, hbHead], hbHead };
}

class Fighter {
  constructor(name, isBot) {
    this.name = name;
    this.isBot = isBot;
    const c = isBot ? makeCharacter(COLORS.bot, COLORS.botDark) : makeCharacter(COLORS.player, COLORS.playerDark);
    this.model = c;
    scene.add(c.group);
    for (const hb of c.hitboxes) hb.userData.fighter = this;
    c.hbHead.userData.head = true;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.wish = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.walkT = 0;
    this.reset(new THREE.Vector3(), 0);
  }

  reset(pos, yaw) {
    this.pos.copy(pos);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.hp = 100;
    this.shield = 50;
    this.alive = true;
    this.onGround = true;
    this.groundPiece = null;
    this.weapon = 'ar';
    this.mode = 'ar'; // ar | sg | wall | ramp | floor
    this.ammo = { ar: WEAPONS.ar.mag, sg: WEAPONS.sg.mag };
    this.fireT = 0;
    this.reloadT = 0;
    this.mats = START_MATS;
    this.lastHurt = -10;
    this.deathT = 0;
    this.model.group.rotation.set(0, yaw, 0);
    this.model.group.position.copy(pos);
  }

  get eye() { return new THREE.Vector3(this.pos.x, this.pos.y + 1.7, this.pos.z); }
  get chest() { return new THREE.Vector3(this.pos.x, this.pos.y + 1.15, this.pos.z); }
  get building() { return this.mode === 'wall' || this.mode === 'ramp' || this.mode === 'floor'; }
}

// ============================================================================
// Physics
// ============================================================================
function groundAt(f, x, z, y) {
  let h = 0;
  let piece = null;
  for (const p of pieces.values()) {
    const b = p.box;
    if (x < b.x0 - RADIUS * 0.6 || x > b.x1 + RADIUS * 0.6 || z < b.z0 - RADIUS * 0.6 || z > b.z1 + RADIUS * 0.6) continue;
    let top;
    if (p.type === 'ramp') {
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      top = rampHeight(p, x, z) + 0.12;
      if (top > y + 1.1) continue;
    } else {
      top = b.y1;
      if (top > y + STEP) continue;
    }
    if (top > h) { h = top; piece = p; }
  }
  return { h, piece };
}

function collideHorizontal(f) {
  for (const p of pieces.values()) {
    if (p.type === 'ramp') continue;
    const b = p.box;
    if (f.pos.y >= b.y1 - 0.02 || f.pos.y + HEIGHT <= b.y0) continue;
    if (b.y1 - f.pos.y <= STEP && p.type === 'floor') continue;
    pushOutBox(f.pos, b);
  }
  for (const c of circles) {
    if (f.pos.y > c.h) continue;
    const dx = f.pos.x - c.x, dz = f.pos.z - c.z;
    const d = Math.hypot(dx, dz);
    const min = c.r + RADIUS;
    if (d < min && d > 1e-6) { f.pos.x = c.x + dx / d * min; f.pos.z = c.z + dz / d * min; }
  }
  const r = Math.hypot(f.pos.x, f.pos.z);
  if (r > ARENA) { f.pos.x *= ARENA / r; f.pos.z *= ARENA / r; }
}

function pushOutBox(pos, b) {
  const cx = Math.max(b.x0, Math.min(pos.x, b.x1));
  const cz = Math.max(b.z0, Math.min(pos.z, b.z1));
  const dx = pos.x - cx, dz = pos.z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 > RADIUS * RADIUS) return;
  if (d2 > 1e-8) {
    const d = Math.sqrt(d2);
    pos.x = cx + dx / d * RADIUS;
    pos.z = cz + dz / d * RADIUS;
  } else {
    // Center inside the box: leave along the shallowest axis.
    const pen = [pos.x - b.x0, b.x1 - pos.x, pos.z - b.z0, b.z1 - pos.z];
    const i = pen.indexOf(Math.min(...pen));
    if (i === 0) pos.x = b.x0 - RADIUS;
    if (i === 1) pos.x = b.x1 + RADIUS;
    if (i === 2) pos.z = b.z0 - RADIUS;
    if (i === 3) pos.z = b.z1 + RADIUS;
  }
}

function ceilingCheck(f, oldY) {
  if (f.vel.y <= 0) return;
  const headOld = oldY + HEIGHT, headNew = f.pos.y + HEIGHT;
  for (const p of pieces.values()) {
    const b = p.box;
    if (f.pos.x < b.x0 || f.pos.x > b.x1 || f.pos.z < b.z0 || f.pos.z > b.z1) continue;
    let bottom;
    if (p.type === 'floor') bottom = b.y0;
    else if (p.type === 'ramp') bottom = rampHeight(p, f.pos.x, f.pos.z) - 0.15;
    else continue;
    if (headOld <= bottom + 0.05 && headNew > bottom) {
      f.pos.y = bottom - HEIGHT;
      f.vel.y = 0;
    }
  }
}

function stepFighter(f, dt, jump) {
  const accel = f.onGround ? 14 : 4;
  f.vel.x += (f.wish.x * SPEED - f.vel.x) * Math.min(1, accel * dt);
  f.vel.z += (f.wish.z * SPEED - f.vel.z) * Math.min(1, accel * dt);
  if (jump && f.onGround) { f.vel.y = JUMP; f.onGround = false; }
  f.vel.y += GRAVITY * dt;

  f.pos.x += f.vel.x * dt;
  f.pos.z += f.vel.z * dt;
  collideHorizontal(f);

  const oldY = f.pos.y;
  f.pos.y += f.vel.y * dt;
  ceilingCheck(f, oldY);

  const g = groundAt(f, f.pos.x, f.pos.z, Math.max(oldY, f.pos.y));
  const snap = f.onGround && f.vel.y <= 0 && oldY - g.h < 0.9;
  if (f.pos.y <= g.h || snap) {
    f.pos.y = g.h;
    f.vel.y = Math.max(0, f.vel.y);
    f.onGround = true;
    f.groundPiece = g.piece;
  } else {
    f.onGround = false;
    f.groundPiece = null;
  }
}

function animateFighter(f, dt) {
  const m = f.model;
  m.group.position.copy(f.pos);
  if (!f.alive) {
    f.deathT += dt;
    m.group.rotation.x = Math.max(-Math.PI / 2, -f.deathT * 6);
    m.group.position.y = f.pos.y + 0.3;
    return;
  }
  m.group.rotation.set(0, f.yaw, 0);
  const speed = Math.hypot(f.vel.x, f.vel.z);
  f.walkT += dt * speed * 1.6;
  const swing = f.onGround ? Math.sin(f.walkT) * Math.min(1, speed / SPEED) * 0.8 : 0.5;
  m.legL.rotation.x = swing;
  m.legR.rotation.x = f.onGround ? -swing : -0.3;
  m.head.rotation.x = -f.pitch * 0.5;
  const aim = -1.35 - f.pitch * 0.8;
  m.armR.rotation.x = aim;
  m.armL.rotation.x = aim + 0.12;
  m.gun.rotation.x = f.pitch * 0.8;
  m.gun.position.y = 1.3 + f.pitch * 0.25;
  m.gun.visible = !f.building;
}

// ============================================================================
// Combat
// ============================================================================
const ray = new THREE.Raycaster();

function castShot(origin, dir, shooter, near = 0, range = 160) {
  ray.set(origin, dir);
  ray.near = near;
  ray.far = range;
  const targets = solids.slice();
  for (const f of fighters) if (f !== shooter && f.alive) targets.push(...f.model.hitboxes);
  const hits = ray.intersectObjects(targets, false);
  return hits[0] || null;
}

function spreadDir(dir, amount) {
  const d = dir.clone();
  d.x += (Math.random() - 0.5) * 2 * amount;
  d.y += (Math.random() - 0.5) * 2 * amount;
  d.z += (Math.random() - 0.5) * 2 * amount;
  return d.normalize();
}

function fire(f, origin, aimDir, near, extraSpread = 0) {
  const w = WEAPONS[f.weapon];
  if (f.fireT > 0 || f.reloadT > 0) return false;
  if (f.ammo[f.weapon] <= 0) { startReload(f); return false; }
  f.ammo[f.weapon]--;
  f.fireT = w.rate;
  const moving = Math.hypot(f.vel.x, f.vel.z) / SPEED;
  const spread = w.spread + w.moveSpread * moving + (f.onGround ? 0 : 0.02) + extraSpread;

  const muzzle = new THREE.Vector3();
  f.model.gun.getWorldPosition(muzzle);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(f.model.group.quaternion);
  muzzle.addScaledVector(fwd, 0.5);
  flash(f.model.gun);

  const hearing = f.isBot ? Math.max(0.2, 1 - f.pos.distanceTo(player.pos) / 90) : 1;
  (f.weapon === 'sg' ? sfx.sg : sfx.ar)(hearing);

  const hitFighters = new Map();
  for (let i = 0; i < w.pellets; i++) {
    const d = spreadDir(aimDir, spread);
    const hit = castShot(origin, d, f, near, w.range);
    const end = hit ? hit.point : origin.clone().addScaledVector(d, w.range);
    tracer(muzzle, end, f.isBot ? 0xd9c2ff : 0xfff1a8);
    if (!hit) continue;
    let dmg = w.dmg;
    const dist = hit.distance;
    if (f.weapon === 'sg') dmg *= Math.max(0.25, 1 - Math.max(0, dist - 9) / 26);
    const target = hit.object.userData.fighter;
    if (target) {
      const head = !!hit.object.userData.head;
      if (head) dmg *= 1.5;
      const acc = hitFighters.get(target) || { dmg: 0, head: false, point: hit.point };
      acc.dmg += dmg; acc.head ||= head;
      hitFighters.set(target, acc);
    } else if (hit.object.userData.piece) {
      damagePiece(hit.object.userData.piece, dmg, f === player ? hit.point : null);
      puff(hit.point, 0xffe0b0, 0.18);
    } else {
      puff(hit.point, 0xffffff, 0.15);
    }
  }
  for (const [target, acc] of hitFighters) hurt(target, acc.dmg, f, acc.head, acc.point);
  if (f.ammo[f.weapon] <= 0) startReload(f);
  return true;
}

function startReload(f) {
  const w = WEAPONS[f.weapon];
  if (f.reloadT > 0 || f.ammo[f.weapon] >= w.mag) return;
  f.reloadT = w.reload;
  f.reloading = f.weapon;
  if (!f.isBot) sfx.reload();
}

function hurt(target, dmg, attacker, head, point) {
  if (!target.alive) return;
  dmg = Math.round(dmg);
  const toShield = Math.min(target.shield, dmg);
  target.shield -= toShield;
  target.hp -= dmg - toShield;
  target.lastHurt = clock.elapsedTime;
  if (attacker === player) {
    popDamage(point, dmg, head ? 'head' : (toShield > 0 ? 'shield' : ''));
    hitmarker(head);
    head ? sfx.head() : sfx.hit();
  }
  if (target === player) {
    sfx.hurt();
    ui.vignette.classList.remove('hurt');
    void ui.vignette.offsetWidth;
    ui.vignette.classList.add('hurt');
    setTimeout(() => ui.vignette.classList.remove('hurt'), 120);
  }
  if (target.hp <= 0) {
    target.hp = 0;
    target.alive = false;
    target.deathT = 0;
    chips(target.chest, target.isBot ? COLORS.bot : COLORS.player, 14);
    onKill(attacker, target);
  }
}

// ============================================================================
// Building helpers shared by player + bot
// ============================================================================
function dominantDir(dx, dz) {
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 0 : 2;
  return dz > 0 ? 1 : 3;
}

function buildTarget(f, type, dir, lookUp = false) {
  const ix = Math.floor(f.pos.x / CELL);
  const iz = Math.floor(f.pos.z / CELL);
  const gp = f.groundPiece;
  const onRamp = gp && gp.type === 'ramp';
  let level = Math.floor((f.pos.y + 0.5) / CELL);
  if (onRamp) level = Math.floor((f.pos.y + 2) / CELL);
  const [dx, dz] = DIRS[dir];

  if (type === 'wall') {
    return { type, ix, iy: level + (lookUp ? 1 : 0), iz, dir };
  }
  if (type === 'floor') {
    if (lookUp) return { type, ix, iy: level + 1, iz, dir: 0 };
    return { type, ix: ix + dx, iy: level, iz: iz + dz, dir: 0 };
  }
  // Ramp: continue a ramp you're standing on, otherwise start one ahead.
  if (onRamp && gp.dir === dir) return { type, ix: gp.ix + dx, iy: gp.iy + 1, iz: gp.iz + dz, dir };
  const lvl = onRamp ? Math.floor((f.pos.y + 2.5) / CELL) : level;
  // Standing close to the far edge of your cell: skip one so you don't build under yourself.
  return { type, ix: ix + dx, iy: lvl, iz: iz + dz, dir };
}

function tryBuild(f, t) {
  if (!t || f.mats < PIECE_COST) return false;
  if (!canPlace(t.type, t.ix, t.iy, t.iz, t.dir)) return false;
  if (!placePiece(t.type, t.ix, t.iy, t.iz, t.dir, f)) return false;
  f.mats -= PIECE_COST;
  return true;
}

// ============================================================================
// Player input
// ============================================================================
const keys = new Set();
let mouseDown = false;
let sens = 1;
let locked = false;
let lastBuildKey = '';

addEventListener('keydown', e => {
  if (state !== 'playing') return;
  keys.add(e.code);
  if (e.code === 'Digit1') setMode(player, 'ar');
  if (e.code === 'Digit2') setMode(player, 'sg');
  if (e.code === 'KeyQ') setMode(player, 'wall');
  if (e.code === 'KeyE') setMode(player, 'ramp');
  if (e.code === 'KeyC') setMode(player, 'floor');
  if (e.code === 'KeyR' && !player.building) startReload(player);
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); mouseDown = false; });
canvas.addEventListener('mousedown', e => {
  if (state !== 'playing') return;
  if (!locked) requestLock();
  if (e.button === 0) mouseDown = true;
});
addEventListener('mouseup', e => { if (e.button === 0) mouseDown = false; });
addEventListener('mousemove', e => {
  if (!locked || state !== 'playing' || !player.alive) return;
  player.yaw -= e.movementX * 0.0022 * sens;
  player.pitch -= e.movementY * 0.0022 * sens;
  player.pitch = Math.max(-1.2, Math.min(1.05, player.pitch));
});
addEventListener('wheel', e => {
  if (state !== 'playing') return;
  setMode(player, player.mode === 'ar' ? 'sg' : 'ar');
});
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if (!locked && state === 'playing') pause();
});

function requestLock() {
  try {
    const r = canvas.requestPointerLock();
    if (r && r.catch) r.catch(() => {});
  } catch { /* not supported */ }
}

function setMode(f, mode) {
  if (f.mode === mode) return;
  f.mode = mode;
  if (mode === 'ar' || mode === 'sg') {
    if (f.reloadT > 0 && f.reloading !== mode) f.reloadT = 0;
    f.weapon = mode;
    f.fireT = Math.max(f.fireT, 0.12);
  }
  if (f === player) updateSlots();
}

const camTarget = new THREE.Vector3();
const camOffset = new THREE.Vector3();

function updatePlayer(dt) {
  const f = player;
  if (!f.alive) { f.wish.set(0, 0, 0); stepFighter(f, dt, false); return; }
  const fx = -Math.sin(f.yaw), fz = -Math.cos(f.yaw);
  const rx = -fz, rz = fx;
  let mx = 0, mz = 0;
  if (keys.has('KeyW')) { mx += fx; mz += fz; }
  if (keys.has('KeyS')) { mx -= fx; mz -= fz; }
  if (keys.has('KeyD')) { mx += rx; mz += rz; }
  if (keys.has('KeyA')) { mx -= rx; mz -= rz; }
  const len = Math.hypot(mx, mz);
  f.wish.set(len ? mx / len : 0, 0, len ? mz / len : 0);
  stepFighter(f, dt, keys.has('Space'));

  if (f.building) {
    const dir = dominantDir(fx, fz);
    const t = buildTarget(f, f.mode, dir, f.pitch > 0.5);
    showGhost(t, canPlace(t.type, t.ix, t.iy, t.iz, t.dir) && f.mats >= PIECE_COST);
    const k = `${t.type}${t.ix},${t.iy},${t.iz},${t.dir}`;
    if (mouseDown && k !== lastBuildKey) { if (tryBuild(f, t)) lastBuildKey = k; }
    if (!mouseDown) lastBuildKey = '';
  } else {
    hideGhost();
    if (mouseDown) {
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      const near = camera.position.distanceTo(f.eye) * 0.95;
      fire(f, camera.position.clone(), dir, near);
      if (f.weapon === 'sg') mouseDown = false;
    }
  }
}

function updateCamera(dt) {
  const f = player;
  camTarget.set(f.pos.x, f.pos.y + 1.75, f.pos.z);
  const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), f.yaw);
  const pitchQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), f.pitch);
  const q = yawQ.multiply(pitchQ);
  camOffset.set(0.85, 0.35, 3.4).applyQuaternion(q);
  const desired = camTarget.clone().add(camOffset);

  // Terrain pulls the camera in; your own builds fade out instead.
  const back = desired.clone().sub(camTarget);
  const dist = back.length();
  ray.set(camTarget, back.normalize());
  ray.near = 0; ray.far = dist;
  const hits = ray.intersectObjects(solids, false);
  const terrain = hits.find(h => !h.object.userData.piece);
  if (terrain) desired.copy(camTarget).addScaledVector(back, Math.max(0.4, terrain.distance - 0.25));
  for (const p of faded) setFaded(p, false);
  faded.length = 0;
  for (const h of hits) {
    const p = h.object.userData.piece;
    if (p && (!terrain || h.distance < terrain.distance)) { setFaded(p, true); faded.push(p); }
  }

  // Too close to see past yourself: hide your own model.
  f.model.group.visible = desired.distanceTo(camTarget) > 1.2;
  camera.position.copy(desired);
  camera.quaternion.copy(q);
  if (desired.y < 0.3) camera.position.y = 0.3;
}

const faded = [];
const fadeMat = new THREE.MeshToonMaterial({ color: COLORS.wood, gradientMap: toonRamp, transparent: true, opacity: 0.22, depthWrite: false });
function setFaded(p, on) {
  if (!p.obj.parent) return;
  p.obj.userData.mesh.material = on ? fadeMat : toon(COLORS.wood);
  p.obj.userData.mesh.castShadow = !on;
  p.obj.children[1].visible = !on;
}

// Ghost preview
const ghostMat = new THREE.MeshBasicMaterial({ color: COLORS.ghost, transparent: true, opacity: 0.35, depthWrite: false });
const ghostBad = new THREE.MeshBasicMaterial({ color: 0xed3833, transparent: true, opacity: 0.3, depthWrite: false });
const ghost = new THREE.Mesh(pieceGeo.floor, ghostMat);
const ghostEdges = new THREE.LineSegments(new THREE.EdgesGeometry(pieceGeo.floor), new THREE.LineBasicMaterial({ color: 0xffffff }));
ghost.add(ghostEdges);
ghost.visible = false;
scene.add(ghost);
let ghostSig = '';

function showGhost(t, ok) {
  const k = pieceKey(t.type, t.ix, t.iy, t.iz, t.dir);
  const shape = pieceShape(t.type, k.ix, k.iy, k.iz, k.dir);
  const sig = t.type + k.dir;
  if (sig !== ghostSig) {
    ghost.geometry = shape.geo;
    ghostEdges.geometry.dispose();
    ghostEdges.geometry = new THREE.EdgesGeometry(shape.geo);
    ghostSig = sig;
  }
  ghost.position.copy(shape.pos);
  ghost.rotation.set(0, 0, 0);
  if (t.type === 'ramp') orientRamp(ghost, k.dir);
  ghost.material = ok ? ghostMat : ghostBad;
  ghost.visible = true;
}
function hideGhost() { ghost.visible = false; }

// ============================================================================
// Bot
// ============================================================================
const brain = { strafeDir: 1, strafeT: 0, seenT: 0, buildCd: 0, jumpT: 2, peekT: 0, aimErr: new THREE.Vector3(), aimT: 0 };
let diff = DIFFICULTY.normal;

function updateBot(dt) {
  const b = bot;
  if (!b.alive) { b.wish.set(0, 0, 0); stepFighter(b, dt, false); return; }
  const now = clock.elapsedTime;
  const toP = player.pos.clone().sub(b.pos);
  const dist = Math.hypot(toP.x, toP.z);
  const dirToP = toP.clone().setY(0).normalize();

  // Face the player.
  const targetYaw = Math.atan2(-dirToP.x, -dirToP.z);
  let dy = targetYaw - b.yaw;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  b.yaw += dy * Math.min(1, dt * 10);

  // Line of sight.
  const eye = b.eye;
  const aimPoint = player.chest;
  const toAim = aimPoint.clone().sub(eye);
  const aimDist = toAim.length();
  const hit = player.alive ? castShot(eye, toAim.clone().normalize(), b, 0, 200) : null;
  const clear = hit && hit.object.userData.fighter === player;
  const blockPiece = hit && hit.object.userData.piece;
  b.pitch = Math.atan2(toAim.y, Math.hypot(toAim.x, toAim.z));

  if (clear) brain.seenT += dt; else brain.seenT = 0;

  // Movement: keep a preferred range, strafe, sometimes jump.
  brain.strafeT -= dt;
  if (brain.strafeT <= 0) { brain.strafeDir *= -1; brain.strafeT = 0.6 + Math.random() * 1.4; }
  const pref = b.weapon === 'sg' ? 5 : 16;
  let fwd = dist > pref + 4 ? 1 : dist < pref - 3 ? -0.7 : 0;
  if (!clear && !blockPiece) fwd = 1;
  const side = new THREE.Vector3(-dirToP.z, 0, dirToP.x).multiplyScalar(brain.strafeDir * diff.strafe);
  const wish = dirToP.clone().multiplyScalar(fwd).add(side);
  if (brain.peekT > 0) { brain.peekT -= dt; wish.copy(side).multiplyScalar(1.4); }
  if (wish.lengthSq() > 1) wish.normalize();
  b.wish.copy(wish);

  brain.jumpT -= dt;
  let jump = false;
  if (brain.jumpT <= 0) { jump = Math.random() < 0.5 * diff.strafe; brain.jumpT = 1.2 + Math.random() * 2; }

  // Weapon choice.
  setMode(b, dist < 9 ? 'sg' : 'ar');

  // Building: wall up when hurt, ramp up when the player is above.
  brain.buildCd -= dt;
  if (brain.buildCd <= 0 && b.mats >= PIECE_COST && Math.random() < diff.build) {
    const d = dominantDir(dirToP.x, dirToP.z);
    const hurtRecently = now - b.lastHurt < 0.35;
    const above = player.pos.y - b.pos.y > 2.5 && dist < 22;
    if (hurtRecently) {
      tryBuild(b, buildTarget(b, 'wall', d));
      if (Math.random() < 0.5) tryBuild(b, buildTarget(b, 'ramp', d));
      brain.buildCd = 0.55;
      brain.peekT = 0.4 + Math.random() * 0.5;
    } else if (above) {
      tryBuild(b, buildTarget(b, 'ramp', d));
      b.wish.copy(dirToP);
      brain.buildCd = 0.3;
    } else {
      brain.buildCd = 0.25;
    }
  }

  stepFighter(b, dt, jump);

  // Aim error drifts instead of snapping each shot.
  brain.aimT -= dt;
  if (brain.aimT <= 0) {
    const e = diff.err * (1 + aimDist / 35) * (1 + Math.hypot(player.vel.x, player.vel.z) / SPEED * 0.6);
    brain.aimErr.set((Math.random() - 0.5) * 2 * e, (Math.random() - 0.5) * 2 * e, (Math.random() - 0.5) * 2 * e);
    brain.aimT = 0.15;
  }

  const wantShoot = (clear && brain.seenT > diff.react) || (blockPiece && hit.distance < 30 && Math.random() < 0.6);
  if (wantShoot && b.fireT <= 0) {
    const dir = toAim.normalize().add(brain.aimErr).normalize();
    if (fire(b, eye, dir, 0.6)) b.fireT *= diff.fireMul;
  }
}

// ============================================================================
// Game state
// ============================================================================
const clock = new THREE.Clock();
let state = 'menu';
let score = { you: 0, bot: 0 };
let roundT = 0;

const player = new Fighter('YOU', false);
const bot = new Fighter('BOT', true);
const fighters = [player, bot];

const SPAWN_P = new THREE.Vector3(2, 0, 22);
const SPAWN_B = new THREE.Vector3(2, 0, -22);

function resetRound() {
  clearPieces();
  player.reset(SPAWN_P, 0);
  bot.reset(SPAWN_B, Math.PI);
  brain.seenT = 0; brain.buildCd = 0.5;
  updateSlots();
}

function startMatch() {
  score = { you: 0, bot: 0 };
  resetRound();
  state = 'playing';
  ui.menu.hidden = true;
  ui.end.hidden = true;
  ui.hud.hidden = false;
  sfx.unlock();
  requestLock();
  banner('FIGHT');
}

function pause() {
  state = 'paused';
  keys.clear(); mouseDown = false;
  ui.menu.hidden = false;
  ui.play.textContent = 'RESUME';
}

function resume() {
  state = 'playing';
  ui.menu.hidden = true;
  requestLock();
}

function onKill(killer, victim) {
  const feed = document.createElement('div');
  feed.innerHTML = `${killer.name} <b>${killer.weapon === 'sg' ? 'SHOTGUN' : 'AR'}</b> ${victim.name}`;
  ui.feed.prepend(feed);
  setTimeout(() => feed.remove(), 4000);
  if (killer === player) score.you++; else score.bot++;
  ui.scoreYou.textContent = score.you;
  ui.scoreBot.textContent = score.bot;
  if (score.you >= GOAL || score.bot >= GOAL) {
    state = 'over';
    roundT = 1.6;
    banner(score.you >= GOAL ? 'VICTORY' : 'DEFEAT');
    (score.you >= GOAL ? sfx.win : sfx.lose)();
  } else {
    state = 'round';
    roundT = 2.4;
    banner(killer === player ? 'ELIMINATED' : 'KNOCKED');
  }
}

function endMatch() {
  state = 'end';
  document.exitPointerLock?.();
  ui.hud.hidden = true;
  ui.end.hidden = false;
  const win = score.you >= GOAL;
  ui.endTitle.innerHTML = win ? 'VICTORY' : 'DEFEAT';
  ui.endTitle.style.color = win ? '#ffd23f' : '';
  ui.endScore.textContent = `${score.you} - ${score.bot}`;
}

// ============================================================================
// UI
// ============================================================================
const $ = id => document.getElementById(id);
const ui = {
  hud: $('hud'), menu: $('menu'), end: $('end'), play: $('play'), again: $('again'),
  scoreYou: $('scoreYou'), scoreBot: $('scoreBot'), feed: $('feed'),
  crosshair: $('crosshair'), hitmarker: $('hitmarker'), dmgLayer: $('dmgLayer'),
  shieldFill: $('shieldFill'), healthFill: $('healthFill'), shieldNum: $('shieldNum'), healthNum: $('healthNum'),
  mats: $('mats'), ammo: $('ammo'), ammoMag: $('ammoMag'), ammoName: $('ammoName'),
  slots: [...document.querySelectorAll('.slot')], banner: $('banner'), vignette: $('vignette'),
  endTitle: $('endTitle'), endScore: $('endScore'), sens: $('sens'), sensOut: $('sensOut'), note: $('note'),
};
$('scoreGoal').textContent = GOAL;

ui.play.addEventListener('click', () => (state === 'paused' ? resume() : startMatch()));
ui.again.addEventListener('click', startMatch);
ui.sens.addEventListener('input', () => { sens = +ui.sens.value; ui.sensOut.textContent = sens.toFixed(1); save(); });
document.querySelectorAll('#difficulty button').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('#difficulty button').forEach(b => b.classList.toggle('on', b === btn));
  diff = DIFFICULTY[btn.dataset.v];
  save();
}));

function save() {
  try { localStorage.setItem('blokbrawl', JSON.stringify({ sens, diff: Object.keys(DIFFICULTY).find(k => DIFFICULTY[k] === diff) })); } catch { /* storage blocked */ }
}
(function load() {
  try {
    const s = JSON.parse(localStorage.getItem('blokbrawl') || '{}');
    if (s.sens) { sens = s.sens; ui.sens.value = sens; ui.sensOut.textContent = (+sens).toFixed(1); }
    if (s.diff && DIFFICULTY[s.diff]) {
      diff = DIFFICULTY[s.diff];
      document.querySelectorAll('#difficulty button').forEach(b => b.classList.toggle('on', b.dataset.v === s.diff));
    }
  } catch { /* storage blocked */ }
})();
if (matchMedia('(pointer: coarse)').matches) ui.note.textContent = 'Best with a keyboard and mouse.';

function updateSlots() {
  for (const s of ui.slots) s.classList.toggle('on', s.dataset.slot === player.mode);
  ui.crosshair.classList.toggle('build', player.building);
}

function banner(text) {
  ui.banner.textContent = text;
  ui.banner.classList.remove('show');
  void ui.banner.offsetWidth;
  ui.banner.classList.add('show');
}

function hitmarker(head) {
  ui.hitmarker.className = 'hitmarker';
  void ui.hitmarker.offsetWidth;
  ui.hitmarker.className = 'hitmarker show' + (head ? ' head' : '');
}

const projV = new THREE.Vector3();
function popDamage(point, value, kind) {
  projV.copy(point).project(camera);
  if (projV.z > 1) return;
  const el = document.createElement('div');
  el.className = 'dmg ' + kind;
  el.textContent = value;
  el.style.left = ((projV.x + 1) / 2 * innerWidth + (Math.random() - 0.5) * 30) + 'px';
  el.style.top = ((1 - projV.y) / 2 * innerHeight) + 'px';
  ui.dmgLayer.appendChild(el);
  setTimeout(() => el.remove(), 800);
}

function updateHud() {
  ui.shieldFill.style.transform = `scaleX(${player.shield / 50})`;
  ui.healthFill.style.transform = `scaleX(${player.hp / 100})`;
  ui.shieldNum.textContent = player.shield;
  ui.healthNum.textContent = player.hp;
  ui.mats.textContent = player.mats;
  const building = player.building;
  ui.ammo.style.visibility = building ? 'hidden' : 'visible';
  ui.ammoMag.textContent = player.reloadT > 0 ? '...' : player.ammo[player.weapon];
  ui.ammoName.textContent = WEAPONS[player.weapon].name;
  ui.ammo.classList.toggle('reloading', player.reloadT > 0);
  const moving = Math.hypot(player.vel.x, player.vel.z) / SPEED;
  const w = WEAPONS[player.weapon];
  const spread = building ? 0 : (w.spread + w.moveSpread * moving + (player.onGround ? 0 : 0.02)) * 260;
  ui.crosshair.style.setProperty('--spread', spread.toFixed(1) + 'px');
}

// ============================================================================
// Loop
// ============================================================================
function tickWeapons(f, dt) {
  f.fireT = Math.max(0, f.fireT - dt);
  if (f.reloadT > 0) {
    f.reloadT -= dt;
    if (f.reloadT <= 0) { f.reloadT = 0; f.ammo[f.reloading] = WEAPONS[f.reloading].mag; }
  }
}

let menuAngle = 0;
function frame() {
  const dt = Math.min(0.05, clock.getDelta());

  for (const c of clouds) { c.position.x += dt * 1.5; if (c.position.x > 160) c.position.x = -160; }

  if (state === 'playing' || state === 'round' || state === 'over') {
    if (state === 'playing') {
      updatePlayer(dt);
      updateBot(dt);
    } else {
      player.wish.set(0, 0, 0); bot.wish.set(0, 0, 0);
      stepFighter(player, dt, false); stepFighter(bot, dt, false);
      hideGhost();
      roundT -= dt;
      if (roundT <= 0) {
        if (state === 'over') endMatch();
        else { resetRound(); state = 'playing'; banner('FIGHT'); }
      }
    }
    tickWeapons(player, dt); tickWeapons(bot, dt);
    updatePieces(dt);
    animateFighter(player, dt); animateFighter(bot, dt);
    updateCamera(dt);
    updateHud();
  } else if (state === 'menu' || state === 'end') {
    menuAngle += dt * 0.08;
    camera.position.set(Math.sin(menuAngle) * 34, 13, Math.cos(menuAngle) * 34);
    camera.lookAt(6, 2, 0);
    animateFighter(player, dt); animateFighter(bot, dt);
    updatePieces(dt);
  } else {
    animateFighter(player, dt); animateFighter(bot, dt);
  }

  updateEffects(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// A small showcase build behind the menu.
function showcase() {
  player.reset(new THREE.Vector3(4, 0, 6), 0.6);
  bot.reset(new THREE.Vector3(10, 0, -4), Math.PI + 0.4);
  for (const [t, ix, iy, iz, d] of [
    ['ramp', 1, 0, -1, 0], ['wall', 1, 0, -1, 3], ['ramp', 2, 1, -1, 0], ['floor', 2, 1, -2, 0],
    ['wall', 2, 0, -2, 0], ['wall', 2, 1, -2, 1], ['wall', 0, 0, 1, 1], ['ramp', 3, 2, -1, 0],
  ]) placePiece(t, ix, iy, iz, d, null);
}

buildWorld();
showcase();
updateSlots();
frame();

// Exposed for automated smoke tests.
window.__blokbrawl = {
  get state() { return state; }, player, bot, pieces, startMatch, tryBuild, buildTarget, setMode, keys,
  fireAt: dir => fire(player, player.eye, dir, 0.5),
};
